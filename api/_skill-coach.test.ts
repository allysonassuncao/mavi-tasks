import { describe, expect, it, vi } from "vitest";
import {
  capabilities,
  coachMessages,
  handleSkillCoach,
  parseCoach,
  parseReview,
  type SkillInput,
} from "./_skill-coach";
import type { AiDeps, AiEnv } from "./_ai";

const company = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000010";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.y`;
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  anthropicKey: "sk",
  model: "claude-opus-5-5",
  providerKey: null,
} as unknown as AiEnv;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

const skill: SkillInput = {
  slug: "relatorio-mensal",
  name: "Relatório mensal",
  description: "Relatório.",
  instructions: "1. Rode o script gerar.py.\n2. Monte o relatório.\n",
  files: [{ name: "gerar.py", content: "print('oi')" }],
};

function deps(answer: string, hidden: string[] = []) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/memberships")) return json([{ hidden_pages: hidden, active: true }]);
    if (url.endsWith("/ai_check_limits")) return json({ blocked: false, message: null });
    if (url.endsWith("/ai_skill_catalog"))
      return json([{ slug: "relatorio-semanal", name: "Relatório semanal", description: "Toda segunda." }]);
    return json(null);
  });
  const llm = vi.fn(async () => ({
    text: answer,
    rounds: 1,
    meter: { model: "claude-opus-5-5", input: 900, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
  }));
  return { d: { fetch, llm, embed: vi.fn() } as unknown as AiDeps, calls, llm };
}

describe("validador de qualidade das skills", () => {
  it("skill boa: muito boa e sem pontos (não inventa defeito)", () => {
    const r = parseReview('{"verdict": "great", "summary": "Muito boa: está clara.", "items": []}', skill);
    expect(r).toEqual({ verdict: "great", summary: "Muito boa: está clara.", items: [] });
  });

  it("o veredito segue os pontos, e o trecho que muda precisa existir", () => {
    const r = parseReview(
      JSON.stringify({
        verdict: "great",
        summary: "Muito boa.",
        items: [
          { kind: "improve", severity: "low", target: "instructions", title: "Diga o tamanho", why: "x", before: "não existe", after: "y" },
          { kind: "fix", severity: "high", target: "instructions", title: "A MAVI não roda scripts", why: "Ela não executa código.", before: "1. Rode o script gerar.py.", after: "1. Busque os resultados das campanhas do mês." },
          { kind: "improve", severity: "medium", target: "description", title: "Diga quando usar", why: "É o que a MAVI lê.", after: "Quando pedirem o relatório mensal de um cliente." },
          { kind: "remove", severity: "medium", target: "file", file: "gerar.py", title: "Tire o script", why: "Não roda aqui." },
          { kind: "include", severity: "low", target: "file", file: "modelo.md", title: "Um modelo", why: "Ajuda.", after: "# Modelo" },
          { kind: "robot", target: "instructions", title: "???" },
        ],
      }),
      skill,
    );
    expect(r.verdict).toBe("needs_work");
    // "Muito boa" com pontos confundiria: vira o resumo padrão.
    expect(r.summary).toMatch(/Precisa de ajustes/);
    expect(r.items.map((i) => [i.severity, i.target])).toEqual([
      ["high", "instructions"],
      ["medium", "description"],
      ["medium", "file"],
      ["low", "instructions"],
      ["low", "file"],
    ]);
    expect(r.items[0]).toMatchObject({ before: "1. Rode o script gerar.py.", after: "1. Busque os resultados das campanhas do mês." });
    // O trecho não existe: vira só orientação.
    expect(r.items[3].before).toBeUndefined();
    expect(r.items[3].after).toBeUndefined();
    expect(r.items[4]).toMatchObject({ file: "modelo.md", after: "# Modelo" });
  });

  it("o que a MAVI faz vai para o validador (e o que não faz)", () => {
    const c = capabilities();
    expect(c).toContain("search_knowledge");
    expect(c).toContain("render_art");
    expect(c).toContain("Não faz: rodar código");
  });

  it("revisa pelo modelo da funcionalidade e registra o custo no módulo Skills", async () => {
    const { d, calls, llm } = deps('{"verdict":"good","summary":"Boa.","items":[{"kind":"improve","severity":"low","target":"description","title":"Mais gatilhos","why":"x","after":"Quando pedirem o relatório mensal."}]}');
    const res = await handleSkillCoach({ company, mode: "review", origin: "import", skill }, token, env, d);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verdict: "good", model: "claude-opus-5-5" });
    const prompt = (llm.mock.calls[0] as unknown as [{ messages: { content: string }[] }])[0].messages[0].content;
    expect(prompt).toContain("acabou de ser importada");
    expect(prompt).toContain("Relatório semanal (relatorio-semanal)");
    expect(prompt).toContain('<arquivo nome="gerar.py"');
    const route = calls.find((c) => c.url.endsWith("/ai_resolve_route"));
    expect(route?.body).toMatchObject({ p_feature: "skill_coach" });
    expect(calls.find((c) => c.url.endsWith("/ai_log_usage"))?.body).toMatchObject({
      p_module: "skills",
      p_kind: "skill_review",
      p_cost: 0.02,
    });
  });

  it("com a MAVI desligada para a pessoa, não roda", async () => {
    const { d, llm } = deps("{}", ["assistant"]);
    const res = await handleSkillCoach({ company, mode: "review", skill }, token, env, d);
    expect(res.status).toBe(403);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("assistente de criação das skills", () => {
  it("a skill atual vai na última mensagem (a pessoa pode ter editado à mão)", () => {
    const m = coachMessages([{ role: "user", content: "Relatório para o cliente" }], skill, []);
    expect(m).toHaveLength(1);
    expect(m[0].content).toMatch(/^Relatório para o cliente\n\n---\nA skill como está agora/);
    expect(m[0].content).toContain("1. Rode o script gerar.py.");
    expect(coachMessages([], skill, [])[0].content).toContain("(A pessoa abriu o assistente.)");
  });

  it("lê a resposta: pergunta com opções, campos inteiros e arquivos", () => {
    const r = parseCoach(
      JSON.stringify({
        reply: "Anotei!",
        question: { text: "Como as pessoas vão pedir?", options: ["relatório do mês", "relatório do mês", "fechamento"], multiple: true },
        draft: { name: "Relatório mensal do cliente", description: "curto", instructions: "1. Busque as campanhas do mês.\n2. Resuma." },
        files: [{ name: "modelo.md", content: "# Modelo" }, { name: "velho.md", remove: true }, { name: "vazio.md", content: " " }],
      }),
    );
    expect(r.question).toEqual({ text: "Como as pessoas vão pedir?", options: ["relatório do mês", "fechamento"], multiple: true });
    // A descrição curta demais fica de fora.
    expect(r.draft).toEqual({ name: "Relatório mensal do cliente", instructions: "1. Busque as campanhas do mês.\n2. Resuma." });
    expect(r.files).toEqual([{ name: "modelo.md", content: "# Modelo" }, { name: "velho.md", remove: true }]);
    expect(r.ready).toBe(false);
    // Pronta: sem nova pergunta.
    expect(parseCoach('{"reply":"Pronta!","question":{"text":"Mais algo?","options":[]},"ready":true}').question).toBeUndefined();
  });

  it("conversa pelo servidor e registra como skill_coach", async () => {
    const { d, calls } = deps('{"reply":"Legal! Como as pessoas vão pedir?","question":{"text":"Como pedem?","options":["relatório do mês"]}}');
    const res = await handleSkillCoach(
      { company, mode: "coach", messages: [{ role: "user", content: "Relatório" }], skill: { ...skill, instructions: "" } },
      token,
      env,
      d,
    );
    expect(res.status).toBe(200);
    expect(res.body.question).toMatchObject({ text: "Como pedem?" });
    expect(calls.find((c) => c.url.endsWith("/ai_log_usage"))?.body).toMatchObject({ p_kind: "skill_coach" });
  });
});

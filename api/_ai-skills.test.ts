import { describe, expect, it, vi } from "vitest";
import { handleAi, streamAi, type AiEnv, type AiStreamEvent } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import { catalogContext, pickedSkills } from "./_ai-skills";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const skillId = "00000000-0000-4000-8000-0000000000e1";
const token = (sub: string) =>
  `Bearer x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
};
type Call = { url: string; body: any };
function world(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const call = { url, body };
    calls.push(call);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    const value = key ? routes[key] : [];
    const data = typeof value === "function" ? (value as (c: Call) => unknown)(call) : value;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const skill = (version: number, test = false) => ({
  id: skillId,
  slug: "relatorio-mensal",
  version,
  name: "Relatório mensal",
  description: "Quando pedirem o relatório mensal de um cliente.",
  instructions: "1. Busque as campanhas do mês.\n2. Monte os indicadores.",
  test,
  files: [{ name: "references/modelo.md", size: 2048 }],
});
const base = (powers: string[], catalog: unknown[]) => ({
  "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
  "clients?": [],
  "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
  "rpc/ai_resolve_route": null,
  "rpc/ai_my_powers": powers,
  "rpc/ai_skill_catalog": catalog,
  "rpc/ai_skill_load": (c: Call) => (c.body.p_slug === "relatorio-mensal" ? skill(c.body.p_version ?? 3, !!c.body.p_version) : null),
  "rpc/ai_skill_file": "# Modelo\nSeções: resumo, números.",
  "rpc/ai_save_turn": "conv",
  "rpc/ai_log_tool_calls": null,
  "rpc/ai_log_usage": null,
});
const catalog = [
  { slug: "relatorio-mensal", version: 3, name: "Relatório mensal", description: "Quando pedirem o relatório mensal de um cliente." },
];
const answer = (text: string) => ({ text, meter: newMeter("claude-opus-5"), rounds: 1 });

describe("skills da MAVI", () => {
  it("o catálogo vai no contexto; use_skill carrega e read_skill_file lê; cada uso registra a versão", async () => {
    const { fetchImpl, calls } = world(base(["skills"], catalog));
    let request: AgentRequest | undefined;
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      request = r;
      outputs.push(await r.execute("read_skill_file", { skill: "relatorio-mensal", file: "references/modelo.md" }));
      outputs.push(await r.execute("use_skill", { skill: "relatorio-mensal" }));
      outputs.push(await r.execute("read_skill_file", { skill: "relatorio-mensal", file: "references/modelo.md" }));
      outputs.push(await r.execute("read_skill_file", { skill: "relatorio-mensal", file: "segredo.md" }));
      outputs.push(await r.execute("use_skill", { skill: "outra" }));
      return answer("Pronto.");
    };
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Faz o relatório do mês?", surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(request!.context).toContain(
      "- relatorio-mensal: Relatório mensal — Quando pedirem o relatório mensal de um cliente.",
    );
    // As instruções só entram quando a MAVI carrega.
    expect(request!.context).not.toContain("Busque as campanhas do mês");
    expect(request!.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["use_skill", "read_skill_file"]),
    );
    expect(outputs[0]).toBe('Carregue a skill "relatorio-mensal" com use_skill antes de ler os arquivos dela.');
    expect(outputs[1]).toContain("Skill carregada: Relatório mensal (relatorio-mensal, versão 3).");
    expect(outputs[1]).toContain("<skill>\n1. Busque as campanhas do mês.");
    expect(outputs[1]).toContain("references/modelo.md (2 KB)");
    expect(outputs[2]).toContain("<arquivo>\n# Modelo\nSeções: resumo, números.\n</arquivo>");
    expect(outputs[3]).toContain('não tem o arquivo "segredo.md"');
    expect(outputs[4]).toBe('Não há a skill "outra" no catálogo desta pessoa. Use uma da lista ou siga sem skill.');
    const load = calls.find((c) => c.url.includes("ai_skill_load"))!;
    expect(load.body).toEqual({ p_company: company, p_slug: "relatorio-mensal", p_version: null });
    const log = calls.find((c) => c.url.includes("ai_log_tool_calls"))!;
    expect(
      log.body.p_calls
        .filter((c: any) => c.skill)
        .map((c: any) => [c.tool, c.skill_version]),
    ).toEqual([
      ["use_skill", 3],
      ["read_skill_file", 3],
    ]);
  });

  it("sem catálogo e sem skill escolhida, nada de skills", async () => {
    const { fetchImpl } = world(base(["skills"], []));
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      return answer("Ok.");
    };
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Oi?", surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(request!.tools.map((t) => t.name)).not.toContain("use_skill");
    expect(request!.context).not.toContain("Skills da agência");
  });

  it("a skill escolhida na caixa entra carregada; a versão em teste é dita", async () => {
    const { fetchImpl, calls } = world(base(["skills"], []));
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      return answer("Ok.");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      {
        action: "ai-ask",
        company,
        scope: {},
        question: "Testa a skill?",
        surface: "page",
        skills: [{ slug: "relatorio-mensal", version: 4 }, { slug: "inexistente" }, "../x"],
      },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    expect(request!.context).toContain(
      "A pessoa escolheu usar esta skill nesta pergunta: Relatório mensal (relatorio-mensal, versão 4, EM TESTE: ainda não aprovada).",
    );
    expect(request!.tools.map((t) => t.name)).toContain("read_skill_file");
    expect(events).toContainEqual({
      type: "step",
      id: "skill-relatorio-mensal",
      label: "Usando a skill “Relatório mensal” (versão 4 em teste)",
      state: "done",
      detail: "escolhida por você",
    });
    expect(events).toContainEqual({ type: "warning", text: "A skill “inexistente” não está disponível para você." });
    const loads = calls.filter((c) => c.url.includes("ai_skill_load")).map((c) => c.body.p_slug);
    expect(loads).toEqual(["relatorio-mensal", "inexistente"]);
  });

  it("sem o poder, a escolha na caixa é ignorada; na bolinha, nem pergunta o catálogo", async () => {
    const { fetchImpl, calls } = world(base([], catalog));
    const llm: LlmAdapter = async () => answer("Ok.");
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Oi?", surface: "page", skills: ["relatorio-mensal"] },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(calls.some((c) => c.url.includes("ai_skill_load"))).toBe(false);
    const bubble = world(base(["skills"], catalog));
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Oi?" },
      token(me),
      env,
      { fetch: bubble.fetchImpl, llm, embed: vi.fn() },
    );
    expect(bubble.calls.some((c) => c.url.includes("ai_skill_catalog"))).toBe(false);
  });

  it("escolhas: até 3, sem repetir, só identificadores válidos", () => {
    expect(pickedSkills(["a1", { slug: "A1" }, { slug: "b2", version: 2 }, "c3", "d4", "../x"])).toEqual([
      { slug: "a1" },
      { slug: "b2", version: 2 },
      { slug: "c3" },
    ]);
    expect(catalogContext([], [])).toBe("");
  });
});

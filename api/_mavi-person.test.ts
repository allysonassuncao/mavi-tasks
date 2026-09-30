import { describe, expect, it, vi } from "vitest";
import { streamAi, type AiEnv } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import { handleLearningWorker, type LearningEnv } from "./_copilot-learning";
import { parsePersonOps, personContext, personMessage, type PersonClaim } from "./_mavi-person";
import { judgeMessage } from "./_mavi-judge";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const conversation = "00000000-0000-4000-8000-0000000000c9";
const run = "00000000-0000-4000-8000-0000000000e1";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
};
const lenv: LearningEnv = { ...env, learningModel: "claude-opus-5-5" };

const claim: PersonClaim = {
  company,
  user: me,
  name: "Ana Equipe",
  facts: { role: "member", teams: ["Squad Primogênito"], clients: [{ id: "k1", name: "5022", n: 12 }] },
  items: [
    { id: "00000000-0000-4000-8000-0000000000a1", kind: "preference", text: "Seja direta.", origin: "person", pinned: true, dismissed: false },
    { id: "00000000-0000-4000-8000-0000000000a2", kind: "frustration", text: "Removido.", origin: "mavi", pinned: false, dismissed: true },
  ],
  feedback: [{ vote: "down", reason: "format", comment: "Sempre quero em tabela", question: "Quais clientes estão frios?", answer: "…", at: "" }],
  frustrations: [{ signals: ["frustration"], answer: "Agora vou puxar as reuniões.", said: "Me mande o que te pedi", judge: "Parou no meio." }],
  questions: ["Me mande o que te pedi", "Faça a passagem dos 17 clientes"],
};

describe("base de comportamento · leitura", () => {
  it("mostra o que o sistema sabe, os itens com quem decidiu, as avaliações, as reclamações e as perguntas", () => {
    const m = personMessage(claim);
    expect(m).toContain("Pessoa: Ana Equipe (colaborador) · equipes: Squad Primogênito");
    expect(m).toContain("Clientes que mais consulta com a MAVI (90 dias): 5022 (12)");
    expect(m).toContain("preferência · escrito pela pessoa: Seja direta.");
    expect(m).toContain("frustração · removido: Removido.");
    expect(m).toContain("👎 formato ruim — “Sempre quero em tabela” · pergunta: Quais clientes estão frios?");
    expect(m).toContain("ela disse: “Me mande o que te pedi” · conferência da MAVI: Parou no meio.");
    expect(m).toContain("- Faça a passagem dos 17 clientes");
  });

  it("as mudanças: só os tipos conhecidos, com texto", () => {
    expect(
      parsePersonOps(
        '{"ops":[{"op":"add","kind":"preference","text":"Responda em tabela."},{"op":"add","kind":"humor","text":"x y z"},{"op":"add","kind":"context","text":"a"},{"op":"retire","id":"i1"}]}',
      ),
    ).toEqual([
      { op: "add", kind: "preference", text: "Responda em tabela." },
      { op: "retire", id: "i1" },
    ]);
    expect(() => parsePersonOps("nada")).toThrow(/JSON/);
  });

  it("no contexto da pergunta: por grupo, com os clientes e as equipes", () => {
    expect(personContext(null)).toBe("");
    expect(personContext({ items: [], facts: { role: "member", teams: [], clients: [] } })).toBe("");
    const text = personContext({
      items: [
        { kind: "preference", text: "Responda em tabela." },
        { kind: "frustration", text: "Não pare no meio." },
      ],
      facts: { role: "member", teams: ["Squad Primogênito"], clients: [{ id: "k1", name: "5022", n: 3 }] },
    });
    expect(text).toContain("- Como prefere as respostas: Responda em tabela.");
    expect(text).toContain("- Evite: Não pare no meio.");
    expect(text).toContain("- Clientes que mais consulta com você: 5022.");
    expect(text).toContain("- Equipes: Squad Primogênito.");
  });

  it("o juiz lê o jeito da pessoa", () => {
    const text = judgeMessage(
      {
        message: 1,
        company,
        conversation,
        signals: ["frustration"],
        question: "Q",
        answer: "A",
        steps: null,
        artifacts: [],
        client: null,
        sources: [],
        dossier: [],
        person: [],
        traits: [{ kind: "preference", text: "Responda em tabela." }],
      },
      null,
    );
    expect(text).toContain("O jeito desta pessoa (a base de comportamento dela):\n- preference: Responda em tabela.");
  });
});

function database(routes: Record<string, unknown | ((b: any) => unknown)>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    const value = key ? routes[key] : [];
    return new Response(JSON.stringify(typeof value === "function" ? (value as (b: any) => unknown)(body) : value), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("base de comportamento · worker", () => {
  it("depois da autoavaliação, lê uma pessoa por vez e grava as mudanças com o gasto", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_learning_claim": null,
      "rpc/mavi_learning_claim": null,
      "rpc/mavi_judge_claim": [],
      "rpc/mavi_person_claim": () => (claims++ === 0 ? claim : null),
      "rpc/ai_worker_route": null,
      "rpc/mavi_person_store": 1,
    });
    const requests: AgentRequest[] = [];
    const llm: LlmAdapter = async (req) => {
      requests.push(req);
      const meter = newMeter("claude-opus-5-5");
      meter.cost = 0.01;
      return { text: '{"ops":[{"op":"add","kind":"preference","text":"Responda listas de clientes em tabela."}]}', meter, rounds: 0 };
    };
    const deps = { fetch: fetchImpl, llm, embed: vi.fn() };
    const res = await handleLearningWorker(`Bearer ${env.workerSecret}`, lenv, deps, {
      env,
      deps,
      judge: { env, deps, budgetMs: 60_000 },
    });
    expect((res.body as any).people).toEqual({ people: 1, changes: 1, failed: 0 });
    expect(requests[0].instructions).toContain("Nunca julgue a pessoa");
    const store = calls.find((c) => c.url.endsWith("/rpc/mavi_person_store"))!;
    expect(store.body).toMatchObject({
      p_company: company,
      p_user: me,
      p_ops: [{ op: "add", kind: "preference", text: "Responda listas de clientes em tabela." }],
    });
    expect(store.body.p_usage).toMatchObject({ cost: 0.01 });
    const route = calls.find((c) => c.url.endsWith("/rpc/ai_worker_route"))!;
    expect(route.body.p_feature).toBe("mavi_learning");
  });
});

describe("base de comportamento · na pergunta", () => {
  it("o que a MAVI sabe de quem pergunta entra no contexto", async () => {
    const { fetchImpl } = database({
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_my_powers": [],
      "rpc/ai_run_start": { id: run, conversation, created: true },
      "rpc/ai_save_turn": conversation,
      "rpc/mavi_person_context": {
        items: [{ kind: "preference", text: "Responda listas de clientes em tabela." }],
        facts: { role: "member", teams: [], clients: [] },
      },
    });
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      return { text: "Pronto.", meter: newMeter("claude-opus-5-5"), rounds: 0 };
    };
    await streamAi(
      { action: "ai-ask", company, question: "Quais clientes estão frios?", surface: "page" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      () => {},
      { onClose: () => {} },
    );
    expect(request!.context).toContain("Sobre quem pergunta");
    expect(request!.context).toContain("- Como prefere as respostas: Responda listas de clientes em tabela.");
  });
});

import { describe, expect, it, vi } from "vitest";
import { streamAi, type AiEnv, type AiStreamEvent } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import { handleLearningWorker, type LearningEnv } from "./_copilot-learning";
import {
  learningContext,
  maviLearningMessage,
  parseMaviLearningOps,
  type MaviClaim,
} from "./_mavi-learning";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const clientA = "00000000-0000-4000-8000-00000000000a";
const product = "00000000-0000-4000-8000-00000000000c";
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

const fb = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  user: `u${id}`,
  leader: false,
  client_id: clientA,
  client: "5022",
  product_id: product,
  product: "Make Ads",
  module: "assistant",
  vote: "down" as const,
  reason: "incomplete",
  comment: "",
  question: "Faça a passagem dos 17 clientes",
  answer: "Agora vou puxar as reuniões de cada cliente.",
  steps: "Procurando 17 clientes (17 clientes); Chegou ao limite de passos desta resposta (limite de passos)",
  at: "2026-09-30T12:00:00Z",
  ...over,
});
const claim: MaviClaim = {
  company,
  feedback: [fb(21, { comment: "Me mande o que pedi" }), fb(22, { user: "u21", reason: "wrong" }), fb(23, { vote: "up", reason: null, comment: "Ótima tabela" })],
  lessons: [
    {
      id: "00000000-0000-4000-8000-0000000000e1",
      scope: "company",
      client_id: null,
      client: null,
      product_id: null,
      product: null,
      kind: "tasks",
      text: "Excluída",
      status: "dismissed",
      origin: "mavi",
      people: 2,
    },
  ],
};

describe("aprendizado da MAVI · prompt", () => {
  it("mostra pergunta, trecho da resposta, passos, motivo e comentário, sem expor quem votou", () => {
    const m = maviLearningMessage(claim);
    expect(m).toContain("[F1] 👎 pessoa 1 · cliente 5022 · produto Make Ads");
    expect(m).toContain("  pergunta: Faça a passagem dos 17 clientes");
    expect(m).toContain("  resposta (trecho): Agora vou puxar as reuniões de cada cliente.");
    expect(m).toContain("  passos: Procurando 17 clientes");
    expect(m).toContain("  motivo: não terminou o pedido");
    expect(m).toContain("  comentário: Me mande o que pedi");
    // A mesma pessoa, o mesmo número.
    expect(m).toContain("[F2] 👎 pessoa 1");
    expect(m).toContain("[F3] 👍 pessoa 2");
    expect(m).not.toContain("u21");
    expect(m).toContain("excluído por líder: Excluída");
  });

  it("as mudanças: [F#] viram ids, o alcance vem das avaliações e o assunto é conferido", () => {
    const ops = parseMaviLearningOps(
      'Aqui: {"ops":[{"op":"add","scope":"client","kind":"tasks","text":"No 5022, faça a passagem como tarefa longa.","feedback":["F1","F2"]},{"op":"add","scope":"product","kind":"inventado","text":"Em Make Ads, comece pelas campanhas.","feedback":["F3"]},{"op":"add","scope":"client","text":"Sem evidência","feedback":["F9"]},{"op":"retire","id":"x"}]}',
      claim,
    );
    expect(ops).toEqual([
      { op: "add", scope: "client", client_id: clientA, kind: "tasks", text: "No 5022, faça a passagem como tarefa longa.", feedback: [21, 22] },
      { op: "add", scope: "product", product_id: product, text: "Em Make Ads, comece pelas campanhas.", feedback: [23] },
      { op: "retire", id: "x" },
    ]);
    expect(() => parseMaviLearningOps("sem json", claim)).toThrow(/JSON/);
  });

  it("no contexto da pergunta: aprendizados para seguir e recusas recentes para evitar", () => {
    expect(learningContext(null)).toBe("");
    expect(learningContext({ lessons: [], rejected: [] })).toBe("");
    const text = learningContext({
      lessons: [{ id: "l1", scope: "client", kind: "facts", text: "O gestor do 5022 agora é o Pedro." }],
      rejected: [{ reason: "format", comment: "Queria em tabela", question: "Quais clientes estão frios?", at: "" }],
    });
    expect(text).toContain("[L1] Cliente · facts: O gestor do 5022 agora é o Pedro.");
    expect(text).toContain("[R1] formato ruim — “Queria em tabela” (pergunta: “Quais clientes estão frios?”)");
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

describe("aprendizado da MAVI · worker", () => {
  it("o mesmo agendamento do Copiloto aprende com as avaliações das respostas", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_learning_claim": null,
      "rpc/mavi_learning_claim": () => (claims++ === 0 ? claim : null),
      "rpc/ai_worker_route": null,
      "rpc/mavi_learning_store": 1,
    });
    const requests: AgentRequest[] = [];
    const llm: LlmAdapter = async (req) => {
      requests.push(req);
      const meter = newMeter("claude-opus-5-5");
      meter.cost = 0.02;
      return {
        text: '{"ops":[{"op":"add","scope":"company","kind":"tasks","text":"Em pedidos com mais de 4 clientes, monte uma tarefa longa.","feedback":["F1","F2"]}]}',
        meter,
        rounds: 0,
      };
    };
    const deps = { fetch: fetchImpl, llm, embed: vi.fn() };
    const res = await handleLearningWorker(`Bearer ${env.workerSecret}`, lenv, deps, { env, deps });
    expect(res.body).toEqual({ companies: 0, changes: 0, failed: 0, mavi: { companies: 1, changes: 1, failed: 0 } });
    expect(requests[0].instructions).toContain("O time avalia cada resposta sua");
    const route = calls.find((c) => c.url.includes("rpc/ai_worker_route"))!;
    expect(route.body.p_feature).toBe("mavi_learning");
    const store = calls.find((c) => c.url.includes("rpc/mavi_learning_store"))!;
    expect(store.body.p_learned).toEqual([21, 22, 23]);
    expect(store.body.p_ops[0]).toMatchObject({ scope: "company", kind: "tasks", feedback: [21, 22] });
    expect(store.body.p_usage).toMatchObject({ cost: 0.02, model: "claude-opus-5-5" });
  });

  it("falha: a empresa volta para a fila mais tarde", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_learning_claim": null,
      "rpc/mavi_learning_claim": () => (claims++ === 0 ? claim : null),
      "rpc/ai_worker_route": null,
      "rpc/mavi_learning_fail": null,
    });
    const llm: LlmAdapter = async () => ({ text: "não sei", meter: newMeter("x"), rounds: 0 });
    const deps = { fetch: fetchImpl, llm, embed: vi.fn() };
    const res = await handleLearningWorker(`Bearer ${env.workerSecret}`, lenv, deps, { env, deps });
    expect((res.body as any).mavi).toEqual({ companies: 0, changes: 0, failed: 1 });
    const fail = calls.find((c) => c.url.includes("rpc/mavi_learning_fail"))!;
    expect(fail.body.p_error).toMatch(/JSON/);
  });
});

describe("aprendizado da MAVI · na pergunta", () => {
  it("os aprendizados em uso entram no contexto e aparecem nos passos", async () => {
    const { fetchImpl, calls } = database({
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "/rest/v1/clients?": [{ id: clientA, name: "5022" }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_my_powers": [],
      "rpc/ai_run_start": { id: run, conversation, created: true },
      "rpc/ai_save_turn": conversation,
      "rpc/mavi_learning_context": {
        lessons: [{ id: "l1", scope: "company", kind: "format", text: "Listas de clientes vão em tabela." }],
        rejected: [],
      },
    });
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      return { text: "Pronto.", meter: newMeter("claude-opus-5-5"), rounds: 0 };
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, question: "Quais clientes estão frios?", surface: "page", scope: { client: clientA } },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
      { onClose: () => {} },
    );
    expect(request!.context).toContain("[L1] Empresa · format: Listas de clientes vão em tabela.");
    const [ctx] = calls.filter((c) => c.url.endsWith("/rpc/mavi_learning_context"));
    expect(ctx.body).toEqual({ p_company: company, p_client: clientA, p_contract: null });
    expect(events.some((e) => e.type === "step" && e.label === "Seguindo 1 aprendizado do time")).toBe(true);
  });

  it("sem a migração (ou com erro), a pergunta segue sem aprendizados", async () => {
    const { fetchImpl } = database({
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_save_turn": conversation,
    });
    const fetchFail = (async (url: string, init?: RequestInit) =>
      String(url).endsWith("/rpc/mavi_learning_context")
        ? new Response(JSON.stringify({ message: "function not found" }), { status: 404 })
        : fetchImpl(url, init)) as typeof fetch;
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      return { text: "Pronto.", meter: newMeter("claude-opus-5-5"), rounds: 0 };
    };
    const events: AiStreamEvent[] = [];
    await streamAi({ action: "ai-ask", company, question: "Oi, tudo bem?" }, token, env, { fetch: fetchFail, llm, embed: vi.fn() }, (e) =>
      events.push(e),
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(request!.context).not.toContain("Aprendizados do time");
  });
});

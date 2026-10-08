import { describe, expect, it, vi } from "vitest";
import { chooseRoute, classify, releasedCandidates, serverCandidates, strongerThan, type RouteContext } from "./_ai-router";
import { REPLAY_MISSING, evalSetItem, jsonShape, replayExecutor, runEvalSet, type EvalSetItem } from "./_ai-eval-set";
import { resetSampleClock, sampledLlm, workerSpot, type SampleRequest } from "./_ai-samples";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import type { CompanyKit } from "./_mavi-judge";
import { newMeter } from "./_social-leads";

const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
};
const claude = serverCandidates(true);
const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  mode: "active",
  level: "equilibrado",
  escalate: true,
  escalateCap: 5,
  sigiloso: false,
  restricted: false,
  server: true,
  candidates: claude,
  stats: [],
  personBad: [],
  ...over,
});
const simple = classify({ question: "Qual o e-mail do cliente?", surface: "page", feature: "mavi_page" });

describe("liberação pelo conjunto de avaliação", () => {
  it("desligada: todos; ligada: só os aprovados; nenhum aprovado: todos, com aviso", () => {
    expect(releasedCandidates(ctx()).list).toHaveLength(claude.length);
    const gated = ctx({ gate: true, approved: [{ providerId: null, model: "claude-sonnet-5" }] });
    expect(releasedCandidates(gated).list.map((c) => c.model)).toEqual(["claude-sonnet-5"]);
    const none = releasedCandidates(ctx({ gate: true, approved: [] }));
    expect(none.list).toHaveLength(claude.length);
    expect(none.note).toMatch(/nenhum modelo aprovado/);
  });

  it("o roteador escolhe entre os aprovados (mesmo quando um mais barato atenderia) e diz no motivo", () => {
    expect(chooseRoute({ signals: simple, ctx: ctx(), current: null }).pick?.model).toBe("claude-haiku-4-5");
    const ch = chooseRoute({ signals: simple, ctx: ctx({ gate: true, approved: [{ providerId: null, model: "claude-sonnet-5" }] }), current: null });
    expect(ch.pick?.model).toBe("claude-sonnet-5");
    expect(ch.decision.reason).toMatch(/só modelos aprovados no conjunto de avaliação/);
    expect(ch.fallbacks).toEqual([]);
  });

  it("a segunda tentativa também fica entre os aprovados", () => {
    const gated = ctx({ gate: true, approved: [{ providerId: null, model: "claude-opus-5" }] });
    expect(strongerThan(gated, simple, { providerId: null, model: "claude-haiku-4-5", kind: "anthropic" })?.model).toBe("claude-opus-5");
  });
});

const request: SampleRequest = {
  instructions: "Você é a MAVI. Responda em JSON quando o módulo pedir.",
  context: "Cliente: ACME.",
  messages: [{ role: "user", content: "Quais tarefas da ACME estão atrasadas?" }],
  tools: [{ name: "find_tasks", description: "Busca tarefas", parameters: { type: "object" } }],
  max_rounds: 6,
  effort: "low",
  max_tokens: 4000,
  calls: [
    { name: "find_tasks", input: { client: "ACME", late: true }, output: "3 tarefas: relatório, arte, site" },
    { name: "find_tasks", input: { client: "ACME", status: "done" }, output: "10 entregues" },
  ],
};
const item = (over: Partial<EvalSetItem> = {}): EvalSetItem => ({
  id: 7,
  run: "r1",
  company: "c",
  model: "claude-haiku-4-5",
  provider: null,
  sample: { id: 3, feature: "assistant", request, answer: "São 3: relatório, arte e site.", model: "claude-sonnet-5" },
  ...over,
});
const judge = (text: string, seen: string[] = []): CompanyKit => ({
  llm: (async (r) => {
    seen.push(r.messages[0].content);
    return { text, meter: newMeter("claude-sonnet-5"), rounds: 1 };
  }) as LlmAdapter,
  route: null,
  model: "claude-sonnet-5",
  jev: null,
  jevRoute: null,
});
const recorder = () => {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response("null");
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe("avaliação dinâmica: repetir os registros", () => {
  it("as consultas devolvem o gravado: igual, parecida (avisando) ou nenhuma", async () => {
    const run = replayExecutor(request.calls);
    expect(await run("find_tasks", { late: true, client: "ACME" })).toBe("3 tarefas: relatório, arte, site");
    const near = await run("find_tasks", { client: "ACME", status: "done", limit: 5 });
    expect(near).toMatch(/consulta parecida/);
    expect(near).toContain("10 entregues");
    expect(await run("client_overview", { client: "ACME" })).toBe(REPLAY_MISSING);
  });

  it("o formato JSON: válido, quebrado ou não é JSON", () => {
    expect(jsonShape('{"items":[]}')).toBe(true);
    expect(jsonShape('```json\n{"items":[]}\n```')).toBe(true);
    expect(jsonShape('{"items":[')).toBe(false);
    expect(jsonShape("São 3 tarefas.")).toBeNull();
  });

  it("o modelo recebe a mesma entrada, consulta o gravado; o juiz compara às cegas e grava o resultado", async () => {
    const { calls, fetchImpl } = recorder();
    let t = 0;
    const seenByModel: { instructions: string; context: string; tools: number; effort: unknown; out: string }[] = [];
    const deps = {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed: vi.fn(),
      now: () => (t += 500),
      providerLlm: ((c: { model: string }) =>
        (async (r: any) => {
          const out = await r.execute("find_tasks", { client: "ACME", late: true });
          seenByModel.push({ instructions: r.instructions, context: r.context, tools: r.tools.length, effort: r.effort, out });
          return { text: "Atrasadas: relatório e arte.", meter: newMeter(c.model), rounds: 2 };
        }) as LlmAdapter) as any,
    };
    const seen: string[] = [];
    // O resultado 7 é ímpar: a original é A e o modelo testado é B.
    const outcome = await evalSetItem(env, deps, judge('{"winner":"A","confidence":0.8,"explanation":"Faltou o site."}', seen), item());
    expect(outcome).toBe("loss");
    expect(seenByModel[0]).toMatchObject({ instructions: request.instructions, context: request.context, tools: 1, effort: "low", out: "3 tarefas: relatório, arte, site" });
    expect(seen[0]).toContain("Resposta A:\nSão 3: relatório, arte e site.");
    expect(seen[0]).toContain("Resposta B:\nAtrasadas: relatório e arte.");
    expect(seen[0]).toContain("find_tasks");
    const store = calls.find((c) => c.url.includes("ai_eval_store"))!.body;
    expect(store).toMatchObject({ p_result: 7, p_outcome: "loss", p_explanation: "Faltou o site.", p_ms: 500 });
    expect(store.p_usage).toHaveLength(2);
    // O resultado 8 é par: o modelo testado é A.
    const win = await evalSetItem(env, deps, judge('{"winner":"A","confidence":0.7,"explanation":"Mais completa."}'), item({ id: 8 }));
    expect(win).toBe("win");
  });

  it("o módulo exige JSON e o modelo quebra o formato: perde sem chamar o juiz", async () => {
    const { calls, fetchImpl } = recorder();
    const deps = {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed: vi.fn(),
      providerLlm: ((c: { model: string }) => async () => ({ text: "Achei 2 itens.", meter: newMeter(c.model), rounds: 1 })) as any,
    };
    const seen: string[] = [];
    const outcome = await evalSetItem(env, deps, judge('{"winner":"B"}', seen), item({ sample: { ...item().sample, answer: '{"items":[{"kind":"promessa"}]}' } }));
    expect(outcome).toBe("loss");
    expect(seen).toEqual([]);
    expect(calls.find((c) => c.url.includes("ai_eval_store"))!.body.p_explanation).toMatch(/formato/);
  });

  it("a fila: sem juiz o registro falha e volta para a fila; para quando acaba", async () => {
    let claims = 0;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("ai_eval_claim")) return new Response(JSON.stringify(claims++ === 0 ? [item({ model: env.model })] : []));
      return new Response("null");
    }) as unknown as typeof fetch;
    // Sem regra para o juiz e sem a Claude do servidor: não há quem compare.
    const stats = await runEvalSet({ ...env, anthropicKey: "" }, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn(), now: () => 0 }, 120_000);
    expect(stats).toMatchObject({ cases: 0, failed: 1 });
    expect(calls.some((u) => u.includes("ai_eval_fail"))).toBe(true);
  });
});

describe("avaliação dinâmica: o gravador", () => {
  const db = { supabaseUrl: "https://db.example.com", supabaseKey: "publishable", workerSecret: "s".repeat(40) };
  const answer: LlmAdapter = async (r) => {
    await r.execute("find_tasks", { late: true });
    return { text: "São 3.", meter: newMeter("claude-sonnet-5"), rounds: 2 };
  };
  const base = { instructions: "MAVI", context: "Hoje: 07/10.", messages: [{ role: "user" as const, content: "Atrasadas?" }], tools: request.tools };

  it("grava a entrada, as consultas e a resposta; um a cada 5 minutos por módulo", async () => {
    resetSampleClock();
    const { calls, fetchImpl } = recorder();
    const works: Promise<unknown>[] = [];
    let now = 1_000_000;
    const llm = sampledLlm(answer, {
      ...workerSpot(db, { fetch: fetchImpl }, "c1", "client_radar", { client: "k1", providerId: "p1" }),
      later: (w) => works.push(w),
      now: () => now,
    });
    const r = await llm({ ...base, execute: async () => "3 tarefas", effort: () => "high" });
    expect(r.text).toBe("São 3.");
    await Promise.all(works);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/rpc/ai_sample_save");
    expect(calls[0].body).toMatchObject({ p_secret: db.workerSecret, p_company: "c1", p_feature: "client_radar", p_client: "k1" });
    expect(calls[0].body.p_sample).toMatchObject({ question: "Atrasadas?", answer: "São 3.", provider_id: "p1", model: "claude-sonnet-5", rounds: 2 });
    expect(calls[0].body.p_sample.request).toMatchObject({ instructions: "MAVI", context: "Hoje: 07/10.", effort: "high", calls: [{ name: "find_tasks", input: { late: true }, output: "3 tarefas" }] });
    // Dentro do intervalo: responde sem gravar; depois dele, grava de novo.
    now += 60_000;
    await llm({ ...base, execute: async () => "3 tarefas" });
    now += 5 * 60_000;
    await llm({ ...base, execute: async () => "3 tarefas" });
    await Promise.all(works);
    expect(calls).toHaveLength(2);
  });

  it("nas telas vai com o login de quem pediu; imagens e busca na internet não são gravadas", async () => {
    resetSampleClock();
    const { calls, fetchImpl } = recorder();
    const works: Promise<unknown>[] = [];
    const spot = { db, fetch: fetchImpl, auth: "Bearer user", company: "c1", feature: "assistant", later: (w: Promise<unknown>) => works.push(w) };
    await sampledLlm(answer, spot)({ ...base, messages: [{ role: "user", content: "Veja", images: [{ mediaType: "image/png", data: "x" }] }], execute: async () => "" });
    await sampledLlm(answer, { ...spot, feature: "mavi_page" })({ ...base, webSearch: true, execute: async () => "" });
    await sampledLlm(answer, { ...spot, feature: "task_search" })({ ...base, execute: async () => "ok" });
    await Promise.all(works);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ p_secret: null, p_feature: "task_search" });
  });
});

describe("modelos do roteamento e o Jev", () => {
  const jev = { providerId: "or", provider: "OpenRouter", kind: "openrouter", model: "typesafe/jev-1", price: { id: "typesafe/jev-1", input: 0.1, output: 0.1 } };
  const sonnet = { providerId: "or", provider: "OpenRouter", kind: "openrouter", model: "anthropic/claude-sonnet-4.5", price: { id: "x", input: 3, output: 15 } };

  it("o Jev nunca responde: fica de fora como validador, mesmo sendo o mais barato", () => {
    const ch = chooseRoute({ signals: simple, ctx: ctx({ candidates: [jev, sonnet] }), current: null });
    expect(ch.pick?.model).toBe("anthropic/claude-sonnet-4.5");
    expect(ch.decision.scored.find((x) => x.model === "typesafe/jev-1")?.out).toBe("validador (não responde)");
    expect(ch.fallbacks.some((c) => c.model === "typesafe/jev-1")).toBe(false);
    expect(strongerThan(ctx({ candidates: [jev] }), simple, { providerId: null, model: "claude-haiku-4-5", kind: "anthropic" })).toBeNull();
  });

  it("só os modelos marcados (o Servidor pelo id zero); nenhum disponível: todos, com aviso", () => {
    const only = ctx({ routeModels: ["00000000-0000-0000-0000-000000000000|claude-opus-5"] });
    const ch = chooseRoute({ signals: simple, ctx: only, current: null });
    expect(ch.pick?.model).toBe("claude-opus-5");
    expect(ch.fallbacks).toEqual([]);
    const gone = chooseRoute({ signals: simple, ctx: ctx({ routeModels: ["x|y"] }), current: null });
    expect(gone.pick?.model).toBe("claude-haiku-4-5");
    expect(gone.decision.reason).toMatch(/nenhum dos modelos marcados/);
    // Com a liberação junto: os marcados e aprovados.
    const both = ctx({
      routeModels: ["00000000-0000-0000-0000-000000000000|claude-opus-5", "00000000-0000-0000-0000-000000000000|claude-sonnet-5"],
      gate: true,
      approved: [{ providerId: null, model: "claude-sonnet-5" }],
    });
    expect(chooseRoute({ signals: simple, ctx: both, current: null }).pick?.model).toBe("claude-sonnet-5");
  });

  it("a regra travada continua valendo fora da lista", () => {
    const locked = chooseRoute({
      signals: simple,
      ctx: ctx({ routeModels: ["00000000-0000-0000-0000-000000000000|claude-opus-5"] }),
      current: { scope: "client", provider_id: "p9", model: "gpt-x", auto: false },
    });
    expect(locked.apply).toBe(false);
    expect(locked.decision.mode).toBe("locked");
  });
});

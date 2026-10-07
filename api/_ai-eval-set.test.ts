import { describe, expect, it, vi } from "vitest";
import { chooseRoute, classify, releasedCandidates, serverCandidates, strongerThan, type RouteContext } from "./_ai-router";
import { caseMaterial, evalSetItem, parseScore, runEvalSet, type EvalSetItem } from "./_ai-eval-set";
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

const item = (over: Partial<EvalSetItem> = {}): EvalSetItem => ({
  id: 7,
  run: "r1",
  company: "c",
  model: "gpt-5-mini",
  provider: { provider_id: "p1", provider: "OpenAI", kind: "openai", base_url: null, key_cipher: "v1:x", price: { id: "gpt-5-mini", input: 0.25, output: 2 } },
  case: {
    id: "k1",
    question: "Qual o prazo do relatório?",
    reference: "Toda sexta, até 18h.",
    material: { client: "ACME", sources: [{ ref: "S1", type: "meeting", title: "Kickoff", date: null, excerpt: "Relatório às sextas." }], dossier: [] },
    context: "Combinado em 02/09.",
    task_type: null,
    client: "ACME",
  },
  ...over,
});

describe("conjunto de avaliação", () => {
  it("nota de 0 a 1 do juiz", () => {
    expect(parseScore('{"score": 1.3, "explanation": "ok"}')).toEqual({ score: 1, explanation: "ok" });
    expect(() => parseScore('{"explanation":"x"}')).toThrow("nota");
    expect(() => parseScore("nada")).toThrow();
  });

  it("o material: o congelado e o de apoio juntos", () => {
    const m = caseMaterial(item().case);
    expect(m).toContain("Cliente: ACME");
    expect(m).toContain("[S1] meeting “Kickoff”: Relatório às sextas.");
    expect(m).toContain("Material de apoio:\nCombinado em 02/09.");
    expect(caseMaterial({ ...item().case, material: null, context: null, client: null })).toBe("");
  });

  it("o modelo responde com o material, o juiz compara com a referência, grava nota, espera e tipo", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("null");
    }) as unknown as typeof fetch;
    let t = 0;
    const made: string[] = [];
    const deps = {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed: vi.fn(),
      now: () => (t += 500),
      providerLlm: ((c: { model: string; apiKey: string }) => {
        made.push(c.model);
        return async () => ({ text: "Sexta, 18h [S1].", meter: newMeter(c.model), rounds: 1 });
      }) as any,
    };
    let judged = "";
    const kit: CompanyKit = {
      llm: (async (r) => {
        judged = r.messages[0].content;
        return { text: '{"score":0.92,"explanation":"Completa."}', meter: newMeter("claude-sonnet-5"), rounds: 1 };
      }) as LlmAdapter,
      route: null,
      model: "claude-sonnet-5",
      jev: null,
      jevRoute: null,
    };
    // A chave selada não abre sem a AI_PROVIDER_KEY: o caso falha com a mensagem dela.
    await expect(evalSetItem(env, deps, kit, item())).rejects.toThrow(/AI_PROVIDER_KEY/);
    const score = await evalSetItem(env, deps, kit, item({ model: "claude-haiku-4-5", provider: null }));
    expect(score).toBe(0.92);
    expect(made).toEqual(["claude-haiku-4-5"]);
    expect(judged).toContain("Resposta de referência:\nToda sexta, até 18h.");
    expect(judged).toContain("Resposta a avaliar:\nSexta, 18h [S1].");
    const store = calls.find((c) => c.url.includes("ai_eval_store"))!.body;
    expect(store).toMatchObject({ p_result: 7, p_score: 0.92, p_ms: 500, p_task_type: "consulta" });
  });

  it("a fila: sem juiz o caso falha e volta para a fila; para quando acaba", async () => {
    let claims = 0;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("ai_eval_claim")) return new Response(JSON.stringify(claims++ === 0 ? [item({ provider: null, model: env.model })] : []));
      return new Response("null");
    }) as unknown as typeof fetch;
    // Sem regra para o juiz e sem a Claude do servidor: não há quem dê a nota.
    const stats = await runEvalSet({ ...env, anthropicKey: "" }, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn(), now: () => 0 }, 120_000);
    expect(stats).toMatchObject({ cases: 0, failed: 1 });
    expect(calls.some((u) => u.includes("ai_eval_fail"))).toBe(true);
  });
});

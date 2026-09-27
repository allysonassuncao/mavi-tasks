import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import {
  handleLearningWorker,
  learningMessage,
  parseLearningOps,
  type LearningEnv,
} from "./_copilot-learning";
import { dossierContext } from "./_copilot";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const clientA = "00000000-0000-4000-8000-00000000000a";
const clientB = "00000000-0000-4000-8000-00000000000b";
const product = "00000000-0000-4000-8000-00000000000c";
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-sonnet-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
};
const lenv: LearningEnv = { ...env, learningModel: "claude-sonnet-5" };

const fb = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  user: `u${id}`,
  leader: false,
  client_id: clientA,
  client: "4282",
  product_id: product,
  product: "Social Media",
  kind: "missing",
  severity: "low",
  title: "Diga quem aprova",
  text: "",
  draft: "Banner interno",
  vote: "down" as const,
  reason: "obvious",
  comment: "",
  at: "2026-09-27T12:00:00Z",
  ...over,
});
const claim = {
  company,
  feedback: [
    fb(11, { comment: "Tarefa interna" }),
    fb(12, { user: "u11" }),
    fb(13, { client_id: clientB, client: "9001", vote: "up", reason: null }),
  ],
  lessons: [
    {
      id: "00000000-0000-4000-8000-0000000000e1",
      scope: "company" as const,
      client_id: null,
      client: null,
      product_id: null,
      product: null,
      kind: null,
      text: "Excluída",
      status: "dismissed" as const,
      origin: "mavi" as const,
      people: 2,
    },
  ],
};

describe("aprendizado · prompt", () => {
  it("conta pessoas sem expor quem votou e mostra motivo e comentário", () => {
    const m = learningMessage(claim);
    expect(m).toContain(
      "[F1] 👎 pessoa 1 · cliente 4282 · produto Social Media",
    );
    expect(m).toContain("[F2] 👎 pessoa 1");
    expect(m).toContain("[F3] 👍 pessoa 2");
    expect(m).toContain("motivo: óbvio");
    expect(m).toContain("comentário: Tarefa interna");
    expect(m).toContain("excluído por líder: Excluída");
    expect(m).not.toContain("u11");
  });

  it("troca [F#] pelos ids e resolve o cliente/produto pelos feedbacks citados", () => {
    const ops = parseLearningOps(
      JSON.stringify({
        ops: [
          {
            op: "add",
            scope: "client",
            kind: "missing",
            text: "Não aponte aprovação em interna.",
            feedback: ["F1", "F2", "F3"],
          },
          { op: "add", scope: "product", text: "Produto", feedback: ["F3"] },
          {
            op: "add",
            scope: "client",
            text: "Sem feedback: sem cliente",
            feedback: [],
          },
          { op: "add", scope: "galaxia", text: "?", feedback: ["F1"] },
          { op: "retire", id: "x" },
        ],
      }),
      claim,
    );
    expect(ops).toEqual([
      {
        op: "add",
        scope: "client",
        client_id: clientA,
        kind: "missing",
        text: "Não aponte aprovação em interna.",
        feedback: [11, 12, 13],
      },
      {
        op: "add",
        scope: "product",
        product_id: product,
        text: "Produto",
        feedback: [13],
      },
      { op: "retire", id: "x" },
    ]);
  });

  it("os aprendizados em uso entram no começo do prompt do copiloto", () => {
    const text = dossierContext({
      throttled: false,
      client: { id: clientA, name: "4282" },
      lessons: [
        {
          id: "1",
          scope: "client",
          kind: "missing",
          text: "Não aponte aprovação em interna.",
        },
        { id: "2", scope: "company", kind: null, text: "Seja breve." },
      ],
    });
    expect(text).toContain(
      '[L1] Este cliente · alertas "missing": Não aponte aprovação em interna.',
    );
    expect(text).toContain("[L2] Empresa: Seja breve.");
  });
});

describe("aprendizado · worker", () => {
  function database(routes: Record<string, unknown | ((b: any) => unknown)>) {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      const key = Object.keys(routes).find((k) => url.includes(k));
      const value = key ? routes[key] : null;
      return new Response(
        JSON.stringify(
          typeof value === "function"
            ? (value as (b: any) => unknown)(body)
            : value,
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("recusa sem o segredo", async () => {
    const res = await handleLearningWorker("Bearer errado", lenv, {
      fetch: vi.fn() as any,
      llm: vi.fn(),
      embed: vi.fn(),
    });
    expect(res.status).toBe(401);
  });

  it("uma empresa por vez: pede as mudanças, grava e marca todos os lidos", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_learning_claim": () => (claims++ === 0 ? claim : null),
      "rpc/ai_worker_route": null,
      "rpc/ai_learning_store": 1,
    });
    const llm: LlmAdapter = async (req) => {
      expect(req.tools).toEqual([]);
      expect(req.messages[0].content).toContain("[F1]");
      const meter = newMeter("claude-sonnet-5");
      meter.cost = 0.01;
      return {
        text: '{"ops":[{"op":"add","scope":"company","text":"Não aponte o óbvio.","feedback":["F1","F3"]}]}',
        meter,
        rounds: 0,
      };
    };
    const res = await handleLearningWorker(`Bearer ${env.workerSecret}`, lenv, {
      fetch: fetchImpl,
      llm,
      embed: vi.fn(),
    });
    expect(res.body).toEqual({ companies: 1, changes: 1, failed: 0 });
    const store = calls.find((c) => c.url.includes("rpc/ai_learning_store"))!;
    expect(store.body.p_secret).toBe(env.workerSecret);
    expect(store.body.p_learned).toEqual([11, 12, 13]);
    expect(store.body.p_ops).toEqual([
      {
        op: "add",
        scope: "company",
        text: "Não aponte o óbvio.",
        feedback: [11, 13],
      },
    ]);
    expect(store.body.p_usage).toMatchObject({ cost: 0.01 });
  });

  it("falha: a empresa volta para a fila mais tarde", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_learning_claim": () => (claims++ === 0 ? claim : null),
      "rpc/ai_worker_route": null,
      "rpc/ai_learning_fail": null,
    });
    const llm: LlmAdapter = async () => ({
      text: "sem json",
      meter: newMeter(),
      rounds: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleLearningWorker(`Bearer ${env.workerSecret}`, lenv, {
      fetch: fetchImpl,
      llm,
      embed: vi.fn(),
    });
    expect(res.body).toEqual({ companies: 0, changes: 0, failed: 1 });
    expect(
      calls.find((c) => c.url.includes("rpc/ai_learning_fail"))!.body.p_company,
    ).toBe(company);
  });
});

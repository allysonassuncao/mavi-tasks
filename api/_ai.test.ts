import { describe, expect, it, vi } from "vitest";
import {
  citedSources,
  handleAi,
  runIndexer,
  streamAi,
  type AiEnv,
  type AiStreamEvent,
} from "./_ai";
import { openAiEmbedder, vectorLiteral } from "./_ai-embeddings";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const me = "00000000-0000-4000-8000-000000000003";
const other = "00000000-0000-4000-8000-000000000004";
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
};

/** Banco falso: respostas por trecho da URL; guarda as chamadas. */
function database(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      url,
      body,
      auth: new Headers(init?.headers).get("Authorization"),
    });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    if (!key) return new Response("[]", { status: 200 });
    const value = routes[key];
    const data =
      typeof value === "function"
        ? (value as (b: any) => unknown)(body)
        : value;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const vec = () => Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));

describe("worker de indexação", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await handleAi({ action: "ai-index" }, "Bearer errado", env, {
      fetch: vi.fn() as any,
      llm: vi.fn(),
      embed: vi.fn(),
    });
    expect(res.status).toBe(401);
  });

  it("monta os documentos, gera vetores em lotes, grava e registra o custo por empresa", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_index_step": () => (claims === 0 ? 3 : 0),
      "rpc/ai_claim_chunks": () =>
        claims++ === 0
          ? [
              { id: 1, company_id: company, content: "a".repeat(300) },
              { id: 2, company_id: company, content: "b".repeat(100) },
            ]
          : [],
      "rpc/ai_store_embeddings": (b: any) => b.p_items.length,
      "rpc/ai_log_indexing": null,
    });
    const embed = vi.fn(async (texts: string[]) => ({
      vectors: texts.map(vec),
      tokens: 400,
      model: "text-embedding-3-small",
    }));
    const stats = await runIndexer(env, {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed,
    });
    expect(stats).toMatchObject({ built: 3, embedded: 2, tokens: 400 });
    const store = calls.find((c) => c.url.includes("ai_store_embeddings"))!;
    expect(store.auth).toBe("Bearer publishable");
    expect(store.body.p_secret).toBe(env.workerSecret);
    expect(store.body.p_items[0]).toEqual({
      id: 1,
      embedding: vectorLiteral(vec()),
    });
    const log = calls.find((c) => c.url.includes("ai_log_indexing"))!;
    expect(log.body.p_items).toEqual([
      { company, tokens: 400, cost: 0.000008 },
    ]);
  });

  it("para quando o tempo acaba", async () => {
    let t = 0;
    const { fetchImpl } = database({
      "rpc/ai_index_step": 1,
      "rpc/ai_claim_chunks": [],
    });
    const stats = await runIndexer(
      { ...env, workerBudgetMs: 10_000 },
      {
        fetch: fetchImpl,
        llm: vi.fn(),
        embed: vi.fn(),
        now: () => (t += 1000),
      },
    );
    expect(stats.built).toBeGreaterThan(0);
    expect(stats.built).toBeLessThan(10);
  });
});

describe("pergunta à IA", () => {
  const routes = () => ({
    "memberships?": [
      {
        user_id: me,
        name: "Ana Admin",
        email: "ana@x.com",
        role: "admin",
        active: true,
      },
      {
        user_id: other,
        name: "Bruno Lima",
        email: "bruno@x.com",
        role: "member",
        active: true,
      },
    ],
    "clients?": [{ id: client, name: "4282" }],
    "contracts?select=id,name,archived,products": [
      {
        id: "k1",
        name: "Make Ads",
        archived: false,
        products: { name: "Make Ads" },
      },
    ],
    "projects?": [{ id: "p1", name: "Lançamento", contract_id: "k1" }],
    "contracts?select=id&": [{ id: "k1" }],
    "rpc/ai_search": [
      {
        chunk_id: 77,
        source_type: "meeting",
        source_id: "m1",
        title: "Alinhamento",
        content:
          '[Reunião] "Alinhamento" · cliente 4282\n[02:10] Ana: A verba é de 3 mil.',
        meta: { kind: "transcript", start: 130 },
        client_id: client,
        occurred_at: "2026-09-10T13:00:00Z",
        task_status: null,
        task_assignee: null,
        task_due: null,
      },
      {
        chunk_id: 78,
        source_type: "task",
        source_id: "t1",
        title: "Subir campanha",
        content: '[Tarefa] "Subir campanha"\nCriar a campanha de 3 mil.',
        meta: { kind: "task" },
        client_id: client,
        occurred_at: "2026-09-11T13:00:00Z",
        task_status: "review",
        task_assignee: other,
        task_due: "2026-09-20",
      },
    ],
    "tasks?": [
      {
        id: "t2",
        title: "Relatório",
        status: "progress",
        due_date: "2026-09-01",
        assignee_id: other,
        created_at: "2026-08-20",
      },
    ],
    "rpc/ai_log_usage": null,
  });

  it("dá contexto, deixa o modelo buscar e devolve só as fontes citadas", async () => {
    const { fetchImpl, calls } = database(routes());
    let seen: AgentRequest | undefined;
    const results: string[] = [];
    const llm: LlmAdapter = async (request) => {
      seen = request;
      results.push(
        await request.execute("search_knowledge", {
          query: "verba",
          client_id: "00000000-0000-4000-8000-00000000ffff",
        }),
      );
      results.push(await request.execute("list_tasks", { overdue_only: true }));
      const meter = newMeter("claude-opus-5");
      meter.input = 2000;
      meter.output = 100;
      meter.cost = 0.0125;
      return {
        text: "A verba é de 3 mil [S1], com tarefa em validação [S2].",
        meter,
        rounds: 1,
      };
    };
    const embed = vi.fn(async () => ({
      vectors: [vec()],
      tokens: 5,
      model: "text-embedding-3-small",
    }));
    const res = await handleAi(
      {
        action: "ai-ask",
        company,
        scope: { client, module: "meetings" },
        question: "Qual a verba?",
        history: [
          { role: "user", content: "Oi" },
          { role: "assistant", content: "Olá [S9]" },
        ],
      },
      token(me),
      env,
      {
        fetch: fetchImpl,
        llm,
        embed,
        now: () => Date.parse("2026-09-26T12:00:00Z"),
      },
    );
    expect(res.status).toBe(200);
    // Contexto: data, quem pergunta, cliente, produtos e projetos.
    expect(seen!.context).toContain("2026-09-26");
    expect(seen!.context).toContain("Ana Admin (administrador)");
    expect(seen!.context).toContain('cliente "4282"');
    expect(seen!.context).toContain("Make Ads — projetos: Lançamento");
    // Referências antigas saem do histórico.
    expect(seen!.messages).toEqual([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Olá " },
      { role: "user", content: "Qual a verba?" },
    ]);
    // O escopo manda: a busca fica no cliente aberto, não no pedido do modelo.
    const search = calls.find((c) => c.url.includes("rpc/ai_search"))!;
    expect(search.auth).toBe(token(me));
    expect(search.body.p_filters.client).toBe(client);
    expect(results[0]).toContain(
      '[S1] Reunião "Alinhamento" · 10/09/2026 · a partir de 02:10',
    );
    expect(results[0]).toContain("[02:10] Ana: A verba é de 3 mil.");
    expect(results[0]).not.toContain("[Reunião]");
    expect(results[0]).toContain(
      '[S2] Tarefa "Subir campanha" · Em validação · responsável Bruno Lima · prazo 20/09/2026',
    );
    // Tarefas atrasadas: filtros e estado atual.
    const tasks = calls.find((c) => c.url.includes("/rest/v1/tasks?"))!;
    expect(tasks.url).toContain("contract_id=in.(k1)");
    expect(tasks.url).toContain("due_date=lt.2026-09-26");
    expect(results[1]).toContain(
      '[S3] "Relatório" · Em andamento · responsável Bruno Lima · prazo 01/09/2026 (atrasada)',
    );
    expect(res.body.sources).toEqual([
      {
        ref: "S1",
        type: "meeting",
        id: "m1",
        title: "Alinhamento",
        date: "2026-09-10T13:00:00Z",
        client_id: client,
        start: 130,
      },
      {
        ref: "S2",
        type: "task",
        id: "t1",
        title: "Subir campanha",
        date: "2026-09-11T13:00:00Z",
        client_id: client,
      },
    ]);
    const usage = calls.find((c) => c.url.includes("ai_log_usage"))!;
    expect(usage.body).toMatchObject({
      p_company: company,
      p_module: "meetings",
      p_client: client,
      p_input: 2000,
      p_embedding: 5,
      p_cost: 0.0125,
    });
  });

  it("cliente fora do alcance da pessoa: recusa sem chamar a IA", async () => {
    const { fetchImpl } = database({ ...routes(), "clients?": [] });
    const llm = vi.fn();
    const res = await handleAi(
      {
        action: "ai-ask",
        company,
        scope: { client },
        question: "Qual a verba?",
      },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(res.status).toBe(403);
    expect(llm).not.toHaveBeenCalled();
  });

  it("registra o custo mesmo quando a IA falha", async () => {
    const { fetchImpl, calls } = database(routes());
    const llm: LlmAdapter = async (request) => {
      await request.execute("search_knowledge", { query: "verba" });
      throw Object.assign(new Error("boom"), { status: 529 });
    };
    const res = await handleAi(
      {
        action: "ai-ask",
        company,
        scope: { client },
        question: "Qual a verba?",
      },
      token(me),
      env,
      {
        fetch: fetchImpl,
        llm,
        embed: async () => ({
          vectors: [vec()],
          tokens: 7,
          model: "text-embedding-3-small",
        }),
      },
    );
    expect(res.status).toBe(529);
    expect(
      calls.find((c) => c.url.includes("ai_log_usage"))?.body.p_embedding,
    ).toBe(7);
  });

  it("citações repetidas e inexistentes", () => {
    const sources = [
      {
        ref: "S1",
        type: "task" as const,
        id: "a",
        title: "A",
        date: null,
        client_id: null,
      },
      {
        ref: "S2",
        type: "task" as const,
        id: "b",
        title: "B",
        date: null,
        client_id: null,
      },
    ];
    expect(
      citedSources("x [S2] y [S1][S2] z [S7]", sources).map((s) => s.ref),
    ).toEqual(["S2", "S1"]);
  });
});

describe("embeddings da OpenAI", () => {
  it("tenta de novo em 429 e devolve na ordem pedida", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      n++ === 0
        ? new Response("{}", { status: 429, headers: { "retry-after": "0" } })
        : new Response(
            JSON.stringify({
              data: [
                { index: 1, embedding: [2] },
                { index: 0, embedding: [1] },
              ],
              usage: { total_tokens: 9 },
            }),
          ),
    ) as unknown as typeof fetch;
    const out = await openAiEmbedder(env, fetchImpl)(["a", "b"]);
    expect(out).toEqual({
      vectors: [[1], [2]],
      tokens: 9,
      model: "text-embedding-3-small",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("sem chave, avisa o que falta", async () => {
    await expect(
      openAiEmbedder({ ...env, openaiKey: "" })(["a"]),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe("pergunta em tempo real (fase 2)", () => {
  const base = () => ({
    "memberships?": [
      {
        user_id: me,
        name: "Ana Admin",
        email: "ana@x.com",
        role: "admin",
        active: true,
      },
    ],
    "clients?": [{ id: client, name: "4282" }],
    "contracts?select=id,name,archived,products": [],
    "rpc/ai_check_limits": {
      blocked: false,
      message: null,
      warnings: ["O uso de IA deste cliente está em 85% do limite do mês."],
    },
    "rpc/ai_search": [
      {
        chunk_id: 1,
        source_type: "meeting",
        source_id: "m1",
        title: "Alinhamento",
        content: "[Reunião]\n[01:00] Ana: verba de 3 mil",
        meta: { start: 60 },
        client_id: client,
        occurred_at: "2026-09-10T13:00:00Z",
        task_status: null,
        task_assignee: null,
        task_due: null,
      },
    ],
    "rpc/ai_save_turn": "00000000-0000-4000-8000-0000000000c1",
    "rpc/ai_log_usage": null,
  });
  const llm: LlmAdapter = async (request) => {
    request.onEvent?.({ type: "thinking", text: "Vou procurar a verba." });
    request.onEvent?.({ type: "text", text: "Vou buscar." });
    request.onEvent?.({ type: "round_end", tools: 1 });
    await request.execute("search_knowledge", { query: "verba" });
    request.onEvent?.({ type: "text", text: "A verba é 3 mil [S1]." });
    return {
      text: "A verba é 3 mil [S1].",
      meter: newMeter("claude-opus-5"),
      rounds: 1,
    };
  };

  it("mostra cada passo, repassa raciocínio e texto, avisa o limite e salva a conversa", async () => {
    const { fetchImpl, calls } = database(base());
    const events: AiStreamEvent[] = [];
    await streamAi(
      {
        action: "ai-ask",
        company,
        scope: { client, module: "assistant" },
        question: "Qual a verba?",
      },
      token(me),
      env,
      {
        fetch: fetchImpl,
        llm,
        embed: async () => ({
          vectors: [vec()],
          tokens: 3,
          model: "text-embedding-3-small",
        }),
      },
      (e) => events.push(e),
    );
    const kinds = events.map((e) =>
      e.type === "step" ? `step:${e.id}:${e.state}` : e.type,
    );
    expect(kinds).toEqual([
      "step:ctx:running",
      "warning",
      "step:ctx:done",
      "thinking",
      "text",
      "round_end",
      "step:t1:running",
      "step:t1:done",
      "text",
      "done",
    ]);
    const tool = events.find(
      (e) => e.type === "step" && e.id === "t1" && e.state === "done",
    );
    expect(tool).toMatchObject({
      label: "Buscando “verba” nas reuniões e tarefas",
      detail: "1 trecho encontrado",
    });
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.conversation).toBe("00000000-0000-4000-8000-0000000000c1");
    expect(done.sources.map((x) => x.ref)).toEqual(["S1"]);
    const save = calls.find((c) => c.url.includes("ai_save_turn"))!;
    expect(save.body).toMatchObject({
      p_company: company,
      p_conversation: null,
      p_scope: { client },
      p_module: "assistant",
      p_question: "Qual a verba?",
      p_answer: "A verba é 3 mil [S1].",
      p_steps: [
        {
          label: "Buscando “verba” nas reuniões e tarefas",
          detail: "1 trecho encontrado",
        },
      ],
    });
  });

  it("limite atingido: para antes de chamar a IA", async () => {
    const { fetchImpl } = database({
      ...base(),
      "rpc/ai_check_limits": {
        blocked: true,
        message: "O limite mensal de IA da empresa (US$ 10,00) foi atingido.",
        warnings: [],
      },
    });
    const events: AiStreamEvent[] = [];
    const spy = vi.fn(llm);
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Oi?" },
      token(me),
      env,
      { fetch: fetchImpl, llm: spy, embed: vi.fn() },
      (e) => events.push(e),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: "error",
      error: "O limite mensal de IA da empresa (US$ 10,00) foi atingido.",
      status: 429,
    });
  });

  it("continua uma conversa salva com o histórico do banco; só quem começou continua", async () => {
    const conversation = "00000000-0000-4000-8000-0000000000c1";
    const { fetchImpl } = database({
      ...base(),
      "ai_conversations?": [{ owner_id: me }],
      "ai_messages?": [
        { role: "assistant", content: "A verba é 3 mil [S1]." },
        { role: "user", content: "Qual a verba?" },
      ],
    });
    let seen: ChatTurnLike[] = [];
    const capture: LlmAdapter = async (request) => {
      seen = request.messages;
      return { text: "Sim.", meter: newMeter("claude-opus-5"), rounds: 0 };
    };
    await handleAi(
      {
        action: "ai-ask",
        company,
        scope: {},
        question: "E em outubro?",
        conversation,
      },
      token(me),
      env,
      { fetch: fetchImpl, llm: capture, embed: vi.fn() },
    );
    expect(seen).toEqual([
      { role: "user", content: "Qual a verba?" },
      { role: "assistant", content: "A verba é 3 mil ." },
      { role: "user", content: "E em outubro?" },
    ]);
    const other = database({
      ...base(),
      "ai_conversations?": [{ owner_id: "someone-else" }],
      "ai_messages?": [],
    });
    const res = await handleAi(
      {
        action: "ai-ask",
        company,
        scope: {},
        question: "E em outubro?",
        conversation,
      },
      token(me),
      env,
      { fetch: other.fetchImpl, llm: capture, embed: vi.fn() },
    );
    expect(res).toEqual({
      status: 403,
      body: { error: "Só quem começou a conversa continua nela." },
    });
  });
});

type ChatTurnLike = { role: "user" | "assistant"; content: string };

import { describe, expect, it, vi } from "vitest";
import { describeStep, findTasks, runTool, summarizeStep, TOOLS, type ToolContext } from "./_ai-tools";
import { readPrepared } from "../src/task-search-mavi";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const ana = "00000000-0000-4000-8000-000000000011";
const anaPaula = "00000000-0000-4000-8000-000000000012";
const joao = "00000000-0000-4000-8000-000000000013";
const task = "00000000-0000-4000-8000-0000000000a1";

type Call = { url: string; body: Record<string, unknown> };
function database(rows: unknown[], opts: { timeoutWithVector?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (opts.timeoutWithVector && body.p_embedding)
      return new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), {
        status: 500,
      });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const ctx = (fetchImpl: typeof fetch, scope = {}): ToolContext => ({
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  fetch: fetchImpl,
  auth: "Bearer pessoa",
  company,
  scope,
  embed: vi.fn(async () => ({ vectors: [[0.1, 0.2]], tokens: 7, model: "text-embedding-3-small" })),
  members: new Map([
    [ana, { name: "Ana Souza", email: "" }],
    [anaPaula, { name: "Ana Paula", email: "" }],
    [joao, { name: "João Lima", email: "" }],
  ]),
  clients: new Map([[client, "Clínica Sorriso"]]),
  today: "2026-10-02",
  usage: { embeddingTokens: 0, embeddingModel: "" },
  sources: [],
  chunks: new Map(),
});
const ROW = {
  task: {
    id: task,
    title: "Criar logotipo da clínica",
    status: "done",
    due_date: "2026-09-20",
    assignee_id: ana,
    created_at: "2026-09-01T12:00:00Z",
  },
  match_in: "description",
  snippet: "Três opções de logotipo com a paleta nova",
  comment_id: null,
  rank: 1,
  total: 42,
};

describe("find_tasks: a busca da Busca avançada na conversa da MAVI", () => {
  it("está entre as ferramentas da conversa e busca com termos, assunto e filtros, como a pessoa", async () => {
    expect(TOOLS.some((t) => t.name === "find_tasks")).toBe(true);
    const { fetchImpl, calls } = database([ROW]);
    const c = ctx(fetchImpl);
    const cards: unknown[] = [];
    const out = await findTasks(
      c,
      {
        request: "logo da Clínica entregue pela Ana Souza em setembro",
        terms: ["logo", "logotipo", "Logo", "identidade visual"],
        topic: "criação do logotipo da marca",
        client_id: client,
        assignee: "ana souza",
        status: ["done"],
        from: "2026-09-01",
        to: "2026-09-30",
      },
      (card) => {
        cards.push(card);
        return "B1";
      },
    );
    const rpc = calls.find((x) => x.url.endsWith("/rpc/search_task_rows_mavi"))!;
    expect(rpc.body).toMatchObject({
      p_company: company,
      p_terms: ["logo", "logotipo", "identidade visual"],
      p_embedding: "[0.1,0.2]",
      p_client: client,
      p_assignee: ana,
      p_statuses: ["done"],
      p_from: "2026-09-01",
      p_to: "2026-09-30",
      p_limit: 15,
    });
    expect(c.embed).toHaveBeenCalledWith(["criação do logotipo da marca"]);
    expect(c.usage.embeddingTokens).toBe(7);
    expect(out).toContain("42 tarefas encontradas (aqui a mais relevante).");
    expect(out).toContain('[S1] "Criar logotipo da clínica" · Entregue · responsável Ana Souza · prazo 20/09/2026');
    expect(out).toContain("achada na descrição: “Três opções de logotipo com a paleta nova”");
    expect(out).toContain("[[B1]]");
    expect(c.sources[0]).toMatchObject({ ref: "S1", type: "task", id: task });
    // O botão abre a Busca avançada com a mesma busca.
    const card = cards[0] as { query: string; request: string; total: number };
    expect(card.total).toBe(42);
    const q = new URLSearchParams(card.query);
    expect(q.get("termo")).toBe("logo da Clínica entregue pela Ana Souza em setembro");
    expect(q.get("cli")).toBe(client);
    expect(q.get("resp")).toBe(ana);
    expect(q.get("situacao")).toBe("done");
    expect(q.get("de")).toBe("2026-09-01");
    expect(readPrepared(q.get("mavi"))).toMatchObject({
      terms: ["logo", "logotipo", "identidade visual"],
      topic: "criação do logotipo da marca",
    });
    expect(summarizeStep("find_tasks", out)).toBe("42 tarefas encontradas");
    expect(describeStep(c, "find_tasks", { request: "logo da Clínica" })).toBe("Localizando tarefas “logo da Clínica”");
  });

  it("nome que serve a mais de uma pessoa ou a ninguém volta para a MAVI perguntar", async () => {
    const { fetchImpl, calls } = database([]);
    expect(await findTasks(ctx(fetchImpl), { request: "x", terms: ["logo"], assignee: "ana" })).toMatch(
      /Mais de uma pessoa com "ana" \(responsável\): Ana Souza, Ana Paula/,
    );
    expect(await findTasks(ctx(fetchImpl), { request: "x", terms: ["logo"], creator: "Zeca" })).toMatch(
      /Ninguém da empresa com o nome "Zeca"/,
    );
    expect(await findTasks(ctx(fetchImpl), { request: "x" })).toMatch(/Diga o que procurar/);
    expect(calls).toHaveLength(0);
  });

  it("se o banco desiste pelo tempo com o sentido, busca só pelos termos; fora da conversa, sem botão", async () => {
    const { fetchImpl, calls } = database([ROW], { timeoutWithVector: true });
    const out = await runTool(ctx(fetchImpl), "find_tasks", {
      request: "logo",
      terms: ["logo"],
      topic: "logotipo da marca",
    });
    expect(calls.map((x) => x.body.p_embedding)).toEqual(["[0.1,0.2]", null]);
    expect(out).toContain("Criar logotipo da clínica");
    expect(out).not.toContain("[[B");
  });

  it("termos que só repetem um filtro saem (\"em andamento\" não vira palavra a procurar)", async () => {
    const { fetchImpl, calls } = database([ROW]);
    await findTasks(ctx(fetchImpl), {
      request: "tarefas em andamento da Ana Souza na Clínica",
      terms: ["em andamento", "andamento", "Ana Souza", "Clínica Sorriso", "tarefas"],
      status: ["progress", "review"],
      assignee: "Ana Souza",
      client_id: client,
    });
    expect(calls[0].body).toMatchObject({ p_terms: [], p_statuses: ["progress", "review"], p_assignee: ana });
  });

  it("o cliente do módulo aberto manda sobre o do pedido", async () => {
    const other = "00000000-0000-4000-8000-000000000099";
    const { fetchImpl, calls } = database([]);
    const out = await findTasks(ctx(fetchImpl, { client }), { request: "logo", terms: ["logo"], client_id: other });
    expect(calls[0].body.p_client).toBe(client);
    expect(out).toBe("Nenhuma tarefa encontrada com essa busca.");
  });
});

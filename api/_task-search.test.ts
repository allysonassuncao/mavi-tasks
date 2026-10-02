import { describe, expect, it, vi } from "vitest";
import { handleTaskSearch, keepFilters, narrowCatalog, nameNear, parseSearch, searchContext } from "./_task-search";
import type { AiDeps, AiEnv } from "./_ai";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000003";
const otherClient = "00000000-0000-4000-8000-000000000004";
const contract = "00000000-0000-4000-8000-000000000005";
const project = "00000000-0000-4000-8000-000000000006";
const user = "00000000-0000-4000-8000-000000000010";
const ana = "00000000-0000-4000-8000-000000000011";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.y`;
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  anthropicKey: "sk",
  openaiKey: "ok",
  model: "claude-haiku-4-5",
  providerKey: null,
} as unknown as AiEnv;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

const ANSWER = JSON.stringify({
  filters: { client, assignee: ana, status: "done", from: "2026-09-30", to: "2026-09-01", project: "inventado" },
  terms: ["logo", "Logo", "logotipo", "identidade visual"],
  topic: "criação do logotipo e da identidade visual",
  summary: "Tarefas sobre logotipo da Clínica Sorriso entregues pela Ana em setembro.",
});

function deps(answer = ANSWER, opts: { blocked?: boolean; active?: boolean; embedFails?: boolean } = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/memberships?select=active"))
      return json([{ active: opts.active ?? true, name: "Quem Pede" }]);
    if (url.includes("/memberships"))
      return json([
        { user_id: user, name: "Quem Pede" },
        { user_id: ana, name: "Ana Souza" },
      ]);
    if (url.includes("/clients"))
      return json([
        { id: client, name: "Clínica Sorriso" },
        { id: otherClient, name: "Padaria Pão" },
      ]);
    if (url.includes("/contracts")) return json([{ id: contract, client_id: client }]);
    if (url.includes("/projects")) return json([{ id: project, name: "Lançamento", contract_id: contract }]);
    if (url.endsWith("/ai_check_limits"))
      return json({ blocked: !!opts.blocked, message: opts.blocked ? "Limite do mês atingido." : null });
    return json(null);
  });
  const llm = vi.fn(async () => ({
    text: answer,
    rounds: 1,
    meter: { model: "claude-haiku-4-5", input: 900, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0013 },
  }));
  const embed = vi.fn(async () => {
    if (opts.embedFails) throw new Error("sem vetores");
    return { vectors: [[0.1, 0.2]], tokens: 9, model: "text-embedding-3-small" };
  });
  return { d: { fetch, llm, embed } as unknown as AiDeps, calls, llm, embed };
}

describe("a MAVI na Busca avançada", () => {
  it("entende o pedido: filtros válidos, termos, vetor do assunto e o gasto registrado", async () => {
    const { d, calls, llm, embed } = deps();
    const res = await handleTaskSearch(
      {
        company,
        query: "o que a Ana entregou de logo para a Clínica em setembro",
        today: "2026-10-02",
        filters: { status: "progress", fields: ["title", "description", "comments"] },
      },
      token,
      env,
      d,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      query: "o que a Ana entregou de logo para a Clínica em setembro",
      terms: ["logo", "logotipo", "identidade visual"],
      embedding: "[0.1,0.2]",
      summary: "Tarefas sobre logotipo da Clínica Sorriso entregues pela Ana em setembro.",
      // O projeto inventado sai; as datas trocadas voltam à ordem.
      filters: { client, assignee: ana, status: "done", from: "2026-09-01", to: "2026-09-30" },
    });
    expect((res.body.filters as Record<string, unknown>).project).toBeUndefined();
    expect(embed).toHaveBeenCalledWith(["criação do logotipo e da identidade visual"]);
    const call = (llm.mock.calls[0] as unknown as [{ context: string; messages: { content: string }[] }])[0];
    expect(call.context).toContain("Hoje: 2026-10-02 (sexta-feira)");
    expect(call.context).toContain(`Quem pede: ${user} | Quem Pede`);
    expect(call.context).toContain("Filtros na tela agora: status: progress.");
    expect(call.context).toContain(`${ana} | Ana Souza`);
    expect(call.context).toContain(`${project} | Lançamento | Clínica Sorriso`);
    expect(call.messages[0].content).toContain("o que a Ana entregou de logo");
    const route = calls.find((c) => c.url.endsWith("/ai_resolve_route"));
    expect(JSON.stringify(route?.body)).toContain("task_search");
    const usage = calls.filter((c) => c.url.endsWith("/ai_log_usage")).map((c) => c.body);
    expect(usage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ p_module: "tasks", p_kind: "task_search", p_input: 900, p_output: 80 }),
        expect.objectContaining({ p_kind: "task_search", p_model: "text-embedding-3-small", p_embedding: 9 }),
      ]),
    );
  });

  it("sem o vetor (falhou ou sem assunto), segue só com os termos", async () => {
    const failing = deps(undefined, { embedFails: true });
    const res = await handleTaskSearch({ company, query: "logo da clínica" }, token, env, failing.d);
    expect(res.status).toBe(200);
    expect(res.body.embedding).toBeNull();
    const onlyFilters = deps(JSON.stringify({ filters: { assignee: ana }, terms: [], topic: "", summary: "Da Ana." }));
    const r2 = await handleTaskSearch({ company, query: "tarefas da Ana" }, token, env, onlyFilters.d);
    expect(r2.body).toMatchObject({ terms: [], embedding: null, filters: { assignee: ana } });
    expect(onlyFilters.embed).not.toHaveBeenCalled();
  });

  it("sem pedido, sem login, sem acesso ou no limite de gasto não chama a MAVI", async () => {
    const empty = deps();
    expect((await handleTaskSearch({ company, query: "x" }, token, env, empty.d)).status).toBe(400);
    expect((await handleTaskSearch({ company, query: "logo" }, null, env, empty.d)).status).toBe(401);
    const off = deps(undefined, { active: false });
    expect((await handleTaskSearch({ company, query: "logo" }, token, env, off.d)).status).toBe(403);
    const blocked = deps(undefined, { blocked: true });
    const res = await handleTaskSearch({ company, query: "logo" }, token, env, blocked.d);
    expect(res).toEqual({ status: 429, body: { error: "Limite do mês atingido." } });
    for (const x of [empty, off, blocked]) expect(x.llm).not.toHaveBeenCalled();
  });

  it("resposta que não é JSON vira erro (a tela busca pelas palavras exatas)", async () => {
    const { d } = deps("Não sei.");
    expect((await handleTaskSearch({ company, query: "logo" }, token, env, d)).status).toBe(502);
    expect(parseSearch('```json\n{"terms":["a"]}\n```')).toEqual({ terms: ["a"] });
  });

  it("filtros: só ids conhecidos, status e datas válidos; \"\" tira o filtro", () => {
    const cat = {
      clients: [{ id: client, name: "Clínica" }],
      projects: [],
      people: [{ id: ana, name: "Ana" }],
    };
    expect(
      keepFilters(
        { client: "", creator: ana, assignee: "x", status: "open", from: "2026-13-45", priority: true, fields: ["comments", "x"] },
        cat,
      ),
    ).toEqual({ client: "", creator: ana, priority: true, fields: ["comments"] });
  });

  it("listas longas vão só com os nomes parecidos com o pedido e os já escolhidos", () => {
    expect(nameNear("Clínica Sorriso", ["clinica"])).toBe(true);
    expect(nameNear("Clínica Sorriso", ["sorr"])).toBe(true);
    expect(nameNear("Padaria Pão", ["clinica"])).toBe(false);
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, name: `Cliente ${i}` }));
    const cat = {
      clients: [...many, { id: client, name: "Clínica Sorriso" }],
      projects: [],
      people: [{ id: ana, name: "Ana" }],
    };
    const narrow = narrowCatalog(cat, "logo da clinica", ["c7"]);
    expect(narrow.clients.map((c) => c.id)).toEqual(["c7", client]);
    expect(narrow.people).toHaveLength(1);
    expect(
      searchContext({ today: "2026-10-02", me: null, current: {}, catalog: narrow }),
    ).toContain("Filtros na tela agora: nenhum.");
  });
});

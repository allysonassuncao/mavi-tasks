import { describe, expect, it, vi } from "vitest";
import {
  MCP_VERSIONS,
  handleMcp,
  mcpTools,
  protectedResource,
  sourceLink,
  type McpEnv,
} from "./_mcp";

const company = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000005";
const client = "00000000-0000-4000-8000-000000000002";
const me = "00000000-0000-4000-8000-000000000003";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const env: McpEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  appOrigin: "https://app.example.com",
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
    if (value instanceof Response) return value;
    const data =
      typeof value === "function"
        ? (value as (b: any) => unknown)(body)
        : value;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const vec = () => Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
const workspaces = (allowed = true) => [
  { company_id: company, name: "Agência", role: "admin", allowed },
];
const base = {
  "/auth/v1/user": { id: me },
  "memberships?select": [
    { user_id: me, name: "Ana Souza", email: "ana@x.com", role: "admin", active: true },
  ],
  "clients?select": [{ id: client, name: "4282 · Loja Boa" }],
};
const deps = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  llm: vi.fn(),
  embed: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(vec),
    tokens: 12,
    model: "text-embedding-3-small",
  })),
  now: () => Date.parse("2026-09-26T12:00:00Z"),
});
const call = (method: string, params: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

describe("servidor MCP", () => {
  it("sem token responde 401 apontando para a descoberta do OAuth", async () => {
    const res = await handleMcp(call("initialize"), null, env, deps(vi.fn() as any));
    expect(res.status).toBe(401);
    expect(res.headers?.["WWW-Authenticate"]).toBe(
      'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource"',
    );
    expect(protectedResource(env)).toMatchObject({
      resource: "https://app.example.com/api/mcp",
      authorization_servers: ["https://db.example.com/auth/v1"],
    });
  });

  it("token vencido ou inválido também é 401 (o cliente renova)", async () => {
    const { fetchImpl } = database({
      "/auth/v1/user": new Response("{}", { status: 401 }),
    });
    const res = await handleMcp(call("tools/list"), token, env, deps(fetchImpl));
    expect(res.status).toBe(401);
  });

  it("initialize combina a versão do protocolo; avisos recebem 202", async () => {
    const { fetchImpl } = database(base);
    const res = await handleMcp(
      call("initialize", { protocolVersion: "2025-06-18" }),
      token,
      env,
      deps(fetchImpl),
    );
    expect(res.body).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mavi" },
      },
    });
    const old = await handleMcp(
      call("initialize", { protocolVersion: "1999-01-01" }),
      token,
      env,
      deps(fetchImpl),
    );
    expect((old.body as any).result.protocolVersion).toBe(MCP_VERSIONS[0]);
    const note = await handleMcp(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      token,
      env,
      deps(fetchImpl),
    );
    expect(note).toEqual({ status: 202, body: null });
    const unknown = await handleMcp(call("resources/list"), token, env, deps(fetchImpl));
    expect((unknown.body as any).error.code).toBe(-32601);
  });

  it("lista as ferramentas, todas só de leitura e com a escolha da empresa", async () => {
    const tools = mcpTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_workspaces",
      "find_clients",
      "search_knowledge",
      "read_more",
      "list_meetings",
      "campaign_results",
      "list_tasks",
      "client_temperature",
    ]);
    for (const t of tools) expect(t.annotations.readOnlyHint).toBe(true);
    const search = tools.find((t) => t.name === "search_knowledge")!;
    expect(Object.keys(search.inputSchema.properties)).toContain("workspace");
  });

  it("busca com o token da pessoa, devolve links do MAVI e registra o custo como mcp", async () => {
    const { fetchImpl, calls } = database({
      ...base,
      "rpc/mcp_workspaces": workspaces(),
      "rpc/ai_search": [
        {
          chunk_id: 77,
          source_type: "meeting",
          source_id: "m1",
          title: "Alinhamento",
          content: "[Reunião]\n[02:10] Ana: A verba é de 3 mil.",
          meta: { start: 130 },
          client_id: client,
          occurred_at: "2026-09-10T13:00:00Z",
          task_status: null,
          task_assignee: null,
          task_due: null,
        },
      ],
      "rpc/ai_log_usage": null,
    });
    const res = await handleMcp(
      call("tools/call", {
        name: "search_knowledge",
        arguments: { query: "verba" },
      }),
      token,
      env,
      deps(fetchImpl),
    );
    const out = (res.body as any).result;
    expect(out.isError).toBeUndefined();
    const text = out.content[0].text as string;
    expect(text).toContain("A verba é de 3 mil.");
    expect(text).toContain(
      "[S1] https://app.example.com/drive?gravacao=m1&t=130",
    );
    expect(text).toContain('ref igual ao número do trecho (ex.: "77")');
    const search = calls.find((c) => c.url.includes("rpc/ai_search"))!;
    expect(search.auth).toBe(token);
    expect(search.body.p_company).toBe(company);
    const log = calls.find((c) => c.url.includes("rpc/ai_log_usage"))!;
    expect(log.auth).toBe(token);
    expect(log.body).toMatchObject({
      p_company: company,
      p_module: "mcp",
      p_embedding: 12,
    });
  });

  it("read_more aceita o número do trecho (servidor sem sessão)", async () => {
    const { fetchImpl, calls } = database({
      ...base,
      "rpc/mcp_workspaces": workspaces(),
      "rpc/ai_read": [
        { ord: 1, content: "[Reunião]\n[02:00] Ana: Antes." },
        { ord: 2, content: "[Reunião]\n[02:10] Ana: A verba é de 3 mil." },
      ],
    });
    const res = await handleMcp(
      call("tools/call", { name: "read_more", arguments: { ref: "77" } }),
      token,
      env,
      deps(fetchImpl),
    );
    const text = (res.body as any).result.content[0].text as string;
    expect(text).toContain("[02:00] Ana: Antes.");
    const read = calls.find((c) => c.url.includes("rpc/ai_read"))!;
    expect(read.body.p_chunk).toBe(77);
    expect(read.auth).toBe(token);
  });

  it("MCP desligado para a pessoa: recusa sem consultar nada", async () => {
    const { fetchImpl, calls } = database({
      ...base,
      "rpc/mcp_workspaces": workspaces(false),
    });
    const res = await handleMcp(
      call("tools/call", { name: "list_tasks", arguments: {} }),
      token,
      env,
      deps(fetchImpl),
    );
    const out = (res.body as any).result;
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("desativado");
    expect(calls.some((c) => c.url.includes("/rest/v1/tasks"))).toBe(false);
  });

  it("em mais de uma empresa pede a escolha; escolhe pelo nome", async () => {
    const two = [
      ...workspaces(),
      { company_id: second, name: "Outra", role: "member", allowed: true },
    ];
    const { fetchImpl, calls } = database({
      ...base,
      "rpc/mcp_workspaces": two,
      "rpc/ai_search": [],
    });
    const ask = await handleMcp(
      call("tools/call", { name: "search_knowledge", arguments: { query: "verba" } }),
      token,
      env,
      deps(fetchImpl),
    );
    expect((ask.body as any).result.content[0].text).toContain(
      "mais de uma empresa: Agência, Outra",
    );
    await handleMcp(
      call("tools/call", {
        name: "search_knowledge",
        arguments: { query: "verba", workspace: "outra" },
      }),
      token,
      env,
      deps(fetchImpl),
    );
    const search = calls.find((c) => c.url.includes("rpc/ai_search"))!;
    expect(search.body.p_company).toBe(second);
    const list = await handleMcp(
      call("tools/call", { name: "list_workspaces" }),
      token,
      env,
      deps(fetchImpl),
    );
    expect((list.body as any).result.content[0].text).toContain(
      `- Outra (id ${second}) · MCP liberado`,
    );
  });

  it("monta o link de cada tipo de fonte", () => {
    const o = env.appOrigin;
    expect(sourceLink(o, { ref: "S1", type: "task", id: "t1", title: "" } as any)).toBe(
      `${o}/tarefas/t1`,
    );
    expect(sourceLink(o, { ref: "S2", type: "file", id: "f1", title: "" } as any)).toBe(
      `${o}/drive?arquivo=f1`,
    );
    expect(
      sourceLink(o, { ref: "S3", type: "social", id: "p1", contract_id: "k1", title: "" } as any),
    ).toBe(`${o}/onboarding/social-leads?contrato=k1`);
    expect(sourceLink(o, { ref: "S4", type: "campaign", id: "c1", title: "" } as any)).toBe(
      `${o}/campanhas?campanha=c1`,
    );
  });
});

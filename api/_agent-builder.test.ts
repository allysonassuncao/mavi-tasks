import { describe, expect, it } from "vitest";
import { clientCode, handleAgentBuilder, starterDraft, type BuilderEnv } from "./_agent-builder";

const env: BuilderEnv = {
  supabaseUrl: "https://db.test",
  supabaseKey: "anon",
  engineUrl: "https://agentes.test",
  engineKey: "mva_key",
};
const auth = "Bearer user-jwt";
const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const contract = "00000000-0000-4000-8000-000000000003";
const otherClient = "00000000-0000-4000-8000-000000000009";
const agentId = "00000000-0000-4000-8000-0000000000a1";
const item = "00000000-0000-4000-8000-0000000000b1";

type Call = { url: string; method: string; body: any; auth: string | null };

/** Banco e motor de mentira: guarda as chamadas e responde pelo caminho. */
function fake(opts: { read?: boolean; write?: boolean; all?: boolean; clients?: string[]; agentClient?: string; itemAgent?: string } = {}) {
  const calls: Call[] = [];
  const agent = {
    id: agentId,
    company_id: "crm-1",
    name: "Clara",
    status: "active",
    published_version: null,
    external_ref: { mavi_company_id: company, mavi_client_id: opts.agentClient ?? client, mavi_contract_id: contract },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body, auth: headers.Authorization ?? null });
    if (url.endsWith("/rpc/agent_builder_access"))
      return json(200, { read: opts.read ?? true, write: opts.write ?? false, leader: false, client_name: "774 - Make Vendas", user_id: "u1", user_label: "ana@x.com" });
    if (url.endsWith("/rpc/agent_builder_clients")) return json(200, { all: opts.all ?? false, leader: false, clients: opts.clients ?? [client] });
    if (url.startsWith(env.engineUrl!)) {
      const path = url.slice(env.engineUrl!.length);
      if (path.startsWith("/v1/agents?") || path === "/v1/agents") {
        if (method === "POST") return json(201, { agent: { ...agent, ...body } });
        return json(200, {
          agents: [
            agent,
            { ...agent, id: "x2", external_ref: { mavi_company_id: company, mavi_client_id: otherClient } },
            { ...agent, id: "x3", external_ref: { mavi_company_id: "outra-empresa", mavi_client_id: client } },
          ],
        });
      }
      if (path.startsWith("/v1/makecrm/companies?make_id=774")) return json(200, { company: { id: "crm-1", make_id: 774 } });
      if (path === `/v1/agents/${agentId}` && method === "GET") return json(200, { agent, bindings: [{ id: "00000000-0000-4000-8000-0000000000c1" }] });
      if (path === `/v1/knowledge/${item}`) return json(200, { item: { id: item, agent_id: opts.itemAgent ?? agentId }, chunks: [] });
      return json(200, { ok: true, path, method });
    }
    return json(404, { message: "?" });
  }) as typeof fetch;
  return { f, calls };
}

const run = (body: Record<string, unknown>, f: typeof fetch, e: BuilderEnv = env, a: string | null = auth) =>
  handleAgentBuilder({ company, ...body }, a, e, { fetch: f });

describe("construtor de agentes (servidor)", () => {
  it("código do cliente vem do começo do nome", () => {
    expect(clientCode("774 - Make Vendas")).toBe(774);
    expect(clientCode("4364")).toBe(4364);
    expect(clientCode("Make Vendas")).toBeNull();
    expect(starterDraft("Clara Atendimento").persona.name).toBe("Clara");
  });

  it("exige login", async () => {
    const { f } = fake();
    expect((await run({ action: "builder-list" }, f, env, null)).status).toBe(401);
  });

  it("lista só os agentes da empresa e dos clientes que a pessoa vê", async () => {
    const { f, calls } = fake();
    const r = await run({ action: "builder-list" }, f);
    expect(r.status).toBe(200);
    expect((r.body as any).agents.map((a: any) => a.id)).toEqual([agentId]);
    // A chave do motor nunca vai ao banco; o login da pessoa nunca vai ao motor.
    expect(calls.find((c) => c.url.includes("/rpc/"))!.auth).toBe(auth);
    expect(calls.find((c) => c.url.startsWith(env.engineUrl!))!.auth).toBe("Bearer mva_key");
  });

  it("sem motor configurado a lista vem vazia e avisa", async () => {
    const { f } = fake();
    const r = await run({ action: "builder-list" }, f, { ...env, engineUrl: null });
    expect(r.body).toMatchObject({ agents: [], configured: false });
  });

  it("criar exige editar o produto e acha a empresa do MakeCRM pelo código", async () => {
    const denied = fake({ write: false });
    expect((await run({ action: "builder-create", client, contract, name: "Clara" }, denied.f)).status).toBe(403);
    const ok = fake({ write: true });
    const r = await run({ action: "builder-create", client, contract, name: "Clara" }, ok.f);
    expect(r.status).toBe(201);
    const post = ok.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/agents"))!;
    expect(post.body).toMatchObject({
      company_id: "crm-1",
      external_ref: { mavi_company_id: company, mavi_client_id: client, mavi_contract_id: contract, client_code: 774 },
    });
  });

  it("leitura deixa ver e testar, mas não mudar", async () => {
    const { f, calls } = fake({ read: true, write: false });
    expect((await run({ action: "builder-agent", agent: agentId, op: "get" }, f)).status).toBe(200);
    expect((await run({ action: "builder-agent", agent: agentId, op: "simulate", message: "oi" }, f)).status).toBe(200);
    const sim = calls.find((c) => c.url.endsWith("/simulate"))!;
    expect(sim.body.session).toBe("u1:1");
    expect((await run({ action: "builder-agent", agent: agentId, op: "publish" }, f)).status).toBe(403);
    expect((await run({ action: "builder-agent", agent: agentId, op: "draft", draft: {} }, f)).status).toBe(403);
  });

  it("agente de outra empresa ou sem leitura não existe", async () => {
    const noRead = fake({ read: false });
    expect((await run({ action: "builder-agent", agent: agentId, op: "get" }, noRead.f)).status).toBe(404);
  });

  it("item de outro agente não é alcançado", async () => {
    const { f } = fake({ write: true, itemAgent: "00000000-0000-4000-8000-0000000000ff" });
    expect((await run({ action: "builder-agent", agent: agentId, op: "knowledge-delete", item }, f)).status).toBe(404);
  });

  it("desligar ligação só se for deste agente", async () => {
    const { f, calls } = fake({ write: true });
    expect((await run({ action: "builder-agent", agent: agentId, op: "unbind", binding: "00000000-0000-4000-8000-0000000000c2" }, f)).status).toBe(404);
    expect((await run({ action: "builder-agent", agent: agentId, op: "unbind", binding: "00000000-0000-4000-8000-0000000000c1" }, f)).status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v1/bindings/00000000-0000-4000-8000-0000000000c1"))).toBe(true);
  });

  it("operação desconhecida", async () => {
    const { f } = fake();
    expect((await run({ action: "builder-agent", agent: agentId, op: "apagar-tudo" }, f)).status).toBe(400);
  });
});

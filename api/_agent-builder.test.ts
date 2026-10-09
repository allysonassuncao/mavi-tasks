import { describe, expect, it } from "vitest";
import { clientCode, handleAgentBuilder, modelPublishOptions, normalizeRef, starterDraft, type BuilderEnv } from "./_agent-builder";

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
    if (url.includes("/rpc/agent_report_settings")) return json(200, { weekly: true, recipients: [] });
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

  it("lacunas e insights: temas pelo endereço do agente; mudar exige edição", async () => {
    const topic = "00000000-0000-4000-8000-0000000000d1";
    const ro = fake({ read: true, write: false });
    expect((await run({ action: "builder-agent", agent: agentId, op: "gaps", from: "2026-10-01", to: "2026-10-07", status: "open" }, ro.f)).status).toBe(200);
    expect(ro.calls.some((c) => c.url.endsWith(`/v1/agents/${agentId}/gaps?from=2026-10-01&to=2026-10-07&status=open`))).toBe(true);
    expect((await run({ action: "builder-agent", agent: agentId, op: "report", from: "2026-10-01", to: "2026-10-07" }, ro.f)).status).toBe(200);
    expect((await run({ action: "builder-agent", agent: agentId, op: "gap-apply", topic, question: "q", answer: "a" }, ro.f)).status).toBe(403);
    expect((await run({ action: "builder-agent", agent: agentId, op: "gap", topic: "não-é-uuid" }, ro.f)).status).toBe(400);

    const rw = fake({ write: true });
    expect((await run({ action: "builder-agent", agent: agentId, op: "gap-apply", topic, question: "Aceita boleto?", answer: "Sim." }, rw.f)).status).toBe(200);
    const apply = rw.calls.find((c) => c.url.endsWith(`/v1/agents/${agentId}/gap-topics/${topic}/apply`))!;
    expect(apply.body).toEqual({ question: "Aceita boleto?", answer: "Sim.", by: "ana@x.com" });
  });

  it("configurar insights: amostra no motor, resumo semanal no banco", async () => {
    const { f, calls } = fake({ write: true });
    const r = await run({ action: "builder-agent", agent: agentId, op: "insights-settings-set", sample_percent: 30, weekly: true, recipients: [client, "x"] }, f);
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.method === "PATCH" && c.url.endsWith(`/v1/agents/${agentId}`))!.body).toEqual({ insights_sample_percent: 30 });
    const set = calls.find((c) => c.url.endsWith("/rpc/agent_report_settings_set"))!;
    expect(set.auth).toBe(auth);
    expect(set.body).toMatchObject({ p_company: company, p_client: client, p_contract: contract, p_agent: agentId, p_weekly: true, p_recipients: [client] });
    expect((await run({ action: "builder-agent", agent: agentId, op: "insights-settings-set", sample_percent: 150 }, f)).status).toBe(400);
  });

  it("bateria de testes: tetos do Painel e quem pediu", async () => {
    const calls: { url: string; method: string; body: any }[] = [];
    const base = fake({ write: true });
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = String(u);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/rpc/agent_test_settings"))
        return new Response(JSON.stringify({ max_conversations: 5, max_turns: 6, run_cap_usd: 0.4, monthly_cap_usd: 10, publish_conversations: 3, scheduled_enabled: true, scheduled_every_days: 7, scheduled_conversations: 4 }));
      if (url.includes("/test-runs?limit=1")) return new Response(JSON.stringify({ runs: [], month_cost_usd: 9.9 }));
      return base.f(u, init);
    }) as typeof fetch;
    const r = await run({ action: "builder-agent", agent: agentId, op: "test-run-start", conversations: 50, profiles: ["preco"], focus: "boleto" }, f);
    expect(r.status).toBe(200);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith(`/v1/agents/${agentId}/test-runs`))!;
    expect(post.body).toMatchObject({ kind: "manual", use: "draft", conversations: 5, max_turns: 6, profiles: ["preco"], focus: "boleto", created_by: "ana@x.com" });
    expect(post.body.cost_cap_usd).toBeCloseTo(0.1);
    const ro = fake({ read: true, write: false });
    expect((await run({ action: "builder-agent", agent: agentId, op: "test-run-start" }, ro.f)).status).toBe(403);
  });

  it("operação desconhecida", async () => {
    const { f } = fake();
    expect((await run({ action: "builder-agent", agent: agentId, op: "apagar-tudo" }, f)).status).toBe(400);
  });
});

describe("modelos liberados ao publicar", () => {
  const models = {
    default: "p1|openai/gpt-5.2",
    fallback: null,
    models: [
      { key: "p1|openai/gpt-5.2", ref: "openrouter:openai/gpt-5.2", kind: "openrouter", label: "GPT-5.2", provider_name: "OR", input: 1.25, output: 10, cached: 0.13, allowed: true },
      { key: "p2|claude", ref: "anthropic:claude", kind: "anthropic", label: "Claude", provider_name: "A", input: 3, output: 15, cached: null, allowed: false },
    ],
  };

  it("formato antigo vira referência do OpenRouter", () => {
    expect(normalizeRef("openai/gpt-5.2")).toBe("openrouter:openai/gpt-5.2");
    expect(normalizeRef("anthropic:claude")).toBe("anthropic:claude");
    expect(normalizeRef("")).toBeNull();
  });

  it("padrão e preços dos liberados vão para o motor", () => {
    expect(modelPublishOptions({}, models)).toEqual({
      default_model: "openrouter:openai/gpt-5.2",
      pricing: { "openrouter:openai/gpt-5.2": { input: 1.25, output: 10, cached: 0.13 } },
    });
  });

  it("modelo não liberado impede publicar", () => {
    expect(() => modelPublishOptions({ model: { model: "anthropic:claude" } }, models)).toThrow(/não está liberado/);
    expect(() => modelPublishOptions({ model: { model: "openai/gpt-5.2" } }, models)).not.toThrow();
  });
});

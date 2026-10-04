import { describe, expect, it } from "vitest";
import {
  agentSetup,
  classify,
  handleAgents,
  systemMessageOf,
  withPrompt,
  workflowCalls,
  workflowPayload,
  type N8nWorkflow,
} from "./_agents";
import { seal, unseal } from "./_google";

const KEY = Buffer.alloc(32, 9);
const SECRET = "w".repeat(40);
const env = {
  supabaseUrl: "https://db.test",
  supabaseKey: "anon",
  providerKey: KEY,
  workerSecret: SECRET,
};
const company = "00000000-0000-4000-8000-000000000001";
const vps = "00000000-0000-4000-8000-000000000002";
const workflow = "00000000-0000-4000-8000-000000000003";
const prompt = "00000000-0000-4000-8000-000000000004";
const auth = "Bearer user-jwt";
const BASE = "https://n8n.example.com";
const lookup = async () => [{ address: "93.184.216.34" }];

const agentNode = (id: string, name: string, systemMessage?: string) => ({
  id,
  name,
  type: "@n8n/n8n-nodes-langchain.agent",
  typeVersion: 2.2,
  position: [0, 0],
  parameters: {
    promptType: "define",
    text: "={{ $json.message }}",
    options: systemMessage === undefined ? {} : { systemMessage, maxIterations: 10 },
  },
});
const call = (target: string) => ({
  id: `call-${target}`,
  name: `Chama ${target}`,
  type: "n8n-nodes-base.executeWorkflow",
  parameters: { source: "database", workflowId: { __rl: true, value: target, mode: "list" } },
});
const wf = (id: string, nodes: any[], extra: Partial<N8nWorkflow> = {}): N8nWorkflow => ({
  id,
  name: `Fluxo ${id}`,
  active: false,
  nodes,
  connections: {},
  versionId: `v-${id}`,
  updatedAt: "2026-10-01T12:00:00.000Z",
  ...extra,
});

/** O banco (PostgREST) e o n8n de mentira, com o registro das chamadas. */
function world(opts: {
  db: (name: string, args: any) => [number, unknown];
  n8n: (method: string, path: string, body: any) => [number, unknown];
}) {
  const db: { name: string; args: any; auth: string }[] = [];
  const n8n: { method: string; path: string; body: any; key: string }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    if (url.startsWith("https://db.test/rest/v1/rpc/")) {
      const name = url.split("/rpc/")[1];
      const args = JSON.parse(String(init.body));
      db.push({ name, args, auth: (init.headers as Record<string, string>).Authorization });
      const [status, body] = opts.db(name, args);
      return new Response(JSON.stringify(body), { status });
    }
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    n8n.push({
      method: init.method ?? "GET",
      path: u.pathname + u.search,
      body,
      key: (init.headers as Record<string, string>)["X-N8N-API-KEY"],
    });
    const [status, answer] = opts.n8n(init.method ?? "GET", u.pathname + u.search, body);
    return new Response(JSON.stringify(answer), { status });
  }) as typeof fetch;
  return { deps: { fetch: impl, lookup }, db, n8n };
}

describe("leitura dos fluxos do n8n", () => {
  it("lê o prompt de sistema e a expressão", () => {
    expect(systemMessageOf(agentNode("a", "A", "Você é a Ana.") as any)).toEqual({
      text: "Você é a Ana.",
      expression: false,
    });
    expect(systemMessageOf(agentNode("a", "A", "=Hoje é {{ $now }}") as any)).toEqual({
      text: "Hoje é {{ $now }}",
      expression: true,
    });
    expect(systemMessageOf(agentNode("a", "A") as any)).toEqual({ text: "", expression: false });
  });

  it("monta a ficha técnica pelas conexões de IA", () => {
    const flow = wf("1", [
      agentNode("a", "AI Agent", "x"),
      { id: "m", name: "OpenAI Chat Model", type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
        parameters: { model: { __rl: true, value: "gpt-4.1-mini", mode: "list" } } },
      { id: "t", name: "Agenda", type: "n8n-nodes-base.googleCalendarTool", parameters: {} },
      { id: "r", name: "Memória", type: "@n8n/n8n-nodes-langchain.memoryPostgresChat", parameters: {} },
    ], {
      connections: {
        "OpenAI Chat Model": { ai_languageModel: [[{ node: "AI Agent", type: "ai_languageModel", index: 0 }]] },
        Agenda: { ai_tool: [[{ node: "AI Agent", type: "ai_tool", index: 0 }]] },
        Memória: { ai_memory: [[{ node: "AI Agent", type: "ai_memory", index: 0 }]] },
      },
    });
    expect(agentSetup(flow, flow.nodes[0])).toEqual({
      model: "gpt-4.1-mini",
      model_node: "OpenAI Chat Model",
      provider: "OpenAi",
      tools: ["Agenda"],
      memory: "Memória",
      disabled: undefined,
    });
  });

  it("separa principal, subfluxo (até o de um subfluxo) e cópia", () => {
    const all = [
      wf("main", [call("router")], { active: true, name: "Atendimento" }),
      wf("router", [call("agente")], { name: "Roteador" }),
      wf("agente", [agentNode("a", "A", "x")]),
      wf("backup", [agentNode("b", "B", "y"), call("agente")]),
      wf("velho", [agentNode("c", "C", "z")], { active: true, isArchived: true }),
    ];
    expect(workflowCalls(all[0])).toEqual(["router"]);
    const roles = classify(all);
    expect(roles.get("main")!.role).toBe("main");
    expect(roles.get("router")!.role).toBe("subflow");
    expect(roles.get("agente")).toEqual({ role: "subflow", called_by: [{ id: "router", name: "Roteador" }] });
    // Um backup que chama o subfluxo não é quem chama de verdade.
    expect(roles.get("backup")!.role).toBe("copy");
    expect(roles.get("velho")!.role).toBe("copy");
  });

  it("o fluxo guardado leva os nós só quando pedido", () => {
    const flow = wf("9", [agentNode("a", "Agente", "Olá"), call("x")], { active: true });
    const full = workflowPayload(flow, { role: "main", called_by: [] });
    expect(full.nodes).toEqual([
      expect.objectContaining({ node_id: "a", node_name: "Agente", prompt: "Olá", expression: false }),
    ]);
    expect("nodes" in workflowPayload(flow, null, false)).toBe(false);
  });

  it("troca só o prompt do nó e deixa de fora o que a API recusa", () => {
    const flow = wf("9", [
      { ...agentNode("a", "Agente", "=Antigo {{ $now }}"), color: 3, extendsCredential: "x" },
      call("x"),
    ]);
    const body = withPrompt(flow, "a", "Novo {{ $now }}", true);
    expect(body.settings).toEqual({});
    expect(body.nodes[0].parameters).toEqual({
      promptType: "define",
      text: "={{ $json.message }}",
      options: { systemMessage: "=Novo {{ $now }}", maxIterations: 10 },
    });
    expect(body.nodes[0]).not.toHaveProperty("color");
    expect(body.nodes[1]).toEqual(call("x"));
    expect(() => withPrompt(flow, "sumiu", "x", false)).toThrow(/não existe mais/);
  });
});

describe("handleAgents", () => {
  it("o agendamento lê a VPS inteira e manda só os fluxos que mudaram", async () => {
    const flows = [
      wf("1", [agentNode("a", "A", "Novo texto")], { active: true }),
      wf("2", [agentNode("b", "B", "Igual")], { versionId: "v-2" }),
      wf("3", [{ id: "x", name: "Webhook", type: "n8n-nodes-base.webhook" }]),
    ];
    const w = world({
      db: (name) =>
        name === "agent_sync_targets"
          ? [200, [{ id: vps, name: "VPS 1", base_url: BASE, key_cipher: seal(KEY, "n8n-key"), known: { "2": "v-2" } }]]
          : [200, { changed: 1, removed: 0, linked: 0 }],
      n8n: (_m, path) =>
        path.includes("cursor=")
          ? [200, { data: [flows[2]], nextCursor: null }]
          : [200, { data: flows.slice(0, 2), nextCursor: "next" }],
    });
    const r = await handleAgents({ action: "agent-sync" }, `Bearer ${SECRET}`, env, w.deps);
    expect(r.status).toBe(200);
    expect(w.n8n.map((c) => c.path)).toEqual([
      "/api/v1/workflows?limit=100&excludePinnedData=true",
      "/api/v1/workflows?limit=100&excludePinnedData=true&cursor=next",
    ]);
    expect(w.n8n[0].key).toBe("n8n-key");
    const store = w.db.find((c) => c.name === "agent_sync_store")!;
    expect(store.auth).toBe("Bearer anon");
    expect(store.args.p_secret).toBe(SECRET);
    expect(store.args.p_complete).toBe(true);
    expect(store.args.p_workflows.map((x: any) => [x.n8n_id, x.role, "nodes" in x])).toEqual([
      ["1", "main", true],
      ["2", "copy", false],
    ]);
    expect(store.args.p_stats).toMatchObject({ workflows: 3, agents: 2, read: 1 });
  });

  it("a falha do n8n fica registrada na VPS", async () => {
    const w = world({
      db: (name) =>
        name === "agent_sync_targets"
          ? [200, [{ id: vps, name: "VPS 1", base_url: BASE, key_cipher: seal(KEY, "k"), known: {} }]]
          : [200, { error: true }],
      n8n: () => [401, { message: "unauthorized" }],
    });
    const r = await handleAgents({ action: "agent-sync" }, `Bearer ${SECRET}`, env, w.deps);
    expect((r.body.results as any[])[0]).toMatchObject({ ok: false });
    const store = w.db.find((c) => c.name === "agent_sync_store")!;
    expect(store.args.p_error).toMatch(/recusou a chave da API \(401\)/);
  });

  it("sem o segredo, só com login (e da empresa)", async () => {
    const w = world({ db: () => [200, []], n8n: () => [200, {}] });
    expect((await handleAgents({ action: "agent-sync" }, null, env, w.deps)).status).toBe(401);
    expect((await handleAgents({ action: "agent-sync" }, "Bearer errado", env, w.deps)).status).toBe(400);
    const r = await handleAgents({ action: "agent-sync", company, instance: vps }, auth, env, w.deps);
    expect(r.status).toBe(200);
    expect(w.db[0]).toMatchObject({ name: "agent_sync_targets", auth,
      args: { p_secret: null, p_company: company, p_instance: vps } });
  });

  const target = {
    prompt,
    workflow,
    n8n_id: "9",
    node_id: "a",
    stored: "Texto antigo",
    expression: false,
    version: 3,
    base_url: BASE,
    key_cipher: seal(KEY, "n8n-key"),
  };

  it("publica só o texto do nó e grava a versão", async () => {
    const current = wf("9", [agentNode("a", "Agente", "Texto antigo"), call("x")], { active: true });
    const w = world({
      db: (name) =>
        name === "agent_prompt_edit_target" ? [200, target] : [200, { version: 4 }],
      n8n: (method, _p, body) =>
        method === "PUT"
          ? [200, { ...current, ...body, active: true, versionId: "v-novo", updatedAt: "2026-10-04T10:00:00Z" }]
          : [200, current],
    });
    const r = await handleAgents(
      { action: "agent-publish", prompt, base: 3, text: "Texto novo\r\ncom linha", note: "horário" },
      auth,
      env,
      w.deps,
    );
    expect(r).toEqual({ status: 200, body: { version: 4, active: true } });
    const put = w.n8n.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/api/v1/workflows/9");
    expect(put.body.nodes[0].parameters.options.systemMessage).toBe("Texto novo\ncom linha");
    expect(put.body.settings).toEqual({});
    const saved = w.db.find((c) => c.name === "agent_prompt_saved")!;
    expect(saved.args).toMatchObject({ p_prompt: prompt, p_base: 3, p_text: "Texto novo\ncom linha",
      p_note: "horário", p_action: "edit", p_version_id: "v-novo" });
    expect(saved.auth).toBe(auth);
    // Restaurar: a versão de onde veio.
    w.db.length = 0;
    await handleAgents(
      { action: "agent-publish", prompt, base: 3, text: "Texto novo", mode: "restore", from: 1 },
      auth,
      env,
      w.deps,
    );
    expect(w.db.find((c) => c.name === "agent_prompt_saved")!.args).toMatchObject({
      p_action: "restore",
      p_from: 1,
    });
  });

  it("mudou direto no n8n: não publica, guarda a versão de lá", async () => {
    const current = wf("9", [agentNode("a", "Agente", "Alguém mudou no n8n")]);
    const w = world({
      db: (name) => (name === "agent_prompt_edit_target" ? [200, target] : [200, { changed: true }]),
      n8n: () => [200, current],
    });
    const r = await handleAgents({ action: "agent-publish", prompt, base: 3, text: "Meu texto" }, auth, env, w.deps);
    expect(r.status).toBe(409);
    expect(r.body.conflict).toBe(true);
    expect(w.n8n.some((c) => c.method === "PUT")).toBe(false);
    expect(w.db.map((c) => c.name)).toEqual(["agent_prompt_edit_target", "agent_workflow_store"]);
  });

  it("a versão base antiga volta como conflito", async () => {
    const w = world({
      db: () => [400, { code: "40001", message: "Bruno Colab mudou este prompt enquanto você editava.", hint: "version:5" }],
      n8n: () => [200, {}],
    });
    const r = await handleAgents({ action: "agent-publish", prompt, base: 3, text: "x" }, auth, env, w.deps);
    expect(r).toEqual({ status: 409, body: { error: "Bruno Colab mudou este prompt enquanto você editava.",
      conflict: true, hint: "version:5" } });
  });

  it("a VPS só é guardada depois de a chave funcionar, e cifrada", async () => {
    const w = world({
      db: (_n, args) => [200, { id: vps, name: args.p_name }],
      n8n: () => [200, { data: [], nextCursor: null }],
    });
    const r = await handleAgents(
      { action: "agent-instance-save", company, name: "VPS 1", base_url: `${BASE}/api/v1/`, api_key: "chave-123" },
      auth,
      env,
      w.deps,
    );
    expect(r.status).toBe(200);
    expect(w.n8n[0]).toMatchObject({ path: "/api/v1/workflows?limit=1&excludePinnedData=true", key: "chave-123" });
    const save = w.db[0];
    expect(save.args.p_base_url).toBe(BASE);
    expect(save.args.p_key_hint).toBe("…-123");
    expect(JSON.stringify(save.args)).not.toContain("chave-123");
    expect(unseal(KEY, save.args.p_key_cipher)).toBe("chave-123");
    // Endereço de rede interna: recusado antes de qualquer pedido.
    const bad = await handleAgents(
      { action: "agent-instance-save", company, name: "X", base_url: "https://n8n.local", api_key: "k" },
      auth,
      env,
      w.deps,
    );
    expect(bad.status).toBe(400);
    // Chave recusada pelo n8n: nada é guardado.
    const w2 = world({ db: () => [200, {}], n8n: () => [401, {}] });
    const refused = await handleAgents(
      { action: "agent-instance-save", company, name: "X", base_url: BASE, api_key: "k" },
      auth,
      env,
      w2.deps,
    );
    expect(refused.status).toBe(502);
    expect(w2.db).toEqual([]);
  });

  it("sem AI_PROVIDER_KEY avisa o que falta", async () => {
    const w = world({ db: () => [200, []], n8n: () => [200, {}] });
    const r = await handleAgents({ action: "agent-sync" }, `Bearer ${SECRET}`, { ...env, providerKey: null }, w.deps);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/AI_PROVIDER_KEY/);
  });
});

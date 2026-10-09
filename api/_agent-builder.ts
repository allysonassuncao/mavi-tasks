/**
 * Agente Conversacional › Agentes MAVI: o MAVI Tasks constrói, o motor
 * (projeto mavi-agentes, em AGENTS_ENGINE_URL) guarda e roda. A chave do motor
 * (AGENTS_ENGINE_KEY) fica só aqui no servidor; o navegador fala com /api/ai.
 *
 * Toda ação confere no banco, com o login da pessoa, a regra do Drive
 * (agent_builder_access): ler o cliente para ver e testar; editar o produto
 * do agente para mudar, publicar e ligar caixas.
 */

type Fetch = typeof fetch;
type Result = { status: number; body: unknown };

export type BuilderEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  engineUrl: string | null;
  engineKey: string | null;
};

export function builderEnv(
  drive: { supabaseUrl: string; supabaseKey: string },
  env: Record<string, string | undefined> = process.env,
): BuilderEnv {
  return {
    supabaseUrl: drive.supabaseUrl,
    supabaseKey: drive.supabaseKey,
    engineUrl: env.AGENTS_ENGINE_URL?.trim().replace(/\/+$/, "") || null,
    engineKey: env.AGENTS_ENGINE_KEY?.trim() || null,
  };
}

export class BuilderError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, what: string) => {
  const s = String(v ?? "");
  if (!UUID.test(s)) throw new BuilderError(400, `Informe ${what}.`);
  return s;
};

export type EngineAgent = {
  id: string;
  company_id: string;
  name: string;
  status: string;
  external_ref: { mavi_company_id?: string; mavi_client_id?: string; mavi_contract_id?: string; client_code?: string };
  published_version: number | null;
  [k: string]: unknown;
};

export type Access = { read: boolean; write: boolean; leader: boolean; client_name: string; user_id: string; user_label: string };

// ------------------------------------------------------------ banco (como a pessoa)
export async function rpc<T>(env: BuilderEnv, f: Fetch, authorization: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await f(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: env.supabaseKey, Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const status = res.status === 401 || res.status === 403 || body?.code === "42501" ? 403 : body?.code === "P0002" ? 404 : res.status;
    throw new BuilderError(status, body?.message ?? "Não foi possível acessar o banco.");
  }
  return body as T;
}

// ------------------------------------------------------------ motor
export async function engine<T>(env: BuilderEnv, f: Fetch, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.engineUrl || !env.engineKey)
    throw new BuilderError(503, "O motor de agentes ainda não está configurado (AGENTS_ENGINE_URL e AGENTS_ENGINE_KEY na Vercel).");
  let res: Response;
  try {
    res = await f(`${env.engineUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.engineKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new BuilderError(502, "O motor de agentes não respondeu. Tente de novo em instantes.");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new BuilderError(
      res.status >= 500 ? 502 : res.status,
      data?.error ?? `O motor respondeu ${res.status}.`,
      data?.details ? { details: data.details } : {},
    );
  }
  return data as T;
}

/** O código do cliente (o começo do nome, ex.: "774 - Make Vendas" → 774) = companys.make_id no MakeCRM. */
export function clientCode(name: string): number | null {
  const m = name.trim().match(/^(\d{1,9})(?!\d)/);
  return m ? Number(m[1]) : null;
}

/** Rascunho inicial: o mínimo para a pessoa completar. */
export function starterDraft(name: string) {
  return {
    schema: "mavi-agent/v1",
    persona: { name: name.split(/\s+/)[0] || "MAVI", company: "" },
    instructions: { goal: "" },
  };
}

/**
 * Operações num agente: [método, caminho, precisa editar?]. O caminho recebe o
 * id do agente e o corpo da ação; o que é de outro recurso (item, ligação,
 * rastro, conversa) é conferido antes de chamar.
 */
type Op = {
  write: boolean;
  run: (ctx: { a: EngineAgent; body: Record<string, unknown>; access: Access; call: Call }) => Promise<unknown>;
};

const q = (v: unknown) => encodeURIComponent(String(v ?? ""));
const qs = (params: Record<string, unknown>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${q(v)}`)
    .join("&");
  return s ? `?${s}` : "";
};

type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

async function ownItem(call: Call, agentId: string, item: unknown) {
  const id = uuid(item, "o item");
  const r = await call<{ item: { agent_id: string } }>("GET", `/v1/knowledge/${id}`);
  if (r.item.agent_id !== agentId) throw new BuilderError(404, "Item não encontrado.");
  return { id, data: r };
}

const OPS: Record<string, Op> = {
  get: {
    write: false,
    run: async ({ a, access, call }) => ({ ...(await call<Record<string, unknown>>("GET", `/v1/agents/${a.id}`)), can_edit: access.write }),
  },
  versions: { write: false, run: ({ a, call }) => call("GET", `/v1/agents/${a.id}/versions`) },
  draft: {
    write: true,
    run: ({ a, body, access, call }) => call("PUT", `/v1/agents/${a.id}/draft`, { draft: body.draft, updated_by: access.user_label }),
  },
  update: {
    write: true,
    run: ({ a, body, call }) =>
      call("PATCH", `/v1/agents/${a.id}`, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(body.status === "active" || body.status === "paused" ? { status: body.status } : {}),
      }),
  },
  publish: {
    write: true,
    run: ({ a, body, access, call }) =>
      call("POST", `/v1/agents/${a.id}/publish`, {
        note: String(body.note ?? "").slice(0, 500),
        published_by: access.user_label,
        ...(Number.isInteger(body.restore_version) ? { restore_version: body.restore_version } : {}),
      }),
  },
  delete: { write: true, run: ({ a, call }) => call("DELETE", `/v1/agents/${a.id}`) },

  inboxes: { write: true, run: ({ a, call }) => call("GET", `/v1/makecrm/companies/${q(a.company_id)}/inboxes`) },
  bind: {
    write: true,
    run: ({ a, body, access, call }) => call("POST", `/v1/agents/${a.id}/bindings`, { inbox_id: String(body.inbox_id ?? ""), created_by: access.user_label }),
  },
  unbind: {
    write: true,
    run: async ({ a, body, call }) => {
      const id = uuid(body.binding, "a ligação");
      const g = await call<{ bindings: { id: string }[] }>("GET", `/v1/agents/${a.id}`);
      if (!g.bindings.some((b) => b.id === id)) throw new BuilderError(404, "Ligação não encontrada.");
      return call("DELETE", `/v1/bindings/${id}`);
    },
  },
  "binding-toggle": {
    write: true,
    run: async ({ a, body, call }) => {
      const id = uuid(body.binding, "a ligação");
      const g = await call<{ bindings: { id: string }[] }>("GET", `/v1/agents/${a.id}`);
      if (!g.bindings.some((b) => b.id === id)) throw new BuilderError(404, "Ligação não encontrada.");
      return call("PATCH", `/v1/bindings/${id}`, { enabled: !!body.enabled });
    },
  },

  "knowledge-list": {
    write: false,
    run: ({ a, body, call }) => call("GET", `/v1/agents/${a.id}/knowledge${qs({ kind: body.kind, limit: body.limit, offset: body.offset })}`),
  },
  "knowledge-get": { write: false, run: async ({ a, body, call }) => (await ownItem(call, a.id, body.item)).data },
  "knowledge-search": {
    write: false,
    run: ({ a, body, call }) =>
      call("POST", `/v1/agents/${a.id}/knowledge/search`, {
        query: String(body.query ?? ""),
        k: Number(body.k) || 8,
        ...(body.kind ? { kind: body.kind } : {}),
        rerank: !!body.rerank,
      }),
  },
  "knowledge-add": {
    write: true,
    run: ({ a, body, access, call }) => call("POST", `/v1/agents/${a.id}/knowledge`, { ...(body.item as object), created_by: access.user_label }),
  },
  "knowledge-bulk": {
    write: true,
    run: ({ a, body, access, call }) =>
      call("POST", `/v1/agents/${a.id}/knowledge/bulk`, {
        items: Array.isArray(body.items) ? body.items.slice(0, 500).map((i) => ({ ...(i as object), created_by: access.user_label })) : [],
      }),
  },
  "knowledge-update": {
    write: true,
    run: async ({ a, body, call }) => {
      const { id } = await ownItem(call, a.id, body.item);
      return call("PUT", `/v1/knowledge/${id}`, body.patch ?? {});
    },
  },
  "knowledge-delete": {
    write: true,
    run: async ({ a, body, call }) => {
      const { id } = await ownItem(call, a.id, body.item);
      return call("DELETE", `/v1/knowledge/${id}`);
    },
  },
  "knowledge-reprocess": {
    write: true,
    run: async ({ a, body, call }) => {
      const { id } = await ownItem(call, a.id, body.item);
      return call("POST", `/v1/knowledge/${id}/reprocess`);
    },
  },
  "upload-url": {
    write: true,
    run: ({ a, body, call }) =>
      call("POST", `/v1/agents/${a.id}/knowledge/upload-url`, { kind: body.kind, filename: body.filename, mime: body.mime, size: body.size }),
  },
  uploaded: {
    write: true,
    run: ({ a, body, access, call }) =>
      call("POST", `/v1/agents/${a.id}/knowledge/uploaded`, {
        item_id: body.item_id,
        storage_path: body.storage_path,
        kind: body.kind,
        filename: body.filename,
        mime: body.mime,
        title: body.title ?? "",
        description: body.description ?? "",
        created_by: access.user_label,
      }),
  },

  simulate: {
    write: false,
    run: ({ a, body, access, call }) =>
      call("POST", `/v1/agents/${a.id}/simulate`, {
        // Cada pessoa tem a sua conversa de teste por agente.
        session: `${access.user_id}:${String(body.session ?? "1").slice(0, 20)}`,
        message: String(body.message ?? ""),
        ...(body.media_url ? { media_url: body.media_url, content_type: body.content_type ?? "image" } : {}),
        use: body.use === "published" || Number.isInteger(body.use) ? body.use : "draft",
        reset: !!body.reset,
      }),
  },
  "sim-messages": {
    write: false,
    run: ({ a, body, access, call }) =>
      call("GET", `/v1/agents/${a.id}/simulations/${q(`${access.user_id}:${String(body.session ?? "1").slice(0, 20)}`)}/messages`),
  },
  turns: {
    write: false,
    run: ({ a, body, call }) =>
      call("GET", `/v1/agents/${a.id}/turns${qs({ limit: body.limit, before: body.before, simulation: body.simulation, status: body.status })}`),
  },
  turn: {
    write: false,
    run: async ({ a, body, call }) => {
      const r = await call<{ turn: { agent_id: string } }>("GET", `/v1/turns/${uuid(body.turn, "o rastro")}`);
      if (r.turn.agent_id !== a.id) throw new BuilderError(404, "Rastro não encontrado.");
      return r;
    },
  },
  usage: { write: false, run: ({ a, body, call }) => call("GET", `/v1/agents/${a.id}/usage${qs({ from: body.from, to: body.to })}`) },
  conversations: { write: false, run: ({ a, body, call }) => call("GET", `/v1/agents/${a.id}/conversations${qs({ limit: body.limit })}`) },
  "conversation-messages": {
    write: false,
    run: ({ a, body, call }) => call("GET", `/v1/agents/${a.id}/conversations/${uuid(body.conversation, "a conversa")}/messages`),
  },
};

export const BUILDER_OPS = Object.keys(OPS);

/**
 * O agente do motor e o que a pessoa pode nele (regra do Drive). Agente de
 * outra empresa ou de cliente que a pessoa não vê: "não encontrado".
 */
export async function loadAgentAccess(
  env: BuilderEnv,
  f: Fetch,
  authorization: string,
  company: string,
  agentId: string,
): Promise<{ a: EngineAgent; access: Access }> {
  const got = await engine<{ agent: EngineAgent }>(env, f, "GET", `/v1/agents/${uuid(agentId, "o agente")}`);
  const a = got.agent;
  const ref = a.external_ref ?? {};
  if (ref.mavi_company_id !== company || !ref.mavi_client_id) throw new BuilderError(404, "Agente não encontrado.");
  const access = await rpc<Access>(env, f, authorization, "agent_builder_access", {
    p_company: company,
    p_client: ref.mavi_client_id,
    p_contract: ref.mavi_contract_id ?? null,
  });
  if (!access.read) throw new BuilderError(404, "Agente não encontrado.");
  return { a, access };
}

// ------------------------------------------------------------ ações
export async function handleAgentBuilder(
  body: Record<string, unknown>,
  authorization: string | null,
  env: BuilderEnv,
  deps: { fetch: Fetch },
): Promise<Result> {
  const f = deps.fetch;
  const action = String(body.action ?? "");
  try {
    if (!authorization?.startsWith("Bearer ")) return { status: 401, body: { error: "Autenticação necessária." } };
    const company = uuid(body.company, "a empresa");
    const call: Call = (m, p, b) => engine(env, f, m, p, b);

    if (action === "builder-list") {
      const scope = await rpc<{ all: boolean; leader: boolean; clients: string[] }>(env, f, authorization, "agent_builder_clients", { p_company: company });
      if (!env.engineUrl || !env.engineKey) return { status: 200, body: { agents: [], leader: scope.leader, configured: false } };
      const client = body.client ? uuid(body.client, "o cliente") : null;
      const r = await call<{ agents: EngineAgent[] }>("GET", `/v1/agents${client ? `?mavi_client_id=${client}` : ""}`);
      const allowed = new Set(scope.clients);
      const agents = r.agents.filter(
        (a) => a.external_ref?.mavi_company_id === company && (scope.all || allowed.has(a.external_ref?.mavi_client_id ?? "")),
      );
      return { status: 200, body: { agents, leader: scope.leader, configured: true } };
    }

    if (action === "builder-create") {
      const client = uuid(body.client, "o cliente");
      const contract = uuid(body.contract, "o produto");
      const access = await rpc<Access>(env, f, authorization, "agent_builder_access", { p_company: company, p_client: client, p_contract: contract });
      if (!access.write) throw new BuilderError(403, "Você não edita este produto do cliente no Drive.");
      const name = String(body.name ?? "").trim().slice(0, 120);
      if (!name) throw new BuilderError(400, "Dê um nome ao agente.");
      const code = clientCode(access.client_name);
      if (!code) throw new BuilderError(400, `Não achei o código do cliente no nome "${access.client_name}" (ex.: "774 - Make Vendas").`);
      const crm = await call<{ company: { id: string } }>("GET", `/v1/makecrm/companies?make_id=${code}`).catch((e) => {
        if (e instanceof BuilderError && e.status === 404) throw new BuilderError(400, `O cliente ${code} não tem empresa no MakeCRM.`);
        throw e;
      });
      const created = await call<{ agent: EngineAgent }>("POST", "/v1/agents", {
        company_id: crm.company.id,
        name,
        origin: "mavi_tasks",
        external_ref: { mavi_company_id: company, mavi_client_id: client, mavi_contract_id: contract, client_code: code },
        draft: starterDraft(name),
        created_by: access.user_label,
      });
      return { status: 201, body: created };
    }

    if (action === "builder-agent") {
      const op = OPS[String(body.op ?? "")];
      if (!op) throw new BuilderError(400, "Operação desconhecida.");
      const { a, access } = await loadAgentAccess(env, f, authorization, company, String(body.agent ?? ""));
      if (op.write && !access.write) throw new BuilderError(403, "Só quem edita este produto do cliente no Drive pode mudar o agente.");
      const data = await op.run({ a, body, access, call });
      return { status: 200, body: data };
    }

    return { status: 400, body: { error: "Ação desconhecida." } };
  } catch (e) {
    if (e instanceof BuilderError) return { status: e.status, body: { error: e.message, ...e.extra } };
    throw e;
  }
}

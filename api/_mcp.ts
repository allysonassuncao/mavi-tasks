import { callRpc } from "./_drive.js";
import { embeddingCost } from "./_ai-embeddings.js";
import { buildContext, type AiDeps, type AiEnv } from "./_ai.js";
import {
  TOOLS,
  runTool,
  type AiSource,
  type ToolContext,
} from "./_ai-tools.js";

/**
 * IA do MAVI · servidor MCP (Model Context Protocol) em /api/mcp.
 *
 * Claude, ChatGPT e outros clientes de IA usam a base de conhecimento do
 * MAVI com o login de cada pessoa: o token é do OAuth 2.1 do Supabase Auth
 * (a pessoa entra e aprova na tela /oauth/consent do MAVI) e é repassado ao
 * banco, então valem as permissões de sempre. Só consulta: nada é criado ou
 * alterado por aqui.
 *
 * Transporte "Streamable HTTP" sem sessão: cada POST traz uma mensagem
 * JSON-RPC e recebe a resposta em JSON (sem stream). Sem token, 401 com o
 * endereço do documento de descoberta (/.well-known/oauth-protected-resource),
 * que aponta para o servidor de autorização do Supabase.
 */

export const MCP_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export type McpEnv = AiEnv & { appOrigin: string };
type Json = Record<string, unknown>;
export type McpResponse = {
  status: number;
  body: Json | null;
  headers?: Record<string, string>;
};

const INSTRUCTIONS = `A MAVI é o sistema de gestão da agência: clientes, produtos contratados, projetos, tarefas, reuniões gravadas (com transcrição), arquivos do Drive, Social Leads, campanhas de tráfego pago e cases de sucesso. Estas ferramentas consultam o que a pessoa conectada pode ver no MAVI.
- Para fatos (o que foi dito, combinado, pedido), use search_knowledge com termos que provavelmente aparecem no texto; faça várias buscas quando a pergunta for ampla.
- Para listas e situação atual, use list_meetings, list_tasks e campaign_results; para achar o id de um cliente pelo código, find_clients.
- Os resultados vêm numerados ([S1], [S2]…) e cada referência tem um link para abrir na MAVI: cite as fontes com esses links.
- Se a pessoa estiver em mais de uma empresa, use list_workspaces e passe "workspace".`;

const workspaceField = {
  workspace: {
    type: "string",
    description:
      "Empresa na MAVI (nome ou id), só se a pessoa estiver em mais de uma (veja list_workspaces).",
  },
};

/** As ferramentas da IA do MAVI, no formato do MCP (todas só de leitura). */
export function mcpTools() {
  const title: Record<string, string> = {
    find_clients: "Achar cliente",
    search_knowledge: "Buscar na MAVI",
    read_more: "Ler mais de um trecho",
    list_meetings: "Listar reuniões gravadas",
    campaign_results: "Resultados das campanhas",
    list_tasks: "Listar tarefas",
    find_tasks: "Localizar tarefas",
    client_temperature: "Termômetro do cliente",
    client_radar: "Radar do cliente",
    media_account: "Conta de mídia (Financeiro › Mídia)",
  };
  return [
    {
      name: "list_workspaces",
      title: "Empresas na MAVI",
      description:
        "Lista as empresas em que a pessoa conectada está na MAVI e se pode usar o MCP em cada uma.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ...TOOLS.map((t) => {
      const params = t.parameters as {
        properties: Json;
        required?: string[];
      };
      return {
        name: t.name,
        title: title[t.name] ?? t.name,
        description: t.description,
        inputSchema: {
          ...params,
          properties: { ...params.properties, ...workspaceField },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      };
    }),
  ];
}

/** O endereço (no MAVI) que abre uma fonte citada. */
export function sourceLink(origin: string, s: AiSource) {
  const q = new URLSearchParams();
  let path = "/drive";
  if (s.type === "task") return `${origin}/tarefas/${s.id}`;
  if (s.type === "meeting") {
    q.set("gravacao", s.id);
    if (s.start && s.start > 0) q.set("t", String(Math.floor(s.start)));
  } else if (s.type === "file") q.set("arquivo", s.id);
  else if (s.type === "social") {
    path = "/onboarding/social-leads";
    if (s.contract_id) q.set("contrato", s.contract_id);
  } else if (s.type === "whatsapp") {
    if (s.group) q.set("whatsapp", s.group);
    q.set("msg", s.id);
  } else if (s.type === "case") {
    path = "/cases-de-sucesso";
    q.set("caso", s.id);
  } else if (s.type === "media") {
    path = "/financeiro/midia";
    q.set("contrato", s.id);
  } else if (s.type === "note") q.set("nota", s.id);
  else {
    path = "/campanhas";
    q.set("campanha", s.id);
  }
  return `${origin}${path}?${q.toString()}`;
}

type Workspace = {
  company_id: string;
  name: string;
  role: string;
  allowed: boolean;
};

/** A pessoa por trás do token (o Supabase confere assinatura e validade). */
async function tokenUser(env: McpEnv, deps: AiDeps, authorization: string) {
  const res = await deps.fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.supabaseKey, Authorization: authorization },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string };
  return typeof user.id === "string" ? user.id : null;
}

function pickWorkspace(list: Workspace[], wanted: unknown) {
  const w = typeof wanted === "string" ? wanted.trim().toLowerCase() : "";
  if (w) {
    const found = list.find(
      (x) => x.company_id === w || x.name.toLowerCase() === w,
    );
    if (!found)
      return { error: `Empresa "${wanted}" não encontrada entre as suas.` };
    if (!found.allowed)
      return {
        error: `O MCP está desativado para você em ${found.name}. Fale com um administrador.`,
      };
    return { workspace: found };
  }
  const allowed = list.filter((x) => x.allowed);
  if (allowed.length === 1) return { workspace: allowed[0] };
  if (!allowed.length)
    return {
      error: list.length
        ? "O MCP está desativado para você na MAVI. Peça a um administrador para liberar."
        : "Sua conta não está ativa em nenhuma empresa da MAVI.",
    };
  return {
    error: `Você está em mais de uma empresa: ${allowed.map((x) => x.name).join(", ")}. Passe "workspace" com uma delas.`,
  };
}

const text = (t: string, isError = false) => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

async function callTool(
  env: McpEnv,
  deps: AiDeps,
  authorization: string,
  name: string,
  args: Json,
) {
  const workspaces = await callRpc<Workspace[]>(
    env,
    deps.fetch,
    authorization,
    "mcp_workspaces",
    {},
  );
  if (!workspaces.ok) return text(workspaces.error, true);
  if (name === "list_workspaces")
    return text(
      workspaces.data.length
        ? workspaces.data
            .map(
              (w) =>
                `- ${w.name} (id ${w.company_id}) · ${w.allowed ? "MCP liberado" : "MCP desativado"}`,
            )
            .join("\n")
        : "Nenhuma empresa ativa.",
    );
  if (!TOOLS.some((t) => t.name === name))
    return text(`Ferramenta desconhecida: ${name}.`, true);
  const picked = pickWorkspace(workspaces.data, args.workspace);
  if (!picked.workspace) return text(picked.error!, true);
  const company = picked.workspace.company_id;
  const now = (deps.now ?? Date.now)();
  const base = await buildContext(env, deps, authorization, company, {}, now);
  const ctx: ToolContext = {
    supabaseUrl: env.supabaseUrl,
    supabaseKey: env.supabaseKey,
    fetch: deps.fetch,
    auth: authorization,
    company,
    scope: { module: "mcp" },
    embed: deps.embed,
    members: base.members,
    clients: base.clients,
    today: base.today,
    usage: { embeddingTokens: 0, embeddingModel: env.embeddingModel },
    sources: [],
    chunks: new Map(),
  };
  // read_more precisa dos trechos da busca anterior, que num servidor sem
  // sessão não ficam guardados: a referência vem com o id do trecho.
  const ref = String(args.ref ?? "").trim();
  if (name === "read_more" && /^\d+$/.test(ref))
    ctx.chunks.set(ref, Number(ref));
  try {
    const out = await runTool(ctx, name, args);
    const links = ctx.sources.map(
      (s) => `[${s.ref}] ${sourceLink(env.appOrigin, s)}`,
    );
    const chunkRefs = [...ctx.chunks]
      .filter(([ref]) => ctx.sources.some((s) => s.ref === ref))
      .map(([ref, id]) => `[${ref}] trecho ${id}`);
    return text(
      [
        out,
        links.length
          ? `Links das fontes (abrir na MAVI):\n${links.join("\n")}`
          : "",
        chunkRefs.length
          ? `Para ler mais de um trecho, chame read_more com ref igual ao número do trecho (ex.: "${chunkRefs[0].split(" trecho ")[1]}"): ${chunkRefs.join("; ")}.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  } catch (e) {
    return text(
      (e as Error).message || "Não foi possível consultar a MAVI.",
      true,
    );
  } finally {
    if (ctx.usage.embeddingTokens)
      await callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "mcp",
        p_kind: "search",
        p_client: null,
        p_contract: null,
        p_project: null,
        p_recording: null,
        p_model: ctx.usage.embeddingModel,
        p_input: 0,
        p_output: 0,
        p_cache_read: 0,
        p_cache_write: 0,
        p_embedding: ctx.usage.embeddingTokens,
        p_cost:
          Math.round(
            embeddingCost(ctx.usage.embeddingModel, ctx.usage.embeddingTokens) *
              1e6,
          ) / 1e6,
      }).catch(() => {});
  }
}

/** Documento de descoberta do recurso protegido (RFC 9728). */
export function protectedResource(env: McpEnv) {
  return {
    resource: `${env.appOrigin}/api/mcp`,
    authorization_servers: [`${env.supabaseUrl}/auth/v1`],
    bearer_methods_supported: ["header"],
    resource_name: "MAVI",
    resource_documentation: `${env.appOrigin}/perfil`,
  };
}

export function unauthorized(env: McpEnv): McpResponse {
  return {
    status: 401,
    body: {
      error: "invalid_token",
      error_description: "Entre com a sua conta da MAVI.",
    },
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${env.appOrigin}/.well-known/oauth-protected-resource"`,
    },
  };
}

const rpcError = (id: unknown, code: number, message: string): McpResponse => ({
  status: 200,
  body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
});

/** Uma mensagem JSON-RPC do cliente MCP. */
export async function handleMcp(
  body: unknown,
  authorization: string | null,
  env: McpEnv,
  deps: AiDeps,
): Promise<McpResponse> {
  if (!authorization?.startsWith("Bearer ")) return unauthorized(env);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return {
      status: 400,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Mensagem inválida." },
      },
    };
  const msg = body as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Json;
  };
  // Respostas e avisos (sem id) não têm resposta.
  if (msg.method === undefined || msg.id === undefined)
    return { status: 202, body: null };
  const user = await tokenUser(env, deps, authorization);
  if (!user) return unauthorized(env);
  const params = msg.params ?? {};
  if (msg.method === "initialize") {
    const asked = String(params.protocolVersion ?? "");
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: MCP_VERSIONS.includes(asked)
            ? asked
            : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mavi", title: "MAVI", version: "1.0.0" },
          instructions: INSTRUCTIONS,
        },
      },
    };
  }
  if (msg.method === "ping")
    return { status: 200, body: { jsonrpc: "2.0", id: msg.id, result: {} } };
  if (msg.method === "tools/list")
    return {
      status: 200,
      body: { jsonrpc: "2.0", id: msg.id, result: { tools: mcpTools() } },
    };
  if (msg.method === "tools/call") {
    const name = String(params.name ?? "");
    const args = (
      params.arguments && typeof params.arguments === "object"
        ? params.arguments
        : {}
    ) as Json;
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: msg.id,
        result: await callTool(env, deps, authorization, name, args),
      },
    };
  }
  return rpcError(msg.id, -32601, `Método não suportado: ${msg.method}`);
}

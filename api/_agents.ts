import crypto from "node:crypto";
import { seal, unseal } from "./_google.js";
import { checkUrl } from "./_ai-mcp.js";
import { providerKeyFrom } from "./_ai-providers.js";

/**
 * Agente Conversacional (migração 20270323090000): o servidor conversa com
 * a API pública do n8n das VPS da agência.
 *
 *  - agent-sync: lê cada VPS inteira (a cada 1h pelo agendamento, com o
 *    AI_WORKER_SECRET; ou "Sincronizar agora" de um administrador): guarda
 *    os fluxos com nó AI Agent, o prompt de sistema e a ficha técnica de cada
 *    nó, e o papel do fluxo (principal, subfluxo ou cópia). Fluxos iguais aos
 *    já guardados (mesmo versionId) vão sem os nós.
 *  - agent-refresh: relê um fluxo agora (quem vê o fluxo).
 *  - agent-publish: troca só o texto do prompt de um nó e salva o fluxo no
 *    n8n (o n8n reativa sozinho o fluxo que estava ativo). Antes, relê o
 *    fluxo: se o prompt mudou direto no n8n depois da última leitura, nada é
 *    gravado e a pessoa revisa a versão atual.
 *  - agent-instance-save / agent-instance-test: o cadastro das VPS
 *    (administradores). A chave da API é cifrada aqui com AI_PROVIDER_KEY; o
 *    banco só guarda o valor cifrado e ela nunca volta ao navegador.
 *
 * O banco é chamado como a própria pessoa (o login dela) ou, no agendamento,
 * como anônimo com o segredo — nunca com a chave de serviço.
 */

type Fetch = typeof fetch;
type Result = { status: number; body: Record<string, unknown> };

export type AgentEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  /** 32 bytes (AI_PROVIDER_KEY); null quando falta. */
  providerKey: Buffer | null;
  /** O segredo do agendamento (AI_WORKER_SECRET, o de mavi_private.ai_config). */
  workerSecret?: string;
};
export type AgentDeps = {
  fetch: Fetch;
  /** Resolve o nome do servidor (os testes trocam). */
  lookup?: (host: string) => Promise<{ address: string }[]>;
  /** Até quando começar a ler outra VPS (ms desde o início). */
  budgetMs?: number;
};

export function agentEnv(
  drive: { supabaseUrl: string; supabaseKey: string; workerSecret?: string },
  env: Record<string, string | undefined> = process.env,
): AgentEnv {
  return {
    supabaseUrl: drive.supabaseUrl,
    supabaseKey: drive.supabaseKey,
    providerKey: providerKeyFrom(env.AI_PROVIDER_KEY),
    workerSecret: drive.workerSecret,
  };
}

export class AgentError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const MISSING_KEY =
  "Falta na Vercel: AI_PROVIDER_KEY (32 bytes em base64). Depois de salvar, faça um Redeploy.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROMPT_MAX = 200_000;

// ------------------------------------------------------------ n8n: leitura
/** Os nós que têm prompt de sistema: o AI Agent e o AI Agent Tool. */
export const AGENT_NODE_TYPES = new Set([
  "@n8n/n8n-nodes-langchain.agent",
  "@n8n/n8n-nodes-langchain.agentTool",
]);
/** Os nós que chamam outro fluxo (subfluxos). */
const CALL_NODE_TYPES = new Set([
  "n8n-nodes-base.executeWorkflow",
  "@n8n/n8n-nodes-langchain.toolWorkflow",
]);

type Connection = { node: string; type: string; index: number };
export type N8nNode = {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  disabled?: boolean;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
};
export type N8nWorkflow = {
  id: string;
  name: string;
  active: boolean;
  isArchived?: boolean;
  nodes: N8nNode[];
  connections: Record<string, Record<string, (Connection[] | null)[]>>;
  versionId?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** O prompt de sistema do nó; "=" na frente é expressão do n8n ({{ }}). */
export function systemMessageOf(node: N8nNode) {
  const raw = record(record(node.parameters).options).systemMessage;
  const text = typeof raw === "string" ? raw : "";
  return text.startsWith("=")
    ? { text: text.slice(1), expression: true }
    : { text, expression: false };
}

/** Valor de um parâmetro do n8n: texto ou o "resource locator" {value}. */
function locatorValue(v: unknown): string {
  if (typeof v === "string") return v;
  const r = record(v);
  const value = r.cachedResultName ?? r.value;
  return typeof value === "string" ? value : "";
}

/** Os nós ligados a `target` por uma conexão de IA (modelo, ferramenta…). */
function sourcesOf(wf: N8nWorkflow, target: string, type: string) {
  const found: N8nNode[] = [];
  for (const [source, byType] of Object.entries(wf.connections ?? {}))
    for (const outputs of Object.values(record(byType)) as (Connection[] | null)[][])
      for (const output of Array.isArray(outputs) ? outputs : [])
        for (const c of output ?? [])
          if (c?.node === target && c.type === type) {
            const node = wf.nodes.find((n) => n.name === source);
            if (node && !found.includes(node)) found.push(node);
          }
  return found;
}

/** A ficha técnica do nó: modelo, ferramentas e memória ligados a ele. */
export function agentSetup(wf: N8nWorkflow, node: N8nNode) {
  const model = sourcesOf(wf, node.name, "ai_languageModel")[0];
  const params = record(model?.parameters);
  const memory = sourcesOf(wf, node.name, "ai_memory")[0];
  return {
    model:
      locatorValue(params.model) ||
      locatorValue(params.modelName) ||
      undefined,
    model_node: model?.name,
    provider: model?.type
      .replace(/^@n8n\/n8n-nodes-langchain\./, "")
      .replace(/^lmChat/, ""),
    tools: sourcesOf(wf, node.name, "ai_tool").map((n) => n.name),
    memory: memory?.name,
    disabled: node.disabled || undefined,
  };
}

/** Os ids dos fluxos que este chama (Execute Workflow e Call Workflow Tool). */
export function workflowCalls(wf: N8nWorkflow) {
  const ids = new Set<string>();
  for (const n of wf.nodes ?? []) {
    if (!CALL_NODE_TYPES.has(n.type) || n.disabled) continue;
    const p = record(n.parameters);
    if (p.source && p.source !== "database") continue;
    const raw = p.workflowId;
    const id = typeof raw === "string" ? raw : record(raw).value;
    if (typeof id === "string" && id && !id.startsWith("=")) ids.add(id);
  }
  return [...ids];
}

export const agentNodes = (wf: N8nWorkflow) =>
  (wf.nodes ?? []).filter((n) => AGENT_NODE_TYPES.has(n.type));

export type Role = "main" | "subflow" | "copy";
/**
 * O papel de cada fluxo da VPS: principal (ativo), subfluxo (chamado por um
 * fluxo vivo, direto ou por outro subfluxo) ou cópia (o resto: backups,
 * versões antigas). Com quem chama cada um (só os vivos).
 */
export function classify(all: N8nWorkflow[]) {
  const byId = new Map(all.map((w) => [w.id, w]));
  const live = new Set<string>();
  const queue = all.filter((w) => w.active && !w.isArchived).map((w) => w.id);
  for (const id of queue) live.add(id);
  const callers = new Map<string, { id: string; name: string }[]>();
  while (queue.length) {
    const id = queue.shift()!;
    const wf = byId.get(id)!;
    for (const target of workflowCalls(wf)) {
      const t = byId.get(target);
      if (!t || t.isArchived) continue;
      const list = callers.get(target) ?? [];
      if (!list.some((c) => c.id === id)) list.push({ id, name: wf.name });
      callers.set(target, list);
      if (!live.has(target)) {
        live.add(target);
        queue.push(target);
      }
    }
  }
  const roles = new Map<string, { role: Role; called_by: { id: string; name: string }[] }>();
  for (const w of all)
    roles.set(w.id, {
      role: w.active && !w.isArchived ? "main" : live.has(w.id) ? "subflow" : "copy",
      called_by: (callers.get(w.id) ?? []).slice(0, 20),
    });
  return roles;
}

/** O que o banco guarda de um fluxo (agent_sync_store / agent_workflow_store). */
export function workflowPayload(
  wf: N8nWorkflow,
  role: { role: Role; called_by: { id: string; name: string }[] } | null,
  withNodes = true,
) {
  return {
    n8n_id: String(wf.id),
    name: String(wf.name ?? "").slice(0, 300),
    active: !!wf.active,
    archived: !!wf.isArchived,
    ...(role ?? {}),
    version_id: wf.versionId ?? "",
    updated_at: wf.updatedAt ?? null,
    ...(withNodes
      ? {
          nodes: agentNodes(wf)
            .filter((n) => n.id)
            .map((n) => {
              const { text, expression } = systemMessageOf(n);
              return {
                node_id: n.id,
                node_name: n.name,
                node_type: n.type,
                prompt: text.slice(0, PROMPT_MAX),
                expression,
                setup: agentSetup(wf, n),
              };
            }),
        }
      : {}),
  };
}

// ------------------------------------------------------------ n8n: API
const host = (base: string) => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};

/** Uma chamada à API pública do n8n (X-N8N-API-KEY), com prazo. */
export async function n8n<T>(
  base: string,
  key: string,
  path: string,
  deps: AgentDeps,
  init: { method?: string; body?: unknown } = {},
  timeoutMs = 30_000,
): Promise<T> {
  const url = `${base.replace(/\/+$/, "")}/api/v1${path}`;
  await checkUrl(url, { fetch: deps.fetch, lookup: deps.lookup }).catch((e) => {
    throw new AgentError(400, (e as Error).message);
  });
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: init.method ?? "GET",
      headers: {
        "X-N8N-API-KEY": key,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AgentError(
      502,
      `Não consegui falar com o n8n em ${host(base)}: ${(e as Error).message}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).message ?? message;
    } catch {
      /* texto puro */
    }
    if (res.status === 401 || res.status === 403)
      throw new AgentError(
        502,
        `O n8n em ${host(base)} recusou a chave da API (${res.status}). Confira a chave em Configuração.`,
      );
    if (res.status === 404)
      throw new AgentError(
        404,
        `O n8n em ${host(base)} não achou ${path.split("?")[0]} (404): o fluxo foi apagado ou a API pública está desligada.`,
      );
    if (res.status >= 300 && res.status < 400)
      throw new AgentError(
        502,
        `O n8n em ${host(base)} redirecionou o pedido (${res.status}): confira o endereço da VPS.`,
      );
    throw new AgentError(
      502,
      `O n8n em ${host(base)} respondeu ${res.status}: ${message}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AgentError(
      502,
      `O n8n em ${host(base)} respondeu algo que não é JSON: confira o endereço da VPS.`,
    );
  }
}

/** Todos os fluxos da VPS (de 100 em 100, sem os dados fixados). */
export async function listWorkflows(base: string, key: string, deps: AgentDeps) {
  const all: N8nWorkflow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const q: string = `limit=100&excludePinnedData=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r: { data: N8nWorkflow[]; nextCursor?: string | null } = await n8n(
      base,
      key,
      `/workflows?${q}`,
      deps,
      {},
      60_000,
    );
    all.push(...(r.data ?? []));
    cursor = r.nextCursor ?? null;
    if (!cursor || !r.data?.length) break;
  }
  return all;
}

/**
 * Os campos de um nó que a API pública aceita ao salvar (ela recusa os
 * outros). Nada do que a tela do n8n grava fica de fora.
 */
const NODE_KEYS = [
  "id",
  "name",
  "webhookId",
  "disabled",
  "notesInFlow",
  "notes",
  "type",
  "typeVersion",
  "executeOnce",
  "alwaysOutputData",
  "retryOnFail",
  "maxTries",
  "waitBetweenTries",
  "continueOnFail",
  "onError",
  "position",
  "parameters",
  "credentials",
];
/**
 * O fluxo para salvar com só o prompt do nó trocado. As configurações vão
 * vazias: o n8n mantém as que já existem e só troca as enviadas.
 */
export function withPrompt(
  wf: N8nWorkflow,
  nodeId: string,
  text: string,
  expression: boolean,
) {
  let found = false;
  const nodes = wf.nodes.map((n) => {
    const kept = Object.fromEntries(
      NODE_KEYS.filter((k) => n[k] !== undefined).map((k) => [k, n[k]]),
    ) as N8nNode;
    if (n.id !== nodeId) return kept;
    found = true;
    const params = record(n.parameters);
    return {
      ...kept,
      parameters: {
        ...params,
        options: {
          ...record(params.options),
          systemMessage: (expression ? "=" : "") + text,
        },
      },
    };
  });
  if (!found)
    throw new AgentError(
      409,
      "Este nó não existe mais no fluxo do n8n. Clique em Atualizar para reler o fluxo.",
    );
  return { name: wf.name, nodes, connections: wf.connections ?? {}, settings: {} };
}

// ------------------------------------------------------------ banco
type Rpc<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; code?: string; hint?: string };

/** Uma função do banco, como a pessoa (o login dela) ou anônimo. */
async function rpc<T>(
  env: AgentEnv,
  fetchImpl: Fetch,
  authorization: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<Rpc<T>> {
  const res = await fetchImpl(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.supabaseKey,
      Authorization: authorization ?? `Bearer ${env.supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok)
    return {
      ok: false,
      status:
        body?.code === "40001"
          ? 409
          : res.status === 401 || res.status === 403
            ? 403
            : res.status,
      // A consulta que passou do tempo diz qual função foi (como em _drive.ts).
      error:
        (body?.message ?? "Não foi possível acessar o banco.") +
        (body?.code === "57014" ? ` (${name})` : ""),
      code: body?.code,
      hint: body?.hint,
    };
  return { ok: true, data: body as T };
}
async function must<T>(r: Promise<Rpc<T>>): Promise<T> {
  const x = await r;
  if (!x.ok)
    throw new AgentError(x.status, x.error, x.code === "40001" ? { conflict: true, hint: x.hint } : {});
  return x.data;
}

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function openKey(env: AgentEnv, cipher: string) {
  if (!env.providerKey) throw new AgentError(500, MISSING_KEY);
  try {
    return unseal(env.providerKey, cipher);
  } catch {
    throw new AgentError(
      409,
      "A chave guardada desta VPS não abre mais (AI_PROVIDER_KEY mudou). Cadastre a chave da API de novo.",
    );
  }
}

// ------------------------------------------------------------ leitura
type SyncTarget = {
  id: string;
  name: string;
  base_url: string;
  key_cipher: string;
  /** n8n_id → versionId já guardado. */
  known: Record<string, string>;
};

/** Lê uma VPS inteira e guarda; uma falha fica registrada na VPS. */
async function syncInstance(
  env: AgentEnv,
  deps: AgentDeps,
  auth: { authorization: string | null; secret: string | null },
  t: SyncTarget,
) {
  const store = (args: Record<string, unknown>) =>
    rpc<Record<string, number>>(env, deps.fetch, auth.authorization, "agent_sync_store", {
      p_secret: auth.secret,
      p_instance: t.id,
      p_workflows: null,
      p_complete: false,
      p_error: null,
      p_stats: null,
      ...args,
    });
  try {
    const key = openKey(env, t.key_cipher);
    const all = await listWorkflows(t.base_url, key, deps);
    const roles = classify(all);
    const agents = all.filter((w) => agentNodes(w).length);
    let sent = 0;
    const workflows = agents.map((w) => {
      const same = !!w.versionId && t.known[String(w.id)] === w.versionId;
      if (!same) sent++;
      return workflowPayload(w, roles.get(w.id) ?? null, !same);
    });
    const stats = {
      workflows: all.length,
      agents: agents.length,
      main: workflows.filter((w) => w.role === "main").length,
      subflows: workflows.filter((w) => w.role === "subflow").length,
      copies: workflows.filter((w) => w.role === "copy").length,
      read: sent,
    };
    const r = await store({ p_workflows: workflows, p_complete: true, p_stats: stats });
    if (!r.ok) throw new AgentError(r.status, r.error);
    return { instance: t.name, ok: true, ...stats, ...r.data };
  } catch (e) {
    const message = (e as Error).message;
    await store({ p_error: message }).catch(() => undefined);
    return { instance: t.name, ok: false, error: message };
  }
}

async function sync(
  body: Record<string, unknown>,
  authorization: string | null,
  env: AgentEnv,
  deps: AgentDeps,
): Promise<Result> {
  const scheduled =
    !!env.workerSecret &&
    !!authorization &&
    sameSecret(authorization, `Bearer ${env.workerSecret}`);
  const company = String(body.company ?? "");
  const instance = body.instance ? String(body.instance) : null;
  if (!scheduled) {
    if (!authorization?.startsWith("Bearer "))
      return { status: 401, body: { error: "Autenticação necessária." } };
    if (!UUID.test(company) || (instance && !UUID.test(instance)))
      return { status: 400, body: { error: "Informe a empresa." } };
  }
  const auth = scheduled
    ? { authorization: null, secret: env.workerSecret! }
    : { authorization, secret: null };
  const targets = await must(
    rpc<SyncTarget[]>(env, deps.fetch, auth.authorization, "agent_sync_targets", {
      p_secret: auth.secret,
      p_company: scheduled ? null : company,
      p_instance: scheduled ? null : instance,
    }),
  );
  const started = Date.now();
  const budget = deps.budgetMs ?? 200_000;
  const results = [];
  for (const t of targets) {
    if (Date.now() - started > budget) {
      // Fica para a próxima volta do agendamento: solta a VPS.
      await rpc(env, deps.fetch, auth.authorization, "agent_sync_store", {
        p_secret: auth.secret,
        p_instance: t.id,
        p_workflows: null,
        p_complete: false,
        p_error: "A leitura ficou para a próxima volta (tempo esgotado).",
        p_stats: null,
      });
      continue;
    }
    results.push(await syncInstance(env, deps, auth, t));
  }
  return { status: 200, body: { results } };
}

// ------------------------------------------------------------ um fluxo
type WorkflowTarget = {
  workflow: string;
  n8n_id: string;
  base_url: string;
  key_cipher: string;
};

async function refresh(
  workflow: string,
  authorization: string,
  env: AgentEnv,
  deps: AgentDeps,
) {
  const t = await must(
    rpc<WorkflowTarget>(env, deps.fetch, authorization, "agent_workflow_target", {
      p_workflow: workflow,
    }),
  );
  const key = openKey(env, t.key_cipher);
  const wf = await n8n<N8nWorkflow>(
    t.base_url,
    key,
    `/workflows/${encodeURIComponent(t.n8n_id)}?excludePinnedData=true`,
    deps,
  );
  const stored = await must(
    rpc<{ changed: boolean }>(env, deps.fetch, authorization, "agent_workflow_store", {
      p_workflow: workflow,
      p_data: workflowPayload(wf, null),
    }),
  );
  return { wf, key, base: t.base_url, changed: stored.changed };
}

type EditTarget = {
  prompt: string;
  workflow: string;
  n8n_id: string;
  node_id: string;
  stored: string;
  expression: boolean;
  version: number;
  base_url: string;
  key_cipher: string;
};

async function publish(
  body: Record<string, unknown>,
  authorization: string,
  env: AgentEnv,
  deps: AgentDeps,
): Promise<Result> {
  const prompt = String(body.prompt ?? "");
  const base = Number(body.base);
  // mode "restore": uma versão antiga publicada de novo (from: qual).
  const action = body.mode === "restore" ? "restore" : "edit";
  const from = action === "restore" ? Number(body.from) : null;
  const text = String(body.text ?? "").replace(/\r\n?/g, "\n");
  if (!UUID.test(prompt) || !Number.isInteger(base))
    return { status: 400, body: { error: "Informe o prompt e a versão." } };
  if (text.length > PROMPT_MAX)
    return {
      status: 400,
      body: { error: `Prompt longo demais (até ${PROMPT_MAX.toLocaleString("pt-BR")} caracteres).` },
    };
  if (!text.trim())
    return { status: 400, body: { error: "O prompt não pode ficar vazio." } };
  const t = await must(
    rpc<EditTarget>(env, deps.fetch, authorization, "agent_prompt_edit_target", {
      p_prompt: prompt,
      p_base: base,
    }),
  );
  const key = openKey(env, t.key_cipher);
  const path = `/workflows/${encodeURIComponent(t.n8n_id)}`;
  const wf = await n8n<N8nWorkflow>(t.base_url, key, `${path}?excludePinnedData=true`, deps);
  const node = wf.nodes.find((n) => n.id === t.node_id);
  const now = node ? systemMessageOf(node) : null;
  if (!now || now.text !== t.stored || now.expression !== t.expression) {
    // Mudou direto no n8n: guarda a versão de lá (vira versão nova) e a
    // pessoa revisa antes de publicar por cima.
    await must(
      rpc(env, deps.fetch, authorization, "agent_workflow_store", {
        p_workflow: t.workflow,
        p_data: workflowPayload(wf, null),
      }),
    );
    throw new AgentError(
      409,
      node
        ? "O prompt foi alterado direto no n8n depois da última leitura. Carreguei a versão de lá: revise e publique de novo."
        : "Este nó não existe mais no fluxo do n8n.",
      { conflict: true },
    );
  }
  const saved = await n8n<N8nWorkflow>(t.base_url, key, path, deps, {
    method: "PUT",
    body: withPrompt(wf, t.node_id, text, t.expression),
  }, 60_000);
  const check = saved.nodes?.find((n) => n.id === t.node_id);
  if (!check || systemMessageOf(check).text !== text)
    throw new AgentError(
      502,
      "O n8n respondeu, mas o prompt salvo não confere com o enviado. Clique em Atualizar e confira no n8n.",
    );
  const r = await must(
    rpc<{ version: number }>(env, deps.fetch, authorization, "agent_prompt_saved", {
      p_prompt: prompt,
      p_base: base,
      p_text: text,
      p_note: String(body.note ?? "").slice(0, 500),
      p_action: action,
      p_from: from,
      p_version_id: saved.versionId ?? null,
      p_updated_at: saved.updatedAt ?? null,
    }),
  );
  return { status: 200, body: { version: r.version, active: !!saved.active } };
}

// ------------------------------------------------------------ VPS
async function testKey(base: string, key: string, deps: AgentDeps) {
  const r = await n8n<{ data?: N8nWorkflow[] }>(base, key, "/workflows?limit=1&excludePinnedData=true", deps);
  if (!Array.isArray(r.data))
    throw new AgentError(
      502,
      `O endereço ${host(base)} respondeu, mas não parece a API do n8n.`,
    );
  return true;
}

async function saveInstance(
  body: Record<string, unknown>,
  authorization: string,
  env: AgentEnv,
  deps: AgentDeps,
): Promise<Result> {
  if (!env.providerKey) throw new AgentError(500, MISSING_KEY);
  const company = String(body.company ?? "");
  const id = body.id ? String(body.id) : null;
  if (!UUID.test(company) || (id && !UUID.test(id)))
    return { status: 400, body: { error: "Informe a empresa." } };
  const base = String(body.base_url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/, "");
  const apiKey = String(body.api_key ?? "").trim();
  await checkUrl(base, { fetch: deps.fetch, lookup: deps.lookup }).catch((e) => {
    throw new AgentError(400, (e as Error).message);
  });
  if (!id && !apiKey)
    return { status: 400, body: { error: "Informe a chave da API do n8n." } };
  // Confere a chave antes de guardar (a nova, ou a guardada num endereço novo).
  const key = apiKey
    ? apiKey
    : openKey(
        env,
        (
          await must(
            rpc<{ key_cipher: string }>(env, deps.fetch, authorization, "agent_instance_secret", {
              p_company: company,
              p_id: id,
            }),
          )
        ).key_cipher,
      );
  await testKey(base, key, deps);
  const saved = await must(
    rpc<Record<string, unknown>>(env, deps.fetch, authorization, "agent_instance_save", {
      p_company: company,
      p_id: id,
      p_name: String(body.name ?? ""),
      p_base_url: base,
      p_key_cipher: apiKey ? seal(env.providerKey, apiKey) : null,
      p_key_hint: apiKey ? `…${apiKey.slice(-4)}` : null,
      p_enabled: body.enabled === undefined ? true : !!body.enabled,
    }),
  );
  return { status: 200, body: saved };
}

async function testInstance(
  body: Record<string, unknown>,
  authorization: string,
  env: AgentEnv,
  deps: AgentDeps,
): Promise<Result> {
  const company = String(body.company ?? "");
  const id = String(body.id ?? "");
  if (!UUID.test(company) || !UUID.test(id))
    return { status: 400, body: { error: "Informe a VPS." } };
  const t = await must(
    rpc<{ base_url: string; key_cipher: string }>(env, deps.fetch, authorization, "agent_instance_secret", {
      p_company: company,
      p_id: id,
    }),
  );
  await testKey(t.base_url, openKey(env, t.key_cipher), deps);
  return { status: 200, body: { ok: true } };
}

// ------------------------------------------------------------ rota
/** POST /api/ai com action agent-* (api/drive.ts). */
export async function handleAgents(
  body: Record<string, unknown>,
  authorization: string | null,
  env: AgentEnv,
  deps: AgentDeps,
): Promise<Result> {
  const action = String(body.action ?? "");
  try {
    if (action === "agent-sync") {
      if (!env.providerKey) throw new AgentError(500, MISSING_KEY);
      return await sync(body, authorization, env, deps);
    }
    if (!authorization?.startsWith("Bearer "))
      return { status: 401, body: { error: "Autenticação necessária." } };
    if (action === "agent-refresh") {
      const workflow = String(body.workflow ?? "");
      if (!UUID.test(workflow))
        return { status: 400, body: { error: "Informe o fluxo." } };
      const r = await refresh(workflow, authorization, env, deps);
      return { status: 200, body: { changed: r.changed } };
    }
    if (action === "agent-publish")
      return await publish(body, authorization, env, deps);
    if (action === "agent-instance-save")
      return await saveInstance(body, authorization, env, deps);
    if (action === "agent-instance-test")
      return await testInstance(body, authorization, env, deps);
    return { status: 400, body: { error: "Ação desconhecida." } };
  } catch (e) {
    if (e instanceof AgentError)
      return { status: e.status, body: { error: e.message, ...e.extra } };
    throw e;
  }
}

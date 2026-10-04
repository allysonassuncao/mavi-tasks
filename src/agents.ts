import { useEffect, useRef } from "react";
import { rpc } from "./api";
import { pageUrl, routeParts } from "./router";
import { supabase } from "./supabase";

/**
 * Agente Conversacional (migração 20270323090000_conversational_agents): o
 * prompt de sistema dos nós AI Agent dos fluxos do n8n de cada cliente (o
 * assistente de WhatsApp que a agência vende como produto MAVI). Quem vê o
 * cliente lê; quem edita no Drive o produto dele publica no n8n.
 */
export type AgentRole = "main" | "subflow" | "copy";
export type AgentSetup = {
  model?: string;
  model_node?: string;
  provider?: string;
  tools?: string[];
  memory?: string;
  disabled?: boolean;
};
export type AgentPromptSummary = {
  id: string;
  node_name: string;
  node_type: string;
  chars: number;
  version: number;
  changed_at: string;
  changed_by_name: string | null;
  setup: AgentSetup;
  expression: boolean;
  removed: boolean;
  /** O começo do texto, ou o trecho achado pela busca. */
  excerpt: string;
};
export type AgentWorkflow = {
  id: string;
  instance: string;
  instance_name: string;
  /** O fluxo aberto no editor do n8n. */
  n8n_url: string;
  n8n_id: string;
  name: string;
  active: boolean;
  archived: boolean;
  role: AgentRole;
  called_by: { id: string; name: string }[];
  n8n_updated_at: string | null;
  client_id: string | null;
  client_name: string | null;
  contract_id: string | null;
  product_name: string | null;
  link_source: "auto" | "manual" | null;
  ignored: boolean;
  removed_at: string | null;
  can_edit: boolean;
  prompts: AgentPromptSummary[];
};
export type AgentPrompt = {
  id: string;
  workflow_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  prompt: string;
  expression: boolean;
  setup: AgentSetup;
  version: number;
  changed_at: string;
  changed_by_name: string | null;
  removed: boolean;
  workflow: AgentWorkflow;
};
export type AgentVersionSource = "first" | "n8n" | "edit" | "restore";
export type AgentPromptVersion = {
  version: number;
  source: AgentVersionSource;
  restored_from: number | null;
  note: string;
  saved_by_name: string | null;
  saved_at: string;
  chars: number;
};
export type AgentInstance = {
  id: string;
  name: string;
  base_url: string;
  key_hint: string;
  enabled: boolean;
  last_sync_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  last_stats: {
    workflows?: number;
    agents?: number;
    main?: number;
    subflows?: number;
    copies?: number;
  };
  syncing: boolean;
  workflows: number;
  created_at: string;
};
/**
 * O que a pessoa pode no módulo. `linker`: liga fluxos aos clientes (aba Sem
 * cliente e Trocar cliente) — líderes sempre, os outros quando liberados
 * (migração 20270324090000_agent_linkers). As VPS só para líderes.
 */
export type AgentStatus =
  | { leader: false; linker: false }
  | {
      leader: boolean;
      linker: true;
      admin: boolean;
      /** Principais e subfluxos sem cliente (não ignorados). */
      unlinked: number;
      unlinked_all: number;
      /** Só líderes. */
      instances?: number;
      errors?: number;
      last_sync_at?: string | null;
    };
/** Uma pessoa e se ela liga fluxos aos clientes. */
export type AgentLinker = {
  user_id: string;
  name: string;
  role: string;
  /** Administrador ou gestor: sempre pode. */
  leader: boolean;
  allowed: boolean;
  granted_at: string | null;
  granted_by_name: string | null;
};

export const ROLE_LABEL: Record<AgentRole, string> = {
  main: "Principal",
  subflow: "Subfluxo",
  copy: "Cópia",
};
export const SOURCE_LABEL: Record<AgentVersionSource, string> = {
  first: "Primeira leitura",
  n8n: "Alterado no n8n",
  edit: "Publicado aqui",
  restore: "Versão antiga publicada",
};

// Sem banco (demonstração): os dados de exemplo, carregados só então.
const demo = () => (supabase ? null : import("./agents-demo"));

export const listAgents = (
  company: string,
  opts: {
    client?: string | null;
    contract?: string | null;
    query?: string;
    unlinked?: boolean;
  } = {},
) =>
  demo()?.then((m) => m.demoAgentList(opts)) ??
  (rpc("agent_list", {
    p_company: company,
    p_client: opts.client ?? null,
    p_contract: opts.contract ?? null,
    p_query: opts.query?.trim() || null,
    p_unlinked: !!opts.unlinked,
  }) as Promise<AgentWorkflow[]>);
export const countAgents = (company: string, contract: string) =>
  demo()?.then(() => 0) ??
  (rpc("agent_count", { p_company: company, p_contract: contract }) as Promise<number>);
export const agentStatus = (company: string) =>
  demo()?.then((m) => m.demoAgentStatus()) ??
  (rpc("agent_status", { p_company: company }) as Promise<AgentStatus>);
export const agentPrompt = (prompt: string) =>
  demo()?.then((m) => m.demoAgentPrompt(prompt)) ??
  (rpc("agent_prompt_get", { p_prompt: prompt }) as Promise<AgentPrompt>);
export const agentPromptVersions = (prompt: string) =>
  demo()?.then((m) => m.demoAgentVersions(prompt)) ??
  (rpc("agent_prompt_versions", { p_prompt: prompt }) as Promise<
    AgentPromptVersion[]
  >);
export const agentPromptVersion = (prompt: string, version: number) =>
  demo()?.then((m) => m.demoAgentVersion(prompt, version)) ??
  (rpc("agent_prompt_version", { p_prompt: prompt, p_version: version }) as Promise<{
    version: number;
    prompt: string;
    expression: boolean;
    source: AgentVersionSource;
    restored_from: number | null;
    note: string;
    saved_at: string;
    saved_by_name: string | null;
  }>);
export const linkAgentWorkflow = (
  workflow: string,
  client: string | null,
  contract: string | null,
  /** Só a demonstração usa (o banco sabe o nome). */
  clientName: string | null = null,
) =>
  demo()?.then((m) => m.demoLink(workflow, client, clientName)) ??
  (rpc("agent_workflow_link", {
    p_workflow: workflow,
    p_client: client,
    p_contract: contract,
  }) as Promise<AgentWorkflow>);
export const ignoreAgentWorkflow = (workflow: string, ignored: boolean) =>
  rpc("agent_workflow_ignore", {
    p_workflow: workflow,
    p_ignored: ignored,
  }) as Promise<AgentWorkflow>;
export const agentLinkers = (company: string) =>
  demo()?.then((m) => m.demoLinkers()) ??
  (rpc("agent_linkers_list", { p_company: company }) as Promise<AgentLinker[]>);
export const setAgentLinker = (company: string, user: string, allowed: boolean) =>
  demo()?.then((m) => m.demoSetLinker(user, allowed)) ??
  (rpc("agent_linker_set", {
    p_company: company,
    p_user: user,
    p_allowed: allowed,
  }) as Promise<{ user_id: string; allowed: boolean }>);
export const agentInstances = (company: string) =>
  demo()?.then((m) => m.demoInstances()) ??
  (rpc("agent_instances_list", { p_company: company }) as Promise<
    AgentInstance[]
  >);
export const deleteAgentInstance = (company: string, id: string) =>
  rpc("agent_instance_delete", { p_company: company, p_id: id }) as Promise<void>;

// ------------------------------------------------------------ servidor
/** Erro do servidor; `conflict`: o prompt mudou no meio tempo (n8n ou outra pessoa). */
export class AgentServerError extends Error {
  constructor(
    message: string,
    readonly conflict = false,
  ) {
    super(message);
  }
}
/** O servidor conversa com o n8n (a chave da VPS nunca vem ao navegador). */
async function server<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw Error("Supabase não configurado");
  const call = async () => {
    const token = (await supabase!.auth.getSession()).data.session
      ?.access_token;
    return fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  };
  let res = await call();
  if (res.status === 401) {
    await supabase.auth.refreshSession();
    res = await call();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new AgentServerError(
      data.error ?? "Não foi possível falar com o servidor.",
      !!data.conflict,
    );
  return data as T;
}

/** Publica o texto no n8n; `base` é a versão aberta. */
export const publishAgentPrompt = (opts: {
  prompt: string;
  base: number;
  text: string;
  note?: string;
  restoreFrom?: number;
}) =>
  demo()?.then((m) => m.demoPublish(opts.prompt, opts.text, opts.note ?? "", opts.restoreFrom)) ??
  server<{ version: number; active: boolean }>({
    action: "agent-publish",
    prompt: opts.prompt,
    base: opts.base,
    text: opts.text,
    note: opts.note ?? "",
    ...(opts.restoreFrom ? { mode: "restore", from: opts.restoreFrom } : {}),
  });
/** Relê o fluxo no n8n agora. */
export const refreshAgentWorkflow = (workflow: string) =>
  demo()?.then(() => ({ changed: false })) ??
  server<{ changed: boolean }>({ action: "agent-refresh", workflow });
/** Lê a VPS (ou todas) agora — administradores. */
export const syncAgents = (company: string, instance?: string) =>
  server<{
    results: {
      instance: string;
      ok: boolean;
      error?: string;
      agents?: number;
      changed?: number;
    }[];
  }>({ action: "agent-sync", company, ...(instance ? { instance } : {}) });
export const saveAgentInstance = (body: {
  company: string;
  id?: string;
  name: string;
  base_url: string;
  api_key?: string;
  enabled: boolean;
}) =>
  server<{ id: string }>({ action: "agent-instance-save", ...body });
export const testAgentInstance = (company: string, id: string) =>
  server<{ ok: true }>({ action: "agent-instance-test", company, id });

/** O link de um prompt (abre no módulo). */
export function agentPromptPath(prompt: string) {
  const company = routeParts(window.location.pathname).company;
  return `${pageUrl("agents", company)}?prompt=${prompt}`;
}

/**
 * Recarrega quando chega um aviso do Agente Conversacional (do cliente ou
 * produto, ou geral); vários avisos seguidos viram uma recarga só.
 */
export function useLiveAgents(
  scope: { client?: string | null; contract?: string | null },
  reload: () => void,
) {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    let timer: number | undefined;
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (scope.contract && d.contract && d.contract !== scope.contract) return;
      if (scope.client && d.client && d.client !== scope.client) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => latest.current(), 350);
    };
    window.addEventListener("mavi:agents", on);
    return () => {
      window.removeEventListener("mavi:agents", on);
      window.clearTimeout(timer);
    };
  }, [scope.client, scope.contract]);
}

import { supabase } from "./supabase";
import { providerAction } from "./ai";

/**
 * MAVI · Conexões (MCP) na tela (migração 20261218090000_mavi_mcp): a lista,
 * o cadastro (a chave e o segredo vão selados pelo servidor), o login OAuth,
 * as ferramentas de cada conexão e a ação confirmada.
 */

export type McpAuth = "none" | "header" | "oauth";
export type McpToolInfo = {
  name: string;
  title?: string;
  description?: string;
  read_only: boolean;
  enabled: boolean;
};
export type McpServer = {
  id: string;
  slug: string;
  name: string;
  url: string;
  instructions: string;
  auth: McpAuth;
  per_person: boolean;
  personal: boolean;
  header_name: string | null;
  header_hint: string | null;
  has_header: boolean;
  client_id: string | null;
  has_client_secret: boolean;
  oauth_ready: boolean;
  tools: McpToolInfo[];
  tools_at: string | null;
  last_error: string | null;
  enabled: boolean;
  everyone: boolean;
  team_ids: string[];
  user_ids: string[];
  except_ids: string[];
  updated_at: string;
  editable: boolean;
  usable: boolean;
  connected: boolean;
  connected_at: string | null;
};
export type McpDraft = {
  id?: string;
  personal: boolean;
  name: string;
  url: string;
  instructions: string;
  auth: McpAuth;
  per_person: boolean;
  header_name: string;
  /** Vazio: mantém a chave guardada. */
  header_value: string;
  client_id: string;
  /** Vazio: mantém o segredo guardado. */
  client_secret: string;
  enabled: boolean;
};

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export const listMcp = (company: string) =>
  rpc<McpServer[]>("ai_mcp_list", { p_company: company }).then((l) => l ?? []);
export const deleteMcp = (id: string) => rpc("ai_mcp_delete", { p_server: id });
export const toggleMcpTool = (id: string, tool: string, enabled: boolean) =>
  rpc("ai_mcp_toggle_tool", { p_server: id, p_tool: tool, p_enabled: enabled });
export const disconnectMcp = (id: string) => rpc("ai_mcp_disconnect", { p_server: id });
export const setMcpAudience = (
  id: string,
  a: { everyone: boolean; team_ids: string[]; user_ids: string[]; except_ids: string[] },
) =>
  rpc("ai_mcp_set_audience", {
    p_server: id,
    p_everyone: a.everyone,
    p_teams: a.team_ids,
    p_users: a.user_ids,
    p_except: a.except_ids,
  });

export type McpFound = { tools?: number; needs_connect?: boolean; error?: string };
export const saveMcp = (company: string, d: McpDraft) =>
  providerAction<McpFound & { id: string }>({ action: "ai-mcp-save", company, ...d });
export const discoverMcp = (server: string) =>
  providerAction<McpFound>({ action: "ai-mcp-discover", server });
/** O endereço do login no serviço (a volta é para `back`). */
export const connectMcp = (server: string, back: string) =>
  providerAction<{ url: string }>({ action: "ai-mcp-connect", server, back });
/** Roda a ação que a pessoa confirmou no card (uma vez só). */
export const runMcpAction = (conversation: string, artifact: string) =>
  providerAction<{ ok: boolean; text?: string; error?: string }>({
    action: "ai-mcp-run",
    conversation,
    artifact,
  });

export const blankDraft = (personal: boolean): McpDraft => ({
  personal,
  name: "",
  url: "",
  instructions: "",
  auth: "none",
  per_person: false,
  header_name: "Authorization",
  header_value: "",
  client_id: "",
  client_secret: "",
  enabled: true,
});

export const draftOf = (s: McpServer): McpDraft => ({
  id: s.id,
  personal: s.personal,
  name: s.name,
  url: s.url,
  instructions: s.instructions,
  auth: s.auth,
  per_person: s.per_person,
  header_name: s.header_name ?? "Authorization",
  header_value: "",
  client_id: s.client_id ?? "",
  client_secret: "",
  enabled: s.enabled,
});

/** Como a conexão está para quem vê. */
export function mcpStatus(s: McpServer): { tone: "ok" | "warn" | "off" | "error"; label: string } {
  if (!s.enabled) return { tone: "off", label: "Desligada" };
  if (s.auth === "oauth" && !s.connected)
    return {
      tone: "warn",
      label: s.personal || s.per_person ? "Conecte sua conta" : "Falta conectar a conta da empresa",
    };
  if (s.last_error) return { tone: "error", label: "Com erro" };
  if (!s.tools.length) return { tone: "warn", label: "Sem ferramentas" };
  return { tone: "ok", label: "Conectada" };
}

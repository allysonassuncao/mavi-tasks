import { supabase } from "./supabase";
import { navigate, routeParts, taskUrl } from "./router";

/**
 * IA do MAVI no navegador: a mesma pergunta serve a qualquer módulo — o
 * escopo diz onde a pessoa está (cliente, produto, projeto, módulo) e a IA
 * busca só ali. As respostas citam fontes [S#] que viram atalhos.
 */

export type AiScope = {
  client?: string;
  contract?: string;
  project?: string;
  module?: string;
};
export type AiSource = {
  ref: string;
  type: "meeting" | "task";
  id: string;
  title: string;
  date: string | null;
  client_id: string | null;
  start?: number;
};

/** Um passo do trabalho da IA, como a tela mostra. */
export type AiStep = {
  id: string;
  label: string;
  state: "running" | "done" | "error" | "note";
  detail?: string;
};
export type AiStreamHandlers = {
  onStep?: (step: AiStep) => void;
  onThinking?: (delta: string) => void;
  onText?: (delta: string) => void;
  /** A rodada chamou ferramentas: o texto dela era um comentário de trabalho. */
  onRoundEnd?: () => void;
  onWarning?: (text: string) => void;
};
export type AiAnswer = {
  answer: string;
  sources: AiSource[];
  conversation: string | null;
};

async function token() {
  return supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
}

/**
 * Chama a IA em tempo real: lê as linhas JSON do servidor à medida que
 * chegam e repassa cada evento; devolve a resposta final.
 */
export async function streamAnswer(
  path: string,
  body: Record<string, unknown>,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<AiAnswer> {
  const t = await token();
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw Error(data.error ?? "Não foi possível falar com a IA.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: AiAnswer | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const e = JSON.parse(line);
    if (e.type === "step")
      handlers.onStep?.({
        id: e.id,
        label: e.label,
        state: e.state,
        detail: e.detail,
      });
    else if (e.type === "thinking") handlers.onThinking?.(e.text);
    else if (e.type === "text") handlers.onText?.(e.text);
    else if (e.type === "round_end") handlers.onRoundEnd?.();
    else if (e.type === "warning") handlers.onWarning?.(e.text);
    else if (e.type === "done")
      final = {
        answer: e.answer ?? "",
        sources: e.sources ?? [],
        conversation: e.conversation ?? null,
      };
    else if (e.type === "error")
      throw Error(e.error ?? "Não foi possível responder.");
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer);
  if (!final) throw Error("A resposta da IA foi interrompida. Tente de novo.");
  return final;
}

/** Pergunta à IA geral (busca na base de conhecimento), numa conversa salva. */
export function askAi(
  company: string,
  scope: AiScope,
  question: string,
  conversation: string | null,
  handlers: AiStreamHandlers = {},
  signal?: AbortSignal,
) {
  return streamAnswer(
    "/api/ai",
    { action: "ai-ask", company, scope, question, conversation },
    handlers,
    signal,
  );
}

// ------------------------------------------------------------ conversas
export type AiConversation = {
  id: string;
  owner_id: string;
  title: string;
  scope: AiScope;
  module: string;
  updated_at: string;
};
export type AiStoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  sources: AiSource[];
  steps: { label: string; detail?: string }[];
};

/** As conversas que a pessoa vê (as dela e as compartilhadas com ela). */
export async function listConversations(company: string) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("id,owner_id,title,scope,module,updated_at")
    .eq("company_id", company)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as AiConversation[];
}
export async function conversationMessages(id: string) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("ai_messages")
    .select("id,role,content,sources,steps")
    .eq("conversation_id", id)
    .order("id");
  if (error) throw error;
  return (data ?? []) as AiStoredMessage[];
}
export async function conversationShares(id: string) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("ai_conversation_shares")
    .select("user_id")
    .eq("conversation_id", id);
  if (error) throw error;
  return (data ?? []).map((r) => r.user_id as string);
}
async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}
export const renameConversation = (id: string, title: string) =>
  rpc("ai_rename_conversation", { p_conversation: id, p_title: title });
export const deleteConversation = (id: string) =>
  rpc("ai_delete_conversation", { p_conversation: id });
export const shareConversation = (id: string, users: string[]) =>
  rpc<{ shared: string[]; refused: { user: string; reason: string }[] }>(
    "ai_share_conversation",
    { p_conversation: id, p_users: users },
  );

// ------------------------------------------------------------ consumo e limites
export type UsageRow = { id: string; cost: number; asks: number };
export type UsageLimit = {
  type: "company" | "user" | "client" | "contract" | "project";
  id: string | null;
  monthly_usd: number;
  month_spent: number;
};
export type UsageReport = {
  total: {
    cost: number;
    asks: number;
    index_cost: number;
    input_tokens: number;
    output_tokens: number;
    embedding_tokens: number;
  };
  by_user: UsageRow[];
  by_client: UsageRow[];
  by_contract: UsageRow[];
  by_project: UsageRow[];
  by_module: UsageRow[];
  by_day: { day: string; cost: number; asks: number }[];
  limits: UsageLimit[];
};
export const usageReport = (company: string, from: string, to: string) =>
  rpc<UsageReport>("ai_usage_report", {
    p_company: company,
    p_from: from,
    p_to: to,
  });
export const setAiLimit = (
  company: string,
  type: UsageLimit["type"],
  id: string | null,
  amount: number | null,
) =>
  rpc("ai_set_limit", {
    p_company: company,
    p_type: type,
    p_id: id,
    p_amount: amount,
  });

// ------------------------------------------------------------ onde a pessoa está
/**
 * O contexto da tela aberta (ex.: o cliente no Drive), para o assistente
 * global já começar nele. Cada página diz o seu e limpa ao sair.
 */
export type AiPlace = { client?: string; label?: string } | null;
let place: AiPlace = null;
const listeners = new Set<() => void>();
export function setAiPlace(next: AiPlace) {
  place = next;
  listeners.forEach((l) => l());
}
export function subscribeAiPlace(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const currentAiPlace = () => place;

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "America/Sao_Paulo",
      })
    : "";

/** O rótulo curto de uma citação: "Reunião 16/09 · 12:34", "Tarefa". */
export function sourceLabel(s: AiSource) {
  if (s.type === "meeting")
    return [
      `Reunião ${shortDate(s.date)}`,
      s.start != null ? clock(s.start) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return "Tarefa";
}

/** Abre uma tarefa citada (a reunião, quem mostra a resposta decide como abrir). */
export function openTaskSource(s: AiSource) {
  const company = routeParts(window.location.pathname).company;
  navigate(taskUrl({ id: s.id, title: s.title }, company));
}

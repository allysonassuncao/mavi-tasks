import { supabase } from "./supabase";
import { navigate, pageUrl, routeParts, taskUrl } from "./router";
import type {
  AiFeature,
  AiRoute,
  ProviderKind,
  ProviderModel,
  RouteScope,
} from "./ai-providers";
import {
  sanitizeArtifact,
  sanitizeArtifacts,
  type ActionState,
  type AiArtifact,
  type Power,
} from "./mavi-artifacts";

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
  type:
    | "meeting"
    | "task"
    | "file"
    | "social"
    | "campaign"
    | "case"
    | "whatsapp"
    | "web"
    /** Um arquivo que a pessoa anexou na conversa (id: o anexo). */
    | "attachment";
  /** Página da internet (busca na internet do módulo MAVI). */
  url?: string;
  /** Whatsapp: o id é a mensagem; o grupo abre a conversa. */
  id: string;
  group?: string;
  title: string;
  date: string | null;
  client_id: string | null;
  /** Social Leads: o produto contratado. */
  contract_id?: string | null;
  /** Reunião: segundo do trecho citado. */
  start?: number;
  /** Arquivo: página, slide ou planilha citada. */
  page?: number;
  label?: string;
  /** Tarefa que a pessoa não abre (Assistente MAVI: só título e status). */
  restricted?: boolean;
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
  /** A MAVI mostrou uma visualização, uma imagem ou uma ação (módulo MAVI). */
  onArtifact?: (artifact: AiArtifact) => void;
  /** A execução desta resposta (para parar) e a conversa em que ela fica. */
  onRun?: (run: { id: string; conversation: string }) => void;
};
/** O passo a passo do custo de uma resposta (api/_ai-cost.ts, turnDetail). */
export type TurnDetail = {
  rounds: {
    model: string;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    cost: number;
    tools: string[];
  }[];
  tools: { tool: string; label: string; ok: boolean; ms: number; cost: number }[];
  prompt: { question: number; extras: number; history: number; instructions: number; context: number };
  output: number;
  answer: number;
};
/** O custo de uma resposta, por modelo (o servidor manda no fim). */
export type TurnCost = {
  detail?: TurnDetail | null;
  /** O gasto por uso (resposta, busca, imagem, anexos, resumo…). */
  kinds?: { kind: string; cost: number }[];
  cost: number;
  models: {
    model: string;
    /** O nome do provedor (null: o padrão do servidor). */
    provider: string | null;
    kinds: string[];
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    embedding: number;
    cost: number;
  }[];
};
export type AiAnswer = {
  answer: string;
  sources: AiSource[];
  artifacts?: AiArtifact[];
  conversation: string | null;
  cost?: TurnCost;
  /** A mensagem salva desta resposta. */
  message?: number;
};
/** O custo de uma conversa (ai_conversation_cost). */
export type ConversationCost = {
  total: {
    cost: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    embedding_tokens: number;
    calls: number;
    answers: number;
  };
  by_model: {
    provider: string;
    model: string;
    cost: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    embedding_tokens: number;
    kinds: string[] | null;
  }[];
  by_kind: { kind: string; cost: number; calls: number }[];
  by_message: {
    message: number;
    cost: number;
    items: {
      provider: string;
      model: string;
      kind: string;
      cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      embedding_tokens: number;
    }[];
    detail?: TurnDetail | null;
  }[];
};
/**
 * O custo da conversa por modelo (só quem começou e os gestores veem; antes
 * da migração 20261224090000, ou sem acesso, null).
 */
export async function conversationCost(id: string): Promise<ConversationCost | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("ai_conversation_cost", { p_conversation: id });
  return error ? null : (data as ConversationCost);
}

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
    throw Error(data.error ?? "Não foi possível falar com a MAVI.");
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
    else if (e.type === "run") handlers.onRun?.({ id: e.id, conversation: e.conversation });
    else if (e.type === "artifact") {
      const artifact = sanitizeArtifact(e.artifact);
      if (artifact) handlers.onArtifact?.(artifact);
    } else if (e.type === "done")
      final = {
        answer: e.answer ?? "",
        sources: e.sources ?? [],
        artifacts: sanitizeArtifacts(e.artifacts),
        conversation: e.conversation ?? null,
        ...(e.cost && typeof e.cost.cost === "number" ? { cost: e.cost as TurnCost } : {}),
        ...(typeof e.message === "number" ? { message: e.message } : {}),
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
  if (!final)
    throw Error("A resposta da MAVI foi interrompida. Tente de novo.");
  return final;
}

/**
 * Pergunta à IA geral (busca na base de conhecimento), numa conversa salva.
 * No módulo MAVI (surface "page"), valem também os poderes da pessoa.
 */
export function askAi(
  company: string,
  scope: AiScope,
  question: string,
  conversation: string | null,
  handlers: AiStreamHandlers = {},
  signal?: AbortSignal,
  surface?: "page",
  /** Skills escolhidas na caixa de mensagem (a versão: em teste). */
  skills?: { slug: string; version?: number }[],
  /** A ação de conexão (MCP) que a pessoa confirmou no card: roda e a MAVI continua. */
  confirm?: string,
  /** Os anexos desta pergunta (módulo MAVI). */
  attachments?: string[],
) {
  return streamAnswer(
    "/api/ai",
    {
      action: "ai-ask",
      company,
      scope,
      question,
      conversation,
      ...(surface ? { surface } : {}),
      ...(skills?.length ? { skills } : {}),
      ...(confirm ? { confirm } : {}),
      ...(attachments?.length ? { attachments } : {}),
    },
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
  artifacts?: AiArtifact[];
};

/** As conversas que a pessoa vê (as dela e as compartilhadas com ela). */
export async function listConversations(company: string, limit = 100) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("id,owner_id,title,scope,module,updated_at")
    .eq("company_id", company)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AiConversation[];
}
/** Uma conversa que a pessoa vê (null quando não existe ou não tem acesso). */
export async function getConversation(company: string, id: string) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("id,owner_id,title,scope,module,updated_at")
    .eq("company_id", company)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as AiConversation | null) ?? null;
}
export async function conversationMessages(id: string) {
  if (!supabase) return [];
  const read = (columns: string) =>
    supabase!
      .from("ai_messages")
      .select(columns)
      .eq("conversation_id", id)
      .order("id");
  let { data, error } = await read("id,role,content,sources,steps,artifacts");
  // Antes da migração 20261212090000_mavi_powers não há anexos.
  if (error?.code === "42703")
    ({ data, error } = await read("id,role,content,sources,steps"));
  if (error) throw error;
  return ((data ?? []) as unknown as AiStoredMessage[]).map((m) => ({
    ...m,
    artifacts: sanitizeArtifacts(m.artifacts),
  }));
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
/** O link (10 minutos) para abrir um anexo da conversa. */
export async function attachmentUrl(id: string) {
  const data = await providerAction<{ url: string }>({ action: "ai-attach-url", id });
  return data.url;
}
/** Parar uma resposta da MAVI (a sua): o servidor para no próximo passo. */
export const cancelRun = (run: string) => rpc<boolean | null>("ai_run_cancel", { p_run: run });
export type ActiveRun = {
  id: string;
  conversation: string | null;
  question: string;
  started_at: string;
  cancel_requested: boolean;
};
/** As respostas da MAVI ainda em andamento (de quem está logado). */
export const activeRuns = (company: string) =>
  rpc<ActiveRun[]>("ai_runs_active", { p_company: company }).then((l) => l ?? []);
// ------------------------------------------------------------ tarefas longas
export type AiTaskStatus = "proposed" | "running" | "paused" | "stopping" | "done" | "cancelled" | "error";
export type AiTaskStep = {
  ord: number;
  title: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
  error: string | null;
  cost: number;
  attempts: number;
};
/** Uma tarefa longa da MAVI (ai_task_get), sem o texto das etapas. */
export type AiTask = {
  id: string;
  conversation: string;
  title: string;
  goal: string;
  closing: { title: string; instructions: string } | null;
  status: AiTaskStatus;
  pause_reason: string | null;
  error: string | null;
  estimate: number;
  cap: number;
  spent: number;
  slices: number;
  message: number | null;
  lease_until: string | null;
  updated_at: string;
  steps: AiTaskStep[];
};
/** A tarefa (só de quem pediu; para os outros, null). */
export const aiTask = (id: string) => rpc<AiTask | null>("ai_task_get", { p_task: id });
/** Confirmar o plano: a MAVI começa no servidor. */
export const confirmAiTask = (id: string) =>
  providerAction<{ task: AiTask }>({ action: "ai-task-confirm", task: id }).then((r) => r.task);
/** Parar: antes de começar, cancela; rodando, a MAVI entrega o que já tem. */
export const stopAiTask = (id: string) =>
  providerAction<{ task: AiTask }>({ action: "ai-task-stop", task: id }).then((r) => r.task);
/** Retomar a tarefa pausada (token vencido, a próxima parte não começou). */
export const resumeAiTask = (id: string) => providerAction({ action: "ai-task-resume", task: id });
/** O teto por tarefa longa da empresa (padrão US$ 10). */
export const aiTaskCap = (company: string) =>
  rpc<number>("ai_task_cap", { p_company: company }).then((v) => Number(v ?? 10));
/** Líderes: muda o teto (sem valor, volta ao padrão). */
export const setAiTaskCap = (company: string, usd: number | null) =>
  rpc<number>("ai_set_task_cap", { p_company: company, p_usd: usd }).then((v) => Number(v ?? 10));

export const renameConversation = (id: string, title: string) =>
  rpc("ai_rename_conversation", { p_conversation: id, p_title: title });
export const deleteConversation = (id: string) =>
  rpc("ai_delete_conversation", { p_conversation: id });
/** Links (1 hora) das imagens que a MAVI gerou, para quem vê a conversa. */
export async function imageUrls(company: string, paths: string[]) {
  if (!paths.length) return {} as Record<string, string>;
  const data = await providerAction<{ urls: Record<string, string> }>({
    action: "ai-image-urls",
    company,
    paths,
  });
  return data.urls ?? {};
}
/** A decisão sobre uma ação que a MAVI propôs (uma vez só). */
export const setActionState = (
  conversation: string,
  artifact: string,
  state: Exclude<ActionState, "pending">,
  result: Record<string, unknown> = {},
) =>
  rpc("ai_set_action_state", {
    p_conversation: conversation,
    p_artifact: artifact,
    p_state: state,
    p_result: result,
  });

// ------------------------------------------------------------ poderes
export type PowerSetting = {
  power: Power;
  enabled: boolean;
  everyone: boolean;
  team_ids: string[];
  user_ids: string[];
  except_ids: string[];
  updated_at: string | null;
  updated_by: string | null;
};
export const powersAdmin = (company: string) =>
  rpc<PowerSetting[]>("ai_powers_admin", { p_company: company });
export const setPower = (company: string, p: PowerSetting) =>
  rpc("ai_set_power", {
    p_company: company,
    p_power: p.power,
    p_enabled: p.enabled,
    p_everyone: p.everyone,
    p_teams: p.team_ids,
    p_users: p.user_ids,
    p_except: p.except_ids,
  });
export const myPowers = (company: string) =>
  rpc<Power[]>("ai_my_powers", { p_company: company });

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
    /** Cache do prompt (migração 20261222090000): lidos (custam ~10%) e gravados. */
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  by_user: UsageRow[];
  by_client: UsageRow[];
  by_contract: UsageRow[];
  by_project: UsageRow[];
  by_module: UsageRow[];
  /** Por provedor e modelo ("" é o padrão do servidor). */
  by_model?: (UsageRow & {
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
  })[];
  /** Cada ferramenta da MAVI: chamadas, falhas, tempo médio e custo. */
  by_tool?: {
    id: string;
    calls: number;
    errors: number;
    avg_ms: number;
    cost: number;
    people: number;
  }[];
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

// ------------------------------------------------------------ provedores
export type AiProvider = {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  /** Os 4 últimos caracteres da API Key salva. */
  key_hint: string;
  models: ProviderModel[];
  active: boolean;
  updated_at: string;
  /** Quantas regras usam este provedor. */
  routes: number;
};
export type AiLibrary = {
  providers: AiProvider[];
  routes: AiRoute[];
  /** O esforço escolhido (funcionalidade ou "skill:<id>" → nível); antes da migração 20261223090000, nada. */
  efforts?: Record<string, string>;
};
/** O esforço de uma funcionalidade ou skill ("skill:<id>"); nulo volta ao automático. */
export const setAiEffort = (company: string, key: string, effort: string | null) =>
  rpc("ai_set_effort", { p_company: company, p_key: key, p_effort: effort });
export const providerLibrary = (company: string) =>
  rpc<AiLibrary>("ai_provider_list", { p_company: company });
export const setProviderActive = (
  company: string,
  id: string,
  active: boolean,
) =>
  rpc("ai_set_provider_active", {
    p_company: company,
    p_id: id,
    p_active: active,
  });
export const deleteProvider = (company: string, id: string) =>
  rpc("ai_delete_provider", { p_company: company, p_id: id });
/** Uma regra; provider nulo tira a regra (numa funcionalidade, id é o nome dela). */
export const setAiRoute = (
  company: string,
  type: RouteScope,
  id: string | null,
  provider: string | null,
  model: string | null,
) =>
  rpc("ai_set_route", {
    p_company: company,
    p_type: type,
    // Na regra de uma funcionalidade, o id é o nome dela.
    p_id: type === "feature" ? null : id,
    p_provider: provider,
    p_model: model,
    ...(type === "feature" ? { p_feature: id } : {}),
  });

/** Ações que passam pelo servidor (a chave é selada lá, nunca no navegador). */
export async function providerAction<T>(body: Record<string, unknown>): Promise<T> {
  const t = await token();
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Error(data.error ?? "Não foi possível falar com o servidor.");
  return data as T;
}
/** O padrão do servidor de cada funcionalidade (só os nomes dos modelos). */
export type ServerDefaults = {
  claudeKey: boolean;
  /** A transcrição e os vetores sem regra usam a OPENAI_API_KEY. */
  openaiKey?: boolean;
  features: Partial<Record<AiFeature, { model: string; env: string }>>;
  /** Os vetores da MAVI (busca e RAG): só para leitura. */
  embedding?: { model: string; env: string };
};
export const serverDefaults = () =>
  providerAction<ServerDefaults>({ action: "ai-provider-defaults" });
export type ProviderDraft = {
  id?: string;
  name: string;
  kind: ProviderKind;
  base_url?: string;
  /** Vazio numa alteração: mantém a chave salva. */
  api_key?: string;
  models: ProviderModel[];
  active?: boolean;
};
export const saveProvider = (company: string, draft: ProviderDraft) =>
  providerAction<{ id: string }>({
    action: "ai-provider-save",
    company,
    ...draft,
  });
export type ListedModel = {
  id: string;
  label?: string;
  input?: number;
  output?: number;
};
/** Os modelos que a chave enxerga (a informada ou a salva do provedor). */
export const fetchProviderModels = (
  company: string,
  args: {
    id?: string;
    kind: ProviderKind;
    base_url?: string;
    api_key?: string;
  },
) =>
  providerAction<{ models: ListedModel[] }>({
    action: "ai-provider-models",
    company,
    ...args,
  });
export const testProvider = (
  company: string,
  args: {
    id?: string;
    kind: ProviderKind;
    base_url?: string;
    api_key?: string;
    model: string;
  },
) =>
  providerAction<{ ok: boolean; ms: number; reply: string }>({
    action: "ai-provider-test",
    company,
    ...args,
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
  if (s.type === "web") {
    try {
      return new URL(s.url ?? s.id).hostname.replace(/^www\./, "");
    } catch {
      return "Internet";
    }
  }
  if (s.type === "meeting")
    return [
      `Reunião ${shortDate(s.date)}`,
      s.start != null ? clock(s.start) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  if (s.type === "file") return s.label ? `Arquivo · ${s.label}` : "Arquivo";
  if (s.type === "attachment") return s.label ? `Anexo · ${s.label}` : "Anexo";
  if (s.type === "social") return "Social Leads";
  if (s.type === "campaign") return "Campanha";
  if (s.type === "case") return "Case de sucesso";
  if (s.type === "whatsapp")
    return [
      `Whatsapp ${shortDate(s.date)}`,
      s.date
        ? new Date(s.date).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "America/Sao_Paulo",
          })
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return "Tarefa";
}

/** O endereço (dentro da empresa aberta) que mostra uma fonte citada. */
export function sourceUrl(s: AiSource) {
  const company = routeParts(window.location.pathname).company;
  // O anexo abre pelo link assinado (openAiSource).
  if (s.type === "attachment") return "#";
  if (s.type === "task") return taskUrl({ id: s.id, title: s.title }, company);
  const q = new URLSearchParams();
  let page: "drive" | "onboarding" | "campaigns" | "cases" = "drive";
  if (s.type === "meeting") {
    q.set("gravacao", s.id);
    if (s.start && s.start > 0) q.set("t", String(Math.floor(s.start)));
  } else if (s.type === "file") q.set("arquivo", s.id);
  else if (s.type === "social") {
    page = "onboarding";
    if (s.contract_id) q.set("contrato", s.contract_id);
  } else if (s.type === "whatsapp") {
    if (s.group) q.set("whatsapp", s.group);
    q.set("msg", s.id);
  } else if (s.type === "case") {
    page = "cases";
    q.set("caso", s.id);
  } else {
    page = "campaigns";
    q.set("campanha", s.id);
  }
  const query = q.toString();
  return pageUrl(page, company) + (query ? `?${query}` : "");
}

/** Abre uma fonte citada no lugar dela. */
export function openAiSource(s: AiSource) {
  // O anexo abre o arquivo (link assinado de 10 minutos).
  if (s.type === "attachment") {
    // A aba abre já no clique (o link chega depois, sem bloqueio de pop-up).
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    void attachmentUrl(s.id)
      .then((url) => {
        if (tab) tab.location.href = url;
        else window.open(url, "_blank", "noopener,noreferrer");
      })
      .catch(() => tab?.close());
    return;
  }
  // Uma página da internet abre fora do sistema.
  if (s.type === "web") {
    const url = s.url ?? s.id;
    if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  navigate(sourceUrl(s));
}

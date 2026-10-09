import { rpc } from "./api";
import { supabase } from "./supabase";

/**
 * Agente Conversacional › Agentes MAVI (api/_agent-builder.ts): os agentes
 * que rodam no motor próprio (mavi-agentes). O navegador fala só com /api/ai;
 * o servidor confere a regra do Drive e chama o motor com a chave dele.
 */

export type KnowledgeKind = "faq" | "product" | "document" | "media" | "example" | "text";

export type BuilderAgent = {
  id: string;
  company_id: string;
  name: string;
  origin: "mavi_tasks" | "makecrm";
  status: "active" | "paused";
  external_ref: { mavi_client_id?: string; mavi_contract_id?: string; client_code?: number };
  published_version: number | null;
  draft_updated_at: string;
  created_at: string;
  updated_at: string;
  bindings?: number;
};

/** O rascunho é o JSON da especificação (mavi-agent/v1), editado por partes. */
export type AgentDraft = Record<string, any>;
export type DraftError = { path: string; message: string };
export type DraftValidation = { valid: boolean; errors: DraftError[] };

export type AgentBinding = {
  id: string;
  inbox_id: string;
  inbox_name: string;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
};

export type AgentDetail = {
  agent: BuilderAgent & { draft: AgentDraft; draft_updated_by: string | null };
  draft_validation: DraftValidation;
  published: { version: number; spec: AgentDraft; note: string; published_by: string | null; created_at: string } | null;
  bindings: AgentBinding[];
  can_edit: boolean;
};

export type AgentVersion = {
  version: number;
  note: string;
  restored_from: number | null;
  published_by: string | null;
  created_at: string;
};

export type KnowledgeItem = {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body_preview: string;
  body_length: number;
  data: Record<string, any>;
  source: { type?: string; url?: string; filename?: string; mime?: string; size?: number };
  status: "pending" | "processing" | "ready" | "error";
  error: string | null;
  chunk_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
export type KnowledgeTotals = { total: number; ready: number; errors: number; processing: number; chunks: number };

export type SearchResult = {
  chunk_id: string;
  item_id: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  context: string;
  score: number;
  vector_rank: number | null;
  keyword_rank: number | null;
};

export type MakecrmInbox = {
  id: string;
  name: string;
  type_id: number;
  status: boolean;
  kind: "whatsapp_uazapi" | "whatsapp_business_api";
  bound_agent: { id: string; name: string } | null;
};

export type ReplyMessage = { text: string; media: string[] };
export type TurnTrace = {
  id: string;
  status: "done" | "silent" | "error" | "skipped";
  model: string | null;
  rounds: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_usd: string | number;
  timings: Record<string, number>;
  tools: { name: string; args?: unknown; result: string; ms: number }[];
  retrieved: { ref: string; kind: string; title: string; score: number; via: string }[];
  output: { messages: ReplyMessage[]; silent_reason: string | null; handoff: string | null } | null;
  /** O lead escreveu antes do envio: descartada e refeita junto com a nova. */
  superseded?: boolean;
  /** O lead escreveu no meio do envio: parou de mandar o resto. */
  interrupted?: boolean;
  error: string | null;
  created_at: string;
  simulation?: boolean;
  agent_version?: number | null;
  external_id?: string;
  contact_name?: string | null;
  phone?: string | null;
  messages?: ReplyMessage[] | null;
};
export type SimulateResult = {
  conversation_id: string;
  result: {
    status: TurnTrace["status"];
    messages: ReplyMessage[];
    attachments: Record<string, { url: string; mime: string; title: string }>;
    silentReason?: string;
    handoff?: string;
    error?: string;
  };
  turn: TurnTrace | null;
};
export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "note";
  content: string;
  content_type: string;
  media: unknown;
  turn_id: string | null;
  created_at: string;
};
export type UsageDay = {
  day: string;
  simulation: boolean;
  turns: number;
  errors: number;
  tokens_in: string | number;
  tokens_out: string | number;
  tokens_cached: string | number;
  cost_usd: string | number;
};
export type AgentConversation = {
  id: string;
  external_id: string;
  phone: string | null;
  contact_name: string | null;
  facts: Record<string, string>;
  summary: string;
  last_inbound_at: string | null;
  last_reply_at: string | null;
  created_at: string;
};

export class BuilderError extends Error {
  constructor(
    message: string,
    readonly details: DraftError[] = [],
  ) {
    super(message);
  }
}

// Sem banco (demonstração): os dados de exemplo, carregados só então.
const demo = () => (supabase ? null : import("./agent-builder-demo"));

async function server<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new BuilderError("Supabase não configurado");
  const call = async () => {
    const token = (await supabase!.auth.getSession()).data.session?.access_token;
    return fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  };
  let res = await call();
  if (res.status === 401) {
    await supabase.auth.refreshSession();
    res = await call();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new BuilderError(data.error ?? "Não foi possível falar com o servidor.", Array.isArray(data.details) ? data.details : []);
  return data as T;
}

export const listBuilderAgents = (company: string, client?: string | null) =>
  demo()?.then((m) => m.demoList()) ??
  server<{ agents: BuilderAgent[]; leader: boolean; configured: boolean }>({ action: "builder-list", company, client: client ?? null });

export const createBuilderAgent = (company: string, input: { client: string; contract: string; name: string }) =>
  demo()?.then((m) => m.demoCreate(input)) ?? server<{ agent: BuilderAgent }>({ action: "builder-create", company, ...input });

/** Uma operação num agente (ver OPS em api/_agent-builder.ts). */
export function agentOp<T>(company: string, agent: string, op: string, extra: Record<string, unknown> = {}): Promise<T> {
  return (
    (demo()?.then((m) => m.demoOp(agent, op, extra)) as Promise<T> | undefined) ??
    server<T>({ action: "builder-agent", company, agent, op, ...extra })
  );
}

// ------------------------------------------------------------ modelos e chaves
/** Painel da MAVI › Agentes MAVI: um modelo de conversa cadastrado num provedor. */
export type AgentModel = {
  /** "<provedor_id>|<modelo>" (o que o Painel guarda). */
  key: string;
  /** "<tipo>:<modelo>" (o que vai para o motor). */
  ref: string;
  provider_id: string;
  provider_name: string;
  kind: string;
  model: string;
  label: string;
  input: number | null;
  output: number | null;
  cached: number | null;
  allowed: boolean;
};
export type AgentModels = {
  can_edit: boolean;
  default: string | null;
  fallback: string | null;
  updated_at: string | null;
  models: AgentModel[];
};

export const agentModels = (company: string) =>
  demo()?.then((m) => m.demoModels()) ?? (rpc("agent_models", { p_company: company }) as Promise<AgentModels>);
export const setAgentModels = (company: string, models: string[], def: string | null, fallback: string | null) =>
  demo()?.then(() => undefined) ??
  (rpc("agent_models_set", { p_company: company, p_models: models, p_default: def, p_fallback: fallback }) as Promise<void>);

export const PROVIDER_LABEL: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  google: "Google (Gemini)",
  deepseek: "DeepSeek",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI (Grok)",
};
/** O tipo do provedor de uma referência ("openrouter:openai/gpt-5.2" → openrouter; antigo com "/" → openrouter). */
export function refKind(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const i = ref.indexOf(":");
  if (i > 0 && ref.slice(0, i) in PROVIDER_LABEL) return ref.slice(0, i);
  return ref.includes("/") ? "openrouter" : "openai";
}
export const priceText = (m: Pick<AgentModel, "input" | "output">) =>
  m.input != null && m.output != null
    ? `US$ ${Number(m.input).toLocaleString("pt-BR")} / ${Number(m.output).toLocaleString("pt-BR")} por milhão de tokens (entrada/saída)`
    : "preço não informado no Painel";

export type AgentSecret = {
  provider: string;
  key_hint: string;
  checked_at: string | null;
  check_ok: boolean | null;
  check_error: string | null;
  updated_by: string | null;
  updated_at: string;
};
export type AgentSecrets = { secrets: AgentSecret[]; server_providers: string[] };

// ------------------------------------------------------------ a MAVI monta o agente
export type MaviQuestion = { text: string; options: string[]; multiple: boolean };
export type MaviField = { path: string; label: string; before: string; after: string; value: unknown; why: string };
export type MaviKnowledge = {
  kind: "faq" | "product" | "text" | "example" | "document" | "file";
  title: string;
  preview: string;
  why: string;
  item: Record<string, unknown>;
  file?: string;
};
export type MaviProposal = { summary: string; fields: MaviField[]; knowledge: MaviKnowledge[]; skipped: string[] };
export type MaviReply = { message: string; questions: MaviQuestion[]; proposal: MaviProposal | null; files: string[]; model?: string };

/** Uma vez da conversa com a MAVI (api/_agent-builder-mavi.ts). */
export const askBuilderMavi = (input: {
  company: string;
  agent: string;
  messages: { role: "user" | "assistant"; content: string }[];
  draft: AgentDraft;
  attachments: { name: string; mime: string; data: string }[];
  files: string[];
}) => demo()?.then((m) => m.demoMavi(input.messages)) ?? server<MaviReply>({ action: "builder-mavi", ...input });

/** O arquivo em base64 (para mandar à MAVI na conversa). */
export const fileBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Não consegui ler o arquivo."));
    r.readAsDataURL(file);
  });

/** Envia o arquivo direto ao armazenamento do motor e registra o item. */
export async function uploadKnowledgeFile(
  company: string,
  agent: string,
  file: File,
  opts: { kind: "document" | "media"; title?: string; description?: string },
): Promise<{ id: string }> {
  const mime = file.type || guessMime(file.name);
  const link = await agentOp<{ item_id: string; storage_path: string; upload_url: string }>(company, agent, "upload-url", {
    kind: opts.kind,
    filename: file.name,
    mime,
    size: file.size,
  });
  if (link.upload_url) {
    const put = await fetch(link.upload_url, { method: "PUT", headers: { "Content-Type": mime }, body: file });
    if (!put.ok) throw new BuilderError("Não foi possível enviar o arquivo. Tente de novo.");
  }
  return agentOp<{ id: string }>(company, agent, "uploaded", {
    item_id: link.item_id,
    storage_path: link.storage_path,
    kind: opts.kind,
    filename: file.name,
    mime,
    title: opts.title ?? "",
    description: opts.description ?? "",
  });
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};
export const guessMime = (name: string) => MIME[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";

// ------------------------------------------------------------ rascunho

/** Lê um campo do rascunho pelo caminho ("persona.name"). */
export function draftGet(draft: AgentDraft, path: string): any {
  return path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), draft);
}

/** Troca um campo sem mexer no resto (cópia rasa por nível). */
export function draftSet(draft: AgentDraft, path: string, value: unknown): AgentDraft {
  const keys = path.split(".");
  const next: AgentDraft = { ...draft };
  let cur: any = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    cur[k] = cur[k] && typeof cur[k] === "object" && !Array.isArray(cur[k]) ? { ...cur[k] } : {};
    cur = cur[k];
  }
  const last = keys[keys.length - 1]!;
  if (value === undefined || value === "" || (Array.isArray(value) && !value.length && !REQUIRED_LISTS.has(path))) delete cur[last];
  else cur[last] = value;
  return next;
}
const REQUIRED_LISTS = new Set<string>();

/** Linhas de uma lista (regras, "nunca", campos do contato). */
export const linesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);

/** Planilha simples (CSV com ; ou ,) para importar FAQ e produtos. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0]!.match(/;/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0) ? ";" : ",";
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const norm = (h: string) =>
    h
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  const head = split(lines[0]!).map(norm);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
}

/** Linhas da planilha → itens (FAQ: pergunta/resposta; produto: nome/preço/categoria/descrição + o resto como atributos). */
export function csvToItems(rows: Record<string, string>[], kind: "faq" | "product") {
  if (kind === "faq") {
    return rows
      .map((r) => ({ q: r.pergunta ?? r.question ?? "", a: r.resposta ?? r.answer ?? "" }))
      .filter((r) => r.q && r.a)
      .map((r) => ({ kind: "faq", data: { question: r.q, answer: r.a } }));
  }
  const known = new Set(["nome", "name", "produto", "preco", "price", "valor", "categoria", "category", "descricao", "description", "codigo", "sku"]);
  return rows
    .map((r) => {
      const name = r.nome ?? r.name ?? r.produto ?? "";
      const attributes = Object.fromEntries(Object.entries(r).filter(([k, v]) => !known.has(k) && v));
      return {
        kind: "product",
        data: {
          name,
          price: r.preco ?? r.price ?? r.valor ?? "",
          category: r.categoria ?? r.category ?? "",
          description: r.descricao ?? r.description ?? "",
          sku: r.codigo ?? r.sku ?? "",
          ...(Object.keys(attributes).length ? { attributes } : {}),
        },
      };
    })
    .filter((i) => i.data.name);
}

export const KIND_LABEL: Record<KnowledgeKind, string> = {
  faq: "Pergunta e resposta",
  product: "Produto",
  document: "Documento",
  media: "Mídia",
  example: "Exemplo de conversa",
  text: "Texto",
};

export const usd = (v: string | number | null | undefined) =>
  `US$ ${Number(v ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;

/** Data e hora de Brasília. */
export const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Sao_Paulo",
      })
    : "—";
export const errorOf = (e: unknown) => (e as Error)?.message ?? "Algo deu errado.";

// ------------------------------------------------------------ lacunas e insights
/** Um tema de lacuna: perguntas/objeções parecidas que o treinamento não cobria. */
export type GapTopic = {
  id: string;
  kind: "question" | "objection";
  title: string;
  title_source: "first" | "mavi" | "person";
  category: string;
  status: "open" | "trained" | "ignored";
  occurrences: number;
  conversations: number;
  after_trained: number;
  first_seen_at: string;
  last_seen_at: string;
  trained_at: string | null;
  trained_by: string | null;
  knowledge_item_id: string | null;
  has_suggestion: boolean;
  in_period: number;
  in_previous: number;
  conversations_in_period: number;
};
export type GapStats = { turns: number; gap_turns: number; gaps: number; new_topics: number; coverage: number | null };
export type GapsResult = {
  period: { from: string; to: string };
  previous: { from: string; to: string };
  topics: GapTopic[];
  stats: GapStats;
  previous_stats: GapStats;
  pending: number;
};
export type GapSuggestion = { question: string; answer: string; note: string; sources: string[]; model: string; generated_at: string };
export type GapExample = {
  id: string;
  text: string;
  lead_text: string;
  created_at: string;
  conversation_id: string;
  external_id: string;
  contact_name: string | null;
  phone: string | null;
};
export type GapDetail = {
  topic: GapTopic & { suggestion: GapSuggestion | null };
  examples: GapExample[];
  similar: { id: string; title: string; kind: GapTopic["kind"]; status: GapTopic["status"]; occurrences: number; similarity: number | null }[];
};

export type Outcome = "scheduled" | "purchased" | "qualified" | "handed_off" | "in_progress" | "not_interested" | "ghosted" | "disqualified" | "other";
export type AgentIssue = { type: string; detail: string };
export type InsightMetrics = {
  conversations: number;
  new_conversations: number;
  lead_messages: number;
  agent_messages: number;
  followup_messages: number;
  followup_recovered: number;
  turns: number;
  errors: number;
  handoffs: number;
  meetings: number;
  reply_ms_p50: number | null;
  cost_usd: number;
  insights_cost_usd: number;
};
type Counted = { label: string; n: number; conversations?: string[] };
export type AgentReport = {
  period: { from: string; to: string };
  previous: { from: string; to: string };
  days: number;
  sample_percent: number;
  metrics: InsightMetrics;
  previous_metrics: InsightMetrics;
  series: {
    days: { day: string; conversations: number; lead_messages: number; handoffs: number; meetings: number }[];
    hours: { hour: number; lead_messages: number }[];
  };
  insights: {
    analyzed: number;
    outcomes: { outcome: Outcome; n: number }[];
    sentiment: { sentiment: "positive" | "neutral" | "negative"; n: number }[];
    reasons: Counted[];
    objections: Counted[];
    topics: Counted[];
    issues: { type: string; n: number; examples: { conversation_id: string; detail: string }[] }[];
  };
  previous_insights: { analyzed: number; outcomes: { outcome: Outcome; n: number }[] };
  look_at: {
    conversation_id: string;
    external_id: string;
    contact_name: string | null;
    phone: string | null;
    outcome: Outcome;
    sentiment: string;
    summary: string;
    agent_issues: AgentIssue[];
    activity_at: string;
  }[];
  gaps: GapStats & { top: { id: string; kind: GapTopic["kind"]; title: string; category: string; in_period: number; occurrences: number }[] };
  previous_gaps: GapStats;
};
export type AgentReading = {
  reading: {
    summary: string;
    points: { kind: "good" | "attention" | "action"; title: string; text: string; conversations: string[] }[];
  };
  model: string | null;
  created_by: string | null;
  created_at: string;
};
export type InsightConversation = {
  conversation_id: string;
  external_id: string;
  contact_name: string | null;
  phone: string | null;
  intent: string;
  outcome: Outcome;
  outcome_reason: string;
  reason_label: string;
  sentiment: "positive" | "neutral" | "negative";
  objections: string[];
  topics: string[];
  agent_issues: AgentIssue[];
  summary: string;
  lead_messages: number;
  activity_at: string;
};
export type ConversationInsight = {
  conversation: AgentConversation;
  insight: (Omit<InsightConversation, "external_id" | "contact_name" | "phone"> & { analyzed_at: string }) | null;
  gaps: { id: string; kind: GapTopic["kind"]; text: string; created_at: string; topic_id: string | null; topic_title: string | null; topic_status: string | null }[];
};
export type InsightsSettings = {
  sample_percent: number;
  can_edit: boolean;
  weekly: {
    weekly: boolean;
    custom: boolean;
    recipients: string[];
    candidates: { id: string; name: string; email: string }[];
    last_sent: string | null;
  };
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  scheduled: "Agendou",
  purchased: "Comprou",
  qualified: "Interessado, sem compromisso",
  handed_off: "Passou para a equipe",
  in_progress: "Em andamento",
  not_interested: "Sem interesse",
  ghosted: "Parou de responder",
  disqualified: "Fora do perfil",
  other: "Outro",
};
/** Bons, neutros e perdidos (a cor das barras). */
export const OUTCOME_TONE: Record<Outcome, "good" | "neutral" | "bad"> = {
  scheduled: "good",
  purchased: "good",
  qualified: "good",
  handed_off: "neutral",
  in_progress: "neutral",
  other: "neutral",
  not_interested: "bad",
  ghosted: "bad",
  disqualified: "bad",
};
export const SENTIMENT_LABEL: Record<string, string> = { positive: "Positivo", neutral: "Neutro", negative: "Negativo" };
export const ISSUE_LABEL: Record<string, string> = {
  wrong_info: "Informação errada",
  ignored_question: "Pergunta sem resposta",
  repetition: "Repetição",
  overpromise: "Prometeu demais",
  tone: "Tom inadequado",
  missed_handoff: "Não passou para a equipe",
  other: "Outra falha",
};
export const OBJECTION_CATEGORY_LABEL: Record<string, string> = {
  preco: "Preço",
  prazo: "Prazo",
  confianca: "Confiança",
  concorrente: "Concorrente",
  momento: "Momento",
  decisor: "Decisor",
  necessidade: "Necessidade",
  outro: "Outra",
};

/** "AAAA-MM-DD" de hoje − n dias, em Brasília. */
export function ymdDaysAgo(n: number, now = new Date()): string {
  const sp = new Date(now.getTime() - 3 * 3600_000 - n * 86_400_000);
  return sp.toISOString().slice(0, 10);
}
/** Os últimos n dias (hoje incluído). */
export const lastDays = (n: number, now = new Date()) => ({ from: ymdDaysAgo(n - 1, now), to: ymdDaysAgo(0, now) });
export const dayMonth = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
/** Variação em relação ao período anterior: "+12%", "−5%", "novo" ou "". */
export function deltaText(cur: number, prev: number): string {
  if (!prev) return cur ? "novo" : "";
  const d = Math.round(((cur - prev) / prev) * 100);
  return d === 0 ? "=" : `${d > 0 ? "+" : "−"}${Math.abs(d)}%`;
}
export const percent = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

// ------------------------------------------------------------ custos
export type CostSum = { events: number; cost_usd: number; cost_brl: number; tokens_in: number; tokens_out: number; units: number; conversations?: number };
export type CostGroupKey = "ia" | "midias" | "conhecimento" | "analises" | "whatsapp" | "testes";
export type CostReport = {
  totals: CostSum | null;
  rows: (CostSum & { key: string; label: string | null })[];
  daily: { day: string; group: CostGroupKey; cost_usd: number; cost_brl: number }[];
  messages: { lead_messages: number; agent_messages: number; conversations: number } | null;
  rates: Record<string, number>;
  agents?: { id: string; name: string; client_id: string | null; contract_id: string | null }[];
};
export type CostFilters = {
  from: string;
  to: string;
  group: "day" | "agent" | "inbox" | "conversation" | "source" | "group" | "model" | "company";
  sources?: string[];
  inbox_ids?: string[];
  simulation?: "exclude" | "include" | "only";
  clients?: string[];
  agents?: string[];
  conversation?: string;
};
export type CostEvent = {
  id: string;
  message_id: string | null;
  turn_id: string | null;
  source: string;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  units: number;
  cost_usd: number;
  meta: Record<string, unknown>;
  created_at: string;
};
export type WabaPrice = { country: string; category: "marketing" | "utility" | "authentication"; price_usd: number; updated_by?: string | null; updated_at?: string };

export const builderCosts = (company: string, f: CostFilters) =>
  (demo()?.then((m) => m.demoCostsAll(f)) as Promise<CostReport & { leader?: boolean }> | undefined) ??
  server<CostReport & { leader?: boolean }>({ action: "builder-costs", company, ...f });
export const wabaPrices = (company: string, prices?: WabaPrice[]) =>
  (demo()?.then((m) => m.demoWabaPrices(prices)) as Promise<{ prices: WabaPrice[]; can_edit: boolean }> | undefined) ??
  server<{ prices: WabaPrice[]; can_edit: boolean }>({ action: "builder-waba-prices", company, ...(prices ? { prices } : {}) });

export const COST_SOURCE_LABEL: Record<string, string> = {
  reply: "Respostas da IA",
  followup: "Follow-up (IA)",
  media_audio: "Áudios (transcrição)",
  media_image: "Imagens (leitura)",
  media_video: "Vídeos (fala)",
  media_document: "Documentos",
  retrieval: "Busca no conhecimento",
  summary: "Resumo da conversa",
  knowledge: "Processar o conhecimento",
  gaps: "Lacunas",
  insight: "Leitura das conversas",
  reading: "Leitura da MAVI",
  waba_template: "WhatsApp oficial (modelos aprovados)",
  test_persona: "Testes: perfis",
  test_lead: "Testes: lead simulado",
  test_judge: "Testes: avaliação",
};
export const COST_GROUPS: { key: CostGroupKey; label: string; sources: string[] }[] = [
  { key: "ia", label: "IA nas conversas", sources: ["reply", "followup"] },
  { key: "midias", label: "Mídias", sources: ["media_audio", "media_image", "media_video", "media_document"] },
  { key: "conhecimento", label: "Conhecimento", sources: ["retrieval", "knowledge"] },
  { key: "analises", label: "Análises da MAVI", sources: ["summary", "gaps", "insight", "reading"] },
  { key: "whatsapp", label: "WhatsApp oficial", sources: ["waba_template"] },
  { key: "testes", label: "Testes", sources: ["test_persona", "test_lead", "test_judge"] },
];
export const COST_GROUP_LABEL = Object.fromEntries(COST_GROUPS.map((g) => [g.key, g.label])) as Record<CostGroupKey, string>;

/** Dinheiro: até 4 casas para valores pequenos (custos de IA são frações de centavo). */
export function money(v: number | null | undefined, currency: "usd" | "brl"): string {
  const n = Number(v ?? 0);
  const digits = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 2 : 4;
  return `${currency === "usd" ? "US$" : "R$"} ${n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
/** A cotação de um dia (a do dia ou a última antes dele). */
export function rateOn(rates: Record<string, number>, day: string): number | null {
  const keys = Object.keys(rates).sort();
  const before = keys.filter((k) => k <= day);
  const k = before.length ? before[before.length - 1] : keys[0];
  return k ? rates[k]! : null;
}

// ------------------------------------------------------------ testes com leads simulados
export type TestProfile = { key: string; label: string; hint: string };
export type TestPersona = { nome: string; perfil: string; descricao: string; objetivo: string; conhece: string; objecoes: string[]; estilo: string; fim_quando: string };
export type TestVerdict = {
  score: number;
  goal_reached: boolean;
  outcome: Outcome;
  issues: { type: string; severity: number; detail: string; quote: string }[];
  gaps: { kind: "question" | "objection"; text: string }[];
  strengths: string[];
  summary: string;
};
export type TestSummary = {
  conversations: number;
  evaluated: number;
  errors: number;
  score: number | null;
  goal_rate: number | null;
  outcomes: Record<string, number>;
  issues: Record<string, { n: number; examples: string[] }>;
  gaps: number;
  severe: number;
  conclusion?: string;
  actions?: { title: string; text: string; where: string }[];
  concluding?: boolean;
};
export type TestRun = {
  id: string;
  kind: "manual" | "publish" | "scheduled";
  agent_version: number | null;
  compare_to: string | null;
  profiles: string[];
  focus: string;
  conversations: number;
  max_turns: number;
  cost_cap_usd: number;
  cost_usd: number;
  status: "queued" | "running" | "done" | "stopped" | "error";
  stop_reason: string | null;
  summary: TestSummary | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
  finished?: number;
};
export type TestConversation = {
  id: string;
  idx: number;
  persona: TestPersona;
  conversation_id: string | null;
  status: "queued" | "running" | "done" | "error" | "skipped";
  turns: number;
  verdict: TestVerdict | null;
  cost_usd: number;
  error: string | null;
};
export type TestLimits = {
  max_conversations: number;
  max_turns: number;
  run_cap_usd: number;
  monthly_cap_usd: number;
  publish_conversations: number;
  scheduled_enabled: boolean;
  scheduled_every_days: number;
  scheduled_conversations: number;
  can_edit?: boolean;
  updated_at?: string | null;
};
export type TestRunsResult = { runs: TestRun[]; month_cost_usd: number; limits: TestLimits; profiles: TestProfile[] };

export const testSettings = (company: string, settings?: Omit<TestLimits, "can_edit" | "updated_at">) =>
  (demo()?.then((m) => m.demoTestSettings(settings)) as Promise<TestLimits> | undefined) ??
  server<TestLimits>({ action: "builder-test-settings", company, ...(settings ? { settings } : {}) });

export const TEST_ISSUE_LABEL: Record<string, string> = { ...ISSUE_LABEL, rule_violation: "Quebrou uma regra", off_script: "Saiu do roteiro" };
export const TEST_KIND_LABEL: Record<TestRun["kind"], string> = { manual: "Sob demanda", publish: "Antes de publicar", scheduled: "Periódica" };
export const TEST_STATUS_LABEL: Record<TestRun["status"], string> = {
  queued: "Na fila",
  running: "Rodando",
  done: "Concluída",
  stopped: "Parada",
  error: "Falhou",
};

import { supabase } from "./supabase";
import { canCreateTaskIn } from "./domain";
import { serializeDescription, type RichNode } from "./rich-text";
import { appPath } from "./temperature";
import type { FormPreset } from "./forms";
import type { Snapshot } from "./types";

/**
 * Campanhas › Insights da MAVI (migração 20270327090000_campaign_insights):
 * os tipos, a leitura e os textos das telas (painel ao lado da campanha, aba
 * Insights, selo na lista e o Painel da MAVI › Campanhas). A análise é feita
 * no servidor (api/_campaign-insights.ts); aqui só se lê e se pede.
 */

export type InsightKind = "highlight" | "opportunity" | "problem" | "tracking";
export type InsightPriority = "high" | "medium" | "low";
export type MoneyBasis = "net" | "gross";
export type InsightWindow = "cycle" | "d7" | "d15" | "d30" | "since_last";
export type InsightUnit = "money" | "count" | "pct" | "ratio" | "days";
export type InsightLevel =
  | "total"
  | "campaign"
  | "adset"
  | "ad"
  | "keyword"
  | "search_term"
  | "segment"
  | "utm";

export type InsightEvidence = {
  label: string;
  value: number;
  unit: InsightUnit;
  window: InsightWindow;
  entity: string;
  name: string;
  metric: string;
};
export type CampaignInsight = {
  id: string;
  run_id: string;
  last_seen_run: string;
  kind: InsightKind;
  priority: InsightPriority;
  title: string;
  body: string;
  action: string;
  evidence: InsightEvidence[];
  target: { key: string; level: InsightLevel; name: string; parent?: string } | null;
  source: "rule" | "mavi";
  money_basis: MoneyBasis;
  confidence: number | null;
  status: InsightStatus;
  seen_count: number;
  last_seen_at: string;
  created_at: string;
  status_at?: string | null;
  status_reason?: string | null;
  status_by_name?: string | null;
  snooze_until?: string | null;
  applied_at?: string | null;
  /** Antes × depois (os aplicados). */
  effect?: InsightEffect | null;
  effect_at?: string | null;
  my_vote?: "up" | "down" | null;
  votes?: { up: number; down: number };
  tasks?: { id: string; title: string; status: string; due_date: string | null; assignee_name: string | null }[];
};
/** expired: aberto sem uso pelo prazo do Painel da MAVI (padrão 15 dias) (sai da tela; no histórico, só a contagem). */
export type InsightStatus = "new" | "applied" | "dismissed" | "snoozed" | "expired";
export type InsightEffect = {
  days: number;
  before: Record<string, number | null>;
  after: Record<string, number | null>;
  change: { cpa: number | null; results_per_day: number | null; ctr: number | null };
  verdict: "better" | "worse" | "neutral";
  money_basis?: MoneyBasis;
};
/** Os motivos do descarte (e do 👎). */
export const DISMISS_REASONS: { id: string; label: string }[] = [
  { id: "wrong", label: "Os números não mostram isso" },
  { id: "not_actionable", label: "Não dá para aplicar" },
  { id: "known", label: "Já sabíamos ou já fazemos" },
  { id: "client", label: "Restrição do cliente (verba, estoque, prazo…)" },
  { id: "timing", label: "Não é o momento" },
  { id: "other", label: "Outro motivo" },
];
export type InsightRunStatus = "queued" | "running" | "done" | "skipped" | "failed";
export type InsightRun = {
  id: string;
  trigger: "schedule" | "manual";
  status: InsightRunStatus;
  requested_by_name: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number;
  model: string;
  provider_name: string;
  summary: string;
  note: string;
  money_basis: MoneyBasis | null;
  multiplier: number | null;
  windows: Partial<Record<InsightWindow, { since: string; until: string }>>;
  insights_count: number;
  repeated_count: number;
  /** Quantos desta análise expiraram sem uso (não aparecem mais). */
  expired_count?: number;
  /** Chamadas às APIs ({meta, google}) e tokens ({input, output}) da análise. */
  api_calls: { meta?: number; google?: number };
  tokens: { input?: number; output?: number };
  insights: CampaignInsight[];
};
export type InsightFrequency = "daily" | "weekdays" | "every";
export type InsightSchedule = {
  source: "company" | "client" | "campaign";
  rule: string | null;
  enabled: boolean;
  frequency: InsightFrequency;
  weekdays: number[];
  every_days: number;
  hour: number;
};
export type CampaignInsightsView = {
  /** Ligado na empresa (o Painel da MAVI). */
  enabled: boolean;
  schedule: InsightSchedule;
  timezone: string;
  last_scheduled_day: string | null;
  places: { panel: boolean; badge: boolean; tab: boolean };
  money_basis: MoneyBasis;
  min_interval_minutes: number;
  /** Dias abertos sem uso até o insight expirar (0: nunca). */
  expire_days?: number;
  /** Por que a campanha não pode ser analisada agora (nulo: pode). */
  blocker: string | null;
  capped: boolean;
  /** Quando o "Analisar agora" libera (nulo: já pode). */
  wait_until: string | null;
  pending: {
    id: string;
    status: "queued" | "running";
    trigger: "schedule" | "manual";
    created_at: string;
    started_at: string | null;
    requested_by_name: string | null;
    /** Na fila com hora marcada: esperando a cota da plataforma (ou o orçamento do Google). */
    waiting_until: string | null;
    note: string;
  } | null;
  latest_run: string | null;
  /** Os insights abertos da última análise (e os que voltaram do "Lembrar depois"). */
  current: CampaignInsight[];
  applied?: CampaignInsight[];
  snoozed?: CampaignInsight[];
  dismissed?: CampaignInsight[];
  runs: InsightRun[];
};
export type RequestResult = { ok: boolean; reason?: string; run?: string; wait_until?: string };
export type InsightBadge = {
  campaign: string;
  open: number;
  high: number;
  medium: number;
  at: string | null;
  running: boolean;
};
export type InsightBadges = { enabled: boolean; badge: boolean; rows: InsightBadge[] };

export type InsightSettings = {
  enabled: boolean;
  frequency: InsightFrequency;
  weekdays: number[];
  every_days: number;
  hour: number;
  show_panel: boolean;
  show_badge: boolean;
  show_tab: boolean;
  mavi_context: boolean;
  notify_inbox: boolean;
  notify_min_priority: InsightPriority;
  notify_who: "team" | "team_leaders";
  money_basis: MoneyBasis;
  monthly_cap_usd: number | null;
  run_cap_usd: number;
  min_interval_minutes: number;
  /** Agendamento: só relê com ao menos N dias novos com investimento (0: sempre). */
  min_new_days: number;
  /** Google: operações do developer token por 24 h para a MAVI. */
  google_daily_ops: number;
  /** Criativos: ler as imagens, ler os vídeos (capa + áudio) e quantos novos por análise. */
  creative_images: boolean;
  creative_videos: boolean;
  creative_new_max: number;
  /** Dias abertos sem uso até o insight expirar e sair da tela (0: nunca). */
  expire_days: number;
  updated_by?: string | null;
  updated_at?: string;
};
export type InsightRule = {
  id?: string;
  client_id: string | null;
  campaign_id: string | null;
  enabled: boolean;
  frequency: InsightFrequency;
  weekdays: number[];
  every_days: number;
  hour: number;
  client_name?: string | null;
  campaign_name?: string | null;
  platform?: string | null;
  updated_at?: string;
};
export type InsightSettingsView = {
  settings: InsightSettings;
  rules: InsightRule[];
  spent_month: number;
  runs_month: number;
  campaigns: number;
  capped: boolean;
  /** Operações do Google usadas pela MAVI nas últimas 24 h. */
  google_ops_24h: number;
  /** Contas pausadas agora pela cota ('*': a plataforma inteira). */
  paused: { platform: "meta" | "google"; account_id: string; until: string; reason: string }[];
  timezone: string;
};

// ------------------------------------------------------------ textos
export const KIND_LABELS: Record<InsightKind, string> = {
  highlight: "Destaque",
  opportunity: "Oportunidade",
  problem: "Atenção",
  tracking: "Rastreamento",
};
export const PRIORITY_LABELS: Record<InsightPriority, string> = {
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};
export const WINDOW_LABELS: Record<InsightWindow, string> = {
  cycle: "ciclo",
  d7: "7 dias",
  d15: "15 dias",
  d30: "30 dias",
  since_last: "desde a última análise",
};
export const LEVEL_LABELS: Record<InsightLevel, string> = {
  total: "Campanha",
  campaign: "Campanha",
  adset: "Conjunto",
  ad: "Anúncio",
  keyword: "Palavra-chave",
  search_term: "Termo de pesquisa",
  segment: "Público",
  utm: "UTM",
};
export const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WEEKDAY_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "sem M" / "com M" e o que quer dizer (o aviso discreto dos valores). */
export const basisLabel = (b: MoneyBasis) => (b === "gross" ? "com M" : "sem M");
export const basisHint = (b: MoneyBasis) =>
  b === "gross"
    ? "Valores em R$ com M: o investimento multiplicado pelo índice de performance do ciclo, como o cliente vê."
    : "Valores em R$ sem M: o investimento real na plataforma.";

const nf = (v: number, digits = 0, max = digits) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: max });
/** O valor de uma evidência como a tela mostra. */
export function formatEvidence(e: Pick<InsightEvidence, "value" | "unit" | "metric">) {
  const v = Number(e.value);
  if (!Number.isFinite(v)) return "—";
  switch (e.unit) {
    case "money":
      return `R$ ${nf(v, 2)}`;
    case "pct":
      return `${nf(v, 0, 1)}%`;
    case "ratio":
      return /roas/.test(e.metric) ? `${nf(v, 2)}x` : nf(v, 2);
    case "days":
      return `${nf(v)} ${v === 1 ? "dia" : "dias"}`;
    default:
      return nf(v, 0, 1);
  }
}

const hourText = (h: number) => `${h}h`;
/** "Toda segunda e quinta, a partir das 8h". */
export function scheduleText(s: Pick<InsightSchedule, "enabled" | "frequency" | "weekdays" | "every_days" | "hour">) {
  if (!s.enabled) return "Desligado";
  if (s.frequency === "daily") return `Todo dia, a partir das ${hourText(s.hour)}`;
  if (s.frequency === "every") return `A cada ${s.every_days} dias, a partir das ${hourText(s.hour)}`;
  const days = [...new Set(s.weekdays)].sort((a, b) => a - b);
  if (days.length === 7) return `Todo dia, a partir das ${hourText(s.hour)}`;
  if (days.length === 5 && days.every((d) => d >= 1 && d <= 5))
    return `De segunda a sexta, a partir das ${hourText(s.hour)}`;
  const names = days.map((d) => WEEKDAY_NAMES[d]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}` : names[0];
  return `Toda ${list}, a partir das ${hourText(s.hour)}`;
}
export const SOURCE_LABELS: Record<InsightSchedule["source"], string> = {
  company: "padrão da empresa",
  client: "ajuste do cliente",
  campaign: "ajuste desta campanha",
};

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
/** O dia e a hora locais de um instante, no fuso da empresa. */
export function localParts(at: Date, timezone: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}
/**
 * O próximo dia (e a hora) da análise agendada, pela mesma regra do banco
 * (mavi_private.campaign_insight_due): nulo quando está desligada.
 */
export function nextScheduled(
  s: InsightSchedule,
  lastScheduledDay: string | null,
  now: Date,
  timezone: string,
): { day: string; hour: number } | null {
  if (!s.enabled) return null;
  const { day: today, hour } = localParts(now, timezone);
  for (let i = 0; i < 400; i++) {
    const day = addDays(today, i);
    if (i === 0 && hour >= s.hour && lastScheduledDay === today) continue;
    if (s.frequency === "every") {
      if (lastScheduledDay && dayDiff(lastScheduledDay, day) < s.every_days) continue;
    } else if (s.frequency === "weekdays" && !s.weekdays.includes(weekday(day))) continue;
    else if (lastScheduledDay && lastScheduledDay >= day) continue;
    return { day, hour: i === 0 && hour > s.hour ? hour : s.hour };
  }
  return null;
}
const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** "hoje", "amanhã", "quinta, 09/10". */
export function dayLabel(day: string, today: string) {
  const diff = dayDiff(today, day);
  if (diff === 0) return "hoje";
  if (diff === 1) return "amanhã";
  const [, m, d] = day.split("-");
  return `${WEEKDAY_NAMES[weekday(day)]}, ${d}/${m}`;
}
/** "agora há pouco", "há 12 min", "há 3 h", "ontem às 09:14", "02/10 às 09:14". */
export function whenText(at: string, now: Date, timezone: string) {
  const t = new Date(at);
  const mins = Math.round((now.getTime() - t.getTime()) / 60_000);
  if (mins < 1) return "agora há pouco";
  if (mins < 60) return `há ${mins} min`;
  if (mins < 6 * 60) return `há ${Math.floor(mins / 60)} h`;
  const time = t.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: timezone || undefined });
  const day = localParts(t, timezone).day;
  const today = localParts(now, timezone).day;
  if (day === today) return `hoje às ${time}`;
  if (dayDiff(day, today) === 1) return `ontem às ${time}`;
  const [, m, d] = day.split("-");
  return `${d}/${m} às ${time}`;
}
/** Quanto falta para liberar ("em 1 h 20 min", "em 5 min"). */
export function waitText(until: string, now: Date) {
  const mins = Math.max(Math.ceil((new Date(until).getTime() - now.getTime()) / 60_000), 1);
  if (mins < 60) return `em ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `em ${h} h${m ? ` ${m} min` : ""}`;
}
export const money = (v: number) =>
  Number(v) > 0 && Number(v) < 0.01
    ? "< US$ 0,01"
    : `US$ ${Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "9 requisições ao Meta · 15,9 mil tokens". */
export function usageText(r: Pick<InsightRun, "api_calls" | "tokens">) {
  const parts: string[] = [];
  const meta = Number(r.api_calls?.meta) || 0;
  const google = Number(r.api_calls?.google) || 0;
  if (meta) parts.push(`${meta} ${meta === 1 ? "requisição" : "requisições"} ao Meta`);
  if (google) parts.push(`${google} ${google === 1 ? "operação" : "operações"} no Google`);
  const tokens = (Number(r.tokens?.input) || 0) + (Number(r.tokens?.output) || 0);
  if (tokens)
    parts.push(
      tokens >= 1000
        ? `${(tokens / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil tokens`
        : `${tokens} tokens`,
    );
  return parts.join(" · ");
}
export const RUN_STATUS: Record<InsightRunStatus, string> = {
  queued: "Na fila",
  running: "Analisando",
  done: "Pronta",
  skipped: "Pulada",
  failed: "Falhou",
};

// ------------------------------------------------------------ leitura
export interface InsightsBackend {
  view(company: string, campaign: string): Promise<CampaignInsightsView>;
  request(company: string, campaign: string): Promise<RequestResult>;
  badges(company: string, campaigns: string[]): Promise<InsightBadges>;
  /** Aplicado / Descartado (motivo) / Lembrar depois (até) / Novo (reabrir). */
  setStatus(
    company: string,
    insight: string,
    status: InsightStatus,
    opts?: { reason?: string; comment?: string; until?: string },
  ): Promise<CampaignInsight>;
  /** 👍 / 👎 (com motivo opcional); nulo tira o voto. */
  vote(company: string, insight: string, vote: "up" | "down" | null, reason?: string, comment?: string): Promise<CampaignInsight>;
  linkTask(company: string, insight: string, task: string): Promise<void>;
  unlinkTask(company: string, insight: string, task: string): Promise<void>;
  events(company: string, insight: string): Promise<InsightEvent[]>;
}
export type InsightEvent = {
  action: "applied" | "dismissed" | "snoozed" | "reopened" | "returned" | "task" | "expired";
  reason: string;
  detail: Record<string, unknown>;
  created_at: string;
  user_name: string | null;
};
async function rpc<T>(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase!.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}
const runFrom = (r: InsightRun): InsightRun => ({
  ...r,
  cost_usd: Number(r.cost_usd) || 0,
  api_calls: r.api_calls ?? {},
  tokens: r.tokens ?? {},
  multiplier: r.multiplier === null ? null : Number(r.multiplier),
  insights: r.insights ?? [],
});
export const serverInsights: InsightsBackend = {
  async view(company, campaign) {
    const v = await rpc<CampaignInsightsView>("campaign_insights", {
      p_company: company,
      p_campaign: campaign,
      p_runs: 20,
    });
    return { ...v, runs: (v.runs ?? []).map(runFrom), current: v.current ?? [] };
  },
  request: (company, campaign) =>
    rpc<RequestResult>("request_campaign_insight", { p_company: company, p_campaign: campaign }),
  async badges(company, campaigns) {
    if (!campaigns.length) return { enabled: false, badge: false, rows: [] };
    return rpc<InsightBadges>("campaign_insight_badges", { p_company: company, p_campaigns: campaigns });
  },
  setStatus: (company, insight, status, opts = {}) =>
    rpc<CampaignInsight>("set_campaign_insight_status", {
      p_company: company,
      p_insight: insight,
      p_status: status,
      p_reason: opts.reason ?? null,
      p_comment: opts.comment ?? "",
      p_until: opts.until ?? null,
    }),
  vote: (company, insight, vote, reason, comment) =>
    rpc<CampaignInsight>("vote_campaign_insight", {
      p_company: company,
      p_insight: insight,
      p_vote: vote,
      p_reason: reason ?? null,
      p_comment: comment ?? "",
    }),
  linkTask: (company, insight, task) =>
    rpc<void>("link_campaign_insight_task", { p_company: company, p_insight: insight, p_task: task }),
  unlinkTask: (company, insight, task) =>
    rpc<void>("unlink_campaign_insight_task", { p_company: company, p_insight: insight, p_task: task }),
  events: (company, insight) => rpc<InsightEvent[]>("campaign_insight_events", { p_company: company, p_insight: insight }),
};

// ------------------------------------------------------------ aprendizados do time (líderes)
export type InsightLesson = {
  id: string;
  scope: "company" | "product" | "client";
  client_id: string | null;
  product_id: string | null;
  client_name: string | null;
  product_name: string | null;
  kind: InsightKind | null;
  text: string;
  status: "active" | "candidate" | "paused" | "dismissed";
  origin: "mavi" | "person";
  people: number;
  has_leader: boolean;
  ups: number;
  downs: number;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};
export type LessonsView = { lessons: InsightLesson[]; pending: number; feedback_30d: number };
export async function loadInsightLessons(company: string) {
  if (offline(company)) return { lessons: [], pending: 0, feedback_30d: 0 } as LessonsView;
  return rpc<LessonsView>("campaign_insight_lessons", { p_company: company });
}
export async function saveInsightLesson(
  company: string,
  lesson: { id?: string; scope: InsightLesson["scope"]; client_id?: string | null; product_id?: string | null; kind?: InsightKind | null; text: string },
) {
  if (offline(company)) throw Error("No ambiente demonstrativo os aprendizados não são salvos.");
  return rpc<LessonsView>("save_campaign_insight_lesson", { p_company: company, p_lesson: lesson });
}
export async function setInsightLesson(company: string, id: string, action: "review" | "pause" | "activate" | "dismiss") {
  if (offline(company)) throw Error("No ambiente demonstrativo os aprendizados não são salvos.");
  return rpc<LessonsView>("set_campaign_insight_lesson", { p_company: company, p_lesson: id, p_action: action });
}

/** "Melhorou: custo por resultado −18% (R$ 32,00 → R$ 26,24), 7 × 7 dias". */
export function effectText(e: InsightEffect) {
  const verdict = e.verdict === "better" ? "Melhorou" : e.verdict === "worse" ? "Piorou" : "Estável";
  const sign = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  const brl = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const main =
    e.change.cpa !== null
      ? `custo por resultado ${sign(e.change.cpa)} (${brl(e.before.cpa)} → ${brl(e.after.cpa)})`
      : e.change.results_per_day !== null
        ? `resultados por dia ${sign(e.change.results_per_day)}`
        : "sem resultados para comparar";
  return `${verdict}: ${main}, ${e.days} dias antes × ${e.days} depois`;
}

/** A tarefa a partir de um insight: no produto da campanha, com o insight e o link de volta. */
export function insightTaskPreset(
  insight: CampaignInsight,
  campaign: { id: string; name: string; contract_id: string },
  data: Snapshot,
  user: string,
): FormPreset | null {
  const own = data.contracts.find((k) => k.id === campaign.contract_id);
  const options = data.contracts.filter(
    (k) => !k.archived && k.client_id === own?.client_id && canCreateTaskIn(data, k.id, user),
  );
  const contract = (options.find((k) => k.id === campaign.contract_id) ?? options[0])?.id;
  if (!contract) return null;
  const text = (t: string, marks?: RichNode["marks"]): RichNode => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
  const bold = [{ type: "bold" }] as RichNode["marks"];
  const link = (href: string) => [{ type: "link", attrs: { href } }] as RichNode["marks"];
  const paragraph = (...content: RichNode[]): RichNode => ({ type: "paragraph", content });
  const content: RichNode[] = [];
  if (insight.body) content.push(paragraph(text(insight.body)));
  if (insight.action) content.push(paragraph(text("O que fazer: ", bold), text(insight.action)));
  if (insight.evidence.length)
    content.push(paragraph(text(`Evidências (valores ${basisLabel(insight.money_basis)})`, bold)), {
      type: "bulletList",
      content: insight.evidence.map((e) => ({
        type: "listItem",
        content: [paragraph(text(`${e.label}: `, bold), text(`${formatEvidence(e)} — ${e.name} · ${WINDOW_LABELS[e.window]}`))],
      })),
    });
  content.push(
    paragraph(
      text(`Insight da MAVI na campanha ${campaign.name}: `, bold),
      text("abrir nas Campanhas", link(appPath(`/campanhas/${campaign.id}?aba=insights`))),
    ),
  );
  return {
    contract,
    title: insight.title.slice(0, 240),
    description: serializeDescription({ type: "doc", content }),
  };
}

// Painel da MAVI › Campanhas (administradores e gestores).
const offline = (company: string) => !supabase || !/^[0-9a-f-]{36}$/i.test(company);
export async function loadInsightSettings(company: string) {
  if (offline(company)) return demoSettings();
  return rpc<InsightSettingsView>("campaign_insight_settings", { p_company: company });
}
export async function saveInsightSettings(company: string, settings: Partial<InsightSettings>) {
  if (offline(company)) return { ...demoSettings(), settings: { ...demoSettings().settings, ...settings } };
  return rpc<InsightSettingsView>("save_campaign_insight_settings", { p_company: company, p_settings: settings });
}
export async function saveInsightRule(company: string, rule: InsightRule) {
  if (offline(company)) throw Error("No ambiente demonstrativo os ajustes não são salvos.");
  return rpc<InsightSettingsView>("save_campaign_insight_rule", { p_company: company, p_rule: rule });
}
export async function deleteInsightRule(company: string, id: string) {
  if (offline(company)) throw Error("No ambiente demonstrativo os ajustes não são salvos.");
  return rpc<InsightSettingsView>("delete_campaign_insight_rule", { p_company: company, p_rule: id });
}

// ------------------------------------------------------------ demonstração
export const DEFAULT_SETTINGS: InsightSettings = {
  enabled: false,
  frequency: "weekdays",
  weekdays: [1, 4],
  every_days: 3,
  hour: 8,
  show_panel: true,
  show_badge: true,
  show_tab: true,
  mavi_context: true,
  notify_inbox: true,
  notify_min_priority: "high",
  notify_who: "team",
  money_basis: "net",
  monthly_cap_usd: 30,
  run_cap_usd: 0.5,
  min_interval_minutes: 240,
  min_new_days: 2,
  google_daily_ops: 500,
  creative_images: true,
  creative_videos: true,
  creative_new_max: 6,
  expire_days: 15,
};
function demoSettings(): InsightSettingsView {
  return {
    settings: { ...DEFAULT_SETTINGS, enabled: true },
    rules: [],
    spent_month: 4.82,
    runs_month: 37,
    campaigns: 12,
    capped: false,
    google_ops_24h: 84,
    paused: [],
    timezone: "America/Sao_Paulo",
  };
}
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
/** Exemplos para o ambiente demonstrativo (nada vai ao banco). */
export function demoInsights(): InsightsBackend {
  const insights = (run: string): CampaignInsight[] => [
    {
      id: "di-1",
      run_id: run,
      last_seen_run: run,
      kind: "tracking",
      priority: "high",
      title: "Leads – Formulário: conversões na plataforma e nenhum lead no CRM",
      body: "No ciclo, a campanha registrou 48 cadastros na plataforma, mas nenhuma oportunidade com utm_campaign igual ao nome dela chegou ao MakeCRM. O CRM recebeu oportunidades com a UTM \"leads-formulario\", quase igual ao nome da campanha.",
      action: "Troque a UTM \"leads-formulario\" pelo nome exato da campanha (\"Leads – Formulário\") nos parâmetros de URL dos anúncios.",
      evidence: [
        { label: "Resultados na plataforma", value: 48, unit: "count", window: "cycle", entity: "c:1", name: "Leads – Formulário", metric: "results" },
        { label: "Oportunidades no CRM", value: 0, unit: "count", window: "cycle", entity: "c:1", name: "Leads – Formulário", metric: "crm_opportunities" },
      ],
      target: { key: "c:1", level: "campaign", name: "Leads – Formulário" },
      source: "rule",
      money_basis: "net",
      confidence: null,
      status: "new",
      seen_count: 1,
      last_seen_at: ago(90),
      created_at: ago(90),
    },
    {
      id: "di-2",
      run_id: run,
      last_seen_run: run,
      kind: "highlight",
      priority: "medium",
      title: "Anúncio \"Frete grátis em 24h\" puxa as oportunidades do CRM",
      body: "Com 22% do investimento do ciclo, o anúncio gerou 41% das oportunidades no CRM, com custo por oportunidade 38% menor que a média, e 9 delas já chegaram à Negociação. O título promete entrega rápida e sem frete, a dor mais citada nas reuniões.",
      action: "Duplique o conjunto com este anúncio e teste uma variação com a mesma promessa em vídeo curto.",
      evidence: [
        { label: "Oportunidades no CRM", value: 19, unit: "count", window: "cycle", entity: "a:2", name: "Frete grátis em 24h", metric: "crm_opportunities" },
        { label: "Custo por oportunidade (CRM)", value: 23.4, unit: "money", window: "cycle", entity: "a:2", name: "Frete grátis em 24h", metric: "crm_cpl" },
        { label: 'Chegaram a "Negociação" ou além', value: 9, unit: "count", window: "cycle", entity: "a:2", name: "Frete grátis em 24h", metric: "stage:demo" },
      ],
      target: { key: "a:2", level: "ad", name: "Frete grátis em 24h", parent: "Público frio – 25-44" },
      source: "mavi",
      money_basis: "net",
      confidence: 0.91,
      status: "new",
      seen_count: 1,
      last_seen_at: ago(90),
      created_at: ago(90),
    },
    {
      id: "di-3",
      run_id: run,
      last_seen_run: run,
      kind: "opportunity",
      priority: "low",
      title: "Mulheres de 35 a 44 anos convertem mais barato no conjunto Remarketing",
      body: "O público feminino de 35 a 44 anos teve o menor custo por resultado do conjunto nos últimos 7 dias.",
      action: "Crie um conjunto só com esse público e verba moderada para validar.",
      evidence: [
        { label: "Custo por resultado", value: 18.9, unit: "money", window: "cycle", entity: "g:3:35-44|female", name: "Remarketing · 35-44 · Mulheres", metric: "cpa" },
      ],
      target: { key: "s:3", level: "adset", name: "Remarketing" },
      source: "mavi",
      money_basis: "net",
      confidence: 0.78,
      status: "new",
      seen_count: 2,
      last_seen_at: ago(90),
      created_at: ago(3 * 24 * 60),
    },
  ];
  return {
    async view() {
      const list = insights("dr-1");
      return {
        enabled: true,
        schedule: { source: "company", rule: null, enabled: true, frequency: "weekdays", weekdays: [1, 4], every_days: 3, hour: 8 },
        timezone: "America/Sao_Paulo",
        last_scheduled_day: null,
        places: { panel: true, badge: true, tab: true },
        money_basis: "net",
        min_interval_minutes: 240,
        expire_days: 15,
        blocker: null,
        capped: false,
        wait_until: null,
        pending: null,
        latest_run: "dr-1",
        current: list,
        applied: [
          {
            ...list[2],
            id: "di-4",
            title: "Pausar o conjunto Interesses amplos, que gasta sem gerar oportunidades",
            kind: "problem",
            priority: "high",
            status: "applied",
            status_by_name: "Tiago Tráfego",
            applied_at: ago(9 * 24 * 60),
            effect: {
              days: 8,
              before: { spend: 1200, results: 30, cpa: 40, ctr: 1.1, cpc: 2.1 },
              after: { spend: 1150, results: 38, cpa: 30.26, ctr: 1.3, cpc: 1.9 },
              change: { cpa: -24.4, results_per_day: 26.7, ctr: 18.2 },
              verdict: "better",
              money_basis: "net",
            },
          },
        ],
        snoozed: [],
        dismissed: [
          {
            ...list[0],
            id: "di-5",
            title: "Testar frete grátis em todos os anúncios",
            kind: "opportunity",
            priority: "medium",
            status: "dismissed",
            status_by_name: "Ana Admin",
            status_reason: "Restrição do cliente: sem margem para frete",
          },
        ],
        runs: [
          {
            id: "dr-1",
            trigger: "schedule",
            status: "done",
            requested_by_name: null,
            created_at: ago(92),
            started_at: ago(92),
            finished_at: ago(90),
            cost_usd: 0.21,
            model: "claude-opus-5-5",
            provider_name: "",
            summary: "A campanha entrega cadastros dentro da meta, mas a UTM de uma campanha não liga os leads ao CRM.",
            note: "",
            money_basis: "net",
            multiplier: 1.5,
            windows: {},
            insights_count: 2,
            repeated_count: 1,
            api_calls: { meta: 9 },
            tokens: { input: 14200, output: 1650 },
            insights: list.slice(0, 2),
          },
        ],
      };
    },
    async request() {
      return { ok: false, reason: "No ambiente demonstrativo a MAVI não analisa campanhas." };
    },
    async setStatus(_c, insight, status, opts = {}) {
      const found = insights("dr-1").find((i) => i.id === insight) ?? insights("dr-1")[0];
      return {
        ...found,
        status,
        status_at: new Date().toISOString(),
        status_by_name: "Você",
        status_reason: status === "dismissed" ? (DISMISS_REASONS.find((r) => r.id === opts.reason)?.label ?? "") : null,
        snooze_until: status === "snoozed" ? (opts.until ?? null) : null,
        applied_at: status === "applied" ? new Date().toISOString() : null,
      };
    },
    async vote(_c, insight, vote) {
      const found = insights("dr-1").find((i) => i.id === insight) ?? insights("dr-1")[0];
      return { ...found, my_vote: vote, votes: { up: vote === "up" ? 1 : 0, down: vote === "down" ? 1 : 0 } };
    },
    async linkTask() {},
    async unlinkTask() {},
    async events() {
      return [];
    },
    async badges(_company, campaigns) {
      return {
        enabled: true,
        badge: true,
        rows: campaigns.slice(0, 2).map((c, i) => ({
          campaign: c,
          open: 3 - i,
          high: i ? 0 : 1,
          medium: 1,
          at: ago(90),
          running: false,
        })),
      };
    },
  };
}

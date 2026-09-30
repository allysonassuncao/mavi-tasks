import { supabase } from "./supabase";
import { canCreateTaskIn } from "./domain";
import { serializeDescription, type RichNode } from "./rich-text";
import { appPath } from "./temperature";
import type { FormPreset } from "./forms";
import type { Snapshot } from "./types";

/**
 * Radar do cliente (migration 20261229090000_client_radar): problemas,
 * promessas e os outros tópicos que a MAVI tira das reuniões gravadas e dos
 * grupos de WhatsApp. Aqui ficam os tipos, as chamadas ao banco, a
 * demonstração e o que as telas repetem (status, gravidade, links).
 */

export type RadarSpeaker = "client" | "team" | "any";
export type RadarSource = "meeting" | "whatsapp";
export type RadarStatusKind = "open" | "progress" | "closed";
export type RadarStatus = {
  key?: string;
  label: string;
  color: string;
  kind: RadarStatusKind;
  /** Fechado: volta a abrir quando o assunto aparece de novo. */
  reopen: boolean;
};
export type RadarFieldType = "text" | "number" | "date" | "choice";
export type RadarField = {
  key?: string;
  label: string;
  type: RadarFieldType;
  options: string[];
  hint?: string;
};
export type RadarTopic = {
  id?: string;
  key?: string;
  name: string;
  description: string;
  exclude: string;
  speaker: RadarSpeaker;
  sources: RadarSource[];
  has_due: boolean;
  severity: boolean;
  severity_label: string;
  severity_levels: string[];
  fields: RadarField[];
  statuses: RadarStatus[];
  color: string;
  /** Nulo: da empresa; com produto, só para os clientes dele. */
  product_id: string | null;
  /** Tópico da empresa desligado nestes produtos. */
  off_products: string[];
  active: boolean;
  position?: number;
  /** Na configuração: quantos itens o tópico já tem. */
  items?: number;
};
export type TopicCounts = RadarTopic & {
  id: string;
  open: number;
  new_7d: number;
  severe: number;
  overdue: number | null;
  total: number;
};
export type RadarOverview = {
  topics: TopicCounts[];
  pending: number;
  started_at: string | null;
  /** O que já foi lido (para explicar como o Radar lê). */
  reading?: {
    done: number;
    meetings: number;
    whatsapp: number;
    last_at: string | null;
    backfill_pending: number;
  };
  backfill_from?: string | null;
  /** Tópicos, histórico e modelos: só administradores e gestores. */
  can_configure: boolean;
  /**
   * Itens, temas, relatórios e avisos: também o colaborador com o módulo
   * ligado, recortados pelos clientes das equipes dele (20270107090000).
   */
  can_use?: boolean;
};
export type RadarItem = {
  id: string;
  topic_id: string;
  client_id: string;
  client_name: string;
  client_color: string | null;
  product_id: string | null;
  product_name: string | null;
  title: string;
  summary: string;
  status: string;
  status_at: string;
  assignee_id: string | null;
  assignee_name: string | null;
  severity: number | null;
  due_date: string | null;
  fields: Record<string, string>;
  speaker_confirmed: boolean;
  mentions: number;
  first_seen_at: string;
  last_seen_at: string;
  reopened_at: string | null;
  created_at: string;
  /** O tema (os itens parecidos de outros clientes do mesmo produto). */
  theme_id: string | null;
  theme_title: string | null;
  /** Tema escolhido por pessoa: a MAVI não mexe. */
  theme_locked: boolean;
  /** Esperando a MAVI escolher o tema. */
  theme_pending: boolean;
};
export type RadarTask = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  assignee_name: string | null;
};
export type RadarOccurrence = {
  id: string;
  source_type: RadarSource;
  source_id: string;
  group_id: string | null;
  message_id: string | null;
  at_seconds: number | null;
  quote: string;
  speaker: string;
  role: "client" | "team" | "unknown";
  occurred_at: string;
  title: string | null;
};
export type RadarItemDetail = RadarItem & {
  topic: RadarTopic & { id: string };
  can_edit: boolean;
  client_products: { id: string; name: string }[];
  occurrences: RadarOccurrence[];
  /** Os temas do mesmo tópico e produto (líderes). */
  theme_options: { id: string; title: string }[];
  tasks: RadarTask[];
};
export type RadarTheme = {
  id: string;
  topic_id: string;
  product_id: string | null;
  product_name: string | null;
  title: string;
  summary: string;
  person_edited: boolean;
  items: number;
  open_items: number;
  clients: number;
  mentions: number;
  last_seen_at: string | null;
  max_severity: number | null;
  client_names: string[];
};
export type RadarThemeFilters = {
  topic: string;
  /** "none": Geral / Agência. */
  product?: string;
  q?: string;
  days?: number;
  /** Só temas com item em aberto (padrão). */
  open_only?: boolean;
  sort?: "clients" | "items" | "mentions" | "recent";
  limit?: number;
  offset?: number;
};
export type RadarThemesPage = {
  total: number;
  themes: RadarTheme[];
  /** Itens esperando a MAVI agrupar. */
  pending: number;
  /** Itens que alguém deixou sem tema. */
  without: number;
};
export type RadarThemeDetail = {
  id: string;
  topic_id: string;
  product_id: string | null;
  product_name: string | null;
  title: string;
  summary: string;
  person_edited: boolean;
  created_at: string;
  topic: RadarTopic & { id: string };
  items: RadarItem[];
  others: { id: string; title: string }[];
  /** Renomear e juntar: quando todos os itens do tema são de clientes seus. */
  can_edit?: boolean;
};
export type ReportFilters = {
  topics?: string[];
  /** "none": Geral / Agência. */
  products?: string[];
  teams?: string[];
  clients?: string[];
};
export type ReportLabels = { topics: string[]; products: string[]; teams: string[]; clients: string[] };
export type RadarReport = {
  id: string;
  title: string;
  period_from: string;
  period_to: string;
  filters: ReportFilters;
  labels: ReportLabels;
  status: "pending" | "running" | "done" | "failed";
  error: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  schedule_id: string | null;
  schedule_name: string | null;
  headline: string | null;
  created_at: string;
  finished_at: string | null;
  cost_usd: number;
};
/** Os números do período (calculados pelo banco). */
export type ReportMaterial = {
  period: { from: string; to: string };
  today: string;
  company: string;
  filters: ReportLabels;
  topics: {
    topic: string;
    has_due: boolean;
    new: number;
    active: number;
    open: number;
    closed: number;
    severe: number;
    overdue: number;
    mentions: number;
    clients: number;
  }[];
  products: {
    product: string;
    clients: number;
    topics: { topic: string; new: number; open: number; severe: number; overdue: number; closed: number }[];
  }[];
  themes: {
    title: string;
    summary: string;
    topic: string;
    product: string;
    clients: number;
    items: number;
    open: number;
    mentions: number;
    max_severity: number | null;
    client_names: string[];
    quotes: string[];
  }[];
  severe: {
    topic: string;
    product: string;
    client: string;
    title: string;
    summary: string;
    severity: number;
    status: string;
    mentions: number;
    last_seen: string;
  }[];
  overdue: {
    topic: string;
    product: string;
    client: string;
    title: string;
    due_date: string;
    status: string;
    assignee: string | null;
  }[];
  clients: { client: string; open: number; severe: number; new: number }[];
  new_items: { topic: string; product: string; client: string; title: string; severity: number | null; status: string }[];
  /** Radar × Campanhas: só para quem vê Campanhas (relatórios antigos não têm). */
  campaigns?: ReportCampaigns;
};
export type ReportCampaign = {
  name: string;
  platform: string;
  product: string;
  status: string;
  objective: string;
  /** O ciclo mais recente dentro do período, até o fim do período. */
  cycle: {
    start: string;
    end: string;
    days: number;
    elapsed: number;
    goal: number;
    budget: number;
    spent: number;
    results: number;
    cost: number | null;
    goal_cost: number | null;
    expected: number;
    status: "good" | "bad" | null;
  };
  period: { spend: number; results: number; impressions: number; clicks: number; cost: number | null };
  previous: { spend: number; results: number; cost: number | null };
};
export type ReportCampaigns = {
  money: string;
  clients: {
    client: string;
    open: number;
    severe: number;
    items: { topic: string; product: string; title: string; severity: number | null; status: string; open: boolean }[];
    campaigns: ReportCampaign[];
  }[];
  without: string[];
};
export type ReportPriority = "alta" | "média" | "baixa";
/** O texto da MAVI. */
export type ReportContent = {
  headline: string;
  summary: string;
  sections: { title: string; paragraphs: string[]; bullets: string[] }[];
  /** Radar × Campanhas: o que foi dito, o que os números mostram e a solução. */
  crossings?: { client: string; product?: string; problem: string; evidence: string; solution: string; priority: ReportPriority }[];
  actions: { priority: ReportPriority; text: string; product?: string }[];
};

const RESULTS: Record<string, [string, string]> = {
  lead: ["leads", "CPL"],
  sale: ["vendas", "CPA"],
  message: ["conversas", "Custo por conversa"],
  traffic: ["cliques", "CPC"],
  engagement: ["engajamentos", "Custo por engajamento"],
  custom: ["conversões", "CPA"],
  video: ["visualizações", "Custo por visualização"],
};
const PLATFORMS: Record<string, string> = { meta: "Meta", google: "Google Ads", linkedin: "LinkedIn", tiktok: "TikTok", kwai: "Kwai" };
const money = (n: number) => Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const count = (n: number) => Math.round(Number(n)).toLocaleString("pt-BR");
/** A variação de a sobre b ("+12%", "-40%"), ou null sem base. */
export function change(a: number, b: number) {
  if (!(b > 0)) return null;
  const v = Math.round(((a - b) / b) * 100);
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v)}%`;
}
/** Uma campanha do relatório em textos curtos (tela e PDF). */
export function campaignCells(c: ReportCampaign) {
  const [result, costName] = RESULTS[c.objective] ?? ["resultados", "Custo por resultado"];
  const y = c.cycle;
  const prev = change(c.period.results, c.previous.results);
  return {
    name: c.name,
    meta: `${PLATFORMS[c.platform] ?? c.platform} · ${c.product}${c.status === "active" ? "" : " · inativa"}`,
    goal: `${count(y.results)} de ${count(y.goal)} ${result}`,
    cycle: `${dateBr(y.start).slice(0, 5)} a ${dateBr(y.end).slice(0, 5)} · dia ${y.elapsed} de ${y.days}`,
    cost:
      y.cost != null
        ? `${costName} ${money(y.cost)}${y.goal_cost != null ? ` × ${money(y.goal_cost)}` : ""}`
        : y.goal_cost != null
          ? `Sem ${result} (meta ${money(y.goal_cost)})`
          : "—",
    spend: `${money(y.spent)} de ${money(y.budget)}${y.expected > 0 ? ` · esperado ${money(y.expected)}` : ""}`,
    period: `${count(c.period.results)} ${result} · ${money(c.period.spend)}${prev ? ` · ${prev} vs. anterior` : ""}`,
    status: y.status,
  };
}
export type RadarReportFull = RadarReport & {
  material: ReportMaterial | null;
  content: ReportContent | null;
  model: string | null;
};
export type ReportSchedule = {
  id?: string;
  name: string;
  frequency: "weekly" | "monthly";
  /** 1 = segunda … 7 = domingo. */
  weekday: number;
  month_day: number;
  hour: number;
  period_days: number;
  filters: ReportFilters;
  labels?: ReportLabels;
  active: boolean;
  next_run_at?: string | null;
  last_run_at?: string | null;
};
export const WEEKDAYS = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];
/** "Toda segunda às 8h · últimos 7 dias". */
export function scheduleLabel(s: Pick<ReportSchedule, "frequency" | "weekday" | "month_day" | "hour" | "period_days">) {
  const when =
    s.frequency === "weekly"
      ? `${s.weekday >= 6 ? "Todo" : "Toda"} ${WEEKDAYS[s.weekday]} às ${s.hour}h`
      : `Todo dia ${s.month_day} às ${s.hour}h`;
  return `${when} · últimos ${s.period_days} dias`;
}
/** Os filtros do relatório numa linha ("Todos os tópicos · Make Ads"). */
export function labelsLine(l: ReportLabels | undefined) {
  if (!l) return "";
  const parts = [
    l.topics.length ? l.topics.join(", ") : "Todos os tópicos",
    l.products.length ? l.products.join(", ") : "Todos os produtos",
    ...(l.teams.length ? [l.teams.join(", ")] : []),
    ...(l.clients.length ? [l.clients.join(", ")] : []),
  ];
  return parts.join(" · ");
}
export const reportPath = (id: string) => `/radar?relatorio=${id}`;

/** Para onde o item vai: um tema, um tema novo, "sem tema" ou a MAVI escolher. */
export type ThemeMove = { theme: string } | { title: string } | { none: true } | { auto: true };
export type RadarFilters = {
  topic?: string;
  q?: string;
  /** "none": Geral / Agência. */
  product?: string;
  client?: string;
  team?: string;
  /** "none": sem tema. */
  theme?: string;
  statuses?: string[];
  severity?: number;
  /** "none": sem responsável. */
  assignee?: string;
  days?: number;
  sort?: "recent" | "mentions" | "severity" | "oldest";
  limit?: number;
  offset?: number;
};
export type RadarPage = { total: number; items: RadarItem[] };
export type ClientRadarData = {
  topics: (RadarTopic & { id: string })[];
  items: RadarItem[];
  pending: number;
  can_edit: boolean;
};
export type RadarConfig = {
  topics: RadarTopic[];
  started_at: string | null;
  jev: { provider: string; model: string } | null;
  model: { provider: string; model: string } | null;
  stats: { done: number; pending: number; failed: number; skipped: number };
  cost_30d: number;
  /** A leitura do histórico (antes de o Radar ligar). */
  backfill?: {
    from: string | null;
    started_at: string | null;
    by_name: string | null;
    pending: number;
    done: number;
    failed: number;
    cost: number;
  } | null;
};
export type AlertEvent = "new" | "recurring" | "reopened" | "due_soon" | "overdue";
export const ALERT_EVENTS: { key: AlertEvent; label: string; hint: string }[] = [
  { key: "new", label: "Item novo", hint: "a MAVI anotou um assunto novo" },
  { key: "recurring", label: "Voltou a aparecer", hint: "o assunto foi falado de novo" },
  { key: "reopened", label: "Reabriu", hint: "um item resolvido voltou" },
  { key: "due_soon", label: "Prazo amanhã", hint: "nos tópicos com prazo" },
  { key: "overdue", label: "Prazo vencido", hint: "venceu ontem e segue em aberto" },
];
export type AlertRule = {
  id?: string;
  name: string;
  topic_id: string | null;
  product_id: string | null;
  /** Só os itens sem produto (Geral / Agência). */
  product_none: boolean;
  client_id: string | null;
  team_id: string | null;
  /** 0 a 3; nulo: qualquer gravidade. */
  min_severity: number | null;
  events: AlertEvent[];
  /** now: na hora (caixa de entrada e push); digest: resumo por dia às 8h. */
  channel: "now" | "digest";
  active: boolean;
  labels?: { topic: string | null; product: string | null; client: string | null; team: string | null };
};
export type BackfillEstimate = {
  from: string | null;
  until: string;
  oldest: string | null;
  meetings: number;
  whatsapp_days: number;
  meeting_chars: number;
  whatsapp_chars: number;
  avg_meeting_cost: number | null;
  avg_whatsapp_cost: number | null;
  samples: number;
  price: { input?: number; output?: number } | null;
};

/**
 * O custo do histórico: pelo custo médio das leituras já feitas (a partir de
 * 5), ou pelo tamanho do texto e o preço do modelo (sem modelo escolhido, o
 * da Claude Opus 5.5). Mais 10% dos temas e da conferência; faixa de ±30%.
 */
export function backfillCost(e: BackfillEstimate, fallback = { input: 4, output: 20 }) {
  const signals = e.meetings + e.whatsapp_days;
  const m = e.avg_meeting_cost != null ? Number(e.avg_meeting_cost) : null;
  const w = e.avg_whatsapp_cost != null ? Number(e.avg_whatsapp_cost) : null;
  let base: number;
  let measured = false;
  if (e.samples >= 5 && (m !== null || w !== null)) {
    measured = true;
    base = e.meetings * (m ?? (w ?? 0) * 4) + e.whatsapp_days * (w ?? (m ?? 0) / 4);
  } else {
    const price = { input: e.price?.input ?? fallback.input, output: e.price?.output ?? fallback.output };
    const input = (Number(e.meeting_chars) + Number(e.whatsapp_chars)) / 3.5 + signals * 3500;
    const output = signals * 700;
    base = (input / 1e6) * price.input + (output / 1e6) * price.output;
  }
  const total = base * 1.1;
  return { signals, low: total * 0.7, high: total * 1.3, measured };
}
export type RadarPatch = Partial<{
  status: string;
  assignee_id: string | null;
  severity: number | null;
  due_date: string | null;
  product_id: string | null;
  title: string;
  summary: string;
  fields: Record<string, string>;
}>;

// ------------------------------------------------------------ o que as telas repetem
export const SPEAKER_LABELS: Record<RadarSpeaker, string> = {
  client: "Só o cliente",
  team: "Só o time",
  any: "Qualquer pessoa",
};
export const KIND_LABELS: Record<RadarStatusKind, string> = {
  open: "Aberto",
  progress: "Em andamento",
  closed: "Fechado",
};
export const SEVERITY_COLORS = ["#7fb2ea", "#eda100", "#eb6834", "#e34948"];
/** "Alta", "Crítica"…: o nome do nível (o texto antes dos dois-pontos). */
export function severityName(topic: Pick<RadarTopic, "severity_levels">, v: number | null | undefined) {
  if (v === null || v === undefined) return null;
  const level = topic.severity_levels[v] ?? "";
  return level.split(":")[0].trim() || ["Baixa", "Média", "Alta", "Crítica"][v];
}
export const statusOf = (topic: Pick<RadarTopic, "statuses">, key: string) =>
  topic.statuses.find((s) => s.key === key) ?? null;
export const isClosed = (topic: Pick<RadarTopic, "statuses">, key: string) =>
  statusOf(topic, key)?.kind === "closed";
export const dateBr = (iso: string | null | undefined) =>
  iso
    ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      })
    : "";
/** Vencida: com prazo passado e ainda aberta. */
export function overdue(topic: RadarTopic, item: Pick<RadarItem, "due_date" | "status">) {
  if (!item.due_date || isClosed(topic, item.status)) return false;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  return item.due_date < today;
}
/** mm:ss ou h:mm:ss. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}
/** Onde a ocorrência abre: o momento da reunião ou a mensagem do grupo. */
export function occurrencePath(o: RadarOccurrence) {
  if (o.source_type === "meeting")
    return `/drive?gravacao=${o.source_id}${o.at_seconds !== null ? `&t=${o.at_seconds}` : ""}`;
  if (o.group_id) return `/drive?whatsapp=${o.group_id}${o.message_id ? `&msg=${o.message_id}` : ""}`;
  return null;
}
/** A aba Radar de um cliente no Drive. */
export const clientRadarPath = (client: string, item?: string) =>
  `/drive?radar=${client}${item ? `&item=${item}` : ""}`;

/**
 * A tarefa a partir de um item: no produto do item (ou no primeiro que a
 * pessoa pode usar no cliente), com o título, o que a MAVI entendeu, as falas
 * com o link para o momento e o link do item. Promessa com prazo leva o prazo.
 */
export function radarTaskPreset(
  item: RadarItemDetail,
  data: Snapshot,
  user: string,
): FormPreset | null {
  const open = data.contracts.filter(
    (k) => k.client_id === item.client_id && !k.archived && canCreateTaskIn(data, k.id, user),
  );
  const contract = (open.find((k) => k.product_id === item.product_id) ?? open[0])?.id;
  if (!contract) return null;
  const text = (t: string, marks?: RichNode["marks"]): RichNode => ({
    type: "text",
    text: t,
    ...(marks ? { marks } : {}),
  });
  const bold = [{ type: "bold" }] as RichNode["marks"];
  const link = (href: string) => [{ type: "link", attrs: { href } }] as RichNode["marks"];
  const paragraph = (...content: RichNode[]): RichNode => ({ type: "paragraph", content });
  const content: RichNode[] = [];
  if (item.summary) content.push(paragraph(text(item.summary)));
  if (item.occurrences.length)
    content.push(paragraph(text("Onde apareceu", bold)), {
      type: "bulletList",
      content: item.occurrences.slice(0, 10).map((o) => {
        const path = occurrencePath(o);
        const when = `${dateBr(o.occurred_at)}${o.source_type === "meeting" && o.at_seconds !== null ? ` ${clock(o.at_seconds)}` : ""}`;
        return {
          type: "listItem",
          content: [
            paragraph(
              path ? text(when, link(appPath(path))) : text(when),
              text(" · "),
              text(`${o.speaker || "Sem nome"}: `, bold),
              text(`“${o.quote}”`),
            ),
          ],
        };
      }),
    });
  content.push(
    paragraph(
      text(`${item.topic.name}: `, bold),
      text("abrir no Radar do cliente", link(appPath(clientRadarPath(item.client_id, item.id)))),
    ),
  );
  return {
    contract,
    title: item.title.slice(0, 240),
    description: serializeDescription({ type: "doc", content }),
    ...(item.topic.has_due && item.due_date ? { due: item.due_date } : {}),
  };
}

/** Um tópico novo, com os status de sempre. */
export function blankTopic(): RadarTopic {
  return {
    name: "",
    description: "",
    exclude: "",
    speaker: "client",
    sources: ["meeting", "whatsapp"],
    has_due: false,
    severity: true,
    severity_label: "Gravidade",
    severity_levels: [
      "Baixa: detalhe, sem risco para a relação",
      "Média: precisa de atenção",
      "Alta: afeta o cliente ou os resultados",
      "Crítica: ameaça a relação ou envolve dinheiro",
    ],
    fields: [],
    statuses: [
      { label: "Aberto", color: "#2a78d6", kind: "open", reopen: false },
      { label: "Em andamento", color: "#eda100", kind: "progress", reopen: false },
      { label: "Resolvido", color: "#2f9e6b", kind: "closed", reopen: true },
      { label: "Descartado", color: "#a3acab", kind: "closed", reopen: false },
    ],
    color: "#6b52b3",
    product_id: null,
    off_products: [],
    active: true,
  };
}

// ------------------------------------------------------------ banco
/** Sem banco ou na demonstração (empresa "demo-agency"): dados de exemplo. */
const offline = (company: string) => !supabase || !/^[0-9a-f-]{36}$/i.test(company);
async function rpc<T>(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase!.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

export async function loadOverview(company: string) {
  if (offline(company)) return demoOverview();
  return rpc<RadarOverview>("radar_overview", { p_company: company });
}
export async function loadItems(company: string, filters: RadarFilters) {
  if (offline(company)) return demoItems(filters);
  return rpc<RadarPage>("radar_items", { p_company: company, p_filters: filters });
}
export async function loadItem(company: string, item: string) {
  if (offline(company)) return demoDetail(item);
  return rpc<RadarItemDetail>("radar_item", { p_company: company, p_item: item });
}
export async function updateItem(company: string, item: string, patch: RadarPatch) {
  if (offline(company)) return demoUpdate(item, patch);
  return rpc<RadarItemDetail>("update_radar_item", {
    p_company: company,
    p_item: item,
    p_patch: patch,
  });
}
export async function linkTask(company: string, item: string, task: string) {
  if (offline(company)) {
    const i = demo.items.find((x) => x.id === item);
    if (i) i.tasks = [{ id: task, title: "Tarefa criada", status: "open", due_date: null, assignee_name: null }, ...(i.tasks ?? [])];
    return;
  }
  await rpc("link_radar_task", { p_company: company, p_item: item, p_task: task });
}
export async function setItemTheme(company: string, item: string, move: ThemeMove) {
  if (offline(company)) return demoMove(item, move);
  return rpc<RadarItemDetail>("set_radar_item_theme", {
    p_company: company,
    p_item: item,
    p_theme: "theme" in move ? move.theme : null,
    p_title: "title" in move ? move.title : null,
    p_auto: "auto" in move,
  });
}
export async function loadThemes(company: string, filters: RadarThemeFilters) {
  if (offline(company)) return demoThemes(filters);
  return rpc<RadarThemesPage>("radar_themes", { p_company: company, p_filters: filters });
}
export async function loadTheme(company: string, theme: string) {
  if (offline(company)) return demoTheme(theme);
  return rpc<RadarThemeDetail>("radar_theme", { p_company: company, p_theme: theme });
}
export async function updateTheme(company: string, theme: string, title: string, summary: string) {
  if (offline(company)) {
    const t = demo.themes.find((x) => x.id === theme);
    if (t) Object.assign(t, { title, summary, person_edited: true });
    return demoTheme(theme);
  }
  return rpc<RadarThemeDetail>("update_radar_theme", {
    p_company: company,
    p_theme: theme,
    p_title: title,
    p_summary: summary,
  });
}
export async function mergeThemes(company: string, target: string, sources: string[]) {
  if (offline(company)) {
    for (const i of demo.items) if (i.theme_id && sources.includes(i.theme_id)) i.theme_id = target;
    demo.themes = demo.themes.filter((t) => t.id === target || !sources.includes(t.id));
    return demoTheme(target);
  }
  return rpc<RadarThemeDetail>("merge_radar_themes", {
    p_company: company,
    p_target: target,
    p_sources: sources,
  });
}
export type ThemeOptions = {
  topics: { id: string; name: string }[];
  themes: { id: string; title: string; topic: string; product: string | null }[];
};
export async function loadThemeOptions(company: string): Promise<ThemeOptions> {
  if (offline(company))
    return {
      topics: demo.topics.map((t) => ({ id: t.id, name: t.name })),
      themes: demo.themes.map((t) => ({
        id: t.id,
        title: t.title,
        topic: demo.topics.find((x) => x.id === t.topic_id)?.name ?? "",
        product: t.product_name,
      })),
    };
  return rpc<ThemeOptions>("radar_theme_options", { p_company: company });
}
export async function requestReport(
  company: string,
  from: string,
  to: string,
  filters: ReportFilters,
  title?: string,
) {
  if (offline(company)) return demoRequest(from, to, filters, title);
  return rpc<RadarReport>("request_radar_report", {
    p_company: company,
    p_from: from,
    p_to: to,
    p_filters: filters,
    p_title: title ?? null,
  });
}
export async function loadReports(company: string) {
  if (offline(company)) return { total: demoReports.length, reports: demoReports.map(({ material: _m, content: _c, model: _o, ...r }) => r) }; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rpc<{ total: number; reports: RadarReport[] }>("radar_reports", {
    p_company: company,
    p_limit: 50,
    p_offset: 0,
  });
}
export async function loadReport(company: string, id: string) {
  if (offline(company)) {
    const r = demoReports.find((x) => x.id === id);
    if (!r) throw Error("Relatório não encontrado.");
    return structuredClone(r);
  }
  return rpc<RadarReportFull>("radar_report", { p_company: company, p_report: id });
}
export async function retryReport(company: string, id: string) {
  if (offline(company)) {
    const r = demoReports.find((x) => x.id === id)!;
    r.status = "pending";
    return r;
  }
  return rpc<RadarReport>("retry_radar_report", { p_company: company, p_report: id });
}
export async function deleteReport(company: string, id: string) {
  if (offline(company)) {
    demoReports = demoReports.filter((x) => x.id !== id);
    return;
  }
  await rpc("delete_radar_report", { p_company: company, p_report: id });
}
export async function loadSchedules(company: string) {
  if (offline(company)) return structuredClone(demoSchedules);
  return rpc<ReportSchedule[]>("radar_report_schedules", { p_company: company });
}
export async function saveSchedule(company: string, schedule: ReportSchedule) {
  if (offline(company)) {
    const next = {
      ...schedule,
      id: schedule.id ?? `demo-schedule-${Date.now()}`,
      labels: demoLabels(schedule.filters),
      next_run_at: daysAgo(-3, 8),
    };
    demoSchedules = [...demoSchedules.filter((x) => x.id !== next.id), next];
    return structuredClone(demoSchedules);
  }
  return rpc<ReportSchedule[]>("save_radar_report_schedule", { p_company: company, p_schedule: schedule });
}
export async function deleteSchedule(company: string, id: string) {
  if (offline(company)) {
    demoSchedules = demoSchedules.filter((x) => x.id !== id);
    return structuredClone(demoSchedules);
  }
  return rpc<ReportSchedule[]>("delete_radar_report_schedule", { p_company: company, p_schedule: id });
}
export async function loadAlertRules(company: string) {
  if (offline(company)) return structuredClone(demoRules);
  return rpc<AlertRule[]>("radar_alert_rules", { p_company: company });
}
export async function saveAlertRule(company: string, rule: AlertRule) {
  if (offline(company)) {
    const next = { ...rule, id: rule.id ?? `demo-rule-${Date.now()}`, labels: demoRuleLabels(rule) };
    demoRules = [...demoRules.filter((r) => r.id !== next.id), next];
    return structuredClone(demoRules);
  }
  return rpc<AlertRule[]>("save_radar_alert_rule", { p_company: company, p_rule: rule });
}
export async function deleteAlertRule(company: string, id: string) {
  if (offline(company)) {
    demoRules = demoRules.filter((r) => r.id !== id);
    return structuredClone(demoRules);
  }
  return rpc<AlertRule[]>("delete_radar_alert_rule", { p_company: company, p_rule: id });
}
export async function estimateBackfill(company: string, from: string) {
  if (offline(company))
    return {
      from,
      until: dayKey(31),
      oldest: dayKey(420),
      meetings: 96,
      whatsapp_days: 1830,
      meeting_chars: 96 * 42000,
      whatsapp_chars: 1830 * 2600,
      avg_meeting_cost: 0.085,
      avg_whatsapp_cost: 0.012,
      samples: 412,
      price: null,
    } satisfies BackfillEstimate;
  return rpc<BackfillEstimate>("radar_backfill_estimate", { p_company: company, p_from: from });
}
export async function startBackfill(company: string, from: string) {
  if (offline(company)) {
    demoBackfill = { from, started_at: new Date().toISOString(), by_name: "Você", pending: 1926, done: 0, failed: 0, cost: 0 };
    return 1926;
  }
  return rpc<number>("start_radar_backfill", { p_company: company, p_from: from });
}
export async function cancelBackfill(company: string) {
  if (offline(company)) {
    const n = demoBackfill?.pending ?? 0;
    if (demoBackfill) demoBackfill = { ...demoBackfill, pending: 0 };
    return n;
  }
  return rpc<number>("cancel_radar_backfill", { p_company: company });
}
export async function loadClientRadar(company: string, client: string) {
  if (offline(company)) return demoClient(client);
  return rpc<ClientRadarData>("client_radar", { p_company: company, p_client: client });
}
export async function loadRadarConfig(company: string) {
  if (offline(company)) return structuredClone(demoConfig());
  return rpc<RadarConfig>("radar_settings", { p_company: company });
}
export async function saveRadarTopics(company: string, topics: RadarTopic[]) {
  if (offline(company)) {
    demo.topics = topics.map((t, i) => ({
      ...structuredClone(t),
      id: t.id ?? `demo-topic-${Date.now()}-${i}`,
      key: t.key ?? `topico_${i + 1}`,
      statuses: t.statuses.map((s, n) => ({ ...s, key: s.key ?? `status_${n + 1}` })),
      fields: t.fields.map((f, n) => ({ ...f, key: f.key ?? `campo_${n + 1}` })),
      position: i + 1,
    })) as (RadarTopic & { id: string })[];
    return structuredClone(demoConfig());
  }
  return rpc<RadarConfig>("save_radar_topics", { p_company: company, p_topics: topics });
}

// ------------------------------------------------------------ demonstração
const PROBLEMS = "demo-topic-problemas";
const PROMISES = "demo-topic-promessas";
const daysAgo = (n: number, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};
const dayKey = (n: number) => daysAgo(n).slice(0, 10);

function demoTopics(): (RadarTopic & { id: string })[] {
  return [
    {
      id: PROBLEMS,
      key: "problemas",
      name: "Problemas / reclamações",
      description:
        'Problemas, reclamações e insatisfações que o cliente traz sobre o trabalho da agência ou sobre os resultados: atrasos, erros, qualidade das entregas, resultados abaixo do esperado, falhas de comunicação. Ex.: "os leads caíram muito esse mês".',
      exclude: "Dúvidas simples, pedidos novos sem reclamação e problemas do negócio do cliente sem relação com a agência.",
      speaker: "client",
      sources: ["meeting", "whatsapp"],
      has_due: false,
      severity: true,
      severity_label: "Gravidade",
      severity_levels: [
        "Baixa: incômodo pequeno, sem risco para a relação",
        "Média: incomoda o cliente e precisa de atenção",
        "Alta: o cliente está irritado ou o problema afeta os resultados",
        "Crítica: ameaça a relação (fala em cancelar, cobra duramente, prejuízo sério)",
      ],
      fields: [],
      statuses: [
        { key: "aberto", label: "Aberto", color: "#e34948", kind: "open", reopen: false },
        { key: "em_tratamento", label: "Em tratamento", color: "#eda100", kind: "progress", reopen: false },
        { key: "resolvido", label: "Resolvido", color: "#2f9e6b", kind: "closed", reopen: true },
        { key: "descartado", label: "Descartado", color: "#a3acab", kind: "closed", reopen: false },
      ],
      color: "#e34948",
      product_id: null,
      off_products: [],
      active: true,
      position: 1,
    },
    {
      id: PROMISES,
      key: "promessas",
      name: "Promessas",
      description:
        'Compromissos que alguém do time da agência assume com o cliente: entregas, prazos, ajustes, retornos, relatórios, bônus ou condições especiais. Ex.: "até sexta te mando as artes".',
      exclude: "Combinados que só dependem do cliente e planos genéricos sem compromisso.",
      speaker: "team",
      sources: ["meeting", "whatsapp"],
      has_due: true,
      severity: true,
      severity_label: "Importância",
      severity_levels: [
        "Baixa: detalhe do dia a dia",
        "Média: compromisso normal de entrega",
        "Alta: o cliente conta com isso para o negócio dele",
        "Crítica: envolve dinheiro, prazo crítico ou condição especial",
      ],
      fields: [],
      statuses: [
        { key: "pendente", label: "Pendente", color: "#2a78d6", kind: "open", reopen: false },
        { key: "em_andamento", label: "Em andamento", color: "#eda100", kind: "progress", reopen: false },
        { key: "cumprida", label: "Cumprida", color: "#2f9e6b", kind: "closed", reopen: false },
        { key: "nao_cumprida", label: "Não cumprida", color: "#e34948", kind: "closed", reopen: false },
      ],
      color: "#2a78d6",
      product_id: null,
      off_products: [],
      active: true,
      position: 2,
    },
  ];
}
type DemoItem = RadarItem & { occurrences: RadarOccurrence[]; tasks?: RadarTask[] };
type DemoTheme = Omit<RadarTheme, "items" | "open_items" | "clients" | "mentions" | "last_seen_at" | "max_severity" | "client_names">;
function demoSeed(): DemoItem[] {
  const occ = (
    n: number,
    type: RadarSource,
    quote: string,
    speaker: string,
    role: RadarOccurrence["role"],
    title: string,
    at: number | null = null,
  ): RadarOccurrence => ({
    id: `demo-occ-${Math.random().toString(36).slice(2)}`,
    source_type: type,
    source_id: "demo",
    group_id: type === "whatsapp" ? "demo-group" : null,
    message_id: null,
    at_seconds: at,
    quote,
    speaker,
    role,
    occurred_at: daysAgo(n),
    title,
  });
  const item = (
    id: string,
    topic: string,
    client: [string, string],
    product: [string, string] | null,
    title: string,
    summary: string,
    status: string,
    severity: number | null,
    occurrences: RadarOccurrence[],
    extra: Partial<RadarItem> = {},
  ): DemoItem => ({
    id,
    topic_id: topic,
    client_id: client[0],
    client_name: client[1],
    client_color: null,
    product_id: product?.[0] ?? null,
    product_name: product?.[1] ?? null,
    title,
    summary,
    status,
    status_at: occurrences[occurrences.length - 1]?.occurred_at ?? daysAgo(1),
    assignee_id: null,
    assignee_name: null,
    severity,
    due_date: null,
    fields: {},
    speaker_confirmed: true,
    mentions: occurrences.length,
    first_seen_at: occurrences[occurrences.length - 1]?.occurred_at ?? daysAgo(1),
    last_seen_at: occurrences[0]?.occurred_at ?? daysAgo(1),
    reopened_at: null,
    created_at: occurrences[occurrences.length - 1]?.occurred_at ?? daysAgo(1),
    theme_id: null,
    theme_title: null,
    theme_locked: false,
    theme_pending: false,
    occurrences,
    ...extra,
  });
  const c1: [string, string] = ["cl-1", "Aurora Studio"];
  const c2: [string, string] = ["cl-2", "Norte Coffee"];
  const c3: [string, string] = ["cl-4", "Forma Living"];
  const trafego: [string, string] = ["pd-1", "Make Ads"];
  const social: [string, string] = ["pd-3", "Social Leads"];
  return [
    item("demo-1", PROBLEMS, c1, trafego, "Leads caíram em setembro",
      "O cliente disse que os leads caíram quase pela metade e quer entender o motivo antes da próxima verba.",
      "aberto", 2, [
        occ(1, "whatsapp", "Os leads caíram de novo essa semana, o que está acontecendo?", "Dra. Paula", "client", 'Grupo "Aurora Studio - Make Ads"'),
        occ(6, "meeting", "Os leads caíram muito, estou preocupada.", "Paula (cliente)", "client", "Alinhamento de setembro", 312),
      ]),
    item("demo-2", PROBLEMS, c2, social, "Artes saindo com o logo antigo",
      "Pela segunda vez as artes do feed saíram com o logo antigo da imobiliária.",
      "em_tratamento", 1, [
        occ(2, "whatsapp", "De novo o logo antigo na arte de hoje.", "Ricardo", "client", 'Grupo "Norte Coffee"'),
        occ(9, "whatsapp", "Essa arte está com o logo errado.", "Ricardo", "client", 'Grupo "Norte Coffee"'),
      ]),
    item("demo-3", PROBLEMS, c3, null, "Demora para responder no grupo",
      "O cliente reclamou que esperou dois dias por uma resposta sobre o relatório.",
      "aberto", 3, [
        occ(0, "whatsapp", "Estou esperando resposta desde segunda, assim não dá.", "Marcos", "client", 'Grupo "Forma Living"'),
      ]),
    item("demo-4", PROBLEMS, c1, social, "Poucos stories na semana",
      "Pediu mais stories; ficou combinado aumentar para 5 por semana.",
      "resolvido", 0, [
        occ(20, "meeting", "Achei que ia ter mais stories essa semana.", "Paula (cliente)", "client", "Reunião mensal", 1210),
      ]),
    item("demo-5", PROMISES, c1, trafego, "Enviar o relatório de campanhas",
      "O Bruno prometeu mandar o relatório com a queda dos leads explicada.",
      "pendente", 2, [
        occ(1, "whatsapp", "Até sexta te mando o relatório completo.", "Bruno Lima", "team", 'Grupo "Aurora Studio - Make Ads"'),
      ], { due_date: dayKey(-2) }),
    item("demo-6", PROMISES, c2, social, "Refazer as artes sem custo",
      "A agência se comprometeu a refazer as 4 artes com o logo novo sem cobrar.",
      "em_andamento", 3, [
        occ(2, "whatsapp", "Vamos refazer as quatro artes sem custo, pode deixar.", "Gabi Gestora", "team", 'Grupo "Norte Coffee"'),
      ], { due_date: dayKey(1) }),
    item("demo-7", PROMISES, c3, null, "Ligar com os números do mês",
      "Ficou de ligar para o cliente com os números fechados do mês.",
      "pendente", 1, [
        occ(8, "meeting", "Amanhã te ligo com os números fechados.", "Ana Admin", "team", "Reunião de resultados", 1805),
      ], { due_date: dayKey(7) }),
    item("demo-8", PROMISES, c1, social, "Aumentar para 5 stories por semana",
      "Combinado na reunião mensal.", "cumprida", 1, [
        occ(20, "meeting", "A partir da semana que vem vão ser cinco stories.", "Gabi Gestora", "team", "Reunião mensal", 1250),
      ], { due_date: dayKey(13) }),
    item("demo-9", PROBLEMS, c2, trafego, "Leads frios, sem interesse de compra",
      "Reclamou que os leads chegam sem saber o que a imobiliária vende.",
      "aberto", 2, [
        occ(3, "meeting", "Os leads que chegam não sabem nem o que a gente vende.", "Ricardo", "client", "Reunião de resultados", 845),
      ]),
    item("demo-10", PROBLEMS, c3, trafego, "Poucos contatos pelo anúncio",
      "Disse que o anúncio novo trouxe poucos contatos no mês.",
      "aberto", 1, [
        occ(4, "whatsapp", "Esse mês quase ninguém chamou pelo anúncio.", "Marcos", "client", 'Grupo "Forma Living"'),
      ], { theme_pending: true }),
  ];
}
function demoThemeSeed(): DemoTheme[] {
  return [
    {
      id: "demo-theme-leads",
      topic_id: PROBLEMS,
      product_id: "pd-1",
      product_name: "Make Ads",
      title: "Queda na quantidade e na qualidade dos leads",
      summary: "Clientes de Make Ads reclamam de menos leads e de leads frios.",
      person_edited: false,
    },
    {
      id: "demo-theme-marca",
      topic_id: PROBLEMS,
      product_id: "pd-3",
      product_name: "Social Leads",
      title: "Artes com a marca errada",
      summary: "Artes publicadas com logo ou cores antigas.",
      person_edited: false,
    },
  ];
}
const demo: { topics: (RadarTopic & { id: string })[]; items: DemoItem[]; themes: DemoTheme[] } = {
  topics: demoTopics(),
  items: demoSeed(),
  themes: demoThemeSeed(),
};
for (const [item, theme] of [
  ["demo-1", "demo-theme-leads"],
  ["demo-9", "demo-theme-leads"],
  ["demo-2", "demo-theme-marca"],
]) {
  const i = demo.items.find((x) => x.id === item)!;
  i.theme_id = theme;
}
// Os outros esperam a MAVI agrupar.
for (const i of demo.items) i.theme_pending = !i.theme_id;
const themeTitle = (id: string | null) => demo.themes.find((t) => t.id === id)?.title ?? null;
const strip = ({ occurrences: _o, tasks: _t, ...rest }: DemoItem): RadarItem => ({ // eslint-disable-line @typescript-eslint/no-unused-vars
  ...rest,
  theme_title: themeTitle(rest.theme_id),
});
function demoThemes(f: RadarThemeFilters): RadarThemesPage {
  const topic = demo.topics.find((t) => t.id === f.topic)!;
  const q = (f.q ?? "").trim().toLowerCase();
  const list = demo.themes
    .filter(
      (t) =>
        t.topic_id === f.topic &&
        (!f.product || (f.product === "none" ? !t.product_id : t.product_id === f.product)) &&
        (!q || `${t.title} ${t.summary}`.toLowerCase().includes(q)),
    )
    .map((t) => {
      const items = demo.items.filter(
        (i) => i.theme_id === t.id && (!f.days || Date.now() - Date.parse(i.last_seen_at) < f.days * 864e5),
      );
      return {
        ...t,
        items: items.length,
        open_items: items.filter((i) => !isClosed(topic, i.status)).length,
        clients: new Set(items.map((i) => i.client_id)).size,
        mentions: items.reduce((n, i) => n + i.mentions, 0),
        last_seen_at: items.map((i) => i.last_seen_at).sort().pop() ?? null,
        max_severity: items.reduce<number | null>((m, i) => (i.severity === null ? m : Math.max(m ?? 0, i.severity)), null),
        client_names: [...new Set(items.map((i) => i.client_name))].slice(0, 6),
      };
    })
    .filter((t) => t.items > 0 && (f.open_only === false || t.open_items > 0))
    .sort((a, b) =>
      f.sort === "items"
        ? b.items - a.items
        : f.sort === "mentions"
          ? b.mentions - a.mentions
          : f.sort === "recent"
            ? (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "")
            : b.clients - a.clients || b.items - a.items,
    );
  const mine = demo.items.filter((i) => i.topic_id === f.topic);
  return {
    total: list.length,
    themes: list,
    pending: mine.filter((i) => i.theme_pending).length,
    without: mine.filter((i) => !i.theme_id && !i.theme_pending).length,
  };
}
function demoTheme(id: string): RadarThemeDetail {
  const t = demo.themes.find((x) => x.id === id);
  if (!t) throw Error("Tema não encontrado.");
  return structuredClone({
    ...t,
    created_at: daysAgo(10),
    topic: demo.topics.find((x) => x.id === t.topic_id)!,
    items: demo.items.filter((i) => i.theme_id === id).map(strip),
    others: demo.themes
      .filter((o) => o.id !== id && o.topic_id === t.topic_id && o.product_id === t.product_id)
      .map((o) => ({ id: o.id, title: o.title })),
    can_edit: true,
  });
}
function demoMove(id: string, move: ThemeMove): RadarItemDetail {
  const i = demo.items.find((x) => x.id === id);
  if (!i) throw Error("Item não encontrado.");
  const before = i.theme_id;
  if ("auto" in move) Object.assign(i, { theme_id: null, theme_locked: false, theme_pending: true });
  else if ("none" in move) Object.assign(i, { theme_id: null, theme_locked: true, theme_pending: false });
  else if ("theme" in move) Object.assign(i, { theme_id: move.theme, theme_locked: true, theme_pending: false });
  else {
    const theme: DemoTheme = {
      id: `demo-theme-${Date.now()}`,
      topic_id: i.topic_id,
      product_id: i.product_id,
      product_name: i.product_name,
      title: move.title,
      summary: "",
      person_edited: true,
    };
    demo.themes.push(theme);
    Object.assign(i, { theme_id: theme.id, theme_locked: true, theme_pending: false });
  }
  if (before && !demo.items.some((x) => x.theme_id === before))
    demo.themes = demo.themes.filter((t) => t.id !== before);
  return demoDetail(id);
}
function demoOverview(): RadarOverview {
  const today = new Date().toLocaleDateString("sv-SE");
  return {
    topics: demo.topics.filter((t) => t.active).map((t) => {
      const mine = demo.items.filter((i) => i.topic_id === t.id);
      const open = mine.filter((i) => !isClosed(t, i.status));
      return {
        ...t,
        open: open.length,
        new_7d: mine.filter((i) => Date.now() - Date.parse(i.created_at) < 7 * 864e5).length,
        severe: open.filter((i) => (i.severity ?? 0) >= 2).length,
        overdue: t.has_due ? open.filter((i) => i.due_date && i.due_date < today).length : null,
        total: mine.length,
      };
    }),
    pending: 2,
    started_at: daysAgo(30),
    reading: {
      done: 412,
      meetings: 38,
      whatsapp: 374,
      last_at: new Date(Date.now() - 40 * 60000).toISOString(),
      backfill_pending: demoBackfill?.pending ?? 0,
    },
    backfill_from: demoBackfill?.from ?? null,
    can_configure: true,
    can_use: true,
  };
}
function demoItems(f: RadarFilters): RadarPage {
  const q = (f.q ?? "").trim().toLowerCase();
  const topicOf = (id: string) => demo.topics.find((t) => t.id === id)!;
  let list = demo.items.filter(
    (i) =>
      (!f.topic || i.topic_id === f.topic) &&
      (!q || `${i.title} ${i.summary} ${i.client_name}`.toLowerCase().includes(q)) &&
      (!f.product || (f.product === "none" ? !i.product_id : i.product_id === f.product)) &&
      (!f.client || i.client_id === f.client) &&
      (!f.statuses?.length || f.statuses.includes(i.status)) &&
      (f.severity === undefined || (i.severity ?? -1) >= f.severity) &&
      (!f.assignee || (f.assignee === "none" ? !i.assignee_id : i.assignee_id === f.assignee)) &&
      (!f.theme || (f.theme === "none" ? !i.theme_id : i.theme_id === f.theme)) &&
      (!f.days || Date.now() - Date.parse(i.last_seen_at) < f.days * 864e5),
  );
  list = [...list].sort((a, b) => {
    if (f.sort === "mentions" && a.mentions !== b.mentions) return b.mentions - a.mentions;
    if (f.sort === "severity" && a.severity !== b.severity) return (b.severity ?? -1) - (a.severity ?? -1);
    if (f.sort === "oldest") return a.first_seen_at.localeCompare(b.first_seen_at);
    const ca = isClosed(topicOf(a.topic_id), a.status) ? 1 : 0;
    const cb = isClosed(topicOf(b.topic_id), b.status) ? 1 : 0;
    return ca - cb || b.last_seen_at.localeCompare(a.last_seen_at);
  });
  const offset = f.offset ?? 0;
  return { total: list.length, items: list.slice(offset, offset + (f.limit ?? 50)).map(strip) };
}
function demoDetail(id: string): RadarItemDetail {
  const i = demo.items.find((x) => x.id === id);
  if (!i) throw Error("Item não encontrado.");
  return structuredClone({
    ...strip(i),
    topic: demo.topics.find((t) => t.id === i.topic_id)!,
    can_edit: true,
    client_products: [
      { id: "pd-3", name: "Social Leads" },
      { id: "pd-1", name: "Make Ads" },
    ],
    occurrences: i.occurrences,
    theme_options: demo.themes
      .filter((t) => t.topic_id === i.topic_id && t.product_id === i.product_id)
      .map((t) => ({ id: t.id, title: t.title })),
    tasks: i.tasks ?? [],
  });
}
function demoUpdate(id: string, patch: RadarPatch): RadarItemDetail {
  const i = demo.items.find((x) => x.id === id);
  if (!i) throw Error("Item não encontrado.");
  if (patch.status && patch.status !== i.status) i.status_at = new Date().toISOString();
  if (patch.product_id !== undefined)
    i.product_name =
      patch.product_id === "pd-3"
        ? "Social Leads"
        : patch.product_id === "pd-1"
          ? "Make Ads"
          : null;
  Object.assign(i, patch);
  return demoDetail(id);
}
function demoClient(client: string): ClientRadarData {
  const mine = demo.items.filter((i) => i.client_id === client);
  const list = mine.length ? mine : demo.items.filter((i) => i.client_id === "cl-1");
  return structuredClone({
    topics: demo.topics,
    items: list.map(strip),
    pending: 0,
    can_edit: true,
  });
}
function demoConfig(): RadarConfig {
  return {
    topics: demo.topics.map((t) => ({ ...t, items: demo.items.filter((i) => i.topic_id === t.id).length })),
    started_at: daysAgo(30),
    jev: { provider: "OpenRouter", model: "~typesafe/jev-latest" },
    model: null,
    stats: { done: 412, pending: 2, failed: 0, skipped: 37 },
    cost_30d: 3.84,
    backfill: demoBackfill,
  };
}
let demoBackfill: NonNullable<RadarConfig["backfill"]> | null = null;
let demoRules: AlertRule[] = [
  {
    id: "demo-rule-1",
    name: "Problemas sérios de Make Ads",
    topic_id: PROBLEMS,
    product_id: "pd-1",
    product_none: false,
    client_id: null,
    team_id: null,
    min_severity: 2,
    events: ["new", "reopened"],
    channel: "now",
    active: true,
    labels: { topic: "Problemas / reclamações", product: "Make Ads", client: null, team: null },
  },
];
function demoRuleLabels(r: AlertRule): NonNullable<AlertRule["labels"]> {
  return {
    topic: demo.topics.find((t) => t.id === r.topic_id)?.name ?? null,
    product: r.product_none ? "Geral / Agência" : (demoLabels({ products: r.product_id ? [r.product_id] : [] }).products[0] ?? null),
    client: null,
    team: null,
  };
}

// ------------------------------------------------------------ demonstração: relatórios
function demoMaterial(from: string, to: string, labels: ReportLabels): ReportMaterial {
  return {
    period: { from, to },
    today: dayKey(0),
    company: "Make Agency",
    filters: labels,
    topics: [
      { topic: "Problemas / reclamações", has_due: false, new: 14, active: 19, open: 11, closed: 6, severe: 4, overdue: 0, mentions: 41, clients: 9 },
      { topic: "Promessas", has_due: true, new: 9, active: 10, open: 5, closed: 4, severe: 2, overdue: 2, mentions: 12, clients: 7 },
    ],
    products: [
      { product: "Make Ads", clients: 6, topics: [
        { topic: "Problemas / reclamações", new: 9, open: 7, severe: 3, overdue: 0, closed: 3 },
        { topic: "Promessas", new: 5, open: 3, severe: 1, overdue: 1, closed: 2 },
      ] },
      { product: "Social Leads", clients: 4, topics: [
        { topic: "Problemas / reclamações", new: 4, open: 3, severe: 1, overdue: 0, closed: 2 },
        { topic: "Promessas", new: 3, open: 2, severe: 1, overdue: 1, closed: 1 },
      ] },
      { product: "Geral / Agência", clients: 2, topics: [
        { topic: "Problemas / reclamações", new: 1, open: 1, severe: 0, overdue: 0, closed: 1 },
      ] },
    ],
    themes: [
      { title: "Queda na quantidade e na qualidade dos leads", summary: "Clientes de Make Ads reclamam de menos leads e de leads frios.", topic: "Problemas / reclamações", product: "Make Ads", clients: 5, items: 6, open: 5, mentions: 14, max_severity: 3, client_names: ["Aurora Studio", "Norte Coffee", "Forma Living"], quotes: ["Os leads caíram de novo essa semana, o que está acontecendo?"] },
      { title: "Artes com a marca errada", summary: "Artes publicadas com logo ou cores antigas.", topic: "Problemas / reclamações", product: "Social Leads", clients: 2, items: 2, open: 1, mentions: 3, max_severity: 1, client_names: ["Norte Coffee", "Aurora Studio"], quotes: ["De novo o logo antigo na arte de hoje."] },
    ],
    severe: [
      { topic: "Problemas / reclamações", product: "Geral / Agência", client: "Forma Living", title: "Demora para responder no grupo", summary: "Esperou dois dias por uma resposta.", severity: 3, status: "Aberto", mentions: 1, last_seen: dayKey(0) },
      { topic: "Problemas / reclamações", product: "Make Ads", client: "Aurora Studio", title: "Leads caíram em setembro", summary: "Quer entender o motivo antes da próxima verba.", severity: 2, status: "Aberto", mentions: 2, last_seen: dayKey(1) },
    ],
    overdue: [
      { topic: "Promessas", product: "Social Leads", client: "Norte Coffee", title: "Refazer as artes sem custo", due_date: dayKey(1), status: "Em andamento", assignee: "Bruno Lima" },
      { topic: "Promessas", product: "Geral / Agência", client: "Forma Living", title: "Ligar com os números do mês", due_date: dayKey(7), status: "Pendente", assignee: null },
    ],
    clients: [
      { client: "Aurora Studio", open: 4, severe: 1, new: 3 },
      { client: "Norte Coffee", open: 3, severe: 1, new: 2 },
      { client: "Forma Living", open: 2, severe: 1, new: 2 },
    ],
    new_items: [],
    campaigns: {
      money: "com M",
      clients: [
        {
          client: "Aurora Studio", open: 4, severe: 1,
          items: [
            { topic: "Problemas / reclamações", product: "Make Ads", title: "Leads caíram em setembro", severity: 2, status: "Aberto", open: true },
            { topic: "Problemas / reclamações", product: "Social Leads", title: "Artes com a marca errada", severity: 1, status: "Em tratamento", open: true },
          ],
          campaigns: [
            {
              name: "Captação · Setembro", platform: "meta", product: "Make Ads", status: "active", objective: "lead",
              cycle: { start: dayKey(29), end: dayKey(-1), days: 31, elapsed: 30, goal: 120, budget: 4500, spent: 4230, results: 71, cost: 59.58, goal_cost: 37.5, expected: 4354.84, status: "bad" },
              period: { spend: 4230, results: 71, impressions: 182400, clicks: 3120, cost: 59.58 },
              previous: { spend: 4410, results: 118, cost: 37.37 },
            },
          ],
        },
        {
          client: "Norte Coffee", open: 3, severe: 1,
          items: [{ topic: "Problemas / reclamações", product: "Make Ads", title: "Leads frios, não respondem no WhatsApp", severity: 1, status: "Aberto", open: true }],
          campaigns: [
            {
              name: "Conversas · Loja", platform: "meta", product: "Make Ads", status: "active", objective: "message",
              cycle: { start: dayKey(29), end: dayKey(-1), days: 31, elapsed: 30, goal: 300, budget: 3000, spent: 2890, results: 342, cost: 8.45, goal_cost: 10, expected: 2903.23, status: "good" },
              period: { spend: 2890, results: 342, impressions: 96500, clicks: 2210, cost: 8.45 },
              previous: { spend: 2950, results: 311, cost: 9.49 },
            },
          ],
        },
      ],
      without: ["Forma Living"],
    },
  };
}
function demoContent(): ReportContent {
  return {
    headline: "A queda de leads em Make Ads virou padrão: 5 clientes reclamaram no período.",
    summary:
      "Foram 14 reclamações novas e 9 promessas no período. O tema que mais se repete é a queda na quantidade e na qualidade dos leads em Make Ads. Duas promessas estão vencidas e um cliente cobrou demora no atendimento com gravidade crítica.",
    sections: [
      {
        title: "Make Ads",
        paragraphs: [
          "A queda de leads aparece em 5 clientes, com falas de leads frios e de menos contatos pelos anúncios. Aurora Studio quer entender o motivo antes de aprovar a próxima verba.",
          "Das 5 promessas novas, 3 seguem em aberto e 1 está vencida.",
        ],
        bullets: [
          "Aurora Studio: explicar a queda de leads antes da próxima verba.",
          "Revisar a segmentação dos clientes com leads frios.",
        ],
      },
      {
        title: "Social Leads",
        paragraphs: ["As artes com a marca errada voltaram em 2 clientes; a agência prometeu refazer as artes sem custo, e o prazo já passou."],
        bullets: ["Norte Coffee: entregar as artes refeitas."],
      },
    ],
    crossings: [
      {
        client: "Aurora Studio",
        product: "Make Ads",
        problem: "Reclamou que os leads caíram em setembro e quer entender o motivo antes da próxima verba.",
        evidence: "Os números confirmam: 71 de 120 leads no ciclo, CPL de R$ 59,58 contra a meta de R$ 37,50, e 40% menos leads que no período anterior, com o gasto no ritmo.",
        solution: "Trocar os criativos em fadiga e revisar a segmentação esta semana; levar o diagnóstico com os números para a reunião antes de pedir a próxima verba.",
        priority: "alta",
      },
      {
        client: "Norte Coffee",
        product: "Make Ads",
        problem: "Diz que os leads chegam frios e não respondem no WhatsApp.",
        evidence: "A campanha está acima da meta: 342 conversas de 300, custo por conversa de R$ 8,45 contra R$ 10,00. O volume não é o problema.",
        solution: "Olhar a qualidade e o atendimento: revisar com o cliente o tempo de resposta às conversas e ajustar a pergunta de qualificação do anúncio.",
        priority: "média",
      },
      {
        client: "Forma Living",
        problem: "Cobrou dois dias sem resposta no grupo (gravidade crítica).",
        evidence: "Não tem campanha com ciclo no período; a queixa é de atendimento, não de mídia.",
        solution: "Responder hoje e combinar um responsável fixo pelo grupo.",
        priority: "alta",
      },
    ],
    actions: [
      { priority: "alta", text: "Responder hoje a Forma Living, que cobrou dois dias sem retorno no grupo.", product: "Geral / Agência" },
      { priority: "alta", text: "Revisar as campanhas dos 5 clientes de Make Ads com queda de leads e levar um diagnóstico para cada um.", product: "Make Ads" },
      { priority: "média", text: "Criar um checklist de marca antes de publicar as artes do Social Leads.", product: "Social Leads" },
      { priority: "baixa", text: "Combinar prazos das promessas com responsável em todas as reuniões." },
    ],
  };
}
let demoReports: RadarReportFull[] = [
  {
    id: "demo-report-1",
    title: `Radar do cliente · ${dateBr(dayKey(30))} a ${dateBr(dayKey(0))}`,
    period_from: dayKey(30),
    period_to: dayKey(0),
    filters: {},
    labels: { topics: [], products: [], teams: [], clients: [] },
    status: "done",
    error: null,
    requested_by: null,
    requested_by_name: "Allyson Assunção",
    schedule_id: null,
    schedule_name: null,
    headline: demoContent().headline,
    created_at: daysAgo(0, 9),
    finished_at: daysAgo(0, 9),
    cost_usd: 0.14,
    material: demoMaterial(dayKey(30), dayKey(0), { topics: [], products: [], teams: [], clients: [] }),
    content: demoContent(),
    model: "claude-opus-5-5",
  },
];
let demoSchedules: ReportSchedule[] = [
  {
    id: "demo-schedule-1",
    name: "Semanal da carteira",
    frequency: "weekly",
    weekday: 1,
    month_day: 1,
    hour: 8,
    period_days: 7,
    filters: {},
    labels: { topics: [], products: [], teams: [], clients: [] },
    active: true,
    next_run_at: daysAgo(-5, 8),
    last_run_at: daysAgo(2, 8),
  },
];
function demoLabels(filters: ReportFilters): ReportLabels {
  return {
    topics: (filters.topics ?? []).map((id) => demo.topics.find((t) => t.id === id)?.name ?? id),
    products: (filters.products ?? []).map((id) =>
      id === "none" ? "Geral / Agência" : id === "pd-1" ? "Make Ads" : id === "pd-2" ? "Make CRM" : id === "pd-3" ? "Social Leads" : id,
    ),
    teams: [],
    clients: [],
  };
}
function demoRequest(from: string, to: string, filters: ReportFilters, title?: string): RadarReport {
  const labels = demoLabels(filters);
  const report: RadarReportFull = {
    id: `demo-report-${Date.now()}`,
    title: title || `Radar do cliente · ${dateBr(from)} a ${dateBr(to)}`,
    period_from: from,
    period_to: to,
    filters,
    labels,
    status: "running",
    error: null,
    requested_by: null,
    requested_by_name: "Você",
    schedule_id: null,
    schedule_name: null,
    headline: null,
    created_at: new Date().toISOString(),
    finished_at: null,
    cost_usd: 0,
    material: null,
    content: null,
    model: null,
  };
  demoReports = [report, ...demoReports];
  // Na demonstração, a MAVI "escreve" em alguns segundos.
  setTimeout(() => {
    Object.assign(report, {
      status: "done",
      material: demoMaterial(from, to, labels),
      content: demoContent(),
      headline: demoContent().headline,
      finished_at: new Date().toISOString(),
      model: "claude-opus-5-5",
    });
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent("mavi:radar", { detail: { kind: "radar", report: report.id, status: "done" } }));
  }, 2500);
  const { material: _m, content: _c, model: _o, ...rest } = report; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}

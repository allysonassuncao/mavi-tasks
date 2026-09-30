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
  can_configure: boolean;
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
};
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
};
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
    can_configure: true,
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
  };
}

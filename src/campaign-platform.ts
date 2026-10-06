import { addDays, adsServer } from "./campaigns";

/**
 * Campanhas › Plataforma: the Meta ad account as the Ads Manager shows it —
 * campaigns, ad sets and ads, the columns and their presets, breakdowns and
 * the period — read live by /api/ads (api/_ads-platform.ts). Read only.
 * Nothing polls: a period or tab asks once, "Atualizar" asks again.
 */

export type PlatformLevel = "campaign" | "adset" | "ad";
export type Breakdown =
  | "age"
  | "gender"
  | "age_gender"
  | "country"
  | "region"
  | "platform"
  | "placement"
  | "device"
  | "day"
  | "week"
  | "month";
export type Metrics = Record<string, number | null>;
export type Delivery = {
  code: string;
  label: string;
  tone: "on" | "off" | "warn" | "bad";
};
export type PlatformRow = {
  id: string;
  name: string;
  level: PlatformLevel;
  delivery: Delivery;
  campaign_id: string;
  campaign_name: string;
  adset_id?: string;
  adset_name?: string;
  objective?: string;
  budget?:
    | { amount: number; period: "daily" | "lifetime" }
    | { shared: "campaign" | "adset" }
    | null;
  bid_strategy?: string;
  optimization?: string;
  start?: string | null;
  end?: string | null;
  attribution?: string;
  creative?: {
    thumbnail?: string;
    title?: string;
    body?: string;
    cta?: string;
    type?: string;
    link?: string;
  };
  rankings?: { quality: string; engagement: string; conversion: string };
  result_label: string;
  metrics: Metrics;
  breakdown?: { key: string; label: string; metrics: Metrics }[];
};
export type PlatformList = {
  account: { id: string; name: string; currency: string; timezone: string };
  rows: PlatformRow[];
  totals: Metrics;
  result_label: string;
  fetched_at: string;
};
export type PlatformQuery = {
  account: string;
  level: PlatformLevel;
  since: string;
  until: string;
  preset?: "maximum";
  campaigns?: string[];
  adsets?: string[];
  breakdown?: Breakdown;
  archived?: boolean;
};
export type PlatformDetail = {
  result_label: string;
  days: { day: string; metrics: Metrics }[];
  age_gender: { age: string; gender: string; metrics: Metrics }[];
  placements: { key: string; label: string; metrics: Metrics }[];
};
/** An ad set's audience, as api/_ads-audience.ts puts it. */
export type AudiencePlace = { kind: string; name: string; radius?: string };
export type AudienceDetailed = { category: string; items: string[] }[];
export type CustomAudience = { id: string; name: string; type?: string };
export type AdsetAudience = {
  id: string;
  name: string;
  delivery: Delivery;
  advantage: { audience: boolean; detailed: boolean; custom: boolean; lookalike: boolean };
  locations: { included: AudiencePlace[]; excluded: AudiencePlace[]; presence: string };
  age: { min: number; max: number; plus: boolean; suggested?: { min: number; max: number } };
  gender: string;
  languages: { count: number; names: string[] };
  /** AND between the groups, OR inside each group. */
  detailed: AudienceDetailed[];
  excluded_detailed: AudienceDetailed;
  custom: { included: CustomAudience[]; excluded: CustomAudience[] };
  placements: {
    automatic: boolean;
    platforms: string[];
    positions: { platform: string; items: string[] }[];
    devices: string[];
    os: string[];
    wifi_only: boolean;
  };
  /** null: Meta gave no estimate; absent: not asked (after the first ad sets). */
  estimate?: { lower: number; upper: number } | null;
  summary?: { label: string; items: string[] }[];
};
export type PlatformAudience = {
  level: PlatformLevel;
  adsets: AdsetAudience[];
  /** How many ad sets came with the estimate. */
  estimated: number;
  fetched_at: string;
};
export const PREVIEW_FORMATS: [string, string][] = [
  ["MOBILE_FEED_STANDARD", "Feed do Facebook (celular)"],
  ["DESKTOP_FEED_STANDARD", "Feed do Facebook (computador)"],
  ["INSTAGRAM_STANDARD", "Feed do Instagram"],
  ["INSTAGRAM_STORY", "Stories do Instagram"],
  ["INSTAGRAM_REELS", "Reels do Instagram"],
  ["FACEBOOK_STORY_MOBILE", "Stories do Facebook"],
  ["FACEBOOK_REELS_MOBILE", "Reels do Facebook"],
  ["MARKETPLACE_MOBILE", "Marketplace"],
  ["RIGHT_COLUMN_STANDARD", "Coluna da direita"],
];

export interface PlatformBackend {
  list(company: string, q: PlatformQuery): Promise<PlatformList>;
  detail(
    company: string,
    q: Omit<PlatformQuery, "campaigns" | "adsets" | "breakdown"> & { id: string },
  ): Promise<PlatformDetail>;
  preview(
    company: string,
    account: string,
    id: string,
    format: string,
  ): Promise<{ src: string | null }>;
  /** The audience of an ad set, of a campaign's ad sets or of an ad's ad set. */
  audience(
    company: string,
    q: { account: string; level: PlatformLevel; id: string },
  ): Promise<PlatformAudience>;
}

// ------------------------------------------------------------ cache
/**
 * The answers of this session, so going back and forth between tabs does
 * not ask Meta again (5 minutes); "Atualizar" skips it.
 */
const TTL = 5 * 60_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
export function cached<T>(
  key: string,
  load: () => Promise<T>,
  fresh = false,
): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 80) cache.delete(cache.keys().next().value!);
  return value;
}

export const serverPlatform: PlatformBackend = {
  list: (company, q) =>
    adsServer({ action: "platform", company, provider: "meta", ...q }),
  detail: (company, q) =>
    adsServer({ action: "platform-detail", company, provider: "meta", ...q }),
  preview: (company, account, id, format) =>
    adsServer({
      action: "platform-preview",
      company,
      provider: "meta",
      account,
      id,
      format,
    }),
  audience: (company, q) =>
    adsServer({ action: "platform-audience", company, provider: "meta", ...q }),
};

// ------------------------------------------------------------ periods
export type DatePreset =
  | "today"
  | "yesterday"
  | "last_7d"
  | "last_14d"
  | "last_28d"
  | "last_30d"
  | "this_month"
  | "last_month"
  | "cycle"
  | "maximum"
  | "custom";
export const DATE_PRESETS: [DatePreset, string][] = [
  ["today", "Hoje"],
  ["yesterday", "Ontem"],
  ["last_7d", "Últimos 7 dias"],
  ["last_14d", "Últimos 14 dias"],
  ["last_28d", "Últimos 28 dias"],
  ["last_30d", "Últimos 30 dias"],
  ["this_month", "Este mês"],
  ["last_month", "Mês passado"],
  ["cycle", "Ciclo atual"],
  ["maximum", "Máximo"],
  ["custom", "Personalizado"],
];
/** The Ads Manager's periods ("últimos N dias" end yesterday). */
export function presetRange(
  preset: DatePreset,
  today: string,
  cycle?: { start_date: string; end_date: string } | null,
): { since: string; until: string } | null {
  const yesterday = addDays(today, -1);
  const last = (n: number) => ({ since: addDays(today, -n), until: yesterday });
  const month = today.slice(0, 7);
  switch (preset) {
    case "today":
      return { since: today, until: today };
    case "yesterday":
      return { since: yesterday, until: yesterday };
    case "last_7d":
      return last(7);
    case "last_14d":
      return last(14);
    case "last_28d":
      return last(28);
    case "last_30d":
      return last(30);
    case "this_month":
      return { since: `${month}-01`, until: today };
    case "last_month": {
      const end = addDays(`${month}-01`, -1);
      return { since: `${end.slice(0, 7)}-01`, until: end };
    }
    case "cycle":
      return cycle
        ? {
            since: cycle.start_date,
            until: cycle.end_date < today ? cycle.end_date : today,
          }
        : null;
    default:
      return null;
  }
}

// ------------------------------------------------------------ columns
export type ColumnKind =
  | "money"
  | "count"
  | "percent"
  | "decimal"
  | "seconds"
  | "text";
export type Column = {
  id: string;
  label: string;
  kind: ColumnKind;
  /** Only at these levels (default: all). */
  levels?: PlatformLevel[];
  value?: (m: Metrics) => number | null;
};
const ratio = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || !b ? null : a / b;
const per = (key: string) => (m: Metrics) => ratio(m.spend, m[key]);
const pick = (key: string) => (m: Metrics) => m[key] ?? null;

export const COLUMNS: Column[] = [
  { id: "delivery", label: "Veiculação", kind: "text" },
  { id: "objective", label: "Objetivo", kind: "text", levels: ["campaign"] },
  {
    id: "optimization",
    label: "Otimização para veiculação",
    kind: "text",
    levels: ["adset"],
  },
  {
    id: "bid_strategy",
    label: "Estratégia de lance",
    kind: "text",
    levels: ["campaign", "adset"],
  },
  {
    id: "budget",
    label: "Orçamento",
    kind: "text",
    levels: ["campaign", "adset"],
  },
  { id: "attribution", label: "Configuração de atribuição", kind: "text" },
  { id: "results", label: "Resultados", kind: "count", value: pick("results") },
  { id: "reach", label: "Alcance", kind: "count", value: pick("reach") },
  {
    id: "frequency",
    label: "Frequência",
    kind: "decimal",
    value: (m) => ratio(m.impressions, m.reach),
  },
  {
    id: "cost_per_result",
    label: "Custo por resultado",
    kind: "money",
    value: per("results"),
  },
  { id: "spend", label: "Valor usado", kind: "money", value: pick("spend") },
  { id: "end", label: "Termina", kind: "text", levels: ["campaign", "adset"] },
  {
    id: "schedule",
    label: "Programação",
    kind: "text",
    levels: ["campaign", "adset"],
  },
  {
    id: "impressions",
    label: "Impressões",
    kind: "count",
    value: pick("impressions"),
  },
  {
    id: "cpm",
    label: "CPM (custo por 1.000 impressões)",
    kind: "money",
    value: (m) => {
      const r = ratio(m.spend, m.impressions);
      return r === null ? null : r * 1000;
    },
  },
  {
    id: "cpp",
    label: "Custo por 1.000 contas alcançadas",
    kind: "money",
    value: (m) => {
      const r = ratio(m.spend, m.reach);
      return r === null ? null : r * 1000;
    },
  },
  {
    id: "link_clicks",
    label: "Cliques no link",
    kind: "count",
    value: pick("link_clicks"),
  },
  {
    id: "cpc",
    label: "CPC (custo por clique no link)",
    kind: "money",
    value: per("link_clicks"),
  },
  {
    id: "ctr",
    label: "CTR (taxa de cliques no link)",
    kind: "percent",
    value: (m) => {
      const r = ratio(m.link_clicks, m.impressions);
      return r === null ? null : r * 100;
    },
  },
  { id: "clicks", label: "Cliques (todos)", kind: "count", value: pick("clicks") },
  {
    id: "ctr_all",
    label: "CTR (todos)",
    kind: "percent",
    value: (m) => {
      const r = ratio(m.clicks, m.impressions);
      return r === null ? null : r * 100;
    },
  },
  { id: "cpc_all", label: "CPC (todos)", kind: "money", value: per("clicks") },
  {
    id: "outbound_clicks",
    label: "Cliques de saída",
    kind: "count",
    value: pick("outbound_clicks"),
  },
  {
    id: "landing_page_views",
    label: "Visualizações da página de destino",
    kind: "count",
    value: pick("landing_page_views"),
  },
  {
    id: "cost_per_lpv",
    label: "Custo por visualização da página de destino",
    kind: "money",
    value: per("landing_page_views"),
  },
  { id: "leads", label: "Leads", kind: "count", value: pick("leads") },
  {
    id: "cost_per_lead",
    label: "Custo por lead",
    kind: "money",
    value: per("leads"),
  },
  {
    id: "messaging_started",
    label: "Conversas por mensagem iniciadas",
    kind: "count",
    value: pick("messaging_started"),
  },
  {
    id: "cost_per_message",
    label: "Custo por conversa por mensagem iniciada",
    kind: "money",
    value: per("messaging_started"),
  },
  {
    id: "messaging_replies",
    label: "Novos contatos de mensagem",
    kind: "count",
    value: pick("messaging_replies"),
  },
  { id: "purchases", label: "Compras", kind: "count", value: pick("purchases") },
  {
    id: "cost_per_purchase",
    label: "Custo por compra",
    kind: "money",
    value: per("purchases"),
  },
  {
    id: "purchase_value",
    label: "Valor de conversão de compras",
    kind: "money",
    value: pick("purchase_value"),
  },
  {
    id: "roas",
    label: "ROAS (retorno do investimento em anúncios) de compras",
    kind: "decimal",
    value: (m) => ratio(m.purchase_value, m.spend),
  },
  {
    id: "add_to_cart",
    label: "Adições ao carrinho",
    kind: "count",
    value: pick("add_to_cart"),
  },
  {
    id: "initiate_checkout",
    label: "Finalizações de compra iniciadas",
    kind: "count",
    value: pick("initiate_checkout"),
  },
  {
    id: "complete_registration",
    label: "Cadastros concluídos",
    kind: "count",
    value: pick("complete_registration"),
  },
  {
    id: "post_engagement",
    label: "Engajamento com a publicação",
    kind: "count",
    value: pick("post_engagement"),
  },
  {
    id: "cost_per_engagement",
    label: "Custo por engajamento com a publicação",
    kind: "money",
    value: per("post_engagement"),
  },
  {
    id: "page_engagement",
    label: "Engajamento com a Página",
    kind: "count",
    value: pick("page_engagement"),
  },
  {
    id: "reactions",
    label: "Reações à publicação",
    kind: "count",
    value: pick("reactions"),
  },
  {
    id: "comments",
    label: "Comentários na publicação",
    kind: "count",
    value: pick("comments"),
  },
  {
    id: "shares",
    label: "Compartilhamentos da publicação",
    kind: "count",
    value: pick("shares"),
  },
  {
    id: "saves",
    label: "Salvamentos da publicação",
    kind: "count",
    value: pick("saves"),
  },
  {
    id: "page_likes",
    label: "Curtidas da Página",
    kind: "count",
    value: pick("page_likes"),
  },
  {
    id: "video_views",
    label: "Reproduções de 3 segundos do vídeo",
    kind: "count",
    value: pick("video_views"),
  },
  { id: "thruplays", label: "ThruPlays", kind: "count", value: pick("thruplays") },
  {
    id: "cost_per_thruplay",
    label: "Custo por ThruPlay",
    kind: "money",
    value: per("thruplays"),
  },
  {
    id: "video_p25",
    label: "Reproduções do vídeo até 25%",
    kind: "count",
    value: pick("video_p25"),
  },
  {
    id: "video_p50",
    label: "Reproduções do vídeo até 50%",
    kind: "count",
    value: pick("video_p50"),
  },
  {
    id: "video_p75",
    label: "Reproduções do vídeo até 75%",
    kind: "count",
    value: pick("video_p75"),
  },
  {
    id: "video_p95",
    label: "Reproduções do vídeo até 95%",
    kind: "count",
    value: pick("video_p95"),
  },
  {
    id: "video_p100",
    label: "Reproduções do vídeo até 100%",
    kind: "count",
    value: pick("video_p100"),
  },
  {
    id: "video_avg",
    label: "Tempo médio de reprodução do vídeo",
    kind: "seconds",
    value: (m) => ratio(m.video_time_total, m.video_plays),
  },
  {
    id: "quality_ranking",
    label: "Classificação de qualidade",
    kind: "text",
    levels: ["ad"],
  },
  {
    id: "engagement_ranking",
    label: "Classificação da taxa de engajamento",
    kind: "text",
    levels: ["ad"],
  },
  {
    id: "conversion_ranking",
    label: "Classificação da taxa de conversão",
    kind: "text",
    levels: ["ad"],
  },
  // MakeCRM: the deals its UTMs give each row (src/platform-crm.ts).
  { id: "crm_leads", label: "Oportunidades (CRM)", kind: "count", value: pick("crm_leads") },
  {
    id: "crm_cost_per_lead",
    label: "Custo por oportunidade (CRM)",
    kind: "money",
    value: per("crm_leads"),
  },
  { id: "crm_wons", label: "Ganhos (CRM)", kind: "count", value: pick("crm_wons") },
  { id: "crm_cost_per_won", label: "Custo por ganho (CRM)", kind: "money", value: per("crm_wons") },
  { id: "crm_revenue", label: "Receita (CRM)", kind: "money", value: pick("crm_revenue") },
  {
    id: "crm_roas",
    label: "ROAS (CRM)",
    kind: "decimal",
    value: (m) => ratio(m.crm_revenue, m.spend),
  },
];
export const columnById = new Map(COLUMNS.map((c) => [c.id, c]));

export type ColumnPreset =
  | "desempenho"
  | "desempenho_cliques"
  | "veiculacao"
  | "engajamento"
  | "video"
  | "mensagens"
  | "leads"
  | "vendas"
  | "crm"
  | "personalizado";
export const PRESETS: { id: ColumnPreset; label: string; columns: string[] }[] = [
  {
    id: "desempenho",
    label: "Desempenho",
    columns: [
      "delivery",
      "bid_strategy",
      "budget",
      "attribution",
      "results",
      "reach",
      "impressions",
      "cost_per_result",
      "spend",
      "end",
      "schedule",
    ],
  },
  {
    id: "desempenho_cliques",
    label: "Desempenho e cliques",
    columns: [
      "delivery",
      "results",
      "reach",
      "frequency",
      "cost_per_result",
      "budget",
      "spend",
      "end",
      "schedule",
      "impressions",
      "cpm",
      "link_clicks",
      "cpc",
      "ctr",
      "clicks",
      "ctr_all",
      "cpc_all",
    ],
  },
  {
    id: "veiculacao",
    label: "Veiculação",
    columns: [
      "delivery",
      "reach",
      "frequency",
      "cpp",
      "impressions",
      "cpm",
      "spend",
      "end",
      "schedule",
      "quality_ranking",
      "engagement_ranking",
      "conversion_ranking",
    ],
  },
  {
    id: "engajamento",
    label: "Engajamento",
    columns: [
      "delivery",
      "post_engagement",
      "cost_per_engagement",
      "page_engagement",
      "reactions",
      "comments",
      "shares",
      "saves",
      "page_likes",
      "link_clicks",
      "cpc",
      "ctr",
      "spend",
    ],
  },
  {
    id: "video",
    label: "Engajamento com o vídeo",
    columns: [
      "delivery",
      "spend",
      "impressions",
      "video_views",
      "thruplays",
      "cost_per_thruplay",
      "video_p25",
      "video_p50",
      "video_p75",
      "video_p95",
      "video_p100",
      "video_avg",
    ],
  },
  {
    id: "mensagens",
    label: "Mensagens",
    columns: [
      "delivery",
      "results",
      "cost_per_result",
      "messaging_started",
      "cost_per_message",
      "messaging_replies",
      "link_clicks",
      "reach",
      "spend",
    ],
  },
  {
    id: "leads",
    label: "Cadastros (leads)",
    columns: [
      "delivery",
      "results",
      "cost_per_result",
      "leads",
      "cost_per_lead",
      "landing_page_views",
      "cost_per_lpv",
      "link_clicks",
      "cpc",
      "ctr",
      "spend",
    ],
  },
  {
    id: "vendas",
    label: "Vendas",
    columns: [
      "delivery",
      "results",
      "cost_per_result",
      "purchases",
      "cost_per_purchase",
      "purchase_value",
      "roas",
      "add_to_cart",
      "initiate_checkout",
      "landing_page_views",
      "spend",
    ],
  },
  {
    id: "crm",
    label: "Resultado no CRM",
    columns: [
      "delivery",
      "results",
      "cost_per_result",
      "spend",
      "crm_leads",
      "crm_cost_per_lead",
      "crm_wons",
      "crm_cost_per_won",
      "crm_revenue",
      "crm_roas",
    ],
  },
];
export const BREAKDOWN_GROUPS: { label: string; items: [Breakdown, string][] }[] = [
  {
    label: "Por tempo",
    items: [
      ["day", "Dia"],
      ["week", "Semana"],
      ["month", "Mês"],
    ],
  },
  {
    label: "Por veiculação",
    items: [
      ["age", "Idade"],
      ["gender", "Gênero"],
      ["age_gender", "Idade e gênero"],
      ["country", "País"],
      ["region", "Região"],
      ["platform", "Plataforma"],
      ["placement", "Posicionamento"],
      ["device", "Dispositivo de impressão"],
    ],
  },
];
export const RANKING: Record<string, string> = {
  ABOVE_AVERAGE: "Acima da média",
  AVERAGE: "Na média",
  BELOW_AVERAGE_35: "Abaixo da média (35% inferiores)",
  BELOW_AVERAGE_20: "Abaixo da média (20% inferiores)",
  BELOW_AVERAGE_10: "Abaixo da média (10% inferiores)",
  UNKNOWN: "—",
};

// ------------------------------------------------------------ formatting
export function formatValue(
  kind: ColumnKind,
  value: number | null | undefined,
  currency = "BRL",
) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  switch (kind) {
    case "money":
      return value.toLocaleString("pt-BR", { style: "currency", currency });
    case "percent":
      return `${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    case "decimal":
      return value.toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    case "seconds": {
      const s = Math.round(value);
      return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
    }
    default:
      return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  }
}
const shortDay = (iso: string) => {
  const d = iso.slice(0, 10);
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
};
/** The text columns, as the Ads Manager words them. */
export function textValue(
  id: string,
  row: PlatformRow,
  currency: string,
): string {
  switch (id) {
    case "delivery":
      return row.delivery.label;
    case "objective":
      return row.objective ?? "—";
    case "optimization":
      return row.optimization ?? "—";
    case "bid_strategy":
      return row.budget && "shared" in row.budget && row.budget.shared === "campaign"
        ? "Usando a estratégia de lance da campanha"
        : row.bid_strategy || "—";
    case "budget":
      if (!row.budget) return "—";
      if ("shared" in row.budget)
        return row.budget.shared === "campaign"
          ? "Usando o orçamento da campanha"
          : "Usando o orçamento do conjunto de anúncios";
      return `${formatValue("money", row.budget.amount, currency)} ${
        row.budget.period === "daily" ? "Diário" : "Total"
      }`;
    case "attribution":
      return row.attribution || "—";
    case "end":
      return row.end ? shortDay(row.end) : row.level === "ad" ? "—" : "Contínuo";
    case "schedule":
      return row.start
        ? `${shortDay(row.start)} – ${row.end ? shortDay(row.end) : "Contínuo"}`
        : "—";
    case "quality_ranking":
      return RANKING[row.rankings?.quality ?? ""] ?? "—";
    case "engagement_ranking":
      return RANKING[row.rankings?.engagement ?? ""] ?? "—";
    case "conversion_ranking":
      return RANKING[row.rankings?.conversion ?? ""] ?? "—";
    default:
      return "—";
  }
}
/** The value a column sorts by. */
export function sortValue(c: Column, row: PlatformRow, currency: string) {
  if (c.kind !== "text") return c.value?.(row.metrics) ?? -Infinity;
  if (c.id === "budget" && row.budget && "amount" in row.budget)
    return row.budget.amount;
  return textValue(c.id, row, currency);
}
/** The footer's value (text columns stay empty; results only if same kind). */
export function totalValue(c: Column, list: PlatformList) {
  if (c.kind === "text" || !c.value) return null;
  return c.value(list.totals);
}
export const levelLabel: Record<PlatformLevel, [string, string]> = {
  campaign: ["Campanhas", "campanha"],
  adset: ["Conjuntos de anúncios", "conjunto de anúncios"],
  ad: ["Anúncios", "anúncio"],
};

// ------------------------------------------------------------ demonstration
/**
 * The demonstration's ad account: a few campaigns, ad sets and ads with
 * numbers that follow the period (the same every time for the same period).
 */
function seeded(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
export const DEMO_CAMPAIGNS = [
  { id: "120210000000000001", name: "[Leads] Formulário · Público aberto", goal: "Leads no formulário", objective: "Cadastros", status: "ACTIVE" },
  { id: "120210000000000002", name: "[Mensagens] WhatsApp · Remarketing", goal: "Conversas por mensagem iniciadas", objective: "Engajamento", status: "ACTIVE" },
  { id: "120210000000000003", name: "[Tráfego] Blog · Interesses", goal: "Cliques no link", objective: "Tráfego", status: "PAUSED" },
  { id: "120210000000000004", name: "[Reconhecimento] Vídeo institucional", goal: "ThruPlays", objective: "Reconhecimento", status: "ACTIVE" },
];
export const DEMO_ADSETS = ["Aberto 25-54", "Semelhante 1% clientes", "Remarketing 30 dias"];
export const DEMO_ADS = ["Vídeo depoimento", "Carrossel benefícios", "Imagem oferta", "Reels bastidores"];
function demoMetrics(rand: () => number, days: number, goal: string, scale: number): Metrics {
  const spend = Math.round((40 + rand() * 90) * days * scale * 100) / 100;
  const impressions = Math.round(spend * (55 + rand() * 40));
  const reach = Math.round(impressions / (1.2 + rand() * 0.9));
  const link = Math.round(impressions * (0.008 + rand() * 0.012));
  const clicks = Math.round(link * (1.3 + rand() * 0.5));
  const leads = Math.round(link * (0.08 + rand() * 0.1));
  const conversations = Math.round(link * (0.2 + rand() * 0.2));
  const plays = Math.round(impressions * (0.25 + rand() * 0.2));
  const thru = Math.round(plays * (0.2 + rand() * 0.2));
  const results =
    goal === "Leads no formulário"
      ? leads
      : goal === "Conversas por mensagem iniciadas"
        ? conversations
        : goal === "ThruPlays"
          ? thru
          : link;
  return {
    spend, impressions, reach, clicks, link_clicks: link, unique_link_clicks: Math.round(link * 0.9),
    outbound_clicks: Math.round(link * 0.95), results,
    leads: goal === "Leads no formulário" ? leads : 0,
    landing_page_views: goal === "Cliques no link" ? Math.round(link * 0.7) : 0,
    purchases: 0, purchase_value: 0, add_to_cart: 0, initiate_checkout: 0, complete_registration: 0,
    messaging_started: goal === "Conversas por mensagem iniciadas" ? conversations : 0,
    messaging_replies: goal === "Conversas por mensagem iniciadas" ? Math.round(conversations * 0.7) : 0,
    post_engagement: Math.round(impressions * 0.03), page_engagement: Math.round(impressions * 0.032),
    reactions: Math.round(impressions * 0.006), comments: Math.round(impressions * 0.0008),
    shares: Math.round(impressions * 0.0005), saves: Math.round(impressions * 0.0004), page_likes: Math.round(impressions * 0.0003),
    video_views: plays, video_plays: plays, thruplays: thru, video_p25: Math.round(plays * 0.55),
    video_p50: Math.round(plays * 0.35), video_p75: Math.round(plays * 0.22), video_p95: Math.round(plays * 0.14),
    video_p100: Math.round(plays * 0.11), video_time_total: plays * (4 + rand() * 6),
  };
}
const sumMetrics = (list: Metrics[]) =>
  list.reduce<Metrics>((acc, m) => {
    for (const [k, v] of Object.entries(m))
      acc[k] = acc[k] === null || v === null ? null : (acc[k] ?? 0) + v;
    return acc;
  }, {});
function daysIn(q: PlatformQuery) {
  if (q.preset) return 180;
  return Math.max(1, Math.round((Date.parse(q.until) - Date.parse(q.since)) / 86_400_000) + 1);
}
export function demoPlatform(linked: string[] = []): PlatformBackend {
  const build = (q: PlatformQuery) => {
    const days = daysIn(q);
    const rows: PlatformRow[] = [];
    DEMO_CAMPAIGNS.forEach((c, ci) => {
      const cid = ci === 0 && linked[0] ? linked[0] : c.id;
      if (q.campaigns?.length && !q.campaigns.includes(cid)) return;
      const paused = c.status === "PAUSED";
      const campaignRand = seeded(`${cid}${q.since}${q.until}`);
      const scale = paused ? 0.05 : 1 - ci * 0.18;
      DEMO_ADSETS.forEach((s, si) => {
        const sid = `${cid}${si}1`;
        if (q.level !== "campaign" && q.adsets?.length && !q.adsets.includes(sid)) return;
        DEMO_ADS.slice(0, 2 + ((ci + si) % 3)).forEach((a, ai) => {
          const id = `${sid}${ai}`;
          const m = demoMetrics(seeded(`${id}${q.since}${q.until}`), days, c.goal, scale / 6);
          rows.push({
            id,
            name: `${a} · ${s}`,
            level: "ad",
            delivery: paused
              ? { code: "CAMPAIGN_PAUSED", label: "Campanha desativada", tone: "off" }
              : ai === 2
                ? { code: "PAUSED", label: "Desativado", tone: "off" }
                : { code: "ACTIVE", label: "Ativo", tone: "on" },
            campaign_id: cid,
            campaign_name: c.name,
            adset_id: sid,
            adset_name: s,
            creative: {
              title: a,
              body: "Conheça a solução que já ajudou centenas de clientes. Fale com a gente!",
              cta: "LEARN_MORE",
              type: ai === 0 ? "VIDEO" : "SHARE",
            },
            rankings: {
              quality: ["ABOVE_AVERAGE", "AVERAGE", "BELOW_AVERAGE_35"][ai % 3],
              engagement: ["AVERAGE", "ABOVE_AVERAGE", "AVERAGE"][ai % 3],
              conversion: ["AVERAGE", "BELOW_AVERAGE_20", "ABOVE_AVERAGE"][ai % 3],
            },
            attribution: "7 dias após o clique ou 1 dia após a visualização",
            result_label: c.goal,
            metrics: m,
          });
        });
      });
      void campaignRand;
    });
    const group = (level: "campaign" | "adset") => {
      const map = new Map<string, PlatformRow[]>();
      for (const r of rows) {
        const key = level === "campaign" ? r.campaign_id : r.adset_id!;
        map.set(key, [...(map.get(key) ?? []), r]);
      }
      return [...map.entries()].map(([id, list]): PlatformRow => {
        const first = list[0];
        const c = DEMO_CAMPAIGNS.find((x) => first.campaign_name === x.name)!;
        const paused = c.status === "PAUSED";
        const m = sumMetrics(list.map((r) => r.metrics));
        m.reach = Math.round((m.reach ?? 0) * 0.8);
        return {
          id,
          name: level === "campaign" ? first.campaign_name : first.adset_name!,
          level,
          delivery: paused
            ? { code: "PAUSED", label: "Desativado", tone: "off" }
            : level === "adset" && id.endsWith("21")
              ? { code: "LEARNING", label: "Aprendizado", tone: "on" }
              : { code: "ACTIVE", label: "Ativo", tone: "on" },
          campaign_id: first.campaign_id,
          campaign_name: first.campaign_name,
          objective: level === "campaign" ? c.objective : undefined,
          optimization: level === "adset" ? c.goal : undefined,
          budget:
            level === "campaign"
              ? c.id.endsWith("1")
                ? { amount: 150, period: "daily" }
                : { shared: "adset" }
              : c.id.endsWith("1")
                ? { shared: "campaign" }
                : { amount: 50, period: "daily" },
          bid_strategy: "Maior volume",
          start: "2026-08-01T00:00:00-0300",
          end: c.id.endsWith("4") ? "2026-12-31T23:59:00-0300" : null,
          attribution: "7 dias após o clique ou 1 dia após a visualização",
          result_label: c.goal,
          metrics: m,
        };
      });
    };
    const list =
      q.level === "ad" ? rows : group(q.level);
    if (q.breakdown)
      for (const r of list) {
        const rand = seeded(`${r.id}${q.breakdown}`);
        const keys: [string, string][] =
          q.breakdown === "age"
            ? ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"].map((k) => [k, k])
            : q.breakdown === "gender"
              ? [["female", "Feminino"], ["male", "Masculino"], ["unknown", "Desconhecido"]]
              : q.breakdown === "placement"
                ? [["fb|feed", "Facebook · Feed"], ["ig|feed", "Instagram · Feed"], ["ig|story", "Instagram · Stories"], ["ig|reels", "Instagram · Reels"]]
                : q.breakdown === "platform"
                  ? [["facebook", "Facebook"], ["instagram", "Instagram"]]
                  : q.breakdown === "device"
                    ? [["android_smartphone", "Celular Android"], ["iphone", "iPhone"], ["desktop", "Computador"]]
                    : [["a", "Parte 1"], ["b", "Parte 2"]];
        const weights = keys.map(() => 0.3 + rand());
        const total = weights.reduce((s, w) => s + w, 0);
        r.breakdown = keys.map(([key, label], i) => ({
          key,
          label,
          metrics: Object.fromEntries(
            Object.entries(r.metrics).map(([k, v]) => [
              k,
              v === null ? null : Math.round(v * (weights[i] / total) * 100) / 100,
            ]),
          ),
        }));
      }
    const totals = sumMetrics(list.map((r) => r.metrics));
    totals.reach = Math.round((totals.reach ?? 0) * 0.75);
    const labels = new Set(list.map((r) => r.result_label));
    if (labels.size > 1) totals.results = null;
    return {
      account: { id: q.account, name: "Conta de demonstração", currency: "BRL", timezone: "America/Sao_Paulo" },
      rows: list,
      totals,
      result_label: labels.size === 1 ? [...labels][0] : "Vários",
      fetched_at: new Date().toISOString(),
    } satisfies PlatformList;
  };
  const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 250));
  return {
    list: (_company, q) => wait(build(q)),
    detail: (_company, q) => {
      const range = q.preset ? { since: addDays(q.until || q.since, -29), until: q.until || q.since } : q;
      const days: { day: string; metrics: Metrics }[] = [];
      for (let d = range.since; d <= range.until && days.length < 120; d = addDays(d, 1))
        days.push({ day: d, metrics: demoMetrics(seeded(`${q.id}${d}`), 1, "Leads no formulário", 0.4) });
      const all = sumMetrics(days.map((x) => x.metrics));
      const part = (w: number) =>
        Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v === null ? null : Math.round(v * w)]));
      return wait({
        result_label: "Leads no formulário",
        days,
        age_gender: ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"].flatMap((age, i) =>
          ["female", "male"].map((gender, j) => ({
            age,
            gender,
            metrics: part([0.05, 0.12, 0.1, 0.08, 0.05, 0.02][i] * (j ? 0.8 : 1.2)),
          })),
        ),
        placements: [
          { key: "ig|feed", label: "Instagram · Feed", metrics: part(0.34) },
          { key: "fb|feed", label: "Facebook · Feed", metrics: part(0.28) },
          { key: "ig|story", label: "Instagram · Stories", metrics: part(0.21) },
          { key: "ig|reels", label: "Instagram · Reels", metrics: part(0.17) },
        ],
      });
    },
    preview: () => wait({ src: null }),
    audience: (_company, q) => {
      // The demo's ids end in <ad set index><1 or the ad index>.
      const sets = q.level === "campaign" ? DEMO_ADSETS : [DEMO_ADSETS[Number(q.id.slice(-2, -1))] ?? DEMO_ADSETS[0]];
      return wait({
        level: q.level,
        adsets: sets.map((name, i) => demoAudience(q.level === "campaign" ? `${q.id}${i}1` : q.id, name)),
        estimated: sets.length,
        fetched_at: new Date().toISOString(),
      } satisfies PlatformAudience);
    },
  };
}

/** The demo report's ad sets ("Aberto 25-54", "Remarketing 30 dias"). */
export const demoAudiences = () =>
  [DEMO_ADSETS[0], DEMO_ADSETS[2]].map((name) => demoAudience(`demo-set-${name}`, name));
function demoAudience(id: string, name: string): AdsetAudience {
  const open = name.startsWith("Aberto");
  const lookalike = name.startsWith("Semelhante");
  return {
    id,
    name,
    delivery: { code: "ACTIVE", label: "Ativo", tone: "on" },
    advantage: { audience: open, detailed: !open && !lookalike, custom: false, lookalike: false },
    locations: {
      included: [
        { kind: "Cidade", name: "São Paulo, São Paulo, Brasil", radius: "+25 km" },
        { kind: "Cidade", name: "Campinas, São Paulo, Brasil", radius: "+17 km" },
      ],
      excluded: lookalike ? [{ kind: "CEP", name: "01310-000, São Paulo" }] : [],
      presence: "Pessoas que moram ou estiveram recentemente nestes locais",
    },
    age: open ? { min: 18, max: 65, plus: true, suggested: { min: 25, max: 54 } } : { min: 25, max: 54, plus: false },
    gender: "Todos os gêneros",
    languages: { count: 1, names: ["Português (Brasil)"] },
    detailed: open || lookalike
      ? []
      : [
          [
            { category: "Interesses", items: ["Empreendedorismo", "Pequenas empresas", "Marketing digital"] },
            { category: "Comportamentos", items: ["Administradores de páginas de empresas"] },
          ],
          [{ category: "Cargos", items: ["Proprietário", "Diretor"] }],
        ],
    excluded_detailed: open || lookalike ? [] : [{ category: "Interesses", items: ["Concursos públicos"] }],
    custom: lookalike
      ? {
          included: [{ id: "1", name: "Semelhante (BR, 1%) – Clientes 2026", type: "Semelhante" }],
          excluded: [{ id: "2", name: "Clientes ativos (lista)", type: "Lista de clientes" }],
        }
      : name.startsWith("Remarketing")
        ? {
            included: [
              { id: "3", name: "Visitantes do site 30 dias", type: "Site" },
              { id: "4", name: "Envolvimento Instagram 30 dias", type: "Envolvimento" },
            ],
            excluded: [{ id: "5", name: "Leads 30 dias", type: "Site" }],
          }
        : { included: [], excluded: [] },
    placements: open
      ? { automatic: true, platforms: [], positions: [], devices: [], os: [], wifi_only: false }
      : {
          automatic: false,
          platforms: ["Facebook", "Instagram"],
          positions: [
            { platform: "Facebook", items: ["Feed", "Stories", "Reels"] },
            { platform: "Instagram", items: ["Feed", "Stories", "Reels", "Explorar"] },
          ],
          devices: ["Celular"],
          os: [],
          wifi_only: false,
        },
    estimate: open ? { lower: 4_200_000, upper: 4_900_000 } : lookalike ? { lower: 1_300_000, upper: 1_600_000 } : { lower: 380_000, upper: 450_000 },
  };
}

import { adsServer } from "./campaigns";
import type { ColumnKind } from "./campaign-platform";

/**
 * Campanhas › Plataforma (Google Ads): the account as the Google Ads
 * interface shows it — campaigns, ad groups, ads, assets, asset groups,
 * keywords, search terms, negatives, audiences and segments, auction —
 * read live by /api/ads (api/_ads-google-platform.ts). Read only.
 */

export type GoogleView =
  | "campaigns"
  | "ad_groups"
  | "ads"
  | "assets"
  | "keywords"
  | "search_terms"
  | "negatives"
  | "asset_groups"
  | "age"
  | "gender"
  | "devices"
  | "locations"
  | "day_of_week"
  | "hour"
  | "auction";
export type GoogleSegment = "date" | "week" | "month" | "device" | "network" | "day_of_week";
export type Metrics = Record<string, number | null>;
export type GoogleStatus = { code: string; label: string; tone: "on" | "off" | "warn" | "bad" };
export type GoogleAsset = {
  type: string;
  text?: string;
  image?: string;
  video?: string;
  performance: string;
  status: string;
};
export type GoogleRow = {
  id: string;
  name: string;
  sub?: string;
  status: GoogleStatus;
  enabled: boolean | null;
  campaign_id?: string;
  ad_group_id?: string;
  info: Record<string, string | number | null>;
  metrics: Metrics | null;
  segments?: { key: string; label: string; metrics: Metrics }[];
  preview?: {
    headlines: string[];
    descriptions: string[];
    final_url?: string;
    path?: string;
    business?: string;
    images: string[];
    videos: string[];
    assets?: GoogleAsset[];
  };
};
export type GoogleList = {
  account: { id: string; name: string; currency: string; timezone: string };
  view: GoogleView;
  rows: GoogleRow[];
  totals: Metrics | null;
  notice?: string;
  fetched_at: string;
};
export type GoogleQuery = {
  account: string;
  manager: string;
  view: GoogleView;
  since: string;
  until: string;
  campaigns: string[];
  ad_groups: string[];
  segment?: GoogleSegment;
  geo?: "city" | "region" | "country";
  removed?: boolean;
};
export type GoogleDetail = {
  days: { day: string; metrics: Metrics }[];
  devices: { key: string; label: string; metrics: Metrics }[];
};
export interface GooglePlatformBackend {
  list(company: string, q: GoogleQuery): Promise<GoogleList>;
  detail(company: string, q: GoogleQuery & { id: string }): Promise<GoogleDetail>;
}
export const serverGooglePlatform: GooglePlatformBackend = {
  list: (company, q) => adsServer({ action: "google-platform", company, provider: "google", ...q }),
  detail: (company, q) =>
    adsServer({ action: "google-platform-detail", company, provider: "google", ...q }),
};

// ------------------------------------------------------------ the menu
/** The left menu, as the Google Ads interface groups it. */
export const MENU: { label?: string; items: [GoogleView, string][] }[] = [
  {
    items: [
      ["campaigns", "Campanhas"],
      ["ad_groups", "Grupos de anúncios"],
      ["ads", "Anúncios"],
      ["assets", "Recursos"],
      ["asset_groups", "Grupos de recursos"],
    ],
  },
  {
    label: "Palavras-chave",
    items: [
      ["keywords", "Palavras-chave de pesquisa"],
      ["search_terms", "Termos de pesquisa"],
      ["negatives", "Palavras-chave negativas"],
    ],
  },
  {
    label: "Públicos e segmentos",
    items: [
      ["age", "Idade"],
      ["gender", "Gênero"],
      ["devices", "Dispositivos"],
      ["locations", "Locais"],
      ["day_of_week", "Dia da semana"],
      ["hour", "Hora do dia"],
    ],
  },
  { label: "Insights", items: [["auction", "Informações de leilão"]] },
];
export const viewLabel = Object.fromEntries(MENU.flatMap((g) => g.items)) as Record<GoogleView, string>;
/** What a row is called, for the footer ("Total: 3 campanhas"). */
export const rowNoun: Record<GoogleView, [string, string]> = {
  campaigns: ["campanha", "campanhas"],
  ad_groups: ["grupo de anúncios", "grupos de anúncios"],
  ads: ["anúncio", "anúncios"],
  assets: ["recurso", "recursos"],
  asset_groups: ["grupo de recursos", "grupos de recursos"],
  keywords: ["palavra-chave", "palavras-chave"],
  search_terms: ["termo de pesquisa", "termos de pesquisa"],
  negatives: ["palavra-chave negativa", "palavras-chave negativas"],
  age: ["faixa etária", "faixas etárias"],
  gender: ["gênero", "gêneros"],
  devices: ["dispositivo", "dispositivos"],
  locations: ["local", "locais"],
  day_of_week: ["dia", "dias"],
  hour: ["hora", "horas"],
  auction: ["linha", "linhas"],
};
/** The first column's heading. */
export const nameHeading: Record<GoogleView, string> = {
  campaigns: "Campanha",
  ad_groups: "Grupo de anúncios",
  ads: "Anúncio",
  assets: "Recurso",
  asset_groups: "Grupo de recursos",
  keywords: "Palavra-chave",
  search_terms: "Termo de pesquisa",
  negatives: "Palavra-chave negativa",
  age: "Idade",
  gender: "Gênero",
  devices: "Dispositivo",
  locations: "Local",
  day_of_week: "Dia da semana",
  hour: "Hora do dia",
  auction: "Domínio de exibição do URL",
};
/** Views whose rows have numbers, a toggle, segments. */
export const withMetrics = (v: GoogleView) => v !== "negatives";
export const withToggle = (v: GoogleView) =>
  ["campaigns", "ad_groups", "ads", "assets", "keywords", "asset_groups"].includes(v);
export const SEGMENTABLE: GoogleView[] = ["campaigns", "ad_groups", "ads", "keywords", "search_terms", "asset_groups"];
export const DETAILABLE: GoogleView[] = ["campaigns", "ad_groups", "ads", "keywords", "asset_groups"];
export const SEGMENTS: [GoogleSegment, string][] = [
  ["date", "Dia"],
  ["week", "Semana"],
  ["month", "Mês"],
  ["device", "Dispositivo"],
  ["network", "Rede (com parceiros de pesquisa)"],
  ["day_of_week", "Dia da semana"],
];

// ------------------------------------------------------------ columns
export type GColumn = {
  id: string;
  label: string;
  kind: ColumnKind;
  /** Numbers from the metrics; text from the row. */
  value?: (m: Metrics) => number | null;
  text?: (r: GoogleRow) => string | number | null;
  /** Numbers kept as they are in the row (quality score, bids). */
  info?: string;
  /** Only in these views (default: every view with numbers). */
  views?: GoogleView[];
};
const ratio = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || !b ? null : a / b;
const pct = (a: number | null | undefined, b: number | null | undefined) => {
  const r = ratio(a, b);
  return r === null ? null : r * 100;
};
const pick = (k: string) => (m: Metrics) => m[k] ?? null;
/** The views whose rows are campaigns or ad (asset) groups: the CRM's UTMs. */
export const CRM_VIEWS: GoogleView[] = ["campaigns", "ad_groups", "asset_groups"];
export const METRIC_COLUMNS: GColumn[] = [
  { id: "clicks", label: "Cliques", kind: "count", value: pick("clicks") },
  { id: "impressions", label: "Impr.", kind: "count", value: pick("impressions") },
  { id: "ctr", label: "CTR", kind: "percent", value: (m) => pct(m.clicks, m.impressions) },
  { id: "cpc", label: "CPC méd.", kind: "money", value: (m) => ratio(m.cost, m.clicks) },
  { id: "cost", label: "Custo", kind: "money", value: pick("cost") },
  { id: "conversions", label: "Conversões", kind: "decimal", value: pick("conversions") },
  { id: "cost_per_conv", label: "Custo/conv.", kind: "money", value: (m) => ratio(m.cost, m.conversions) },
  { id: "conv_rate", label: "Taxa de conv.", kind: "percent", value: (m) => pct(m.conversions, m.interactions) },
  { id: "conversions_value", label: "Valor conv.", kind: "money", value: pick("conversions_value") },
  { id: "value_per_cost", label: "Valor conv./custo", kind: "decimal", value: (m) => ratio(m.conversions_value, m.cost) },
  { id: "all_conversions", label: "Todas as conv.", kind: "decimal", value: pick("all_conversions") },
  { id: "view_through", label: "Conv. view-through", kind: "count", value: pick("view_through_conversions") },
  { id: "interactions", label: "Interações", kind: "count", value: pick("interactions") },
  { id: "interaction_rate", label: "Taxa de interação", kind: "percent", value: (m) => pct(m.interactions, m.impressions) },
  { id: "engagements", label: "Engajamentos", kind: "count", value: pick("engagements") },
  { id: "video_views", label: "Visualizações", kind: "count", value: pick("video_views") },
  { id: "cpv", label: "CPV méd.", kind: "money", value: (m) => ratio(m.cost, m.video_views) },
  { id: "search_is", label: "Parc. impr. pesq.", kind: "percent", value: pick("search_is") },
  { id: "search_top_is", label: "Parc. impr. parte sup. pesq.", kind: "percent", value: pick("search_top_is") },
  { id: "search_abs_top_is", label: "Parc. impr. topo abs. pesq.", kind: "percent", value: pick("search_abs_top_is") },
  { id: "search_lost_rank", label: "Parc. impr. perdida pesq. (classif.)", kind: "percent", value: pick("search_lost_rank") },
  { id: "search_lost_budget", label: "Parc. impr. perdida pesq. (orçam.)", kind: "percent", value: pick("search_lost_budget") },
  { id: "top_pct", label: "Taxa de impr. parte sup.", kind: "percent", value: pick("top_pct") },
  { id: "abs_top_pct", label: "Taxa de impr. topo abs.", kind: "percent", value: pick("abs_top_pct") },
  // MakeCRM: the deals its UTMs give each campaign and ad group
  // (src/platform-crm.ts; utm_campaign = campanha, utm_term = grupo).
  ...(
    [
      { id: "crm_leads", label: "Oportunidades (CRM)", kind: "count", value: pick("crm_leads") },
      { id: "crm_cost_per_lead", label: "Custo/oportunidade (CRM)", kind: "money", value: (m) => ratio(m.cost, m.crm_leads) },
      { id: "crm_wons", label: "Ganhos (CRM)", kind: "count", value: pick("crm_wons") },
      { id: "crm_cost_per_won", label: "Custo/ganho (CRM)", kind: "money", value: (m) => ratio(m.cost, m.crm_wons) },
      { id: "crm_revenue", label: "Receita (CRM)", kind: "money", value: pick("crm_revenue") },
      { id: "crm_roas", label: "ROAS (CRM)", kind: "decimal", value: (m) => ratio(m.crm_revenue, m.cost) },
    ] as GColumn[]
  ).map((c) => ({ ...c, views: CRM_VIEWS })),
];
export const metricColumn = new Map(METRIC_COLUMNS.map((c) => [c.id, c]));
const t = (id: string, label: string, kind: ColumnKind = "text"): GColumn => ({
  id,
  label,
  kind,
  text: (r) => r.info[id] ?? null,
});
/** Each view's own columns, between the name and the numbers. */
export const TEXT_COLUMNS: Record<GoogleView, GColumn[]> = {
  campaigns: [t("budget", "Orçamento", "money"), t("type", "Tipo de campanha"), t("bidding", "Tipo de estratégia de lances")],
  ad_groups: [t("campaign", "Campanha"), t("bid", "CPC máx. padrão", "money"), t("target_cpa", "CPA desejado", "money")],
  ads: [t("campaign", "Campanha"), t("ad_group", "Grupo de anúncios"), t("type", "Tipo de anúncio"), t("approval", "Status da política"), t("strength", "Força do anúncio")],
  assets: [t("asset_type", "Tipo de recurso"), t("level", "Nível"), t("campaign", "Campanha"), t("ad_group", "Grupo de anúncios")],
  asset_groups: [t("campaign", "Campanha"), t("strength", "Força do anúncio")],
  keywords: [t("match", "Tipo de correspondência"), t("campaign", "Campanha"), t("ad_group", "Grupo de anúncios"), t("quality", "Índice de qualidade", "count"), t("bid", "CPC máx.", "money")],
  search_terms: [t("keyword", "Palavra-chave"), t("added", "Adicionado/excluído"), t("campaign", "Campanha"), t("ad_group", "Grupo de anúncios")],
  negatives: [t("match", "Tipo de correspondência"), t("level", "Nível"), t("where", "Campanha / grupo / lista")],
  age: [],
  gender: [],
  devices: [],
  locations: [],
  day_of_week: [],
  hour: [],
  auction: [t("overlap", "Taxa de sobreposição", "percent"), t("position_above", "Taxa de posição acima", "percent"), t("outranking", "Parcela de superação", "percent")],
};
export type GPreset = "desempenho" | "conversoes" | "concorrencia" | "video" | "crm" | "personalizado";
export const G_PRESETS: { id: GPreset; label: string; columns: string[] }[] = [
  { id: "desempenho", label: "Desempenho", columns: ["clicks", "impressions", "ctr", "cpc", "cost", "conversions", "cost_per_conv", "conv_rate"] },
  { id: "conversoes", label: "Conversões", columns: ["conversions", "cost_per_conv", "conv_rate", "conversions_value", "value_per_cost", "all_conversions", "view_through", "cost"] },
  { id: "concorrencia", label: "Concorrência", columns: ["impressions", "search_is", "search_top_is", "search_abs_top_is", "search_lost_rank", "search_lost_budget", "top_pct", "abs_top_pct"] },
  { id: "video", label: "Vídeo", columns: ["impressions", "video_views", "cpv", "interactions", "interaction_rate", "clicks", "cost", "conversions"] },
  { id: "crm", label: "Resultado no CRM", columns: ["clicks", "cost", "conversions", "cost_per_conv", "crm_leads", "crm_cost_per_lead", "crm_wons", "crm_cost_per_won", "crm_revenue", "crm_roas"] },
];
/** Auction always reads the share columns. */
export const AUCTION_COLUMNS = ["impressions", "search_is", "top_pct", "abs_top_pct", "search_lost_rank", "search_lost_budget"];

// ------------------------------------------------------------ demonstration
function seeded(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
function span(q: Pick<GoogleQuery, "since" | "until">) {
  return Math.max(1, Math.round((Date.parse(q.until) - Date.parse(q.since)) / 86_400_000) + 1);
}
function demoMetrics(key: string, days: number, scale = 1): Metrics {
  const rand = seeded(key);
  const impressions = Math.round((180 + rand() * 420) * days * scale);
  const clicks = Math.round(impressions * (0.03 + rand() * 0.07));
  const cost = Math.round(clicks * (1.2 + rand() * 2.8) * 100) / 100;
  const conversions = Math.round(clicks * (0.05 + rand() * 0.12) * 10) / 10;
  return {
    impressions,
    clicks,
    cost,
    conversions,
    conversions_value: Math.round(conversions * (80 + rand() * 120) * 100) / 100,
    all_conversions: Math.round(conversions * 1.2 * 10) / 10,
    view_through_conversions: Math.round(rand() * 3),
    interactions: clicks,
    engagements: Math.round(clicks * 0.2),
    video_views: 0,
    phone_calls: Math.round(rand() * 4),
    search_is: Math.round((35 + rand() * 50) * 10) / 10,
    search_top_is: Math.round((25 + rand() * 40) * 10) / 10,
    search_abs_top_is: Math.round((10 + rand() * 30) * 10) / 10,
    search_lost_rank: Math.round((5 + rand() * 30) * 10) / 10,
    search_lost_budget: Math.round(rand() * 20 * 10) / 10,
    top_pct: Math.round((50 + rand() * 40) * 10) / 10,
    abs_top_pct: Math.round((20 + rand() * 40) * 10) / 10,
  };
}
const sum = (list: (Metrics | null)[]) =>
  list.reduce<Metrics>((acc, m) => {
    for (const [k, v] of Object.entries(m ?? {}))
      acc[k] = k.startsWith("search_") || k.endsWith("_pct") ? null : (acc[k] ?? 0) + (v ?? 0);
    return acc;
  }, {});
const on: GoogleStatus = { code: "ELIGIBLE", label: "Qualificada", tone: "on" };
const paused: GoogleStatus = { code: "PAUSED", label: "Pausada", tone: "off" };
const DEMO_CAMPAIGNS = [
  { id: "21000001", name: "Pesquisa · Marca", type: "Pesquisa", budget: 60, bidding: "Maximizar conversões", status: on },
  { id: "21000002", name: "Pesquisa · Genéricas", type: "Pesquisa", budget: 120, bidding: "CPA desejado", status: { code: "LIMITED", label: "Limitada pelo orçamento", tone: "warn" } as GoogleStatus },
  { id: "21000003", name: "PMax · Leads", type: "Performance Max", budget: 90, bidding: "Maximizar conversões", status: on },
  { id: "21000004", name: "Display · Remarketing", type: "Display", budget: 30, bidding: "Maximizar cliques", status: paused },
];
const DEMO_GROUPS: Record<string, string[]> = {
  "21000001": ["Marca exata", "Marca + produto"],
  "21000002": ["Café especial", "Café em grãos", "Cafeteria perto"],
  "21000004": ["Visitantes 30 dias"],
};
const DEMO_KEYWORDS: Record<string, [string, "EXACT" | "PHRASE" | "BROAD"][]> = {
  "Marca exata": [["norte coffee", "EXACT"], ["norte café", "EXACT"]],
  "Marca + produto": [["norte coffee grãos", "PHRASE"]],
  "Café especial": [["café especial", "PHRASE"], ["comprar café especial", "BROAD"], ["café gourmet", "BROAD"]],
  "Café em grãos": [["café em grãos", "EXACT"], ["café em grãos 1kg", "PHRASE"]],
  "Cafeteria perto": [["cafeteria perto de mim", "BROAD"]],
};
const MATCH_LABEL = { EXACT: "Correspondência exata", PHRASE: "Correspondência de frase", BROAD: "Correspondência ampla" };
const kwText = (text: string, m: keyof typeof MATCH_LABEL) =>
  m === "EXACT" ? `[${text}]` : m === "PHRASE" ? `"${text}"` : text;

export function demoGooglePlatform(linked: string[] = []): GooglePlatformBackend {
  const campaigns = () =>
    DEMO_CAMPAIGNS.map((c, i) => ({ ...c, id: i === 0 && linked[0] ? linked[0] : c.id }));
  const build = (q: GoogleQuery): GoogleList => {
    const days = span(q);
    const period = `${q.since}${q.until}`;
    const inScope = (cid: string) => !q.campaigns.length || q.campaigns.includes(cid);
    const groups = campaigns().flatMap((c, ci) =>
      (DEMO_GROUPS[DEMO_CAMPAIGNS[ci].id] ?? []).map((name, gi) => ({
        id: `${c.id}${gi}`,
        name,
        campaign: c,
      })),
    );
    const groupInScope = (g: { id: string; campaign: { id: string } }) =>
      inScope(g.campaign.id) && (!q.ad_groups.length || q.ad_groups.includes(g.id));
    let rows: GoogleRow[] = [];
    let notice: string | undefined;
    const segmentsOf = (key: string, m: Metrics | null): GoogleRow["segments"] => {
      if (!q.segment || !m) return undefined;
      const parts: [string, string][] =
        q.segment === "device"
          ? [["MOBILE", "Celulares"], ["DESKTOP", "Computadores"], ["TABLET", "Tablets"]]
          : q.segment === "network"
            ? [["SEARCH", "Pesquisa Google"], ["SEARCH_PARTNERS", "Parceiros de pesquisa"]]
            : q.segment === "day_of_week"
              ? [["MONDAY", "Segunda-feira"], ["TUESDAY", "Terça-feira"], ["WEDNESDAY", "Quarta-feira"], ["THURSDAY", "Quinta-feira"], ["FRIDAY", "Sexta-feira"], ["SATURDAY", "Sábado"], ["SUNDAY", "Domingo"]]
              : [["a", q.since], ["b", q.until]];
      const rand = seeded(key + q.segment);
      const w = parts.map(() => 0.3 + rand());
      const total = w.reduce((s, x) => s + x, 0);
      return parts.map(([k, label], i) => ({
        key: k,
        label,
        metrics: Object.fromEntries(Object.entries(m).map(([mk, v]) => [mk, v === null || mk.startsWith("search_") || mk.endsWith("_pct") ? null : Math.round(v * (w[i] / total) * 100) / 100])),
      }));
    };
    switch (q.view) {
      case "campaigns":
        rows = campaigns()
          .filter((c) => inScope(c.id))
          .map((c) => {
            const m = demoMetrics(c.id + period, days, c.status.code === "PAUSED" ? 0.03 : 1);
            return {
              id: c.id,
              name: c.name,
              sub: c.type,
              status: c.status,
              enabled: c.status.code !== "PAUSED",
              campaign_id: c.id,
              info: { budget: c.budget, type: c.type, bidding: c.bidding },
              metrics: m,
              segments: segmentsOf(c.id, m),
            };
          });
        break;
      case "ad_groups":
        rows = groups.filter(groupInScope).map((g, i) => {
          const m = demoMetrics(g.id + period, days, 0.45);
          return {
            id: g.id,
            name: g.name,
            sub: g.campaign.name,
            status: i === 2 ? paused : { code: "ENABLED", label: "Ativado", tone: "on" },
            enabled: i !== 2,
            campaign_id: g.campaign.id,
            ad_group_id: g.id,
            info: { campaign: g.campaign.name, bid: 2.5 + i * 0.4, target_cpa: g.campaign.bidding === "CPA desejado" ? 28 : null },
            metrics: m,
            segments: segmentsOf(g.id, m),
          };
        });
        break;
      case "ads":
        rows = groups.filter(groupInScope).flatMap((g, gi) =>
          [0, 1].map((ai) => {
            const m = demoMetrics(`${g.id}ad${ai}${period}`, days, 0.22);
            const display = g.campaign.type === "Display";
            return {
              id: `${g.id}~${ai + 1}`,
              name: display ? "Café fresquinho em casa" : `${g.name} | Norte Coffee`,
              sub: display ? "Anúncio display responsivo" : "Anúncio responsivo de pesquisa",
              status: ai === 1 && gi % 2 ? paused : { code: "ENABLED", label: "Qualificado", tone: "on" },
              enabled: !(ai === 1 && gi % 2),
              campaign_id: g.campaign.id,
              ad_group_id: g.id,
              info: {
                campaign: g.campaign.name,
                ad_group: g.name,
                type: display ? "Anúncio display responsivo" : "Anúncio responsivo de pesquisa",
                approval: "Aprovado",
                strength: ["Excelente", "Boa", "Média"][(gi + ai) % 3],
              },
              metrics: m,
              segments: segmentsOf(`${g.id}${ai}`, m),
              preview: {
                headlines: [`${g.name} | Norte Coffee`, "Torra fresca toda semana", "Frete grátis acima de R$ 150"],
                descriptions: ["Cafés especiais selecionados de pequenos produtores. Peça hoje e receba em casa.", "Assinatura com desconto. Cancele quando quiser."],
                final_url: "https://www.nortecoffee.com.br/cafes",
                path: "nortecoffee.com.br/cafes/especiais",
                business: "Norte Coffee",
                images: [],
                videos: [],
              },
            };
          }),
        );
        break;
      case "keywords":
        rows = groups.filter(groupInScope).flatMap((g) =>
          (DEMO_KEYWORDS[g.name] ?? []).map(([text, match], ki) => {
            const m = demoMetrics(`${g.id}kw${ki}${period}`, days, 0.18);
            return {
              id: `${g.id}~${ki + 1}`,
              name: kwText(text, match),
              sub: g.name,
              status: ki === 2 ? { code: "RARELY_SERVED", label: "Baixo volume de pesquisa", tone: "warn" } : on,
              enabled: true,
              campaign_id: g.campaign.id,
              ad_group_id: g.id,
              info: { match: MATCH_LABEL[match], campaign: g.campaign.name, ad_group: g.name, quality: 5 + ((ki * 3 + text.length) % 6), bid: 2.1 + ki * 0.35 },
              metrics: m,
              segments: segmentsOf(`${g.id}${ki}`, m),
            };
          }),
        );
        break;
      case "search_terms":
        rows = groups.filter(groupInScope).flatMap((g) =>
          (DEMO_KEYWORDS[g.name] ?? []).flatMap(([text, match], ki) =>
            [`${text}`, `${text} preço`, `melhor ${text}`].map((term, ti) => {
              const m = demoMetrics(`${g.id}st${ki}${ti}${period}`, days, 0.07);
              return {
                id: `${g.id}~${term}~${text}`,
                name: term,
                sub: g.name,
                status: { code: ti === 0 ? "ADDED" : "NONE", label: ti === 0 ? "Adicionado" : "Nenhum", tone: ti === 0 ? "on" : "off" },
                enabled: null,
                campaign_id: g.campaign.id,
                ad_group_id: g.id,
                info: { keyword: kwText(text, match), added: ti === 0 ? "Adicionado" : "Nenhum", campaign: g.campaign.name, ad_group: g.name },
                metrics: m,
                segments: segmentsOf(`${g.id}${ki}${ti}`, m),
              } satisfies GoogleRow;
            }),
          ),
        );
        break;
      case "negatives":
        rows = [
          ["grátis", "BROAD", "Campanha", "Pesquisa · Genéricas"],
          ["receita", "PHRASE", "Campanha", "Pesquisa · Genéricas"],
          ["vagas", "BROAD", "Lista: Negativas gerais", "Pesquisa · Marca, Pesquisa · Genéricas"],
          ["starbucks", "EXACT", "Grupo de anúncios", "Pesquisa · Genéricas › Café especial"],
        ].map(([text, match, level, where], i) => ({
          id: `n${i}`,
          name: kwText(text, match as keyof typeof MATCH_LABEL),
          sub: where,
          status: { code: "NEGATIVE", label: "Negativa", tone: "off" },
          enabled: null,
          info: { match: MATCH_LABEL[match as keyof typeof MATCH_LABEL], level, where },
          metrics: null,
        }));
        break;
      case "assets":
        rows = [
          ["Sitelink", "Assinatura de café", "Economize 15% todo mês", "Campanha"],
          ["Sitelink", "Cafés especiais", "Grãos selecionados", "Campanha"],
          ["Frase de destaque", "Frete grátis acima de R$ 150", "", "Conta"],
          ["Frase de destaque", "Torra semanal", "", "Conta"],
          ["Snippet estruturado", "Tipos: Arábica, Bourbon, Catuaí", "", "Campanha"],
          ["Ligação", "(11) 4002-8922", "", "Conta"],
          ["Imagem", "Xícara na mesa", "", "Campanha"],
        ].map(([type, text, detail, level], i) => ({
          id: `a${i}`,
          name: text,
          sub: detail || undefined,
          status: { code: "ENABLED", label: "Qualificado", tone: "on" },
          enabled: true,
          info: { asset_type: type, level, campaign: level === "Conta" ? "Todas" : DEMO_CAMPAIGNS[i % 2].name, ad_group: "" },
          metrics: demoMetrics(`asset${i}${period}`, days, 0.15),
        }));
        break;
      case "asset_groups":
        rows = campaigns()
          .filter((c) => c.type === "Performance Max" && inScope(c.id))
          .flatMap((c) =>
            ["Leads · Assinatura", "Leads · Presentes"].map((name, i) => {
              const m = demoMetrics(`${c.id}ag${i}${period}`, days, 0.5);
              return {
                id: `${c.id}${i}9`,
                name,
                sub: c.name,
                status: on,
                enabled: true,
                campaign_id: c.id,
                info: { campaign: c.name, strength: i ? "Boa" : "Excelente" },
                metrics: m,
                segments: segmentsOf(`${c.id}ag${i}`, m),
                preview: {
                  headlines: ["Café especial em casa", "Assine e economize", "Torra fresca"],
                  descriptions: ["Cafés de pequenos produtores, torrados toda semana."],
                  final_url: "https://www.nortecoffee.com.br",
                  business: "Norte Coffee",
                  images: [],
                  videos: [],
                  assets: [
                    { type: "Título", text: "Café especial em casa", performance: "Melhor", status: "ENABLED" },
                    { type: "Título", text: "Assine e economize", performance: "Boa", status: "ENABLED" },
                    { type: "Título", text: "Torra fresca", performance: "Baixa", status: "ENABLED" },
                    { type: "Descrição", text: "Cafés de pequenos produtores, torrados toda semana.", performance: "Boa", status: "ENABLED" },
                    { type: "Imagem", text: "Xícara e grãos (1200×628)", performance: "Aprendizado", status: "ENABLED" },
                    { type: "Vídeo do YouTube", text: "Como torramos nosso café", performance: "Pendente", status: "ENABLED" },
                  ],
                },
              };
            }),
          );
        break;
      case "auction":
        rows = [
          ...campaigns()
            .filter((c) => c.type === "Pesquisa" && inScope(c.id))
            .map((c) => ({
              id: `c~${c.id}`,
              name: c.name,
              sub: "Sua conta",
              status: c.status,
              enabled: null,
              campaign_id: c.id,
              info: { domain: "Você", kind: "self" },
              metrics: demoMetrics(`auc${c.id}${period}`, days),
            })),
        ];
        notice =
          "Os concorrentes do leilão só vêm do Google para contas com acesso liberado à API de informações de leilão. Aqui aparecem as parcelas de impressões das suas campanhas de pesquisa e shopping.";
        break;
      default: {
        const labels: Record<string, string[]> = {
          age: ["18-24", "25-34", "35-44", "45-54", "55-64", "65 ou mais", "Desconhecido"],
          gender: ["Feminino", "Masculino", "Desconhecido"],
          devices: ["Celulares", "Computadores", "Tablets", "Telas de TV"],
          locations: ["São Paulo", "Campinas", "Rio de Janeiro", "Belo Horizonte", "Curitiba"],
          day_of_week: ["Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado", "Domingo"],
          hour: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}h`),
        };
        rows = (labels[q.view] ?? []).map((name, i) => ({
          id: name,
          name,
          sub: q.view === "locations" ? ["Estado de São Paulo, Brasil", "Estado de São Paulo, Brasil", "Estado do Rio de Janeiro, Brasil", "Estado de Minas Gerais, Brasil", "Estado do Paraná, Brasil"][i] : undefined,
          status: { code: "SEGMENT", label: "", tone: "off" },
          enabled: null,
          info: {},
          metrics: demoMetrics(`${q.view}${i}${period}`, days, q.view === "hour" ? 0.05 : 0.3),
        }));
      }
    }
    return {
      account: { id: q.account, name: "Norte Coffee Ads", currency: "BRL", timezone: "America/Sao_Paulo" },
      view: q.view,
      rows,
      totals: q.view === "negatives" ? null : sum(rows.map((r) => r.metrics)),
      ...(notice ? { notice } : {}),
      fetched_at: new Date().toISOString(),
    };
  };
  const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 250));
  return {
    list: (_company, q) => wait(build(q)),
    detail: (_company, q) => {
      const days: GoogleDetail["days"] = [];
      for (let d = q.since; d <= q.until && days.length < 120; ) {
        days.push({ day: d, metrics: demoMetrics(`${q.id}${d}`, 1, 0.4) });
        d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      }
      const all = sum(days.map((x) => x.metrics));
      const part = (w: number) => Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v === null ? null : Math.round(v * w * 100) / 100]));
      return wait({
        days,
        devices: [
          { key: "MOBILE", label: "Celulares", metrics: part(0.62) },
          { key: "DESKTOP", label: "Computadores", metrics: part(0.31) },
          { key: "TABLET", label: "Tablets", metrics: part(0.07) },
        ],
      });
    },
  };
}

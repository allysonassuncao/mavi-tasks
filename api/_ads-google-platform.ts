import { AdsError, type Fetch } from "./_ads.js";
import { googleTotals } from "./_ads-sync.js";
import { actionId, type ConversionAction } from "./_conversions.js";
import { checkRange, inlineImage, type ReportMeta } from "./_ads-platform.js";

/**
 * Campanhas › Plataforma and Relatórios for Google Ads: the account read
 * live with GAQL, as the Google Ads interface shows it (read only).
 *
 * - googleList: one view of the account — campaigns, ad groups, ads,
 *   assets (extensions), keywords, search terms, negative keywords, asset
 *   groups (Performance Max), audiences and segments (age, gender, device,
 *   location, day and hour) and auction information — optionally under
 *   chosen campaigns or ad groups, with an optional segment as sub-rows.
 * - googleDetail: an object's days and its devices.
 * - googleReportMeta: what a report keeps of Google when it is created:
 *   each ad's, ad group's, keyword's and search term's days, with the
 *   cycle's result rule (googleTotals, the daily sync's), and the ads'
 *   texts and images.
 *
 * Nothing is stored or polled: the tab asks when someone opens it or
 * presses "Atualizar".
 */

export type GoogleRow = Record<string, Record<string, any>> & {
  segments?: Record<string, any>;
  metrics?: Record<string, any>;
};
/** GAQL for one account, through the MCC when there is one. */
export type Search = (query: string) => Promise<GoogleRow[]>;

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
export const GOOGLE_VIEWS: GoogleView[] = [
  "campaigns",
  "ad_groups",
  "ads",
  "assets",
  "keywords",
  "search_terms",
  "negatives",
  "asset_groups",
  "age",
  "gender",
  "devices",
  "locations",
  "day_of_week",
  "hour",
  "auction",
];
export type GoogleSegment = "date" | "week" | "month" | "device" | "network" | "day_of_week";
const SEGMENT_FIELD: Record<GoogleSegment, string> = {
  date: "segments.date",
  week: "segments.week",
  month: "segments.month",
  device: "segments.device",
  network: "segments.ad_network_type",
  day_of_week: "segments.day_of_week",
};
/** The views a segment can split (as in the Google Ads interface). */
const SEGMENTABLE: GoogleView[] = ["campaigns", "ad_groups", "ads", "keywords", "search_terms", "asset_groups"];

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v == null ? "" : String(v));
const ID = /^[0-9]{1,20}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------ metrics
export type Metrics = Record<string, number | null>;
/** The metrics every view with numbers reads. */
const BASE_METRICS = [
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
  "metrics.all_conversions",
  "metrics.view_through_conversions",
  "metrics.interactions",
  "metrics.engagements",
  "metrics.video_trueview_views",
].join(", ");
/** Impression share: search campaigns, ad groups and keywords only. */
const SHARE_METRICS = [
  "metrics.search_impression_share",
  "metrics.search_top_impression_share",
  "metrics.search_absolute_top_impression_share",
  "metrics.search_rank_lost_impression_share",
  "metrics.top_impression_percentage",
  "metrics.absolute_top_impression_percentage",
].join(", ");

/** Google sends ratios as 0–1; the page shows percentages. */
const share = (v: unknown) => (v === undefined || v === null || v === "" ? null : num(v) * 100);
export function metricsOf(m: Record<string, any> | undefined): Metrics {
  const x = m ?? {};
  return {
    impressions: num(x.impressions),
    clicks: num(x.clicks),
    cost: num(x.costMicros) / 1e6,
    conversions: num(x.conversions),
    conversions_value: num(x.conversionsValue),
    all_conversions: num(x.allConversions),
    view_through_conversions: num(x.viewThroughConversions),
    interactions: num(x.interactions),
    engagements: num(x.engagements),
    video_views: num(x.videoTrueviewViews),
    phone_calls: num(x.phoneCalls),
    // Not summed: each row's own.
    search_is: share(x.searchImpressionShare),
    search_top_is: share(x.searchTopImpressionShare),
    search_abs_top_is: share(x.searchAbsoluteTopImpressionShare),
    search_lost_rank: share(x.searchRankLostImpressionShare),
    search_lost_budget: share(x.searchBudgetLostImpressionShare),
    top_pct: share(x.topImpressionPercentage),
    abs_top_pct: share(x.absoluteTopImpressionPercentage),
  };
}
const RATIOS = new Set([
  "search_is",
  "search_top_is",
  "search_abs_top_is",
  "search_lost_rank",
  "search_lost_budget",
  "top_pct",
  "abs_top_pct",
]);
export function addMetrics(into: Metrics, m: Metrics) {
  for (const [k, v] of Object.entries(m)) {
    if (RATIOS.has(k)) {
      into[k] = null;
      continue;
    }
    into[k] = (into[k] ?? 0) + (v ?? 0);
  }
  return into;
}

// ------------------------------------------------------------ labels
export type Status = { code: string; label: string; tone: "on" | "off" | "warn" | "bad" };
const PRIMARY: Record<string, [string, Status["tone"]]> = {
  ELIGIBLE: ["Qualificada", "on"],
  PAUSED: ["Pausada", "off"],
  REMOVED: ["Removida", "off"],
  ENDED: ["Encerrada", "off"],
  PENDING: ["Pendente", "warn"],
  MISCONFIGURED: ["Configuração incorreta", "bad"],
  LIMITED: ["Limitada", "warn"],
  LEARNING: ["Aprendizado", "on"],
  NOT_ELIGIBLE: ["Não qualificada", "bad"],
};
const REASON: Record<string, string> = {
  BUDGET_CONSTRAINED: "Limitada pelo orçamento",
  BIDDING_STRATEGY_LEARNING: "Aprendizado",
  BIDDING_STRATEGY_LIMITED: "Estratégia de lances limitada",
  BIDDING_STRATEGY_MISCONFIGURED: "Estratégia de lances com problema",
  HAS_ADS_LIMITED_BY_POLICY: "Anúncios limitados pela política",
  HAS_ADS_DISAPPROVED: "Anúncios reprovados",
  MOST_ADS_UNDER_REVIEW: "Anúncios em análise",
  MISSING_LEAD_FORM_EXTENSION: "Falta formulário de lead",
  CAMPAIGN_PAUSED: "Campanha pausada",
  CAMPAIGN_ENDED: "Campanha encerrada",
  CAMPAIGN_PENDING: "Campanha pendente",
  AD_GROUP_PAUSED: "Grupo de anúncios pausado",
  AD_GROUP_REMOVED: "Grupo de anúncios removido",
  SEARCH_VOLUME_LIMITED: "Baixo volume de pesquisa",
  AD_GROUP_AD_UNDER_REVIEW: "Em análise",
  AD_GROUP_AD_DISAPPROVED: "Reprovado",
  AD_GROUP_AD_APPROVED_LIMITED: "Aprovado (limitado)",
};
export function statusOf(status: unknown, primary?: unknown, reasons?: unknown): Status {
  const s = str(status);
  const p = str(primary);
  const first = Array.isArray(reasons) ? str(reasons[0]) : "";
  if (s === "PAUSED") return { code: "PAUSED", label: "Pausada", tone: "off" };
  if (s === "REMOVED") return { code: "REMOVED", label: "Removida", tone: "off" };
  if (p && PRIMARY[p]) {
    const [label, tone] = PRIMARY[p];
    return { code: p, label: p === "LIMITED" && REASON[first] ? REASON[first] : label, tone };
  }
  if (s === "ENABLED") return { code: "ENABLED", label: "Ativada", tone: "on" };
  return { code: s, label: s || "—", tone: "off" };
}
export const CHANNEL: Record<string, string> = {
  SEARCH: "Pesquisa",
  DISPLAY: "Display",
  SHOPPING: "Shopping",
  VIDEO: "Vídeo",
  PERFORMANCE_MAX: "Performance Max",
  DEMAND_GEN: "Geração de demanda",
  DISCOVERY: "Geração de demanda",
  MULTI_CHANNEL: "App",
  LOCAL: "Local",
  SMART: "Inteligente",
  HOTEL: "Hotel",
  LOCAL_SERVICES: "Serviços locais",
};
export const BIDDING: Record<string, string> = {
  MAXIMIZE_CONVERSIONS: "Maximizar conversões",
  MAXIMIZE_CONVERSION_VALUE: "Maximizar o valor da conversão",
  TARGET_CPA: "CPA desejado",
  TARGET_ROAS: "ROAS desejado",
  TARGET_SPEND: "Maximizar cliques",
  MANUAL_CPC: "CPC manual",
  ENHANCED_CPC: "CPC otimizado",
  MANUAL_CPM: "CPM manual",
  MANUAL_CPV: "CPV manual",
  TARGET_CPM: "CPM desejado",
  TARGET_IMPRESSION_SHARE: "Parcela de impressões desejada",
  MAXIMIZE_CLICKS: "Maximizar cliques",
  COMMISSION: "Comissão",
  PERCENT_CPC: "CPC percentual",
};
export const MATCH: Record<string, string> = {
  EXACT: "Correspondência exata",
  PHRASE: "Correspondência de frase",
  BROAD: "Correspondência ampla",
};
/** "[exata]", "\"frase\"", "ampla": how the interface writes a keyword. */
export function keywordText(text: unknown, match: unknown) {
  const t = str(text);
  return str(match) === "EXACT" ? `[${t}]` : str(match) === "PHRASE" ? `"${t}"` : t;
}
const AD_TYPE: Record<string, string> = {
  RESPONSIVE_SEARCH_AD: "Anúncio responsivo de pesquisa",
  RESPONSIVE_DISPLAY_AD: "Anúncio display responsivo",
  EXPANDED_TEXT_AD: "Anúncio de texto expandido",
  IMAGE_AD: "Anúncio de imagem",
  VIDEO_AD: "Anúncio em vídeo",
  VIDEO_RESPONSIVE_AD: "Anúncio em vídeo responsivo",
  CALL_AD: "Anúncio só para chamadas",
  DEMAND_GEN_MULTI_ASSET_AD: "Anúncio de geração de demanda",
  DEMAND_GEN_CAROUSEL_AD: "Anúncio em carrossel",
  DISCOVERY_MULTI_ASSET_AD: "Anúncio de geração de demanda",
  APP_AD: "Anúncio de app",
  SHOPPING_PRODUCT_AD: "Anúncio de produto (Shopping)",
  SMART_CAMPAIGN_AD: "Anúncio de campanha inteligente",
};
const STRENGTH: Record<string, string> = {
  EXCELLENT: "Excelente",
  GOOD: "Boa",
  AVERAGE: "Média",
  POOR: "Baixa",
  PENDING: "Pendente",
  NO_ADS: "Sem anúncios",
};
const APPROVAL: Record<string, string> = {
  APPROVED: "Aprovado",
  APPROVED_LIMITED: "Aprovado (limitado)",
  AREA_OF_INTEREST_ONLY: "Aprovado (limitado)",
  DISAPPROVED: "Reprovado",
  UNKNOWN: "—",
};
export const FIELD_TYPE: Record<string, string> = {
  SITELINK: "Sitelink",
  CALLOUT: "Frase de destaque",
  STRUCTURED_SNIPPET: "Snippet estruturado",
  CALL: "Ligação",
  PRICE: "Preço",
  PROMOTION: "Promoção",
  LEAD_FORM: "Formulário de lead",
  MOBILE_APP: "App",
  AD_IMAGE: "Imagem",
  BUSINESS_LOGO: "Logotipo da empresa",
  BUSINESS_NAME: "Nome da empresa",
  HEADLINE: "Título",
  LONG_HEADLINE: "Título longo",
  DESCRIPTION: "Descrição",
  MARKETING_IMAGE: "Imagem",
  SQUARE_MARKETING_IMAGE: "Imagem quadrada",
  PORTRAIT_MARKETING_IMAGE: "Imagem retrato",
  LOGO: "Logotipo",
  LANDSCAPE_LOGO: "Logotipo horizontal",
  YOUTUBE_VIDEO: "Vídeo do YouTube",
  CALL_TO_ACTION_SELECTION: "Call to action",
};
const EXTENSION_TYPES = [
  "SITELINK",
  "CALLOUT",
  "STRUCTURED_SNIPPET",
  "CALL",
  "PRICE",
  "PROMOTION",
  "LEAD_FORM",
  "MOBILE_APP",
  "AD_IMAGE",
  "BUSINESS_LOGO",
  "BUSINESS_NAME",
];
const PERFORMANCE: Record<string, string> = {
  BEST: "Melhor",
  GOOD: "Boa",
  LOW: "Baixa",
  LEARNING: "Aprendizado",
  PENDING: "Pendente",
  UNKNOWN: "—",
};
const AGE: Record<string, string> = {
  AGE_RANGE_18_24: "18-24",
  AGE_RANGE_25_34: "25-34",
  AGE_RANGE_35_44: "35-44",
  AGE_RANGE_45_54: "45-54",
  AGE_RANGE_55_64: "55-64",
  AGE_RANGE_65_UP: "65 ou mais",
  AGE_RANGE_UNDETERMINED: "Desconhecido",
};
const GENDER: Record<string, string> = {
  MALE: "Masculino",
  FEMALE: "Feminino",
  UNDETERMINED: "Desconhecido",
};
export const DEVICE: Record<string, string> = {
  MOBILE: "Celulares",
  DESKTOP: "Computadores",
  TABLET: "Tablets",
  CONNECTED_TV: "Telas de TV",
  OTHER: "Outros",
  UNKNOWN: "Desconhecido",
};
const NETWORK: Record<string, string> = {
  SEARCH: "Pesquisa Google",
  SEARCH_PARTNERS: "Parceiros de pesquisa",
  CONTENT: "Rede de Display",
  YOUTUBE: "YouTube",
  YOUTUBE_SEARCH: "Pesquisas no YouTube",
  YOUTUBE_WATCH: "Vídeos do YouTube",
  GOOGLE_TV: "Google TV",
  MIXED: "Várias redes",
  UNKNOWN: "Desconhecida",
};
export const WEEKDAY: Record<string, [number, string]> = {
  MONDAY: [1, "Segunda-feira"],
  TUESDAY: [2, "Terça-feira"],
  WEDNESDAY: [3, "Quarta-feira"],
  THURSDAY: [4, "Quinta-feira"],
  FRIDAY: [5, "Sexta-feira"],
  SATURDAY: [6, "Sábado"],
  SUNDAY: [7, "Domingo"],
};
const TERM_STATUS: Record<string, string> = {
  ADDED: "Adicionado",
  EXCLUDED: "Excluído",
  ADDED_EXCLUDED: "Adicionado e excluído",
  NONE: "Nenhum",
};
function segmentLabel(kind: GoogleSegment, value: unknown) {
  const v = str(value);
  if (kind === "device") return DEVICE[v] ?? v;
  if (kind === "network") return NETWORK[v] ?? v;
  if (kind === "day_of_week") return WEEKDAY[v]?.[1] ?? v;
  return v;
}

// ------------------------------------------------------------ requests
export type GoogleQuery = {
  account: string;
  manager: string;
  view: GoogleView;
  since: string;
  until: string;
  campaigns: string[];
  ad_groups: string[];
  segment?: GoogleSegment;
  /** Locations: city, region or country. */
  geo?: "city" | "region" | "country";
  removed?: boolean;
};
export function googleQuery(raw: Record<string, unknown>): GoogleQuery {
  const account = String(raw.account ?? "").replace(/-/g, "");
  if (!ID.test(account)) throw new AdsError(400, "Conta do Google Ads inválida.");
  const manager = String(raw.manager ?? "").replace(/-/g, "");
  if (manager && !ID.test(manager)) throw new AdsError(400, "MCC inválida.");
  const view = raw.view as GoogleView;
  if (!GOOGLE_VIEWS.includes(view)) throw new AdsError(400, "Visão inválida.");
  const since = String(raw.since ?? "");
  const until = String(raw.until ?? "");
  checkRange(since, until);
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.map(String).filter((x) => ID.test(x)).slice(0, 100) : [];
  const segment = raw.segment as GoogleSegment | undefined;
  if (segment && !(segment in SEGMENT_FIELD)) throw new AdsError(400, "Segmento inválido.");
  const geo = raw.geo === "region" || raw.geo === "country" ? raw.geo : "city";
  return {
    account,
    manager,
    view,
    since,
    until,
    campaigns: ids(raw.campaigns),
    ad_groups: ids(raw.ad_groups),
    segment: segment && SEGMENTABLE.includes(view) ? segment : undefined,
    geo,
    removed: raw.removed === true,
  };
}
const period = (q: Pick<GoogleQuery, "since" | "until">) =>
  `segments.date BETWEEN '${q.since}' AND '${q.until}'`;
/** WHERE for the chosen campaigns and ad groups (ids already checked). */
function scope(q: GoogleQuery, withAdGroups = true) {
  const parts: string[] = [];
  if (q.campaigns.length) parts.push(`campaign.id IN (${q.campaigns.join(",")})`);
  if (withAdGroups && q.ad_groups.length) parts.push(`ad_group.id IN (${q.ad_groups.join(",")})`);
  return parts.map((p) => ` AND ${p}`).join("");
}

export type GoogleListRow = {
  id: string;
  name: string;
  /** Under the name: the campaign, the ad group, the type… */
  sub?: string;
  status: Status;
  /** The toggle: on, off, or none (rows without one). */
  enabled: boolean | null;
  campaign_id?: string;
  ad_group_id?: string;
  /** The view's text columns. */
  info: Record<string, string | number | null>;
  metrics: Metrics | null;
  segments?: { key: string; label: string; metrics: Metrics }[];
  /** Ads and asset groups: what the ad shows. */
  preview?: {
    headlines: string[];
    descriptions: string[];
    final_url?: string;
    path?: string;
    business?: string;
    images: string[];
    videos: string[];
    assets?: { type: string; text?: string; image?: string; video?: string; performance: string; status: string }[];
  };
};
export type GoogleList = {
  account: { id: string; name: string; currency: string; timezone: string };
  view: GoogleView;
  rows: GoogleListRow[];
  totals: Metrics | null;
  /** Something the view could not show (e.g. auction competitors). */
  notice?: string;
  fetched_at: string;
};

/** The ids a row of a resource is known by (for segments' sub-rows). */
function rowKey(view: GoogleView, r: GoogleRow) {
  switch (view) {
    case "campaigns":
      return str(r.campaign?.id);
    case "ad_groups":
      return str(r.adGroup?.id);
    case "ads":
      return `${str(r.adGroup?.id)}~${str(r.adGroupAd?.ad?.id)}`;
    case "keywords":
      return `${str(r.adGroup?.id)}~${str(r.adGroupCriterion?.criterionId)}`;
    case "search_terms":
      return `${str(r.adGroup?.id)}~${str(r.searchTermView?.searchTerm)}~${str(r.segments?.keyword?.info?.text)}`;
    case "asset_groups":
      return str(r.assetGroup?.id);
    default:
      return "";
  }
}
/** The query of a segmentable view, with or without a segment. */
function viewQuery(q: GoogleQuery, segment?: string) {
  const seg = segment ? `${segment}, ` : "";
  const removed = q.removed ? "" : " AND %s.status != 'REMOVED'";
  const where = (resource: string) =>
    `WHERE ${period(q)}${removed.replace("%s", resource)}`;
  switch (q.view) {
    case "campaigns":
      return `SELECT ${seg}campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros, campaign_budget.explicitly_shared, ${BASE_METRICS}, ${SHARE_METRICS}, metrics.search_budget_lost_impression_share FROM campaign ${where("campaign")}${scope(q, false)}`;
    case "ad_groups":
      return `SELECT ${seg}ad_group.id, ad_group.name, ad_group.status, ad_group.primary_status, ad_group.primary_status_reasons, ad_group.type, ad_group.cpc_bid_micros, ad_group.target_cpa_micros, campaign.id, campaign.name, campaign.advertising_channel_type, ${BASE_METRICS}, ${SHARE_METRICS} FROM ad_group ${where("ad_group")} AND campaign.status != 'REMOVED'${scope(q)}`;
    case "ads":
      return `SELECT ${seg}ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.long_headline, ad_group_ad.ad.responsive_display_ad.descriptions, ad_group_ad.ad.responsive_display_ad.business_name, ad_group_ad.ad.responsive_display_ad.marketing_images, ad_group_ad.ad.image_ad.image_url, ad_group_ad.status, ad_group_ad.primary_status, ad_group_ad.primary_status_reasons, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad_strength, ad_group.id, ad_group.name, campaign.id, campaign.name, ${BASE_METRICS} FROM ad_group_ad ${where("ad_group_ad")} AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'${scope(q)}`;
    case "keywords":
      return `SELECT ${seg}ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.system_serving_status, ad_group_criterion.approval_status, ad_group_criterion.quality_info.quality_score, ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.final_urls, ad_group.id, ad_group.name, campaign.id, campaign.name, ${BASE_METRICS}, ${SHARE_METRICS} FROM keyword_view ${where("ad_group_criterion")} AND ad_group_criterion.negative = FALSE AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'${scope(q)}`;
    case "search_terms":
      return `SELECT ${seg}search_term_view.search_term, search_term_view.status, segments.keyword.info.text, segments.keyword.info.match_type, ad_group.id, ad_group.name, campaign.id, campaign.name, ${BASE_METRICS} FROM search_term_view WHERE ${period(q)}${scope(q)} ORDER BY metrics.impressions DESC LIMIT ${segment ? 5000 : 1000}`;
    case "asset_groups":
      return `SELECT ${seg}asset_group.id, asset_group.name, asset_group.status, asset_group.primary_status, asset_group.primary_status_reasons, asset_group.ad_strength, asset_group.final_urls, campaign.id, campaign.name, ${BASE_METRICS} FROM asset_group ${where("asset_group")} AND campaign.status != 'REMOVED'${scope(q, false)}`;
    default:
      throw new AdsError(400, "Visão inválida.");
  }
}
const texts = (list: unknown) =>
  Array.isArray(list) ? list.map((x) => str(x?.text)).filter(Boolean) : [];

function toRow(view: GoogleView, r: GoogleRow, currency: string): GoogleListRow {
  void currency;
  const c = r.campaign ?? {};
  const g = r.adGroup ?? {};
  const m = metricsOf(r.metrics);
  switch (view) {
    case "campaigns": {
      const budget = r.campaignBudget ?? {};
      return {
        id: str(c.id),
        name: str(c.name) || str(c.id),
        sub: CHANNEL[str(c.advertisingChannelType)] ?? str(c.advertisingChannelType),
        status: statusOf(c.status, c.primaryStatus, c.primaryStatusReasons),
        enabled: str(c.status) === "ENABLED",
        campaign_id: str(c.id),
        info: {
          type: CHANNEL[str(c.advertisingChannelType)] ?? str(c.advertisingChannelType),
          budget: budget.amountMicros ? num(budget.amountMicros) / 1e6 : null,
          budget_shared: budget.explicitlyShared ? "Compartilhado" : "",
          bidding: BIDDING[str(c.biddingStrategyType)] ?? str(c.biddingStrategyType),
        },
        metrics: m,
      };
    }
    case "ad_groups":
      return {
        id: str(g.id),
        name: str(g.name) || str(g.id),
        sub: str(c.name),
        status: statusOf(g.status, g.primaryStatus, g.primaryStatusReasons),
        enabled: str(g.status) === "ENABLED",
        campaign_id: str(c.id),
        ad_group_id: str(g.id),
        info: {
          campaign: str(c.name),
          bid: g.cpcBidMicros ? num(g.cpcBidMicros) / 1e6 : null,
          target_cpa: g.targetCpaMicros ? num(g.targetCpaMicros) / 1e6 : null,
        },
        metrics: m,
      };
    case "ads": {
      const aga = r.adGroupAd ?? {};
      const ad = aga.ad ?? {};
      const rsa = ad.responsiveSearchAd ?? {};
      const rda = ad.responsiveDisplayAd ?? {};
      const url = str(ad.finalUrls?.[0]);
      let host = "";
      try {
        host = url ? new URL(url).hostname.replace(/^www\./, "") : "";
      } catch {
        host = "";
      }
      const headlines = [...texts(rsa.headlines), ...texts(rda.headlines), ...(rda.longHeadline?.text ? [str(rda.longHeadline.text)] : [])];
      const descriptions = [...texts(rsa.descriptions), ...texts(rda.descriptions)];
      return {
        id: `${str(g.id)}~${str(ad.id)}`,
        name: headlines[0] || str(ad.name) || AD_TYPE[str(ad.type)] || str(ad.id),
        sub: AD_TYPE[str(ad.type)] ?? str(ad.type),
        status: statusOf(aga.status, aga.primaryStatus, aga.primaryStatusReasons),
        enabled: str(aga.status) === "ENABLED",
        campaign_id: str(c.id),
        ad_group_id: str(g.id),
        info: {
          campaign: str(c.name),
          ad_group: str(g.name),
          type: AD_TYPE[str(ad.type)] ?? str(ad.type),
          approval: APPROVAL[str(aga.policySummary?.approvalStatus)] ?? "—",
          strength: STRENGTH[str(aga.adStrength)] ?? "—",
          final_url: url,
        },
        metrics: m,
        preview: {
          headlines,
          descriptions,
          final_url: url,
          path: [host, str(rsa.path1), str(rsa.path2)].filter(Boolean).join("/"),
          business: str(rda.businessName?.text ?? rda.businessName),
          images: [
            ...(ad.imageAd?.imageUrl ? [str(ad.imageAd.imageUrl)] : []),
          ],
          videos: [],
          // The display ad's images are assets: resolved after.
          ...(Array.isArray(rda.marketingImages)
            ? { assets: rda.marketingImages.map((a: any) => ({ type: "MARKETING_IMAGE", image: str(a.asset), performance: "", status: "" })) }
            : {}),
        },
      };
    }
    case "keywords": {
      const k = r.adGroupCriterion ?? {};
      const serving = str(k.systemServingStatus);
      const status = statusOf(k.status);
      return {
        id: `${str(g.id)}~${str(k.criterionId)}`,
        name: keywordText(k.keyword?.text, k.keyword?.matchType),
        sub: str(g.name),
        status:
          str(k.status) === "ENABLED" && serving === "RARELY_SERVED"
            ? { code: "RARELY_SERVED", label: "Baixo volume de pesquisa", tone: "warn" }
            : str(k.status) === "ENABLED" && str(k.approvalStatus) === "DISAPPROVED"
              ? { code: "DISAPPROVED", label: "Reprovada", tone: "bad" }
              : str(k.status) === "ENABLED"
                ? { code: "ELIGIBLE", label: "Qualificada", tone: "on" }
                : status,
        enabled: str(k.status) === "ENABLED",
        campaign_id: str(c.id),
        ad_group_id: str(g.id),
        info: {
          campaign: str(c.name),
          ad_group: str(g.name),
          match: MATCH[str(k.keyword?.matchType)] ?? str(k.keyword?.matchType),
          quality: k.qualityInfo?.qualityScore ? num(k.qualityInfo.qualityScore) : null,
          bid: k.effectiveCpcBidMicros ? num(k.effectiveCpcBidMicros) / 1e6 : null,
          final_url: str(k.finalUrls?.[0]),
        },
        metrics: m,
      };
    }
    case "search_terms": {
      const t = r.searchTermView ?? {};
      const kw = r.segments?.keyword?.info ?? {};
      return {
        id: rowKey("search_terms", r),
        name: str(t.searchTerm),
        sub: str(g.name),
        status: { code: str(t.status), label: TERM_STATUS[str(t.status)] ?? "Nenhum", tone: str(t.status) === "EXCLUDED" ? "off" : str(t.status) === "ADDED" ? "on" : "off" },
        enabled: null,
        campaign_id: str(c.id),
        ad_group_id: str(g.id),
        info: {
          campaign: str(c.name),
          ad_group: str(g.name),
          keyword: kw.text ? keywordText(kw.text, kw.matchType) : "",
          added: TERM_STATUS[str(t.status)] ?? "Nenhum",
        },
        metrics: m,
      };
    }
    case "asset_groups": {
      const a = r.assetGroup ?? {};
      return {
        id: str(a.id),
        name: str(a.name) || str(a.id),
        sub: str(c.name),
        status: statusOf(a.status, a.primaryStatus, a.primaryStatusReasons),
        enabled: str(a.status) === "ENABLED",
        campaign_id: str(c.id),
        info: {
          campaign: str(c.name),
          strength: STRENGTH[str(a.adStrength)] ?? "—",
          final_url: str(a.finalUrls?.[0]),
        },
        metrics: m,
      };
    }
    default:
      throw new AdsError(400, "Visão inválida.");
  }
}

/** Sums rows of the same key (a view read per segment or per day). */
function groupBy<T>(rows: T[], key: (r: T) => string) {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

/** One view of the account, as the Google Ads interface shows it. */
export async function googleList(
  search: Search,
  q: GoogleQuery,
  fetchImpl: Fetch,
  now = new Date(),
): Promise<GoogleList> {
  const [customer] = await search(
    "SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer",
  );
  const account = {
    id: q.account,
    name: str(customer?.customer?.descriptiveName) || q.account,
    currency: str(customer?.customer?.currencyCode) || "BRL",
    timezone: str(customer?.customer?.timeZone),
  };
  const base = { account, view: q.view, fetched_at: now.toISOString() };
  let rows: GoogleListRow[] = [];
  let notice: string | undefined;
  let totals: Metrics | null = null;
  const sum = (list: GoogleListRow[]) =>
    list.reduce<Metrics>((acc, r) => (r.metrics ? addMetrics(acc, r.metrics) : acc), {});

  if (SEGMENTABLE.includes(q.view)) {
    const [main, split] = await Promise.all([
      search(viewQuery(q)),
      q.segment ? search(viewQuery(q, SEGMENT_FIELD[q.segment])) : Promise.resolve(null),
    ]);
    rows = main.map((r) => toRow(q.view, r, account.currency));
    if (split) {
      const field = SEGMENT_FIELD[q.segment!].replace("segments.", "");
      const camel = field.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
      const byRow = groupBy(split, (r) => rowKey(q.view, r));
      for (const row of rows) {
        const parts = groupBy(byRow.get(row.id) ?? [], (r) => str(r.segments?.[camel]));
        row.segments = [...parts.entries()]
          .map(([k, list]) => ({
            key: k,
            label: segmentLabel(q.segment!, k),
            metrics: list.reduce<Metrics>((acc, r) => addMetrics(acc, metricsOf(r.metrics)), {}),
          }))
          .sort((a, b) =>
            q.segment === "day_of_week"
              ? (WEEKDAY[a.key]?.[0] ?? 9) - (WEEKDAY[b.key]?.[0] ?? 9)
              : q.segment === "date" || q.segment === "week" || q.segment === "month"
                ? a.key.localeCompare(b.key)
                : (b.metrics.cost ?? 0) - (a.metrics.cost ?? 0),
          );
      }
    }
    if (q.view === "ads") await resolveAdImages(search, rows);
    if (q.view === "asset_groups") await attachGroupAssets(search, rows);
    totals = sum(rows);
  } else if (q.view === "assets") {
    rows = await assetRows(search, q);
    totals = sum(rows);
  } else if (q.view === "negatives") {
    rows = await negativeRows(search, q);
  } else if (q.view === "auction") {
    const r = await auctionRows(search, q);
    rows = r.rows;
    notice = r.notice;
  } else {
    rows = await audienceRows(search, q);
    totals = sum(rows);
  }
  void fetchImpl;
  return { ...base, rows, totals, ...(notice ? { notice } : {}) };
}

/** Display ads name their images as assets: their addresses. */
async function resolveAdImages(search: Search, rows: GoogleListRow[]) {
  const names = [
    ...new Set(
      rows.flatMap((r) => (r.preview?.assets ?? []).map((a) => a.image ?? "")).filter((n) => /^customers\/\d+\/assets\/\d+$/.test(n)),
    ),
  ].slice(0, 500);
  if (!names.length) return;
  const found = await search(
    `SELECT asset.resource_name, asset.image_asset.full_size.url FROM asset WHERE asset.resource_name IN (${names.map((n) => `'${n}'`).join(",")})`,
  ).catch(() => [] as GoogleRow[]);
  const url = new Map(found.map((a) => [str(a.asset?.resourceName), str(a.asset?.imageAsset?.fullSize?.url)]));
  for (const r of rows)
    if (r.preview?.assets) {
      r.preview.images.push(...r.preview.assets.map((a) => url.get(a.image ?? "") ?? "").filter(Boolean));
      delete r.preview.assets;
    }
}

/** Performance Max: each asset group's assets, with their rating. */
async function attachGroupAssets(search: Search, rows: GoogleListRow[]) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id).filter((id) => ID.test(id)).slice(0, 200);
  const found = await search(
    `SELECT asset_group.id, asset_group_asset.field_type, asset_group_asset.performance_label, asset_group_asset.status, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, asset.youtube_video_asset.youtube_video_id FROM asset_group_asset WHERE asset_group.id IN (${ids.join(",")}) AND asset_group_asset.status != 'REMOVED'`,
  ).catch(() => [] as GoogleRow[]);
  const byGroup = groupBy(found, (r) => str(r.assetGroup?.id));
  for (const row of rows) {
    const list = byGroup.get(row.id) ?? [];
    const assets = list.map((r) => ({
      type: FIELD_TYPE[str(r.assetGroupAsset?.fieldType)] ?? str(r.assetGroupAsset?.fieldType),
      text: str(r.asset?.textAsset?.text) || undefined,
      image: str(r.asset?.imageAsset?.fullSize?.url) || undefined,
      video: str(r.asset?.youtubeVideoAsset?.youtubeVideoId) || undefined,
      performance: PERFORMANCE[str(r.assetGroupAsset?.performanceLabel)] ?? "—",
      status: str(r.assetGroupAsset?.status),
    }));
    const field = (t: string) => list.filter((r) => str(r.assetGroupAsset?.fieldType) === t).map((r) => str(r.asset?.textAsset?.text)).filter(Boolean);
    row.preview = {
      headlines: [...field("HEADLINE"), ...field("LONG_HEADLINE")],
      descriptions: field("DESCRIPTION"),
      final_url: str(row.info.final_url),
      business: field("BUSINESS_NAME")[0],
      images: assets.map((a) => a.image ?? "").filter(Boolean),
      videos: assets.map((a) => a.video ?? "").filter(Boolean),
      assets,
    };
  }
}

/** Assets (extensions) of the account, the campaigns and the ad groups. */
async function assetRows(search: Search, q: GoogleQuery): Promise<GoogleListRow[]> {
  const types = EXTENSION_TYPES.map((t) => `'${t}'`).join(",");
  const fields =
    "asset.id, asset.type, asset.name, asset.final_urls, asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, asset.callout_asset.callout_text, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values, asset.call_asset.phone_number, asset.promotion_asset.promotion_target, asset.price_asset.type, asset.image_asset.full_size.url";
  const levels: [string, string, string][] = [
    ["customer_asset", "Conta", ""],
    ["campaign_asset", "Campanha", ", campaign.id, campaign.name"],
    ["ad_group_asset", "Grupo de anúncios", ", ad_group.id, ad_group.name, campaign.id, campaign.name"],
  ];
  const scoped = q.campaigns.length || q.ad_groups.length;
  const results = await Promise.all(
    levels.map(([resource, level, extra]) =>
      // Account-level assets don't belong to the chosen campaigns.
      scoped && resource === "customer_asset"
        ? Promise.resolve([] as { r: GoogleRow; resource: string; level: string }[])
        : search(
            `SELECT ${resource}.field_type, ${resource}.status, ${fields}${extra}, ${BASE_METRICS} FROM ${resource} WHERE ${period(q)} AND ${resource}.field_type IN (${types}) AND ${resource}.status != 'REMOVED'${
              resource === "customer_asset" ? "" : scope(q, resource === "ad_group_asset")
            }`,
          )
            .then((rows) => rows.map((r) => ({ r, resource, level })))
            .catch(() => []),
    ),
  );
  const camel = (s: string) => s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
  return results.flat().map(({ r, resource, level }) => {
    const link = r[camel(resource)] ?? {};
    const a = r.asset ?? {};
    const type = str(link.fieldType);
    const text =
      str(a.sitelinkAsset?.linkText) ||
      str(a.calloutAsset?.calloutText) ||
      (a.structuredSnippetAsset ? `${str(a.structuredSnippetAsset.header)}: ${(a.structuredSnippetAsset.values ?? []).join(", ")}` : "") ||
      str(a.callAsset?.phoneNumber) ||
      str(a.promotionAsset?.promotionTarget) ||
      str(a.name) ||
      FIELD_TYPE[type] ||
      type;
    const detail = [str(a.sitelinkAsset?.description1), str(a.sitelinkAsset?.description2)].filter(Boolean).join(" · ");
    return {
      id: `${resource}~${str(r.campaign?.id)}~${str(r.adGroup?.id)}~${str(a.id)}`,
      name: text,
      sub: detail || undefined,
      status: statusOf(link.status),
      enabled: str(link.status) === "ENABLED",
      campaign_id: str(r.campaign?.id) || undefined,
      ad_group_id: str(r.adGroup?.id) || undefined,
      info: {
        asset_type: FIELD_TYPE[type] ?? type,
        level,
        campaign: str(r.campaign?.name) || (level === "Conta" ? "Todas" : ""),
        ad_group: str(r.adGroup?.name),
        final_url: str(a.finalUrls?.[0]),
        image: str(a.imageAsset?.fullSize?.url),
      },
      metrics: metricsOf(r.metrics),
    } satisfies GoogleListRow;
  });
}

/** Negative keywords: of campaigns, of ad groups and the shared lists. */
async function negativeRows(search: Search, q: GoogleQuery): Promise<GoogleListRow[]> {
  const [campaignLevel, groupLevel, shared, lists] = await Promise.all([
    search(
      `SELECT campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign.id, campaign.name FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD' AND campaign.status != 'REMOVED'${scope(q, false)}`,
    ),
    search(
      `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group.id, ad_group.name, campaign.id, campaign.name FROM ad_group_criterion WHERE ad_group_criterion.negative = TRUE AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'${scope(q)}`,
    ),
    search(
      `SELECT shared_set.id, shared_set.name, campaign.id, campaign.name FROM campaign_shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND campaign_shared_set.status = 'ENABLED'${scope(q, false)}`,
    ).catch(() => [] as GoogleRow[]),
    search(
      `SELECT shared_criterion.criterion_id, shared_criterion.keyword.text, shared_criterion.keyword.match_type, shared_set.id, shared_set.name FROM shared_criterion WHERE shared_criterion.type = 'KEYWORD' AND shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`,
    ).catch(() => [] as GoogleRow[]),
  ]);
  const listCampaigns = groupBy(shared, (r) => str(r.sharedSet?.id));
  const neg = (id: string, text: unknown, match: unknown, level: string, where: string, extra: Partial<GoogleListRow> = {}): GoogleListRow => ({
    id,
    name: keywordText(text, match),
    sub: where,
    status: { code: "NEGATIVE", label: "Negativa", tone: "off" },
    enabled: null,
    info: { match: MATCH[str(match)] ?? str(match), level, where },
    metrics: null,
    ...extra,
  });
  return [
    ...campaignLevel.map((r) =>
      neg(`c~${str(r.campaign?.id)}~${str(r.campaignCriterion?.criterionId)}`, r.campaignCriterion?.keyword?.text, r.campaignCriterion?.keyword?.matchType, "Campanha", str(r.campaign?.name), { campaign_id: str(r.campaign?.id) }),
    ),
    ...groupLevel.map((r) =>
      neg(`g~${str(r.adGroup?.id)}~${str(r.adGroupCriterion?.criterionId)}`, r.adGroupCriterion?.keyword?.text, r.adGroupCriterion?.keyword?.matchType, "Grupo de anúncios", `${str(r.campaign?.name)} › ${str(r.adGroup?.name)}`, { campaign_id: str(r.campaign?.id), ad_group_id: str(r.adGroup?.id) }),
    ),
    // A shared list counts when it is applied to a campaign in view.
    ...lists
      .filter((r) => (listCampaigns.get(str(r.sharedSet?.id)) ?? []).length > 0)
      .map((r) => {
        const used = listCampaigns.get(str(r.sharedSet?.id)) ?? [];
        return neg(
          `l~${str(r.sharedSet?.id)}~${str(r.sharedCriterion?.criterionId)}`,
          r.sharedCriterion?.keyword?.text,
          r.sharedCriterion?.keyword?.matchType,
          `Lista: ${str(r.sharedSet?.name)}`,
          used.map((u) => str(u.campaign?.name)).join(", "),
        );
      }),
  ];
}

/** Auction: impression share per campaign and, when Google allows, the competitors. */
async function auctionRows(search: Search, q: GoogleQuery) {
  const rows = (
    await search(
      `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.advertising_channel_type, metrics.impressions, ${SHARE_METRICS}, metrics.search_budget_lost_impression_share FROM campaign WHERE ${period(q)} AND campaign.advertising_channel_type IN ('SEARCH', 'SHOPPING') AND campaign.status != 'REMOVED'${scope(q, false)}`,
    )
  ).map((r): GoogleListRow => ({
    id: `c~${str(r.campaign?.id)}`,
    name: str(r.campaign?.name),
    sub: "Sua conta",
    status: statusOf(r.campaign?.status, r.campaign?.primaryStatus),
    enabled: null,
    campaign_id: str(r.campaign?.id),
    info: { domain: "Você", kind: "self" },
    metrics: metricsOf(r.metrics),
  }));
  let notice: string | undefined;
  try {
    const competitors = await search(
      `SELECT segments.auction_insight_domain, metrics.auction_insight_search_impression_share, metrics.auction_insight_search_overlap_rate, metrics.auction_insight_search_outranking_share, metrics.auction_insight_search_position_above_rate, metrics.auction_insight_search_top_impression_percentage, metrics.auction_insight_search_absolute_top_impression_percentage FROM campaign WHERE ${period(q)} AND campaign.advertising_channel_type = 'SEARCH'${scope(q, false)}`,
    );
    const byDomain = groupBy(competitors, (r) => str(r.segments?.auctionInsightDomain));
    for (const [domain, list] of byDomain) {
      const avg = (k: string) => {
        const v = list.map((r) => r.metrics?.[k]).filter((x) => x !== undefined && x !== null);
        return v.length ? (v.reduce((s, x) => s + num(x), 0) / v.length) * 100 : null;
      };
      rows.push({
        id: `d~${domain}`,
        name: domain,
        sub: "Concorrente",
        status: { code: "COMPETITOR", label: "Concorrente", tone: "off" },
        enabled: null,
        info: {
          domain,
          kind: "competitor",
          overlap: avg("auctionInsightSearchOverlapRate"),
          position_above: avg("auctionInsightSearchPositionAboveRate"),
          outranking: avg("auctionInsightSearchOutrankingShare"),
        },
        metrics: {
          search_is: avg("auctionInsightSearchImpressionShare"),
          top_pct: avg("auctionInsightSearchTopImpressionPercentage"),
          abs_top_pct: avg("auctionInsightSearchAbsoluteTopImpressionPercentage"),
        },
      });
    }
  } catch {
    notice =
      "Os concorrentes do leilão só vêm do Google para contas com acesso liberado à API de informações de leilão. Aqui aparecem as parcelas de impressões das suas campanhas de pesquisa e shopping.";
  }
  return { rows, notice };
}

/** Audiences and segments: age, gender, devices, locations, day and hour. */
async function audienceRows(search: Search, q: GoogleQuery): Promise<GoogleListRow[]> {
  const aggregate = (list: GoogleRow[], key: (r: GoogleRow) => string, label: (k: string) => string, order?: (k: string) => number) =>
    [...groupBy(list, key).entries()]
      .filter(([k]) => k)
      .map(([k, rows]): GoogleListRow => ({
        id: k,
        name: label(k),
        status: { code: "SEGMENT", label: "", tone: "off" },
        enabled: null,
        info: {},
        metrics: rows.reduce<Metrics>((acc, r) => addMetrics(acc, metricsOf(r.metrics)), {}),
      }))
      .sort((a, b) => (order ? order(a.id) - order(b.id) : (b.metrics?.cost ?? 0) - (a.metrics?.cost ?? 0)));
  const where = `WHERE ${period(q)}`;
  switch (q.view) {
    case "age": {
      const rows = await search(`SELECT ad_group_criterion.age_range.type, ${BASE_METRICS} FROM age_range_view ${where}${scope(q)}`);
      const order = Object.keys(AGE);
      return aggregate(rows, (r) => str(r.adGroupCriterion?.ageRange?.type), (k) => AGE[k] ?? k, (k) => order.indexOf(k));
    }
    case "gender": {
      const rows = await search(`SELECT ad_group_criterion.gender.type, ${BASE_METRICS} FROM gender_view ${where}${scope(q)}`);
      return aggregate(rows, (r) => str(r.adGroupCriterion?.gender?.type), (k) => GENDER[k] ?? k);
    }
    case "devices": {
      const rows = await search(`SELECT segments.device, ${BASE_METRICS} FROM ${q.ad_groups.length ? "ad_group" : "campaign"} ${where}${scope(q)}`);
      return aggregate(rows, (r) => str(r.segments?.device), (k) => DEVICE[k] ?? k);
    }
    case "day_of_week": {
      const rows = await search(`SELECT segments.day_of_week, ${BASE_METRICS} FROM ${q.ad_groups.length ? "ad_group" : "campaign"} ${where}${scope(q)}`);
      return aggregate(rows, (r) => str(r.segments?.dayOfWeek), (k) => WEEKDAY[k]?.[1] ?? k, (k) => WEEKDAY[k]?.[0] ?? 9);
    }
    case "hour": {
      const rows = await search(`SELECT segments.hour, ${BASE_METRICS} FROM ${q.ad_groups.length ? "ad_group" : "campaign"} ${where}${scope(q)}`);
      return aggregate(rows, (r) => str(r.segments?.hour), (k) => `${k.padStart(2, "0")}h`, (k) => num(k));
    }
    case "locations": {
      const field = q.geo === "country" ? "segments.geo_target_country" : q.geo === "region" ? "segments.geo_target_region" : "segments.geo_target_city";
      const camel = field.replace("segments.", "").replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
      const rows = await search(`SELECT ${field}, ${BASE_METRICS} FROM geographic_view ${where}${scope(q)}`);
      const list = aggregate(rows, (r) => str(r.segments?.[camel]), (k) => k).slice(0, 300);
      // geoTargetConstants/1001773 → "São Paulo, State of São Paulo, Brazil".
      const names = list.map((r) => r.id).filter((n) => /^geoTargetConstants\/\d+$/.test(n));
      if (names.length) {
        const found = await search(
          `SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${names.map((n) => `'${n}'`).join(",")})`,
        ).catch(() => [] as GoogleRow[]);
        const name = new Map(found.map((g) => [str(g.geoTargetConstant?.resourceName), g.geoTargetConstant ?? {}]));
        for (const r of list) {
          const g = name.get(r.id);
          if (g) {
            r.name = str(g.name) || r.id;
            r.sub = str(g.canonicalName);
          }
        }
      }
      return list;
    }
    default:
      throw new AdsError(400, "Visão inválida.");
  }
}

// ------------------------------------------------------------ one object
export async function googleDetail(search: Search, raw: Record<string, unknown>) {
  const q = googleQuery({ ...raw, view: raw.view ?? "campaigns" });
  const id = String(raw.id ?? "");
  const parts = id.split("~");
  if (!parts.every((p) => ID.test(p))) throw new AdsError(400, "Item inválido.");
  const where =
    q.view === "campaigns"
      ? `campaign.id = ${parts[0]}`
      : q.view === "ad_groups"
        ? `ad_group.id = ${parts[0]}`
        : q.view === "ads"
          ? `ad_group.id = ${parts[0]} AND ad_group_ad.ad.id = ${parts[1]}`
          : q.view === "keywords"
            ? `ad_group.id = ${parts[0]} AND ad_group_criterion.criterion_id = ${parts[1]}`
            : q.view === "asset_groups"
              ? `asset_group.id = ${parts[0]}`
              : null;
  if (!where) throw new AdsError(400, "Esta visão não tem detalhes.");
  const resource = {
    campaigns: "campaign",
    ad_groups: "ad_group",
    ads: "ad_group_ad",
    keywords: "keyword_view",
    asset_groups: "asset_group",
  }[q.view as "campaigns"];
  const [days, devices] = await Promise.all([
    search(`SELECT segments.date, ${BASE_METRICS} FROM ${resource} WHERE ${period(q)} AND ${where}`),
    search(`SELECT segments.device, ${BASE_METRICS} FROM ${resource} WHERE ${period(q)} AND ${where}`),
  ]);
  const byDay = groupBy(days, (r) => str(r.segments?.date));
  const byDevice = groupBy(devices, (r) => str(r.segments?.device));
  const sum = (list: GoogleRow[]) => list.reduce<Metrics>((acc, r) => addMetrics(acc, metricsOf(r.metrics)), {});
  return {
    days: [...byDay.entries()].map(([day, list]) => ({ day, metrics: sum(list) })).sort((a, b) => a.day.localeCompare(b.day)),
    devices: [...byDevice.entries()].map(([k, list]) => ({ key: k, label: DEVICE[k] ?? k, metrics: sum(list) })).sort((a, b) => (b.metrics.cost ?? 0) - (a.metrics.cost ?? 0)),
  };
}

// ------------------------------------------------------------ reports
export type GoogleReportSources = {
  platform: string;
  cycles: {
    id: string;
    start_date: string;
    end_date: string;
    objective: "lead" | "sale" | "message" | "traffic" | "engagement" | "custom" | "video";
    destination: "lead_form" | "external_page" | "make_landing_page";
    conversion_actions: string[] | null;
  }[];
  links: { account_id: string; campaign_id: string; manager_id: string }[];
};
type Day = { d: string; s: number; i: number; c: number; r: number };
type Item = {
  id: string;
  name: string;
  adset?: string;
  campaign?: string;
  thumb?: string;
  title?: string;
  body?: string;
  link?: string;
  kind?: string;
  days: Day[];
};
const IMAGE_HOSTS = /(^|\.)(googleusercontent\.com|googlesyndication\.com|gstatic\.com|ytimg\.com|ggpht\.com)$/;

/**
 * What a report keeps of Google: every ad's, ad group's, keyword's and
 * search term's days in the periods, with the cycle's result rule (the
 * conversions it chose, or its objective's categories: the daily sync's
 * googleTotals), and the top ads' texts and first image.
 */
export async function googleReportMeta(
  searchFor: (account: string, manager: string) => Search,
  sources: GoogleReportSources,
  ranges: { start: string; end: string }[],
  adsLimit: number,
  fetchImpl: Fetch,
): Promise<ReportMeta & { keywords: Item[]; search_terms: Item[] }> {
  for (const r of ranges) {
    if (!DAY.test(r.start) || !DAY.test(r.end)) throw new AdsError(400, "Período inválido.");
    checkRange(r.start, r.end);
  }
  const cycleOn = (day: string) =>
    [...sources.cycles].reverse().find((c) => c.start_date <= day && day <= c.end_date) ??
    sources.cycles[sources.cycles.length - 1];
  const ad_results = sources.cycles.some(
    (c) => c.destination !== "make_landing_page" || c.objective === "traffic" || c.objective === "engagement",
  );
  const accounts = new Map<string, { manager: string; campaigns: Set<string> | null }>();
  for (const l of sources.links) {
    const id = String(l.account_id).replace(/-/g, "");
    if (!ID.test(id)) continue;
    const manager = String(l.manager_id ?? "").replace(/-/g, "");
    const entry = accounts.get(id) ?? { manager: ID.test(manager) ? manager : "", campaigns: new Set<string>() };
    if (!l.campaign_id) entry.campaigns = null;
    else entry.campaigns?.add(l.campaign_id);
    accounts.set(id, entry);
  }
  const lists = { ads: new Map<string, Item>(), adsets: new Map<string, Item>(), keywords: new Map<string, Item>(), search_terms: new Map<string, Item>() };
  let currency = "BRL";
  const metrics = "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.phone_calls";
  for (const [account, { manager, campaigns }] of accounts) {
    const search = searchFor(account, manager);
    const [info] = await search("SELECT customer.currency_code FROM customer");
    currency = str(info?.customer?.currencyCode) || currency;
    const filter = campaigns?.size ? ` AND campaign.id IN (${[...campaigns].filter((c) => ID.test(c)).join(",")})` : "";
    type Spec = { list: keyof typeof lists; from: string; fields: string; key: (r: GoogleRow) => string; make: (r: GoogleRow) => Omit<Item, "days">; limit?: number };
    const specs: Spec[] = [
      {
        list: "ads",
        from: "ad_group_ad",
        fields: "ad_group.id, ad_group.name, campaign.name, ad_group_ad.ad.id",
        key: (r) => `${str(r.adGroup?.id)}~${str(r.adGroupAd?.ad?.id)}`,
        make: (r) => ({ id: `${str(r.adGroup?.id)}~${str(r.adGroupAd?.ad?.id)}`, name: "", adset: str(r.adGroup?.name), campaign: str(r.campaign?.name) }),
      },
      {
        list: "adsets",
        from: "ad_group",
        fields: "ad_group.id, ad_group.name, campaign.name",
        key: (r) => str(r.adGroup?.id),
        make: (r) => ({ id: str(r.adGroup?.id), name: str(r.adGroup?.name), campaign: str(r.campaign?.name) }),
      },
      {
        list: "keywords",
        from: "keyword_view",
        fields: "ad_group.id, ad_group.name, campaign.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type",
        key: (r) => `${str(r.adGroup?.id)}~${str(r.adGroupCriterion?.criterionId)}`,
        make: (r) => ({
          id: `${str(r.adGroup?.id)}~${str(r.adGroupCriterion?.criterionId)}`,
          name: keywordText(r.adGroupCriterion?.keyword?.text, r.adGroupCriterion?.keyword?.matchType),
          adset: str(r.adGroup?.name),
          campaign: str(r.campaign?.name),
          kind: MATCH[str(r.adGroupCriterion?.keyword?.matchType)],
        }),
      },
      {
        list: "search_terms",
        from: "search_term_view",
        fields: "ad_group.id, ad_group.name, campaign.name, search_term_view.search_term",
        key: (r) => `${str(r.adGroup?.id)}~${str(r.searchTermView?.searchTerm)}`,
        make: (r) => ({ id: `${str(r.adGroup?.id)}~${str(r.searchTermView?.searchTerm)}`, name: str(r.searchTermView?.searchTerm), adset: str(r.adGroup?.name), campaign: str(r.campaign?.name) }),
        limit: 10000,
      },
    ];
    for (const range of ranges) {
      const when = `segments.date BETWEEN '${range.start}' AND '${range.end}'`;
      await Promise.all(
        specs.map(async (spec) => {
          const tail = spec.limit ? ` ORDER BY metrics.impressions DESC LIMIT ${spec.limit}` : "";
          const [rows, actionRows] = await Promise.all([
            search(`SELECT segments.date, ${spec.fields}, ${metrics} FROM ${spec.from} WHERE ${when}${filter}${tail}`),
            // The conversions per action (a segment cost can't come with).
            search(
              `SELECT segments.date, ${spec.fields}, segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions FROM ${spec.from} WHERE ${when}${filter}`,
            ).catch((e) => {
              // The ads and ad groups must have them; terms may not.
              if (spec.list === "search_terms" || spec.list === "keywords") return [] as GoogleRow[];
              throw e;
            }),
          ]);
          const actions = new Map<string, ConversionAction[]>();
          for (const r of actionRows) {
            const id = actionId(r.segments?.conversionAction);
            if (!id) continue;
            const k = `${str(r.segments?.date)}|${spec.key(r)}`;
            actions.set(k, [
              ...(actions.get(k) ?? []),
              { id, name: str(r.segments?.conversionActionName) || id, category: str(r.segments?.conversionActionCategory), conversions: num(r.metrics?.conversions) },
            ]);
          }
          const map = lists[spec.list];
          for (const r of rows) {
            const day = str(r.segments?.date);
            const cycle = cycleOn(day);
            const t = cycle
              ? googleTotals(cycle, r as never, actions.get(`${day}|${spec.key(r)}`) ?? [])
              : { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
            const item = map.get(spec.key(r)) ?? { ...spec.make(r), days: [] };
            const same = item.days.find((x) => x.d === day);
            const d = { d: day, s: t.spend, i: t.impressions, c: t.clicks, r: t.conversions };
            if (same) {
              same.s += d.s;
              same.i += d.i;
              same.c += d.c;
              same.r += d.r;
            } else item.days.push(d);
            map.set(spec.key(r), item);
          }
        }),
      );
    }
    // The ads' texts and first image (the ones that spent the most).
    const spent = (i: Item) => i.days.reduce((s, d) => s + d.s, 0);
    const top = [...lists.ads.values()].filter((a) => !a.name).sort((a, b) => spent(b) - spent(a));
    const ids = top.map((a) => a.id.split("~")[1]).filter((x) => ID.test(x));
    if (ids.length) {
      const found = await search(
        `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.descriptions, ad_group_ad.ad.responsive_display_ad.marketing_images, ad_group_ad.ad.image_ad.image_url FROM ad_group_ad WHERE ad_group_ad.ad.id IN (${ids.slice(0, 500).join(",")})`,
      ).catch(() => [] as GoogleRow[]);
      const byId = new Map(found.map((r) => [`${str(r.adGroup?.id)}~${str(r.adGroupAd?.ad?.id)}`, r]));
      const images = new Map<string, string>();
      const assetNames = [
        ...new Set(
          top
            .slice(0, adsLimit)
            .flatMap((a) => {
              const m = byId.get(a.id)?.adGroupAd?.ad?.responsiveDisplayAd?.marketingImages;
              return Array.isArray(m) && m[0]?.asset ? [str(m[0].asset)] : [];
            })
            .filter((n) => /^customers\/\d+\/assets\/\d+$/.test(n)),
        ),
      ];
      if (assetNames.length) {
        const assets = await search(
          `SELECT asset.resource_name, asset.image_asset.full_size.url FROM asset WHERE asset.resource_name IN (${assetNames.map((n) => `'${n}'`).join(",")})`,
        ).catch(() => [] as GoogleRow[]);
        for (const a of assets) images.set(str(a.asset?.resourceName), str(a.asset?.imageAsset?.fullSize?.url));
      }
      await Promise.all(
        top.map(async (item, index) => {
          const ad = byId.get(item.id)?.adGroupAd?.ad ?? {};
          const headlines = [...texts(ad.responsiveSearchAd?.headlines), ...texts(ad.responsiveDisplayAd?.headlines)];
          const descriptions = [...texts(ad.responsiveSearchAd?.descriptions), ...texts(ad.responsiveDisplayAd?.descriptions)];
          item.name = headlines[0] || AD_TYPE[str(ad.type)] || item.id;
          item.title = headlines.slice(0, 3).join(" | ").slice(0, 300) || undefined;
          item.body = descriptions.slice(0, 2).join(" ").slice(0, 1200) || undefined;
          item.link = str(ad.finalUrls?.[0]) || undefined;
          item.kind = AD_TYPE[str(ad.type)];
          if (index >= adsLimit) return;
          const first =
            str(ad.imageAd?.imageUrl) ||
            images.get(str(ad.responsiveDisplayAd?.marketingImages?.[0]?.asset)) ||
            "";
          if (first) item.thumb = await inlineImage(fetchImpl, first, IMAGE_HOSTS);
        }),
      );
    }
  }
  const sortItems = (m: Map<string, Item>, limit: number, byClicks = false) =>
    [...m.values()]
      .map((i) => ({ ...i, days: i.days.sort((a, b) => a.d.localeCompare(b.d)) }))
      .filter((i) => i.days.some((d) => d.i > 0 || d.s > 0))
      .sort((a, b) =>
        byClicks
          ? b.days.reduce((s, d) => s + d.c, 0) - a.days.reduce((s, d) => s + d.c, 0)
          : b.days.reduce((s, d) => s + d.s, 0) - a.days.reduce((s, d) => s + d.s, 0),
      )
      .slice(0, limit);
  return {
    currency,
    // Google has no deduplicated reach for these campaigns.
    reach: null,
    ...(ranges.length > 1 ? { compare_reach: null } : {}),
    ad_results,
    ads: sortItems(lists.ads, 200),
    adsets: sortItems(lists.adsets, 100),
    keywords: sortItems(lists.keywords, 100),
    search_terms: sortItems(lists.search_terms, 100, true),
  };
}

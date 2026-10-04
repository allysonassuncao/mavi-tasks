import { AdsError, graph, graphAll, type AdsEnv, type Fetch } from "./_ads.js";
import { metaResults } from "./_ads-sync.js";
import { ruleOn, type MetaConversionRule } from "./_meta-conversions.js";

/**
 * Campanhas › Plataforma and Relatórios: the Meta ad account read live, as
 * the Ads Manager shows it (read only: the connection has ads_read).
 *
 * - platformList: the campaigns, ad sets or ads of an account (optionally
 *   under chosen campaigns or ad sets) with their delivery, budget, bid
 *   strategy, schedule and the period's numbers; the "Resultados" column
 *   follows each ad set's optimization goal, as the Ads Manager does; an
 *   optional breakdown (age, gender, placement, device, time…) comes as
 *   sub-rows.
 * - platformDetail: an object's days and its age/gender and placement split.
 * - platformPreview: the ad's preview (Meta's own iframe).
 * - reportMeta: what a report keeps of Meta when it is created — each ad's
 *   and ad set's days (with the cycle's result rule, api/_ads-sync.ts), the
 *   period's reach and the top ads' creative image (inline, so the report
 *   still shows it when Facebook's links expire).
 *
 * Nothing here is stored or polled: the tab asks when someone opens it or
 * presses "Atualizar".
 */

export type PlatformLevel = "campaign" | "adset" | "ad";
export const BREAKDOWNS = {
  age: { breakdowns: "age" },
  gender: { breakdowns: "gender" },
  age_gender: { breakdowns: "age,gender" },
  country: { breakdowns: "country" },
  region: { breakdowns: "region" },
  platform: { breakdowns: "publisher_platform" },
  placement: { breakdowns: "publisher_platform,platform_position" },
  device: { breakdowns: "impression_device" },
  day: { time_increment: "1" },
  week: { time_increment: "7" },
  month: { time_increment: "monthly" },
} as const;
export type Breakdown = keyof typeof BREAKDOWNS;

type Action = { action_type: string; value: string };
type InsightRow = Record<string, unknown> & {
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  date_start?: string;
  date_stop?: string;
  actions?: Action[];
  action_values?: Action[];
};
type PromotedObject = {
  custom_event_type?: string;
  custom_conversion_id?: string;
  custom_event_str?: string;
  pixel_id?: string;
  page_id?: string;
};
type AdsetInfo = {
  id: string;
  campaign_id?: string;
  optimization_goal?: string;
  promoted_object?: PromotedObject;
  destination_type?: string;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9]{1,30}$/;

// ------------------------------------------------------------ results
/** What an ad set's "Resultados" counts, by its optimization goal. */
export type ResultSpec = {
  /** Action types, the first one present wins; or a metric (reach…). */
  actions?: string[];
  metric?: "reach" | "impressions" | "inline_link_clicks";
  /** A video field (list of actions) instead of `actions`. */
  field?: string;
  label: string;
};
const PIXEL_EVENTS: Record<string, [string, string]> = {
  LEAD: ["lead", "Leads no site"],
  PURCHASE: ["purchase", "Compras no site"],
  COMPLETE_REGISTRATION: ["complete_registration", "Cadastros concluídos"],
  ADD_TO_CART: ["add_to_cart", "Adições ao carrinho"],
  INITIATED_CHECKOUT: ["initiate_checkout", "Finalizações de compra iniciadas"],
  ADD_PAYMENT_INFO: ["add_payment_info", "Informações de pagamento adicionadas"],
  CONTENT_VIEW: ["view_content", "Visualizações do conteúdo"],
  CONTACT: ["contact", "Contatos"],
  SCHEDULE: ["schedule", "Agendamentos"],
  SUBMIT_APPLICATION: ["submit_application", "Inscrições enviadas"],
  START_TRIAL: ["start_trial", "Avaliações gratuitas iniciadas"],
  SUBSCRIBE: ["subscribe", "Assinaturas"],
  SEARCH: ["search", "Pesquisas"],
  ADD_TO_WISHLIST: ["add_to_wishlist", "Adições à lista de desejos"],
  DONATE: ["donate", "Doações"],
  FIND_LOCATION: ["find_location", "Pesquisas de localização"],
  CUSTOMIZE_PRODUCT: ["customize_product", "Personalizações de produto"],
};
export function resultSpec(adset: AdsetInfo | undefined): ResultSpec | null {
  const goal = adset?.optimization_goal ?? "";
  const promoted = adset?.promoted_object ?? {};
  switch (goal) {
    case "LEAD_GENERATION":
    case "QUALITY_LEAD":
      return {
        actions: ["onsite_conversion.lead_grouped", "leadgen_grouped", "lead"],
        label: "Leads no formulário",
      };
    case "OFFSITE_CONVERSIONS":
    case "VALUE":
    case "INCREMENTAL_OFFSITE_CONVERSIONS": {
      if (promoted.custom_conversion_id)
        return {
          actions: [`offsite_conversion.custom.${promoted.custom_conversion_id}`],
          label: "Conversões personalizadas",
        };
      const event = promoted.custom_event_type ?? (goal === "VALUE" ? "PURCHASE" : "");
      const known = PIXEL_EVENTS[event];
      if (known)
        return {
          actions: [
            `offsite_conversion.fb_pixel_${known[0]}`,
            known[0] === "lead" ? "lead" : known[0],
          ],
          label: known[1],
        };
      return {
        actions: ["offsite_conversion.fb_pixel_custom"],
        label: promoted.custom_event_str
          ? `Conversões: ${promoted.custom_event_str}`
          : "Conversões no site",
      };
    }
    case "LINK_CLICKS":
      return { metric: "inline_link_clicks", label: "Cliques no link" };
    case "LANDING_PAGE_VIEWS":
      return {
        actions: ["landing_page_view"],
        label: "Visualizações da página de destino",
      };
    case "REACH":
      return { metric: "reach", label: "Alcance" };
    case "IMPRESSIONS":
      return { metric: "impressions", label: "Impressões" };
    case "THRUPLAY":
      return { field: "video_thruplay_watched_actions", label: "ThruPlays" };
    case "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS":
      return {
        field: "video_continuous_2_sec_watched_actions",
        label: "Reproduções contínuas de 2 segundos",
      };
    case "POST_ENGAGEMENT":
      return { actions: ["post_engagement"], label: "Engajamentos com a publicação" };
    case "PAGE_LIKES":
      return { actions: ["like"], label: "Curtidas da Página" };
    case "CONVERSATIONS":
      return {
        actions: ["onsite_conversion.messaging_conversation_started_7d"],
        label: "Conversas por mensagem iniciadas",
      };
    case "REPLIES":
      return {
        actions: ["onsite_conversion.messaging_first_reply"],
        label: "Novos contatos de mensagem",
      };
    case "APP_INSTALLS":
      return {
        actions: ["mobile_app_install", "app_install", "omni_app_install"],
        label: "Instalações do app",
      };
    case "EVENT_RESPONSES":
      return { actions: ["rsvp"], label: "Respostas ao evento" };
    case "AD_RECALL_LIFT":
      return { metric: "reach", label: "Alcance" };
    case "VISIT_INSTAGRAM_PROFILE":
    case "PROFILE_VISIT":
      return {
        actions: ["onsite_conversion.ig_profile_visit", "profile_visit"],
        label: "Visitas ao perfil do Instagram",
      };
    default:
      return null;
  }
}
const specKey = (s: ResultSpec | null) =>
  s ? `${s.label}|${s.metric ?? s.field ?? s.actions?.join(",")}` : "";

const actionValue = (list: Action[] | undefined, type: string) =>
  num(list?.find((a) => a.action_type === type)?.value);
const hasAction = (list: Action[] | undefined, type: string) =>
  !!list?.some((a) => a.action_type === type);

export function resultValue(row: InsightRow, spec: ResultSpec | null) {
  if (!spec) return null;
  if (spec.metric) return num(row[spec.metric]);
  if (spec.field)
    return num(
      (row[spec.field] as Action[] | undefined)?.find(
        (a) => a.action_type === "video_view",
      )?.value ?? (row[spec.field] as Action[] | undefined)?.[0]?.value,
    );
  const types = spec.actions ?? [];
  const found = types.find((t) => hasAction(row.actions, t));
  return found ? actionValue(row.actions, found) : 0;
}

// ------------------------------------------------------------ metrics
/** The numbers the table adds up; rates are derived on the page. */
export type Metrics = Record<string, number | null>;
const VIDEO_FIELDS = [
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p95_watched_actions",
  "video_p100_watched_actions",
  "video_thruplay_watched_actions",
  "video_avg_time_watched_actions",
  "video_play_actions",
];
export const INSIGHT_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "inline_link_clicks",
  "unique_inline_link_clicks",
  "outbound_clicks",
  "actions",
  "action_values",
  ...VIDEO_FIELDS,
].join(",");
const RANKINGS = "quality_ranking,engagement_rate_ranking,conversion_rate_ranking";

const firstValue = (row: InsightRow, field: string) =>
  num((row[field] as Action[] | undefined)?.[0]?.value);

export function metricsOf(row: InsightRow, spec: ResultSpec | null): Metrics {
  const a = row.actions;
  const v = row.action_values;
  const lead = hasAction(a, "lead")
    ? actionValue(a, "lead")
    : actionValue(a, "onsite_conversion.lead_grouped") +
      actionValue(a, "offsite_conversion.fb_pixel_lead");
  const purchases = hasAction(a, "purchase")
    ? actionValue(a, "purchase")
    : actionValue(a, "offsite_conversion.fb_pixel_purchase");
  const purchaseValue = hasAction(v, "purchase")
    ? actionValue(v, "purchase")
    : actionValue(v, "offsite_conversion.fb_pixel_purchase");
  const plays = firstValue(row, "video_play_actions");
  return {
    spend: num(row.spend),
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    link_clicks: num(row.inline_link_clicks),
    unique_link_clicks: num(row.unique_inline_link_clicks),
    outbound_clicks: firstValue(row, "outbound_clicks"),
    results: resultValue(row, spec),
    leads: lead,
    landing_page_views: actionValue(a, "landing_page_view"),
    purchases,
    purchase_value: purchaseValue,
    add_to_cart:
      actionValue(a, "add_to_cart") ||
      actionValue(a, "offsite_conversion.fb_pixel_add_to_cart"),
    initiate_checkout:
      actionValue(a, "initiate_checkout") ||
      actionValue(a, "offsite_conversion.fb_pixel_initiate_checkout"),
    complete_registration:
      actionValue(a, "complete_registration") ||
      actionValue(a, "offsite_conversion.fb_pixel_complete_registration"),
    messaging_started: actionValue(
      a,
      "onsite_conversion.messaging_conversation_started_7d",
    ),
    messaging_replies: actionValue(a, "onsite_conversion.messaging_first_reply"),
    post_engagement: actionValue(a, "post_engagement"),
    page_engagement: actionValue(a, "page_engagement"),
    reactions: actionValue(a, "post_reaction"),
    comments: actionValue(a, "comment"),
    shares: actionValue(a, "post"),
    saves: actionValue(a, "onsite_conversion.post_save"),
    page_likes: actionValue(a, "like"),
    video_views: actionValue(a, "video_view"),
    video_plays: plays,
    thruplays: firstValue(row, "video_thruplay_watched_actions"),
    video_p25: firstValue(row, "video_p25_watched_actions"),
    video_p50: firstValue(row, "video_p50_watched_actions"),
    video_p75: firstValue(row, "video_p75_watched_actions"),
    video_p95: firstValue(row, "video_p95_watched_actions"),
    video_p100: firstValue(row, "video_p100_watched_actions"),
    // An average: kept as seconds × plays so it adds up (the page divides).
    video_time_total:
      firstValue(row, "video_avg_time_watched_actions") * (plays || 0),
  };
}

// ------------------------------------------------------------ labels
const STATUS: Record<string, [string, "on" | "off" | "warn" | "bad"]> = {
  ACTIVE: ["Ativo", "on"],
  PAUSED: ["Desativado", "off"],
  CAMPAIGN_PAUSED: ["Campanha desativada", "off"],
  ADSET_PAUSED: ["Conjunto de anúncios desativado", "off"],
  IN_PROCESS: ["Em processamento", "warn"],
  WITH_ISSUES: ["Com problemas", "bad"],
  PENDING_REVIEW: ["Em análise", "warn"],
  DISAPPROVED: ["Reprovado", "bad"],
  PREAPPROVED: ["Pré-aprovado", "warn"],
  PENDING_BILLING_INFO: ["Pagamento pendente", "bad"],
  ARCHIVED: ["Arquivado", "off"],
  DELETED: ["Excluído", "off"],
};
export function deliveryOf(
  effective: string | undefined,
  configured: string | undefined,
  end: string | undefined,
  now: Date,
  learning?: string,
) {
  const code = effective ?? configured ?? "";
  if (code === "ACTIVE" && end && new Date(end) < now)
    return { code: "COMPLETED", label: "Concluído", tone: "off" as const };
  if (code === "ACTIVE" && learning === "LEARNING")
    return { code: "LEARNING", label: "Aprendizado", tone: "on" as const };
  if (code === "ACTIVE" && learning === "FAIL")
    return { code: "LEARNING_LIMITED", label: "Aprendizado limitado", tone: "warn" as const };
  const [label, tone] = STATUS[code] ?? [code || "—", "off" as const];
  return { code, label, tone };
}
export const BID_STRATEGY: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: "Maior volume",
  LOWEST_COST_WITH_BID_CAP: "Limite de lance",
  COST_CAP: "Meta de custo por resultado",
  LOWEST_COST_WITH_MIN_ROAS: "Meta de ROAS",
  TARGET_COST: "Custo desejado",
};
export const OBJECTIVE: Record<string, string> = {
  OUTCOME_LEADS: "Cadastros",
  OUTCOME_SALES: "Vendas",
  OUTCOME_TRAFFIC: "Tráfego",
  OUTCOME_ENGAGEMENT: "Engajamento",
  OUTCOME_AWARENESS: "Reconhecimento",
  OUTCOME_APP_PROMOTION: "Promoção do app",
  LEAD_GENERATION: "Geração de cadastros",
  CONVERSIONS: "Conversões",
  LINK_CLICKS: "Tráfego",
  MESSAGES: "Mensagens",
  POST_ENGAGEMENT: "Engajamento",
  VIDEO_VIEWS: "Visualizações do vídeo",
  REACH: "Alcance",
  BRAND_AWARENESS: "Reconhecimento da marca",
  PAGE_LIKES: "Curtidas da Página",
  APP_INSTALLS: "Instalações do app",
};
/** "7d_click_1d_view" → the Ads Manager's words. */
export function attributionLabel(value: unknown) {
  const text = String(value ?? "");
  if (!text) return "";
  const parts = text.split(/_(?=\d)/).map((p) => {
    const m = p.match(/^(\d+)d_(click|view|ev)$/);
    if (!m) return p;
    const days = `${m[1]} ${m[1] === "1" ? "dia" : "dias"}`;
    return m[2] === "click"
      ? `${days} após o clique`
      : m[2] === "view"
        ? `${days} após a visualização`
        : `${days} após o engajamento`;
  });
  return parts.join(" ou ");
}
// Meta amounts come in the currency's smallest unit.
const ZERO_DECIMAL = new Set([
  "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND",
]);
export const fromMinor = (value: unknown, currency: string) =>
  value === undefined || value === null || value === ""
    ? null
    : num(value) / (ZERO_DECIMAL.has(currency) ? 1 : 100);

const GENDER: Record<string, string> = {
  male: "Masculino",
  female: "Feminino",
  unknown: "Desconhecido",
};
const PUBLISHER: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  audience_network: "Audience Network",
  messenger: "Messenger",
  threads: "Threads",
  whatsapp: "WhatsApp",
};
const POSITION: Record<string, string> = {
  feed: "Feed",
  story: "Stories",
  facebook_stories: "Stories",
  instagram_stories: "Stories",
  reels: "Reels",
  facebook_reels: "Reels",
  instagram_reels: "Reels",
  facebook_reels_overlay: "Anúncios sobrepostos no Reels",
  instream_video: "Vídeos in-stream",
  marketplace: "Marketplace",
  search: "Resultados da pesquisa",
  instagram_search: "Resultados da pesquisa",
  explore: "Explorar",
  instagram_explore: "Explorar",
  instagram_explore_grid_home: "Página inicial do Explorar",
  right_hand_column: "Coluna da direita",
  video_feeds: "Feeds de vídeo",
  profile_feed: "Feed do perfil",
  instagram_profile_feed: "Feed do perfil",
  messenger_inbox: "Caixa de entrada",
  messenger_stories: "Stories",
  an_classic: "Nativo, banner e intersticial",
  rewarded_video: "Vídeos premiados",
  threads_feed: "Feed",
  notification: "Notificações",
};
const DEVICE: Record<string, string> = {
  desktop: "Computador",
  iphone: "iPhone",
  ipad: "iPad",
  ipod: "iPod",
  android_smartphone: "Celular Android",
  android_tablet: "Tablet Android",
  mobile_web: "Web no celular",
  other: "Outros",
};
const pretty = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "—";
export function breakdownKey(kind: Breakdown, row: InsightRow) {
  const g = (k: string) => String(row[k] ?? "");
  switch (kind) {
    case "age":
      return { key: g("age"), label: g("age") || "Desconhecido" };
    case "gender":
      return { key: g("gender"), label: GENDER[g("gender")] ?? pretty(g("gender")) };
    case "age_gender":
      return {
        key: `${g("age")}|${g("gender")}`,
        label: `${g("age") || "?"} · ${GENDER[g("gender")] ?? pretty(g("gender"))}`,
      };
    case "country":
      return { key: g("country"), label: g("country") || "Desconhecido" };
    case "region":
      return { key: g("region"), label: g("region") || "Desconhecido" };
    case "platform":
      return {
        key: g("publisher_platform"),
        label: PUBLISHER[g("publisher_platform")] ?? pretty(g("publisher_platform")),
      };
    case "placement":
      return {
        key: `${g("publisher_platform")}|${g("platform_position")}`,
        label: `${PUBLISHER[g("publisher_platform")] ?? pretty(g("publisher_platform"))} · ${
          POSITION[g("platform_position")] ?? pretty(g("platform_position"))
        }`,
      };
    case "device":
      return {
        key: g("impression_device"),
        label: DEVICE[g("impression_device")] ?? pretty(g("impression_device")),
      };
    default:
      return {
        key: g("date_start"),
        label:
          g("date_start") === g("date_stop") || !g("date_stop")
            ? g("date_start")
            : `${g("date_start")}|${g("date_stop")}`,
      };
  }
}

// ------------------------------------------------------------ requests
export type PlatformQuery = {
  account: string;
  level: PlatformLevel;
  since: string;
  until: string;
  /** "maximum": the account's whole life (since/until ignored). */
  preset?: "maximum";
  campaigns?: string[];
  adsets?: string[];
  breakdown?: Breakdown;
  archived?: boolean;
};
/** Checks and trims what the page sent. */
export function platformQuery(raw: Record<string, unknown>): PlatformQuery {
  const account = String(raw.account ?? "").replace(/^act_/i, "");
  if (!ID.test(account)) throw new AdsError(400, "Conta de anúncio inválida.");
  const level = raw.level as PlatformLevel;
  if (!["campaign", "adset", "ad"].includes(level))
    throw new AdsError(400, "Nível inválido.");
  const preset = raw.preset === "maximum" ? "maximum" : undefined;
  const since = String(raw.since ?? "");
  const until = String(raw.until ?? "");
  if (!preset) checkRange(since, until);
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.map(String).filter((x) => ID.test(x)).slice(0, 100) : [];
  const breakdown = raw.breakdown as Breakdown | undefined;
  if (breakdown && !(breakdown in BREAKDOWNS))
    throw new AdsError(400, "Detalhamento inválido.");
  return {
    account,
    level,
    since,
    until,
    preset,
    campaigns: ids(raw.campaigns),
    adsets: ids(raw.adsets),
    breakdown: breakdown || undefined,
    archived: raw.archived === true,
  };
}
export function checkRange(since: string, until: string) {
  if (!DAY.test(since) || !DAY.test(until) || until < since)
    throw new AdsError(400, "Período inválido.");
  const days = (Date.parse(until) - Date.parse(since)) / 86_400_000;
  if (days > 37 * 31) throw new AdsError(400, "O Meta mostra até 37 meses.");
}
const timeParams = (
  q: Pick<PlatformQuery, "since" | "until" | "preset">,
): Record<string, string> =>
  q.preset
    ? { date_preset: q.preset }
    : { time_range: JSON.stringify({ since: q.since, until: q.until }) };

const DELIVERABLE = [
  "ACTIVE",
  "PAUSED",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "IN_PROCESS",
  "WITH_ISSUES",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
];
function filtering(
  q: PlatformQuery,
  withStatus: boolean,
  level: PlatformLevel,
): Record<string, string> {
  const f: { field: string; operator: string; value: unknown }[] = [];
  if (q.campaigns?.length)
    f.push({ field: "campaign.id", operator: "IN", value: q.campaigns });
  if (q.adsets?.length && level !== "campaign")
    f.push({ field: "adset.id", operator: "IN", value: q.adsets });
  if (withStatus)
    f.push({
      field: "effective_status",
      operator: "IN",
      value: q.archived ? [...DELIVERABLE, "ARCHIVED"] : DELIVERABLE,
    });
  return f.length ? { filtering: JSON.stringify(f) } : {};
}

const STRUCTURE: Record<PlatformLevel, string> = {
  campaign:
    "id,name,objective,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,start_time,stop_time,buying_type,special_ad_categories,updated_time",
  adset:
    "id,name,campaign_id,campaign{name},effective_status,configured_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,optimization_goal,billing_event,promoted_object,destination_type,start_time,end_time,learning_stage_info,updated_time",
  ad: "id,name,campaign_id,adset_id,campaign{name},adset{name},effective_status,configured_status,creative{id,thumbnail_url,object_type,title,body,call_to_action_type,instagram_permalink_url,effective_object_story_id},updated_time",
};
const EDGE: Record<PlatformLevel, string> = {
  campaign: "campaigns",
  adset: "adsets",
  ad: "ads",
};

type StructureRow = Record<string, any> & { id: string; name?: string };

export type PlatformRow = {
  id: string;
  name: string;
  level: PlatformLevel;
  delivery: { code: string; label: string; tone: "on" | "off" | "warn" | "bad" };
  campaign_id: string;
  campaign_name: string;
  adset_id?: string;
  adset_name?: string;
  objective?: string;
  budget?: { amount: number; period: "daily" | "lifetime" } | { shared: "campaign" | "adset" } | null;
  bid_strategy?: string;
  optimization?: string;
  start?: string | null;
  end?: string | null;
  attribution?: string;
  creative?: {
    id?: string;
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

const OPTIMIZATION: Record<string, string> = {
  LEAD_GENERATION: "Cadastros",
  QUALITY_LEAD: "Cadastros de qualidade",
  OFFSITE_CONVERSIONS: "Conversões",
  VALUE: "Valor",
  LINK_CLICKS: "Cliques no link",
  LANDING_PAGE_VIEWS: "Visualizações da página de destino",
  REACH: "Alcance",
  IMPRESSIONS: "Impressões",
  THRUPLAY: "ThruPlays",
  POST_ENGAGEMENT: "Engajamento com a publicação",
  CONVERSATIONS: "Conversas",
  REPLIES: "Respostas",
  PAGE_LIKES: "Curtidas da Página",
  APP_INSTALLS: "Instalações do app",
  AD_RECALL_LIFT: "Lembrança do anúncio",
  PROFILE_VISIT: "Visitas ao perfil",
  VISIT_INSTAGRAM_PROFILE: "Visitas ao perfil",
};

function addMetrics(into: Metrics, m: Metrics) {
  for (const [k, v] of Object.entries(m))
    into[k] = v === null || into[k] === null ? null : (into[k] ?? 0) + v;
  return into;
}

/** The account's campaigns, ad sets or ads with the period's numbers. */
export async function platformList(
  env: AdsEnv,
  fetchImpl: Fetch,
  token: string,
  q: PlatformQuery,
  now = new Date(),
): Promise<PlatformList> {
  const act = `/act_${q.account}`;
  const base = { ...timeParams(q), limit: "500" };
  const needAdsets = q.level !== "adset";
  const [account, structure, adsets, insights, totalRows, split] =
    await Promise.all([
      graph<{ name?: string; currency?: string; timezone_name?: string }>(
        env,
        fetchImpl,
        token,
        act,
        { fields: "name,currency,timezone_name" },
      ),
      graphAll<StructureRow>(env, fetchImpl, token, `${act}/${EDGE[q.level]}`, {
        fields: STRUCTURE[q.level],
        limit: q.level === "ad" ? "200" : "500",
        ...filtering(q, true, q.level),
      }),
      // The ad sets' goals decide the "Resultados" of campaigns and ads.
      needAdsets
        ? graphAll<AdsetInfo>(env, fetchImpl, token, `${act}/adsets`, {
            fields: "id,campaign_id,optimization_goal,promoted_object,destination_type",
            limit: "500",
            ...filtering({ ...q, adsets: [] }, true, "adset"),
          })
        : Promise.resolve(null),
      graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
        ...base,
        level: q.level,
        fields: `campaign_id,adset_id,ad_id,attribution_setting,${INSIGHT_FIELDS}${q.level === "ad" ? `,${RANKINGS}` : ""}`,
        ...filtering(q, false, q.level),
      }),
      graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
        ...base,
        level: "account",
        fields: INSIGHT_FIELDS,
        ...filtering(q, false, q.level),
      }),
      q.breakdown
        ? graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
            ...base,
            level: q.level,
            fields: `campaign_id,adset_id,ad_id,${INSIGHT_FIELDS}`,
            ...BREAKDOWNS[q.breakdown],
            ...filtering(q, false, q.level),
          })
        : Promise.resolve(null),
    ]);
  const currency = account.currency ?? "BRL";
  const adsetInfo = new Map<string, AdsetInfo>(
    (adsets ?? (structure as AdsetInfo[])).map((a) => [a.id, a]),
  );
  // A campaign's result: its ad sets' if they all count the same thing.
  const campaignSpec = new Map<string, ResultSpec | null>();
  const campaignMixed = new Set<string>();
  for (const a of adsetInfo.values()) {
    if (!a.campaign_id) continue;
    const spec = resultSpec(a);
    if (!campaignSpec.has(a.campaign_id)) campaignSpec.set(a.campaign_id, spec);
    else if (specKey(campaignSpec.get(a.campaign_id)!) !== specKey(spec))
      campaignMixed.add(a.campaign_id);
  }
  const specOf = (id: string, row: StructureRow | InsightRow): ResultSpec | null =>
    q.level === "campaign"
      ? campaignMixed.has(id)
        ? null
        : (campaignSpec.get(id) ?? null)
      : resultSpec(adsetInfo.get(q.level === "adset" ? id : String(row.adset_id ?? "")));
  const idOf = (r: InsightRow) =>
    String(q.level === "campaign" ? r.campaign_id : q.level === "adset" ? r.adset_id : r.ad_id);
  const byId = new Map(insights.map((r) => [idOf(r), r]));
  const splitById = new Map<string, InsightRow[]>();
  for (const r of split ?? []) {
    const list = splitById.get(idOf(r)) ?? [];
    list.push(r);
    splitById.set(idOf(r), list);
  }
  // Campaigns sharing their budget with the ad sets (CBO or not).
  const campaignBudget = new Map<string, boolean>();
  if (q.level === "adset") {
    const ids = [...new Set(structure.map((s) => String(s.campaign_id)))];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const found = await graph<Record<string, { daily_budget?: string; lifetime_budget?: string }>>(
        env,
        fetchImpl,
        token,
        "/",
        { ids: chunk.join(","), fields: "daily_budget,lifetime_budget" },
      );
      for (const [id, c] of Object.entries(found))
        campaignBudget.set(id, !!(num(c.daily_budget) || num(c.lifetime_budget)));
    }
  }
  const labels = new Set<string>();
  const rows: PlatformRow[] = structure.map((s) => {
    const insight = byId.get(s.id) ?? {};
    const spec = specOf(s.id, { ...s, adset_id: s.adset_id });
    const mixed = q.level === "campaign" && campaignMixed.has(s.id);
    const result_label = mixed ? "Vários" : (spec?.label ?? "—");
    labels.add(result_label);
    const end = s.stop_time ?? s.end_time;
    const daily = fromMinor(s.daily_budget, currency);
    const lifetime = fromMinor(s.lifetime_budget, currency);
    const ownBudget = daily
      ? { amount: daily, period: "daily" as const }
      : lifetime
        ? { amount: lifetime, period: "lifetime" as const }
        : null;
    const row: PlatformRow = {
      id: s.id,
      name: s.name ?? s.id,
      level: q.level,
      delivery: deliveryOf(
        s.effective_status,
        s.configured_status,
        end,
        now,
        s.learning_stage_info?.status,
      ),
      campaign_id: q.level === "campaign" ? s.id : String(s.campaign_id ?? ""),
      campaign_name: q.level === "campaign" ? (s.name ?? "") : (s.campaign?.name ?? ""),
      ...(q.level === "ad"
        ? { adset_id: String(s.adset_id ?? ""), adset_name: s.adset?.name ?? "" }
        : {}),
      ...(q.level === "campaign"
        ? {
            objective: OBJECTIVE[s.objective] ?? pretty(String(s.objective ?? "").toLowerCase()),
            budget: ownBudget ?? { shared: "adset" as const },
            bid_strategy: BID_STRATEGY[s.bid_strategy] ?? (s.bid_strategy ? pretty(String(s.bid_strategy).toLowerCase()) : ""),
          }
        : {}),
      ...(q.level === "adset"
        ? {
            budget:
              ownBudget ??
              (campaignBudget.get(String(s.campaign_id)) ? { shared: "campaign" as const } : null),
            bid_strategy: BID_STRATEGY[s.bid_strategy] ?? "",
            optimization: OPTIMIZATION[s.optimization_goal] ?? pretty(String(s.optimization_goal ?? "").toLowerCase()),
          }
        : {}),
      ...(q.level !== "ad" ? { start: s.start_time ?? null, end: end ?? null } : {}),
      ...(q.level === "ad"
        ? {
            creative: {
              thumbnail: s.creative?.thumbnail_url,
              title: s.creative?.title,
              body: s.creative?.body,
              cta: s.creative?.call_to_action_type,
              type: s.creative?.object_type,
              link: s.creative?.instagram_permalink_url ??
                (s.creative?.effective_object_story_id
                  ? `https://www.facebook.com/${s.creative.effective_object_story_id}`
                  : undefined),
            },
            rankings: {
              quality: String(insight.quality_ranking ?? ""),
              engagement: String(insight.engagement_rate_ranking ?? ""),
              conversion: String(insight.conversion_rate_ranking ?? ""),
            },
          }
        : {}),
      attribution: attributionLabel(insight.attribution_setting),
      result_label,
      metrics: metricsOf(insight, mixed ? null : spec),
    };
    if (q.breakdown)
      row.breakdown = (splitById.get(s.id) ?? [])
        .map((r) => ({ ...breakdownKey(q.breakdown!, r), metrics: metricsOf(r, mixed ? null : spec) }))
        .sort((a, b) => (q.breakdown === "day" || q.breakdown === "week" || q.breakdown === "month" ? a.key.localeCompare(b.key) : (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0)));
    return row;
  });
  // The footer: the account's numbers under the same filter (deduplicated
  // reach); results only when every row counts the same thing.
  const one = labels.size === 1 ? [...labels][0] : "";
  const totals = metricsOf(totalRows[0] ?? {}, null);
  totals.results =
    one && one !== "—" && one !== "Vários"
      ? rows.reduce((s, r) => s + (r.metrics.results ?? 0), 0)
      : null;
  return {
    account: {
      id: q.account,
      name: account.name ?? q.account,
      currency,
      timezone: account.timezone_name ?? "",
    },
    rows,
    totals,
    result_label: one && one !== "—" ? one : labels.size > 1 ? "Vários" : "—",
    fetched_at: now.toISOString(),
  };
}

// ------------------------------------------------------------ several periods at once
/** A period of the insights worker (ciclo, 7 dias…). */
export type WindowRange = { key: string; since: string; until: string };
export type WindowRow = Omit<PlatformRow, "metrics" | "breakdown" | "rankings" | "budget" | "bid_strategy"> & {
  /** The numbers of each period, by its key. */
  windows: Record<string, Metrics>;
  breakdown?: { key: string; label: string; metrics: Metrics }[];
};
/**
 * The lean read of Campanhas › Insights da MAVI: the level's structure once
 * and ONE insights call with every period (time_ranges), instead of one
 * platformList per period (each with the account, the totals and the
 * structure again). Results count as in Ads Manager (the ad sets' goals).
 * The breakdown (age × gender…) comes for one period only.
 */
export async function platformWindows(
  env: AdsEnv,
  fetchImpl: Fetch,
  token: string,
  q: {
    account: string;
    level: PlatformLevel;
    campaigns: string[];
    ranges: WindowRange[];
    breakdown?: { kind: Breakdown; range: WindowRange };
  },
  now = new Date(),
): Promise<{ rows: WindowRow[]; result_label: string }> {
  if (!q.ranges.length) return { rows: [], result_label: "—" };
  for (const r of q.ranges) checkRange(r.since, r.until);
  const act = `/act_${q.account}`;
  const pq: PlatformQuery = {
    account: q.account,
    level: q.level,
    since: q.ranges[0].since,
    until: q.ranges[0].until,
    campaigns: q.campaigns,
    adsets: [],
  };
  const [structure, adsets, insights, split] = await Promise.all([
    graphAll<StructureRow>(env, fetchImpl, token, `${act}/${EDGE[q.level]}`, {
      fields: STRUCTURE[q.level],
      limit: q.level === "ad" ? "200" : "500",
      ...filtering(pq, true, q.level),
    }),
    q.level !== "adset"
      ? graphAll<AdsetInfo>(env, fetchImpl, token, `${act}/adsets`, {
          fields: "id,campaign_id,optimization_goal,promoted_object,destination_type",
          limit: "500",
          ...filtering({ ...pq, adsets: [] }, true, "adset"),
        })
      : Promise.resolve(null),
    graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
      level: q.level,
      limit: "500",
      time_ranges: JSON.stringify(q.ranges.map((r) => ({ since: r.since, until: r.until }))),
      fields: `campaign_id,adset_id,ad_id,${INSIGHT_FIELDS}`,
      ...filtering(pq, false, q.level),
    }),
    q.breakdown
      ? graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
          level: q.level,
          limit: "500",
          time_range: JSON.stringify({ since: q.breakdown.range.since, until: q.breakdown.range.until }),
          fields: `campaign_id,adset_id,ad_id,${INSIGHT_FIELDS}`,
          ...BREAKDOWNS[q.breakdown.kind],
          ...filtering(pq, false, q.level),
        })
      : Promise.resolve(null),
  ]);
  const adsetInfo = new Map<string, AdsetInfo>((adsets ?? (structure as AdsetInfo[])).map((a) => [a.id, a]));
  const campaignSpec = new Map<string, ResultSpec | null>();
  const campaignMixed = new Set<string>();
  for (const a of adsetInfo.values()) {
    if (!a.campaign_id) continue;
    const spec = resultSpec(a);
    if (!campaignSpec.has(a.campaign_id)) campaignSpec.set(a.campaign_id, spec);
    else if (specKey(campaignSpec.get(a.campaign_id)!) !== specKey(spec)) campaignMixed.add(a.campaign_id);
  }
  const idOf = (r: InsightRow | StructureRow) =>
    String(q.level === "campaign" ? (r.campaign_id ?? r.id) : q.level === "adset" ? (r.adset_id ?? r.id) : (r.ad_id ?? r.id));
  const keyOf = new Map(q.ranges.map((r) => [`${r.since}|${r.until}`, r.key]));
  const byId = new Map<string, Map<string, InsightRow>>();
  for (const r of insights) {
    const key = keyOf.get(`${r.date_start}|${r.date_stop}`);
    if (!key) continue;
    const id = String(q.level === "campaign" ? r.campaign_id : q.level === "adset" ? r.adset_id : r.ad_id);
    const m = byId.get(id) ?? new Map<string, InsightRow>();
    m.set(key, r);
    byId.set(id, m);
  }
  const splitById = new Map<string, InsightRow[]>();
  for (const r of split ?? []) {
    const id = String(q.level === "campaign" ? r.campaign_id : q.level === "adset" ? r.adset_id : r.ad_id);
    const list = splitById.get(id) ?? [];
    list.push(r);
    splitById.set(id, list);
  }
  const labels = new Set<string>();
  const rows: WindowRow[] = structure.map((s) => {
    const mixed = q.level === "campaign" && campaignMixed.has(s.id);
    const spec = mixed
      ? null
      : q.level === "campaign"
        ? (campaignSpec.get(s.id) ?? null)
        : resultSpec(adsetInfo.get(q.level === "adset" ? s.id : String(s.adset_id ?? "")));
    const result_label = mixed ? "Vários" : (spec?.label ?? "—");
    labels.add(result_label);
    const end = s.stop_time ?? s.end_time;
    const found = byId.get(idOf(s));
    const row: WindowRow = {
      id: s.id,
      name: s.name ?? s.id,
      level: q.level,
      delivery: deliveryOf(s.effective_status, s.configured_status, end, now, s.learning_stage_info?.status),
      campaign_id: q.level === "campaign" ? s.id : String(s.campaign_id ?? ""),
      campaign_name: q.level === "campaign" ? (s.name ?? "") : (s.campaign?.name ?? ""),
      ...(q.level === "ad" ? { adset_id: String(s.adset_id ?? ""), adset_name: s.adset?.name ?? "" } : {}),
      ...(q.level === "campaign"
        ? { objective: OBJECTIVE[s.objective] ?? pretty(String(s.objective ?? "").toLowerCase()) }
        : {}),
      ...(q.level === "adset"
        ? { optimization: OPTIMIZATION[s.optimization_goal] ?? pretty(String(s.optimization_goal ?? "").toLowerCase()) }
        : {}),
      ...(q.level === "ad"
        ? {
            creative: {
              id: s.creative?.id,
              title: s.creative?.title,
              body: s.creative?.body,
              cta: s.creative?.call_to_action_type,
              type: s.creative?.object_type,
            },
          }
        : {}),
      result_label,
      windows: Object.fromEntries(
        q.ranges.map((r) => [r.key, metricsOf(found?.get(r.key) ?? {}, mixed ? null : spec)]),
      ),
    };
    if (q.breakdown)
      row.breakdown = (splitById.get(idOf(s)) ?? [])
        .map((r) => ({ ...breakdownKey(q.breakdown!.kind, r), metrics: metricsOf(r, mixed ? null : spec) }))
        .sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0));
    return row;
  });
  const one = labels.size === 1 ? [...labels][0] : "";
  return { rows, result_label: one && one !== "—" ? one : labels.size > 1 ? "Vários" : "—" };
}

// ------------------------------------------------------------ one object
export async function platformDetail(
  env: AdsEnv,
  fetchImpl: Fetch,
  token: string,
  raw: Record<string, unknown>,
) {
  const q = platformQuery({ ...raw, level: raw.level ?? "campaign" });
  const id = String(raw.id ?? "");
  if (!ID.test(id)) throw new AdsError(400, "Item inválido.");
  // The object's result rule (the ad set's goal, or the campaign's ad sets').
  const goal = "id,optimization_goal,promoted_object";
  const adsets: AdsetInfo[] = await (q.level === "campaign"
    ? graphAll<AdsetInfo>(env, fetchImpl, token, `/${id}/adsets`, {
        fields: goal,
        limit: "200",
      })
    : graph<AdsetInfo & { adset?: AdsetInfo }>(env, fetchImpl, token, `/${id}`, {
        fields: q.level === "ad" ? `adset{${goal}}` : goal,
      }).then((o) => [q.level === "ad" ? o.adset : o].filter((a): a is AdsetInfo => !!a))
  ).catch(() => []);
  const specs = adsets.map((a) => resultSpec(a));
  const same = specs.length > 0 && specs.every((s) => specKey(s) === specKey(specs[0]));
  const spec = same ? specs[0] : null;
  const path = `/${id}/insights`;
  const base = { ...timeParams(q), fields: INSIGHT_FIELDS, limit: "500" };
  const [days, ageGender, placement] = await Promise.all([
    graphAll<InsightRow>(env, fetchImpl, token, path, { ...base, time_increment: "1" }),
    graphAll<InsightRow>(env, fetchImpl, token, path, { ...base, breakdowns: "age,gender" }),
    graphAll<InsightRow>(env, fetchImpl, token, path, {
      ...base,
      breakdowns: "publisher_platform,platform_position",
    }),
  ]);
  return {
    result_label: spec?.label ?? (specs.length > 1 ? "Vários" : "—"),
    days: days.map((r) => ({ day: String(r.date_start), metrics: metricsOf(r, spec) })),
    age_gender: ageGender.map((r) => ({
      age: String(r.age ?? ""),
      gender: String(r.gender ?? ""),
      metrics: metricsOf(r, spec),
    })),
    placements: placement
      .map((r) => ({ ...breakdownKey("placement", r), metrics: metricsOf(r, spec) }))
      .sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0)),
  };
}

export const PREVIEW_FORMATS = [
  "MOBILE_FEED_STANDARD",
  "DESKTOP_FEED_STANDARD",
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "INSTAGRAM_REELS",
  "FACEBOOK_STORY_MOBILE",
  "FACEBOOK_REELS_MOBILE",
  "RIGHT_COLUMN_STANDARD",
  "MARKETPLACE_MOBILE",
] as const;
/** Meta's preview of the ad: the address of its iframe (facebook.com only). */
export async function platformPreview(
  env: AdsEnv,
  fetchImpl: Fetch,
  token: string,
  raw: Record<string, unknown>,
) {
  const id = String(raw.id ?? "");
  if (!ID.test(id)) throw new AdsError(400, "Anúncio inválido.");
  const format = PREVIEW_FORMATS.includes(raw.format as (typeof PREVIEW_FORMATS)[number])
    ? String(raw.format)
    : "MOBILE_FEED_STANDARD";
  const body = await graph<{ data?: { body?: string }[] }>(
    env,
    fetchImpl,
    token,
    `/${id}/previews`,
    { ad_format: format },
  );
  return { src: previewSrc(body.data?.[0]?.body ?? ""), format };
}
export function previewSrc(html: string) {
  const m = html.match(/src="([^"]+)"/);
  if (!m) return null;
  const src = m[1].replace(/&amp;/g, "&");
  try {
    const url = new URL(src);
    return url.protocol === "https:" &&
      (url.hostname === "www.facebook.com" || url.hostname.endsWith(".facebook.com"))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ reports
export type ReportSources = {
  platform: string;
  cycles: {
    id: string;
    start_date: string;
    end_date: string;
    objective: Parameters<typeof metaResults>[0];
    destination: Parameters<typeof metaResults>[1];
    /** The cycle's "Conversões que contam" (null: by objective). */
    meta_conversions?: MetaConversionRule[] | null;
  }[];
  links: { account_id: string; campaign_id: string }[];
};
type ReportDay = { d: string; s: number; i: number; c: number; r: number };
type ReportItem = {
  id: string;
  name: string;
  adset?: string;
  campaign?: string;
  reach?: number;
  thumb?: string;
  title?: string;
  body?: string;
  link?: string;
  video?: boolean;
  days: ReportDay[];
};
export type ReportMeta = {
  currency: string;
  reach: number | null;
  /** The comparison period's deduplicated reach. */
  compare_reach?: number | null;
  ad_results: boolean;
  ads: ReportItem[];
  adsets: ReportItem[];
  error?: string;
};
const IMAGE_HOSTS = /(^|\.)(fbcdn\.net|facebook\.com|cdninstagram\.com|fbsbx\.com)$/;
const MAX_IMAGE = 160_000;
/** A creative's image as a data: address (kept inside the report). */
export async function inlineImage(
  fetchImpl: Fetch,
  src: string | undefined,
  hosts: RegExp = IMAGE_HOSTS,
) {
  if (!src) return undefined;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !hosts.test(url.hostname)) return undefined;
  try {
    const res = await fetchImpl(url.toString());
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE) return undefined;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * What a report keeps of Meta: every ad's and ad set's days in the period
 * (results by the cycle of each day), their reach, the period's reach and
 * the images of the `adsLimit` ads that spent the most.
 */
export async function reportMeta(
  env: AdsEnv,
  fetchImpl: Fetch,
  tokenFor: (account: string) => Promise<string>,
  sources: ReportSources,
  start: string,
  end: string,
  adsLimit: number,
  compare?: { start: string; end: string } | null,
): Promise<ReportMeta> {
  checkRange(start, end);
  if (compare) checkRange(compare.start, compare.end);
  const cycleOn = (day: string) =>
    [...sources.cycles].reverse().find((c) => c.start_date <= day && day <= c.end_date) ??
    sources.cycles[sources.cycles.length - 1];
  const ad_results = sources.cycles.some(
    (c) =>
      c.destination !== "make_landing_page" ||
      c.objective === "traffic" ||
      c.objective === "engagement" ||
      !!c.meta_conversions?.some((r) => r.actions?.length),
  );
  // Each account, with the campaigns linked (none: the whole account).
  const accounts = new Map<string, Set<string> | null>();
  for (const l of sources.links) {
    const id = String(l.account_id).replace(/^act_/i, "");
    if (!ID.test(id)) continue;
    const current = accounts.has(id) ? accounts.get(id)! : new Set<string>();
    if (current === null) continue;
    if (!l.campaign_id) accounts.set(id, null);
    else accounts.set(id, current.add(l.campaign_id));
  }
  const ads = new Map<string, ReportItem>();
  const adsets = new Map<string, ReportItem>();
  let reach: number | null = null;
  let currency = "BRL";
  const range = { time_range: JSON.stringify({ since: start, until: end }) };
  // The comparison's days come in their own read (the periods may be far
  // apart: the days between them are not needed).
  const compareRange = compare
    ? { time_range: JSON.stringify({ since: compare.start, until: compare.end }) }
    : null;
  let compareReach: number | null = null;
  for (const [account, campaigns] of accounts) {
    const token = await tokenFor(account);
    const filter: Record<string, string> = campaigns?.size
      ? {
          filtering: JSON.stringify([
            { field: "campaign.id", operator: "IN", value: [...campaigns] },
          ]),
        }
      : {};
    const act = `/act_${account}`;
    const dailyOf = (r: Record<string, string>) =>
      graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
        ...r,
        ...filter,
        level: "ad",
        time_increment: "1",
        fields: "ad_id,ad_name,adset_id,adset_name,campaign_name,spend,impressions,inline_link_clicks,actions",
        limit: "500",
      });
    const [info, main, adReach, adsetReach, total, compared, compareTotal] = await Promise.all([
      graph<{ currency?: string }>(env, fetchImpl, token, act, { fields: "currency" }),
      dailyOf(range),
      graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
        ...range,
        ...filter,
        level: "ad",
        fields: "ad_id,reach",
        limit: "500",
      }),
      graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
        ...range,
        ...filter,
        level: "adset",
        fields: "adset_id,reach",
        limit: "500",
      }),
      graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
        ...range,
        ...filter,
        level: "account",
        fields: "reach",
      }),
      compareRange ? dailyOf(compareRange) : Promise.resolve([] as InsightRow[]),
      compareRange
        ? graphAll<InsightRow>(env, fetchImpl, token, `${act}/insights`, {
            ...compareRange,
            ...filter,
            level: "account",
            fields: "reach",
          })
        : Promise.resolve([] as InsightRow[]),
    ]);
    currency = info.currency ?? currency;
    reach = (reach ?? 0) + num(total[0]?.reach);
    if (compareRange) compareReach = (compareReach ?? 0) + num(compareTotal[0]?.reach);
    // A day in both periods (overlapping choices) counts once.
    const seen = new Set(main.map((r) => `${r.ad_id}|${r.date_start}`));
    const daily = [
      ...main,
      ...compared.filter((r) => !seen.has(`${r.ad_id}|${r.date_start}`)),
    ];
    for (const row of daily) {
      const day = String(row.date_start ?? "");
      const cycle = cycleOn(day);
      const results = cycle
        ? metaResults(
            cycle.objective,
            cycle.destination,
            row as never,
            ruleOn(cycle.meta_conversions, day),
          ).conversions
        : 0;
      const d: ReportDay = {
        d: day,
        s: num(row.spend),
        i: num(row.impressions),
        c: num(row.inline_link_clicks),
        r: results,
      };
      const adId = String(row.ad_id);
      const ad = ads.get(adId) ?? {
        id: adId,
        name: String(row.ad_name ?? adId),
        adset: String(row.adset_name ?? ""),
        campaign: String(row.campaign_name ?? ""),
        days: [],
      };
      ad.days.push(d);
      ads.set(adId, ad);
      const setId = String(row.adset_id);
      const set = adsets.get(setId) ?? {
        id: setId,
        name: String(row.adset_name ?? setId),
        campaign: String(row.campaign_name ?? ""),
        days: [],
      };
      const same = set.days.find((x) => x.d === day);
      if (same) {
        same.s += d.s;
        same.i += d.i;
        same.c += d.c;
        same.r += d.r;
      } else set.days.push({ ...d });
      adsets.set(setId, set);
    }
    for (const r of adReach) {
      const ad = ads.get(String(r.ad_id));
      if (ad) ad.reach = (ad.reach ?? 0) + num(r.reach);
    }
    for (const r of adsetReach) {
      const set = adsets.get(String(r.adset_id));
      if (set) set.reach = (set.reach ?? 0) + num(r.reach);
    }
    // The creatives of the ads that spent the most (of this account).
    const spent = (i: ReportItem) => i.days.reduce((s, d) => s + d.s, 0);
    const top = [...ads.values()]
      .filter((a) => daily.some((r) => String(r.ad_id) === a.id))
      .sort((a, b) => spent(b) - spent(a))
      .slice(0, adsLimit);
    for (let i = 0; i < top.length; i += 25) {
      const chunk = top.slice(i, i + 25);
      const found = await graph<
        Record<
          string,
          {
            creative?: {
              thumbnail_url?: string;
              image_url?: string;
              title?: string;
              body?: string;
              object_type?: string;
              video_id?: string;
              instagram_permalink_url?: string;
              effective_object_story_id?: string;
            };
          }
        >
      >(env, fetchImpl, token, "/", {
        ids: chunk.map((a) => a.id).join(","),
        fields:
          "creative.thumbnail_width(480).thumbnail_height(480){thumbnail_url,image_url,title,body,object_type,video_id,instagram_permalink_url,effective_object_story_id}",
      }).catch(() => ({}) as Record<string, never>);
      await Promise.all(
        chunk.map(async (ad) => {
          const c = found[ad.id]?.creative;
          if (!c) return;
          ad.title = c.title?.slice(0, 300);
          ad.body = c.body?.slice(0, 1200);
          ad.video = c.object_type === "VIDEO" || !!c.video_id;
          ad.link =
            c.instagram_permalink_url ??
            (c.effective_object_story_id
              ? `https://www.facebook.com/${c.effective_object_story_id}`
              : undefined);
          ad.thumb =
            (await inlineImage(fetchImpl, c.thumbnail_url)) ??
            (await inlineImage(fetchImpl, c.image_url));
        }),
      );
    }
  }
  const sortItems = (list: ReportItem[]) =>
    list
      .map((i) => ({ ...i, days: i.days.sort((a, b) => a.d.localeCompare(b.d)) }))
      .sort(
        (a, b) =>
          b.days.reduce((s, d) => s + d.s, 0) - a.days.reduce((s, d) => s + d.s, 0),
      );
  return {
    currency,
    reach: accounts.size ? reach : null,
    ...(compare ? { compare_reach: accounts.size ? compareReach : null } : {}),
    ad_results,
    ads: sortItems([...ads.values()]).slice(0, 200),
    adsets: sortItems([...adsets.values()]).slice(0, 100),
  };
}

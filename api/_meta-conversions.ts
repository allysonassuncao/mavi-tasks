/**
 * "Conversões que contam" on Meta (migration
 * 20270302090000_campaign_meta_conversions): which action types of the
 * insights count as a cycle's result.
 *
 * A cycle keeps a list of rules, each from a day on (the first from the
 * cycle's start): actions null is the objective's default rule
 * (api/_ads-sync.ts, metaResults); a list counts the sum of those action
 * types. "Recalcular o ciclo inteiro" leaves one rule; "só daqui para frente"
 * adds one from that day, and the days before keep the rule they had.
 */

export type MetaConversionRule = {
  /** The first day it counts (null: from the cycle's start). */
  from: string | null;
  /** The action types that count (null: the objective's default). */
  actions: string[] | null;
  /** Taken from the previous cycle when this one was created. */
  inherited?: boolean;
};

/** The action types that count on a day (null: the objective's default). */
export function ruleOn(
  rules: MetaConversionRule[] | null | undefined,
  day: string,
): string[] | null {
  let picked: string[] | null = null;
  for (const r of rules ?? [])
    if (!r.from || r.from <= day) picked = r.actions?.length ? r.actions : null;
  return picked;
}

/** The rule in force now: the last one. */
export const currentRule = (rules: MetaConversionRule[] | null | undefined) =>
  rules?.length ? rules[rules.length - 1] : null;

/** More than one rule over the cycle (a change "daqui para frente"). */
export const splitRules = (rules: MetaConversionRule[] | null | undefined) =>
  (rules?.length ?? 0) > 1;

/** The objective's default action types (for "conta no padrão"). */
export function metaDefaultTypes(objective: string, destination: string) {
  if (objective === "traffic") return [];
  if (objective === "engagement") return ["post_engagement"];
  if (destination === "lead_form")
    return ["leadgen_grouped", "onsite_conversion.lead_grouped"];
  if (destination === "make_landing_page") return [];
  if (objective === "sale") return ["purchase"];
  if (objective === "custom") return ["offsite_conversion.fb_pixel_custom"];
  if (objective === "message") return ["onsite_conversion.messaging_first_reply"];
  if (objective === "video") return ["video_view"];
  return ["offsite_conversion.fb_pixel_lead"];
}

/** What the default rule counts, in words. */
export function metaDefaultLabel(objective: string, destination: string) {
  if (objective === "traffic") return "os cliques no link";
  if (objective === "engagement") return "os engajamentos com a publicação";
  if (destination === "lead_form") return "os leads do formulário do Facebook";
  if (destination === "make_landing_page")
    return "os cadastros da página de captura da Make";
  if (objective === "sale") return "as compras";
  if (objective === "custom") return "os eventos personalizados do pixel";
  if (objective === "message") return "as primeiras respostas nas mensagens";
  if (objective === "video") return "as visualizações do vídeo";
  return "os leads do pixel no site";
}

// ------------------------------------------------------------ names
/** The standard events (pixel, Meta) by their action type's stem. */
const EVENTS: Record<string, string> = {
  lead: "Leads",
  purchase: "Compras",
  complete_registration: "Cadastros concluídos",
  add_to_cart: "Adições ao carrinho",
  initiate_checkout: "Finalizações de compra iniciadas",
  add_payment_info: "Informações de pagamento adicionadas",
  view_content: "Visualizações de conteúdo",
  contact: "Contatos",
  schedule: "Agendamentos",
  submit_application: "Inscrições enviadas",
  start_trial: "Avaliações gratuitas iniciadas",
  subscribe: "Assinaturas",
  search: "Pesquisas",
  add_to_wishlist: "Adições à lista de desejos",
  donate: "Doações",
  find_location: "Pesquisas de localização",
  customize_product: "Personalizações de produto",
  activate_app: "Ativações do app",
  app_install: "Instalações do app",
  achievement_unlocked: "Conquistas desbloqueadas",
  level_achieved: "Níveis alcançados",
  rate: "Avaliações",
  spent_credits: "Créditos gastos",
  tutorial_completion: "Tutoriais concluídos",
};
/** Pixel events by the custom conversion's event (custom_event_type). */
const CUSTOM_EVENTS: Record<string, string> = {
  LEAD: "lead",
  PURCHASE: "purchase",
  COMPLETE_REGISTRATION: "complete_registration",
  ADD_TO_CART: "add_to_cart",
  INITIATED_CHECKOUT: "initiate_checkout",
  ADD_PAYMENT_INFO: "add_payment_info",
  CONTENT_VIEW: "view_content",
  CONTACT: "contact",
  SCHEDULE: "schedule",
  SUBMIT_APPLICATION: "submit_application",
  START_TRIAL: "start_trial",
  SUBSCRIBE: "subscribe",
  SEARCH: "search",
  ADD_TO_WISHLIST: "add_to_wishlist",
  DONATE: "donate",
  FIND_LOCATION: "find_location",
  CUSTOMIZE_PRODUCT: "customize_product",
};
/** Action types with a name of their own. */
const NAMED: Record<string, string> = {
  lead: "Leads (site e formulário)",
  "onsite_conversion.lead_grouped": "Leads no formulário do Facebook",
  leadgen_grouped: "Leads no formulário do Facebook (agrupados)",
  "offsite_conversion.fb_pixel_custom": "Eventos personalizados do pixel (todos)",
  "onsite_conversion.messaging_conversation_started_7d":
    "Conversas por mensagem iniciadas",
  "onsite_conversion.messaging_first_reply": "Primeiras respostas nas mensagens",
  "onsite_conversion.total_messaging_connection": "Conexões por mensagem",
  "onsite_conversion.messaging_user_depth_2_message_send":
    "Conversas com 2 mensagens ou mais",
  "onsite_conversion.messaging_user_depth_3_message_send":
    "Conversas com 3 mensagens ou mais",
  "onsite_conversion.messaging_user_depth_5_message_send":
    "Conversas com 5 mensagens ou mais",
  "onsite_conversion.messaging_welcome_message_view":
    "Mensagens de boas-vindas vistas",
  "onsite_conversion.messaging_block": "Bloqueios nas mensagens",
  "onsite_conversion.post_save": "Publicações salvas",
  "onsite_conversion.flow_complete": "Fluxos concluídos",
  click_to_call_native_call_placed: "Ligações feitas",
  click_to_call_call_confirm: "Ligações confirmadas",
  link_click: "Cliques no link",
  landing_page_view: "Visualizações da página de destino",
  post_engagement: "Engajamentos com a publicação",
  page_engagement: "Engajamentos com a Página",
  post_reaction: "Reações à publicação",
  post_interaction_gross: "Interações com a publicação",
  comment: "Comentários",
  post: "Compartilhamentos",
  like: "Curtidas da Página",
  photo_view: "Visualizações da foto",
  video_view: "Visualizações do vídeo (3 s)",
  "onsite_conversion.view_content": "Visualizações de conteúdo no Facebook",
};

/** The Meta account's custom conversions, by id. */
export type CustomConversions = Map<string, { name: string; event: string }>;

/**
 * An action type's name and where it comes from, as the person reads it in
 * the Ads Manager.
 */
export function metaActionLabel(
  type: string,
  customs: CustomConversions = new Map(),
): { label: string; detail: string } {
  const custom = /^offsite_conversion\.custom\.(\d+)$/.exec(type);
  if (custom) {
    const c = customs.get(custom[1]);
    return {
      label: c?.name ?? `Conversão personalizada ${custom[1]}`,
      detail: "Conversão personalizada",
    };
  }
  if (NAMED[type]) return { label: NAMED[type], detail: "" };
  const stem = (prefix: string) =>
    type.startsWith(prefix) ? type.slice(prefix.length) : null;
  const pixel = stem("offsite_conversion.fb_pixel_");
  if (pixel && EVENTS[pixel])
    return { label: `${EVENTS[pixel]} no site`, detail: "Pixel" };
  const omni = stem("omni_");
  if (omni && EVENTS[omni])
    return { label: `${EVENTS[omni]} (todos os canais)`, detail: "Site, app e Meta" };
  const web = stem("onsite_web_app_") ?? stem("onsite_web_");
  if (web && EVENTS[web])
    return { label: `${EVENTS[web]} no site`, detail: "Meta (sem pixel)" };
  const onsite = stem("onsite_conversion.");
  if (onsite && EVENTS[onsite])
    return { label: `${EVENTS[onsite]} no Facebook/Instagram`, detail: "Meta" };
  const app = stem("app_custom_event.fb_mobile_");
  if (app && EVENTS[app]) return { label: `${EVENTS[app]} no app`, detail: "App" };
  if (EVENTS[type])
    return { label: `${EVENTS[type]} (todas as origens)`, detail: "" };
  return { label: type, detail: "" };
}

/**
 * What an action type counts, as groups: two choices sharing a group may
 * count the same lead (or purchase…) twice. "lead" (all leads) covers the
 * site's and the form's; the pixel's, the Meta's and the "omni" version of
 * an event are the same event; a custom conversion counts its event again.
 */
export function metaActionFamilies(
  type: string,
  customs: CustomConversions = new Map(),
): string[] {
  if (type === "lead" || type === "omni_lead") return ["lead_site", "lead_form"];
  if (type === "leadgen_grouped" || type === "onsite_conversion.lead_grouped")
    return ["lead_form"];
  if (type.startsWith("onsite_conversion.messaging_")) return ["messaging"];
  if (type === "onsite_conversion.total_messaging_connection") return ["messaging"];
  const custom = /^offsite_conversion\.custom\.(\d+)$/.exec(type);
  if (custom) {
    const event = CUSTOM_EVENTS[customs.get(custom[1])?.event ?? ""];
    return event ? [event === "lead" ? "lead_site" : event] : [];
  }
  const stem = type
    .replace(/^offsite_conversion\.fb_pixel_/, "")
    .replace(/^onsite_web_app_/, "")
    .replace(/^onsite_web_/, "")
    .replace(/^omni_/, "")
    .replace(/^onsite_conversion\./, "")
    .replace(/^initiated_checkout$/, "initiate_checkout");
  if (stem === "lead") return ["lead_site"];
  return EVENTS[stem] ? [stem] : [];
}

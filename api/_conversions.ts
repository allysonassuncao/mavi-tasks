/**
 * Campanhas: which Google conversion actions count as a cycle's result, for
 * the daily sync (api/_ads-sync.ts) and for the "Conversões do Google que
 * contam" window (api/_ads.ts), so both say the same.
 *
 *  - The cycle may choose them (ad_cycles.conversion_actions: the actions'
 *    ids, and "phone_calls" for the calls from ads): then only those count.
 *  - Otherwise, by Google's category of each action (sturdier than the name
 *    list the MASO used — an action named outside it counted as zero):
 *      · sales (VENDA): purchases;
 *      · the Make capture page: contact, call, directions/visit and
 *        purchase — the page's leads come from the Make server, and the
 *        form's conversion would count them twice (the MASO's list);
 *      · everything else: the lead categories (form, contact, call,
 *        sign-up, quote, appointment, imported/qualified/converted leads,
 *        directions/visit);
 *    never page views, clicks, engagement, downloads or "Outro".
 *  - The sales funnel by category: page view, add to cart, begin checkout.
 * Each action's conversions are rounded (as the MASO did).
 */
export type Objective =
  "lead" | "sale" | "message" | "traffic" | "engagement" | "custom" | "video";
export type Destination = "lead_form" | "external_page" | "make_landing_page";
export type ConversionAction = {
  /** The conversion action's id (the end of customers/x/conversionActions/<id>). */
  id: string;
  name: string;
  /** Google's category (SUBMIT_LEAD_FORM, PURCHASE, PAGE_VIEW…). */
  category: string;
  conversions: number;
};
/** The calls from ads (metrics.phone_calls), selectable like an action. */
export const PHONE_CALLS = "phone_calls";

const LEAD_CATEGORIES = new Set([
  "SUBMIT_LEAD_FORM",
  "CONTACT",
  "PHONE_CALL_LEAD",
  "SIGNUP",
  "REQUEST_QUOTE",
  "BOOK_APPOINTMENT",
  "IMPORTED_LEAD",
  "QUALIFIED_LEAD",
  "CONVERTED_LEAD",
  "GET_DIRECTIONS",
  "STORE_VISIT",
]);
const SALE_CATEGORIES = new Set(["PURCHASE", "STORE_SALE", "SUBSCRIBE_PAID"]);
const MAKE_PAGE_CATEGORIES = new Set([
  "CONTACT",
  "PHONE_CALL_LEAD",
  "GET_DIRECTIONS",
  "STORE_VISIT",
  "PURCHASE",
  "STORE_SALE",
]);

/** Google's categories, as people read them. */
export const CATEGORY_LABELS: Record<string, string> = {
  SUBMIT_LEAD_FORM: "Envio de formulário",
  CONTACT: "Contato",
  PHONE_CALL_LEAD: "Ligação",
  SIGNUP: "Inscrição",
  REQUEST_QUOTE: "Pedido de orçamento",
  BOOK_APPOINTMENT: "Agendamento",
  IMPORTED_LEAD: "Lead importado",
  QUALIFIED_LEAD: "Lead qualificado",
  CONVERTED_LEAD: "Lead convertido",
  GET_DIRECTIONS: "Rotas",
  STORE_VISIT: "Visita à loja",
  PURCHASE: "Compra",
  STORE_SALE: "Venda na loja",
  SUBSCRIBE_PAID: "Assinatura paga",
  PAGE_VIEW: "Visualização de página",
  ADD_TO_CART: "Adição ao carrinho",
  BEGIN_CHECKOUT: "Início de checkout",
  OUTBOUND_CLICK: "Clique de saída",
  ENGAGEMENT: "Engajamento",
  DOWNLOAD: "Download",
  DEFAULT: "Outro",
};

/** Whether an action counts by default (no choice made for the cycle). */
export function countsByDefault(
  objective: Objective,
  destination: Destination,
  category: string,
) {
  if (destination === "make_landing_page")
    return MAKE_PAGE_CATEGORIES.has(category);
  if (objective === "sale") return SALE_CATEGORIES.has(category);
  return LEAD_CATEGORIES.has(category);
}

/** "customers/123/conversionActions/456" → "456". */
export const actionId = (resource: unknown) =>
  String(resource ?? "")
    .split("/")
    .pop() ?? "";

export function classifyActions(
  objective: Objective,
  destination: Destination,
  actions: ConversionAction[],
  phoneCalls: number,
  selection: string[] | null | undefined,
) {
  const chosen = selection?.length ? new Set(selection) : null;
  const rows = actions.map((a) => {
    const n = Math.round(a.conversions);
    return {
      ...a,
      conversions: n,
      counted: chosen
        ? chosen.has(a.id)
        : countsByDefault(objective, destination, a.category),
    };
  });
  // The calls from ads: only when chosen (by default a call counts when
  // Google tracks it as a conversion, category "Ligação").
  const callsCounted = !!chosen?.has(PHONE_CALLS);
  const sum = (f: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(f).reduce((s, r) => s + r.conversions, 0);
  return {
    rows,
    phoneCalls,
    callsCounted,
    counted: sum((r) => r.counted) + (callsCounted ? phoneCalls : 0),
    view_content: sum((r) => r.category === "PAGE_VIEW"),
    add_to_cart: sum((r) => r.category === "ADD_TO_CART"),
    initiate_checkout: sum((r) => r.category === "BEGIN_CHECKOUT"),
  };
}

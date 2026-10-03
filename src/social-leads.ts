/**
 * Onboarding › Social Leads (migration 20261013090000_social_leads): the
 * rules shared by the page and the server (api/_social-leads.ts) — the
 * briefing's fields and steps, whether the AI has what it needs, the stage of
 * each client, the next actions, the check for promises in the posts and the
 * chat importer (the contract of the "social-leads" skill and of the B29
 * artifact). No imports: the server loads this file as is.
 */

// ------------------------------------------------------------ plan content
export type Pillar = "posicionar" | "autoridade" | "oferta";
export const pillars: Record<Pillar, string> = {
  posicionar: "Posicionar",
  autoridade: "Autoridade",
  oferta: "Oferta",
};
export type PostStatus = "pendente" | "aprovado" | "reprovado";
/** A post as the plan content carries it (the artifact's contract). */
export interface PlanPost {
  numero: number;
  badge: Pillar;
  gancho: string;
  direcaoCopy: string;
  direcaoVisual: string;
  formato: string;
  cta: string;
  ehAnuncio: boolean;
  /**
   * The exact texts of the piece (migration 20261120090000): what goes on
   * the image(s), in the video and the caption. Plain text from the AI, or
   * the editor's rich text (mavi:richtext:v1:) once the team edits it.
   */
  textoImagem?: string;
  textoVideo?: string;
  legenda?: string;
  status?: PostStatus;
  observacao?: string;
}
/** How many posts a plan may have (the team picks it; 8 is the B29's). */
export const POSTS_MIN = 8;
export const POSTS_MAX = 16;
export const POSTS_DEFAULT = 8;
export const clampPosts = (n: unknown) =>
  Math.min(
    POSTS_MAX,
    Math.max(POSTS_MIN, Math.round(Number(n) || POSTS_DEFAULT)),
  );

const RICH_PREFIX = "mavi:richtext:v1:";
/**
 * The visible text of a post text (rich or plain), paragraphs on their own
 * lines. Same reading as rich-text.ts, here without imports (the server
 * loads this file as is).
 */
export function postTextPlain(value: string | null | undefined): string {
  const v = value ?? "";
  if (!v.startsWith(RICH_PREFIX)) return v.trim();
  type Node = { type?: string; text?: string; content?: Node[] };
  const blocks = new Set(["paragraph", "listItem"]);
  const walk = (n: Node): string =>
    n.type === "text"
      ? (n.text ?? "")
      : n.type === "hardBreak"
        ? "\n"
        : (n.content ?? [])
            .map((c) => walk(c) + (c.type && blocks.has(c.type) ? "\n" : ""))
            .join("");
  try {
    return walk(JSON.parse(v.slice(RICH_PREFIX.length)) as Node)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return v.trim();
  }
}

/**
 * One slide (or the single art) as the MAVI writes it: the texts that go
 * on the art and, apart, an image idea for the designer.
 */
export interface PostSlide {
  headline: string;
  subheadline: string;
  texto: string;
  sugestaoImagem: string;
}
/** Starts the image idea, so nobody takes it for text of the art. */
export const IMAGE_SUGGESTION_LABEL = "SUGESTÃO DE IMAGEM";
const SUGGESTION_NOTE =
  " (só uma ideia para o designer, não vai escrito na arte): ";
const SLIDE_FIELDS = [
  ["headline", "Headline"],
  ["subheadline", "Subheadline"],
  ["texto", "Texto"],
] as const;
/** A single art has no slides: one item and a format that isn't a carousel. */
export const isSingleArt = (count: number, formato: string) =>
  count === 1 && !/carross/i.test(formato);
type RichInline = { type: string; text?: string; marks?: { type: string }[] };
function richLines(text: string, marks?: { type: string }[]): RichInline[] {
  return text
    .split("\n")
    .flatMap((line, i) => [
      ...(i ? [{ type: "hardBreak" }] : []),
      ...(line
        ? [{ type: "text", text: line, ...(marks ? { marks } : {}) }]
        : []),
    ]);
}
/**
 * The art texts as rich text (mavi:richtext:v1:), one paragraph per slide:
 * "Slide 1 (Capa)" in bold, then "Headline: …", "Subheadline: …",
 * "Texto: …" and the image idea (highlighted) on their own lines, with a
 * blank line between slides. "" when there's nothing on the art.
 */
export function slidesRichText(slides: PostSlide[], single: boolean): string {
  const list = slides
    .map((s) => ({
      headline: (s.headline ?? "").trim(),
      subheadline: (s.subheadline ?? "").trim(),
      texto: (s.texto ?? "").trim(),
      sugestaoImagem: (s.sugestaoImagem ?? "").trim(),
    }))
    .filter((s) => s.headline || s.subheadline || s.texto || s.sugestaoImagem);
  if (!list.length) return "";
  const bold = [{ type: "bold" }];
  const br = { type: "hardBreak" };
  const content = list.flatMap((s, i) => {
    const title = single
      ? "Arte"
      : `Slide ${i + 1}${i === 0 && list.length > 1 ? " (Capa)" : ""}`;
    const lines: RichInline[] = [{ type: "text", text: title, marks: bold }];
    for (const [k, label] of SLIDE_FIELDS)
      if (s[k])
        lines.push(
          br,
          { type: "text", text: `${label}: `, marks: bold },
          ...richLines(s[k]),
        );
    if (s.sugestaoImagem)
      lines.push(
        br,
        {
          type: "text",
          text: IMAGE_SUGGESTION_LABEL,
          marks: [{ type: "bold" }, { type: "highlight" }],
        },
        { type: "text", text: SUGGESTION_NOTE, marks: bold },
        ...richLines(s.sugestaoImagem, [{ type: "italic" }]),
      );
    return [
      ...(i ? [{ type: "paragraph" }] : []),
      { type: "paragraph", content: lines },
    ];
  });
  return RICH_PREFIX + JSON.stringify({ type: "doc", content });
}
/**
 * The slides back from a text slidesRichText wrote, or null when the text
 * is something else (old plain text, or the team edited it in the editor).
 */
export function slidesFromText(
  value: string | null | undefined,
): { slides: PostSlide[]; single: boolean } | null {
  const v = value ?? "";
  if (!v.startsWith(RICH_PREFIX)) return null;
  type Node = { type?: string; text?: string; content?: Node[] };
  let doc: Node;
  try {
    doc = JSON.parse(v.slice(RICH_PREFIX.length)) as Node;
  } catch {
    return null;
  }
  const suggestion = IMAGE_SUGGESTION_LABEL + SUGGESTION_NOTE;
  const slides: PostSlide[] = [];
  let single = false;
  for (const n of doc.content ?? []) {
    if (n.type !== "paragraph") return null;
    const text = (n.content ?? [])
      .map((c) => (c.type === "hardBreak" ? "\n" : (c.text ?? "")))
      .join("");
    if (!text) continue;
    const [title, ...lines] = text.split("\n");
    if (!/^(Arte|Slide \d+( \(Capa\))?)$/.test(title)) return null;
    single = title === "Arte";
    const slide: PostSlide = {
      headline: "",
      subheadline: "",
      texto: "",
      sugestaoImagem: "",
    };
    let field: keyof PostSlide | null = null;
    for (const line of lines) {
      const f = SLIDE_FIELDS.find(([, l]) => line.startsWith(`${l}: `));
      if (f) {
        field = f[0];
        slide[field] = line.slice(f[1].length + 2);
      } else if (line.startsWith(suggestion)) {
        field = "sugestaoImagem";
        slide.sugestaoImagem = line.slice(suggestion.length);
      } else if (field) slide[field] += `\n${line}`;
      else return null;
    }
    slides.push(slide);
  }
  if (!slides.length || slidesRichText(slides, single) !== v) return null;
  return { slides, single };
}
/** The art text without the image ideas (the client's presentation PDF). */
export const withoutImageSuggestions = (plain: string) =>
  plain
    .split("\n")
    .filter((l) => !l.startsWith(IMAGE_SUGGESTION_LABEL))
    .join("\n");
export interface PlanCampaign {
  objetivo: string;
  regiao: string;
  idadeGenero: string;
  segmentacao: string;
  posicionamentos: string;
  orcamento: string;
  perguntasFormulario: string[];
  roteamentoLead: string;
}
export interface PlanContent {
  diagnostico: { negocio: string; comoQuerSerVista: string };
  swot: {
    forcas: string;
    fraquezas: string;
    oportunidades: string;
    ameacas: string;
  };
  pilares: { titulo: string; descricao: string }[];
  publico: string;
  campanha: PlanCampaign;
  alertas: string[];
  posts: PlanPost[];
}

// ------------------------------------------------------------ database rows
export type Decision = "pending" | "approved" | "rejected";
export interface SlPost {
  plan_id: string;
  number: number;
  pillar: Pillar;
  hook: string;
  copy_direction: string;
  visual_direction: string;
  format: string;
  cta: string;
  is_ad: boolean;
  /** The exact texts: on the image(s), in the video, the caption ('' when none). */
  image_text?: string;
  video_text?: string;
  caption?: string;
  decision: Decision;
  note: string;
  decided_via: "link" | "team" | null;
  decided_by: string | null;
  decided_at: string | null;
  updated_at: string;
  /** The art task, once production was released. */
  task_id?: string | null;
  /** The art files, in the client's Drive. */
  arts?: MediaFile[];
}
/** An alert (or promise check) marked as read (social_leads_alert_reads). */
export interface SlAlertRead {
  alert_text: string;
  kind: "alerta" | "checagem";
  read_by: string;
  read_at: string;
}
/** The promise check as the alerts tab lists it (and marks it read). */
export const flagText = (f: Flag) =>
  `Post ${f.post} · ${f.field}: “${f.term}”, ${f.why}`;
/** An art task as the plan shows it. */
export interface SlTask {
  id: string;
  title: string;
  status: string;
  assignee_id: string;
  due_date: string;
}
export interface SlPlan {
  id: string;
  company_id: string;
  contract_id: string;
  month_number: number;
  label: string;
  content: Omit<PlanContent, "posts">;
  summary: string;
  source: "ai" | "import" | "manual" | "artifact";
  share_enabled: boolean;
  shared_at: string | null;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface SlRevision {
  id: string;
  plan_id: string;
  number: number;
  reason: string;
  content: PlanContent & { label?: string };
  created_by: string | null;
  created_at: string;
}
export interface SlJob {
  id: string;
  kind: "new" | "current";
  status: "running" | "done" | "failed";
  error: string | null;
  created_at: string;
  finished_at: string | null;
  plan_id?: string | null;
}
export type CampaignObjective = "form_nativo" | "ctwa";
export const campaignObjectives: Record<CampaignObjective, string> = {
  form_nativo: "Formulário nativo do Meta",
  ctwa: "Conversa no WhatsApp (CTWA)",
};
export interface SlBriefing {
  fields: BriefingFields;
  campaign_objective: CampaignObjective | null;
  responsible_id: string | null;
  version: number;
  updated_at: string;
  updated_by?: string | null;
  /** Files in the client's Drive (migration 20261015090000). */
  media?: BriefingMedia;
  /** The client's cycle tasks, once the first release opened it. */
  cycle?: { followup?: string; meeting?: string; started_at?: string } | null;
  /**
   * The Drive folder the client uploads social proof to, by its public
   * link (migration 20261120090000).
   */
  proof_folder?: string | null;
}
/** Briefing fields that take files as well as text. */
export type MediaKey = "socialProof" | "brandLogo" | "brandVisualElements";
export interface MediaFile {
  id: string;
  name: string;
  type: string;
  size: number;
}
export type BriefingMedia = Partial<Record<MediaKey, MediaFile[]>>;
/** What each media field accepts (the file input's accept). */
export const mediaAccept: Record<MediaKey, string> = {
  socialProof: "image/*,video/*,audio/*",
  brandLogo: "image/*,video/*",
  brandVisualElements: "image/*,video/*",
};
export function mediaAllowed(key: MediaKey, type: string) {
  const kind = type.split("/")[0];
  return key === "socialProof"
    ? ["image", "video", "audio"].includes(kind)
    : ["image", "video"].includes(kind);
}
/** One call to the AI and what it cost (social_leads_ai_usage). */
export interface SlUsage {
  kind: "generate" | "adjust" | "colors" | "briefing" | "schedule";
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | string;
  created_at: string;
  created_by: string | null;
}
/** A plan's AI cost: the total, and the generations and adjustments in it. */
export function usageSummary(rows: SlUsage[]) {
  const sum = (list: SlUsage[]) =>
    list.reduce((t, r) => t + Number(r.cost_usd || 0), 0);
  const generate = rows.filter((r) => r.kind === "generate");
  const adjust = rows.filter((r) => r.kind === "adjust");
  return {
    total: sum(rows),
    generations: generate.length,
    generateCost: sum(generate),
    adjustments: adjust.length,
    adjustCost: sum(adjust),
    tokens: rows.reduce(
      (t, r) =>
        t +
        r.input_tokens +
        r.output_tokens +
        r.cache_read_tokens +
        r.cache_write_tokens,
      0,
    ),
  };
}
/** "US$ 0,42" (and "menos de US$ 0,01" for a tiny, non-zero cost). */
/**
 * Textos guardados antes de a inteligência se chamar MAVI ("ajuste pedido à
 * IA", "Gerado pela IA"): na tela, dizem MAVI. O valor guardado não muda,
 * porque o código e o banco comparam por ele.
 */
export function maviText(text: string | null | undefined) {
  return (text ?? "").replace(/(^|\s)(à|a|da|pela) IA\b/gi, "$1$2 MAVI");
}

export function formatUsd(value: number) {
  if (value > 0 && value < 0.005) return "menos de US$ 0,01";
  return `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ------------------------------------------------------------ masks
/** "(11) 91234-5678" (mobile, with the 9) or "(11) 3456-7890" while typing. */
export function formatPhoneBR(value: string) {
  let d = value.replace(/\D/g, "");
  // A pasted +55 goes away.
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.slice(0, 11);
  if (!d) return "";
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length <= 4) return `(${ddd}) ${rest}`;
  // 10 digits: landline; 11: mobile with the 9.
  const cut = rest.length === 9 ? 5 : 4;
  return `(${ddd}) ${rest.slice(0, cut)}-${rest.slice(cut)}`;
}
export function phoneComplete(value: string) {
  const d = value.replace(/\D/g, "");
  return d.length === 11 && d[2] === "9";
}

export const currencies = [
  { code: "BRL", label: "Real" },
  { code: "USD", label: "Dólar" },
  { code: "EUR", label: "Euro" },
  { code: "GBP", label: "Libra" },
  { code: "CAD", label: "Dólar CA" },
  { code: "AUD", label: "Dólar AU" },
  { code: "CHF", label: "Franco" },
  { code: "JPY", label: "Iene" },
  { code: "ARS", label: "Peso AR" },
  { code: "CLP", label: "Peso CL" },
  { code: "MXN", label: "Peso MX" },
  { code: "PYG", label: "Guarani" },
  { code: "UYU", label: "Peso UY" },
] as const;
export type CurrencyCode = (typeof currencies)[number]["code"];
const moneyFormat = (code: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: code });
export const currencyDigits = (code: string) =>
  moneyFormat(code).resolvedOptions().maximumFractionDigits ?? 2;
/** The currency's symbol as the formatted value shows it ("R$", "US$", "€"…). */
export function currencySymbol(code: string) {
  return (
    moneyFormat(code)
      .formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? code
  );
}
/** "R$ 1.200,00", "US$ 1.200,00", "€ 1.200,00". */
export function formatMoney(amount: number, code: string) {
  return moneyFormat(code)
    .format(amount)
    .replace(/\u00a0/g, " ");
}
/** Typing digits fills from the cents (like a card machine). */
export function moneyFromDigits(digits: string, code: string) {
  const d = digits
    .replace(/\D/g, "")
    .replace(/^0+(?=\d)/, "")
    .slice(0, 13);
  if (!d) return null;
  return Number(d) / 10 ** currencyDigits(code);
}
/**
 * A stored value read back: its currency and amount, or `legacy` when the
 * text isn't one amount (e.g. "R$150,00 á R$700,00", from before the mask).
 */
export function parseMoney(text: string | undefined): {
  code: CurrencyCode;
  amount: number | null;
  legacy: string | null;
} {
  const t = (text ?? "").trim();
  if (!t) return { code: "BRL", amount: null, legacy: null };
  // Longest symbols first ("US$" before "$").
  const found = [...currencies]
    .map((c) => ({ code: c.code, symbol: currencySymbol(c.code) }))
    .sort((a, b) => b.symbol.length - a.symbol.length)
    .find((c) => t.startsWith(c.symbol) || t.toUpperCase().startsWith(c.code));
  const code: CurrencyCode = found?.code ?? "BRL";
  const rest = found
    ? t
        .slice(
          t.toUpperCase().startsWith(found.code)
            ? found.code.length
            : found.symbol.length,
        )
        .trim()
    : t;
  const numbers = rest.match(/\d[\d.,]*/g) ?? [];
  if (numbers.length !== 1 || /[a-zá-ú]/i.test(rest.replace(numbers[0], "")))
    return { code, amount: null, legacy: t };
  const n = numbers[0];
  // "1.200,50" and "500,00" (comma decimals); "1200" or "1.200" (thousands).
  const amount = n.includes(",")
    ? Number(n.replace(/\./g, "").replace(",", "."))
    : Number(n.replace(/[.,]/g, ""));
  return Number.isFinite(amount)
    ? { code, amount, legacy: null }
    : { code, amount: null, legacy: t };
}

/** A brand colour as the field edits it; hex may be missing ("azul"). */
export type BrandColor = { hex: string | null; name: string };
const HEX_IN = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i;
const fullHex = (h: string) => {
  const v = h.replace("#", "").toLowerCase();
  return `#${v.length === 3 ? [...v].map((c) => c + c).join("") : v}`;
};
/** "azul-marinho #0b1d3a, verde-água #14b8a6" → the list (and back). */
export function parseColors(text: string | undefined): BrandColor[] {
  return (text ?? "")
    .split(/[,;\n]+|\s+e\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(HEX_IN);
      return {
        hex: m ? fullHex(m[0]) : null,
        name: part.replace(HEX_IN, "").replace(/\s+/g, " ").trim(),
      };
    });
}
export function serializeColors(list: BrandColor[]) {
  return list
    .filter((c) => c.hex || c.name.trim())
    .map((c) => [c.name.trim(), c.hex].filter(Boolean).join(" "))
    .join(", ");
}
/** One client of the portfolio (social_leads_portfolio). */
export interface PortfolioItem {
  contract_id: string;
  contract_name: string;
  client_id: string;
  client_name: string;
  client_color: string;
  contract_created_at: string;
  can_write: boolean;
  briefing: {
    fields: BriefingFields;
    campaign_objective: CampaignObjective | null;
    responsible_id: string | null;
    updated_at: string;
  } | null;
  plan_count: number;
  plan: {
    id: string;
    month_number: number;
    label: string;
    created_at: string;
    updated_at: string;
    share_enabled: boolean;
    shared_at: string | null;
    alerts: number;
    /** Alerts nobody marked as read yet. */
    alerts_unread?: number;
    first_alert: string | null;
    /** How many posts the plan has (8 to 16). */
    posts?: number;
    approved: number;
    rejected: number;
    last_decision_at: string | null;
    /** Posts with an art task / with art files. */
    tasks?: number;
    arts?: number;
    /** Social Media: posts scheduled, published, and waiting to be published. */
    scheduled?: number;
    published?: number;
    due?: number;
  } | null;
  job: SlJob | null;
  /** The client's Meta campaign (id and name only for leaders). */
  campaign?: { id: string | null; name: string | null; active: boolean } | null;
}
export interface Portfolio {
  configured: boolean;
  product_id?: string;
  team_id?: string | null;
  /** Who receives the art tasks (the squad when not set). */
  design_team_id?: string | null;
  /** Days to deliver an art after production is released. */
  art_days?: number;
  items: PortfolioItem[];
}

/** A post row as plan content. */
export function postContent(p: SlPost): PlanPost {
  return {
    numero: p.number,
    badge: p.pillar,
    gancho: p.hook,
    direcaoCopy: p.copy_direction,
    direcaoVisual: p.visual_direction,
    formato: p.format,
    cta: p.cta,
    ehAnuncio: p.is_ad,
    textoImagem: p.image_text ?? "",
    textoVideo: p.video_text ?? "",
    legenda: p.caption ?? "",
    status:
      p.decision === "approved"
        ? "aprovado"
        : p.decision === "rejected"
          ? "reprovado"
          : "pendente",
    observacao: p.note,
  };
}
export function fullContent(plan: SlPlan, posts: SlPost[]): PlanContent {
  return {
    ...plan.content,
    posts: [...posts].sort((a, b) => a.number - b.number).map(postContent),
  };
}

// ------------------------------------------------------------ briefing
export type BriefingKey =
  | "clientName"
  | "segment"
  | "contactName"
  | "contactWhats"
  | "briefingDate"
  | "businessWhat"
  | "positioning"
  | "marketRegion"
  | "competitors"
  | "differentiators"
  | "swotForcas"
  | "swotFraquezas"
  | "swotOportunidades"
  | "swotAmeacas"
  | "targetAudience"
  | "socialProof"
  | "igHandle"
  | "fbHandle"
  | "websiteUrl"
  | "toneRefs"
  | "featuredOffer"
  | "averageTicket"
  | "mediaBudget"
  | "notes"
  | "brandColors"
  | "brandLogo"
  | "brandVisualElements";
export type BriefingFields = Partial<Record<BriefingKey, string>>;
export interface BriefingField {
  key: BriefingKey;
  label: string;
  /** What to write, shown under the label. */
  help?: string;
  placeholder?: string;
  long?: boolean;
  type?: "date" | "url";
  /** A masked or richer control instead of plain text. */
  kind?: "phone" | "money" | "colors";
  /** Also takes files (kept in the client's Drive). */
  media?: MediaKey;
  /** What the file button says ("imagem, vídeo ou áudio"). */
  mediaWhat?: string;
}
export interface BriefingStep {
  id: string;
  title: string;
  fields: BriefingField[];
}
/** The 27 text fields, in 5 short steps (plus objective and responsible). */
export const briefingSteps: BriefingStep[] = [
  {
    id: "cliente",
    title: "Cliente e contato",
    fields: [
      {
        key: "clientName",
        label: "Nome da marca nas peças",
        help: "Como o cliente quer ser chamado nos posts.",
      },
      {
        key: "segment",
        label: "Segmento",
        placeholder: "Ex.: Escola infantil",
      },
      { key: "contactName", label: "Contato no cliente" },
      { key: "contactWhats", label: "WhatsApp do contato", kind: "phone" },
      { key: "briefingDate", label: "Data do briefing", type: "date" },
    ],
  },
  {
    id: "negocio",
    title: "Negócio e oferta",
    fields: [
      {
        key: "businessWhat",
        label: "O que o negócio faz",
        long: true,
      },
      {
        key: "positioning",
        label: "Como quer ser visto",
        help: "Posicionamento desejado.",
        long: true,
      },
      { key: "differentiators", label: "Diferenciais", long: true },
      {
        key: "featuredOffer",
        label: "Oferta em destaque",
        help: "O que o anúncio do mês vai oferecer.",
      },
      {
        key: "averageTicket",
        label: "Ticket médio",
        help: "Em texto livre: faixa, por mês, por procedimento…",
        placeholder: "Ex.: R$ 300 a R$ 500 por mês",
      },
    ],
  },
  {
    id: "mercado",
    title: "Mercado e público",
    fields: [
      { key: "marketRegion", label: "Região de atuação" },
      { key: "competitors", label: "Concorrentes e referências", long: true },
      { key: "targetAudience", label: "Público-alvo", long: true },
      {
        key: "socialProof",
        label: "Prova social",
        help: "Depoimentos e casos reais. Sem isso, a MAVI não inventa nenhum.",
        long: true,
        media: "socialProof",
        mediaWhat: "imagem, vídeo ou áudio",
      },
      { key: "swotForcas", label: "Forças", long: true },
      { key: "swotFraquezas", label: "Fraquezas", long: true },
      { key: "swotOportunidades", label: "Oportunidades", long: true },
      { key: "swotAmeacas", label: "Ameaças", long: true },
    ],
  },
  {
    id: "marca",
    title: "Presença e marca",
    fields: [
      { key: "igHandle", label: "Instagram", placeholder: "@perfil" },
      { key: "fbHandle", label: "Facebook", placeholder: "Página" },
      {
        key: "websiteUrl",
        label: "Site ou landing",
        type: "url",
        placeholder: "https://",
      },
      {
        key: "toneRefs",
        label: "Tom e referências",
        help: "Como a marca fala.",
        long: true,
      },
      {
        key: "brandColors",
        label: "Cores da marca",
        help: "Obrigatório quando não há Instagram, Facebook nem site. A MAVI busca no site ou Instagram informados.",
        kind: "colors",
      },
      {
        key: "brandLogo",
        label: "Logo",
        placeholder: "Observações sobre o logo (opcional)",
        media: "brandLogo",
        mediaWhat: "imagem ou vídeo",
      },
      {
        key: "brandVisualElements",
        label: "Elementos visuais",
        placeholder: "Ex.: ícones, texturas, fotos da equipe",
        media: "brandVisualElements",
        mediaWhat: "imagem ou vídeo",
      },
    ],
  },
  {
    id: "campanha",
    title: "Campanha",
    fields: [
      { key: "mediaBudget", label: "Verba de mídia por mês", kind: "money" },
      {
        key: "notes",
        label: "Restrições e observações",
        help: "Valem em todas as peças. Ex.: não prometer resultado, não falar de política.",
        long: true,
      },
    ],
  },
];
export const briefingKeys: BriefingKey[] = briefingSteps.flatMap((s) =>
  s.fields.map((f) => f.key),
);

const fold = (text: string) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function slugify(text: string) {
  return (
    fold(text)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "cliente"
  );
}

/** "Criar página", "não tem", "ainda não", "-": written, but not a channel. */
export function missingChannel(value: string | undefined) {
  const v = fold(value ?? "");
  if (!v) return true;
  return /^(-+|n\/?a|nenhum[a]?|inexistente|sem\b.*|criar\b.*|a criar\b.*|ainda (nao|sem)\b.*|nao (tem|existe|possui|ha)\b.*|nao)$/.test(
    v,
  );
}
/** No Instagram, Facebook nor site the AI could look at. */
export function hasNoDigitalPresence(f: BriefingFields) {
  return (
    missingChannel(f.igHandle) &&
    missingChannel(f.fbHandle) &&
    missingChannel(f.websiteUrl)
  );
}
const SENSITIVE =
  /afiliad|multinivel|mlm|renda extra|oportunidade de (renda|negocio)|ganhar dinheiro|investiment|financeir|credito|emprestimo|consorcio|seguro|saude|clinic|medic|emagrec|estetic|odontolog|psicolog|suplement/;
/** Verticals the Meta watches closely (risk of rejection or restriction). */
export function sensitiveVertical(f: BriefingFields) {
  return SENSITIVE.test(
    fold(
      [f.segment, f.businessWhat, f.featuredOffer, f.positioning]
        .filter(Boolean)
        .join(" "),
    ),
  );
}

export type Readiness = {
  filled: number;
  total: number;
  /** What stops the plan from being generated. */
  blockers: string[];
  /** What the plan will warn about. */
  warnings: string[];
  byStep: { id: string; filled: number; total: number }[];
};
/** How far the briefing is and what stops or weakens the plan. */
export function briefingReadiness(
  fields: BriefingFields,
  objective: CampaignObjective | null,
  clientName = "",
  media: BriefingMedia = {},
): Readiness {
  // A field with files counts as filled (e.g. the logo sent, no text).
  const has = (k: BriefingKey) =>
    !!fields[k]?.trim() || !!media[k as MediaKey]?.length;
  const byStep = briefingSteps.map((s) => ({
    id: s.id,
    filled:
      s.fields.filter((f) => has(f.key)).length +
      (s.id === "campanha" && objective ? 1 : 0),
    total: s.fields.length + (s.id === "campanha" ? 1 : 0),
  }));
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!has("clientName") && !clientName.trim())
    blockers.push("Informe o nome da marca.");
  const noPresence = hasNoDigitalPresence(fields);
  if (noPresence && !has("brandColors"))
    blockers.push(
      "Sem Instagram, Facebook ou site, informe as cores da marca: a MAVI não inventa identidade visual.",
    );
  if (noPresence)
    warnings.push(
      "Nenhum perfil social ou site ativo: o plano vai abrir com um alerta de bloqueio.",
    );
  if (!objective) warnings.push("Escolha o objetivo da campanha.");
  if (!has("socialProof"))
    warnings.push(
      "Sem prova social: os posts usam situações genéricas e o plano pede depoimentos.",
    );
  if (sensitiveVertical(fields))
    warnings.push(
      "Vertical sensível no Meta: a MAVI eleva o rigor e evita promessa de ganho.",
    );
  return {
    filled: byStep.reduce((s, x) => s + x.filled, 0),
    total: byStep.reduce((s, x) => s + x.total, 0),
    blockers,
    warnings,
    byStep,
  };
}

// ------------------------------------------------------------ stages
export const stages = [
  "Briefing",
  "Plano",
  "Aprovação",
  "Produção",
  "Campanha",
] as const;
/** Social Media publishes the posts too: Agendamento comes before Campanha. */
export const mediaStages = [
  "Briefing",
  "Plano",
  "Aprovação",
  "Produção",
  "Agendamento",
  "Campanha",
] as const;
export const stagesOf = (module: SlModule): readonly string[] =>
  module === "social_media" ? mediaStages : stages;
/** How many posts the latest plan has (8 before the count could change). */
export const postsOf = (plan: { posts?: number } | null | undefined) =>
  plan?.posts || POSTS_DEFAULT;
/**
 * 0 briefing · 1 plano (a revisar) · 2 aprovação · 3 aprovado/produção ·
 * Social Media: 4 agendamento (todas as artes) · 5 campanha (tudo agendado).
 */
export function stageOf(
  item: PortfolioItem,
  module: SlModule = "social_leads",
) {
  if (!item.plan) return 0;
  const total = postsOf(item.plan);
  if (item.plan.approved >= total) {
    if (module !== "social_media") return item.campaign?.active ? 4 : 3;
    if ((item.plan.scheduled ?? 0) >= total) return 5;
    return (item.plan.arts ?? 0) >= total ? 4 : 3;
  }
  if (!item.plan.share_enabled && item.plan.approved + item.plan.rejected === 0)
    return 1;
  return 2;
}
export function stageLabel(
  item: PortfolioItem,
  module: SlModule = "social_leads",
) {
  const p = item.plan;
  if (item.job?.status === "running") return "Gerando o plano…";
  if (!p) return item.briefing ? "Briefing em andamento" : "Sem briefing";
  const decided = p.approved + p.rejected;
  const total = postsOf(p);
  if (p.approved >= total) {
    if (module === "social_media" && (p.due ?? 0) > 0)
      return `Agendamento · ${p.due} para publicar`;
    if (item.campaign?.active) return "Campanha no ar";
    if (module === "social_media" && (p.scheduled ?? 0) > 0)
      return (p.published ?? 0) >= total
        ? "Tudo publicado"
        : `Agendamento · ${p.scheduled}/${total} agendados`;
    if (!p.tasks) return "Plano aprovado";
    return `Produção · ${p.arts ?? 0}/${total} artes`;
  }
  if (!p.share_enabled && decided === 0) return "Plano para revisar";
  return `Aprovação · ${decided}/${total}`;
}

export type Tone = "bad" | "warn" | "good" | "info";
export type NextAction = {
  contract: string;
  client: string;
  tone: Tone;
  title: string;
  detail: string;
  /** What the button does. */
  action:
    | "open-plan"
    | "open-briefing"
    | "generate"
    | "share"
    | "next-month"
    | "release"
    | "campaign"
    | "schedule";
  label: string;
};
const DAY = 86_400_000;
export function daysSince(iso: string | null | undefined, now = Date.now()) {
  return iso ? Math.floor((now - new Date(iso).getTime()) / DAY) : 0;
}
/** The one thing each client needs now, the most urgent first. */
export function nextActions(
  items: PortfolioItem[],
  now = Date.now(),
  module: SlModule = "social_leads",
): NextAction[] {
  const order: Record<Tone, number> = { bad: 0, warn: 1, good: 2, info: 3 };
  const out: NextAction[] = [];
  for (const i of items) {
    const base = { contract: i.contract_id, client: i.client_name };
    const p = i.plan;
    const total = postsOf(p);
    if (i.job?.status === "running") {
      out.push({
        ...base,
        tone: "info",
        title: `${i.client_name}: a MAVI está gerando o plano`,
        detail: "Leva de 1 a 3 minutos. A tela atualiza sozinha.",
        action: "open-plan",
        label: "Acompanhar",
      });
      continue;
    }
    if (
      i.job?.status === "failed" &&
      (!p || new Date(i.job.created_at) > new Date(p.updated_at))
    ) {
      out.push({
        ...base,
        tone: "bad",
        title: `${i.client_name}: a geração do plano falhou`,
        detail: i.job.error ?? "Tente gerar de novo.",
        action: p ? "open-plan" : "open-briefing",
        label: "Ver o motivo",
      });
      continue;
    }
    if (!i.briefing) {
      out.push({
        ...base,
        tone: "info",
        title: `${i.client_name}: preencher o briefing`,
        detail: "Contrato sem briefing ainda.",
        action: "open-briefing",
        label: "Começar briefing",
      });
      continue;
    }
    if (!p) {
      out.push({
        ...base,
        tone: "info",
        title: `${i.client_name}: gerar o plano do Mês 1`,
        detail: `Briefing salvo ${relativeDays(i.briefing.updated_at, now)}.`,
        action: "open-briefing",
        label: "Revisar e gerar",
      });
      continue;
    }
    if (p.first_alert && /^bloqueio/i.test(p.first_alert.trim())) {
      out.push({
        ...base,
        tone: "bad",
        title: `${i.client_name}: ${p.first_alert.replace(/^bloqueio\s*[:—-]\s*/i, "")}`,
        detail: `Bloqueio operacional apontado no plano do ${p.label}.`,
        action: "open-plan",
        label: "Abrir plano",
      });
      continue;
    }
    if (p.approved >= total) {
      const age = daysSince(p.created_at, now);
      const arts = p.arts ?? 0;
      const media = module === "social_media";
      if (media && (p.due ?? 0) > 0)
        out.push({
          ...base,
          tone: "bad",
          title: `${i.client_name}: ${plural(p.due ?? 0, "post na hora de publicar", "posts na hora de publicar")}`,
          detail: "A hora marcada chegou: publique e marque como publicado.",
          action: "schedule",
          label: "Abrir agendamento",
        });
      else if (age >= 25)
        out.push({
          ...base,
          tone: "warn",
          title: `${i.client_name}: hora do plano do Mês ${p.month_number + 1}`,
          detail: `O ${p.label} foi criado há ${age} dias.`,
          action: "next-month",
          label: "Gerar próximo mês",
        });
      else if ((p.tasks ?? 0) < total)
        out.push({
          ...base,
          tone: "good",
          title: `${i.client_name}: o cliente aprovou os ${total} posts`,
          detail: "Libere a produção: cada post vira uma tarefa de arte.",
          action: "release",
          label: "Liberar produção",
        });
      else if (media && arts > (p.scheduled ?? 0))
        out.push({
          ...base,
          tone: arts < total ? "info" : "good",
          title: `${i.client_name}: ${plural(arts - (p.scheduled ?? 0), "post com arte para agendar", "posts com arte para agendar")}`,
          detail: `${p.scheduled ?? 0} de ${total} agendados · ${arts} com arte.`,
          action: "schedule",
          label: "Agendar",
        });
      else if (arts < total)
        out.push({
          ...base,
          tone: "info",
          title: `${i.client_name}: produção em andamento`,
          detail: `${arts} de ${total} posts com arte.`,
          action: "open-plan",
          label: "Ver artes",
        });
      else if (!i.campaign)
        out.push({
          ...base,
          tone: "good",
          title: `${i.client_name}: artes prontas, falta a campanha`,
          detail: "Crie a campanha do Meta com o post que vira anúncio.",
          action: "campaign",
          label: "Criar campanha",
        });
      else if (!i.campaign.active)
        out.push({
          ...base,
          tone: "warn",
          title: `${i.client_name}: campanha criada, ainda inativa`,
          detail: "Complete o ciclo e ative em Campanhas.",
          action: "campaign",
          label: "Abrir campanha",
        });
      continue;
    }
    if (p.rejected > 0) {
      out.push({
        ...base,
        tone: "warn",
        title: `${i.client_name}: ajuste pedido em ${p.rejected} ${p.rejected === 1 ? "post" : "posts"}`,
        detail: `${p.approved + p.rejected} de ${total} decididos no ${p.label}.`,
        action: "open-plan",
        label: "Ver pedidos",
      });
      continue;
    }
    if (!p.share_enabled) {
      out.push({
        ...base,
        tone: "info",
        title: `${i.client_name}: revisar e enviar o ${p.label}`,
        detail: "O plano ainda não foi enviado para o cliente aprovar.",
        action: "share",
        label: "Enviar para aprovação",
      });
      continue;
    }
    const idle = daysSince(p.last_decision_at ?? p.shared_at, now);
    if (idle >= 2)
      out.push({
        ...base,
        tone: "warn",
        title: `${i.client_name}: aprovação parada há ${idle} dias`,
        detail: `${p.approved + p.rejected} de ${total} decididos · link enviado ${relativeDays(p.shared_at, now)}.`,
        action: "share",
        label: "Reenviar link",
      });
  }
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}
export function relativeDays(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const d = daysSince(iso, now);
  if (d <= 0) return "hoje";
  if (d === 1) return "ontem";
  return `há ${d} dias`;
}

// ------------------------------------------------------------ compliance
export type Flag = { post: number; field: string; term: string; why: string };
const PROMISES: { re: RegExp; why: string }[] = [
  {
    re: /garantid[oa]s?|garantimos|garantia de/i,
    why: "promessa de resultado",
  },
  {
    re: /renda extra|ganhe dinheiro|ganhar dinheiro|dinheiro f[aá]cil|fique rico|enrique[cç]/i,
    why: "promessa de ganho",
  },
  {
    re: /\bR\$\s?\d[\d.,]*(\s?(mil|k))?/i,
    why: "valor em dinheiro (confira se não é promessa de ganho)",
  },
  {
    re: /\b\d{2,3}\s?%/i,
    why: "percentual (confira se não é promessa de resultado)",
  },
  {
    re: /em (apenas )?\d+ (dias|semanas|meses)/i,
    why: "prazo de resultado",
  },
  {
    re: /sem risco|risco zero|100% (seguro|garantido|eficaz)/i,
    why: "promessa de resultado",
  },
  { re: /\bcura\b|curar|elimina de vez/i, why: "promessa de saúde" },
];
/** Words of promise in any field of the posts, the text asked for the art included. */
export function complianceFlags(posts: PlanPost[]): Flag[] {
  const fields: [keyof PlanPost, string][] = [
    ["gancho", "Gancho"],
    ["direcaoCopy", "Direção de copy"],
    ["direcaoVisual", "Texto pedido para a arte"],
    ["cta", "CTA"],
    ["textoImagem", "Texto da imagem"],
    ["textoVideo", "Texto do vídeo"],
    ["legenda", "Legenda"],
  ];
  const out: Flag[] = [];
  for (const p of posts)
    for (const [key, label] of fields) {
      const text = postTextPlain(String(p[key] ?? ""));
      for (const { re, why } of PROMISES) {
        const m = text.match(re);
        if (m) out.push({ post: p.numero, field: label, term: m[0], why });
      }
    }
  return out;
}

// ------------------------------------------------------------ importer
export type ImportResult =
  | {
      ok: true;
      content: PlanContent;
      changes: string[];
      warnings: string[];
      summary: string;
      /** Posts already decided whose content changes (they go back to pending). */
      reopened: number[];
    }
  | { ok: false; error: string };

const POST_FIELDS: {
  key: keyof PlanPost;
  label: string;
  optional?: boolean;
}[] = [
  { key: "gancho", label: "gancho" },
  { key: "direcaoCopy", label: "direção de copy" },
  { key: "direcaoVisual", label: "direção visual" },
  { key: "formato", label: "formato" },
  { key: "cta", label: "CTA" },
  { key: "textoImagem", label: "texto da imagem", optional: true },
  { key: "textoVideo", label: "texto do vídeo", optional: true },
  { key: "legenda", label: "legenda", optional: true },
];
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The partial update returned by the chat (or by "Pedir ajuste à IA"),
 * validated and merged into the plan: what is absent stays; diagnostico,
 * swot and campanha merge field by field; pilares and alertas are replaced;
 * a post whose content changes goes back to pending.
 */
export function parseImport(
  text: string,
  current: PlanContent,
  opened: { clientSlugs: string[]; planId: string; planLabel: string },
): ImportResult {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "O texto colado não é um JSON válido." };
  }
  if (!isObject(data))
    return { ok: false, error: "O JSON precisa ser um objeto." };
  if (data.tipo !== "social-leads-atualizacao")
    return {
      ok: false,
      error: 'O campo "tipo" precisa ser "social-leads-atualizacao".',
    };
  if (
    typeof data.cliente !== "string" ||
    !opened.clientSlugs.includes(slugify(data.cliente))
  )
    return {
      ok: false,
      error: `Este JSON é de outro cliente (${String(data.cliente ?? "sem cliente")}).`,
    };
  const warnings: string[] = [];
  if (
    data.plano != null &&
    String(data.plano) !== opened.planId &&
    slugify(String(data.plano)) !== slugify(opened.planLabel)
  )
    warnings.push(
      `O JSON fala do plano "${String(data.plano)}", mas o aberto é o ${opened.planLabel}.`,
    );
  const a = data.alteracoes;
  if (!isObject(a))
    return { ok: false, error: 'Faltou o objeto "alteracoes".' };

  const next: PlanContent = JSON.parse(JSON.stringify(current));
  const changes: string[] = [];
  const reopened: number[] = [];

  if (a.posts != null) {
    if (!Array.isArray(a.posts))
      return { ok: false, error: '"posts" precisa ser uma lista.' };
    const total = next.posts.length;
    if (a.posts.length > total)
      return { ok: false, error: `Mais de ${total} posts no JSON.` };
    const seen = new Set<number>();
    for (const item of a.posts) {
      if (!isObject(item))
        return { ok: false, error: "Post inválido no JSON." };
      const n = Number(item.numero);
      if (!Number.isInteger(n) || n < 1 || n > total)
        return {
          ok: false,
          error: `Número de post fora de 1 a ${total}: ${String(item.numero)}.`,
        };
      if (seen.has(n))
        return { ok: false, error: `Post ${n} repetido no JSON.` };
      seen.add(n);
      const post = next.posts.find((p) => p.numero === n);
      if (!post)
        return { ok: false, error: `O post ${n} não existe neste plano.` };
      const what: string[] = [];
      if (item.badge != null) {
        if (!(String(item.badge) in pillars))
          return {
            ok: false,
            error: `Pilar do post ${n} inválido: use posicionar, autoridade ou oferta.`,
          };
        if (item.badge !== post.badge) {
          post.badge = item.badge as Pillar;
          what.push("pilar");
        }
      }
      for (const f of POST_FIELDS) {
        if (item[f.key] == null) continue;
        const value = String(item[f.key]).trim();
        if (!value && !f.optional)
          return {
            ok: false,
            error: `O ${f.label} do post ${n} ficaria vazio.`,
          };
        if (value !== (post[f.key] ?? "")) {
          (post as unknown as Record<string, unknown>)[f.key] = value;
          what.push(f.label);
        }
      }
      if (
        item.ehAnuncio != null &&
        Boolean(item.ehAnuncio) !== post.ehAnuncio
      ) {
        post.ehAnuncio = Boolean(item.ehAnuncio);
        what.push(
          post.ehAnuncio ? "passa a ser o anúncio" : "deixa de ser o anúncio",
        );
      }
      if (what.length) {
        changes.push(`Post ${n}: ${what.join(", ")}`);
        if (post.status && post.status !== "pendente") reopened.push(n);
        post.status = "pendente";
        post.observacao = "";
      }
    }
  }
  const merge = (key: "diagnostico" | "swot" | "campanha", label: string) => {
    const part = a[key];
    if (part == null) return null;
    if (!isObject(part)) return `"${key}" precisa ser um objeto.`;
    const target = next[key] as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(part)) {
      if (!(k in target)) return `Campo desconhecido em ${key}: ${k}.`;
      const value = Array.isArray(v) ? v.map(String) : String(v ?? "").trim();
      if (JSON.stringify(value) !== JSON.stringify(target[k])) {
        target[k] = value;
        changes.push(`${label}: ${k}`);
      }
    }
    return null;
  };
  for (const [key, label] of [
    ["diagnostico", "Diagnóstico"],
    ["swot", "SWOT"],
    ["campanha", "Campanha"],
  ] as const) {
    const err = merge(key, label);
    if (err) return { ok: false, error: err };
  }
  if (a.pilares != null) {
    if (!Array.isArray(a.pilares) || a.pilares.length !== 4)
      return { ok: false, error: "Os pilares precisam ser exatamente 4." };
    const list = a.pilares.map((p) => ({
      titulo: String(isObject(p) ? (p.titulo ?? "") : "").trim(),
      descricao: String(isObject(p) ? (p.descricao ?? "") : "").trim(),
    }));
    if (list.some((p) => !p.titulo || !p.descricao))
      return { ok: false, error: "Todo pilar precisa de título e descrição." };
    if (JSON.stringify(list) !== JSON.stringify(next.pilares)) {
      next.pilares = list;
      changes.push("Pilares substituídos");
    }
  }
  if (a.alertas != null) {
    if (!Array.isArray(a.alertas))
      return { ok: false, error: '"alertas" precisa ser uma lista.' };
    const list = a.alertas.map((x) => String(x).trim()).filter(Boolean);
    if (JSON.stringify(list) !== JSON.stringify(next.alertas)) {
      next.alertas = list;
      changes.push("Alertas substituídos");
    }
  }
  if (a.publico != null) {
    const v = String(a.publico).trim();
    if (!v) return { ok: false, error: "O público ficaria vazio." };
    if (v !== next.publico) {
      next.publico = v;
      changes.push("Público");
    }
  }
  const ads = next.posts.filter((p) => p.ehAnuncio).length;
  if (ads !== 1)
    return {
      ok: false,
      error: `O plano precisa terminar com exatamente um post que vira anúncio (ficaria com ${ads}).`,
    };
  if (!changes.length) warnings.push("Nada muda no plano com este JSON.");
  if (reopened.length)
    warnings.push(
      `Já avaliados que voltam a pendente: ${reopened.map((n) => `post ${n}`).join(", ")}.`,
    );
  return {
    ok: true,
    content: next,
    changes,
    warnings,
    reopened,
    summary: typeof data.resumo === "string" ? data.resumo.trim() : "",
  };
}

/** A manual edit of one post, as the importer's change list. */
export function editPost(
  current: PlanContent,
  number: number,
  patch: Partial<PlanPost>,
): PlanContent {
  const next: PlanContent = JSON.parse(JSON.stringify(current));
  for (const p of next.posts) {
    if (p.numero === number) Object.assign(p, patch);
    else if (patch.ehAnuncio) p.ehAnuncio = false;
  }
  return next;
}

// ------------------------------------------------------------ post history
/** What happened to a post (migration 20261020090000_social_leads_post_history). */
export type PostEventKind =
  | "created"
  | "approved"
  | "rejected"
  | "reopened"
  | "edited"
  | "arts"
  | "task"
  | "comment"
  | "scheduled"
  | "unscheduled"
  | "published";
/** The post's content fields the history compares (database names). */
export const postFields = {
  pillar: "Pilar",
  hook: "Gancho",
  copy_direction: "Direção de copy",
  visual_direction: "Direção visual",
  format: "Formato",
  cta: "CTA",
  image_text: "Texto da imagem",
  video_text: "Texto do vídeo",
  caption: "Legenda",
  is_ad: "Anúncio do mês",
} as const;
export type PostField = keyof typeof postFields;
export interface PostEventDetail {
  source?: string;
  before?: Partial<Record<PostField, string | boolean>>;
  after?: Partial<Record<PostField, string | boolean>>;
  reason?: string;
  summary?: string;
  /** The approval was for the previous text: the post went back to pending. */
  reset?: boolean;
  added?: { id: string; name: string; type: string }[];
  removed?: string[];
  task?: string;
  assignee?: string;
  team?: string;
  due?: string;
  /** Agendamento (Social Media): when, when before and where. */
  at?: string;
  previous?: string | null;
  destinations?: SmDestination[];
  url?: string | null;
  via?: "manual" | "meta" | null;
  undone?: boolean;
}
export interface SlPostEvent {
  id: string;
  plan_id: string;
  number: number;
  kind: PostEventKind;
  via: "team" | "link" | "ai";
  actor_id: string | null;
  /** Who did it, as named at the time (on the link, the client). */
  actor_name: string;
  note: string;
  detail: PostEventDetail;
  created_at: string;
}
export type PostEventDraft = Omit<SlPostEvent, "id" | "created_at">;

/**
 * The events a change to a post makes, as the database trigger
 * mavi_private.social_leads_log_post writes them (used by the demo).
 */
export function postEventsFor(
  before: SlPost | undefined,
  after: SlPost,
  ctx: {
    actor: string | null;
    actorName: string;
    clientName: string;
    source: string;
    reason?: string | null;
    summary?: string;
    name: (user: string | null) => string;
    task?: { assignee?: string; team?: string; due?: string };
  },
): PostEventDraft[] {
  const base = {
    plan_id: after.plan_id,
    number: after.number,
    actor_id: ctx.actor,
    actor_name: ctx.actorName,
    note: "",
    detail: {} as PostEventDetail,
  };
  const out: PostEventDraft[] = [];
  const via = ctx.source === "ai" ? "ai" : "team";
  if (!before) {
    out.push({
      ...base,
      kind: "created",
      via,
      detail: { source: ctx.source },
    });
    if (after.decision !== "pending")
      out.push({
        ...base,
        kind: after.decision,
        via: "team",
        actor_id: after.decided_by,
        actor_name: ctx.name(after.decided_by),
        note: after.note,
      });
    return out;
  }
  const was: PostEventDetail["before"] = {};
  const now: PostEventDetail["after"] = {};
  for (const f of Object.keys(postFields) as PostField[])
    if ((before[f] ?? "") !== (after[f] ?? "")) {
      was[f] = before[f] ?? "";
      now[f] = after[f] ?? "";
    }
  const edited = Object.keys(was).length > 0;
  const reason = ctx.reason ?? undefined;
  if (edited) {
    const detail: PostEventDetail = { before: was, after: now };
    if (reason) detail.reason = reason;
    if (reason === "ajuste pedido à IA" && ctx.summary)
      detail.summary = ctx.summary;
    if (before.decision !== "pending" && after.decision === "pending")
      detail.reset = true;
    out.push({
      ...base,
      kind: "edited",
      via:
        reason === "ajuste pedido à IA" || reason === "regeneração do mês"
          ? "ai"
          : "team",
      detail,
    });
  }
  if (
    (before.decision !== after.decision ||
      before.decided_at !== after.decided_at) &&
    !(edited && after.decision === "pending")
  ) {
    const detail: PostEventDetail = reason ? { reason } : {};
    if (after.decision === "pending")
      out.push({ ...base, kind: "reopened", via: "team", detail });
    else if (after.decided_via === "link")
      out.push({
        ...base,
        kind: after.decision,
        via: "link",
        actor_id: null,
        actor_name: ctx.clientName,
        note: after.note,
      });
    else
      out.push({
        ...base,
        kind: after.decision,
        via: "team",
        actor_id: after.decided_by ?? ctx.actor,
        actor_name: ctx.name(after.decided_by ?? ctx.actor),
        note: after.note,
        detail,
      });
  }
  const oldArts = before.arts ?? [];
  const newArts = after.arts ?? [];
  const added = newArts
    .filter((a) => !oldArts.some((o) => o.id === a.id))
    .map((a) => ({ id: a.id, name: a.name, type: a.type }));
  const removed = oldArts
    .filter((a) => !newArts.some((o) => o.id === a.id))
    .map((a) => a.name);
  if (added.length || removed.length)
    out.push({
      ...base,
      kind: "arts",
      via: "team",
      detail: { added, removed },
    });
  if (after.task_id && before.task_id !== after.task_id)
    out.push({
      ...base,
      kind: "task",
      via: "team",
      detail: { task: after.task_id, ...ctx.task },
    });
  return out;
}

const shown = (f: PostField, v: string | boolean | undefined) =>
  f === "is_ad"
    ? v
      ? "Sim"
      : "Não"
    : f === "pillar"
      ? (pillars[v as Pillar] ?? String(v ?? ""))
      : postTextPlain(String(v ?? ""));
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** How the timeline shows an event: a title, a tone and what changed. */
export function describeEvent(e: SlPostEvent): {
  title: string;
  tone: "good" | "bad" | "info" | "neutral";
  changes: { label: string; before: string; after: string }[];
  lines: string[];
} {
  const who = e.actor_name || (e.via === "link" ? "O cliente" : "Alguém");
  const d = e.detail ?? {};
  const lines: string[] = [];
  const changes = (Object.keys(d.after ?? {}) as PostField[]).map((f) => ({
    label: postFields[f] ?? f,
    before: shown(f, d.before?.[f]),
    after: shown(f, d.after?.[f]),
  }));
  const restored = d.reason?.match(/restaurar a versão (\d+)/)?.[1];
  switch (e.kind) {
    case "created":
      return {
        title:
          d.source === "import"
            ? "Post importado"
            : d.source === "manual"
              ? `Post criado por ${who}`
              : "Post criado pela MAVI",
        tone: "neutral",
        changes: [],
        lines,
      };
    case "approved":
    case "rejected": {
      const ok = e.kind === "approved";
      if (restored) lines.push(`Na restauração da versão ${restored}.`);
      return {
        title:
          e.via === "link"
            ? `${who} ${ok ? "aprovou" : "pediu ajuste"} pelo link`
            : `${ok ? "Aprovado" : "Ajuste pedido"} · registrado por ${who}`,
        tone: ok ? "good" : "bad",
        changes: [],
        lines,
      };
    }
    case "reopened":
      return {
        title:
          d.reason === "regeneração do mês"
            ? "Voltou para pendente na regeneração do plano"
            : restored
              ? `Voltou para pendente na restauração da versão ${restored}`
              : `${who} voltou o post para pendente`,
        tone: "neutral",
        changes: [],
        lines,
      };
    case "edited":
      if (d.summary) lines.push(maviText(d.summary));
      if (d.reset)
        lines.push(
          "Voltou para pendente: a decisão anterior valia para o texto antigo.",
        );
      return {
        title:
          d.reason === "ajuste pedido à IA"
            ? `Ajustado pela MAVI, a pedido de ${who}`
            : d.reason === "regeneração do mês"
              ? `Refeito pela MAVI na regeneração, a pedido de ${who}`
              : restored
                ? `${who} restaurou a versão ${restored}`
                : d.reason === "importação da conversa no chat"
                  ? `${who} importou uma mudança da conversa no chat`
                  : `Editado por ${who}`,
        tone: "info",
        changes,
        lines,
      };
    case "arts": {
      const add = d.added ?? [];
      const rem = d.removed ?? [];
      if (add.length)
        lines.push(`Enviadas: ${add.map((a) => a.name).join(", ")}`);
      if (rem.length) lines.push(`Retiradas: ${rem.join(", ")}`);
      return {
        title: add.length
          ? `${e.actor_name || "A equipe"} enviou ${plural(add.length, "arte", "artes")}`
          : `${e.actor_name || "A equipe"} retirou ${plural(rem.length, "arte", "artes")}`,
        tone: "info",
        changes: [],
        lines,
      };
    }
    case "task":
      if (d.due)
        lines.push(
          `Prazo: ${new Date(`${d.due}T12:00:00`).toLocaleDateString("pt-BR")}`,
        );
      return {
        title: `Tarefa de arte criada para ${d.assignee ?? (d.team ? `a equipe ${d.team}` : "a equipe")}`,
        tone: "info",
        changes: [],
        lines,
      };
    case "comment":
      return { title: `${who} comentou`, tone: "neutral", changes: [], lines };
    case "scheduled":
      if (d.destinations?.length)
        lines.push(
          `Onde: ${d.destinations.map((x) => destinationLabels[x]).join(", ")}`,
        );
      if (d.previous) lines.push(`Antes: ${scheduleWhen(d.previous)}`);
      return {
        title: `${d.previous ? "Reagendado" : "Agendado"} por ${who} para ${d.at ? scheduleWhen(d.at) : "—"}`,
        tone: "info",
        changes: [],
        lines,
      };
    case "unscheduled":
      return {
        title: `${who} tirou do agendamento`,
        tone: "neutral",
        changes: [],
        lines,
      };
    case "published":
      if (d.url) lines.push(d.url);
      return {
        title: d.undone
          ? `${who} desfez o “publicado”`
          : d.via === "meta"
            ? "Publicado pelo Meta"
            : `Publicado · marcado por ${who}`,
        tone: d.undone ? "neutral" : "good",
        changes: [],
        lines,
      };
  }
}

// ------------------------------------------------------------ briefing by AI
/** What the AI may fill from notes or a transcript (colours have their own search). */
export const briefingAiKeys: BriefingKey[] = briefingKeys.filter(
  (k) => k !== "brandColors",
);
/** The AI's reading of the notes or the meeting, for the team to review. */
export interface BriefingSuggestion {
  fields: BriefingFields;
  objective: CampaignObjective | null;
  /** The passage each field came from (a short quote). */
  evidence: Partial<Record<BriefingKey, string>>;
  /** Fields the material doesn't answer: ask the client. */
  missing: BriefingKey[];
  summary: string;
  /** What was read ("Reunião de onboarding · 12/09"). */
  source: string;
  cost_usd: number;
}
const fieldKind = (key: BriefingKey) =>
  briefingSteps.flatMap((s) => s.fields).find((f) => f.key === key);

/**
 * The AI's fields in the briefing's own formats: money as the mask writes it
 * (the AI sends "1500.00"), the WhatsApp with the mask, the date as
 * AAAA-MM-DD, the Instagram with @ and the site with https://. Empty, unknown
 * or too long values are dropped.
 */
export function cleanBriefingSuggestion(
  raw: Record<string, unknown>,
): BriefingFields {
  const out: BriefingFields = {};
  for (const key of briefingAiKeys) {
    const v = raw[key];
    if (typeof v !== "string") continue;
    let text = v.trim().slice(0, 4000);
    if (!text) continue;
    const f = fieldKind(key);
    if (f?.kind === "money") {
      const n = Number(text.replace(/[^\d.,-]/g, "").replace(",", "."));
      if (Number.isFinite(n) && n > 0) text = formatMoney(n, "BRL");
    } else if (f?.kind === "phone") {
      const digits = text.replace(/\D/g, "");
      if (digits.length < 10) continue;
      text = formatPhoneBR(digits);
    } else if (f?.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || isNaN(Date.parse(text)))
        continue;
    } else if (key === "igHandle") {
      const handle = text
        .replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, "")
        .replace(/[/?].*$/, "")
        .replace(/^@?/, "");
      if (!/^[\w.]{1,30}$/.test(handle)) continue;
      text = `@${handle}`;
    } else if (f?.type === "url") {
      if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
      try {
        new URL(text);
      } catch {
        continue;
      }
    }
    out[key] = text;
  }
  return out;
}

/**
 * The briefing after applying the chosen suggestions: only the fields the
 * team kept (by default, the empty ones), never touching the rest.
 */
export function applyBriefingSuggestion(
  current: BriefingFields,
  suggestion: BriefingFields,
  chosen: BriefingKey[],
): BriefingFields {
  const next = { ...current };
  for (const key of chosen) {
    const v = suggestion[key];
    if (v) next[key] = v;
  }
  return next;
}
/** Which suggestions start ticked: the ones filling an empty field. */
export function defaultBriefingChoice(
  current: BriefingFields,
  suggestion: BriefingFields,
): BriefingKey[] {
  return (Object.keys(suggestion) as BriefingKey[]).filter(
    (k) => !current[k]?.trim(),
  );
}

/**
 * The text of a transcript file: subtitles (.vtt, .srt) lose the numbering,
 * the timings and the WEBVTT header; repeated lines in a row go too.
 */
export function transcriptFromFile(name: string, text: string) {
  const clean = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  if (!/\.(vtt|srt)$/i.test(name)) return clean.trim();
  const lines: string[] = [];
  for (const raw of clean.split("\n")) {
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (
      !line ||
      /^WEBVTT/.test(line) ||
      /^NOTE\b/.test(line) ||
      /^\d+$/.test(line) ||
      /-->/.test(line)
    )
      continue;
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ reading the plan
// The AI writes the strategy and the campaign as paragraphs. These helpers
// turn them into what the eye reads first (the lead sentence, the list items,
// the short fact) without changing a word.
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-ZÀ-Ý"“'(])/u;

/** The sentences of a text ("R$ 1.000,00" and "Sr." stay whole). */
export function sentencesOf(text: string | null | undefined): string[] {
  return (text ?? "")
    .trim()
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The first sentence, and the rest of the text. */
export function leadOf(text: string | null | undefined) {
  const [lead = "", ...rest] = sentencesOf(text);
  return { lead, rest: rest.join(" ") };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A text written as a list ("a; b; c", or several sentences) as its items.
 * A leading "Não foram apontadas … no briefing." (the AI saying the briefing
 * had nothing) and a "Pontos …:" label come apart from the items.
 */
export function pointsOf(text: string | null | undefined): {
  note: string | null;
  label: string | null;
  points: string[];
} {
  let rest = (text ?? "").trim();
  let note: string | null = null;
  let label: string | null = null;
  const empty = rest.match(/^(não (?:foram|foi) apontad[oa]s?[^.]*\.)\s*/i);
  if (empty) {
    note = empty[1];
    rest = rest.slice(empty[0].length);
  }
  const labelled = rest.match(/^([^:;.]{3,80}):\s+(.*)$/s);
  if (labelled && /^pontos?\b/i.test(labelled[1])) {
    label = labelled[1].trim();
    rest = labelled[2];
  }
  const parts =
    (rest.match(/;/g) ?? []).length >= 1
      ? rest.split(/;\s*/)
      : sentencesOf(rest);
  const points = parts
    .map((p) => p.trim().replace(/[.;]+$/, ""))
    .filter(Boolean)
    .map(capitalize);
  return { note, label, points };
}

/** The first clause of a text, short enough for a tile. */
export function shortFact(text: string | null | undefined, max = 48) {
  const t = (text ?? "").trim();
  const cut = t.search(/[,;.(—–]|\s-\s/);
  let s = (cut > 3 ? t.slice(0, cut) : t).trim();
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return s;
}

/** The campaign at a glance: objective, budget, age range and region. */
export function campaignFacts(
  c: PlanContent["campanha"],
  objective: CampaignObjective | null,
): { key: string; label: string; value: string; hint: string }[] {
  const money = c.orcamento.match(
    /R\$\s?[\d.]+(?:,\d{2})?(?:\s*\/\s*m[eê]s)?/i,
  )?.[0];
  const daily = c.orcamento.match(/R\$\s?[\d.]+(?:,\d{2})?\s*\/\s*dia/i)?.[0];
  const age = c.idadeGenero.match(
    /\d{2}\s*(?:a|-|–|até)\s*\d{2}\+?\s*anos/i,
  )?.[0];
  const radius = c.regiao.match(/raio de [^,.;]*?km/i)?.[0];
  return [
    {
      key: "objetivo",
      label: "Objetivo",
      value: objective
        ? objective === "ctwa"
          ? "Conversa no WhatsApp"
          : "Formulário no Meta"
        : shortFact(c.objetivo) || "—",
      hint: shortFact(c.objetivo, 90),
    },
    {
      key: "verba",
      label: "Verba de mídia",
      value: money
        ? money.replace(/\s*\/\s*/, "/")
        : shortFact(c.orcamento) || "—",
      hint: daily ? `≈ ${daily.replace(/\s*\/\s*/, "/")}` : "",
    },
    {
      key: "publico",
      label: "Idade",
      value: age ?? (shortFact(c.idadeGenero) || "—"),
      hint: /todos os g[eê]neros/i.test(c.idadeGenero)
        ? "Todos os gêneros"
        : "",
    },
    {
      key: "regiao",
      label: "Região",
      value: radius ? capitalize(radius) : shortFact(c.regiao) || "—",
      hint: radius
        ? shortFact(
            c.regiao.slice(c.regiao.indexOf(radius) + radius.length),
            60,
          )
        : "",
    },
  ];
}

// ------------------------------------------------------------ agendamento
/** The module of a client (social-leads-module.ts; repeated: no imports here). */
type SlModule = "social_leads" | "social_media";
/** Where a post goes: Instagram (feed, carousel or Reels by the art), Stories, the Facebook Page. */
export type SmDestination = "instagram" | "story" | "facebook";
export const destinationLabels: Record<SmDestination, string> = {
  instagram: "Instagram",
  story: "Stories",
  facebook: "Facebook",
};
export const DESTINATIONS: SmDestination[] = ["instagram", "story", "facebook"];
export type SmStatus =
  "scheduled" | "publishing" | "due" | "published" | "failed";
/** A post's schedule (migration 20270315090000_social_media_schedule). */
export interface SmSchedule {
  plan_id: string;
  number: number;
  scheduled_at: string;
  destinations: SmDestination[];
  /** null: the plan's caption. */
  caption: string | null;
  first_comment: string;
  cover: { art: string } | { seconds: number } | null;
  status: SmStatus;
  reminded_at: string | null;
  published_at: string | null;
  published_url: string | null;
  published_via: "manual" | "meta" | null;
  published_by: string | null;
  error: string | null;
  scheduled_by: string;
  updated_by: string | null;
  updated_at: string;
}
/** What a save sends: the time in the company's time zone ("AAAA-MM-DDTHH:MM"). */
export interface SmScheduleDraft {
  number: number;
  at: string;
  destinations: SmDestination[];
  caption: string | null;
  first_comment: string;
  cover: SmSchedule["cover"];
}
export const SM_TIME_ZONE = "America/Sao_Paulo";
/** An instant as "AAAA-MM-DDTHH:MM" in a time zone (the input's value). */
export function localInput(iso: string, timeZone = SM_TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** "seg., 12/10 às 18:30" (in the company's time zone). */
export function scheduleWhen(iso: string, timeZone = SM_TIME_ZONE) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("pt-BR", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
  const time = d.toLocaleTimeString("pt-BR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} às ${time}`;
}
/** "AAAA-MM-DDTHH:MM" (local) shown the same way. */
export function localWhen(local: string) {
  const [date, time] = local.split("T");
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.toLocaleDateString("pt-BR", {
    timeZone: "UTC",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
  return `${day} às ${time}`;
}
/** Instagram's label for a post: Reels for a video, carousel for several arts. */
export function instagramKind(arts: { type: string }[] | undefined) {
  const list = arts ?? [];
  if (list.some((a) => a.type.startsWith("video/")) && list.length === 1)
    return "Reels";
  return list.length > 1 ? "Carrossel" : "Feed";
}
/** The schedule's status for the team. */
export function scheduleStatus(s: SmSchedule, now = Date.now()) {
  if (s.status === "published")
    return { label: "Publicado", tone: "good" as const };
  if (s.status === "failed") return { label: "Falhou", tone: "bad" as const };
  if (s.status === "publishing")
    return { label: "Publicando pelo Meta", tone: "info" as const };
  if (s.status === "due" || new Date(s.scheduled_at).getTime() <= now)
    return { label: "Hora de publicar", tone: "warn" as const };
  return { label: "Agendado", tone: "info" as const };
}
/**
 * The client's Meta connection in Social Media (migration
 * 20270316090000_social_media_meta): the Page and its Instagram. The token
 * never leaves the database.
 */
export interface SmAccount {
  link_calendar: boolean;
  page_id: string | null;
  page_name: string | null;
  ig_user_id: string | null;
  ig_username: string | null;
  connected_via: "agency" | "client" | null;
  connected_name: string | null;
  connected_by: string | null;
  connected_at: string | null;
  connection_error: string | null;
  connection_error_at: string | null;
}
/** A Page the Facebook login reaches (to pick the client's). */
export interface SmPage {
  id: string;
  name: string;
  ig_id: string | null;
  ig_username: string | null;
}

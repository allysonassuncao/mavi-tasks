/**
 * MAVI · identidades visuais (migração 20270604090000_visual_identities): o
 * tema que os documentos e as apresentações usam — cores por função, fontes
 * de título e de texto, logos, cantos, capa e detalhes. Serve à tela, às
 * exportações (PDF, PowerPoint, Word, HTML) e ao servidor da MAVI.
 *
 * - A identidade fica no banco (do cliente, da empresa ou da galeria) ou é
 *   um dos estilos prontos daqui (builtin:…).
 * - O documento guarda uma cópia do tema (Look) de quando foi criado: mudar
 *   a identidade depois não muda o que já foi entregue.
 * - Logos e fontes da marca são arquivos do Drive (pastas de Marca), pelos
 *   ids; no HTML viram file:<id> e são trocados pelo arquivo na hora.
 */

export type FontSource = "google" | "brand" | "system";
export type IdentityFont = { family: string; weight: number; source: FontSource };
/** Um arquivo de fonte da marca, com a família e o peso dele. */
export type BrandFace = { file: string; family: string; weight: number; style: "normal" | "italic" };
export type IdentityColors = {
  /** O fundo das páginas e dos slides. */
  bg: string;
  /** Cartões, caixas e linhas de tabela. */
  surface: string;
  /** O texto. */
  ink: string;
  /** Texto de apoio (subtítulos, legendas). */
  muted: string;
  /** A cor principal da marca (capas, faixas, títulos de destaque). */
  primary: string;
  /** O texto sobre a cor principal. */
  on_primary: string;
  /** O destaque (números, marcadores, detalhes). */
  accent: string;
};
export const COVERS = ["solid", "primary", "gradient", "split"] as const;
export const DECORS = ["none", "bar", "corner", "band"] as const;
export type Cover = (typeof COVERS)[number];
export type Decor = (typeof DECORS)[number];
export type IdentityTokens = {
  mode: "light" | "dark";
  colors: IdentityColors;
  heading: IdentityFont;
  body: IdentityFont;
  /** As fontes da marca usadas (arquivos). */
  faces: BrandFace[];
  /** O logo para fundo claro e para fundo escuro (ids de arquivos da Marca). */
  logo: { light?: string; dark?: string };
  /** Cantos arredondados, em pixels num slide de 1280 (0 = retos). */
  radius: number;
  cover: Cover;
  decor: Decor;
};
export type LookSource = "client" | "company" | "gallery" | "builtin" | "custom";
/** O tema aplicado num documento (cópia de quando foi criado). */
export type Look = IdentityTokens & {
  id: string;
  name: string;
  source: LookSource;
  /** O cliente da identidade, quando é a dele. */
  client?: string;
};

export type IdentityScope = "company" | "client" | "gallery";
export type IdentityRow = {
  id: string;
  scope: IdentityScope;
  client_id: string | null;
  client_name: string | null;
  name: string;
  description: string;
  tokens: unknown;
  guide_chars: number;
  version: number;
  updated_at: string;
  updated_by_name: string | null;
  guide?: string;
};

export const COVER_LABELS: Record<Cover, string> = {
  solid: "Fundo da página",
  primary: "Cor principal",
  gradient: "Degradê",
  split: "Dividida",
};
export const DECOR_LABELS: Record<Decor, string> = {
  none: "Nenhum",
  bar: "Barra no título",
  corner: "Forma no canto",
  band: "Faixa no rodapé",
};
export const COLOR_LABELS: Record<keyof IdentityColors, string> = {
  bg: "Fundo",
  surface: "Caixas",
  ink: "Texto",
  muted: "Texto de apoio",
  primary: "Principal",
  on_primary: "Texto sobre a principal",
  accent: "Destaque",
};

/**
 * As fontes do Google que a tela oferece, com os pesos que existem (pedir um
 * peso que a família não tem derruba a folha de estilos inteira).
 */
export const GOOGLE_FONTS: Record<string, number[]> = {
  Inter: [300, 400, 500, 600, 700, 800],
  Roboto: [300, 400, 500, 700, 900],
  "Open Sans": [300, 400, 600, 700, 800],
  Montserrat: [300, 400, 500, 600, 700, 800, 900],
  Poppins: [300, 400, 500, 600, 700, 800],
  Lato: [300, 400, 700, 900],
  Nunito: [300, 400, 600, 700, 800],
  Raleway: [300, 400, 500, 600, 700, 800],
  "Work Sans": [300, 400, 500, 600, 700],
  "DM Sans": [400, 500, 700],
  "DM Serif Display": [400],
  Manrope: [300, 400, 500, 600, 700, 800],
  "Plus Jakarta Sans": [300, 400, 500, 600, 700, 800],
  "Space Grotesk": [300, 400, 500, 600, 700],
  "IBM Plex Sans": [300, 400, 500, 600, 700],
  "IBM Plex Serif": [300, 400, 500, 600, 700],
  "Source Sans 3": [300, 400, 600, 700, 900],
  "Source Serif 4": [300, 400, 600, 700],
  "Playfair Display": [400, 500, 600, 700, 800, 900],
  Merriweather: [300, 400, 700, 900],
  Lora: [400, 500, 600, 700],
  "Cormorant Garamond": [300, 400, 500, 600, 700],
  "Libre Baskerville": [400, 700],
  Oswald: [300, 400, 500, 600, 700],
  "Bebas Neue": [400],
  Archivo: [300, 400, 500, 600, 700, 800],
  Rubik: [300, 400, 500, 600, 700, 800],
  Outfit: [300, 400, 500, 600, 700, 800],
  Sora: [300, 400, 600, 700, 800],
  Fraunces: [300, 400, 600, 700, 900],
  Barlow: [300, 400, 500, 600, 700, 800],
  "Josefin Sans": [300, 400, 600, 700],
  Urbanist: [300, 400, 500, 600, 700, 800],
  "Red Hat Display": [300, 400, 500, 700, 900],
};
/** Fontes que já vêm no computador (Word e PowerPoint mostram igual). */
export const SYSTEM_FONTS: Record<string, string> = {
  Calibri: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif",
  Arial: "Arial, Helvetica, sans-serif",
  "Segoe UI": "'Segoe UI', system-ui, Arial, sans-serif",
  Georgia: "Georgia, 'Times New Roman', serif",
  "Times New Roman": "'Times New Roman', Times, serif",
  Verdana: "Verdana, Geneva, sans-serif",
  "Trebuchet MS": "'Trebuchet MS', Arial, sans-serif",
};

// ------------------------------------------------------------ estilos prontos
type Builtin = { name: string; description: string; tokens: IdentityTokens };
const g = (family: string, weight = 700): IdentityFont => ({ family, weight, source: "google" });
const base = (
  mode: "light" | "dark",
  colors: IdentityColors,
  heading: IdentityFont,
  body: IdentityFont,
  extra: Partial<IdentityTokens> = {},
): IdentityTokens => ({
  mode,
  colors,
  heading,
  body,
  faces: [],
  logo: {},
  radius: 12,
  cover: "solid",
  decor: "bar",
  ...extra,
});

/**
 * Os estilos que a MAVI sugere quando não há marca. Os três primeiros são
 * os temas antigos das apresentações (claro, escuro, verde).
 */
export const BUILTIN_LOOKS: Record<string, Builtin> = {
  claro: {
    name: "Claro",
    description: "Fundo branco, texto grafite e verde de destaque. Neutro, para qualquer assunto.",
    tokens: base(
      "light",
      { bg: "#FFFFFF", surface: "#EEF4E5", ink: "#263334", muted: "#6B7775", primary: "#4F7D2D", on_primary: "#FFFFFF", accent: "#4F7D2D" },
      g("Inter", 700),
      g("Inter", 400),
    ),
  },
  escuro: {
    name: "Escuro",
    description: "Fundo grafite com verde-limão. Para apresentações de impacto e telas.",
    tokens: base(
      "dark",
      { bg: "#1C2728", surface: "#263334", ink: "#F3F6F1", muted: "#A9B5B2", primary: "#C8EC8E", on_primary: "#1C2728", accent: "#C8EC8E" },
      g("Inter", 700),
      g("Inter", 400),
    ),
  },
  verde: {
    name: "Verde",
    description: "Fundo verde-claro e verde-escuro. Leve e acolhedor.",
    tokens: base(
      "light",
      { bg: "#EEF4E5", surface: "#FFFFFF", ink: "#1C2728", muted: "#4F5C5C", primary: "#2F6B1E", on_primary: "#FFFFFF", accent: "#2F6B1E" },
      g("Inter", 700),
      g("Inter", 400),
    ),
  },
  corporativo: {
    name: "Corporativo",
    description: "Azul-marinho e branco, capa na cor principal. Propostas, relatórios para diretoria, bancos e B2B.",
    tokens: base(
      "light",
      { bg: "#FFFFFF", surface: "#EEF2F8", ink: "#14213D", muted: "#5C677D", primary: "#14213D", on_primary: "#FFFFFF", accent: "#2563EB" },
      g("IBM Plex Sans", 700),
      g("IBM Plex Sans", 400),
      { cover: "primary", radius: 6, decor: "band" },
    ),
  },
  minimalista: {
    name: "Minimalista",
    description: "Preto no branco, cantos retos e um vermelho pontual. Moderno e direto.",
    tokens: base(
      "light",
      { bg: "#FFFFFF", surface: "#F4F4F4", ink: "#111111", muted: "#6E6E6E", primary: "#111111", on_primary: "#FFFFFF", accent: "#E63946" },
      g("Manrope", 800),
      g("Manrope", 400),
      { radius: 0, decor: "none", cover: "split" },
    ),
  },
  editorial: {
    name: "Editorial",
    description: "Papel creme, títulos com serifa e terracota. Conteúdo, artigos, marcas premium e de estilo de vida.",
    tokens: base(
      "light",
      { bg: "#FAF6EF", surface: "#F1E9DC", ink: "#2B2420", muted: "#7A6E64", primary: "#A0522D", on_primary: "#FFFFFF", accent: "#A0522D" },
      g("Playfair Display", 700),
      g("Source Sans 3", 400),
      { radius: 4, decor: "bar" },
    ),
  },
  tech: {
    name: "Tech noturno",
    description: "Azul-noite com ciano e violeta em degradê. Tecnologia, SaaS, lançamentos e dados.",
    tokens: base(
      "dark",
      { bg: "#0B1020", surface: "#151C33", ink: "#EAF0FF", muted: "#8E9AC0", primary: "#22D3EE", on_primary: "#0B1020", accent: "#A78BFA" },
      g("Space Grotesk", 700),
      g("Inter", 400),
      { cover: "gradient", radius: 16, decor: "corner" },
    ),
  },
  vibrante: {
    name: "Vibrante",
    description: "Roxo e laranja, formas arredondadas. Varejo, promoções, público jovem e redes sociais.",
    tokens: base(
      "light",
      { bg: "#FFFFFF", surface: "#F3EEFF", ink: "#1E1B3A", muted: "#6B6790", primary: "#6D28D9", on_primary: "#FFFFFF", accent: "#F97316" },
      g("Poppins", 700),
      g("Poppins", 400),
      { cover: "gradient", radius: 24, decor: "corner" },
    ),
  },
  elegante: {
    name: "Elegante",
    description: "Preto e dourado, serifa clássica. Luxo, imobiliário de alto padrão, joias e eventos.",
    tokens: base(
      "dark",
      { bg: "#111111", surface: "#1C1C1C", ink: "#F5F1E8", muted: "#A39E93", primary: "#C9A45C", on_primary: "#111111", accent: "#C9A45C" },
      g("Cormorant Garamond", 600),
      g("Montserrat", 400),
      { radius: 0, decor: "bar", cover: "solid" },
    ),
  },
  natural: {
    name: "Natural",
    description: "Bege e verde-oliva, serifa suave. Saúde, bem-estar, alimentação e sustentabilidade.",
    tokens: base(
      "light",
      { bg: "#F6F3EA", surface: "#ECE6D6", ink: "#2F3A2B", muted: "#6F7765", primary: "#5B7046", on_primary: "#FFFFFF", accent: "#C17C3A" },
      g("DM Serif Display", 400),
      g("DM Sans", 400),
      { radius: 18, decor: "corner" },
    ),
  },
};
export const BUILTIN_PREFIX = "builtin:";
export function builtinLook(key: string): Look | null {
  const b = BUILTIN_LOOKS[key.replace(BUILTIN_PREFIX, "")];
  return b ? { ...structuredClone(b.tokens), id: `${BUILTIN_PREFIX}${key.replace(BUILTIN_PREFIX, "")}`, name: b.name, source: "builtin" } : null;
}
/** O tema antigo das apresentações (claro, escuro, verde) como identidade. */
export const legacyLook = (theme: string | undefined) => builtinLook(theme && theme in BUILTIN_LOOKS ? theme : "claro")!;

// ------------------------------------------------------------ conferência
const HEX = /^#[0-9a-f]{6}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAMILY = /^[\p{L}\p{N} .'&-]{2,60}$/u;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const hex = (v: unknown, fallback: string) => {
  let s = typeof v === "string" ? v.trim() : "";
  if (/^#?[0-9a-f]{3}$/i.test(s)) s = `#${s.replace("#", "").replace(/./g, "$&$&")}`;
  if (/^[0-9a-f]{6}$/i.test(s)) s = `#${s}`;
  return HEX.test(s) ? s.toUpperCase() : fallback;
};
const weightOf = (v: unknown, fallback: number) => {
  const n = Math.round(Number(v) / 100) * 100;
  return n >= 100 && n <= 900 ? n : fallback;
};

function font(raw: unknown, fallback: IdentityFont, faces: BrandFace[]): IdentityFont {
  const o = obj(raw);
  const family = typeof o?.family === "string" ? o.family.trim().replace(/["`]/g, "") : typeof raw === "string" ? raw.trim() : "";
  if (!FAMILY.test(family)) return fallback;
  const weight = weightOf(o?.weight, fallback.weight);
  const branded = faces.some((f) => f.family.toLowerCase() === family.toLowerCase());
  const known = Object.keys(GOOGLE_FONTS).find((k) => k.toLowerCase() === family.toLowerCase());
  const system = Object.keys(SYSTEM_FONTS).find((k) => k.toLowerCase() === family.toLowerCase());
  const asked = o?.source;
  const source: FontSource =
    asked === "brand" && branded
      ? "brand"
      : branded && asked !== "google"
        ? "brand"
        : system && asked !== "google"
          ? "system"
          : "google";
  return { family: known && source === "google" ? known : system && source === "system" ? system : family, weight, source };
}

/** Os tokens de uma identidade no formato fechado, com o que faltar do padrão. */
export function sanitizeTokens(raw: unknown, fallback: IdentityTokens = BUILTIN_LOOKS.claro.tokens): IdentityTokens {
  const v = obj(raw) ?? {};
  const c = obj(v.colors) ?? {};
  // Sem fontes ou logo no pedido, ficam as do tema de base (um ajuste só de cores não perde o logo).
  const faces = (Array.isArray(v.faces) ? v.faces : fallback.faces)
    .map((x) => {
      const f = obj(x);
      if (!f || typeof f.file !== "string" || !UUID.test(f.file)) return null;
      const family = typeof f.family === "string" ? f.family.trim().replace(/["`]/g, "") : "";
      if (!FAMILY.test(family)) return null;
      return {
        file: f.file.toLowerCase(),
        family,
        weight: weightOf(f.weight, 400),
        style: f.style === "italic" ? ("italic" as const) : ("normal" as const),
      };
    })
    .filter((f): f is BrandFace => !!f)
    .slice(0, 24);
  const colors = Object.fromEntries(
    (Object.keys(fallback.colors) as (keyof IdentityColors)[]).map((k) => [k, hex(c[k], fallback.colors[k])]),
  ) as IdentityColors;
  // Sem o texto sobre a principal: o que tiver mais contraste.
  if (!HEX.test(String(c.on_primary ?? "")) && HEX.test(String(c.primary ?? "")))
    colors.on_primary = readableOn(colors.primary, colors.ink);
  const logo = obj(v.logo) ?? fallback.logo;
  const id = (x: unknown) => (typeof x === "string" && UUID.test(x) ? x.toLowerCase() : undefined);
  const radius = Number(v.radius);
  const mode = v.mode === "dark" || v.mode === "light" ? v.mode : luminance(colors.bg) < 0.4 ? "dark" : "light";
  return {
    mode,
    colors,
    heading: font(v.heading, fallback.heading, faces),
    body: font(v.body, fallback.body, faces),
    faces,
    logo: Object.fromEntries(
      [
        ["light", id(logo.light)],
        ["dark", id(logo.dark)],
      ].filter(([, x]) => x),
    ),
    radius: Number.isFinite(radius) ? Math.max(0, Math.min(40, Math.round(radius))) : fallback.radius,
    cover: (COVERS as readonly string[]).includes(String(v.cover)) ? (v.cover as Cover) : fallback.cover,
    decor: (DECORS as readonly string[]).includes(String(v.decor)) ? (v.decor as Decor) : fallback.decor,
  };
}

/** O tema guardado num documento (null: não há ou não serve). */
export function sanitizeLook(raw: unknown): Look | null {
  const v = obj(raw);
  if (!v) return null;
  const name = typeof v.name === "string" ? v.name.trim().slice(0, 80) : "";
  const id = typeof v.id === "string" ? v.id.trim().slice(0, 60) : "";
  const source = (["client", "company", "gallery", "builtin", "custom"] as const).find((s) => s === v.source) ?? "custom";
  const client = typeof v.client === "string" && UUID.test(v.client) ? v.client.toLowerCase() : undefined;
  return { ...sanitizeTokens(v), id: id || "custom", name: name || "Estilo próprio", source, ...(client ? { client } : {}) };
}

// ------------------------------------------------------------ cores
export function luminance(h: string) {
  const n = parseInt(h.replace("#", ""), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** O texto que se lê melhor sobre a cor (branco ou o escuro dado). */
export function readableOn(color: string, dark = "#111111") {
  return contrast(color, "#FFFFFF") >= contrast(color, dark) ? "#FFFFFF" : dark.toUpperCase();
}
/** Os pares com pouco contraste (para avisar na tela e à MAVI). */
export function contrastIssues(t: IdentityTokens) {
  const pairs: [keyof IdentityColors, keyof IdentityColors, number][] = [
    ["ink", "bg", 4.5],
    ["ink", "surface", 4.5],
    ["muted", "bg", 3],
    ["on_primary", "primary", 3],
    ["accent", "bg", 2],
  ];
  return pairs
    .filter(([a, b, min]) => contrast(t.colors[a], t.colors[b]) < min)
    .map(([a, b]) => `${COLOR_LABELS[a]} sobre ${COLOR_LABELS[b].toLowerCase()} com pouco contraste`);
}

// ------------------------------------------------------------ fontes
/** A família no CSS, com reservas. */
export function fontStack(f: IdentityFont) {
  if (f.source === "system") return SYSTEM_FONTS[f.family] ?? `"${f.family}", Arial, sans-serif`;
  const serif = /serif|garamond|baskerville|playfair|merriweather|lora|fraunces|times|georgia/i.test(f.family) && !/sans/i.test(f.family);
  return `"${f.family}", ${serif ? "Georgia, serif" : "Arial, sans-serif"}`;
}
/** A folha do Google Fonts com as famílias do tema (null: nenhuma). */
export function googleFontsHref(t: Pick<IdentityTokens, "heading" | "body">) {
  const want = new Map<string, Set<number>>();
  for (const f of [t.heading, t.body]) {
    if (f.source !== "google") continue;
    const set = want.get(f.family) ?? new Set<number>();
    set.add(f.weight);
    want.set(f.family, set);
  }
  if (!want.size) return null;
  const parts = [...want].map(([family, weights]) => {
    const has = GOOGLE_FONTS[family];
    const q = family.replace(/ /g, "+");
    if (!has) return `family=${q}`;
    // O peso pedido, o regular e o negrito, se a família tiver.
    const ws = [...new Set([...weights, 400, 700])].filter((w) => has.includes(w)).sort((a, b) => a - b);
    return ws.length ? `family=${q}:wght@${ws.join(";")}` : `family=${q}`;
  });
  return `https://fonts.googleapis.com/css2?${parts.join("&")}&display=swap`;
}
/** Os @font-face das fontes da marca (o arquivo vai como file:<id>). */
export function brandFontFaces(t: Pick<IdentityTokens, "faces" | "heading" | "body">, url = (file: string) => `file:${file}`) {
  const used = new Set([t.heading, t.body].filter((f) => f.source === "brand").map((f) => f.family.toLowerCase()));
  return t.faces
    .filter((f) => used.has(f.family.toLowerCase()))
    .map(
      (f) =>
        `@font-face{font-family:"${f.family}";src:url("${url(f.file)}");font-weight:${f.weight};font-style:${f.style};font-display:block}`,
    )
    .join("\n");
}
/** Os arquivos que o tema usa (logos e fontes). */
export function lookFiles(t: Pick<IdentityTokens, "faces" | "heading" | "body" | "logo">) {
  const used = new Set([t.heading, t.body].filter((f) => f.source === "brand").map((f) => f.family.toLowerCase()));
  return [
    ...new Set([
      ...(t.logo.light ? [t.logo.light] : []),
      ...(t.logo.dark ? [t.logo.dark] : []),
      ...t.faces.filter((f) => used.has(f.family.toLowerCase())).map((f) => f.file),
    ]),
  ];
}
/** O logo que combina com o fundo (o do fundo escuro no escuro), se houver. */
export function logoFor(t: Pick<IdentityTokens, "logo">, background: string) {
  const dark = luminance(background) < 0.4;
  return (dark ? t.logo.dark ?? t.logo.light : t.logo.light ?? t.logo.dark) ?? null;
}

// ------------------------------------------------------------ a partir da Marca
export type BrandInput = {
  colors: { name: string; hex: string }[];
  fonts: { file: string; family: string; weight: number; style: string; role: string }[];
  files: { id: string; name: string; content_type?: string }[];
};
/**
 * Um primeiro tema a partir de Drive › cliente › Marca: a cor mais forte vira
 * a principal, a segunda o destaque; as fontes pelo papel ("títulos",
 * "texto"); os logos pelo nome do arquivo (branco/negativo = fundo escuro).
 */
export function tokensFromBrand(brand: BrandInput): IdentityTokens {
  const t = structuredClone(BUILTIN_LOOKS.claro.tokens);
  const colors = brand.colors.map((c) => c.hex.toUpperCase()).filter((h) => HEX.test(h));
  const strong = colors.filter((h) => luminance(h) > 0.03 && luminance(h) < 0.75);
  const darkest = [...colors].sort((a, b) => luminance(a) - luminance(b))[0];
  if (strong[0]) t.colors.primary = strong[0];
  t.colors.accent = strong[1] ?? strong[0] ?? t.colors.accent;
  if (darkest && luminance(darkest) < 0.06) t.colors.ink = darkest;
  t.colors.on_primary = readableOn(t.colors.primary, t.colors.ink);
  t.colors.surface = mix(t.colors.primary, "#FFFFFF", 0.92);
  t.colors.muted = mix(t.colors.ink, "#FFFFFF", 0.45);
  t.cover = "primary";
  const faces: BrandFace[] = brand.fonts
    .filter((f) => UUID.test(f.file) && FAMILY.test(f.family))
    .map((f) => ({ file: f.file, family: f.family, weight: weightOf(f.weight, 400), style: f.style === "italic" ? "italic" : "normal" }));
  t.faces = faces;
  const byRole = (re: RegExp) => brand.fonts.find((f) => re.test(f.role));
  const head = byRole(/t[íi]tul|destaq|display|head/i) ?? brand.fonts[0];
  const text = byRole(/texto|corpo|body|par[áa]graf/i) ?? brand.fonts.find((f) => f.family !== head?.family) ?? head;
  if (head) t.heading = { family: head.family, weight: weightOf(head.weight, 700), source: "brand" };
  if (text) t.body = { family: text.family, weight: weightOf(text.weight, 400), source: "brand" };
  const images = brand.files.filter((f) => /\.(png|jpe?g|webp|svg)$/i.test(f.name));
  const logos = images.filter((f) => /logo|marca|assinatura/i.test(f.name));
  const pool = logos.length ? logos : images;
  const forDark = pool.find((f) => /branc|white|negativ|dark|escur|invert/i.test(f.name));
  const forLight = pool.find((f) => f !== forDark && !/branc|white|negativ|invert/i.test(f.name));
  t.logo = { ...(forLight ? { light: forLight.id } : {}), ...(forDark ? { dark: forDark.id } : {}) };
  return t;
}
/** Mistura duas cores (0 = a, 1 = b). */
export function mix(a: string, b: string, k: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Uma linha que resume o tema (para a MAVI e para o card). */
export function describeTokens(t: IdentityTokens) {
  const font = (f: IdentityFont) => `${f.family} ${f.weight}${f.source === "brand" ? " (da marca)" : ""}`;
  return [
    `${t.mode === "dark" ? "escuro" : "claro"}`,
    `fundo ${t.colors.bg}, texto ${t.colors.ink}, principal ${t.colors.primary}, destaque ${t.colors.accent}`,
    `títulos ${font(t.heading)}, texto ${font(t.body)}`,
    `capa ${COVER_LABELS[t.cover].toLowerCase()}, detalhe ${DECOR_LABELS[t.decor].toLowerCase()}, cantos ${t.radius}px`,
    t.logo.light || t.logo.dark ? "com logo" : "sem logo",
  ].join("; ");
}

// ------------------------------------------------------------ Guia da marca
export const GUIDE_SECTIONS = [
  "Essência",
  "Tom de voz",
  "Visual",
  "Faça",
  "Evite",
  "Exemplos aprovados",
  "Aprendizados",
] as const;
export const GUIDE_TEMPLATE = `## Essência
O que a marca é e como quer ser percebida, em 2 ou 3 frases.

## Tom de voz
- Como fala (ex.: próximo, direto, sem jargão)
- Palavras que usa e que evita

## Visual
- Quando usar fundo escuro ou claro
- Como usar a cor principal e o destaque
- Fotos e ilustrações: estilo

## Faça
-

## Evite
-

## Exemplos aprovados
- (documentos, apresentações ou artes que o cliente aprovou)

## Aprendizados
- (correções do cliente, com a data)
`;
const foldText = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * Põe itens numa seção do guia ("## Faça"): no fim da seção, como tópicos;
 * sem a seção, ela nasce no fim. Tira os tópicos vazios do modelo ("-") e
 * os de exemplo entre parênteses; não repete um item que já está lá.
 */
export function addToGuide(guide: string, section: string, items: string[], date?: string) {
  const lines = guide.replace(/\r\n?/g, "\n").split("\n");
  const want = foldText(section.replace(/^#+\s*/, ""));
  const start = lines.findIndex((l) => /^##\s+/.test(l) && foldText(l.replace(/^##\s+/, "")) === want);
  const have = new Set(lines.map((l) => foldText(l.replace(/^\s*[-*]\s+(\(\d{2}\/\d{2}\/\d{4}\)\s*)?/, ""))));
  const fresh = items
    .map((i) => i.trim().replace(/^[-*]\s+/, ""))
    .filter((i) => i && !have.has(foldText(i)))
    .map((i) => `- ${date ? `(${date}) ` : ""}${i}`);
  if (!fresh.length) return guide;
  if (start < 0) return `${guide.trimEnd()}${guide.trim() ? "\n\n" : ""}## ${section.replace(/^#+\s*/, "").trim()}\n${fresh.join("\n")}\n`;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s+/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).filter((l) => !/^\s*[-*]\s*$/.test(l) && !/^\s*[-*]\s*\(.*\)\s*$/.test(l));
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const next = [...lines.slice(0, start + 1), ...body, ...fresh, ...(end < lines.length ? [""] : []), ...lines.slice(end)];
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}

import type { McpDeps } from "./_ai-mcp.js";
import { get, readBody, readHtml, robotsAllows } from "./_ai-scrape.js";
import { checkUrl } from "./_ai-mcp.js";

/**
 * MAVI · o estilo de um site (para criar uma identidade visual a partir
 * dele): as cores que o CSS mais usa (e as das variáveis de tema, como
 * --primary), as fontes, a cor do navegador (theme-color), o logo provável e
 * um trecho do texto (o tom). Com as mesmas proteções da leitura de páginas:
 * nada de rede interna, robots.txt respeitado, tamanho limitado.
 */

export type SiteColor = { hex: string; count: number; vars: string[] };
export type SiteStyle = {
  url: string;
  title: string;
  description: string;
  themeColor: string | null;
  colors: SiteColor[];
  fonts: { family: string; count: number }[];
  googleFonts: string[];
  logo: string | null;
  image: string | null;
  text: string;
  notes: string[];
};

const CSS_MAX = 400_000;
/** Folhas de bibliotecas (as cores delas não são da marca). */
const LIBRARY = /bootstrap|font-?awesome|fontawesome|jquery|slick|swiper|owl\.carousel|animate(\.min)?\.css|aos(\.min)?\.css|fancybox|magnific|lightbox|select2|datepicker|wp-includes|elementor\/assets\/lib|woocommerce|icons?\.css|normalize/i;
const ICON_FONT = /awesome|glyphicon|icon|dashicons|material symbols|material icons|eicons|fa-|remixicon|ionicons|feather/i;
const SHEETS_MAX = 4;
const GENERIC = /^(inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica neue|helvetica|arial|noto sans|liberation sans|apple color emoji|segoe ui emoji|segoe ui symbol|noto color emoji|var\(.*)$/i;

const hex6 = (h: string) => {
  const s = h.replace("#", "").toLowerCase();
  const full = s.length === 3 || s.length === 4 ? s.slice(0, 3).replace(/./g, "$&$&") : s.slice(0, 6);
  return /^[0-9a-f]{6}$/.test(full) ? `#${full.toUpperCase()}` : null;
};
const rgbHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
const dist = (a: string, b: string) => {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  return Math.hypot(((pa >> 16) & 255) - ((pb >> 16) & 255), ((pa >> 8) & 255) - ((pb >> 8) & 255), (pa & 255) - (pb & 255));
};

/** As cores e as fontes de um CSS (contadas), e as variáveis de tema. */
export function cssStyle(css: string) {
  const colors = new Map<string, SiteColor>();
  const bump = (hex: string | null, v?: string) => {
    if (!hex) return;
    const c = colors.get(hex) ?? { hex, count: 0, vars: [] };
    c.count++;
    if (v && !c.vars.includes(v) && c.vars.length < 4) c.vars.push(v);
    colors.set(hex, c);
  };
  // Variáveis de tema (--primary: #123456) pesam mais: dizem o papel da cor.
  for (const m of css.matchAll(/(--[\w-]{2,40})\s*:\s*(#[0-9a-f]{3,8}\b|rgba?\([^)]+\))/gi)) {
    const v = m[2].startsWith("#") ? hex6(m[2]) : rgbFrom(m[2]);
    for (let i = 0; i < 4; i++) bump(v, m[1]);
  }
  for (const m of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) bump(hex6(m[0]));
  for (const m of css.matchAll(/rgba?\([^)]+\)/gi)) bump(rgbFrom(m[0]));
  const fonts = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const first = m[1].split(",")[0].replace(/["'!]|important/gi, "").trim();
    if (first && !GENERIC.test(first) && !ICON_FONT.test(first) && first.length <= 60) fonts.set(first, (fonts.get(first) ?? 0) + 1);
  }
  for (const m of css.matchAll(/@font-face\s*{[^}]*font-family\s*:\s*["']?([^;"'}]+)/gi)) {
    const f = m[1].trim();
    if (f && !GENERIC.test(f) && !ICON_FONT.test(f)) fonts.set(f, (fonts.get(f) ?? 0) + 2);
  }
  return { colors, fonts };
}
function rgbFrom(s: string) {
  const n = s.match(/[\d.]+%?/g)?.map((x) => (x.endsWith("%") ? (parseFloat(x) * 255) / 100 : parseFloat(x))) ?? [];
  if (n.length < 3) return null;
  if (n.length >= 4 && n[3] < 0.5) return null; // quase transparente não é cor de marca
  return rgbHex(n[0], n[1], n[2]);
}

/** Junta as cores parecidas e tira os cinzas muito usados só em bordas. */
export function topColors(colors: Map<string, SiteColor>, max = 12) {
  const sorted = [...colors.values()].sort((a, b) => b.count - a.count);
  const out: SiteColor[] = [];
  for (const c of sorted) {
    const near = out.find((o) => dist(o.hex, c.hex) < 18);
    if (near) {
      near.count += c.count;
      for (const v of c.vars) if (!near.vars.includes(v) && near.vars.length < 4) near.vars.push(v);
    } else out.push({ ...c, vars: [...c.vars] });
    if (out.length >= max * 2) break;
  }
  return out.sort((a, b) => b.vars.length - a.vars.length || b.count - a.count).slice(0, max);
}

export async function siteStyle(raw: string, deps: McpDeps): Promise<SiteStyle> {
  const url = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  const u = await checkUrl(url, deps);
  const robots = await get(`${u.origin}/robots.txt`, deps, "text/plain").catch(() => null);
  const rules = robots && robots.res.ok ? new TextDecoder().decode(await readBody(robots.res).catch(() => new Uint8Array())) : "";
  if (!robotsAllows(rules.slice(0, 200_000), `${u.pathname}${u.search}`))
    throw new Error("O site não permite leitura automática desta página (robots.txt).");
  const { res, url: final } = await get(u.toString(), deps, "text/html,application/xhtml+xml");
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(res.status === 403 || res.status === 401 ? "O site bloqueia leitura automática." : `O site respondeu com erro (${res.status}).`);
  }
  const html = new TextDecoder().decode(await readBody(res));
  const page = readHtml(html, final);
  const notes: string[] = [];
  let css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).join("\n");
  css += "\n" + [...html.matchAll(/\sstyle\s*=\s*"([^"]{0,600})"/gi)].map((m) => `x{${m[1]}}`).join("\n");
  const sheets = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((t) => /rel\s*=\s*["']?[^"'>]*stylesheet/i.test(t))
    .map((t) => t.match(/href\s*=\s*["']([^"']+)["']/i)?.[1])
    .filter((h): h is string => !!h)
    .map((h) => new URL(h, final).toString());
  const googleFonts = [
    ...new Set(
      sheets
        .filter((h) => /fonts\.googleapis\.com/i.test(h))
        .flatMap((h) => [...new URL(h).searchParams.getAll("family")].map((f) => f.split(":")[0].replace(/\+/g, " "))),
    ),
  ];
  const own = sheets.filter((h) => !/fonts\.googleapis\.com/i.test(h) && !LIBRARY.test(h));
  for (const href of own.slice(0, SHEETS_MAX)) {
    if (css.length > CSS_MAX) break;
    try {
      const r = await get(href, deps, "text/css,*/*;q=0.1");
      if (r.res.ok) css += "\n" + new TextDecoder().decode(await readBody(r.res)).slice(0, CSS_MAX - css.length);
      else await r.res.body?.cancel().catch(() => {});
    } catch {
      notes.push(`Não deu para ler a folha de estilo ${new URL(href).pathname.slice(0, 60)}.`);
    }
  }
  const { colors, fonts } = cssStyle(css);
  const meta = (name: string) =>
    html.match(new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`, "i"))?.[1] ??
    null;
  const abs = (h: string | null | undefined) => {
    if (!h) return null;
    try {
      return new URL(h, final).toString();
    } catch {
      return null;
    }
  };
  const logoTag = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).find((t) => /logo|marca|brand/i.test(t));
  const logo = abs(logoTag?.match(/\ssrc\s*=\s*["']([^"']+)["']/i)?.[1]) ?? abs(html.match(/<link[^>]+rel\s*=\s*["'](?:apple-touch-icon|icon)["'][^>]*href\s*=\s*["']([^"']+)["']/i)?.[1]);
  if (!css.trim()) notes.push("O site quase não tem CSS na página (pode ser montado por JavaScript): as cores podem estar incompletas.");
  return {
    url: final,
    title: page.title,
    description: page.description,
    themeColor: hex6(meta("theme-color") ?? "") ?? null,
    colors: topColors(colors),
    fonts: [...fonts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([family, count]) => ({ family, count })),
    googleFonts,
    logo,
    image: abs(meta("og:image")),
    text: page.text.slice(0, 1800),
    notes,
  };
}

/** O estilo do site em texto, para a MAVI. */
export function siteStyleText(s: SiteStyle) {
  return [
    `Estilo de ${s.url}${s.title ? ` (“${s.title}”)` : ""}:`,
    s.description ? `Descrição: ${s.description}` : "",
    s.themeColor ? `Cor do navegador (theme-color): ${s.themeColor}.` : "",
    s.colors.length
      ? `Cores mais usadas no CSS (as com variável dizem o papel): ${s.colors.map((c) => `${c.hex} ×${c.count}${c.vars.length ? ` [${c.vars.join(", ")}]` : ""}`).join("; ")}.`
      : "Cores: nenhuma achada no CSS.",
    s.fonts.length ? `Fontes do CSS: ${s.fonts.map((f) => `${f.family} ×${f.count}`).join("; ")}.` : "Fontes: nenhuma achada.",
    s.googleFonts.length ? `Google Fonts carregadas: ${s.googleFonts.join(", ")}.` : "",
    s.logo ? `Logo provável: ${s.logo} (não está na Marca; para usar, a pessoa sobe o arquivo em Drive › cliente › Marca).` : "",
    s.text ? `Trecho do texto (para o tom de voz):\n${s.text}` : "",
    ...s.notes,
  ]
    .filter(Boolean)
    .join("\n");
}

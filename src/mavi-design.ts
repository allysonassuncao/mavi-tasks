import { fontHead, lookVars } from "./mavi-doc-html.js";
import type { Look } from "./visual-identity.js";

/**
 * MAVI · design livre: a MAVI escreve as páginas em HTML e CSS (como faz nas
 * artes) e o Chromium do servidor desenha, confere e imprime em PDF. Serve
 * para o que pede um layout próprio — proposta comercial caprichada,
 * one-pager, e-book, relatório visual, catálogo, apresentação especial.
 *
 * - Cada página é um <section class="page"> no tamanho do formato; com a
 *   classe "flow" (<section class="page flow">) a página cresce e o texto
 *   continua nas páginas seguintes (para textos longos).
 * - Com uma identidade, a página já traz as variáveis do tema (var(--bg),
 *   var(--primary), var(--font-head)…), as fontes e o logo (logo:light /
 *   logo:dark).
 * - Os arquivos ficam como referências (file:<id>, img:I1), trocadas na
 *   hora pela tela, pelo .html e pelo servidor.
 * - O mesmo HTML vai para a tela (iframe sem scripts), o .html e o PDF; a
 *   limpeza tira o que não é desenho (scripts, eventos, formulários, links
 *   de fora), para o arquivo baixado também ser seguro.
 */

export const DESIGN_FORMATS = {
  a4: { label: "A4 em pé", width: 794, height: 1123, page: "A4" },
  a4_landscape: { label: "A4 deitado", width: 1123, height: 794, page: "A4 landscape" },
  slides: { label: "Slides 16:9", width: 1280, height: 720, page: "1280px 720px" },
  square: { label: "Quadrado", width: 1080, height: 1080, page: "1080px 1080px" },
} as const;
export type DesignFormat = keyof typeof DESIGN_FORMATS;
export const DESIGN_FORMAT_KEYS = Object.keys(DESIGN_FORMATS) as DesignFormat[];
export const DESIGN_HTML_MAX = 250_000;
export const DESIGN_PAGES_MAX = 40;

/** O que pode sair de fora: só o Google Fonts. */
const FONTS_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//i;
const TOKEN = /^(file:[0-9a-f-]{36}|img:I\d{1,2}|data:image\/[a-z+]+;base64,)/i;

/**
 * Tira do HTML o que não é desenho: scripts, eventos (onclick…), iframes,
 * objetos, formulários, <base>, <meta refresh>, links javascript: e
 * endereços de fora (imagem só pelas referências; folha de estilo só do
 * Google Fonts).
 */
export function cleanDesignHtml(raw: string) {
  let s = String(raw ?? "").slice(0, DESIGN_HTML_MAX);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "iframe", "object", "embed", "form", "noscript", "template", "svg:script"])
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "").replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "");
  s = s.replace(/<(base|meta)\b[^>]*>/gi, "");
  s = s.replace(/<(input|button|select|textarea)\b[^>]*>/gi, "");
  // Eventos e atributos que rodam código.
  s = s.replace(/\s(on[a-z]+|formaction|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/(href|src|xlink:href|action)\s*=\s*(["'])\s*(javascript|vbscript):[^"']*\2/gi, '$1=$2#$2');
  // <link>: só a folha do Google Fonts.
  s = s.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    return /rel\s*=\s*["']?stylesheet/i.test(tag) && FONTS_HOST.test(href) ? `<link rel="stylesheet" href="${href}">` : "";
  });
  // Imagens: só as referências (ou data:); o resto some.
  s = s.replace(/(<(?:img|source|image)\b[^>]*?\s(?:src|href|xlink:href|srcset)\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, url) =>
    TOKEN.test(url.trim()) || url.trim().startsWith("#") ? m : `${pre}${q}${q}`,
  );
  // url(...) no CSS: referências, data: ou Google Fonts.
  s = s.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q, url) =>
    TOKEN.test(url.trim()) || FONTS_HOST.test(url.trim()) || url.trim().startsWith("#") ? m : "url()",
  );
  s = s.replace(/@import\s+(?:url\()?\s*["']?([^"');]+)["']?\)?\s*;?/gi, (m, url) => (FONTS_HOST.test(url.trim()) ? m : ""));
  // Links de navegação continuam (abrem fora), menos os que rodam código.
  return s.trim();
}

/** As referências que a página usa. */
export function designTokens(html: string) {
  return {
    files: [...new Set([...html.matchAll(/file:([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase()))],
    images: [...new Set([...html.matchAll(/img:(I\d{1,2})\b/gi)].map((m) => m[1].toUpperCase()))],
  };
}

/** Quantas páginas o HTML tem (as <section class="page">). */
export const countPages = (html: string) =>
  (html.match(/<section\b[^>]*class\s*=\s*["'][^"']*\bpage\b[^"']*["']/gi) ?? []).length;

/**
 * A página inteira: o tamanho de cada página, o tema (variáveis e fontes) e o
 * HTML da MAVI por cima (ela pode mudar tudo). O corpo vai como está; o
 * <head> que ela mandar fica depois da base.
 */
export function designPage(html: string, format: DesignFormat, look: Look | null | undefined, url?: (token: string) => string | null) {
  const f = DESIGN_FORMATS[format];
  const resolve = (s: string) =>
    url ? s.replace(/(file:[0-9a-f-]{36}|img:I\d{1,2})(?=["')\s])/gi, (t) => url(t) ?? "") : s;
  const base = `@page{size:${f.page};margin:0}
html,body{margin:0;padding:0}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:${look?.colors.bg ?? "#ffffff"};color:${look?.colors.ink ?? "#1c2728"};font-family:${look ? "var(--font-body)" : "Arial, sans-serif"}}
${look ? `:root{${lookVars(look)}}` : ""}
.page{position:relative;width:${f.width}px;height:${f.height}px;overflow:hidden;break-after:page;margin:0 auto;background:${look?.colors.bg ?? "#ffffff"}}
.page:last-of-type{break-after:auto}
.page.flow{height:auto;min-height:${f.height}px;overflow:visible;-webkit-box-decoration-break:clone;box-decoration-break:clone}
img{max-width:100%}
@media screen{html,body{background:#dfe4e1}body{padding:16px 0}.page{margin:0 auto 16px;box-shadow:0 6px 24px #0003}}`;
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=${f.width}">${look ? fontHead(look, { url: url ?? undefined }) : ""}<style>${base}</style>`;
  const clean = cleanDesignHtml(html);
  const styles = [...clean.matchAll(/<style\b[^>]*>[\s\S]*?<\/style\s*>|<link\b[^>]*>/gi)].map((m) => m[0]).join("\n");
  const body = clean.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] ?? clean.replace(/<\/?(html|head|body)\b[^>]*>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>|<link\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "");
  return resolve(`<!doctype html><html lang="pt-BR"><head>${head}${styles}</head><body>${body.trim()}</body></html>`);
}

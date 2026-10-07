import type { Canvas, Slide } from "./mavi-artifacts.js";
import { clean, markdownBlocks, runs } from "./mavi-export.js";
import {
  brandFontFaces,
  contrast,
  fontStack,
  googleFontsHref,
  logoFor,
  type Look,
} from "./visual-identity.js";

/**
 * MAVI · o documento e a apresentação em HTML, com a identidade visual. É o
 * mesmo desenho na tela (dentro de um shadow DOM), no arquivo .html e no PDF
 * (o Chromium do servidor imprime esta página), para o que a pessoa vê ser
 * o que ela baixa.
 *
 * Os arquivos entram como referências — file:<id> (logos e fontes da Marca)
 * e img:I1 (imagens da conversa) — trocadas por `url` quando dada (na tela,
 * pelos links assinados; no .html, por data:); sem ela, o servidor troca.
 */

export type HtmlOptions = {
  url?: (token: string) => string | null;
  /**
   * Marca cada campo que dá para editar (data-f="title", "bullets.0",
   * "stats.1.value"; nos documentos, data-b="3", "3.0", "3.r.1.2"): só no
   * editor do canvas.
   */
  marks?: boolean;
};
const mark = (o: HtmlOptions, attr: "f" | "b", path: string | number) => (o.marks ? ` data-${attr}="${path}"` : "");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Negrito, itálico e código; o resto do Markdown sai como texto. */
const inline = (t: string) =>
  runs(t)
    .map((r) => (r.bold ? `<strong>${esc(r.text)}</strong>` : r.italics ? `<em>${esc(r.text)}</em>` : esc(r.text)))
    .join("");
const src = (token: string, o: HtmlOptions) => esc(o.url ? (o.url(token) ?? "") : token);

/** As variáveis do tema e as cores que dependem do contraste. */
export function lookVars(look: Look) {
  const c = look.colors;
  // Títulos e detalhes na cor da marca só quando se leem no fundo.
  const heading = contrast(c.primary, c.bg) >= 3 ? c.primary : c.ink;
  const mark = contrast(c.accent, c.bg) >= 2 ? c.accent : c.primary;
  const coverBg =
    look.cover === "gradient"
      ? `linear-gradient(135deg, ${c.primary} 0%, ${c.accent} 100%)`
      : look.cover === "primary"
        ? c.primary
        : c.bg;
  const coverInk = look.cover === "primary" || look.cover === "gradient" ? c.on_primary : c.ink;
  return [
    `--bg:${c.bg}`,
    `--surface:${c.surface}`,
    `--ink:${c.ink}`,
    `--muted:${c.muted}`,
    `--primary:${c.primary}`,
    `--on-primary:${c.on_primary}`,
    `--accent:${c.accent}`,
    `--heading:${heading}`,
    `--mark:${mark}`,
    `--cover-bg:${coverBg}`,
    `--cover-ink:${coverInk}`,
    // O detalhe da capa na cor principal: o destaque, se aparecer sobre ela.
    `--cover-mark:${contrast(c.accent, c.primary) >= 2 ? c.accent : c.on_primary}`,
    `--radius:${look.radius}`,
    `--font-head:${fontStack(look.heading)}`,
    `--font-body:${fontStack(look.body)}`,
    `--w-head:${look.heading.weight}`,
    `--w-body:${look.body.weight}`,
  ].join(";");
}

/** O que carrega as fontes numa página inteira (.html e PDF). */
export function fontHead(look: Look, o: HtmlOptions = {}) {
  const href = googleFontsHref(look);
  const faces = brandFontFaces(look, (file) => src(`file:${file}`, o));
  return `${href ? `<link rel="stylesheet" href="${esc(href)}">` : ""}${faces ? `<style>${faces}</style>` : ""}`;
}

// ------------------------------------------------------------ documento
const DOC_CSS = `
.doc{background:var(--bg);color:var(--ink);font-family:var(--font-body);font-weight:var(--w-body);font-size:15px;line-height:1.65;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc *{box-sizing:border-box}
.doc-cover{position:relative;overflow:hidden;background:var(--cover-bg);color:var(--cover-ink);padding:56px 64px 48px;display:flex;flex-direction:column;gap:18px}
.doc-cover.cover-solid{padding-bottom:28px}
.doc-cover.cover-solid::after{content:"";display:block;width:72px;height:6px;border-radius:3px;background:var(--mark);margin-top:6px}
.doc-cover.cover-split{display:grid;grid-template-columns:14px 1fr;gap:28px;background:var(--bg);color:var(--ink)}
.doc-cover.cover-split::before{content:"";background:var(--primary);border-radius:calc(var(--radius) * 1px);grid-row:1 / span 3}
.doc-cover.cover-split > *{grid-column:2}
.doc-cover h1{margin:0;font-family:var(--font-head);font-weight:var(--w-head);font-size:38px;line-height:1.15;letter-spacing:-.01em}
.doc-cover .doc-logo{height:44px;width:auto;max-width:220px;object-fit:contain;object-position:left}
.doc-cover .doc-date{opacity:.75;font-size:13px}
.doc-cover.decor-corner::before{content:"";position:absolute;right:-60px;top:-60px;width:220px;height:220px;border-radius:50%;background:var(--accent);opacity:.18}
.doc-cover.cover-split.decor-corner::before{position:static;width:auto;height:auto;border-radius:calc(var(--radius) * 1px);opacity:1;background:var(--primary)}
.doc-body{padding:36px 64px 56px}
.doc h2,.doc h3,.doc h4,.doc h5{font-family:var(--font-head);font-weight:var(--w-head);line-height:1.25;margin:1.6em 0 .55em;break-after:avoid}
.doc h2{font-size:24px;color:var(--heading)}
.doc.decor-bar h2::before{content:"";display:block;width:36px;height:4px;border-radius:2px;background:var(--mark);margin-bottom:10px}
.doc h3{font-size:19px}
.doc h4,.doc h5{font-size:16px;color:var(--heading)}
.doc p{margin:0 0 .9em}
.doc ul,.doc ol{margin:0 0 1em;padding-left:1.4em}
.doc li{margin:.25em 0}
.doc li::marker{color:var(--mark);font-weight:700}
.doc strong{font-weight:700}
.doc blockquote{margin:1.2em 0;padding:14px 18px;border-left:4px solid var(--mark);background:var(--surface);border-radius:0 calc(var(--radius) * 1px) calc(var(--radius) * 1px) 0}
.doc pre{background:var(--surface);padding:14px 16px;border-radius:calc(var(--radius) * 1px);white-space:pre-wrap;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace}
.doc hr{border:0;height:1px;background:var(--muted);opacity:.35;margin:2em 0}
.doc table{width:100%;border-collapse:separate;border-spacing:0;margin:1.2em 0 1.4em;font-size:14px;border-radius:calc(var(--radius) * 1px);overflow:hidden;break-inside:auto}
.doc th{background:var(--primary);color:var(--on-primary);text-align:left;font-weight:700;padding:9px 12px}
.doc td{padding:8px 12px;border-bottom:1px solid color-mix(in srgb,var(--muted) 25%,transparent)}
.doc tr:nth-child(even) td{background:var(--surface)}
.doc tr{break-inside:avoid}
.doc-foot{padding:0 64px 36px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:16px}
.doc-foot img{height:22px;width:auto;opacity:.9}
.doc.decor-band .doc-foot{border-top:6px solid var(--primary);padding-top:16px}
`;

/** Os blocos do documento como aparecem (sem o primeiro título repetido). */
export function docBlocks(title: string, markdown: string) {
  const blocks = markdownBlocks(markdown);
  // O primeiro título do Markdown igual ao do documento não se repete.
  const first = blocks[0];
  if (first?.kind === "heading" && clean(first.text).trim() === clean(title).trim()) blocks.shift();
  return blocks;
}

export function documentHtml(title: string, markdown: string, look: Look, o: HtmlOptions = {}, date?: string) {
  return documentFromBlocks(title, docBlocks(title, markdown), look, o, date);
}

/** O documento a partir dos blocos (o editor desenha assim: um bloco vazio não some). */
export function documentFromBlocks(
  title: string,
  blocks: ReturnType<typeof markdownBlocks>,
  look: Look,
  o: HtmlOptions = {},
  date?: string,
) {
  const body: string[] = [];
  for (const [n, b] of blocks.entries()) {
    const at = mark(o, "b", n);
    if (b.kind === "heading") {
      // O título do documento é o h1: "#" e "##" viram as seções (h2).
      const level = Math.min(5, Math.max(2, b.level));
      body.push(`<h${level}${at}>${inline(b.text)}</h${level}>`);
    } else if (b.kind === "paragraph") body.push(`<p${at}>${inline(b.text)}</p>`);
    else if (b.kind === "quote") body.push(`<blockquote${at}>${inline(b.text)}</blockquote>`);
    else if (b.kind === "code") body.push(`<pre${at}>${esc(b.text)}</pre>`);
    else if (b.kind === "rule") body.push(`<hr${at}>`);
    else if (b.kind === "list") {
      const tag = b.ordered ? "ol" : "ul";
      body.push(`<${tag}>${b.items.map((i, k) => `<li${mark(o, "b", `${n}.${k}`)}>${inline(i)}</li>`).join("")}</${tag}>`);
    } else if (b.kind === "table")
      body.push(
        `<table${o.marks ? ` data-t="${n}"` : ""}><thead><tr>${b.head.map((h, k) => `<th${mark(o, "b", `${n}.h.${k}`)}>${inline(h)}</th>`).join("")}</tr></thead><tbody>${b.rows
          .map((r, j) => `<tr>${b.head.map((_, k) => `<td${mark(o, "b", `${n}.r.${j}.${k}`)}>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
  }
  const coverBg = look.cover === "primary" || look.cover === "gradient" ? look.colors.primary : look.colors.bg;
  const logo = logoFor(look, coverBg);
  const footLogo = logoFor(look, look.colors.bg);
  return `<article class="doc decor-${look.decor}" style="${esc(lookVars(look))}">
<header class="doc-cover cover-${look.cover} decor-${look.decor}">${logo ? `<img class="doc-logo" src="${src(`file:${logo}`, o)}" alt="">` : ""}<h1${mark(o, "f", "title")}>${inline(title)}</h1>${date ? `<span class="doc-date">${esc(date)}</span>` : ""}</header>
<div class="doc-body">${body.join("\n")}</div>
${footLogo && footLogo !== logo ? `<footer class="doc-foot"><span>${inline(title)}</span><img src="${src(`file:${footLogo}`, o)}" alt=""></footer>` : look.decor === "band" ? `<footer class="doc-foot"><span>${inline(title)}</span></footer>` : ""}
</article>`;
}

// ------------------------------------------------------------ apresentação
const SLIDE_CSS = `
.s-box{width:100%;container-type:inline-size}
.s{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;background:var(--bg);color:var(--ink);font-family:var(--font-body);font-weight:var(--w-body);font-size:2.5cqw;line-height:1.4;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.s *{box-sizing:border-box;margin:0}
.s-in{position:relative;z-index:1;height:100%;padding:5.5cqw 6cqw;display:flex;flex-direction:column;gap:2.2cqw}
.s h2,.s h3,.s h4{font-family:var(--font-head);font-weight:var(--w-head);line-height:1.15}
.s h2{font-size:5.2cqw;letter-spacing:-.05cqw}
.s h3{font-size:4.2cqw;color:var(--heading)}
.s h4{font-size:2.3cqw;color:var(--mark);margin-bottom:1cqw}
.s ul{padding-left:3cqw;display:flex;flex-direction:column;gap:1.6cqw}
.s.layout-bullets .s-in > ul{margin-top:auto;margin-bottom:auto;font-size:2.8cqw}
.s li::marker{color:var(--mark)}
.s .sub{color:var(--muted);font-size:2.5cqw}
.s.decor-bar .s-in > h3::before{content:"";display:block;width:6cqw;height:.6cqw;border-radius:.3cqw;background:var(--mark);margin-bottom:1.6cqw}
.s .corner{position:absolute;z-index:0;right:-9cqw;top:-9cqw;width:26cqw;height:26cqw;border-radius:50%;background:var(--accent);opacity:.16}
.s .band{position:absolute;z-index:0;left:0;right:0;bottom:0;height:1.2cqw;background:var(--primary)}
.s .logo{position:absolute;z-index:2;right:4cqw;bottom:3cqw;height:3.4cqw;width:auto;max-width:16cqw;object-fit:contain;object-position:right}
.s.decor-band .logo{bottom:3.6cqw}
.s .num{position:absolute;z-index:2;left:6cqw;bottom:3cqw;font-size:1.4cqw;color:var(--muted)}
.s.decor-band .num{bottom:3.6cqw}
/* capa e encerramento */
.s.cover{background:var(--cover-bg);color:var(--cover-ink)}
.s.cover .s-in{justify-content:center;align-items:flex-start;padding:7cqw 8cqw;gap:2.4cqw}
.s.cover h2{font-size:6cqw;max-width:80%}
.s.cover .sub{color:inherit;opacity:.78;font-size:2.5cqw;max-width:75%}
.s.cover.cover-solid h2::after,.s.cover.cover-primary h2::after,.s.cover.cover-split h2::after{content:"";display:block;width:9cqw;height:.8cqw;border-radius:.4cqw;background:var(--mark);margin-top:2.6cqw}
.s.cover.cover-primary h2::after{background:var(--cover-mark)}
.s.cover .cover-logo{height:6cqw;width:auto;max-width:28cqw;object-fit:contain;object-position:left;margin-bottom:2cqw}
.s.cover.cover-split{display:grid;grid-template-columns:40% 1fr;background:var(--bg);color:var(--ink)}
.s.cover.cover-split .split{background:var(--primary);display:flex;align-items:center;justify-content:center;padding:6cqw}
.s.cover.cover-split .split img{max-width:80%;max-height:40%;object-fit:contain}
.s.cover.cover-split .s-in{padding:6cqw}
.s.cover.cover-split h2{max-width:none}
/* seção */
.s.section .s-in{justify-content:center;padding-left:9cqw;gap:1.6cqw}
.s.section .s-in::before{content:"";position:absolute;left:6cqw;top:50%;transform:translateY(-50%);width:1cqw;height:14cqw;border-radius:.5cqw;background:var(--mark)}
.s.section.on-primary{background:var(--cover-bg);color:var(--cover-ink)}
.s.section.on-primary .s-in::before{background:var(--cover-ink);opacity:.8}
.s.section.on-primary .sub{color:inherit;opacity:.78}
.cols{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:3cqw;margin-bottom:3cqw}
.cols > div{background:var(--surface);border-radius:calc(var(--radius) * .078cqw);padding:3cqw 3.4cqw}
.stats{flex:1;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2.4cqw;align-items:center}
.stats > div{display:flex;flex-direction:column;align-items:center;gap:1.4cqw;padding:5cqw 2cqw;border-radius:calc(var(--radius) * .078cqw);background:var(--surface);text-align:center}
.stats strong{font-family:var(--font-head);font-size:7cqw;font-weight:var(--w-head);color:var(--mark);line-height:1}
.stats span{color:var(--muted)}
.quote{flex:1;display:flex;flex-direction:column;justify-content:center;gap:2cqw;text-align:center;padding:0 4cqw}
.quote blockquote{font-family:var(--font-head);font-size:3.6cqw;font-style:italic;line-height:1.35}
.quote blockquote::before{content:"“";display:block;font-size:9cqw;line-height:.6;color:var(--mark);font-style:normal}
.quote figcaption{color:var(--muted)}
.img{flex:1;min-height:0;display:grid;grid-template-columns:1fr;gap:3cqw}
.img.with-text{grid-template-columns:1.4fr 1fr}
.img img{width:100%;height:100%;min-height:0;object-fit:contain;border-radius:calc(var(--radius) * .078cqw)}
.img .empty{display:grid;place-items:center;border-radius:calc(var(--radius) * .078cqw);background:var(--surface);color:var(--muted)}
`;

function slideInner(s: Slide, o: HtmlOptions) {
  const f = (path: string) => mark(o, "f", path);
  const list = (key: "bullets" | "left" | "right", items?: string[]) =>
    items?.length ? `<ul>${items.map((b, i) => `<li${f(`${key}.${i}`)}>${inline(b)}</li>`).join("")}</ul>` : "";
  const sub = s.subtitle || o.marks ? `<p class="sub"${f("subtitle")}>${inline(s.subtitle ?? "")}</p>` : "";
  if (s.layout === "section") return `<h2${f("title")}>${inline(s.title)}</h2>${sub}`;
  if (s.layout === "quote")
    return `<figure class="quote"><blockquote${f("quote")}>${inline(s.quote ?? s.title)}</blockquote>${s.author || o.marks ? `<figcaption>— <span${f("author")}>${esc(s.author ?? "")}</span></figcaption>` : ""}</figure>`;
  const head = `<h3${f("title")}>${inline(s.title)}</h3>`;
  if (s.layout === "two_columns")
    return `${head}${sub}<div class="cols"><div>${s.left_title || o.marks ? `<h4${f("left_title")}>${esc(s.left_title ?? "")}</h4>` : ""}${list("left", s.left)}</div><div>${s.right_title || o.marks ? `<h4${f("right_title")}>${esc(s.right_title ?? "")}</h4>` : ""}${list("right", s.right)}</div></div>`;
  if (s.layout === "stats")
    return `${head}<div class="stats">${(s.stats ?? []).map((st, i) => `<div><strong${f(`stats.${i}.value`)}>${esc(st.value)}</strong><span${f(`stats.${i}.label`)}>${inline(st.label)}</span></div>`).join("")}</div>${sub}`;
  if (s.layout === "image") {
    const url = s.image ? src(`img:${s.image}`, o) : "";
    return `${head}<div class="img${s.bullets?.length ? " with-text" : ""}">${url ? `<img src="${url}" alt="">` : `<span class="empty">Imagem ${esc(s.image ?? "")}</span>`}${list("bullets", s.bullets)}</div>`;
  }
  return `${head}${sub}${list("bullets", s.bullets)}`;
}

/** Um slide (a moldura com o tamanho; as letras acompanham a largura). */
export function slideHtml(s: Slide, look: Look, index: number, o: HtmlOptions = {}) {
  const cover = s.layout === "title" || s.layout === "closing";
  const onPrimary = look.cover === "primary" || look.cover === "gradient";
  const bg = cover && onPrimary ? look.colors.primary : look.colors.bg;
  const logo = logoFor(look, cover && look.cover === "split" ? look.colors.primary : bg);
  const logoImg = (cls: string) => (logo ? `<img class="${cls}" src="${src(`file:${logo}`, o)}" alt="">` : "");
  const vars = lookVars(look);
  if (cover) {
    const inner = `${look.cover === "split" ? "" : logoImg("cover-logo")}<h2${mark(o, "f", "title")}>${inline(s.title)}</h2>${s.subtitle || o.marks ? `<p class="sub"${mark(o, "f", "subtitle")}>${inline(s.subtitle ?? "")}</p>` : ""}`;
    const decor = look.decor === "corner" && look.cover !== "split" ? `<span class="corner"></span>` : "";
    return `<div class="s-box"><div class="s cover cover-${look.cover} decor-${look.decor}" style="${esc(vars)}">${
      look.cover === "split" ? `<div class="split">${logoImg("")}</div>` : ""
    }${decor}<div class="s-in">${inner}</div></div></div>`;
  }
  const section = s.layout === "section";
  const cls = `s ${section ? `section${onPrimary ? " on-primary" : ""}` : `layout-${s.layout}`} decor-${look.decor}`;
  const decor =
    look.decor === "corner" ? `<span class="corner"></span>` : look.decor === "band" && !(section && onPrimary) ? `<span class="band"></span>` : "";
  const footer = section && onPrimary ? "" : `${logoImg("logo")}<span class="num">${index + 1}</span>`;
  return `<div class="s-box"><div class="${cls}" style="${esc(vars)}">${decor}<div class="s-in">${slideInner(s, o)}</div>${footer}</div></div>`;
}

export const CANVAS_CSS = { document: DOC_CSS, slides: SLIDE_CSS };

/**
 * A página inteira (o .html para baixar e o que o servidor imprime em PDF):
 * o documento em A4; a apresentação com um slide por página de 1280×720.
 */
export function canvasPage(
  c: Extract<Canvas, { kind: "document" | "slides" }>,
  look: Look,
  o: HtmlOptions = {},
  date?: string,
) {
  const slides = c.kind === "slides";
  const page = slides
    ? `@page{size:1280px 720px;margin:0}html,body{margin:0;background:${look.colors.bg}}.s-box{width:1280px;break-after:page}.s-box:last-child{break-after:auto}@media screen{body{background:#2b2b2b;padding:24px 0}.s-box{margin:0 auto 24px;box-shadow:0 10px 30px #0006}}`
    : `@page{size:A4;margin:0}html,body{margin:0;background:${look.colors.bg}}.doc{max-width:210mm;margin:0 auto;min-height:297mm}@media print{.doc-cover{padding:22mm 20mm 14mm}.doc-body{padding:14mm 20mm;-webkit-box-decoration-break:clone;box-decoration-break:clone}.doc-foot{padding:0 20mm 14mm}}@media screen{body{background:${look.mode === "dark" ? "#000" : "#e9e9e9"};padding:24px 0}.doc{box-shadow:0 10px 30px #0003}}`;
  const content = slides
    ? c.slides.map((s, i) => slideHtml(s, look, i, o)).join("\n")
    : documentHtml(c.title, c.markdown, look, o, date);
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(clean(c.title))}</title>${fontHead(look, o)}<style>${page}${slides ? SLIDE_CSS : DOC_CSS}</style></head>
<body>${content}</body></html>`;
}

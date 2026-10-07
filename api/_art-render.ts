import fs from "node:fs";
import type { Browser, Page } from "puppeteer-core";

/**
 * MAVI · arte por código: desenha uma página (HTML e CSS) num navegador e
 * devolve o PNG — o texto, as fontes e o logo saem exatos, como num editor,
 * em vez de a IA de imagem desenhar as letras.
 *
 * - A página não roda scripts nem abre a internet: só as imagens e fontes
 *   que chegam aqui (a marca do cliente e as imagens da conversa, trocadas
 *   por data: antes de abrir) e o Google Fonts.
 * - Depois de desenhar, confere o que dá para medir (texto fora da arte ou
 *   cortado, textos um sobre o outro, fonte que não carregou) e devolve
 *   junto, para a MAVI corrigir antes de mostrar.
 *
 * Na Vercel roda na função /api/render-art (o Chromium é grande demais para
 * a função de todo o resto); no computador, aqui mesmo, com o Chrome local.
 */

export type ArtAsset = {
  /** O que a página usa no lugar do arquivo (ex.: "marca:logo.svg", "img:I2"). */
  token: string;
  /** Link assinado do GCS. */
  url: string;
};
export type RenderInput = {
  html: string;
  width: number;
  height: number;
  assets: ArtAsset[];
};
export type RenderResult = {
  png: Buffer;
  /** A mesma arte em JPEG (leve), para a MAVI conferir. */
  preview: Buffer;
  /** O que a conferência automática achou (vazio: nada). */
  report: string[];
};

export const ART_MIN = 200;
export const ART_MAX = 2400;
const HTML_MAX = 200_000;
const ASSET_MAX = 15 * 1024 * 1024;
const ASSETS_TOTAL = 40 * 1024 * 1024;
/** O que a página pode abrir além do que chega como data:. */
const ALLOWED = /^(data:|blob:|about:|https:\/\/fonts\.googleapis\.com\/|https:\/\/fonts\.gstatic\.com\/)/;
const GCS = /^https:\/\/storage\.googleapis\.com\//;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};
/** O tipo pelo final do nome (o GCS nem sempre diz). */
export function assetMime(name: string, given?: string | null) {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return MIME[ext] ?? (given && given !== "application/octet-stream" ? given : "application/octet-stream");
}

export function checkRenderInput(input: RenderInput) {
  const { html, width, height } = input;
  if (typeof html !== "string" || html.trim().length < 20) return "Mande o HTML da arte.";
  if (html.length > HTML_MAX) return "O HTML passou de 200 mil caracteres: simplifique.";
  for (const [n, v] of [
    ["largura", width],
    ["altura", height],
  ] as const)
    if (!Number.isInteger(v) || v < ART_MIN || v > ART_MAX)
      return `A ${n} vai de ${ART_MIN} a ${ART_MAX} pixels.`;
  if (!Array.isArray(input.assets) || input.assets.length > 24) return "No máximo 24 arquivos por arte.";
  if (input.assets.some((a) => !a || typeof a.token !== "string" || !GCS.test(String(a.url))))
    return "Arquivo inválido.";
  return null;
}

/** Baixa os arquivos e troca cada referência da página pelo conteúdo (data:). */
async function inline(input: RenderInput, fetchImpl: typeof fetch) {
  let html = input.html;
  let total = 0;
  // As referências mais longas primeiro (marca:logo.svg antes de marca:logo).
  const assets = [...input.assets].sort((a, b) => b.token.length - a.token.length);
  for (const a of assets) {
    if (!html.includes(a.token)) continue;
    const res = await fetchImpl(a.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Não foi possível abrir ${a.token} (${res.status}).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > ASSET_MAX) throw new Error(`${a.token} passa de 15 MB.`);
    total += bytes.length;
    if (total > ASSETS_TOTAL) throw new Error("Os arquivos da arte passam de 40 MB juntos.");
    const name = a.token.replace(/^[a-z]+:/, "");
    const uri = `data:${assetMime(name, res.headers.get("content-type"))};base64,${bytes.toString("base64")}`;
    html = html.split(a.token).join(uri);
  }
  return html;
}

/** A página completa: tamanho fixo, sem scripts e sem internet (além do Google Fonts). */
export function artDocument(body: string, width: number, height: number) {
  const csp =
    "default-src 'none'; img-src data: blob:; media-src data:; font-src data: https://fonts.gstatic.com; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'none'";
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}*{box-sizing:border-box}</style>`;
  const clean = body
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<meta[^>]+http-equiv[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(clean)) return clean.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  if (/<html[^>]*>/i.test(clean)) return clean.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${clean}</body></html>`;
}

// ------------------------------------------------------------ navegador
let browser: Promise<Browser> | null = null;

async function localChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found)
    throw new Error("Sem navegador para desenhar a arte: instale o Chrome ou defina CHROME_PATH.");
  return found;
}

async function openBrowser(): Promise<Browser> {
  const puppeteer = (await import("puppeteer-core")).default;
  if (process.env.VERCEL || process.env.AWS_EXECUTION_ENV) {
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({
      executablePath: await chromium.executablePath(),
      args: chromium.args,
      headless: true,
    });
  }
  return puppeteer.launch({
    executablePath: await localChrome(),
    args: ["--no-sandbox", "--font-render-hinting=none", "--hide-scrollbars"],
    headless: true,
  });
}

async function newPage(): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    browser ??= openBrowser();
    try {
      const b = await browser;
      if (!b.connected) throw new Error("fechado");
      return await b.newPage();
    } catch (e) {
      browser = null;
      if (attempt) throw e;
    }
  }
}

/**
 * Conferência na página já desenhada. Vai como texto (JavaScript puro) para
 * o navegador: o compilador do servidor não mexe nela.
 */
const INSPECT = `(function (width, height) {
  var notes = [];
  function short(s) {
    var t = s.replace(/\\s+/g, " ").trim();
    return t.length > 40 ? t.slice(0, 40) + "…" : t;
  }
  // Cada texto com a caixa do próprio texto (não a do bloco inteiro).
  var texts = [];
  document.body.querySelectorAll("*").forEach(function (el) {
    var nodes = [];
    el.childNodes.forEach(function (n) { if (n.nodeType === 3 && (n.textContent || "").trim()) nodes.push(n); });
    if (!nodes.length) return;
    var st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return;
    var range = document.createRange();
    range.setStartBefore(nodes[0]);
    range.setEndAfter(nodes[nodes.length - 1]);
    var box = range.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // A caixa da fonte sobra acima e abaixo das letras (~20% da linha em cada
    // ponta): conta só a área das letras, senão títulos gigantes "encostam".
    var trim = 0.2 * Math.min(box.height, parseFloat(st.fontSize) * 1.25);
    var r = { left: box.left, right: box.right, top: box.top + trim, bottom: box.bottom - trim,
      width: box.width, height: Math.max(1, box.height - 2 * trim) };
    var turned = false;
    for (var p = el; p && p !== document.body; p = p.parentElement)
      if (getComputedStyle(p).transform !== "none") { turned = p; break; }
    texts.push({ el: el, text: nodes.map(function (n) { return n.textContent; }).join(" ").trim(), r: r, turned: turned });
  });
  texts.forEach(function (t) {
    var r = t.r;
    if (r.left < -2 || r.top < -2 || r.right > width + 2 || r.bottom > height + 2)
      notes.push("Texto saindo da arte: “" + short(t.text) + "” (se for proposital, como uma faixa repetida, ignore).");
    var el = t.el;
    if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
      var st = getComputedStyle(el);
      if (/hidden|clip/.test(st.overflow + st.overflowX + st.overflowY) || st.textOverflow === "ellipsis")
        notes.push("Texto passando da caixa (cortado): “" + short(t.text) + "” (se for proposital, como uma faixa repetida, ignore).");
    }
  });
  document.querySelectorAll("img").forEach(function (img) {
    if (!img.complete || !img.naturalWidth)
      notes.push("Imagem que não carregou: " + (img.getAttribute("src") || "").slice(0, 60) + " (use marca:… ou img:…).");
  });
  var leaves = texts.slice(0, 80);
  for (var i = 0; i < leaves.length; i++)
    for (var j = i + 1; j < leaves.length; j++) {
      var a = leaves[i], b = leaves[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // Girados juntos (um cartão inclinado): as caixas medidas ficam maiores que o texto.
      if (a.turned && a.turned === b.turned) continue;
      var w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      var h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 0 || h <= 0) continue;
      var small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if ((w * h) / small > 0.25)
        notes.push("Textos um sobre o outro: “" + short(a.text) + "” e “" + short(b.text) + "”.");
    }
  var declared = {};
  document.fonts.forEach(function (f) {
    var family = f.family.replace(/["']/g, "").trim();
    declared[family.toLowerCase()] = true;
    if (f.status === "error") notes.push("A fonte “" + family + "” não carregou.");
  });
  var generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|emoji|math|inherit|initial)$/;
  var missing = {};
  texts.forEach(function (t) {
    var first = (getComputedStyle(t.el).fontFamily.split(",")[0] || "").replace(/["']/g, "").trim();
    if (first && !generic.test(first.toLowerCase()) && !declared[first.toLowerCase()]) missing[first] = true;
  });
  Object.keys(missing).forEach(function (f) {
    notes.push("A fonte “" + f + "” não está na arte (sem @font-face da marca nem Google Fonts): o texto saiu na fonte padrão.");
  });
  return notes.filter(function (n, k) { return notes.indexOf(n) === k; }).slice(0, 20);
})`;

export async function renderArt(
  input: RenderInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RenderResult> {
  const problem = checkRenderInput(input);
  if (problem) throw new Error(problem);
  const { width, height } = input;
  const html = artDocument(await inline(input, fetchImpl), width, height);
  const page = await newPage();
  const blocked = new Set<string>();
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (ALLOWED.test(url)) void req.continue();
      else {
        blocked.add(url.slice(0, 80));
        void req.abort();
      }
    });
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 25_000 });
    await page.evaluate(
      "document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))",
    );
    const report = (await page.evaluate(`${INSPECT}(${width}, ${height})`)) as string[];
    for (const url of blocked)
      report.push(`Bloqueado (a arte não abre a internet): ${url}. Use as referências marca:… e img:….`);
    const clip = { x: 0, y: 0, width, height };
    const png = Buffer.from(await page.screenshot({ type: "png", clip }));
    const preview = Buffer.from(await page.screenshot({ type: "jpeg", quality: 82, clip }));
    return { png, preview, report };
  } finally {
    await page.close().catch(() => {});
  }
}

// ------------------------------------------------------------ PDF
/**
 * Documentos e apresentações da MAVI em PDF (a página de canvasPage, com o
 * tamanho de página dela): as mesmas regras da arte — sem scripts, sem
 * internet além do Google Fonts, os arquivos trocados por data: antes.
 */
export type PdfInput = { html: string; assets: ArtAsset[] };
export const PDF_HTML_MAX = 1_500_000;

export function checkPdfInput(input: PdfInput) {
  if (typeof input?.html !== "string" || input.html.trim().length < 20) return "Mande a página do documento.";
  if (input.html.length > PDF_HTML_MAX) return "O documento passou de 1,5 milhão de caracteres.";
  if (!Array.isArray(input.assets) || input.assets.length > 40) return "No máximo 40 arquivos por documento.";
  if (input.assets.some((a) => !a || typeof a.token !== "string" || !GCS.test(String(a.url))))
    return "Arquivo inválido.";
  return null;
}

/** A página com a mesma política da arte (sem scripts nem internet). */
export function pdfDocument(body: string) {
  const csp =
    "default-src 'none'; img-src data: blob:; font-src data: https://fonts.gstatic.com; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'none'";
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const clean = body
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<meta[^>]+http-equiv[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(clean)) return clean.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${clean}</body></html>`;
}

export async function renderPdf(input: PdfInput, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const problem = checkPdfInput(input);
  if (problem) throw new Error(problem);
  const html = pdfDocument(await inline({ html: input.html, width: ART_MIN, height: ART_MIN, assets: input.assets }, fetchImpl));
  const page = await newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => void (ALLOWED.test(req.url()) ? req.continue() : req.abort()));
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 40_000 });
    await page.evaluate("document.fonts.ready");
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true, timeout: 60_000 });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

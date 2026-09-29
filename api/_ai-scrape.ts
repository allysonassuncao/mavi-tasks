import { checkUrl, type McpDeps } from "./_ai-mcp.js";
import { extractFileText } from "./_ai-extract.js";

/**
 * MAVI · Leitura de páginas (poder 'scrape', migração 20261220090000):
 * a MAVI abre páginas públicas e lê o que importa — título, descrição,
 * texto principal (com títulos e listas), tabelas, dados estruturados
 * (JSON-LD: produtos, preços, eventos) e, se pedido, os links. Funciona com
 * qualquer modelo (é uma ferramenta nossa, não a busca da Claude).
 *
 * - Só https e endereços públicos (a mesma regra das conexões MCP), inclusive
 *   em cada redirecionamento; respeita o robots.txt do site.
 * - Até 5 páginas por chamada, 5 MB e 20 s cada; o texto é cortado com aviso.
 * - Sem navegador: páginas montadas só por JavaScript podem vir incompletas
 *   (a MAVI avisa).
 * A ferramenta (SCRAPE_TOOL) fica em _ai-powers.ts, com as outras.
 */

export type ScrapedPage = {
  url: string;
  title: string;
  description: string;
  text: string;
  tables: string[];
  data: string[];
  links: { text: string; url: string }[];
  note?: string;
};

const UA = "Mozilla/5.0 (compatible; MAVI-Bot/1.0; leitura de páginas a pedido de uma pessoa)";
const MAX_BYTES = 5_000_000;
const PAGE_TEXT = 12_000;

// ------------------------------------------------------------ HTML
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  atilde: "ã",
  otilde: "õ",
  acirc: "â",
  ecirc: "ê",
  ocirc: "ô",
  agrave: "à",
  ccedil: "ç",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Atilde: "Ã",
  Otilde: "Õ",
  Ccedil: "Ç",
};
export function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}
const squash = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) =>
  decode(tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(2).find((x) => x !== undefined) ?? "");

function meta(html: string, keys: string[]) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const k = (attr(tag, "name") || attr(tag, "property")).toLowerCase();
    if (keys.includes(k)) {
      const v = attr(tag, "content").trim();
      if (v) return v;
    }
  }
  return "";
}

/** Uma tabela HTML em Markdown (até 40 linhas). */
function tableMarkdown(table: string) {
  const rows = (table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [])
    .map((tr) => (tr.match(/<t[hd]\b[\s\S]*?<\/t[hd]>/gi) ?? []).map((c) => squash(c).replace(/\|/g, "/")))
    .filter((r) => r.some(Boolean))
    .slice(0, 40);
  if (rows.length < 2) return "";
  const width = Math.min(Math.max(...rows.map((r) => r.length)), 10);
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => (r[i] ?? "").slice(0, 120)).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

/** O conteúdo de uma página HTML, sem menu, rodapé, scripts e estilos. */
export function readHtml(html: string, base: string): Omit<ScrapedPage, "url"> {
  const data = (html.match(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) ?? [])
    .map((s) => s.replace(/^<script[^>]*>|<\/script>$/gi, "").trim())
    .map((s) => {
      try {
        return JSON.stringify(JSON.parse(s)).slice(0, 3000);
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .slice(0, 3);
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|object)\b[\s\S]*?<\/\1>/gi, " ");
  const title = squash(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || meta(html, ["og:title"]);
  const description = meta(html, ["description", "og:description", "twitter:description"]);
  // O conteúdo principal quando a página marca; senão o corpo sem menus.
  const main =
    body.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ??
    (body.match(/<article\b[\s\S]*?<\/article>/gi) ?? []).sort((a, b) => b.length - a.length)[0];
  body = main ?? (body.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? body);
  if (!main) body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const tables = (body.match(/<table\b[\s\S]*?<\/table>/gi) ?? []).map(tableMarkdown).filter(Boolean).slice(0, 5);
  const links: ScrapedPage["links"] = [];
  const seen = new Set<string>();
  for (const a of body.match(/<a\b[^>]*href[\s\S]*?<\/a>/gi) ?? []) {
    const href = attr(a.match(/<a\b[^>]*>/i)?.[0] ?? "", "href");
    let url = "";
    try {
      url = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    const text = squash(a).slice(0, 120);
    if (text) links.push({ text, url });
    if (links.length >= 60) break;
  }
  const text = decode(
    body
      .replace(/<table\b[\s\S]*?<\/table>/gi, "\n[tabela]\n")
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Math.min(Number(n), 3))} ${squash(t)}\n`)
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|li|ul|ol|blockquote|pre|tr|dd|dt|figure|figcaption)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const note =
    text.length < 400 && scripts > 5
      ? "A página parece montada por JavaScript: o conteúdo pode ter vindo incompleto."
      : undefined;
  return { title: title.slice(0, 300), description: description.slice(0, 500), text, tables, data, links, ...(note ? { note } : {}) };
}

/** Com páginas longas, os trechos sobre o foco vêm primeiro (na ordem da página). */
export function focusText(text: string, focus: string, max = PAGE_TEXT) {
  if (text.length <= max) return text;
  const words = focus
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (!words.length) return `${text.slice(0, max)}\n… (página cortada)`;
  const blocks = text.split(/\n{2,}/);
  const score = (b: string) => {
    const t = b.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  };
  const keep = new Set<number>();
  let size = 0;
  for (const i of blocks.map((b, i) => [score(b), i] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (size + blocks[i].length > max) continue;
    keep.add(i);
    size += blocks[i].length;
  }
  for (let i = 0; i < blocks.length && size < max; i++)
    if (!keep.has(i) && size + blocks[i].length <= max) {
      keep.add(i);
      size += blocks[i].length;
    }
  return `${blocks.filter((_, i) => keep.has(i)).join("\n\n")}\n… (página longa: vieram os trechos sobre “${focus.slice(0, 60)}” e o começo)`;
}

// ------------------------------------------------------------ robots.txt
/** Pode ler o caminho? Grupos de "*" e de "mavi"; a regra mais longa vale. */
export function robotsAllows(robots: string, path: string) {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === "allow", path: value });
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.includes("mavi")));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const pattern = new RegExp(
      `^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`,
    );
    if (pattern.test(path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)))
      best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

// ------------------------------------------------------------ busca
async function readBody(res: Response) {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("A página é grande demais (mais de 5 MB).");
    }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** Busca com os redirecionamentos conferidos um a um (nada de rede interna). */
async function get(url: string, deps: McpDeps, accept: string) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await checkUrl(current, deps);
    const res = await deps.fetch(current, {
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.6" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {});
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    return { res, url: current };
  }
  throw new Error("A página redirecionou vezes demais.");
}

/** Lê uma página (HTML, PDF, texto ou JSON). */
export async function scrapePage(
  url: string,
  deps: McpDeps,
  robots: Map<string, string>,
  opts: { focus?: string } = {},
): Promise<ScrapedPage> {
  const u = await checkUrl(url, deps);
  if (!robots.has(u.origin)) {
    const r = await get(`${u.origin}/robots.txt`, deps, "text/plain").catch(() => null);
    const text = r && r.res.ok ? new TextDecoder().decode(await readBody(r.res).catch(() => new Uint8Array())) : "";
    robots.set(u.origin, text.slice(0, 200_000));
  }
  if (!robotsAllows(robots.get(u.origin) ?? "", `${u.pathname}${u.search}`))
    throw new Error("O site não permite leitura automática desta página (robots.txt).");
  const { res, url: final } = await get(
    u.toString(),
    deps,
    "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.5",
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      res.status === 404
        ? "A página não existe (404)."
        : res.status === 401 || res.status === 403
          ? "A página pede login ou bloqueia leitura automática."
          : `O site respondeu com erro (${res.status}).`,
    );
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const bytes = await readBody(res);
  const empty = { title: "", description: "", tables: [], data: [], links: [] };
  if (type === "application/pdf" || /\.pdf$/i.test(new URL(final).pathname)) {
    const x = await extractFileText("pdf", bytes, "pagina.pdf");
    const text = x.pages.map((p) => p.text).join("\n\n").trim();
    return { ...empty, url: final, title: new URL(final).pathname.split("/").pop() ?? "PDF", text: focusText(text, opts.focus ?? "") };
  }
  const raw = new TextDecoder().decode(bytes);
  if (type.includes("html") || /^\s*<(!doctype html|html)/i.test(raw)) {
    const page = readHtml(raw, final);
    return { ...page, url: final, text: focusText(page.text, opts.focus ?? "") };
  }
  if (type.startsWith("text/") || type.includes("json") || type.includes("xml"))
    return { ...empty, url: final, text: focusText(raw.trim(), opts.focus ?? "") };
  throw new Error(`Não dá para ler este tipo de arquivo (${type || "desconhecido"}).`);
}

/** A página em texto para a MAVI, com a referência da fonte. */
export function pageForMavi(p: ScrapedPage, ref: string, withLinks: boolean) {
  return [
    `[${ref}] ${p.title || p.url}`,
    `Endereço: ${p.url}`,
    p.description ? `Descrição: ${p.description}` : "",
    p.note ? `Atenção: ${p.note}` : "",
    p.text ? `Conteúdo:\n${p.text}` : "Conteúdo: (vazio)",
    p.tables.length ? `Tabelas:\n${p.tables.join("\n\n")}` : "",
    p.data.length ? `Dados estruturados (JSON-LD):\n${p.data.join("\n")}` : "",
    withLinks && p.links.length ? `Links:\n${p.links.map((l) => `- ${l.text}: ${l.url}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

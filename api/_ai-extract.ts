import { strFromU8, unzipSync } from "fflate";

/**
 * IA do MAVI · texto dos arquivos do Drive, por página (PDF), slide
 * (PowerPoint) ou planilha (Excel); Word, CSV e texto viram uma parte só.
 * O banco quebra cada parte em trechos e guarda o rótulo para a citação.
 *
 * Sem bibliotecas pesadas: PDF pelo unpdf (pdf.js para serverless); os
 * formatos do Office são ZIPs de XML, lidos com o fflate.
 */

export type FilePage = { label: string | null; text: string };
export type Extracted = {
  status: "done" | "empty" | "unsupported" | "error";
  pages: FilePage[];
  error?: string;
};

const MAX_TOTAL = 400_000;
const MAX_PAGE = 80_000;
const MAX_ROWS = 3_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
export function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const tidy = (text: string) =>
  text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Limita o total (e cada parte), descartando partes vazias. */
function finish(pages: FilePage[]): Extracted {
  const out: FilePage[] = [];
  let total = 0;
  for (const p of pages) {
    const text = tidy(p.text).slice(0, MAX_PAGE);
    if (!text) continue;
    if (total + text.length > MAX_TOTAL) {
      out.push({ label: p.label, text: text.slice(0, MAX_TOTAL - total) });
      break;
    }
    out.push({ label: p.label, text });
    total += text.length;
  }
  const chars = out.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
  return chars >= 20
    ? { status: "done", pages: out }
    : { status: "empty", pages: [] };
}

async function pdf(bytes: Uint8Array) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(bytes);
  const { text } = await extractText(doc, { mergePages: false });
  return finish(
    (Array.isArray(text) ? text : [text]).map((t, i) => ({
      label: `Página ${i + 1}`,
      text: t,
    })),
  );
}

/** Arquivos de dentro do ZIP (só os que interessam). */
function unzip(bytes: Uint8Array, keep: (name: string) => boolean) {
  const files = unzipSync(bytes, { filter: (f) => keep(f.name) });
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, strFromU8(data)]),
  );
}

export function docxText(xml: string) {
  return decodeXml(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:(?:br|cr)\/>/g, "\n")
      .replace(/<\/w:tc>/g, " | ")
      .replace(/<\/w:(?:p|tr)>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/ \| \n/g, "\n");
}

function docx(bytes: Uint8Array) {
  const files = unzip(bytes, (n) => n === "word/document.xml");
  const xml = files["word/document.xml"];
  if (!xml)
    return {
      status: "error" as const,
      pages: [],
      error: "Word sem document.xml",
    };
  return finish([{ label: null, text: docxText(xml) }]);
}

function pptx(bytes: Uint8Array) {
  const files = unzip(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slides = Object.keys(files)
    .map((n) => ({ n: Number(n.match(/slide(\d+)\.xml$/)![1]), xml: files[n] }))
    .sort((a, b) => a.n - b.n);
  return finish(
    slides.map((s) => ({
      label: `Slide ${s.n}`,
      text: decodeXml(
        s.xml
          .replace(/<\/a:p>/g, "\n")
          .replace(/<a:br\/>/g, "\n")
          .replace(/<(?!\/?a:t\b)[^>]+>/g, "")
          .replace(/<\/?a:t[^>]*>/g, ""),
      ),
    })),
  );
}

/** Coluna de uma referência de célula ("C12" → 2). */
const column = (ref: string) =>
  [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce(
    (n, ch) => n * 26 + ch.charCodeAt(0) - 64,
    0,
  ) - 1;

export function sheetRows(xml: string, shared: string[]) {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="(\w+)"/)?.[1];
      let value = "";
      if (type === "inlineStr")
        value = decodeXml(
          (body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
            .map((t) => t.replace(/<[^>]+>/g, ""))
            .join(""),
        );
      else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
        value =
          type === "s"
            ? (shared[Number(v)] ?? "")
            : type === "b"
              ? v === "1"
                ? "sim"
                : "não"
              : decodeXml(v);
      }
      const at = ref ? column(ref) : cells.length;
      while (cells.length < at) cells.push("");
      cells[at] = value.trim();
    }
    const line = cells
      .join(" | ")
      .replace(/(\s\|\s)+$/, "")
      .trim();
    if (line.replace(/[|\s]/g, "")) rows.push(line);
    if (rows.length >= MAX_ROWS) break;
  }
  return rows.join("\n");
}

function xlsx(bytes: Uint8Array) {
  const files = unzip(
    bytes,
    (n) =>
      n === "xl/sharedStrings.xml" ||
      n === "xl/workbook.xml" ||
      n === "xl/_rels/workbook.xml.rels" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  const shared = [
    ...(files["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) =>
    decodeXml(
      (m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
        .map((t) => t.replace(/<[^>]+>/g, ""))
        .join(""),
    ),
  );
  const rels = new Map(
    [
      ...(files["xl/_rels/workbook.xml.rels"] ?? "").matchAll(
        /<Relationship\b[^>]*>/g,
      ),
    ].map((m) => [
      m[0].match(/\bId="([^"]+)"/)?.[1],
      m[0]
        .match(/\bTarget="([^"]+)"/)?.[1]
        ?.replace(/^\/?xl\//, "")
        .replace(/^\//, ""),
    ]),
  );
  const sheets = [
    ...(files["xl/workbook.xml"] ?? "").matchAll(/<sheet\b[^>]*>/g),
  ].map((m) => ({
    name: decodeXml(m[0].match(/\bname="([^"]+)"/)?.[1] ?? "Planilha"),
    target: rels.get(m[0].match(/\br:id="([^"]+)"/)?.[1]),
  }));
  const list = sheets.length
    ? sheets
    : Object.keys(files)
        .filter((n) => n.startsWith("xl/worksheets/"))
        .map((n, i) => ({
          name: `Planilha ${i + 1}`,
          target: n.replace(/^xl\//, ""),
        }));
  return finish(
    list.map((s) => ({
      label: `Planilha ${s.name}`,
      text: sheetRows(files[`xl/${s.target}`] ?? "", shared),
    })),
  );
}

function plain(bytes: Uint8Array, name: string) {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/\.(html?|xml)$/i.test(name))
    text = decodeXml(
      text
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ).replace(/[ \t]+/g, " ");
  return finish([{ label: null, text }]);
}

/** O texto de um arquivo, pelo tipo que o banco identificou (ai_file_kind). */
export async function extractFileText(
  kind: string | null,
  bytes: Uint8Array,
  name: string,
): Promise<Extracted> {
  try {
    if (kind === "pdf") return await pdf(bytes);
    if (kind === "docx") return docx(bytes);
    if (kind === "pptx") return pptx(bytes);
    if (kind === "xlsx") return xlsx(bytes);
    if (kind === "text") return plain(bytes, name);
    return { status: "unsupported", pages: [] };
  } catch (e) {
    return {
      status: "error",
      pages: [],
      error: (e as Error).message?.slice(0, 300) || "falha ao ler",
    };
  }
}

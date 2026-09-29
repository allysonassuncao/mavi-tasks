import type {
  Canvas,
  SheetTab,
  Slide,
  SlideTheme,
  TableColumn,
} from "./mavi-artifacts";

/**
 * MAVI · o canvas em arquivo: documento em Word (.docx) e Markdown,
 * apresentação em PowerPoint (.pptx), planilha em Excel (.xlsx) e CSV, e
 * qualquer um impresso em PDF. As bibliotecas (docx, pptxgenjs, fflate)
 * só carregam quando a pessoa baixa.
 */

export function fileName(title: string, ext: string) {
  return `${
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "mavi"
  }.${ext}`;
}
export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** O texto sem as marcas da conversa (fontes [S1], anexos [[D1]]). */
export const clean = (t: string) =>
  t
    .replace(/\s?\[S\d{1,3}\]/g, "")
    .replace(/\s?\[\[[VIADQ]\d{1,2}\]\]/g, "")
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, "$1");
/** Negrito e itálico viram pedaços; o resto do Markdown sai como texto. */
export function runs(t: string) {
  const out: { text: string; bold?: boolean; italics?: boolean }[] = [];
  const re = /\*\*([^*]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?![*\w])|`([^`]+)`|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  const s = clean(t);
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], italics: true });
    else if (m[3] !== undefined) out.push({ text: m[3] });
    else out.push({ text: `${m[4]} (${m[5]})` });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}
const plain = (t: string) => runs(t).map((r) => r.text).join("");

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "rule" };
const cells = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** O Markdown do documento em blocos (a mesma leitura da tela). */
export function markdownBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push({ kind: "table", head, rows });
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      out.push({ kind: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: "rule" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const li = /^\s*([-•*]|\d+[.)])\s+(.*)$/;
    if (li.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && li.test(lines[i])) items.push(lines[i++].match(li)![2]);
      out.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.trim()) out.push({ kind: "paragraph", text: line.trim() });
    i++;
  }
  return out;
}

// ------------------------------------------------------------ Word
export async function documentDocx(title: string, md: string) {
  const d = await import("docx");
  const children: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [
    new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun(clean(title))] }),
  ];
  const text = (t: string) => runs(t).map((r) => new d.TextRun({ text: r.text, bold: r.bold, italics: r.italics }));
  const levels = [
    d.HeadingLevel.HEADING_1,
    d.HeadingLevel.HEADING_2,
    d.HeadingLevel.HEADING_3,
    d.HeadingLevel.HEADING_4,
  ];
  for (const b of markdownBlocks(md)) {
    if (b.kind === "heading")
      children.push(new d.Paragraph({ heading: levels[Math.min(3, b.level - 1)], children: text(b.text) }));
    else if (b.kind === "paragraph") children.push(new d.Paragraph({ children: text(b.text) }));
    else if (b.kind === "quote")
      children.push(new d.Paragraph({ children: text(b.text), indent: { left: 480 }, style: "Quote" }));
    else if (b.kind === "code")
      for (const l of b.text.split("\n"))
        children.push(new d.Paragraph({ children: [new d.TextRun({ text: l, font: "Courier New", size: 18 })] }));
    else if (b.kind === "rule") children.push(new d.Paragraph({ text: "" }));
    else if (b.kind === "list")
      b.items.forEach((it, n) =>
        children.push(
          b.ordered
            ? new d.Paragraph({ children: [new d.TextRun(`${n + 1}. `), ...text(it)], indent: { left: 360 } })
            : new d.Paragraph({ children: text(it), bullet: { level: 0 } }),
        ),
      );
    else if (b.kind === "table") {
      const row = (cols: string[], head = false) =>
        new d.TableRow({
          tableHeader: head,
          children: b.head.map(
            (_, c) =>
              new d.TableCell({
                children: [
                  new d.Paragraph({
                    children: runs(cols[c] ?? "").map(
                      (r) => new d.TextRun({ text: r.text, bold: head || r.bold, italics: r.italics }),
                    ),
                  }),
                ],
              }),
          ),
        });
      children.push(
        new d.Table({
          width: { size: 100, type: d.WidthType.PERCENTAGE },
          rows: [row(b.head, true), ...b.rows.map((r) => row(r))],
        }),
      );
      children.push(new d.Paragraph({ text: "" }));
    }
  }
  const doc = new d.Document({
    creator: "MAVI",
    title: clean(title),
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return d.Packer.toBlob(doc);
}

// ------------------------------------------------------------ PowerPoint
export const THEMES: Record<
  SlideTheme,
  { bg: string; ink: string; muted: string; accent: string; soft: string; font: string }
> = {
  claro: { bg: "FFFFFF", ink: "263334", muted: "6B7775", accent: "4F7D2D", soft: "EEF4E5", font: "Calibri" },
  escuro: { bg: "1C2728", ink: "F3F6F1", muted: "A9B5B2", accent: "C8EC8E", soft: "263334", font: "Calibri" },
  verde: { bg: "EEF4E5", ink: "1C2728", muted: "4F5C5C", accent: "2F6B1E", soft: "FFFFFF", font: "Calibri" },
};

/** As imagens da conversa (I1 → data URL), para pôr nos slides. */
export type ImageSource = (ref: string) => Promise<string | null>;

export async function slidesPptx(c: Extract<Canvas, { kind: "slides" }>, image: ImageSource) {
  const { default: Pptx } = await import("pptxgenjs");
  const pptx = new Pptx();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = clean(c.title);
  const t = THEMES[c.theme];
  const W = 13.333;
  for (const s of c.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: t.bg };
    const base = { fontFace: t.font, color: t.ink, margin: 0 };
    const bullets = (items: string[], x: number, y: number, w: number, h: number, size = 20) =>
      slide.addText(
        items.map((b) => ({ text: plain(b), options: { bullet: { indent: 18 }, breakLine: true } })),
        { ...base, x, y, w, h, fontSize: size, valign: "top", paraSpaceAfter: 10 },
      );
    const title = (y = 0.6, size = 32) =>
      slide.addText(plain(s.title), { ...base, x: 0.7, y, w: W - 1.4, h: 1, fontSize: size, bold: true });
    if (s.layout === "title" || s.layout === "closing" || s.layout === "section") {
      if (s.layout === "section")
        slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 3.2, w: 0.12, h: 1.1, fill: { color: t.accent } });
      slide.addText(plain(s.title), {
        ...base,
        x: s.layout === "section" ? 1.1 : 0.9,
        y: s.layout === "section" ? 3.0 : 2.4,
        w: W - 2,
        h: 1.4,
        fontSize: s.layout === "section" ? 36 : 44,
        bold: true,
        align: s.layout === "section" ? "left" : "center",
      });
      if (s.subtitle)
        slide.addText(plain(s.subtitle), {
          ...base,
          color: t.muted,
          x: s.layout === "section" ? 1.1 : 0.9,
          y: s.layout === "section" ? 4.2 : 3.9,
          w: W - 2,
          h: 0.9,
          fontSize: 20,
          align: s.layout === "section" ? "left" : "center",
        });
    } else if (s.layout === "two_columns") {
      title();
      const col = (head: string | undefined, items: string[] | undefined, x: number) => {
        if (head) slide.addText(plain(head), { ...base, color: t.accent, x, y: 1.8, w: 5.6, h: 0.5, fontSize: 18, bold: true });
        if (items?.length) bullets(items, x, head ? 2.4 : 1.9, 5.6, 4.4, 18);
      };
      col(s.left_title, s.left, 0.7);
      col(s.right_title, s.right, 7);
    } else if (s.layout === "stats" && s.stats?.length) {
      title();
      const n = s.stats.length;
      const w = (W - 1.4 - (n - 1) * 0.3) / n;
      s.stats.forEach((st, i) => {
        const x = 0.7 + i * (w + 0.3);
        slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.3, w, h: 2.8, fill: { color: t.soft }, rectRadius: 0.12 });
        slide.addText(st.value, { ...base, color: t.accent, x, y: 2.6, w, h: 1.3, fontSize: 44, bold: true, align: "center" });
        slide.addText(plain(st.label), { ...base, color: t.muted, x: x + 0.2, y: 3.9, w: w - 0.4, h: 1, fontSize: 16, align: "center" });
      });
      if (s.subtitle)
        slide.addText(plain(s.subtitle), { ...base, color: t.muted, x: 0.7, y: 5.6, w: W - 1.4, h: 0.8, fontSize: 16 });
    } else if (s.layout === "quote" && s.quote) {
      slide.addText(`“${plain(s.quote)}”`, { ...base, x: 1.2, y: 1.6, w: W - 2.4, h: 3.2, fontSize: 30, italic: true, align: "center", valign: "middle" });
      if (s.author) slide.addText(`— ${plain(s.author)}`, { ...base, color: t.muted, x: 1.2, y: 5, w: W - 2.4, h: 0.6, fontSize: 18, align: "center" });
    } else if (s.layout === "image" && s.image) {
      title(0.5, 28);
      const data = await image(s.image).catch(() => null);
      if (data) slide.addImage({ data, x: 0.7, y: 1.6, w: s.bullets?.length ? 7 : W - 1.4, h: 5.3, sizing: { type: "contain", w: s.bullets?.length ? 7 : W - 1.4, h: 5.3 } });
      if (s.bullets?.length) bullets(s.bullets, 8.1, 1.8, 4.6, 5, 18);
    } else {
      title();
      if (s.subtitle) slide.addText(plain(s.subtitle), { ...base, color: t.muted, x: 0.7, y: 1.5, w: W - 1.4, h: 0.6, fontSize: 18 });
      if (s.bullets?.length) bullets(s.bullets, 0.7, s.subtitle ? 2.3 : 1.9, W - 1.4, 4.8);
    }
    if (s.notes) slide.addNotes(plain(s.notes));
  }
  return (await pptx.write({ outputType: "blob" })) as Blob;
}

// ------------------------------------------------------------ Excel
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
/** O formato de número de cada unidade (estilos do styles.xml abaixo). */
const unitStyle = (u?: TableColumn["unit"]) =>
  u === "money" ? 2 : u === "percent" ? 3 : u === "hours" || u === "days" || u === "number" ? 4 : 0;

/** Uma planilha do Excel (.xlsx) escrita à mão: os XML mínimos, num zip. */
export async function sheetXlsx(sheets: SheetTab[]) {
  const { zipSync, strToU8 } = await import("fflate");
  const sheetXml = (t: SheetTab) => {
    const rows = [t.columns.map((c) => c.label), ...t.rows];
    const body = rows
      .map((r, ri) => {
        const cellsXml = t.columns
          .map((c, ci) => {
            const v = r[ci];
            const ref = `${colName(ci)}${ri + 1}`;
            if (v === null || v === undefined || v === "") return "";
            if (ri === 0) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${esc(String(v))}</t></is></c>`;
            if (typeof v === "number")
              return `<c r="${ref}" s="${unitStyle(c.unit)}"><v>${c.unit === "percent" ? v / 100 : v}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(clean(String(v)))}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cellsXml}</row>`;
      })
      .join("");
    const widths = t.columns
      .map((c, i) => {
        const longest = Math.max(c.label.length, ...t.rows.slice(0, 200).map((r) => String(r[i] ?? "").length));
        return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(10, longest + 2))}" customWidth="1"/>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${body}</sheetData></worksheet>`;
  };
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("")}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((t, i) => `<sheet name="${esc(t.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="5"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="10" applyNumberFormat="1"/><xf numFmtId="4" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ),
  };
  sheets.forEach((t, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(t));
  });
  return new Blob([zipSync(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function sheetCsv(t: SheetTab) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "number" ? String(v).replace(".", ",") : clean(String(v));
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[t.columns.map((c) => c.label), ...t.rows].map((r) => r.map(cell).join(";")).join("\n")}`;
}

// ------------------------------------------------------------ PDF (impressão)
/**
 * Abre o conteúdo numa janela de impressão (Salvar como PDF): o que a tela
 * desenhou, sem o resto do app.
 */
export function printHtml(title: string, html: string, landscape = false) {
  const w = window.open("", "_blank", "noopener=no,width=1000,height=800");
  if (!w) return false;
  const styles = [...document.querySelectorAll('link[rel="stylesheet"], style')]
    .map((n) => n.outerHTML)
    .join("");
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)}</title>${styles}<style>@page{size:${landscape ? "A4 landscape" : "A4"};margin:14mm}body{background:#fff;margin:0}.canvas-print{padding:0}.canvas-slide{break-after:page;page-break-after:always;box-shadow:none!important;border:0!important;width:100%!important}.canvas-doc{max-width:none!important;padding:0!important}</style></head><body><div class="canvas-print">${html}</div><script>window.onload=()=>{setTimeout(()=>{window.print()},300)}</script></body></html>`);
  w.document.close();
  return true;
}

export type { Slide };

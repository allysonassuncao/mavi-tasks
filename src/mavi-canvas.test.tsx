import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { strFromU8, unzipSync } from "fflate";
import { sanitizeArtifact, sanitizeCanvas } from "./mavi-artifacts";
import { MaviMarkdown } from "./MaviMarkdown";
import {
  clean,
  documentDocx,
  markdownBlocks,
  runs,
  sheetCsv,
  sheetXlsx,
  slidesPptx,
} from "./mavi-export";
import { AnswerText } from "./AiChat";
import { IMAGE_KINDS } from "./ai-providers";

describe("canvas (formato fechado)", () => {
  it("documento, apresentação e planilha; o que não serve fica de fora", () => {
    expect(sanitizeCanvas({ kind: "document", title: "R", markdown: "curto" })).toBeNull();
    expect(
      sanitizeCanvas({ kind: "slides", title: "Pitch", theme: "neon", slides: [
        { layout: "stats", title: "Números", stats: [{ value: "612", label: "leads" }, { label: "sem valor" }] },
        { layout: "inventado", title: "Tópicos", bullets: ["a", "", "b"], image: "i2", html: "<b>" },
        { layout: "bullets" },
      ] }),
    ).toEqual({
      kind: "slides",
      title: "Pitch",
      theme: "claro",
      slides: [
        { layout: "stats", title: "Números", stats: [{ value: "612", label: "leads" }] },
        { layout: "bullets", title: "Tópicos", bullets: ["a", "b"], image: "I2" },
      ],
    });
    const sheet = sanitizeCanvas({
      kind: "sheet",
      title: "Leads",
      sheets: [{ name: "Set/2026", columns: [{ label: "Dia" }, { label: "Leads", unit: "number" }], rows: [["01/09", "12"]] }],
    });
    expect(sheet).toEqual({
      kind: "sheet",
      title: "Leads",
      sheets: [{ name: "Set 2026", columns: [{ label: "Dia" }, { label: "Leads", unit: "number" }], rows: [["01/09", 12]] }],
    });
    expect(
      sanitizeArtifact({ id: "canvas-1", ref: "D1", type: "canvas", canvas: sheet, revision_of: "D9" }),
    ).toMatchObject({ ref: "D1", type: "canvas", revision_of: "D9" });
  });
});

describe("Markdown completo no módulo", () => {
  const inline = (t: string) => [t];
  it("títulos, tabelas, listas numeradas, código e links", () => {
    const html = renderToStaticMarkup(
      <MaviMarkdown
        inline={inline}
        text={"## Resumo\n| Canal | Leads |\n|---|--:|\n| Meta | 94 |\n1. Um\n2. Dois\n   - sub\n```\nx = 1\n```\nVeja [o site](https://a.com) e `código`.\n> nota\n---\n[[D1]]"}
        renderArtifact={(ref) => <b>{ref}</b>}
      />,
    );
    expect(html).toContain('<h3 class="md-h"><span>Resumo</span></h3>');
    expect(html).toContain('<th style="text-align:right"><span>Leads</span></th>');
    expect(html).toContain('<td style="text-align:right"><span>94</span></td>');
    expect(html).toContain(
      '<ol class="md-list"><li><span>Um</span></li><li><span>Dois</span><ul class="md-list"><li><span>sub</span></li></ul></li></ol>',
    );
    expect(html).toContain('<pre class="md-code"><code>x = 1</code></pre>');
    expect(html).toContain('<a href="https://a.com" target="_blank" rel="noopener noreferrer">o site</a>');
    expect(html).toContain("<code>código</code>");
    expect(html).toContain('<blockquote class="md-quote">');
    expect(html).toContain('<div class="answer-artifact"><b>D1</b></div>');
    // Link que não é http(s) não vira link.
    expect(renderToStaticMarkup(<MaviMarkdown inline={inline} text="[x](javascript:alert(1))" />)).not.toContain("<a");
  });
  it("a bolinha continua com o jeito simples; o módulo usa o completo", () => {
    expect(renderToStaticMarkup(<AnswerText text={"## Título\ntexto"} />)).toContain("<p><span>Título</span></p>");
    expect(renderToStaticMarkup(<AnswerText rich text={"## Título\ntexto"} />)).toContain('<h3 class="md-h">');
  });
});

describe("arquivos do canvas", () => {
  it("o Markdown em blocos e o texto sem as marcas da conversa", () => {
    expect(clean("Cresceu [S1] muito [[V2]] em [12:30].")).toBe("Cresceu muito em 12:30.");
    expect(runs("**Forte** e *leve*")).toEqual([
      { text: "Forte", bold: true },
      { text: " e " },
      { text: "leve", italics: true },
    ]);
    expect(markdownBlocks("# A\n- x\n- y\n| a | b |\n|---|---|\n| 1 | 2 |").map((b) => b.kind)).toEqual([
      "heading",
      "list",
      "table",
    ]);
  });
  it("Excel: abas, cabeçalho em negrito, números como números", async () => {
    const blob = await sheetXlsx([
      { name: "Leads", columns: [{ label: "Dia" }, { label: "Gasto", unit: "money" }, { label: "Taxa", unit: "percent" }], rows: [["01/09", 120.5, 4.8]] },
      { name: "Resumo", columns: [{ label: "Total" }], rows: [[1]] },
    ]);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t>Dia</t></is></c>');
    expect(sheet).toContain('<c r="B2" s="2"><v>120.5</v></c>');
    expect(sheet).toContain('<c r="C2" s="3"><v>0.048</v></c>');
    expect(strFromU8(files["xl/workbook.xml"])).toContain('<sheet name="Resumo" sheetId="2" r:id="rId2"/>');
    expect(sheetCsv({ name: "x", columns: [{ label: "a" }, { label: "b" }], rows: [["1; 2", 3.5]] })).toBe('﻿a;b\n"1; 2";3,5');
  });
  it("Word: um .docx de verdade", async () => {
    const blob = await documentDocx("Relatório", "# Resumo\nTexto com **negrito**.\n- item\n| a | b |\n|---|---|\n| 1 | 2 |");
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const doc = strFromU8(files["word/document.xml"]);
    expect(doc).toContain("Relatório");
    expect(doc).toContain("negrito");
    expect(doc).toContain("<w:tbl>");
  });
  it("PowerPoint: um slide por slide, com as notas", async () => {
    const blob = await slidesPptx(
      {
        kind: "slides",
        title: "Pitch",
        theme: "escuro",
        slides: [
          { layout: "title", title: "Resultados de setembro", subtitle: "Clínica" },
          { layout: "stats", title: "Números", stats: [{ value: "612", label: "leads" }] },
          { layout: "bullets", title: "Tópicos", bullets: ["Um **forte**", "Dois"], notes: "Falar do forte." },
        ],
      },
      async () => null,
    );
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const slides = Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides).toHaveLength(3);
    expect(strFromU8(files["ppt/slides/slide1.xml"])).toContain("Resultados de setembro");
    expect(strFromU8(files["ppt/slides/slide3.xml"])).toContain("Um forte");
    const notes = Object.keys(files).filter((f) => /^ppt\/notesSlides\//.test(f)).map((f) => strFromU8(files[f]));
    expect(notes.some((n) => n.includes("Falar do forte."))).toBe(true);
  });
  it("o OpenRouter gera imagens", () => {
    expect(IMAGE_KINDS).toContain("openrouter");
  });
});

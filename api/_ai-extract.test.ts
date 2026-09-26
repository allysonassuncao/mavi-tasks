import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { jsPDF } from "jspdf";
import { decodeXml, extractFileText, sheetRows } from "./_ai-extract";

const zip = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  );

describe("texto dos arquivos do Drive", () => {
  it("PDF: uma parte por página", async () => {
    const doc = new jsPDF();
    doc.text("Proposta comercial de tráfego pago para o cliente.", 10, 10);
    doc.addPage();
    doc.text("Investimento mensal de tres mil reais em Meta Ads.", 10, 10);
    const out = await extractFileText(
      "pdf",
      new Uint8Array(doc.output("arraybuffer")),
      "p.pdf",
    );
    expect(out.status).toBe("done");
    expect(out.pages.map((p) => p.label)).toEqual(["Página 1", "Página 2"]);
    expect(out.pages[1].text).toContain("Investimento mensal");
  });

  it("Word: parágrafos, quebras e tabelas", async () => {
    const xml = `<w:document><w:body>
      <w:p><w:r><w:t>Briefing do cliente</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Público: mulheres &amp; homens</w:t></w:r><w:r><w:br/><w:t>de 30 a 50 anos</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Canal</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Verba</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`;
    const out = await extractFileText(
      "docx",
      zip({ "word/document.xml": xml }),
      "b.docx",
    );
    expect(out.status).toBe("done");
    expect(out.pages[0].label).toBeNull();
    expect(out.pages[0].text).toContain(
      "Público: mulheres & homens\nde 30 a 50 anos",
    );
    expect(out.pages[0].text).toContain("Canal");
    expect(out.pages[0].text).toContain("Verba");
  });

  it("PowerPoint: um slide por parte, na ordem", async () => {
    const slide = (t: string) =>
      `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>linha dois do slide</a:t></a:r></a:p></p:sld>`;
    const out = await extractFileText(
      "pptx",
      zip({
        "ppt/slides/slide2.xml": slide("Resultados do mês"),
        "ppt/slides/slide1.xml": slide("Capa da apresentação"),
      }),
      "a.pptx",
    );
    expect(out.pages.map((p) => p.label)).toEqual(["Slide 1", "Slide 2"]);
    expect(out.pages[1].text).toBe("Resultados do mês\nlinha dois do slide");
  });

  it("Excel: cada planilha com o nome, linhas com as colunas no lugar", async () => {
    const out = await extractFileText(
      "xlsx",
      zip({
        "xl/workbook.xml": `<workbook><sheets><sheet name="Leads &amp; vendas" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/sharedStrings.xml": `<sst><si><t>Mês</t></si><si><t>Leads</t></si><si><r><t>Set</t></r><r><t>embro</t></r></si></sst>`,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
          <row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>120</v></c></row>
        </sheetData></worksheet>`,
      }),
      "l.xlsx",
    );
    expect(out.pages).toEqual([
      {
        label: "Planilha Leads & vendas",
        text: "Mês | Leads\nSetembro |  | 120",
      },
    ]);
  });

  it("texto e HTML", async () => {
    const html = new TextEncoder().encode(
      "<html><style>x{}</style><body><p>Olá&nbsp;mundo da agência</p><p>Segunda linha do texto</p></body></html>",
    );
    const out = await extractFileText("text", html, "a.html");
    expect(out.pages[0].text).toBe(
      "Olá mundo da agência\n Segunda linha do texto",
    );
  });

  it("sem texto legível, tipo desconhecido e arquivo quebrado", async () => {
    expect(
      (
        await extractFileText(
          "text",
          new TextEncoder().encode("  \n "),
          "a.txt",
        )
      ).status,
    ).toBe("empty");
    expect(
      (await extractFileText(null, new Uint8Array([1, 2]), "a.bin")).status,
    ).toBe("unsupported");
    const broken = await extractFileText(
      "docx",
      new Uint8Array([1, 2, 3]),
      "a.docx",
    );
    expect(broken.status).toBe("error");
  });

  it("entidades e células inline", () => {
    expect(decodeXml("a &lt;b&gt; &#233; &#xE7;")).toBe("a <b> é ç");
    expect(
      sheetRows(
        `<row r="1"><c r="B1" t="inlineStr"><is><t>oi</t></is></c><c r="C1" t="b"><v>1</v></c></row>`,
        [],
      ),
    ).toBe("| oi | sim");
  });
});

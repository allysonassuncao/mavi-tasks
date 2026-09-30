import { describe, expect, it } from "vitest";
import { radarReportPdf } from "./radar-pdf";
import { loadReport } from "./radar";

describe("PDF do relatório do Radar", () => {
  it("gera as páginas com o texto da MAVI e as tabelas dos números", async () => {
    const report = await loadReport("demo-agency", "demo-report-1");
    const doc = await radarReportPdf(report);
    const pdf = doc.output();
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    // O texto sai no PDF (fontes padrão, sem compressão de fluxo por padrão).
    expect(pdf).toContain("RADAR DO CLIENTE");
    expect(pdf).toContain("Temas com mais clientes");
    expect(pdf).toContain("sugeridas");
    expect(pdf).toMatch(new RegExp(`\\(1 de ${doc.getNumberOfPages()}\\)`));
  });

  it("relatório sem texto (ainda na fila) não quebra", async () => {
    const report = await loadReport("demo-agency", "demo-report-1");
    const doc = await radarReportPdf({ ...report, content: null, material: null });
    expect(doc.getNumberOfPages()).toBe(1);
  });
});

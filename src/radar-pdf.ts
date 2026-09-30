import { dateBr, labelsLine, type RadarReportFull } from "./radar";

/**
 * O relatório do Radar em PDF (A4 em pé): o cabeçalho com o período e os
 * filtros, o que a MAVI escreveu (resumo, uma seção por produto, as ações) e
 * as tabelas com os números do banco. O jsPDF só carrega quando alguém baixa.
 */

type RGB = [number, number, number];
const INK: RGB = [38, 51, 52];
const DARK: RGB = [28, 39, 40];
const GREEN: RGB = [200, 237, 141];
const MUTED: RGB = [132, 144, 143];
const SOFT: RGB = [246, 247, 248];
const LINE: RGB = [227, 232, 232];
const PRIORITY: Record<string, RGB> = {
  alta: [227, 73, 72],
  média: [237, 161, 0],
  baixa: [127, 178, 234],
};
const SEVERITY = ["Baixa", "Média", "Alta", "Crítica"];

const M = 16;
const W = 210;
const H = 297;
const CW = W - 2 * M;

export async function radarReportPdf(r: RadarReportFull) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let y = 0;

  const color = (c: RGB) => doc.setTextColor(...c);
  const font = (size: number, style: "normal" | "bold" | "italic" = "normal") => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
  };
  const lh = (size: number) => size * 0.42;
  const ensure = (need: number) => {
    if (y + need <= H - 18) return;
    doc.addPage();
    y = M;
  };
  const para = (text: string, size = 10, style: "normal" | "bold" | "italic" = "normal", c: RGB = INK, x = M, w = CW) => {
    font(size, style);
    color(c);
    const lines = doc.splitTextToSize(text, w) as string[];
    for (const line of lines) {
      ensure(lh(size) + 1);
      doc.text(line, x, y + lh(size));
      y += lh(size) + 0.6;
    }
  };
  const heading = (text: string) => {
    ensure(14);
    y += 4;
    font(13, "bold");
    color(DARK);
    doc.text(text, M, y + lh(13));
    y += lh(13) + 2;
    doc.setDrawColor(...GREEN);
    doc.setLineWidth(0.8);
    doc.line(M, y, M + 18, y);
    y += 3;
  };
  const table = (head: string[], rows: string[][], widths: number[]) => {
    const pad = 1.6;
    const size = 8.5;
    const drawHead = () => {
      font(size, "bold");
      const hh = lh(size) + 2 * pad;
      doc.setFillColor(...SOFT);
      doc.rect(M, y, CW, hh, "F");
      color(MUTED);
      let x = M;
      head.forEach((h, i) => {
        doc.text(h, x + pad, y + pad + lh(size) - 0.4);
        x += widths[i];
      });
      y += hh;
    };
    ensure(20);
    drawHead();
    for (const row of rows) {
      font(size, "normal");
      const cells = row.map((cell, i) => doc.splitTextToSize(cell, widths[i] - 2 * pad) as string[]);
      const rh = Math.max(...cells.map((c) => c.length)) * (lh(size) + 0.5) + 2 * pad;
      if (y + rh > H - 18) {
        doc.addPage();
        y = M;
        drawHead();
        font(size, "normal");
      }
      color(INK);
      let x = M;
      cells.forEach((lines, i) => {
        lines.forEach((line, n) => doc.text(line, x + pad, y + pad + lh(size) - 0.4 + n * (lh(size) + 0.5)));
        x += widths[i];
      });
      y += rh;
      doc.setDrawColor(...LINE);
      doc.setLineWidth(0.2);
      doc.line(M, y, M + CW, y);
    }
    y += 3;
  };

  // Cabeçalho.
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W, 38, "F");
  font(9, "bold");
  doc.setTextColor(...GREEN);
  doc.text("RADAR DO CLIENTE · MAVI", M, 12);
  font(16, "bold");
  doc.setTextColor(255, 255, 255);
  doc.text(doc.splitTextToSize(r.title, CW)[0] as string, M, 21);
  font(9.5);
  doc.setTextColor(210, 218, 216);
  doc.text(`${dateBr(r.period_from)} a ${dateBr(r.period_to)} · ${labelsLine(r.labels)}`, M, 28, { maxWidth: CW });
  doc.text(
    `Gerado em ${dateBr(r.finished_at ?? r.created_at)}${r.requested_by_name ? ` · pedido por ${r.requested_by_name}` : ""}${r.schedule_name ? ` · agendamento "${r.schedule_name}"` : ""}`,
    M,
    33,
    { maxWidth: CW },
  );
  y = 46;

  const c = r.content;
  const m = r.material;
  if (c) {
    para(c.headline, 13, "bold", DARK);
    y += 1.5;
    para(c.summary, 10.5);
  }

  if (m?.topics.length) {
    heading("Números do período");
    table(
      ["Tópico", "Novos", "Em aberto", "Fechados", "Sérios", "Vencidos", "Vezes", "Clientes"],
      m.topics.map((t) => [
        t.topic,
        String(t.new),
        String(t.open),
        String(t.closed),
        String(t.severe),
        t.has_due ? String(t.overdue) : "—",
        String(t.mentions),
        String(t.clients),
      ]),
      [52, 17, 19, 19, 16, 18, 17, 20],
    );
  }

  if (c?.sections.length) {
    for (const s of c.sections) {
      heading(s.title);
      for (const p of s.paragraphs) {
        para(p);
        y += 1.2;
      }
      for (const b of s.bullets) {
        font(10);
        const lines = doc.splitTextToSize(b, CW - 6) as string[];
        lines.forEach((line, n) => {
          ensure(lh(10) + 1);
          if (n === 0) {
            doc.setFillColor(...INK);
            doc.circle(M + 1.5, y + lh(10) - 1.2, 0.7, "F");
          }
          color(INK);
          doc.text(line, M + 5, y + lh(10));
          y += lh(10) + 0.6;
        });
      }
      const nums = m?.products.find((p) => p.product === s.title);
      if (nums) {
        y += 1.5;
        table(
          ["Tópico", "Novos", "Em aberto", "Sérios", "Vencidos", "Fechados"],
          nums.topics.map((t) => [t.topic, String(t.new), String(t.open), String(t.severe), String(t.overdue), String(t.closed)]),
          [68, 22, 22, 22, 22, 22],
        );
      }
    }
  }

  if (c?.actions.length) {
    heading("Ações sugeridas");
    for (const a of c.actions) {
      font(10);
      const text = `${a.text}${a.product ? ` (${a.product})` : ""}`;
      const lines = doc.splitTextToSize(text, CW - 22) as string[];
      ensure(lines.length * (lh(10) + 0.6) + 2);
      doc.setFillColor(...(PRIORITY[a.priority] ?? MUTED));
      doc.roundedRect(M, y + 0.3, 17, 4.6, 1.2, 1.2, "F");
      font(7.5, "bold");
      doc.setTextColor(255, 255, 255);
      doc.text(a.priority.toUpperCase(), M + 8.5, y + 3.6, { align: "center" });
      font(10);
      color(INK);
      lines.forEach((line, n) => doc.text(line, M + 21, y + lh(10) + n * (lh(10) + 0.6)));
      y += lines.length * (lh(10) + 0.6) + 2.2;
    }
  }

  if (m?.themes.length) {
    heading("Temas com mais clientes");
    table(
      ["Tema", "Produto", "Clientes", "Em aberto", "Vezes", "Mais sério"],
      m.themes.map((t) => [
        t.title,
        t.product,
        String(t.clients),
        `${t.open} de ${t.items}`,
        String(t.mentions),
        t.max_severity != null ? SEVERITY[t.max_severity] : "—",
      ]),
      [70, 32, 18, 20, 16, 22],
    );
  }
  if (m?.severe.length) {
    heading("Itens sérios em aberto");
    table(
      ["Cliente", "Item", "Produto", "Gravidade", "Última vez"],
      m.severe.map((i) => [i.client, i.title, i.product, SEVERITY[i.severity] ?? String(i.severity), dateBr(i.last_seen)]),
      [34, 72, 30, 20, 22],
    );
  }
  if (m?.overdue.length) {
    heading("Promessas e prazos vencidos");
    table(
      ["Cliente", "Promessa", "Prazo", "Responsável"],
      m.overdue.map((o) => [o.client, o.title, dateBr(o.due_date), o.assignee ?? "Sem responsável"]),
      [36, 82, 24, 36],
    );
  }
  if (m?.clients.length) {
    heading("Clientes com mais itens em aberto");
    table(
      ["Cliente", "Em aberto", "Sérios", "Novos no período"],
      m.clients.map((x) => [x.client, String(x.open), String(x.severe), String(x.new)]),
      [88, 30, 30, 30],
    );
  }

  // Rodapé com as páginas.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    font(8);
    color(MUTED);
    doc.text("Radar do cliente · números calculados pelo sistema; texto escrito pela MAVI", M, H - 8);
    doc.text(`${p} de ${pages}`, W - M, H - 8, { align: "right" });
  }
  return doc;
}

/** Baixa o PDF com um nome a partir do título. */
export async function downloadRadarReport(r: RadarReportFull) {
  const doc = await radarReportPdf(r);
  const name = r.title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
  doc.save(`${name || "radar-do-cliente"}.pdf`);
}

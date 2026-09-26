import {
  parseColors,
  pillars,
  type BriefingFields,
  type PlanContent,
  type SlPost,
} from "./social-leads";

/**
 * The two PDFs of the Social Leads (as the B29 had), in the MAVI identity:
 * - the designer's: the approved posts with the visual identity;
 * - the presentation to the client: A4 landscape slides with the arts.
 * The presentation leaves out what is internal (alerts, budget, placements,
 * form questions, lead routing), like the client link. jsPDF is loaded only
 * when a PDF is made.
 */

type RGB = [number, number, number];
const INK: RGB = [38, 51, 52];
const DARK: RGB = [28, 39, 40];
const GREEN: RGB = [200, 237, 141];
const MUTED: RGB = [132, 144, 143];
const SOFT: RGB = [246, 247, 248];
const LINE: RGB = [227, 232, 232];
const PILLAR: Record<string, RGB> = {
  posicionar: [93, 126, 174],
  autoridade: [138, 112, 179],
  oferta: [178, 122, 82],
};

export type PdfImage = { data: string; w: number; h: number; video?: boolean };

/**
 * An image (or a video's first frame) as a JPEG data URL, at most `max`
 * pixels on the longer side, for embedding. Null when it can't be read.
 */
export async function loadImage(
  url: string,
  type: string,
  max = 900,
): Promise<PdfImage | null> {
  if (!url) return null;
  try {
    const blob = await (await fetch(url)).blob();
    const src = URL.createObjectURL(blob);
    try {
      let el: HTMLImageElement | HTMLVideoElement;
      let w: number;
      let h: number;
      if (type.startsWith("video/")) {
        const v = document.createElement("video");
        v.muted = true;
        v.preload = "auto";
        v.src = src;
        await new Promise<void>((resolve, reject) => {
          v.onloadeddata = () => {
            v.currentTime = Math.min(0.15, v.duration || 0);
          };
          v.onseeked = () => resolve();
          v.onerror = () => reject(new Error("vídeo"));
          window.setTimeout(() => reject(new Error("tempo")), 8000);
        });
        el = v;
        w = v.videoWidth;
        h = v.videoHeight;
      } else {
        const img = new Image();
        img.src = src;
        await img.decode();
        el = img;
        w = img.naturalWidth;
        h = img.naturalHeight;
      }
      if (!w || !h) return null;
      const scale = Math.min(1, max / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      return {
        data: canvas.toDataURL("image/jpeg", 0.82),
        w: canvas.width,
        h: canvas.height,
        video: type.startsWith("video/"),
      };
    } finally {
      URL.revokeObjectURL(src);
    }
  } catch {
    return null;
  }
}

const hexRgb = (hex: string): RGB => {
  const v = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB;
};
const date = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");

async function newDoc(orientation: "portrait" | "landscape") {
  const { jsPDF } = await import("jspdf");
  return new jsPDF({ orientation, unit: "mm", format: "a4" });
}
type Doc = Awaited<ReturnType<typeof newDoc>>;

/** Draws an image inside a box, keeping its proportion. */
function fit(
  doc: Doc,
  img: PdfImage,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const r = Math.min(w / img.w, h / img.h);
  const iw = img.w * r;
  const ih = img.h * r;
  doc.addImage(img.data, "JPEG", x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  if (img.video) {
    doc.setFillColor(...DARK);
    doc.roundedRect(
      x + (w - iw) / 2 + 2,
      y + (h - ih) / 2 + 2,
      16,
      6,
      1.5,
      1.5,
      "F",
    );
    doc.setTextColor(...GREEN);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.text("VÍDEO", x + (w - iw) / 2 + 10, y + (h - ih) / 2 + 6, {
      align: "center",
    });
  }
}

// ------------------------------------------------------------ designer
export async function designerPdf(input: {
  company: string;
  client: string;
  label: string;
  fields: BriefingFields;
  logo: PdfImage | null;
  posts: SlPost[];
}): Promise<Blob> {
  const doc = await newDoc("portrait");
  const W = 210;
  const M = 16;
  let y = 0;
  const header = () => {
    doc.setFillColor(...DARK);
    doc.rect(0, 0, W, 30, "F");
    doc.setTextColor(...GREEN);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text(`${input.company.toUpperCase()} · DIREÇÃO PARA O DESIGNER`, M, 11);
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(17);
    doc.text(`${input.client} · ${input.label}`, M, 22);
    y = 40;
  };
  const room = (needed: number) => {
    if (y + needed > 285) {
      doc.addPage();
      header();
    }
  };
  const para = (label: string, text: string, width = W - 2 * M) => {
    if (!text?.trim()) return;
    const lines = doc.splitTextToSize(text.trim(), width);
    room(8 + lines.length * 4.6);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(label.toUpperCase(), M, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(lines, M, y + 5);
    y += 7 + lines.length * 4.6;
  };
  header();

  // Identity.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...INK);
  doc.text("Identidade visual", M, y);
  y += 7;
  const colors = parseColors(input.fields.brandColors);
  if (colors.length) {
    let x = M;
    for (const c of colors) {
      if (x > W - M - 40) {
        x = M;
        y += 16;
      }
      if (c.hex) doc.setFillColor(...hexRgb(c.hex));
      else doc.setFillColor(...SOFT);
      doc.setDrawColor(...LINE);
      doc.roundedRect(x, y, 10, 10, 1.5, 1.5, "FD");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...INK);
      doc.text(c.name || c.hex || "", x + 12, y + 4.5);
      if (c.hex && c.name) {
        doc.setTextColor(...MUTED);
        doc.text(c.hex, x + 12, y + 8.5);
      }
      x += 45;
    }
    y += 16;
  }
  if (input.logo) {
    room(34);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text("LOGO", M, y);
    fit(doc, input.logo, M, y + 2, 50, 28);
    y += 34;
  }
  para("Tom e referências", input.fields.toneRefs ?? "");
  para("Elementos visuais", input.fields.brandVisualElements ?? "");
  para("Restrições (valem em todas as peças)", input.fields.notes ?? "");
  para(
    "Nunca",
    "Prometer resultado, ganho ou prazo; inventar depoimento ou cliente. O texto dentro da arte segue a mesma regra.",
  );

  // Posts.
  for (const p of input.posts) {
    const lines = [p.copy_direction, p.visual_direction].map((t) =>
      doc.splitTextToSize(t, W - 2 * M - 8),
    );
    room(40 + (lines[0].length + lines[1].length) * 4.6);
    y += 3;
    doc.setDrawColor(...LINE);
    doc.line(M, y, W - M, y);
    y += 7;
    doc.setFillColor(...(PILLAR[p.pillar] ?? MUTED));
    doc.roundedRect(M, y - 4, 24, 6, 1.5, 1.5, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.text(pillars[p.pillar].toUpperCase(), M + 12, y, { align: "center" });
    doc.setTextColor(...INK);
    doc.setFontSize(9);
    doc.text(
      `POST ${p.number}${p.is_ad ? "  ·  VIRA ANÚNCIO" : ""}`,
      M + 28,
      y,
    );
    y += 7;
    doc.setFontSize(12.5);
    const hook = doc.splitTextToSize(p.hook, W - 2 * M);
    doc.text(hook, M, y);
    y += hook.length * 5.6 + 2;
    para("Direção de copy", p.copy_direction);
    para("Direção visual", p.visual_direction);
    para("Formato · CTA", `${p.format} · ${p.cta}`);
    if (p.note) para("Observação do cliente", p.note);
  }
  return doc.output("blob");
}

// ------------------------------------------------------------ presentation
export async function presentationPdf(input: {
  company: string;
  client: string;
  label: string;
  createdAt: string;
  responsible: string | null;
  content: PlanContent;
  posts: SlPost[];
  arts: Record<number, PdfImage[]>;
  link: string | null;
}): Promise<Blob> {
  const doc = await newDoc("landscape");
  const W = 297;
  const H = 210;
  const M = 20;
  const slide = (dark = false) => {
    doc.addPage();
    doc.setFillColor(...(dark ? DARK : SOFT));
    doc.rect(0, 0, W, H, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...(dark ? GREEN : MUTED));
    doc.text(
      `${input.company.toUpperCase()} · ${input.client.toUpperCase()} · ${input.label.toUpperCase()}`,
      M,
      14,
    );
  };
  const title = (text: string, dark = false) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    doc.setTextColor(...(dark ? ([255, 255, 255] as RGB) : INK));
    doc.text(text, M, 36);
  };
  const body = (
    text: string,
    x: number,
    y: number,
    width: number,
    size = 12,
    color: RGB = INK,
  ) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, width);
    doc.text(lines, x, y);
    return y + lines.length * size * 0.45;
  };

  // Cover (the first page).
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W, H, "F");
  doc.setFillColor(...GREEN);
  doc.roundedRect(M, 24, 12, 12, 2.5, 2.5, "F");
  doc.setTextColor(...DARK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(input.company.slice(0, 1).toUpperCase(), M + 6, 32.3, {
    align: "center",
  });
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.text(input.company, M + 16, 32);
  doc.setTextColor(166, 180, 179);
  doc.setFontSize(12);
  doc.text("PLANO DE CONTEÚDO", M, 92);
  doc.setTextColor(...GREEN);
  doc.setFontSize(40);
  doc.text(doc.splitTextToSize(input.client, W - 2 * M), M, 110);
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.text(`${input.label} · ${input.posts.length} publicações`, M, 132);
  doc.setTextColor(166, 180, 179);
  doc.setFontSize(10.5);
  doc.text(
    `Criado em ${date(input.createdAt)}${input.responsible ? ` · com ${input.responsible}` : ""}`,
    M,
    141,
  );

  // Diagnosis and audience.
  slide();
  title("O que vamos comunicar");
  let y = body(
    input.content.diagnostico.comoQuerSerVista,
    M,
    52,
    W - 2 * M,
    16,
  );
  y = body(input.content.diagnostico.negocio, M, y + 6, W - 2 * M, 12, MUTED);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  doc.text("PARA QUEM", M, y + 12);
  body(input.content.publico, M, y + 19, W - 2 * M, 12);

  // Pillars.
  slide();
  title("Os 4 pilares do mês");
  const cw = (W - 2 * M - 3 * 8) / 4;
  input.content.pilares.forEach((p, i) => {
    const x = M + i * (cw + 8);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...LINE);
    doc.roundedRect(x, 50, cw, 120, 4, 4, "FD");
    doc.setTextColor(...(GREEN.map((v) => v - 60) as RGB));
    doc.setFont("helvetica", "bold");
    doc.setFontSize(30);
    doc.text(String(i + 1).padStart(2, "0"), x + 8, 70);
    doc.setTextColor(...INK);
    doc.setFontSize(14);
    const t = doc.splitTextToSize(p.titulo, cw - 16);
    doc.text(t, x + 8, 84);
    body(p.descricao, x + 8, 86 + t.length * 6.5, cw - 16, 10.5, MUTED);
  });

  // One slide per post.
  for (const p of input.posts) {
    slide();
    const arts = (input.arts[p.number] ?? []).slice(0, 4);
    const textW = arts.length ? 140 : W - 2 * M;
    doc.setFillColor(...(PILLAR[p.pillar] ?? MUTED));
    doc.roundedRect(M, 24, 30, 7, 1.5, 1.5, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text(pillars[p.pillar].toUpperCase(), M + 15, 29, { align: "center" });
    doc.setTextColor(...MUTED);
    doc.text(`POST ${p.number} DE ${input.posts.length}`, M + 36, 29);
    if (p.is_ad) {
      doc.setFillColor(...DARK);
      doc.roundedRect(M + 72, 24, 30, 7, 1.5, 1.5, "F");
      doc.setTextColor(...GREEN);
      doc.text("VIRA ANÚNCIO", M + 87, 29, { align: "center" });
    }
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    const hook = doc.splitTextToSize(p.hook, textW);
    doc.text(hook, M, 46);
    let py =
      body(p.copy_direction, M, 50 + hook.length * 9, textW, 12, INK) + 6;
    for (const [k, v] of [
      ["FORMATO", p.format],
      ["COMO VAI SER", p.visual_direction],
      ["CHAMADA", p.cta],
    ] as const) {
      if (py > H - 20) break;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      doc.text(k, M, py);
      py = body(v, M, py + 5, textW, 10.5) + 4;
    }
    if (arts.length) {
      const x0 = M + textW + 10;
      const aw = W - M - x0;
      const cols = arts.length === 1 ? 1 : 2;
      const rows = Math.ceil(arts.length / cols);
      const cell = Math.min(
        (aw - (cols - 1) * 4) / cols,
        (H - 44 - (rows - 1) * 4) / rows,
      );
      arts.forEach((a, i) => {
        const cx = x0 + (i % cols) * (cell + 4);
        const cy = 24 + Math.floor(i / cols) * (cell + 4);
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(cx, cy, cell, cell, 3, 3, "F");
        fit(doc, a, cx + 2, cy + 2, cell - 4, cell - 4);
      });
    } else {
      doc.setTextColor(232, 236, 236);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(160);
      doc.text(String(p.number), W - M, H - 20, { align: "right" });
    }
  }

  // Campaign, in the client's words.
  slide();
  title("O anúncio do mês");
  const c = input.content.campanha;
  const ad = input.posts.find((p) => p.is_ad);
  let cy = 54;
  for (const [k, v] of [
    ["OBJETIVO", c.objetivo],
    ["ONDE", c.regiao],
    ["PARA QUEM", c.idadeGenero],
    ["O ANÚNCIO", ad ? `Post ${ad.number}: ${ad.hook}` : ""],
  ] as const) {
    if (!v) continue;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(k, M, cy);
    cy = body(v, M, cy + 7, W - 2 * M, 14) + 8;
  }

  // Closing.
  slide(true);
  title("Próximo passo: sua aprovação", true);
  let fy = body(
    "Aprove ou peça ajuste em cada post. Com os 8 aprovados, a produção das artes começa e o anúncio vai ao ar.",
    M,
    54,
    W - 2 * M,
    15,
    [230, 238, 237],
  );
  if (input.link) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...GREEN);
    doc.text("LINK DE APROVAÇÃO", M, fy + 12);
    fy = body(input.link, M, fy + 19, W - 2 * M, 11, [255, 255, 255]);
  }
  return doc.output("blob");
}

/** Saves a Blob as a file (a download from the app). */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

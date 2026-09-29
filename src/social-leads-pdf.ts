import {
  parseColors,
  pillars,
  postTextPlain,
  withoutImageSuggestions,
  type BriefingFields,
  type PlanContent,
  type SlPost,
} from "./social-leads";

/**
 * The two PDFs of the Social Leads (as the B29 had):
 * - the designer's (MAVI identity): the approved posts with the visual
 *   identity and the exact texts of each piece;
 * - the presentation to the client (Make Acelerador de Vendas identity):
 *   A4 landscape slides with the arts and the texts.
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
    para("Texto exato da(s) imagem(ns)", postTextPlain(p.image_text));
    para("Texto exato do vídeo", postTextPlain(p.video_text));
    para("Legenda (copy)", postTextPlain(p.caption));
    if (p.note) para("Observação do cliente", p.note);
  }
  return doc.output("blob");
}

// ------------------------------------------------------------ presentation
/**
 * The presentation follows the Make Acelerador de Vendas identity (as on
 * makevendas.com.br): black, the brand orange, white and greys, the
 * lowercase "make" with the orange "m" seal. Helvetica stands in for
 * Biennale, the site's typeface, which jsPDF doesn't carry.
 */
const MAKE = {
  black: [17, 17, 17] as RGB,
  ink: [33, 33, 33] as RGB,
  orange: [255, 110, 40] as RGB,
  orangeDark: [185, 74, 0] as RGB,
  orangeSoft: [255, 240, 232] as RGB,
  grey: [97, 97, 97] as RGB,
  greyLight: [236, 236, 236] as RGB,
  paper: [250, 250, 250] as RGB,
  white: [255, 255, 255] as RGB,
};
const MAKE_BRAND = "Make Acelerador de Vendas";
const MAKE_PILLAR: Record<string, RGB> = {
  posicionar: MAKE.black,
  autoridade: MAKE.grey,
  oferta: MAKE.orange,
};

/** The seal (orange circle, white "m") and, when asked, the "make" word. */
function makeMark(
  doc: Doc,
  x: number,
  y: number,
  size: number,
  word: RGB | null,
) {
  doc.setFillColor(...MAKE.orange);
  doc.circle(x + size / 2, y + size / 2, size / 2, "F");
  doc.setTextColor(...MAKE.white);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(size * 2.3);
  doc.text("m", x + size / 2, y + size * 0.69, { align: "center" });
  if (word) {
    doc.setTextColor(...word);
    doc.setFontSize(size * 2.1);
    doc.text("make", x + size * 1.35, y + size * 0.72);
  }
}

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
  let page = 1;
  const footer = (dark: boolean) => {
    doc.setDrawColor(...MAKE.orange);
    doc.setLineWidth(0.6);
    doc.line(M, H - 14, W - M, H - 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...(dark ? MAKE.greyLight : MAKE.grey));
    doc.text(`${MAKE_BRAND} · makevendas.com.br`, M, H - 8.5);
    doc.text(String(page), W - M, H - 8.5, { align: "right" });
  };
  const slide = (dark = false) => {
    doc.addPage();
    page++;
    doc.setFillColor(...(dark ? MAKE.black : MAKE.white));
    doc.rect(0, 0, W, H, "F");
    makeMark(doc, M, 10, 7, dark ? MAKE.white : MAKE.black);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...(dark ? MAKE.greyLight : MAKE.grey));
    doc.text(
      `${input.client.toUpperCase()} · ${input.label.toUpperCase()}`,
      W - M,
      15.5,
      { align: "right" },
    );
    footer(dark);
  };
  const title = (text: string, dark = false, y = 40) => {
    doc.setFillColor(...MAKE.orange);
    doc.rect(M, y - 8.5, 3, 10, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    doc.setTextColor(...(dark ? MAKE.white : MAKE.black));
    doc.text(text, M + 7, y);
  };
  const body = (
    text: string,
    x: number,
    y: number,
    width: number,
    size = 12,
    color: RGB = MAKE.ink,
    maxLines = Infinity,
  ) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    let lines = doc.splitTextToSize(text, width) as string[];
    if (lines.length > maxLines) {
      lines = lines.slice(0, Math.max(1, maxLines));
      lines[lines.length - 1] =
        `${lines[lines.length - 1].replace(/\s+\S*$/, "")}…`;
    }
    doc.text(lines, x, y);
    return y + lines.length * size * 0.45;
  };
  const label = (
    text: string,
    x: number,
    y: number,
    color: RGB = MAKE.orange,
  ) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...color);
    doc.text(text, x, y);
  };

  // Cover (the first page).
  doc.setFillColor(...MAKE.black);
  doc.rect(0, 0, W, H, "F");
  doc.setFillColor(...MAKE.orange);
  doc.rect(0, 0, 6, H, "F");
  makeMark(doc, M, 22, 12, MAKE.white);
  // The big seal, cut by the page edge.
  doc.setFillColor(...MAKE.orange);
  doc.circle(W - 34, H - 40, 62, "F");
  doc.setTextColor(...MAKE.white);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(190);
  doc.text("m", W - 34, H - 12, { align: "center" });
  label("PLANO DE CONTEÚDO", M, 88);
  doc.setTextColor(...MAKE.white);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(38);
  const name = doc.splitTextToSize(input.client, W - 2 * M - 90);
  doc.text(name, M, 104);
  let cy = 104 + name.length * 15;
  doc.setFontSize(15);
  doc.setTextColor(...MAKE.orange);
  doc.text(`${input.label} · ${input.posts.length} publicações`, M, cy);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  doc.setTextColor(...MAKE.greyLight);
  cy += 9;
  doc.text(
    `Criado em ${date(input.createdAt)}${input.responsible ? ` · com ${input.responsible}` : ""}`,
    M,
    cy,
  );
  doc.setFontSize(8.5);
  doc.setTextColor(...MAKE.grey);
  doc.text(`${MAKE_BRAND} · makevendas.com.br`, M, H - 14);

  // Diagnosis and audience.
  slide();
  title("O que vamos comunicar");
  let y = body(
    input.content.diagnostico.comoQuerSerVista,
    M,
    56,
    W - 2 * M,
    16,
    MAKE.black,
  );
  y = body(
    input.content.diagnostico.negocio,
    M,
    y + 6,
    W - 2 * M,
    11.5,
    MAKE.grey,
  );
  doc.setFillColor(...MAKE.orangeSoft);
  doc.setFontSize(12);
  const pub = doc.splitTextToSize(
    input.content.publico,
    W - 2 * M - 16,
  ) as string[];
  const boxH = Math.min(H - 20 - (y + 8), 16 + pub.length * 5.4);
  doc.roundedRect(M, y + 8, W - 2 * M, boxH, 3, 3, "F");
  label("PARA QUEM", M + 8, y + 17);
  body(
    input.content.publico,
    M + 8,
    y + 24,
    W - 2 * M - 16,
    12,
    MAKE.ink,
    Math.max(1, Math.floor((boxH - 18) / 5.4)),
  );

  // Pillars.
  slide();
  title(`Os ${input.content.pilares.length} pilares do mês`);
  const cw = (W - 2 * M - 3 * 8) / 4;
  input.content.pilares.forEach((p, i) => {
    const x = M + i * (cw + 8);
    doc.setFillColor(...(i % 2 ? MAKE.paper : MAKE.white));
    doc.setDrawColor(...MAKE.greyLight);
    doc.roundedRect(x, 52, cw, 128, 3, 3, "FD");
    doc.setFillColor(...MAKE.orange);
    doc.rect(x, 52, cw, 2.2, "F");
    doc.setTextColor(...MAKE.orange);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(30);
    doc.text(String(i + 1).padStart(2, "0"), x + 8, 74);
    doc.setTextColor(...MAKE.black);
    doc.setFontSize(14);
    const t = doc.splitTextToSize(p.titulo, cw - 16);
    doc.text(t, x + 8, 88);
    body(p.descricao, x + 8, 90 + t.length * 6.5, cw - 16, 10.5, MAKE.grey, 14);
  });

  // One slide per post.
  for (const p of input.posts) {
    slide();
    const arts = (input.arts[p.number] ?? []).slice(0, 4);
    const textW = arts.length ? 140 : 165;
    const tagColor = MAKE_PILLAR[p.pillar] ?? MAKE.grey;
    doc.setFillColor(...tagColor);
    doc.roundedRect(M, 26, 32, 7, 3.5, 3.5, "F");
    doc.setTextColor(...MAKE.white);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text(pillars[p.pillar].toUpperCase(), M + 16, 31, { align: "center" });
    doc.setTextColor(...MAKE.grey);
    doc.text(`POST ${p.number} DE ${input.posts.length}`, M + 37, 31);
    if (p.is_ad) {
      doc.setFillColor(...MAKE.orange);
      doc.roundedRect(M + 72, 26, 32, 7, 3.5, 3.5, "F");
      doc.setTextColor(...MAKE.white);
      doc.text("VIRA ANÚNCIO", M + 88, 31, { align: "center" });
    }
    doc.setTextColor(...MAKE.black);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(21);
    const hook = (doc.splitTextToSize(p.hook, textW) as string[]).slice(0, 3);
    doc.text(hook, M, 47);
    const bottom = H - 20;
    let py =
      body(
        p.copy_direction,
        M,
        51 + hook.length * 8.6,
        textW,
        11,
        MAKE.grey,
        4,
      ) + 5;
    // Format and call side by side.
    label("FORMATO", M, py);
    label("CHAMADA", M + textW / 2, py);
    body(p.format, M, py + 5, textW / 2 - 4, 10.5, MAKE.ink, 2);
    const after = body(
      p.cta,
      M + textW / 2,
      py + 5,
      textW / 2 - 4,
      10.5,
      MAKE.ink,
      2,
    );
    py = Math.max(after, py + 10) + 5;
    // The exact texts, in boxes, while there is room.
    // Blank lines between paragraphs take room a slide doesn't have.
    const tight = (t: string | undefined) =>
      postTextPlain(t).replace(/\n\s*\n+/g, "\n");
    for (const [k, v] of [
      // The image ideas are for the designer, not for the client's deck.
      ["TEXTO DA ARTE", withoutImageSuggestions(tight(p.image_text))],
      ["ROTEIRO DO VÍDEO", tight(p.video_text)],
      ["LEGENDA", tight(p.caption)],
      [
        "COMO VAI SER",
        postTextPlain(p.image_text) || postTextPlain(p.video_text)
          ? ""
          : p.visual_direction,
      ],
    ] as const) {
      if (!v || py > bottom - 16) continue;
      const room = Math.floor((bottom - py - 10) / 4.3);
      const lines = Math.min(
        room,
        (doc.splitTextToSize(v, textW - 10) as string[]).length,
        k === "LEGENDA" ? 6 : 7,
      );
      if (lines < 1) continue;
      const h = 10 + lines * 4.3;
      doc.setFillColor(...MAKE.paper);
      doc.rect(M, py - 4, textW, h, "F");
      doc.setFillColor(...MAKE.orange);
      doc.rect(M, py - 4, 1.4, h, "F");
      label(k, M + 5, py + 1);
      body(v, M + 5, py + 6, textW - 10, 9.5, MAKE.ink, lines);
      py += h + 4;
    }
    if (arts.length) {
      const x0 = M + textW + 10;
      const aw = W - M - x0;
      const cols = arts.length === 1 ? 1 : 2;
      const rows = Math.ceil(arts.length / cols);
      const cell = Math.min(
        (aw - (cols - 1) * 4) / cols,
        (H - 50 - (rows - 1) * 4) / rows,
      );
      arts.forEach((a, i) => {
        const cx = x0 + (i % cols) * (cell + 4);
        const cy2 = 26 + Math.floor(i / cols) * (cell + 4);
        doc.setFillColor(...MAKE.paper);
        doc.setDrawColor(...MAKE.greyLight);
        doc.roundedRect(cx, cy2, cell, cell, 2, 2, "FD");
        fit(doc, a, cx + 2, cy2 + 2, cell - 4, cell - 4);
      });
    } else {
      doc.setTextColor(...MAKE.orangeSoft);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(150);
      doc.text(String(p.number).padStart(2, "0"), W - M, H - 24, {
        align: "right",
      });
    }
  }

  // Campaign, in the client's words.
  slide();
  title("O anúncio do mês");
  const c = input.content.campanha;
  const ad = input.posts.find((p) => p.is_ad);
  let ay = 58;
  const facts = [
    ["OBJETIVO", c.objetivo],
    ["ONDE", c.regiao],
    ["PARA QUEM", c.idadeGenero],
    ["O ANÚNCIO", ad ? `Post ${ad.number}: ${ad.hook}` : ""],
  ] as const;
  for (const [k, v] of facts) {
    if (!v || ay > H - 30) continue;
    label(k, M, ay);
    ay = body(v, M, ay + 7, W - 2 * M, 13, MAKE.ink, 4) + 8;
  }

  // Closing.
  slide(true);
  title("Próximo passo: sua aprovação", true, 52);
  let fy = body(
    `Aprove ou peça ajuste em cada post. Com os ${input.posts.length} aprovados, a produção das artes começa e o anúncio vai ao ar.`,
    M,
    68,
    W - 2 * M - 60,
    15,
    MAKE.greyLight,
  );
  if (input.link) {
    label("LINK DE APROVAÇÃO", M, fy + 14);
    doc.setFillColor(...MAKE.orange);
    const linkLines = doc.splitTextToSize(
      input.link,
      W - 2 * M - 20,
    ) as string[];
    const lh = 8 + linkLines.length * 5;
    doc.roundedRect(M, fy + 18, W - 2 * M - 60, lh, 2, 2, "F");
    fy = body(
      input.link,
      M + 6,
      fy + 18 + lh / 2 + 1.6 - (linkLines.length - 1) * 2.5,
      W - 2 * M - 72,
      11,
      MAKE.white,
    );
  }
  makeMark(doc, W - M - 44, H - 48, 14, MAKE.white);
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

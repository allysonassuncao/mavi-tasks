import type { IncomingMessage, ServerResponse } from "node:http";
import {
  checkPdfInput,
  checkRenderInput,
  renderArt,
  renderPages,
  renderPdf,
  type PagesInput,
  type PdfInput,
  type RenderInput,
} from "./_art-render.js";

/**
 * MAVI · arte por código na Vercel: o Chromium fica só nesta função (é
 * grande demais para a /api/drive, que atende todo o resto).
 *
 * Quem chama é o servidor da MAVI, com o token de quem pediu (conferido no
 * Supabase): manda o HTML, os links assinados dos arquivos e o link
 * assinado onde gravar o PNG no GCS. Devolve a prévia em JPEG (para a MAVI
 * conferir) e o que a conferência automática achou.
 *
 * Com mode "pdf", imprime um documento ou uma apresentação da MAVI (a página
 * inteira, com o tamanho de página dela) e grava o PDF no link. Com mode
 * "pages", desenha as páginas do design livre: devolve as prévias (em
 * base64) e a conferência, ou grava cada página num dos links de `puts`.
 */

const GCS = /^https:\/\/storage\.googleapis\.com\//;

async function signedIn(auth: string | undefined) {
  const url = process.env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co";
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  if (!auth?.startsWith("Bearer ")) return false;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: auth },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return !!res?.ok;
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const reply = (status: number, body: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return reply(405, { error: "Método não permitido" });
  let raw = "";
  if (typeof req.body === "object" && req.body !== null) raw = JSON.stringify(req.body);
  else for await (const chunk of req) raw += chunk;
  let body: RenderInput & PagesInput & { put?: { url?: string }; puts?: string[]; mode?: string };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return reply(400, { error: "Pedido inválido." });
  }
  if (!(await signedIn(req.headers.authorization))) return reply(401, { error: "Entre de novo." });
  if (body.mode === "pages") {
    const problem = checkPdfInput(body);
    if (problem) return reply(400, { error: problem });
    const puts = Array.isArray(body.puts) ? body.puts.map(String) : null;
    if (puts && (puts.length > 40 || puts.some((u) => !GCS.test(u)))) return reply(400, { error: "Links inválidos." });
    try {
      const r = await renderPages({
        html: body.html,
        assets: body.assets,
        width: Math.min(2400, Math.max(200, Number(body.width) || 1280)),
        height: Math.min(2400, Math.max(200, Number(body.height) || 720)),
        scale: Number(body.scale) || 1,
        type: body.type === "png" ? "png" : "jpeg",
        ...(Array.isArray(body.pick) ? { pick: body.pick.map(Number).filter(Number.isInteger) } : {}),
      });
      if (!puts)
        return reply(200, {
          pages: r.pages,
          report: r.report,
          images: r.images.map((i) => ({ page: i.page, data: i.data.toString("base64") })),
        });
      let saved = 0;
      for (const [k, img] of r.images.entries()) {
        if (!puts[k]) break;
        const res = await fetch(puts[k], {
          method: "PUT",
          headers: { "Content-Type": body.type === "png" ? "image/png" : "image/jpeg" },
          body: new Uint8Array(img.data),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) return reply(502, { error: `Não foi possível guardar a página ${k + 1} (${res.status}).` });
        saved++;
      }
      return reply(200, { pages: r.pages, report: r.report, saved });
    } catch (e) {
      return reply(500, { error: (e as Error).message?.slice(0, 300) || "Não foi possível desenhar as páginas." });
    }
  }
  const pdf = body.mode === "pdf";
  const problem = pdf ? checkPdfInput(body) : checkRenderInput(body);
  if (problem) return reply(400, { error: problem });
  const put = String(body.put?.url ?? "");
  if (!GCS.test(put)) return reply(400, { error: "Falta onde gravar a arte." });
  if (pdf)
    try {
      const file = await renderPdf(body);
      const saved = await fetch(put, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(file),
        signal: AbortSignal.timeout(60_000),
      });
      if (!saved.ok) return reply(502, { error: `Não foi possível guardar o PDF (${saved.status}).` });
      return reply(200, { bytes: file.length });
    } catch (e) {
      return reply(500, { error: (e as Error).message?.slice(0, 300) || "Não foi possível gerar o PDF." });
    }
  try {
    const r = await renderArt(body);
    const saved = await fetch(put, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: r.png,
      signal: AbortSignal.timeout(60_000),
    });
    if (!saved.ok) return reply(502, { error: `Não foi possível guardar a arte (${saved.status}).` });
    return reply(200, { preview: r.preview.toString("base64"), report: r.report, bytes: r.png.length });
  } catch (e) {
    return reply(500, { error: (e as Error).message?.slice(0, 300) || "Não foi possível desenhar a arte." });
  }
}

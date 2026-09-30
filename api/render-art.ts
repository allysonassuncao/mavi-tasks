import type { IncomingMessage, ServerResponse } from "node:http";
import { checkRenderInput, renderArt, type RenderInput } from "./_art-render.js";

/**
 * MAVI · arte por código na Vercel: o Chromium fica só nesta função (é
 * grande demais para a /api/drive, que atende todo o resto).
 *
 * Quem chama é o servidor da MAVI, com o token de quem pediu (conferido no
 * Supabase): manda o HTML, os links assinados dos arquivos e o link
 * assinado onde gravar o PNG no GCS. Devolve a prévia em JPEG (para a MAVI
 * conferir) e o que a conferência automática achou.
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
  let body: RenderInput & { put?: { url?: string } };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return reply(400, { error: "Pedido inválido." });
  }
  if (!(await signedIn(req.headers.authorization))) return reply(401, { error: "Entre de novo." });
  const problem = checkRenderInput(body);
  if (problem) return reply(400, { error: problem });
  const put = String(body.put?.url ?? "");
  if (!GCS.test(put)) return reply(400, { error: "Falta onde gravar a arte." });
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

import { supabase } from "./supabase";
import { providerAction } from "./ai";
import { artifactSummary, type AiArtifact, type Canvas, type CanvasArtifact, type ImageArtifact } from "./mavi-artifacts";
import type { Look } from "./visual-identity";

/**
 * MAVI · edição direta no canvas (migração 20270610090000_canvas_edits): a
 * versão editada vira uma mensagem da pessoa na conversa, com o documento
 * anexado (uma referência nova, ex.: D3, "ajuste de D1, editado por você").
 * A MAVI lê essa mensagem junto com a próxima pergunta e continua dela.
 */

/** A próxima referência de documento da conversa (D1, D2…). */
export function nextDocRef(artifacts: AiArtifact[]) {
  return nextRef(artifacts, "D");
}
/** A próxima referência de um tipo (D, I…), pulando as que já estão em uso. */
export function nextRef(artifacts: { ref: string }[], letter: "D" | "I") {
  const used = artifacts.filter((a) => a.ref.startsWith(letter)).map((a) => Number(a.ref.slice(1)) || 0);
  return `${letter}${Math.max(0, ...used) + 1}`;
}

/** Uma imagem enviada do computador no editor (vira anexo da versão salva). */
export type UploadedImage = { ref: string; path: string; url: string; name: string };
export async function uploadCanvasImage(company: string, file: File): Promise<{ path: string; url: string }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw Error("Envie uma imagem PNG, JPG ou WebP.");
  if (file.size > 10 * 1024 * 1024) throw Error("A imagem precisa ter até 10 MB.");
  const r = await providerAction<{ path: string; put: string; url: string; headers: Record<string, string> }>({
    action: "ai-image-upload",
    company,
    content_type: file.type,
    size: file.size,
  });
  const res = await fetch(r.put, { method: "PUT", headers: r.headers, body: file });
  if (!res.ok) throw Error(`Não foi possível enviar a imagem (${res.status}).`);
  return { path: r.path, url: r.url };
}
/** O anexo de uma imagem enviada (só as que a versão usa vão junto). */
export const uploadedArtifact = (u: UploadedImage): ImageArtifact => ({
  id: `img-${crypto.randomUUID()}`,
  ref: u.ref,
  type: "image",
  path: u.path,
  prompt: u.name.slice(0, 200),
  size: "square",
  model: "enviada pela pessoa",
});
/** As imagens enviadas que o documento usa (img:I7 no HTML, ou a imagem de um slide). */
export function usedUploads(canvas: Canvas, uploads: UploadedImage[]) {
  const text = canvas.kind === "design" ? canvas.html : canvas.kind === "slides" ? canvas.slides.map((s) => (s.image ? `img:${s.image}` : "")).join(" ") : "";
  return uploads.filter((u) => new RegExp(`img:${u.ref}(?![0-9])`).test(text));
}

/** A versão editada, pronta para gravar (sanitizeCanvas confere de novo ao ler). */
export function editedArtifact(from: CanvasArtifact, canvas: Canvas, ref: string): CanvasArtifact {
  return {
    id: `canvas-${crypto.randomUUID()}`,
    ref,
    type: "canvas",
    canvas,
    revision_of: from.ref,
    edited: true,
  };
}

/** O que fica escrito na conversa (e a MAVI lê). */
export const editNote = (from: CanvasArtifact, to: CanvasArtifact) =>
  `Editei o ${from.ref} direto no canvas e salvei como ${to.ref} (${artifactSummary(to)}). Daqui para a frente, use o ${to.ref}.`;

export async function saveCanvasEdit(conversation: string, note: string, artifact: CanvasArtifact, images: ImageArtifact[] = []) {
  if (!supabase) throw Error("Supabase não configurado.");
  const { data, error } = await supabase.rpc("ai_canvas_edit", {
    p_conversation: conversation,
    p_note: note,
    p_artifact: artifact,
    p_images: images,
  });
  if (error) throw Error(error.message);
  return Number(data);
}

/**
 * O design livre com outra identidade: o tema (variáveis e fontes) vem do
 * look; as cores e fontes que o desenho escreveu direto (as do tema
 * anterior) e o logo trocam junto. Uma passada só, para uma cor nova não
 * virar outra.
 */
export function restyleDesign(html: string, from: Look | null | undefined, to: Look) {
  if (!from) return html;
  const colors = new Map<string, string>();
  // Duas cores iguais no tema anterior: vale a de cima (fundo, texto, marca…).
  for (const k of ["bg", "ink", "primary", "accent", "surface", "muted", "on_primary"] as const) {
    const a = from.colors[k].toLowerCase();
    if (!colors.has(a)) colors.set(a, to.colors[k]);
  }
  const fonts = new Map<string, string>();
  for (const k of ["heading", "body"] as const) if (!fonts.has(from[k].family)) fonts.set(from[k].family, to[k].family);
  const logos = new Map<string, string>();
  for (const k of ["light", "dark"] as const) {
    const a = from.logo[k];
    const b = to.logo[k] ?? to.logo.light ?? to.logo.dark;
    if (a && b && !logos.has(a)) logos.set(a, b);
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = html.replace(/#[0-9a-f]{6}\b/gi, (h) => colors.get(h.toLowerCase()) ?? h);
  const fam = [...fonts].filter(([a, b]) => a !== b).map(([a]) => a);
  if (fam.length) {
    const re = new RegExp(`(^|['",\\s]|&quot;)(${fam.map(esc).join("|")})(?=['",\\s]|&quot;|$)`, "g");
    out = out.replace(/(font-family\s*:\s*)((?:&quot;|[^;}"<])+)/gi, (_m, p: string, v: string) => p + v.replace(re, (_x, b: string, f: string) => b + fonts.get(f)!));
  }
  if (logos.size) out = out.replace(/file:([0-9a-f-]{36})/gi, (t, id: string) => (logos.has(id.toLowerCase()) ? `file:${logos.get(id.toLowerCase())}` : t));
  return out;
}

/** O documento com a identidade escolhida no canvas. */
export function withLook(c: Canvas, from: Look | null, to: Look): Canvas | null {
  if (c.kind === "sheet") return null;
  if (c.kind === "design") return { ...c, html: restyleDesign(c.html, from, to), look: to };
  return { ...c, look: to };
}

/** Como a MAVI chama a identidade (o parâmetro identity). */
export const identityParam = (l: Look) =>
  l.source === "company" ? "empresa" : l.source === "client" ? "cliente" : l.id;

export const lookNote = (from: CanvasArtifact, to: CanvasArtifact, look: Look) =>
  `Apliquei a identidade visual “${look.name}” no ${from.ref} pelo canvas e salvei como ${to.ref} (${artifactSummary(to)}). Daqui para a frente, use o ${to.ref} e essa identidade (identity: ${identityParam(look)}).`;

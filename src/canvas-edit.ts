import { supabase } from "./supabase";
import { providerAction } from "./ai";
import { artifactSummary, type AiArtifact, type Canvas, type CanvasArtifact, type ImageArtifact } from "./mavi-artifacts";

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

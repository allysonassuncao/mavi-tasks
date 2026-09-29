import { supabase } from "./supabase";
import { providerAction } from "./ai";

/**
 * MAVI · anexos na conversa (migração 20261221090000_mavi_attachments), na
 * tela: o tipo pelo nome, a impressão digital (SHA-256: o mesmo arquivo não
 * sobe de novo), imagens grandes reduzidas antes de subir, o upload direto
 * para o GCS com progresso e a leitura pelo servidor.
 */

export type AttachmentKind = "document" | "image" | "audio" | "video";
export type AttachmentStatus = "uploading" | "processing" | "ready" | "empty" | "error" | "unsupported";
export type Attachment = {
  id: string;
  conversation: string | null;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  status: AttachmentStatus;
  error: string | null;
  pages: number | null;
  chars: number | null;
  preview: string | null;
  created_at: string;
};

const KINDS: Record<string, AttachmentKind> = {
  pdf: "document",
  docx: "document",
  pptx: "document",
  xlsx: "document",
  txt: "document",
  md: "document",
  csv: "document",
  json: "document",
  html: "document",
  htm: "document",
  xml: "document",
  log: "document",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  aac: "audio",
  flac: "audio",
  mp4: "video",
  mov: "video",
  webm: "video",
  mpeg: "video",
};
/** O que o seletor de arquivos aceita. */
export const ATTACH_ACCEPT = Object.keys(KINDS)
  .map((e) => `.${e}`)
  .join(",");
export const MAX_ATTACH_BYTES: Record<AttachmentKind, number> = {
  document: 52_428_800,
  image: 52_428_800,
  audio: 26_214_400,
  video: 26_214_400,
};
/** Até quantos arquivos por mensagem. */
export const MAX_PER_MESSAGE = 10;

export function attachmentKind(name: string): AttachmentKind | null {
  return KINDS[name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? ""] ?? null;
}

/** Por que o arquivo não entra (ou null se entra). */
export function attachmentProblem(file: File) {
  const kind = attachmentKind(file.name);
  if (!kind) return "Tipo de arquivo não aceito.";
  if (file.size > MAX_ATTACH_BYTES[kind])
    return kind === "audio" || kind === "video" ? "Áudio e vídeo até 25 MB." : "Arquivo até 50 MB.";
  if (!file.size) return "Arquivo vazio.";
  return null;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

async function sha256(file: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Imagens grandes chegam menores (lado maior até 2048 px): a MAVI lê melhor,
 * sobe mais rápido e cabe no limite da leitura (5 MB). GIF fica como está.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || typeof createImageBitmap !== "function") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const max = 2048;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 3_500_000) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.88));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, "") + ".webp", { type: "image/webp" });
}

/** A duração do áudio ou do vídeo (para o custo da transcrição). */
function mediaSeconds(file: File, kind: AttachmentKind): Promise<number | null> {
  if (kind !== "audio" && kind !== "video") return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind === "video" ? "video" : "audio");
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 5000);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(el.duration) ? el.duration : null);
    };
    el.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    el.src = url;
  });
}

function put(url: string, headers: Record<string, string>, file: Blob, onProgress: (p: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Error(`Falha no envio (${xhr.status}).`)));
    xhr.onerror = () => reject(Error("Falha no envio. Confira a conexão."));
    xhr.send(file);
  });
}

export type AttachStage = "preparing" | "uploading" | "reading";

/**
 * Sobe e lê um anexo: devolve como ficou (pronto, vazio ou com erro). O
 * mesmo arquivo já lido por você não sobe de novo.
 */
export async function attachFile(
  company: string,
  conversation: string | null,
  original: File,
  onStage: (stage: AttachStage, progress?: number) => void,
): Promise<Attachment> {
  onStage("preparing");
  const kind = attachmentKind(original.name);
  const file = kind === "image" ? await shrinkImage(original) : original;
  const [hash, seconds] = await Promise.all([sha256(file), mediaSeconds(file, kind ?? "document")]);
  const signed = await providerAction<{
    attachment: Attachment;
    url?: string;
    headers?: Record<string, string>;
  }>({ action: "ai-attach-sign", company, conversation, name: file.name, size: file.size, sha256: hash });
  if (!signed.url) return signed.attachment;
  onStage("uploading", 0);
  await put(signed.url, signed.headers ?? {}, file, (p) => onStage("uploading", p));
  onStage("reading");
  const done = await providerAction<{ attachment: Attachment }>({
    action: "ai-attach-process",
    id: signed.attachment.id,
    ...(seconds ? { seconds } : {}),
  });
  return { ...signed.attachment, ...done.attachment };
}

export const removeAttachment = (id: string) =>
  providerAction<{ ok: boolean }>({ action: "ai-attach-delete", id });

export async function conversationAttachments(conversation: string) {
  if (!supabase) return [] as Attachment[];
  const { data, error } = await supabase.rpc("ai_attachments_list", { p_conversation: conversation });
  if (error) throw error;
  return (data ?? []) as Attachment[];
}

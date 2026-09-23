import { supabase } from "./supabase";

/** Avatar edge in pixels: sharp at 2× the largest avatar shown (45 px). */
export const AVATAR_SIZE = 256;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export type OptimizedAvatar = {
  blob: Blob;
  format: "webp" | "jpg";
  preview: string;
  originalBytes: number;
};

function encode(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality),
  );
}

/**
 * Crops the photo to a centered square and scales it to AVATAR_SIZE, encoded
 * as WebP (JPEG where the browser cannot encode WebP, e.g. Safari). A phone
 * photo of several MB becomes ~10-30 KB, so lists with many avatars stay fast.
 */
export async function optimizeAvatar(file: File): Promise<OptimizedAvatar> {
  if (!file.type.startsWith("image/"))
    throw Error("Escolha um arquivo de imagem (JPG, PNG ou WebP).");
  if (file.size > MAX_INPUT_BYTES)
    throw Error("Escolha uma imagem de até 20 MB.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw Error(
      "Não foi possível ler esta imagem. Use JPG, PNG ou WebP (fotos HEIC do iPhone precisam ser convertidas).",
    );
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );
  bitmap.close();
  let blob = await encode(canvas, "image/webp", 0.82);
  let format: OptimizedAvatar["format"] = "webp";
  if (!blob || blob.type !== "image/webp") {
    blob = await encode(canvas, "image/jpeg", 0.85);
    format = "jpg";
  }
  if (!blob) throw Error("Não foi possível otimizar esta imagem.");
  return {
    blob,
    format,
    preview: URL.createObjectURL(blob),
    originalBytes: file.size,
  };
}

/** Uploads an optimized avatar; returns its public URL for set_my_avatar. */
export async function uploadAvatar(avatar: OptimizedAvatar) {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  const res = await fetch("/api/profile", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: "avatar-upload", format: avatar.format }),
  });
  const signed = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(signed.error ?? "Não foi possível enviar a foto.");
  const put = await fetch(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: avatar.blob,
  });
  if (!put.ok) throw Error(`Falha no envio da foto (${put.status}).`);
  return signed.public_url as string;
}

export async function changePassword(password: string) {
  if (!supabase) throw Error("Supabase não configurado");
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

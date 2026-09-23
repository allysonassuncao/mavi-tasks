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

/**
 * Why a self-service recovery email was not sent, in words for the person on
 * the login page (the admin-facing wording lives in _shared/auth-email.ts).
 */
export function passwordResetError(
  error: { message?: string; status?: number; code?: string } | null,
) {
  const message = error?.message ?? "";
  const wait = /after (\d+) seconds?/i.exec(message)?.[1];
  if (wait)
    return `Por segurança, aguarde ${wait} segundos antes de pedir outro link.`;
  if (
    error?.code === "over_email_send_rate_limit" ||
    error?.status === 429 ||
    /rate limit/i.test(message)
  )
    return "Muitos pedidos de e-mail agora. Tente de novo em alguns minutos.";
  if (error?.code === "validation_failed" || /invalid.*email/i.test(message))
    return "Confira o e-mail digitado.";
  return "Não foi possível enviar o link agora. Tente de novo ou fale com o administrador.";
}

/**
 * Emails a recovery link. Supabase answers the same way whether or not the
 * address has an account, so the screen must not claim either.
 */
export async function requestPasswordReset(email: string) {
  if (!supabase) throw Error("A conexão com Supabase ainda não foi configurada.");
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    // Same landing as the admin-sent link: the app opens "Defina sua senha".
    redirectTo: window.location.origin + "/?reset=1",
  });
  if (error) throw Error(passwordResetError(error));
}

import { supabase } from "./supabase";

export const GCS_BUCKET = "maso_storage_main";

/**
 * Returns the public direct URL for an object stored in the public GCS bucket.
 */
export function getGcsPublicUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `https://storage.googleapis.com/${GCS_BUCKET}/${encodeURI(cleanPath).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

/** A record prepared for upload (prepare_attachment / prepare_inline_image). */
export type UploadTarget = { kind: "attachment" | "inline-image"; id: string };

/**
 * Uploads the file for a record the user just prepared. The server
 * (api/gcs/sign-upload.ts) signs a PUT only for that record's own path.
 */
export async function uploadToGcs(
  target: UploadTarget,
  file: File,
  contentType?: string,
): Promise<void> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token) throw new Error("Entre novamente para enviar arquivos.");
  const res = await fetch("/api/gcs/sign-upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      ...target,
      contentType: contentType || file.type || "application/octet-stream",
    }),
  });
  const signed = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      signed.error ?? "Não foi possível autorizar o envio do arquivo.",
    );
  const put = await fetch(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: file,
  });
  if (!put.ok) {
    const errText = await put.text().catch(() => "");
    throw new Error(
      `Falha no upload para o Google Cloud Storage (${put.status}): ${errText || put.statusText}`,
    );
  }
}

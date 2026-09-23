import { supabase } from "./supabase";

export const GCS_BUCKET = "maso_storage_main";

/**
 * Returns the public direct URL for an object stored in the public GCS bucket.
 */
export function getGcsPublicUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `https://storage.googleapis.com/${GCS_BUCKET}/${encodeURI(cleanPath).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

/**
 * Requests a signed upload URL from the local Vite dev middleware,
 * Vercel serverless API, or Supabase Edge Function.
 */
export async function getSignedUploadUrl(
  path: string,
  contentType: string,
): Promise<string> {
  const cleanPath = path.replace(/^\/+/, "");

  // 1. Try local dev server / Vercel API endpoint
  try {
    const res = await fetch("/api/gcs/sign-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: cleanPath, contentType }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.url) return data.url;
    }
  } catch {
    /* Fallback to Supabase Edge Function */
  }

  // 2. Try Supabase Edge Function
  if (supabase) {
    try {
      const { data, error } = await supabase.functions.invoke("gcs-storage", {
        body: { path: cleanPath, contentType, action: "sign-upload" },
      });
      if (!error && data?.url) return data.url;
      if (error) throw error;
    } catch (err) {
      throw new Error(
        `Falha ao autorizar upload no GCS: ${(err as Error).message || err}`,
      );
    }
  }

  throw new Error(
    "Não foi possível obter autorização para envio de arquivo ao GCS.",
  );
}

/**
 * Uploads a file directly to Google Cloud Storage using a signed V4 PUT URL.
 */
export async function uploadToGcs(
  path: string,
  file: File,
  contentType?: string,
): Promise<void> {
  const type = contentType || file.type || "application/octet-stream";
  const signedUrl = await getSignedUploadUrl(path, type);

  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": type,
    },
    body: file,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Falha no upload para o Google Cloud Storage (${res.status}): ${errText || res.statusText}`,
    );
  }
}

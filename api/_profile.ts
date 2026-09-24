import { callRpc, signGcsUrl, type DriveEnv } from "./_drive.js";

/** Largest avatar GCS accepts; the browser sends ~10-30 KB images. */
export const AVATAR_MAX_BYTES = 512 * 1024;

/**
 * Profile photo and company logo uploads. The database picks the object
 * path inside the caller's own avatar folder (or, for administrators, the
 * company's logo folder); the signed URL only accepts WebP/JPEG up to
 * AVATAR_MAX_BYTES (enforced by GCS through x-goog-content-length-range).
 * Avatars live in the public bucket so every teammate can load them directly.
 */
export async function handleProfile(
  body: unknown,
  authorization: string | null,
  env: DriveEnv & { publicBucket: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!env.credentials?.client_email || !env.credentials.private_key)
    return fail(500, "Credenciais do Google Cloud Storage não configuradas.");
  const req = (body ?? {}) as {
    action?: string;
    format?: string;
    company?: unknown;
  };
  if (req.action !== "avatar-upload" && req.action !== "company-logo-upload")
    return fail(400, "Ação inválida.");
  const logo = req.action === "company-logo-upload";
  if (
    logo &&
    (typeof req.company !== "string" || !/^[0-9a-f-]{36}$/i.test(req.company))
  )
    return fail(400, "Empresa inválida.");
  const format = req.format === "jpg" ? "jpg" : "webp";
  const contentType = format === "jpg" ? "image/jpeg" : "image/webp";
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");
  // Company logos (administrators) go to the company's own folder.
  const target = await callRpc<string>(
    env,
    fetchImpl,
    authorization,
    logo ? "company_logo_upload_path" : "avatar_upload_path",
    logo ? { p_company: req.company, p_format: format } : { p_format: format },
  );
  if (!target.ok) return fail(target.status, target.error);
  const range = `0,${AVATAR_MAX_BYTES}`;
  return {
    status: 200,
    body: {
      url: signGcsUrl(env.credentials, env.publicBucket, target.data, "PUT", {
        contentType,
        headers: { "x-goog-content-length-range": range },
      }),
      headers: {
        "Content-Type": contentType,
        "x-goog-content-length-range": range,
      },
      public_url: `https://storage.googleapis.com/${env.publicBucket}/${target.data}`,
    },
  };
}

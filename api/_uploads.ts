import { callRpc, signGcsUrl, type DriveEnv } from "./_drive.js";
import { attachmentType, inlineImageTypes } from "../src/upload-types.js";

/**
 * Signs uploads for task attachments and inline images. The client names a
 * record it just prepared (prepare_attachment / prepare_inline_image), never
 * an object path: the database resolves the path, as the requesting user,
 * only for that user's own recent, still-pending record. The signed URL fixes
 * the content type and caps the size at what was declared when preparing.
 */
export type UploadRequest = {
  kind: "attachment" | "inline-image";
  id: string;
  contentType?: string;
};

export async function handleUpload(
  body: unknown,
  authorization: string | null,
  env: DriveEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!env.credentials?.client_email || !env.credentials.private_key)
    return fail(500, "Credenciais do Google Cloud Storage não configuradas.");
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");
  const req = (body ?? {}) as Partial<UploadRequest>;
  if (req.kind !== "attachment" && req.kind !== "inline-image")
    return fail(400, "Tipo de envio inválido.");
  if (typeof req.id !== "string" || !/^[0-9a-f-]{36}$/i.test(req.id))
    return fail(400, "Registro inválido.");

  const target = await callRpc<
    { path: string; name: string; size_bytes: number }[]
  >(
    env,
    fetchImpl,
    authorization,
    req.kind === "attachment"
      ? "attachment_upload_target"
      : "inline_image_upload_target",
    req.kind === "attachment" ? { p_attachment: req.id } : { p_image: req.id },
  );
  const record = target.ok ? target.data[0] : undefined;
  if (!record) return fail(403, "Envio não autorizado ou expirado.");

  const contentType =
    req.kind === "attachment"
      ? attachmentType(record.name)
      : inlineImageTypes.find((t) => t === req.contentType);
  if (!contentType) return fail(400, "Formato de arquivo não permitido.");
  const range = `0,${record.size_bytes}`;
  return {
    status: 200,
    body: {
      url: signGcsUrl(env.credentials, env.bucket, record.path, "PUT", {
        contentType,
        headers: { "x-goog-content-length-range": range },
      }),
      headers: {
        "Content-Type": contentType,
        "x-goog-content-length-range": range,
      },
    },
  };
}

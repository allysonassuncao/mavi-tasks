import { callRpc, signGcsUrl, type DriveEnv } from "./_drive.js";
import {
  attachmentType,
  inlineImageTypes,
  recordedAudioTypes,
} from "../src/upload-types.js";

/**
 * Signs uploads for task attachments and inline images. The client names a
 * record it just prepared (prepare_attachment / prepare_inline_image), never
 * an object path: the database resolves the path, as the requesting user,
 * only for that user's own recent, still-pending record. The signed URL fixes
 * the content type and caps the size at what was declared when preparing.
 *
 * Recorded audio (task descriptions and comments) goes the same way: the
 * draft prepared by prepare_task_audio, with the audio type it declared.
 * So do the receipts of Financeiro › Mídia (prepare_media_receipt) and the
 * files of a returned skill (prepare_skill_review_file), with the
 * attachments' rule for file types.
 *
 * It also deletes task attachments permanently (Armazenamento page): the
 * database removes the record if the caller may (delete_attachment) and
 * returns the object path, which is then removed from the bucket. Audio is
 * removed the same way (delete_task_audio), except that copies of a
 * repeating task share the object: it goes only with the last record.
 */
export type UploadRequest =
  | {
      kind:
        | "attachment"
        | "inline-image"
        | "audio"
        | "media-receipt"
        | "skill-review-file";
      id: string;
      contentType?: string;
    }
  | { action: "delete-attachment" | "delete-audio"; id: string };

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
  const req = (body ?? {}) as {
    kind?: string;
    action?: string;
    id?: unknown;
    contentType?: string;
  };
  if (req.action === "delete-attachment" || req.action === "delete-audio") {
    if (typeof req.id !== "string" || !/^[0-9a-f-]{36}$/i.test(req.id))
      return fail(400, "Registro inválido.");
    const removed = await callRpc<string | null>(
      env,
      fetchImpl,
      authorization,
      req.action === "delete-audio" ? "delete_task_audio" : "delete_attachment",
      req.action === "delete-audio"
        ? { p_audio: req.id }
        : { p_attachment: req.id },
    );
    if (!removed.ok) return fail(removed.status, removed.error);
    // Another copy of the task still plays this audio.
    if (!removed.data)
      return { status: 200, body: { deleted: true, storage: true } };
    // The record is gone either way; a failed object removal only leaves an
    // object that no record points to.
    const res = await fetchImpl(
      signGcsUrl(env.credentials, env.bucket, removed.data, "DELETE"),
      { method: "DELETE" },
    ).catch(() => null);
    return {
      status: 200,
      body: { deleted: true, storage: !!res && (res.ok || res.status === 404) },
    };
  }
  if (
    req.kind !== "attachment" &&
    req.kind !== "inline-image" &&
    req.kind !== "audio" &&
    req.kind !== "media-receipt" &&
    req.kind !== "skill-review-file"
  )
    return fail(400, "Tipo de envio inválido.");
  if (typeof req.id !== "string" || !/^[0-9a-f-]{36}$/i.test(req.id))
    return fail(400, "Registro inválido.");

  const target = await callRpc<
    { path: string; name?: string; mime?: string; size_bytes: number }[]
  >(
    env,
    fetchImpl,
    authorization,
    req.kind === "attachment"
      ? "attachment_upload_target"
      : req.kind === "media-receipt"
        ? "media_receipt_upload_target"
        : req.kind === "skill-review-file"
          ? "skill_review_file_upload_target"
          : req.kind === "audio"
            ? "task_audio_upload_target"
            : "inline_image_upload_target",
    req.kind === "attachment"
      ? { p_attachment: req.id }
      : req.kind === "media-receipt"
        ? { p_receipt: req.id }
        : req.kind === "skill-review-file"
          ? { p_file: req.id }
          : req.kind === "audio"
            ? { p_audio: req.id }
            : { p_image: req.id },
  );
  const record = target.ok ? target.data[0] : undefined;
  if (!record) return fail(403, "Envio não autorizado ou expirado.");

  const contentType =
    req.kind === "attachment" ||
    req.kind === "media-receipt" ||
    req.kind === "skill-review-file"
      ? attachmentType(record.name ?? "")
      : req.kind === "audio"
        ? recordedAudioTypes.find((t) => t === record.mime)
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

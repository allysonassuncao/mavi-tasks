import { rpc, invalidateTaskExtras } from "./api";
import { supabase } from "./supabase";
import { uploadToGcs } from "./gcs";
import type { Attachment } from "./types";
import { ATTACHMENT_MAX_BYTES, attachmentType } from "./upload-types";
export const ATTACHMENT_HINT =
  "Qualquer arquivo de até 100 MB (menos programas, como .exe ou .apk)";
export function validateAttachment(file: Pick<File, "name" | "size">) {
  if (file.size === 0 || file.size > ATTACHMENT_MAX_BYTES)
    throw Error(`${file.name}: escolha um arquivo não vazio de até 100 MB.`);
  const type = attachmentType(file.name);
  if (!type)
    throw Error(
      `${file.name}: por segurança, programas e scripts (.exe, .bat, .sh, .apk…) não podem ser anexados. Compacte em ZIP se precisar enviar.`,
    );
  return type;
}
export async function uploadAttachment(taskId: string, file: File) {
  const contentType = validateAttachment(file);
  if (!supabase) throw Error("Conecte o Supabase para enviar arquivos.");
  const attachment: Attachment = await rpc("prepare_attachment", {
    p_task: taskId,
    p_name: file.name,
    p_size: file.size,
  });
  try {
    await uploadToGcs(
      { kind: "attachment", id: attachment.id },
      file,
      contentType,
    );
    invalidateTaskExtras(taskId);
  } catch (error) {
    try {
      await rpc("discard_pending_attachment", { p_attachment: attachment.id });
    } catch {
      /* Keep metadata when upload outcome is uncertain. */
    }
    throw error;
  }
  return attachment;
}
/** Keep the saved task and completed uploads when retrying a partial failure. */
export type TaskUploadState = { taskId?: string; pending: File[] };
export async function saveTaskWithAttachments(
  state: TaskUploadState,
  create: () => Promise<string>,
  upload: (id: string, file: File) => Promise<unknown>,
  changed: () => void,
) {
  if (!state.taskId) {
    state.taskId = await create();
    changed();
  }
  while (state.pending.length) {
    await upload(state.taskId, state.pending[0]);
    state.pending.shift();
    changed();
  }
}
/**
 * Deletes a task attachment permanently (Armazenamento page): the server
 * (api/_uploads.ts) asks the database, then removes the object.
 */
export async function deleteAttachment(id: string) {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token) throw Error("Entre novamente para excluir arquivos.");
  const res = await fetch("/api/gcs/sign-upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: "delete-attachment", id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "Não foi possível excluir o anexo.");
}

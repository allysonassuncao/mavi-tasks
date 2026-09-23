import { rpc, invalidateTaskExtras } from "./api";
import { supabase } from "./supabase";
import { uploadToGcs } from "./gcs";
import type { Attachment } from "./types";
import { attachmentType, attachmentTypes } from "./upload-types";
export const attachmentAccept = Object.keys(attachmentTypes)
  .map((ext) => `.${ext}`)
  .join(",");
export function validateAttachment(file: Pick<File, "name" | "size">) {
  if (file.size === 0 || file.size > 20971520)
    throw Error(`${file.name}: escolha um arquivo não vazio de até 20 MB.`);
  const type = attachmentType(file.name);
  if (!type)
    throw Error(
      `${file.name}: formato não permitido. Use PDF, imagem, TXT, CSV, ZIP ou documentos do Office.`,
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

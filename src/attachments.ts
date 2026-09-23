import { rpc, invalidateTaskExtras } from "./api";
import { supabase } from "./supabase";
import { uploadToGcs } from "./gcs";
import type { Attachment } from "./types";
const mimeByExtension: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const attachmentAccept = Object.keys(mimeByExtension)
  .map((ext) => `.${ext}`)
  .join(",");
export function validateAttachment(file: Pick<File, "name" | "size">) {
  if (file.size === 0 || file.size > 20971520)
    throw Error(`${file.name}: escolha um arquivo não vazio de até 20 MB.`);
  const type = mimeByExtension[file.name.split(".").pop()?.toLowerCase() ?? ""];
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
    await uploadToGcs(attachment.path, file, contentType);
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

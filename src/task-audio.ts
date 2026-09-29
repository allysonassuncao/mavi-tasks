import { invalidateTaskExtras, rpc } from "./api";
import { uploadToGcs } from "./gcs";
import { supabase } from "./supabase";

/**
 * Áudios das tarefas (migration 20261201090000_task_audio): gravados no
 * navegador, enviados ao GCS como rascunho, transcritos (e, na descrição,
 * resumidos) pela MAVI e então ligados à tarefa ou a um comentário.
 */
export type AudioStatus =
  | "uploading"
  | "transcribing"
  | "summarizing"
  | "ready"
  | "empty"
  | "failed";
export interface TaskAudio {
  id: string;
  company_id: string;
  task_id: string | null;
  comment_id: string | null;
  purpose: "description" | "comment";
  uploaded_by: string;
  path: string;
  mime: string;
  size_bytes: number;
  duration_seconds: number;
  position: number;
  status: AudioStatus;
  transcript: string | null;
  summary: string | null;
  error: string | null;
  edited_by: string | null;
  edited_at: string | null;
  status_at: string;
  created_at: string;
}

/** Cada gravação: até 5 minutos (aviso a partir de 4:30). */
export const AUDIO_MAX_SECONDS = 300;
export const AUDIO_WARN_SECONDS = 270;
/** Fala: 32 kbps basta e deixa 5 minutos em ~1,2 MB. */
export const AUDIO_BITS_PER_SECOND = 32_000;
/** Sem resposta do servidor depois disso, o áudio pode ser pedido de novo. */
const STALE_MS = 5 * 60 * 1000;

/** O formato que este navegador grava (Chrome/Firefox: WebM; Safari: MP4). */
export function pickRecorderMime(
  supported: (type: string) => boolean = (t) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
) {
  return (
    [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ].find(supported) ?? ""
  );
}
/** O tipo guardado (sem os codecs). */
export const baseMime = (mime: string) =>
  mime.split(";")[0].trim().toLowerCase() || "audio/webm";

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A MAVI ainda está trabalhando (e não travou). */
export function audioWorking(a: Pick<TaskAudio, "status" | "status_at">, now = Date.now()) {
  return (
    (a.status === "transcribing" || a.status === "summarizing") &&
    now - new Date(a.status_at).getTime() < STALE_MS
  );
}
/** Pode pedir de novo: falhou, travou, ou o resumo não saiu. */
export function audioRetryable(
  a: Pick<TaskAudio, "status" | "status_at" | "purpose" | "summary" | "error">,
  now = Date.now(),
) {
  if (a.status === "failed") return true;
  if (a.status === "transcribing" || a.status === "summarizing")
    return !audioWorking(a, now);
  return (
    a.status === "ready" &&
    a.purpose === "description" &&
    !a.summary &&
    !!a.error
  );
}

/** O que o Assistente MAVI lê dos áudios da descrição. */
export function audioTranscripts(audios: Pick<TaskAudio, "transcript">[]) {
  return audios
    .map((a, i) => (a.transcript ? `Áudio ${i + 1}: ${a.transcript}` : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);
}

/** Grava o rascunho: prepara, envia ao GCS e confirma. */
export async function uploadRecordedAudio(
  company: string,
  purpose: TaskAudio["purpose"],
  blob: Blob,
  mime: string,
  seconds: number,
): Promise<TaskAudio> {
  if (!supabase) throw Error("Conecte o Supabase para gravar áudios.");
  const type = baseMime(mime);
  const draft: TaskAudio = await rpc("prepare_task_audio", {
    p_company: company,
    p_purpose: purpose,
    p_mime: type,
    p_size: blob.size,
    p_duration: Math.min(Math.max(seconds, 0.5), AUDIO_MAX_SECONDS),
  });
  try {
    await uploadToGcs({ kind: "audio", id: draft.id }, blob, type);
  } catch (e) {
    await deleteAudio(draft.id).catch(() => {});
    throw e;
  }
  return rpc("confirm_task_audio", { p_audio: draft.id });
}

async function token() {
  const t = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!t) throw Error("Entre novamente para continuar.");
  return t;
}
async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await token()}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "Não foi possível falar com o servidor.");
  return data;
}

/**
 * A MAVI transcreve (e resume, na descrição). Volta com o áudio como ficou;
 * `contract` escolhe o cliente de um rascunho (as regras do Painel da MAVI).
 */
export async function processAudio(id: string, contract?: string | null) {
  const data = await post("/api/drive", {
    action: "task-audio",
    op: "work",
    audio: id,
    contract: contract ?? null,
  });
  return data.audio as TaskAudio;
}

/** A transcrição corrigida (o resumo é refeito). */
export async function editAudioTranscript(id: string, transcript: string) {
  const data = await post("/api/drive", {
    action: "task-audio",
    op: "edit",
    audio: id,
    transcript,
  });
  return data.audio as TaskAudio;
}

/** Tira o áudio (o arquivo sai do GCS quando nenhuma cópia o usa mais). */
export async function deleteAudio(id: string) {
  await post("/api/gcs/sign-upload", { action: "delete-audio", id });
}

/** Os rascunhos entram na descrição da tarefa, nesta ordem. */
export async function bindAudios(task: string, ids: string[]) {
  if (!ids.length) return [];
  const rows: TaskAudio[] = await rpc("bind_task_audios", {
    p_task: task,
    p_audios: ids,
  });
  invalidateTaskExtras(task);
  return rows;
}

/** Um comentário com áudio (o texto é opcional). */
export async function addAudioComment(
  task: string,
  body: string,
  parent: string | null,
  audio: string,
) {
  const comment = await rpc("add_audio_comment", {
    p_task: task,
    p_body: body,
    p_parent: parent,
    p_audio: audio,
  });
  invalidateTaskExtras(task);
  return comment;
}

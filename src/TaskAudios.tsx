import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Mic, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { Button, Skeleton } from "./ui";
import { AudioPlayer } from "./AudioPlayer";
import { AudioRecorder, type Recording } from "./AudioRecorder";
import { getGcsPublicUrl } from "./gcs";
import {
  audioRetryable,
  audioWorking,
  bindAudios,
  deleteAudio,
  editAudioTranscript,
  formatDuration,
  processAudio,
  uploadRecordedAudio,
  type TaskAudio,
} from "./task-audio";
import "./task-audio.css";

type Pending = { key: string; seconds: number; error?: string };

/**
 * The audios of a task description, in two situations:
 * - creating a task (`task` null): drafts kept here, transcribed while the
 *   form is still open, and bound to the task once it is saved (bindTo);
 * - an existing task: each recording is bound at once and the list comes
 *   from the task's details (`audios`), refreshed by `onChanged` and by the
 *   live notices.
 */
export function useTaskAudios({
  company,
  task,
  contract,
  audios,
  onChanged,
  onError,
}: {
  company: string;
  task: string | null;
  /** The product chosen in the form: which client the MAVI rules follow. */
  contract?: string | null;
  audios?: TaskAudio[];
  onChanged?: () => void;
  onError: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<TaskAudio[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  // What the server returned last, while the task's details catch up.
  const [latest, setLatest] = useState<Record<string, TaskAudio>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const contractRef = useRef(contract);
  contractRef.current = contract;

  const put = useCallback(
    (a: TaskAudio) => {
      if (!alive.current) return;
      if (a.task_id) setLatest((m) => ({ ...m, [a.id]: a }));
      setDrafts((d) => d.map((x) => (x.id === a.id ? a : x)));
    },
    [],
  );
  const work = useCallback(
    async (a: TaskAudio) => {
      try {
        put(await processAudio(a.id, contractRef.current));
      } catch (e) {
        put({ ...a, status: a.transcript ? "ready" : "failed", error: (e as Error).message });
      } finally {
        onChanged?.();
      }
    },
    [put, onChanged],
  );

  async function add(r: Recording) {
    const key = crypto.randomUUID();
    setPending((p) => [...p, { key, seconds: r.seconds }]);
    try {
      let a = await uploadRecordedAudio(company, "description", r.blob, r.mime, r.seconds);
      if (task) {
        [a] = await bindAudios(task, [a.id]);
        put(a);
        onChanged?.();
      } else if (alive.current) setDrafts((d) => [...d, a]);
      if (alive.current) setPending((p) => p.filter((x) => x.key !== key));
      void work(a);
    } catch (e) {
      if (alive.current)
        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, error: (e as Error).message } : x)),
        );
    }
  }
  // Once in the details, an audio missing from them was removed.
  const seen = useRef(new Set<string>());
  for (const a of audios ?? []) seen.current.add(a.id);
  const items: TaskAudio[] = task
    ? [
        ...(audios ?? [])
          .filter((a) => !a.comment_id)
          .map((a) => {
            const l = latest[a.id];
            // The newer of the two (the details may still be the old row).
            return l && new Date(l.status_at) >= new Date(a.status_at) ? l : a;
          }),
        // Just recorded: shown before the details reload.
        ...Object.values(latest).filter(
          (l) =>
            l.task_id === task &&
            !l.comment_id &&
            !seen.current.has(l.id),
        ),
      ]
    : drafts;

  return {
    items,
    pending,
    /** Still sending a recording: the task can't be saved with it yet. */
    uploading: pending.some((p) => !p.error),
    add,
    dismissPending: (key: string) => setPending((p) => p.filter((x) => x.key !== key)),
    retry: (a: TaskAudio) => {
      put({ ...a, status: a.transcript ? "summarizing" : "transcribing", status_at: new Date().toISOString(), error: null });
      void work(a);
    },
    async edit(a: TaskAudio, text: string) {
      put({ ...a, transcript: text, summary: null, status: "summarizing", status_at: new Date().toISOString() });
      try {
        put(await editAudioTranscript(a.id, text));
      } catch (e) {
        put(a);
        onError((e as Error).message);
      } finally {
        onChanged?.();
      }
    },
    async remove(a: TaskAudio) {
      try {
        await deleteAudio(a.id);
        if (alive.current) {
          setDrafts((d) => d.filter((x) => x.id !== a.id));
          setLatest(({ [a.id]: _gone, ...rest }) => rest);
        }
        onChanged?.();
      } catch (e) {
        onError((e as Error).message);
      }
    },
    /** Creation: the drafts go into the task just saved. */
    async bindTo(taskId: string) {
      const ids = drafts.map((d) => d.id);
      if (!ids.length) return;
      await bindAudios(taskId, ids);
      if (alive.current) setDrafts([]);
    },
    /** Creation closed without saving: the drafts are thrown away. */
    discardAll() {
      for (const d of drafts) void deleteAudio(d.id).catch(() => {});
      setDrafts([]);
    },
  };
}
export type TaskAudiosState = ReturnType<typeof useTaskAudios>;

/**
 * The description's audios. Recording belongs to writing the request: the
 * recorder shows only where the task is created or edited (`canRecord`);
 * on the task itself the audios are there to listen to.
 */
export function TaskAudioList({
  state,
  canManage,
  canRecord = canManage,
  demo,
  disabled,
  nameOf,
  onRecording,
}: {
  state: TaskAudiosState;
  /** Correct the transcript, try again and remove. */
  canManage: boolean;
  /** Record a new audio (creation and edit forms). */
  canRecord?: boolean;
  demo?: boolean;
  disabled?: boolean;
  nameOf: (user: string) => string;
  onRecording?: (active: boolean) => void;
}) {
  const { items, pending } = state;
  if (!items.length && !pending.length && !canRecord) return null;
  return (
    <section className="task-audios" aria-label="Áudios da descrição">
      {items.map((a, i) => (
        <AudioCard
          key={a.id}
          audio={a}
          label={`Áudio ${i + 1}`}
          canManage={canManage}
          nameOf={nameOf}
          onRetry={() => state.retry(a)}
          onEdit={(text) => state.edit(a, text)}
          onDelete={() => state.remove(a)}
        />
      ))}
      {pending.map((p) => (
        <div className="audio-card pending" key={p.key} role="status">
          <header>
            <Mic size={14} /> Áudio {items.length + 1} · {formatDuration(p.seconds)}
          </header>
          {p.error ? (
            <p className="audio-status failed">
              <AlertCircle size={14} />
              <span>{p.error}</span>
              <button type="button" onClick={() => state.dismissPending(p.key)}>
                Fechar
              </button>
            </p>
          ) : (
            <p className="audio-status working">
              <Skeleton className="skeleton-line" /> Enviando o áudio…
            </p>
          )}
        </div>
      ))}
      {canRecord &&
        (demo ? (
          <small className="audio-hint">
            A gravação de áudios funciona no ambiente conectado.
          </small>
        ) : (
          <div className="task-audios-add">
            <AudioRecorder
              onUse={(r) => state.add(r)}
              disabled={disabled}
              label={items.length ? "Gravar outro áudio" : "Gravar áudio"}
              onActiveChange={onRecording}
            />
            {!items.length && !pending.length && (
              <small className="audio-hint">
                Explique falando, em até 5 minutos. A MAVI transcreve e resume em tópicos.
              </small>
            )}
          </div>
        ))}
    </section>
  );
}

/**
 * One audio: the player, what the MAVI did with it (transcribing, the
 * summary and the full transcript) and, for whoever looks after it,
 * correcting the transcript, trying again and removing.
 */
export function AudioCard({
  audio: a,
  label,
  canManage,
  nameOf,
  onRetry,
  onEdit,
  onDelete,
  variant = "description",
}: {
  audio: TaskAudio;
  label: string;
  canManage: boolean;
  nameOf: (user: string) => string;
  onRetry: () => void;
  onEdit: (text: string) => Promise<void>;
  onDelete: () => Promise<void>;
  variant?: "description" | "comment";
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const url = getGcsPublicUrl(a.path);
  const working = audioWorking(a);
  const retry = canManage && audioRetryable(a);
  const points = (a.summary ?? "")
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  const comment = variant === "comment";

  async function remove() {
    if (!window.confirm(comment ? "Remover este áudio do comentário?" : `Remover o ${label.toLowerCase()} da descrição?`))
      return;
    setRemoving(true);
    try {
      await onDelete();
    } finally {
      setRemoving(false);
    }
  }
  async function save() {
    if (editing === null) return;
    setSaving(true);
    try {
      await onEdit(editing);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  }
  function download() {
    const link = document.createElement("a");
    link.href = url;
    link.download = `${label}.${a.mime === "audio/mp4" ? "m4a" : a.mime.split("/")[1]}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
  }

  return (
    <article className={`audio-card${comment ? " in-comment" : ""}`}>
      {!comment && (
        <header>
          <Mic size={14} /> {label} · {formatDuration(a.duration_seconds)}
          {canManage && (
            <Button
              type="button"
              className="icon-btn audio-remove"
              onClick={() => void remove()}
              loading={removing}
              aria-label={`Remover ${label.toLowerCase()}`}
              title="Remover áudio"
            >
              <Trash2 size={15} />
            </Button>
          )}
        </header>
      )}
      <div className="audio-card-player">
        <AudioPlayer src={url} duration={a.duration_seconds} label={label.toLowerCase()} onDownload={comment ? undefined : download} />
        {comment && canManage && (
          <Button
            type="button"
            className="icon-btn audio-remove"
            onClick={() => void remove()}
            loading={removing}
            aria-label="Remover áudio do comentário"
            title="Remover áudio"
          >
            <Trash2 size={15} />
          </Button>
        )}
      </div>
      {a.status === "uploading" ? (
        <p className="audio-status failed">
          <AlertCircle size={14} />
          <span>O envio deste áudio não terminou.</span>
        </p>
      ) : working && a.status === "transcribing" ? (
        <p className="audio-status working" role="status">
          <Sparkles size={14} /> A MAVI está transcrevendo…
        </p>
      ) : a.status === "empty" ? (
        <p className="audio-status muted-status">A MAVI não ouviu fala neste áudio.</p>
      ) : !a.transcript ? (
        retry && (
          <p className="audio-status failed" role="alert">
            <AlertCircle size={14} />
            <span>{a.error ?? "A MAVI não conseguiu transcrever este áudio."}</span>
            <button type="button" onClick={onRetry}>
              <RotateCcw size={13} /> Tentar de novo
            </button>
          </p>
        )
      ) : editing !== null ? (
        <div className="audio-edit">
          <label>
            Corrigir a transcrição
            <textarea
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              rows={Math.min(10, Math.max(3, Math.ceil(editing.length / 70)))}
              maxLength={20000}
              autoFocus
            />
          </label>
          {!comment && <small>A MAVI refaz o resumo com o texto corrigido.</small>}
          <div className="audio-edit-actions">
            <Button type="button" className="btn secondary" onClick={() => setEditing(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button type="button" className="btn primary" onClick={() => void save()} loading={saving}>
              Salvar
            </Button>
          </div>
        </div>
      ) : (
        <>
          {!comment &&
            (a.status === "summarizing" && working ? (
              <p className="audio-status working" role="status">
                <Sparkles size={14} /> A MAVI está resumindo…
              </p>
            ) : points.length ? (
              <div className="audio-summary">
                <strong>
                  <Sparkles size={13} /> Resumo da MAVI
                </strong>
                <ul>
                  {points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : (
              retry && (
                <p className="audio-status failed">
                  <AlertCircle size={14} />
                  <span>{a.error ?? "O resumo não saiu."}</span>
                  <button type="button" onClick={onRetry}>
                    <RotateCcw size={13} /> Tentar de novo
                  </button>
                </p>
              )
            ))}
          <details className="audio-transcript" open={!comment && !points.length && !working}>
            <summary>{comment ? "Ver transcrição" : "Transcrição completa"}</summary>
            <p>{a.transcript}</p>
            <div className="audio-transcript-foot">
              {a.edited_by && (
                <small>Corrigida por {nameOf(a.edited_by)}</small>
              )}
              {canManage && !working && (
                <button type="button" onClick={() => setEditing(a.transcript ?? "")}>
                  Corrigir transcrição
                </button>
              )}
            </div>
          </details>
        </>
      )}
    </article>
  );
}

/** A recording chosen in the comment composer, before it is sent. */
export function RecordingPreview({
  recording,
  onRemove,
  disabled,
}: {
  recording: Recording;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const url = useMemo(() => URL.createObjectURL(recording.blob), [recording.blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="audio-card-player recording-preview">
      <AudioPlayer src={url} duration={recording.seconds} label="áudio gravado" />
      <Button
        type="button"
        className="icon-btn"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Tirar o áudio do comentário"
        title="Tirar o áudio"
      >
        <X size={15} />
      </Button>
    </div>
  );
}

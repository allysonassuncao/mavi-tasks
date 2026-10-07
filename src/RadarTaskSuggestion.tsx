import { useEffect, useState } from "react";
import { Link2, Plus, RotateCcw, Sparkles, X } from "lucide-react";
import { Button, Textarea } from "./ui";
import { statuses, type Status } from "./types";
import {
  SUGGESTION_REASONS,
  dismissSuggestion,
  loadSuggestion,
  suggestionLine,
  undoAutoTask,
  undoUntil,
  type SuggestionReason,
  type TaskSuggestion,
} from "./radar-task-learning";
import "./radar-task-learning.css";

/**
 * O motivo (pronto + comentário) para recusar a sugestão ou desfazer a
 * tarefa criada sozinha pela MAVI. "Outro motivo" pede o comentário.
 */
export function ReasonPicker({
  question,
  confirm,
  busy,
  onCancel,
  onConfirm,
}: {
  question: string;
  confirm: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: SuggestionReason, note: string) => void;
}) {
  const [reason, setReason] = useState<SuggestionReason | "">("");
  const [note, setNote] = useState("");
  return (
    <div className="radar-suggestion-refuse">
      <span>{question}</span>
      <div className="radar-suggestion-reasons" role="radiogroup" aria-label="Motivo">
        {SUGGESTION_REASONS.map((r) => (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={reason === r.value}
            className={reason === r.value ? "selected" : ""}
            onClick={() => setReason(r.value)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <Textarea
        rows={2}
        maxLength={1000}
        value={note}
        placeholder={reason === "other" ? "Conte o motivo" : "Comentário (opcional)"}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="radar-suggestion-actions">
        <Button className="btn quiet compact" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button
          className="btn secondary compact"
          loading={busy}
          disabled={!reason || (reason === "other" && note.trim().length < 3)}
          onClick={() => reason && onConfirm(reason, note.trim())}
        >
          {confirm}
        </Button>
      </div>
    </div>
  );
}

/**
 * A tarefa sugerida pela MAVI no item do Radar (migration 20270608090000):
 * criar pelo formulário preenchido com a sugestão, vincular a tarefa aberta
 * que ela achou, ou recusar com um motivo (a MAVI aprende com a recusa).
 * Criada sozinha (Fase 4, migration 20270609090000): a tarefa e o "Desfazer"
 * nas primeiras 24 h. Só para quem edita o item.
 */
export function RadarTaskSuggestionCard({
  company,
  item,
  onCreate,
  onLink,
  onUndone,
  notify,
}: {
  company: string;
  item: string;
  /** Abre o formulário de tarefa preenchido com a sugestão. */
  onCreate?: (s: TaskSuggestion) => void;
  /** Vincula a tarefa aberta sugerida. */
  onLink?: (task: string) => Promise<void>;
  /** A tarefa criada sozinha foi desfeita (o item recarrega). */
  onUndone?: () => void;
  notify?: (message: string) => void;
}) {
  const [s, setS] = useState<TaskSuggestion | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      loadSuggestion(company, item)
        .then((x) => alive && setS(x))
        .catch(() => alive && setS(null));
    void load();
    // A MAVI terminou de decidir (Realtime, sem consultas periódicas).
    const on = (e: Event) => {
      if ((e as CustomEvent<{ item?: string }>).detail?.item === item) void load();
    };
    window.addEventListener("mavi:radar-task-suggestion", on);
    return () => {
      alive = false;
      window.removeEventListener("mavi:radar-task-suggestion", on);
    };
  }, [company, item]);

  const auto = s?.status === "auto" && !!s.undo_until;
  if (!s || (!auto && (s.status !== "open" || (s.decision !== "task" && s.decision !== "link")))) return null;

  async function run(fn: () => Promise<unknown>, done: () => void) {
    setBusy(true);
    setError("");
    try {
      await fn();
      done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const refuse = (reason: SuggestionReason, note: string) =>
    run(
      async () => setS(await dismissSuggestion(company, item, reason, note)),
      () => {
        setAsking(false);
        notify?.("Sugestão recusada. A MAVI aprende com o motivo.");
      },
    );
  const undo = (reason: SuggestionReason, note: string) =>
    run(
      async () => setS(await undoAutoTask(company, item, reason, note)),
      () => {
        setAsking(false);
        onUndone?.();
        notify?.("Tarefa desfeita e arquivada. A MAVI conta como erro e aprende com o motivo.");
      },
    );
  const link = () =>
    s.link_task_id && onLink
      ? run(
          () => onLink(s.link_task_id!),
          () => setS({ ...s, status: "created" }),
        )
      : undefined;
  const linked = s.link_task_status ? statuses[s.link_task_status as Status] : null;

  return (
    <div className={`radar-suggestion${auto ? " auto" : ""}`} role="region" aria-label="Tarefa sugerida pela MAVI">
      <div className="radar-suggestion-head">
        <Sparkles size={14} aria-hidden="true" />
        <span>
          {auto
            ? "A MAVI criou a tarefa sozinha"
            : s.decision === "link"
              ? "A MAVI sugere vincular uma tarefa"
              : "Tarefa sugerida pela MAVI"}
        </span>
      </div>
      {auto ? (
        <p className="radar-suggestion-text">
          <strong>“{s.task_title ?? s.title}”</strong>
          {s.task_assignee_name ? ` para ${s.task_assignee_name}` : ""}. Se não fazia sentido, desfaça{" "}
          {undoUntil(s.undo_until)}: a tarefa é arquivada e a MAVI aprende com o motivo.
        </p>
      ) : s.decision === "task" ? (
        <>
          <strong className="radar-suggestion-title">{s.title}</strong>
          <p className="radar-suggestion-line">{suggestionLine(s)}</p>
          {s.description && <p className="radar-suggestion-text">{s.description}</p>}
        </>
      ) : (
        <p className="radar-suggestion-text">
          Já existe a tarefa <strong>“{s.link_task_title}”</strong>
          {linked && <span style={{ color: linked.color }}> · {linked.label}</span>} que trata disso.
        </p>
      )}
      {(s.why || s.rule_condition) && (
        <p className="radar-suggestion-why">
          {s.why}
          {s.rule_condition && <span> Regra em uso: “{s.rule_condition}”.</span>}
        </p>
      )}
      {s.auto_note && !auto && (
        <p className="radar-suggestion-why">
          Não criou sozinha: {s.auto_note.replace(/^A MAVI não criou sozinha: /, "")}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {asking ? (
        <ReasonPicker
          question={auto ? "Por que desfazer?" : "Por que não?"}
          confirm={auto ? "Desfazer tarefa" : "Recusar sugestão"}
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={auto ? undo : refuse}
        />
      ) : (
        <div className="radar-suggestion-actions">
          {!auto && s.decision === "task" && onCreate && (
            <Button className="btn primary compact" onClick={() => onCreate(s)}>
              <Plus size={14} aria-hidden="true" /> Criar tarefa
            </Button>
          )}
          {!auto && s.decision === "link" && onLink && (
            <Button className="btn primary compact" loading={busy} onClick={link}>
              <Link2 size={14} aria-hidden="true" /> Vincular
            </Button>
          )}
          <Button className="btn quiet compact" onClick={() => setAsking(true)}>
            {auto ? <RotateCcw size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}{" "}
            {auto ? "Desfazer" : "Recusar"}
          </Button>
        </div>
      )}
    </div>
  );
}

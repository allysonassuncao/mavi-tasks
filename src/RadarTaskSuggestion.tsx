import { useEffect, useState } from "react";
import { Link2, Plus, Sparkles, X } from "lucide-react";
import { Button, Textarea } from "./ui";
import { statuses, type Status } from "./types";
import {
  SUGGESTION_REASONS,
  dismissSuggestion,
  loadSuggestion,
  suggestionLine,
  type SuggestionReason,
  type TaskSuggestion,
} from "./radar-task-learning";
import "./radar-task-learning.css";

/**
 * A tarefa sugerida pela MAVI no item do Radar (migration 20270608090000):
 * criar pelo formulário preenchido com a sugestão, vincular a tarefa aberta
 * que ela achou, ou recusar com um motivo (a MAVI aprende com a recusa). Só
 * para quem edita o item; sem sugestão em aberto, não aparece.
 */
export function RadarTaskSuggestionCard({
  company,
  item,
  onCreate,
  onLink,
  notify,
}: {
  company: string;
  item: string;
  /** Abre o formulário de tarefa preenchido com a sugestão. */
  onCreate?: (s: TaskSuggestion) => void;
  /** Vincula a tarefa aberta sugerida. */
  onLink?: (task: string) => Promise<void>;
  notify?: (message: string) => void;
}) {
  const [s, setS] = useState<TaskSuggestion | null>(null);
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState<SuggestionReason | "">("");
  const [note, setNote] = useState("");
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

  if (!s || s.status !== "open" || (s.decision !== "task" && s.decision !== "link")) return null;

  async function refuse() {
    if (!reason) return;
    setBusy(true);
    setError("");
    try {
      setS(await dismissSuggestion(company, item, reason, note.trim()));
      setRefusing(false);
      notify?.("Sugestão recusada. A MAVI aprende com o motivo.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function link() {
    if (!s?.link_task_id || !onLink) return;
    setBusy(true);
    setError("");
    try {
      await onLink(s.link_task_id);
      setS({ ...s, status: "created" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const linked = s.link_task_status ? statuses[s.link_task_status as Status] : null;

  return (
    <div className="radar-suggestion" role="region" aria-label="Tarefa sugerida pela MAVI">
      <div className="radar-suggestion-head">
        <Sparkles size={14} aria-hidden="true" />
        <span>{s.decision === "link" ? "A MAVI sugere vincular uma tarefa" : "Tarefa sugerida pela MAVI"}</span>
      </div>
      {s.decision === "task" ? (
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
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {refusing ? (
        <div className="radar-suggestion-refuse">
          <span>Por que não?</span>
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
            <Button className="btn quiet compact" onClick={() => setRefusing(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              className="btn secondary compact"
              loading={busy}
              disabled={!reason || (reason === "other" && note.trim().length < 3)}
              onClick={refuse}
            >
              Recusar sugestão
            </Button>
          </div>
        </div>
      ) : (
        <div className="radar-suggestion-actions">
          {s.decision === "task" && onCreate && (
            <Button className="btn primary compact" onClick={() => onCreate(s)}>
              <Plus size={14} aria-hidden="true" /> Criar tarefa
            </Button>
          )}
          {s.decision === "link" && onLink && (
            <Button className="btn primary compact" loading={busy} onClick={link}>
              <Link2 size={14} aria-hidden="true" /> Vincular
            </Button>
          )}
          <Button className="btn quiet compact" onClick={() => setRefusing(true)}>
            <X size={14} aria-hidden="true" /> Recusar
          </Button>
        </div>
      )}
    </div>
  );
}

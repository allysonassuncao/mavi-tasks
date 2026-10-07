import { useEffect, useState } from "react";
import { Radar, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "./ui";
import { appPath, openInApp } from "./temperature";
import { taskOrigin, undoAutoTask, undoUntil, type TaskOrigin } from "./radar-task-learning";
import { ReasonPicker } from "./RadarTaskSuggestion";
import "./radar-task-learning.css";

/**
 * Na tarefa: de qual item do Radar do cliente ela veio e, quando a MAVI a
 * criou sozinha (migration 20270609090000), o selo "Criada pelo Radar" e o
 * "Desfazer" nas primeiras 24 h (quem edita o item ou o responsável). Sem
 * ligação com o Radar, não aparece.
 */
export function RadarTaskOriginRow({
  company,
  task,
  onUndone,
  notify,
}: {
  company: string;
  task: string;
  /** A tarefa foi desfeita (arquivada): o detalhe fecha. */
  onUndone?: () => void;
  notify?: (message: string) => void;
}) {
  const [o, setO] = useState<TaskOrigin | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    taskOrigin(company, task)
      .then((x) => alive && setO(x))
      .catch(() => alive && setO(null));
    return () => {
      alive = false;
    };
  }, [company, task]);
  if (!o) return null;
  const path = `/radar?item=${o.item_id}`;
  async function undo(reason: Parameters<typeof undoAutoTask>[2], note: string) {
    if (!o) return;
    setBusy(true);
    setError("");
    try {
      await undoAutoTask(company, o.item_id, reason, note);
      setAsking(false);
      notify?.("Tarefa desfeita e arquivada. A MAVI conta como erro e aprende com o motivo.");
      onUndone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="property-row radar-origin-row">
      <span className="property-label">
        <Radar size={15} /> Radar do cliente
      </span>
      <div className="property-value radar-origin">
        <span>
          {o.auto && (
            <span className="radar-suggest-chip" title={o.rule_condition ? `Regra em uso: ${o.rule_condition}` : undefined}>
              <Sparkles size={11} aria-hidden="true" /> {o.status === "undone" ? "Desfeita" : "Criada pelo Radar"}
            </span>
          )}{" "}
          <a
            href={appPath(path)}
            onClick={(e) => {
              e.preventDefault();
              openInApp(path);
            }}
          >
            {o.item_title}
          </a>
        </span>
        {o.can_undo &&
          (asking ? (
            <ReasonPicker
              question="Por que desfazer?"
              confirm="Desfazer tarefa"
              busy={busy}
              onCancel={() => setAsking(false)}
              onConfirm={undo}
            />
          ) : (
            <Button className="btn quiet compact" onClick={() => setAsking(true)}>
              <RotateCcw size={13} aria-hidden="true" /> Desfazer {undoUntil(o.undo_until)}
            </Button>
          ))}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

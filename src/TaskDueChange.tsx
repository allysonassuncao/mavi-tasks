import { useState, type FormEvent } from "react";
import { Check, PencilLine } from "lucide-react";
import { Button, Textarea } from "./ui";
import { Modal } from "./components";
import { DateInput } from "./DateInput";
import { AbsenceNote } from "./DueRuleHint";
import { dateLabel } from "./domain";
import type { Snapshot, Task } from "./types";
import {
  DUE_REASON_MAX,
  DUE_REASON_MIN,
  canChangeDue,
  dueChangeError,
} from "./task-due";
import "./task-due.css";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * O prazo nas propriedades da tarefa. Quem pode (task-due.ts) clica para
 * mudar só a data, com o motivo, que fica no histórico e nos Dashboards.
 */
export function TaskDueValue({
  task,
  data,
  user,
  late,
  mutate,
  notify,
}: {
  task: Task;
  data: Snapshot;
  user: string;
  late: boolean;
  mutate: Mutate;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const can = !task.archived && canChangeDue(data, task, user);
  return (
    <div className={`property-value${late ? " late" : ""}`}>
      {can ? (
        <button
          type="button"
          className="property-button"
          title="Mudar o prazo"
          onClick={() => setOpen(true)}
        >
          {dateLabel(task.due_date)}
          <PencilLine size={14} />
        </button>
      ) : (
        dateLabel(task.due_date)
      )}
      {late && <small className="late">atrasada</small>}
      {task.due_smart && !late && <small>pela MAVI</small>}
      {open && (
        <DueChangeModal
          task={task}
          data={data}
          mutate={mutate}
          notify={notify}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function DueChangeModal({
  task,
  data,
  mutate,
  notify,
  onClose,
}: {
  task: Task;
  data: Snapshot;
  mutate: Mutate;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [due, setDue] = useState(task.due_date);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = dueChangeError(task, due, reason);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await mutate("set_task_due", {
        p_task: task.id,
        p_version: task.version,
        p_due: due,
        p_reason: reason.trim(),
      });
      notify("Prazo alterado.");
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <Modal title="Mudar o prazo" onClose={onClose} busy={saving}>
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          <p className="due-change-intro">
            Prazo atual: <strong>{dateLabel(task.due_date)}</strong> Só a data muda: status e
            aprovações continuam como estão. O motivo fica no histórico da tarefa e a mudança
            conta nos Dashboards.
          </p>
          <label>
            Novo prazo
            <DateInput
              name="due"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              min={task.start_date ?? undefined}
              required
            />
          </label>
          <AbsenceNote data={data} assignee={task.assignee_id} due={due} />
          <label>
            Motivo
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex.: o cliente atrasou o envio do material"
              required
              minLength={DUE_REASON_MIN}
              maxLength={DUE_REASON_MAX}
              rows={3}
            />
            <small>Se o prazo ficar antes do mínimo da regra, este motivo vale como justificativa.</small>
          </label>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button type="button" className="btn secondary" disabled={saving} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={saving}>
            Salvar <Check size={17} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}

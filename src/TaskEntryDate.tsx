import { useState, type FormEvent } from "react";
import { CalendarPlus, Check, PencilLine } from "lucide-react";
import { Button, Textarea } from "./ui";
import { Modal } from "./components";
import { DateInput } from "./DateInput";
import { dateLabel } from "./domain";
import type { Snapshot, Task } from "./types";
import {
  ENTRY_REASON_MAX,
  ENTRY_REASON_MIN,
  canChangeEntry,
  earliestEntry,
  entryDateError,
  entryDay,
  latestEntry,
} from "./task-entry";
import "./task-entry.css";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * "Entrada" nas propriedades da tarefa: o dia em que a demanda entrou (a
 * criação, sem ajuste). Quem pode (task-entry.ts) muda a data com um motivo,
 * que fica no histórico da tarefa e nos Dashboards.
 */
export function TaskEntryRow({
  task,
  data,
  user,
  mutate,
  notify,
}: {
  task: Task;
  data: Snapshot;
  user: string;
  mutate: Mutate;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const tz =
    data.companies.find((c) => c.id === task.company_id)?.timezone ??
    "America/Sao_Paulo";
  const day = entryDay(task, tz);
  const can = !task.archived && canChangeEntry(data, task, user);
  const adjusted = !!task.entered_at;
  return (
    <div className="property-row">
      <span className="property-label">
        <CalendarPlus size={15} /> Entrada
      </span>
      <div className="property-value">
        {can ? (
          <button
            type="button"
            className="property-button"
            title="Alterar a data de entrada"
            onClick={() => setOpen(true)}
          >
            {dateLabel(day)}
            <PencilLine size={14} />
          </button>
        ) : (
          dateLabel(day)
        )}
        {adjusted && (
          <small title={`Criada em ${dateLabel(entryDay({ created_at: task.created_at }, tz))}`}>
            ajustada
          </small>
        )}
      </div>
      {open && (
        <EntryDateModal
          task={task}
          tz={tz}
          current={day}
          mutate={mutate}
          notify={notify}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function EntryDateModal({
  task,
  tz,
  current,
  mutate,
  notify,
  onClose,
}: {
  task: Task;
  tz: string;
  current: string;
  mutate: Mutate;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [date, setDate] = useState(current);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = entryDateError(task, date, reason, tz);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await mutate("set_task_entry_date", {
        p_task: task.id,
        p_version: task.version,
        p_date: date,
        p_reason: reason.trim(),
      });
      notify("Data de entrada alterada.");
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <Modal title="Alterar a data de entrada" onClose={onClose} busy={saving}>
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          <p className="entry-date-intro">
            Entrada atual: <strong>{dateLabel(current)}</strong> O motivo fica registrado no
            histórico da tarefa e a mudança conta nos Dashboards.
          </p>
          <label>
            Nova data de entrada
            <DateInput
              name="entry_date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={earliestEntry(task, tz)}
              max={latestEntry(task, tz)}
              required
            />
          </label>
          <label>
            Motivo
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex.: o cliente mandou o pedido por e-mail dois dias antes"
              required
              minLength={ENTRY_REASON_MIN}
              maxLength={ENTRY_REASON_MAX}
              rows={3}
            />
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

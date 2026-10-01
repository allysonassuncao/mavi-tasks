import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Flag } from "lucide-react";
import { useRef, useState } from "react";
import {
  PRIORITY_RULE,
  canChangePriority,
  isPrioritized,
  priorityBlock,
  type Priority,
} from "./task-priority";
import { priorities, type Snapshot, type Task } from "./types";
import "./task-priority.css";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;

const ORDER: Priority[] = ["urgent", "high", "normal", "low"];

/** "Urgente" / "Alta" beside the title in the list; nothing for the others. */
export function PriorityTag({ priority }: { priority: Priority }) {
  if (!isPrioritized(priority)) return null;
  return (
    <span
      className={`priority-tag priority-tag-${priority}`}
      title={`Prioridade ${priorities[priority]}`}
    >
      <Flag size={11} fill="currentColor" aria-hidden="true" />
      {priorities[priority]}
    </span>
  );
}

/** The row's class in the list and the board: highlighted when Alta/Urgente. */
export function priorityClass(priority: Priority) {
  return isPrioritized(priority) ? `is-priority priority-row-${priority}` : "";
}

function PriorityLabel({ priority }: { priority: Priority }) {
  return (
    <span className={`priority-flag priority-${priority}`}>
      <Flag size={13} fill="currentColor" />
      {priorities[priority]}
    </span>
  );
}

/**
 * A prioridade nas propriedades da tarefa: quem pode muda por um menu (só a
 * prioridade muda, status e aprovações ficam), com quem marcou e quando.
 */
export function TaskPriorityValue({
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
  const [saving, setSaving] = useState(false);
  const picked = useRef(false);
  const can = !task.archived && canChangePriority(data, task, user);
  const by = task.priority_set_by
    ? data.members.find((m) => m.user_id === task.priority_set_by)?.name
    : null;
  const when = task.priority_set_at
    ? new Date(task.priority_set_at).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
      })
    : "";
  async function pick(next: Priority) {
    if (next === task.priority) return;
    setSaving(true);
    try {
      await mutate("set_task_priority", {
        p_task: task.id,
        p_version: task.version,
        p_priority: next,
      });
      notify(
        isPrioritized(next)
          ? `Tarefa marcada como prioridade ${priorities[next]}.`
          : `Prioridade alterada para ${priorities[next]}.`,
      );
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="property-value">
      {can ? (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="property-button"
              disabled={saving}
              aria-label={`Prioridade: ${priorities[task.priority]}. Mudar a prioridade`}
            >
              <PriorityLabel priority={task.priority} />
              <ChevronDown size={14} />
            </button>
          </Popover.Trigger>
          <Popover.Content
            className="status-menu priority-menu"
            role="menu"
            sideOffset={6}
            align="start"
            collisionPadding={10}
            onCloseAutoFocus={(e) => {
              if (picked.current) e.preventDefault();
              picked.current = false;
            }}
          >
            <p>Prioridade</p>
            {ORDER.map((p) => {
              const block = priorityBlock(data, task, p, user);
              return (
                <button
                  key={p}
                  type="button"
                  role="menuitemradio"
                  aria-checked={p === task.priority}
                  className={`status-option${p === task.priority ? " current" : ""}`}
                  disabled={!!block}
                  title={block || undefined}
                  onClick={() => {
                    picked.current = true;
                    setOpen(false);
                    void pick(p);
                  }}
                >
                  <PriorityLabel priority={p} />
                  {p === task.priority && <Check size={14} />}
                </button>
              );
            })}
            <small className="priority-menu-rule">{PRIORITY_RULE}</small>
          </Popover.Content>
        </Popover.Root>
      ) : (
        <PriorityLabel priority={task.priority} />
      )}
      {isPrioritized(task.priority) && (by || when) && (
        <small>
          marcada{by ? ` por ${by}` : ""}
          {when ? ` em ${when}` : ""}
        </small>
      )}
    </div>
  );
}

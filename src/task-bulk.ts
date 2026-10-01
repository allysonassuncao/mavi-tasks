import { priorities, statuses, type Status, type Task } from "./types";

/**
 * One change applied to many tasks at once (public.bulk_update_tasks):
 * another responsible (a person, or the team's least busy member), another
 * status, a fixed due date, the due dates moved by N business days, or each
 * due date counted again by its due rule. Every due date change needs
 * `reason` (migration 20270110090000), which also justifies a date before
 * the rule's minimum. "priority": Alta and Urgente only where the person
 * may prioritize (migration 20270130090000).
 */
export type BulkChange =
  | { kind: "assignee"; value: string }
  | { kind: "team"; value: string }
  | { kind: "status"; value: Status; note?: string }
  | { kind: "due"; value: string; reason: string }
  | { kind: "shift"; value: number; reason: string }
  | { kind: "rule"; reason: string }
  | { kind: "priority"; value: Task["priority"] };

interface BulkSide {
  status: Status;
  assignee_id: string;
  due_date: string;
  priority?: Task["priority"];
}
/** How one task came out: changed, or left out and why. */
export interface BulkItem {
  id: string;
  /** Missing for a task the person can't see. */
  title?: string;
  contract_id?: string;
  parent_id?: string | null;
  ok: boolean;
  reason: string | null;
  before?: BulkSide;
  after?: BulkSide;
}
export interface BulkResult {
  /** The review: the database did it all and undid it at the end. */
  preview: boolean;
  /** The applied edit, for "Desfazer". */
  operation?: string | null;
  applied: number;
  results: BulkItem[];
}
export interface BulkUndo {
  restored: number;
  /** Changed by someone after the edit: left as they are. */
  kept: number;
}

/** Statuses the flow only enters with a description, and what it asks. */
export const NOTE_STATUSES: Partial<Record<Status, string>> = {
  returned: "Quais informações faltam?",
  rejected: "Descreva a alteração solicitada",
  correction: "Descreva a correção necessária",
};

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
/** "30/09 (qua)". */
export function dayLabel(day: string) {
  const d = new Date(day + "T12:00:00Z");
  return `${day.slice(8, 10)}/${day.slice(5, 7)} (${WEEKDAYS[d.getUTCDay()]})`;
}

export function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The review's first line: what is about to happen. */
export function describeChange(
  change: BulkChange,
  names: { member: (id: string) => string; team: (id: string) => string },
) {
  switch (change.kind) {
    case "assignee":
      return `Trocar o responsável para ${names.member(change.value)}.`;
    case "team":
      return `Distribuir na equipe ${names.team(change.value)}: cada tarefa vai para quem tem menos tarefas em aberto naquele momento.`;
    case "status":
      return `Mudar o status para ${statuses[change.value].label}.`;
    case "due":
      return `Definir o prazo de todas para ${dayLabel(change.value)}.`;
    case "shift": {
      const n = Math.abs(change.value);
      return `${change.value > 0 ? "Adiar" : "Antecipar"} o prazo em ${plural(n, "dia útil", "dias úteis")}, a partir do prazo de cada tarefa.`;
    }
    case "rule":
      return "Recalcular o prazo de cada tarefa pela regra de prazo que vale para ela, contando do início planejado ou do dia em que foi criada.";
    case "priority":
      return `Mudar a prioridade para ${priorities[change.value]}. Alta e Urgente só mudam se você é administrador, gestor ou tem o recurso "Marcar prioridade".`;
  }
}

/** Which of a task's fields the change touches (shown before → after). */
export function changedField(change: BulkChange): keyof BulkSide {
  return change.kind === "assignee" || change.kind === "team"
    ? "assignee_id"
    : change.kind === "status"
      ? "status"
      : change.kind === "priority"
        ? "priority"
        : "due_date";
}

/** Before and after of one task, in words. */
export function sides(
  item: BulkItem,
  change: BulkChange,
  member: (id: string) => string,
): { before: string; after: string } | null {
  if (!item.before || !item.after) return null;
  const field = changedField(change);
  const label = (side: BulkSide) =>
    field === "assignee_id"
      ? member(side.assignee_id)
      : field === "status"
        ? (statuses[side.status]?.label ?? side.status)
        : field === "priority"
          ? side.priority
            ? priorities[side.priority]
            : "—"
          : dayLabel(side.due_date);
  return { before: label(item.before), after: label(item.after) };
}

/** The toast after applying: "12 tarefas alteradas · 2 ficaram de fora". */
export function appliedMessage(result: BulkResult) {
  const out = result.results.length - result.applied;
  return [
    plural(result.applied, "tarefa alterada", "tarefas alteradas"),
    out ? plural(out, "ficou de fora", "ficaram de fora") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function undoMessage(undo: BulkUndo) {
  return undo.kept
    ? `${plural(undo.restored, "tarefa voltou", "tarefas voltaram")} ao que era. ${plural(undo.kept, "foi mexida depois e ficou como está", "foram mexidas depois e ficaram como estão")}.`
    : `Alteração desfeita: ${plural(undo.restored, "tarefa voltou", "tarefas voltaram")} ao que era.`;
}

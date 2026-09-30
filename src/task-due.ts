import type { Snapshot, Task } from "./types";

/**
 * Mudança de prazo com motivo (migration 20270110090000_task_due_changes).
 * Toda mudança de prazo feita por alguém pede o motivo, fica no histórico e
 * conta nos Dashboards. O banco (public.set_task_due) decide; aqui ficam as
 * mesmas regras, para a tela e para a demonstração.
 */

export const DUE_REASON_MIN = 5;
export const DUE_REASON_MAX = 1000;

/** Where the change came from, as task_due_changes.source keeps it. */
export const dueSources = {
  task: "direto no prazo",
  edit: "em Editar tarefa",
  bulk: "em massa",
  replan: "no replanejamento",
} as const;

/**
 * Creator, assignee, participants (mentioned or once responsible), a
 * supervisor of one of the assignee's teams, managers and admins.
 */
export function canChangeDue(data: Snapshot, task: Task, user: string) {
  const me = data.members.find((m) => m.user_id === user && m.active);
  if (!me) return false;
  if (me.role === "admin" || me.role === "manager") return true;
  if (task.creator_id === user || task.assignee_id === user) return true;
  if (task.participant_ids?.includes(user)) return true;
  const assigneeTeams = new Set(
    data.teamMembers
      .filter((tm) => tm.user_id === task.assignee_id)
      .map((tm) => tm.team_id),
  );
  return data.teamMembers.some(
    (tm) =>
      tm.user_id === user && tm.supervisor && assigneeTeams.has(tm.team_id),
  );
}

/** The reason's problem, if any (every due date change asks one). */
export function dueReasonError(reason: string | null | undefined) {
  const n = (reason ?? "").trim().length;
  if (n < DUE_REASON_MIN)
    return `Informe o motivo da mudança de prazo (ao menos ${DUE_REASON_MIN} caracteres).`;
  if (n > DUE_REASON_MAX) return `O motivo pode ter até ${DUE_REASON_MAX} caracteres.`;
  return "";
}

const br = (day: string) => day.split("-").reverse().join("/");

/** The first reason the database would refuse the new date, if any. */
export function dueChangeError(
  task: Pick<Task, "due_date" | "start_date">,
  due: string,
  reason: string,
) {
  if (!due) return "Escolha o novo prazo.";
  if (due === task.due_date) return "A tarefa já tem esse prazo.";
  if (task.start_date && due < task.start_date)
    return `O prazo não pode ficar antes do início planejado (${br(task.start_date)}).`;
  return dueReasonError(reason);
}

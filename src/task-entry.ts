import { dateKey } from "./domain";
import type { Snapshot, Task } from "./types";

/**
 * Data de entrada da tarefa (migration 20270109090000_task_entry_date): o
 * dia em que a demanda entrou. Sem ajuste, é o da criação. O banco
 * (public.set_task_entry_date) decide; aqui ficam o mesmo cálculo e as
 * mesmas regras, para a tela e para a demonstração.
 */

export const ENTRY_REASON_MIN = 5;
export const ENTRY_REASON_MAX = 1000;

/** The entry day (YYYY-MM-DD) in the company's time zone. */
export function entryDay(
  task: Pick<Task, "created_at" | "entered_at">,
  tz = "America/Sao_Paulo",
) {
  return dateKey(new Date(task.entered_at ?? task.created_at), tz);
}

/**
 * Creator, assignee, participants (mentioned or once responsible), a
 * supervisor of one of the assignee's teams, managers and admins.
 */
export function canChangeEntry(data: Snapshot, task: Task, user: string) {
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

const shift = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
const br = (day: string) => day.split("-").reverse().join("/");

/** The first reason the database would refuse the new date, if any. */
export function entryDateError(
  task: Pick<Task, "created_at" | "entered_at" | "due_date" | "delivered_at">,
  day: string,
  reason: string,
  tz = "America/Sao_Paulo",
) {
  if (!day) return "Informe a nova data de entrada.";
  if (day === entryDay(task, tz))
    return "A tarefa já está com essa data de entrada.";
  if (task.due_date && day > task.due_date)
    return `A data de entrada não pode ser depois do prazo (${br(task.due_date)}).`;
  const delivered = task.delivered_at
    ? dateKey(new Date(task.delivered_at), tz)
    : null;
  if (delivered && day > delivered)
    return `A data de entrada não pode ser depois da entrega (${br(delivered)}).`;
  if (day < shift(dateKey(new Date(task.created_at), tz), -365))
    return "A data de entrada pode ser até 1 ano antes da criação da tarefa.";
  const written = reason.trim().length;
  if (written < ENTRY_REASON_MIN)
    return `Informe o motivo da alteração (ao menos ${ENTRY_REASON_MIN} caracteres).`;
  if (written > ENTRY_REASON_MAX)
    return `O motivo pode ter até ${ENTRY_REASON_MAX} caracteres.`;
  return "";
}

/** The earliest day the database accepts (1 year before the creation). */
export const earliestEntry = (task: Pick<Task, "created_at">, tz?: string) =>
  shift(dateKey(new Date(task.created_at), tz), -365);

/** The latest day: the due date or the delivery, whichever comes first. */
export function latestEntry(
  task: Pick<Task, "due_date" | "delivered_at">,
  tz?: string,
) {
  const delivered = task.delivered_at
    ? dateKey(new Date(task.delivered_at), tz)
    : null;
  return [task.due_date, delivered].filter(Boolean).sort()[0] ?? undefined;
}

/**
 * The new entered_at, as the database sets it: the creation's time of day
 * on the new day (null when back on the creation's day).
 */
export function enteredAt(created_at: string, day: string, tz = "America/Sao_Paulo") {
  const created = new Date(created_at);
  if (dateKey(created, tz) === day) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(created)
      .map((p) => [p.type, p.value]),
  );
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  const offset =
    Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${time}Z`,
    ) - created.getTime();
  return new Date(Date.parse(`${day}T${time}Z`) - offset).toISOString();
}

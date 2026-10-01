import { priorities, type Snapshot, type Task } from "./types";

/**
 * Prioridades (migrações 20270130090000 e 20270205090000): Alta e Urgente
 * são o destaque da lista de Tarefas e só administradores, gestores e quem
 * tem o recurso extra "Marcar prioridade" (memberships.task_priority) dão ou
 * tiram, em qualquer tarefa que veem. Baixa ↔ Normal continua com quem edita
 * a tarefa. O banco confere de novo.
 */
export type Priority = Task["priority"];

/** 2 Urgente, 1 Alta, 0 as outras (tasks.priority_weight). */
export function priorityWeight(p: Priority | string | null | undefined) {
  return p === "urgent" ? 2 : p === "high" ? 1 : 0;
}
/** Alta ou Urgente: a tarefa aparece em destaque. */
export function isPrioritized(p: Priority | string | null | undefined) {
  return priorityWeight(p) > 0;
}

export const PRIORITY_RULE =
  'Só administradores, gestores e quem tem o recurso "Marcar prioridade" dão ou tiram a prioridade Alta ou Urgente.';

function activeMember(data: Snapshot, userId: string) {
  return data.members.find((m) => m.user_id === userId && m.active);
}
function leads(data: Snapshot, userId: string) {
  const role = activeMember(data, userId)?.role;
  return role === "admin" || role === "manager";
}

/**
 * Mirrors mavi_private.can_prioritize_as: admin or manager, or the extra
 * "Marcar prioridade" on — for any task the person sees, whoever receives it
 * (the list only holds tasks they see).
 */
export function mayPrioritize(data: Snapshot, userId: string) {
  return leads(data, userId) || !!activeMember(data, userId)?.task_priority;
}
/** Mirrors the tasks policy for editing (mavi_private.can_edit). */
function editsTask(data: Snapshot, task: Task, userId: string) {
  return leads(data, userId) || (!!activeMember(data, userId) && task.creator_id === userId);
}
/**
 * Whether the person may move the task to `next` (mavi_private.may_set_priority
 * and public.set_task_priority): whoever may prioritize, always; Baixa ↔
 * Normal, also whoever edits the task.
 */
export function canSetPriority(
  data: Snapshot,
  task: Task,
  next: Priority,
  userId: string,
) {
  if (next === task.priority) return true;
  if (mayPrioritize(data, userId)) return true;
  return (
    !isPrioritized(next) &&
    !isPrioritized(task.priority) &&
    editsTask(data, task, userId)
  );
}
/** Whether the task's priority can be changed by the person at all. */
export function canChangePriority(data: Snapshot, task: Task, userId: string) {
  return (Object.keys(priorities) as Priority[]).some(
    (p) => p !== task.priority && canSetPriority(data, task, p, userId),
  );
}
/** Why an option can't be picked, or "" when it can. */
export function priorityBlock(
  data: Snapshot,
  task: Task,
  next: Priority,
  userId: string,
) {
  return canSetPriority(data, task, next, userId) ? "" : PRIORITY_RULE;
}

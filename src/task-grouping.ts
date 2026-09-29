import { dateKey, isLate, type NameLookup } from "./domain";
import { listedStatuses, statuses, type Task } from "./types";

/**
 * How the task list is split into sections, chosen by each person ("Agrupar
 * por … e depois por …"). "auto" keeps the list's own sections (by scope in
 * "Todas", by team in the team tabs); "pack" gathers what was created for the
 * same client on the same day, as the old MASO did.
 */
export type GroupBy =
  | "auto"
  | "pack"
  | "client"
  | "assignee"
  | "status"
  | "due"
  | "project"
  | "none";

export const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: "auto", label: "Padrão da aba" },
  { id: "pack", label: "Pacote (cliente + dia)" },
  { id: "client", label: "Cliente" },
  { id: "assignee", label: "Responsável" },
  { id: "status", label: "Status" },
  { id: "due", label: "Prazo" },
  { id: "project", label: "Projeto" },
  { id: "none", label: "Sem agrupamento" },
];
/** Second level: any split but the tab's own ("Nada" leaves it out). */
export const THEN_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: "none", label: "Nada" },
  ...GROUP_OPTIONS.filter((o) => o.id !== "auto" && o.id !== "none"),
];

export function parseGroupBy(value: string, fallback: GroupBy): GroupBy {
  return GROUP_OPTIONS.some((o) => o.id === value)
    ? (value as GroupBy)
    : fallback;
}

/**
 * The server's order for a split, so a page of 50 holds whole sections as
 * far as possible (packs newest first; the rest by due date inside).
 */
export type TaskOrder = "due" | "created" | "contract" | "assignee" | "status" | "project";
export function groupOrder(by: GroupBy): TaskOrder {
  return (
    {
      pack: "created",
      client: "contract",
      assignee: "assignee",
      status: "status",
      project: "project",
    } as Partial<Record<GroupBy, TaskOrder>>
  )[by] ?? "due";
}

export interface GroupContext {
  lookup: NameLookup;
  today: string;
  /** The company's timezone: the day a task was created, for packs. */
  timezone: string;
}

export interface TaskGroup {
  key: string;
  label: string;
  hint: string;
  tasks: Task[];
  /** The second level ("e depois por"), when chosen. */
  children?: TaskGroup[];
}

const shortDate = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
function addDays(day: string, n: number) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Sunday of the week `day` is in (weeks run Monday to Sunday). */
function weekEnd(day: string) {
  const weekday = new Date(day + "T12:00:00Z").getUTCDay();
  return addDays(day, weekday === 0 ? 0 : 7 - weekday);
}

/** Where one task goes for a split: its section's key, name and place. */
function sectionOf(
  task: Task,
  by: GroupBy,
  ctx: GroupContext,
): { key: string; label: string; sort: string } {
  const contract = ctx.lookup.contracts.get(task.contract_id);
  const client = contract ? ctx.lookup.clients.get(contract.client_id) : undefined;
  const clientName = client?.name ?? "Sem cliente";
  switch (by) {
    case "pack": {
      const day = dateKey(new Date(task.created_at), ctx.timezone);
      return {
        key: `${contract?.client_id ?? "-"}|${day}`,
        label: `${clientName} · ${shortDate(day)}`,
        // Newest packs first.
        sort: `${9e8 - Number(day.replaceAll("-", ""))}|${clientName}`,
      };
    }
    case "client":
      return { key: contract?.client_id ?? "-", label: clientName, sort: clientName };
    case "assignee": {
      const name = ctx.lookup.members.get(task.assignee_id)?.name ?? "Usuário removido";
      return { key: task.assignee_id, label: name, sort: name };
    }
    case "status":
      return {
        key: task.status,
        label: statuses[task.status]?.label ?? task.status,
        sort: String(listedStatuses.indexOf(task.status)).padStart(2, "0"),
      };
    case "project": {
      const project = task.project_id ? ctx.lookup.projects.get(task.project_id) : undefined;
      return project
        ? { key: project.id, label: project.name, sort: `0${project.name}` }
        : { key: "-", label: "Sem projeto", sort: "1" };
    }
    case "due": {
      const end = weekEnd(ctx.today);
      if (isLate(task, ctx.today)) return { key: "late", label: "Atrasadas", sort: "0" };
      if (task.due_date === ctx.today) return { key: "today", label: "Hoje", sort: "1" };
      if (task.due_date <= end)
        return {
          key: "week",
          label: `Esta semana (até ${shortDate(end)})`,
          sort: "2",
        };
      if (task.due_date <= addDays(end, 7))
        return {
          key: "next",
          label: `Próxima semana (${shortDate(addDays(end, 1))} a ${shortDate(addDays(end, 7))})`,
          sort: "3",
        };
      return { key: "later", label: "Mais tarde", sort: "4" };
    }
    default:
      return { key: "all", label: "Tarefas", sort: "" };
  }
}

/**
 * "14h estimadas" — what a section's header adds in its fine print. The late
 * ones get their own mark beside the count (TaskTable), seen even closed.
 */
export function groupHint(tasks: Task[], _today: string, lead = "") {
  const minutes = tasks.reduce((sum, t) => sum + (t.estimated_minutes || 0), 0);
  const hours = Math.round(minutes / 6) / 10;
  return [
    lead,
    hours ? `${String(hours).replace(".", ",")}h estimadas` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Splits tasks into sections, in each section's order. */
export function groupTasks(
  tasks: Task[],
  by: GroupBy,
  ctx: GroupContext,
  keyPrefix = "",
): TaskGroup[] {
  const map = new Map<string, TaskGroup & { sort: string }>();
  for (const t of tasks) {
    const s = sectionOf(t, by, ctx);
    const group = map.get(s.key);
    if (group) group.tasks.push(t);
    else
      map.set(s.key, {
        key: keyPrefix + s.key,
        label: s.label,
        sort: s.sort,
        hint: "",
        tasks: [t],
      });
  }
  return [...map.values()]
    .sort((a, b) => a.sort.localeCompare(b.sort, "pt-BR"))
    .map(({ sort: _sort, ...g }) => ({
      ...g,
      // Inside a section, the nearest due date first.
      tasks: [...g.tasks].sort((a, b) => a.due_date.localeCompare(b.due_date)),
      hint: groupHint(g.tasks, ctx.today),
    }));
}

/** Adds the second level to sections made elsewhere (the tab's own too). */
export function withSubgroups(
  groups: TaskGroup[],
  then: GroupBy,
  ctx: GroupContext,
): TaskGroup[] {
  if (then === "none" || then === "auto") return groups;
  return groups.map((g) => ({
    ...g,
    children: groupTasks(g.tasks, then, ctx, `${g.key}>`),
  }));
}

/**
 * The list's rows for one section: subtasks right under their main task
 * when both are in it; a subtask whose main task is elsewhere stands on its
 * own (and says whose subtask it is).
 */
export interface TaskRowNode {
  task: Task;
  children: Task[];
  /** Main task's id when it is in another section (or page). */
  parentElsewhere: string | null;
}
export function nestSubtasks(tasks: Task[]): TaskRowNode[] {
  const here = new Set(tasks.map((t) => t.id));
  const kids = new Map<string, Task[]>();
  for (const t of tasks)
    if (t.parent_id && here.has(t.parent_id))
      kids.set(t.parent_id, [...(kids.get(t.parent_id) ?? []), t]);
  return tasks
    .filter((t) => !t.parent_id || !here.has(t.parent_id))
    .map((t) => ({
      task: t,
      children: kids.get(t.id) ?? [],
      parentElsewhere: t.parent_id && !here.has(t.parent_id) ? t.parent_id : null,
    }));
}

/** What a saved view holds: the list's split, filters and look. */
export interface TaskViewConfig {
  group?: GroupBy;
  then?: GroupBy;
  view?: string;
  status?: string;
  product?: string;
  scope?: string;
  late?: boolean;
  client?: string;
  project?: string;
}
const VIEW_KEYS: (keyof TaskViewConfig)[] = [
  "group",
  "then",
  "view",
  "status",
  "product",
  "scope",
  "late",
  "client",
  "project",
];
/** A config without empty or default values, for storing and comparing. */
export function normalizeViewConfig(c: TaskViewConfig): TaskViewConfig {
  const out: TaskViewConfig = {};
  for (const k of VIEW_KEYS) {
    const v = c[k];
    if (v === undefined || v === "" || v === false) continue;
    if (k === "group" && v === "auto") continue;
    if (k === "then" && v === "none") continue;
    if (k === "view" && v === "list") continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
export function sameViewConfig(a: TaskViewConfig, b: TaskViewConfig) {
  const x = normalizeViewConfig(a),
    y = normalizeViewConfig(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every(
    (k) =>
      (x as Record<string, unknown>)[k] === (y as Record<string, unknown>)[k],
  );
}

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
 * How the list is sorted ("Ordenar por"), chosen by each person: the tasks
 * and, for splits without an order of their own, the sections too (by each
 * one's first task). The server pages the list without groups in this order.
 */
export type TaskSort = "due" | "due_desc" | "created_desc" | "created" | "title";
export const SORT_OPTIONS: { id: TaskSort; label: string }[] = [
  { id: "due", label: "Prazo mais próximo" },
  { id: "due_desc", label: "Prazo mais distante" },
  { id: "created_desc", label: "Criadas por último" },
  { id: "created", label: "Criadas primeiro" },
  { id: "title", label: "Nome (A–Z)" },
];
export function parseSort(value: string): TaskSort {
  return SORT_OPTIONS.some((o) => o.id === value) ? (value as TaskSort) : "due";
}
/** The sort's own key, without the tie-breaker (sections break ties apart). */
function sortKey(sort: TaskSort, a: Task, b: Task) {
  switch (sort) {
    case "due_desc":
      return b.due_date.localeCompare(a.due_date);
    case "created_desc":
      return b.created_at.localeCompare(a.created_at);
    case "created":
      return a.created_at.localeCompare(b.created_at);
    case "title":
      return a.title.localeCompare(b.title, "pt-BR", { sensitivity: "base" });
    default:
      return a.due_date.localeCompare(b.due_date);
  }
}
/** Tasks in the sort's order; ties by id, as the server pages them. */
export function compareTasks(sort: TaskSort) {
  return (a: Task, b: Task) =>
    sortKey(sort, a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Splits whose sections keep their own order whatever the sort. */
const FIXED_ORDER: GroupBy[] = ["status", "due", "none", "auto"];

/** A section before it is placed: its own order and whether it goes last. */
export type PlacedGroup = TaskGroup & {
  /** The split's own order (packs newest first, names A–Z…). */
  order: string;
  /** "Sem projeto", "Sem equipe": after the others. */
  last?: boolean;
};
/**
 * Sections in the list's order: by their first task under the sort (the
 * pack with the nearest due date first, by default), their own order
 * breaking ties. "Nome" and the splits with an order of their own (status,
 * due date) keep theirs. The tasks inside must already be sorted.
 */
export function placeGroups(
  groups: PlacedGroup[],
  sort: TaskSort,
  fixed = false,
): TaskGroup[] {
  const own = fixed || sort === "title";
  return [...groups]
    .sort(
      (a, b) =>
        Number(!!a.last) - Number(!!b.last) ||
        (own ? 0 : sortKey(sort, a.tasks[0], b.tasks[0])) ||
        a.order.localeCompare(b.order, "pt-BR"),
    )
    .map(({ order: _order, last: _last, ...g }) => g);
}

export interface GroupContext {
  lookup: NameLookup;
  today: string;
  /** The company's timezone: the day a task was created, for packs. */
  timezone: string;
  /** "Ordenar por": the tasks' order and the sections' (due date by default). */
  sort?: TaskSort;
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
): { key: string; label: string; sort: string; last?: boolean } {
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
      return {
        key: contract?.client_id ?? "-",
        label: clientName,
        sort: clientName,
        last: !client,
      };
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
        : { key: "-", label: "Sem projeto", sort: "1", last: true };
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

/**
 * What a closed section shows in its own columns, so it reads without
 * opening: how many per status, the open due dates' span, and who does and
 * who asked (most tasks first). One pass over the section's tasks.
 */
export interface GroupSummary {
  late: number;
  /** Statuses present, in the list's order, with their counts. */
  statuses: [Task["status"], number][];
  /** Nearest and farthest due date of the tasks not done ("" when none). */
  firstDue: string;
  lastDue: string;
  /** Member ids, most tasks first. */
  assignees: string[];
  creators: string[];
}
export function groupSummary(tasks: Task[], today: string): GroupSummary {
  const byStatus = new Map<Task["status"], number>(),
    assignees = new Map<string, number>(),
    creators = new Map<string, number>();
  let late = 0,
    firstDue = "",
    lastDue = "";
  for (const t of tasks) {
    byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    assignees.set(t.assignee_id, (assignees.get(t.assignee_id) ?? 0) + 1);
    creators.set(t.creator_id, (creators.get(t.creator_id) ?? 0) + 1);
    if (t.status === "done" || !t.due_date) continue;
    if (t.due_date < today) late++;
    if (!firstDue || t.due_date < firstDue) firstDue = t.due_date;
    if (t.due_date > lastDue) lastDue = t.due_date;
  }
  const ranked = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const order = (s: Task["status"]) => {
    const i = listedStatuses.indexOf(s);
    return i < 0 ? listedStatuses.length : i;
  };
  return {
    late,
    statuses: [...byStatus.entries()].sort((a, b) => order(a[0]) - order(b[0])),
    firstDue,
    lastDue,
    assignees: ranked(assignees),
    creators: ranked(creators),
  };
}

/** Splits tasks into sections, in the list's order (see placeGroups). */
export function groupTasks(
  tasks: Task[],
  by: GroupBy,
  ctx: GroupContext,
  keyPrefix = "",
): TaskGroup[] {
  const sort = ctx.sort ?? "due";
  const map = new Map<string, PlacedGroup>();
  for (const t of tasks) {
    const s = sectionOf(t, by, ctx);
    const group = map.get(s.key);
    if (group) group.tasks.push(t);
    else
      map.set(s.key, {
        key: keyPrefix + s.key,
        label: s.label,
        order: s.sort,
        last: s.last,
        hint: "",
        tasks: [t],
      });
  }
  const sections = [...map.values()].map((g) => ({
    ...g,
    tasks: [...g.tasks].sort(compareTasks(sort)),
    hint: groupHint(g.tasks, ctx.today),
  }));
  return placeGroups(sections, sort, FIXED_ORDER.includes(by));
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
  sort?: TaskSort;
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
  "sort",
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
    if (k === "sort" && v === "due") continue;
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

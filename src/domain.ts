import {
  type Task,
  type TimeEntry,
  type TaskEvent,
  type Snapshot,
  type Status,
  type Project,
  type ProjectApprover,
} from "./types";
export function dateKey(date = new Date(), timezone = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function isLate(task: Task, today = dateKey()) {
  return task.status !== "done" && task.due_date < today;
}
export function minutes(entry: TimeEntry, now = Date.now()) {
  return Math.max(
    0,
    ((entry.ended_at ? Date.parse(entry.ended_at) : now) -
      Date.parse(entry.started_at)) /
      60000,
  );
}
export function duration(value: number) {
  const m = Math.round(value);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
/** Worked time down to the second, e.g. "1h 05m 09s" — for task timers. */
export function durationWithSeconds(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${Math.floor(safe / 3600)}h ${pad(Math.floor(safe / 60) % 60)}m ${pad(safe % 60)}s`;
}
export function entrySeconds(entry: TimeEntry, now = Date.now()) {
  return Math.floor(minutes(entry, now) * 60);
}
export function taskTimerSeconds(
  hours: TimeEntry[],
  taskId: string,
  running?: TimeEntry | null,
  now = Date.now(),
): number {
  const isRunning = running?.task_id === taskId && !running.ended_at;
  const pastSeconds = hours
    .filter((h) => h.task_id === taskId && h.ended_at && h.id !== running?.id)
    .reduce((sum, h) => {
      const start = Date.parse(h.started_at);
      const end = Date.parse(h.ended_at!);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return sum;
      }
      return sum + Math.floor((end - start) / 1000);
    }, 0);
  const currentSeconds =
    isRunning && running
      ? Math.max(0, Math.floor((now - Date.parse(running.started_at)) / 1000))
      : 0;
  return pastSeconds + currentSeconds;
}
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor(safe / 60) % 60;
  const s = safe % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}
export function dateLabel(value: string | null) {
  if (!value) return "Sem data";
  return new Date(value + "T12:00:00").toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
  });
}
export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
}
export interface NameLookup {
  contracts: Map<string, Snapshot["contracts"][number]>;
  clients: Map<string, Snapshot["clients"][number]>;
  products: Map<string, Snapshot["products"][number]>;
  projects: Map<string, Snapshot["projects"][number]>;
  members: Map<string, Snapshot["members"][number]>;
}
export function buildNameLookup(data: Snapshot): NameLookup {
  return {
    contracts: new Map(data.contracts.map((c) => [c.id, c])),
    clients: new Map(data.clients.map((c) => [c.id, c])),
    products: new Map(data.products.map((p) => [p.id, p])),
    projects: new Map(data.projects.map((p) => [p.id, p])),
    members: new Map(data.members.map((m) => [m.user_id, m])),
  };
}
export function namesFrom(lookup: NameLookup, task: Task) {
  const contract = lookup.contracts.get(task.contract_id);
  return {
    client: contract ? lookup.clients.get(contract.client_id) : undefined,
    product: contract ? lookup.products.get(contract.product_id) : undefined,
    project: task.project_id ? lookup.projects.get(task.project_id) : undefined,
    member: lookup.members.get(task.assignee_id),
  };
}
export function names(data: Snapshot, task: Task) {
  return namesFrom(buildNameLookup(data), task);
}
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [item, ...list];
  const next = list.slice();
  next[index] = item;
  return next;
}
/** Accent- and case-insensitive key for matching names typed by people. */
export const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
/** Default name for a client ↔ product link when the user gives none. */
export function defaultContractName(product: string, client: string) {
  return `${product} · ${client}`;
}
/**
 * A contracted product is identified by its client and product; its own name
 * only adds information when it is not just a restatement of those two
 * (e.g. "Social Leads · Aurora"), so callers show it only when this returns it.
 */
export function contractDetail(name: string, product = "", client = "") {
  const n = fold(name);
  if (!n) return "";
  const p = fold(product),
    c = fold(client);
  if ((p && n.includes(p)) || n === c || n === `${c} · ${p}`) return "";
  return name.trim();
}
export function contractParts(data: Snapshot, contractId: string | null) {
  const contract = data.contracts.find((c) => c.id === contractId);
  const client = data.clients.find((c) => c.id === contract?.client_id);
  const product = data.products.find((p) => p.id === contract?.product_id);
  return {
    contract,
    client,
    product,
    detail: contract
      ? contractDetail(contract.name, product?.name, client?.name)
      : "",
  };
}
/** "Produto (identificação)" — how a contracted product reads under its client. */
export function contractProductLabel(data: Snapshot, contractId: string) {
  const { product, detail } = contractParts(data, contractId);
  return `${product?.name ?? "Produto"}${detail ? ` (${detail})` : ""}`;
}
/** Task search matches the title, the client's name or the project's name. */
export function taskMatchesSearch(
  lookup: NameLookup,
  task: Task,
  query: string,
) {
  const q = fold(query);
  if (!q) return true;
  const n = namesFrom(lookup, task);
  return [task.title, n.client?.name, n.project?.name].some(
    (v) => !!v && fold(v).includes(q),
  );
}
/** A project's validation settings, with defaults for rows cached before they existed. */
export function projectReview(
  project?: Pick<Project, "requires_review" | "approver"> | null,
) {
  return {
    required: project?.requires_review ?? true,
    approver: project?.approver ?? ("creator" as ProjectApprover),
  };
}
/**
 * Mirrors mavi_private.task_supervisor: an active supervisor of the task's
 * team (or of the client's teams when the task has none), whatever the
 * person's profile.
 */
export function isTaskSupervisor(data: Snapshot, task: Task, userId: string) {
  if (!data.members.some((m) => m.user_id === userId && m.active)) return false;
  const myTeams = new Set(
    data.teamMembers
      .filter((tm) => tm.user_id === userId && tm.supervisor)
      .map((tm) => tm.team_id),
  );
  if (!myTeams.size) return false;
  if (task.team_id) return myTeams.has(task.team_id);
  const clientId = data.contracts.find(
    (c) => c.id === task.contract_id,
  )?.client_id;
  return data.clientTeams.some(
    (ct) => ct.client_id === clientId && myTeams.has(ct.team_id),
  );
}
/** Mirrors the tasks policy: leaders, the creator, the assignee, supervisors. */
export function canSeeTask(data: Snapshot, task: Task, userId: string) {
  const me = data.members.find((m) => m.user_id === userId && m.active);
  return (
    me?.role === "admin" ||
    me?.role === "manager" ||
    task.creator_id === userId ||
    task.assignee_id === userId ||
    isParticipant(task, userId) ||
    isTaskSupervisor(data, task, userId)
  );
}
/**
 * Mirrors mavi_private.can_approve: admins always; tasks outside a project
 * (or in one without validation) by their creator or any leader; otherwise
 * by the project's chosen approver — the creator, or a supervisor of the
 * task's team (the client's teams when the task has none).
 */
export function canApproveTask(data: Snapshot, task: Task, userId: string) {
  const me = data.members.find((m) => m.user_id === userId && m.active);
  if (!me) return false;
  if (me.role === "admin") return true;
  const project = data.projects.find((p) => p.id === task.project_id);
  const review = projectReview(project);
  if (!project || !review.required)
    return me.role === "manager" || task.creator_id === userId;
  if (review.approver === "creator") return task.creator_id === userId;
  return isTaskSupervisor(data, task, userId);
}
/**
 * Mirrors mavi_private.contract_access, which create_task checks: admins
 * everywhere, everyone else only in clients served by one of their teams.
 */
export function canCreateTaskIn(
  data: Snapshot,
  contractId: string,
  userId: string,
) {
  const me = data.members.find((m) => m.user_id === userId && m.active);
  if (!me) return false;
  if (me.role === "admin") return true;
  const clientId = data.contracts.find((c) => c.id === contractId)?.client_id;
  const myTeams = new Set(
    data.teamMembers
      .filter((tm) => tm.user_id === userId)
      .map((tm) => tm.team_id),
  );
  return data.clientTeams.some(
    (ct) => ct.client_id === clientId && myTeams.has(ct.team_id),
  );
}
/** Clients served by any of the person's teams (how collaborators reach clients). */
export function teamClientIds(data: Snapshot, userId: string) {
  const myTeams = new Set(
    data.teamMembers
      .filter((tm) => tm.user_id === userId)
      .map((tm) => tm.team_id),
  );
  return new Set(
    data.clientTeams
      .filter((ct) => myTeams.has(ct.team_id))
      .map((ct) => ct.client_id),
  );
}
/** Delivered tasks can be reopened (except by admins) up to this long after delivery. */
export const REOPEN_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** A button that is shown but disabled, with the reason as its label. */
export type BlockedAction = { blocked: string };
/**
 * What the user may do with a task (mirrors public.transition_task):
 * `true` allows it, a BlockedAction shows it disabled, `false` hides it.
 *
 * The flow is free: the current assignee, the creator or a leader moves the
 * task between its working statuses in any order, and picks who is
 * responsible from then on. While in validation, whoever validates may move
 * it too. Delivery still goes through the validator's approval.
 */
export function taskActions(
  data: Snapshot,
  task: Task,
  userId: string,
  now = Date.now(),
) {
  const me = data.members.find((m) => m.user_id === userId && m.active);
  const admin = me?.role === "admin",
    leader = admin || me?.role === "manager",
    creator = task.creator_id === userId,
    assignee = task.assignee_id === userId,
    approver = canApproveTask(data, task, userId),
    s = task.status;
  const review = projectReview(
    data.projects.find((p) => p.id === task.project_id),
  ).required;
  const mover =
    !!me && (assignee || creator || leader || (s === "review" && approver));
  const reopenExpired =
    !admin &&
    !!task.delivered_at &&
    now - Date.parse(task.delivered_at) >= REOPEN_WINDOW_MS;
  return {
    /** Change the status (among the working ones) and/or the assignee. */
    move: s !== "done" && mover,
    /** Deliver straight from the status menu: projects without validation. */
    deliver: s !== "done" && mover && !review,
    approveInternal: approver && s === "review" && !task.internal_approved_by,
    approveClient:
      approver &&
      s === "review" &&
      task.requires_client_approval &&
      !!task.internal_approved_by &&
      !task.client_approved_by,
    reopen:
      s === "done" && (admin || creator || assignee || approver)
        ? reopenExpired
          ? ({
              blocked:
                "Não é possível reabrir esta tarefa. A data limite para reabertura da tarefa foi ultrapassada.",
            } as BlockedAction)
          : true
        : false,
  };
}
export type TaskActions = ReturnType<typeof taskActions>;
/**
 * Where a task stands for the person looking at the list: assigned to them,
 * created by them for someone else, one they take part in (they were
 * responsible before, or were mentioned), in one of their teams, or
 * elsewhere. Mirrored on the server by the task list's `scope` filter.
 */
export type TaskScope =
  "mine" | "created" | "participating" | "teams" | "others";
export const TASK_SCOPES: { id: TaskScope; label: string; hint: string }[] = [
  { id: "mine", label: "Para você", hint: "Você é o responsável" },
  {
    id: "created",
    label: "Criadas por você",
    hint: "Você criou para outra pessoa",
  },
  {
    id: "participating",
    label: "Participando",
    hint: "Você já foi responsável ou foi mencionado",
  },
  {
    id: "teams",
    label: "Suas equipes",
    hint: "Das equipes de que você participa",
  },
  { id: "others", label: "Outras equipes", hint: "Demais tarefas da empresa" },
];
/** The person's teams and the clients those teams serve. */
export function myTeams(data: Snapshot, userId: string) {
  const teams = new Set(
    data.teamMembers
      .filter((tm) => tm.user_id === userId)
      .map((tm) => tm.team_id),
  );
  const clients = new Set(
    data.clientTeams
      .filter((ct) => teams.has(ct.team_id))
      .map((ct) => ct.client_id),
  );
  return { teams, clients };
}
/** Takes part in the task: was responsible before, or was mentioned. */
export function isParticipant(
  task: Pick<Task, "participant_ids">,
  userId: string,
) {
  return !!task.participant_ids?.includes(userId);
}
export function taskScope(
  data: Snapshot,
  task: Task,
  userId: string,
  mine = myTeams(data, userId),
): TaskScope {
  if (task.assignee_id === userId) return "mine";
  if (task.creator_id === userId) return "created";
  if (isParticipant(task, userId)) return "participating";
  const inMyTeams = task.team_id
    ? mine.teams.has(task.team_id)
    : mine.clients.has(
        data.contracts.find((k) => k.id === task.contract_id)?.client_id ?? "",
      );
  return inMyTeams ? "teams" : "others";
}
/** The task's team name ("Sem equipe" when none). */
export function taskTeamName(data: Snapshot, task: Task) {
  return (
    (task.team_id && data.teams.find((t) => t.id === task.team_id)?.name) ||
    "Sem equipe"
  );
}
/**
 * Who should be responsible when the task moves to `target` — only a
 * suggestion: the person moving the task confirms or picks someone else.
 * Delegation and missing information go back to the creator, validation to
 * whoever validates, execution and changes to whoever last executed it.
 */
export function suggestedAssignee(
  data: Snapshot,
  task: Task,
  target: Status,
  events: TaskEvent[] = [],
): string {
  const active = (id?: string | null) =>
    !!id && data.members.some((m) => m.user_id === id && m.active);
  const pick = (...ids: (string | null | undefined)[]) =>
    ids.find(active) ?? task.assignee_id;
  if (target === task.status) return task.assignee_id;
  if (target === "open" || target === "returned") return pick(task.creator_id);
  if (target === "review") {
    const review = projectReview(
      data.projects.find((p) => p.id === task.project_id),
    );
    if (!review.required) return task.assignee_id;
    if (task.project_id && review.approver === "supervisor") {
      const supervisors = data.members
        .filter((m) => m.active && isTaskSupervisor(data, task, m.user_id))
        .map((m) => m.user_id);
      return supervisors.includes(task.assignee_id)
        ? task.assignee_id
        : pick(supervisors[0], task.creator_id);
    }
    return pick(task.creator_id);
  }
  return pick(lastExecutor(task, events));
}
/** Whoever last held the task while it was being executed or changed. */
function lastExecutor(task: Task, events: TaskEvent[]) {
  if (["progress", "rejected"].includes(task.status)) return task.assignee_id;
  const executing = [...events]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .find(
      (e) =>
        ["progress", "rejected"].includes(String(e.detail.from)) &&
        typeof e.detail.assignee_from === "string",
    );
  return executing
    ? String(executing.detail.assignee_from)
    : task.status === "open"
      ? task.assignee_id
      : null;
}
/**
 * How long the task has spent in each status (as in ClickUp's status menu),
 * from its history: each move records since when the previous status held
 * (older events don't, and history older than a month is pruned, so that
 * time is only partly counted). The current status runs from when the task
 * entered it.
 */
export function statusDurations(
  task: Pick<Task, "status" | "created_at" | "status_changed_at">,
  events: TaskEvent[],
  now = Date.now(),
): Partial<Record<Status, number>> {
  const result: Partial<Record<Status, number>> = {};
  const add = (s: Status, ms: number) => {
    if (ms > 0) result[s] = (result[s] ?? 0) + ms;
  };
  const moves = events
    .filter(
      (e) =>
        typeof e.detail.from === "string" &&
        typeof e.detail.to === "string" &&
        e.detail.from !== e.detail.to,
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const created = events.some((e) => e.action === "created");
  let since = created || !moves.length ? Date.parse(task.created_at) : NaN;
  for (const e of moves) {
    const at = Date.parse(e.created_at);
    const start =
      typeof e.detail.status_since === "string"
        ? Date.parse(e.detail.status_since)
        : since;
    if (Number.isFinite(start)) add(e.detail.from as Status, at - start);
    since = at;
  }
  const entered = task.status_changed_at
    ? Date.parse(task.status_changed_at)
    : since;
  if (Number.isFinite(entered)) add(task.status, now - entered);
  return result;
}
/** "3 d", "5 h", "12 min" — a compact time-in-status label. */
export function shortSpan(ms: number) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(min, 1)} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

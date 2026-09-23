import { type Task, type TimeEntry, type Snapshot } from "./types";
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

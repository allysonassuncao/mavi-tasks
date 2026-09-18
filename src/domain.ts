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
export function names(data: Snapshot, task: Task) {
  const contract = data.contracts.find((c) => c.id === task.contract_id);
  return {
    client: data.clients.find((c) => c.id === contract?.client_id),
    product: data.products.find((p) => p.id === contract?.product_id),
    project: data.projects.find((p) => p.id === task.project_id),
    member: data.members.find((m) => m.user_id === task.assignee_id),
  };
}

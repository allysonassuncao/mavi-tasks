import type { Task } from "./types";
export function calendarDate(value: string) {
  return new Date(`${value}T12:00:00`);
}
export function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function addDays(value: string, days: number) {
  const d = calendarDate(value);
  d.setDate(d.getDate() + days);
  return localDate(d);
}
export function monthRange(month: string) {
  const [year, m] = month.split("-").map(Number);
  return {
    start: localDate(new Date(year, m - 1, 1, 12)),
    end: localDate(new Date(year, m, 0, 12)),
  };
}
export function calendarDays(month: string) {
  const { start, end } = monthRange(month);
  const first = addDays(start, -calendarDate(start).getDay());
  const last = addDays(end, 6 - calendarDate(end).getDay());
  const days: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}
export function taskStart(task: Task) {
  return (
    task.start_date ??
    (task.created_at.slice(0, 10) < task.due_date
      ? task.created_at.slice(0, 10)
      : task.due_date)
  );
}
export function overlaps(task: Task, start: string, end: string) {
  return taskStart(task) <= end && task.due_date >= start;
}
export function ganttPlacement(task: Task, days: string[]) {
  const first = days.findIndex((d) => d >= taskStart(task));
  let last = days.findIndex((d) => d >= task.due_date);
  if (last < 0) last = days.length - 1;
  return {
    start: Math.max(0, first) + 1,
    span: Math.max(1, last - Math.max(0, first) + 1),
  };
}

import { dateKey } from "./domain";
import type { Snapshot, Task, TimeEntry } from "./types";
import {
  addDays,
  daysBetween,
  metricDef,
  type DashboardFilters,
  type PanelResult,
  type PanelSpec,
  type Query,
  type SeriesRow,
} from "./dashboards";

/**
 * The query engine of the database (mavi_private.dashboard_sql), in memory,
 * for the demonstration: same metrics, filters, groupings, top N with
 * "Outros" and zero-filled time buckets, over the demo's tasks and hours.
 */

type Row = { task: Task; entry?: TimeEntry };

function bucketStart(day: string, interval: PanelResult["interval"]) {
  if (interval === "month") return `${day.slice(0, 7)}-01`;
  if (interval === "week") {
    const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    return addDays(day, -dow);
  }
  return day;
}

function series(
  data: Snapshot,
  q: Query,
  group: PanelSpec["groupBy"],
  interval: PanelResult["interval"],
  from: string,
  to: string,
  filters: DashboardFilters,
  limit: number | null,
  tz: string,
  now: Date,
): SeriesRow[] {
  // Social Leads lives in its own store in the demo: no figures here.
  if (q.source === "social_leads")
    return group === "none" ? [{ k: "total", v: 0 }] : [];
  const today = dateKey(now, tz);
  const contract = new Map(data.contracts.map((k) => [k.id, k]));
  const taskById = new Map(data.tasks.map((t) => [t.id, t]));
  const day = (ts: string | null | undefined) =>
    ts ? dateKey(new Date(ts), tz) : null;
  const late = (t: Task) =>
    (t.status !== "done" && t.due_date < today) ||
    (!!t.delivered_at && (day(t.delivered_at) ?? "") > t.due_date);
  const rows: Row[] =
    q.source === "tasks"
      ? data.tasks.filter((t) => !t.archived).map((task) => ({ task }))
      : data.hours.flatMap((entry) => {
          const task = taskById.get(entry.task_id);
          return task ? [{ task, entry }] : [];
        });
  const dateOf = (r: Row) =>
    q.source === "hours"
      ? day(r.entry!.started_at)
      : q.dateField === "due_date"
        ? r.task.due_date
        : day(
            q.dateField === "delivered_at"
              ? r.task.delivered_at
              : r.task.created_at,
          );
  const field = (r: Row, name: string): string | null => {
    const k = contract.get(r.task.contract_id);
    switch (name) {
      case "client":
        return k?.client_id ?? null;
      case "product":
        return k?.product_id ?? null;
      case "project":
        return r.task.project_id;
      case "team":
        return r.task.team_id;
      case "person":
        return q.source === "hours" ? r.entry!.user_id : r.task.assignee_id;
      case "creator":
        return r.task.creator_id;
      case "status":
        return r.task.status;
      case "priority":
        return r.task.priority;
      case "entry_source":
        return r.entry?.source ?? null;
      default:
        return null;
    }
  };
  const allFilters = [
    ...q.filters,
    ...(
      [
        ["client", filters.clients],
        ["product", filters.products],
        ["team", filters.teams],
        ["person", filters.people],
      ] as const
    )
      .filter(([, values]) => values?.length)
      .map(([f, values]) => ({ field: f, op: "in" as const, values: values! })),
  ];
  const kept = rows.filter((r) => {
    const d = dateOf(r);
    if (!d || d < from || d > to) return false;
    if (q.metric === "lead_time_days" && !r.task.delivered_at) return false;
    return allFilters.every((f) => {
      if (!f.values.length) return true;
      if (f.field === "late") {
        const wanted = f.values[0] === "true";
        return (late(r.task) === wanted) === ((f.op ?? "in") === "in");
      }
      const v = field(r, f.field);
      const hit = v !== null && f.values.includes(v);
      return (f.op ?? "in") === "in" ? hit : !hit;
    });
  });
  const measure = (list: Row[]): number | null => {
    switch (q.metric) {
      case "count":
      case "entries":
        return list.length;
      case "late":
        return list.filter((r) => late(r.task)).length;
      case "estimated_hours":
        return list.reduce((s, r) => s + r.task.estimated_minutes, 0) / 60;
      case "lead_time_days":
        return list.length
          ? list.reduce(
              (s, r) =>
                s +
                (Date.parse(r.task.delivered_at!) -
                  Date.parse(r.task.created_at ?? r.task.delivered_at!)) /
                  86400000,
              0,
            ) / list.length
          : null;
      case "hours":
        return (
          list.reduce(
            (s, r) =>
              s +
              (Date.parse(r.entry!.ended_at ?? now.toISOString()) -
                Date.parse(r.entry!.started_at)),
            0,
          ) / 3600000
        );
      case "people":
        return new Set(list.map((r) => r.entry!.user_id)).size;
      case "tasks":
        return new Set(list.map((r) => r.entry!.task_id)).size;
      default:
        return null;
    }
  };
  if (group === "none") return [{ k: "total", v: measure(kept) }];
  const groups = new Map<string | null, Row[]>();
  for (const r of kept) {
    const key =
      group === "time" ? bucketStart(dateOf(r)!, interval) : field(r, group);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const additive = metricDef(q)?.additive ?? true;
  if (group === "time") {
    const out: SeriesRow[] = [];
    for (let k = bucketStart(from, interval); k <= to;) {
      const list = groups.get(k);
      out.push({ k, v: list ? measure(list) : additive ? 0 : null });
      k =
        interval === "month"
          ? `${new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 1)).toISOString().slice(0, 10)}`
          : addDays(k, interval === "week" ? 7 : 1);
    }
    return out;
  }
  const name = (key: string | null) => {
    if (key === null) return null;
    const lookup = {
      client: data.clients,
      product: data.products,
      project: data.projects,
      team: data.teams,
    }[group as "client"];
    if (lookup) return lookup.find((x) => x.id === key)?.name ?? null;
    if (group === "person" || group === "creator")
      return data.members.find((m) => m.user_id === key)?.name ?? null;
    return key;
  };
  const ranked = [...groups]
    .map(([k, list]) => ({ k, l: name(k), v: measure(list) }))
    .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
  const lim = Math.min(Math.max(limit ?? 1000, 1), 1000);
  const top: SeriesRow[] = ranked.slice(0, lim);
  const rest = ranked.slice(lim);
  if (additive && rest.length)
    top.push({
      k: "__other__",
      l: "Outros",
      v: rest.reduce((s, r) => s + (r.v ?? 0), 0),
    });
  return top;
}

/** A panel's result, as dashboard_run returns it. */
export function runPanel(
  data: Snapshot,
  spec: PanelSpec,
  range: { from: string; to: string },
  filters: DashboardFilters,
  tz: string,
  now = new Date(),
): PanelResult {
  const days = daysBetween(range.from, range.to);
  const interval =
    !spec.interval || spec.interval === "auto"
      ? days <= 62
        ? "day"
        : days <= 366
          ? "week"
          : "month"
      : spec.interval;
  const limit = spec.formula?.expr
    ? null
    : Math.min(Math.max(spec.limit ?? 10, 1), 50);
  const run = (from: string, to: string) =>
    Object.fromEntries(
      spec.queries.map((q) => [
        q.ref,
        series(
          data,
          q,
          spec.groupBy,
          interval,
          from,
          to,
          filters,
          limit,
          tz,
          now,
        ),
      ]),
    );
  return {
    series: run(range.from, range.to),
    previous:
      spec.groupBy === "none" && spec.compare
        ? run(addDays(range.from, -days), addDays(range.from, -1))
        : {},
    interval,
    computed_at: now.toISOString(),
  };
}

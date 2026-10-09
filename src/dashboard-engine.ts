import { dateKey } from "./domain";
import type { Snapshot, Task, TimeEntry } from "./types";
import {
  addDays,
  attributionOf,
  daysBetween,
  metricDef,
  type DashboardFilters,
  type PanelRecords,
  type PanelResult,
  type RecordRow,
  type RecordSelection,
  type PanelSpec,
  type Query,
  type SeriesRow,
} from "./dashboards";

/**
 * The query engine of the database (mavi_private.dashboard_sql), in memory,
 * for the demonstration: same metrics, filters, groupings, top N with
 * "Outros" and zero-filled time buckets, over the demo's tasks and hours —
 * and the records behind each figure (migration 20270224090000).
 */

type Row = { task: Task; entry?: TimeEntry };

/** Task metrics over delivered tasks only. */
const DELIVERED_ONLY = [
  "lead_time_days",
  "on_time_rate",
  "on_time_original_rate",
  "delay_days",
  "first_pass_rate",
  "rework_per_task",
  "smart_hit_rate",
  "rule_hit_rate",
  "smart_error_days",
];

function bucketStart(day: string, interval: PanelResult["interval"]) {
  if (interval === "month") return `${day.slice(0, 7)}-01`;
  if (interval === "week") {
    const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    return addDays(day, -dow);
  }
  return day;
}

/**
 * The rows a query keeps (the period, its filters and the dashboard's), how
 * a list of them measures, the categories of a row and their names; null
 * for the sources the demo has no data of.
 */
function prepare(
  data: Snapshot,
  q: Query,
  group: PanelSpec["groupBy"],
  interval: PanelResult["interval"],
  from: string,
  to: string,
  filters: DashboardFilters,
  tz: string,
  now: Date,
) {
  // Social Leads lives in its own store, and the demo keeps no status
  // history (status_history, reviews), notice deliveries, Radar items nor
  // due date changes: no figures here.
  if (
    q.source === "due_changes" ||
    q.source === "social_leads" ||
    q.source === "status_history" ||
    q.source === "reviews" ||
    q.source === "notices" ||
    q.source === "temperature" ||
    q.source === "radar" ||
    q.source === "agent_costs"
  )
    return null;
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
      case "person": {
        if (q.source === "hours") return r.entry!.user_id;
        // Migration 20270131090000: who the task counts for. The demo keeps
        // no status history: whoever executed it last stands for everyone
        // who did, and for whoever had it when the due date passed.
        const mode = attributionOf(q);
        if (mode === "assignee") return r.task.assignee_id;
        if (
          mode === "roles" &&
          (q.metric === "tight_due" || q.metric === "shorter_than_smart")
        )
          return r.task.creator_id;
        return r.task.executor_id ?? r.task.assignee_id;
      }
      case "creator":
        return r.task.creator_id;
      case "executor":
        return r.task.executor_id ?? r.task.assignee_id;
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
  // Migration 20270209090000: a team is its people — the teams of whoever
  // the row counts for ("Pessoa"), each once.
  const teamsOf = (r: Row) => {
    const person = field(r, "person");
    return [
      ...new Set(
        data.teamMembers
          .filter((m) => m.user_id === person)
          .map((m) => m.team_id),
      ),
    ];
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
    if (DELIVERED_ONLY.includes(q.metric) && !r.task.delivered_at) return false;
    return allFilters.every((f) => {
      if (!f.values.length) return true;
      if (f.field === "late") {
        const wanted = f.values[0] === "true";
        return (late(r.task) === wanted) === ((f.op ?? "in") === "in");
      }
      const values = f.field === "team" ? teamsOf(r) : [field(r, f.field)];
      const hit = values.some((v) => v !== null && f.values.includes(v));
      return (f.op ?? "in") === "in" ? hit : !hit;
    });
  });
  const deliveredDay = (t: Task) => day(t.delivered_at) ?? "";
  const share = (list: Row[], hit: (t: Task) => boolean) =>
    list.length
      ? (100 * list.filter((r) => hit(r.task)).length) / list.length
      : null;
  const mean = (values: number[]) =>
    values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  const measure = (list: Row[]): number | null => {
    switch (q.metric) {
      case "on_time_rate":
        return share(list, (t) => deliveredDay(t) <= t.due_date);
      case "on_time_original_rate":
        return share(list, (t) => deliveredDay(t) <= t.original_due_date);
      case "delay_days":
        return mean(
          list
            .filter((r) => deliveredDay(r.task) > r.task.due_date)
            .map((r) => daysBetween(r.task.due_date, deliveredDay(r.task)) - 1),
        );
      case "rescheduled":
        return list.filter((r) => r.task.due_date !== r.task.original_due_date)
          .length;
      // Migration 20261201120000: the suggested due dates.
      case "smart_hit_rate": {
        const had = list.filter((r) => r.task.due_smart_date);
        return had.length
          ? (100 * had.filter((r) => deliveredDay(r.task) <= r.task.due_smart_date!).length) / had.length
          : null;
      }
      case "rule_hit_rate": {
        const had = list.filter((r) => r.task.due_rule_date);
        return had.length
          ? (100 * had.filter((r) => deliveredDay(r.task) <= r.task.due_rule_date!).length) / had.length
          : null;
      }
      case "smart_error_days":
        return mean(
          list
            .filter((r) => r.task.due_smart_date)
            .map(
              (r) =>
                Math.abs(Date.parse(deliveredDay(r.task)) - Date.parse(r.task.due_smart_date!)) /
                86400000,
            ),
        );
      case "tight_due":
        return list.filter((r) => r.task.due_tight_reason).length;
      case "shorter_than_smart":
        return list.filter(
          (r) => r.task.due_smart_date && r.task.original_due_date < r.task.due_smart_date,
        ).length;
      // Without the status history, the demo reads rework from the revision.
      case "first_pass_rate":
        return share(list, (t) => t.revision <= 1);
      case "rework_per_task":
        return mean(list.map((r) => Math.max(r.task.revision - 1, 0)));
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
  const keysOf = (r: Row): (string | null)[] => {
    if (group === "none") return [null];
    if (group === "time") return [bucketStart(dateOf(r)!, interval)];
    if (group === "team") {
      const teams = teamsOf(r);
      return teams.length ? teams : [null];
    }
    return [field(r, group)];
  };
  const name = (key: string | null) => {
    if (key === null) return null;
    const lookup = {
      client: data.clients,
      product: data.products,
      project: data.projects,
      team: data.teams,
    }[group as "client"];
    if (lookup) return lookup.find((x) => x.id === key)?.name ?? null;
    if (group === "person" || group === "creator" || group === "executor")
      return data.members.find((m) => m.user_id === key)?.name ?? null;
    return key;
  };
  return { kept, measure, keysOf, name, dateOf, contract };
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
  const p = prepare(data, q, group, interval, from, to, filters, tz, now);
  if (!p) return group === "none" ? [{ k: "total", v: 0 }] : [];
  const { kept, measure, keysOf, name } = p;
  if (group === "none") return [{ k: "total", v: measure(kept) }];
  const groups = new Map<string | null, Row[]>();
  for (const r of kept) {
    for (const key of keysOf(r)) {
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }
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

/** The panel's time buckets ("auto": by the length of the period). */
function intervalOf(spec: PanelSpec, range: { from: string; to: string }) {
  const days = daysBetween(range.from, range.to);
  return !spec.interval || spec.interval === "auto"
    ? days <= 62
      ? "day"
      : days <= 366
        ? "week"
        : "month"
    : spec.interval;
}

/** A panel's result, as dashboard_run returns it. */
export function runPanel(
  data: Snapshot,
  spec: PanelSpec,
  range: { from: string; to: string },
  filters: DashboardFilters,
  tz: string,
  now = new Date(),
  compare: { from: string; to: string } | null = null,
): PanelResult {
  const days = daysBetween(range.from, range.to);
  const interval = intervalOf(spec, range);
  const limit = spec.formula?.expr
    ? null
    : Math.min(Math.max(spec.limit ?? 10, 1), 50);
  const run = (from: string, to: string, top = limit) =>
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
          top,
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
    // The comparison: every group, with the period's interval.
    ...(compare
      ? { compare: run(compare.from, compare.to, null), compare_range: compare }
      : {}),
    interval,
    computed_at: now.toISOString(),
  };
}

/**
 * The records behind one query of a panel, as dashboard_panel_records
 * returns them: one per task (or time entry, task with hours, person) and
 * category, with its part of the value; the value over the categories
 * chosen. Same rules as the database: nothing that adds 0 to a sum or a
 * count, zeros kept in averages and rates (and in hours).
 */
export function runRecords(
  data: Snapshot,
  spec: PanelSpec,
  ref: string,
  range: { from: string; to: string },
  filters: DashboardFilters,
  tz: string,
  selection: RecordSelection,
  now = new Date(),
): PanelRecords {
  const q = spec.queries.find((x) => x.ref === ref) ?? spec.queries[0];
  const kind: PanelRecords["kind"] =
    q.source !== "hours"
      ? "task"
      : q.metric === "tasks"
        ? "task"
        : q.metric === "people"
          ? "person"
          : "entry";
  const empty: PanelRecords = {
    kind,
    value: null,
    total: 0,
    rows: [],
    can_open: true,
    computed_at: now.toISOString(),
  };
  const p = prepare(
    data,
    q,
    spec.groupBy,
    intervalOf(spec, range),
    range.from,
    range.to,
    filters,
    tz,
    now,
  );
  if (!p) return empty;
  const wanted = (key: string | null) => {
    const k = key ?? "__null__";
    if (selection.keys?.length) return selection.keys.includes(k);
    if (selection.exclude?.length) return !selection.exclude.includes(k);
    return true;
  };
  const idOf = (r: Row) =>
    kind === "task"
      ? (r.entry?.task_id ?? r.task.id)
      : kind === "person"
        ? r.entry!.user_id
        : r.entry!.id;
  const chosen: Row[] = [];
  const groups = new Map<string, { id: string; k: string | null; rows: Row[] }>();
  for (const r of p.kept)
    for (const key of p.keysOf(r)) {
      if (!wanted(key)) continue;
      chosen.push(r);
      const id = idOf(r);
      const g = groups.get(`${id}|${key}`);
      if (g) g.rows.push(r);
      else groups.set(`${id}|${key}`, { id, k: key, rows: [r] });
    }
  const def = metricDef(q);
  const additive = def?.additive ?? true;
  const distinct = q.source === "hours" && (q.metric === "tasks" || q.metric === "people");
  const member = (id: string | null | undefined) =>
    data.members.find((m) => m.user_id === id)?.name ?? null;
  const detail = (r: Row): Partial<RecordRow> => {
    const k = p.contract.get(r.task.contract_id);
    const where = {
      client: data.clients.find((c) => c.id === k?.client_id)?.name ?? null,
      product: data.products.find((x) => x.id === k?.product_id)?.name ?? null,
    };
    if (kind === "person") return { person: member(r.entry!.user_id) };
    if (kind === "entry")
      return {
        ...where,
        task: r.task.id,
        title: r.task.title,
        status: r.task.status,
        person: member(r.entry!.user_id),
        started_at: r.entry!.started_at,
        ended_at: r.entry!.ended_at,
        source: r.entry!.source,
      };
    const executor = r.task.executor_id ? member(r.task.executor_id) : null;
    return {
      ...where,
      task: r.task.id,
      title: r.task.title,
      status: r.task.status,
      priority: r.task.priority,
      assignee: member(r.task.assignee_id),
      executors: executor ? [executor] : [],
      creator: member(r.task.creator_id),
      created_at: r.task.created_at,
      due_date: r.task.due_date,
      original_due_date: r.task.original_due_date,
      delivered_at: r.task.delivered_at,
      estimated_minutes: r.task.estimated_minutes,
    };
  };
  const rows: RecordRow[] = [...groups.values()]
    .map((g) => ({
      id: g.id,
      k: g.k,
      l: p.name(g.k),
      v: p.measure(g.rows),
      d: g.rows.map((r) => p.dateOf(r) ?? "").sort().at(-1) ?? null,
      n: g.rows.length,
      ...detail(g.rows[0]),
    }))
    .filter((r) =>
      q.source === "hours" || (!additive && !distinct)
        ? r.v !== null
        : (r.v ?? 0) !== 0,
    )
    .sort((a, b) => (b.d ?? "").localeCompare(a.d ?? "") || a.id.localeCompare(b.id));
  return {
    ...empty,
    value: p.measure(chosen),
    total: rows.length,
    rows: rows.slice(0, 1000),
  };
}

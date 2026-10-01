import { supabase } from "./supabase";
import { dateKey } from "./domain";
import { priorities, statuses, type Status } from "./types";
import {
  metricDef,
  rangeOptions,
  sources,
  parseFormula,
  evaluate,
  queryName,
  type GroupBy,
  type Panel,
  type PanelResult,
  type PanelSpec,
  type Query,
  type QueryFilter,
  type Source,
  type Unit,
  type DashboardRange,
  type DashboardVariables,
  type SeriesRow,
  type Dashboard,
  type LinkAccess,
} from "./dashboard-catalog";

export * from "./dashboard-catalog";

/**
 * Dashboards (migration 20260930140000_dashboards): panels of queries over
 * the company's tasks and hours, computed in the database by
 * dashboard_panel_data / dashboard_preview. This module holds the catalog
 * the editor offers (the database accepts exactly these names), periods,
 * formulas, how results become series, the grid layout and the API calls.
 */


/** Categorical colors, fixed order (validated for color-vision deficiency). */
export const seriesColors = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
];
export const OTHER_COLOR = "#a3acab";

// ------------------------------------------------------------ periods
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (key: string) => new Date(`${key}T00:00:00Z`);
export const addDays = (key: string, days: number) =>
  iso(new Date(utc(key).getTime() + days * 86400000));
export const daysBetween = (from: string, to: string) =>
  Math.round((utc(to).getTime() - utc(from).getTime()) / 86400000) + 1;

/** A dashboard period as dates (inclusive) in the company's timezone. */
export function resolveRange(
  range: DashboardRange | undefined,
  timezone: string,
  now = new Date(),
): { from: string; to: string } {
  if (range && "from" in range) return { from: range.from, to: range.to };
  const today = dateKey(now, timezone);
  const [y, m] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthStart = `${y}-${pad(m)}-01`;
  switch (range?.preset ?? "30d") {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "month":
      return { from: monthStart, to: today };
    case "last_month": {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case "quarter":
      return {
        from: `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`,
        to: today,
      };
    case "year":
      return { from: `${y}-01-01`, to: today };
    case "12m":
      return { from: addDays(today, -364), to: today };
    default:
      return { from: addDays(today, -29), to: today };
  }
}

export function rangeLabel(range: DashboardRange | undefined) {
  if (range && "from" in range)
    return `${shortDay(range.from)} – ${shortDay(range.to)}`;
  return (
    rangeOptions.find((r) => r.key === (range?.preset ?? "30d"))?.label ??
    "Últimos 30 dias"
  );
}
const shortDay = (key: string) =>
  utc(key).toLocaleDateString("pt-BR", { timeZone: "UTC" });

/** "set/26", "12/09", "sem. 12/09" — a time bucket on an axis. */
export function bucketLabel(key: string, interval: PanelResult["interval"]) {
  const d = utc(key);
  if (interval === "month")
    return d
      .toLocaleDateString("pt-BR", {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      })
      .replace(". de ", "/")
      .replace(".", "");
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });
}


// ------------------------------------------------------------ series
export type DisplaySeries = {
  /** Unique within the panel: the query's letter, or "formula". */
  id: string;
  name: string;
  color: string;
  /** Each query keeps its metric's unit (hours next to counts in a table). */
  unit: Unit;
  values: (number | null)[];
  previous?: number | null;
};
export type Display = {
  /** Keys of the x axis / categories, in order ("__other__" = Outros). */
  keys: string[];
  labels: string[];
  series: DisplaySeries[];
  unit: Unit;
  interval: PanelResult["interval"];
};

const emptyLabel: Partial<Record<GroupBy, string>> = {
  project: "Sem projeto",
  team: "Sem equipe",
  person: "Sem pessoa",
  executor: "Sem pessoa",
  previous: "Sem responsável anterior",
  validator: "Sem pessoa",
  client: "Sem cliente",
};
/** The label of a category, with status and priority in words. */
export function categoryLabel(group: GroupBy, row: SeriesRow) {
  if (row.k === "__other__") return "Outros";
  if (row.k === null) return emptyLabel[group] ?? "Sem valor";
  if (group === "status") return statuses[row.k as Status]?.label ?? row.k;
  if (group === "priority")
    return priorities[row.k as keyof typeof priorities] ?? row.k;
  return row.l ?? row.k;
}

/** The unit a panel shows: its own, the formula's (number) or the metric's. */
export function panelUnit(spec: PanelSpec): Unit {
  if (spec.unit) return spec.unit;
  if (spec.formula?.expr) return "number";
  const first = spec.queries.find((q) => !q.hidden) ?? spec.queries[0];
  return (first && metricDef(first)?.unit) || "number";
}

/**
 * Turns a panel's result into what charts draw: the categories or time
 * buckets, and one series per visible query — or a single one computed by
 * the formula, per key.
 */
export function buildDisplay(spec: PanelSpec, result: PanelResult): Display {
  const group = spec.groupBy;
  const unit = panelUnit(spec);
  const interval = result.interval;
  const labels = new Map<string, string>();
  const valueOf = new Map<string, Map<string, number | null>>();
  const order: string[] = [];
  for (const q of spec.queries) {
    const rows = result.series[q.ref] ?? [];
    const map = new Map<string, number | null>();
    for (const row of rows) {
      const key = row.k ?? "__null__";
      map.set(key, row.v === null ? null : Number(row.v));
      if (!labels.has(key)) {
        labels.set(
          key,
          group === "time"
            ? bucketLabel(key, interval)
            : categoryLabel(group, row),
        );
        order.push(key);
      }
    }
    valueOf.set(q.ref, map);
  }
  const prevOf = (ref: string) => {
    const row = result.previous?.[ref]?.[0];
    return row ? (row.v === null ? null : Number(row.v)) : undefined;
  };
  const formula = spec.formula?.expr ? parseFormula(spec.formula.expr) : null;
  let keys = group === "time" ? [...order].sort() : order;
  let series: DisplaySeries[];
  if (formula?.ok) {
    const node = formula.node;
    const at = (
      key: string,
      from: (ref: string) => number | null | undefined,
    ) =>
      evaluate(
        node,
        Object.fromEntries(
          spec.queries.map((q) => [q.ref, from(q.ref) ?? null]),
        ),
      );
    let values = keys.map((k) => at(k, (ref) => valueOf.get(ref)?.get(k)));
    // A formula brings every group: rank them here and keep the top N.
    if (group !== "time" && group !== "none") {
      const ranked = keys
        .map((k, i) => ({ k, v: values[i] }))
        .filter((r) => r.k !== "__other__")
        .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
        .slice(0, spec.limit ?? 10);
      keys = ranked.map((r) => r.k);
      values = ranked.map((r) => r.v);
    }
    series = [
      {
        id: "formula",
        name: spec.formula?.label?.trim() || "Fórmula",
        color: seriesColors[0],
        unit,
        values,
        previous: spec.compare ? at("total", prevOf) : undefined,
      },
    ];
  } else {
    series = spec.queries
      .filter((q) => !q.hidden)
      .map((q, i) => ({
        id: q.ref,
        name: queryName(q),
        color: seriesColors[i % seriesColors.length],
        unit: spec.unit ?? metricDef(q)?.unit ?? unit,
        values: keys.map((k) => valueOf.get(q.ref)?.get(k) ?? null),
        previous: spec.compare ? prevOf(q.ref) : undefined,
      }));
  }
  return {
    keys,
    labels: keys.map((k) => labels.get(k) ?? k),
    series,
    unit,
    interval,
  };
}

const numberFormat = (decimals: number) =>
  new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  });
/** A value in the panel's unit: "1.234", "12,5 h", "3,2 dias", "45,1%". */
export function formatValue(
  v: number | null | undefined,
  unit: Unit,
  decimals?: number,
) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (unit === "money") return `R$ ${numberFormat(decimals ?? 2).format(v)}`;
  const d =
    decimals ??
    (Math.abs(v) >= 100 ? 0 : unit === "number" && Number.isInteger(v) ? 0 : 1);
  const n = numberFormat(d).format(v);
  if (unit === "hours") return `${n} h`;
  if (unit === "days") return `${n} ${Math.abs(v) === 1 ? "dia" : "dias"}`;
  if (unit === "percent") return `${n}%`;
  return n;
}
/** Short axis ticks: "1,2 mil", "3 mi". */
export function formatTick(v: number, unit: Unit) {
  const abs = Math.abs(v);
  const n =
    abs >= 1e6
      ? `${numberFormat(1).format(v / 1e6)} mi`
      : abs >= 1e4
        ? `${numberFormat(1).format(v / 1e3)} mil`
        : numberFormat(abs < 10 && !Number.isInteger(v) ? 1 : 0).format(v);
  return unit === "percent"
    ? `${n}%`
    : unit === "hours"
      ? `${n} h`
      : unit === "money"
        ? `R$ ${n}`
        : n;
}

// ------------------------------------------------------------ layout
export const GRID_COLUMNS = 12;
type Rect = Pick<Panel, "x" | "y" | "w" | "h">;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Packs panels upwards (like Grafana): each panel, top to bottom, moves up
 * while nothing is in its way. `pinned` keeps its place and the others flow
 * around it.
 */
export function compact(panels: Panel[], pinned?: string): Panel[] {
  const sorted = [...panels].sort((a, b) =>
    a.id === pinned ? -1 : b.id === pinned ? 1 : a.y - b.y || a.x - b.x,
  );
  const placed: Panel[] = [];
  for (const p of sorted) {
    const next = { ...p, x: Math.min(Math.max(0, p.x), GRID_COLUMNS - p.w) };
    if (p.id !== pinned) {
      next.y = 0;
      while (placed.some((q) => overlaps(q, next))) next.y++;
    }
    placed.push(next);
  }
  return panels.map((p) => placed.find((q) => q.id === p.id)!);
}

/**
 * Moves or resizes one panel; the rest reflows around it. Placed exactly
 * over a panel of the same size, the two swap places (reordering a row of
 * numbers); otherwise the panels in the way move down. While dragging, call
 * it with the layout from the start of the drag, not the previous step.
 */
export function placePanel(panels: Panel[], id: string, rect: Rect): Panel[] {
  const w = Math.min(Math.max(1, rect.w), GRID_COLUMNS);
  const target = {
    x: Math.min(Math.max(0, rect.x), GRID_COLUMNS - w),
    y: Math.max(0, rect.y),
    w,
    h: Math.min(Math.max(2, rect.h), 24),
  };
  const moving = panels.find((p) => p.id === id);
  const hits = panels.filter((p) => p.id !== id && overlaps(p, target));
  const swap =
    moving &&
    hits.length === 1 &&
    hits[0].x === target.x &&
    hits[0].y === target.y &&
    hits[0].w === moving.w &&
    hits[0].h === moving.h &&
    target.w === moving.w &&
    target.h === moving.h
      ? hits[0].id
      : null;
  return compact(
    panels.map((p) =>
      p.id === id
        ? { ...p, ...target }
        : p.id === swap
          ? { ...p, x: moving!.x, y: moving!.y }
          : p,
    ),
    id,
  );
}

/** Where a new panel goes: the first free spot of its width, from the top. */
export function freeSpot(panels: Panel[], w: number, h: number): Rect {
  for (let y = 0; ; y++)
    for (let x = 0; x + w <= GRID_COLUMNS; x++) {
      const rect = { x, y, w, h };
      if (!panels.some((p) => overlaps(p, rect))) return rect;
    }
}

export const newPanelId = () =>
  `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

/** A good starting point: the main figures of the operation. */
export function starterPanels(): Panel[] {
  const q = (
    ref: string,
    source: Source,
    metric: string,
    extra: Partial<Query> = {},
  ): Query => ({
    ref,
    source,
    metric,
    filters: [],
    ...extra,
  });
  const done: QueryFilter = { field: "status", op: "in", values: ["done"] };
  return [
    {
      id: "criadas",
      title: "Tarefas criadas",
      x: 0,
      y: 0,
      w: 3,
      h: 3,
      spec: {
        viz: "stat",
        groupBy: "none",
        compare: true,
        queries: [q("A", "tasks", "count")],
      },
    },
    {
      id: "entregues",
      title: "Entregas",
      x: 3,
      y: 0,
      w: 3,
      h: 3,
      spec: {
        viz: "stat",
        groupBy: "none",
        compare: true,
        queries: [
          q("A", "tasks", "count", {
            dateField: "delivered_at",
            filters: [done],
          }),
        ],
      },
    },
    {
      id: "no-prazo",
      title: "Entregas no prazo",
      x: 6,
      y: 0,
      w: 3,
      h: 3,
      spec: {
        viz: "stat",
        groupBy: "none",
        compare: true,
        unit: "percent",
        formula: { expr: "(A - B) / A * 100", label: "No prazo" },
        queries: [
          q("A", "tasks", "count", {
            dateField: "delivered_at",
            filters: [done],
            hidden: true,
          }),
          q("B", "tasks", "late", {
            dateField: "delivered_at",
            filters: [done],
            hidden: true,
          }),
        ],
      },
    },
    {
      id: "horas",
      title: "Horas registradas",
      x: 9,
      y: 0,
      w: 3,
      h: 3,
      spec: {
        viz: "stat",
        groupBy: "none",
        compare: true,
        queries: [q("A", "hours", "hours")],
      },
    },
    {
      id: "ritmo",
      title: "Criadas × entregues",
      x: 0,
      y: 3,
      w: 8,
      h: 5,
      spec: {
        viz: "line",
        groupBy: "time",
        interval: "auto",
        queries: [
          q("A", "tasks", "count", { label: "Criadas" }),
          q("B", "tasks", "count", {
            dateField: "delivered_at",
            filters: [done],
            label: "Entregues",
          }),
        ],
      },
    },
    {
      id: "status",
      title: "Tarefas por status",
      x: 8,
      y: 3,
      w: 4,
      h: 5,
      spec: {
        viz: "donut",
        groupBy: "status",
        queries: [q("A", "tasks", "count")],
      },
    },
    {
      id: "clientes-horas",
      title: "Horas por cliente",
      x: 0,
      y: 8,
      w: 6,
      h: 6,
      spec: {
        viz: "hbar",
        groupBy: "client",
        limit: 10,
        queries: [q("A", "hours", "hours")],
      },
    },
    {
      id: "pessoas",
      title: "Por pessoa",
      x: 6,
      y: 8,
      w: 6,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "person",
        limit: 20,
        queries: [
          q("A", "tasks", "count", { label: "Tarefas" }),
          q("B", "tasks", "late", { label: "Atrasadas" }),
          q("C", "hours", "hours", { label: "Horas registradas" }),
        ],
      },
    },
  ];
}

/** Social Leads: approvals, adjustments, time to approval and stages. */
export function socialLeadsPanels(): Panel[] {
  const q = (
    ref: string,
    metric: string,
    extra: Partial<Query> = {},
  ): Query => ({
    ref,
    source: "social_leads",
    metric,
    dateField: "event",
    filters: [],
    ...extra,
  });
  const stat = (
    id: string,
    title: string,
    x: number,
    y: number,
    w: number,
    metric: string,
    extra: Partial<PanelSpec> = {},
  ): Panel => ({
    id,
    title,
    x,
    y,
    w,
    h: 3,
    spec: {
      viz: "stat",
      groupBy: "none",
      compare: true,
      queries: [q("A", metric)],
      ...extra,
    },
  });
  return [
    stat("aprovacoes", "Aprovações de posts", 0, 0, 3, "approvals"),
    stat("taxa-aprovacao", "Taxa de aprovação", 3, 0, 3, "approval_rate", {
      unit: "percent",
    }),
    stat("reprovas", "Pedidos de ajuste", 6, 0, 3, "rejections"),
    stat("taxa-reprova", "Taxa de reprova", 9, 0, 3, "rejection_rate", {
      unit: "percent",
    }),
    stat(
      "ajustes-post",
      "Ajustes por post avaliado",
      0,
      3,
      4,
      "adjust_per_post",
      {
        decimals: 2,
      },
    ),
    stat(
      "tempo-aprovacao",
      "Tempo até a aprovação do plano",
      4,
      3,
      4,
      "approval_days",
      {
        unit: "days",
      },
    ),
    stat("clientes", "Clientes no Social Leads", 8, 3, 4, "clients", {
      compare: false,
    }),
    {
      id: "decisoes-tempo",
      title: "Aprovações × ajustes",
      x: 0,
      y: 6,
      w: 8,
      h: 5,
      spec: {
        viz: "line",
        groupBy: "time",
        interval: "auto",
        queries: [
          q("A", "approvals", { label: "Aprovações" }),
          q("B", "rejections", { label: "Ajustes" }),
        ],
      },
    },
    {
      id: "etapas",
      title: "Clientes por etapa",
      x: 8,
      y: 6,
      w: 4,
      h: 5,
      spec: {
        viz: "donut",
        groupBy: "stage",
        queries: [q("A", "clients")],
      },
    },
    {
      id: "por-cliente",
      title: "Por cliente",
      x: 0,
      y: 11,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "client",
        limit: 20,
        queries: [
          q("A", "approvals", { label: "Aprovações" }),
          q("B", "rejections", { label: "Ajustes" }),
          q("C", "approval_rate", { label: "Taxa de aprovação" }),
          q("D", "approval_days", { label: "Dias até aprovar" }),
        ],
      },
    },
  ];
}

// ------------------------------------------------------------ API
const db = () => {
  if (!supabase) throw Error("Supabase não configurado");
  return supabase;
};
const DASHBOARD_COLUMNS =
  "id,company_id,name,description,panels,variables,link_access,share_token,has_password,version,created_by,updated_by,created_at,updated_at";

export async function listDashboards(company: string): Promise<Dashboard[]> {
  const { data, error } = await db()
    .from("dashboards")
    .select(DASHBOARD_COLUMNS)
    .eq("company_id", company)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Dashboard[];
}

export async function getDashboard(id: string): Promise<Dashboard | null> {
  const { data, error } = await db()
    .from("dashboards")
    .select(DASHBOARD_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as Dashboard | null;
}

export async function saveDashboard(
  company: string,
  d: Pick<Dashboard, "name" | "description" | "panels" | "variables"> & {
    id?: string | null;
    version?: number | null;
  },
): Promise<Dashboard> {
  const { data, error } = await db().rpc("save_dashboard", {
    p_company: company,
    p_dashboard: d.id ?? null,
    p_name: d.name,
    p_description: d.description,
    p_panels: d.panels,
    p_variables: d.variables,
    p_version: d.version ?? null,
  });
  if (error) throw error;
  return data as Dashboard;
}

export async function deleteDashboard(id: string) {
  const { error } = await db().rpc("delete_dashboard", { p_dashboard: id });
  if (error) throw error;
}

export type DashboardSharing = {
  link_access: LinkAccess;
  password?: string;
  users: string[];
  teams: string[];
  newLink?: boolean;
};
export async function setDashboardSharing(
  id: string,
  s: DashboardSharing,
): Promise<Dashboard> {
  const { data, error } = await db().rpc("set_dashboard_sharing", {
    p_dashboard: id,
    p_link_access: s.link_access,
    p_password: s.password || null,
    p_users: s.users,
    p_teams: s.teams,
    p_new_link: !!s.newLink,
  });
  if (error) throw error;
  return data as Dashboard;
}

export async function dashboardMembers(id: string) {
  const { data, error } = await db()
    .from("dashboard_members")
    .select("user_id,team_id")
    .eq("dashboard_id", id);
  if (error) throw error;
  const rows = (data ?? []) as {
    user_id: string | null;
    team_id: string | null;
  }[];
  return {
    users: rows.flatMap((r) => (r.user_id ? [r.user_id] : [])),
    teams: rows.flatMap((r) => (r.team_id ? [r.team_id] : [])),
  };
}

/** Where a panel's data comes from: the app (id) or a shared link (token). */
export type PanelSource =
  | { kind: "app"; dashboard: string }
  | { kind: "link"; token: string; password?: string };

export async function panelData(
  source: PanelSource,
  panel: string,
  range: { from: string; to: string },
  vars: DashboardVariables | null,
  fresh = false,
): Promise<PanelResult> {
  const { data, error } = await db().rpc("dashboard_panel_data", {
    p_dashboard: source.kind === "app" ? source.dashboard : null,
    p_panel: panel,
    p_from: range.from,
    p_to: range.to,
    p_vars: vars,
    p_token: source.kind === "link" ? source.token : null,
    p_password: source.kind === "link" ? (source.password ?? null) : null,
    p_fresh: fresh,
  });
  if (error) throw error;
  if (data?.error) throw Error(data.error);
  return data as PanelResult;
}

export async function previewPanel(
  company: string,
  spec: PanelSpec,
  range: { from: string; to: string },
  vars: DashboardVariables,
): Promise<PanelResult> {
  const { data, error } = await db().rpc("dashboard_preview", {
    p_company: company,
    p_spec: spec,
    p_from: range.from,
    p_to: range.to,
    p_vars: vars,
  });
  if (error) throw error;
  return data as PanelResult;
}

export type SharedDashboard =
  | { status: "password"; wrong: boolean }
  | { status: "locked" }
  | {
      status: "ok";
      id: string;
      name: string;
      description: string;
      panels: Panel[];
      variables: DashboardVariables;
      updated_at: string;
      timezone: string;
      company: string;
    };
export async function sharedDashboard(
  token: string,
  password?: string,
): Promise<SharedDashboard> {
  const { data, error } = await db().rpc("dashboard_shared", {
    p_token: token,
    p_password: password || null,
  });
  if (error) throw error;
  return data as SharedDashboard;
}

export const dashboardLinkUrl = (token: string) =>
  `${window.location.origin}/painel/${token}`;

/**
 * Performance of the team (migration 20261104090000): validations, time and
 * times in each status by person, delivery time by client, product, project
 * and whoever executed, first-pass approvals and deadlines.
 */
export function performancePanels(): Panel[] {
  const q = (
    ref: string,
    source: Source,
    metric: string,
    extra: Partial<Query> = {},
  ): Query => ({
    ref,
    source,
    metric,
    dateField: sources[source].dateFields[0].key,
    filters: [],
    ...extra,
  });
  const delivered = { dateField: "delivered_at" };
  const done: QueryFilter = { field: "status", op: "in", values: ["done"] };
  const inStatus = (
    ref: string,
    metric: string,
    status: string,
    label: string,
  ) =>
    q(ref, "status_history", metric, {
      label,
      filters: [{ field: "status", op: "in", values: [status] }],
    });
  const byStatus = (metric: string) => [
    inStatus("A", metric, "returned", "Devolvida"),
    inStatus("B", metric, "review", "Em validação"),
    inStatus("C", metric, "rejected", "Alteração"),
    inStatus("D", metric, "correction", "Correção"),
  ];
  const leadTime = (
    id: string,
    title: string,
    groupBy: GroupBy,
    x: number,
    y: number,
  ): Panel => ({
    id,
    title,
    x,
    y,
    w: 6,
    h: 6,
    spec: {
      viz: "hbar",
      groupBy,
      limit: 10,
      queries: [q("A", "tasks", "lead_time_days", delivered)],
    },
  });
  const stat = (id: string, title: string, x: number, query: Query): Panel => ({
    id,
    title,
    x,
    y: 0,
    w: 3,
    h: 3,
    spec: { viz: "stat", groupBy: "none", compare: true, queries: [query] },
  });
  return [
    stat(
      "de-primeira",
      "Aprovadas de primeira",
      0,
      q("A", "tasks", "first_pass_rate", delivered),
    ),
    stat(
      "taxa-aprovacao",
      "Aprovação na validação",
      3,
      q("A", "reviews", "approval_rate"),
    ),
    stat(
      "no-prazo",
      "Entregas no prazo",
      6,
      q("A", "tasks", "on_time_rate", delivered),
    ),
    stat(
      "prazo-medio",
      "Prazo médio de entrega",
      9,
      q("A", "tasks", "lead_time_days", delivered),
    ),
    {
      id: "validacoes-pessoa",
      title: "Validações por pessoa (quem enviou)",
      x: 0,
      y: 3,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "person",
        limit: 30,
        queries: [
          q("A", "reviews", "sent", { label: "Envios" }),
          q("B", "reviews", "approved", { label: "Aprovadas" }),
          q("C", "reviews", "reproved", { label: "Reprovadas" }),
          q("D", "reviews", "approval_rate", { label: "Taxa de aprovação" }),
        ],
      },
    },
    {
      id: "vezes-status",
      title: "Vezes em cada status, por pessoa",
      x: 0,
      y: 9,
      w: 6,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "person",
        limit: 30,
        queries: byStatus("entries"),
      },
    },
    {
      id: "horas-status",
      title: "Tempo com a tarefa em cada status, por pessoa",
      x: 6,
      y: 9,
      w: 6,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "person",
        limit: 30,
        queries: byStatus("hours"),
      },
    },
    leadTime(
      "prazo-cliente",
      "Prazo médio de entrega por cliente",
      "client",
      0,
      15,
    ),
    leadTime(
      "prazo-produto",
      "Prazo médio de entrega por produto",
      "product",
      6,
      15,
    ),
    leadTime(
      "prazo-projeto",
      "Prazo médio de entrega por projeto",
      "project",
      0,
      21,
    ),
    {
      id: "entregas-executor",
      title: "Entregas por quem executou",
      x: 6,
      y: 21,
      w: 6,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "executor",
        limit: 30,
        queries: [
          q("A", "tasks", "count", {
            ...delivered,
            filters: [done],
            label: "Entregas",
          }),
          q("B", "tasks", "lead_time_days", {
            ...delivered,
            label: "Prazo médio (dias)",
          }),
          q("C", "tasks", "first_pass_rate", {
            ...delivered,
            label: "De primeira",
          }),
          q("D", "tasks", "on_time_rate", { ...delivered, label: "No prazo" }),
        ],
      },
    },
    {
      id: "aprovadas-reprovadas",
      title: "Aprovadas × reprovadas",
      x: 0,
      y: 27,
      w: 12,
      h: 5,
      spec: {
        viz: "line",
        groupBy: "time",
        interval: "auto",
        queries: [
          q("A", "reviews", "approved", { label: "Aprovadas" }),
          q("B", "reviews", "reproved", { label: "Reprovadas" }),
        ],
      },
    },
    // Migration 20270131090000: each one's part of the time, apart from the
    // hours worked (the timer).
    {
      id: "tempo-papel",
      title: "Tempo por papel, por pessoa",
      x: 0,
      y: 32,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "person",
        limit: 30,
        queries: [
          q("A", "hours", "hours", { label: "Horas registradas (cronômetro)" }),
          q("B", "status_history", "hours", {
            label: "Executando",
            filters: [
              {
                field: "status",
                op: "in",
                values: ["progress", "rejected", "correction"],
              },
            ],
          }),
          inStatus("C", "hours", "review", "Validando"),
          inStatus("D", "hours", "returned", "Aguardando informação"),
        ],
      },
    },
  ];
}

/**
 * Prazos e previsões (migration 20261201120000): quanto as datas da MAVI e
 * das regras acertam, o erro médio da MAVI, e quem define prazos apertados
 * ou mais curtos que a sugestão (por quem criou a tarefa).
 */
export function duePanels(): Panel[] {
  const q = (ref: string, metric: string, extra: Partial<Query> = {}): Query => ({
    ref,
    source: "tasks",
    metric,
    dateField: "delivered_at",
    filters: [],
    ...extra,
  });
  const stat = (id: string, title: string, x: number, query: Query): Panel => ({
    id,
    title,
    x,
    y: 0,
    w: 3,
    h: 3,
    spec: { viz: "stat", groupBy: "none", compare: true, queries: [query] },
  });
  const created = { dateField: "created_at" };
  return [
    stat("mavi-acerto", "Entregas até a data da MAVI", 0, q("A", "smart_hit_rate")),
    stat("regra-acerto", "Entregas até a data da regra", 3, q("A", "rule_hit_rate")),
    stat("mavi-erro", "Erro médio da MAVI", 6, q("A", "smart_error_days")),
    stat("no-prazo-definido", "Entregas no prazo definido", 9, q("A", "on_time_rate")),
    {
      id: "acerto-tempo",
      title: "Acerto ao longo do tempo",
      x: 0,
      y: 3,
      w: 12,
      h: 5,
      spec: {
        viz: "line",
        groupBy: "time",
        interval: "auto",
        queries: [
          q("A", "smart_hit_rate", { label: "Data da MAVI" }),
          q("B", "rule_hit_rate", { label: "Data da regra" }),
          q("C", "on_time_rate", { label: "Prazo definido" }),
        ],
      },
    },
    {
      id: "acerto-pessoa",
      title: "Acerto por quem executou",
      x: 0,
      y: 8,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "executor",
        limit: 30,
        queries: [
          q("A", "count", { label: "Entregas" }),
          q("B", "smart_hit_rate", { label: "Até a data da MAVI" }),
          q("C", "rule_hit_rate", { label: "Até a data da regra" }),
          q("D", "smart_error_days", { label: "Erro da MAVI (dias)" }),
        ],
      },
    },
    {
      id: "prazos-quem-cria",
      title: "Prazos apertados e mais curtos que a MAVI, por quem criou",
      x: 0,
      y: 14,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "creator",
        limit: 30,
        queries: [
          q("A", "count", { ...created, label: "Tarefas criadas" }),
          q("B", "tight_due", { ...created, label: "Antes do mínimo" }),
          q("C", "shorter_than_smart", { ...created, label: "Mais curtos que a MAVI" }),
        ],
      },
    },
    // Migration 20270110090000: who changes due dates, and how much.
    {
      id: "prazo-mudancas",
      title: "Mudanças de prazo, por quem mudou",
      x: 0,
      y: 20,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "person",
        limit: 30,
        queries: (
          [
            ["A", "changes", "Mudanças"],
            ["B", "later", "Adiados"],
            ["C", "earlier", "Antecipados"],
            ["D", "avg_days", "Dias movidos (média)"],
          ] as const
        ).map(([ref, metric, label]) => ({
          ref,
          source: "due_changes" as const,
          metric,
          dateField: "created_at",
          filters: [],
          label,
        })),
      },
    },
  ];
}

/**
 * Radar do cliente (migration 20261230090000): os itens em aberto, os sérios,
 * as promessas vencidas, a evolução, os temas com mais clientes, os itens por
 * produto e por tópico, e os clientes com mais itens em aberto.
 */
export function radarPanels(): Panel[] {
  const q = (ref: string, metric: string, extra: Partial<Query> = {}): Query => ({
    ref,
    source: "radar",
    metric,
    dateField: "created_at",
    filters: [],
    ...extra,
  });
  const stat = (id: string, title: string, x: number, query: Query): Panel => ({
    id,
    title,
    x,
    y: 0,
    w: 3,
    h: 3,
    spec: { viz: "stat", groupBy: "none", compare: true, queries: [query] },
  });
  return [
    stat("novos", "Itens novos", 0, q("A", "items")),
    stat("em-aberto", "Em aberto", 3, q("A", "open_items")),
    stat("serios", "Sérios", 6, q("A", "severe")),
    stat("vencidos", "Com prazo vencido", 9, q("A", "overdue")),
    {
      id: "radar-tempo",
      title: "Itens novos no período",
      x: 0,
      y: 3,
      w: 12,
      h: 5,
      spec: { viz: "bar", groupBy: "time", interval: "auto", queries: [q("A", "items", { label: "Itens" })] },
    },
    {
      id: "radar-temas",
      title: "Temas com mais clientes",
      x: 0,
      y: 8,
      w: 6,
      h: 6,
      spec: { viz: "hbar", groupBy: "theme", limit: 15, queries: [q("A", "clients")] },
    },
    {
      id: "radar-produto",
      title: "Itens por produto",
      x: 6,
      y: 8,
      w: 6,
      h: 6,
      spec: { viz: "donut", groupBy: "product", queries: [q("A", "items")] },
    },
    {
      id: "radar-topico",
      title: "Itens por tópico",
      x: 0,
      y: 14,
      w: 6,
      h: 6,
      spec: { viz: "hbar", groupBy: "topic", queries: [q("A", "items"), q("B", "open_items", { label: "Em aberto" })] },
    },
    {
      id: "radar-cliente",
      title: "Clientes com mais itens em aberto",
      x: 6,
      y: 14,
      w: 6,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "client",
        limit: 30,
        queries: [
          q("A", "open_items", { label: "Em aberto" }),
          q("B", "severe", { label: "Sérios" }),
          q("C", "mentions", { label: "Ocorrências" }),
        ],
      },
    },
  ];
}

/**
 * Termômetro do cliente (migration 20261110090000): a temperatura média da
 * carteira, quantos clientes estão em faixa de alerta ou deram sinal, a
 * evolução no tempo, os clientes por faixa e por equipe.
 */
export function temperaturePanels(): Panel[] {
  const q = (
    ref: string,
    metric: string,
    extra: Partial<Query> = {},
  ): Query => ({
    ref,
    source: "temperature",
    metric,
    dateField: "day",
    filters: [],
    ...extra,
  });
  const stat = (id: string, title: string, x: number, query: Query): Panel => ({
    id,
    title,
    x,
    y: 0,
    w: 3,
    h: 3,
    spec: { viz: "stat", groupBy: "none", compare: true, queries: [query] },
  });
  return [
    stat("temperatura", "Temperatura média", 0, q("A", "score")),
    stat("clientes", "Clientes com temperatura", 3, q("A", "clients")),
    stat("em-alerta", "Em faixa de alerta", 6, q("A", "alert_rate")),
    stat("sinais", "Com sinal de alerta", 9, q("A", "flag_clients")),
    {
      id: "temperatura-tempo",
      title: "Temperatura média da carteira",
      x: 0,
      y: 3,
      w: 12,
      h: 5,
      spec: {
        viz: "line",
        groupBy: "time",
        interval: "auto",
        queries: [q("A", "score", { label: "Temperatura" })],
      },
    },
    {
      id: "por-faixa",
      title: "Clientes por faixa",
      x: 0,
      y: 8,
      w: 6,
      h: 6,
      spec: { viz: "donut", groupBy: "band", queries: [q("A", "clients")] },
    },
    {
      id: "por-equipe",
      title: "Temperatura por equipe",
      x: 6,
      y: 8,
      w: 6,
      h: 6,
      spec: {
        viz: "hbar",
        groupBy: "team",
        limit: 15,
        queries: [q("A", "score")],
      },
    },
    {
      id: "por-cliente",
      title: "Temperatura por cliente",
      x: 0,
      y: 14,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "client",
        limit: 30,
        queries: [q("A", "score", { label: "Temperatura" })],
      },
    },
  ];
}

/**
 * Mural de avisos (migration 20261107090000): alcance, leitura e
 * confirmação dos avisos, quem mais deixa pendências e quanto se demora
 * para ver e confirmar.
 */
export function noticesPanels(): Panel[] {
  const q = (
    ref: string,
    metric: string,
    extra: Partial<Query> = {},
  ): Query => ({
    ref,
    source: "notices",
    metric,
    dateField: "delivered_at",
    filters: [],
    ...extra,
  });
  const stat = (id: string, title: string, x: number, query: Query): Panel => ({
    id,
    title,
    x,
    y: 0,
    w: 3,
    h: 3,
    spec: { viz: "stat", groupBy: "none", compare: true, queries: [query] },
  });
  return [
    stat("avisos", "Avisos enviados", 0, q("A", "notices")),
    stat("taxa-visto", "Taxa de visto", 3, q("A", "seen_rate")),
    stat("taxa-confirmacao", "Taxa de confirmação", 6, q("A", "ack_rate")),
    stat("tempo-ver", "Tempo até ver", 9, q("A", "hours_to_see")),
    {
      id: "leitura-tempo",
      title: "Entregas × vistos",
      x: 0,
      y: 3,
      w: 12,
      h: 5,
      spec: {
        viz: "line",
        groupBy: "time",
        interval: "auto",
        queries: [
          q("A", "delivered", { label: "Entregas" }),
          q("B", "seen", { label: "Vistos" }),
        ],
      },
    },
    {
      id: "por-aviso",
      title: "Leitura por aviso",
      x: 0,
      y: 8,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "notice",
        limit: 30,
        queries: [
          q("A", "delivered", { label: "Entregas" }),
          q("B", "seen_rate", { label: "Visto" }),
          q("C", "ack_rate", { label: "Confirmação" }),
          q("D", "pending", { label: "Pendentes" }),
        ],
      },
    },
    {
      id: "pendencias-pessoa",
      title: "Quem mais deixa avisos pendentes",
      x: 0,
      y: 14,
      w: 6,
      h: 6,
      spec: {
        viz: "hbar",
        groupBy: "person",
        limit: 10,
        queries: [q("A", "pending")],
      },
    },
    {
      id: "visto-equipe",
      title: "Taxa de visto por equipe",
      x: 6,
      y: 14,
      w: 6,
      h: 6,
      spec: {
        viz: "hbar",
        groupBy: "team",
        limit: 10,
        queries: [q("A", "seen_rate")],
      },
    },
    {
      id: "tempo-pessoa",
      title: "Tempo até ver e confirmar, por pessoa",
      x: 0,
      y: 20,
      w: 12,
      h: 6,
      spec: {
        viz: "table",
        groupBy: "person",
        limit: 30,
        queries: [
          q("A", "hours_to_see", { label: "Até ver (h)" }),
          q("B", "hours_to_ack", { label: "Até confirmar (h)" }),
          q("C", "pending", { label: "Pendentes" }),
        ],
      },
    },
  ];
}

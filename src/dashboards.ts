import { supabase } from "./supabase";
import { dateKey } from "./domain";
import { priorities, statuses, type Status } from "./types";

/**
 * Dashboards (migration 20260930140000_dashboards): panels of queries over
 * the company's tasks and hours, computed in the database by
 * dashboard_panel_data / dashboard_preview. This module holds the catalog
 * the editor offers (the database accepts exactly these names), periods,
 * formulas, how results become series, the grid layout and the API calls.
 */

export type Source = "tasks" | "hours";
export type Viz = "stat" | "line" | "area" | "bar" | "hbar" | "donut" | "table";
export type GroupBy =
  | "none"
  | "time"
  | "client"
  | "product"
  | "project"
  | "team"
  | "person"
  | "creator"
  | "status"
  | "priority";
export type Interval = "auto" | "day" | "week" | "month";
export type Unit = "number" | "hours" | "days" | "percent";
export type FilterField =
  | "client"
  | "product"
  | "project"
  | "team"
  | "person"
  | "creator"
  | "status"
  | "priority"
  | "late"
  | "entry_source";

export type QueryFilter = {
  field: FilterField;
  op?: "in" | "not_in";
  values: string[];
};
export type Query = {
  ref: string;
  source: Source;
  metric: string;
  dateField?: string;
  filters: QueryFilter[];
  /** Used only by the formula, not drawn on its own. */
  hidden?: boolean;
  label?: string;
};
export type PanelSpec = {
  viz: Viz;
  groupBy: GroupBy;
  interval?: Interval;
  /** Categories shown (the rest folds into "Outros"). */
  limit?: number;
  queries: Query[];
  formula?: { expr: string; label: string } | null;
  unit?: Unit;
  decimals?: number;
  /** Stat: compare with the previous period of the same length. */
  compare?: boolean;
};
export type Panel = {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  spec: PanelSpec;
};
export type RangePreset =
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "month"
  | "last_month"
  | "quarter"
  | "year"
  | "12m";
export type DashboardRange =
  { preset: RangePreset } | { from: string; to: string };
export type DashboardFilters = {
  clients?: string[];
  products?: string[];
  teams?: string[];
  people?: string[];
};
export type DashboardVariables = {
  range?: DashboardRange;
  filters?: DashboardFilters;
};
export type LinkAccess = "none" | "password" | "public";
export type Dashboard = {
  id: string;
  company_id: string;
  name: string;
  description: string;
  panels: Panel[];
  variables: DashboardVariables;
  link_access: LinkAccess;
  share_token: string;
  has_password: boolean;
  version: number;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};
export type SeriesRow = {
  k: string | null;
  l?: string | null;
  v: number | null;
};
export type PanelResult = {
  series: Record<string, SeriesRow[]>;
  previous: Record<string, SeriesRow[]>;
  interval: Exclude<Interval, "auto">;
  computed_at: string;
};

// ------------------------------------------------------------ catalog
type MetricDef = { key: string; label: string; unit: Unit; additive: boolean };
export const sources: Record<
  Source,
  {
    label: string;
    metrics: MetricDef[];
    dateFields: { key: string; label: string }[];
    filters: FilterField[];
  }
> = {
  tasks: {
    label: "Tarefas",
    metrics: [
      {
        key: "count",
        label: "Quantidade de tarefas",
        unit: "number",
        additive: true,
      },
      {
        key: "late",
        label: "Tarefas atrasadas",
        unit: "number",
        additive: true,
      },
      {
        key: "estimated_hours",
        label: "Horas estimadas",
        unit: "hours",
        additive: true,
      },
      {
        key: "lead_time_days",
        label: "Prazo médio de entrega (dias)",
        unit: "days",
        additive: false,
      },
    ],
    dateFields: [
      { key: "created_at", label: "Criação" },
      { key: "due_date", label: "Prazo" },
      { key: "delivered_at", label: "Entrega" },
    ],
    filters: [
      "status",
      "priority",
      "late",
      "client",
      "product",
      "project",
      "team",
      "person",
      "creator",
    ],
  },
  hours: {
    label: "Horas",
    metrics: [
      {
        key: "hours",
        label: "Horas registradas",
        unit: "hours",
        additive: true,
      },
      {
        key: "entries",
        label: "Quantidade de apontamentos",
        unit: "number",
        additive: true,
      },
      {
        key: "people",
        label: "Pessoas que registraram",
        unit: "number",
        additive: false,
      },
      {
        key: "tasks",
        label: "Tarefas com horas",
        unit: "number",
        additive: false,
      },
    ],
    dateFields: [{ key: "started_at", label: "Início do apontamento" }],
    filters: ["client", "product", "project", "team", "person", "entry_source"],
  },
};
export const metricDef = (q: Pick<Query, "source" | "metric">) =>
  sources[q.source]?.metrics.find((m) => m.key === q.metric);

export const filterLabels: Record<FilterField, string> = {
  client: "Cliente",
  product: "Produto",
  project: "Projeto",
  team: "Equipe",
  person: "Pessoa",
  creator: "Criador",
  status: "Status",
  priority: "Prioridade",
  late: "Atraso",
  entry_source: "Origem do apontamento",
};

export const groupOptions: {
  key: GroupBy;
  label: string;
  sources: Source[];
}[] = [
  { key: "none", label: "Total (sem agrupar)", sources: ["tasks", "hours"] },
  {
    key: "time",
    label: "Tempo (dia, semana, mês)",
    sources: ["tasks", "hours"],
  },
  { key: "client", label: "Cliente", sources: ["tasks", "hours"] },
  { key: "product", label: "Produto", sources: ["tasks", "hours"] },
  { key: "project", label: "Projeto", sources: ["tasks", "hours"] },
  { key: "team", label: "Equipe", sources: ["tasks", "hours"] },
  {
    key: "person",
    label: "Pessoa (responsável ou quem registrou)",
    sources: ["tasks", "hours"],
  },
  { key: "creator", label: "Criador da tarefa", sources: ["tasks"] },
  { key: "status", label: "Status", sources: ["tasks"] },
  { key: "priority", label: "Prioridade", sources: ["tasks"] },
];
/** Groupings every query of the panel supports. */
export const groupsFor = (queries: Pick<Query, "source">[]) =>
  groupOptions.filter((g) =>
    queries.every((q) => g.sources.includes(q.source)),
  );

export const vizOptions: { key: Viz; label: string }[] = [
  { key: "stat", label: "Número" },
  { key: "line", label: "Linha" },
  { key: "area", label: "Área" },
  { key: "bar", label: "Colunas" },
  { key: "hbar", label: "Barras horizontais" },
  { key: "donut", label: "Rosca" },
  { key: "table", label: "Tabela" },
];

export const rangeOptions: { key: RangePreset; label: string }[] = [
  { key: "today", label: "Hoje" },
  { key: "7d", label: "Últimos 7 dias" },
  { key: "30d", label: "Últimos 30 dias" },
  { key: "90d", label: "Últimos 90 dias" },
  { key: "month", label: "Este mês" },
  { key: "last_month", label: "Mês passado" },
  { key: "quarter", label: "Este trimestre" },
  { key: "year", label: "Este ano" },
  { key: "12m", label: "Últimos 12 meses" },
];

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

// ------------------------------------------------------------ formulas
type Node =
  | { t: "num"; v: number }
  | { t: "ref"; v: string }
  | { t: "neg"; a: Node }
  | { t: "op"; op: "+" | "-" | "*" | "/"; a: Node; b: Node };

/**
 * Parses "A / B * 100": references A–E, numbers, + - * / and parentheses.
 * Never evaluates code. Returns the tree or an error in words.
 */
export function parseFormula(
  expr: string,
): { ok: true; node: Node; refs: string[] } | { ok: false; error: string } {
  const tokens = expr.match(/\s*([A-E]|\d+(?:[.,]\d+)?|[()+\-*/])\s*/g);
  const joined = (tokens ?? []).join("").replace(/\s+/g, "");
  if (!tokens || joined !== expr.replace(/\s+/g, ""))
    return {
      ok: false,
      error: "Use apenas A a E, números, + - * / e parênteses.",
    };
  const list = tokens.map((t) => t.trim());
  let i = 0;
  const refs = new Set<string>();
  function primary(): Node {
    const t = list[i++];
    if (t === undefined) throw Error("A fórmula terminou antes do esperado.");
    if (t === "(") {
      const n = sum();
      if (list[i++] !== ")") throw Error("Falta fechar um parêntese.");
      return n;
    }
    if (t === "-") return { t: "neg", a: primary() };
    if (/^[A-E]$/.test(t)) {
      refs.add(t);
      return { t: "ref", v: t };
    }
    if (/^\d/.test(t)) return { t: "num", v: Number(t.replace(",", ".")) };
    throw Error(`Não esperava "${t}" aqui.`);
  }
  function product(): Node {
    let n = primary();
    while (list[i] === "*" || list[i] === "/") {
      const op = list[i++] as "*" | "/";
      n = { t: "op", op, a: n, b: primary() };
    }
    return n;
  }
  function sum(): Node {
    let n = product();
    while (list[i] === "+" || list[i] === "-") {
      const op = list[i++] as "+" | "-";
      n = { t: "op", op, a: n, b: product() };
    }
    return n;
  }
  try {
    if (!list.length)
      throw Error("Escreva uma fórmula, por exemplo A / B * 100.");
    const node = sum();
    if (i < list.length) throw Error(`Não esperava "${list[i]}" aqui.`);
    return { ok: true, node, refs: [...refs] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Evaluates a parsed formula; a missing value or division by zero gives null. */
export function evaluate(
  node: Node,
  values: Record<string, number | null>,
): number | null {
  switch (node.t) {
    case "num":
      return node.v;
    case "ref":
      return values[node.v] ?? null;
    case "neg": {
      const a = evaluate(node.a, values);
      return a === null ? null : -a;
    }
    case "op": {
      const a = evaluate(node.a, values);
      const b = evaluate(node.b, values);
      if (a === null || b === null) return null;
      if (node.op === "/") return b === 0 ? null : a / b;
      return node.op === "+" ? a + b : node.op === "-" ? a - b : a * b;
    }
  }
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

export function queryName(q: Query) {
  return q.label?.trim() || metricDef(q)?.label || q.ref;
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
  return unit === "percent" ? `${n}%` : unit === "hours" ? `${n} h` : n;
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
          q("C", "hours", "hours", { label: "Horas" }),
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

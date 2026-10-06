import {
  CHURN_REASONS,
  CsEngine,
  addDays,
  addMonths,
  between,
  countsAsNew,
  dateDiff,
  lastDay,
  monthStart,
  monthsBetween,
  monthsRange,
  type CsData,
  type CsDataClient,
  type CsDataCycle,
} from "./cs-engine.js";
import {
  metricDef,
  type DashboardFilters,
  type GroupBy,
  type PanelResult,
  type PanelSpec,
  type Query,
  type SeriesRow,
} from "./dashboard-catalog.js";
import type { PanelRecords, RecordRow, RecordSelection } from "./dashboards.js";

/**
 * As fontes de Customer Success do construtor dos Dashboards (migração
 * 20270523090000): Financeiro, Carteira, Saúde e Trial, calculadas com o
 * motor do painel CS Make (cs-engine.ts) — as mesmas regras (M1, categoria
 * histórica, squad do mês, aniversário do trial) e, por isso, os mesmos
 * números. Puro: a tela, a demonstração e a MAVI no servidor usam igual.
 *
 * Cada métrica vira uma lista de itens (um ciclo, uma nota de HS, um cliente
 * no mês, uma entrada ou saída) com seus atributos; o agrupamento reparte os
 * itens e a agregação da métrica dá o número de cada grupo. Os dados de CS
 * são mensais: o período conta cada mês em que toca; entradas, reativações e
 * saídas contam pela data exata.
 */

type Item = {
  /** O mês do item (AAAA-MM-01). */
  m: string;
  client: CsDataClient | null;
  squad: string | null;
  category?: string | null;
  adimp?: string | null;
  reason?: string | null;
  band?: string | null;
  phase?: string | null;
  /** Numerador (ou o valor) e denominador da métrica. */
  a: number;
  b?: number;
  /** Só a meta: não pertence a cliente, fase nem adimplência. */
  squadOnly?: boolean;
  /** Para a lista de registros. */
  date?: string | null;
  note?: string;
};
type Agg = "sum" | "avg" | "rate" | "ratio" | "last" | "distinct";
type Ctx = { e: CsEngine; from: string; to: string; months: string[]; last: string; override: boolean };
type Metric = { agg: Agg; items: (c: Ctx) => Item[] };

const CATEGORY: Record<string, string> = { TRIAL: "Trial", BASE: "Base", BASE_RA: "Base (reativado)", ACL: "ACL" };
const ADIMP: Record<string, string> = { ADIMPLENTE: "Adimplente", INADIMPLENTE: "Inadimplente", PERDA: "Perda" };
const BAND: Record<string, string> = { SATISFEITO: "Satisfeito", ALERTA: "Alerta", CRITICO: "Crítico" };
const PHASE_ORDER = ["M1", "M2", "M3", "M4+", "Pós-trial"];
const fase = (n: number) => (n <= 0 ? "M1" : n === 1 ? "M2" : n === 2 ? "M3" : "M4+");
const isBase = (c: CsDataClient) => c.kind === "BASE" || c.kind === "BASE_RA";

// ------------------------------------------------------------ itens de cada métrica
function cycleItems(c: Ctx, value: (y: CsDataCycle) => number, den?: (y: CsDataCycle) => number): Item[] {
  return c.months.flatMap((m) =>
    c.e.cyclesOfMonth(m).map((y) => ({
      m, client: c.e.clientOf(y.client), squad: c.e.cycleSquad(y), category: c.e.category(y), adimp: y.adimplencia,
      a: value(y), b: den?.(y), date: y.billing_date ?? y.month,
      note: `${y.status} · provável ${y.probable.toLocaleString("pt-BR")}`,
    })));
}
const revenueOf = (e: CsEngine) => (y: CsDataCycle) => (y.paid > 0 ? e.vef(y) : 0);
/**
 * O faturamento oficial lançado à mão (cs_official_revenue) vale no lugar do
 * calculado pelos ciclos, por squad e mês — como no painel CS Make — quando
 * o painel não separa por cliente, fase ou adimplência nem filtra clientes.
 */
function revenueItems(c: Ctx): Item[] {
  const items = cycleItems(c, revenueOf(c.e));
  if (!c.override) return items;
  const out: Item[] = [];
  const replaced = new Set<string>();
  for (const m of c.months)
    for (const s of c.e.squads) {
      const v = c.e.officialRevenue(m, s.id);
      if (v === 0) continue;
      replaced.add(`${s.id}|${m}`);
      out.push({ m, client: null, squad: s.id, a: v, squadOnly: true, date: m, note: "Faturamento oficial lançado à mão" });
    }
  return [...items.filter((i) => !replaced.has(`${i.squad}|${i.m}`)), ...out];
}
function goalItems(c: Ctx, value: boolean): Item[] {
  return c.months.flatMap((m) =>
    c.e.squads.map((s) => ({
      m, client: null, squad: s.id, a: value ? c.e.goal(s.id, m) : 0, b: value ? undefined : c.e.goal(s.id, m),
      squadOnly: true, date: m, note: "Meta do squad",
    })).filter((i) => (i.a || i.b) !== 0));
}
/** Uma linha por cliente e mês em que ele cumpre a condição (retrato do mês). */
function monthlyClients(c: Ctx, ok: (cl: CsDataClient, m: string) => boolean, extra?: (cl: CsDataClient, m: string) => Partial<Item>) {
  return c.months.flatMap((m) =>
    c.e.clients.filter((cl) => ok(cl, m)).map((cl) => ({
      m, client: cl, squad: c.e.squadInMonth(cl, m), a: 1, date: lastDay(m), ...extra?.(cl, m),
    })));
}
const inRange = (c: Ctx, d: string | null) => between(d, c.from, c.to);
function churnFase(cl: CsDataClient, date: string) {
  const n = monthsBetween(cl.entry_date, date);
  if (n <= 2) return fase(n);
  return cl.kind === "TRIAL" ? "M4+" : "Pós-trial";
}

const METRICS: Record<string, Metric> = {
  // ------------------------------------------------ Financeiro
  "cs_finance.revenue": { agg: "sum", items: revenueItems },
  "cs_finance.planned": { agg: "sum", items: (c) => cycleItems(c, (y) => y.probable) },
  "cs_finance.best": { agg: "sum", items: (c) => cycleItems(c, (y) => y.best) },
  "cs_finance.received": { agg: "sum", items: (c) => cycleItems(c, (y) => y.paid) },
  "cs_finance.open": {
    agg: "sum",
    items: (c) => cycleItems(c, (y) => (y.status === "PENDENTE" || y.status === "PARCIAL" ? Math.max(0, y.probable - y.paid) : 0)),
  },
  "cs_finance.ticket": {
    agg: "ratio",
    items: (c) => cycleItems(c, revenueOf(c.e), (y) => (c.e.isEffectivePayer(y) ? 1 : 0)),
  },
  "cs_finance.fees": { agg: "sum", items: (c) => cycleItems(c, (y) => y.fee_paid ?? 0) },
  "cs_finance.goal": { agg: "sum", items: (c) => goalItems(c, true) },
  "cs_finance.attainment": {
    agg: "rate",
    items: (c) => [...revenueItems(c).map((i) => ({ ...i, b: 0 })), ...goalItems(c, false)],
  },
  // ------------------------------------------------ Carteira
  "cs_portfolio.active": { agg: "last", items: (c) => monthlyClients(c, (cl, m) => c.e.activeIn(cl, m)) },
  "cs_portfolio.payers": {
    agg: "distinct",
    items: (c) => cycleItems(c, (y) => (y.paid > 0 ? 1 : 0)).filter((i) => i.a > 0),
  },
  "cs_portfolio.new": {
    agg: "sum",
    items: (c) => c.e.clients.filter((cl) => countsAsNew(cl) && inRange(c, cl.entry_date)).map((cl) => ({
      m: monthStart(cl.entry_date), client: cl, squad: c.e.squadInMonth(cl, cl.entry_date), a: 1, date: cl.entry_date,
      note: "Entrada",
    })),
  },
  "cs_portfolio.reactivations": {
    agg: "sum",
    items: (c) => c.e.reactivations.filter((r) => inRange(c, r.date)).map((r) => ({
      m: monthStart(r.date), client: r.client, squad: c.e.squadInMonth(r.client, r.date), a: 1, date: r.date,
      note: "Reativação",
    })),
  },
  "cs_portfolio.churns": {
    agg: "sum",
    items: (c) => churnItems(c, -1).map((i) => ({ ...i, a: 1 })),
  },
  "cs_portfolio.net": {
    agg: "sum",
    items: (c) => [...METRICS["cs_portfolio.new"].items(c), ...METRICS["cs_portfolio.reactivations"].items(c), ...churnItems(c, -1)],
  },
  // ------------------------------------------------ Saúde
  "cs_health.hs_avg": { agg: "avg", items: (c) => hsItems(c, (h) => h.score) },
  "cs_health.hs_clients": { agg: "last", items: (c) => hsItems(c, () => 1) },
  "cs_health.hs_critical": { agg: "last", items: (c) => hsItems(c, () => 1).filter((i) => i.band === "CRITICO") },
  "cs_health.adimp_rate": {
    agg: "rate",
    items: (c) => cycleItems(c, (y) => (y.adimplencia === "ADIMPLENTE" ? 1 : 0), () => 1),
  },
  "cs_health.cycles": { agg: "sum", items: (c) => cycleItems(c, () => 1) },
  // ------------------------------------------------ Trial
  "cs_trial.in_trial": {
    agg: "last",
    items: (c) => monthlyClients(c, (cl, m) => {
      const fim = lastDay(m);
      const ancora = fim < c.e.today ? fim : c.e.today;
      return cl.kind === "TRIAL" && cl.entry_date <= ancora && (cl.churn_date === null || cl.churn_date > fim);
    }, (cl, m) => {
      const fim = lastDay(m);
      return { phase: fase(Math.max(0, monthsBetween(cl.entry_date, fim < c.e.today ? fim : c.e.today))) };
    }),
  },
  "cs_trial.graduated": { agg: "sum", items: (c) => gradItems(c) },
  "cs_trial.grad_rate": {
    agg: "rate",
    items: (c) => [
      ...gradItems(c).map((i) => ({ ...i, b: 0 })),
      // O denominador: quem entrou três meses antes (e passou pelo trial).
      ...c.months.flatMap((m) => {
        const origem = addMonths(m, -3);
        return c.e.clients.filter((cl) => between(cl.entry_date, origem, lastDay(origem)) && c.e.passouTrial(cl))
          .map((cl) => ({ m, client: cl, squad: c.e.squadInMonth(cl, m), a: 0, b: 1, date: cl.entry_date,
            note: "Entrou três meses antes" }));
      }),
    ],
  },
  "cs_trial.trial_churns": {
    agg: "sum",
    items: (c) => c.e.clients.filter((cl) => inRange(c, cl.churn_date) && c.e.passouTrial(cl)).map((cl) => ({
      m: monthStart(cl.churn_date!), client: cl, squad: c.e.squadInMonth(cl, cl.churn_date!), a: 1, date: cl.churn_date,
      phase: churnFase(cl, cl.churn_date!), note: "Churn",
    })),
  },
};
function churnItems(c: Ctx, sign: number): Item[] {
  return c.e.churns.filter((r) => inRange(c, r.date)).map((r) => ({
    m: monthStart(r.date), client: r.client, squad: c.e.squadInMonth(r.client, r.date), a: sign, date: r.date,
    reason: r.reason ? CHURN_REASONS[r.reason].label : null, note: "Churn",
  }));
}
function hsItems(c: Ctx, value: (h: { score: number }) => number): Item[] {
  return c.months.flatMap((m) =>
    c.e.hsOfMonth(m).map((h) => {
      const cl = c.e.clientOf(h.client);
      return { m, client: cl, squad: c.e.squadInMonth(cl, m), band: h.band, a: value(h), date: m, note: `HS ${h.score}%` };
    }));
}
function gradItems(c: Ctx): Item[] {
  return c.e.clients.filter((cl) => {
    const g = c.e.gradMonth(cl);
    return isBase(cl) && g !== null && c.months.includes(g);
  }).map((cl) => {
    const g = c.e.gradMonth(cl)!;
    return { m: g, client: cl, squad: c.e.squadInMonth(cl, g), a: 1, date: g, note: `Graduou (M${cl.trial_month})` };
  });
}

// ------------------------------------------------------------ filtros, grupos, agregação
function passes(i: Item, q: Query, filters: DashboardFilters) {
  if (filters.clients?.length && (!i.client?.client_id || !filters.clients.includes(i.client.client_id))) return false;
  for (const f of q.filters) {
    if (!f.values.length) continue;
    const value =
      f.field === "client" ? i.client?.client_id ?? null
        : f.field === "squad" ? i.squad
          : f.field === "cs_kind" ? (i.client ? (isBase(i.client) ? "BASE" : i.client.kind) : null)
            : undefined;
    if (value === undefined) continue;
    // A meta é do squad: o filtro de tipo de cliente não a tira.
    if (value === null && f.field === "cs_kind" && i.squadOnly) continue;
    const hit = value !== null && f.values.includes(value);
    if ((f.op ?? "in") === "in" ? !hit : hit) return false;
  }
  return true;
}
function keyOf(e: CsEngine, i: Item, group: GroupBy): { k: string | null; l: string | null } {
  switch (group) {
    case "time": return { k: i.m, l: null };
    case "client": return { k: i.client?.id ?? null, l: i.client?.name ?? null };
    case "squad": return { k: i.squad, l: i.squad ? e.squadName(i.squad) : null };
    case "cs_category": return { k: i.category ?? null, l: i.category ? CATEGORY[i.category] ?? i.category : null };
    case "cs_adimplencia": return { k: i.adimp ?? null, l: i.adimp ? ADIMP[i.adimp] ?? i.adimp : null };
    case "cs_reason": return { k: i.reason ?? null, l: i.reason ?? (i.a < 0 || i.note === "Churn" ? "Sem motivo" : null) };
    case "cs_band": return { k: i.band ?? null, l: i.band ? BAND[i.band] ?? i.band : null };
    case "cs_phase": return { k: i.phase ?? null, l: i.phase ?? null };
    default: return { k: "total", l: null };
  }
}
function aggregate(agg: Agg, items: Item[], last: string | null): number | null {
  const sum = (f: (i: Item) => number) => items.reduce((s, i) => s + f(i), 0);
  switch (agg) {
    case "sum": return sum((i) => i.a);
    case "avg": return items.length ? sum((i) => i.a) / items.length : null;
    case "rate": {
      const b = sum((i) => i.b ?? 0);
      return b > 0 ? (sum((i) => i.a) / b) * 100 : null;
    }
    case "ratio": {
      const b = sum((i) => i.b ?? 0);
      return b > 0 ? sum((i) => i.a) / b : null;
    }
    case "distinct": return new Set(items.map((i) => i.client?.id)).size;
    case "last": {
      // O retrato do último mês do período (ou do mês de cada coluna).
      const ref = last ?? items.reduce((mx, i) => (i.m > mx ? i.m : mx), "");
      return items.filter((i) => i.m === ref).length;
    }
  }
}

// ------------------------------------------------------------ o painel
const metricOf = (q: Query) => METRICS[`${q.source}.${q.metric}`];
function context(e: CsEngine, from: string, to: string, q: Query, group: GroupBy, filters: DashboardFilters): Ctx {
  const months = monthsRange(monthStart(from), monthStart(to));
  return {
    e, from, to, months, last: months[months.length - 1],
    override: ["none", "time", "squad"].includes(group) && !filters.clients?.length &&
      !q.filters.some((f) => f.values.length && f.field !== "squad"),
  };
}
function itemsFor(e: CsEngine, q: Query, group: GroupBy, from: string, to: string, filters: DashboardFilters) {
  const m = metricOf(q);
  if (!m) throw new Error(`Métrica de Customer Success desconhecida: ${q.metric}`);
  const ctx = context(e, from, to, q, group, filters);
  // A meta só se reparte por squad e mês.
  const squadGroups: GroupBy[] = ["none", "time", "squad"];
  const items = m.items(ctx).filter((i) => passes(i, q, filters) && (!i.squadOnly || squadGroups.includes(group)));
  return { m, ctx, items };
}

function series(e: CsEngine, q: Query, group: GroupBy, from: string, to: string, filters: DashboardFilters,
  limit: number | null): SeriesRow[] {
  const { m, ctx, items } = itemsFor(e, q, group, from, to, filters);
  if (group === "none") return [{ k: "total", v: aggregate(m.agg, items, ctx.last) }];
  const additive = metricDef(q)?.additive ?? true;
  const groups = new Map<string | null, { l: string | null; items: Item[] }>();
  for (const i of items) {
    const { k, l } = keyOf(e, i, group);
    const g = groups.get(k) ?? { l, items: [] };
    g.items.push(i);
    groups.set(k, g);
  }
  if (group === "time")
    return ctx.months.map((mo) => {
      const g = groups.get(mo);
      return { k: mo, v: g ? aggregate(m.agg, g.items, mo) : additive ? 0 : null };
    });
  const ranked = [...groups].map(([k, g]) => ({ k, l: g.l, v: aggregate(m.agg, g.items, ctx.last) }))
    .filter((r) => r.v !== 0 || !additive)
    .sort((a, b) =>
      group === "cs_phase" ? PHASE_ORDER.indexOf(a.k ?? "") - PHASE_ORDER.indexOf(b.k ?? "")
        : (b.v ?? -Infinity) - (a.v ?? -Infinity));
  const lim = Math.min(Math.max(limit ?? 1000, 1), 1000);
  const top: SeriesRow[] = ranked.slice(0, lim);
  const rest = ranked.slice(lim);
  if (rest.length) {
    const restItems = rest.flatMap((r) => groups.get(r.k)?.items ?? []);
    top.push({ k: "__other__", l: "Outros", v: aggregate(m.agg, restItems, ctx.last) });
  }
  return top;
}

/** Um painel de CS como dashboard_panel_data o devolveria (com o anterior e a comparação). */
export function runCsPanel(
  data: CsData,
  spec: PanelSpec,
  range: { from: string; to: string },
  filters: DashboardFilters,
  compare: { from: string; to: string } | null = null,
  engine: CsEngine = engineFor(data),
): PanelResult {
  const limit = spec.formula?.expr ? null : Math.min(Math.max(spec.limit ?? 10, 1), 50);
  const run = (from: string, to: string, top: number | null) =>
    Object.fromEntries(spec.queries.map((q) => [q.ref, series(engine, q, spec.groupBy, from, to, filters, top)]));
  const days = dateDiff(range.to, range.from) + 1;
  return {
    series: run(range.from, range.to, limit),
    previous: spec.groupBy === "none" && spec.compare ? run(addDays(range.from, -days), addDays(range.from, -1), limit) : {},
    ...(compare ? { compare: run(compare.from, compare.to, null), compare_range: compare } : {}),
    // Os dados de CS são mensais.
    interval: "month",
    computed_at: new Date().toISOString(),
  };
}

/** Os registros por trás de uma consulta de CS: cada ciclo, nota, cliente no mês, entrada ou saída. */
export function runCsRecords(
  data: CsData,
  spec: PanelSpec,
  ref: string,
  range: { from: string; to: string },
  filters: DashboardFilters,
  selection: RecordSelection,
  engine: CsEngine = engineFor(data),
): PanelRecords {
  const q = spec.queries.find((x) => x.ref === ref) ?? spec.queries[0];
  const { m, ctx, items } = itemsFor(engine, q, spec.groupBy, range.from, range.to, filters);
  const chosen = items.filter((i) => {
    // Como nas outras fontes: o que soma 0 não entra na lista de uma soma.
    if (m.agg === "sum" && i.a === 0) return false;
    if (m.agg === "last" && spec.groupBy !== "time" && i.m !== ctx.last) return false;
    const k = keyOf(engine, i, spec.groupBy).k ?? "__null__";
    if (selection.keys) return selection.keys.includes(k);
    if (selection.exclude) return !selection.exclude.includes(k);
    return true;
  });
  const value = (i: Item): number | null =>
    m.agg === "rate" ? (i.b ? (i.a / i.b) * 100 : null)
      : m.agg === "ratio" ? i.a
        : m.agg === "last" || m.agg === "distinct" ? 1 : i.a;
  const rows: RecordRow[] = chosen
    .sort((a, b) => String(b.date ?? b.m).localeCompare(String(a.date ?? a.m)))
    .slice(0, 1000)
    .map((i, n) => {
      const { k, l } = keyOf(engine, i, spec.groupBy);
      return {
        id: `${i.client?.id ?? i.squad ?? "x"}-${i.m}-${n}`, k, l, v: value(i), d: i.date ?? i.m, n: 1,
        title: i.client ? `${i.client.name} #${i.client.external_id}` : i.squad ? `Squad ${engine.squadName(i.squad)}` : "—",
        squad: i.squad ? engine.squadName(i.squad) : null, cs_month: i.m, note: i.note ?? "",
      };
    });
  return {
    kind: "cs", value: aggregate(m.agg, chosen, spec.groupBy === "time" ? null : ctx.last), total: chosen.length, rows,
    can_open: false, computed_at: new Date().toISOString(),
  };
}

// O motor é montado uma vez por base de dados.
const engines = new WeakMap<CsData, CsEngine>();
export function engineFor(data: CsData) {
  let e = engines.get(data);
  if (!e) engines.set(data, (e = new CsEngine(data)));
  return e;
}

import { supabase } from "./supabase";
import { fetchAllRows } from "./api";
import {
  addDays,
  cycleDays,
  daysBetween,
  type AdCycle,
  type AdObjective,
  type AdPlatform,
} from "./campaigns";

/**
 * Campanhas: the numbers of each cycle (migration 20261002090000_ad_metrics)
 * and the header of the campaign's day to day, with the MASO's formulas in
 * their canonical form (spec 6.14; checked against the MASO's print, 6.13).
 * Money is net of M (what the platform spends); the "com M" view multiplies
 * it by M — the day's M for what was spent, the cycle's for the rest.
 */
export type DailyMetric = {
  cycle_id: string;
  day: string;
  multiplier: number;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  view_content: number;
  add_to_cart: number;
  initiate_checkout: number;
  source: "meta" | "google" | "maso" | "manual";
};
export type CycleSnapshot = Omit<
  DailyMetric,
  "day" | "multiplier" | "source"
> & {
  id: number;
  taken_on: string;
  period_start: string;
  period_end: string;
  goal_status: "good" | "bad" | null;
  source: DailyMetric["source"];
  author_label: string;
};
export type SyncRun = {
  cycle_id: string;
  trigger: "schedule" | "manual";
  status: "ok" | "error";
  message: string;
  days: number;
  created_at: string;
};
export type CampaignMetrics = {
  daily: DailyMetric[];
  snapshots: CycleSnapshot[];
  runs: SyncRun[];
};
export type SyncResult = {
  synced: number;
  errors: { cycle: string; message: string }[];
};
/** The metrics of a record, as typed in an edit (net of M). */
export type MetricValues = Pick<
  DailyMetric,
  | "spend"
  | "impressions"
  | "reach"
  | "clicks"
  | "conversions"
  | "view_content"
  | "add_to_cart"
  | "initiate_checkout"
>;
/** A day of the "Dia a dia": its metrics and the day's M. */
export type DailyEdit = MetricValues & { multiplier: number };
/**
 * A snapshot of the "MASO" sub-tab: the end of its period, the metrics and
 * Bom/Ruim ("auto": by the cycle's goal, as the daily sync rates it).
 */
export type SnapshotEdit = MetricValues & {
  period_end: string;
  goal_status: "good" | "bad" | "auto";
};
export interface MetricsBackend {
  load(company: string, campaign: string): Promise<CampaignMetrics>;
  /** Syncs the campaign's cycles now (an administrator's button). */
  sync(company: string, campaign: string): Promise<SyncResult>;
  /**
   * Edits (update_ad_daily_metric / update_ad_cycle_snapshot, migration
   * 20261006090000_ad_record_edits): the record becomes "manual", which the
   * sync keeps, and the change goes to the campaign's history.
   */
  updateDaily(row: DailyMetric, values: DailyEdit): Promise<void>;
  updateSnapshot(snapshot: CycleSnapshot, values: SnapshotEdit): Promise<void>;
}

// ------------------------------------------------------------ totals
export type Totals = Pick<
  DailyMetric,
  | "spend"
  | "impressions"
  | "reach"
  | "clicks"
  | "conversions"
  | "view_content"
  | "add_to_cart"
  | "initiate_checkout"
>;
export const emptyTotals = (): Totals => ({
  spend: 0,
  impressions: 0,
  reach: 0,
  clicks: 0,
  conversions: 0,
  view_content: 0,
  add_to_cart: 0,
  initiate_checkout: 0,
});
/** Sums days; reach adds up day by day (only snapshots deduplicate it). */
export function sumDays(rows: Totals[]): Totals {
  const t = emptyTotals();
  for (const r of rows)
    for (const k of Object.keys(t) as (keyof Totals)[]) t[k] += r[k];
  return t;
}
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
/** CTR = clicks ÷ impressions (one rule for every platform, spec 6.8). */
export const ctr = (t: Totals) => {
  const r = ratio(t.clicks, t.impressions);
  return r === null ? null : r * 100;
};
export const cpc = (t: Totals) => ratio(t.spend, t.clicks);
export const cpm = (t: Totals) => {
  const r = ratio(t.spend, t.impressions);
  return r === null ? null : r * 1000;
};
export const cpa = (t: Totals) => ratio(t.spend, t.conversions);
export const frequency = (t: Totals) => ratio(t.impressions, t.reach);
/** Conversion rate: results ÷ clicks (traffic: clicks ÷ reach), MASO. */
export function conversionRate(objective: AdObjective, t: Totals) {
  const r =
    objective === "traffic"
      ? ratio(t.clicks, t.reach)
      : ratio(t.conversions, t.clicks);
  return r === null ? null : r * 100;
}
/** Money of days in the "com M" view: each day by its own M. */
export const grossSpend = (rows: DailyMetric[]) =>
  rows.reduce((s, r) => s + r.spend * r.multiplier, 0);

/** "CPL do ciclo", "Custo por conversa"… — the cost's name by objective. */
export const costLabel: Record<AdObjective, string> = {
  lead: "CPL",
  sale: "CPA",
  message: "Custo por conversa",
  traffic: "CPC",
  engagement: "Custo por engajamento",
  custom: "CPA",
  video: "Custo por visualização",
};

// ------------------------------------------------------------ header
export type CycleKpis = {
  days: number;
  /** Days with data (up to yesterday), and "D-N". */
  elapsed: number;
  remaining: number;
  budget: number;
  spent: number;
  left: number;
  goal: number;
  goalCost: number | null;
  conversions: number;
  cost: number | null;
  /** Conversions a day to reach the goal (0: goal reached). */
  idealConversions: number;
  idealBudget: number;
  /** % the cost improved (+) or got worse (−) since the first snapshot. */
  improvement: number | null;
  /** Spent more than the pace up to yesterday (MASO's red alert). */
  overPace: { spent: number; expected: number } | null;
  status: "good" | "bad" | null;
  score: number | null;
  totals: Totals;
};
/**
 * The header of a cycle. withM: money as the client contracted it (× M);
 * otherwise net (what the platform spends). The latest snapshot gives the
 * cycle-to-date results (as in the MASO); without one, the days add up.
 */
export function cycleKpis(
  cycle: AdCycle,
  platform: AdPlatform,
  metrics: CampaignMetrics,
  today: string,
  withM: boolean,
): CycleKpis {
  const m = cycle.multiplier;
  const days = cycleDays(cycle);
  const elapsed = Math.min(
    Math.max(daysBetween(cycle.start_date, today), 0),
    days,
  );
  const remaining = Math.max(daysBetween(today, cycle.end_date) + 1, 0);
  const rows = metrics.daily.filter((d) => d.cycle_id === cycle.id);
  const snaps = metrics.snapshots
    .filter((s) => s.cycle_id === cycle.id)
    .sort((a, b) => a.taken_on.localeCompare(b.taken_on));
  const last = snaps[snaps.length - 1];
  const totals = last ?? sumDays(rows);
  const netBudget = cycle.budget / m;
  const spentNet = rows.length ? sumDays(rows).spend : totals.spend;
  const spentGross = rows.length ? grossSpend(rows) : totals.spend * m;
  const leftNet = netBudget - spentGross / m;
  const money = (net: number) => (withM ? net * m : net);
  const netCost = cpa(totals);
  const goal = cycle.goal_results;
  const goalCostNet = goal > 0 ? netBudget / goal : null;
  const firstCost = snaps.map((s) => cpa(s)).find((c) => c !== null && c > 0);
  const lastCost = last ? cpa(last) : null;
  const expected = (netBudget * elapsed) / days;
  return {
    days,
    elapsed,
    remaining,
    budget: withM ? cycle.budget : netBudget,
    spent: withM ? spentGross : spentNet,
    left: money(leftNet),
    goal,
    goalCost: goalCostNet === null ? null : money(goalCostNet),
    conversions: totals.conversions,
    cost: netCost === null ? null : money(netCost),
    idealConversions:
      goal > totals.conversions
        ? Math.ceil((goal - totals.conversions) / Math.max(remaining, 1))
        : 0,
    idealBudget: money(Math.max(leftNet, 0) / Math.max(remaining, 1)),
    improvement:
      firstCost && lastCost ? 100 - (lastCost / firstCost) * 100 : null,
    overPace:
      elapsed > 0 && spentNet > expected + 0.005
        ? { spent: money(spentNet), expected: money(expected) }
        : null,
    status:
      goalCostNet === null || (!last && !rows.length)
        ? null
        : totals.conversions > 0 && netCost !== null && netCost <= goalCostNet
          ? "good"
          : "bad",
    score:
      last || rows.length
        ? campaignScore(platform, cycle.objective, totals)
        : null,
    totals,
  };
}

// ------------------------------------------------------------ score
/** Bands (upper limits, best first) and the grade of each, spec 6.10. */
type Bands = { limits: number[]; higherIsBetter?: boolean };
const GRADES = [1, 0.75, 0.5, 0.25, 0];
const BANDS: Record<"meta" | "google", Record<string, Bands>> = {
  meta: {
    cpa_message: { limits: [5, 10, 15, 20] },
    cpa_lead: { limits: [8, 12, 18, 22] },
    cpa_sale: { limits: [50, 70, 90, 120] },
    cpc: { limits: [2, 5, 10, 15] },
    cpa_engagement: { limits: [0.1, 0.3, 0.5, 1] },
    cpm: { limits: [30, 60, 90, 120] },
    ctr: { limits: [2.5, 2, 1, 0.5], higherIsBetter: true },
  },
  google: {
    cpa_message: { limits: [5, 10, 15, 20] },
    cpa_lead: { limits: [15, 20, 25, 30] },
    cpa_sale: { limits: [65, 85, 100, 130] },
    cpc: { limits: [5, 10, 15, 20] },
    cpa_engagement: { limits: [0.1, 0.3, 0.5, 1] },
    cpm: { limits: [30, 60, 90, 120] },
    ctr: { limits: [15, 10, 7, 5], higherIsBetter: true },
  },
};
/** Weights (%) by objective; video has none (score 0). */
const WEIGHTS: Partial<Record<AdObjective, Record<string, number>>> = {
  traffic: { ctr: 30, cpc: 60, cpm: 10 },
  engagement: { cpm: 20, cpa_engagement: 80 },
  message: { ctr: 20, cpc: 15, cpm: 15, cpa_message: 50 },
  lead: { ctr: 20, cpc: 15, cpm: 15, cpa_lead: 50 },
  custom: { ctr: 20, cpc: 15, cpm: 15, cpa_lead: 50 },
  sale: { ctr: 20, cpc: 15, cpm: 15, cpa_sale: 50 },
};
export function grade(value: number | null, bands: Bands) {
  if (value === null || value === 0) return 0;
  const i = bands.higherIsBetter
    ? bands.limits.findIndex((l) => value > l)
    : bands.limits.findIndex((l) => value <= l);
  return GRADES[i === -1 ? GRADES.length - 1 : i];
}
/**
 * The MASO's campaign score (0–100): each indicator's grade by band times
 * its weight, on net values. LinkedIn, Kwai and TikTok use Google's bands.
 */
export function campaignScore(
  platform: AdPlatform,
  objective: AdObjective,
  t: Totals,
) {
  const weights = WEIGHTS[objective];
  if (!weights) return 0;
  const table = BANDS[platform === "meta" ? "meta" : "google"];
  const values: Record<string, number | null> = {
    ctr: ctr(t),
    cpc: cpc(t),
    cpm: cpm(t),
    cpa_message: cpa(t),
    cpa_lead: cpa(t),
    cpa_sale: cpa(t),
    cpa_engagement: cpa(t),
  };
  const score = Object.entries(weights).reduce(
    (s, [k, w]) => s + grade(values[k], table[k]) * w,
    0,
  );
  return Math.round(score * 100) / 100;
}

// ------------------------------------------------------------ day to day
/** Dates from..to, inclusive. */
export function dateRange(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 1100; d = addDays(d, 1))
    out.push(d);
  return out;
}
/**
 * Each day as the snapshots tell it (MASO's "LIVE"): the difference between
 * the snapshot taken the next day and the one taken that day, when both
 * exist. A stored day that differs from it is flagged.
 */
export function liveDeltas(snapshots: CycleSnapshot[]) {
  const byCycle = new Map<string, CycleSnapshot[]>();
  for (const s of snapshots)
    byCycle.set(s.cycle_id, [...(byCycle.get(s.cycle_id) ?? []), s]);
  const out = new Map<string, Totals>();
  for (const [cycle, list] of byCycle) {
    const sorted = [...list].sort((a, b) =>
      a.taken_on.localeCompare(b.taken_on),
    );
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const day = addDays(s.taken_on, -1);
      // The first snapshot of a cycle covers only its first day.
      const prev =
        i > 0 && sorted[i - 1].taken_on === day
          ? sorted[i - 1]
          : s.period_start === day
            ? null
            : undefined;
      if (prev === undefined) continue;
      const delta = emptyTotals();
      for (const k of Object.keys(delta) as (keyof Totals)[])
        delta[k] = s[k] - (prev ? prev[k] : 0);
      out.set(`${cycle}:${day}`, delta);
    }
  }
  return out;
}
/** A day's value against the snapshots' ("LIVE"), within a cent. */
export const diverges = (stored: number, live: number) =>
  Math.abs(stored - live) > 0.009;

// ------------------------------------------------------------ backend
const METRIC_COLUMNS =
  "spend,impressions,reach,clicks,conversions,view_content,add_to_cart,initiate_checkout";
const toNumbers = <T extends Record<string, unknown>>(row: T) => {
  const out: Record<string, unknown> = { ...row };
  for (const k of [
    "multiplier",
    "spend",
    "impressions",
    "reach",
    "clicks",
    "conversions",
    "view_content",
    "add_to_cart",
    "initiate_checkout",
  ])
    if (k in out) out[k] = Number(out[k]);
  return out as T;
};
export async function loadMetrics(
  company: string,
  campaign: string,
): Promise<CampaignMetrics> {
  if (!supabase) throw Error("Supabase não configurado");
  const [daily, snapshots, runs] = await Promise.all([
    fetchAllRows<DailyMetric>((count) =>
      supabase!
        .from("ad_daily_metrics")
        .select(
          `id,cycle_id,day,multiplier,${METRIC_COLUMNS},source`,
          count ? { count } : undefined,
        )
        .eq("company_id", company)
        .eq("campaign_id", campaign)
        .order("id"),
    ),
    fetchAllRows<CycleSnapshot>((count) =>
      supabase!
        .from("ad_cycle_snapshots")
        .select(
          `id,cycle_id,taken_on,period_start,period_end,${METRIC_COLUMNS},goal_status,source,author_label`,
          count ? { count } : undefined,
        )
        .eq("company_id", company)
        .eq("campaign_id", campaign)
        .order("id"),
    ),
    supabase
      .from("ad_sync_runs")
      .select("cycle_id,trigger,status,message,days,created_at")
      .eq("company_id", company)
      .eq("campaign_id", campaign)
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []) as SyncRun[];
      }),
  ]);
  return {
    daily: daily.map(toNumbers).sort((a, b) => a.day.localeCompare(b.day)),
    snapshots: snapshots.map(toNumbers),
    runs,
  };
}
export async function syncNow(campaign: string): Promise<SyncResult> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token) throw Error("Entre novamente para sincronizar.");
  const res = await fetch("/api/ads-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ campaign }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "Não foi possível sincronizar.");
  return data as SyncResult;
}

/**
 * "Meta desta campanha (com base histórica)" (MASO, spec 6.11): with at
 * least 15 snapshots rated Bom/Ruim in the campaign's history, the usual
 * cost per result is the mean of the Bom ones' average cost and the Ruim
 * ones' (the MASO summed the Bom into the Ruim average, a bug). It shows
 * when that cost is above the cycle's goal cost — the goal asks for more
 * than the campaign usually delivers — with the quantity it would bring.
 * Net of M, like the costs it compares.
 */
export function historicalGoal(
  snapshots: CycleSnapshot[],
  cycle: Pick<AdCycle, "budget" | "multiplier" | "goal_results">,
) {
  const rated = snapshots.filter(
    (s) => s.goal_status && s.conversions > 0 && s.spend > 0,
  );
  if (rated.length < 15 || cycle.goal_results <= 0) return null;
  const mean = (list: CycleSnapshot[]) =>
    list.length
      ? list.reduce((sum, s) => sum + s.spend / s.conversions, 0) / list.length
      : null;
  const good = mean(rated.filter((s) => s.goal_status === "good"));
  const bad = mean(rated.filter((s) => s.goal_status === "bad"));
  const usual =
    good !== null && bad !== null ? (good + bad) / 2 : (good ?? bad)!;
  const net = cycle.budget / cycle.multiplier;
  if (!(usual > net / cycle.goal_results)) return null;
  return {
    analyses: rated.length,
    cost: usual,
    quantity: Math.round(net / usual),
  };
}

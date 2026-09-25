import { describe, expect, it } from "vitest";
import {
  campaignScore,
  conversionRate,
  ctr,
  cycleKpis,
  diverges,
  emptyTotals,
  grade,
  historicalGoal,
  liveDeltas,
  sumDays,
  type CampaignMetrics,
  type CycleSnapshot,
  type DailyMetric,
} from "./campaign-metrics";
import type { AdCycle } from "./campaigns";

const cycle: AdCycle = {
  id: "cy",
  company_id: "co",
  campaign_id: "ca",
  competence_month: "2026-09-01",
  start_date: "2026-08-31",
  end_date: "2026-09-30",
  objective: "message",
  goal_results: 100,
  budget: 3000,
  multiplier: 2.5,
  destination: "external_page",
  landing_pages: [],
  niche: "",
  created_by: "u",
  created_at: "",
  updated_at: "",
  version: 1,
  links: [],
};
const day = (d: string, spend: number, extra: Partial<DailyMetric> = {}) =>
  ({
    ...emptyTotals(),
    cycle_id: "cy",
    day: d,
    multiplier: 2.5,
    spend,
    source: "meta",
    ...extra,
  }) as DailyMetric;
const snapshot = (
  taken: string,
  totals: Partial<CycleSnapshot>,
): CycleSnapshot => ({
  ...emptyTotals(),
  id: 1,
  cycle_id: "cy",
  taken_on: taken,
  period_start: "2026-08-31",
  period_end: taken,
  goal_status: null,
  source: "meta",
  author_label: "",
  ...totals,
});

describe("cabeçalho do ciclo (print do MASO, cliente 5022)", () => {
  // 24 days spending R$ 963,73 in total, 242 conversations, M 2,5.
  const daily = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 31 + i)).toISOString().slice(0, 10);
    return day(d, i === 23 ? 963.73 - 23 * 40 : 40);
  });
  const metrics: CampaignMetrics = {
    daily,
    snapshots: [
      snapshot("2026-09-10", { spend: 400, conversions: 60 }),
      snapshot("2026-09-24", {
        spend: 963.73,
        conversions: 242,
        impressions: 60000,
        clicks: 900,
        reach: 30000,
      }),
    ],
    runs: [],
  };
  it("sem M: verba real, restante, meta, atual e ritmo", () => {
    const k = cycleKpis(cycle, "meta", metrics, "2026-09-24", false);
    expect(k.budget).toBe(1200);
    expect(k.left).toBeCloseTo(236.27, 2);
    expect(k.goalCost).toBe(12);
    expect(k.conversions).toBe(242);
    expect(k.cost).toBeCloseTo(3.98, 2);
    expect(k.idealConversions).toBe(0);
    expect(k.elapsed).toBe(24);
    // Today counts as a day to spend (the MASO divided by 6, not 7).
    expect(k.remaining).toBe(7);
    expect(k.idealBudget).toBeCloseTo(33.75, 2);
    // Pace over 31 days: 1200 × 24 ÷ 31 = 929,03 < 963,73.
    expect(k.overPace?.expected).toBeCloseTo(929.03, 2);
    expect(k.status).toBe("good");
    // CPA 400/60 = 6,67 → 3,98: 40% better.
    expect(k.improvement).toBeCloseTo(40.28, 1);
  });
  it("com M: tudo em valores do cliente", () => {
    const k = cycleKpis(cycle, "meta", metrics, "2026-09-24", true);
    expect(k.budget).toBe(3000);
    expect(k.spent).toBeCloseTo(2409.33, 1);
    expect(k.left).toBeCloseTo(590.68, 1);
    expect(k.goalCost).toBe(30);
    expect(k.cost).toBeCloseTo(9.96, 2);
  });
  it("sem dados: sem status nem score", () => {
    const k = cycleKpis(
      cycle,
      "meta",
      { daily: [], snapshots: [], runs: [] },
      "2026-09-24",
      false,
    );
    expect([k.status, k.score, k.cost, k.overPace]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(k.left).toBe(1200);
    expect(k.idealConversions).toBe(15);
  });
});

describe("métricas e score", () => {
  it("CTR por impressões; taxa de conversão do tráfego por alcance", () => {
    const t = { ...emptyTotals(), impressions: 1000, clicks: 20, reach: 500 };
    expect(ctr(t)).toBe(2);
    expect(conversionRate("traffic", t)).toBe(4);
    expect(conversionRate("lead", { ...t, conversions: 5 })).toBe(25);
  });
  it("faixas do MASO: nota do limite inferior", () => {
    const cpaLead = { limits: [8, 12, 18, 22] };
    expect(grade(8, cpaLead)).toBe(1);
    expect(grade(8.01, cpaLead)).toBe(0.75);
    expect(grade(30, cpaLead)).toBe(0);
    expect(grade(null, cpaLead)).toBe(0);
    expect(grade(2.6, { limits: [2.5, 2, 1, 0.5], higherIsBetter: true })).toBe(
      1,
    );
  });
  it("score de mensagem do print ≈ 90", () => {
    // CPA 3,98 (50), CPM 16 (15), CPC 1,07 (15), CTR 1,5% (0,5 × 20).
    const t = {
      ...emptyTotals(),
      spend: 963.73,
      conversions: 242,
      impressions: 60000,
      clicks: 900,
    };
    expect(campaignScore("meta", "message", t)).toBe(90);
    expect(campaignScore("meta", "video", t)).toBe(0);
  });
});

describe("dia a dia e LIVE", () => {
  it("o dia pelos acumulados e a divergência com o gravado", () => {
    const snaps = [
      snapshot("2026-09-01", { spend: 40, conversions: 10 }),
      snapshot("2026-09-02", { spend: 90, conversions: 21 }),
      snapshot("2026-09-04", { spend: 150, conversions: 30 }),
    ];
    const live = liveDeltas(snaps);
    // 31/08 (first day: the first snapshot itself) and 01/09.
    expect(live.get("cy:2026-08-31")?.spend).toBe(40);
    expect(live.get("cy:2026-09-01")?.conversions).toBe(11);
    // No snapshot on 03/09: no LIVE for 02/09 nor 03/09.
    expect(live.has("cy:2026-09-02")).toBe(false);
    expect(live.has("cy:2026-09-03")).toBe(false);
    expect(diverges(50, 50.004)).toBe(false);
    expect(diverges(50, 49)).toBe(true);
  });
  it("soma os dias", () => {
    expect(sumDays([day("a", 10), day("b", 5.5)]).spend).toBe(15.5);
  });
});

describe("meta com base histórica", () => {
  const rated = (n: number, status: "good" | "bad", cost: number) =>
    Array.from({ length: n }, (_, i) =>
      snapshot(`2026-08-${String(i + 1).padStart(2, "0")}`, {
        spend: cost * 10,
        conversions: 10,
        goal_status: status,
      }),
    );
  it("precisa de 15 análises e de uma meta acima do histórico", () => {
    // Goal cost: 1200 ÷ 100 = 12. History: Bom at 10, Ruim at 30 → 20.
    const history = [...rated(10, "good", 10), ...rated(6, "bad", 30)];
    expect(historicalGoal(history, cycle)).toEqual({
      analyses: 16,
      cost: 20,
      quantity: 60,
    });
    expect(historicalGoal(history.slice(0, 14), cycle)).toBeNull();
    // A campaign that usually costs less than the goal: nothing to say.
    expect(historicalGoal(rated(20, "good", 8), cycle)).toBeNull();
  });
});

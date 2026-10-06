import { describe, expect, it } from "vitest";
import { addMonths, lastDay, monthStart } from "./cs-engine";
import { kpiStripData, trialDataMensal } from "./cs-blocks";
import { demoCsData } from "./cs-dashboard";
import { engineFor, runCsPanel, runCsRecords } from "./cs-sources";
import type { PanelSpec, Query } from "./dashboard-catalog";

// As fontes de CS do construtor dão os mesmos números do painel CS Make
// (mesmo motor), na carteira inventada da demonstração.
const data = demoCsData();
const e = engineFor(data);
const mes = addMonths(monthStart(data.today), -1);
const range = { from: mes, to: lastDay(mes) };
const k = kpiStripData(e, { mes_ref: mes, squad_id: null, dim: "tudo" });
const tr = trialDataMensal(e, { mes_ref: mes, squad_id: null, dim: "tudo" });

const q = (source: Query["source"], metric: string, extra: Partial<Query> = {}): Query => ({
  ref: "A", source, metric, filters: [], ...extra,
});
const total = (query: Query, filters = {}) => {
  const spec: PanelSpec = { viz: "stat", groupBy: "none", queries: [query] };
  return runCsPanel(data, spec, range, filters).series.A[0].v;
};

describe("fontes de Customer Success = painel CS Make", () => {
  it("financeiro do mês", () => {
    expect(total(q("cs_finance", "revenue"))).toBeCloseTo(k.fat_mes, 2);
    expect(total(q("cs_finance", "planned"))).toBeCloseTo(k.planejado, 2);
    expect(total(q("cs_finance", "goal"))).toBeCloseTo(k.meta, 2);
    expect(total(q("cs_finance", "attainment"))).toBeCloseTo(k.atingimento_pct, 6);
  });
  it("carteira do mês", () => {
    expect(total(q("cs_portfolio", "active"))).toBe(k.ativos_total);
    expect(total(q("cs_portfolio", "payers"))).toBe(k.pagantes);
    expect(total(q("cs_portfolio", "new"))).toBe(k.net_novos);
    expect(total(q("cs_portfolio", "churns"))).toBe(k.net_saidas);
    expect(total(q("cs_portfolio", "net"))).toBe(k.net_churn);
  });
  it("trial do mês", () => {
    const f = tr.funil;
    expect(total(q("cs_trial", "in_trial"))).toBe(f.m1 + f.m2 + f.m3 + f.m4plus);
    expect(total(q("cs_trial", "graduated"))).toBe(f.graduados);
    expect(total(q("cs_trial", "grad_rate"))).toBe(f.entradas > 0 ? (f.graduados / f.entradas) * 100 : null);
  });
  it("saúde do mês", () => {
    const hs = e.hsOfMonth(mes);
    expect(total(q("cs_health", "hs_avg"))).toBeCloseTo(hs.reduce((s, h) => s + h.score, 0) / hs.length, 6);
    expect(total(q("cs_health", "hs_critical"))).toBe(hs.filter((h) => h.band === "CRITICO").length);
  });
});

describe("agrupamentos, filtros e registros", () => {
  it("por squad soma o total; por mês dá um valor por mês", () => {
    const bySquad = runCsPanel(data, { viz: "bar", groupBy: "squad", queries: [q("cs_finance", "revenue")] }, range, {});
    expect(bySquad.series.A.reduce((s, r) => s + (r.v ?? 0), 0)).toBeCloseTo(k.fat_mes, 2);
    const ini = addMonths(mes, -2);
    const byMonth = runCsPanel(data, { viz: "line", groupBy: "time", queries: [q("cs_finance", "revenue")] },
      { from: ini, to: lastDay(mes) }, {});
    expect(byMonth.series.A.map((r) => r.k)).toEqual([ini, addMonths(ini, 1), mes]);
    expect(byMonth.interval).toBe("month");
  });
  it("filtro de tipo e de squad", () => {
    const sq = data.squads[0].id;
    const trial = total(q("cs_portfolio", "active", { filters: [{ field: "cs_kind", values: ["TRIAL"] }] }));
    expect(trial).toBe(k.ativos_trial);
    const own = kpiStripData(e, { mes_ref: mes, squad_id: sq, dim: "tudo" });
    expect(total(q("cs_finance", "planned", { filters: [{ field: "squad", values: [sq] }] }))).toBeCloseTo(own.planejado, 2);
  });
  it("os registros conferem com o número do painel", () => {
    const spec: PanelSpec = { viz: "stat", groupBy: "none", queries: [q("cs_finance", "revenue")] };
    const rec = runCsRecords(data, spec, "A", range, {}, {});
    expect(rec.kind).toBe("cs");
    expect(rec.value).toBeCloseTo(k.fat_mes, 2);
    expect(rec.rows.reduce((s, r) => s + (r.v ?? 0), 0)).toBeCloseTo(k.fat_mes, 2);
  });
});

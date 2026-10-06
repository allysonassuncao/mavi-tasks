import { describe, expect, it } from "vitest";
import {
  basisLabel,
  belowText,
  dayLabel,
  formatEvidence,
  insightRowIndex,
  nextScheduled,
  platformRowKeys,
  rowInsights,
  rowLevelOf,
  scheduleText,
  waitText,
  whenText,
  type CampaignInsight,
  type InsightSchedule,
} from "./campaign-insights";

const schedule = (s: Partial<InsightSchedule>): InsightSchedule => ({
  source: "company",
  rule: null,
  enabled: true,
  frequency: "weekdays",
  weekdays: [1, 4],
  every_days: 3,
  hour: 8,
  ...s,
});
const tz = "America/Sao_Paulo";
// 2026-10-05 é segunda-feira; 10h UTC = 7h em São Paulo.
const mondayAt7 = new Date("2026-10-05T10:00:00Z");
const mondayAt9 = new Date("2026-10-05T12:00:00Z");

describe("textos dos insights", () => {
  it("evidências no formato brasileiro, pela unidade", () => {
    expect(formatEvidence({ value: 1234.5, unit: "money", metric: "spend" })).toBe("R$ 1.234,50");
    expect(formatEvidence({ value: 12.34, unit: "pct", metric: "ctr" })).toBe("12,3%");
    expect(formatEvidence({ value: 3.456, unit: "ratio", metric: "crm_roas" })).toBe("3,46x");
    expect(formatEvidence({ value: 1.8, unit: "ratio", metric: "frequency" })).toBe("1,80");
    expect(formatEvidence({ value: 41, unit: "count", metric: "results" })).toBe("41");
    expect(formatEvidence({ value: 1, unit: "days", metric: "days_elapsed" })).toBe("1 dia");
  });

  it("frequência em português", () => {
    expect(scheduleText(schedule({}))).toBe("Toda segunda e quinta, a partir das 8h");
    expect(scheduleText(schedule({ weekdays: [1, 2, 3, 4, 5] }))).toBe("De segunda a sexta, a partir das 8h");
    expect(scheduleText(schedule({ frequency: "daily", hour: 7 }))).toBe("Todo dia, a partir das 7h");
    expect(scheduleText(schedule({ frequency: "every", every_days: 2 }))).toBe("A cada 2 dias, a partir das 8h");
    expect(scheduleText(schedule({ enabled: false }))).toBe("Desligado");
    expect(basisLabel("gross")).toBe("com M");
    expect(basisLabel("net")).toBe("sem M");
  });

  it("a próxima análise segue a regra do banco", () => {
    // Segunda antes das 8h: hoje às 8h.
    expect(nextScheduled(schedule({}), null, mondayAt7, tz)).toEqual({ day: "2026-10-05", hour: 8 });
    // Segunda às 9h, sem análise hoje: já (vai rodar na próxima volta).
    expect(nextScheduled(schedule({}), "2026-10-01", mondayAt9, tz)).toEqual({ day: "2026-10-05", hour: 9 });
    // Já rodou hoje: quinta.
    expect(nextScheduled(schedule({}), "2026-10-05", mondayAt9, tz)).toEqual({ day: "2026-10-08", hour: 8 });
    // A cada 3 dias, a última no sábado (03/10): terça (06/10).
    expect(nextScheduled(schedule({ frequency: "every" }), "2026-10-03", mondayAt9, tz)).toEqual({
      day: "2026-10-06",
      hour: 8,
    });
    expect(nextScheduled(schedule({ enabled: false }), null, mondayAt9, tz)).toBeNull();
    expect(dayLabel("2026-10-08", "2026-10-05")).toBe("quinta, 08/10");
    expect(dayLabel("2026-10-06", "2026-10-05")).toBe("amanhã");
  });

  it("quanto tempo passou e quanto falta", () => {
    const now = new Date("2026-10-05T15:00:00Z");
    expect(whenText("2026-10-05T14:48:00Z", now, tz)).toBe("há 12 min");
    expect(whenText("2026-10-05T12:00:00Z", now, tz)).toBe("há 3 h");
    expect(whenText("2026-10-04T12:05:00Z", now, tz)).toBe("ontem às 09:05");
    expect(waitText("2026-10-05T16:20:00Z", now)).toBe("em 1 h 20 min");
    expect(waitText("2026-10-05T15:04:10Z", now)).toBe("em 5 min");
  });
});

describe("Fase 4: efeito e tarefa", () => {
  it("o efeito em uma linha", async () => {
    const { effectText } = await import("./campaign-insights");
    expect(
      effectText({
        days: 7,
        before: { cpa: 40 },
        after: { cpa: 30.24 },
        change: { cpa: -24.4, results_per_day: 26.7, ctr: null },
        verdict: "better",
      }),
    ).toBe("Melhorou: custo por resultado −24,4% (R$ 40,00 → R$ 30,24), 7 dias antes × 7 depois");
    expect(
      effectText({ days: 5, before: {}, after: {}, change: { cpa: null, results_per_day: -15, ctr: null }, verdict: "worse" }),
    ).toBe("Piorou: resultados por dia −15%, 5 dias antes × 5 depois");
  });
});

describe("Fase 8: negativas para colar no Google Ads", () => {
  it("[exata] ou \"frase\", uma por linha", async () => {
    const { negativesText } = await import("./campaign-insights");
    expect(
      negativesText([
        { term: "vaga de emprego", match: "phrase", spend: 55, clicks: 20, campaign: "Pesquisa", why: "" },
        { term: "clínica grátis", match: "exact", spend: 30, clicks: 10, campaign: "Pesquisa", why: "" },
      ]),
    ).toBe('"vaga de emprego"\n[clínica grátis]');
  });
});

describe("os insights na aba Plataforma", () => {
  const ev = (entity: string) => ({ label: "x", value: 1, unit: "count" as const, window: "cycle" as const, entity, name: entity, metric: "results" });
  const ins = (id: string, x: Partial<CampaignInsight>): CampaignInsight =>
    ({
      id,
      run_id: "r",
      last_seen_run: "r",
      kind: "problem",
      priority: "medium",
      title: id,
      body: "",
      action: "",
      evidence: [],
      target: null,
      source: "mavi",
      money_basis: "net",
      confidence: null,
      status: "new",
      seen_count: 1,
      last_seen_at: "",
      created_at: "",
      ...x,
    }) as CampaignInsight;
  const parents = { "a:1": "s:1", "a:2": "s:1", "s:1": "c:1", "k:9": "s:2", "s:2": "c:1" };
  const view = {
    current: [
      // Compara dois anúncios: alvo no a:1, citado no a:2.
      ins("cmp", { target: { key: "a:1", level: "ad", name: "A1" }, evidence: [ev("a:1"), ev("a:2")], extra: { parents } }),
      ins("kw", { priority: "high", target: { key: "k:9", level: "keyword", name: "kw" }, evidence: [ev("k:9")], extra: { parents } }),
      // Sem alvo: a campanha toda; o público do Meta (g:<conjunto>:<faixa>) cai no conjunto.
      ins("tot", { evidence: [ev("total"), ev("g:123:35-44|female")] }),
      ins("neg", { evidence: [ev("total")], extra: { negatives: [{ term: " Vaga Emprego ", match: "exact", spend: 1, clicks: 1, campaign: "", why: "" }] } }),
      ins("snz", { status: "snoozed", target: { key: "a:1", level: "ad", name: "A1" } }),
    ],
    applied: [ins("app", { status: "applied", target: { key: "a:1", level: "ad", name: "A1" }, evidence: [ev("a:1")] })],
  };
  const index = insightRowIndex(view);
  const ids = (list: { insight: CampaignInsight; role: string }[]) => list.map((r) => `${r.insight.id}:${r.role}`);

  it("as chaves das linhas: a da plataforma, o total nas vinculadas e o termo pelo texto", () => {
    expect(platformRowKeys("campaign", "1", { linked: true })).toEqual(["c:1", "total"]);
    expect(platformRowKeys("campaign", "2", { linked: false })).toEqual(["c:2"]);
    expect(platformRowKeys("search_term", "g~vaga emprego~x", { name: "vaga emprego" })).toEqual([
      "t:g~vaga emprego~x",
      "term:vaga emprego",
    ]);
    expect(platformRowKeys("age", "AGE_RANGE_25_34")).toEqual(["g:age:AGE_RANGE_25_34"]);
    expect(rowLevelOf("g:gender:MALE")).toBe("gender");
    expect(rowLevelOf("b:7")).toBeNull();
  });

  it("alvo e citados; abertos antes dos aplicados; adiado fica de fora", () => {
    expect(ids(rowInsights(index, ["a:1"]).own)).toEqual(["cmp:target", "app:target"]);
    expect(ids(rowInsights(index, ["a:2"]).own)).toEqual(["cmp:cited"]);
    expect(ids(rowInsights(index, ["s:123"]).own)).toEqual(["tot:cited"]);
    expect(ids(rowInsights(index, ["term:vaga emprego"]).own)).toEqual(["neg:target"]);
    expect(ids(rowInsights(index, ["c:1", "total"]).own)).toEqual(["tot:target", "neg:target"]);
  });

  it("a campanha e o conjunto contam os de dentro (sem repetir os dela)", () => {
    const c = rowInsights(index, ["c:1", "total"]);
    expect(ids(c.below).sort()).toEqual(["app:target", "cmp:target", "kw:target"]);
    expect(belowText(c.levels, "google")).toBe("nos anúncios e palavras-chave");
    expect(belowText(rowInsights(index, ["s:1"]).levels, "meta")).toBe("nos anúncios");
    expect(rowInsights(index, ["a:1"]).below).toEqual([]);
    expect([...index.levels.get("ad")!].sort()).toEqual(["app", "cmp"]);
    expect([...index.levels.get("search_term")!]).toEqual(["neg"]);
  });

  it("sem a Plataforma ligada (ou sem dados), nada", () => {
    expect(insightRowIndex(null).own.size).toBe(0);
  });
});

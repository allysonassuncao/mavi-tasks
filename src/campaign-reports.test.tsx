import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  comparePeriods,
  configFrom,
  deltaOf,
  previousRange,
  reachOf,
  daysIn,
  defaultConfig,
  demoReports,
  itemsIn,
  metricLabel,
  metricValue,
  numbersForMavi,
  reportPeriods,
  totalsOf,
  type ReportView,
} from "./campaign-reports";
import { AnalysisText, CampaignReportView } from "./CampaignReportView";
import {
  COLUMNS,
  PRESETS,
  demoPlatform,
  formatValue,
  presetRange,
  textValue,
  type PlatformRow,
} from "./campaign-platform";
import type { AdCycle } from "./campaigns";
import type { MetricsBackend } from "./campaign-metrics";

const day = (d: string, spend: number, conversions: number, clicks = 10, impressions = 1000) => ({
  day: d,
  spend,
  impressions,
  reach: 800,
  clicks,
  conversions,
  view_content: 0,
  add_to_cart: 0,
  initiate_checkout: 0,
});
const view: ReportView = {
  platform: "meta",
  campaign_name: "Norte · Meta",
  client_name: "Norte Coffee",
  product_name: "Make Ads",
  captured_at: "2026-09-10T12:00:00Z",
  currency: "BRL",
  days: [day("2026-09-01", 100, 5), day("2026-09-02", 200, 10), day("2026-09-03", 300, 0)],
  cycles: [
    { start_date: "2026-09-01", end_date: "2026-09-30", objective: "lead", destination: "lead_form", goal_results: 100, budget: 3000 },
  ],
  reach: 1800,
  ad_results: true,
  ads: [
    { id: "a1", name: "Vídeo", adset: "Aberto", days: [{ d: "2026-09-01", s: 60, i: 500, c: 5, r: 1 }, { d: "2026-09-03", s: 100, i: 400, c: 4, r: 0 }] },
    { id: "a2", name: "Imagem", adset: "Aberto", days: [{ d: "2026-09-02", s: 40, i: 300, c: 3, r: 6 }] },
    { id: "a3", name: "Parado", days: [] },
  ],
};

describe("os números do relatório", () => {
  it("somam o período escolhido e o alcance só vale no período todo", () => {
    const all = totalsOf(daysIn(view, "2026-09-01", "2026-09-03"));
    expect(all).toMatchObject({ spend: 600, conversions: 15, clicks: 30, impressions: 3000 });
    expect(metricValue("cpa", all, view.reach)).toBe(40);
    expect(metricValue("ctr", all, view.reach)).toBe(1);
    expect(metricValue("cpm", all, view.reach)).toBe(200);
    expect(metricValue("frequency", all, view.reach)).toBeCloseTo(3000 / 1800);
    const part = totalsOf(daysIn(view, "2026-09-03", "2026-09-03"));
    expect(metricValue("cpa", part, null)).toBeNull();
    expect(metricValue("reach", part, null)).toBeNull();
    expect(metricLabel("results", view)).toBe("Leads");
    expect(metricLabel("cpa", view)).toBe("Custo por lead");
  });

  it("os anúncios do período, o que mais trouxe resultado primeiro", () => {
    const items = itemsIn(view.ads, "2026-09-01", "2026-09-03", true);
    expect(items.map((i) => [i.item.id, i.results, i.spend])).toEqual([
      ["a2", 6, 40],
      ["a1", 1, 160],
    ]);
    // Without results per ad (Make pages), by spend.
    expect(itemsIn(view.ads, "2026-09-01", "2026-09-03", false)[0].item.id).toBe("a1");
    expect(itemsIn(view.ads, "2026-09-02", "2026-09-02", true).map((i) => i.item.id)).toEqual(["a2"]);
  });

  it("o que a MAVI lê: os números como o cliente vê, com a meta e os anúncios", () => {
    const n = numbersForMavi(view, defaultConfig("lead"), "2026-09-01", "2026-09-03");
    expect(n.totais).toMatchObject({ investimento: 600, resultados: 15, custo_por_resultado: 40, alcance: 1800 });
    expect(n.meta).toEqual({ resultados_esperados: 100, verba: 3000, custo_por_resultado_esperado: 30 });
    expect(n.anuncios?.[0]).toMatchObject({ nome: "Imagem", resultados: 6 });
    expect(n.resultado_chamado_de).toBe("Leads");
    expect(JSON.stringify(n)).not.toMatch(/multiplic|"m"/);
    const noGoal = numbersForMavi(view, { ...defaultConfig("lead"), sections: { ads: false, adsets: false, analysis: true, goal: false } }, "2026-09-02", "2026-09-03");
    expect(noGoal.meta).toBeUndefined();
    expect(noGoal.anuncios).toBeUndefined();
    expect(noGoal.totais.alcance).toBeNull();
  });

  it("a configuração lida do banco completa o que falta e ignora o desconhecido", () => {
    const c = configFrom({ metrics: ["spend", "bogus" as never], ads_limit: 99 });
    expect(c.metrics).toEqual(["spend"]);
    expect(c.ads_limit).toBe(30);
    expect(c.sections.ads).toBe(true);
    expect(defaultConfig("sale").metrics).toContain("add_to_cart");
    expect(defaultConfig("lead").charts).not.toContain("funnel");
  });

  it("os períodos oferecidos terminam ontem", () => {
    const current = { id: "y2", start_date: "2026-09-01", end_date: "2026-09-30" } as AdCycle;
    const previous = { id: "y1", start_date: "2026-08-01", end_date: "2026-08-31" } as AdCycle;
    const list = reportPeriods([previous, current], current, "2026-09-15");
    expect(list[0]).toMatchObject({ id: "current", start: "2026-09-01", end: "2026-09-14" });
    expect(list[1]).toMatchObject({ id: "previous", start: "2026-08-01", end: "2026-08-31" });
    expect(list.find((p) => p.id === "7")).toMatchObject({ start: "2026-09-08", end: "2026-09-14" });
    expect(list.find((p) => p.id === "last_month")).toMatchObject({ start: "2026-08-01", end: "2026-08-31" });
  });
});

describe("a página do relatório", () => {
  it("mostra só o que foi escolhido, sem M", () => {
    const html = renderToStaticMarkup(
      <CampaignReportView
        company="Make"
        title="Relatório de setembro"
        view={view}
        config={{
          metrics: ["spend", "results", "cpa", "reach"],
          charts: [],
          sections: { ads: true, adsets: false, analysis: true, goal: true },
          ads_limit: 1,
          allow_filter: true,
        }}
        analysis={"Resumo **forte**.\n- Item um\n- Item dois"}
        periodStart="2026-09-01"
        periodEnd="2026-09-03"
      />,
    ).replace(/\u00a0/g, " ");
    expect(html).toContain("Relatório de setembro");
    expect(html).toContain("Norte Coffee · Make Ads");
    expect(html).toContain("R$ 600,00");
    expect(html).toContain("Custo por lead");
    expect(html).toContain("1.800");
    expect(html).toContain("Leads: 15 de 100");
    expect(html).toContain("Período todo");
    expect(html).toContain("<strong>forte</strong>");
    expect(html).toContain("<li>Item um</li>");
    // One ad (the limit): the one with most results.
    expect(html).toContain("Imagem");
    expect(html).not.toContain(">Vídeo<");
    expect(html).not.toMatch(/\bM\b|multiplic/i);
  });

  it("a análise não aceita HTML", () => {
    const html = renderToStaticMarkup(<AnalysisText text={'<img src=x onerror="alert(1)">'} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("a comparação entre períodos", () => {
  const withCompare: ReportView = {
    ...view,
    days: [day("2026-08-30", 50, 2), day("2026-08-31", 150, 3), ...view.days],
    compare_reach: 900,
  };
  it("variação, custo que cai é bom e o alcance só nos períodos guardados", () => {
    expect(deltaOf(150, 100)).toBe(50);
    expect(deltaOf(5, 0)).toBeNull();
    expect(previousRange("2026-09-01", "2026-09-03")).toEqual({ from: "2026-08-29", to: "2026-08-31" });
    const saved = { start: "2026-09-01", end: "2026-09-03", compareStart: "2026-08-30", compareEnd: "2026-08-31" };
    expect(reachOf(withCompare, { from: "2026-08-30", to: "2026-08-31" }, saved)).toBe(900);
    expect(reachOf(withCompare, { from: "2026-09-01", to: "2026-09-03" }, saved)).toBe(1800);
    expect(reachOf(withCompare, { from: "2026-09-02", to: "2026-09-03" }, saved)).toBeNull();
  });
  it("os períodos oferecidos para comparar", () => {
    const cycles = [{ id: "y1", start_date: "2026-08-01", end_date: "2026-08-31" }] as AdCycle[];
    const list = comparePeriods("2026-09-01", "2026-09-30", cycles);
    expect(list.map((p) => [p.id, p.start, p.end])).toEqual([
      ["previous", "2026-08-02", "2026-08-31"],
      ["cycle", "2026-08-01", "2026-08-31"],
      ["month", "2026-08-01", "2026-08-30"],
    ]);
    // The month before clamps the day (31/03 → 28/02).
    expect(comparePeriods("2026-03-01", "2026-03-31", []).find((p) => p.id === "month")).toMatchObject({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });
  it("a página mostra a variação e o que a MAVI lê traz a comparação", () => {
    const html = renderToStaticMarkup(
      <CampaignReportView
        title="Setembro contra agosto"
        view={withCompare}
        config={{ metrics: ["spend", "results", "cpa", "reach"], charts: ["results"], sections: { ads: false, adsets: false, analysis: false, goal: false }, ads_limit: 5, allow_filter: true }}
        analysis=""
        periodStart="2026-09-01"
        periodEnd="2026-09-03"
        compareStart="2026-08-30"
        compareEnd="2026-08-31"
      />,
    ).replace(/\u00a0/g, " ");
    expect(html).toContain("comparado com 30/08/2026 a 31/08/2026");
    // Spend 600 vs 200 (+200%), results 15 vs 5, cost 40 vs 40.
    expect(html).toContain("+200%");
    expect(html).toContain("vs R$ 200,00");
    // More results is good; spending more has no color.
    expect(html).toMatch(/creport-delta good[^>]*>(?:(?!creport-delta).)*\+200%/);
    expect(html).toMatch(/class="creport-delta "[^>]*>(?:(?!creport-delta).)*\+200%/);
    expect(html).toContain("vs 900");
    expect(html).toContain("Período de comparação");
    const n = numbersForMavi(withCompare, defaultConfig("lead"), "2026-09-01", "2026-09-03", { from: "2026-08-30", to: "2026-08-31" }, 900);
    expect(n.comparacao).toMatchObject({ investimento: 200, resultados: 5, alcance: 900 });
    expect(n.comparacao?.variacao_percentual).toMatchObject({ investimento: 200, resultados: 200, custo_por_resultado: 0 });
  });
});

describe("relatórios na demonstração", () => {
  const metrics: MetricsBackend = {
    load: async () => ({
      daily: [
        { id: 1, cycle_id: "y1", day: "2026-09-01", multiplier: 2, spend: 100, impressions: 1000, reach: 900, clicks: 10, conversions: 4, view_content: 0, add_to_cart: 0, initiate_checkout: 0, source: "meta" },
        { id: 2, cycle_id: "y1", day: "2026-09-02", multiplier: 2, spend: 50, impressions: 500, reach: 400, clicks: 5, conversions: 1, view_content: 0, add_to_cart: 0, initiate_checkout: 0, source: "meta" },
      ],
      snapshots: [],
      runs: [],
    }),
    sync: async () => ({ synced: 0, errors: [] }),
    updateDaily: async () => {},
    updateSnapshot: async () => {},
  } as unknown as MetricsBackend;
  const cycle = { id: "y1", campaign_id: "c", start_date: "2026-09-01", end_date: "2026-09-30", objective: "lead", destination: "lead_form", goal_results: 50, budget: 2000, multiplier: 2, links: [] } as unknown as AdCycle;
  it("com M multiplica o dinheiro; sem M, a verba volta ao valor da plataforma", async () => {
    const backend = demoReports({
      metrics,
      cycles: () => [cycle],
      names: () => ({ campaign: "C", client: "Cliente", product: "Make Ads" }),
      user: "u1",
    });
    const r = await backend.create("co", {
      campaign: "c",
      title: "Teste",
      start: "2026-09-01",
      end: "2026-09-02",
      config: { ...defaultConfig("lead"), with_m: true },
      link: true,
    });
    expect(r.view!.days.map((d) => d.spend)).toEqual([200, 100]);
    expect(r.view!.cycles[0].budget).toBe(2000);
    expect(r.link?.token).toMatch(/^[0-9a-f]{64}$/);
    const without = await backend.update(r.id, "Teste", { ...r.config, with_m: false }, "");
    expect(without.view!.days.map((d) => d.spend)).toEqual([100, 50]);
    expect(without.view!.cycles[0].budget).toBe(1000);
    const off = await backend.setLink(r.id, false, null, null, false);
    expect(off.link).toBeNull();
    expect((await backend.list("co", "c")).length).toBe(1);
    await backend.remove(r.id);
    expect((await backend.list("co", "c")).length).toBe(0);
  });
});

describe("a plataforma", () => {
  it("os períodos do Gerenciador terminam ontem", () => {
    expect(presetRange("last_7d", "2026-09-30")).toEqual({ since: "2026-09-23", until: "2026-09-29" });
    expect(presetRange("this_month", "2026-09-30")).toEqual({ since: "2026-09-01", until: "2026-09-30" });
    expect(presetRange("last_month", "2026-09-30")).toEqual({ since: "2026-08-01", until: "2026-08-31" });
    expect(presetRange("cycle", "2026-09-30", { start_date: "2026-09-10", end_date: "2026-10-09" })).toEqual({
      since: "2026-09-10",
      until: "2026-09-30",
    });
  });
  it("cada predefinição usa colunas que existem", () => {
    const ids = new Set(COLUMNS.map((c) => c.id));
    for (const p of PRESETS) for (const c of p.columns) expect(ids.has(c)).toBe(true);
  });
  it("o orçamento e as métricas nas palavras do Meta", () => {
    const row = {
      level: "adset",
      budget: { shared: "campaign" },
      delivery: { code: "ACTIVE", label: "Ativo", tone: "on" },
      start: "2026-09-01T00:00:00-0300",
      end: null,
    } as unknown as PlatformRow;
    expect(textValue("budget", row, "BRL")).toBe("Usando o orçamento da campanha");
    expect(textValue("bid_strategy", row, "BRL")).toBe("Usando a estratégia de lance da campanha");
    expect(textValue("end", row, "BRL")).toBe("Contínuo");
    expect(textValue("schedule", row, "BRL")).toBe("01/09/2026 – Contínuo");
    expect(formatValue("money", 12.5).replace(/\u00a0/g, " ")).toBe("R$ 12,50");
    expect(formatValue("percent", 1.234)).toBe("1,23%");
    expect(formatValue("seconds", 75)).toBe("1:15");
    expect(formatValue("count", null)).toBe("—");
  });
  it("a demonstração segue o nível e a seleção", async () => {
    const p = demoPlatform(["23850001"]);
    const base = { account: "1", since: "2026-09-01", until: "2026-09-07" };
    const campaigns = await p.list("co", { ...base, level: "campaign" });
    expect(campaigns.rows[0].id).toBe("23850001");
    const sets = await p.list("co", { ...base, level: "adset", campaigns: ["23850001"] });
    expect(sets.rows.every((r) => r.campaign_id === "23850001")).toBe(true);
    const ads = await p.list("co", { ...base, level: "ad", adsets: [sets.rows[0].id], breakdown: "age" });
    expect(ads.rows.every((r) => r.adset_id === sets.rows[0].id)).toBe(true);
    expect(ads.rows[0].breakdown?.length).toBe(6);
  });
});

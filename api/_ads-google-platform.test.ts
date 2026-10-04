import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleAds, type AdsEnv } from "./_ads";
import {
  googleDetail,
  googleList,
  googleQuery,
  googleReportMeta,
  googleWindows,
  keywordText,
  metricsOf,
  statusOf,
  type GoogleReportSources,
  type GoogleRow,
} from "./_ads-google-platform";

const fetchNone = (() => {
  throw Error("sem rede");
}) as unknown as typeof fetch;
/** A fake GAQL: each query answers by the first pattern it matches. */
function gaql(routes: [RegExp, (q: string) => GoogleRow[]][]) {
  const queries: string[] = [];
  const search = vi.fn(async (q: string) => {
    queries.push(q);
    const route = routes.find(([re]) => re.test(q));
    if (!route) throw Error(`Consulta inesperada: ${q}`);
    return route[1](q);
  });
  return { search, queries };
}
const customer: [RegExp, () => GoogleRow[]] = [
  /FROM customer$/,
  () => [{ customer: { descriptiveName: "Norte Ads", currencyCode: "BRL", timeZone: "America/Sao_Paulo" } }],
];
const base = { account: "1234567890", manager: "", since: "2026-09-01", until: "2026-09-07" };

describe("palavras do Google Ads", () => {
  it("status, correspondência e métricas", () => {
    expect(statusOf("ENABLED", "ELIGIBLE")).toMatchObject({ label: "Qualificada", tone: "on" });
    expect(statusOf("ENABLED", "LIMITED", ["BUDGET_CONSTRAINED"]).label).toBe("Limitada pelo orçamento");
    expect(statusOf("PAUSED", "PAUSED").label).toBe("Pausada");
    expect(keywordText("tênis", "EXACT")).toBe("[tênis]");
    expect(keywordText("tênis", "PHRASE")).toBe('"tênis"');
    expect(keywordText("tênis", "BROAD")).toBe("tênis");
    const m = metricsOf({ costMicros: "12500000", clicks: "10", searchImpressionShare: 0.425 });
    expect(m.cost).toBe(12.5);
    expect(m.search_is).toBeCloseTo(42.5);
    expect(m.search_lost_budget).toBeNull();
  });
  it("confere o pedido", () => {
    expect(() => googleQuery({ ...base, account: "x", view: "campaigns" })).toThrow(/Conta/);
    expect(() => googleQuery({ ...base, view: "nada" })).toThrow(/Visão/);
    const q = googleQuery({ ...base, account: "123-456-7890", view: "negatives", segment: "date", campaigns: ["1", "x"] });
    expect(q).toMatchObject({ account: "1234567890", campaigns: ["1"] });
    // Negatives have no segments.
    expect(q.segment).toBeUndefined();
  });
});

describe("as visões da conta", () => {
  it("campanhas com orçamento, lance, parcela de impressões e segmento por dispositivo", async () => {
    const { search, queries } = gaql([
      customer,
      [
        /segments\.device, campaign\.id/,
        () => [
          { segments: { device: "MOBILE" }, campaign: { id: "1" }, metrics: { costMicros: "3000000", clicks: "3" } },
          { segments: { device: "DESKTOP" }, campaign: { id: "1" }, metrics: { costMicros: "7000000", clicks: "2" } },
        ],
      ],
      [
        /FROM campaign WHERE/,
        () => [
          {
            campaign: { id: "1", name: "Pesquisa · Marca", status: "ENABLED", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"], advertisingChannelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS" },
            campaignBudget: { amountMicros: "50000000" },
            metrics: { costMicros: "10000000", clicks: "5", impressions: "100", conversions: 2, searchImpressionShare: 0.6 },
          },
        ],
      ],
    ]);
    const list = await googleList(search, googleQuery({ ...base, view: "campaigns", segment: "device" }), fetchNone);
    expect(list.account).toMatchObject({ name: "Norte Ads", currency: "BRL" });
    const [c] = list.rows;
    expect(c).toMatchObject({
      name: "Pesquisa · Marca",
      status: { label: "Limitada pelo orçamento", tone: "warn" },
      enabled: true,
      info: { type: "Pesquisa", budget: 50, bidding: "Maximizar conversões" },
    });
    expect(c.metrics).toMatchObject({ cost: 10, clicks: 5, conversions: 2, search_is: 60 });
    expect(c.segments?.map((s) => [s.label, s.metrics.cost])).toEqual([
      ["Computadores", 7],
      ["Celulares", 3],
    ]);
    expect(list.totals).toMatchObject({ cost: 10, clicks: 5, search_is: null });
    expect(queries.find((q) => q.includes("FROM campaign WHERE"))).toContain("segments.date BETWEEN '2026-09-01' AND '2026-09-07'");
    expect(queries.find((q) => q.includes("FROM campaign WHERE"))).toContain("campaign.status != 'REMOVED'");
  });

  it("anúncios com títulos, descrições e as imagens do display", async () => {
    const { search } = gaql([
      customer,
      [
        /FROM ad_group_ad/,
        () => [
          {
            adGroupAd: {
              status: "ENABLED",
              adStrength: "GOOD",
              policySummary: { approvalStatus: "APPROVED" },
              ad: {
                id: "77",
                type: "RESPONSIVE_SEARCH_AD",
                finalUrls: ["https://www.norte.com.br/cafe"],
                responsiveSearchAd: { headlines: [{ text: "Café especial" }, { text: "Entrega rápida" }], descriptions: [{ text: "Compre hoje." }], path1: "cafe" },
              },
            },
            adGroup: { id: "5", name: "Marca" },
            campaign: { id: "1", name: "Pesquisa" },
            metrics: { clicks: "4" },
          },
          {
            adGroupAd: { status: "PAUSED", ad: { id: "78", type: "RESPONSIVE_DISPLAY_AD", responsiveDisplayAd: { headlines: [{ text: "Display" }], marketingImages: [{ asset: "customers/1/assets/9" }] } } },
            adGroup: { id: "5", name: "Marca" },
            campaign: { id: "1", name: "Pesquisa" },
          },
        ],
      ],
      [/FROM asset WHERE/, () => [{ asset: { resourceName: "customers/1/assets/9", imageAsset: { fullSize: { url: "https://tpc.googlesyndication.com/img.jpg" } } } }]],
    ]);
    const list = await googleList(search, googleQuery({ ...base, view: "ads" }), fetchNone);
    const [rsa, rda] = list.rows;
    expect(rsa).toMatchObject({
      id: "5~77",
      name: "Café especial",
      info: { strength: "Boa", approval: "Aprovado", type: "Anúncio responsivo de pesquisa" },
      preview: { headlines: ["Café especial", "Entrega rápida"], descriptions: ["Compre hoje."], path: "norte.com.br/cafe" },
    });
    expect(rda.enabled).toBe(false);
    expect(rda.preview?.images).toEqual(["https://tpc.googlesyndication.com/img.jpg"]);
  });

  it("negativas da campanha, do grupo e das listas aplicadas", async () => {
    const { search } = gaql([
      customer,
      [/FROM campaign_criterion/, () => [{ campaignCriterion: { criterionId: "1", keyword: { text: "grátis", matchType: "BROAD" } }, campaign: { id: "1", name: "Pesquisa" } }]],
      [/FROM ad_group_criterion/, () => [{ adGroupCriterion: { criterionId: "2", keyword: { text: "vaga", matchType: "PHRASE" } }, adGroup: { id: "5", name: "Marca" }, campaign: { id: "1", name: "Pesquisa" } }]],
      [/FROM campaign_shared_set/, () => [{ sharedSet: { id: "9", name: "Marcas" }, campaign: { id: "1", name: "Pesquisa" } }]],
      [/FROM shared_criterion/, () => [
        { sharedCriterion: { criterionId: "3", keyword: { text: "concorrente", matchType: "EXACT" } }, sharedSet: { id: "9", name: "Marcas" } },
        { sharedCriterion: { criterionId: "4", keyword: { text: "fora", matchType: "EXACT" } }, sharedSet: { id: "8", name: "Não usada" } },
      ]],
    ]);
    const list = await googleList(search, googleQuery({ ...base, view: "negatives" }), fetchNone);
    expect(list.rows.map((r) => [r.name, r.info.level, r.info.where])).toEqual([
      ["grátis", "Campanha", "Pesquisa"],
      ['"vaga"', "Grupo de anúncios", "Pesquisa › Marca"],
      ["[concorrente]", "Lista: Marcas", "Pesquisa"],
    ]);
    expect(list.totals).toBeNull();
  });

  it("leilão: sem acesso aos concorrentes, as parcelas e um aviso", async () => {
    const { search } = gaql([
      customer,
      [/auction_insight/, () => { throw Error("not allowed"); }],
      [/FROM campaign WHERE/, () => [{ campaign: { id: "1", name: "Pesquisa", status: "ENABLED" }, metrics: { searchImpressionShare: 0.5, searchBudgetLostImpressionShare: 0.1 } }]],
    ]);
    const list = await googleList(search, googleQuery({ ...base, view: "auction" }), fetchNone);
    expect(list.rows[0].metrics).toMatchObject({ search_is: 50, search_lost_budget: 10 });
    expect(list.notice).toMatch(/informações de leilão/);
  });

  it("locais com o nome do Google e idade na ordem das faixas", async () => {
    const { search } = gaql([
      customer,
      [/FROM geographic_view/, () => [
        { segments: { geoTargetCity: "geoTargetConstants/1001773" }, metrics: { costMicros: "2000000" } },
        { segments: { geoTargetCity: "geoTargetConstants/1001773" }, metrics: { costMicros: "1000000" } },
      ]],
      [/FROM geo_target_constant/, () => [{ geoTargetConstant: { resourceName: "geoTargetConstants/1001773", name: "São Paulo", canonicalName: "São Paulo,State of Sao Paulo,Brazil" } }]],
      [/FROM age_range_view/, () => [
        { adGroupCriterion: { ageRange: { type: "AGE_RANGE_35_44" } }, metrics: { clicks: "1" } },
        { adGroupCriterion: { ageRange: { type: "AGE_RANGE_18_24" } }, metrics: { clicks: "2" } },
      ]],
    ]);
    const places = await googleList(search, googleQuery({ ...base, view: "locations" }), fetchNone);
    expect(places.rows[0]).toMatchObject({ name: "São Paulo", metrics: { cost: 3 } });
    const ages = await googleList(search, googleQuery({ ...base, view: "age" }), fetchNone);
    expect(ages.rows.map((r) => r.name)).toEqual(["18-24", "35-44"]);
  });

  it("detalhe de uma palavra-chave: dias e dispositivos", async () => {
    const { search, queries } = gaql([
      [/SELECT segments\.date/, () => [{ segments: { date: "2026-09-02" }, metrics: { clicks: "2" } }, { segments: { date: "2026-09-01" }, metrics: { clicks: "1" } }]],
      [/SELECT segments\.device/, () => [{ segments: { device: "MOBILE" }, metrics: { clicks: "3" } }]],
    ]);
    const d = await googleDetail(search, { ...base, view: "keywords", id: "5~33" });
    expect(d.days.map((x) => x.day)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(d.devices[0].label).toBe("Celulares");
    expect(queries[0]).toContain("ad_group_criterion.criterion_id = 33");
    await expect(googleDetail(search, { ...base, view: "keywords", id: "5~x" })).rejects.toThrow(/inválido/);
  });
});

describe("o que o relatório guarda do Google", () => {
  const sources: GoogleReportSources = {
    platform: "google",
    cycles: [
      { id: "y1", start_date: "2026-09-01", end_date: "2026-09-30", objective: "lead", destination: "external_page", conversion_actions: ["555"] },
    ],
    links: [{ account_id: "1234567890", campaign_id: "1", manager_id: "9990001111" }],
  };
  it("só as conversões escolhidas no ciclo contam, por item e por dia", async () => {
    const managers: string[] = [];
    const { search, queries } = gaql([
      [/FROM customer$/, () => [{ customer: { currencyCode: "BRL" } }]],
      [
        /segments\.conversion_action/,
        (q) =>
          q.includes("FROM keyword_view")
            ? [
                { segments: { date: "2026-09-01", conversionAction: "customers/1/conversionActions/555", conversionActionCategory: "SUBMIT_LEAD_FORM" }, adGroup: { id: "5" }, adGroupCriterion: { criterionId: "33" }, metrics: { conversions: 2 } },
                { segments: { date: "2026-09-01", conversionAction: "customers/1/conversionActions/777", conversionActionCategory: "SUBMIT_LEAD_FORM" }, adGroup: { id: "5" }, adGroupCriterion: { criterionId: "33" }, metrics: { conversions: 9 } },
              ]
            : [],
      ],
      [
        /FROM keyword_view/,
        () => [
          { segments: { date: "2026-09-01" }, adGroup: { id: "5", name: "Marca" }, campaign: { name: "Pesquisa" }, adGroupCriterion: { criterionId: "33", keyword: { text: "café", matchType: "EXACT" } }, metrics: { costMicros: "4000000", impressions: "100", clicks: "8" } },
        ],
      ],
      [/FROM (ad_group_ad|ad_group|search_term_view) WHERE/, () => []],
    ]);
    const meta = await googleReportMeta(
      (account, manager) => {
        managers.push(`${account}/${manager}`);
        return search;
      },
      sources,
      [{ start: "2026-09-01", end: "2026-09-07" }],
      5,
      fetchNone,
    );
    expect(managers).toEqual(["1234567890/9990001111"]);
    expect(meta.keywords[0]).toMatchObject({ name: "[café]", adset: "Marca", kind: "Correspondência exata" });
    // 555 counts (2), 777 doesn't.
    expect(meta.keywords[0].days).toEqual([{ d: "2026-09-01", s: 4, i: 100, c: 8, r: 2 }]);
    expect(meta.reach).toBeNull();
    expect(queries.every((q) => !q.includes("FROM keyword_view") || q.includes("campaign.id IN (1)"))).toBe(true);
  });
});

describe("/api/ads: google-platform", () => {
  const key = crypto.randomBytes(32);
  const env: AdsEnv = {
    supabaseUrl: "https://db.example.com",
    supabaseKey: "publishable",
    tokenKey: key,
    redirectUri: "https://workspace.example.com/api/ads-callback",
    meta: { appId: "app-1", appSecret: "app-secret", version: "v23.0" },
    google: { clientId: "client-id", clientSecret: "client-secret", developerToken: "dev-token", version: "v25" },
  };
  it("um colaborador só abre as contas dos clientes dele", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("rpc/ad_google_scope")) return new Response(JSON.stringify(["1111111111"]));
      throw Error(`inesperado: ${url}`);
    }) as unknown as typeof fetch;
    const res = await handleAds(
      { action: "google-platform", company: "00000000-0000-4000-8000-000000000001", provider: "google", account: "2222222222", view: "campaigns", since: "2026-09-01", until: "2026-09-07" },
      "Bearer user",
      env,
      fetchMock,
    );
    expect(res.status).toBe(403);
  });
});

describe("leitura enxuta dos insights do Google", () => {
  it("uma consulta por visão, por dia, somada em cada janela; sem a consulta do cliente", async () => {
    const day = (date: string, cost: number, conversions: number) => ({
      segments: { date },
      campaign: { id: "11", name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH" },
      metrics: { costMicros: String(cost * 1e6), conversions: String(conversions), impressions: "100", clicks: "10" },
    });
    const { search, queries } = gaql([
      [/FROM campaign /, () => [day("2026-09-01", 10, 1), day("2026-09-28", 20, 2), day("2026-09-30", 30, 0)]],
    ]);
    const rows = await googleWindows(search, {
      account: "1234567890",
      manager: "",
      view: "campaigns",
      campaigns: ["11"],
      ranges: [
        { key: "cycle", since: "2026-09-01", until: "2026-09-30" },
        { key: "d7", since: "2026-09-24", until: "2026-09-30" },
      ],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/segments\.date, campaign\.id/);
    expect(queries[0]).toMatch(/BETWEEN '2026-09-01' AND '2026-09-30'/);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Pesquisa");
    expect(rows[0].windows.cycle).toMatchObject({ cost: 60, conversions: 3 });
    expect(rows[0].windows.d7).toMatchObject({ cost: 50, conversions: 2 });
  });
});

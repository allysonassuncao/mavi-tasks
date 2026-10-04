import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleAds, type AdsEnv } from "./_ads";
import {
  attributionLabel,
  deliveryOf,
  fromMinor,
  inlineImage,
  metricsOf,
  platformList,
  platformQuery,
  platformWindows,
  previewSrc,
  reportMeta,
  resultSpec,
  resultValue,
  type ReportSources,
} from "./_ads-platform";
import { seal } from "./_google";

const key = crypto.randomBytes(32);
const env: AdsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  tokenKey: key,
  redirectUri: "https://workspace.example.com/api/ads-callback",
  meta: { appId: "app-1", appSecret: "app-secret", version: "v23.0" },
  google: {
    clientId: "client-id",
    clientSecret: "client-secret",
    developerToken: "dev-token",
    version: "v25",
  },
};
const company = "00000000-0000-4000-8000-000000000001";
const campaign = "00000000-0000-4000-8000-000000000002";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

type Call = { url: URL; method: string; body?: string };
function network(routes: [RegExp, (call: Call) => Response][]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: new URL(url), method: init.method ?? "GET", body: init.body?.toString() };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw Error(`Rota inesperada: ${call.method} ${url}`);
    return route[1](call);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}
const param = (c: Call, k: string) => c.url.searchParams.get(k) ?? "";

describe("Resultados como o Gerenciador de Anúncios", () => {
  it("segue a meta de desempenho do conjunto", () => {
    expect(resultSpec({ id: "1", optimization_goal: "LEAD_GENERATION" })?.label).toBe(
      "Leads no formulário",
    );
    expect(
      resultSpec({
        id: "1",
        optimization_goal: "OFFSITE_CONVERSIONS",
        promoted_object: { custom_event_type: "PURCHASE" },
      })?.actions,
    ).toEqual(["offsite_conversion.fb_pixel_purchase", "purchase"]);
    expect(
      resultSpec({
        id: "1",
        optimization_goal: "OFFSITE_CONVERSIONS",
        promoted_object: { custom_conversion_id: "987" },
      })?.actions,
    ).toEqual(["offsite_conversion.custom.987"]);
    expect(resultSpec({ id: "1", optimization_goal: "REACH" })?.metric).toBe("reach");
    expect(resultSpec({ id: "1", optimization_goal: "CONVERSATIONS" })?.label).toBe(
      "Conversas por mensagem iniciadas",
    );
    expect(resultSpec({ id: "1", optimization_goal: "SOMETHING_NEW" })).toBeNull();
  });

  it("lê o primeiro tipo de ação presente, a métrica ou o campo de vídeo", () => {
    const row = {
      reach: "900",
      actions: [
        { action_type: "lead", value: "9" },
        { action_type: "onsite_conversion.lead_grouped", value: "7" },
      ],
      video_thruplay_watched_actions: [{ action_type: "video_view", value: "33" }],
    };
    expect(resultValue(row, resultSpec({ id: "1", optimization_goal: "LEAD_GENERATION" }))).toBe(7);
    expect(resultValue(row, resultSpec({ id: "1", optimization_goal: "REACH" }))).toBe(900);
    expect(resultValue(row, resultSpec({ id: "1", optimization_goal: "THRUPLAY" }))).toBe(33);
    expect(resultValue(row, null)).toBeNull();
    const m = metricsOf(
      {
        spend: "12.5",
        impressions: "1000",
        inline_link_clicks: "20",
        actions: [{ action_type: "post_reaction", value: "4" }],
        video_play_actions: [{ action_type: "video_view", value: "10" }],
        video_avg_time_watched_actions: [{ action_type: "video_view", value: "3" }],
      },
      null,
    );
    expect(m).toMatchObject({ spend: 12.5, impressions: 1000, link_clicks: 20, reactions: 4, results: null });
    // The average time adds up as seconds × plays.
    expect(m.video_time_total).toBe(30);
  });

  it("veiculação, atribuição e orçamento nas palavras do Meta", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(deliveryOf("ACTIVE", "ACTIVE", undefined, now).label).toBe("Ativo");
    expect(deliveryOf("ACTIVE", "ACTIVE", "2026-09-01T00:00:00Z", now).label).toBe("Concluído");
    expect(deliveryOf("ACTIVE", "ACTIVE", undefined, now, "LEARNING").label).toBe("Aprendizado");
    expect(deliveryOf("CAMPAIGN_PAUSED", "ACTIVE", undefined, now)).toMatchObject({
      label: "Campanha desativada",
      tone: "off",
    });
    expect(attributionLabel("7d_click_1d_view")).toBe(
      "7 dias após o clique ou 1 dia após a visualização",
    );
    expect(fromMinor("15000", "BRL")).toBe(150);
    expect(fromMinor("15000", "JPY")).toBe(15000);
    expect(fromMinor(undefined, "BRL")).toBeNull();
  });

  it("confere o que a página pede", () => {
    expect(() => platformQuery({ account: "x", level: "campaign" })).toThrow(/Conta/);
    expect(() =>
      platformQuery({ account: "123", level: "campaign", since: "2026-09-10", until: "2026-09-01" }),
    ).toThrow(/Período/);
    const q = platformQuery({
      account: "act_123",
      level: "ad",
      since: "2026-09-01",
      until: "2026-09-07",
      campaigns: ["1", "nope", "2"],
      breakdown: "age",
    });
    expect(q).toMatchObject({ account: "123", campaigns: ["1", "2"], breakdown: "age" });
    expect(platformQuery({ account: "1", level: "campaign", preset: "maximum" }).preset).toBe("maximum");
  });

  it("a prévia só aceita o iframe do Facebook", () => {
    expect(
      previewSrc('<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=1&amp;t=2" width="540"></iframe>'),
    ).toBe("https://www.facebook.com/ads/api/preview_iframe.php?d=1&t=2");
    expect(previewSrc('<iframe src="https://evil.example.com/x"></iframe>')).toBeNull();
    expect(previewSrc("")).toBeNull();
  });
});

describe("a lista da plataforma", () => {
  it("campanhas com os resultados dos conjuntos, orçamento e totais da conta", async () => {
    const { fetch, calls } = network([
      [/\/act_123\?/, () => json({ name: "Conta Norte", currency: "BRL", timezone_name: "America/Sao_Paulo" })],
      [
        /\/act_123\/campaigns/,
        () =>
          json({
            data: [
              { id: "c1", name: "Leads", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", daily_budget: "15000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" },
              { id: "c2", name: "Misto", effective_status: "PAUSED", objective: "OUTCOME_SALES" },
            ],
          }),
      ],
      [
        /\/act_123\/adsets/,
        () =>
          json({
            data: [
              { id: "s1", campaign_id: "c1", optimization_goal: "LEAD_GENERATION" },
              { id: "s2", campaign_id: "c2", optimization_goal: "LINK_CLICKS" },
              { id: "s3", campaign_id: "c2", optimization_goal: "REACH" },
            ],
          }),
      ],
      [
        /\/act_123\/insights/,
        (c) =>
          param(c, "level") === "account"
            ? json({ data: [{ spend: "30", impressions: "3000", reach: "1500", inline_link_clicks: "30" }] })
            : json({
                data: [
                  { campaign_id: "c1", spend: "20", impressions: "2000", reach: "1200", attribution_setting: "7d_click_1d_view", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "4" }] },
                  { campaign_id: "c2", spend: "10", impressions: "1000", reach: "600", inline_link_clicks: "30" },
                ],
              }),
      ],
    ]);
    const list = await platformList(env, fetch, "token", {
      account: "123",
      level: "campaign",
      since: "2026-09-01",
      until: "2026-09-07",
    });
    expect(list.account).toMatchObject({ name: "Conta Norte", currency: "BRL" });
    const [leads, mixed] = list.rows;
    expect(leads).toMatchObject({
      result_label: "Leads no formulário",
      objective: "Cadastros",
      budget: { amount: 150, period: "daily" },
      bid_strategy: "Maior volume",
      attribution: "7 dias após o clique ou 1 dia após a visualização",
    });
    expect(leads.metrics.results).toBe(4);
    // Ad sets counting different things: "Vários", no number.
    expect(mixed.result_label).toBe("Vários");
    expect(mixed.metrics.results).toBeNull();
    expect(mixed.budget).toEqual({ shared: "adset" });
    expect(mixed.delivery.label).toBe("Desativado");
    // The footer: the account's deduplicated reach; mixed results, none.
    expect(list.totals.reach).toBe(1500);
    expect(list.totals.results).toBeNull();
    expect(list.result_label).toBe("Vários");
    // Structure lists hide archived and deleted objects by default.
    const structure = calls.find((c) => c.url.pathname.endsWith("/campaigns"))!;
    expect(param(structure, "filtering")).toContain("effective_status");
    expect(param(structure, "filtering")).not.toContain("ARCHIVED");
    // The token goes in the header with the app secret proof.
    expect(param(structure, "access_token")).toBe("");
    expect(param(structure, "appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("anúncios filtrados pelos conjuntos escolhidos, com detalhamento", async () => {
    const { fetch, calls } = network([
      [/\/act_9\?/, () => json({ name: "Conta", currency: "BRL" })],
      [
        /\/act_9\/ads\?/,
        () =>
          json({
            data: [
              {
                id: "a1",
                name: "Vídeo",
                adset_id: "s1",
                campaign_id: "c1",
                campaign: { name: "Leads" },
                adset: { name: "Aberto" },
                effective_status: "ACTIVE",
                creative: { thumbnail_url: "https://scontent.fbcdn.net/t.jpg", instagram_permalink_url: "https://instagram.com/p/1" },
              },
            ],
          }),
      ],
      [/\/act_9\/adsets/, () => json({ data: [{ id: "s1", campaign_id: "c1", optimization_goal: "LEAD_GENERATION" }] })],
      [
        /\/act_9\/insights/,
        (c) =>
          param(c, "level") === "account"
            ? json({ data: [{ spend: "5", impressions: "500", reach: "400" }] })
            : param(c, "breakdowns") === "age"
              ? json({
                  data: [
                    { ad_id: "a1", age: "25-34", spend: "3", actions: [{ action_type: "lead", value: "2" }] },
                    { ad_id: "a1", age: "18-24", spend: "2", actions: [{ action_type: "lead", value: "1" }] },
                  ],
                })
              : json({ data: [{ ad_id: "a1", spend: "5", impressions: "500", quality_ranking: "ABOVE_AVERAGE", actions: [{ action_type: "lead", value: "3" }] }] }),
      ],
    ]);
    const list = await platformList(env, fetch, "t", {
      account: "9",
      level: "ad",
      since: "2026-09-01",
      until: "2026-09-02",
      adsets: ["s1"],
      breakdown: "age",
    });
    const [ad] = list.rows;
    expect(ad).toMatchObject({
      adset_name: "Aberto",
      campaign_name: "Leads",
      result_label: "Leads no formulário",
      rankings: { quality: "ABOVE_AVERAGE" },
      creative: { link: "https://instagram.com/p/1" },
    });
    expect(ad.metrics.results).toBe(3);
    expect(ad.breakdown!.map((b) => [b.label, b.metrics.results])).toEqual([
      ["25-34", 2],
      ["18-24", 1],
    ]);
    expect(list.totals.results).toBe(3);
    const insight = calls.find((c) => c.url.pathname.endsWith("/insights") && param(c, "level") === "ad")!;
    expect(JSON.parse(param(insight, "filtering"))).toEqual([
      { field: "adset.id", operator: "IN", value: ["s1"] },
    ]);
  });
});

describe("o que o relatório guarda do Meta", () => {
  const sources: ReportSources = {
    platform: "meta",
    cycles: [
      { id: "y1", start_date: "2026-08-01", end_date: "2026-08-31", objective: "lead", destination: "lead_form" },
      { id: "y2", start_date: "2026-09-01", end_date: "2026-09-30", objective: "message", destination: "external_page" },
    ],
    links: [
      { account_id: "111", campaign_id: "c1" },
      { account_id: "111", campaign_id: "c2" },
    ],
  };
  it("os dias de cada anúncio com a regra do ciclo do dia, o alcance e a imagem", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { fetch, calls } = network([
      [/\/act_111\?/, () => json({ currency: "BRL" })],
      [
        /\/act_111\/insights/,
        (c) =>
          param(c, "level") === "account"
            ? json({ data: [{ reach: "5000" }] })
            : param(c, "level") === "adset"
              ? json({ data: [{ adset_id: "s1", reach: "4000" }] })
              : param(c, "time_increment")
                ? json({
                    data: [
                      { ad_id: "a1", ad_name: "Vídeo", adset_id: "s1", adset_name: "Aberto", campaign_name: "C1", date_start: "2026-08-31", spend: "10", impressions: "100", inline_link_clicks: "5", actions: [{ action_type: "leadgen_grouped", value: "2" }, { action_type: "onsite_conversion.messaging_first_reply", value: "9" }] },
                      { ad_id: "a1", ad_name: "Vídeo", adset_id: "s1", adset_name: "Aberto", campaign_name: "C1", date_start: "2026-09-01", spend: "20", impressions: "200", inline_link_clicks: "8", actions: [{ action_type: "leadgen_grouped", value: "4" }, { action_type: "onsite_conversion.messaging_first_reply", value: "3" }] },
                      { ad_id: "a2", ad_name: "Imagem", adset_id: "s1", adset_name: "Aberto", campaign_name: "C1", date_start: "2026-09-01", spend: "1", impressions: "10", inline_link_clicks: "0" },
                    ],
                  })
                : json({ data: [{ ad_id: "a1", reach: "3000" }] }),
      ],
      [
        /graph\.facebook\.com\/v23\.0\/\?/,
        () => json({ a1: { creative: { thumbnail_url: "https://scontent.fbcdn.net/a1.png", title: "Oferta", object_type: "VIDEO" } } }),
      ],
      [/scontent\.fbcdn\.net/, () => new Response(png, { headers: { "content-type": "image/png" } })],
    ]);
    const meta = await reportMeta(env, fetch, async () => "tok", sources, "2026-08-31", "2026-09-01", 1);
    expect(meta.reach).toBe(5000);
    expect(meta.currency).toBe("BRL");
    const [a1, a2] = meta.ads;
    // 31/08 in the lead cycle (form leads), 01/09 in the message cycle.
    expect(a1.days).toEqual([
      { d: "2026-08-31", s: 10, i: 100, c: 5, r: 2 },
      { d: "2026-09-01", s: 20, i: 200, c: 8, r: 3 },
    ]);
    expect(a1).toMatchObject({ reach: 3000, title: "Oferta", video: true, adset: "Aberto" });
    expect(a1.thumb).toBe(`data:image/png;base64,${png.toString("base64")}`);
    // Only the top ad (by spend) gets its creative.
    expect(a2.thumb).toBeUndefined();
    expect(meta.adsets[0]).toMatchObject({ id: "s1", reach: 4000 });
    expect(meta.adsets[0].days[1]).toEqual({ d: "2026-09-01", s: 21, i: 210, c: 8, r: 3 });
    // Both linked campaigns, one account.
    const daily = calls.find((c) => param(c, "time_increment") === "1")!;
    expect(JSON.parse(param(daily, "filtering"))[0].value).toEqual(["c1", "c2"]);
  });

  it("com comparação: os dias dos dois períodos e o alcance de cada um", async () => {
    const { fetch, calls } = network([
      [/\/act_111\?/, () => json({ currency: "BRL" })],
      [
        /\/act_111\/insights/,
        (c) => {
          const since = JSON.parse(param(c, "time_range")).since;
          if (param(c, "level") === "account")
            return json({ data: [{ reach: since === "2026-08-01" ? "700" : "900" }] });
          if (param(c, "time_increment"))
            return json({
              data: [
                { ad_id: "a1", ad_name: "Vídeo", adset_id: "s1", adset_name: "Aberto", date_start: since, spend: since === "2026-08-01" ? "5" : "8", impressions: "10", inline_link_clicks: "1", actions: [{ action_type: "leadgen_grouped", value: "1" }] },
              ],
            });
          return json({ data: [] });
        },
      ],
      [/graph\.facebook\.com\/v23\.0\/\?/, () => json({})],
    ]);
    const meta = await reportMeta(env, fetch, async () => "tok", sources, "2026-09-01", "2026-09-07", 5, {
      start: "2026-08-01",
      end: "2026-08-07",
    });
    expect(meta.reach).toBe(900);
    expect(meta.compare_reach).toBe(700);
    expect(meta.ads[0].days.map((d) => [d.d, d.s])).toEqual([
      ["2026-08-01", 5],
      ["2026-09-01", 8],
    ]);
    // Two separate reads of days: the gap between the periods is skipped.
    const ranges = calls
      .filter((c) => param(c, "time_increment") === "1")
      .map((c) => JSON.parse(param(c, "time_range")));
    expect(ranges).toEqual([
      { since: "2026-09-01", until: "2026-09-07" },
      { since: "2026-08-01", until: "2026-08-07" },
    ]);
  });

  it("imagens só do Facebook, pequenas e de tipos de imagem", async () => {
    const big = new Response(Buffer.alloc(200_000), { headers: { "content-type": "image/jpeg" } });
    const { fetch } = network([
      [/big\.fbcdn\.net/, () => big],
      [/html\.fbcdn\.net/, () => new Response("<html>", { headers: { "content-type": "text/html" } })],
    ]);
    expect(await inlineImage(fetch, "https://evil.example.com/x.png")).toBeUndefined();
    expect(await inlineImage(fetch, "http://scontent.fbcdn.net/x.png")).toBeUndefined();
    expect(await inlineImage(fetch, "https://big.fbcdn.net/x.jpg")).toBeUndefined();
    expect(await inlineImage(fetch, "https://html.fbcdn.net/x")).toBeUndefined();
    expect(await inlineImage(fetch, undefined)).toBeUndefined();
  });
});

describe("/api/ads: report-create", () => {
  it("lê as fontes, os anúncios do Meta e cria o relatório como a pessoa", async () => {
    const cipher = seal(key, "meta-token");
    const { fetch, calls } = network([
      [
        /rpc\/ad_report_sources/,
        () =>
          json({
            platform: "meta",
            cycles: [{ id: "y1", start_date: "2026-09-01", end_date: "2026-09-30", objective: "lead", destination: "lead_form" }],
            links: [{ account_id: "111", campaign_id: "c1" }],
          }),
      ],
      [/rpc\/ad_meta_token/, () => json([{ token_cipher: cipher, token_expires_at: null }])],
      [/\/act_111\?/, () => json({ currency: "BRL" })],
      [/\/act_111\/insights/, () => json({ data: [] })],
      [/rpc\/create_ad_report/, (c) => json({ id: "r1", echo: JSON.parse(c.body!) })],
    ]);
    const res = await handleAds(
      {
        action: "report-create",
        company,
        provider: "meta",
        campaign,
        title: "Setembro",
        start: "2026-09-01",
        end: "2026-09-07",
        config: { with_m: true, ads_limit: 5 },
        link: true,
        password: "segredo",
        compare_start: "2026-08-25",
        compare_end: "2026-08-31",
      },
      "Bearer user",
      env,
      fetch,
    );
    expect(res.status).toBe(200);
    const created = calls.find((c) => c.url.pathname.endsWith("create_ad_report"))!;
    const args = JSON.parse(created.body!);
    expect(args).toMatchObject({
      p_campaign: campaign,
      p_title: "Setembro",
      p_start: "2026-09-01",
      p_end: "2026-09-07",
      p_link: true,
      p_password: "segredo",
      p_config: { with_m: true, ads_limit: 5 },
      p_compare_start: "2026-08-25",
      p_compare_end: "2026-08-31",
    });
    // The sources cover both periods.
    const sources = calls.find((c) => c.url.pathname.endsWith("ad_report_sources"))!;
    expect(JSON.parse(sources.body!)).toMatchObject({ p_start: "2026-08-25", p_end: "2026-09-07" });
    expect(args.p_meta.compare_reach).toBe(0);
    expect(args.p_meta).toMatchObject({ currency: "BRL", ads: [], reach: 0 });
    // The Meta token is the database's (as the person), never the browser's.
    const token = calls.find((c) => c.url.pathname.endsWith("ad_meta_token"))!;
    expect(JSON.parse(token.body!)).toEqual({ p_company: company, p_account: "111" });
  });

  it("se o Meta falhar, o relatório sai com os números e diz por quê", async () => {
    const { fetch, calls } = network([
      [
        /rpc\/ad_report_sources/,
        () =>
          json({
            platform: "meta",
            cycles: [{ id: "y1", start_date: "2026-09-01", end_date: "2026-09-30", objective: "lead", destination: "lead_form" }],
            links: [{ account_id: "111", campaign_id: "" }],
          }),
      ],
      [/rpc\/ad_meta_token/, () => json([])],
      [/rpc\/create_ad_report/, () => json({ id: "r1" })],
    ]);
    const res = await handleAds(
      { action: "report-create", company, provider: "meta", campaign, title: "X", start: "2026-09-01", end: "2026-09-02", config: {} },
      "Bearer user",
      env,
      fetch,
    );
    expect(res.status).toBe(200);
    const args = JSON.parse(calls.find((c) => c.url.pathname.endsWith("create_ad_report"))!.body!);
    expect(args.p_meta.error).toMatch(/não está conectada/);
  });

  it("a plataforma pede a conta conectada (sem ela, erro do banco)", async () => {
    const { fetch } = network([[/rpc\/ad_meta_token/, () => json([])]]);
    const res = await handleAds(
      { action: "platform", company, provider: "meta", account: "act_5", level: "campaign", since: "2026-09-01", until: "2026-09-02" },
      "Bearer user",
      env,
      fetch,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_connected");
    const bad = await handleAds(
      { action: "platform", company, provider: "meta", account: "x", level: "campaign" },
      "Bearer user",
      env,
      fetch,
    );
    expect(bad.status).toBe(400);
  });
});

describe("leitura enxuta dos insights (várias janelas numa chamada)", () => {
  it("uma chamada de insights com time_ranges; cada linha na sua janela; sem conta nem totais", async () => {
    const { fetch, calls } = network([
      [
        /\/act_7\/adsets/,
        () =>
          json({
            data: [
              { id: "s1", name: "Público A", campaign_id: "c1", campaign: { name: "Leads" }, effective_status: "ACTIVE", optimization_goal: "LEAD_GENERATION" },
            ],
          }),
      ],
      [
        /\/act_7\/insights/,
        (c) =>
          param(c, "breakdowns")
            ? json({
                data: [
                  { adset_id: "s1", age: "25-34", gender: "female", spend: "6", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "3" }] },
                  { adset_id: "s1", age: "35-44", gender: "male", spend: "4", actions: [] },
                ],
              })
            : json({
                data: [
                  { adset_id: "s1", date_start: "2026-09-01", date_stop: "2026-09-30", spend: "100", impressions: "1000", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "8" }] },
                  { adset_id: "s1", date_start: "2026-09-24", date_stop: "2026-09-30", spend: "30", impressions: "300", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "2" }] },
                ],
              }),
      ],
    ]);
    const cycle = { key: "cycle", since: "2026-09-01", until: "2026-09-30" };
    const r = await platformWindows(env, fetch, "t", {
      account: "7",
      level: "adset",
      campaigns: ["c1"],
      ranges: [cycle, { key: "d7", since: "2026-09-24", until: "2026-09-30" }],
      breakdown: { kind: "age_gender", range: cycle },
    });
    expect(r.result_label).toBe("Leads no formulário");
    expect(r.rows[0]).toMatchObject({ id: "s1", name: "Público A", campaign_name: "Leads", optimization: "Cadastros" });
    expect(r.rows[0].windows.cycle).toMatchObject({ spend: 100, results: 8 });
    expect(r.rows[0].windows.d7).toMatchObject({ spend: 30, results: 2 });
    expect(r.rows[0].breakdown?.[0]).toMatchObject({ key: "25-34|female" });
    // Estrutura (com as metas) + insights das janelas + o público: 3 chamadas.
    expect(calls).toHaveLength(3);
    const insights = calls.find((c) => c.url.pathname.endsWith("/insights") && !param(c, "breakdowns"))!;
    expect(JSON.parse(param(insights, "time_ranges"))).toEqual([
      { since: "2026-09-01", until: "2026-09-30" },
      { since: "2026-09-24", until: "2026-09-30" },
    ]);
    expect(calls.some((c) => c.url.pathname === "/v23.0/act_7")).toBe(false);
  });
});

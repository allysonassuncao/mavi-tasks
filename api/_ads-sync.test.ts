import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  googleActionTotals,
  googleTotals,
  handleAdsSync,
  metaResults,
  syncWindow,
  usesMakeLeads,
  type SyncEnv,
  type SyncTarget,
} from "./_ads-sync";
import { seal } from "./_google";

const key = crypto.randomBytes(32);
const env: SyncEnv = {
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
  secret: "s".repeat(40),
  makeLeadsUrl: "https://make.example.com/api/capture/mavi-leads.php",
  makeLeadsSecret: "m".repeat(40),
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
type Call = {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
};
function network(routes: [RegExp, (call: Call) => Response][]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: init.body?.toString(),
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw Error(`Rota inesperada: ${call.method} ${url}`);
    return route[1](call);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}
const target = (extra: Partial<SyncTarget> = {}): SyncTarget => ({
  cycle_id: "cy-1",
  company_id: "co-1",
  campaign_id: "ca-1",
  platform: "meta",
  objective: "message",
  destination: "external_page",
  start_date: "2026-09-20",
  end_date: "2026-10-19",
  today: "2026-09-24",
  last_day: null,
  links: [{ account_id: "111", campaign_id: "c1", manager_id: "" }],
  meta_tokens: {
    "111": { token_cipher: seal(key, "fb-token"), expires_at: null },
  },
  google_token: null,
  ...extra,
});

describe("janela de leitura", () => {
  it("sempre o ciclo inteiro até ontem (ou até o fim do ciclo)", () => {
    expect(syncWindow(target())).toEqual({
      since: "2026-09-20",
      until: "2026-09-23",
    });
    // Synced before: still the whole cycle (a rule change reaches every day).
    expect(
      syncWindow(target({ start_date: "2026-09-01", last_day: "2026-09-22" })),
    ).toEqual({ since: "2026-09-01", until: "2026-09-23" });
    expect(
      syncWindow(
        target({
          start_date: "2026-08-20",
          end_date: "2026-09-19",
          last_day: "2026-09-18",
        }),
      ),
    ).toEqual({ since: "2026-08-20", until: "2026-09-19" });
    expect(syncWindow(target({ start_date: "2026-09-24" }))).toBeNull();
  });
});

describe("o que conta como resultado (regras dos crons do MASO)", () => {
  const actions = [
    {
      action_type: "onsite_conversion.messaging_conversation_started_7d",
      value: "12",
    },
    { action_type: "onsite_conversion.messaging_first_reply", value: "10" },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "5" },
    { action_type: "lead", value: "9" },
    { action_type: "leadgen_grouped", value: "4" },
    { action_type: "onsite_conversion.lead_grouped", value: "6" },
    { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
    { action_type: "purchase", value: "3" },
    { action_type: "landing_page_view", value: "40" },
    { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: "8" },
    { action_type: "add_to_cart", value: "7" },
    { action_type: "initiate_checkout", value: "5" },
    { action_type: "offsite_conversion.fb_pixel_custom", value: "2" },
    {
      action_type: "offsite_conversion.fb_pixel_complete_registration",
      value: "1",
    },
    { action_type: "post_engagement", value: "300" },
    { action_type: "video_view", value: "70" },
  ];
  const row = { actions, inline_link_clicks: "80" };
  const c = (
    o: Parameters<typeof metaResults>[0],
    d: Parameters<typeof metaResults>[1],
  ) => metaResults(o, d, row).conversions;

  it("Meta, página externa: cada objetivo com a ação do MASO", () => {
    // MENSAGEM: first reply (the MASO's since 19/07/2023), not 7-day conversations.
    expect(c("message", "external_page")).toBe(10);
    // LEAD: the pixel's lead only (not "lead", which adds other leads).
    expect(c("lead", "external_page")).toBe(5);
    // PERSONALIZADA: the pixel's custom events.
    expect(c("custom", "external_page")).toBe(2);
    expect(c("video", "external_page")).toBe(70);
    // VENDA: purchases, and the funnel with the aggregated actions.
    expect(metaResults("sale", "external_page", row)).toEqual({
      conversions: 3,
      view_content: 40,
      add_to_cart: 7,
      initiate_checkout: 5,
    });
    expect(metaResults("lead", "external_page", row).view_content).toBe(0);
  });
  it("Meta: tráfego e engajamento valem em qualquer destino", () => {
    for (const d of [
      "external_page",
      "lead_form",
      "make_landing_page",
    ] as const) {
      expect(c("traffic", d)).toBe(80);
      expect(c("engagement", d)).toBe(300);
    }
  });
  it("Meta, formulário do Facebook: leadgen_grouped em qualquer objetivo", () => {
    for (const o of ["lead", "message", "sale", "custom"] as const)
      expect(c(o, "lead_form")).toBe(4);
    // Without leadgen_grouped, the newer name.
    expect(
      metaResults("lead", "lead_form", {
        actions: [
          { action_type: "onsite_conversion.lead_grouped", value: "6" },
        ],
      }).conversions,
    ).toBe(6);
  });
  it("Meta, página de captura da Make: os cadastros vêm da Make", () => {
    expect(c("lead", "make_landing_page")).toBe(0);
    expect(
      usesMakeLeads({ objective: "lead", destination: "make_landing_page" }),
    ).toBe(true);
    expect(
      usesMakeLeads({ objective: "sale", destination: "make_landing_page" }),
    ).toBe(true);
    expect(
      usesMakeLeads({ objective: "traffic", destination: "make_landing_page" }),
    ).toBe(false);
    expect(
      usesMakeLeads({ objective: "lead", destination: "external_page" }),
    ).toBe(false);
  });

  const googleActions = [
    { name: "Clique no WhatsApp", conversions: 3.4 },
    { name: "Ligações de anúncios (phone)", conversions: 1 },
    { name: "Lead - Formulário", conversions: 2.6 },
    { name: "Compra", conversions: 2 },
    { name: "Inscrição newsletter", conversions: 1 },
    { name: "Visualização de página", conversions: 50 },
    { name: "Adição ao carrinho", conversions: 9 },
    { name: "Finalização de compra", conversions: 4 },
    { name: "Iniciar checkout", conversions: 3 },
    { name: "Tempo no site", conversions: 30 },
  ];
  it("Google: ações pelo nome (lista do MASO), sem acento, arredondadas", () => {
    expect(googleActionTotals("external_page", googleActions)).toEqual({
      // WhatsApp 3 + phone 1 + lead 3 + compra 2 + inscricao 1; never the
      // view/cart/checkout ones ("Finalização de compra" has "compra", but
      // "finali" rules it out); "Tempo no site" is in no list.
      counted: 10,
      view_content: 50,
      add_to_cart: 9,
      initiate_checkout: 7,
    });
    // Make page: only WhatsApp, phone, local and purchase.
    expect(googleActionTotals("make_landing_page", googleActions).counted).toBe(
      6,
    );
  });
  it("Google: por objetivo, com as ligações dos anúncios", () => {
    const metrics = {
      costMicros: "12500000",
      impressions: "1000",
      clicks: "50",
      phoneCalls: "2",
      videoTrueviewViews: "30",
    };
    expect(
      googleTotals("lead", "external_page", { metrics }, googleActions),
    ).toMatchObject({
      spend: 12.5,
      conversions: 12,
      clicks: 50,
      reach: 0,
      view_content: 0,
    });
    expect(
      googleTotals("sale", "external_page", { metrics }, googleActions),
    ).toMatchObject({
      conversions: 12,
      view_content: 50,
      add_to_cart: 9,
      initiate_checkout: 7,
    });
    expect(
      googleTotals("message", "external_page", { metrics }, googleActions)
        .conversions,
    ).toBe(12);
    expect(
      googleTotals("lead", "make_landing_page", { metrics }, googleActions)
        .conversions,
    ).toBe(8);
    expect(
      googleTotals("traffic", "external_page", { metrics }, googleActions)
        .conversions,
    ).toBe(50);
    expect(
      googleTotals("engagement", "external_page", { metrics }, googleActions)
        .conversions,
    ).toBe(1000);
    expect(
      googleTotals("video", "external_page", { metrics }, googleActions)
        .conversions,
    ).toBe(30);
  });
});

describe("POST /api/ads-sync", () => {
  it("agendamento: lê os dias e o acumulado do Meta e grava", async () => {
    let batch = [target()];
    const { fetch, calls } = network([
      [
        /rpc\/ad_sync_targets/,
        () => {
          const now = batch;
          batch = [];
          return json(now);
        },
      ],
      [
        /graph\.facebook\.com\/v23\.0\/act_111\/insights.*time_increment=1/,
        () =>
          json({
            data: [
              {
                date_start: "2026-09-21",
                spend: "30.5",
                impressions: "1000",
                reach: "700",
                inline_link_clicks: "20",
                actions: [
                  {
                    action_type: "onsite_conversion.messaging_first_reply",
                    value: "6",
                  },
                ],
              },
            ],
          }),
      ],
      [
        /graph\.facebook\.com\/v23\.0\/act_111\/insights/,
        () =>
          json({
            data: [{ spend: "30.5", impressions: "1000", reach: "650" }],
          }),
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 1, errors: [] });
    const insights = calls.filter((c) => c.url.includes("insights"));
    expect(insights).toHaveLength(2);
    const daily = new URL(insights[0].url).searchParams;
    expect(JSON.parse(daily.get("time_range")!)).toEqual({
      since: "2026-09-20",
      until: "2026-09-23",
    });
    expect(JSON.parse(daily.get("filtering")!)[0].value).toEqual(["c1"]);
    expect(insights[0].headers.Authorization).toBe("Bearer fb-token");
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect(stored.p_secret).toBe(env.secret);
    expect(stored.p_trigger).toBe("schedule");
    // Every day of the window, zero where nothing was delivered.
    expect(stored.p_days.map((d: { day: string }) => d.day)).toEqual([
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
    ]);
    expect(stored.p_days[1]).toMatchObject({ spend: 30.5, conversions: 6 });
    expect(stored.p_days[0].spend).toBe(0);
    expect(stored.p_snapshot).toMatchObject({
      period_end: "2026-09-23",
      reach: 650,
    });
  });

  it("Google: renova o acesso, usa a MCC e filtra as campanhas", async () => {
    const google = target({
      platform: "google",
      objective: "lead",
      links: [
        {
          account_id: "2223334444",
          campaign_id: "9",
          manager_id: "5550001111",
        },
      ],
      meta_tokens: null,
      google_token: { refresh_token_cipher: seal(key, "refresh-1") },
    });
    let batch = [google];
    const { fetch, calls } = network([
      [
        /rpc\/ad_sync_targets/,
        () => {
          const now = batch;
          batch = [];
          return json(now);
        },
      ],
      [/oauth2\.googleapis\.com\/token/, () => json({ access_token: "acc" })],
      [
        /googleAds:searchStream/,
        (call) => {
          const query: string = JSON.parse(call.body!).query;
          const daily = query.includes("segments.date,");
          const segments = daily ? { date: "2026-09-22" } : {};
          return json([
            {
              results: query.includes("conversion_action_name")
                ? [
                    {
                      segments: {
                        ...segments,
                        conversionActionName: "Lead site",
                      },
                      campaign: { id: "9" },
                      metrics: { conversions: 2 },
                    },
                    {
                      segments: {
                        ...segments,
                        conversionActionName: "Visualização",
                      },
                      campaign: { id: "9" },
                      metrics: { conversions: 40 },
                    },
                  ]
                : [
                    {
                      segments,
                      campaign: { id: "9" },
                      metrics: { costMicros: "5000000", phoneCalls: "1" },
                    },
                  ],
            },
          ]);
        },
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    const search = calls.filter((c) => c.url.includes("searchStream"));
    expect(search[0].url).toContain("customers/2223334444/");
    expect(search[0].headers["login-customer-id"]).toBe("5550001111");
    expect(search[0].headers.Authorization).toBe("Bearer acc");
    expect(JSON.parse(search[0].body!).query).toContain("campaign.id IN (9)");
    // v22+ name (metrics.video_views is rejected by v25), in the metrics queries.
    const queries = search.map((c) => JSON.parse(c.body!).query as string);
    for (const q of queries.filter(
      (q) => !q.includes("conversion_action_name"),
    )) {
      expect(q).toContain("metrics.video_trueview_views");
      expect(q).toContain("metrics.phone_calls");
    }
    for (const q of queries) expect(q).not.toContain("metrics.video_views");
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect(
      stored.p_days.find((d: { day: string }) => d.day === "2026-09-22"),
    ).toMatchObject({ spend: 5, conversions: 3 });
    expect(stored.p_snapshot).toMatchObject({ spend: 5, conversions: 3 });
    // Four queries: metrics and conversion actions, per day and for the cycle.
    expect(search).toHaveLength(4);
  });

  it("página de captura da Make: os cadastros vêm do servidor da Make", async () => {
    const make = target({
      objective: "lead",
      destination: "make_landing_page",
      landing_pages: ["12345", "12346"],
    });
    let batch = [make];
    const { fetch, calls } = network([
      [
        /rpc\/ad_sync_targets/,
        () => {
          const now = batch;
          batch = [];
          return json(now);
        },
      ],
      [
        /act_111\/insights.*time_increment=1/,
        () =>
          json({
            data: [
              {
                date_start: "2026-09-21",
                spend: "20",
                actions: [
                  {
                    action_type: "offsite_conversion.fb_pixel_lead",
                    value: "9",
                  },
                ],
              },
            ],
          }),
      ],
      [/act_111\/insights/, () => json({ data: [{ spend: "20" }] })],
      [
        /POST https:\/\/make\.example\.com/,
        () => json({ days: { "2026-09-21": 3, "2026-09-22": 1 }, total: 4 }),
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 1, errors: [] });
    const leads = calls.find((c) => c.url.includes("make.example.com"))!;
    expect(leads.headers["X-Mavi-Secret"]).toBe(env.makeLeadsSecret);
    expect(JSON.parse(leads.body!)).toEqual({
      squeezes: ["12345", "12346"],
      since: "2026-09-20",
      until: "2026-09-23",
    });
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    const day = (d: string) =>
      stored.p_days.find((x: { day: string }) => x.day === d);
    // The pixel's leads don't count: the page's do, even on a day without spend.
    expect(day("2026-09-21")).toMatchObject({ spend: 20, conversions: 3 });
    expect(day("2026-09-22")).toMatchObject({ spend: 0, conversions: 1 });
    expect(stored.p_snapshot.conversions).toBe(4);
  });

  it("página de captura da Make sem a leitura configurada: erro, sem números", async () => {
    let batch = [
      target({
        objective: "lead",
        destination: "make_landing_page",
        landing_pages: ["1"],
      }),
    ];
    const { fetch, calls } = network([
      [
        /rpc\/ad_sync_targets/,
        () => {
          const now = batch;
          batch = [];
          return json(now);
        },
      ],
      [/act_111\/insights/, () => json({ data: [] })],
      [/rpc\/ad_sync_store/, () => json(0)],
    ]);
    const result = await handleAdsSync(
      {},
      `Bearer ${env.secret}`,
      { ...env, makeLeadsSecret: "" },
      fetch,
    );
    expect(
      String((result.body.errors as { message: string }[])[0].message),
    ).toContain("MAKE_LEADS_SECRET");
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect(stored.p_status).toBe("error");
  });

  it("erro da plataforma vira registro de erro, sem números", async () => {
    let batch = [
      target({
        meta_tokens: {
          "111": {
            token_cipher: seal(key, "x"),
            expires_at: "2020-01-01T00:00:00Z",
          },
        },
      }),
    ];
    const { fetch, calls } = network([
      [
        /rpc\/ad_sync_targets/,
        () => {
          const now = batch;
          batch = [];
          return json(now);
        },
      ],
      [/rpc\/ad_sync_store/, () => json(0)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body.errors).toEqual([
      {
        cycle: "cy-1",
        message: "O acesso ao Facebook da conta 111 expirou. Conecte de novo.",
      },
    ]);
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect([stored.p_status, stored.p_days, stored.p_snapshot]).toEqual([
      "error",
      [],
      null,
    ]);
  });

  it("botão do administrador: exige a campanha e usa a sessão", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect((await handleAdsSync({}, null, env, f)).status).toBe(401);
    expect(
      (await handleAdsSync({}, "Bearer user-jwt", env, f)).body.error,
    ).toBe("Informe a campanha.");
    const { fetch, calls } = network([
      [/rpc\/ad_sync_targets/, () => json([])],
    ]);
    await handleAdsSync(
      { campaign: "00000000-0000-4000-8000-000000000001" },
      "Bearer user-jwt",
      env,
      fetch,
    );
    expect(calls[0].headers.Authorization).toBe("Bearer user-jwt");
    expect(JSON.parse(calls[0].body!)).toMatchObject({
      p_secret: null,
      p_campaign: "00000000-0000-4000-8000-000000000001",
    });
  });
});

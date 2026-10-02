import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BACKFILL_LIMIT,
  coverage,
  gate,
  googleTotals,
  handleAdsSync,
  leadsUpTo,
  mapLimit,
  metaResults,
  missingSnapshots,
  sharedLinks,
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
function network(
  routes: [RegExp, (call: Call) => Response | Promise<Response>][],
) {
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

describe("várias leituras ao mesmo tempo", () => {
  it("no máximo o limite por vez, resultados na ordem", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5, 15], 2, async (ms) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40, 10, 30]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async (x) => x)).toEqual([]);
  });
});

describe("Make: poucas leituras por vez e acumulados de uma chamada", () => {
  it("gate: no máximo o limite rodando, os outros esperam", async () => {
    const run = gate(2);
    let running = 0;
    let peak = 0;
    const out = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        run(async () => {
          peak = Math.max(peak, ++running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
          return n;
        }),
      ),
    );
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });
  it("leads distintos até um dia: a soma dos que apareceram até ele", () => {
    const firsts = new Map([
      ["2026-09-21", 3],
      ["2026-09-22", 2],
      ["2026-09-24", 1],
    ]);
    expect(leadsUpTo(firsts, "2026-09-20")).toBe(0);
    expect(leadsUpTo(firsts, "2026-09-22")).toBe(5);
    expect(leadsUpTo(firsts, "2026-09-30")).toBe(6);
  });
});

describe("acumulados que faltam (histórico diário)", () => {
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (
      let d = new Date(`${from}T12:00:00Z`);
      ;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const day = d.toISOString().slice(0, 10);
      if (day > to) return out;
      out.push(day);
    }
  };
  const cycle = { start_date: "2026-08-31", end_date: "2026-09-30" };
  it("os dias sem registro antes de hoje, cada um até o dia anterior", () => {
    const t = target({
      ...cycle,
      today: "2026-09-28",
      snapshot_days: days("2026-09-01", "2026-09-24"),
    });
    // Taken on 27, 26 and 25/09: the numbers up to 26, 25 and 24/09.
    expect(missingSnapshots(t)).toEqual([
      "2026-09-26",
      "2026-09-25",
      "2026-09-24",
    ]);
  });
  it("depois do fim, só até o dia seguinte ao fim do ciclo", () => {
    const t = target({
      ...cycle,
      today: "2026-10-05",
      snapshot_days: days("2026-09-01", "2026-09-30"),
    });
    expect(missingSnapshots(t)).toEqual(["2026-09-30"]);
  });
  it("no máximo alguns por vez, os mais recentes primeiro", () => {
    const t = target({ ...cycle, today: "2026-09-28", snapshot_days: [] });
    const ends = missingSnapshots(t);
    expect(ends).toHaveLength(BACKFILL_LIMIT);
    expect(ends[0]).toBe("2026-09-26");
  });
  it("sem a lista de dias do banco, nada", () => {
    expect(missingSnapshots(target({ ...cycle, today: "2026-09-28" }))).toEqual(
      [],
    );
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
    {
      id: "1",
      name: "Clique no WhatsApp",
      category: "CONTACT",
      conversions: 3.4,
    },
    {
      id: "2",
      name: "Formulário site",
      category: "SUBMIT_LEAD_FORM",
      conversions: 2.6,
    },
    {
      id: "3",
      name: "Ligação do site",
      category: "PHONE_CALL_LEAD",
      conversions: 1,
    },
    { id: "4", name: "Compra", category: "PURCHASE", conversions: 2 },
    { id: "5", name: "Tempo no site", category: "DEFAULT", conversions: 30 },
    { id: "6", name: "Página vista", category: "PAGE_VIEW", conversions: 50 },
    { id: "7", name: "Carrinho", category: "ADD_TO_CART", conversions: 9 },
    { id: "8", name: "Checkout", category: "BEGIN_CHECKOUT", conversions: 4 },
  ];
  const metrics = {
    costMicros: "12500000",
    impressions: "1000",
    clicks: "50",
    phoneCalls: "2",
    videoTrueviewViews: "30",
  };
  const g = (
    objective: SyncTarget["objective"],
    destination: SyncTarget["destination"] = "external_page",
    conversion_actions: string[] | null = null,
  ) =>
    googleTotals(
      { objective, destination, conversion_actions },
      { metrics },
      googleActions,
    );
  it("Google, sem escolha: as categorias do objetivo", () => {
    // Lead: WhatsApp 3 + form 3 + call 1 + "Compra" 2 (in the MASO's names);
    // not "Tempo no site" ("Outro"), views, cart.
    expect(g("lead")).toMatchObject({
      spend: 12.5,
      conversions: 9,
      clicks: 50,
      reach: 0,
    });
    expect(g("message").conversions).toBe(9);
    // Sale: purchases, and the funnel by category.
    expect(g("sale")).toMatchObject({
      conversions: 2,
      view_content: 50,
      add_to_cart: 9,
      initiate_checkout: 4,
    });
    // Make page: contact, call, purchase (the form's leads come from the Make).
    expect(g("lead", "make_landing_page").conversions).toBe(6);
    expect(g("traffic").conversions).toBe(50);
    expect(g("engagement").conversions).toBe(1000);
    expect(g("video").conversions).toBe(30);
  });
  it("Google, com a escolha do ciclo: só as ações marcadas (e as ligações, se marcadas)", () => {
    expect(g("lead", "external_page", ["2"]).conversions).toBe(3);
    expect(g("lead", "external_page", ["2", "5"]).conversions).toBe(33);
    expect(g("lead", "external_page", ["2", "phone_calls"]).conversions).toBe(
      5,
    );
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
                        conversionAction:
                          "customers/2223334444/conversionActions/11",
                        conversionActionName: "Lead site",
                        conversionActionCategory: "SUBMIT_LEAD_FORM",
                      },
                      campaign: { id: "9" },
                      metrics: { conversions: 2 },
                    },
                    {
                      segments: {
                        ...segments,
                        conversionAction:
                          "customers/2223334444/conversionActions/12",
                        conversionActionName: "Visualização",
                        conversionActionCategory: "PAGE_VIEW",
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
    ).toMatchObject({ spend: 5, conversions: 2 });
    expect(stored.p_snapshot).toMatchObject({ spend: 5, conversions: 2 });
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

  it("preenche os acumulados que faltam, lidos da plataforma e da Make", async () => {
    const make = target({
      objective: "lead",
      destination: "make_landing_page",
      landing_pages: ["81895b88"],
      // Up to yesterday (23/09); 22/09 and 21/09 were never taken.
      snapshot_days: ["2026-09-21"],
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
      [/act_111\/insights.*time_increment=1/, () => json({ data: [] })],
      [
        /act_111\/insights/,
        (call) => {
          const until = JSON.parse(
            new URL(call.url).searchParams.get("time_range")!,
          ).until;
          return json({ data: [{ spend: until.slice(-2), reach: "10" }] });
        },
      ],
      [
        /POST https:\/\/make\.example\.com/,
        (call) =>
          json({
            days: {},
            total: Number(JSON.parse(call.body!).until.slice(-2)) * 2,
          }),
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 1, errors: [] });
    const periods = calls
      .filter(
        (c) => c.url.includes("insights") && !c.url.includes("time_increment"),
      )
      .map((c) => JSON.parse(new URL(c.url).searchParams.get("time_range")!));
    expect(periods).toEqual([
      { since: "2026-09-20", until: "2026-09-23" },
      { since: "2026-09-20", until: "2026-09-22" },
      { since: "2026-09-20", until: "2026-09-21" },
    ]);
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect(stored.p_snapshot).toMatchObject({
      period_end: "2026-09-23",
      spend: 23,
      conversions: 46,
    });
    expect(stored.p_backfill).toEqual([
      expect.objectContaining({
        period_end: "2026-09-22",
        spend: 22,
        conversions: 44,
      }),
      expect.objectContaining({
        period_end: "2026-09-21",
        spend: 21,
        conversions: 42,
      }),
    ]);
  });

  it("agendamento: vários ciclos ao mesmo tempo, todos do lote", async () => {
    let batch = Array.from({ length: 7 }, (_, i) =>
      target({ cycle_id: `cy-${i}` }),
    );
    let running = 0;
    let peak = 0;
    const { fetch } = network([
      [
        /rpc\/ad_sync_targets/,
        () => {
          const now = batch;
          batch = [];
          return json(now);
        },
      ],
      [
        /act_111\/insights/,
        async () => {
          peak = Math.max(peak, ++running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
          return json({ data: [] });
        },
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 7, errors: [] });
    expect(peak).toBeGreaterThan(1);
  });

  it("Make com os primeiros dias: uma chamada só para todos os acumulados", async () => {
    let batch = [
      target({
        objective: "lead",
        destination: "make_landing_page",
        landing_pages: ["81895b88"],
        snapshot_days: ["2026-09-21"],
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
      [
        /POST https:\/\/make\.example\.com/,
        () =>
          json({
            days: {},
            total: 9,
            firsts: { "2026-09-20": 4, "2026-09-22": 3, "2026-09-23": 2 },
          }),
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(
      calls.filter((c) => c.url.includes("make.example.com")),
    ).toHaveLength(1);
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect(stored.p_snapshot.conversions).toBe(9);
    expect(
      stored.p_backfill.map(
        (b: { period_end: string; conversions: number }) => [
          b.period_end,
          b.conversions,
        ],
      ),
    ).toEqual([
      ["2026-09-22", 7],
      ["2026-09-21", 4],
    ]);
  });

  it("sem acumulado faltando, não manda p_backfill (bancos antigos)", async () => {
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
      [/act_111\/insights/, () => json({ data: [] })],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect(stored).not.toHaveProperty("p_backfill");
  });

  it("página de captura da Make com os leads no MAVI: conta aqui, sem chamar a Make", async () => {
    let batch = [
      target({
        objective: "lead",
        destination: "make_landing_page",
        landing_pages: ["81895b88", " 81895b88 "],
        snapshot_days: ["2026-09-21"],
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
      [
        /rpc\/make_leads_count/,
        () =>
          json({
            days: { "2026-09-20": 4, "2026-09-22": 3, "2026-09-23": 2 },
            total: 9,
            firsts: { "2026-09-20": 4, "2026-09-22": 3, "2026-09-23": 2 },
          }),
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    // Without the Make's secret too: it isn't asked.
    const result = await handleAdsSync(
      {},
      `Bearer ${env.secret}`,
      { ...env, makeLeadsSecret: "" },
      fetch,
    );
    expect(result.body).toEqual({ synced: 1, errors: [] });
    expect(calls.some((c) => c.url.includes("make.example.com"))).toBe(false);
    const count = calls.find((c) => c.url.includes("make_leads_count"))!;
    expect(JSON.parse(count.body!)).toEqual({
      p_secret: env.secret,
      p_squeezes: ["81895b88"],
      p_since: "2026-09-20",
      p_until: "2026-09-23",
    });
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    const day = (d: string) =>
      stored.p_days.find((x: { day: string }) => x.day === d);
    expect(day("2026-09-22")).toMatchObject({ conversions: 3 });
    expect(stored.p_snapshot.conversions).toBe(9);
    expect(
      stored.p_backfill.map(
        (b: { period_end: string; conversions: number }) => [
          b.period_end,
          b.conversions,
        ],
      ),
    ).toEqual([
      ["2026-09-22", 7],
      ["2026-09-21", 4],
    ]);
  });

  it("leads no MAVI ainda sem cobrir o período: pergunta à Make, como antes", async () => {
    let batch = [
      target({
        objective: "lead",
        destination: "make_landing_page",
        landing_pages: ["81895b88"],
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
      [/rpc\/make_leads_count/, () => json(null)],
      [
        /POST https:\/\/make\.example\.com/,
        () => json({ days: { "2026-09-21": 2 }, total: 2 }),
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 1, errors: [] });
    expect(
      calls.filter((c) => c.url.includes("make.example.com")),
    ).toHaveLength(1);
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect(stored.p_snapshot.conversions).toBe(2);
  });

  it("Make fora do ar com os leads no MAVI incompletos: o erro diz por quê", async () => {
    let batch = [
      target({
        objective: "lead",
        destination: "make_landing_page",
        landing_pages: ["81895b88"],
      }),
    ];
    const { fetch } = network([
      [
        /rpc\/ad_sync_targets/,
        () => {
          const now = batch;
          batch = [];
          return json(now);
        },
      ],
      [/act_111\/insights/, () => json({ data: [] })],
      [/rpc\/make_leads_count/, () => json(null)],
      [
        /rpc\/make_leads_status/,
        () => json({ cursor: 1200000, caught_up_at: null, seen_at: null }),
      ],
      [
        /POST https:\/\/make\.example\.com/,
        () => {
          throw new Error("The operation was aborted due to timeout");
        },
      ],
      [/rpc\/ad_sync_store/, () => json(0)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    const message = String(
      (result.body.errors as { message: string }[])[0].message,
    );
    expect(message).toContain("Make: The operation was aborted due to timeout.");
    expect(message).toContain("ainda está mandando o histórico (até o id 1200000)");
  });

  it("por que os leads no MAVI não cobrem o período", () => {
    expect(
      coverage({ cursor: 5, caught_up_at: "2026-09-30T02:59:00Z" }, "2026-09-29"),
    ).toBe(
      "o envio da Make chegou ao fim da tabela pela última vez em 29/09/2026, 23:59, antes do fim de 29/09/2026",
    );
    expect(coverage(null, "2026-09-29")).toContain("depois de 29/09/2026");
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
      // The estimate says expired; Facebook is what refuses it.
      [
        /graph\.facebook\.com/,
        () =>
          json({ error: { code: 190, message: "Session has expired" } }, 400),
      ],
      [/rpc\/ad_sync_store/, () => json(0)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body.errors).toEqual([
      {
        cycle: "cy-1",
        message:
          "Conta 111: O acesso ao Facebook desta conta expirou. Conecte o Facebook de novo. (Facebook: Session has expired)",
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

  it("validade estimada vencida não impede: o Facebook aceitou o token", async () => {
    let batch = [
      target({
        meta_tokens: {
          "111": {
            token_cipher: seal(key, "fb-token"),
            expires_at: "2020-01-01T00:00:00Z",
          },
        },
      }),
    ];
    const { fetch } = network([
      [
        /rpc\/ad_sync_targets/,
        () => {
          const now = batch;
          batch = [];
          return json(now);
        },
      ],
      [/act_111\/insights/, () => json({ data: [] })],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 1, errors: [] });
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

describe("dia de virada (ciclo que começa no dia em que o anterior termina)", () => {
  const links = (...ids: string[]) =>
    ids.map((id) => ({ account_id: "111", campaign_id: id, manager_id: "" }));
  it("o que os dois ciclos contam, conta a conta", () => {
    // Campanhas marcadas nos dois: só as em comum.
    expect(sharedLinks("meta", links("c1", "c2"), links("c2", "c3"))).toEqual(
      links("c2"),
    );
    // Nenhuma em comum: nada a tirar.
    expect(sharedLinks("meta", links("c1"), links("c3"))).toEqual([]);
    // Um com a conta inteira: as campanhas do outro.
    expect(sharedLinks("meta", links(""), links("c2"))).toEqual(links("c2"));
    expect(sharedLinks("meta", links("c1"), links(""))).toEqual(links("c1"));
    expect(sharedLinks("meta", links(""), links(""))).toEqual(links(""));
    // Outra conta não divide nada; "act_" é a mesma conta.
    expect(
      sharedLinks("meta", links("c1"), [{ account_id: "222", campaign_id: "c1" }]),
    ).toEqual([]);
    expect(
      sharedLinks("meta", links("c1"), [{ account_id: "act_111", campaign_id: "c1" }]),
    ).toEqual(links("c1"));
  });

  it("Meta: o ciclo que termina deixa de contar, no dia, as campanhas que estão no novo", async () => {
    let batch = [
      target({
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        today: "2026-10-02",
        links: links("c1", "c2"),
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
      [
        /rpc\/ad_sync_shared_days/,
        () =>
          json([
            { day: "2026-09-30", links: links("c2", "c3"), landing_pages: [] },
          ]),
      ],
      [
        /act_111\/insights/,
        (call) => {
          const q = new URL(call.url).searchParams;
          const range = JSON.parse(q.get("time_range")!);
          const ids = JSON.parse(q.get("filtering")!)[0].value;
          // A leitura só do dia de virada, só das campanhas em comum.
          if (range.since === "2026-09-30") {
            expect(ids).toEqual(["c2"]);
            return json({
              data: [{ date_start: "2026-09-30", spend: "40", impressions: "400" }],
            });
          }
          if (q.get("time_increment"))
            return json({
              data: [
                { date_start: "2026-09-29", spend: "100", impressions: "1000" },
                { date_start: "2026-09-30", spend: "100", impressions: "1000" },
              ],
            });
          return json({ data: [{ spend: "200", impressions: "2000" }] });
        },
      ],
      [/rpc\/ad_sync_store/, () => json(30)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 1, errors: [] });
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    const day = (d: string) =>
      stored.p_days.find((x: { day: string }) => x.day === d);
    expect(day("2026-09-29")).toMatchObject({ spend: 100, impressions: 1000 });
    expect(day("2026-09-30")).toMatchObject({ spend: 60, impressions: 600 });
    expect(stored.p_snapshot).toMatchObject({ spend: 160, impressions: 1600 });
  });

  it("sem dia de virada (ou sem a migração), sincroniza como antes", async () => {
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
      [/rpc\/ad_sync_shared_days/, () => json({ message: "not found" }, 404)],
      [/act_111\/insights/, () => json({ data: [] })],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 1, errors: [] });
    expect(calls.filter((c) => c.url.includes("insights"))).toHaveLength(2);
  });

  it("página da Make: tira do dia os cadastros das páginas que os dois contam", async () => {
    let batch = [
      target({
        objective: "lead",
        destination: "make_landing_page",
        landing_pages: ["sq1", "sq2"],
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        today: "2026-10-02",
      }),
    ];
    const counts: string[] = [];
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
        /rpc\/ad_sync_shared_days/,
        () =>
          json([{ day: "2026-09-30", links: links("c9"), landing_pages: ["sq2", "sq3"] }]),
      ],
      [/act_111\/insights/, () => json({ data: [] })],
      [
        /rpc\/make_leads_count/,
        (call) => {
          const body = JSON.parse(call.body!);
          counts.push(body.p_squeezes.join(","));
          return body.p_since === "2026-09-30"
            ? json({ days: { "2026-09-30": 2 }, total: 2, firsts: { "2026-09-30": 2 } })
            : json({
                days: { "2026-09-29": 3, "2026-09-30": 5 },
                total: 8,
                firsts: { "2026-09-29": 3, "2026-09-30": 5 },
              });
        },
      ],
      [/rpc\/ad_sync_store/, () => json(30)],
    ]);
    const result = await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    expect(result.body).toEqual({ synced: 1, errors: [] });
    expect(counts).toEqual(["sq1,sq2", "sq2"]);
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    const day = (d: string) =>
      stored.p_days.find((x: { day: string }) => x.day === d);
    expect(day("2026-09-30")).toMatchObject({ conversions: 3 });
    expect(stored.p_snapshot.conversions).toBe(6);
  });
});

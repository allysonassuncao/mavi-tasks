import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  googleTotals,
  handleAdsSync,
  metaResults,
  syncWindow,
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
  it("o ciclo inteiro na primeira vez; depois os últimos 7 dias; até ontem", () => {
    expect(syncWindow(target())).toEqual({
      since: "2026-09-20",
      until: "2026-09-23",
    });
    expect(
      syncWindow(target({ start_date: "2026-09-01", last_day: "2026-09-22" })),
    ).toEqual({ since: "2026-09-17", until: "2026-09-23" });
    // Ended cycles stop at their end; cycles starting today have nothing.
    expect(
      syncWindow(
        target({
          start_date: "2026-08-20",
          end_date: "2026-09-19",
          last_day: "2026-09-18",
        }),
      ),
    ).toEqual({ since: "2026-09-17", until: "2026-09-19" });
    expect(syncWindow(target({ start_date: "2026-09-24" }))).toBeNull();
  });
});

describe("o que conta como resultado", () => {
  const actions = [
    {
      action_type: "onsite_conversion.messaging_conversation_started_7d",
      value: "12",
    },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "5" },
    { action_type: "lead", value: "9" },
    { action_type: "onsite_conversion.lead_grouped", value: "4" },
    { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" },
    { action_type: "purchase", value: "3" },
    { action_type: "landing_page_view", value: "40" },
    { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: "7" },
    { action_type: "offsite_conversion.fb_pixel_custom", value: "2" },
    {
      action_type: "offsite_conversion.fb_pixel_complete_registration",
      value: "1",
    },
    { action_type: "post_engagement", value: "300" },
  ];
  const row = { actions, inline_link_clicks: "80" };
  it("Meta: pelo objetivo e pelo destino (regra do MASO)", () => {
    expect(metaResults("message", "external_page", row).conversions).toBe(12);
    expect(metaResults("lead", "external_page", row).conversions).toBe(5);
    expect(metaResults("lead", "lead_form", row).conversions).toBe(4);
    expect(metaResults("traffic", "external_page", row).conversions).toBe(80);
    expect(metaResults("engagement", "external_page", row).conversions).toBe(
      300,
    );
    expect(metaResults("custom", "external_page", row).conversions).toBe(3);
    expect(metaResults("sale", "external_page", row)).toEqual({
      conversions: 3,
      view_content: 40,
      add_to_cart: 7,
      initiate_checkout: 0,
    });
    // The funnel only for sales and custom conversions.
    expect(metaResults("lead", "external_page", row).view_content).toBe(0);
  });
  it("Google: conversões; tráfego = cliques; engajamento = impressões", () => {
    const metrics = {
      costMicros: "12500000",
      impressions: "1000",
      clicks: "50",
      conversions: 4.5,
      videoViews: "30",
    };
    expect(googleTotals("lead", { metrics })).toMatchObject({
      spend: 12.5,
      conversions: 4.5,
      clicks: 50,
      reach: 0,
    });
    expect(googleTotals("traffic", { metrics }).conversions).toBe(50);
    expect(googleTotals("engagement", { metrics }).conversions).toBe(1000);
    expect(googleTotals("video", { metrics }).conversions).toBe(30);
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
                    action_type:
                      "onsite_conversion.messaging_conversation_started_7d",
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
        (call) =>
          json([
            {
              results: JSON.parse(call.body!).query.includes("segments.date,")
                ? [
                    {
                      segments: { date: "2026-09-22" },
                      metrics: { costMicros: "5000000", conversions: 2 },
                    },
                  ]
                : [{ metrics: { costMicros: "5000000", conversions: 2 } }],
            },
          ]),
      ],
      [/rpc\/ad_sync_store/, () => json(4)],
    ]);
    await handleAdsSync({}, `Bearer ${env.secret}`, env, fetch);
    const search = calls.filter((c) => c.url.includes("searchStream"));
    expect(search[0].url).toContain("customers/2223334444/");
    expect(search[0].headers["login-customer-id"]).toBe("5550001111");
    expect(search[0].headers.Authorization).toBe("Bearer acc");
    expect(JSON.parse(search[0].body!).query).toContain("campaign.id IN (9)");
    const stored = JSON.parse(
      calls.find((c) => c.url.includes("ad_sync_store"))!.body!,
    );
    expect(
      stored.p_days.find((d: { day: string }) => d.day === "2026-09-22"),
    ).toMatchObject({ spend: 5, conversions: 2 });
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

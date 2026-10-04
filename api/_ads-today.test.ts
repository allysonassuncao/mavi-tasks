import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  groupByAccount,
  handleAdsToday,
  ownCampaigns,
  readToday,
  type TodayTarget,
} from "./_ads-today";
import type { SyncEnv } from "./_ads-sync";
import { seal } from "./_google";

const key = crypto.randomBytes(32);
const env: SyncEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  tokenKey: key,
  redirectUri: "https://workspace.example.com/api/ads-callback",
  meta: { appId: "app-1", appSecret: "app-secret", version: "v23.0" },
  google: { clientId: "client-id", clientSecret: "client-secret", developerToken: "dev-token", version: "v25" },
  secret: "s".repeat(40),
  makeLeadsUrl: "https://make.example.com/api/capture/mavi-leads.php",
  makeLeadsSecret: "m".repeat(40),
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
type Call = { url: string; method: string; body?: string };
function network(routes: [RegExp, (call: Call) => Response | Promise<Response>][]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const call: Call = { url, method: init.method ?? "GET", body: init.body?.toString() };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw Error(`Rota inesperada: ${call.method} ${url}`);
    return route[1](call);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}
const metaToken = { token_cipher: seal(key, "meta-token"), expires_at: null };
const target = (extra: Partial<TodayTarget> = {}): TodayTarget => ({
  cycle_id: "cy-1",
  company_id: "co-1",
  campaign_id: "ca-1",
  platform: "meta",
  objective: "lead",
  destination: "lead_form",
  conversion_actions: null,
  meta_conversions: null,
  today: "2026-10-04",
  links: [{ account_id: "act_111", campaign_id: "c1", manager_id: "" }],
  meta_tokens: { "111": metaToken },
  google_token: null,
  ...extra,
});
const lead = (n: number) => [{ action_type: "leadgen_grouped", value: String(n) }];

describe("leitor do hoje: contas", () => {
  it("junta os ciclos por conta e sabe quando a conta toda conta", () => {
    const a = target();
    const b = target({ cycle_id: "cy-2", campaign_id: "ca-2", links: [{ account_id: "111", campaign_id: "c2", manager_id: "" }] });
    const c = target({ cycle_id: "cy-3", campaign_id: "ca-3", links: [{ account_id: "222", campaign_id: "", manager_id: "" }] });
    const groups = groupByAccount([a, b, c]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ account: "111", whole: false, campaigns: ["c1", "c2"] });
    expect(groups[0].targets).toEqual([a, b]);
    expect(groups[1]).toMatchObject({ account: "222", whole: true });
    expect(ownCampaigns(c, groups[1])).toBeNull();
    expect([...ownCampaigns(a, groups[0])!]).toEqual(["c1"]);
  });

  it("Meta: uma chamada por conta, cada ciclo soma as suas campanhas com a regra dele", async () => {
    const net = network([
      [
        /graph\.facebook\.com\/v23\.0\/act_111\/insights/,
        () =>
          json({
            data: [
              { campaign_id: "c1", spend: "40.5", impressions: "1000", inline_link_clicks: "30", actions: lead(3) },
              { campaign_id: "c2", spend: "10", impressions: "200", inline_link_clicks: "5", actions: [{ action_type: "onsite_conversion.messaging_first_reply", value: "2" }] },
            ],
          }),
      ],
    ]);
    const a = target();
    const b = target({
      cycle_id: "cy-2",
      campaign_id: "ca-2",
      objective: "message",
      destination: "external_page",
      links: [{ account_id: "111", campaign_id: "c2", manager_id: "" }],
    });
    const r = await readToday(env, net.fetch, [a, b]);
    expect(net.calls).toHaveLength(1);
    const q = new URL(net.calls[0].url).searchParams;
    expect(q.get("level")).toBe("campaign");
    expect(JSON.parse(q.get("time_range")!)).toEqual({ since: "2026-10-04", until: "2026-10-04" });
    expect(JSON.parse(q.get("filtering")!)[0].value).toEqual(["c1", "c2"]);
    expect(r.rows).toEqual([
      { cycle_id: "cy-1", day: "2026-10-04", spend: 40.5, conversions: 3, clicks: 30, impressions: 1000 },
      { cycle_id: "cy-2", day: "2026-10-04", spend: 10, conversions: 2, clicks: 5, impressions: 200 },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("Meta: as conversões que contam escolhidas no ciclo valem para hoje", async () => {
    const net = network([
      [
        /act_111\/insights/,
        () => json({ data: [{ campaign_id: "c1", spend: "5", actions: [...lead(1), { action_type: "offsite_conversion.fb_pixel_lead", value: "4" }] }] }),
      ],
    ]);
    const r = await readToday(env, net.fetch, [
      target({ meta_conversions: [{ from: "2026-09-01", actions: ["offsite_conversion.fb_pixel_lead"] }] }),
    ]);
    expect(r.rows[0].conversions).toBe(4);
  });

  it("Google: duas consultas por conta, métricas e ações de conversão por campanha", async () => {
    const net = network([
      [/oauth2\.googleapis\.com\/token/, () => json({ access_token: "g-access" })],
      [
        /googleads\.googleapis\.com\/v25\/customers\/333\/googleAds:searchStream/,
        (call) => {
          const { query } = JSON.parse(call.body!);
          expect(query).toContain("segments.date BETWEEN '2026-10-04' AND '2026-10-04'");
          expect(query).toContain("campaign.id IN (9001)");
          return query.includes("conversion_action")
            ? json([
                {
                  results: [
                    {
                      campaign: { id: "9001" },
                      segments: { conversionAction: "customers/333/conversionActions/77", conversionActionName: "Lead", conversionActionCategory: "SUBMIT_LEAD_FORM" },
                      metrics: { conversions: 6 },
                    },
                  ],
                },
              ])
            : json([{ results: [{ campaign: { id: "9001" }, metrics: { costMicros: "25500000", impressions: "900", clicks: "40" } }] }]);
        },
      ],
    ]);
    const r = await readToday(env, net.fetch, [
      target({
        platform: "google",
        objective: "lead",
        destination: "external_page",
        links: [{ account_id: "333", campaign_id: "9001", manager_id: "444" }],
        meta_tokens: null,
        google_token: { refresh_token_cipher: seal(key, "refresh") },
      }),
    ]);
    expect(net.calls.filter((c) => c.url.includes("googleads"))).toHaveLength(2);
    expect(r.rows).toEqual([{ cycle_id: "cy-1", day: "2026-10-04", spend: 25.5, conversions: 6, clicks: 40, impressions: 900 }]);
  });

  it("limite do Meta: o ciclo fica com o erro e a conta é pausada", async () => {
    const net = network([
      [/act_111\/insights/, () => json({ error: { code: 17, message: "User request limit reached" } }, 400)],
    ]);
    const r = await readToday(env, net.fetch, [target()], { now: () => Date.parse("2026-10-04T15:00:00Z") });
    expect(r.rows).toEqual([]);
    expect(r.errors[0].error).toMatch(/limite de requisições/);
    expect(r.cooldowns).toEqual([
      { platform: "meta", account: "111", until: "2026-10-04T16:00:00.000Z", reason: "Meta: limite de requisições (código 17)" },
    ]);
  });

  it("consumo alto da cota: lê e deixa a conta descansar", async () => {
    const net = network([
      [
        /act_111\/insights/,
        () => json({ data: [] }, 200, { "x-business-use-case-usage": JSON.stringify({ "111": [{ call_count: 82, estimated_time_to_regain_access: 0 }] }) }),
      ],
    ]);
    const r = await readToday(env, net.fetch, [target()], { now: () => Date.parse("2026-10-04T15:00:00Z") });
    expect(r.rows[0]).toMatchObject({ spend: 0, conversions: 0 });
    expect(r.cooldowns[0]).toMatchObject({ account: "111", until: "2026-10-04T15:15:00.000Z" });
  });

  it("ciclo com duas contas: só grava quando as duas foram lidas", async () => {
    const net = network([
      [/act_111\/insights/, () => json({ data: [{ campaign_id: "c1", spend: "10", actions: lead(1) }] })],
      [/act_222\/insights/, () => json({ error: { code: 190, message: "Token expirado" } }, 400)],
    ]);
    const r = await readToday(env, net.fetch, [
      target({
        links: [
          { account_id: "111", campaign_id: "c1", manager_id: "" },
          { account_id: "222", campaign_id: "c9", manager_id: "" },
        ],
        meta_tokens: { "111": metaToken, "222": metaToken },
      }),
    ]);
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it("depois do orçamento de tempo, as contas que faltam ficam para a próxima", async () => {
    let t = 0;
    const net = network([[/insights/, () => json({ data: [] })]]);
    const targets = [1, 2, 3, 4, 5, 6].map((i) =>
      target({ cycle_id: `cy-${i}`, links: [{ account_id: String(100 + i), campaign_id: "c", manager_id: "" }], meta_tokens: { [String(100 + i)]: metaToken } }),
    );
    const r = await readToday(env, net.fetch, targets, { budgetMs: 10, now: () => (t += 6) });
    expect(r.rows.length).toBeLessThan(6);
    expect(r.errors).toEqual([]);
  });
});

describe("POST /api/ads-sync {today}", () => {
  it("só com o segredo do agendamento", async () => {
    const r = await handleAdsToday("Bearer outro", env, vi.fn() as unknown as typeof fetch);
    expect(r.status).toBe(401);
  });

  it("lê os alvos, lê as contas e grava com as pausas", async () => {
    const net = network([
      [/rpc\/ad_today_targets/, () => json([target()])],
      [/act_111\/insights/, () => json({ data: [{ campaign_id: "c1", spend: "12", actions: lead(2) }] })],
      [/rpc\/ad_today_store/, () => json(1)],
    ]);
    const r = await handleAdsToday(`Bearer ${env.secret}`, env, net.fetch);
    expect(r).toEqual({ status: 200, body: { read: 1, errors: 0, accounts: 1 } });
    const stored = JSON.parse(net.calls.find((c) => c.url.includes("ad_today_store"))!.body!);
    expect(stored.p_rows).toEqual([{ cycle_id: "cy-1", day: "2026-10-04", spend: 12, conversions: 2, clicks: 0, impressions: 0 }]);
    expect(stored.p_cooldowns).toEqual([]);
  });

  it("sem nada para ler, nem chama as plataformas", async () => {
    const net = network([[/rpc\/ad_today_targets/, () => json([])]]);
    const r = await handleAdsToday(`Bearer ${env.secret}`, env, net.fetch);
    expect(r.body).toEqual({ read: 0, errors: 0, accounts: 0 });
    expect(net.calls).toHaveLength(1);
  });
});

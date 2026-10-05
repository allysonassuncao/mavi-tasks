import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  googleItems,
  handleBudgetRefresh,
  handleBudgetSchedule,
  metaItems,
  readBudgets,
  summarize,
  type BudgetTarget,
} from "./_ads-budget";
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
type Call = { url: string; method: string; body?: string; auth?: string };
function network(routes: [RegExp, (call: Call) => Response | Promise<Response>][]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { url, method: init.method ?? "GET", body: init.body?.toString(), auth: headers.Authorization };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw Error(`Rota inesperada: ${call.method} ${url}`);
    return route[1](call);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}
const metaToken = { token_cipher: seal(key, "meta-token"), expires_at: null, currency: "BRL" };
const target = (extra: Partial<BudgetTarget> = {}): BudgetTarget => ({
  cycle_id: "cy-1",
  company_id: "co-1",
  campaign_id: "ca-1",
  platform: "meta",
  today: "2026-10-05",
  links: [{ account_id: "act_111", campaign_id: "c1", manager_id: "" }],
  meta_tokens: { "111": metaToken },
  google_token: null,
  ...extra,
});
const NOW = Date.parse("2026-10-05T15:00:00Z");
const active = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, effective_status: "ACTIVE", ...extra });

describe("orçamento da plataforma: Meta", () => {
  it("CBO conta a campanha; ABO soma os conjuntos ativos", () => {
    const cbo = metaItems(
      { ...active("c1"), daily_budget: "15000", adsets: { data: [active("s1"), active("s2")] } },
      "BRL",
      NOW,
    );
    expect(cbo).toEqual([
      expect.objectContaining({ id: "c1", level: "campaign", active: true, daily: 150, lifetime: 0 }),
    ]);
    const abo = metaItems(
      {
        ...active("c2"),
        adsets: {
          data: [
            active("s1", { daily_budget: "5000" }),
            active("s2", { daily_budget: "3000", effective_status: "PAUSED" }),
            active("s3", { daily_budget: "2000", end_time: "2026-10-01T00:00:00Z" }),
          ],
        },
      },
      "BRL",
      NOW,
    );
    expect(abo.map((i) => [i.id, i.level, i.active, i.daily])).toEqual([
      ["s1", "adset", true, 50],
      ["s2", "adset", false, 30],
      ["s3", "adset", false, 20],
    ]);
    expect(summarize(abo)).toEqual({ daily: 50, lifetime: 0, lifetime_left: 0, active: 1, total: 3 });
  });

  it("campanha parada, CBO sem conjunto entregando e vitalício à parte", () => {
    const paused = metaItems({ ...active("c1", { effective_status: "PAUSED" }), daily_budget: "10000" }, "BRL", NOW);
    expect(paused[0]).toMatchObject({ active: false, status: "PAUSED" });
    const empty = metaItems(
      { ...active("c2"), daily_budget: "10000", adsets: { data: [active("s1", { effective_status: "ADSET_PAUSED" })] } },
      "BRL",
      NOW,
    );
    expect(empty[0]).toMatchObject({ active: false, status: "NO_ACTIVE_ADSETS" });
    const life = metaItems(
      { ...active("c3"), lifetime_budget: "300000", budget_remaining: "120000", adsets: { data: [active("s1")] } },
      "BRL",
      NOW,
    );
    expect(summarize(life)).toEqual({ daily: 0, lifetime: 3000, lifetime_left: 1200, active: 1, total: 1 });
  });

  it("uma chamada por conta, só a estrutura, filtrada pelas campanhas vinculadas", async () => {
    const net = network([
      [
        /act_111\/campaigns/,
        () =>
          json({
            data: [
              { ...active("c1"), daily_budget: "12000", adsets: { data: [active("s1")] } },
              { ...active("c9"), daily_budget: "99900", adsets: { data: [active("s9")] } },
            ],
          }),
      ],
    ]);
    const other = target({ cycle_id: "cy-2", links: [{ account_id: "act_111", campaign_id: "c9", manager_id: "" }] });
    const r = await readBudgets(env, net.fetch, [target(), other], { now: () => NOW });
    expect(net.calls).toHaveLength(1);
    const url = new URL(net.calls[0].url);
    expect(url.searchParams.get("fields")).toContain("adsets.limit(200)");
    expect(url.searchParams.get("fields")).not.toContain("insights");
    expect(JSON.parse(url.searchParams.get("filtering")!)).toEqual([
      { field: "campaign.id", operator: "IN", value: ["c1", "c9"] },
    ]);
    expect(r.rows.map((x) => [x.cycle_id, x.daily, x.active, x.total])).toEqual([
      ["cy-1", 120, 1, 1],
      ["cy-2", 999, 1, 1],
    ]);
    expect(r.errors).toEqual([]);
  });

  it("conta inteira: só as campanhas entregando", async () => {
    const net = network([[/act_111\/campaigns/, () => json({ data: [] })]]);
    const whole = target({ links: [{ account_id: "act_111", campaign_id: "", manager_id: "" }] });
    const r = await readBudgets(env, net.fetch, [whole], { now: () => NOW });
    const url = new URL(net.calls[0].url);
    expect(JSON.parse(url.searchParams.get("filtering")!)).toEqual([
      { field: "effective_status", operator: "IN", value: ["ACTIVE"] },
    ]);
    expect(r.rows[0]).toMatchObject({ daily: 0, active: 0, total: 0 });
  });

  it("limite do Meta: o ciclo fica com o erro e a conta é pausada", async () => {
    const net = network([
      [/act_111\/campaigns/, () => json({ error: { code: 80004, message: "Too many calls" } }, 400)],
    ]);
    const r = await readBudgets(env, net.fetch, [target()], { now: () => NOW });
    expect(r.rows).toEqual([]);
    expect(r.errors[0].cycle_id).toBe("cy-1");
    expect(r.cooldowns[0]).toMatchObject({ platform: "meta", account: "111" });
  });
});

describe("orçamento da plataforma: Google", () => {
  it("orçamento compartilhado conta uma vez; parada e vitalício", () => {
    const items = googleItems([
      {
        campaign: { id: "1", name: "Pesquisa", status: "ENABLED", primaryStatus: "ELIGIBLE" },
        campaignBudget: { resourceName: "b/1", amountMicros: "50000000", explicitlyShared: true },
      },
      {
        campaign: { id: "2", name: "PMax", status: "ENABLED", primaryStatus: "LIMITED" },
        campaignBudget: { resourceName: "b/1", amountMicros: "50000000", explicitlyShared: true },
      },
      {
        campaign: { id: "3", name: "Display", status: "PAUSED", primaryStatus: "PAUSED" },
        campaignBudget: { resourceName: "b/3", amountMicros: "20000000" },
      },
      {
        campaign: { id: "4", name: "Encerrada", status: "ENABLED", primaryStatus: "ENDED" },
        campaignBudget: { resourceName: "b/4", amountMicros: "10000000" },
      },
    ]);
    expect(items.map((i) => [i.id, i.active, i.daily, i.shared])).toEqual([
      ["1", true, 50, true],
      ["2", true, 50, true],
      ["3", false, 20, false],
      ["4", false, 10, false],
    ]);
    expect(summarize(items)).toEqual({ daily: 50, lifetime: 0, lifetime_left: 0, active: 2, total: 4 });
  });

  it("uma consulta por conta, com o gerente do vínculo", async () => {
    const net = network([
      [/oauth2\.googleapis\.com\/token/, () => json({ access_token: "g-access", expires_in: 3600 })],
      [
        /customers\/123\/googleAds:searchStream/,
        () =>
          json([
            {
              results: [
                {
                  campaign: { id: "77", name: "Pesquisa", status: "ENABLED", primaryStatus: "ELIGIBLE" },
                  campaignBudget: { resourceName: "b/77", amountMicros: "35500000" },
                  customer: { currencyCode: "BRL" },
                },
              ],
            },
          ]),
      ],
    ]);
    const g = target({
      platform: "google",
      links: [{ account_id: "123", campaign_id: "77", manager_id: "999" }],
      meta_tokens: null,
      google_token: { refresh_token_cipher: seal(key, "refresh") },
    });
    const r = await readBudgets(env, net.fetch, [g], { now: () => NOW });
    const search = net.calls.find((c) => c.url.includes("searchStream"))!;
    expect(JSON.parse(search.body!).query).toContain("campaign.id IN (77)");
    expect(JSON.parse(search.body!).query).not.toContain("segments.date");
    expect(r.rows[0]).toMatchObject({ daily: 35.5, active: 1, total: 1, currency: "BRL" });
  });
});

describe("POST /api/ads-sync: orçamento", () => {
  it("agendado: só com o segredo; lê e grava", async () => {
    expect(await handleBudgetSchedule("Bearer outro", env, vi.fn() as unknown as typeof fetch)).toBeNull();
    const net = network([
      [/rpc\/ad_budget_targets/, () => json([target()])],
      [/act_111\/campaigns/, () => json({ data: [{ ...active("c1"), daily_budget: "8000", adsets: { data: [active("s1")] } }] })],
      [/rpc\/ad_budget_store/, () => json(1)],
    ]);
    const r = await handleBudgetSchedule(`Bearer ${env.secret}`, env, net.fetch);
    expect(r).toEqual({ read: 1, errors: 0, accounts: 1 });
    const stored = JSON.parse(net.calls.find((c) => c.url.includes("ad_budget_store"))!.body!);
    expect(stored.p_rows[0]).toMatchObject({ cycle_id: "cy-1", daily: 80, active: 1, total: 1 });
  });

  it("sem a migração (ou nada para ler): não faz nada", async () => {
    const net = network([[/rpc\/ad_budget_targets/, () => json({ message: "not found" }, 404)]]);
    expect(await handleBudgetSchedule(`Bearer ${env.secret}`, env, net.fetch)).toBeNull();
    expect(net.calls).toHaveLength(1);
  });

  it("botão Atualizar: o banco confere a pessoa; grava com o segredo", async () => {
    const net = network([
      [/rpc\/ad_budget_targets/, () => json([target()])],
      [/act_111\/campaigns/, () => json({ data: [{ ...active("c1"), daily_budget: "8000", adsets: { data: [active("s1")] } }] })],
      [/rpc\/ad_budget_store/, () => json(1)],
    ]);
    const campaign = "00000000-0000-4000-8000-000000000001";
    const r = await handleBudgetRefresh({ budget: campaign }, "Bearer user-jwt", env, net.fetch);
    expect(r).toEqual({ status: 200, body: { daily: 80, lifetime: 0, active: 1, total: 1 } });
    const asked = net.calls.find((c) => c.url.includes("ad_budget_targets"))!;
    expect(asked.auth).toBe("Bearer user-jwt");
    expect(JSON.parse(asked.body!)).toEqual({ p_secret: null, p_campaign: campaign, p_limit: 1 });
    const stored = net.calls.find((c) => c.url.includes("ad_budget_store"))!;
    expect(JSON.parse(stored.body!).p_secret).toBe(env.secret);
  });

  it("botão Atualizar: o intervalo de 5 min vem do banco", async () => {
    const net = network([
      [
        /rpc\/ad_budget_targets/,
        () => json({ message: "O orçamento desta campanha foi lido há pouco. Tente de novo em 3 min." }, 400),
      ],
    ]);
    const r = await handleBudgetRefresh(
      { budget: "00000000-0000-4000-8000-000000000001" },
      "Bearer user-jwt",
      env,
      net.fetch,
    );
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("lido há pouco");
    expect(net.calls).toHaveLength(1);
  });
});

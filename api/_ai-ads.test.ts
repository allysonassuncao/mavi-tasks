import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountLines, adsTurn, type AdAccount } from "./_ai-ads";
import { seal } from "./_google";
import { adsEnv } from "./_ads";

const key = crypto.randomBytes(32);
const env = { supabaseUrl: "https://db.example.com", supabaseKey: "publishable" };
const ads = adsEnv({ META_APP_SECRET: "secret", META_APP_ID: "1", GOOGLE_TOKEN_KEY_ADS: key.toString("base64") });
const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-0000000000c1";
const campaign = "00000000-0000-4000-8000-0000000000a1";
const auth = "Bearer x.eyJzdWIiOiJ1In0.y";
// 2 de outubro de 2026, meio-dia em São Paulo.
const now = () => Date.parse("2026-10-02T15:00:00Z");

const ACCOUNTS: AdAccount[] = [
  {
    platform: "meta",
    account_id: "111",
    name: "Conta Meta",
    manager_id: "",
    client_id: client,
    client: "4282",
    connected: true,
    campaigns: [
      { id: campaign, name: "Leads", status: "active", platform_campaigns: [{ id: "120000000001", name: "LP" }] },
    ],
  },
  {
    platform: "meta",
    account_id: "222",
    name: "Sem conexão",
    manager_id: "",
    client_id: client,
    client: "4282",
    connected: false,
    campaigns: [],
  },
  {
    platform: "google",
    account_id: "1234567890",
    name: "Conta Google",
    manager_id: "9998887777",
    client_id: client,
    client: "4282",
    connected: true,
    campaigns: [],
  },
];

type Call = { url: string; method: string; headers: Headers; body: any };
/** Supabase, o Graph e o Google Ads de mentira. */
function fake(owner: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const raw = typeof init.body === "string" ? init.body : "";
    calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: raw ? JSON.parse(raw) : null });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/rpc/ad_ai_accounts")) return json(ACCOUNTS);
    if (url.endsWith("/rpc/ad_meta_token")) return json([{ token_cipher: seal(key, "token-da-conta") }]);
    if (url.endsWith("/rpc/ad_google_tokens"))
      return json([{ refresh_token_cipher: seal(key, "r"), access_token_cipher: seal(key, "g"), access_expires_at: new Date(Date.now() + 3600_000).toISOString() }]);
    if (url.includes("/rpc/")) return json(null);
    if (url.startsWith("https://graph.facebook.com/")) {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v[0-9.]+/, "");
      if (u.searchParams.get("fields") === "account_id") {
        const id = path.slice(1);
        return owner[id] ? json({ id, account_id: owner[id] }) : json({ error: { message: "nope" } }, 400);
      }
      if (path === "/act_111") return json({ name: "Conta Meta", currency: "BRL", timezone_name: "America/Sao_Paulo" });
      if (path === "/act_111/campaigns")
        return json({ data: [{ id: "120000000001", name: "LP", effective_status: "ACTIVE", daily_budget: "5000" }] });
      if (path === "/act_111/insights")
        return json({ data: [{ campaign_id: "120000000001", spend: "120.5", impressions: "1000", clicks: "30" }] });
      if (path.endsWith("/insights") || path.endsWith("/adsets")) return json({ data: [] });
      if (path === "/120000000002")
        return json({
          id: "120000000002",
          name: "Conjunto A",
          account_id: "111",
          effective_status: "ACTIVE",
          targeting: { geo_locations: { countries: ["BR"] }, age_min: 25, flexible_spec: [{ interests: [{ id: "1", name: "Imóveis" }] }] },
        });
      return json({ id: path.slice(1), targeting: { age_min: 25 }, paging: { next: "https://graph.facebook.com/x?access_token=SEGREDO" } });
    }
    if (url.includes("googleads.googleapis.com")) return json([{ results: [{ campaign: { name: "Busca" } }] }]);
    return json({}, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const turnOf = async (scope = {}, owner: Record<string, string> = {}) => {
  const f = fake(owner);
  return { ...f, turn: (await adsTurn(env, f.fetchImpl, auth, company, scope, ads, now))! };
};

describe("contas por cliente", () => {
  it("lista as contas e avisa a que está sem conexão", () => {
    const text = accountLines(ACCOUNTS);
    expect(text).toContain("Cliente 4282");
    expect(text).toContain("Meta Ads · conta act_111");
    expect(text).toContain("120000000001");
    expect(text).toMatch(/act_222 "Sem conexão" · SEM conexão do Facebook/);
    expect(text).toContain("Google Ads · conta 123-456-7890");
  });
});

describe("adsTurn", () => {
  it("oferece as ferramentas e o foco da campanha", async () => {
    const { turn } = await turnOf({ client, campaign });
    expect(turn.tools.map((t) => t.name)).toEqual([
      "ad_accounts",
      "meta_ads_report",
      "meta_ads_detail",
      "meta_ads_audience",
      "meta_ads_graph",
      "google_ads_search",
      "google_ads_fields",
    ]);
    expect(turn.context).toContain('campanha do MAVI "Leads"');
    expect(turn.context).toContain("1 no Meta Ads (mais 1 sem a conexão do Facebook)");
  });

  it("recusa conta de fora e conta sem conexão, sem chegar ao Meta", async () => {
    const { turn, calls } = await turnOf();
    expect(await turn.run("meta_ads_report", { account_id: "act_999" })).toMatch(/^Recusado: a conta act_999/);
    expect(await turn.run("meta_ads_report", { account_id: "act_222" })).toMatch(/não tem a conexão do Facebook/);
    expect(calls.some((c) => c.url.startsWith("https://graph.facebook.com/"))).toBe(false);
  });

  it("lê a conta com o token dela (o da conexão), no período padrão", async () => {
    const { turn, calls } = await turnOf();
    const out = await turn.run("meta_ads_report", { account_id: "act_111" });
    expect(out).toContain('conta act_111 "Conta Meta"');
    expect(out).toContain("2026-09-26 a 2026-10-02");
    expect(out).toContain('"spend":120.5');
    const graphCall = calls.find((c) => c.url.includes("/act_111/insights"))!;
    expect(graphCall.headers.get("authorization")).toBe("Bearer token-da-conta");
  });

  it("um objeto só é lido depois de conferido que é da conta", async () => {
    const { turn } = await turnOf({}, { "120000000001": "111", "120000000009": "999" });
    expect(await turn.run("meta_ads_graph", { account_id: "act_111", path: "120000000009", fields: "targeting" })).toMatch(
      /^Recusado: 120000000009 não é da conta act_111/,
    );
    expect(await turn.run("meta_ads_detail", { account_id: "act_111", level: "campaign", id: "120000000009" })).toMatch(
      /^Recusado/,
    );
    const out = await turn.run("meta_ads_graph", { account_id: "act_111", path: "120000000001", fields: "targeting" });
    expect(out).toContain('"age_min":25');
    // O link da próxima página leva o token: nunca vai para a conversa.
    expect(out).not.toContain("SEGREDO");
    expect(out).toContain("há mais páginas");
  });

  it("o público do conjunto, em texto, só de um item da conta", async () => {
    const { turn } = await turnOf();
    const out = await turn.run("meta_ads_audience", { account_id: "act_111", id: "120000000002" });
    expect(out).toContain('Conjunto 120000000002 "Conjunto A"');
    expect(out).toContain("Locais: Brasil");
    expect(out).toContain("Interesses: Imóveis");
    expect(turn.label("meta_ads_audience", {})).toBe("Consultando o Meta Ads: público do conjunto");
    // An item without the account's id (another account): refused.
    expect(await turn.run("meta_ads_audience", { account_id: "act_111", id: "120000000009" })).toMatch(/não é da conta/);
    expect(await turn.run("meta_ads_audience", { account_id: "act_999", id: "120000000002" })).toMatch(/^Recusado/);
  });

  it("Graph: só caminhos da conta e sem parâmetros de token", async () => {
    const { turn, calls } = await turnOf();
    expect(await turn.run("meta_ads_graph", { account_id: "act_111", path: "act_999/campaigns" })).toMatch(/^Recusado/);
    expect(await turn.run("meta_ads_graph", { account_id: "act_111", path: "act_111/a/b/c" })).toMatch(/^Caminho inválido/);
    await turn.run("meta_ads_graph", {
      account_id: "act_111",
      path: "act_111/customaudiences",
      params: { access_token: "x", method: "post", ids: "1,2", limit: "500" },
    });
    const u = new URL(calls.filter((c) => c.url.includes("customaudiences")).pop()!.url);
    expect(u.searchParams.get("access_token")).toBeNull();
    expect(u.searchParams.get("method")).toBeNull();
    expect(u.searchParams.get("ids")).toBeNull();
    expect(u.searchParams.get("limit")).toBe("100");
  });

  it("Google: só contas liberadas, só SELECT, pela MCC", async () => {
    const { turn, calls } = await turnOf();
    expect(await turn.run("google_ads_search", { customer_id: "555-555-5555", query: "SELECT campaign.name FROM campaign" })).toMatch(/^Recusado/);
    expect(await turn.run("google_ads_search", { customer_id: "123-456-7890", query: "DELETE x" })).toMatch(/SELECT/);
    const out = await turn.run("google_ads_search", { customer_id: "123-456-7890", query: "SELECT campaign.name FROM campaign" });
    expect(out).toContain('"Busca"');
    const call = calls.find((c) => c.url.includes("googleAds:searchStream"))!;
    expect(call.url).toContain("customers/1234567890/");
    expect(call.headers.get("login-customer-id")).toBe("9998887777");
    expect(call.body.query).toMatch(/LIMIT 200$/);
  });
});

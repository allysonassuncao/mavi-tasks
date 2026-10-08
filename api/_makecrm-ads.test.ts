import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleMakecrmAds, makecrmQuery, type MakecrmAdsEnv } from "./_makecrm-ads";
import { seal } from "./_google";

const tokenKey = crypto.randomBytes(32);
const env: MakecrmAdsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  tokenKey,
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
  makecrmSecret: "c".repeat(40),
};
const CRM = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const MAVI_CAMPAIGN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const MASO_CAMPAIGN = "33645047a5c60c2904152189da93a14c";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const campaign = {
  id: MAVI_CAMPAIGN,
  legacy_id: MASO_CAMPAIGN,
  name: "Meta Mensagem - Home Equity",
  platform: "meta",
  status: "active",
  created_on: "2026-09-23",
  cycle: { id: "c1", legacy_id: "98ce", objective: "message", start_date: "2026-10-01", end_date: "2026-10-20" },
  links: [{ account_id: "111", campaign_id: "222", campaign_name: "[MSG] Home Equity", manager_id: "" }],
  totals: { days: 7, spend: 700, spend_m: 1750, impressions: 9000, reach: 5000, clicks: 300, conversions: 42 },
};

/** The database (rpc) and the Meta (graph.facebook.com), answered by name. */
function services(answer: {
  rpc?: (name: string, args: any) => unknown;
  graph?: (url: URL) => unknown;
}) {
  const rpcs: { name: string; args: any }[] = [];
  const graphs: URL[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    if (input.includes("/rest/v1/rpc/")) {
      const name = input.split("/rpc/")[1];
      const args = JSON.parse(String(init.body));
      rpcs.push({ name, args });
      return json(answer.rpc?.(name, args) ?? []);
    }
    const url = new URL(input);
    graphs.push(url);
    return json(answer.graph?.(url) ?? { data: [] });
  });
  return { fetch: fetchMock as unknown as typeof fetch, rpcs, graphs };
}

const ask = (body: unknown, svc: ReturnType<typeof services>, secret = env.makecrmSecret) =>
  handleMakecrmAds(body, secret, env, svc.fetch);
const period = { crm_company: CRM, since: "2026-10-02", until: "2026-10-08" };

describe("MakeCRM: o pedido", () => {
  it("só com empresa, período e campanhas válidos", () => {
    expect(makecrmQuery({ action: "campaigns", ...period, refs: [MASO_CAMPAIGN] })).toEqual({
      action: "campaigns",
      crmCompany: CRM,
      refs: [MASO_CAMPAIGN],
      since: "2026-10-02",
      until: "2026-10-08",
    });
    expect(makecrmQuery({ action: "campaigns", ...period })?.refs).toEqual([]);
    expect(makecrmQuery({ action: "other", ...period })).toBeNull();
    expect(makecrmQuery({ action: "campaigns", ...period, crm_company: "x" })).toBeNull();
    expect(makecrmQuery({ action: "campaigns", ...period, until: "2026-10-01" })).toBeNull();
    expect(makecrmQuery({ action: "campaigns", ...period, since: "2026-02-30" })).toBeNull();
    expect(makecrmQuery({ action: "campaigns", ...period, refs: ["a'; drop"] })).toBeNull();
    // ads: exactly one campaign; audience: at least one.
    expect(makecrmQuery({ action: "ads", ...period, refs: [] })).toBeNull();
    expect(makecrmQuery({ action: "ads", ...period, refs: ["a", "b"] })).toBeNull();
    expect(makecrmQuery({ action: "audience", ...period, refs: [] })).toBeNull();
  });
});

describe("MakeCRM: acesso", () => {
  it("sem os segredos configurados, não atende", async () => {
    const svc = services({});
    const result = await handleMakecrmAds({}, env.makecrmSecret, { ...env, makecrmSecret: "" }, svc.fetch);
    expect(result.status).toBe(503);
    expect(svc.rpcs).toHaveLength(0);
  });

  it("segredo errado: 401, sem ler o banco", async () => {
    const svc = services({});
    const result = await ask({ action: "campaigns", ...period }, svc, "x".repeat(40));
    expect(result.status).toBe(401);
    expect(svc.rpcs).toHaveLength(0);
  });

  it("pedido inválido: 400", async () => {
    const svc = services({});
    expect((await ask({ action: "campaigns" }, svc)).status).toBe(400);
  });
});

describe("MakeCRM: campanhas", () => {
  it("pergunta ao banco com o segredo da sincronização e devolve a lista", async () => {
    const svc = services({ rpc: () => [campaign] });
    const result = await ask({ action: "campaigns", ...period, refs: [MASO_CAMPAIGN] }, svc);
    expect(result).toEqual({ status: 200, body: { campaigns: [campaign] } });
    expect(svc.rpcs).toEqual([
      {
        name: "makecrm_ads_campaigns",
        args: {
          p_secret: env.secret,
          p_crm_company: CRM,
          p_legacy: [MASO_CAMPAIGN],
          p_since: "2026-10-02",
          p_until: "2026-10-08",
        },
      },
    ]);
  });
});

describe("MakeCRM: anúncios", () => {
  const access = [
    {
      campaign: MAVI_CAMPAIGN,
      legacy_id: MASO_CAMPAIGN,
      account_id: "111",
      campaign_ids: ["222"],
      token_cipher: seal(tokenKey, "meta-token"),
      expires_at: null,
    },
  ];

  it("lê os anúncios da campanha na Meta com o token da conta, sem devolvê-lo", async () => {
    const svc = services({
      rpc: (name) => (name === "makecrm_ads_campaigns" ? [campaign] : access),
      graph: (url) =>
        url.pathname.endsWith("/222/ads")
          ? {
              data: [
                {
                  id: "ad1",
                  name: "Anúncio 1",
                  status: "ACTIVE",
                  adset: { id: "as1", name: "Conjunto" },
                  creative: { id: "777" },
                  preview_shareable_link: "https://fb.me/x",
                  insights: { data: [{ impressions: "100", spend: "10" }] },
                },
              ],
            }
          : { 777: { id: "777", name: "Criativo", image_url: "https://img" } },
    });
    const result = await ask({ action: "ads", ...period, refs: [MASO_CAMPAIGN] }, svc);
    expect(result.status).toBe(200);
    expect(result.body.campaign).toEqual(campaign);
    expect(result.body.ads).toEqual([
      {
        id: "ad1",
        name: "Anúncio 1",
        status: "ACTIVE",
        adset_id: "as1",
        adset_name: "Conjunto",
        preview_url: "https://fb.me/x",
        performance: { impressions: "100", spend: "10" },
        creative_details: { id: "777", name: "Criativo", image_url: "https://img" },
      },
    ]);
    // The legacy id asks the database for that campaign only.
    expect(svc.rpcs[0].args.p_legacy).toEqual([MASO_CAMPAIGN]);
    expect(svc.rpcs[1]).toMatchObject({ name: "makecrm_ads_meta_access", args: { p_refs: [MASO_CAMPAIGN] } });
    // The token goes in the header, never in the answer.
    expect(svc.graphs[0].searchParams.get("access_token")).toBeNull();
    expect(svc.graphs[0].searchParams.get("fields")).toContain('insights.time_range({"since":"2026-10-02","until":"2026-10-08"})');
    expect(JSON.stringify(result.body)).not.toContain("meta-token");
  });

  it("campanha do MAVI pelo id: não pede o legacy_id", async () => {
    const svc = services({ rpc: (name) => (name === "makecrm_ads_campaigns" ? [campaign] : []) });
    await ask({ action: "ads", ...period, refs: [MAVI_CAMPAIGN] }, svc);
    expect(svc.rpcs[0].args.p_legacy).toEqual([]);
  });

  it("campanha do Google ou que não chega: sem anúncios e sem ler a Meta", async () => {
    const svc = services({ rpc: () => [{ ...campaign, platform: "google" }] });
    const result = await ask({ action: "ads", ...period, refs: [MASO_CAMPAIGN] }, svc);
    expect(result.body.ads).toEqual([]);
    expect(svc.graphs).toHaveLength(0);
    const none = services({ rpc: () => [] });
    expect((await ask({ action: "ads", ...period, refs: [MASO_CAMPAIGN] }, none)).body).toEqual({
      campaign: null,
      ads: [],
      warnings: [],
    });
  });

  it("conta sem conexão no MAVI vira aviso", async () => {
    const svc = services({
      rpc: (name) =>
        name === "makecrm_ads_campaigns" ? [campaign] : [{ ...access[0], token_cipher: null }],
    });
    const result = await ask({ action: "ads", ...period, refs: [MASO_CAMPAIGN] }, svc);
    expect(result.body.ads).toEqual([]);
    expect(result.body.warnings).toEqual([
      "Conta do Meta 111: sem conexão do Facebook no MAVI (Campanhas › Conexões).",
    ]);
  });
});

describe("MakeCRM: público", () => {
  it("idade/gênero e região só das campanhas pedidas, uma leitura por conta", async () => {
    const svc = services({
      rpc: () => [
        { campaign: "a", legacy_id: null, account_id: "111", campaign_ids: ["222"], token_cipher: seal(tokenKey, "t") },
        { campaign: "b", legacy_id: null, account_id: "111", campaign_ids: ["333"], token_cipher: seal(tokenKey, "t") },
      ],
      graph: (url) =>
        url.searchParams.get("breakdowns") === "region"
          ? { data: [{ campaign_id: "222", region: "São Paulo", spend: "5", impressions: "50", inline_link_clicks: "2" }] }
          : {
              data: [
                { campaign_id: "333", age: "25-34", gender: "female", spend: "3", impressions: "30", actions: [{ action_type: "lead", value: "1" }] },
                // Another client's campaign in a shared account: left out.
                { campaign_id: "999", age: "25-34", gender: "male", spend: "9", impressions: "90" },
              ],
            },
    });
    const result = await ask({ action: "audience", ...period, refs: ["a", "b"] }, svc);
    expect(result.status).toBe(200);
    expect(result.body.rows).toEqual([
      { kind: "age_gender", campaign_id: "333", age: "25-34", gender: "female", spend: 3, impressions: 30, clicks: 0, actions: [{ action_type: "lead", value: 1 }] },
      { kind: "region", campaign_id: "222", region: "São Paulo", spend: 5, impressions: 50, clicks: 2, actions: [] },
    ]);
    expect(svc.graphs).toHaveLength(2);
    expect(JSON.parse(svc.graphs[0].searchParams.get("filtering")!)).toEqual([
      { field: "campaign.id", operator: "IN", value: ["222", "333"] },
    ]);
  });

  it("a Meta falhando numa conta vira aviso", async () => {
    const svc = services({
      rpc: () => [{ campaign: "a", legacy_id: null, account_id: "111", campaign_ids: ["222"], token_cipher: seal(tokenKey, "t") }],
      graph: () => ({ error: { message: "boom" } }),
    });
    const result = await ask({ action: "audience", ...period, refs: ["a"] }, svc);
    expect(result.body.rows).toEqual([]);
    expect(result.body.warnings).toEqual(["Conta 111: a Meta não devolveu o público (Facebook: boom)."]);
  });
});

import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AdsEnv } from "./_ads";
import { seal } from "./_google";
import type { CampaignInsightsEnv } from "./_campaign-insights";
import { readWatch, watchItems, watchPlatforms, type WatchClaim } from "./_campaign-watch";

const company = "00000000-0000-4000-8000-000000000001";
const campaign = "00000000-0000-4000-8000-000000000002";
const tokenKey = crypto.randomBytes(32);
const ads: AdsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  tokenKey,
  redirectUri: "",
  meta: { appId: "app", appSecret: "secret", version: "v23.0" },
  google: { clientId: "cid", clientSecret: "cs", developerToken: "dev", version: "v25" },
};
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "",
  embeddingModel: "",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: crypto.randomBytes(32),
  imageModel: "",
  ads,
  crm: { supabaseUrl: "", supabaseKey: "", secret: "x".repeat(40), crmUrl: "https://crm.test" },
} as unknown as CampaignInsightsEnv;

const claim = (over: Partial<WatchClaim> = {}): WatchClaim => ({
  company_id: company,
  campaign_id: campaign,
  day: "2026-10-05",
  campaign: { id: campaign, name: "Motion - Meta", platform: "meta" },
  money_basis: "net",
  links: [{ account_id: "111", campaign_id: "222" }],
  meta_tokens: { "111": { token_cipher: seal(tokenKey, "token"), expires_at: null } },
  google_token: null,
  crm_company_id: "00000000-0000-4000-8000-000000000099",
  yesterday: "2026-10-04",
  d2: { days: 2, conversions: 9, spend: 300 },
  cycle: { spend: 1200, conversions: 80, goal_cpa: 20 },
  ...over,
});

describe("os avisos da vigia (sem a MAVI)", () => {
  it("reprovados, verba limitada com o custo na meta e leads que pararam de chegar ao CRM", () => {
    const items = watchItems(claim(), {
      disapproved: [
        { name: "Frete grátis", group: "Público A", reason: "Texto com promessa enganosa" },
        { name: "Vídeo", group: "", reason: "" },
      ],
      limited: ["Motion - Meta"],
      crm: { recent: 0, before: 14 },
    });
    expect(items.map((i) => [i.fingerprint, i.priority])).toEqual([
      ["problem#total#vigia-api-reprovados", "high"],
      ["opportunity#total#vigia-api-verba-limitada", "medium"],
      ["tracking#total#vigia-api-sem-lead-crm", "high"],
    ]);
    expect(items[0].title).toBe("2 anúncios foram reprovados pela plataforma");
    expect(items[0].body).toContain('"Frete grátis" (em Público A): Texto com promessa enganosa; "Vídeo".');
    expect(items[1].body).toMatch(/custa R\$\s?15,00, dentro da meta de R\$\s?20,00/);
    expect(items[2].evidence.map((e) => [e.metric, e.window, e.value])).toEqual([
      ["results", "d2", 9],
      ["crm_opportunities", "d2", 0],
      ["crm_opportunities", "prev7", 14],
    ]);
  });

  it("sem motivo, nada: custo acima da meta não é oportunidade; CRM que nunca recebeu não é quebra", () => {
    expect(
      watchItems(claim({ cycle: { spend: 3000, conversions: 80, goal_cpa: 20 } }), {
        disapproved: [],
        limited: ["Motion - Meta"],
        crm: { recent: 0, before: 0 },
      }),
    ).toEqual([]);
    expect(
      watchItems(claim({ d2: { days: 2, conversions: 2, spend: 50 } }), { disapproved: [], limited: [], crm: { recent: 0, before: 9 } }),
    ).toEqual([]);
  });
});

function network() {
  const calls: { url: string; body: any }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (url.startsWith("https://graph.facebook.com/v23.0/act_111/ads"))
      return json({
        data: [{ name: "Frete grátis", adset: { name: "Público A" }, ad_review_feedback: { global: { Política: "Promessa enganosa" } } }],
      });
    if (url.startsWith("https://graph.facebook.com/v23.0/?")) return json({ "222": { name: "Motion - Meta" } });
    if (url === "https://crm.test/api/mavi-sso")
      return json({
        campaigns: body.date_start.startsWith("2026-10-03") ? [] : [["Motion - Meta", 14, 1, 1, 900], ["Outra", 5, 0, 0, 0]],
      });
    if (url.includes("rpc/ai_campaign_watch_claim")) return json(calls.filter((c) => c.url.includes("claim")).length === 1 ? [claim()] : []);
    if (url.includes("rpc/ai_campaign_watch_store")) return json(1);
    throw Error(`rota inesperada: ${url}`);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("a leitura da vigia", () => {
  it("Meta: reprovados numa chamada; os nomes e o CRM dos 2 últimos dias × os 7 antes", async () => {
    const { impl, calls } = network();
    const found = await readWatch(env, impl, claim());
    expect(found).toEqual({
      disapproved: [{ name: "Frete grátis", group: "Público A", reason: "Promessa enganosa" }],
      limited: [],
      crm: { recent: 0, before: 14 },
    });
    const ads = new URL(calls[0].url);
    expect(JSON.parse(ads.searchParams.get("filtering")!)).toEqual([
      { field: "campaign.id", operator: "IN", value: ["222"] },
      { field: "effective_status", operator: "IN", value: ["DISAPPROVED", "WITH_ISSUES"] },
    ]);
    const crm = calls.filter((c) => c.url === "https://crm.test/api/mavi-sso").map((c) => [c.body.date_start, c.body.date_end]);
    expect(crm).toEqual([
      ["2026-10-03T00:00:00.000-03:00", "2026-10-04T23:59:59.999-03:00"],
      ["2026-09-26T00:00:00.000-03:00", "2026-10-02T23:59:59.999-03:00"],
    ]);
    // Poucas conversões: nem lê os nomes nem o CRM.
    const quiet = network();
    expect((await readWatch(env, quiet.impl, claim({ d2: { days: 2, conversions: 1, spend: 40 } }))).crm).toBeNull();
    expect(quiet.calls).toHaveLength(1);
  });

  it("o worker pega da fila e grava o que achou", async () => {
    const { impl, calls } = network();
    let t = 0;
    const stats = await watchPlatforms(env, { fetch: impl, llm: vi.fn(), embed: vi.fn(), now: () => (t += 1000) }, 60_000);
    expect(stats).toEqual({ done: 1, failed: 0, found: 2 });
    const store = calls.find((c) => c.url.includes("rpc/ai_campaign_watch_store"))!.body;
    expect(store).toMatchObject({ p_company: company, p_campaign: campaign, p_day: "2026-10-05", p_note: "" });
    expect(store.p_items.map((i: { fingerprint: string }) => i.fingerprint)).toEqual([
      "problem#total#vigia-api-reprovados",
      "tracking#total#vigia-api-sem-lead-crm",
    ]);
  });

  it("conexão que não abre: grava 'não leu' (nada muda nos avisos) em vez de repetir", async () => {
    const { impl, calls } = network();
    let t = 0;
    const read = vi.fn(async () => {
      const { InsightsError } = await import("./_campaign-insights");
      throw new InsightsError(409, "A conta 111 não tem conexão do Facebook.", true);
    });
    const stats = await watchPlatforms(env, { fetch: impl, llm: vi.fn(), embed: vi.fn(), now: () => (t += 1000) }, 60_000, read);
    expect(stats).toEqual({ done: 0, failed: 1, found: 0 });
    const store = calls.find((c) => c.url.includes("rpc/ai_campaign_watch_store"))!.body;
    expect(store).toMatchObject({ p_items: null, p_note: "A conta 111 não tem conexão do Facebook." });
  });
});

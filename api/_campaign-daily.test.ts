import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LlmAdapter } from "./_ai-llm";
import type { AdsEnv } from "./_ads";
import { newMeter } from "./_social-leads";
import {
  dailyEntities,
  dailyMessage,
  dailyNumbers,
  handleCampaignDailyWorker,
  idle,
  parseDaily,
  ruleRead,
  runCampaignDaily,
  type DailyEnv,
  type DailyMaterial,
} from "./_campaign-daily";
import { ThrottledError, type Analysis, type Entity } from "./_campaign-insights";

const company = "00000000-0000-4000-8000-000000000001";
const read = "00000000-0000-4000-8000-000000000700";
const env: DailyEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-haiku-4-5-20251001",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: crypto.randomBytes(32),
  imageModel: "gpt-image-1",
  ads: {} as AdsEnv,
  crm: { supabaseUrl: "", supabaseKey: "", crmUrl: "https://crm.example.com", secret: "c".repeat(40) },
  dailyBudgetMs: 400_000,
};

/** 10 dias de R$ 100 (sem M) e 2 leads por dia; M 1,5; meta 100 leads com R$ 3.000. */
function material(over: Partial<DailyMaterial> = {}): DailyMaterial {
  return {
    run: { id: read, trigger: "schedule" },
    company_id: company,
    today: "2026-10-04",
    timezone: "America/Sao_Paulo",
    campaign: { id: "camp", name: "Motion - Meta", platform: "meta", notes: "" },
    client: { id: "cl", name: "Vittalium" },
    product: { id: "pd", name: "Make Ads" },
    contract_id: "k",
    cycle: {
      id: "cy",
      start_date: "2026-09-24",
      end_date: "2026-10-23",
      objective: "lead",
      destination: "external_page",
      goal_results: 100,
      budget: 3000,
      multiplier: 1.5,
      niche: "",
    },
    links: [{ account_id: "111", campaign_id: "222" }],
    meta_tokens: { "111": { token_cipher: "v1:x", expires_at: null } },
    google_token: null,
    crm_company_id: null,
    daily: Array.from({ length: 10 }, (_, i) => ({
      day: i < 7 ? `2026-09-${24 + i}` : `2026-10-0${i - 6}`,
      spend: 100,
      conversions: 2,
      multiplier: 1.5,
    })),
    cycle_total: null,
    today_read: { spend: 40, conversions: 1, read_at: "2026-10-04T15:10:00Z" },
    open_insights: [{ priority: "high", kind: "problem", title: "O conjunto 'Amplo' gasta sem lead", action: "Pause o conjunto" }],
    settings: { money_basis: "net", run_cap_usd: 0.1 },
    last_done_at: null,
    previous: [],
    context: { dossier: [], radar: [], temperature: null, meetings: [] },
    jev: null,
    ...over,
  };
}
const entity = (key: string, level: Entity["level"], name: string, spend: number, extra: Partial<Entity> = {}): Entity => ({
  key,
  level,
  name,
  n: { cycle: { spend, results: 3, ctr: 1.2, frequency: null, roas: 4 }, d7: { spend: spend / 2 } },
  ...extra,
});
function analysis(entities: Entity[]): Analysis {
  return {
    platform: "meta",
    basis: "net",
    multiplier: 1.5,
    windows: {},
    result_label: "Cadastros",
    entities,
    crm: "unlinked",
    notes: [],
    accounts: ["111"],
  } as Analysis;
}

describe("os números do dia", () => {
  it("ciclo, ritmo, meta e projeção na base sem M", () => {
    const n = dailyNumbers(material());
    expect(n).toMatchObject({
      basis: "net",
      days: 30,
      elapsed: 10,
      budget: 2000,
      spent: 1000,
      conversions: 20,
      goalCost: 20,
      cost: 50,
      vsGoal: 150,
      projection: 60,
      yesterday: { spend: 100, conversions: 2 },
      today: { spend: 40, conversions: 1 },
    });
    expect(n.expected).toBeCloseTo(666.67, 1);
    expect(n.last7).toHaveLength(7);
  });

  it("com M e com o acumulado do ciclo (a conta do cabeçalho)", () => {
    const n = dailyNumbers(
      material({ settings: { money_basis: "gross", run_cap_usd: 0.1 }, cycle_total: { spend: 900, conversions: 30, until: "2026-10-03" } }),
    );
    expect(n.spent).toBe(1350);
    expect(n.conversions).toBe(30);
    expect(n.goalCost).toBe(30);
    expect(n.cost).toBe(45);
    expect(n.yesterday).toEqual({ spend: 150, conversions: 2 });
  });

  it("parada: sem investimento ontem nem hoje", () => {
    const daily = material().daily.map((d) => (d.day === "2026-10-03" ? { ...d, spend: 0, conversions: 0 } : d));
    const m = material({ daily, today_read: null });
    expect(idle(dailyNumbers(m))).toBe(true);
    expect(ruleRead(m, dailyNumbers(m))).toMatchObject({ tone: "attention", headline: expect.stringMatching(/^Sem investimento ontem:/) });
  });

  it("a frase pelas regras compara com a meta e projeta o fim", () => {
    const m = material();
    const r = ruleRead(m, dailyNumbers(m));
    expect(r.tone).toBe("bad");
    expect(r.headline).toBe("20 leads no ciclo a R$ 50,00 cada, 150% acima da meta de R$ 20,00; no ritmo atual, fecha com 60 de 100.");
    expect(r.points[0]).toBe("Ontem: 2 leads a R$ 50,00 cada.");
    expect(r.points[1]).toMatch(/50% acima do ritmo da verba/);
  });
});

describe("o material e a resposta", () => {
  it("leva os itens que mais gastaram, com as copys, sem tokens", () => {
    const ads = Array.from({ length: 9 }, (_, i) =>
      entity(`a:${i}`, "ad", `Anúncio ${i}`, 100 - i, { info: { titulo: `Promessa ${i}`, texto: "Frete grátis", criativo: "Foto do produto" } }),
    );
    const a = analysis([entity("c:222", "campaign", "Motion", 900), ...ads, entity("s:1", "adset", "Amplo", 300)]);
    expect(dailyEntities(a).filter((e) => e.level === "ad")).toHaveLength(6);
    const text = dailyMessage(material(), dailyNumbers(material()), a);
    expect(text).toContain("Promessa 0");
    expect(text).not.toContain("Promessa 8");
    expect(text).toContain("Frete grátis");
    expect(text).toContain("O conjunto 'Amplo' gasta sem lead");
    expect(text).not.toContain("v1:x");
    // Só as métricas que ajudam (sem roas da plataforma nem nulos).
    expect(text).not.toContain('"roas"');
    expect(text).not.toContain('"frequency"');
    expect(dailyMessage(material(), dailyNumbers(material()), null)).toContain("sem a leitura da plataforma hoje");
  });

  it("lê o JSON da MAVI e recusa o que não serve", () => {
    expect(parseDaily('Aqui: {"tom": "Atenção", "frase": "Custo 18% abaixo da meta, puxado pelo anúncio X.", "pontos": ["a", "", 3, "b"]}')).toEqual({
      tone: "attention",
      headline: "Custo 18% abaixo da meta, puxado pelo anúncio X.",
      points: ["a", "b"],
    });
    expect(parseDaily("sem json")).toBeNull();
    expect(parseDaily('{"tom":"bom","frase":"ok"}')).toBeNull();
  });
});

function database(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const key = Object.keys(routes)
      .sort((x, y) => y.length - x.length)
      .find((k) => url.includes(k));
    if (!key) return new Response("null", { status: 200 });
    const value = routes[key];
    const data = typeof value === "function" ? (value as (b: any) => unknown)(body) : value;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const once = () => {
  let n = 0;
  return () => (n++ < 1 ? [{ id: read }] : []);
};
const noCreatives = vi.fn(async () => ({ byEntity: new Map(), usage: [], notes: [], read: 0, reused: 0 }));

describe("worker da leitura do dia", () => {
  it("recusa sem o segredo", async () => {
    const r = await handleCampaignDailyWorker("Bearer errado", env, { fetch: vi.fn() as any, llm: vi.fn(), embed: vi.fn() });
    expect(r.status).toBe(401);
  });

  it("lê a plataforma, pergunta à MAVI e grava a frase com o custo", async () => {
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_daily_claim": once(),
      "rpc/ai_campaign_daily_material": material(),
      "rpc/ai_worker_route": null,
      "rpc/ai_campaign_daily_store": { ok: true },
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toMatch(/LEITURA DO DIA/);
      expect(req.messages[0].content).toMatch(/Anúncio A/);
      const meter = newMeter("claude-haiku-4-5-20251001");
      meter.input = 3000;
      meter.output = 120;
      meter.cost = 0.004;
      return {
        text: '{"tom":"ruim","frase":"Leads a R$ 50,00, 150% acima da meta; o anúncio Anúncio A traz quase tudo.","pontos":["Pause o conjunto Amplo."]}',
        meter,
        rounds: 1,
      };
    });
    const readPlatform = vi.fn(async () => analysis([entity("c:222", "campaign", "Motion", 900), entity("a:1", "ad", "Anúncio A", 500)]));
    let t = 0;
    const stats = await runCampaignDaily(env, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => (t += 60_000) }, readPlatform as any, noCreatives as any);
    expect(stats).toEqual({ done: 1, rule: 0, skipped: 0, deferred: 0, failed: 0 });
    const store = calls.find((c) => c.url.includes("ai_campaign_daily_store"))!.body;
    expect(store.p_read).toBe(read);
    expect(store.p_result).toMatchObject({
      status: "done",
      source: "mavi",
      tone: "bad",
      headline: "Leads a R$ 50,00, 150% acima da meta; o anúncio Anúncio A traz quase tudo.",
      points: ["Pause o conjunto Amplo."],
      money_basis: "net",
      model: "claude-haiku-4-5-20251001",
      api_calls: { meta: 0, google: 0 },
    });
    expect(store.p_result.usage).toEqual([expect.objectContaining({ kind: "campaign_daily", cost: 0.004 })]);
    // A regra da funcionalidade primeiro; sem ela, a dos insights.
    const routes = calls.filter((c) => c.url.includes("ai_worker_route")).map((c) => c.body.p_feature);
    expect(routes).toEqual(["campaign_daily", "campaign_insights"]);
  });

  it("parada: frase pelas regras, sem a plataforma nem a MAVI", async () => {
    const daily = material().daily.map((d) => (d.day === "2026-10-03" ? { ...d, spend: 0 } : d));
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_daily_claim": once(),
      "rpc/ai_campaign_daily_material": material({ daily, today_read: null }),
      "rpc/ai_campaign_daily_store": { ok: true },
    });
    const llm = vi.fn();
    const readPlatform = vi.fn();
    let t = 0;
    const stats = await runCampaignDaily(env, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => (t += 60_000) }, readPlatform as any, noCreatives as any);
    expect(stats.rule).toBe(1);
    expect(llm).not.toHaveBeenCalled();
    expect(readPlatform).not.toHaveBeenCalled();
    expect(calls.find((c) => c.url.includes("ai_campaign_daily_store"))!.body.p_result).toMatchObject({ source: "rule", tone: "attention" });
  });

  it("cota do Meta: pausa a conta e a leitura volta para a fila", async () => {
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_daily_claim": once(),
      "rpc/ai_campaign_daily_material": material(),
      "rpc/ai_campaign_insight_cooldown": null,
      "rpc/ai_campaign_daily_defer": null,
    });
    const readPlatform = vi.fn(async () => {
      throw new ThrottledError({ platform: "meta", scope: "account", minutes: 30, reason: "Meta: limite de requisições (código 17)" }, ["111"]);
    });
    let t = 0;
    const stats = await runCampaignDaily(env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn(), now: () => (t += 60_000) }, readPlatform as any, noCreatives as any);
    expect(stats.deferred).toBe(1);
    expect(calls.find((c) => c.url.includes("ai_campaign_insight_cooldown"))!.body).toMatchObject({ p_platform: "meta", p_account: "111" });
    expect(calls.some((c) => c.url.includes("ai_campaign_daily_store"))).toBe(false);
  });

  it("sem a plataforma (conexão) ainda escreve com os números do MAVI; sem a MAVI, pelas regras", async () => {
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_daily_claim": once(),
      "rpc/ai_campaign_daily_material": material(),
      "rpc/ai_worker_route": null,
      "rpc/ai_campaign_daily_store": { ok: true },
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.messages[0].content).toMatch(/sem a leitura da plataforma hoje/);
      return { text: "não sei", meter: newMeter("claude-haiku-4-5-20251001"), rounds: 1 };
    });
    const readPlatform = vi.fn(async () => {
      throw new Error("A conexão do Facebook desta conta expirou.");
    });
    let t = 0;
    const stats = await runCampaignDaily(env, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => (t += 60_000) }, readPlatform as any, noCreatives as any);
    expect(stats.rule).toBe(1);
    const result = calls.find((c) => c.url.includes("ai_campaign_daily_store"))!.body.p_result;
    expect(result.source).toBe("rule");
    expect(result.headline).toMatch(/^20 leads no ciclo/);
    expect(result.note).toMatch(/Sem a leitura da plataforma: A conexão do Facebook/);
    expect(result.note).toMatch(/não veio no formato/);
  });

  it("teto pequeno demais: frase pelas regras sem chamar a MAVI", async () => {
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_daily_claim": once(),
      "rpc/ai_campaign_daily_material": material({ settings: { money_basis: "net", run_cap_usd: 0.000001 } }),
      "rpc/ai_worker_route": null,
      "rpc/ai_campaign_daily_store": { ok: true },
    });
    const llm = vi.fn();
    let t = 0;
    await runCampaignDaily(env, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => (t += 60_000) }, (async () => analysis([])) as any, noCreatives as any);
    expect(llm).not.toHaveBeenCalled();
    expect(calls.find((c) => c.url.includes("ai_campaign_daily_store"))!.body.p_result.note).toMatch(/teto por leitura/);
  });

  it("campanha que não pode mais ser lida: pula com o motivo", async () => {
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_daily_claim": once(),
      "rpc/ai_campaign_daily_material": { blocked: "A campanha não está ativa." },
      "rpc/ai_campaign_daily_store": { ok: true },
    });
    let t = 0;
    const stats = await runCampaignDaily(env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn(), now: () => (t += 60_000) });
    expect(stats.skipped).toBe(1);
    expect(calls.find((c) => c.url.includes("ai_campaign_daily_store"))!.body.p_result).toEqual({ status: "skipped", note: "A campanha não está ativa." });
  });
});

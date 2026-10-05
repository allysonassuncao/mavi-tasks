import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import type { WindowRow } from "./_ads-platform";
import type { AdsEnv } from "./_ads";
import { seal } from "./_google";
import { newMeter } from "./_social-leads";
import {
  applyCheck,
  applyFunnel,
  effectOf,
  effectPlans,
  insightsContextLine,
  measureEffects,
  plannedRanges,
  keywordCrm,
  buildEvidence,
  crmIndex,
  derive,
  fitToCap,
  focus,
  handleCampaignInsightsWorker,
  insightMessage,
  metaEntities,
  metaUsage,
  meteredFetch,
  newApiMeter,
  ThrottledError,
  nearMissUtms,
  negativeCandidates,
  negativesInsight,
  parseInsights,
  parseNegatives,
  rankInsights,
  ruleInsights,
  sampleOk,
  stepsOf,
  runCampaignInsights,
  skipReason,
  totalEntity,
  stageDaysOf,
  typicalDays,
  unitOf,
  windowsFor,
  youngOf,
  withCrm,
  type Analysis,
  type CampaignInsightsEnv,
  type Entity,
  type InsightMaterial,
} from "./_campaign-insights";

const company = "00000000-0000-4000-8000-000000000001";
const run = "00000000-0000-4000-8000-0000000000a1";
const provider = "00000000-0000-4000-8000-000000000800";
const providerKey = crypto.randomBytes(32);
const env: CampaignInsightsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey,
  imageModel: "gpt-image-1",
  ads: {} as AdsEnv,
  crm: { supabaseUrl: "", supabaseKey: "", crmUrl: "https://crm.example.com", secret: "c".repeat(40) },
  insightsBudgetMs: 400_000,
};

function material(over: Partial<InsightMaterial> = {}): InsightMaterial {
  return {
    run: { id: run, trigger: "manual" },
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
    crm_company_id: "crm",
    // 10 dias: R$ 100 por dia (sem M) e 2 resultados que contam por dia.
    daily: Array.from({ length: 10 }, (_, i) => ({
      day: i < 7 ? `2026-09-${24 + i}` : `2026-10-0${i - 6}`,
      spend: 100,
      conversions: 2,
      multiplier: 1.5,
    })),
    settings: { money_basis: "net", run_cap_usd: 0.5 },
    last_done_at: null,
    previous: [],
    context: { dossier: [{ kind: "context", text: "Vende suplementos" }], radar: [], temperature: null, meetings: [] },
    jev: null,
    ...over,
  };
}

const row = (
  p: Partial<WindowRow> & { id: string; name: string; level: WindowRow["level"] },
  windows: Record<string, Record<string, number>> = {
    cycle: { spend: 100, impressions: 1000, reach: 800, link_clicks: 20, results: 4 },
  },
): WindowRow => ({
  delivery: { code: "ACTIVE", label: "Ativo", tone: "on" },
  campaign_id: "222",
  campaign_name: "Motion",
  attribution: "",
  result_label: "Cadastros",
  windows,
  ...p,
});

describe("janelas e números", () => {
  it("todas até ontem; o ciclo para no fim dele; desde a última análise quando houve", () => {
    const w = windowsFor("2026-10-04", { start_date: "2026-09-24", end_date: "2026-10-23" }, null, "America/Sao_Paulo");
    expect(w).toEqual({
      cycle: { since: "2026-09-24", until: "2026-10-03" },
      d7: { since: "2026-09-27", until: "2026-10-03" },
      d15: { since: "2026-09-19", until: "2026-10-03" },
      d30: { since: "2026-09-04", until: "2026-10-03" },
    });
    const after = windowsFor(
      "2026-10-04",
      { start_date: "2026-09-01", end_date: "2026-10-02" },
      "2026-10-01T02:00:00Z",
      "America/Sao_Paulo",
    );
    expect(after.cycle).toEqual({ since: "2026-09-01", until: "2026-10-02" });
    // 01/10 às 02h UTC ainda é 30/09 em São Paulo.
    expect(after.since_last).toEqual({ since: "2026-09-30", until: "2026-10-03" });
  });

  it("derivadas: CPA, CTR, CPC, CPM, frequência, ROAS; e o CRM ao lado", () => {
    const n = derive({ spend: 100, impressions: 1000, reach: 500, clicks: 20, results: 4, value: 300 });
    expect(n).toMatchObject({ cpa: 25, ctr: 2, cpc: 5, cpm: 100, frequency: 2, roas: 3 });
    expect(derive({ spend: 50, results: 0 }).cpa).toBeNull();
    const c = withCrm(n, { opportunities: 2, wins: 1, revenue: 900 });
    expect(c).toMatchObject({ crm_opportunities: 2, crm_cpl: 50, crm_cost_win: 100, crm_roas: 9, crm_rate: 50 });
  });
});

describe("entidades do Meta com o CRM", () => {
  const crm = crmIndex({
    campaigns: [
      ["Motion", 3, 1, 1, 500],
      ["motion ", 2, 0, 0, 0],
    ],
    adsets: [
      ["Motion", "Público A", 2, 1, 1, 500],
      ["Motion", "público a", 1, 0, 0, 0],
    ],
    ads: [["Motion", "Público A", "Anúncio frete", 2, 1, 1, 500]],
  });
  const entities = metaEntities(
    {
      campaigns: [
        row({ id: "222", name: "Motion", level: "campaign" }, {
          cycle: { spend: 100, impressions: 1000, results: 4 },
          d7: { spend: 40, impressions: 400, results: 1 },
        }),
      ],
      adsets: [
        row({
          id: "s1",
          name: "Público A",
          level: "adset",
          optimization: "Cadastros",
          breakdown: [{ key: "25-34|female", label: "25-34 · Mulheres", metrics: { spend: 60, results: 3, impressions: 500 } }],
        }),
        // Sem veiculação: não vai para a MAVI.
        row({ id: "s9", name: "Parado", level: "adset" }, { cycle: { spend: 0, impressions: 0, results: 0 } }),
      ],
      ads: [
        row({
          id: "a1",
          name: "Anúncio frete",
          level: "ad",
          adset_id: "s1",
          adset_name: "Público A",
          creative: { title: "Frete grátis em 24h", body: "Compre hoje" },
        }),
      ],
    },
    crm,
    1.5,
  );
  const byKey = new Map(entities.map((e) => [e.key, e]));

  it("liga pelo nome exato, multiplica o dinheiro pelo M quando pedido e guarda o criativo", () => {
    expect(byKey.get("c:222")!.n.cycle).toMatchObject({ spend: 150, crm_opportunities: 3, crm_wins: 1 });
    // O CRM só vem na janela do ciclo.
    expect(byKey.get("c:222")!.n.d7!.crm_opportunities).toBeUndefined();
    expect(byKey.get("s:s1")).toMatchObject({ parent: "c:222", info: { otimizacao: "Cadastros" } });
    expect(byKey.get("s:s1")!.n.cycle!.crm_opportunities).toBe(2);
    expect(byKey.get("a:a1")).toMatchObject({ parent: "s:s1", info: { titulo: "Frete grátis em 24h" } });
    expect(byKey.get("a:a1")!.n.cycle!.crm_opportunities).toBe(2);
    expect(byKey.get("g:s1:25-34|female")).toMatchObject({ level: "segment", parent: "s:s1" });
    expect(byKey.get("g:s1:25-34|female")!.n.cycle!.spend).toBe(90);
    expect(byKey.has("s:s9")).toBe(false);
  });

  it("UTMs quase iguais ao nome viram entidades para a correção", () => {
    const near = nearMissUtms(entities, crm);
    expect(near.map((u) => [u.name, u.parent, u.info?.kind])).toEqual([
      ["motion ", "c:222", "campaign"],
      ["público a", "s:s1", "adset"],
    ]);
    expect(near[0].n.cycle!.crm_opportunities).toBe(2);
  });
});

function analysisOf(entities: Entity[], m = material(), crm: Analysis["crm"] = "ok"): Analysis {
  const a: Analysis = {
    platform: "meta",
    basis: "net",
    multiplier: 1.5,
    windows: windowsFor(m.today, m.cycle, m.last_done_at, m.timezone),
    result_label: "Cadastros",
    entities,
    crm,
    notes: [],
  };
  a.entities = [totalEntity(m, a), ...a.entities];
  return a;
}
const campaign = (results: number, opportunities: number): Entity => ({
  key: "c:222",
  level: "campaign",
  name: "Motion",
  n: { cycle: withCrm(derive({ spend: 900, results }), { opportunities, wins: 0, revenue: 0 }) },
});

describe("detecções automáticas", () => {
  it("conversões na plataforma e nenhum lead no CRM: rastreamento, prioridade alta", () => {
    const a = analysisOf([campaign(30, 0)]);
    const map = new Map(a.entities.map((e) => [e.key, e]));
    const rules = ruleInsights(material(), a, map);
    const t = rules.find((r) => r.kind === "tracking")!;
    expect(t).toMatchObject({ priority: "high", source: "rule", fingerprint: "tracking#c:222#sem-lead-no-crm" });
    expect(t.evidence.map((e) => [e.metric, e.value])).toEqual([
      ["results", 30],
      ["crm_opportunities", 0],
    ]);
    // Com leads no CRM, ou sem CRM ligado, não há o que apontar.
    expect(ruleInsights(material(), analysisOf([campaign(30, 4)]), new Map()).some((r) => r.kind === "tracking")).toBe(false);
    const off = analysisOf([campaign(30, 0)], material(), "unlinked");
    expect(ruleInsights(material(), off, new Map(off.entities.map((e) => [e.key, e]))).some((r) => r.kind === "tracking")).toBe(false);
  });

  it("custo por resultado do ciclo acima da meta (com a meta sem M)", () => {
    // Meta: R$ 3.000 com M = R$ 2.000 sem M para 100 resultados = R$ 20; o ciclo: R$ 1.000 / 20 = R$ 50.
    const a = analysisOf([campaign(30, 4)]);
    const total = a.entities[0].n.cycle!;
    expect(total).toMatchObject({ goal_cpa: 20, mavi_results: 20, mavi_cpa: 50, cost_vs_goal: 250, days_elapsed: 10 });
    const r = ruleInsights(material(), a, new Map(a.entities.map((e) => [e.key, e])));
    expect(r.find((x) => x.kind === "problem")).toMatchObject({
      priority: "high",
      fingerprint: "problem#total#custo-acima-da-meta",
    });
  });
});

describe("Fase 5: boas práticas, amostra, ordem e passos", () => {
  const n = (w: Parameters<typeof derive>[0]) => derive(w);
  const metaAnalysis = (extra: Entity[]) => analysisOf([campaign(30, 4), ...extra]);

  it("aprendizado limitado que pesa e anúncio cansado viram detecções; o pequeno não", () => {
    const camp = campaign(30, 4);
    camp.n.d7 = n({ spend: 1000, results: 20, impressions: 50000, clicks: 600 });
    const limited: Entity = {
      key: "s:1",
      level: "adset",
      name: "Público A",
      parent: "c:222",
      status: "Aprendizado limitado",
      n: { d7: n({ spend: 300, results: 4 }) },
    };
    const small: Entity = { ...limited, key: "s:2", name: "Público B", n: { d7: n({ spend: 50, results: 1 }) } };
    const tired: Entity = {
      key: "a:1",
      level: "ad",
      name: "Vídeo depoimento",
      parent: "s:1",
      n: {
        d7: n({ spend: 200, impressions: 9000, reach: 2500, clicks: 45, results: 5 }),
        d30: n({ spend: 800, impressions: 30000, reach: 12000, clicks: 300, results: 25 }),
      },
    };
    const a = analysisOf([camp, limited, small, tired]);
    const r = ruleInsights(material(), a, new Map(a.entities.map((e) => [e.key, e])));
    const prints = r.map((x) => x.fingerprint);
    expect(prints).toContain("problem#s:1#aprendizado-limitado");
    expect(prints).not.toContain("problem#s:2#aprendizado-limitado");
    const t = r.find((x) => x.fingerprint === "problem#a:1#anuncio-cansado")!;
    expect(t.title).toBe('O anúncio "Vídeo depoimento" está cansando o público');
    expect(t.body).toMatch(/viu este anúncio 3,6 vezes.*caiu para 0,5%, contra 1%/);
    expect(t.action.split("\n")).toHaveLength(2);
  });

  it("amostra mínima: sem resultados, oportunidades ou gasto suficiente, a MAVI não conclui", () => {
    const tiny: Entity = { key: "s:9", level: "adset", name: "Teste", parent: "c:222", n: { cycle: n({ spend: 15, results: 2 }) } };
    const a = metaAnalysis([tiny]);
    const map = new Map(a.entities.map((e) => [e.key, e]));
    const about = (key: string | null, kind: "highlight" | "tracking" = "highlight") =>
      ({ kind, target: key ? { key } : null, evidence: [] }) as never;
    expect(sampleOk(about("s:9"), map, 10)).toBe(false);
    expect(sampleOk(about("s:9", "tracking"), map, 10)).toBe(true);
    expect(sampleOk(about("c:222"), map, 10)).toBe(true);
    expect(sampleOk(about("s:9"), map, 0)).toBe(true);
    // Gastou 2 resultados da meta (R$ 20 cada) sem trazer nada: pode apontar o problema.
    map.set("s:9", { ...tiny, n: { cycle: n({ spend: 45, results: 0 }) } });
    expect(sampleOk(about("s:9"), map, 10)).toBe(true);
  });

  it("a ordem pela prioridade (mantendo a da análise) e o limite; os passos em linhas", () => {
    const x = (title: string, priority: "high" | "medium" | "low") => ({ title, priority }) as never;
    expect(rankInsights([x("a", "low"), x("b", "high"), x("c", "medium"), x("d", "high")], 3).map((i: { title: string }) => i.title)).toEqual([
      "b",
      "d",
      "c",
    ]);
    expect(stepsOf(["1. Duplique o conjunto", " - Suba 20%", "", "Compare em 3 dias", "Quarto"])).toBe(
      "Duplique o conjunto\nSuba 20%\nCompare em 3 dias",
    );
    expect(stepsOf("Pausar o anúncio")).toBe("Pausar o anúncio");
  });
});

describe("a resposta da MAVI", () => {
  const a = analysisOf([campaign(30, 4)]);
  const map = new Map(a.entities.map((e) => [e.key, e]));

  it("os valores das evidências vêm do material; evidência inventada cai, e o insight sem nenhuma também", () => {
    const text = `Segue:\n${JSON.stringify({
      summary: "Campanha cara.",
      insights: [
        {
          kind: "opportunity",
          priority: "medium",
          topic: "Mover verba",
          target: "c:222",
          title: "Mover verba",
          body: "…",
          action: "…",
          evidence: [
            { entity: "c:222", window: "cycle", metric: "crm_opportunities" },
            { entity: "c:999", window: "cycle", metric: "spend" },
            { entity: "c:222", window: "cycle", metric: "inventada" },
          ],
        },
        { kind: "problem", priority: "high", title: "Sem prova", evidence: [{ entity: "x", window: "cycle", metric: "spend" }] },
        { kind: "talvez", priority: "high", title: "Tipo errado", evidence: [{ entity: "c:222", window: "cycle", metric: "spend" }] },
      ],
    })}`;
    const r = parseInsights(text, map);
    expect(r.summary).toBe("Campanha cara.");
    expect(r.dropped).toBe(2);
    expect(r.insights).toHaveLength(1);
    expect(r.insights[0]).toMatchObject({
      target: { key: "c:222", level: "campaign", name: "Motion" },
      fingerprint: "opportunity#c:222#mover-verba",
      evidence: [{ metric: "crm_opportunities", value: 4, unit: "count", name: "Motion", window: "cycle" }],
    });
    expect(() => parseInsights("não deu", map)).toThrow(/formato esperado/);
  });

  it("o material vai com as chaves, as janelas, os insights anteriores e sem tokens", () => {
    const text = insightMessage(
      material({
        previous: [
          {
            kind: "problem",
            priority: "high",
            title: "Público caro",
            fingerprint: "problem#g:s1:25-34|female#publico-caro",
            status: "new",
            seen_count: 2,
            last_seen_at: "2026-10-01",
          },
        ],
      }),
      a,
      [],
    );
    expect(text).toMatch(/"topic":"publico-caro","target":"g:s1:25-34\|female"/);
    expect(text).toMatch(/"key":"c:222"/);
    expect(text).toMatch(/R\$ sem M/);
    expect(text).not.toMatch(/token/);
  });

  it("buildEvidence não repete a mesma evidência", () => {
    const e = buildEvidence(map, [
      { entity: "total", window: "cycle", metric: "goal_cpa" },
      { entity: "total", window: "cycle", metric: "goal_cpa" },
    ]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ value: 20, unit: "money", label: "Custo por resultado da meta" });
  });
});

describe("teto por análise e o Jev", () => {
  it("enxuga até caber; sem caber nem cortado, nulo", () => {
    const price = { input: 4, output: 20 };
    const build = (cut: number) => ({ text: "x".repeat(cut >= 2 ? 1000 : 400_000), maxTokens: cut >= 4 ? 3000 : 6000 });
    expect(fitToCap(build, 0.5, price)).toMatchObject({ cut: 2 });
    expect(fitToCap(build, 0.01, price)).toBeNull();
  });

  it("o Jev tira o que os números não sustentam e guarda a confiança", () => {
    const list = [{ title: "a" }, { title: "b" }, { title: "c" }] as any[];
    const kept = applyCheck(list, { answers: { ok_1: { noul: 0.9 }, ok_2: { noul: 0.1 } } });
    expect(kept.map((x) => x.title)).toEqual(["a", "c"]);
    expect(kept[0].confidence).toBe(0.9);
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
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("worker dos insights", () => {
  it("recusa sem o segredo", async () => {
    const res = await handleCampaignInsightsWorker("Bearer errado", env, {
      fetch: vi.fn() as any,
      llm: vi.fn(),
      embed: vi.fn(),
    });
    expect(res.status).toBe(401);
  });

  it("lê, detecta, pergunta à MAVI, confere com o Jev e grava com o custo", async () => {
    let claims = 0;
    const jev = {
      scope: "feature",
      provider_id: provider,
      provider: "OpenRouter",
      kind: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      key_cipher: seal(providerKey, "sk-or"),
      model: "~typesafe/jev-latest",
      price: { id: "~typesafe/jev-latest", input: 0.042, output: 0 },
    };
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_insight_claim": () => (claims++ < 1 ? [{ id: run, company_id: company }] : []),
      "rpc/ai_campaign_insight_material": material({ jev }),
      "rpc/ai_worker_route": null,
      "rpc/ai_campaign_insight_store": { ok: true },
      "alpha/decisions": { model: "typesafe/jev-1", answers: { ok_1: { noul: 0.92 }, ok_2: { noul: 0.05 } }, usage: { input_tokens: 900, cost: 0.00004 } },
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toMatch(/analista sênior de tráfego/);
      expect(req.messages[0].content).toMatch(/deteccoes_automaticas/);
      const meter = newMeter("claude-opus-5-5");
      meter.input = 9000;
      meter.output = 700;
      meter.cost = 0.05;
      return {
        text: JSON.stringify({
          summary: "Leads sem CRM e custo alto.",
          insights: [
            {
              kind: "highlight",
              priority: "medium",
              topic: "anuncio-frete",
              target: "c:222",
              title: "Bom volume",
              body: "…",
              action: "Escalar",
              evidence: [{ entity: "c:222", window: "cycle", metric: "results" }],
            },
            {
              kind: "opportunity",
              priority: "low",
              topic: "sem-base",
              target: null,
              title: "Chute",
              body: "…",
              action: "…",
              evidence: [{ entity: "total", window: "cycle", metric: "spend" }],
            },
          ],
        }),
        meter,
        rounds: 1,
      };
    });
    const read = vi.fn(async (_env: unknown, _fetch: unknown, m: InsightMaterial) => analysisOf([campaign(30, 0)], m));
    let t = 0;
    const stats = await runCampaignInsights(env, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => (t += 60_000) }, read);
    expect(stats).toEqual({ done: 1, skipped: 0, deferred: 0, failed: 0, insights: 3, learned: 0, watched: 0 });
    const store = calls.find((c) => c.url.includes("rpc/ai_campaign_insight_store"))!.body;
    expect(store.p_secret).toBe(env.workerSecret);
    const result = store.p_result;
    expect(result.status).toBe("done");
    expect(result.summary).toBe("Leads sem CRM e custo alto.");
    // As detecções primeiro; o "Chute" o Jev recusou.
    expect(result.insights.map((i: any) => [i.source, i.kind, i.title])).toEqual([
      ["rule", "tracking", "Motion: a plataforma registra leads, mas nenhum chega ao CRM"],
      ["rule", "problem", "Cada resultado está custando mais que a meta"],
      ["mavi", "highlight", "Bom volume"],
    ]);
    expect(result.insights[2].confidence).toBe(0.92);
    expect(result.note).toMatch(/O Jev recusou 1 insight/);
    expect(result.api_calls).toEqual({ meta: 0, google: 0 });
    expect(result.tokens).toEqual({ input: 9900, output: 700 });
    expect(result.usage.map((u: any) => [u.kind, u.cost])).toEqual([
      ["campaign_insights", 0.05],
      ["campaign_insights_check", 0.00004],
    ]);
  });

  it("campanha que deixou de poder ser analisada: pula com o motivo", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_insight_claim": () => (claims++ < 1 ? [{ id: run, company_id: company }] : []),
      "rpc/ai_campaign_insight_material": { blocked: "A campanha não está ativa." },
      "rpc/ai_campaign_insight_store": { ok: true },
    });
    let t = 0;
    const stats = await runCampaignInsights(env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn(), now: () => (t += 60_000) });
    expect(stats.skipped).toBe(1);
    const store = calls.find((c) => c.url.includes("rpc/ai_campaign_insight_store"))!.body;
    expect(store.p_result).toEqual({ status: "skipped", note: "A campanha não está ativa." });
  });

  it("falha de leitura volta para a fila; falta de conexão não adianta repetir", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_insight_claim": () => (claims++ < 1 ? [{ id: run, company_id: company }] : []),
      "rpc/ai_campaign_insight_material": material({ meta_tokens: null }),
      "rpc/ai_worker_route": null,
      "rpc/ai_campaign_insight_fail": null,
    });
    const read = vi.fn(async () => {
      const { InsightsError } = await import("./_campaign-insights");
      throw new InsightsError(409, "A conexão do Facebook desta conta expirou.", true);
    });
    let t = 0;
    const stats = await runCampaignInsights(env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn(), now: () => (t += 60_000) }, read as any);
    expect(stats.failed).toBe(1);
    const fail = calls.find((c) => c.url.includes("rpc/ai_campaign_insight_fail"))!.body;
    expect(fail).toMatchObject({ p_run: run, p_final: true });
    expect(fail.p_error).toMatch(/expirou/);
  });
});

describe("cota das APIs e leitura à toa", () => {
  it("lê o consumo que o Meta informa (o maior vale) e o tempo para liberar", () => {
    const h = new Headers({
      "x-business-use-case-usage": JSON.stringify({
        "999": [{ type: "ads_insights", call_count: 12, total_cputime: 81, total_time: 40, estimated_time_to_regain_access: 7 }],
      }),
      "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 33, reset_time_duration: 120 }),
    });
    expect(metaUsage(h)).toEqual({ pct: 81, regain: 7 });
    expect(metaUsage(new Headers())).toEqual({ pct: 0, regain: 0 });
  });

  it("conta as chamadas e percebe o limite do Meta e o RESOURCE_EXHAUSTED do Google", async () => {
    const meter = newApiMeter();
    const base = vi.fn(async (url: string) =>
      url.includes("graph.facebook.com/v23.0/act_1/ads")
        ? new Response(JSON.stringify({ error: { code: 80000, message: "too many" } }), {
            status: 400,
            headers: { "x-business-use-case-usage": JSON.stringify({ "1": [{ call_count: 100, estimated_time_to_regain_access: 30 }] }) },
          })
        : url.includes("googleads")
          ? new Response(JSON.stringify([{ error: { status: "RESOURCE_EXHAUSTED", details: [{ retryDelay: "120s" }] } }]), { status: 429 })
          : new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const f = meteredFetch(base, meter);
    await f("https://graph.facebook.com/v23.0/act_1/campaigns");
    expect(meter).toMatchObject({ meta: 1, throttle: null });
    await f("https://graph.facebook.com/v23.0/act_1/ads");
    expect(meter.throttle).toMatchObject({ platform: "meta", scope: "account", minutes: 30 });
    expect(meter.pct).toBe(100);
    const g = newApiMeter();
    await meteredFetch(base, g)("https://googleads.googleapis.com/v25/customers/1/googleAds:searchStream");
    expect(g).toMatchObject({ google: 1, throttle: { platform: "google", scope: "platform", minutes: 60 } });
  });

  it("pula sem chamar nada: sem investimento desde a última análise, ou poucos dias novos no agendamento", () => {
    // A última análise (02/10, 9h em SP) leu até 01/10.
    const base = material({ last_done_at: "2026-10-02T12:00:00Z" });
    const days = (spends: number[]) =>
      spends.map((spend, i) => ({ day: `2026-10-0${i + 2}`, spend, conversions: 0, multiplier: 1.5 }));
    expect(skipReason({ ...base, daily: days([0, 0]) })).toMatch(/Sem investimento desde a última análise \(que leu até 01\/10\)/);
    const sched = { ...base, run: { id: run, trigger: "schedule" as const }, settings: { ...base.settings, min_new_days: 2 } };
    expect(skipReason({ ...sched, daily: days([50, 0]) })).toMatch(/Só 1 dia novo com investimento/);
    expect(skipReason({ ...sched, daily: days([50, 20]) })).toBeNull();
    // Pedida por alguém: analisa mesmo com pouco dado novo.
    expect(skipReason({ ...base, settings: { ...base.settings, min_new_days: 2 }, daily: days([50, 0]) })).toBeNull();
    // Sem os dias sincronizados não dá para saber: analisa. Nunca analisada: analisa.
    expect(skipReason({ ...sched, daily: [] })).toBeNull();
    expect(skipReason(material())).toBeNull();
  });

  it("só o que pesa vai para a MAVI: 2% do investimento ou CRM; e o limite por nível", () => {
    const e = (key: string, level: any, spend: number, crm = 0) => ({
      key,
      level,
      name: key,
      n: { cycle: { spend, impressions: spend ? 100 : 0, results: 0, crm_opportunities: crm } },
    });
    const list = focus(
      [e("c:1", "campaign", 1000), e("a:1", "ad", 500), e("a:2", "ad", 10), e("a:3", "ad", 5, 2), e("a:4", "ad", 300), e("a:5", "ad", 0)],
      { adsets: 5, ads: 2, keywords: 5, terms: 5, segments: 5 },
    );
    // a:2 pesa 1% e não tem CRM; a:5 não veiculou; dos que sobram, o do CRM primeiro.
    expect(list.map((x) => x.key)).toEqual(["c:1", "a:1", "a:3"]);
  });

  it("limite da plataforma: pausa a conta, a análise volta para a fila sem contar tentativa", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_insight_claim": () => (claims++ < 1 ? [{ id: run, company_id: company }] : []),
      "rpc/ai_campaign_insight_material": material(),
      "rpc/ai_worker_route": null,
      "rpc/ai_campaign_insight_cooldown": null,
      "rpc/ai_campaign_insight_defer": null,
    });
    const read = vi.fn(async () => {
      throw new ThrottledError({ platform: "meta", scope: "account", minutes: 30, reason: "Meta: limite de requisições (código 80000)" }, ["111"]);
    });
    let t = 0;
    const llm = vi.fn();
    const stats = await runCampaignInsights(env, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => (t += 60_000) }, read as any);
    expect(stats).toMatchObject({ deferred: 1, failed: 0 });
    expect(llm).not.toHaveBeenCalled();
    const cool = calls.find((c) => c.url.includes("rpc/ai_campaign_insight_cooldown"))!.body;
    expect(cool).toMatchObject({ p_platform: "meta", p_account: "111" });
    const defer = calls.find((c) => c.url.includes("rpc/ai_campaign_insight_defer"))!.body;
    expect(defer.p_note).toMatch(/espera a cota liberar/);
    expect(new Date(defer.p_until).getTime() - new Date(cool.p_until).getTime()).toBe(0);
  });

  it("Google: sem orçamento de operações da MAVI, nem lê a plataforma", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_insight_claim": () => (claims++ < 1 ? [{ id: run, company_id: company }] : []),
      "rpc/ai_campaign_insight_material": material({
        campaign: { id: "camp", name: "Pesquisa", platform: "google", notes: "" },
        links: [{ account_id: "123", campaign_id: "9" }],
        google_token: { refresh_token_cipher: "v1:x" },
      }),
      "rpc/ai_campaign_insight_google_ops": { ok: false, used: 498, budget: 500, retry_at: "2026-10-05T09:05:00Z" },
      "rpc/ai_campaign_insight_defer": null,
    });
    const read = vi.fn();
    let t = 0;
    const stats = await runCampaignInsights(env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn(), now: () => (t += 60_000) }, read as any);
    expect(stats.deferred).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(calls.find((c) => c.url.includes("rpc/ai_campaign_insight_google_ops"))!.body).toMatchObject({ p_ops: 7, p_check: true });
    const defer = calls.find((c) => c.url.includes("rpc/ai_campaign_insight_defer"))!.body;
    expect(defer).toMatchObject({ p_until: "2026-10-05T09:05:00Z" });
    expect(defer.p_note).toMatch(/498 de 500/);
  });
});

describe("termos de pesquisa e negativas (Fase 8)", () => {
  const term = (id: string, name: string, cost: number, conversions: number, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    sub: "Grupo A",
    status: { code: "NONE", label: "Nenhum", tone: "off" as const },
    enabled: null,
    campaign_id: "222",
    ad_group_id: "g1",
    info: { campaign: "Pesquisa", ad_group: "Grupo A", keyword: "[clínica]" },
    windows: { cycle: { cost, clicks: 10, impressions: 100, conversions } },
    ...extra,
  });
  const reads = [
    {
      view: "search_terms" as const,
      rows: [
        term("1", "vaga de emprego clínica", 40, 0),
        term("2", "Vaga de emprego clínica", 15, 0),
        term("3", "clínica perto de mim", 80, 3),
        term("4", "clínica grátis", 30, 0),
        term("5", "curso de clínica", 4, 0),
        term("6", "clínica popular", 60, 0, { status: { code: "EXCLUDED", label: "Excluído", tone: "off" } }),
      ],
    },
  ] as never;

  it("candidatas: sem conversão, ainda não negativadas, somadas por termo e acima do piso", () => {
    // Meta de R$ 20 por resultado → piso de R$ 6; o M (1,5) multiplica o gasto.
    const list = negativeCandidates(reads, 1.5, 20);
    expect(list.map((t) => [t.ref, t.term, t.spend])).toEqual([
      ["N1", "vaga de emprego clínica", 82.5],
      ["N2", "clínica grátis", 45],
      // R$ 4 × 1,5 = R$ 6: alcança o piso.
      ["N3", "curso de clínica", 6],
    ]);
    // Sem meta: piso de R$ 10.
    expect(negativeCandidates(reads, 1, null).map((t) => t.term)).toEqual(["vaga de emprego clínica", "clínica grátis"]);
  });

  it("a MAVI escolhe só entre as candidatas; o servidor soma o gasto e monta a lista", () => {
    const candidates = negativeCandidates(reads, 1, 20);
    const picked = parseNegatives(
      JSON.stringify({
        insights: [],
        negatives: [
          { ref: "N1", match: "phrase", why: "Procura de emprego" },
          { ref: "N1", match: "exact" },
          { ref: "N9", match: "exact" },
          { ref: "N2", match: "qualquer" },
        ],
      }),
      candidates,
    );
    expect(picked).toEqual([
      { term: "vaga de emprego clínica", match: "phrase", spend: 55, clicks: 20, campaign: "Pesquisa", why: "Procura de emprego" },
      { term: "clínica grátis", match: "exact", spend: 30, clicks: 10, campaign: "Pesquisa", why: "" },
    ]);
    expect(parseNegatives("sem json", candidates)).toEqual([]);
    const total = { key: "total", level: "total" as const, name: "Campanha (total)", n: { cycle: { spend: 500 } } };
    const insight = negativesInsight({} as never, picked, new Map([["total", total]]))!;
    expect(insight).toMatchObject({
      kind: "opportunity",
      priority: "high",
      fingerprint: "opportunity#total#negativas-termos-de-pesquisa",
      extra: { negatives: picked },
    });
    expect(insight.title).toMatch(/^Negativar 2 termos de pesquisa que gastaram R\$\s?85,00 sem converter$/);
    expect(insight.evidence.map((e) => [e.metric, e.value])).toEqual([
      ["negatives_spend", 85],
      ["negatives_count", 2],
      ["negatives_share", 17],
    ]);
    expect(negativesInsight({} as never, [], new Map())).toBeNull();
  });
});

describe("as etapas que importam e a maturidade (Fase 6)", () => {
  const goal = {
    source: "client" as const,
    stages: [
      { pipeline_id: "p1", pipeline_name: "Vendas", stage_id: "st2", stage_name: "Negociação", cost_goal: 40 },
      { pipeline_id: "p1", pipeline_name: "Vendas", stage_id: "st3", stage_name: "Contrato", cost_goal: 100 },
    ],
  };
  const funnel = {
    rows: [
      {
        l: "c" as const, c: "Motion", t: "", n: "", deals: 20, open: 12, won: 2, lost: 6, qualified: 0, score: null,
        at: null, reach: { st1: 12, st2: 5, st3: 3 }, lost_by: null, buckets: null, answers: null,
        ages: { "0": 6, "4": 3, "8": 2, "15": 1 },
      },
      {
        l: "s" as const, c: "Motion", t: "Público A", n: "", deals: 8, open: 2, won: 1, lost: 5, qualified: 0, score: null,
        at: null, reach: { st1: 2, st2: 4, st3: 2 }, lost_by: null, buckets: null, answers: null, ages: { "15": 2 },
      },
    ],
    pipelines: [{ id: "p1", name: "Vendas" }],
    stages: [
      { id: "st1", pipeline_id: "p1", name: "Novo", order: 1 },
      { id: "st2", pipeline_id: "p1", name: "Negociação", order: 2 },
      { id: "st3", pipeline_id: "p1", name: "Contrato", order: 3 },
    ],
    reasons: [],
    buckets: [],
    options: [],
    stage_days: { st2: { median: 6.4, n: 30 }, st3: { median: 12, n: 9 } },
  };
  const entities = () => [
    { key: "c:222", level: "campaign" as const, name: "Motion", utm: "Motion", n: { cycle: withCrm(derive({ spend: 640, results: 40 }), { opportunities: 20, wins: 2, revenue: 0 }) } },
    { key: "s:1", level: "adset" as const, name: "Público A", parent: "c:222", utm: ["Motion", "Público A"].join("\u0000"), n: { cycle: { spend: 120 } } },
  ];

  it("cada etapa: os leads que chegam (ela ou além), a porcentagem, o custo e os recentes pelo tempo típico dela", () => {
    const list = entities();
    const labels = applyFunnel(list, funnel, goal);
    // Negociação ou além: 5 + 3 = 8 de 20, R$ 80 (200% da meta de R$ 40); recentes (< 6 dias): 6.
    // Contrato: 3 de 20, R$ 213,33 (213,3% da meta de R$ 100); recentes (< 12 dias): 6 + 3 = 9.
    expect(list[0].n.cycle).toMatchObject({
      "goal:st2:leads": 8,
      "goal:st2:rate": 40,
      "goal:st2:cost": 80,
      "goal:st2:vs_target": 200,
      "goal:st2:young": 6,
      "goal:st3:leads": 3,
      "goal:st3:cost": 213.33,
      "goal:st3:young": 9,
      "goal:st3:young_rate": 45,
      young_leads: 6,
      young_rate: 30,
    });
    expect(list[1].n.cycle).toMatchObject({ "goal:st2:leads": 6, "goal:st2:cost": 20, "goal:st3:leads": 2 });
    expect(labels["goal:st2:cost"]).toBe('Custo por lead que chega a "Negociação"');
    expect(labels["goal:st3:young"]).toBe('Leads abertos há menos de 12 dias (cedo para chegar a "Contrato")');
    expect(youngOf({ "0": 2, "4": 3, "8": 4, "31": 9 }, 10)).toBe(5);
    expect(typicalDays(funnel, "st2")).toBe(6);
    expect(typicalDays({ ...funnel, stage_days: {} }, "st2")).toBeNull();
    expect(unitOf("goal:st2:cost")).toBe("money");
    expect(unitOf("goal:st2:rate")).toBe("pct");
  });

  it("no total, as metas; o aviso fala da etapa que mais estoura e cita as outras — mais brando com muitos recentes", () => {
    const m = { ...material(), crm_goal: goal };
    const build = (ages: Record<string, number>) => {
      const list = entities();
      const f = { ...funnel, rows: [{ ...funnel.rows[0], ages }, funnel.rows[1]] };
      const a = analysisOf([], m);
      a.entities = list;
      a.funnel = "ok";
      a.labels = applyFunnel(list, f, goal);
      a.stageDays = stageDaysOf(f, goal);
      a.entities = [totalEntity(m, a), ...list];
      return a;
    };
    const a = build({ "15": 3 });
    const total = a.entities[0].n.cycle!;
    expect(total).toMatchObject({ "goal:st2:leads": 8, "goal:st2:cost": 80, "goal:st2:target": 40, "goal:st3:target": 100 });
    const r = ruleInsights(m, a, new Map(a.entities.map((e) => [e.key, e]))).find((x) => x.fingerprint === "problem#total#etapa-acima-da-meta")!;
    // Contrato estoura 213%, Negociação 200%: o aviso é do Contrato e cita a Negociação.
    expect(r.priority).toBe("high");
    expect(r.title).toBe('Cada lead que chega a "Contrato" está custando mais que a meta');
    expect(r.body).toMatch(/Também acima da meta: "Negociação" \(R\$\s?80,00, meta R\$\s?40,00\)/);
    expect(r.evidence.map((e) => [e.label, e.unit])).toEqual([
      ['Custo por lead que chega a "Contrato"', "money"],
      ['Meta de custo por lead em "Contrato"', "money"],
      ['Leads que chegaram a "Contrato" (etapa que importa)', "count"],
    ]);
    const early = build({ "0": 9 });
    const r2 = ruleInsights(m, early, new Map(early.entities.map((e) => [e.key, e]))).find((x) => x.fingerprint === "problem#total#etapa-acima-da-meta")!;
    expect(r2.priority).toBe("medium");
    expect(r2.body).toMatch(/45% dos leads ainda são recentes \(entraram há menos de 12 dias/);
    // O material diz as etapas, as metas, o tempo típico e as métricas de cada uma.
    const text = insightMessage(m, a, []);
    expect(text).toContain('"etapas_que_importam":{"origem":"padrão do cliente","etapas":[{"etapa":"Negociação","funil":"Vendas","meta_de_custo_por_lead":40,"dias_tipicos_ate_a_etapa":6,"metricas":{"leads":"goal:st2:leads"');
  });
});

describe("o funil do CRM (Fase 2)", () => {
  const funnel = {
    rows: [
      {
        l: "c" as const, c: "Motion", t: "", n: "", deals: 10, open: 4, won: 2, lost: 4, qualified: 6, score: 7.5,
        at: { st2: 3, st1: 1 }, reach: { st1: 3, st2: 4, st3: 3 }, lost_by: { r1: 3, r2: 1 }, buckets: { b1: 4, b2: 2 },
        answers: { o1: 5, o2: 1 },
      },
      {
        l: "s" as const, c: "Motion", t: "Público A", n: "", deals: 6, open: 2, won: 0, lost: 4, qualified: 0, score: null,
        at: null, reach: { st1: 6 }, lost_by: { r1: 4 }, buckets: null, answers: null,
      },
    ],
    pipelines: [{ id: "p1", name: "Vendas" }],
    stages: [
      { id: "st1", pipeline_id: "p1", name: "Novo", order: 1 },
      { id: "st2", pipeline_id: "p1", name: "Negociação", order: 2 },
      { id: "st3", pipeline_id: "p1", name: "Contrato", order: 3 },
    ],
    reasons: [{ id: "r1", name: "Sem orçamento" }, { id: "r2", name: "Preço" }],
    buckets: [{ id: "b1", name: "Quente", form: "SDR", min: 7, max: 10 }, { id: "b2", name: "Frio", form: "SDR", min: 0, max: 6 }],
    options: [{ id: "o1", label: "Sim", question: "Tem orçamento?", form: "SDR" }],
  };

  it("cada entidade com UTM ganha o funil do ciclo; etapas somam 'ou além'; rótulos legíveis", () => {
    const entities = [
      { key: "c:1", level: "campaign" as const, name: "Motion", utm: "Motion", n: { cycle: { spend: 100 }, d7: { spend: 30 } } },
      { key: "s:1", level: "adset" as const, name: "Público A", utm: ["Motion", "Público A"].join("\u0000"), n: { cycle: { spend: 50 } } },
      { key: "s:2", level: "adset" as const, name: "Sem lead", utm: ["Motion", "Sem lead"].join("\u0000"), n: { cycle: { spend: 10 } } },
    ];
    const labels = applyFunnel(entities, funnel);
    expect(entities[0].n.cycle).toMatchObject({
      spend: 100,
      crm_open: 4,
      crm_won_deals: 2,
      crm_lost: 4,
      crm_lost_rate: 40,
      crm_qualified: 6,
      crm_score: 7.5,
      // Negociação ou além: 4 + 3; Contrato: 3. "Novo" (a primeira) não entra.
      "stage:st2": 7,
      "stage:st3": 3,
      "lost:r1": 3,
      "bucket:b1": 4,
      "answer:o1": 5,
    });
    expect(entities[0].n.cycle).not.toHaveProperty("stage:st1");
    // Opção sem nome (removida) não vira métrica; o CRM só na janela do ciclo.
    expect(entities[0].n.cycle).not.toHaveProperty("answer:o2");
    expect(entities[0].n.d7).toEqual({ spend: 30 });
    expect(entities[1].n.cycle).toMatchObject({ crm_lost_rate: 66.7, "lost:r1": 4 });
    expect(entities[1].n.cycle).not.toHaveProperty("crm_score");
    expect(entities[2].n.cycle).toEqual({ spend: 10 });
    expect(labels).toMatchObject({
      "stage:st2": 'Chegaram a "Negociação" ou além',
      "lost:r1": 'Perdidas por "Sem orçamento"',
      "bucket:b1": 'Qualificação "Quente"',
      "answer:o1": 'Responderam "Sim" em "Tem orçamento?"',
    });
    // A MAVI cita a métrica do funil e o valor vem do material, com o rótulo.
    const map = new Map(entities.map((e) => [e.key, e]));
    const r = parseInsights(
      JSON.stringify({
        insights: [
          {
            kind: "problem",
            priority: "high",
            title: "Leads sem orçamento",
            target: "s:1",
            evidence: [{ entity: "s:1", window: "cycle", metric: "lost:r1" }, { entity: "s:1", window: "cycle", metric: "stage:inventada" }],
          },
        ],
      }),
      map,
      6,
      labels,
    );
    expect(r.insights[0].evidence).toEqual([
      { label: 'Perdidas por "Sem orçamento"', value: 4, unit: "count", window: "cycle", entity: "s:1", name: "Público A", metric: "lost:r1" },
    ]);
  });

  it("Google: a palavra-chave pelo utm_content ({keyword}), sem os sinais da correspondência", () => {
    const crm = crmIndex({
      campaigns: [["Pesquisa", 5, 1, 1, 900]],
      adsets: [["Pesquisa", "Grupo A", 5, 1, 1, 900]],
      ads: [
        ["Pesquisa", "Grupo A", "consultoria tributaria", 3, 1, 1, 900],
        ["Pesquisa", "Grupo A", "contador online", 2, 0, 0, 0],
      ],
    })!;
    expect(keywordCrm(crm, "Pesquisa", "Grupo A", "[consultoria tributária]")).toMatchObject({
      counts: { opportunities: 3, wins: 1, revenue: 900 },
    });
    expect(keywordCrm(crm, "Pesquisa", "Grupo B", "contador online")).toBeNull();
  });

  it("Google sem utm_content no CRM: aviso de rastreamento com o modelo de URL", () => {
    const m = material({ campaign: { id: "camp", name: "Pesquisa", platform: "google", notes: "" } });
    const a = analysisOf([
      { key: "c:9", level: "campaign", name: "Pesquisa", n: { cycle: withCrm(derive({ spend: 500, results: 10 }), { opportunities: 6, wins: 0, revenue: 0 }) } },
      { key: "s:9", level: "adset", name: "Grupo A", parent: "c:9", n: { cycle: { spend: 500 } } },
      { key: "k:1", level: "keyword", name: "[contador]", parent: "s:9", n: { cycle: { spend: 200 } } },
    ], m);
    a.platform = "google";
    a.contentCampaigns = [];
    const map = new Map(a.entities.map((e) => [e.key, e]));
    const rule = ruleInsights(m, a, map).find((r) => r.fingerprint === "tracking#c:9#google-sem-palavra-chave");
    expect(rule).toMatchObject({ priority: "low" });
    expect(rule!.action).toMatch(/utm_content=\{keyword\}/);
    // Com utm_content chegando ao CRM, nada a dizer.
    a.contentCampaigns = ["Pesquisa"];
    expect(ruleInsights(m, a, map).some((r) => r.fingerprint.includes("google-sem-palavra-chave"))).toBe(false);
  });
});

describe("criativos na análise (Fase 3)", () => {
  it("o resumo do criativo entra no material do anúncio e o custo da leitura conta na análise", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_campaign_insight_claim": () => (claims++ < 1 ? [{ id: run, company_id: company }] : []),
      "rpc/ai_campaign_insight_material": material(),
      "rpc/ai_worker_route": null,
      "rpc/ai_campaign_insight_store": { ok: true },
    });
    const ad: Entity = {
      key: "a:7",
      level: "ad",
      name: "Frete grátis",
      parent: "c:222",
      source: { creative: "c7", account: "111" },
      info: { titulo: "Frete grátis em 24h" },
      n: { cycle: withCrm(derive({ spend: 300, results: 9 }), { opportunities: 5, wins: 1, revenue: 800 }) },
    };
    const read = vi.fn(async (_e: unknown, _f: unknown, m: InsightMaterial) => analysisOf([campaign(30, 4), ad], m));
    const creatives = vi.fn(async (_env: unknown, _deps: unknown, input: any) => {
      expect(input.ads).toEqual([
        expect.objectContaining({ entity: "a:7", spend: 300, title: "Frete grátis em 24h", meta: { creative: "c7", account: "111" } }),
      ]);
      expect(input.budget).toBeCloseTo(0.2);
      return {
        byEntity: new Map([["a:7", { line: "Caixa chegando | promessa: frete grátis em 24h", transcript: "chega amanhã" }]]),
        usage: [{ kind: "campaign_creative_image", model: "claude-opus-5-5", input: 2400, output: 300, cache_read: 0, cache_write: 0, cost: 0.02 }],
        notes: [],
        read: 1,
        reused: 0,
      };
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.messages[0].content).toMatch(/"criativo":"Caixa chegando \| promessa: frete grátis em 24h"/);
      expect(req.messages[0].content).toMatch(/"audio":"chega amanhã"/);
      const meter = newMeter("claude-opus-5-5");
      meter.cost = 0.05;
      return { text: JSON.stringify({ summary: "ok", insights: [] }), meter, rounds: 1 };
    });
    let t = 0;
    await runCampaignInsights(env, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => (t += 60_000) }, read, creatives as any);
    expect(creatives).toHaveBeenCalledTimes(1);
    const result = calls.find((c) => c.url.includes("rpc/ai_campaign_insight_store"))!.body.p_result;
    expect(result.usage.map((u: any) => [u.kind, u.cost])).toEqual([
      ["campaign_creative_image", 0.02],
      ["campaign_insights", 0.05],
    ]);
    expect(result.note).toMatch(/Criativos: 1 lido agora, 0 reaproveitados/);
  });
});

describe("antes × depois dos aplicados (Fase 4)", () => {
  it("os períodos: N dias antes e N depois (até 14; mínimo de 3 dias depois), no nível do alvo", () => {
    const m = material({
      applied: [
        { id: "11111111-aaaa-4000-8000-000000000001", title: "Pausar", kind: "problem", target: { key: "s:9", level: "adset", name: "X" }, applied_at: "2026-09-27T12:00:00Z", effect: null },
        { id: "22222222-aaaa-4000-8000-000000000002", title: "Geral", kind: "problem", target: null, applied_at: "2026-09-10T12:00:00Z", effect: null },
        { id: "33333333-aaaa-4000-8000-000000000003", title: "Recente", kind: "problem", target: null, applied_at: "2026-10-02T12:00:00Z", effect: null },
      ],
    });
    const plans = effectPlans(m);
    expect(plans.map((p) => [p.level, p.days, p.before.since, p.before.until, p.after.since, p.after.until])).toEqual([
      // Aplicado em 27/09; até ontem (03/10) são 7 dias.
      ["adset", 7, "2026-09-20", "2026-09-26", "2026-09-27", "2026-10-03"],
      // Há mais de 14 dias: 14 de cada lado.
      ["total", 14, "2026-08-27", "2026-09-09", "2026-09-10", "2026-09-23"],
    ]);
    expect(plannedRanges(plans, "adset").map((r) => r.key)).toEqual(["b:11111111", "x:11111111"]);
    expect(plannedRanges(plans, "campaign").map((r) => r.key)).toEqual(["b:22222222", "x:22222222"]);
  });

  it("o efeito pelo custo por resultado (ou resultados por dia) e os períodos saem das entidades", () => {
    expect(effectOf(derive({ spend: 400, results: 10 }), derive({ spend: 400, results: 13 }), 7, "net")).toMatchObject({
      verdict: "better",
      change: { cpa: -23.1, results_per_day: 30 },
      before: { cpa: 40 },
      money_basis: "net",
    });
    expect(effectOf(derive({ spend: 400, results: 10 }), derive({ spend: 440, results: 10 }), 7).verdict).toBe("worse");
    expect(effectOf(derive({ spend: 100, results: 0 }), derive({ spend: 100, results: 0 }), 5).verdict).toBe("neutral");
    const plans = effectPlans(
      material({
        applied: [{ id: "11111111-aaaa-4000-8000-000000000001", title: "P", kind: "problem", target: { key: "s:9", level: "adset", name: "X" }, applied_at: "2026-09-27T12:00:00Z", effect: null }],
      }),
    );
    const entities: Entity[] = [
      {
        key: "s:9",
        level: "adset",
        name: "X",
        n: { cycle: derive({ spend: 900, results: 20 }), ["b:11111111" as never]: derive({ spend: 350, results: 7 }), ["x:11111111" as never]: derive({ spend: 350, results: 10 }) },
      },
    ];
    const out = measureEffects(plans, entities);
    expect(out[0]).toMatchObject({ insight: "11111111-aaaa-4000-8000-000000000001", effect: { verdict: "better", days: 7 } });
    expect(Object.keys(entities[0].n)).toEqual(["cycle"]);
  });

  it("o contexto da conversa: abertos com evidências, aplicados com efeito, descartados; nada quando desligado", () => {
    expect(insightsContextLine(null)).toBe("");
    const line = insightsContextLine({
      money_basis: "net",
      open: [{ priority: "high", kind: "problem", title: "Conjunto caro", action: "Pausar", evidence: [{ label: "CPA", value: 42.5, unit: "money", window: "cycle", entity: "s:1", name: "X", metric: "cpa" }] }],
      applied: [{ title: "Pausar o amplo", applied_at: "2026-09-27T12:00:00Z", effect: effectOf(derive({ spend: 400, results: 10 }), derive({ spend: 400, results: 13 }), 7) }],
      dismissed: [{ title: "Frete grátis", reason: "Restrição do cliente" }],
    });
    expect(line).toContain("valores sem M");
    expect(line).toContain("[aberto, prioridade alta] Conjunto caro → Pausar (CPA: R$ 42,50)");
    expect(line).toContain("[aplicado em 2026-09-27] Pausar o amplo — efeito em 7 dias: melhorou (custo por resultado -23,1%)");
    expect(line).toContain("[descartado pelo time: Restrição do cliente] Frete grátis");
  });
});

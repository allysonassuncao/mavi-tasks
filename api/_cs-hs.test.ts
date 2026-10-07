import { describe, expect, it, vi } from "vitest";
import { handleCsHsWorker, type CsHsEnv } from "./_cs-hs";

// O worker da sugestão de Health Score (migração 20270524090000) com um banco
// e uma MAVI falsos.
const env: CsHsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-haiku",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 50_000,
  providerKey: null,
  csHsBudgetMs: 40_000,
};
const job = {
  company_id: "c", cs_client_id: "k1", month: "2026-09-01", today: "2026-09-30", rules: {},
  pack: {
    client: { name: "Loja Boa", external_id: "4282", kind: "BASE", trial_month: null, linked: true, squad: "P" },
    cycle: { status: "PAGO", adimplencia: "ADIMPLENTE", billing_date: "2026-09-10", paid_date: "2026-09-10", paid: 5000, probable: 5000, probability: "ALTA" },
    registered: null, meetings: [], temperature: null, temperature_readings: [], social_leads: null, whatsapp: [], radar: [],
    campaigns: [{ id: "c1", campaign: "Leads", platform: "meta", goal_results: 100, budget: 3000, multiplier: 1, start: "2026-09-01",
      end: "2026-09-30", last: { taken_on: "2026-09-29", spend: 3000, results: 120, goal_status: "good" } }],
  },
};

describe("worker da sugestão de Health Score", () => {
  it("sem o segredo, 401", async () => {
    const res = await handleCsHsWorker("Bearer errado", env, { fetch: vi.fn() as never, llm: vi.fn(), embed: vi.fn() });
    expect(res.status).toBe(401);
  });
  it("pega os pendentes, junta os dados e a MAVI e grava com o custo", async () => {
    const stored: unknown[] = [];
    let claims = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.p_secret).toBe(env.workerSecret);
      if (url.endsWith("/rpc/cs_hs_claim")) return Response.json(claims++ === 0 ? [job] : []);
      if (url.endsWith("/rpc/ai_worker_route")) return Response.json(null);
      if (url.endsWith("/rpc/cs_hs_store")) {
        stored.push(...body.p_items);
        return Response.json(body.p_items.length);
      }
      return Response.json(null);
    }) as unknown as typeof fetch;
    const llm = vi.fn(async () => ({
      text: '{"goal":{"value":true,"confidence":"alta","why":"Campanha BOM.","evidence":["C1"]},"perception":{"value":null},"creatives":{"value":null}}',
      meter: { model: "claude-haiku", input: 900, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.0021 },
    }));
    const res = await handleCsHsWorker(`Bearer ${env.workerSecret}`, env, { fetch: fetchImpl, llm: llm as never, embed: vi.fn() });
    expect(res).toEqual({ status: 200, body: { done: 1, failed: 0 } });
    const it = stored[0] as Record<string, any>;
    expect(it.criteria.goal).toMatchObject({ value: true, evidence: [{ type: "campaign", id: "c1" }] });
    expect(it.criteria.payment.value).toBe(true);
    expect(it.criteria.meeting.value).toBe(false);
    expect(it.score).toBe(50);
    expect(it.band).toBe("ALERTA");
    expect(it.usage).toMatchObject({ input: 900, cost: 0.0021 });
    expect((llm.mock.calls[0] as unknown as [{ messages: { content: string }[] }])[0].messages[0].content).toContain("[C1] Leads");
  });
});

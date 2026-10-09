import { describe, expect, it } from "vitest";
import { planRun, type TestLimits } from "./_agent-test-plan";
import { handleAgentTests, testNotice, type TestsWorkerEnv } from "./_agent-tests";

const limits: TestLimits = {
  max_conversations: 10, max_turns: 8, run_cap_usd: 1, monthly_cap_usd: 20, publish_conversations: 4,
  scheduled_enabled: true, scheduled_every_days: 7, scheduled_conversations: 6,
};
const env: TestsWorkerEnv = { supabaseUrl: "https://db.test", supabaseKey: "anon", engineUrl: "https://agentes.test", engineKey: "k", workerSecret: "s".repeat(40) };
const company = "00000000-0000-4000-8000-000000000001";

describe("testes com leads simulados (servidor)", () => {
  it("bateria dentro dos tetos", () => {
    expect(planRun(limits, 0, { kind: "manual", conversations: 30 })).toEqual({ ok: true, plan: { conversations: 10, max_turns: 8, cost_cap_usd: 1 } });
    expect(planRun(limits, 0, { kind: "scheduled" })).toMatchObject({ plan: { conversations: 6 } });
    // Antes de publicar: duas baterias, o que sobra do mês se divide.
    expect(planRun(limits, 19.5, { kind: "publish" })).toEqual({ ok: true, plan: { conversations: 4, max_turns: 8, cost_cap_usd: 0.25 } });
    expect(planRun(limits, 20, { kind: "manual" })).toMatchObject({ ok: false });
  });

  it("aviso só quando achou problema ou lacuna", () => {
    expect(testNotice({ id: "r", agent_id: "a", agent_name: "Clara", summary: { score: 9, issues: {}, gaps: 0 } })).toBeNull();
    expect(testNotice({ id: "r", agent_id: "a", agent_name: "Clara", summary: { score: 7.5, issues: { tone: { n: 2 } }, gaps: 1, conclusion: "Trava em preço." } })).toEqual({
      title: "Teste periódico de Clara: nota 7,5 · 2 problema(s) · 1 lacuna(s)",
      body: "Trava em preço.",
      link: "/agente-conversacional?agente=a&aba=testes&bateria=r",
    });
  });

  it("rotina: só com o segredo; começa as vencidas (no teto do mês, só marca) e avisa as terminadas", async () => {
    const calls: { url: string; method: string; body: any }[] = [];
    const json = (b: unknown) => new Response(JSON.stringify(b));
    const agents = [
      { id: "a1", name: "Clara", status: "active", published_version: 2, bindings: 1, draft_updated_by: "ana@x.com", external_ref: { mavi_company_id: company, mavi_client_id: "c1" } },
      { id: "a2", name: "Bia", status: "active", published_version: 1, bindings: 1, external_ref: { mavi_company_id: company, mavi_client_id: "c1" } },
      { id: "a3", name: "Sem caixa", status: "active", published_version: 1, bindings: 0, external_ref: { mavi_company_id: company } },
    ];
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = String(u);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === "https://agentes.test/v1/agents") return json({ agents });
      if (url.endsWith("/rpc/agent_test_due")) return json(body.p_agents.map((a: { agent_id: string }) => ({ agent_id: a.agent_id, limits })));
      if (url.includes("/v1/agents/a1/test-runs?limit=1")) return json({ month_cost_usd: 0 });
      if (url.includes("/v1/agents/a2/test-runs?limit=1")) return json({ month_cost_usd: 25 });
      if (url.endsWith("/v1/agents/a1/test-runs") && method === "POST") return json({ runs: ["run-a1"] });
      if (url.endsWith("/rpc/agent_test_since")) return json("2026-10-08T00:00:00Z");
      if (url.endsWith("/v1/test-runs/finished"))
        return json({ runs: [{ id: "old", agent_id: "a1", agent_name: "Clara", status: "done", summary: { score: 6, issues: { wrong_info: { n: 1 } }, gaps: 0 } }] });
      return json(1);
    }) as typeof fetch;
    expect((await handleAgentTests("Bearer x", env, { fetch: f })).status).toBe(401);
    const r = await handleAgentTests(`Bearer ${env.workerSecret}`, env, { fetch: f });
    expect(r.body).toEqual({ started: 1, capped: 1, notified: 1, failed: 0 });
    expect(calls.find((c) => c.url.endsWith("/rpc/agent_test_due"))!.body.p_agents.map((a: { agent_id: string }) => a.agent_id)).toEqual(["a1", "a2"]);
    expect(calls.find((c) => c.url.endsWith("/v1/agents/a1/test-runs") && c.method === "POST")!.body).toMatchObject({
      kind: "scheduled",
      use: "published",
      conversations: 6,
      max_turns: 8,
      cost_cap_usd: 1,
    });
    const marked = calls.filter((c) => c.url.endsWith("/rpc/agent_test_scheduled")).map((c) => [c.body.p_agent, c.body.p_run]);
    expect(marked).toEqual([["a1", "run-a1"], ["a2", null]]);
    expect(calls.find((c) => c.url.endsWith("/rpc/agent_test_notify"))!.body).toMatchObject({ p_run: "old", p_agent: "a1", p_client: "c1", p_creator: "ana@x.com" });
  });
});

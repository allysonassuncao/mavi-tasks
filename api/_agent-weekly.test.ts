import { describe, expect, it } from "vitest";
import { handleAgentWeekly, lastWeek, weeklyNotice, type WeeklyEnv } from "./_agent-weekly";

const env: WeeklyEnv = {
  supabaseUrl: "https://db.test",
  supabaseKey: "anon",
  engineUrl: "https://agentes.test",
  engineKey: "mva_key",
  workerSecret: "s".repeat(40),
  budgetMs: 240_000,
};
const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const report = (conversations: number) => ({ report: { metrics: { conversations, meetings: 3, handoffs: 1 }, gaps: { coverage: 0.91 } } });

function fake() {
  const calls: { url: string; method: string; body: any }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const agents = [
    { id: "a1", name: "Clara", published_version: 2, bindings: 1, draft_updated_by: "ana@x.com", external_ref: { mavi_company_id: company, mavi_client_id: client } },
    { id: "a2", name: "Sem caixa", published_version: 1, bindings: 0, external_ref: { mavi_company_id: company, mavi_client_id: client } },
    { id: "a3", name: "Quieto", published_version: 1, bindings: 1, external_ref: { mavi_company_id: company, mavi_client_id: client } },
  ];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url === "https://agentes.test/v1/agents") return json({ agents });
    if (url.endsWith("/rpc/agent_report_targets"))
      return json(body.p_agents.map((a: { agent_id: string }) => ({ agent_id: a.agent_id, recipients: ["u1"] })));
    if (url.includes("/v1/agents/a1/report")) return json(report(12));
    if (url.includes("/v1/agents/a3/report")) return json(report(0));
    if (url.endsWith("/v1/agents/a1/reading")) return json({ reading: { reading: { summary: "Semana boa." } } });
    if (url.endsWith("/rpc/agent_report_send")) return json(1);
    return json({ error: "?" }, 404);
  }) as typeof fetch;
  return { f, calls };
}

describe("resumo semanal dos agentes", () => {
  it("a semana anterior, de segunda a domingo (Brasília)", () => {
    // Segunda, 12/10/2026 às 8h de Brasília (11h UTC).
    expect(lastWeek(new Date("2026-10-12T11:00:00Z"))).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    // Domingo às 23h de Brasília ainda é a semana de 05/10.
    expect(lastWeek(new Date("2026-10-12T02:00:00Z"))).toEqual({ from: "2026-09-28", to: "2026-10-04" });
  });

  it("o aviso leva os números, a leitura e o link da aba", () => {
    const n = weeklyNotice({ id: "a1", name: "Clara" }, { from: "2026-10-05", to: "2026-10-11" }, report(12).report, "Semana boa.");
    expect(n.title).toBe("Clara: a semana de 05/10 a 11/10");
    expect(n.body).toBe("12 conversas · 3 reuniões marcadas · 1 passada para a equipe · cobertura do treinamento 91%. Semana boa.");
    expect(n.link).toBe("/agente-conversacional?agente=a1&aba=insights&de=2026-10-05&ate=2026-10-11");
  });

  it("só o agendamento chama; agentes sem caixa ficam de fora; semana sem conversa não gasta leitura", async () => {
    const { f, calls } = fake();
    expect((await handleAgentWeekly("Bearer errado", env, { fetch: f })).status).toBe(401);
    const r = await handleAgentWeekly(`Bearer ${env.workerSecret}`, env, { fetch: f, now: () => Date.parse("2026-10-12T11:00:00Z") });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ week: { from: "2026-10-05", to: "2026-10-11" }, agents: 2, sent: 1, quiet: 1, failed: 0 });
    const targets = calls.find((c) => c.url.endsWith("/rpc/agent_report_targets"))!;
    expect(targets.body.p_secret).toBe(env.workerSecret);
    expect(targets.body.p_agents.map((a: { agent_id: string }) => a.agent_id)).toEqual(["a1", "a3"]);
    expect(targets.body.p_agents[0].creator).toBe("ana@x.com");
    expect(calls.some((c) => c.url.endsWith("/v1/agents/a3/reading"))).toBe(false);
    const send = calls.find((c) => c.url.endsWith("/rpc/agent_report_send"))!;
    expect(send.body).toMatchObject({ p_agent: "a1", p_company: company, p_week: "2026-10-05", p_users: ["u1"] });
  });
});

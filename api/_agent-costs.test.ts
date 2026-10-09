import { describe, expect, it } from "vitest";
import { costGroup, fetchPtax, handleAgentCostsSync, mapDailyRows, type CostsSyncEnv } from "./_agent-costs";
import { costQuery } from "./_agent-builder";

const env: CostsSyncEnv = { supabaseUrl: "https://db.test", supabaseKey: "anon", engineUrl: "https://agentes.test", engineKey: "k", workerSecret: "s".repeat(40) };
const company = "00000000-0000-4000-8000-000000000001";

describe("custos dos agentes (servidor)", () => {
  it("grupos dos tipos de gasto", () => {
    expect(["reply", "followup", "media_audio", "retrieval", "insight", "waba_template", "test_lead"].map(costGroup)).toEqual([
      "ia", "ia", "midias", "conhecimento", "analises", "whatsapp", "testes",
    ]);
  });

  it("PTAX: um valor por dia (o último publicado)", async () => {
    let url = "";
    const f = (async (u: RequestInfo | URL) => {
      url = String(u);
      return new Response(JSON.stringify({ value: [
        { cotacaoVenda: 5.41, dataHoraCotacao: "2026-10-08 13:03:21.1" },
        { cotacaoVenda: 5.52, dataHoraCotacao: "2026-10-09 13:05:00.0" },
      ] }));
    }) as typeof fetch;
    expect(await fetchPtax(f, "2026-10-01", "2026-10-09")).toEqual([
      { day: "2026-10-08", usd_brl: 5.41 },
      { day: "2026-10-09", usd_brl: 5.52 },
    ]);
    expect(url).toContain("@dataInicial='10-01-2026'&@dataFinalCotacao='10-09-2026'");
  });

  it("somas do motor ganham cliente/produto do MAVI; agente de fora fica de fora", () => {
    const rows = mapDailyRows(
      [
        { day: "2026-10-09", agent_id: "a1", company_id: "crm", inbox_id: "i1", source: "media_audio", model: "m", simulation: false, events: 2, cost_usd: 0.01, tokens_in: 10, tokens_out: 1, units: 30 },
        { day: "2026-10-09", agent_id: "x", company_id: "crm", inbox_id: "", source: "reply", model: "m", simulation: false, events: 1, cost_usd: 0.1, tokens_in: 1, tokens_out: 1, units: 0 },
      ],
      [{ id: "a1", name: "Clara", external_ref: { mavi_company_id: company, mavi_client_id: "c1", mavi_contract_id: "k1" } }, { id: "x", name: "Outro", external_ref: {} }],
      [{ inbox_id: "i1", inbox_name: "WhatsApp" }],
    );
    expect(rows).toEqual([
      expect.objectContaining({ agent_id: "a1", agent_name: "Clara", company_id: company, client_id: "c1", contract_id: "k1", inbox_name: "WhatsApp", cost_group: "midias" }),
    ]);
  });

  it("sincronização: só com o segredo; guarda PTAX e somas dos últimos 3 dias", async () => {
    const calls: { url: string; body: any }[] = [];
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = String(u);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes("olinda.bcb.gov.br")) return new Response(JSON.stringify({ value: [{ cotacaoVenda: 5.5, dataHoraCotacao: "2026-10-09 13:00:00" }] }));
      if (url.endsWith("/v1/costs/daily")) return new Response(JSON.stringify({ rows: [], agents: [], inboxes: [] }));
      return new Response("1");
    }) as typeof fetch;
    expect((await handleAgentCostsSync("Bearer x", env, { fetch: f })).status).toBe(401);
    const r = await handleAgentCostsSync(`Bearer ${env.workerSecret}`, env, { fetch: f, now: () => Date.parse("2026-10-09T15:00:00Z") });
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.url.endsWith("/v1/costs/daily"))!.body).toEqual({ from: "2026-10-07", to: "2026-10-09" });
    expect(calls.find((c) => c.url.endsWith("/rpc/fx_ptax_store"))!.body.p_rows).toEqual([{ day: "2026-10-09", usd_brl: 5.5 }]);
    expect(calls.find((c) => c.url.endsWith("/rpc/agent_costs_store"))!.body).toMatchObject({ p_from: "2026-10-07", p_to: "2026-10-09", p_secret: env.workerSecret });
  });

  it("filtro do relatório conferido antes do motor", () => {
    expect(() => costQuery({ from: "2026-10-09", to: "2026-10-01" })).toThrow();
    expect(costQuery({ from: "2026-10-01", to: "2026-10-09", group: "x", sources: ["reply", "hack"], simulation: "?" })).toMatchObject({
      group: "source",
      sources: ["reply"],
      simulation: "exclude",
    });
  });
});

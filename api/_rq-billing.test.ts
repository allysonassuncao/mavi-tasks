import { describe, expect, it } from "vitest";
import { handleCrm } from "./_crm";
import { rqCompute, rqLeadsFrom, rqMatches, rqMonthRange, rqRevenue, type RqConfig, type RqLead } from "./_rq-billing";

const lead = (key: string, extra: Partial<RqLead> = {}): RqLead => ({
  key,
  deal_id: key,
  name: `Lead ${key}`,
  contact: "",
  phone: "",
  at: "2026-09-10T12:00:00Z",
  estimated: false,
  value: 0,
  status: 1,
  stage: "Reunião",
  created_at: null,
  source_id: null,
  source: "",
  campaign_id: null,
  campaign: "",
  utms: [],
  ...extra,
});
const meeting: RqConfig = {
  model: "meeting",
  pipeline_id: "p",
  pipeline_name: "Vendas",
  stage_id: "s",
  stage_name: "Reunião qualificada",
  price_kind: "fixed",
  unit_price: 150,
  percent: null,
  contract_kind: "variable",
  fixed_amount: null,
  cap: null,
  lead_filter: { mode: "all" },
};

describe("quais leads contam", () => {
  it("UTM: precisa de alguma UTM e, escolhidos, do utm_source", () => {
    const meta = lead("1", { utms: [{ s: "Facebook", c: "RQ" }] });
    const none = lead("2", { utms: [{ s: " ", c: "" }] });
    expect(rqMatches(meta, { mode: "utm" })).toBe(true);
    expect(rqMatches(none, { mode: "utm" })).toBe(false);
    expect(rqMatches(meta, { mode: "utm", utm_sources: ["facebook"] })).toBe(true);
    expect(rqMatches(meta, { mode: "utm", utm_sources: ["google"] })).toBe(false);
  });
  it("CRM: origem e campanha; escolhidas as duas, bate nas duas", () => {
    const l = lead("1", { source_id: "7", campaign_id: "9" });
    expect(rqMatches(l, { mode: "crm", sources: [{ id: "7", name: "Meta" }] })).toBe(true);
    expect(rqMatches(l, { mode: "crm", sources: [{ id: "8", name: "Google" }] })).toBe(false);
    expect(rqMatches(l, { mode: "crm", sources: [{ id: "7", name: "" }], campaigns: [{ id: "1", name: "" }] })).toBe(false);
    expect(rqMatches(lead("2"), { mode: "crm", campaigns: [{ id: "9", name: "" }] })).toBe(false);
    expect(rqMatches(lead("2"), { mode: "crm" })).toBe(true);
  });
});

describe("receita do contrato", () => {
  it("variável, fixo + variável, mínimo garantido e teto", () => {
    expect(rqRevenue(meeting, 4, 0)).toMatchObject({ variable: 600, total: 600 });
    expect(rqRevenue({ ...meeting, contract_kind: "fixed_plus", fixed_amount: 500 }, 4, 0)).toMatchObject({
      fixed: 500,
      total: 1100,
    });
    const min = rqRevenue({ ...meeting, contract_kind: "minimum", fixed_amount: 1000 }, 4, 0);
    expect(min).toMatchObject({ variable: 600, fixed: 400, total: 1000, minimum_applied: true });
    expect(rqRevenue({ ...meeting, contract_kind: "minimum", fixed_amount: 1000 }, 8, 0).minimum_applied).toBe(false);
    expect(rqRevenue({ ...meeting, cap: 900 }, 8, 0)).toMatchObject({ variable: 1200, total: 900, capped: true });
    const sale: RqConfig = { ...meeting, model: "sale", price_kind: "percent", unit_price: null, percent: 7.5 };
    expect(rqRevenue(sale, 2, 10000.1).total).toBe(750.01);
  });
});

describe("a conta do mês", () => {
  it("filtro, ajustes, cobrados em outro mês e a mídia", () => {
    const rows = [
      lead("a", { at: "2026-09-03T10:00:00Z", source_id: "7" }),
      lead("b", { at: "2026-09-01T10:00:00Z", source_id: "8" }),
      lead("c", { at: "2026-09-02T10:00:00Z", source_id: "7", estimated: true }),
      lead("d", { source_id: "7" }),
      lead("e", { source_id: "8" }),
      lead("a", { source_id: "7" }),
    ];
    const config: RqConfig = { ...meeting, lead_filter: { mode: "crm", sources: [{ id: "7", name: "Meta" }] } };
    const r = rqCompute(
      config,
      rows,
      [
        { key: "b", action: "include", reason: "Veio do Meta", lead: {}, created_at: "x", by: "Ana" },
        { key: "c", action: "exclude", reason: "Duplicado", lead: {}, created_at: "x", by: "Ana" },
        { key: "z", action: "include", reason: "Mudou de etapa", lead: { name: "Zé", at: "2026-09-20T00:00:00Z" }, created_at: "x", by: "Ana" },
      ],
      { d: "2026-08" },
      { net: "300", gross: 450 },
    );
    expect(r.leads.map((l) => l.key)).toEqual(["b", "a", "z"]);
    expect(r.leads[0].adjustment?.reason).toBe("Veio do Meta");
    expect(r.leads[2]).toMatchObject({ manual: true, name: "Zé" });
    expect(r.outside.map((l) => [l.key, l.outside])).toEqual([
      ["c", "excluded"],
      ["d", "billed"],
      ["e", "filtered"],
    ]);
    expect(r.outside[1].billed_month).toBe("2026-08");
    expect(r.totals).toMatchObject({
      count: 3,
      total: 450,
      spend_net: 300,
      spend_gross: 450,
      result: 150,
      margin: 0.333,
      media_per_lead: 100,
      revenue_per_lead: 150,
      estimated: 0,
    });
  });
  it("lê só o que é bem formado do CRM", () => {
    const rows = rqLeadsFrom({ rows: [{ key: "a", deal_id: "a", value: "12.5", estimated: true }, { key: 1 }, null] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: 12.5, estimated: true, utms: [] });
    expect(rqLeadsFrom(null)).toEqual([]);
  });
  it("o mês em Brasília", () => {
    expect(rqMonthRange("2026-02")).toEqual({
      start: "2026-02-01T00:00:00.000-03:00",
      end: "2026-02-28T23:59:59.999-03:00",
    });
    expect(rqMonthRange("2026-13")).toBeNull();
  });
});

describe("/api/crm rq-month e rq-validate", () => {
  const SECRET = "s".repeat(48);
  const env = { supabaseUrl: "https://db.test", supabaseKey: "anon", crmUrl: "https://crm.test", secret: SECRET };
  const company = "00000000-0000-4000-8000-000000000001";
  const client = "00000000-0000-4000-8000-000000000020";
  const crmCompany = "11111111-2222-4333-8444-555555555555";
  const view = (extra: Record<string, unknown> = {}) => ({
    client,
    client_name: "Vittalium",
    month: "2026-09",
    config: meeting,
    closing: null,
    adjustments: [],
    billed: {},
    spend: { net: 100, gross: 150, campaigns: 1 },
    crm_company_id: crmCompany,
    ...extra,
  });
  function fake(month: unknown) {
    const calls: { url: string; body: any }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      const out = url.endsWith("/rpc/rq_month")
        ? month
        : url.endsWith("/rpc/rq_validate")
          ? { status: "validated" }
          : { rows: [lead("a"), lead("b")] };
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch;
    return { impl, calls };
  }

  it("conta ao vivo pelo CRM e não devolve a empresa do CRM", async () => {
    const f = fake(view());
    const r = await handleCrm({ action: "rq-month", company, client, month: "2026-09" }, "Bearer x", env, f.impl);
    expect(r.status).toBe(200);
    expect((r.body as any).result.totals).toMatchObject({ count: 2, total: 300, result: 200 });
    expect((r.body as any).view.crm_company_id).toBeUndefined();
    const crm = f.calls.find((c) => c.url.endsWith("/api/mavi-sso"))!;
    expect(crm.body).toMatchObject({
      action: "billing",
      company_id: crmCompany,
      mode: "meeting",
      pipeline_id: "p",
      stage_id: "s",
      date_start: "2026-09-01T00:00:00.000-03:00",
      date_end: "2026-09-30T23:59:59.999-03:00",
    });
  });
  it("validado: o congelado, sem perguntar ao CRM", async () => {
    const f = fake(view({ closing: { status: "validated", leads: [{ key: "a" }], totals: { count: 1 } } }));
    const r = await handleCrm({ action: "rq-month", company, client, month: "2026-09" }, "Bearer x", env, f.impl);
    expect((r.body as any).frozen).toBe(true);
    expect((r.body as any).result.leads).toEqual([{ key: "a" }]);
    expect(f.calls.some((c) => c.url.includes("mavi-sso"))).toBe(false);
  });
  it("sem regra ou sem CRM, avisa o que falta", async () => {
    let r = await handleCrm({ action: "rq-month", company, client, month: "2026-09" }, "Bearer x", env, fake(view({ config: null })).impl);
    expect((r.body as any).missing).toBe("config");
    r = await handleCrm({ action: "rq-month", company, client, month: "2026-09" }, "Bearer x", env, fake(view({ crm_company_id: null })).impl);
    expect((r.body as any).missing).toBe("crm");
  });
  it("validar conta de novo e congela só a regra, os leads e os totais", async () => {
    const f = fake(view({ config: { ...meeting, updated_at: "x", updated_by_name: "Ana" } }));
    const r = await handleCrm({ action: "rq-validate", company, client, month: "2026-09" }, "Bearer x", env, f.impl);
    expect(r.status).toBe(200);
    const saved = f.calls.find((c) => c.url.endsWith("/rpc/rq_validate"))!.body;
    expect(saved.p_result.config.updated_at).toBeUndefined();
    expect(saved.p_result.leads.map((l: any) => l.key)).toEqual(["a", "b"]);
    expect(saved.p_result.totals.total).toBe(300);
  });
  it("mês inválido", async () => {
    const r = await handleCrm({ action: "rq-month", company, client, month: "set" }, "Bearer x", env, fake(view()).impl);
    expect(r.status).toBe(400);
  });
});

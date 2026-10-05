import { describe, expect, it } from "vitest";
import { crmEnv, crmUtmFunnel, funnelFrom, handleCrm } from "./_crm";

const SECRET = "s".repeat(48);
const env = {
  supabaseUrl: "https://db.test",
  supabaseKey: "anon",
  crmUrl: "https://crm.test",
  secret: SECRET,
};
const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000020";
const crmCompany = "11111111-2222-4333-8444-555555555555";
const person = "00000000-0000-4000-8000-000000000010";
const auth = "Bearer user-jwt";

type Call = { url: string; body: any; headers: Record<string, string> };
function fake(answer: (url: string, body: any) => [number, unknown]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    const [status, out] = answer(url, body);
    return new Response(JSON.stringify(out), { status });
  }) as typeof fetch;
  return { impl, calls };
}
const opened = {
  crm_company_id: crmCompany,
  user_id: person,
  email: "tiago@make.com",
  name: "Tiago Tráfego",
  role: "member",
};

describe("Abrir no CRM", () => {
  it("o banco confere e o MakeCRM devolve o link de entrada", async () => {
    const f = fake((url) =>
      url.includes("/rpc/")
        ? [200, opened]
        : [200, { url: "https://crm.test/entrar-mavi#token_hash=abc" }],
    );
    const r = await handleCrm(
      { action: "open", company, client },
      auth,
      env,
      f.impl,
    );
    expect(r).toEqual({
      status: 200,
      body: { url: "https://crm.test/entrar-mavi#token_hash=abc" },
    });
    const [db, crm] = f.calls;
    expect(db.url).toBe("https://db.test/rest/v1/rpc/crm_open");
    expect(db.headers.Authorization).toBe(auth);
    expect(db.body).toEqual({ p_company: company, p_client: client });
    expect(crm.url).toBe("https://crm.test/api/mavi-sso");
    expect(crm.headers["X-Mavi-Secret"]).toBe(SECRET);
    // The person's MAVI login never goes to the MakeCRM.
    expect(JSON.stringify(crm)).not.toContain("user-jwt");
    expect(crm.body).toEqual({
      action: "login",
      company_id: crmCompany,
      person: { id: person, email: "tiago@make.com", name: "Tiago Tráfego" },
      role: "member",
    });
  });

  it("sem acesso ao cliente, o MakeCRM nem é chamado", async () => {
    const f = fake(() => [
      403,
      { message: "Sem permissão: este cliente não é de uma equipe sua" },
    ]);
    const r = await handleCrm(
      { action: "open", company, client },
      auth,
      env,
      f.impl,
    );
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Sem permissão/);
    expect(f.calls).toHaveLength(1);
  });

  it("só devolve link do próprio MakeCRM", async () => {
    const f = fake((url) =>
      url.includes("/rpc/")
        ? [200, opened]
        : [200, { url: "https://evil.test/x" }],
    );
    const r = await handleCrm(
      { action: "open", company, client },
      auth,
      env,
      f.impl,
    );
    expect(r.status).toBe(502);
  });

  it("segredo recusado vira erro de configuração; o erro do MakeCRM chega à pessoa", async () => {
    let f = fake((url) =>
      url.includes("/rpc/") ? [200, opened] : [401, { error: "x" }],
    );
    let r = await handleCrm(
      { action: "open", company, client },
      auth,
      env,
      f.impl,
    );
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/MAKECRM_SSO_SECRET/);
    f = fake((url) =>
      url.includes("/rpc/")
        ? [200, opened]
        : [409, { error: "Empresa inativa no MakeCRM." }],
    );
    r = await handleCrm({ action: "open", company, client }, auth, env, f.impl);
    expect(r).toEqual({
      status: 409,
      body: { error: "Empresa inativa no MakeCRM." },
    });
  });

  it("lista as empresas só para líderes", async () => {
    const companies = [
      { id: crmCompany, make_id: 4321, active: true, admins: [] },
    ];
    let f = fake((url) =>
      url.includes("/rpc/") ? [200, true] : [200, { companies }],
    );
    let r = await handleCrm(
      { action: "companies", company },
      auth,
      env,
      f.impl,
    );
    expect(r).toEqual({ status: 200, body: { companies } });
    expect(f.calls[0].url).toBe("https://db.test/rest/v1/rpc/crm_link_admin");
    expect(f.calls[1].body).toEqual({ action: "companies" });
    f = fake(() => [
      403,
      {
        message:
          "Sem permissão: só administradores e gestores ligam clientes ao CRM",
      },
    ]);
    r = await handleCrm({ action: "companies", company }, auth, env, f.impl);
    expect(r.status).toBe(403);
    expect(f.calls).toHaveLength(1);
  });

  it("sem login, sem segredo ou com dados inválidos", async () => {
    const f = fake(() => [200, {}]);
    expect(
      (await handleCrm({ action: "open", company, client }, null, env, f.impl))
        .status,
    ).toBe(401);
    expect(
      (
        await handleCrm(
          { action: "open", company, client },
          auth,
          { ...env, secret: null },
          f.impl,
        )
      ).body.error,
    ).toMatch(/MAKECRM_SSO_SECRET/);
    expect(
      (
        await handleCrm(
          { action: "open", company, client: "x" },
          auth,
          env,
          f.impl,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleCrm(
          { action: "open", company: "x", client },
          auth,
          env,
          f.impl,
        )
      ).status,
    ).toBe(400);
    expect(
      (await handleCrm({ action: "outra", company }, auth, env, f.impl)).status,
    ).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it("segredo curto não liga o atalho; endereço sem barra final", () => {
    expect(crmEnv({ MAKECRM_SSO_SECRET: "curto" }).secret).toBeNull();
    expect(
      crmEnv({ MAKECRM_SSO_SECRET: SECRET, MAKECRM_URL: "https://x.test/" }),
    ).toMatchObject({
      secret: SECRET,
      crmUrl: "https://x.test",
    });
    expect(crmEnv({}).crmUrl).toBe("https://app.usemakecrm.com.br");
  });
});

describe("Oportunidades por UTM (Plataforma)", () => {
  const deals = {
    campaigns: [["[774] Leads", 5, 2, 1, 3000]],
    adsets: [["[774] Leads", "[001] Aberto", 4, 2, 1, 3000], ["ruim", 1]],
    ads: [["[774] Leads", "[001] Aberto", "AD002", 6, 2, 1, 3000]],
  };

  it("lê a ligação com o login da pessoa e pede ao MakeCRM o período no dia de Brasília", async () => {
    const f = fake((url) =>
      url.includes("/rest/v1/client_crm_links")
        ? [200, [{ crm_company_id: crmCompany }]]
        : [200, deals],
    );
    const r = await handleCrm(
      { action: "utm", company, client, since: "2026-09-27", until: "2026-10-03" },
      auth,
      env,
      f.impl,
    );
    expect(r).toEqual({
      status: 200,
      body: {
        linked: true,
        campaigns: deals.campaigns,
        // Linhas fora do formato ficam de fora.
        adsets: [deals.adsets[0]],
        ads: deals.ads,
      },
    });
    const [db, crm] = f.calls;
    expect(db.url).toBe(
      `https://db.test/rest/v1/client_crm_links?select=crm_company_id&company_id=eq.${company}&client_id=eq.${client}`,
    );
    expect(db.headers.Authorization).toBe(auth);
    expect(crm.headers["X-Mavi-Secret"]).toBe(SECRET);
    expect(JSON.stringify(crm)).not.toContain("user-jwt");
    expect(crm.body).toEqual({
      action: "utm-deals",
      company_id: crmCompany,
      date_start: "2026-09-27T00:00:00.000-03:00",
      date_end: "2026-10-03T23:59:59.999-03:00",
    });
  });

  it("cliente sem ligação (ou que a pessoa não vê): nada vai ao MakeCRM", async () => {
    const f = fake(() => [200, []]);
    const r = await handleCrm(
      { action: "utm", company, client, since: "2026-09-27", until: "2026-10-03" },
      auth,
      env,
      f.impl,
    );
    expect(r).toEqual({ status: 200, body: { linked: false } });
    expect(f.calls).toHaveLength(1);
  });

  it("\"Máximo\" pede desde o começo; período inválido nem consulta", async () => {
    const f = fake((url) =>
      url.includes("/rest/v1/") ? [200, [{ crm_company_id: crmCompany }]] : [200, deals],
    );
    await handleCrm({ action: "utm", company, client, since: "", until: "2026-10-03" }, auth, env, f.impl);
    expect(f.calls[1].body.date_start).toBe("2000-01-01T00:00:00.000-03:00");
    const g = fake(() => [200, []]);
    for (const p of [
      { since: "2026-10-05", until: "2026-10-03" },
      { since: "ontem", until: "2026-10-03" },
      { since: "2026-10-01", until: "" },
    ])
      expect((await handleCrm({ action: "utm", company, client, ...p }, auth, env, g.impl)).status).toBe(400);
    expect(g.calls).toHaveLength(0);
  });

  it("o erro do MakeCRM chega à pessoa", async () => {
    const f = fake((url) =>
      url.includes("/rest/v1/")
        ? [200, [{ crm_company_id: crmCompany }]]
        : [503, { error: "Falta criar a consulta mavi_utm_deals no banco do MakeCRM." }],
    );
    const r = await handleCrm(
      { action: "utm", company, client, since: "2026-09-27", until: "2026-10-03" },
      auth,
      env,
      f.impl,
    );
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/mavi_utm_deals/);
  });

  it("abre o funil filtrado; outro destino é recusado", async () => {
    const f = fake((url) =>
      url.includes("/rpc/") ? [200, opened] : [200, { url: "https://crm.test/entrar-mavi#token_hash=abc&next=x" }],
    );
    const next = "/pipeline-v2?utmCampaign=%5B774%5D+Leads&createdFrom=2026-09-27T03%3A00%3A00.000Z";
    const r = await handleCrm({ action: "open", company, client, next }, auth, env, f.impl);
    expect(r.status).toBe(200);
    expect(f.calls[1].body.next).toBe(next);
    for (const bad of ["https://evil.test/", "//evil.test", "/settings", "/pipeline-v2?a=1#x"])
      expect(
        (await handleCrm({ action: "open", company, client, next: bad }, auth, env, f.impl)).status,
      ).toBe(400);
    expect(f.calls).toHaveLength(2);
  });
});

describe("Funil por UTM (Insights da MAVI)", () => {
  it("pede ao MakeCRM com o segredo, no dia de Brasília, e só aceita o que é bem formado", async () => {
    const { impl, calls } = fake(() => [
      200,
      {
        rows: [
          { l: "c", c: "Motion", t: "", n: "", deals: 3, open: 1, won: 1, lost: 1, qualified: 2, score: "6.5", at: { s2: 1 }, reach: { s2: 1, s3: 2, x: "1" }, lost_by: null, buckets: { b1: 2 }, answers: {} },
          { l: "z", c: "Inválida" },
          "lixo",
        ],
        pipelines: [{ id: "p1", name: "Vendas" }],
        stages: [{ id: "s2", pipeline_id: "p1", name: "Negociação", order: 2 }],
        reasons: [{ id: 7, name: "Preço" }],
        buckets: [{ id: "b1", name: "Quente", form: "SDR", min: 7, max: 10 }],
        options: [],
      },
    ]);
    const r = await crmUtmFunnel(env, impl, crmCompany, "2026-09-01", "2026-09-30");
    expect(calls[0].url).toBe("https://crm.test/api/mavi-sso");
    expect(calls[0].headers["X-Mavi-Secret"]).toBe(SECRET);
    expect(calls[0].body).toEqual({
      action: "utm-funnel",
      company_id: crmCompany,
      date_start: "2026-09-01T00:00:00.000-03:00",
      date_end: "2026-09-30T23:59:59.999-03:00",
    });
    if (!r.ok) throw Error(r.error);
    expect(r.data.rows).toHaveLength(1);
    expect(r.data.rows[0]).toMatchObject({ deals: 3, score: 6.5, reach: { s2: 1, s3: 2 }, lost_by: null, answers: null });
    expect(r.data.reasons).toEqual([{ id: "7", name: "Preço" }]);
  });

  it("sem a consulta no CRM, o erro chega com o status", async () => {
    const { impl } = fake(() => [503, { error: "Falta criar a consulta mavi_utm_funnel no banco do MakeCRM." }]);
    const r = await crmUtmFunnel(env, impl, crmCompany, "2026-09-01", "2026-09-30");
    // O worker reconhece pela mensagem (o 503 do CRM chega como 502).
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/mavi_utm_funnel/) });
  });
});

describe("A etapa que importa (Fase 6 dos Insights)", () => {
  it("as idades das abertas e os dias típicos até cada etapa (só o bem formado)", () => {
    const f = funnelFrom({
      rows: [{ l: "c", c: "Motion", deals: 3, ages: { "0": 2, "8": "x", "15": 1 } }],
      stage_days: { s2: { median: "6.5", n: 12 }, s3: { median: 4, n: 0 }, s4: null },
    });
    expect(f.rows[0].ages).toEqual({ "0": 2, "15": 1 });
    expect(f.stage_days).toEqual({ s2: { median: 6.5, n: 12 } });
    // A consulta antiga (sem idades): nada quebra.
    expect(funnelFrom({ rows: [{ l: "c", c: "Motion" }] })).toMatchObject({ rows: [{ ages: null }], stage_days: {} });
  });

  it("os funis do cliente: confere a ligação com o login da pessoa e pede ao MakeCRM", async () => {
    const f = fake((url) =>
      url.includes("/rest/v1/client_crm_links")
        ? [200, [{ crm_company_id: crmCompany }]]
        : [
            200,
            {
              pipelines: [{ id: "p1", name: "Vendas", stages: [{ id: "s1", name: "Novo", order: 1 }, { nome: "lixo" }] }, { name: "sem id" }],
              sources: [{ id: 7, name: "Meta" }, { name: "sem id" }],
            },
          ],
    );
    const r = await handleCrm({ action: "pipelines", company, client }, auth, env, f.impl);
    expect(r).toEqual({
      status: 200,
      body: {
        linked: true,
        pipelines: [{ id: "p1", name: "Vendas", stages: [{ id: "s1", name: "Novo", order: 1 }] }],
        sources: [{ id: "7", name: "Meta" }],
        campaigns: [],
      },
    });
    expect(f.calls[0].headers.Authorization).toBe(auth);
    expect(f.calls[1].body).toEqual({ action: "pipelines", company_id: crmCompany });
    // Sem a ligação por Campanhas, tenta pelo Financeiro › Make Ads RQ (rq_crm_company).
    const none = fake((url) => (url.includes("/rpc/rq_crm_company") ? [403, { message: "Sem permissão" }] : [200, []]));
    expect(await handleCrm({ action: "pipelines", company, client }, auth, env, none.impl)).toEqual({
      status: 200,
      body: { linked: false, pipelines: [], sources: [], campaigns: [] },
    });
    expect(none.calls).toHaveLength(2);
    const rq = fake((url) =>
      url.includes("/rpc/rq_crm_company") ? [200, crmCompany] : url.includes("client_crm_links") ? [200, []] : [200, { pipelines: [] }],
    );
    expect((await handleCrm({ action: "pipelines", company, client }, auth, env, rq.impl)).body).toMatchObject({ linked: true });
    expect(rq.calls[2].body).toEqual({ action: "pipelines", company_id: crmCompany });
    expect((await handleCrm({ action: "pipelines", company, client: "x" }, auth, env, none.impl)).status).toBe(400);
  });
});

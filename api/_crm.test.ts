import { describe, expect, it } from "vitest";
import { crmEnv, handleCrm } from "./_crm";

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

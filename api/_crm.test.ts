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
    const body = JSON.parse(String(init.body));
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

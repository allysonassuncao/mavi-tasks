import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_ADS_SCOPE,
  accountId,
  adsEnv,
  handleAds,
  handleAdsCallback,
  missingConfig,
  type AdsEnv,
} from "./_ads";
import { seal, unseal } from "./_google";

const key = crypto.randomBytes(32);
const env: AdsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  tokenKey: key,
  redirectUri: "https://workspace.example.com/api/ads-callback",
  meta: { appId: "app-1", appSecret: "app-secret", version: "v23.0" },
  google: {
    clientId: "client-id",
    clientSecret: "client-secret",
    developerToken: "dev-token",
    version: "v25",
  },
};
const company = "00000000-0000-4000-8000-000000000001";
const auth = "Bearer user-jwt";
const json = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), { status });

type Call = {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
};
/** A fake network: each route answers by "METHOD url", in order. */
function network(routes: [RegExp, (call: Call) => Response][]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: init.body?.toString(),
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw Error(`Rota inesperada: ${call.method} ${url}`);
    return route[1](call);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}
const rpcArgs = (call: Call) => JSON.parse(call.body ?? "{}");

describe("configuração e validação", () => {
  it("lê as variáveis; sem elas a plataforma fica desligada", async () => {
    const e = adsEnv({
      APP_ORIGIN: "https://workspace.example.com",
      GOOGLE_TOKEN_KEY_ADS: key.toString("base64"),
      META_APP_ID: "a",
      META_APP_SECRET: "b",
    });
    expect(e.redirectUri).toBe(
      "https://workspace.example.com/api/ads-callback",
    );
    expect(e.google.version).toBe("v25");
    // The Agenda's variables are not used by Campanhas.
    const agenda = adsEnv({
      GOOGLE_CLIENT_ID: "agenda",
      GOOGLE_CLIENT_SECRET: "agenda",
      GOOGLE_TOKEN_KEY: key.toString("base64"),
      GOOGLE_CLIENT_ID_ADS: "ads-client",
      GOOGLE_CLIENT_SECRET_ADS: "ads-secret",
    });
    expect([
      agenda.tokenKey,
      agenda.google.clientId,
      agenda.google.clientSecret,
    ]).toEqual([null, "ads-client", "ads-secret"]);
    const result = await handleAds(
      { action: "accounts", company, provider: "google" },
      auth,
      e,
      vi.fn() as unknown as typeof fetch,
    );
    expect(result.status).toBe(500);
    expect(result.body.code).toBe("not_configured");
    // It says what is missing (names, never values).
    expect(result.body.error).toBe(
      "A conexão com o Google Ads não está configurada no servidor. Falta na Vercel (Production): GOOGLE_CLIENT_ID_ADS, GOOGLE_CLIENT_SECRET_ADS, GOOGLE_ADS_DEVELOPER_TOKEN. Depois de salvar, faça um Redeploy.",
    );
  });
  it("aponta a chave ausente ou inválida, que vale para as duas plataformas", () => {
    expect(
      missingConfig(adsEnv({ META_APP_ID: "a", META_APP_SECRET: "b" }), "meta"),
    ).toEqual(["GOOGLE_TOKEN_KEY_ADS"]);
    // 64 hex characters (or any text) is not 32 bytes in base64.
    const hex = adsEnv({
      GOOGLE_TOKEN_KEY_ADS: "ab".repeat(32),
      META_APP_ID: "a",
      META_APP_SECRET: "b",
    });
    expect(hex.tokenKey).toBeNull();
    expect(missingConfig(hex, "meta")[0]).toMatch(
      /^GOOGLE_TOKEN_KEY_ADS \(inválida/,
    );
    expect(missingConfig(hex, "google")).toHaveLength(4);
    const ok = adsEnv({
      GOOGLE_TOKEN_KEY_ADS: key.toString("base64"),
      META_APP_ID: "a",
      META_APP_SECRET: "b",
    });
    expect(missingConfig(ok, "meta")).toEqual([]);
  });
  it("a janela Conexões recebe o que falta de cada plataforma", async () => {
    const e = adsEnv({
      GOOGLE_TOKEN_KEY_ADS: key.toString("base64"),
      META_APP_ID: "a",
      META_APP_SECRET: "b",
    });
    const { fetch } = network([
      [/rpc\/ad_connections/, () => json({ meta: null, google: null })],
    ]);
    const result = await handleAds(
      { action: "status", company },
      auth,
      e,
      fetch,
    );
    expect(result.body).toMatchObject({
      meta: { configured: true, missing: [] },
      google: {
        configured: false,
        missing: [
          "GOOGLE_CLIENT_ID_ADS",
          "GOOGLE_CLIENT_SECRET_ADS",
          "GOOGLE_ADS_DEVELOPER_TOKEN",
        ],
      },
    });
  });
  it("exige sessão, empresa e plataforma válidas", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect((await handleAds({}, null, env, f)).status).toBe(401);
    expect(
      (await handleAds({ action: "status", company: "x" }, auth, env, f))
        .status,
    ).toBe(400);
    expect(
      (
        await handleAds(
          { action: "accounts", company, provider: "tiktok" },
          auth,
          env,
          f,
        )
      ).body.error,
    ).toBe("Plataforma inválida.");
  });
  it("normaliza o id da conta", () => {
    expect(accountId("meta", " act_123 ")).toBe("123");
    expect(accountId("google", "123-456-7890")).toBe("1234567890");
    expect(accountId("meta", "abc")).toBeNull();
  });
});

describe("conectar", () => {
  it("Meta: login do Facebook com estado de uso único", async () => {
    const { fetch } = network([
      [/rpc\/ad_begin_connect/, () => json("a".repeat(64))],
    ]);
    const result = await handleAds(
      { action: "connect", company, provider: "meta" },
      auth,
      env,
      fetch,
    );
    const url = new URL(String(result.body.url));
    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/v23.0/dialog/oauth",
    );
    expect(url.searchParams.get("state")).toBe(`meta.${"a".repeat(64)}`);
    expect(url.searchParams.get("scope")).toBe(
      "ads_read,business_management,pages_show_list,pages_read_engagement,pages_manage_metadata,pages_manage_ads,leads_retrieval",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(env.redirectUri);
  });
  it("Meta: a conexão leva o cliente e a campanha de volta", async () => {
    const { fetch, calls } = network([
      [/rpc\/ad_begin_connect/, () => json("c".repeat(64))],
    ]);
    const client = "00000000-0000-4000-8000-0000000000c1";
    const campaign = "00000000-0000-4000-8000-0000000000a1";
    await handleAds(
      { action: "connect", company, provider: "meta", client, campaign },
      auth,
      env,
      fetch,
    );
    expect(rpcArgs(calls[0])).toEqual({
      p_company: company,
      p_provider: "meta",
      p_client: client,
      p_campaign: campaign,
    });
  });
  it("Google: consentimento offline com o escopo do Google Ads", async () => {
    const { fetch, calls } = network([
      [/rpc\/ad_begin_connect/, () => json("b".repeat(64))],
    ]);
    const result = await handleAds(
      { action: "connect", company, provider: "google" },
      auth,
      env,
      fetch,
    );
    expect(rpcArgs(calls[0])).toEqual({
      p_company: company,
      p_provider: "google",
      p_client: null,
      p_campaign: null,
    });
    const url = new URL(String(result.body.url));
    expect(url.searchParams.get("scope")).toContain(GOOGLE_ADS_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe(`google.${"b".repeat(64)}`);
  });
  it("sem permissão no banco, não conecta", async () => {
    const { fetch } = network([
      [
        /rpc\/ad_begin_connect/,
        () =>
          json(
            {
              message:
                "Sem permissão: Campanhas é exclusivo de administradores",
            },
            403,
          ),
      ],
    ]);
    const result = await handleAds(
      { action: "connect", company, provider: "meta" },
      auth,
      env,
      fetch,
    );
    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/exclusivo de administradores/);
  });
});

describe("Meta: desconectar um perfil", () => {
  it("remove só as contas do perfil pedido", async () => {
    const { fetch, calls } = network([
      [/rpc\/ad_disconnect_meta_profile/, () => json(3)],
    ]);
    const result = await handleAds(
      { action: "disconnect", company, provider: "meta", profile: "fb9" },
      auth,
      env,
      fetch,
    );
    expect(result.body).toEqual({ disconnected: true, accounts: 3 });
    expect(JSON.parse(calls[0].body!)).toEqual({
      p_company: company,
      p_fb_user_id: "fb9",
    });
    expect(calls.some((c) => c.url.includes("rpc/ad_disconnect\b"))).toBe(
      false,
    );
  });
});

describe("Meta: campanhas da conta", () => {
  const token = (expires: string | null = null) =>
    [
      /rpc\/ad_meta_token/,
      () =>
        json([
          { token_cipher: seal(key, "fb-token"), token_expires_at: expires },
        ]),
    ] as [RegExp, () => Response];

  it("lê todas as páginas com o token no cabeçalho", async () => {
    const pages = [
      {
        data: [
          {
            id: "1",
            name: "BF",
            effective_status: "ACTIVE",
            objective: "OUTCOME_LEADS",
          },
        ],
        paging: {
          next: "https://graph.facebook.com/v23.0/act_123/campaigns?after=x&access_token=leak",
        },
      },
      { data: [{ id: "2", name: "Remarketing", effective_status: "PAUSED" }] },
    ];
    const { fetch, calls } = network([
      token(),
      [
        /GET https:\/\/graph\.facebook\.com\/v23\.0\/act_123\/campaigns/,
        () => json(pages.shift()),
      ],
    ]);
    const result = await handleAds(
      { action: "campaigns", company, provider: "meta", account: "act_123" },
      auth,
      env,
      fetch,
    );
    expect(result.body.campaigns).toEqual([
      {
        id: "1",
        name: "BF",
        status: "Ativa",
        active: true,
        kind: "OUTCOME_LEADS",
      },
      {
        id: "2",
        name: "Remarketing",
        status: "Pausada",
        active: false,
        kind: "",
      },
    ]);
    const graphCalls = calls.filter((c) => c.url.includes("graph.facebook"));
    expect(graphCalls).toHaveLength(2);
    for (const c of graphCalls) {
      expect(c.headers.Authorization).toBe("Bearer fb-token");
      expect(c.url).not.toContain("access_token");
      expect(new URL(c.url).searchParams.get("appsecret_proof")).toBe(
        crypto
          .createHmac("sha256", "app-secret")
          .update("fb-token")
          .digest("hex"),
      );
    }
    expect(rpcArgs(calls[0])).toEqual({ p_company: company, p_account: "123" });
  });

  it("token vencido ou recusado pede nova conexão", async () => {
    const expired = network([token("2020-01-01T00:00:00Z")]);
    const a = await handleAds(
      { action: "campaigns", company, provider: "meta", account: "123" },
      auth,
      env,
      expired.fetch,
    );
    expect([a.status, a.body.code]).toEqual([409, "expired"]);
    const refused = network([
      token(),
      [
        /graph\.facebook\.com/,
        () => json({ error: { code: 190, message: "x" } }, 400),
      ],
    ]);
    const b = await handleAds(
      { action: "campaigns", company, provider: "meta", account: "123" },
      auth,
      env,
      refused.fetch,
    );
    expect([b.status, b.body.code]).toEqual([409, "expired"]);
  });

  it("conta que ninguém conectou", async () => {
    const { fetch } = network([[/rpc\/ad_meta_token/, () => json([])]]);
    const result = await handleAds(
      { action: "campaigns", company, provider: "meta", account: "999" },
      auth,
      env,
      fetch,
    );
    expect([result.status, result.body.code]).toEqual([404, "not_connected"]);
  });

  it("não segue paginação para fora do Graph", async () => {
    const { fetch, calls } = network([
      token(),
      [
        /graph\.facebook\.com/,
        () =>
          json({ data: [], paging: { next: "https://evil.example/steal" } }),
      ],
    ]);
    const result = await handleAds(
      { action: "campaigns", company, provider: "meta", account: "123" },
      auth,
      env,
      fetch,
    );
    expect(result.status).toBe(502);
    expect(calls.some((c) => c.url.includes("evil"))).toBe(false);
  });

  it("lista as contas conectadas sem expor tokens", async () => {
    const { fetch } = network([
      [
        /rpc\/ad_meta_account_list/,
        () =>
          json([
            {
              account_id: "123",
              name: "Vittalium",
              currency: "BRL",
              account_status: 1,
              token_expires_at: "2026-11-01T00:00:00Z",
              fb_user_id: "fb1",
              fb_user_name: "Ana",
              client_id: "cl-1",
              client_name: "Vittalium",
            },
            {
              account_id: "456",
              name: "Outro cliente",
              currency: "BRL",
              account_status: 1,
              token_expires_at: null,
              fb_user_id: "fb2",
              fb_user_name: "Beto",
              client_id: "cl-2",
              client_name: "Outro",
            },
          ]),
      ],
    ]);
    // Only the client's accounts (the cycle form of its campaign).
    const all = await handleAds(
      { action: "accounts", company, provider: "meta" },
      auth,
      env,
      fetch,
    );
    expect(all.body.accounts).toHaveLength(2);
    const result = await handleAds(
      { action: "accounts", company, provider: "meta", client: "cl-1" },
      auth,
      env,
      fetch,
    );
    expect(result.body.accounts).toEqual([
      {
        id: "123",
        name: "Vittalium",
        status: "Ativa",
        active: true,
        currency: "BRL",
        manager_id: "",
        manager_name: "",
        expires_at: "2026-11-01T00:00:00Z",
        connected_by: "Ana",
        connected_by_id: "fb1",
        client_id: "cl-1",
        client_name: "Vittalium",
      },
    ]);
  });
});

describe("Google Ads", () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const tokens = (access: string | null, expires: string | null) =>
    [
      /rpc\/ad_google_tokens/,
      () =>
        json([
          {
            refresh_token_cipher: seal(key, "refresh-1"),
            access_token_cipher: access ? seal(key, access) : null,
            access_expires_at: expires,
          },
        ]),
    ] as [RegExp, () => Response];

  it("contas: as da MCC, com login-customer-id, sem duplicar", async () => {
    const { fetch, calls } = network([
      tokens("access-1", future),
      [
        /GET .*v25\/customers:listAccessibleCustomers/,
        () => json({ resourceNames: ["customers/111", "customers/222"] }),
      ],
      [
        /POST .*customers\/111\/googleAds:searchStream/,
        () =>
          json([
            {
              results: [
                {
                  customerClient: {
                    id: "111",
                    descriptiveName: "MCC Make",
                    manager: true,
                    status: "ENABLED",
                  },
                },
                {
                  customerClient: {
                    id: "222",
                    descriptiveName: "Vittalium",
                    manager: false,
                    status: "ENABLED",
                    currencyCode: "BRL",
                  },
                },
                {
                  customerClient: {
                    id: "333",
                    descriptiveName: "Aurora",
                    manager: false,
                    status: "SUSPENDED",
                  },
                },
                {
                  customerClient: {
                    id: "444",
                    descriptiveName: "Sub-MCC",
                    manager: true,
                    status: "ENABLED",
                  },
                },
              ],
            },
          ]),
      ],
      [
        /POST .*customers\/222\/googleAds:searchStream/,
        () =>
          json([
            {
              results: [
                {
                  customerClient: {
                    id: "222",
                    descriptiveName: "Vittalium",
                    manager: false,
                    status: "ENABLED",
                  },
                },
              ],
            },
          ]),
      ],
    ]);
    const result = await handleAds(
      { action: "accounts", company, provider: "google" },
      auth,
      env,
      fetch,
    );
    expect(result.body.accounts).toEqual([
      {
        id: "333",
        name: "Aurora",
        status: "SUSPENDED",
        active: false,
        currency: "",
        manager_id: "111",
        manager_name: "MCC Make",
      },
      {
        id: "222",
        name: "Vittalium",
        status: "Ativa",
        active: true,
        currency: "BRL",
        manager_id: "111",
        manager_name: "MCC Make",
      },
    ]);
    const search = calls.filter((c) => c.url.includes("searchStream"));
    expect(search.map((c) => c.headers["login-customer-id"]).sort()).toEqual([
      "111",
      "222",
    ]);
    for (const c of calls.filter((c) => c.url.includes("googleads")))
      expect(c.headers["developer-token"]).toBe("dev-token");
  });

  it("campanhas pela MCC; token vencido é renovado e salvo", async () => {
    const { fetch, calls } = network([
      tokens("old", "2020-01-01T00:00:00Z"),
      [
        /POST https:\/\/oauth2\.googleapis\.com\/token/,
        () => json({ access_token: "access-2", expires_in: 3600 }),
      ],
      [/rpc\/ad_google_save_access/, () => json(null)],
      [
        /POST .*customers\/2223334444\/googleAds:searchStream/,
        () =>
          json([
            {
              results: [
                {
                  campaign: {
                    id: "9",
                    name: "Pesquisa - Marca",
                    status: "ENABLED",
                    advertisingChannelType: "SEARCH",
                  },
                },
                {
                  campaign: {
                    id: "8",
                    name: "PMax",
                    status: "PAUSED",
                    advertisingChannelType: "PERFORMANCE_MAX",
                  },
                },
              ],
            },
          ]),
      ],
    ]);
    const result = await handleAds(
      {
        action: "campaigns",
        company,
        provider: "google",
        account: "222-333-4444",
        manager: "111-000-0000",
      },
      auth,
      env,
      fetch,
    );
    expect(result.body.campaigns).toEqual([
      {
        id: "9",
        name: "Pesquisa - Marca",
        status: "Ativa",
        active: true,
        kind: "SEARCH",
      },
      {
        id: "8",
        name: "PMax",
        status: "Pausada",
        active: false,
        kind: "PERFORMANCE_MAX",
      },
    ]);
    const saved = rpcArgs(calls.find((c) => c.url.includes("save_access"))!);
    expect(unseal(key, saved.p_access_cipher)).toBe("access-2");
    const search = calls.find((c) => c.url.includes("searchStream"))!;
    expect(search.headers.Authorization).toBe("Bearer access-2");
    expect(search.headers["login-customer-id"]).toBe("1110000000");
    expect(JSON.parse(search.body!).query).toContain("FROM campaign");
  });

  it("consentimento revogado desconecta e pede nova conexão", async () => {
    const { fetch, calls } = network([
      tokens(null, null),
      [
        /oauth2\.googleapis\.com\/token/,
        () => json({ error: "invalid_grant" }, 400),
      ],
      [/rpc\/ad_disconnect/, () => json(null)],
    ]);
    const result = await handleAds(
      { action: "campaigns", company, provider: "google", account: "1" },
      auth,
      env,
      fetch,
    );
    expect([result.status, result.body.code]).toEqual([409, "not_connected"]);
    expect(
      rpcArgs(calls.find((c) => c.url.includes("ad_disconnect"))!),
    ).toEqual({ p_company: company, p_provider: "google" });
  });
});

describe("retorno da plataforma (callback)", () => {
  const state = "c".repeat(64);
  it("Meta: troca por token longo e grava as contas", async () => {
    const { fetch, calls } = network([
      [
        /GET https:\/\/graph\.facebook\.com\/v23\.0\/oauth\/access_token\?.*code=abc/,
        () => json({ access_token: "short" }),
      ],
      [
        /GET https:\/\/graph\.facebook\.com\/v23\.0\/oauth\/access_token\?.*fb_exchange_token=short/,
        () => json({ access_token: "long", expires_in: 5184000 }),
      ],
      [/\/me\?/, () => json({ id: "fb1", name: "Ana" })],
      [
        /\/me\/adaccounts/,
        () =>
          json({
            data: [
              {
                account_id: "123",
                name: "Vittalium",
                currency: "BRL",
                account_status: 1,
              },
            ],
          }),
      ],
      [
        /rpc\/ad_complete_meta_connect/,
        () => json({ pending: "p-1", campaign: "ca-1" }),
      ],
    ]);
    const result = await handleAdsCallback(
      new URLSearchParams({ code: "abc", state: `meta.${state}` }),
      env,
      fetch,
    );
    expect(result.location).toBe(
      "https://workspace.example.com/campanhas?campanha=ca-1&pendente=p-1&conexao=meta-escolher",
    );
    const stored = calls.find((c) => c.url.includes("complete_meta"))!;
    // The redirect has no session: the database checks the state instead.
    expect(stored.headers.Authorization).toBe("Bearer publishable");
    const args = rpcArgs(stored);
    expect(args.p_state).toBe(state);
    expect(unseal(key, args.p_token_cipher)).toBe("long");
    expect(args.p_accounts).toEqual([
      {
        account_id: "123",
        name: "Vittalium",
        currency: "BRL",
        account_status: 1,
      },
    ]);
    expect(Date.parse(args.p_expires_at)).toBeGreaterThan(Date.now());
  });

  it("cancelado, estado inválido ou vencido", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const at = (q: Record<string, string>) =>
      handleAdsCallback(new URLSearchParams(q), env, f).then((r) => r.location);
    expect(
      await at({ error: "access_denied", state: `meta.${state}` }),
    ).toMatch(/meta-cancelado$/);
    expect(await at({ code: "x", state: "meta.zz" })).toMatch(/meta-erro$/);
    expect(await at({ code: "x", state: "outra.abc" })).toMatch(/meta-erro$/);
  });

  it("Google: exige o escopo do Google Ads", async () => {
    const answer = (scope: string) =>
      network([
        [
          /POST https:\/\/oauth2\.googleapis\.com\/token/,
          () =>
            json({
              access_token: "a",
              refresh_token: "r",
              expires_in: 3600,
              scope,
            }),
        ],
        [/userinfo/, () => json({ email: "agencia@make.com" })],
        [/rpc\/ad_complete_google_connect/, () => json(null)],
      ]);
    const denied = answer("openid email");
    expect(
      (
        await handleAdsCallback(
          new URLSearchParams({ code: "x", state: `google.${state}` }),
          env,
          denied.fetch,
        )
      ).location,
    ).toMatch(/google-sem-permissao$/);
    const ok = answer(`openid email ${GOOGLE_ADS_SCOPE}`);
    const result = await handleAdsCallback(
      new URLSearchParams({ code: "x", state: `google.${state}` }),
      env,
      ok.fetch,
    );
    expect(result.location).toMatch(/google-conectado$/);
    const args = rpcArgs(
      ok.calls.find((c) => c.url.includes("complete_google"))!,
    );
    expect(args.p_email).toBe("agencia@make.com");
    expect(unseal(key, args.p_refresh_cipher)).toBe("r");
  });
});

describe("Meta: formulários de cadastro (Lead Ads)", () => {
  const token = [
    /rpc\/ad_meta_token/,
    () =>
      json([{ token_cipher: seal(key, "fb-token"), token_expires_at: null }]),
  ] as [RegExp, () => Response];
  const page = [
    /GET https:\/\/graph\.facebook\.com\/v23\.0\/9001\?fields=name%2Caccess_token/,
    () => json({ name: "Página Vittalium", access_token: "page-token" }),
  ] as [RegExp, () => Response];

  it("lista as páginas que o perfil da conta administra", async () => {
    const { fetch, calls } = network([
      token,
      [
        /GET https:\/\/graph\.facebook\.com\/v23\.0\/me\/accounts/,
        () =>
          json({
            data: [
              { id: "2", name: "Zeta" },
              { id: "1", name: "Alfa" },
            ],
          }),
      ],
    ]);
    const result = await handleAds(
      { action: "pages", company, provider: "meta", account: "act_123" },
      auth,
      env,
      fetch,
    );
    expect(result.body.pages).toEqual([
      { id: "1", name: "Alfa" },
      { id: "2", name: "Zeta" },
    ]);
    expect(calls[1].headers.Authorization).toBe("Bearer fb-token");
  });

  it("lista os formulários da página com o token dela (ativos primeiro)", async () => {
    const { fetch, calls } = network([
      token,
      page,
      [
        /GET https:\/\/graph\.facebook\.com\/v23\.0\/9001\/leadgen_forms/,
        () =>
          json({
            data: [
              { id: "5002", name: "Antigo", status: "ARCHIVED" },
              {
                id: "5001",
                name: "Avaliação",
                status: "ACTIVE",
                leads_count: 12,
              },
            ],
          }),
      ],
    ]);
    const result = await handleAds(
      {
        action: "forms",
        company,
        provider: "meta",
        account: "123",
        page: "9001",
      },
      auth,
      env,
      fetch,
    );
    expect(result.body).toEqual({
      page: { id: "9001", name: "Página Vittalium" },
      forms: [
        {
          id: "5001",
          name: "Avaliação",
          status: "Ativo",
          active: true,
          leads: 12,
        },
        {
          id: "5002",
          name: "Antigo",
          status: "Arquivado",
          active: false,
          leads: null,
        },
      ],
    });
    expect(calls[2].headers.Authorization).toBe("Bearer page-token");
    // No token ever goes back to the browser.
    expect(JSON.stringify(result.body)).not.toContain("token");
  });

  it("página que o perfil não administra", async () => {
    const { fetch } = network([
      token,
      [
        /GET https:\/\/graph\.facebook\.com\/v23\.0\/9001/,
        () => json({ name: "X" }),
      ],
    ]);
    const result = await handleAds(
      {
        action: "forms",
        company,
        provider: "meta",
        account: "123",
        page: "9001",
      },
      auth,
      env,
      fetch,
    );
    expect([result.status, result.body.code]).toEqual([403, "no_page_access"]);
  });

  it("liga o formulário: inscreve a página no webhook e guarda o token cifrado", async () => {
    const { fetch, calls } = network([
      token,
      page,
      [
        /POST https:\/\/graph\.facebook\.com\/v23\.0\/9001\/subscribed_apps/,
        () => json({ success: true }),
      ],
      [/rpc\/ad_save_lead_form/, () => json({ id: "lf-1", form_id: "5001" })],
    ]);
    const result = await handleAds(
      {
        action: "link-form",
        company,
        provider: "meta",
        account: "123",
        page: "9001",
        form: "5001",
        form_name: "Avaliação",
        client: "00000000-0000-4000-8000-000000000002",
        landing_page: " 12345 ",
        make_user: "2477",
      },
      auth,
      env,
      fetch,
    );
    expect(result).toEqual({
      status: 200,
      body: { form: { id: "lf-1", form_id: "5001" } },
    });
    const subscribe = calls[2];
    expect(subscribe.body).toBe("subscribed_fields=leadgen");
    expect(subscribe.headers.Authorization).toBe("Bearer page-token");
    const args = rpcArgs(calls[3]);
    expect(args).toMatchObject({
      p_page_id: "9001",
      p_page_name: "Página Vittalium",
      p_form_id: "5001",
      p_landing_page: "12345",
      p_make_user: "2477",
      p_client: "00000000-0000-4000-8000-000000000002",
    });
    expect(unseal(key, args.p_page_token_cipher)).toBe("page-token");
  });

  it("o Facebook não confirma a inscrição: não liga", async () => {
    const { fetch, calls } = network([
      token,
      page,
      [/POST .*subscribed_apps/, () => json({ success: false })],
    ]);
    const result = await handleAds(
      {
        action: "link-form",
        company,
        provider: "meta",
        account: "123",
        page: "9001",
        form: "5001",
        landing_page: "12345",
        make_user: "2477",
      },
      auth,
      env,
      fetch,
    );
    expect(result.status).toBe(502);
    expect(calls.some((c) => c.url.includes("ad_save_lead_form"))).toBe(false);
  });
});

describe("Google: ações de conversão do ciclo", () => {
  const cycle = "00000000-0000-4000-8000-0000000000c1";
  const context = (extra: Record<string, unknown> = {}) =>
    [
      /rpc\/ad_cycle_conversion_context/,
      () =>
        json({
          company_id: company,
          platform: "google",
          objective: "lead",
          destination: "external_page",
          start_date: "2026-09-04",
          end_date: "2026-10-04",
          today: "2026-09-25",
          conversion_actions: null,
          links: [
            {
              account_id: "3329986472",
              campaign_id: "9",
              manager_id: "1238619048",
            },
          ],
          ...extra,
        }),
    ] as [RegExp, () => Response];
  const google = (actionRows: unknown[], calls = "4") =>
    [
      [
        /rpc\/ad_google_tokens/,
        () =>
          json([
            {
              refresh_token_cipher: seal(key, "refresh"),
              access_token_cipher: seal(key, "access"),
              access_expires_at: "2099-01-01T00:00:00Z",
            },
          ]),
      ],
      [
        /googleAds:searchStream/,
        (call: { body?: string }) =>
          json([
            {
              results: JSON.parse(call.body!).query.includes(
                "conversion_action",
              )
                ? actionRows
                : [{ campaign: { id: "9" }, metrics: { phoneCalls: calls } }],
            },
          ]),
      ],
    ] as [RegExp, (call: { body?: string }) => Response][];
  const row = (
    id: string,
    name: string,
    category: string,
    conversions: number,
  ) => ({
    campaign: { id: "9" },
    segments: {
      conversionAction: `customers/3329986472/conversionActions/${id}`,
      conversionActionName: name,
      conversionActionCategory: category,
    },
    metrics: { conversions },
  });

  it("lista as ações do ciclo e diz quais contam (padrão: categorias de cadastro)", async () => {
    const { fetch, calls } = network([
      context(),
      ...google([
        row("11", "Formulário site", "SUBMIT_LEAD_FORM", 33.2),
        row("12", "Clique WhatsApp", "DEFAULT", 90),
        row("13", "Página vista", "PAGE_VIEW", 400),
      ]),
    ]);
    const result = await handleAds(
      { action: "conversion-actions", company, provider: "google", cycle },
      auth,
      env,
      fetch,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      period: { since: "2026-09-04", until: "2026-09-24" },
      selection: null,
      phone_calls: 4,
      calls_counted: false,
      counted: 33,
    });
    const actions = result.body.actions as {
      id: string;
      counted: boolean;
      category_label: string;
    }[];
    expect(actions.map((a) => [a.id, a.counted, a.category_label])).toEqual([
      ["13", false, "Visualização de página"],
      ["12", false, "Outro"],
      ["11", true, "Envio de formulário"],
    ]);
    const search = calls.filter((c) => c.url.includes("searchStream"));
    expect(search[0].headers["login-customer-id"]).toBe("1238619048");
    expect(JSON.parse(search[0].body!).query).toContain(
      "segments.date BETWEEN '2026-09-04' AND '2026-09-24'",
    );
  });

  it("com a escolha do ciclo, contam só as marcadas", async () => {
    const { fetch } = network([
      context({ conversion_actions: ["12", "phone_calls"] }),
      ...google([
        row("11", "Formulário site", "SUBMIT_LEAD_FORM", 33),
        row("12", "Clique WhatsApp", "DEFAULT", 90),
      ]),
    ]);
    const result = await handleAds(
      { action: "conversion-actions", company, provider: "google", cycle },
      auth,
      env,
      fetch,
    );
    expect(result.body).toMatchObject({ counted: 94, calls_counted: true });
  });

  it("só para ciclos do Google", async () => {
    const { fetch } = network([context({ platform: "meta" })]);
    const result = await handleAds(
      { action: "conversion-actions", company, provider: "google", cycle },
      auth,
      env,
      fetch,
    );
    expect(result.status).toBe(400);
  });
});

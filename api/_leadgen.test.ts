import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AdsEnv } from "./_ads";
import { seal } from "./_google";
import {
  MAKE_OPTIN_URL,
  fieldName,
  firstJson,
  formatPhone,
  handleLeadgen,
  leadgenEnv,
  optinPayload,
  referenceOf,
  validSignature,
  verifySubscription,
  type LeadgenEnv,
} from "./_leadgen";

const key = crypto.randomBytes(32);
const base: AdsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  tokenKey: key,
  redirectUri: "https://workspace.example.com/api/ads-callback",
  meta: { appId: "app-1", appSecret: "app-secret", version: "v23.0" },
  google: {
    clientId: "",
    clientSecret: "",
    developerToken: "",
    version: "v25",
  },
};
const env: LeadgenEnv = leadgenEnv(
  {
    ADS_SYNC_SECRET: "s".repeat(40),
    META_WEBHOOK_VERIFY_TOKEN: "verifica-123",
    LEADGEN_FORWARD_URL: "https://flow.example.com/webhook/abc",
  },
  base,
);
const sign = (raw: string, secret = "app-secret") =>
  "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

type Call = { url: string; method: string; body?: string };
function network(routes: [RegExp, (call: Call) => Response][]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = {
      url,
      method: init.method ?? "GET",
      body: init.body?.toString(),
    };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw Error(`Rota inesperada: ${call.method} ${url}`);
    return route[1](call);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}
const notice = (...leads: string[]) =>
  JSON.stringify({
    object: "page",
    entry: [
      {
        id: "9001",
        time: 1790000000,
        changes: leads.map((l) => ({
          field: "leadgen",
          value: {
            leadgen_id: l,
            form_id: "5001",
            page_id: "9001",
            ad_id: "1",
          },
        })),
      },
    ],
  });
const target = {
  skip: false,
  company_id: "c",
  lead_form_id: "f",
  landing_page_id: "12345",
  make_user_id: "2477",
  page_token_cipher: seal(key, "PAGE-TOKEN"),
  account_token_ciphers: [seal(key, "ACCOUNT-TOKEN")],
};
const lead = {
  id: "7001",
  field_data: [
    { name: "full_name", values: ["Maria Souza"] },
    { name: "E-mail", values: ["maria@example.com"] },
    { name: "phone_number", values: ["+5511988887777"] },
    { name: "Nome da empresa", values: ["Souza Ltda"] },
  ],
};

describe("configuração do webhook", () => {
  it("lê as variáveis e usa a API de optin da Make por padrão", () => {
    expect(env.optinUrl).toBe(MAKE_OPTIN_URL);
    expect(env.forwardUrl).toBe("https://flow.example.com/webhook/abc");
    // Only https destinations.
    expect(
      leadgenEnv({ LEADGEN_FORWARD_URL: "http://x" }, base).forwardUrl,
    ).toBe("");
  });
  it("confirma a URL só com o token de verificação certo", () => {
    const q = (token: string) =>
      new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": token,
        "hub.challenge": "desafio",
      });
    expect(verifySubscription(q("verifica-123"), env)).toEqual({
      status: 200,
      body: "desafio",
    });
    expect(verifySubscription(q("abc123"), env).status).toBe(403);
    expect(verifySubscription(q(""), { ...env, verifyToken: "" }).status).toBe(
      403,
    );
  });
  it("confere a assinatura do Facebook", () => {
    const raw = notice("7001");
    expect(validSignature(raw, sign(raw), "app-secret")).toBe(true);
    expect(validSignature(raw, sign(raw, "outro"), "app-secret")).toBe(false);
    expect(validSignature(raw + " ", sign(raw), "app-secret")).toBe(false);
    expect(validSignature(raw, null, "app-secret")).toBe(false);
  });
});

describe("campos do formulário (regras do MASO)", () => {
  it("limpa o nome e acha a referência", () => {
    expect(fieldName("E-mail")).toBe("email");
    expect(fieldName("Nome completo")).toBe("nomecompleto");
    expect(referenceOf("full_name")).toBe("nome");
    expect(referenceOf("nomedaempresa")).toBe("empresa");
    expect(referenceOf("company_name")).toBe("empresa");
    expect(referenceOf("phone_number")).toBe("telefone");
    expect(referenceOf("whatsapp")).toBe("whatsapp");
    expect(referenceOf("cidade")).toBe("");
  });
  it("telefone com DDD entre parênteses, sem perder os 5 do número", () => {
    expect(formatPhone("+5511955558888")).toBe("(11)955558888");
    expect(formatPhone("(11)95555-8888")).toBe("(11)955558888");
    expect(formatPhone("955558888")).toBe("955558888");
  });
  it("monta o corpo da API de optin como o MASO", () => {
    const utm = {
      Source: "Meta",
      Medium: "Paid Traffic",
      Campaign: "[LEAD] Avaliação",
      Term: "Conjunto A",
      Content: "Anúncio 1",
    };
    const body = optinPayload(lead, target, utm);
    expect(body).toMatchObject({
      id_usuario: "2477",
      id_capture: "12345",
      duplo_lead: 1,
      valor_campo_email: "maria@example.com",
      valor_campo_celular: "+5511988887777",
      coluna: ["full_name", "email", "phone_number", "nomedaempresa"],
      fonte: 0,
      url: "leadgen",
      fbclid: "7001",
      utm,
    });
    expect(body.campos.email).toEqual({
      id: 1,
      nome: "email",
      tipo: 0,
      obrigatorio: 1,
      valor: "maria@example.com",
      referencia: "email",
    });
    expect(body.campos.nomedaempresa.referencia).toBe("empresa");
    // Without the ad's names: an empty list, like the MASO.
    expect(optinPayload(lead, target, null).utm).toEqual([]);
    // The clients that want "(DD)number".
    expect(
      optinPayload(lead, { ...target, make_user_id: "2832" }, null)
        .valor_campo_celular,
    ).toBe("(11)988887777");
  });
  it("lê o primeiro JSON da resposta da Make", () => {
    expect(firstJson('{"resposta":0,"person":{"id":1}}<br>Mailer')).toEqual({
      resposta: 0,
      person: { id: 1 },
    });
    expect(firstJson('{"a":"}"}')).toEqual({ a: "}" });
    expect(firstJson("erro")).toEqual({});
  });
});

describe("recebimento dos cadastros", () => {
  const routes = (
    claim: (call: Call) => Response,
    optin: (call: Call) => Response = () => json({ resposta: 0 }),
  ): [RegExp, (call: Call) => Response][] => [
    [/POST https:\/\/flow\.example\.com/, () => json({ ok: true })],
    [/rpc\/ad_leadgen_claim/, claim],
    [/rpc\/ad_leadgen_finish/, () => json(null)],
    [
      /GET https:\/\/graph\.facebook\.com\/v23\.0\/7001\?fields=id%2Ccreated_time%2Cfield_data/,
      () => json(lead),
    ],
    [
      /GET https:\/\/graph\.facebook\.com\/v23\.0\/7001\?fields=ad_name/,
      () =>
        json({
          ad_name: "Anúncio 1",
          adset_name: "Conjunto A",
          campaign_name: "[LEAD] Avaliação",
        }),
    ],
    [/POST https:\/\/www\.makevendas\.com\.br/, optin],
  ];

  it("recusa sem configuração ou com assinatura errada", async () => {
    const raw = notice("7001");
    const off = await handleLeadgen(raw, sign(raw), {
      ...env,
      verifyToken: "",
    });
    expect(off.status).toBe(500);
    expect(String(off.body.error)).toContain("META_WEBHOOK_VERIFY_TOKEN");
    const net = network([]);
    const bad = await handleLeadgen(raw, sign(raw, "x"), env, net.fetch);
    expect(bad.status).toBe(401);
    expect(net.calls).toHaveLength(0);
  });

  it("entrega o cadastro à página de captura e registra", async () => {
    const raw = notice("7001");
    const net = network(routes(() => json(target)));
    const result = await handleLeadgen(raw, sign(raw), env, net.fetch);
    expect(result).toEqual({
      status: 200,
      body: { leads: [{ leadgen_id: "7001", status: "sent" }] },
    });
    // The raw notice went to the flow, untouched.
    expect(net.calls[0].body).toBe(raw);
    const optin = net.calls.find((c) => c.url.includes("makevendas"))!;
    const body = JSON.parse(optin.body!);
    expect(body.id_capture).toBe("12345");
    expect(body.utm.Campaign).toBe("[LEAD] Avaliação");
    const finish = net.calls.find((c) => c.url.includes("ad_leadgen_finish"))!;
    expect(JSON.parse(finish.body!)).toMatchObject({
      p_leadgen: "7001",
      p_status: "sent",
    });
    // The Page's token went to Graph only in the header, never in the URL.
    expect(net.calls.some((c) => c.url.includes("PAGE-TOKEN"))).toBe(false);
  });

  it("já recebido ou sem vínculo: não envia de novo", async () => {
    const raw = notice("7001");
    const net = network(routes(() => json({ skip: true, reason: "already" })));
    const result = await handleLeadgen(raw, sign(raw), env, net.fetch);
    expect(result.status).toBe(200);
    expect(net.calls.some((c) => c.url.includes("makevendas"))).toBe(false);
  });

  it("Make fora do ar: responde 500 para o Facebook reenviar", async () => {
    const raw = notice("7001");
    const net = network(
      routes(
        () => json(target),
        () => new Response("erro", { status: 503 }),
      ),
    );
    const result = await handleLeadgen(raw, sign(raw), env, net.fetch);
    expect(result.status).toBe(500);
    const finish = net.calls.find((c) => c.url.includes("ad_leadgen_finish"))!;
    expect(JSON.parse(finish.body!).p_status).toBe("error");
  });

  it("campos obrigatórios faltando: erro registrado, sem reenvio; duplicado conta como entregue", async () => {
    const raw = notice("7001");
    const missing = network(
      routes(
        () => json(target),
        () => json({ resposta: 2 }),
      ),
    );
    const r1 = await handleLeadgen(raw, sign(raw), env, missing.fetch);
    expect(r1.status).toBe(200);
    expect((r1.body.leads as { status: string }[])[0].status).toBe("error");
    const dup = network(
      routes(
        () => json(target),
        () => json({ resposta: 0, lead_duplicado: 1 }),
      ),
    );
    const r2 = await handleLeadgen(raw, sign(raw), env, dup.fetch);
    expect((r2.body.leads as { status: string }[])[0].status).toBe("duplicate");
  });
});

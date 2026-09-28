import { describe, expect, it, vi } from "vitest";
import { apiKey, handlePublicApi } from "./_public-api";

const env = { supabaseUrl: "https://db.example.com", supabaseKey: "publishable" };
const KEY = `workspace_${"a".repeat(64)}`;
const CLIENT = "00000000-0000-4000-8000-000000000001";

function call(
  method: string,
  path: string,
  opts: { body?: unknown; query?: string; headers?: Record<string, string> } = {},
  response = new Response(JSON.stringify({ ok: true })),
) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  const result = handlePublicApi(
    {
      method,
      path,
      query: new URLSearchParams(opts.query ?? ""),
      headers: opts.headers ?? { authorization: `Bearer ${KEY}` },
      body: opts.body ?? null,
    },
    env,
    fetchMock as unknown as typeof fetch,
  );
  return { result, fetchMock };
}
const sent = (fetchMock: ReturnType<typeof vi.fn>) => ({
  url: fetchMock.mock.calls[0][0],
  args: JSON.parse(fetchMock.mock.calls[0][1].body),
  auth: fetchMock.mock.calls[0][1].headers.Authorization,
});

describe("apiKey", () => {
  it("aceita Bearer ou X-Api-Key, só no formato workspace_", () => {
    expect(apiKey({ authorization: `Bearer ${KEY}` })).toBe(KEY);
    expect(apiKey({ "x-api-key": KEY })).toBe(KEY);
    expect(apiKey({ authorization: "Bearer eyJhbGciOi" })).toBeNull();
    expect(apiKey({ authorization: `Bearer mavi_${"a".repeat(64)}` })).toBeNull();
    expect(apiKey({})).toBeNull();
  });
});

describe("handlePublicApi", () => {
  it("sem chave: 401 antes de consultar o banco", async () => {
    const { result, fetchMock } = call("GET", "products", { headers: {} });
    expect((await result).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rota desconhecida 404; método errado 405 com Allow", async () => {
    expect((await call("GET", "tarefas").result).status).toBe(404);
    expect((await call("GET", "clients/nao-e-uuid").result).status).toBe(404);
    const r = await call("DELETE", `clients/${CLIENT}`).result;
    expect(r.status).toBe(405);
    expect(r.headers).toEqual({ Allow: "GET" });
  });

  it("POST /clients cria com a chave publicável e responde 201", async () => {
    const body = { name: "Aurora", products: ["SEO"] };
    const { result, fetchMock } = call("POST", "clients", { body });
    expect((await result).status).toBe(201);
    const s = sent(fetchMock);
    expect(s.url).toBe("https://db.example.com/rest/v1/rpc/api_create_client");
    expect(s.args).toEqual({ p_key: KEY, p_client: body });
    expect(s.auth).toBe("Bearer publishable");
  });

  it("POST /clients/{id}/products exige a lista products", async () => {
    expect(
      (await call("POST", `clients/${CLIENT}/products`, { body: {} }).result)
        .status,
    ).toBe(400);
    const { result, fetchMock } = call("POST", `clients/${CLIENT}/products`, {
      body: { products: ["SEO"] },
    });
    expect((await result).status).toBe(200);
    expect(sent(fetchMock).args).toEqual({
      p_key: KEY,
      p_client: CLIENT,
      p_products: ["SEO"],
    });
  });

  it("GET /clients repassa email e search", async () => {
    const { fetchMock, result } = call("GET", "clients", {
      query: "email=a%40b.com",
    });
    await result;
    expect(sent(fetchMock).args).toEqual({
      p_key: KEY,
      p_email: "a@b.com",
      p_search: null,
    });
  });

  it("traduz os erros do banco", async () => {
    const pg = (code: string, message: string, details?: string) =>
      new Response(JSON.stringify({ code, message, details }), { status: 400 });
    const cases: [string, number][] = [
      ["42501", 401],
      ["22023", 422],
      ["P0002", 404],
    ];
    for (const [code, status] of cases) {
      const r = await call("GET", "products", {}, pg(code, "msg")).result;
      expect(r).toMatchObject({ status, body: { error: "msg" } });
    }
    const dup = await call(
      "POST",
      "clients",
      { body: { name: "Aurora" } },
      pg("23505", "Já existe", CLIENT),
    ).result;
    expect(dup).toEqual({
      status: 409,
      body: { error: "Já existe", existing_client_id: CLIENT },
    });
  });
});

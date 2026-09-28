import type { DriveEnv } from "./_drive.js";

type Env = Pick<DriveEnv, "supabaseUrl" | "supabaseKey">;
export type PublicApiResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQLSTATE of the api_* functions → HTTP status of the public API. */
const STATUS: Record<string, number> = {
  "42501": 401, // chave inválida ou revogada
  "22023": 422, // dados inválidos (produto/equipe inexistente, nome…)
  "22P02": 422, // JSON ou id malformado
  P0002: 404,
  "23505": 409, // cliente com o mesmo e-mail
};

/** The key from `Authorization: Bearer workspace_…` or `X-Api-Key: workspace_…`. */
export function apiKey(headers: Record<string, string | string[] | undefined>) {
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  const bearer = one(headers["authorization"]).match(/^Bearer\s+(.+)$/i)?.[1];
  const key = bearer ?? one(headers["x-api-key"]);
  return /^workspace_[0-9a-f]{64}$/.test(key) ? key : null;
}

async function rpc(
  env: Env,
  fetchImpl: typeof fetch,
  name: string,
  args: Record<string, unknown>,
  created = false,
): Promise<PublicApiResponse> {
  const res = await fetchImpl(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.supabaseKey,
      Authorization: `Bearer ${env.supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.ok) return { status: created ? 201 : 200, body };
  const status = STATUS[body?.code] ?? (res.status >= 500 ? 502 : 400);
  const error: Record<string, unknown> = {
    error: body?.message ?? "Não foi possível concluir a requisição.",
  };
  if (body?.code === "23505" && UUID.test(body?.details ?? ""))
    error.existing_client_id = body.details;
  return { status, body: error };
}

/**
 * API pública v1 (/api/v1/…): cadastro de clientes e vínculo de produtos por
 * sistemas externos, com a chave de API do espaço. `path` é o que vem depois
 * de /api/v1/. Quem valida a chave e isola a empresa é o banco (api_*).
 */
export async function handlePublicApi(
  req: {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  },
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicApiResponse> {
  const fail = (status: number, error: string, headers?: Record<string, string>) => ({
    status,
    body: { error },
    headers,
  });
  const parts = req.path.split("/").filter(Boolean);
  const route = parts.map((p) => (UUID.test(p) ? ":id" : p)).join("/");
  const allowed: Record<string, string> = {
    products: "GET",
    teams: "GET",
    clients: "GET, POST",
    "clients/:id": "GET",
    "clients/:id/products": "POST",
  };
  if (!allowed[route]) return fail(404, "Rota não encontrada.");
  if (!allowed[route].split(", ").includes(req.method))
    return fail(405, "Método não permitido.", { Allow: allowed[route] });
  const key = apiKey(req.headers);
  if (!key)
    return fail(401, "Envie a chave de API em Authorization: Bearer workspace_….");
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;
  const id = parts[1];

  switch (`${req.method} ${route}`) {
    case "GET products":
      return rpc(env, fetchImpl, "api_list_products", { p_key: key });
    case "GET teams":
      return rpc(env, fetchImpl, "api_list_teams", { p_key: key });
    case "GET clients":
      return rpc(env, fetchImpl, "api_find_clients", {
        p_key: key,
        p_email: req.query.get("email"),
        p_search: req.query.get("search"),
      });
    case "GET clients/:id":
      return rpc(env, fetchImpl, "api_get_client", { p_key: key, p_client: id });
    case "POST clients":
      if (!body) return fail(400, "Envie um objeto JSON no corpo.");
      return rpc(
        env,
        fetchImpl,
        "api_create_client",
        { p_key: key, p_client: body },
        true,
      );
    default: // POST clients/:id/products
      if (!body || !Array.isArray(body.products))
        return fail(400, 'Envie {"products": [...]} no corpo.');
      return rpc(env, fetchImpl, "api_link_client_products", {
        p_key: key,
        p_client: id,
        p_products: body.products,
      });
  }
}

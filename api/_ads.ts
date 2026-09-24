import crypto from "node:crypto";
import { callRpc } from "./_drive.js";
import { seal, unseal } from "./_google.js";
import { appOrigin } from "./_origin.js";

/**
 * Campanhas: the ad accounts and campaigns of Meta and Google Ads, read live
 * so a cycle can be linked to them (as the MASO did in the cycle form).
 *
 * - Meta: an administrator signs in with Facebook; the long-lived token is
 *   kept per ad account it reaches (the last person to connect takes an
 *   account over), as in the MASO.
 * - Google Ads: one agency connection (an account with access to the MCC),
 *   refreshed on demand. The MCC is sent as login-customer-id.
 *
 * Tokens (Meta's and Google's) are sealed with GOOGLE_TOKEN_KEY_ADS before
 * reaching the database
 * (migration 20261001090000_ad_platform_connections) and never reach the
 * browser. Only the company's administrators get past the database functions.
 */

export type AdsEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  /** 32 bytes (GOOGLE_TOKEN_KEY_ADS, base64); null when missing or invalid. */
  tokenKey: Buffer | null;
  /** Registered in the Meta app and in Google Cloud: <origin>/api/ads-callback. */
  redirectUri: string;
  meta: { appId: string; appSecret: string; version: string };
  google: {
    clientId: string;
    clientSecret: string;
    developerToken: string;
    version: string;
  };
};

export function adsEnv(
  env: Record<string, string | undefined> = process.env,
): AdsEnv {
  // Campanhas has its own OAuth client and key (the Agenda's are
  // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_TOKEN_KEY).
  const key = env.GOOGLE_TOKEN_KEY_ADS
    ? Buffer.from(env.GOOGLE_TOKEN_KEY_ADS, "base64")
    : null;
  return {
    supabaseUrl:
      env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co",
    supabaseKey:
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
    tokenKey: key && key.length === 32 ? key : null,
    redirectUri: env.ADS_REDIRECT_URI || `${appOrigin(env)}/api/ads-callback`,
    meta: {
      appId: env.META_APP_ID ?? "",
      appSecret: env.META_APP_SECRET ?? "",
      version: env.META_GRAPH_VERSION || "v23.0",
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID_ADS ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET_ADS ?? "",
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
      // v21, the MASO's, was sunset on 2026-08-05.
      version: env.GOOGLE_ADS_API_VERSION || "v25",
    },
  };
}

export type AdsProvider = "meta" | "google";
export const META_SCOPE = "ads_read,business_management";
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function configured(env: AdsEnv, provider: AdsProvider) {
  if (!env.tokenKey) return false;
  return provider === "meta"
    ? !!(env.meta.appId && env.meta.appSecret)
    : !!(
        env.google.clientId &&
        env.google.clientSecret &&
        env.google.developerToken
      );
}

export class AdsError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export type Fetch = typeof fetch;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Meta ad account id without "act_"; Google customer id without dashes. */
export function accountId(provider: AdsProvider, value: unknown) {
  const text = String(value ?? "").trim();
  const id =
    provider === "meta" ? text.replace(/^act_/i, "") : text.replace(/-/g, "");
  return /^[0-9]{1,30}$/.test(id) ? id : null;
}

async function rpc<T>(
  env: AdsEnv,
  fetchImpl: Fetch,
  authorization: string | null,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await callRpc<T>(env, fetchImpl, authorization, name, args);
  if (!result.ok) throw new AdsError(result.status, result.error);
  return result.data;
}

// ------------------------------------------------------------ Meta
const META_ACCOUNT_STATUS: Record<number, string> = {
  1: "Ativa",
  2: "Desativada",
  3: "Pagamento pendente",
  7: "Em análise",
  8: "Pagamento pendente",
  9: "Em período de carência",
  100: "Encerramento pendente",
  101: "Encerrada",
  201: "Ativa",
  202: "Encerrada",
};
const CAMPAIGN_STATUS: Record<string, string> = {
  ACTIVE: "Ativa",
  ENABLED: "Ativa",
  PAUSED: "Pausada",
  CAMPAIGN_PAUSED: "Pausada",
  ADSET_PAUSED: "Pausada",
  IN_PROCESS: "Em processamento",
  WITH_ISSUES: "Com problemas",
  PENDING_REVIEW: "Em análise",
  DISAPPROVED: "Reprovada",
  ARCHIVED: "Arquivada",
  DELETED: "Excluída",
  REMOVED: "Excluída",
};
export type PlatformCampaign = {
  id: string;
  name: string;
  status: string;
  active: boolean;
  /** Meta objective or Google channel type. */
  kind: string;
};
export type PlatformAccount = {
  id: string;
  name: string;
  status: string;
  active: boolean;
  currency: string;
  /** Google: the MCC it is reached through ("" when accessed directly). */
  manager_id: string;
  manager_name: string;
  /** Meta: when this account's token expires, and whose it is. */
  expires_at?: string | null;
  connected_by?: string;
};

function appSecretProof(env: AdsEnv, token: string) {
  return crypto
    .createHmac("sha256", env.meta.appSecret)
    .update(token)
    .digest("hex");
}

/** A Graph API GET with the token in the header (never in a URL we build). */
async function graph<T>(
  env: AdsEnv,
  fetchImpl: Fetch,
  token: string,
  pathOrUrl: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = pathOrUrl.startsWith("https://")
    ? new URL(pathOrUrl)
    : new URL(`https://graph.facebook.com/${env.meta.version}${pathOrUrl}`);
  // Paging links come from the response: the token only goes to Graph.
  if (url.protocol !== "https:" || url.hostname !== "graph.facebook.com")
    throw new AdsError(502, "Facebook: endereço de paginação inesperado.");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.delete("access_token");
  url.searchParams.set("appsecret_proof", appSecretProof(env, token));
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number };
  } & T;
  if (!res.ok || body.error) {
    if (body.error?.code === 190)
      throw new AdsError(
        409,
        "O acesso ao Facebook desta conta expirou. Conecte o Facebook de novo.",
        "expired",
      );
    throw new AdsError(
      502,
      `Facebook: ${body.error?.message ?? res.statusText}`,
    );
  }
  return body;
}

/** Every page of a Graph list (the MASO read only the first two). */
export async function graphAll<T>(
  env: AdsEnv,
  fetchImpl: Fetch,
  token: string,
  path: string,
  params: Record<string, string>,
  maxPages = 25,
) {
  const items: T[] = [];
  let next: string | undefined = path;
  for (let page = 0; next && page < maxPages; page++) {
    const body: { data?: T[]; paging?: { next?: string } } = await graph(
      env,
      fetchImpl,
      token,
      next,
      page === 0 ? params : {},
    );
    items.push(...(body.data ?? []));
    next = body.paging?.next;
  }
  return items;
}

async function metaCampaigns(
  env: AdsEnv,
  fetchImpl: Fetch,
  authorization: string,
  company: string,
  account: string,
): Promise<PlatformCampaign[]> {
  const [row] = await rpc<
    { token_cipher: string; token_expires_at: string | null }[]
  >(env, fetchImpl, authorization, "ad_meta_token", {
    p_company: company,
    p_account: account,
  });
  if (!row)
    throw new AdsError(
      404,
      "Esta conta de anúncio não está conectada. Conecte o Facebook com um usuário que tenha acesso a ela.",
      "not_connected",
    );
  if (row.token_expires_at && Date.parse(row.token_expires_at) < Date.now())
    throw new AdsError(
      409,
      "O acesso ao Facebook desta conta expirou. Conecte o Facebook de novo.",
      "expired",
    );
  const token = unseal(env.tokenKey!, row.token_cipher);
  const items = await graphAll<{
    id: string;
    name?: string;
    effective_status?: string;
    objective?: string;
  }>(env, fetchImpl, token, `/act_${account}/campaigns`, {
    fields: "id,name,effective_status,objective",
    limit: "200",
  });
  return items.map((c) => ({
    id: c.id,
    name: c.name ?? c.id,
    status:
      CAMPAIGN_STATUS[c.effective_status ?? ""] ?? c.effective_status ?? "",
    active: c.effective_status === "ACTIVE",
    kind: c.objective ?? "",
  }));
}

// ------------------------------------------------------------ Google Ads
async function googleToken(
  env: AdsEnv,
  fetchImpl: Fetch,
  authorization: string,
  company: string,
  force = false,
): Promise<string> {
  const [row] = await rpc<
    {
      refresh_token_cipher: string;
      access_token_cipher: string | null;
      access_expires_at: string | null;
    }[]
  >(env, fetchImpl, authorization, "ad_google_tokens", { p_company: company });
  if (!row)
    throw new AdsError(
      409,
      "Conecte o Google Ads da agência.",
      "not_connected",
    );
  const key = env.tokenKey!;
  if (
    !force &&
    row.access_token_cipher &&
    row.access_expires_at &&
    Date.parse(row.access_expires_at) > Date.now() + 60_000
  )
    return unseal(key, row.access_token_cipher);
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      refresh_token: unseal(key, row.refresh_token_cipher),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    // Revoked or expired consent: forget it; someone connects again.
    if (body.error === "invalid_grant") {
      await rpc(env, fetchImpl, authorization, "ad_disconnect", {
        p_company: company,
        p_provider: "google",
      });
      throw new AdsError(
        409,
        "A conexão com o Google Ads expirou. Conecte de novo.",
        "not_connected",
      );
    }
    throw new AdsError(
      502,
      `Google: ${body.error_description || body.error || res.statusText}`,
    );
  }
  const token = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  await rpc(env, fetchImpl, authorization, "ad_google_save_access", {
    p_company: company,
    p_access_cipher: seal(key, token.access_token),
    p_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  });
  return token.access_token;
}

type GoogleRow = Record<string, Record<string, unknown>>;
/** Google Ads API calls; a 401 refreshes the token once and retries. */
function googleAds(
  env: AdsEnv,
  fetchImpl: Fetch,
  authorization: string,
  company: string,
) {
  let token: Promise<string> | null = null;
  async function call<T>(
    path: string,
    init: { body?: unknown; loginCustomer?: string } = {},
    retry = true,
  ): Promise<T> {
    token ??= googleToken(env, fetchImpl, authorization, company);
    const res = await fetchImpl(
      `https://googleads.googleapis.com/${env.google.version}/${path}`,
      {
        method: init.body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${await token}`,
          "developer-token": env.google.developerToken,
          ...(init.loginCustomer
            ? { "login-customer-id": init.loginCustomer }
            : {}),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      },
    );
    if (res.status === 401 && retry) {
      token = googleToken(env, fetchImpl, authorization, company, true);
      return call<T>(path, init, false);
    }
    const body = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
      const error = (Array.isArray(body) ? body[0] : body) as {
        error?: {
          message?: string;
          details?: { errors?: { message?: string }[] }[];
        };
      };
      const message =
        error?.error?.details?.[0]?.errors?.[0]?.message ??
        error?.error?.message ??
        res.statusText;
      throw new AdsError(
        res.status === 403 ? 403 : 502,
        `Google Ads: ${message}`,
      );
    }
    return body as T;
  }
  /** GAQL through searchStream: every row of every batch. */
  async function search(customer: string, query: string, login?: string) {
    const batches = await call<{ results?: GoogleRow[] }[]>(
      `customers/${customer}/googleAds:searchStream`,
      { body: { query }, loginCustomer: login ?? customer },
    );
    return batches.flatMap((b) => b.results ?? []);
  }
  return { call, search };
}

const str = (v: unknown) => (v == null ? "" : String(v));

/**
 * Every client account reachable by the connection: each accessible
 * customer and, for managers (MCC), the accounts below them.
 */
async function googleAccounts(
  env: AdsEnv,
  fetchImpl: Fetch,
  authorization: string,
  company: string,
): Promise<PlatformAccount[]> {
  const ads = googleAds(env, fetchImpl, authorization, company);
  const list = await ads.call<{ resourceNames?: string[] }>(
    "customers:listAccessibleCustomers",
  );
  const roots = (list.resourceNames ?? [])
    .map((r) => r.replace("customers/", ""))
    .filter((id) => /^[0-9]+$/.test(id))
    .slice(0, 50);
  const found = new Map<string, PlatformAccount>();
  let firstError: unknown = null;
  let ok = 0;
  const queue = [...roots];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let root = queue.shift(); root; root = queue.shift()) {
        try {
          const rows = await ads.search(
            root,
            "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.currency_code, customer_client.level FROM customer_client",
          );
          ok++;
          const self = rows.find(
            (r) => str(r.customerClient?.id) === root,
          )?.customerClient;
          const rootIsManager = self?.manager === true;
          for (const r of rows) {
            const c = r.customerClient ?? {};
            const id = str(c.id);
            if (!id || c.manager === true) continue;
            const account: PlatformAccount = {
              id,
              name: str(c.descriptiveName) || id,
              status: str(c.status) === "ENABLED" ? "Ativa" : str(c.status),
              active: str(c.status) === "ENABLED",
              currency: str(c.currencyCode),
              manager_id: rootIsManager ? root : "",
              manager_name: rootIsManager ? str(self?.descriptiveName) : "",
            };
            // Through an MCC wins over direct access (the MASO's way).
            const known = found.get(id);
            if (!known || (!known.manager_id && account.manager_id))
              found.set(id, account);
          }
        } catch (e) {
          firstError ??= e;
        }
      }
    }),
  );
  if (!ok && firstError) throw firstError;
  return [...found.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );
}

async function googleCampaigns(
  env: AdsEnv,
  fetchImpl: Fetch,
  authorization: string,
  company: string,
  account: string,
  manager: string,
): Promise<PlatformCampaign[]> {
  const rows = await googleAds(env, fetchImpl, authorization, company).search(
    account,
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name",
    manager || account,
  );
  return rows.map((r) => ({
    id: str(r.campaign?.id),
    name: str(r.campaign?.name) || str(r.campaign?.id),
    status: CAMPAIGN_STATUS[str(r.campaign?.status)] ?? str(r.campaign?.status),
    active: str(r.campaign?.status) === "ENABLED",
    kind: str(r.campaign?.advertisingChannelType),
  }));
}

// ------------------------------------------------------------ handlers
export type AdsRequest =
  | { action: "status"; company: string }
  | { action: "connect"; company: string; provider: AdsProvider }
  | { action: "disconnect"; company: string; provider: AdsProvider }
  | { action: "accounts"; company: string; provider: AdsProvider }
  | {
      action: "campaigns";
      company: string;
      provider: AdsProvider;
      account: string;
      manager?: string;
    };

export async function handleAds(
  body: unknown,
  authorization: string | null,
  env: AdsEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string, code?: string) => ({
    status,
    body: code ? { error, code } : { error },
  });
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");
  const req = (body ?? {}) as Partial<AdsRequest> & Record<string, unknown>;
  const company = String(req.company ?? "");
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  const provider = req.provider as AdsProvider;
  const needsProvider = req.action !== "status";
  if (needsProvider && provider !== "meta" && provider !== "google")
    return fail(400, "Plataforma inválida.");
  if (needsProvider && !configured(env, provider))
    return fail(
      500,
      provider === "meta"
        ? "A conexão com o Facebook não está configurada no servidor."
        : "A conexão com o Google Ads não está configurada no servidor.",
      "not_configured",
    );
  try {
    if (req.action === "status") {
      const connections = await rpc<{
        meta: Record<string, unknown> | null;
        google: Record<string, unknown> | null;
      }>(env, fetchImpl, authorization, "ad_connections", {
        p_company: company,
      });
      return {
        status: 200,
        body: {
          meta: { configured: configured(env, "meta"), ...connections.meta },
          google: {
            configured: configured(env, "google"),
            ...connections.google,
          },
        },
      };
    }

    if (req.action === "connect") {
      const state = await rpc<string>(
        env,
        fetchImpl,
        authorization,
        "ad_begin_connect",
        { p_company: company, p_provider: provider },
      );
      const url =
        provider === "meta"
          ? new URL(`https://www.facebook.com/${env.meta.version}/dialog/oauth`)
          : new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams(
        provider === "meta"
          ? {
              client_id: env.meta.appId,
              redirect_uri: env.redirectUri,
              response_type: "code",
              scope: META_SCOPE,
              state: `meta.${state}`,
            }
          : {
              client_id: env.google.clientId,
              redirect_uri: env.redirectUri,
              response_type: "code",
              scope: `${GOOGLE_ADS_SCOPE} openid email`,
              access_type: "offline",
              prompt: "consent",
              state: `google.${state}`,
            },
      ).toString();
      return { status: 200, body: { url: url.toString() } };
    }

    if (req.action === "disconnect") {
      if (provider === "google") {
        const [row] = await rpc<{ refresh_token_cipher: string }[]>(
          env,
          fetchImpl,
          authorization,
          "ad_google_tokens",
          { p_company: company },
        );
        if (row)
          await fetchImpl("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: unseal(env.tokenKey!, row.refresh_token_cipher),
            }),
          }).catch(() => null);
      }
      await rpc(env, fetchImpl, authorization, "ad_disconnect", {
        p_company: company,
        p_provider: provider,
      });
      return { status: 200, body: { disconnected: true } };
    }

    if (req.action === "accounts") {
      if (provider === "google")
        return {
          status: 200,
          body: {
            accounts: await googleAccounts(
              env,
              fetchImpl,
              authorization,
              company,
            ),
          },
        };
      const rows = await rpc<
        {
          account_id: string;
          name: string;
          currency: string;
          account_status: number | null;
          token_expires_at: string | null;
          fb_user_name: string;
        }[]
      >(env, fetchImpl, authorization, "ad_meta_account_list", {
        p_company: company,
      });
      const accounts: PlatformAccount[] = rows.map((a) => ({
        id: a.account_id,
        name: a.name || a.account_id,
        status: META_ACCOUNT_STATUS[a.account_status ?? 0] ?? "",
        active: a.account_status === 1 || a.account_status === 201,
        currency: a.currency,
        manager_id: "",
        manager_name: "",
        expires_at: a.token_expires_at,
        connected_by: a.fb_user_name,
      }));
      return { status: 200, body: { accounts } };
    }

    if (req.action === "campaigns") {
      const account = accountId(provider, req.account);
      if (!account) return fail(400, "Conta de anúncio inválida.");
      const manager = req.manager ? accountId("google", req.manager) : "";
      if (manager === null) return fail(400, "MCC inválida.");
      const campaigns =
        provider === "meta"
          ? await metaCampaigns(env, fetchImpl, authorization, company, account)
          : await googleCampaigns(
              env,
              fetchImpl,
              authorization,
              company,
              account,
              manager,
            );
      return { status: 200, body: { campaigns } };
    }
    return fail(400, "Ação inválida.");
  } catch (e) {
    if (e instanceof AdsError) return fail(e.status, e.message, e.code);
    throw e;
  }
}

/**
 * The platform's redirect after consent (GET /api/ads-callback?code&state):
 * exchanges the code, stores the sealed token against the state and sends
 * the administrator back to Campanhas (?conexao=<platform>-<result>).
 */
export async function handleAdsCallback(
  query: URLSearchParams,
  env: AdsEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; location: string }> {
  const [provider, state = ""] = (query.get("state") ?? "").split(".");
  const back = (result: string) => ({
    status: 302,
    location: `${new URL(env.redirectUri).origin}/campanhas?conexao=${
      provider === "google" ? "google" : "meta"
    }-${result}`,
  });
  if (provider !== "meta" && provider !== "google") return back("erro");
  if (!configured(env, provider)) return back("erro");
  const code = query.get("code");
  if (query.get("error") || !code) return back("cancelado");
  if (!/^[0-9a-f]{64}$/.test(state)) return back("erro");
  const key = env.tokenKey!;

  if (provider === "meta") {
    const exchange = async (params: Record<string, string>) => {
      const url = new URL(
        `https://graph.facebook.com/${env.meta.version}/oauth/access_token`,
      );
      url.search = new URLSearchParams({
        client_id: env.meta.appId,
        client_secret: env.meta.appSecret,
        ...params,
      }).toString();
      const res = await fetchImpl(url.toString());
      if (!res.ok) return null;
      return (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
    };
    const short = await exchange({ redirect_uri: env.redirectUri, code });
    if (!short?.access_token) return back("erro");
    // A long-lived user token (~60 days), as the MASO kept.
    const long = await exchange({
      grant_type: "fb_exchange_token",
      fb_exchange_token: short.access_token,
    });
    const token = long?.access_token ?? short.access_token;
    const expiresIn = long?.access_token ? long.expires_in : short.expires_in;
    try {
      const me = await graph<{ id?: string; name?: string }>(
        env,
        fetchImpl,
        token,
        "/me",
        { fields: "id,name" },
      );
      const accounts = await graphAll<{
        account_id?: string;
        name?: string;
        currency?: string;
        account_status?: number;
      }>(env, fetchImpl, token, "/me/adaccounts", {
        fields: "account_id,name,currency,account_status",
        limit: "200",
      });
      const stored = await callRpc<number>(
        env,
        fetchImpl,
        null,
        "ad_complete_meta_connect",
        {
          p_state: state,
          p_fb_user_id: me.id ?? "",
          p_fb_user_name: me.name ?? "",
          p_token_cipher: seal(key, token),
          p_expires_at: expiresIn
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : null,
          p_accounts: accounts.map((a) => ({
            account_id: a.account_id ?? "",
            name: a.name ?? "",
            currency: a.currency ?? "",
            account_status: a.account_status ?? null,
          })),
        },
      );
      if (!stored.ok) return back("expirado");
      return back(stored.data > 0 ? "conectado" : "sem-contas");
    } catch {
      return back("erro");
    }
  }

  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: env.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return back("erro");
  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  if (!token.refresh_token) return back("erro");
  if (!(token.scope ?? "").split(" ").includes(GOOGLE_ADS_SCOPE))
    return back("sem-permissao");
  const me = await fetchImpl(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  )
    .then((r) => (r.ok ? r.json() : {}))
    .then((body) => body as { email?: string })
    .catch((): { email?: string } => ({}));
  const stored = await callRpc(
    env,
    fetchImpl,
    null,
    "ad_complete_google_connect",
    {
      p_state: state,
      p_email: me.email ?? "",
      p_scope: token.scope ?? "",
      p_refresh_cipher: seal(key, token.refresh_token),
      p_access_cipher: seal(key, token.access_token),
      p_expires_at: new Date(
        Date.now() + token.expires_in * 1000,
      ).toISOString(),
    },
  );
  return back(stored.ok ? "conectado" : "expirado");
}

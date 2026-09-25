import crypto from "node:crypto";
import { callRpc } from "./_drive.js";
import { unseal } from "./_google.js";
import { AdsError, graph, type AdsEnv, type Fetch } from "./_ads.js";

/**
 * Campanhas: the leads of Facebook lead forms (Meta Lead Ads), received by
 * the app's "leadgen" webhook (/api/meta-leadgen) and sent to the Make
 * capture page the form is linked to (migration 20261010090000_ad_lead_forms),
 * as the MASO's webhook/facebook/leadgen.php did: the same payload to the
 * Make optin API (/api/optin/v7), the same field mapping and UTMs, and the
 * raw notice forwarded to the automation flow.
 *
 * Fixed from the MASO: the notice's signature is checked (X-Hub-Signature-256
 * with the app secret) and the verify token comes from the environment; each
 * lead is delivered once (the MASO let a second copy through); a failure is
 * retried by Facebook (answering 500) instead of being lost; the phone clean
 * up no longer drops every "5" of the number; tokens are sealed at rest.
 */
export type LeadgenEnv = AdsEnv & {
  /** ADS_SYNC_SECRET: how the server proves itself to the database. */
  secret: string;
  /** META_WEBHOOK_VERIFY_TOKEN: typed in the Meta app's webhook setup. */
  verifyToken: string;
  /** The Make optin API. */
  optinUrl: string;
  /** LEADGEN_FORWARD_URL: where the raw notice is also sent (optional). */
  forwardUrl: string;
};

export const MAKE_OPTIN_URL =
  "https://www.makevendas.com.br/api/optin/v7/index.php";

export function leadgenEnv(
  env: Record<string, string | undefined>,
  base: AdsEnv,
): LeadgenEnv {
  const https = (v: string | undefined) =>
    v && /^https:\/\//.test(v.trim()) ? v.trim() : "";
  return {
    ...base,
    secret: env.ADS_SYNC_SECRET ?? "",
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN ?? "",
    optinUrl: https(env.MAKE_OPTIN_URL) || MAKE_OPTIN_URL,
    forwardUrl: https(env.LEADGEN_FORWARD_URL),
  };
}

/** The variables the webhook still needs (names only). */
export function leadgenMissing(env: LeadgenEnv) {
  const missing: string[] = [];
  if (!env.meta.appSecret) missing.push("META_APP_SECRET");
  if (!env.verifyToken) missing.push("META_WEBHOOK_VERIFY_TOKEN");
  if (!env.secret) missing.push("ADS_SYNC_SECRET");
  if (!env.tokenKey) missing.push("GOOGLE_TOKEN_KEY_ADS");
  return missing;
}

/** Meta's GET to confirm the callback URL (hub.mode / hub.verify_token). */
export function verifySubscription(query: URLSearchParams, env: LeadgenEnv) {
  const ok =
    query.get("hub.mode") === "subscribe" &&
    !!env.verifyToken &&
    safeEqual(query.get("hub.verify_token") ?? "", env.verifyToken);
  return ok
    ? { status: 200, body: query.get("hub.challenge") ?? "" }
    : { status: 403, body: "Token de verificação inválido." };
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256(raw body, app secret). */
export function validSignature(
  raw: string,
  header: string | null | undefined,
  appSecret: string,
) {
  if (!header || !appSecret) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(raw, "utf8").digest("hex");
  return safeEqual(header.trim(), expected);
}

// ------------------------------------------------------------ fields
/**
 * The MASO's field reference (leadgen.php): the first word found in the
 * field's name says what it is. Order matters (it is the MASO's).
 */
const REFERENCES: [string, string][] = [
  ["nome", "nome"],
  ["nome completo", "nome"],
  ["nomecompleto", "nome"],
  ["nome_completo", "nome"],
  ["empresa", "empresa"],
  ["email", "email"],
  ["mail", "email"],
  ["telefone", "telefone"],
  ["celular", "celular"],
  ["whatsapp", "whatsapp"],
  ["phone", "telefone"],
  ["cargo", "cargo"],
  ["name", "nome"],
  ["full_name", "nome"],
  ["first_name", "nome"],
  ["company", "empresa"],
  ["job", "cargo"],
  ["business", "empresa"],
  ["nombre", "nome"],
  ["nombre_completo", "nome"],
  ["apellidos", "nome"],
  ["nombre_y_apellidos", "nome"],
  ["telefono", "telefone"],
  ["numero_de_telefono", "telefone"],
  ["número_de_teléfono", "telefone"],
  ["correo", "email"],
  ["eletronico", "email"],
  ["correo_electronico", "email"],
  ["correo_electrónico", "email"],
  ["nombre_de_la_empresa", "empresa"],
];

/** The MASO's name clean up: lowercase letters, digits and "_" only. */
export const fieldName = (name: string) =>
  name.replace(/[^a-zA-Z0-9_]+/g, "").toLowerCase();

export function referenceOf(name: string) {
  for (const [word, reference] of REFERENCES) {
    if (!name.includes(word)) continue;
    // "nome da empresa" / "company name" is the company.
    if (
      (word === "nome" || word === "name") &&
      /empresa|business|company/.test(name)
    )
      return "empresa";
    return reference;
  }
  return "";
}

/**
 * Clients of the Make that want the phone as "(DD)number" (the MASO's list
 * in leadgen.php).
 */
const PHONE_WITH_AREA_CODE = new Set(["2832", "2814", "2843", "2818"]);
export function formatPhone(value: string) {
  const v = value.replace(/-/g, "");
  if (v.includes("(")) return v;
  const digits = v.replace(/^\s*\+?\s*55/, "").replace(/\D/g, "");
  return digits.length > 9
    ? `(${digits.slice(0, 2)})${digits.slice(2)}`
    : digits;
}

export type FacebookLead = {
  id: string;
  field_data?: { name: string; values?: string[] }[];
};
export type Utm = {
  Source: string;
  Medium: string;
  Campaign: string;
  Term: string;
  Content: string;
};

/** The body the Make optin API takes (the MASO's $data_bd_make). */
export function optinPayload(
  lead: FacebookLead,
  target: { landing_page_id: string; make_user_id: string },
  utm: Utm | null,
) {
  const columns: string[] = [];
  const fields: Record<
    string,
    {
      id: number;
      nome: string;
      tipo: number;
      obrigatorio: number;
      valor: string;
      referencia: string;
    }
  > = {};
  let email = "";
  let phone = "";
  const formatted = PHONE_WITH_AREA_CODE.has(target.make_user_id);
  (lead.field_data ?? []).forEach((field, index) => {
    const name = fieldName(field.name ?? "");
    const reference = referenceOf(name);
    let value = String(field.values?.[0] ?? "");
    if (reference === "telefone") {
      if (formatted) value = formatPhone(value);
      phone = value;
    } else if (reference === "email") email = value;
    columns.push(name);
    fields[name] = {
      id: index,
      nome: name,
      tipo: 0,
      obrigatorio: 1,
      valor: value,
      referencia: reference,
    };
  });
  return {
    id_usuario: target.make_user_id,
    id_capture: target.landing_page_id,
    duplo_lead: 1,
    valor_campo_email: email,
    valor_campo_celular: phone,
    coluna: columns,
    campos: fields,
    fonte: 0,
    browser_name: "",
    browser_version: "",
    device_model: "",
    device_type: "",
    device_vendor: "",
    os_name: "",
    os_version: "",
    usuario_ip: 0,
    usuario_cidade: 0,
    usuario_estado: 0,
    usuario_pais: 0,
    usuario_loc: 0,
    // The MASO sent an empty list when the ad's names weren't found.
    utm: utm ?? [],
    url: "leadgen",
    fbclid: lead.id,
  };
}

/** The first complete JSON object of a text ({} when there is none). */
export function firstJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  if (start < 0) return {};
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return {};
      }
    }
  }
  return {};
}

// ------------------------------------------------------------ delivery
type Claim =
  | { skip: true; reason: string }
  | {
      skip: false;
      company_id: string;
      lead_form_id: string;
      landing_page_id: string;
      make_user_id: string;
      page_token_cipher: string;
      account_token_ciphers: string[];
    };
type Notice = {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        leadgen_id?: string | number;
        form_id?: string | number;
        page_id?: string | number;
      };
    }[];
  }[];
};
export type LeadResult = {
  leadgen_id: string;
  status: "sent" | "duplicate" | "error" | "skipped";
  reason?: string;
  retry?: boolean;
};

/** The ad, ad set and campaign names (UTMs): the Page's token, else an ad account's. */
async function adNames(
  env: LeadgenEnv,
  fetchImpl: Fetch,
  leadgen: string,
  tokens: string[],
): Promise<Utm | null> {
  for (const token of tokens) {
    try {
      const ad = await graph<{
        ad_name?: string;
        adset_name?: string;
        campaign_name?: string;
      }>(env, fetchImpl, token, `/${leadgen}`, {
        fields: "ad_name,adset_name,campaign_name",
      });
      if (ad.campaign_name || ad.ad_name)
        return {
          Source: "Meta",
          Medium: "Paid Traffic",
          Campaign: ad.campaign_name ?? "",
          Term: ad.adset_name ?? "",
          Content: ad.ad_name ?? "",
        };
    } catch {
      // The next token may see the ad.
    }
  }
  return null;
}

async function deliver(
  env: LeadgenEnv,
  fetchImpl: Fetch,
  leadgen: string,
  target: Extract<Claim, { skip: false }>,
): Promise<{
  status: "sent" | "duplicate" | "error";
  message: string;
  retry: boolean;
}> {
  const pageToken = unseal(env.tokenKey!, target.page_token_cipher);
  let lead: FacebookLead;
  try {
    lead = await graph<FacebookLead>(env, fetchImpl, pageToken, `/${leadgen}`, {
      fields: "id,created_time,field_data",
    });
  } catch (e) {
    const expired = e instanceof AdsError && e.code === "expired";
    return {
      status: "error",
      message: expired
        ? "O acesso à página do Facebook expirou: integre o formulário de novo."
        : `Não foi possível ler o cadastro no Facebook: ${(e as Error).message}`,
      retry: !expired,
    };
  }
  const accountTokens = target.account_token_ciphers.flatMap((c) => {
    try {
      return [unseal(env.tokenKey!, c)];
    } catch {
      return [];
    }
  });
  const utm = await adNames(env, fetchImpl, leadgen, [
    pageToken,
    ...accountTokens,
  ]);
  let res: Response;
  try {
    res = await fetchImpl(env.optinUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic" },
      body: JSON.stringify(optinPayload(lead, target, utm)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return {
      status: "error",
      message: `A Make não respondeu: ${(e as Error).message}`,
      retry: true,
    };
  }
  const text = await res.text();
  // The optin API may print more after its JSON: the first object counts.
  const answer = firstJson(text) as {
    resposta?: number | string;
    lead_duplicado?: number | string;
  };
  if (!res.ok)
    return {
      status: "error",
      message: `A Make respondeu ${res.status}.`,
      retry: res.status >= 500,
    };
  if (Number(answer.lead_duplicado) === 1)
    return {
      status: "duplicate",
      message: "A Make já tinha este cadastro.",
      retry: false,
    };
  if (String(answer.resposta) === "0")
    return { status: "sent", message: "", retry: false };
  if (String(answer.resposta) === "2")
    return {
      status: "error",
      message:
        "A página de captura exige campos que o formulário do Facebook não tem.",
      retry: false,
    };
  return {
    status: "error",
    message: `Resposta inesperada da Make: ${text.slice(0, 200)}`,
    retry: false,
  };
}

/**
 * Meta's POST: each lead of the notice claimed (once), read with the Page's
 * token and sent to its capture page. 200 when done; 500 when a lead failed
 * for a reason that may pass, so Facebook sends it again.
 */
export async function handleLeadgen(
  raw: string,
  signature: string | null | undefined,
  env: LeadgenEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const missing = leadgenMissing(env);
  if (missing.length)
    return {
      status: 500,
      body: { error: `Webhook não configurado. Falta: ${missing.join(", ")}.` },
    };
  if (!validSignature(raw, signature, env.meta.appSecret))
    return { status: 401, body: { error: "Assinatura inválida." } };
  let notice: Notice;
  try {
    notice = JSON.parse(raw) as Notice;
  } catch {
    return { status: 400, body: { error: "JSON inválido." } };
  }
  // The automation flow receives every notice, as it did from the MASO.
  if (env.forwardUrl)
    await fetchImpl(env.forwardUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
  if (notice.object !== "page") return { status: 200, body: { ignored: true } };

  const results: LeadResult[] = [];
  for (const entry of notice.entry ?? [])
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const leadgen = String(change.value?.leadgen_id ?? "");
      if (!/^[0-9]{1,40}$/.test(leadgen)) continue;
      const claimed = await callRpc<Claim>(
        env,
        fetchImpl,
        null,
        "ad_leadgen_claim",
        {
          p_secret: env.secret,
          p_leadgen: leadgen,
          p_page: String(change.value?.page_id ?? entry.id ?? ""),
          p_form: String(change.value?.form_id ?? ""),
        },
      );
      if (!claimed.ok) {
        results.push({
          leadgen_id: leadgen,
          status: "error",
          reason: claimed.error,
          retry: true,
        });
        continue;
      }
      if (claimed.data.skip) {
        results.push({
          leadgen_id: leadgen,
          status: "skipped",
          reason: claimed.data.reason,
        });
        continue;
      }
      let outcome: Awaited<ReturnType<typeof deliver>>;
      try {
        outcome = await deliver(env, fetchImpl, leadgen, claimed.data);
      } catch (e) {
        outcome = {
          status: "error",
          message: (e as Error).message,
          retry: true,
        };
      }
      await callRpc(env, fetchImpl, null, "ad_leadgen_finish", {
        p_secret: env.secret,
        p_leadgen: leadgen,
        p_status: outcome.status,
        p_message: outcome.message,
      });
      results.push({
        leadgen_id: leadgen,
        status: outcome.status,
        reason: outcome.message || undefined,
        retry: outcome.status === "error" ? outcome.retry : undefined,
      });
    }
  const retry = results.some((r) => r.status === "error" && r.retry);
  return { status: retry ? 500 : 200, body: { leads: results } };
}

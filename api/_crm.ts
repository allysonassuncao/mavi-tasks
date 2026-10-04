import { callRpc } from "./_drive.js";

/**
 * Campanhas › Abrir no CRM (migração 20270320090000_makecrm_links).
 *
 * O MakeCRM é outro SaaS, com outro Supabase, em que cada login pertence a
 * uma empresa só. O banco do MAVI confere se a pessoa vê o cliente em
 * Campanhas e registra a abertura; este servidor pede então ao servidor do
 * MakeCRM (POST /api/mavi-sso, com o segredo MAKECRM_SSO_SECRET, que nenhum
 * dos dois bancos tem) o link de entrada de uso único do login desta pessoa
 * naquela empresa. O MakeCRM cria esse login no primeiro clique, com o papel
 * dela no MAVI (administrador → Admin, gestor → Gerente, colaborador →
 * Equipe Interna, que só olha). O MAVI nunca guarda chave do MakeCRM.
 *
 * POST /api/crm com o login do MAVI:
 *  - {action: "companies", company}: as empresas do MakeCRM para ligar a um
 *    cliente (só administradores e gestores);
 *  - {action: "open", company, client, next?}: {url} para abrir numa aba
 *    nova; next leva ao funil já filtrado (/pipeline-v2?…).
 *  - {action: "utm", company, client, since, until}: as oportunidades e os
 *    ganhos do MakeCRM por UTM no período (data de criação da oportunidade),
 *    os números da página Anúncios do CRM, para Campanhas › Plataforma. Quem
 *    vê o cliente em Campanhas lê a ligação dele (regra da tabela
 *    client_crm_links); sem ligação, {linked: false}.
 */
export type CrmEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  /** Onde o MakeCRM responde (sem a barra final). */
  crmUrl: string;
  /** null: atalho desligado até configurar. */
  secret: string | null;
};
type Fetch = typeof fetch;
type Result = { status: number; body: Record<string, unknown> };

export function crmEnv(
  env: Record<string, string | undefined> = process.env,
): CrmEnv {
  return {
    supabaseUrl:
      env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co",
    supabaseKey:
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
    crmUrl: (env.MAKECRM_URL || "https://app.usemakecrm.com.br").replace(
      /\/+$/,
      "",
    ),
    secret:
      env.MAKECRM_SSO_SECRET && env.MAKECRM_SSO_SECRET.length >= 32
        ? env.MAKECRM_SSO_SECRET
        : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(["admin", "manager", "member"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Where "open" may land: the MakeCRM's pipeline, filters in the URL. */
export const isCrmNext = (next: unknown): next is string =>
  typeof next === "string" &&
  next.length <= 2000 &&
  /^\/pipeline-v2\?[^#\s]*$/.test(next);

/** The MakeCRM's numbers per UTM (sql/mavi_utm_deals.sql in the CRM). */
export type CrmUtmDeals = {
  /** [utm_campaign, oportunidades, ganhos, oportunidades ganhas, receita] */
  campaigns: [string, number, number, number, number][];
  /** [utm_campaign, utm_term, oportunidades, ganhos, ganhas, receita] */
  adsets: [string, string, number, number, number, number][];
  /** [utm_campaign, utm_term, utm_content, linhas, ganhos, ganhas, receita] */
  ads: [string, string, string, number, number, number, number][];
};
/** Only well-formed rows: [texts…, numbers…]. */
function utmRows<T>(rows: unknown, texts: number, numbers: number): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r) =>
      Array.isArray(r) &&
      r.length === texts + numbers &&
      r.slice(0, texts).every((v) => typeof v === "string") &&
      r.slice(texts).every((v) => typeof v === "number" && Number.isFinite(v)),
  ) as T[];
}

export type CrmCompany = {
  id: string;
  make_id: number | null;
  active: boolean;
  admins: { name: string; email: string }[];
};

const fail = (status: number, error: string): Result => ({
  status,
  body: { error },
});

/** Pergunta ao servidor do MakeCRM, com o segredo. */
async function askCrm<T>(
  env: CrmEnv,
  fetchImpl: Fetch,
  body: Record<string, unknown>,
): Promise<
  { ok: true; data: T } | { ok: false; status: number; error: string }
> {
  let res: Response;
  try {
    res = await fetchImpl(`${env.crmUrl}/api/mavi-sso`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mavi-Secret": env.secret!,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      error: "O MakeCRM não respondeu. Tente de novo em instantes.",
    };
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok)
    return {
      ok: false,
      // 401 here is the secret, not the person: a configuration problem.
      status: res.status === 401 ? 502 : res.status >= 500 ? 502 : res.status,
      error:
        res.status === 401
          ? "O MakeCRM recusou o MAVI: confira o MAKECRM_SSO_SECRET nos dois lados."
          : typeof data?.error === "string"
            ? data.error
            : "O MakeCRM não conseguiu atender agora.",
    };
  return { ok: true, data: data as T };
}

/**
 * The MakeCRM's deals per UTM of a CRM company in a period (days of
 * Brasília, as its Anúncios page asks). Also used by the insights worker,
 * which reads the link with the worker's secret.
 */
export async function crmUtmDeals(
  env: CrmEnv,
  fetchImpl: Fetch,
  crmCompany: string,
  since: string,
  until: string,
): Promise<
  { ok: true; data: CrmUtmDeals } | { ok: false; status: number; error: string }
> {
  const r = await askCrm<Record<string, unknown>>(env, fetchImpl, {
    action: "utm-deals",
    company_id: crmCompany,
    date_start: `${since}T00:00:00.000-03:00`,
    date_end: `${until}T23:59:59.999-03:00`,
  });
  if (!r.ok) return r;
  return {
    ok: true,
    data: {
      campaigns: utmRows(r.data?.campaigns, 1, 4),
      adsets: utmRows(r.data?.adsets, 2, 4),
      ads: utmRows(r.data?.ads, 3, 4),
    },
  };
}

/** O funil do CRM por UTM (sql/mavi_utm_funnel.sql no CRM). */
export type CrmFunnelRow = {
  /** c: campanha; s: campanha + termo; a: campanha + termo + conteúdo. */
  l: "c" | "s" | "a";
  c: string;
  t: string;
  n: string;
  deals: number;
  open: number;
  won: number;
  lost: number;
  qualified: number;
  score: number | null;
  /** Abertas por etapa atual; até onde cada uma chegou; perdas por motivo; faixas; opções. */
  at: Record<string, number> | null;
  reach: Record<string, number> | null;
  lost_by: Record<string, number> | null;
  buckets: Record<string, number> | null;
  answers: Record<string, number> | null;
};
export type CrmFunnel = {
  rows: CrmFunnelRow[];
  pipelines: { id: string; name: string }[];
  stages: { id: string; pipeline_id: string; name: string; order: number | null }[];
  reasons: { id: string; name: string }[];
  buckets: { id: string; name: string; form: string; min: number | null; max: number | null }[];
  options: { id: string; label: string; question: string; form: string }[];
};
const counts = (v: unknown): Record<string, number> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>))
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = n;
  return Object.keys(out).length ? out : null;
};
const list = <T>(v: unknown, ok: (x: any) => boolean): T[] => (Array.isArray(v) ? v.filter(ok) : []);
/** Só o que é bem formado (o CRM é outro sistema). */
export function funnelFrom(raw: any): CrmFunnel {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  return {
    rows: list<any>(raw?.rows, (r) => r && ["c", "s", "a"].includes(r.l) && typeof r.c === "string").map((r) => ({
      l: r.l,
      c: r.c,
      t: typeof r.t === "string" ? r.t : "",
      n: typeof r.n === "string" ? r.n : "",
      deals: n(r.deals),
      open: n(r.open),
      won: n(r.won),
      lost: n(r.lost),
      qualified: n(r.qualified),
      score: r.score === null || r.score === undefined ? null : n(r.score),
      at: counts(r.at),
      reach: counts(r.reach),
      lost_by: counts(r.lost_by),
      buckets: counts(r.buckets),
      answers: counts(r.answers),
    })),
    pipelines: list(raw?.pipelines, (x) => typeof x?.id === "string"),
    stages: list<any>(raw?.stages, (x) => typeof x?.id === "string").map((x) => ({
      id: x.id,
      pipeline_id: String(x.pipeline_id ?? ""),
      name: String(x.name ?? ""),
      order: x.order === null || x.order === undefined ? null : n(x.order),
    })),
    reasons: list(raw?.reasons, (x) => typeof x?.id === "string" || typeof x?.id === "number").map((x: any) => ({
      id: String(x.id),
      name: String(x.name ?? ""),
    })),
    buckets: list(raw?.buckets, (x) => typeof x?.id === "string"),
    options: list(raw?.options, (x) => typeof x?.id === "string"),
  };
}
/**
 * O funil por UTM de uma empresa do CRM no período (dias de Brasília):
 * etapa alcançada, perdas com motivo e qualificação. Usado pelos Insights.
 */
export async function crmUtmFunnel(
  env: CrmEnv,
  fetchImpl: Fetch,
  crmCompany: string,
  since: string,
  until: string,
): Promise<{ ok: true; data: CrmFunnel } | { ok: false; status: number; error: string }> {
  const r = await askCrm<Record<string, unknown>>(env, fetchImpl, {
    action: "utm-funnel",
    company_id: crmCompany,
    date_start: `${since}T00:00:00.000-03:00`,
    date_end: `${until}T23:59:59.999-03:00`,
  });
  if (!r.ok) return r;
  return { ok: true, data: funnelFrom(r.data) };
}

export async function handleCrm(
  body: any,
  authorization: string | null,
  env: CrmEnv,
  fetchImpl: Fetch = fetch,
): Promise<Result> {
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");
  if (!env.secret)
    return fail(
      503,
      "O atalho do MakeCRM ainda não está configurado: falta o MAKECRM_SSO_SECRET no servidor.",
    );
  const { action, company } = body ?? {};
  if (!UUID.test(company ?? "")) return fail(400, "Empresa inválida.");

  if (action === "companies") {
    const allowed = await callRpc<boolean>(
      env,
      fetchImpl,
      authorization,
      "crm_link_admin",
      {
        p_company: company,
      },
    );
    if (!allowed.ok) return fail(allowed.status, allowed.error);
    const r = await askCrm<{ companies?: CrmCompany[] }>(env, fetchImpl, {
      action: "companies",
    });
    if (!r.ok) return fail(r.status, r.error);
    return {
      status: 200,
      body: {
        companies: Array.isArray(r.data?.companies) ? r.data.companies : [],
      },
    };
  }

  if (action === "utm") {
    const { client, until } = body;
    // "Máximo": no start, everything the CRM has.
    const since = body.since || "2000-01-01";
    if (!UUID.test(client ?? "")) return fail(400, "Cliente inválido.");
    if (!DAY.test(since) || !DAY.test(until ?? "") || since > until)
      return fail(400, "Período inválido.");
    const res = await fetchImpl(
      `${env.supabaseUrl}/rest/v1/client_crm_links?select=crm_company_id&company_id=eq.${company}&client_id=eq.${client}`,
      { headers: { apikey: env.supabaseKey, Authorization: authorization } },
    );
    if (!res.ok)
      return fail(
        res.status === 401 || res.status === 403 ? 403 : 502,
        "Não foi possível conferir a ligação do cliente com o MakeCRM.",
      );
    const rows = (await res.json().catch(() => [])) as {
      crm_company_id?: string;
    }[];
    const crmCompany = Array.isArray(rows) ? rows[0]?.crm_company_id : null;
    if (!crmCompany || !UUID.test(crmCompany))
      return { status: 200, body: { linked: false } };
    const r = await crmUtmDeals(env, fetchImpl, crmCompany, since, until);
    if (!r.ok) return fail(r.status, r.error);
    return { status: 200, body: { linked: true, ...r.data } };
  }

  if (action === "open") {
    const { client, next } = body;
    if (!UUID.test(client ?? "")) return fail(400, "Cliente inválido.");
    if (next !== undefined && !isCrmNext(next))
      return fail(400, "Destino inválido no MakeCRM.");
    const who = await callRpc<{
      crm_company_id: string;
      user_id: string;
      email: string;
      name: string;
      role: string;
    }>(env, fetchImpl, authorization, "crm_open", {
      p_company: company,
      p_client: client,
    });
    if (!who.ok) return fail(who.status, who.error);
    const { crm_company_id, user_id, email, name, role } = who.data;
    if (!UUID.test(crm_company_id) || !UUID.test(user_id) || !ROLES.has(role))
      return fail(500, "Resposta inesperada do banco.");
    const r = await askCrm<{ url?: string }>(env, fetchImpl, {
      action: "login",
      company_id: crm_company_id,
      person: { id: user_id, email, name },
      role,
      ...(next ? { next } : {}),
    });
    if (!r.ok) return fail(r.status, r.error);
    const url = r.data?.url;
    // Only the MakeCRM's own address goes back to the browser.
    if (typeof url !== "string" || !url.startsWith(`${env.crmUrl}/`))
      return fail(502, "O MakeCRM devolveu um link inesperado.");
    return { status: 200, body: { url } };
  }

  return fail(400, "Ação desconhecida.");
}

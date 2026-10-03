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
 *  - {action: "open", company, client}: {url} para abrir numa aba nova.
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

  if (action === "open") {
    const { client } = body;
    if (!UUID.test(client ?? "")) return fail(400, "Cliente inválido.");
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

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";

// CORS is an additional browser restriction; JWT + live admin membership remain
// mandatory because non-browser callers can forge the Origin header.
export function createInviteHandler(
  origin: string,
  createAdmin: () => SupabaseClient,
  additionalOrigins: string[] = [],
) {
  const allowedOrigins = new Set(
    [origin, ...additionalOrigins].filter(Boolean),
  );
  return async (req: Request) => {
    const requestOrigin = req.headers.get("origin");
    const authorizedOrigin =
      requestOrigin !== null && allowedOrigins.has(requestOrigin);
    const headers = {
      "Access-Control-Allow-Origin": authorizedOrigin ? requestOrigin : origin,
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      Vary: "Origin",
    };
    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers });
    if (!origin) return reply(503, { error: "Aplicação não configurada." });
    if (!authorizedOrigin)
      return reply(403, { error: "Origem não autorizada." });
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (req.method !== "POST")
      return reply(405, { error: "Método não permitido." });
    try {
      const token = req.headers
        .get("Authorization")
        ?.replace(/^Bearer\s+/i, "");
      if (!token) return reply(401, { error: "Autenticação necessária." });
      const admin = createAdmin();
      const {
        data: { user },
        error: authError,
      } = await admin.auth.getUser(token);
      if (authError || !user) return reply(401, { error: "Sessão inválida." });
      let body;
      try {
        body = await req.json();
      } catch {
        return reply(400, { error: "JSON inválido." });
      }
      const { company_id, email, name, role } = body ?? {};
      if (
        typeof company_id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(company_id) ||
        typeof email !== "string" ||
        email.length > 254 ||
        !/^\S+@\S+\.\S+$/.test(email) ||
        typeof name !== "string" ||
        name.trim().length < 2 ||
        name.length > 120 ||
        !["admin", "manager", "member"].includes(role)
      )
        return reply(400, { error: "Revise os dados do convite." });
      const { data: membership, error: membershipError } = await admin
        .from("memberships")
        .select("role,active")
        .eq("company_id", company_id)
        .eq("user_id", user.id)
        .single();
      if (membershipError || !membership?.active || membership.role !== "admin")
        return reply(403, {
          error: "Somente administradores desta empresa podem convidar.",
        });
      const { data: quota, error: quotaError } = await admin.rpc(
        "consume_invite_limit",
        {
          p_company: company_id,
          p_actor: user.id,
        },
      );
      if (quotaError || !quota)
        return reply(503, {
          error: "Não foi possível verificar o limite de convites.",
        });
      if (!quota.allowed)
        return new Response(
          JSON.stringify({
            error: "Limite de convites atingido. Tente novamente mais tarde.",
          }),
          {
            status: 429,
            headers: { ...headers, "Retry-After": String(quota.retry_after) },
          },
        );
      const { data: invited, error: inviteError } =
        await admin.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), {
          redirectTo: requestOrigin + "/?setup=1",
          data: { name: name.trim() },
        });
      if (inviteError || !invited.user)
        return reply(400, {
          error:
            "Não foi possível enviar o convite. Confirme o endereço e verifique se a conta já existe.",
        });
      const { error: writeError } = await admin.from("memberships").insert({
        company_id,
        user_id: invited.user.id,
        name: name.trim(),
        role,
        active: true,
      });
      if (writeError)
        return reply(409, {
          error:
            "O e-mail foi enviado, mas o vínculo não foi criado. O administrador deve revisar o vínculo antes de reenviar.",
          user_id: invited.user.id,
        });
      return reply(200, { user_id: invited.user.id });
    } catch {
      return reply(500, { error: "Não foi possível processar o convite." });
    }
  };
}

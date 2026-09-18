// Deploy only after configuring APP_ORIGIN and Auth redirect allowlist.
// Invoked by an explicit administrator action; never run automatically.
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
const origin = Deno.env.get("APP_ORIGIN")!;
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  Vary: "Origin",
};
Deno.serve(async (req) => {
  const reply = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers });
  if (!origin) return reply(503, { error: "Aplicação não configurada." });
  if (req.headers.get("origin") && req.headers.get("origin") !== origin)
    return reply(403, { error: "Origem não autorizada." });
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (req.method !== "POST")
    return reply(405, { error: "Método não permitido." });
  try {
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return reply(401, { error: "Autenticação necessária." });
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const {
      data: { user },
      error: authError,
    } = await admin.auth.getUser(token);
    if (authError || !user) return reply(401, { error: "Sessão inválida." });
    const { company_id, email, name, role } = await req.json();
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
    const { data: invited, error: inviteError } =
      await admin.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), {
        redirectTo: origin + "/?setup=1",
        data: { name: name.trim() },
      });
    if (inviteError || !invited.user)
      return reply(400, {
        error:
          "Não foi possível enviar o convite. Confirme o endereço e verifique se a conta já existe.",
      });
    const { error: writeError } = await admin
      .from("memberships")
      .insert({
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
});

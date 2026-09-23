import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";

export function createUserAdminHandler(
  origin: string,
  createAdmin: () => SupabaseClient,
  additionalOrigins: string[] = [],
) {
  const allowedOrigins = new Set(
    [origin, ...additionalOrigins].filter(Boolean),
  );

  return async (req: Request) => {
    const requestOrigin = req.headers.get("origin");
    const isLocalhost =
      requestOrigin !== null &&
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin);
    const authorizedOrigin =
      (requestOrigin !== null && allowedOrigins.has(requestOrigin)) ||
      Boolean(isLocalhost);
    const headers = {
      "Access-Control-Allow-Origin":
        authorizedOrigin && requestOrigin ? requestOrigin : origin,
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
        data: { user: caller },
        error: authError,
      } = await admin.auth.getUser(token);
      if (authError || !caller)
        return reply(401, { error: "Sessão inválida." });

      let body: Record<string, unknown> = {};
      try {
        body = await req.json();
      } catch {
        return reply(400, { error: "JSON inválido." });
      }

      const { company_id, target_user_id, action } = body;
      if (
        typeof company_id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(company_id) ||
        typeof target_user_id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(target_user_id)
      ) {
        return reply(400, { error: "Parâmetros de identificação inválidos." });
      }

      // Check caller is active admin of this company
      const { data: callerMembership, error: callerMemError } = await admin
        .from("memberships")
        .select("role,active")
        .eq("company_id", company_id)
        .eq("user_id", caller.id)
        .single();

      if (
        callerMemError ||
        !callerMembership?.active ||
        (callerMembership.role !== "admin" &&
          callerMembership.role !== "manager")
      ) {
        return reply(403, {
          error:
            "Somente administradores ou gestores desta empresa podem executar esta ação.",
        });
      }

      // Check target user belongs to this company
      const { data: targetMembership, error: targetMemError } = await admin
        .from("memberships")
        .select("user_id,name,role,active,email")
        .eq("company_id", company_id)
        .eq("user_id", target_user_id)
        .single();

      if (targetMemError || !targetMembership) {
        return reply(404, {
          error: "Usuário não encontrado nesta empresa.",
        });
      }

      // Handle SYNC ACCESS: after update_member changes someone's status, the
      // Auth account follows the memberships — banned while no company keeps
      // the person active (so they can't sign in or refresh a session), and
      // unbanned otherwise. It only mirrors the database, so it cannot be used
      // to lock out anyone the caller could not deactivate.
      if (action === "sync_access") {
        const { data: rows, error: rowsError } = await admin
          .from("memberships")
          .select("active")
          .eq("user_id", target_user_id);
        if (rowsError)
          return reply(500, { error: "Não foi possível ler os acessos." });
        const active = (rows ?? []).some((r: { active: boolean }) => r.active);
        const { error: banError } = await admin.auth.admin.updateUserById(
          target_user_id,
          { ban_duration: active ? "none" : "876000h" },
        );
        if (banError)
          return reply(400, {
            error: banError.message || "Não foi possível atualizar o acesso.",
          });
        return reply(200, { success: true, active });
      }

      // Fetch user's auth email if not in membership
      let targetEmail = targetMembership.email?.trim() || "";
      if (!targetEmail) {
        const { data: authTarget } =
          await admin.auth.admin.getUserById(target_user_id);
        targetEmail = authTarget?.user?.email?.trim() || "";
      }

      // Handle RESET PASSWORD
      if (action === "reset_password") {
        const mode =
          body.mode === "set_password" ? "set_password" : "send_link";

        if (mode === "set_password") {
          const newPassword = String(body.new_password ?? "").trim();
          if (newPassword.length < 8) {
            return reply(400, {
              error: "A nova senha deve ter no mínimo 8 caracteres.",
            });
          }

          const { error: pwdError } = await admin.auth.admin.updateUserById(
            target_user_id,
            { password: newPassword },
          );
          if (pwdError) {
            return reply(400, {
              error: pwdError.message || "Erro ao definir nova senha.",
            });
          }

          return reply(200, {
            success: true,
            message: "Senha atualizada com sucesso.",
          });
        } else {
          // Send link mode (and return generated recovery link if available)
          if (!targetEmail) {
            return reply(400, {
              error: "Usuário não possui e-mail cadastrado para recuperação.",
            });
          }

          let recoveryLink = "";
          try {
            const { data: linkData, error: linkError } =
              await admin.auth.admin.generateLink({
                type: "recovery",
                email: targetEmail,
                options: {
                  redirectTo: requestOrigin + "/?reset=1",
                },
              });
            if (!linkError && linkData?.properties?.action_link) {
              recoveryLink = linkData.properties.action_link;
            }
          } catch {
            // If generateLink is not configured, fall back to resetPasswordForEmail
          }

          const { error: resetError } = await admin.auth.resetPasswordForEmail(
            targetEmail,
            {
              redirectTo: requestOrigin + "/?reset=1",
            },
          );

          if (resetError && !recoveryLink) {
            return reply(400, {
              error:
                resetError.message || "Erro ao enviar e-mail de recuperação.",
            });
          }

          return reply(200, {
            success: true,
            link: recoveryLink || undefined,
            message: `Link de recuperação gerado para ${targetEmail}.`,
          });
        }
      }

      // Handle UPDATE EMAIL
      if (action === "update_email") {
        const newEmail = String(body.new_email ?? "")
          .trim()
          .toLowerCase();
        if (
          !newEmail ||
          newEmail.length > 254 ||
          !/^\S+@\S+\.\S+$/.test(newEmail)
        ) {
          return reply(400, { error: "Informe um e-mail válido." });
        }

        const { error: emailAuthError } = await admin.auth.admin.updateUserById(
          target_user_id,
          {
            email: newEmail,
            email_confirm: true,
          },
        );

        if (emailAuthError) {
          return reply(400, {
            error:
              emailAuthError.message ||
              "Não foi possível atualizar o e-mail (endereço já em uso ou inválido).",
          });
        }

        // Update in public.memberships
        await admin
          .from("memberships")
          .update({ email: newEmail })
          .eq("company_id", company_id)
          .eq("user_id", target_user_id);

        return reply(200, {
          success: true,
          email: newEmail,
          message: "E-mail atualizado com sucesso.",
        });
      }

      return reply(400, { error: "Ação não suportada." });
    } catch (err) {
      return reply(500, {
        error: (err as Error).message || "Erro interno ao gerenciar usuário.",
      });
    }
  };
}

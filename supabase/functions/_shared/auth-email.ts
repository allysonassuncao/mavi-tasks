/**
 * Turns a Supabase Auth error from an email-sending call (invite, password
 * recovery) into a message that says why nothing was sent. `status` is the
 * HTTP status to answer with.
 */
export function describeEmailError(
  error: { message?: string; status?: number; code?: string } | null,
  fallback: string,
): { status: number; message: string } {
  const message = error?.message ?? "";
  const code = error?.code ?? "";
  if (
    code === "over_email_send_rate_limit" ||
    error?.status === 429 ||
    /rate limit|security purposes|only request this after/i.test(message)
  )
    return {
      status: 429,
      message:
        "O limite de envio de e-mails do Supabase foi atingido. Aguarde alguns minutos e tente de novo — com o servidor de e-mail padrão, o limite é de poucos e-mails por hora.",
    };
  if (
    code === "email_address_not_authorized" ||
    /not authorized|not allowed/i.test(message)
  )
    return {
      status: 422,
      message:
        "O servidor de e-mail padrão do Supabase só envia para membros da equipe do projeto. Configure um SMTP próprio (Authentication → SMTP) para enviar a qualquer endereço.",
    };
  if (
    code === "email_exists" ||
    /already (been )?registered|already exists/i.test(message)
  )
    return { status: 409, message: "Já existe uma conta com este e-mail." };
  if (/sending|smtp|mail/i.test(message))
    return {
      status: 502,
      message:
        "O Supabase não conseguiu entregar o e-mail ao servidor de envio. Confira o SMTP configurado em Authentication → SMTP.",
    };
  return {
    status: 400,
    message: message ? `${fallback} (${message})` : fallback,
  };
}

/**
 * Supabase Auth answers in English ("Invalid login credentials"…). The login
 * and password screens show these words instead, in Brazilian Portuguese,
 * by the error's code when it has one and by its message otherwise.
 */
type AuthLikeError = {
  message?: string;
  code?: string;
  status?: number;
  name?: string;
} | null;

const BY_CODE: Record<string, string> = {
  invalid_credentials: "E-mail ou senha incorretos.",
  email_not_confirmed:
    "Seu e-mail ainda não foi confirmado. Abra o convite enviado para ele ou peça um novo ao administrador.",
  user_not_found: "E-mail ou senha incorretos.",
  user_banned:
    "Seu acesso a este espaço de trabalho foi desativado. Fale com o administrador.",
  over_request_rate_limit:
    "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.",
  over_email_send_rate_limit:
    "Muitos pedidos de e-mail agora. Tente de novo em alguns minutos.",
  weak_password:
    "Essa senha é fraca. Use pelo menos 12 caracteres, misturando letras, números e símbolos.",
  same_password: "A nova senha precisa ser diferente da atual.",
  session_expired: "Sua sessão expirou. Entre novamente.",
  session_not_found: "Sua sessão expirou. Entre novamente.",
  refresh_token_not_found: "Sua sessão expirou. Entre novamente.",
  refresh_token_already_used: "Sua sessão expirou. Entre novamente.",
  bad_jwt: "Sua sessão expirou. Entre novamente.",
  reauthentication_needed:
    "Por segurança, entre novamente antes de trocar a senha.",
  otp_expired:
    "Este link expirou ou já foi usado. Peça um novo ao administrador ou use “Esqueci minha senha”.",
  flow_state_expired:
    "Este link expirou ou já foi usado. Peça um novo ao administrador ou use “Esqueci minha senha”.",
  email_address_invalid: "Confira o e-mail digitado.",
  validation_failed: "Confira o e-mail e a senha digitados.",
  signup_disabled: "O acesso é só por convite. Fale com o administrador.",
  email_provider_disabled:
    "O acesso com e-mail e senha está desativado. Fale com o administrador.",
  captcha_failed:
    "Não foi possível confirmar que você não é um robô. Tente de novo.",
  request_timeout: "O servidor demorou para responder. Tente de novo.",
  unexpected_failure:
    "Não foi possível entrar agora. Tente de novo em instantes.",
};

const BY_MESSAGE: [RegExp, string][] = [
  [/invalid login credentials/i, BY_CODE.invalid_credentials],
  [/email not confirmed/i, BY_CODE.email_not_confirmed],
  [/banned/i, BY_CODE.user_banned],
  [/rate limit|too many requests/i, BY_CODE.over_request_rate_limit],
  [/should be different from the old password/i, BY_CODE.same_password],
  [/password should|password is known|weak password/i, BY_CODE.weak_password],
  [
    /(session|token|jwt).*(expired|missing|not found|invalid)/i,
    BY_CODE.session_expired,
  ],
  [/auth session missing/i, BY_CODE.session_expired],
  [
    /(link|otp|token) (is )?(invalid|has expired)|expired/i,
    BY_CODE.otp_expired,
  ],
  [
    /invalid.*email|email.*invalid|unable to validate email/i,
    BY_CODE.email_address_invalid,
  ],
  [/signups? not allowed/i, BY_CODE.signup_disabled],
  [
    /failed to fetch|load failed|networkerror|network request failed/i,
    "Sem conexão com o servidor. Verifique sua internet e tente de novo.",
  ],
];

export function authErrorMessage(error: AuthLikeError): string {
  const message = error?.message ?? "";
  const wait = /after (\d+) seconds?/i.exec(message)?.[1];
  if (wait)
    return `Por segurança, aguarde ${wait} segundos antes de tentar de novo.`;
  if (error?.code && BY_CODE[error.code]) return BY_CODE[error.code];
  for (const [pattern, text] of BY_MESSAGE)
    if (pattern.test(message)) return text;
  if (error?.status === 429) return BY_CODE.over_request_rate_limit;
  if (error?.name === "AuthRetryableFetchError" || error?.status === 0)
    return "Sem conexão com o servidor. Verifique sua internet e tente de novo.";
  if (error?.status && error.status >= 500) return BY_CODE.unexpected_failure;
  // Supabase's, but not one we know: never its English words.
  if (error?.name?.startsWith("Auth") || error?.code || error?.status)
    return "Não foi possível concluir agora. Tente de novo ou fale com o administrador.";
  // The app's own errors are already in Portuguese.
  return (
    message ||
    "Não foi possível concluir agora. Tente de novo ou fale com o administrador."
  );
}

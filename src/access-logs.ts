import { rpc } from "./api";

/** Logs de login e acesso de uma pessoa (member_access_logs). */
export type AccessKind = "login" | "logout" | "access";
export type AccessLog = {
  id: number;
  kind: AccessKind;
  /** Como entrou (auth.mfa_amr_claims): password, recovery, invite… */
  method: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  /** Na saída: quando a sessão encerrada começou. */
  session_started_at: string | null;
};
export type AccessSummary = {
  last_login: string | null;
  last_access: string | null;
  logins_30d: number;
  ips_30d: number;
  devices_30d: number;
};

export const ACCESS_PAGE = 50;
export const accessKinds: Record<AccessKind, string> = {
  login: "Login",
  access: "Acesso ao espaço",
  logout: "Saída",
};
const methods: Record<string, string> = {
  password: "Senha",
  recovery: "Link de recuperação",
  invite: "Convite",
  magiclink: "Link por e-mail",
  otp: "Código por e-mail",
  email_signup: "Confirmação de e-mail",
  email_change: "Troca de e-mail",
  oauth: "Conta externa",
  sso: "SSO",
  "sso/saml": "SSO",
  totp: "Autenticador (2FA)",
  anonymous: "Anônimo",
};
export const methodLabel = (m: string | null) => (m ? (methods[m] ?? m) : "");

export async function memberAccessLogs(
  company: string,
  user: string,
  filters: { kind?: AccessKind | ""; before?: number } = {},
): Promise<{ items: AccessLog[]; summary: AccessSummary | null }> {
  const r = await rpc("member_access_logs", {
    p_company: company,
    p_user: user,
    p_kind: filters.kind || null,
    p_before: filters.before ?? null,
    p_limit: ACCESS_PAGE,
  });
  return { items: r?.items ?? [], summary: r?.summary ?? null };
}

// No máximo uma chamada a cada 30 min por pessoa e espaço (o banco também
// limita).
const ACCESS_EVERY = 30 * 60 * 1000;
const lastLogged = new Map<string, number>();
/** Registra que a pessoa abriu o sistema neste espaço. Nunca falha. */
export function logAccess(user: string, company: string, now = Date.now()) {
  const key = `${user}:${company}`;
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < ACCESS_EVERY) return false;
  lastLogged.set(key, now);
  rpc("log_access", { p_company: company }).catch(() => {
    lastLogged.delete(key);
  });
  return true;
}

/** “Chrome no macOS”, “Safari no iPhone”… */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return "Dispositivo desconhecido";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "Chromebook"
            : /Mac OS X|Macintosh/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : /^node|undici|curl|python|Go-http|okhttp/i.test(ua)
                ? "Integração"
                : "";
  if (browser && os) return `${browser} no ${os}`;
  return browser || os || "Dispositivo desconhecido";
}

/** Duração legível de uma sessão: “45 min”, “3 h 12 min”, “2 dias”. */
export function sessionLength(from: string, to: string): string {
  const min = Math.max(
    0,
    Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000),
  );
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} dias`;
}

/** Dados ilustrativos da demonstração, que não registra acessos. */
export function demoAccessLogs(kind: AccessKind | "", now = Date.now()) {
  const at = (min: number) => new Date(now - min * 60000).toISOString();
  const mac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
  const row = (
    id: number,
    kind: AccessKind,
    min: number,
    ua: string,
    ip: string,
    extra: Partial<AccessLog> = {},
  ): AccessLog => ({
    id,
    kind,
    method: null,
    ip,
    user_agent: ua,
    created_at: at(min),
    session_started_at: null,
    ...extra,
  });
  const items = [
    row(5, "access", 12, mac, "203.0.113.24"),
    row(4, "login", 14, mac, "203.0.113.24", { method: "password" }),
    row(3, "logout", 600, iphone, "198.51.100.9", {
      session_started_at: at(792),
    }),
    row(2, "access", 780, iphone, "198.51.100.9"),
    row(1, "login", 792, iphone, "198.51.100.9", { method: "recovery" }),
  ].filter((e) => !kind || e.kind === kind);
  const summary: AccessSummary = {
    last_login: at(14),
    last_access: at(12),
    logins_30d: 2,
    ips_30d: 2,
    devices_30d: 2,
  };
  return { items, summary };
}

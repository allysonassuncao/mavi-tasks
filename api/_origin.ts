/**
 * The app's official address. The Supabase functions behind /api/invite-user
 * and /api/user-admin (api/edge-function.ts) check the request origin against their allowlist
 * (APP_ORIGIN / APP_ADDITIONAL_ORIGINS) and build the links they email from
 * it — invites land on /?setup=1, password resets on /?reset=1 — so it must
 * be a domain that serves the app. APP_ORIGIN on Vercel overrides it.
 */
export const DEFAULT_APP_ORIGIN = "https://workspace.maso.app.br";

export function appOrigin(
  env: Record<string, string | undefined> = process.env,
) {
  const value = env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  return value && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value)
    ? value
    : DEFAULT_APP_ORIGIN;
}

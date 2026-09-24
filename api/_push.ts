import crypto from "node:crypto";
import { callRpc, type DriveEnv } from "./_drive.js";

/**
 * Web Push sender. The database (migration web_push) hands each new
 * notification over — with the recipient's registered browsers — signed
 * with PUSH_SECRET; this signs the messages with the VAPID key, sends them,
 * and asks the database to forget browsers that no longer exist.
 */
export type PushEnv = Pick<DriveEnv, "supabaseUrl" | "supabaseKey"> & {
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
  secret?: string;
};
export type PushSubscriptionRow = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
type Message = { title: string; body: string; tag: string; url: string };
/** Sends one message; rejects with `statusCode` like web-push does. */
export type Sender = (
  subscription: PushSubscriptionRow,
  payload: string,
) => Promise<unknown>;

const MAX_SUBSCRIPTIONS = 50;

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handlePush(
  method: string | undefined,
  body: unknown,
  authorization: string | null,
  env: PushEnv,
  send: Sender,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  const configured =
    !!env.vapidPublicKey && !!env.vapidPrivateKey && !!env.secret;
  // The browser asks for the public key before subscribing.
  if (method === "GET")
    return configured
      ? { status: 200, body: { publicKey: env.vapidPublicKey } }
      : fail(503, "Notificações push ainda não configuradas no servidor.");
  if (method !== "POST") return fail(405, "Método não permitido");
  if (!configured)
    return fail(503, "Notificações push ainda não configuradas no servidor.");
  if (!authorization || !sameSecret(authorization, `Bearer ${env.secret}`))
    return fail(401, "Não autorizado.");

  const req = (body ?? {}) as {
    subscriptions?: PushSubscriptionRow[];
    message?: Partial<Message>;
  };
  const m = req.message;
  const subscriptions = Array.isArray(req.subscriptions)
    ? req.subscriptions
        .filter(
          (s) =>
            typeof s?.endpoint === "string" &&
            s.endpoint.startsWith("https://") &&
            typeof s.keys?.p256dh === "string" &&
            typeof s.keys?.auth === "string",
        )
        .slice(0, MAX_SUBSCRIPTIONS)
    : [];
  if (!m?.title || !subscriptions.length)
    return fail(400, "Notificação inválida.");
  const payload = JSON.stringify({
    title: String(m.title).slice(0, 120),
    body: String(m.body ?? "").slice(0, 300),
    tag: String(m.tag ?? ""),
    // Only paths inside the app open on click.
    url: typeof m.url === "string" && m.url.startsWith("/") ? m.url : "/",
  });

  const results = await Promise.allSettled(
    subscriptions.map((s) => send(s, payload)),
  );
  const gone = subscriptions
    .filter((_, i) => {
      const r = results[i];
      const code =
        r.status === "rejected"
          ? (r.reason as { statusCode?: number })?.statusCode
          : undefined;
      return code === 404 || code === 410;
    })
    .map((s) => s.endpoint);
  if (gone.length)
    await callRpc(env as DriveEnv, fetchImpl, null, "push_gone", {
      p_secret: env.secret,
      p_endpoints: gone,
    });
  return {
    status: 200,
    body: {
      sent: results.filter((r) => r.status === "fulfilled").length,
      gone: gone.length,
      failed:
        results.filter((r) => r.status === "rejected").length - gone.length,
    },
  };
}

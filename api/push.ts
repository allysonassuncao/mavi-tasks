import type { IncomingMessage, ServerResponse } from "node:http";
import webpush from "web-push";
import { driveEnv } from "./drive.js";
import { handlePush, type PushEnv } from "./_push.js";

function pushEnv(): PushEnv {
  const { supabaseUrl, supabaseKey } = driveEnv();
  return {
    supabaseUrl,
    supabaseKey,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT || "mailto:suporte@mavi.app.br",
    secret: process.env.PUSH_SECRET,
  };
}

/** GET: the VAPID public key. POST (from the database): send a notification. */
export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  let raw = "";
  if (req.method === "POST") {
    if (typeof req.body === "object" && req.body !== null)
      raw = JSON.stringify(req.body);
    else for await (const chunk of req) raw += chunk;
  }
  try {
    const env = pushEnv();
    const result = await handlePush(
      req.method,
      raw ? JSON.parse(raw) : {},
      (req.headers["authorization"] as string | undefined) ?? null,
      env,
      (subscription, payload) =>
        webpush.sendNotification(subscription, payload, {
          vapidDetails: {
            subject: env.vapidSubject!,
            publicKey: env.vapidPublicKey!,
            privateKey: env.vapidPrivateKey!,
          },
          // Worth delivering for a day; shown at once when possible.
          TTL: 24 * 60 * 60,
          urgency: "high",
        }),
    );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

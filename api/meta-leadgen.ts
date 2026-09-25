import type { IncomingMessage, ServerResponse } from "node:http";
import { adsEnv } from "./_ads.js";
import { handleLeadgen, leadgenEnv, verifySubscription } from "./_leadgen.js";

/**
 * Campanhas: the Meta app's "leadgen" webhook (api/_leadgen.ts). Set in the
 * Meta app → Webhooks → Page: callback <origin>/api/meta-leadgen and the
 * META_WEBHOOK_VERIFY_TOKEN as the verify token; subscribe "leadgen".
 */
export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  const env = leadgenEnv(process.env, adsEnv());
  if (req.method === "GET") {
    const query = new URL(req.url ?? "/", "https://x").searchParams;
    const result = verifySubscription(query, env);
    res.statusCode = result.status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(result.body);
    return;
  }
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Método não permitido" }));
    return;
  }
  // The exact bytes Meta signed: read the stream, never the parsed body.
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const result = await handleLeadgen(
      raw,
      req.headers["x-hub-signature-256"] as string | undefined,
      env,
    );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

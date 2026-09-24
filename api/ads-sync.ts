import type { IncomingMessage, ServerResponse } from "node:http";
import { adsEnv } from "./_ads.js";
import { handleAdsSync, syncEnv } from "./_ads-sync.js";

/** Campanhas: the daily sync of the cycles' numbers (api/_ads-sync.ts). */
export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Método não permitido" }));
    return;
  }
  let raw = "";
  if (typeof req.body === "object" && req.body !== null) {
    raw = JSON.stringify(req.body);
  } else {
    for await (const chunk of req) raw += chunk;
  }
  try {
    const result = await handleAdsSync(
      JSON.parse(raw || "{}"),
      (req.headers["authorization"] as string | undefined) ?? null,
      syncEnv(process.env, adsEnv()),
    );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

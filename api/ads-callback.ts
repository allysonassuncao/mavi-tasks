import type { IncomingMessage, ServerResponse } from "node:http";
import { adsEnv, handleAdsCallback } from "./_ads.js";

/** Facebook's or Google's redirect after an administrator connects them. */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  const query = new URL(req.url ?? "/", "https://callback.invalid")
    .searchParams;
  const env = adsEnv();
  try {
    const result = await handleAdsCallback(query, env);
    res.statusCode = result.status;
    res.setHeader("Location", result.location);
  } catch {
    res.statusCode = 302;
    res.setHeader(
      "Location",
      `${new URL(env.redirectUri).origin}/campanhas?conexao=erro`,
    );
  }
  res.end();
}

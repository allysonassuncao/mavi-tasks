import type { IncomingMessage, ServerResponse } from "node:http";
import { googleEnv, handleGoogleCallback } from "./_google.js";

/** Google's redirect after the person allows access to their calendar. */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  const query = new URL(req.url ?? "/", "https://callback.invalid")
    .searchParams;
  const env = googleEnv();
  try {
    const result = await handleGoogleCallback(query, env);
    res.statusCode = result.status;
    res.setHeader("Location", result.location);
  } catch {
    res.statusCode = 302;
    res.setHeader(
      "Location",
      `${new URL(env.redirectUri).origin}/agenda?google=erro`,
    );
  }
  res.end();
}

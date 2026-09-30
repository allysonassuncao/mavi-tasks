import type { IncomingMessage, ServerResponse } from "node:http";
import { googleEnv, handleGoogle, handleGoogleCallback } from "./_google.js";

/**
 * Agenda: the signed-in person's Google Calendar (api/_google.ts).
 *
 * GET is Google's redirect after the person allows access to their calendar
 * (/api/google-callback, rewritten here in vercel.json: the Hobby plan takes
 * at most 12 functions per deployment); POST is the calendar API.
 */
export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return callback(req, res);
  res.setHeader("Content-Type", "application/json");
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
    const result = await handleGoogle(
      JSON.parse(raw || "{}"),
      (req.headers["authorization"] as string | undefined) ?? null,
      googleEnv(),
    );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/** Google's redirect after the person allows access to their calendar. */
async function callback(req: IncomingMessage, res: ServerResponse) {
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

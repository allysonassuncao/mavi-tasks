import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import {
  claudeComplete,
  handleSocialLeads,
  socialLeadsEnv,
} from "./_social-leads.js";

/** Onboarding › Social Leads: plans written by Claude (api/_social-leads.ts). */
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
    const result = await handleSocialLeads(
      JSON.parse(raw || "{}"),
      (req.headers["authorization"] as string | undefined) ?? null,
      socialLeadsEnv(),
      {
        fetch,
        complete: claudeComplete,
        // On Vercel the function keeps running after the response until the
        // work ends (up to maxDuration); in the dev server the process simply
        // stays alive.
        background: (work) => waitUntil(work.catch(() => {})),
      },
    );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { signGcsUrl } from "./_drive.js";
import { driveEnv } from "./drive.js";
import {
  claudeComplete,
  handleSocialLeads,
  publicArt,
  socialLeadsEnv,
} from "./_social-leads.js";

/** Onboarding › Social Leads: plans written by Claude (api/_social-leads.ts). */
export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  // The arts of the client link (<img>/<video> sources): a redirect.
  if (req.method === "GET") {
    const drive = driveEnv();
    const result = await publicArt(
      new URL(req.url ?? "", "https://mavi.invalid").searchParams,
      socialLeadsEnv(),
      {
        fetch,
        sign: (file) =>
          drive.credentials
            ? signGcsUrl(drive.credentials, drive.bucket, file.path, "GET", {
                expiresInSeconds: 600,
                query: {
                  "response-content-disposition": `inline; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"`,
                },
              })
            : null,
      },
    ).catch(() => ({ status: 500, error: "Não foi possível abrir a arte." }));
    if (result.status === 302 && "location" in result && result.location) {
      res.statusCode = 302;
      res.setHeader("Location", result.location);
      // Under the signature's 10 minutes.
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end();
      return;
    }
    res.statusCode = result.status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "error" in result ? result.error : "" }));
    return;
  }
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

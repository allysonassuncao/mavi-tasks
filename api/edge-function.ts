import type { IncomingMessage, ServerResponse } from "node:http";
import { appOrigin } from "./_origin.js";

/**
 * /api/invite-user and /api/user-admin (vercel.json rewrites them here, with
 * ?fn=): forwards the request to that Supabase Edge Function with the
 * person's token and the official origin. One function for both keeps the
 * deployment within the Hobby plan's 12 functions.
 */
const FUNCTIONS = new Set(["invite-user", "user-admin"]);

export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json");
  const fn = new URL(req.url ?? "", "https://mavi.invalid").searchParams.get(
    "fn",
  );
  if (!fn || !FUNCTIONS.has(fn)) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Função desconhecida" }));
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Método não permitido" }));
    return;
  }

  let body = "";
  if (typeof req.body === "object" && req.body !== null) {
    body = JSON.stringify(req.body);
  } else {
    for await (const chunk of req) {
      body += chunk;
    }
  }

  try {
    const supabaseUrl =
      process.env.VITE_SUPABASE_URL ||
      "https://zajlipvbotjafkowohmn.supabase.co";
    const edgeRes = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: (req.headers["authorization"] as string) || "",
        // The official domain: email links are built from it.
        Origin: appOrigin(),
      },
      body,
    });
    res.statusCode = edgeRes.status;
    res.end(await edgeRes.text());
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

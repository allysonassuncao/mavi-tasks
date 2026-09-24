import type { IncomingMessage, ServerResponse } from "node:http";
import { appOrigin } from "./_origin.js";

export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
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
    const targetUrl = `${supabaseUrl}/functions/v1/invite-user`;
    const authHeader = req.headers["authorization"] || "";

    const edgeRes = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader as string,
        // The official domain: email links are built from it.
        Origin: appOrigin(),
      },
      body,
    });

    res.statusCode = edgeRes.status;
    res.setHeader("Content-Type", "application/json");
    const text = await edgeRes.text();
    res.end(text);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

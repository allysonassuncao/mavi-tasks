import type { IncomingMessage, ServerResponse } from "node:http";
import { crmEnv, handleCrm } from "./_crm.js";

/** Campanhas › Abrir no CRM: entra no MakeCRM do cliente (api/_crm.ts). */
export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
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
    const result = await handleCrm(
      JSON.parse(raw || "{}"),
      (req.headers["authorization"] as string | undefined) ?? null,
      crmEnv(),
    );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

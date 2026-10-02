import type { IncomingMessage, ServerResponse } from "node:http";
import { clientNotesEnv, handleClientNotes } from "./_client-notes.js";

/** Anotações do cliente: cifra e abre os trechos secretos (api/_client-notes.ts). */
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
    const result = await handleClientNotes(
      JSON.parse(raw || "{}"),
      (req.headers["authorization"] as string | undefined) ?? null,
      clientNotesEnv(),
    );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

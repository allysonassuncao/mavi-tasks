import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleDrive, type DriveEnv, type GcsCredentials } from "./_drive.js";
import {
  claudeAsk,
  handleMeetings,
  meetingsEnv,
  streamMeetingAsk,
} from "./_meetings.js";
import { aiDeps, aiEnv, handleAi, streamAi } from "./_ai.js";
import { handleMcp, protectedResource } from "./_mcp.js";
import { handleWhatsapp, whatsappEnv } from "./_whatsapp.js";
import { appOrigin } from "./_origin.js";

function credentials(): GcsCredentials | null {
  if (process.env.GCS_CREDENTIALS)
    return JSON.parse(process.env.GCS_CREDENTIALS);
  const localFile = path.resolve(process.cwd(), "gcs-credentials.json");
  return fs.existsSync(localFile)
    ? JSON.parse(fs.readFileSync(localFile, "utf8"))
    : null;
}

/** Environment for Drive requests; GCS_DRIVE_BUCKET lets Drive use its own (private) bucket. */
export function driveEnv(
  env: Record<string, string | undefined> = process.env,
): DriveEnv {
  return {
    supabaseUrl:
      env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co",
    supabaseKey:
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
    bucket: env.GCS_DRIVE_BUCKET || env.GCS_BUCKET || "maso_storage_main",
    credentials: credentials(),
  };
}

/** Browser IP and user agent, for the Drive audit trail (Vercel sets x-forwarded-for). */
export function requestOrigin(req: IncomingMessage) {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(",")[0]
    ?.trim();
  return {
    ip:
      first ||
      (req.headers["x-real-ip"] as string) ||
      req.socket?.remoteAddress,
    user_agent: req.headers["user-agent"],
  };
}

const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

async function readBody(req: IncomingMessage & { body?: any }) {
  if (typeof req.body === "object" && req.body !== null)
    return JSON.stringify(req.body);
  if (typeof req.body === "string") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/**
 * Servidor MCP (/api/mcp, reescrito para cá) e o documento de descoberta do
 * OAuth (/.well-known/oauth-protected-resource).
 */
async function mcpRoutes(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
  url: URL,
) {
  const env = { ...aiEnv(driveEnv()), appOrigin: appOrigin() };
  for (const [k, v] of Object.entries(MCP_CORS)) res.setHeader(k, v);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (
    url.pathname.startsWith("/.well-known/oauth-protected-resource") ||
    url.searchParams.get("wk") === "1"
  ) {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify(protectedResource(env)));
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.statusCode = 405;
    res.end();
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || "null");
  } catch {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "JSON inválido." },
      }),
    );
    return;
  }
  const result = await handleMcp(
    body,
    (req.headers["authorization"] as string | undefined) ?? null,
    env,
    aiDeps(env),
  );
  for (const [k, v] of Object.entries(result.headers ?? {}))
    res.setHeader(k, v);
  res.statusCode = result.status;
  if (result.body === null) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result.body));
}

export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  const url = new URL(req.url ?? "/", "https://mavi.invalid");
  if (
    url.pathname === "/api/mcp" ||
    url.pathname.startsWith("/.well-known/oauth-protected-resource") ||
    url.searchParams.get("mcp") === "1" ||
    url.searchParams.get("wk") === "1"
  ) {
    try {
      await mcpRoutes(req, res, url);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
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
    const body = JSON.parse(raw || "{}");
    const authorization =
      (req.headers["authorization"] as string | undefined) ?? null;
    const action = typeof body?.action === "string" ? body.action : "";
    // Perguntas à IA em tempo real: uma linha JSON por evento (passos,
    // raciocínio, texto) até "done" ou "error".
    if (body?.stream && (action === "ai-ask" || action === "meeting-ask")) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.statusCode = 200;
      const write = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);
      if (action === "ai-ask") {
        const env = aiEnv(driveEnv());
        await streamAi(body, authorization, env, aiDeps(env), write);
      } else
        await streamMeetingAsk(
          body,
          authorization,
          meetingsEnv(driveEnv()),
          { fetch, ask: claudeAsk },
          write,
        );
      res.end();
      return;
    }
    // Gravações da MAVI, a IA (/api/ai é reescrito para cá) e a coleta do
    // Whatsapp (/api/whatsapp) vivem na mesma função: o plano Hobby da Vercel
    // limita o número de funções.
    let result: { status: number; body: unknown };
    if (action.startsWith("whatsapp-"))
      result = await handleWhatsapp(
        body,
        authorization,
        whatsappEnv(driveEnv()),
        { fetch },
        requestOrigin(req),
      );
    else if (action.startsWith("meeting-"))
      result = await handleMeetings(
        body,
        authorization,
        meetingsEnv(driveEnv()),
        { fetch, ask: claudeAsk },
        requestOrigin(req),
      );
    else if (action.startsWith("ai-")) {
      const env = aiEnv(driveEnv());
      result = await handleAi(body, authorization, env, aiDeps(env));
    } else
      result = await handleDrive(
        body,
        authorization,
        driveEnv(),
        fetch,
        requestOrigin(req),
      );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

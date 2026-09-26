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
    // Gravações da MAVI e a IA (/api/ai é reescrito para cá) vivem na mesma
    // função: o plano Hobby da Vercel limita o número de funções.
    let result: { status: number; body: unknown };
    if (action.startsWith("meeting-"))
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

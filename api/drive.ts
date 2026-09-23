import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleDrive, type DriveEnv, type GcsCredentials } from "./_drive";

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
    const result = await handleDrive(
      JSON.parse(raw || "{}"),
      (req.headers["authorization"] as string | undefined) ?? null,
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

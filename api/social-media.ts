import type { IncomingMessage, ServerResponse } from "node:http";
import sharp from "sharp";
import { driveEnv } from "./drive.js";
import { handleSocialMedia, socialMediaEnv } from "./_social-media.js";

/**
 * Planejamento › Social Media › Agendamento: a conexão com o app do Meta do
 * Social Media e o worker que publica na hora marcada (api/_social-media.ts).
 */
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
  if (typeof req.body === "object" && req.body !== null)
    raw = JSON.stringify(req.body);
  else for await (const chunk of req) raw += chunk;
  const drive = driveEnv();
  try {
    const result = await handleSocialMedia(
      JSON.parse(raw || "{}"),
      (req.headers["authorization"] as string | undefined) ?? null,
      socialMediaEnv({ credentials: drive.credentials, bucket: drive.bucket }),
      {
        fetch,
        toJpeg: (input) =>
          sharp(input)
            .rotate()
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 92, mozjpeg: true })
            .toBuffer(),
      },
    );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

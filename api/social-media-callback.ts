import type { IncomingMessage, ServerResponse } from "node:http";
import { driveEnv } from "./drive.js";
import { handleSocialMediaCallback, socialMediaEnv } from "./_social-media.js";

/** O retorno do login do Facebook no app do Social Media. */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  const query = new URL(req.url ?? "/", "https://callback.invalid")
    .searchParams;
  const drive = driveEnv();
  const env = socialMediaEnv({
    credentials: drive.credentials,
    bucket: drive.bucket,
  });
  try {
    const result = await handleSocialMediaCallback(query, env);
    res.statusCode = result.status;
    res.setHeader("Location", result.location);
  } catch {
    res.statusCode = 302;
    res.setHeader(
      "Location",
      `${env.origin}/planejamento/social-media?secao=agendamento&sm_conexao=erro`,
    );
  }
  res.end();
}

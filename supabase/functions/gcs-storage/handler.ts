import crypto from "node:crypto";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";

export function signGcsPutUrl(
  creds: { client_email: string; private_key: string },
  bucket: string,
  objectPath: string,
  contentType: string,
  expiresInSeconds = 900,
) {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timestamp =
    dateStamp + "T" + now.toISOString().slice(11, 19).replace(/:/g, "") + "Z";
  const credentialScope = `${dateStamp}/auto/storage/goog4_request`;
  const credential = `${creds.client_email}/${credentialScope}`;

  const queryParams = new URLSearchParams({
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": credential,
    "X-Goog-Date": timestamp,
    "X-Goog-Expires": expiresInSeconds.toString(),
    "X-Goog-SignedHeaders": "content-type;host",
  });
  queryParams.sort();

  const cleanPath = objectPath.replace(/^\/+/, "");
  const canonicalUri =
    "/" +
    bucket +
    "/" +
    encodeURI(cleanPath).replace(/#/g, "%23").replace(/\?/g, "%3F");
  const canonicalHeaders = `content-type:${contentType.trim()}\nhost:storage.googleapis.com\n`;
  const signedHeaders = "content-type;host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    queryParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const canonicalRequestHash = crypto
    .createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");

  const stringToSign = [
    "GOOG4-RSA-SHA256",
    timestamp,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(stringToSign);
  const signature = signer.sign(creds.private_key, "hex");

  queryParams.set("X-Goog-Signature", signature);
  return `https://storage.googleapis.com${canonicalUri}?${queryParams.toString()}`;
}

export function createGcsStorageHandler(
  origin: string,
  createClient: () => SupabaseClient,
  getCredentials: () => { client_email: string; private_key: string } | null,
  getBucket: () => string = () => "maso_storage_main",
  additionalOrigins: string[] = [],
) {
  const allowedOrigins = new Set(
    [origin, ...additionalOrigins].filter(Boolean),
  );

  return async (req: Request) => {
    const requestOrigin = req.headers.get("origin");
    const authorizedOrigin =
      requestOrigin !== null &&
      (allowedOrigins.size === 0 || allowedOrigins.has(requestOrigin));

    const headers: Record<string, string> = {
      "Access-Control-Allow-Origin": requestOrigin || origin || "*",
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      Vary: "Origin",
    };

    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers });

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (req.method !== "POST") {
      return reply(405, { error: "Método não permitido." });
    }

    try {
      const token = req.headers
        .get("Authorization")
        ?.replace(/^Bearer\s+/i, "");
      if (!token) return reply(401, { error: "Autenticação necessária." });

      const client = createClient();
      const {
        data: { user },
        error: authError,
      } = await client.auth.getUser(token);
      if (authError || !user) return reply(401, { error: "Sessão inválida." });

      let body;
      try {
        body = await req.json();
      } catch {
        return reply(400, { error: "JSON inválido." });
      }

      const { path: objectPath, contentType } = body ?? {};
      if (
        typeof objectPath !== "string" ||
        objectPath.trim().length === 0 ||
        typeof contentType !== "string" ||
        contentType.trim().length === 0
      ) {
        return reply(400, {
          error: "Parâmetros 'path' e 'contentType' são obrigatórios.",
        });
      }

      const creds = getCredentials();
      if (!creds || !creds.client_email || !creds.private_key) {
        return reply(500, {
          error:
            "Credenciais do Google Cloud Storage não configuradas no servidor.",
        });
      }

      const bucket = getBucket();
      const url = signGcsPutUrl(creds, bucket, objectPath, contentType);

      return reply(200, { url });
    } catch (err) {
      return reply(500, {
        error: `Erro ao assinar URL: ${(err as Error).message || err}`,
      });
    }
  };
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

function signGcsPutUrl(
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
    const { path: objectPath, contentType } = JSON.parse(body || "{}");
    if (!objectPath || !contentType) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Parâmetros 'path' e 'contentType' são obrigatórios.",
        }),
      );
      return;
    }

    let creds = null;
    if (process.env.GCS_CREDENTIALS) {
      creds = JSON.parse(process.env.GCS_CREDENTIALS);
    } else {
      const localFile = path.resolve(process.cwd(), "gcs-credentials.json");
      if (fs.existsSync(localFile)) {
        creds = JSON.parse(fs.readFileSync(localFile, "utf8"));
      }
    }

    if (!creds || !creds.client_email || !creds.private_key) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Credenciais do Google Cloud Storage não configuradas.",
        }),
      );
      return;
    }

    const bucket = process.env.GCS_BUCKET || "maso_storage_main";
    const url = signGcsPutUrl(creds, bucket, objectPath, contentType);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ url }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

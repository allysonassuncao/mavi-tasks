import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

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

function gcsDevPlugin() {
  return {
    name: "gcs-dev-server",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (
          req.url?.startsWith("/api/gcs/sign-upload") &&
          req.method === "POST"
        ) {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk;
          });
          req.on("end", () => {
            try {
              const { path: objectPath, contentType } = JSON.parse(
                body || "{}",
              );
              if (!objectPath || !contentType) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error:
                      "Parâmetros 'path' e 'contentType' são obrigatórios.",
                  }),
                );
                return;
              }

              let creds = null;
              const credsPath = path.resolve(
                process.cwd(),
                "gcs-credentials.json",
              );
              if (fs.existsSync(credsPath)) {
                creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
              } else if (process.env.GCS_CREDENTIALS) {
                creds = JSON.parse(process.env.GCS_CREDENTIALS);
              }

              if (!creds || !creds.client_email || !creds.private_key) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error:
                      "Credenciais do Google Cloud Storage não encontradas.",
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
          });
          return;
        }

        if (req.url?.startsWith("/api/invite-user") && req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk;
          });
          req.on("end", async () => {
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
                  Origin: "https://mavi.maso.app.br",
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
          });
          return;
        }

        if (req.url?.startsWith("/api/user-admin") && req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk;
          });
          req.on("end", async () => {
            try {
              const supabaseUrl =
                process.env.VITE_SUPABASE_URL ||
                "https://zajlipvbotjafkowohmn.supabase.co";
              const targetUrl = `${supabaseUrl}/functions/v1/user-admin`;
              const authHeader = req.headers["authorization"] || "";

              const edgeRes = await fetch(targetUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: authHeader as string,
                  Origin: "https://mavi.maso.app.br",
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
          });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const { VITE_SUPABASE_URL } = loadEnv(mode, process.cwd(), "VITE_");
  const origin = VITE_SUPABASE_URL ? new URL(VITE_SUPABASE_URL).origin : null;
  return {
    plugins: [
      react(),
      gcsDevPlugin(),
      {
        name: "supabase-preconnect",
        transformIndexHtml() {
          // Also works with custom domains; demo builds emit no empty URL.
          return origin
            ? [
                {
                  tag: "link",
                  attrs: {
                    rel: "preconnect",
                    href: origin,
                    crossorigin: "anonymous",
                  },
                  injectTo: "head-prepend" as const,
                },
              ]
            : [];
        },
      },
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("/node_modules/")) return;
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id))
              return "vendor-react";
            if (id.includes("/node_modules/@supabase/"))
              return "vendor-supabase";
            if (/\/node_modules\/(@tiptap\/|prosemirror-)/.test(id))
              return "vendor-editor";
            if (/\/node_modules\/(@radix-ui\/|@floating-ui\/)/.test(id))
              return "vendor-radix";
            if (
              /\/node_modules\/(react-day-picker|@daypicker\/|date-fns)/.test(
                id,
              )
            )
              return "vendor-calendar";
          },
        },
      },
    },
  };
});

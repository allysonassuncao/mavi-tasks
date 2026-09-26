import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { appOrigin } from "./api/_origin";

function gcsDevPlugin() {
  return {
    name: "gcs-dev-server",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith("/api/gcs/sign-upload")) {
          // Same handler as the Vercel function: signs only records the
          // signed-in user just prepared (api/_uploads.ts).
          const { default: signUpload } = await server.ssrLoadModule(
            "/api/gcs/sign-upload.ts",
          );
          await signUpload(req, res);
          return;
        }

        if (req.url?.startsWith("/api/profile")) {
          const { default: profile } =
            await server.ssrLoadModule("/api/profile.ts");
          await profile(req, res);
          return;
        }
        if (req.url?.startsWith("/api/google-callback")) {
          const { default: callback } = await server.ssrLoadModule(
            "/api/google-callback.ts",
          );
          await callback(req, res);
          return;
        }
        if (req.url?.startsWith("/api/google")) {
          // Same handler as the Vercel function (api/google.ts).
          const { default: google } =
            await server.ssrLoadModule("/api/google.ts");
          await google(req, res);
          return;
        }
        if (req.url?.startsWith("/api/social-leads")) {
          // Same handler as the Vercel function (api/social-leads.ts).
          const { default: socialLeads } = await server.ssrLoadModule(
            "/api/social-leads.ts",
          );
          await socialLeads(req, res);
          return;
        }
        if (
          req.url?.startsWith("/api/drive") ||
          req.url?.startsWith("/api/ai")
        ) {
          // Same handler as the Vercel function (api/drive.ts); /api/ai is
          // rewritten to it on Vercel too.
          const { default: drive } =
            await server.ssrLoadModule("/api/drive.ts");
          await drive(req, res);
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
                  Origin: appOrigin(),
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
                  Origin: appOrigin(),
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
  // Server-side dev handlers (api/drive.ts) read their config from process.env,
  // as they do on Vercel; real environment variables take precedence.
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "")))
    process.env[key] ??= value;
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

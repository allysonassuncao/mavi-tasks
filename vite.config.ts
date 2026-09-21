import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const { VITE_SUPABASE_URL } = loadEnv(mode, process.cwd(), "VITE_");
  const origin = VITE_SUPABASE_URL ? new URL(VITE_SUPABASE_URL).origin : null;
  return {
    plugins: [
      react(),
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

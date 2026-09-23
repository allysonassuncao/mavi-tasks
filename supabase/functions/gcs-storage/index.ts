import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { createGcsStorageHandler } from "./handler.ts";

function loadCredentials() {
  const json = Deno.env.get("GCS_CREDENTIALS");
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

Deno.serve(
  createGcsStorageHandler(
    Deno.env.get("APP_ORIGIN") ?? "",
    () =>
      createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY") ||
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        {
          auth: { persistSession: false, autoRefreshToken: false },
        },
      ),
    loadCredentials,
    () => Deno.env.get("GCS_BUCKET") || "maso_storage_main",
    (Deno.env.get("APP_ADDITIONAL_ORIGINS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
);

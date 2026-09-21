import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { createInviteHandler } from "./handler.ts";

Deno.serve(
  createInviteHandler(
    Deno.env.get("APP_ORIGIN") ?? "",
    () =>
      createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        {
          auth: { persistSession: false, autoRefreshToken: false },
        },
      ),
    (Deno.env.get("APP_ADDITIONAL_ORIGINS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
);

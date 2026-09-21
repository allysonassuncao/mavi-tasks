import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { createReconcileHandler } from "./handler.ts";

Deno.serve(
  createReconcileHandler(Deno.env.get("MAINTENANCE_SECRET") ?? "", () =>
    createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    ),
  ),
);

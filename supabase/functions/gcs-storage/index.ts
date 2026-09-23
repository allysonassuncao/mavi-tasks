import { createGcsStorageHandler } from "./handler.ts";

Deno.serve(createGcsStorageHandler(Deno.env.get("APP_ORIGIN") ?? ""));

// Read-only smoke check using the same public credentials as the frontend.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return [
        line.slice(0, separator),
        line.slice(separator + 1).replace(/^['"]|['"]$/g, ""),
      ];
    }),
);
const base = env.VITE_SUPABASE_URL;
const headers = { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY };
assert(base && headers.apikey, "Configure .env.local first");
const settings = await fetch(`${base}/auth/v1/settings`, { headers });
assert.equal(settings.status, 200, "Auth reachable with the publishable key");
const config = await settings.json();
console.log("PASS: Supabase Auth reachable");
console.log(`Public signup disabled: ${config.disable_signup === true}`);
console.log(
  `Anonymous sign-ins enabled: ${config.external?.anonymous_users === true}`,
);
for (const table of ["companies", "memberships", "tasks", "attachments"]) {
  const response = await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, {
    headers,
  });
  assert(
    [401, 403].includes(response.status),
    `Anonymous access must be denied: ${table} (${response.status})`,
  );
  console.log(`PASS: anonymous access denied to ${table}`);
}

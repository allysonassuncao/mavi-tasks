import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Vercel runs these functions as plain Node ESM ("type": "module"), where a
 * relative import without its extension fails when the module loads — the
 * function then answers FUNCTION_INVOCATION_FAILED to every request. Vite
 * resolves extensionless imports in development, so only this check catches
 * it before deploying.
 */
function functionSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return functionSources(file);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [file]
      : [];
  });
}

describe("imports das funções da Vercel", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const file of functionSources(dir)) {
    it(`${path.relative(dir, file)} usa extensão .js nos imports relativos`, () => {
      const source = fs.readFileSync(file, "utf8");
      const relative = [
        ...source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g),
      ].map((m) => m[1]);
      expect(relative.filter((spec) => !spec.endsWith(".js"))).toEqual([]);
    });
  }
});

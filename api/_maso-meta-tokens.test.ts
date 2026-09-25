import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { unseal } from "./_google.js";
// The MASO import seals the tokens outside the server; the server must open them.
import { seal } from "../scripts/import-maso-meta-tokens.mjs";

describe("tokens do Meta importados do MASO", () => {
  it("o servidor abre o token cifrado pelo script de importação", () => {
    const key = crypto.randomBytes(32);
    const token = `EAA${"x".repeat(180)}`;
    const sealed = seal(key, token);
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain(token);
    expect(unseal(key, sealed)).toBe(token);
    expect(() => unseal(crypto.randomBytes(32), sealed)).toThrow();
  });
});

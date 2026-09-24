import { describe, expect, it } from "vitest";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./_origin";

describe("appOrigin", () => {
  it("usa o domínio oficial por padrão", () => {
    expect(appOrigin({})).toBe("https://workspace.maso.app.br");
    expect(DEFAULT_APP_ORIGIN).toBe("https://workspace.maso.app.br");
  });
  it("aceita outro domínio pela variável APP_ORIGIN", () => {
    expect(appOrigin({ APP_ORIGIN: "https://app.exemplo.com.br/" })).toBe(
      "https://app.exemplo.com.br",
    );
  });
  it("ignora valores que não são uma origem https", () => {
    for (const bad of [
      "http://inseguro.com",
      "workspace.maso.app.br",
      "https://a.com/caminho",
      " ",
    ])
      expect(appOrigin({ APP_ORIGIN: bad })).toBe(DEFAULT_APP_ORIGIN);
  });
});

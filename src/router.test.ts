import { describe, expect, it } from "vitest";
import { pagePaths, pageUrl, readParam, resolvePage } from "./router";

describe("shareable routes", () => {
  it("resolves every page, home alias and trailing slashes", () => {
    for (const [page, path] of Object.entries(pagePaths)) {
      expect(resolvePage(path)).toBe(page);
      expect(resolvePage(path + "/")).toBe(page);
    }
    expect(resolvePage("/")).toBe("overview");
    expect(resolvePage("/pagina-inexistente")).toBeNull();
  });
  it("preserves the tenant and encodes query values", () => {
    expect(pageUrl("projects", "empresa & outra")).toBe(
      "/projetos?empresa=empresa%20%26%20outra",
    );
  });
  it("restores filters without accepting invalid pagination", () => {
    const params = new URLSearchParams("busca=ação&minhas=1&pagina=2");
    expect(readParam<string>(params, "busca", "")).toBe("ação");
    expect(readParam<boolean>(params, "minhas", false)).toBe(true);
    expect(readParam<number>(params, "pagina", 0)).toBe(2);
    for (const invalid of ["-1", "NaN", "1.2", "Infinity"]) {
      expect(
        readParam<number>(
          new URLSearchParams({ pagina: invalid }),
          "pagina",
          0,
        ),
      ).toBe(0);
    }
  });
});

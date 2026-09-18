import { describe, expect, it } from "vitest";
import {
  pagePaths,
  pageUrl,
  readParam,
  resolvePage,
  companySlug,
  safeReturnPath,
  loginDestination,
  routeParts,
} from "./router";

describe("shareable routes", () => {
  it("resolves every page, home alias and trailing slashes", () => {
    for (const [page, path] of Object.entries(pagePaths)) {
      expect(resolvePage(path)).toBe(page);
      expect(resolvePage(path + "/")).toBe(page);
    }
    expect(resolvePage("/")).toBe("overview");
    expect(resolvePage("/pagina-inexistente")).toBeNull();
  });
  it("uses a readable company path and resolves scoped pages", () => {
    const company = { id: "tenant-1", name: "Make Acelerador de Vendas" };
    expect(companySlug(company, [company])).toBe("make-acelerador-de-vendas");
    expect(pageUrl("projects", companySlug(company, [company]))).toBe(
      "/agencias/make-acelerador-de-vendas/projetos",
    );
    expect(resolvePage("/agencias/make-acelerador-de-vendas/projetos")).toBe(
      "projects",
    );
    expect(
      routeParts("/agencias/make-acelerador-de-vendas/clientes").company,
    ).toBe("make-acelerador-de-vendas");
    expect(resolvePage("/login")).toBeNull();
  });
  it("distinguishes companies with equivalent names", () => {
    const companies = [
      { id: "a", name: "Agência São Paulo" },
      { id: "b", name: "Agencia Sao Paulo" },
    ];
    expect(companySlug(companies[0], companies)).toBe("agencia-sao-paulo-a");
    expect(companySlug(companies[1], companies)).toBe("agencia-sao-paulo-b");
  });
  it("sends the initial page to login and retains protected destinations", () => {
    expect(loginDestination("/")).toBe("/login");
    const requested = "/agencias/make/clientes?busca=Ana";
    const url = new URL(loginDestination(requested), "https://mavi.invalid");
    expect(url.pathname).toBe("/login");
    expect(safeReturnPath(url.searchParams.get("retorno"))).toBe(requested);
  });
  it("rejects external redirects and drops auth tokens from return URLs", () => {
    for (const bad of [
      null,
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/login",
      "/unknown",
    ]) {
      expect(safeReturnPath(bad)).toBe("/visao-geral");
    }
    expect(
      safeReturnPath(
        "/clientes?access_token=secret&busca=Ana#refresh_token=secret",
      ),
    ).toBe("/clientes?busca=Ana");
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

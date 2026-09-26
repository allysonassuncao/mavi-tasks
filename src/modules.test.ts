import { describe, expect, it } from "vitest";
import { canOpenPage, firstPage, moduleOf, roleAllows } from "./modules";

describe("módulos visíveis por pessoa", () => {
  it("as regras do perfil continuam valendo", () => {
    // Campanhas: administrators and managers, not collaborators.
    expect(roleAllows("campaigns", "manager")).toBe(true);
    expect(roleAllows("campaigns", "admin")).toBe(true);
    expect(roleAllows("campaigns", "member")).toBe(false);
    expect(roleAllows("products", "member")).toBe(false);
    expect(roleAllows("tasks", "member")).toBe(true);
    // Onboarding › Social Leads: collaborators see the clients they serve.
    expect(roleAllows("onboarding", "member")).toBe(true);
    // Hiding never grants: a collaborator still doesn't see Produtos.
    expect(canOpenPage("products", "member", [])).toBe(false);
  });
  it("esconder tira o módulo e as páginas dele", () => {
    const hidden = ["tasks", "products", "reports"];
    expect(canOpenPage("tasks", "admin", hidden)).toBe(false);
    expect(canOpenPage("search", "admin", hidden)).toBe(false);
    expect(canOpenPage("contracts", "admin", hidden)).toBe(false);
    expect(canOpenPage("reports", "member", hidden)).toBe(false);
    expect(canOpenPage("agenda", "member", hidden)).toBe(true);
    expect(moduleOf("search")).toBe("tasks");
    expect(moduleOf("settings")).toBeNull();
  });
  it("Meu perfil e configurações nunca se escondem", () => {
    const all = [
      "overview",
      "tasks",
      "agenda",
      "clients",
      "products",
      "projects",
      "campaigns",
      "onboarding",
      "hours",
      "reports",
      "drive",
      "storage",
      "dashboards",
    ];
    expect(canOpenPage("profile", "member", all)).toBe(true);
    expect(canOpenPage("settings", "admin", all)).toBe(true);
    expect(firstPage("admin", all)).toBe("profile");
  });
  it("cai na primeira página que a pessoa pode abrir", () => {
    expect(firstPage("admin", [])).toBe("overview");
    expect(firstPage("member", [])).toBe("tasks");
    expect(firstPage("manager", ["overview", "tasks"])).toBe("agenda");
    expect(firstPage("member", ["tasks", "agenda"])).toBe("onboarding");
    expect(firstPage("member", ["tasks", "agenda", "onboarding"])).toBe(
      "drive",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  canOpenPage,
  firstPage,
  hiddenModules,
  moduleOf,
  moduleOn,
  roleAllows,
} from "./modules";

// A collaborator's modules off: what an administrator hid plus the opt-in
// ones not turned on (what App passes around).
const off = (hidden: string[] = [], shown: string[] = []) =>
  hiddenModules({ role: "member", hidden_pages: hidden, shown_pages: shown });

describe("módulos visíveis por pessoa", () => {
  it("as regras do perfil continuam valendo", () => {
    // Campanhas: administrators and managers; a collaborator only when an
    // administrator turns it on.
    expect(roleAllows("campaigns", "manager")).toBe(true);
    expect(roleAllows("campaigns", "admin")).toBe(true);
    expect(canOpenPage("campaigns", "member", off())).toBe(false);
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
      "socialMedia",
      "cases",
      "temperature",
      "radar",
      "hours",
      "reports",
      "drive",
      "storage",
      "aiUsage",
      "dashboards",
      "notices",
    ];
    expect(canOpenPage("profile", "member", all)).toBe(true);
    expect(canOpenPage("settings", "admin", all)).toBe(true);
    expect(firstPage("admin", all)).toBe("profile");
  });
  it("cai na primeira página que a pessoa pode abrir", () => {
    expect(firstPage("admin", [])).toBe("overview");
    expect(firstPage("member", off())).toBe("tasks");
    expect(firstPage("manager", ["overview", "tasks"])).toBe("agenda");
    expect(firstPage("member", off(["tasks", "agenda"]))).toBe("onboarding");
    // Planejamento › Social Media comes right after Social Leads.
    expect(firstPage("member", off(["tasks", "agenda", "onboarding"]))).toBe(
      "socialMedia",
    );
    expect(
      firstPage("member", off(["tasks", "agenda", "onboarding", "socialMedia"])),
    ).toBe("cases");
    expect(
      firstPage(
        "member",
        off(["tasks", "agenda", "onboarding", "socialMedia", "cases"]),
      ),
    ).toBe("temperature");
    expect(
      firstPage(
        "member",
        off(["tasks", "agenda", "onboarding", "socialMedia", "cases", "temperature"]),
      ),
    ).toBe("drive");
  });
  it("Radar do cliente: administradores e gestores, e o administrador pode esconder", () => {
    expect(roleAllows("radar", "admin")).toBe(true);
    expect(roleAllows("radar", "manager")).toBe(true);
    expect(canOpenPage("radar", "member", off())).toBe(false);
    expect(canOpenPage("radar", "manager", ["radar"])).toBe(false);
    expect(moduleOf("radar")).toBe("radar");
  });
  it("Termômetro dos clientes: de todos os perfis, e o administrador pode esconder", () => {
    expect(roleAllows("temperature", "member")).toBe(true);
    expect(canOpenPage("temperature", "member", ["temperature"])).toBe(false);
    expect(moduleOf("temperature")).toBe("temperature");
  });
  it("o assistente de IA é um módulo de todos, que o administrador desliga", () => {
    expect(moduleOn("assistant", "member")).toBe(true);
    expect(moduleOn("assistant", "admin", ["tasks"])).toBe(true);
    expect(moduleOn("assistant", "manager", ["assistant"])).toBe(false);
    expect(moduleOn("assistant", undefined)).toBe(false);
    // Não é página: nunca vira o destino depois do login.
    expect(firstPage("admin", ["overview", "tasks"])).toBe("agenda");
    const all = [
      "overview",
      "tasks",
      "agenda",
      "clients",
      "products",
      "projects",
      "campaigns",
      "onboarding",
      "socialMedia",
      "cases",
      "temperature",
      "radar",
      "hours",
      "reports",
      "drive",
      "storage",
      "aiUsage",
      "dashboards",
      "assistant",
      "notices",
    ];
    expect(firstPage("admin", all)).toBe("profile");
  });
  it("Cases de Sucesso: de todos os perfis, e o administrador pode esconder", () => {
    expect(roleAllows("cases", "member")).toBe(true);
    expect(roleAllows("cases", "manager")).toBe(true);
    expect(canOpenPage("cases", "member", ["cases"])).toBe(false);
    expect(moduleOf("cases")).toBe("cases");
  });
  it("Mural de avisos: de todos os perfis, e o administrador pode esconder", () => {
    expect(roleAllows("notices", "member")).toBe(true);
    expect(canOpenPage("notices", "member", ["notices"])).toBe(false);
    expect(moduleOn("notices", "member", ["notices"])).toBe(false);
    expect(moduleOf("notices")).toBe("notices");
    // Só vira destino quando nada mais abre.
    expect(firstPage("manager", ["overview", "tasks"])).toBe("agenda");
  });
  it("Visão geral, Campanhas, Radar e Dashboards: desligados para colaboradores até o administrador ligar", () => {
    for (const page of ["overview", "campaigns", "radar", "dashboards"] as const) {
      expect(canOpenPage(page, "member", off())).toBe(false);
      expect(canOpenPage(page, "member", off([], [page]))).toBe(true);
      // Hiding wins over turning on.
      expect(canOpenPage(page, "member", off([page], [page]))).toBe(false);
      // Leaders have them by profile; shown_pages doesn't count for them.
      expect(
        canOpenPage(page, "manager", hiddenModules({ role: "manager" })),
      ).toBe(true);
    }
    // Only the four: Produtos stays out, Tarefas stays in.
    expect(off()).toEqual(["overview", "campaigns", "radar", "dashboards"]);
    expect(canOpenPage("products", "member", off([], ["overview"]))).toBe(false);
    // Landing after login: Tarefas first for a collaborator even with Visão
    // geral on.
    expect(firstPage("member", off([], ["overview"]))).toBe("tasks");
  });
  it("Inteligência artificial: líderes, não colaboradores", () => {
    expect(canOpenPage("aiUsage", "manager")).toBe(true);
    expect(canOpenPage("aiUsage", "member")).toBe(false);
    expect(canOpenPage("aiUsage", "admin", ["aiUsage"])).toBe(false);
  });
});

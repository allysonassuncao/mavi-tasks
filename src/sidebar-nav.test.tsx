import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarNav } from "./SidebarNav";
import type { Page } from "./router";

const MEMBER: Page[] = [
  "tasks",
  "search",
  "clients",
  "projects",
  "hours",
  "reports",
  "drive",
  "profile",
];
const render = (isLeader: boolean, page: Page = "tasks", query = "") =>
  renderToStaticMarkup(
    <SidebarNav
      page={page}
      params={new URLSearchParams(query)}
      isLeader={isLeader}
      allowed={(p) => isLeader || MEMBER.includes(p)}
      taskCount={5}
      products={[{ id: "p1", name: "Make Ads", color: "#000" }]}
      href={(to) =>
        `/${to.page}${to.query ? "?" + new URLSearchParams(to.query) : ""}`
      }
      onNavigate={() => {}}
    />,
  );

describe("SidebarNav", () => {
  it("agrupa o menu e abre o submenu da página atual", () => {
    const html = render(true);
    for (const label of ["TRABALHO", "ARQUIVOS E ANÁLISES", "ADMINISTRAÇÃO"])
      expect(html).toContain(label);
    expect(html).not.toContain("CARTEIRA");
    // Leaders manage clients, products, projects and hours in Administração.
    const admin = html.slice(html.indexOf("ADMINISTRAÇÃO"));
    for (const item of [
      "Clientes",
      "Produtos",
      "Projetos",
      "Controle de horas",
    ])
      expect(admin).toContain(`>${item}<`);
    expect(html).toContain("Para você");
    expect(html).toContain(
      "POR PRODUTO".toLowerCase() === "" ? "" : "Por produto",
    );
  });
  it("marca a visão atual da lista de tarefas", () => {
    const html = render(true, "tasks", "escopo=mine");
    expect(html).toMatch(
      /class="active" aria-current="page"[^>]*>(<span[^>]*><\/span>)?<span>Para você/,
    );
  });
  it("colaboradores não veem produtos nem administração", () => {
    const html = render(false, "overview");
    expect(html).not.toContain("ADMINISTRAÇÃO");
    expect(html).not.toContain(">Produtos<");
    expect(html).toContain("Clientes");
    expect(html).toContain("Controle de horas");
  });
  it("atalhos da configuração abrem na página de configurações", () => {
    const html = render(true, "settings");
    expect(html).toContain("Templates de tarefa");
  });
  it("submenus ficam fechados fora da sua página", () => {
    const html = render(true, "overview");
    expect(html).not.toContain("Para você");
    expect(html).toContain('aria-expanded="false"');
  });
});

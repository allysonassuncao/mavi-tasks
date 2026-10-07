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
const render = (
  isLeader: boolean,
  page: Page = "tasks",
  query = "",
  allowed = (p: Page) => isLeader || MEMBER.includes(p),
) =>
  renderToStaticMarkup(
    <SidebarNav
      page={page}
      params={new URLSearchParams(query)}
      isLeader={isLeader}
      allowed={allowed}
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
  it("configurações é um link só (as seções ficam no menu da página)", () => {
    const html = render(true, "settings");
    expect(html).toMatch(/href="\/settings" class="active"/);
    expect(html).not.toContain("Templates de tarefa");
  });
  it("submenus ficam fechados fora da sua página", () => {
    const html = render(true, "overview");
    expect(html).not.toContain("Para você");
    expect(html).toContain('aria-expanded="false"');
  });
  it("Planejamento reúne Social Leads e Social Media", () => {
    const html = render(true, "socialMedia");
    expect(html).not.toContain(">Onboarding<");
    expect(html).toContain(">Planejamento<");
    expect(html).toContain('href="/onboarding"');
    // Social Media's page opens the submenu, with it marked.
    expect(html).toMatch(
      /href="\/socialMedia" class="active" aria-current="page"[^>]*><span>Social Media/,
    );
    expect(html).toContain(">Social Leads<");
    // Without Social Leads, Planejamento opens Social Media.
    const only = render(true, "overview", "", (p) => p !== "onboarding");
    expect(only).toContain('href="/socialMedia"');
    expect(only).not.toContain('href="/onboarding"');
  });
});

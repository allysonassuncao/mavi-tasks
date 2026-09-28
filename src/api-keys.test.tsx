import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.stubGlobal("window", { location: { origin: "https://mavi.test" } });
const { ApiKeysPanel } = await import("./ApiKeys");

const render = (props: { isAdmin: boolean; demo: boolean }) =>
  renderToStaticMarkup(
    createElement(ApiKeysPanel, { company: "c1", notify: () => {}, ...props }),
  );

describe("Chaves de API", () => {
  it("administrador vê o endereço da API, o formulário e a lista", () => {
    const html = render({ isAdmin: true, demo: false });
    expect(html).toContain("Chaves de API");
    expect(html).toContain("https://mavi.test/api/v1");
    expect(html).toContain("Criar chave");
    expect(html).toContain("Carregando…");
  });
  it("gestor não cria nem vê chaves", () => {
    const html = render({ isAdmin: false, demo: false });
    expect(html).toContain("Exclusivo de administradores");
    expect(html).not.toContain("Criar chave");
  });
  it("a demonstração não se conecta à API", () => {
    expect(render({ isAdmin: true, demo: true })).toContain(
      "A demonstração não se conecta à API pública.",
    );
  });
});

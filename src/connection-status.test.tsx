import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionToast } from "./ConnectionStatus";

describe("Aviso de conexão", () => {
  it("avisa quando a internet cai", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionToast, { notice: "offline" }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Sem conexão com a internet.");
  });
  it("confirma quando a conexão volta", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionToast, { notice: "back" }),
    );
    expect(html).toContain("Conexão restabelecida");
  });
  it("não mostra nada com a conexão normal", () => {
    expect(
      renderToStaticMarkup(createElement(ConnectionToast, { notice: null })),
    ).toBe("");
  });
});

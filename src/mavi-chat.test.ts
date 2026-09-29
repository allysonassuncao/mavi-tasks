import { describe, expect, it } from "vitest";
import { groupByDate, plainAnswer, titleFrom } from "./MaviChatPage";
import { maviChatIdFromPath, pageUrl, resolvePage } from "./router";
import { canOpenPage, moduleOf } from "./modules";

const ID = "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d";

describe("módulo MAVI", () => {
  it("cada conversa tem o seu endereço, dentro da agência", () => {
    expect(pageUrl("mavi")).toBe("/mavi/conversas");
    expect(resolvePage("/mavi/conversas")).toBe("mavi");
    expect(resolvePage(`/agencias/make/mavi/conversas/${ID}`)).toBe("mavi");
    expect(maviChatIdFromPath(`/agencias/make/mavi/conversas/${ID}`)).toBe(ID);
    expect(maviChatIdFromPath("/mavi/conversas/nao-e-id")).toBeNull();
    // O Painel da MAVI continua no mesmo endereço.
    expect(resolvePage("/mavi")).toBe("aiUsage");
  });
  it("é o mesmo módulo da bolinha: de todos, e o administrador desliga os dois", () => {
    expect(moduleOf("mavi")).toBe("assistant");
    expect(canOpenPage("mavi", "member")).toBe(true);
    expect(canOpenPage("mavi", "manager")).toBe(true);
    expect(canOpenPage("mavi", "member", ["assistant"])).toBe(false);
  });
  it("agrupa as conversas por data, como no ChatGPT", () => {
    const now = new Date(2026, 8, 29, 15, 0);
    const at = (d: number, h = 10) => new Date(2026, 8, d, h).toISOString();
    const groups = groupByDate(
      [
        { id: "a", updated_at: at(29, 9) },
        { id: "b", updated_at: at(28, 23) },
        { id: "c", updated_at: at(24) },
        { id: "d", updated_at: at(5) },
        { id: "e", updated_at: new Date(2026, 6, 3).toISOString() },
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Hoje", ["a"]],
      ["Ontem", ["b"]],
      ["Últimos 7 dias", ["c"]],
      ["Últimos 30 dias", ["d"]],
      ["Julho de 2026", ["e"]],
    ]);
  });
  it("dá à conversa nova o título do servidor e copia a resposta limpa", () => {
    expect(titleFrom("  O que  está\natrasado? ")).toBe("O que está atrasado?");
    expect(titleFrom("x".repeat(120))).toHaveLength(80);
    expect(plainAnswer("A reunião foi **ontem** [S1] e ficou combinado [S12].")).toBe(
      "A reunião foi ontem e ficou combinado.",
    );
  });
});

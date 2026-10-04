import { describe, expect, it } from "vitest";
import { diffLines, diffStats, diffWords } from "./text-diff";

describe("diferença entre versões", () => {
  it("textos iguais não têm diferença", () => {
    const lines = diffLines("a\nb", "a\nb");
    expect(lines.every((l) => l.kind === "same")).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it("linhas que entram e saem", () => {
    const lines = diffLines("Olá\nRegra 1\nRegra 2\nTchau", "Olá\nRegra 2\nRegra 3\nTchau");
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "same:Olá",
      "del:Regra 1",
      "same:Regra 2",
      "add:Regra 3",
      "same:Tchau",
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it("linha trocada mostra as palavras que mudaram", () => {
    const [, del, add] = diffLines(
      "Horário:\nAtendemos de segunda a sexta.\nFim",
      "Horário:\nAtendemos de segunda a sábado.\nFim",
    );
    expect(del.kind).toBe("del");
    expect(add.kind).toBe("add");
    expect(add.words).toEqual([
      { kind: "same", text: "Atendemos de segunda a " },
      { kind: "del", text: "sexta." },
      { kind: "add", text: "sábado." },
    ]);
  });

  it("palavras: junta os pedaços do mesmo tipo", () => {
    expect(diffWords("a b c", "a x c")).toEqual([
      { kind: "same", text: "a " },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: " c" },
    ]);
  });

  it("texto vazio de um lado", () => {
    expect(diffStats(diffLines("", "a\nb"))).toEqual({ added: 2, removed: 1 });
  });
});

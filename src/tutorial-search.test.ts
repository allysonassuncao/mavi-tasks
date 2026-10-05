import { describe, expect, it } from "vitest";
import { DESCRIPTION_PREFIX, sanitizeDescription } from "./rich-text";
import { tutorialSections, type TutorialHit } from "./tutorials";
import { TUTORIAL_MODULES } from "./tutorial-modules";
import { MODULES } from "./modules";
import { groupHits, queryWords, snippet } from "./TutorialSearch";
import { sanitizeArtifacts } from "./mavi-artifacts";

const doc = (...content: unknown[]) => DESCRIPTION_PREFIX + JSON.stringify({ type: "doc", content });
const text = (t: string, marks?: unknown[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const h = (t: string, level = 2) => ({ type: "heading", attrs: { level }, content: [text(t)] });

describe("seções dos tutoriais", () => {
  it("separa como o banco (mesmas âncoras de scripts/test-tutorials-mavi.mjs)", () => {
    const body = doc(
      p(text("Este guia mostra o caminho das tarefas.")),
      h("Criar a tarefa"),
      p(text("Clique em "), text("No", [{ type: "bold" }]), text("va tarefa e escolha o cliente.")),
      { type: "bulletList", content: [{ type: "listItem", content: [p(text("Descreva o pedido"))] }] },
      h("Passo à passo", 3),
      { type: "tutorialVideo", attrs: { provider: "youtube", videoId: "dQw4w9WgXcQ", label: "Demonstração", transcript: "Aqui eu mostro o filtro." } },
      h("Criar a tarefa"),
      p(text("Repetido de propósito.")),
    );
    expect(tutorialSections("O básico de Tarefas", body)).toEqual([
      { anchor: "", title: "", text: "O básico de Tarefas\nEste guia mostra o caminho das tarefas." },
      { anchor: "criar-a-tarefa", title: "Criar a tarefa", text: "Clique em Nova tarefa e escolha o cliente.\nDescreva o pedido" },
      { anchor: "passo-a-passo", title: "Passo à passo", text: "[Vídeo: Demonstração]\nTranscrição do vídeo: Aqui eu mostro o filtro." },
      { anchor: "criar-a-tarefa-2", title: "Criar a tarefa", text: "Repetido de propósito." },
    ]);
  });

  it("guarda a transcrição colada só no vídeo de link", () => {
    const clean = sanitizeDescription({
      type: "doc",
      content: [
        { type: "tutorialVideo", attrs: { provider: "vimeo", videoId: "123456789", transcript: "  Fala.  " } },
        { type: "tutorialVideo", attrs: { mediaId: "11111111-2222-4333-8444-555555555555", transcript: "x" } },
      ],
    });
    expect(clean.content?.[0].attrs?.transcript).toBe("Fala.");
    expect(clean.content?.[1].attrs).not.toHaveProperty("transcript");
  });
});

describe("resultados da busca", () => {
  it("as palavras da pergunta, sem acento, sem as curtas e sem as que a busca ignora", () => {
    expect(queryWords("Como mudo o PRAZO da tarefa? É urgente")).toEqual(["mudo", "prazo", "tarefa", "urgente"]);
  });

  it("o trecho em volta da palavra, com as palavras marcadas sem acento", () => {
    const content = `Seção: Prazo\n${"Texto de abertura bem longo. ".repeat(6)}Para mudar o prazo, escreva o motivo da mudança.`;
    const s = snippet(content, ["prazo", "mudanca"]);
    expect(s.before).toBe(true);
    expect(s.parts.filter((x) => x.mark).map((x) => x.text)).toEqual(["prazo", "mudança"]);
    expect(s.parts.map((x) => x.text).join("")).not.toContain("Seção:");
  });

  it("agrupa por tutorial na ordem da busca, sem repetir a seção", () => {
    const hit = (tutorial: string, anchor: string, chunk: number) =>
      ({ tutorial_id: tutorial, anchor, chunk_id: chunk }) as TutorialHit;
    const groups = groupHits([hit("a", "x", 1), hit("b", "", 2), hit("a", "x", 3), hit("a", "y", 4)]);
    expect(groups.map((g) => [g.tutorial.tutorial_id, g.sections.map((s) => s.chunk_id)])).toEqual([
      ["a", [1, 4]],
      ["b", [2]],
    ]);
  });
});

describe("módulos e cartões", () => {
  it("os módulos dos tutoriais têm os nomes de Módulos visíveis", () => {
    for (const m of MODULES) {
      const t = TUTORIAL_MODULES.find((x) => x.id === m.id);
      expect(t, m.id).toBeTruthy();
      if (m.id !== "assistant") expect(t!.label).toBe(m.label);
    }
  });

  it("o cartão Abrir tutorial só passa com id e âncora válidos", () => {
    const [card, bad] = sanitizeArtifacts([
      { id: "art-1", ref: "B1", type: "tutorial", tutorial: "11111111-2222-4333-8444-555555555555", anchor: "prazo", title: "Como", section: "Prazo", summary: "" },
      { id: "art-2", ref: "B2", type: "tutorial", tutorial: "x", anchor: "prazo", title: "Como" },
    ]);
    expect(card).toMatchObject({ type: "tutorial", anchor: "prazo", section: "Prazo" });
    expect(bad).toBeUndefined();
    const [weird] = sanitizeArtifacts([
      { id: "art-3", ref: "B3", type: "tutorial", tutorial: "11111111-2222-4333-8444-555555555555", anchor: "<script>", title: "" },
    ]);
    expect(weird).toMatchObject({ anchor: "", title: "Tutorial" });
  });
});

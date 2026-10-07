import { describe, expect, it } from "vitest";
import { inlineFrom } from "./CanvasEditors";
import { blocksToMarkdown, markdownBlocks } from "./mavi-export";
import { toDesign, countPages } from "./mavi-design";
import { editNote, editedArtifact, nextDocRef } from "./canvas-edit";
import { sanitizeArtifact, sanitizeCanvas, type CanvasArtifact } from "./mavi-artifacts";
import { builtinLook } from "./visual-identity";
import { documentHtml, slideHtml } from "./mavi-doc-html";

const look = builtinLook("corporativo")!;

describe("edição direta no canvas", () => {
  it("o texto do campo volta com negrito e itálico em Markdown", () => {
    const el = { childNodes: [] } as unknown as Element;
    // Um campo de verdade, montado à mão (sem DOM no teste).
    const node = (tag: string, children: unknown[], style: Record<string, string> = {}) => ({ nodeType: 1, tagName: tag, style, childNodes: children });
    const text = (t: string) => ({ nodeType: 3, textContent: t });
    Object.assign(el, {
      childNodes: [text("Os leads "), node("STRONG", [text("cresceram")]), text(" e "), node("SPAN", [text("muito")], { fontStyle: "italic" }), node("BR", []), text("  hoje")],
    });
    expect(inlineFrom(el)).toBe("Os leads **cresceram** e *muito* hoje");
  });

  it("os blocos voltam em Markdown que se lê igual", () => {
    const md = "## Resumo\n\nTexto com **forte**.\n\n- Um\n- Dois\n\n1. Primeiro\n\n> Nota\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const back = blocksToMarkdown(markdownBlocks(md));
    expect(markdownBlocks(back)).toEqual(markdownBlocks(md));
    // Bloco vazio (o que a pessoa acabou de criar) some do arquivo.
    expect(blocksToMarkdown([{ kind: "paragraph", text: "a" }, { kind: "paragraph", text: "" }]).trim()).toBe("a");
  });

  it("os campos editáveis só aparecem marcados no editor", () => {
    const s = { layout: "bullets" as const, title: "Tópicos", bullets: ["um", "dois"] };
    expect(slideHtml(s, look, 0)).not.toContain("data-f");
    const marked = slideHtml(s, look, 0, { marks: true });
    expect(marked).toContain('data-f="title"');
    expect(marked).toContain('data-f="bullets.1"');
    expect(marked).toContain('data-f="subtitle"');
    const doc = documentHtml("R", "Texto.\n\n| a | b |\n|---|---|\n| 1 | 2 |", look, { marks: true });
    expect(doc).toContain('data-b="0"');
    expect(doc).toContain('data-b="1.r.0.1"');
  });

  it("mover livre: apresentação e documento viram design com as cores na página", () => {
    const d = toDesign({ kind: "slides", title: "Pitch", theme: "claro", slides: [{ layout: "title", title: "Capa" }, { layout: "bullets", title: "B", bullets: ["x"] }] }, look);
    expect(d).toMatchObject({ kind: "design", format: "slides", pages: 2 });
    expect(countPages(d.html)).toBe(2);
    expect(d.html).not.toContain('style="--bg');
    expect(sanitizeCanvas(d)).toMatchObject({ kind: "design", pages: 2 });
    const doc = toDesign({ kind: "document", title: "R", markdown: "Texto longo o bastante." }, look);
    expect(doc).toMatchObject({ format: "a4", pages: 1 });
    expect(doc.html).toContain('class="page flow"');
  });

  it("a versão editada: referência nova, marcada como da pessoa, e a nota para a MAVI", () => {
    const from = { id: "c1", ref: "D1", type: "canvas", canvas: { kind: "document", title: "Proposta", markdown: "Texto longo o bastante." } } as CanvasArtifact;
    expect(nextDocRef([from, { ...from, ref: "D4" }, { id: "i", ref: "I9", type: "image" } as never])).toBe("D5");
    const to = editedArtifact(from, from.canvas, "D2");
    expect(sanitizeArtifact(to)).toMatchObject({ ref: "D2", revision_of: "D1", edited: true });
    expect(editNote(from, to)).toBe('Editei o D1 direto no canvas e salvei como D2 (documento “Proposta” (edição da pessoa de D1)). Daqui para a frente, use o D2.');
  });
});

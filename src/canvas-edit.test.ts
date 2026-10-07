import { describe, expect, it } from "vitest";
import { inlineFrom } from "./CanvasEditors";
import { blocksToMarkdown, markdownBlocks } from "./mavi-export";
import { toDesign, countPages } from "./mavi-design";
import { editNote, editedArtifact, identityParam, lookNote, nextDocRef, restyleDesign, withLook } from "./canvas-edit";
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

describe("aplicar identidade no canvas", () => {
  const to = builtinLook("escuro")!;
  it("design livre: cores, fontes e logo do tema anterior trocam numa passada", () => {
    const from = { ...look, logo: { light: "11111111-1111-1111-1111-111111111111" } };
    const dest = { ...to, logo: { dark: "22222222-2222-2222-2222-222222222222" } };
    const html = `<style>h1{color:${from.colors.accent.toLowerCase()};font-family:'${from.heading.family}',serif}</style>
<section class="page" style="background:${from.colors.bg};font-family:&quot;${from.body.family}&quot;"><img src="file:11111111-1111-1111-1111-111111111111"><p>${from.heading.family} no texto</p><b style="color:#123456">x</b></section>`;
    const out = restyleDesign(html, from, dest);
    expect(out).toContain(`color:${dest.colors.accent}`);
    expect(out).toContain(`background:${dest.colors.bg}`);
    expect(out).toContain(`'${dest.heading.family}',serif`);
    expect(out).toContain(`&quot;${dest.body.family}&quot;`);
    expect(out).toContain("file:22222222-2222-2222-2222-222222222222");
    // Cor que não é do tema e o texto da página ficam.
    expect(out).toContain("#123456");
    expect(out).toContain(`<p>${from.heading.family} no texto</p>`);
  });

  it("documento e apresentação levam só o tema; planilha não tem", () => {
    const doc = { kind: "document" as const, title: "T", markdown: "Oi", look };
    expect(withLook(doc, look, to)).toEqual({ ...doc, look: to });
    expect(withLook({ kind: "sheet", title: "P", sheets: [] } as never, null, to)).toBeNull();
  });

  it("a nota diz à MAVI qual identidade seguir", () => {
    const from = { id: "canvas-1", ref: "D1", type: "canvas", canvas: { kind: "document", title: "T", markdown: "Oi", look } } as CanvasArtifact;
    const saved = editedArtifact(from, { kind: "document", title: "T", markdown: "Oi", look: to }, "D2");
    expect(lookNote(from, saved, to)).toMatch(/“.+” no D1 .* como D2 .*identity: builtin:escuro/);
    expect(identityParam({ ...to, source: "company" })).toBe("empresa");
  });
});

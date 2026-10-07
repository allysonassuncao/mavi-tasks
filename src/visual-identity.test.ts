import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import {
  BUILTIN_LOOKS,
  builtinLook,
  contrast,
  contrastIssues,
  googleFontsHref,
  legacyLook,
  lookFiles,
  logoFor,
  sanitizeLook,
  sanitizeTokens,
  tokensFromBrand,
} from "./visual-identity";
import { canvasPage, documentHtml, slideHtml } from "./mavi-doc-html";
import { documentDocx, slidesPptx } from "./mavi-export";
import { sanitizeCanvas } from "./mavi-artifacts";

const logo = "00000000-0000-4000-8000-0000000000aa";
const dark = "00000000-0000-4000-8000-0000000000ab";
const font = "00000000-0000-4000-8000-0000000000bb";

describe("identidades: o formato fechado", () => {
  it("cores, fontes e formas; o que não serve volta ao padrão", () => {
    const t = sanitizeTokens({
      colors: { bg: "0b1020", primary: "#abc", ink: "vermelho", on_primary: undefined },
      heading: { family: "Playfair Display", weight: 750 },
      body: { family: "<script>", weight: 400 },
      logo: { light: logo, dark: "../x" },
      radius: 99,
      cover: "neon",
      decor: "band",
      faces: [{ file: font, family: "Tomato", weight: 700 }, { file: "x", family: "Y" }],
    });
    expect(t.colors.bg).toBe("#0B1020");
    expect(t.colors.primary).toBe("#AABBCC");
    expect(t.colors.ink).toBe(BUILTIN_LOOKS.claro.tokens.colors.ink);
    expect(t.mode).toBe("dark");
    expect(t.heading).toEqual({ family: "Playfair Display", weight: 800, source: "google" });
    expect(t.body).toEqual(BUILTIN_LOOKS.claro.tokens.body);
    expect(t.logo).toEqual({ light: logo });
    expect(t.radius).toBe(40);
    expect(t.cover).toBe("solid");
    expect(t.decor).toBe("band");
    expect(t.faces).toEqual([{ file: font, family: "Tomato", weight: 700, style: "normal" }]);
    // A fonte da marca só vale se tiver o arquivo.
    expect(sanitizeTokens({ faces: t.faces, heading: { family: "Tomato", source: "brand" } }).heading.source).toBe("brand");
    expect(sanitizeTokens({ heading: { family: "Calibri" } }).heading.source).toBe("system");
    expect(sanitizeLook({ name: "x", source: "hack", colors: {} })).toMatchObject({ source: "custom", id: "custom" });
    expect(sanitizeLook(null)).toBeNull();
  });

  it("os estilos prontos se leem bem (contraste) e o tema antigo continua igual", () => {
    for (const [key, b] of Object.entries(BUILTIN_LOOKS)) {
      expect(contrastIssues(b.tokens), key).toEqual([]);
      expect(contrast(b.tokens.colors.ink, b.tokens.colors.bg), key).toBeGreaterThanOrEqual(4.5);
    }
    expect(legacyLook("escuro").colors.bg).toBe("#1C2728");
    expect(legacyLook("inventado").id).toBe("builtin:claro");
    expect(builtinLook("nada")).toBeNull();
  });

  it("Google Fonts só com os pesos que a família tem", () => {
    expect(googleFontsHref({ heading: { family: "Bebas Neue", weight: 700, source: "google" }, body: { family: "Inter", weight: 400, source: "google" } })).toBe(
      "https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&family=Inter:wght@400;700&display=swap",
    );
    expect(googleFontsHref({ heading: { family: "Calibri", weight: 700, source: "system" }, body: { family: "Arial", weight: 400, source: "system" } })).toBeNull();
  });

  it("o primeiro tema a partir da Marca do Drive", () => {
    const t = tokensFromBrand({
      colors: [
        { name: "Branco", hex: "#FFFFFF" },
        { name: "Navy", hex: "#001119" },
        { name: "Laranja", hex: "#FF8900" },
      ],
      fonts: [
        { file: font, family: "Tomato Grotesk", weight: 700, style: "normal", role: "Títulos" },
        { file: dark, family: "Inter Marca", weight: 400, style: "normal", role: "Textos" },
      ],
      files: [
        { id: logo, name: "logo-colorido.svg" },
        { id: dark, name: "logo-branco.png" },
      ],
    });
    expect(t.colors.primary).toBe("#FF8900");
    expect(t.colors.ink).toBe("#001119");
    expect(t.heading).toEqual({ family: "Tomato Grotesk", weight: 700, source: "brand" });
    expect(t.body).toEqual({ family: "Inter Marca", weight: 400, source: "brand" });
    expect(t.logo).toEqual({ light: logo, dark });
    expect(logoFor(t, "#001119")).toBe(dark);
    expect(logoFor(t, "#FFFFFF")).toBe(logo);
    expect(lookFiles(t).sort()).toEqual([logo, dark, font].sort());
  });
});

describe("o desenho do documento e dos slides", () => {
  const look = { ...builtinLook("corporativo")!, logo: { light: logo } };
  it("o texto sai escapado e os arquivos como referência (ou pelo link dado)", () => {
    const html = documentHtml("Proposta <b>", "# Proposta <b>\nTexto <script>alert(1)</script> **forte**\n| a | b |\n|---|---|\n| 1 | 2 |", look);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>forte</strong>");
    expect(html).toContain("<th>a</th>");
    // O título repetido no começo do Markdown não aparece duas vezes.
    expect(html.match(/Proposta &lt;b&gt;/g)).toHaveLength(2); // capa e rodapé
    expect(html).toContain("--primary:#14213D");
    const slide = slideHtml({ layout: "title", title: "Pitch", subtitle: "Set" }, { ...look, cover: "solid" }, 0, {
      url: (t) => (t === `file:${logo}` ? "https://link/logo.svg" : null),
    });
    expect(slide).toContain('src="https://link/logo.svg"');
    expect(slide).toContain("cover-solid");
  });
  it("a página inteira: A4 para documento, 1280×720 por slide, com as fontes", () => {
    const deck = canvasPage({ kind: "slides", title: "Pitch", theme: "claro", slides: [{ layout: "bullets", title: "A", bullets: ["x"] }, { layout: "closing", title: "Fim" }] }, look);
    expect(deck).toContain("@page{size:1280px 720px;margin:0}");
    expect(deck).toContain("fonts.googleapis.com/css2?family=IBM+Plex+Sans");
    expect(deck.match(/class="s-box"/g)).toHaveLength(2);
    expect(canvasPage({ kind: "document", title: "R", markdown: "Um texto longo o bastante." }, look)).toContain("@page{size:A4;margin:0}");
  });
  it("o canvas guarda o tema e o tira quando não serve", () => {
    const c = sanitizeCanvas({ kind: "document", title: "R", markdown: "Um texto longo o bastante.", look: { ...look, colors: { bg: "x" } } });
    expect(c).toMatchObject({ look: { id: "builtin:corporativo", colors: { bg: "#FFFFFF" } } });
    expect(sanitizeCanvas({ kind: "document", title: "R", markdown: "Um texto longo o bastante." })).not.toHaveProperty("look");
  });
});

describe("arquivos com a identidade", () => {
  const look = builtinLook("editorial")!;
  it("Word: fontes, cores dos títulos e cabeçalho da tabela na cor principal", async () => {
    const blob = await documentDocx("Relatório", "## Resumo\nTexto.\n| a | b |\n|---|---|\n| 1 | 2 |", look);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const styles = strFromU8(files["word/styles.xml"]);
    expect(styles).toContain('w:ascii="Source Sans 3"');
    expect(styles).toContain('w:ascii="Playfair Display"');
    const doc = strFromU8(files["word/document.xml"]);
    expect(doc).toContain('w:fill="A0522D"');
    expect(doc).toContain('<w:color w:val="FFFFFF"/>'); // texto sobre a principal
    expect(doc).toContain('<w:background w:color="FAF6EF"');
  });
  it("PowerPoint: fundo, fontes e o logo do tema", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const blob = await slidesPptx(
      { kind: "slides", title: "Pitch", theme: "claro", look: { ...look, cover: "primary" }, slides: [{ layout: "title", title: "Capa" }, { layout: "bullets", title: "Tópicos", bullets: ["a"] }] },
      async () => null,
      { logo: async () => ({ data: png, width: 300, height: 100 }) },
    );
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const cover = strFromU8(files["ppt/slides/slide1.xml"]);
    expect(cover).toContain('<a:srgbClr val="A0522D"');
    expect(cover).toContain('typeface="Playfair Display"');
    const content = strFromU8(files["ppt/slides/slide2.xml"]);
    expect(content).toContain('<a:srgbClr val="FAF6EF"');
    expect(Object.keys(files).some((f) => /^ppt\/media\/image/.test(f))).toBe(true);
  });
});

describe("Guia da marca vivo", () => {
  it("põe os itens no fim da seção, tira os vazios do modelo e não repete", async () => {
    const { addToGuide, GUIDE_TEMPLATE } = await import("./visual-identity");
    const g1 = addToGuide(GUIDE_TEMPLATE, "Evite", ["Verde-limão nos títulos", "Emoji em proposta"]);
    expect(g1).toContain("## Evite\n- Verde-limão nos títulos\n- Emoji em proposta\n\n## Exemplos aprovados");
    expect(g1).not.toMatch(/## Evite\n-\n/);
    // Repetido (com outra caixa) não entra de novo.
    expect(addToGuide(g1, "evite", ["verde-limão nos títulos"])).toBe(g1);
    // Aprendizados levam a data; o exemplo entre parênteses some.
    const g2 = addToGuide(g1, "Aprendizados", ["Capa sempre escura"], "07/10/2026");
    expect(g2).toContain("## Aprendizados\n- (07/10/2026) Capa sempre escura");
    expect(g2).not.toContain("(correções do cliente, com a data)");
    // Seção que não existe nasce no fim.
    expect(addToGuide("## Essência\nTexto.", "Faça", ["Fotos reais"])).toBe("## Essência\nTexto.\n\n## Faça\n- Fotos reais\n");
    expect(addToGuide("", "Faça", ["Fotos reais"])).toBe("## Faça\n- Fotos reais\n");
  });

  it("ajustar só as cores mantém o logo e as fontes da base", () => {
    const base = { ...BUILTIN_LOOKS.claro.tokens, logo: { light: logo }, faces: [{ file: font, family: "Tomato", weight: 700, style: "normal" as const }] };
    const t = sanitizeTokens({ colors: { primary: "#FF6E28" } }, base);
    expect(t.logo).toEqual({ light: logo });
    expect(t.faces).toHaveLength(1);
    expect(t.colors.primary).toBe("#FF6E28");
  });

  it("a proposta da MAVI no formato fechado", async () => {
    const { sanitizeAction } = await import("./mavi-artifacts");
    const client = "00000000-0000-4000-8000-000000000002";
    expect(sanitizeAction({ kind: "identity", op: "guide_add", scope: "client", client_id: client, identity_name: "Marca", section: "Evite", lines: ["Emoji", ""], reason: "pediu" })).toEqual({
      kind: "identity", op: "guide_add", scope: "client", client_id: client, client_name: "", identity_name: "Marca", section: "Evite", lines: ["Emoji"], reason: "pediu",
    });
    expect(sanitizeAction({ kind: "identity", op: "guide_add", scope: "client", identity_name: "x", section: "Evite", lines: ["a"] })).toBeNull();
    expect(sanitizeAction({ kind: "identity", op: "guide_add", scope: "company", identity_name: "x", section: "Evite", lines: [] })).toBeNull();
    const save = sanitizeAction({ kind: "identity", op: "save", scope: "gallery", identity_name: "Noite", tokens: { colors: { bg: "#0b1020" } }, guide: "## Tom\nCurto." });
    expect(save).toMatchObject({ op: "save", scope: "gallery", tokens: { mode: "dark", colors: { bg: "#0B1020" } }, guide: "## Tom\nCurto." });
  });
});

describe("salvar no Drive", () => {
  it("a proposta no formato fechado", async () => {
    const { sanitizeAction } = await import("./mavi-artifacts");
    const id = "00000000-0000-4000-8000-000000000002";
    expect(sanitizeAction({ kind: "drive_save", ref: "d1", format: "exe", file_name: "a/b:c", client_id: id, client_name: "Clínica", folder_id: "x" })).toEqual({
      kind: "drive_save", ref: "D1", format: "pdf", file_name: "a b c", client_id: id, client_name: "Clínica",
    });
    expect(sanitizeAction({ kind: "drive_save", ref: "V1", format: "pdf" })).toBeNull();
  });
});

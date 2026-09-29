import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  cleanFileName,
  fileKind,
  importSkill,
  parseSkillMd,
  skillMd,
  slugify,
  validSlug,
} from "./mavi-skills";
import { resolvePage, skillIdFromPath, pageUrl } from "./router";
import { canOpenPage, moduleOf } from "./modules";

describe("skills no formato da Claude", () => {
  it("lê o SKILL.md: identificador, título, descrição e instruções", () => {
    const md = `---\nname: relatorio-mensal\ndescription: >\n  Quando pedirem o relatório\n  mensal de um cliente.\n---\n# Relatório mensal\n\n1. Busque as campanhas.\n`;
    expect(parseSkillMd(md)).toEqual({
      slug: "relatorio-mensal",
      name: "Relatório mensal",
      description: "Quando pedirem o relatório mensal de um cliente.",
      instructions: "# Relatório mensal\n\n1. Busque as campanhas.",
    });
    // Sem título: o nome vem do identificador.
    expect(parseSkillMd("---\nname: pdf-tools\ndescription: 'Para PDFs.'\n---\nFaça.").name).toBe(
      "Pdf tools",
    );
    // Sem cabeçalho: o primeiro # vira o nome.
    expect(parseSkillMd("# Briefing\nPergunte.")).toMatchObject({ slug: "", name: "Briefing" });
    // O que a MAVI exporta volta igual.
    const out = skillMd({
      slug: "briefing",
      name: "Briefing: novo cliente",
      description: "Quando chegar um cliente novo.",
      instructions: "Pergunte o objetivo.",
    });
    expect(parseSkillMd(out)).toEqual({
      slug: "briefing",
      name: "Briefing: novo cliente",
      description: "Quando chegar um cliente novo.",
      instructions: "Pergunte o objetivo.",
    });
  });

  it("identificadores e nomes de arquivo que o banco aceita", () => {
    expect(slugify("Relatório Mensal (v2)!")).toBe("relatorio-mensal-v2");
    expect(validSlug("a")).toBe(false);
    expect(validSlug("relatorio-mensal")).toBe(true);
    expect(cleanFileName("..\\references/../modelo ção.md")).toBe("references/modelo cao.md");
    expect(fileKind("dados.csv")).toBe("text");
    expect(fileKind("proposta.pdf")).toBe("pdf");
    expect(fileKind("logo.png")).toBeNull();
  });

  it("importa um .zip com a pasta da skill; o que não é texto fica de fora", async () => {
    const zip = zipSync({
      "relatorio/SKILL.md": strToU8("---\nname: relatorio\ndescription: Relatório do mês do cliente.\n---\nSiga o modelo."),
      "relatorio/references/modelo.md": strToU8("# Modelo"),
      "relatorio/scripts/grafico.py": strToU8("print(1)"),
      "relatorio/assets/logo.png": new Uint8Array([137, 80, 78, 71]),
      "__MACOSX/relatorio/._SKILL.md": strToU8("x"),
    });
    const file = new File([zip], "relatorio.zip", { type: "application/zip" });
    const { draft, skipped } = await importSkill(file);
    expect(draft).toMatchObject({
      slug: "relatorio",
      name: "Relatorio",
      description: "Relatório do mês do cliente.",
      instructions: "Siga o modelo.",
    });
    expect(draft.files.map((f) => f.name).sort()).toEqual(["references/modelo.md", "scripts/grafico.py"]);
    expect(skipped).toEqual(["assets/logo.png (não é texto)"]);
    await expect(importSkill(new File(["x"], "foto.png"))).rejects.toThrow(/SKILL.md ou um .zip/);
    await expect(
      importSkill(new File([zipSync({ "a.md": strToU8("x") })], "vazio.zip")),
    ).rejects.toThrow(/não tem um SKILL.md/);
  });
});

describe("a página de Skills", () => {
  it("tem endereço próprio e segue o módulo da MAVI", () => {
    const id = "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d";
    expect(pageUrl("skills")).toBe("/mavi/skills");
    expect(resolvePage(`/agencias/make/mavi/skills/${id}`)).toBe("skills");
    expect(skillIdFromPath(`/mavi/skills/${id}`)).toBe(id);
    expect(moduleOf("skills")).toBe("assistant");
    expect(canOpenPage("skills", "member")).toBe(true);
    expect(canOpenPage("skills", "member", ["assistant"])).toBe(false);
  });
});

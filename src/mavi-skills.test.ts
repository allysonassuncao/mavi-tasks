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

describe("revisão da MAVI: aplicar e desfazer", async () => {
  const { applyCheck, undoCheck, applyCoach, checkKey } = await import("./mavi-skills");
  const draft = {
    slug: "relatorio",
    name: "Relatório",
    description: "Relatório.",
    instructions: "# Relatório\n\n1. Rode o script.\n2. Monte.\n",
    files: [{ name: "a.md", content: "linha 1\nlinha 2" }],
    note: "",
  };
  const item = (x: Record<string, unknown>) =>
    ({ id: "c1", kind: "fix", severity: "high", title: "t", why: "w", ...x }) as Parameters<typeof applyCheck>[1];

  it("troca o trecho, inclui depois do trecho ou no fim, e desfaz", () => {
    const fix = applyCheck(draft, item({ target: "instructions", before: "1. Rode o script.", after: "1. Busque as campanhas." }))!;
    expect(fix.draft.instructions).toBe("# Relatório\n\n1. Busque as campanhas.\n2. Monte.\n");
    expect(undoCheck(fix.draft, fix.undo)).toEqual(draft);
    const after = applyCheck(draft, item({ kind: "include", target: "instructions", anchor: "# Relatório", after: "Objetivo: o mês." }))!;
    expect(after.draft.instructions).toBe("# Relatório\n\nObjetivo: o mês.\n\n1. Rode o script.\n2. Monte.\n");
    const end = applyCheck(draft, item({ kind: "include", target: "instructions", after: "3. Confira." }))!;
    expect(end.draft.instructions.endsWith("2. Monte.\n\n3. Confira.\n")).toBe(true);
    // O trecho mudou desde a revisão: não aplica.
    expect(applyCheck(draft, item({ target: "instructions", before: "outro texto", after: "x" }))).toBeNull();
    // Sem texto pronto: é só orientação.
    expect(applyCheck(draft, item({ target: "description" }))).toBeNull();
  });

  it("campos inteiros e arquivos: novo, trocado e removido", () => {
    const d = applyCheck(draft, item({ target: "description", after: "Quando pedirem o relatório do mês." }))!;
    expect(d.draft.description).toBe("Quando pedirem o relatório do mês.");
    expect(undoCheck(d.draft, d.undo).description).toBe("Relatório.");
    const add = applyCheck(draft, item({ kind: "include", target: "file", file: "modelo.md", after: "# Modelo" }))!;
    expect(add.draft.files.map((f) => f.name)).toEqual(["a.md", "modelo.md"]);
    expect(undoCheck(add.draft, add.undo).files).toEqual(draft.files);
    const rm = applyCheck(draft, item({ kind: "remove", target: "file", file: "a.md" }))!;
    expect(rm.draft.files).toEqual([]);
    expect(undoCheck(rm.draft, rm.undo).files).toEqual(draft.files);
    const edit = applyCheck(draft, item({ target: "file", file: "a.md", before: "linha 2", after: "linha dois" }))!;
    expect(edit.draft.files[0].content).toBe("linha 1\nlinha dois");
    expect(checkKey(edit.draft)).not.toBe(checkKey(draft));
  });

  it("o assistente troca os campos inteiros; o identificador acompanha o nome só na skill nova", () => {
    const r = { draft: { name: "Relatório mensal do cliente", instructions: "1. Busque.\n2. Resuma." }, files: [{ name: "modelo.md", content: "# M" }, { name: "a.md", remove: true }] };
    const next = applyCoach(draft, r, true);
    expect(next).toMatchObject({ slug: "relatorio-mensal-do-cliente", name: "Relatório mensal do cliente", description: "Relatório.", instructions: "1. Busque.\n2. Resuma." });
    expect(next.files).toEqual([{ name: "modelo.md", content: "# M" }]);
    expect(applyCoach(draft, r, false).slug).toBe("relatorio");
  });
});

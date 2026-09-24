import { describe, expect, it } from "vitest";
import {
  byTemplate,
  customFieldsError,
  customKey,
  fieldIdFrom,
  formatCustomValue,
  templateFieldsFor,
} from "./templateFields";
import { demoSnapshot } from "./demo";

const data = demoSnapshot();
// ct-1 is Social Leads (pd-3); a Make Ads contract (pd-1):
const adsContract = data.contracts.find((k) => k.product_id === "pd-1")!.id;
const otherContract = data.contracts.find((k) => k.product_id !== "pd-1")!.id;
const creative = data.teamMembers.find(
  (tm) => tm.team_id === "team-2",
)!.user_id;
const outside = data.members.find(
  (m) =>
    !data.teamMembers.some(
      (tm) => tm.user_id === m.user_id && tm.team_id === "team-2",
    ),
)?.user_id;

describe("templateFieldsFor", () => {
  it("soma os templates do produto e da equipe do responsável", () => {
    const names = byTemplate(
      templateFieldsFor(data, adsContract, creative),
    ).map((g) => g.name);
    expect(names).toEqual([
      "Criativos de Make Ads",
      "Padrão Criação & Conteúdo",
    ]);
  });
  it("em outro produto, vale só o da equipe", () => {
    const names = byTemplate(
      templateFieldsFor(data, otherContract, creative),
    ).map((g) => g.name);
    expect(names).toEqual(["Padrão Criação & Conteúdo"]);
  });
  it("sem produto nem equipe com template, não há campos", () => {
    if (!outside) return;
    expect(templateFieldsFor(data, otherContract, outside)).toEqual([]);
  });
  it("templates inativos não entram", () => {
    const off = {
      ...data,
      taskTemplates: data.taskTemplates.map((t) => ({ ...t, active: false })),
    };
    expect(templateFieldsFor(off, adsContract, creative)).toEqual([]);
  });
});

describe("customFieldsError", () => {
  const fields = templateFieldsFor(data, adsContract, creative);
  const briefing = fields.find((f) => f.id === "briefing")!;
  const formato = fields.find((f) => f.id === "formato")!;
  it("aponta o primeiro obrigatório vazio", () => {
    expect(customFieldsError(fields, {})).toBe(
      'Preencha o campo obrigatório "Link do briefing"',
    );
  });
  it("confere links e números", () => {
    expect(
      customFieldsError(fields, {
        [customKey(briefing)]: "docs",
        [customKey(formato)]: "Feed",
      }),
    ).toMatch(/Informe um link/);
  });
  it("aceita valores válidos", () => {
    expect(
      customFieldsError(fields, {
        [customKey(briefing)]: "https://docs.example/b",
        [customKey(formato)]: "Feed",
      }),
    ).toBe("");
  });
});

describe("apresentação e ids", () => {
  it("formata valores por tipo", () => {
    const base = { id: "x", label: "X", required: false };
    expect(formatCustomValue({ ...base, type: "checkbox" }, true)).toBe("Sim");
    expect(
      formatCustomValue({ ...base, type: "multiselect" }, ["A", "B"]),
    ).toBe("A, B");
    expect(formatCustomValue({ ...base, type: "text" }, "")).toBe("");
  });
  it("gera ids estáveis e únicos a partir do nome", () => {
    expect(fieldIdFrom("Link do briefing", [])).toBe("link_do_briefing");
    expect(fieldIdFrom("Ação!", ["acao"])).toBe("acao_2");
  });
});

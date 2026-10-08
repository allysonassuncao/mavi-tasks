import { describe, expect, it } from "vitest";
import {
  describeTarget,
  looksDestructive,
  maxScore,
  pathShape,
  scoreCandidate,
  stableClasses,
  stableId,
  threshold,
  type Candidate,
  type TourTarget,
} from "./tour-target";
import { onStepScreen, placeBalloon, screenOf, screenShape, stepHref, tourModules, type TourStep } from "./tours";

const target: TourTarget = {
  tag: "button",
  tour: null,
  id: null,
  role: null,
  label: null,
  text: "Nova tarefa",
  classes: ["btn", "primary"],
  path: "main > div.page-head > button.btn.primary:nth-of-type(2)",
  context: "Tarefas",
  dialog: false,
  nth: 0,
  box: { x: 0.8, y: 0.05, w: 0.08, h: 0.04 },
};
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  text: "Nova tarefa",
  label: null,
  role: null,
  classes: ["btn", "primary"],
  dialog: false,
  context: "Tarefas",
  pathMatch: true,
  shapeMatch: true,
  nth: 0,
  box: { ...target.box },
  ...over,
});

describe("pontuação dos candidatos", () => {
  it("o mesmo elemento passa com folga", () => {
    expect(scoreCandidate(target, cand())).toBeGreaterThan(threshold(target) * 2);
  });
  it("outro lugar e outra posição, mas o mesmo texto, ainda passa", () => {
    const moved = cand({ pathMatch: false, shapeMatch: false, context: "", box: { x: 0.1, y: 0.9, w: 0.08, h: 0.04 } });
    expect(scoreCandidate(target, moved)).toBeGreaterThanOrEqual(threshold(target));
  });
  it("um botão qualquer com outro texto não passa", () => {
    const other = cand({ text: "Exportar", pathMatch: false, shapeMatch: false, context: "", classes: ["btn"], box: { x: 0.2, y: 0.5, w: 0.05, h: 0.03 } });
    expect(scoreCandidate(target, other)).toBeLessThan(threshold(target));
  });
  it("dentro de um modal não vale pelo de fora", () => {
    const inside = { ...target, dialog: true };
    expect(scoreCandidate(inside, cand({ dialog: false }))).toBeLessThan(scoreCandidate(inside, cand({ dialog: true })));
  });
  it("entre botões iguais, o da mesma ordem ganha", () => {
    const second = { ...target, nth: 1 };
    expect(scoreCandidate(second, cand({ nth: 1 }))).toBeGreaterThan(scoreCandidate(second, cand({ nth: 0 })));
  });
  it("texto sem acento e com espaços diferentes conta como o mesmo", () => {
    const t = { ...target, text: "Configurações" };
    expect(scoreCandidate(t, cand({ text: " configuracoes " }))).toBeGreaterThan(threshold(t));
  });
  it("sem texto nem rótulo (uma tabela), o caminho e as classes decidem", () => {
    const table: TourTarget = { ...target, tag: "table", text: "", classes: ["tasks-table"], context: "" };
    expect(maxScore(table)).toBeGreaterThan(0);
    expect(scoreCandidate(table, cand({ text: "", classes: ["tasks-table"], context: "" }))).toBeGreaterThanOrEqual(threshold(table));
    expect(
      scoreCandidate(table, cand({ text: "", classes: ["other"], context: "", pathMatch: false, shapeMatch: false, box: { x: 0, y: 0.9, w: 0.1, h: 0.05 } })),
    ).toBeLessThan(threshold(table));
  });
});

describe("impressões digitais", () => {
  it("ids gerados e classes de estado ficam de fora", () => {
    expect(stableId(":r1a:")).toBeNull();
    expect(stableId("a1b2c3d4-0000-4000-8000-000000000000")).toBeNull();
    expect(stableId("task-123456")).toBeNull();
    expect(stableId("sidebar")).toBe("sidebar");
    expect(stableClasses(["btn", "is-open", "active", "selected", "row-12345", "tour-ring", "primary"])).toEqual(["btn", "primary"]);
  });
  it("forma do caminho ignora as posições", () => {
    expect(pathShape("main > ul > li:nth-of-type(3) > button")).toBe("ul > li > button");
  });
  it("nome do elemento para o editor e botões perigosos", () => {
    expect(describeTarget({ tag: "button", role: null, text: "Nova tarefa", label: null })).toBe("Botão “Nova tarefa”");
    expect(describeTarget({ tag: "div", role: "tab", text: "", label: "Plataforma" })).toBe("Aba “Plataforma”");
    expect(looksDestructive({ text: "Excluir tarefa", label: null })).toBe(true);
    expect(looksDestructive({ text: "Salvar", label: "Remover filtro" })).toBe(true);
    expect(looksDestructive({ text: "Nova tarefa", label: null })).toBe(false);
  });
});

describe("telas", () => {
  it("guarda o caminho sem a agência, só os parâmetros de tela e o hash", () => {
    expect(screenOf("/agencias/make/tarefas", "?aba=quadro&status=x&termo=y", "")).toBe("/tarefas?aba=quadro");
    expect(screenOf("/configuracoes", "", "#equipe")).toBe("/configuracoes#equipe");
  });
  it("registros do mesmo tipo são a mesma tela; a lista não é o registro", () => {
    const a = "/campanhas/a1b2c3d4-0000-4000-8000-000000000001";
    const b = "/campanhas/a1b2c3d4-0000-4000-8000-000000000002";
    expect(onStepScreen(a, b)).toBe(true);
    expect(onStepScreen("/tarefas", "/tarefas/a1b2c3d4-0000-4000-8000-000000000001/minha-tarefa")).toBe(false);
    expect(screenShape("/tarefas/a1b2c3d4-0000-4000-8000-000000000001/minha-tarefa")).toBe("/tarefas/:id");
    expect(onStepScreen("/tarefas?aba=x", "/tarefas")).toBe(false);
  });
  it("endereço do passo na agência", () => {
    expect(stepHref("/tarefas", "make vendas")).toBe("/agencias/make%20vendas/tarefas");
    expect(stepHref("/tarefas", "")).toBe("/tarefas");
  });
  it("módulos tirados das telas dos passos", () => {
    const s = (page: string) => ({ page }) as TourStep;
    expect(tourModules([s("tasks"), s("campaigns"), s("tasks"), s("tutorials")])).toEqual(["campaigns", "tasks"]);
  });
});

describe("posição do balão", () => {
  const view = { width: 1200, height: 800 };
  const size = { width: 300, height: 150 };
  it("abaixo quando cabe; acima quando o elemento está no pé da tela", () => {
    expect(placeBalloon({ left: 100, top: 100, width: 80, height: 30 }, size, "auto", view).side).toBe("bottom");
    expect(placeBalloon({ left: 100, top: 700, width: 80, height: 30 }, size, "auto", view).side).toBe("top");
  });
  it("respeita o lado escolhido e fica dentro da tela", () => {
    const p = placeBalloon({ left: 1100, top: 300, width: 80, height: 30 }, size, "right", view);
    expect(p.side).toBe("left");
    expect(p.left).toBeGreaterThanOrEqual(12);
    const q = placeBalloon({ left: 0, top: 300, width: 40, height: 30 }, size, "bottom", view);
    expect(q.left).toBe(12);
  });
  it("sem elemento (ou elemento enorme), no meio ou no pé da tela", () => {
    expect(placeBalloon(null, size, "auto", view)).toEqual({ left: 450, top: 325, side: "center" });
    expect(placeBalloon({ left: 0, top: 0, width: 1200, height: 800 }, size, "auto", view).side).toBe("center");
  });
});

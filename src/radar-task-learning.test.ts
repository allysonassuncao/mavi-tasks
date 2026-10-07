import { describe, expect, it } from "vitest";
import {
  changedLine,
  draftPayload,
  loadTaskLearning,
  mainPriority,
  presetRate,
  ruleDraft,
  ruleOutcome,
  ruleScope,
  rulesCost,
  taskRate,
  suggestionHitRate,
  autonomyLine,
  undoUntil,
} from "./radar-task-learning";

describe("Tarefas do Radar (o que a MAVI aprende)", () => {
  it("calcula quantos itens viram tarefa e quantas ficaram como vieram", () => {
    expect(taskRate({ items_task: 3, no_task: 1 })).toBe(75);
    expect(taskRate({ items_task: 0, no_task: 0 })).toBeNull();
    expect(presetRate({ with_preset: 4, as_preset: 1 })).toBe(25);
    expect(presetRate({ with_preset: 0, as_preset: 0 })).toBeNull();
  });
  it("resume o que mudam e a prioridade mais usada", () => {
    expect(changedLine({ title: 1, due: 3 })).toBe("prazo 3 · título 1");
    expect(changedLine({})).toBe("");
    expect(mainPriority({ normal: 1, high: 4 })).toBe("Alta");
    expect(mainPriority({ normal: 5, high: 1 })).toBeNull();
  });
  it("na demonstração, filtra pelo tópico", async () => {
    const all = await loadTaskLearning("demo-agency", { days: 180 });
    const one = await loadTaskLearning("demo-agency", { days: 180, topic: "rt-2" });
    expect(all.groups.length).toBe(2);
    expect(one.groups.map((g) => g.topic_name)).toEqual(["Promessas da Make"]);
    expect(one.totals.no_task).toBe(6);
  });

  it("descreve a regra: o que fazer, onde vale", () => {
    expect(ruleOutcome({ action: "task", team_name: "Tráfego", due_days: 2, priority: "high" })).toBe(
      "Abrir tarefa para a equipe Tráfego · prazo 2 dias úteis · prioridade Alta",
    );
    expect(ruleOutcome({ action: "task", team_name: "Tráfego", assignee_name: "Bruno", due_days: 1, priority: "normal" })).toBe(
      "Abrir tarefa para Bruno (equipe Tráfego) · prazo 1 dia útil",
    );
    expect(ruleOutcome({ action: "task" })).toBe("Abrir tarefa");
    expect(ruleOutcome({ action: "no_task", team_name: "x" })).toBe("Não abrir tarefa");
    expect(ruleScope({ all_products: true, product_name: "x" })).toBe("Todos os produtos");
    expect(ruleScope({})).toBe("Geral / Agência");
  });
  it("o formulário vira o que o banco recebe; não abrir tarefa não leva equipe nem prazo", () => {
    const d = { ...ruleDraft(undefined, "t1"), product: "all", condition: "  Elogio  ", min_severity: "1", team_id: "tm", due_days: "3" };
    expect(draftPayload(d)).toMatchObject({ topic_id: "t1", all_products: true, product_id: null, condition: "Elogio",
      min_severity: 1, team_id: "tm", due_days: 3, priority: null });
    expect(draftPayload({ ...d, action: "no_task" })).toMatchObject({ team_id: null, due_days: null, title_hint: null });
    expect(draftPayload({ ...d, product: "p1" })).toMatchObject({ all_products: false, product_id: "p1" });
  });
  it("estima o custo do histórico pelo preço ou pela média medida", () => {
    const base = { groups: 2, signals: 20, chars: 35_000, avg_cost: null, samples: 0, price: { input: 1, output: 5 } };
    const byPrice = rulesCost(base);
    // (10.000 + 7.000 tokens de entrada) × US$ 1/M + 3.000 de saída × US$ 5/M = US$ 0,032, +10% do Jev.
    expect(byPrice.measured).toBe(false);
    expect(byPrice.low).toBeCloseTo(0.032 * 1.1 * 0.7, 5);
    const measured = rulesCost({ ...base, avg_cost: 0.05, samples: 4 });
    expect(measured.measured).toBe(true);
    expect(measured.high).toBeCloseTo(2 * 0.05 * 1.1 * 1.3, 5);
  });
  it("autonomia: o acerto conta as criadas sozinhas e as desfeitas; a frase do grupo", () => {
    const base = { as_is: 6, accepted: 8, dismissed: 1, replaced: 1, expired: 0 };
    expect(suggestionHitRate(base)).toBe(60);
    expect(suggestionHitRate({ ...base, auto: 4, undone: 1 })).toBe(67);
    const settings = { suggest: true, autonomy_rate: 90, autonomy_min: 10, mavi_name: "MAVI" };
    const g = { autonomy: { enabled: true, decided: 4, hits: 4, rate: 100, active: false } } as Parameters<typeof autonomyLine>[0];
    expect(autonomyLine(g, settings)).toBe("Liberada · faltam decisões (4 de 10)");
    expect(autonomyLine({ ...g, autonomy: { ...g.autonomy!, decided: 20, rate: 80 } }, settings)).toBe(
      "Liberada · acerto 80% (precisa de 90%)",
    );
    expect(autonomyLine({ ...g, autonomy: { ...g.autonomy!, decided: 20, rate: 95, active: true } }, settings)).toBe(
      "Abre sozinha · acerto 95%",
    );
    expect(autonomyLine({ ...g, autonomy: { ...g.autonomy!, enabled: false } }, settings)).toBe("Só sugere");
    expect(autonomyLine(g, { suggest: true })).toBe("Liberada, mas a MAVI não está na empresa");
    expect(undoUntil()).toBe("");
    expect(undoUntil("2026-10-08T17:30:00Z")).toMatch(/^até \d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});

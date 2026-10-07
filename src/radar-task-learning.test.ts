import { describe, expect, it } from "vitest";
import { changedLine, loadTaskLearning, mainPriority, presetRate, taskRate } from "./radar-task-learning";

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
});

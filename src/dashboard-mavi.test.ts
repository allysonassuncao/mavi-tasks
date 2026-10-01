import { describe, expect, it } from "vitest";
import { applyProposal, proposalItems } from "./dashboard-mavi";
import { checkSpec, type Panel, type PanelSpec } from "./dashboards";

const stat: PanelSpec = {
  viz: "stat",
  groupBy: "none",
  queries: [{ ref: "A", source: "tasks", metric: "count", filters: [] }],
};
const panels: Panel[] = [
  { id: "a", title: "Criadas", x: 0, y: 0, w: 3, h: 3, spec: stat },
  { id: "b", title: "Entregas", x: 3, y: 0, w: 3, h: 3, spec: stat },
  { id: "c", title: "Ritmo", x: 0, y: 3, w: 12, h: 5, spec: { ...stat, viz: "line", groupBy: "time" } },
];

describe("MAVI nos Dashboards: aplicar a proposta", () => {
  it("só os itens escolhidos; painéis novos no primeiro espaço livre, sem sobrepor", () => {
    const items = proposalItems(
      {
        name: "Operação do mês",
        range: "month",
        add: [
          { title: "Atrasadas", w: 3, h: 3, spec: { ...stat, queries: [{ ...stat.queries[0], metric: "late" }] }, why: "" },
          { title: "Horas", w: 3, h: 3, spec: stat, why: "" },
        ],
        update: [{ id: "c", title: "Ritmo semanal", w: 12, h: 6, spec: { ...stat, viz: "bar", groupBy: "time" }, why: "" }],
        remove: ["b", "não-existe"],
      },
      panels,
    );
    expect(items.map((i) => i.key)).toEqual(["name", "range", "add-0", "add-1", "update-c", "remove-b"]);
    // A pessoa tirou o painel "Horas".
    const next = applyProposal({ name: "Operação", description: "", panels }, items.filter((i) => i.key !== "add-1"));
    expect(next.name).toBe("Operação do mês");
    expect(next.range).toBe("month");
    expect(next.panels.map((p) => p.title)).toEqual(["Criadas", "Ritmo semanal", "Atrasadas"]);
    const late = next.panels.find((p) => p.title === "Atrasadas")!;
    // Onde estava "Entregas", ao lado de "Criadas".
    expect([late.x, late.y]).toEqual([3, 0]);
    expect(next.panels.find((p) => p.id === "c")).toMatchObject({ h: 6, spec: { viz: "bar" } });
  });

  it("o catálogo recusa o que o módulo não tem, em palavras", () => {
    expect(checkSpec({ viz: "pizza", queries: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/viz inválida/) });
    expect(
      checkSpec({ viz: "table", groupBy: "executor", queries: [{ source: "hours", metric: "hours" }] }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Agrupamento "executor"/) });
    const ok = checkSpec({
      viz: "stat",
      queries: [
        { ref: "A", source: "tasks", metric: "count", hidden: true, attribution: "assignee" },
        { ref: "B", source: "tasks", metric: "late", hidden: true },
      ],
      formula: { expr: "B / A * 100", label: "Atraso" },
    });
    expect(ok).toMatchObject({
      ok: true,
      spec: { groupBy: "none", compare: true, formula: { expr: "B / A * 100" }, queries: [{ attribution: "assignee" }, {}] },
    });
  });
});

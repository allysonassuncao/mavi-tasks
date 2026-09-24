import { describe, expect, it } from "vitest";
import {
  buildDisplay,
  compact,
  evaluate,
  formatValue,
  freeSpot,
  parseFormula,
  placePanel,
  resolveRange,
  starterPanels,
  type Panel,
  type PanelResult,
  type PanelSpec,
} from "./dashboards";
import { niceTicks } from "./DashboardCharts";
import { runPanel } from "./dashboard-engine";
import { emptySnapshot, type Snapshot, type Task } from "./types";

const calc = (expr: string, values: Record<string, number | null>) => {
  const f = parseFormula(expr);
  if (!f.ok) throw Error(f.error);
  return evaluate(f.node, values);
};

describe("Fórmulas", () => {
  it("respeita precedência, parênteses e sinal", () => {
    expect(calc("A / B * 100", { A: 3, B: 4 })).toBe(75);
    expect(calc("(A - B) / A * 100", { A: 10, B: 2 })).toBe(80);
    expect(calc("A + B * C", { A: 1, B: 2, C: 3 })).toBe(7);
    expect(calc("-A + 2,5", { A: 1 })).toBe(1.5);
  });
  it("divisão por zero e valor ausente ficam vazios", () => {
    expect(calc("A / B", { A: 1, B: 0 })).toBeNull();
    expect(calc("A + B", { A: 1, B: null })).toBeNull();
  });
  it("recusa qualquer coisa além de A–E, números e operadores", () => {
    for (const bad of [
      "A; drop",
      "Math.max(A)",
      "A ** 2",
      "F + 1",
      "A +",
      "(A",
      "alert(1)",
      "",
    ])
      expect(parseFormula(bad).ok).toBe(false);
    expect(parseFormula("A / B").ok && parseFormula("A / B")).toMatchObject({
      refs: ["A", "B"],
    });
  });
});

describe("Períodos", () => {
  const now = new Date("2026-09-24T15:00:00Z");
  const tz = "America/Sao_Paulo";
  it("resolve as opções no fuso da empresa", () => {
    expect(resolveRange({ preset: "7d" }, tz, now)).toEqual({
      from: "2026-09-18",
      to: "2026-09-24",
    });
    expect(resolveRange({ preset: "month" }, tz, now)).toEqual({
      from: "2026-09-01",
      to: "2026-09-24",
    });
    expect(resolveRange({ preset: "last_month" }, tz, now)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(resolveRange({ preset: "quarter" }, tz, now)).toEqual({
      from: "2026-07-01",
      to: "2026-09-24",
    });
    expect(resolveRange({ preset: "year" }, tz, now)).toEqual({
      from: "2026-01-01",
      to: "2026-09-24",
    });
    expect(
      resolveRange({ from: "2026-01-05", to: "2026-02-01" }, tz, now),
    ).toEqual({ from: "2026-01-05", to: "2026-02-01" });
  });
  it("de madrugada em UTC ainda é o dia anterior em São Paulo", () => {
    expect(
      resolveRange({ preset: "today" }, tz, new Date("2026-09-25T01:00:00Z")),
    ).toEqual({
      from: "2026-09-24",
      to: "2026-09-24",
    });
  });
});

describe("Séries dos painéis", () => {
  const result = (
    series: PanelResult["series"],
    extra: Partial<PanelResult> = {},
  ): PanelResult => ({
    series,
    previous: {},
    interval: "day",
    computed_at: "",
    ...extra,
  });
  it("fórmula por categoria: calcula, ordena e fica com os N maiores", () => {
    const spec: PanelSpec = {
      viz: "hbar",
      groupBy: "client",
      limit: 2,
      formula: { expr: "A / B", label: "Horas por tarefa" },
      queries: [
        { ref: "A", source: "hours", metric: "hours", filters: [] },
        { ref: "B", source: "tasks", metric: "count", filters: [] },
      ],
    };
    const d = buildDisplay(
      spec,
      result({
        A: [
          { k: "a", l: "Aurora", v: 10 },
          { k: "n", l: "Norte", v: 9 },
          { k: "v", l: "Vértice", v: 1 },
        ],
        B: [
          { k: "a", l: "Aurora", v: 5 },
          { k: "n", l: "Norte", v: 1 },
          { k: "v", l: "Vértice", v: 0 },
        ],
      }),
    );
    expect(d.labels).toEqual(["Norte", "Aurora"]);
    expect(d.series).toHaveLength(1);
    expect(d.series[0]).toMatchObject({
      name: "Horas por tarefa",
      values: [9, 2],
    });
  });
  it("status em palavras, Outros e itens sem valor", () => {
    const d = buildDisplay(
      {
        viz: "donut",
        groupBy: "status",
        queries: [{ ref: "A", source: "tasks", metric: "count", filters: [] }],
      },
      result({
        A: [
          { k: "done", v: 3 },
          { k: "__other__", l: "Outros", v: 1 },
        ],
      }),
    );
    expect(d.labels).toEqual(["Entregue", "Outros"]);
    const p = buildDisplay(
      {
        viz: "bar",
        groupBy: "project",
        queries: [{ ref: "A", source: "tasks", metric: "count", filters: [] }],
      },
      result({ A: [{ k: null, l: null, v: 2 }] }),
    );
    expect(p.labels).toEqual(["Sem projeto"]);
  });
  it("oculta consultas marcadas e compara com o período anterior", () => {
    const d = buildDisplay(
      {
        viz: "stat",
        groupBy: "none",
        compare: true,
        queries: [
          { ref: "A", source: "tasks", metric: "count", filters: [] },
          {
            ref: "B",
            source: "tasks",
            metric: "late",
            filters: [],
            hidden: true,
          },
        ],
      },
      result(
        { A: [{ k: "total", v: 12 }], B: [{ k: "total", v: 3 }] },
        { previous: { A: [{ k: "total", v: 10 }] } },
      ),
    );
    expect(d.series.map((s) => [s.name, s.values[0], s.previous])).toEqual([
      ["Quantidade de tarefas", 12, 10],
    ]);
  });
  it("formata por unidade", () => {
    expect(formatValue(12.5, "hours")).toBe("12,5 h");
    expect(formatValue(1, "days")).toBe("1 dia");
    expect(formatValue(45.14, "percent")).toBe("45,1%");
    expect(formatValue(1234, "number")).toBe("1.234");
    expect(formatValue(null, "number")).toBe("—");
  });
  it("marcas do eixo redondas, com negativos", () => {
    expect(niceTicks(0, 97)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(-12, 30)[0]).toBeLessThanOrEqual(-12);
  });
});

describe("Grade dos painéis", () => {
  const p = (
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Panel => ({
    id,
    title: id,
    x,
    y,
    w,
    h,
    spec: { viz: "stat", groupBy: "none", queries: [] },
  });
  const overlap = (list: Panel[]) =>
    list.some((a, i) =>
      list.some(
        (b, j) =>
          i !== j &&
          a.x < b.x + b.w &&
          b.x < a.x + a.w &&
          a.y < b.y + b.h &&
          b.y < a.y + a.h,
      ),
    );
  it("mover um painel empurra os outros e nada se sobrepõe", () => {
    const moved = placePanel(
      [p("a", 0, 0, 6, 3), p("b", 6, 0, 6, 3), p("c", 0, 3, 12, 4)],
      "c",
      { x: 0, y: 0, w: 12, h: 4 },
    );
    expect(moved.find((x) => x.id === "c")).toMatchObject({ x: 0, y: 0 });
    expect(moved.find((x) => x.id === "a")!.y).toBe(4);
    expect(overlap(moved)).toBe(false);
  });
  it("painéis do mesmo tamanho trocam de lugar", () => {
    const row = [
      p("a", 0, 0, 3, 3),
      p("b", 3, 0, 3, 3),
      p("c", 6, 0, 3, 3),
      p("d", 9, 0, 3, 3),
    ];
    const moved = placePanel(row, "d", { x: 0, y: 0, w: 3, h: 3 });
    expect(moved.map((x) => [x.id, x.x, x.y])).toEqual([
      ["a", 9, 0],
      ["b", 3, 0],
      ["c", 6, 0],
      ["d", 0, 0],
    ]);
  });
  it("redimensionar respeita as 12 colunas e compacta para cima", () => {
    const resized = placePanel([p("a", 8, 0, 4, 3)], "a", {
      x: 8,
      y: 5,
      w: 10,
      h: 1,
    });
    expect(resized[0]).toMatchObject({ x: 2, w: 10, h: 2, y: 5 });
    expect(compact(resized)[0].y).toBe(0);
  });
  it("novo painel vai para o primeiro espaço livre", () => {
    expect(freeSpot([p("a", 0, 0, 6, 3)], 6, 3)).toEqual({
      x: 6,
      y: 0,
      w: 6,
      h: 3,
    });
    expect(freeSpot([p("a", 0, 0, 12, 3)], 4, 3)).toEqual({
      x: 0,
      y: 3,
      w: 4,
      h: 3,
    });
  });
  it("o modelo inicial não tem painéis sobrepostos", () => {
    expect(overlap(starterPanels())).toBe(false);
  });
});

describe("Motor da demonstração", () => {
  // The same fixture as scripts/test-dashboards.mjs.
  const task = (id: string, extra: Partial<Task>): Task =>
    ({
      id,
      company_id: "c",
      contract_id: "k1",
      project_id: null,
      team_id: null,
      parent_id: null,
      title: id,
      description: "",
      status: "progress",
      priority: "normal",
      creator_id: "ana",
      assignee_id: "bia",
      due_date: "2099-01-01",
      original_due_date: "2099-01-01",
      estimated_minutes: 0,
      requires_client_approval: false,
      internal_approved_by: null,
      client_approved_by: null,
      client_approval_note: null,
      delivered_at: null,
      revision: 1,
      version: 1,
      archived: false,
      created_at: "2026-09-02T13:00:00Z",
      ...extra,
    }) as Task;
  const data: Snapshot = {
    ...emptySnapshot,
    clients: [
      {
        id: "aurora",
        company_id: "c",
        name: "Aurora",
        email: "",
        color: "#000",
        archived: false,
      },
      {
        id: "norte",
        company_id: "c",
        name: "Norte",
        email: "",
        color: "#000",
        archived: false,
      },
    ],
    contracts: [
      {
        id: "k1",
        company_id: "c",
        client_id: "aurora",
        product_id: "p",
        name: "",
        archived: false,
      },
      {
        id: "k2",
        company_id: "c",
        client_id: "norte",
        product_id: "p",
        name: "",
        archived: false,
      },
    ],
    tasks: [
      task("t1", {
        status: "done",
        due_date: "2026-09-10",
        delivered_at: "2026-09-09T18:00:00Z",
        created_at: "2026-09-01T13:00:00Z",
        estimated_minutes: 120,
        assignee_id: "ana",
      }),
      task("t2", {
        status: "done",
        due_date: "2026-09-05",
        delivered_at: "2026-09-08T18:00:00Z",
        created_at: "2026-09-03T13:00:00Z",
        estimated_minutes: 60,
      }),
      task("t3", { due_date: "2026-09-02", estimated_minutes: 30 }),
      task("t4", { contract_id: "k2", created_at: "2026-09-15T13:00:00Z" }),
    ],
    hours: [
      {
        id: "h1",
        company_id: "c",
        task_id: "t1",
        user_id: "ana",
        started_at: "2026-09-02T12:00:00Z",
        ended_at: "2026-09-02T14:00:00Z",
        note: "",
        source: "manual",
      },
      {
        id: "h2",
        company_id: "c",
        task_id: "t1",
        user_id: "bia",
        started_at: "2026-09-03T12:00:00Z",
        ended_at: "2026-09-03T12:30:00Z",
        note: "",
        source: "timer",
      },
      {
        id: "h3",
        company_id: "c",
        task_id: "t4",
        user_id: "bia",
        started_at: "2026-09-15T12:00:00Z",
        ended_at: "2026-09-15T13:00:00Z",
        note: "",
        source: "manual",
      },
    ],
  };
  const range = { from: "2026-09-01", to: "2026-09-30" };
  const run = (spec: PanelSpec, filters = {}) =>
    runPanel(
      data,
      spec,
      range,
      filters,
      "America/Sao_Paulo",
      new Date("2026-09-24T15:00:00Z"),
    );
  const q = (
    ref: string,
    source: "tasks" | "hours",
    metric: string,
    extra = {},
  ) => ({ ref, source, metric, filters: [], ...extra });
  it("mesmos totais do banco", () => {
    const r = run({
      viz: "stat",
      groupBy: "none",
      queries: [
        q("A", "tasks", "count"),
        q("B", "tasks", "estimated_hours"),
        q("C", "tasks", "late"),
        q("D", "hours", "hours"),
      ],
    });
    expect([
      r.series.A[0].v,
      r.series.B[0].v,
      r.series.C[0].v,
      r.series.D[0].v,
    ]).toEqual([4, 3.5, 2, 3.5]);
  });
  it("por cliente, com top N e Outros", () => {
    const r = run({
      viz: "hbar",
      groupBy: "client",
      limit: 1,
      queries: [q("A", "tasks", "count")],
    });
    expect(r.series.A).toEqual([
      { k: "aurora", l: "Aurora", v: 3 },
      { k: "__other__", l: "Outros", v: 1 },
    ]);
  });
  it("série diária preenchida e filtro do dashboard", () => {
    const r = run(
      {
        viz: "line",
        groupBy: "time",
        interval: "day",
        queries: [q("A", "hours", "hours")],
      },
      { people: ["bia"] },
    );
    expect(r.series.A).toHaveLength(30);
    expect(r.series.A[2].v).toBe(0.5);
    expect(r.series.A[14].v).toBe(1);
  });
});

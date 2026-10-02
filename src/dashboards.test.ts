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
  socialLeadsPanels,
  performancePanels,
  duePanels,
  noticesPanels,
  groupsFor,
  metricDef,
  panelNotes,
  sources,
  type Panel,
  type PanelResult,
  type PanelSpec,
} from "./dashboards";
import { niceTicks } from "./DashboardCharts";
import { runPanel, runRecords } from "./dashboard-engine";
import { recordsLine } from "./DashboardCanvas";
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
  it("o modelo Social Leads cabe na grade e só usa o catálogo", () => {
    const panels = socialLeadsPanels();
    expect(overlap(panels)).toBe(false);
    for (const p of panels) {
      expect(p.x + p.w).toBeLessThanOrEqual(12);
      for (const q of p.spec.queries) expect(metricDef(q)).toBeTruthy();
      expect(groupsFor(p.spec.queries).map((g) => g.key)).toContain(
        p.spec.groupBy,
      );
    }
    // "Etapa" only makes sense for the clients metric.
    const stage = panels.filter((p) => p.spec.groupBy === "stage");
    expect(
      stage.every((p) => p.spec.queries.every((q) => q.metric === "clients")),
    ).toBe(true);
  });
  it("o modelo de performance cabe na grade e só usa o catálogo", () => {
    const panels = performancePanels();
    expect(overlap(panels)).toBe(false);
    for (const p of panels) {
      expect(p.x + p.w).toBeLessThanOrEqual(12);
      expect(p.spec.queries.length).toBeLessThanOrEqual(5);
      for (const q of p.spec.queries) {
        expect(metricDef(q)).toBeTruthy();
        for (const f of q.filters)
          expect(sources[q.source].filters).toContain(f.field);
      }
      expect(groupsFor(p.spec.queries).map((g) => g.key)).toContain(
        p.spec.groupBy,
      );
    }
  });
  it("o modelo de prazos e previsões cabe na grade e só usa o catálogo", () => {
    const panels = duePanels();
    expect(overlap(panels)).toBe(false);
    for (const p of panels) {
      expect(p.x + p.w).toBeLessThanOrEqual(12);
      for (const q of p.spec.queries) expect(metricDef(q)).toBeTruthy();
      expect(groupsFor(p.spec.queries).map((g) => g.key)).toContain(
        p.spec.groupBy,
      );
    }
  });
  it("o modelo do Mural de avisos cabe na grade e só usa a fonte Avisos", () => {
    const panels = noticesPanels();
    expect(overlap(panels)).toBe(false);
    for (const p of panels) {
      expect(p.x + p.w).toBeLessThanOrEqual(12);
      for (const q of p.spec.queries) {
        expect(q.source).toBe("notices");
        expect(metricDef(q)).toBeTruthy();
      }
      expect(groupsFor(p.spec.queries).map((g) => g.key)).toContain(
        p.spec.groupBy,
      );
    }
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
  it("registros: a barra clicada, Outros e o total conferem com o painel", () => {
    const spec: PanelSpec = {
      viz: "hbar",
      groupBy: "client",
      limit: 1,
      queries: [q("A", "tasks", "count")],
    };
    const records = (selection = {}) =>
      runRecords(data, spec, "A", range, {}, "America/Sao_Paulo", selection, new Date("2026-09-24T15:00:00Z"));
    const aurora = records({ keys: ["aurora"] });
    expect(aurora.value).toBe(3);
    expect(aurora.rows.map((r) => r.id).sort()).toEqual(["t1", "t2", "t3"]);
    expect(aurora.rows[0].client).toBe("Aurora");
    const other = records({ exclude: ["aurora"] });
    expect([other.value, other.rows.map((r) => r.id)]).toEqual([1, ["t4"]]);
    expect(records().total).toBe(4);
  });
  it("registros: horas por lançamento e taxa com 0 e 100", () => {
    const go = (spec: PanelSpec) =>
      runRecords(data, spec, "A", range, {}, "America/Sao_Paulo", {}, new Date("2026-09-24T15:00:00Z"));
    const hours = go({ viz: "stat", groupBy: "none", queries: [q("A", "hours", "hours")] });
    expect(hours.kind).toBe("entry");
    expect(Object.fromEntries(hours.rows.map((r) => [r.id, r.v]))).toEqual({ h1: 2, h2: 0.5, h3: 1 });
    const onTime = go({
      viz: "stat",
      groupBy: "none",
      queries: [q("A", "tasks", "on_time_rate", { dateField: "delivered_at" })],
    });
    expect(onTime.value).toBe(50);
    expect(Object.fromEntries(onTime.rows.map((r) => [r.id, r.v]))).toEqual({ t1: 100, t2: 0 });
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
  it("Equipe são as pessoas da equipe, mesmo sem equipe na tarefa", () => {
    const withTeams: Snapshot = {
      ...data,
      teams: [
        { id: "design", company_id: "c", name: "Design" },
        { id: "midia", company_id: "c", name: "Mídia" },
      ] as Snapshot["teams"],
      teamMembers: [
        { company_id: "c", team_id: "design", user_id: "ana" },
        { company_id: "c", team_id: "midia", user_id: "bia" },
      ],
    };
    const go = (spec: PanelSpec, filters = {}) =>
      runPanel(withTeams, spec, range, filters, "America/Sao_Paulo", new Date("2026-09-24T15:00:00Z"));
    const stat = (filters = {}) =>
      go(
        { viz: "stat", groupBy: "none", queries: [q("A", "tasks", "count"), q("B", "hours", "hours")] },
        filters,
      );
    const design = stat({ teams: ["design"] });
    expect([design.series.A[0].v, design.series.B[0].v]).toEqual([1, 2]);
    const byTeam = go({ viz: "table", groupBy: "team", queries: [q("A", "tasks", "count")] });
    expect(byTeam.series.A).toEqual([
      { k: "midia", l: "Mídia", v: 3 },
      { k: "design", l: "Design", v: 1 },
    ]);
  });
  it("acerto das datas da MAVI e da regra", () => {
    const delivered = (id: string, day: string, rule: string, smart: string) =>
      task(id, {
        status: "done",
        delivered_at: `${day}T18:00:00Z`,
        due_rule_date: rule,
        due_smart_date: smart,
      });
    const r = runPanel(
      {
        ...data,
        tasks: [
          delivered("d1", "2026-09-05", "2026-09-06", "2026-09-05"),
          delivered("d2", "2026-09-09", "2026-09-06", "2026-09-07"),
          delivered("d3", "2026-09-07", "2026-09-08", "2026-09-07"),
          task("d4", { due_tight_reason: "Cliente pediu", created_at: "2026-09-03T12:00:00Z" }),
        ],
      },
      {
        viz: "stat",
        groupBy: "none",
        queries: [
          q("A", "tasks", "smart_hit_rate", { dateField: "delivered_at" }),
          q("B", "tasks", "rule_hit_rate", { dateField: "delivered_at" }),
          q("C", "tasks", "smart_error_days", { dateField: "delivered_at" }),
          q("D", "tasks", "tight_due"),
        ],
      },
      range,
      {},
      "America/Sao_Paulo",
      new Date("2026-09-24T15:00:00Z"),
    );
    expect(Math.round(r.series.A[0].v!)).toBe(67);
    expect(Math.round(r.series.B[0].v!)).toBe(67);
    expect(r.series.C[0].v).toBeCloseTo(0.67, 2);
    expect(r.series.D[0].v).toBe(1);
  });
  it("qualidade das entregas, por quem executou", () => {
    const r = run({
      viz: "table",
      groupBy: "executor",
      queries: [
        q("A", "tasks", "on_time_rate", { dateField: "delivered_at" }),
        q("B", "tasks", "delay_days", { dateField: "delivered_at" }),
        q("C", "tasks", "first_pass_rate", { dateField: "delivered_at" }),
      ],
    });
    // t1 (ana) no prazo; t2 (bia) 3 dias atrasada.
    expect(r.series.A).toEqual([
      { k: "ana", l: null, v: 100 },
      { k: "bia", l: null, v: 0 },
    ]);
    expect(r.series.B.find((x) => x.k === "bia")?.v).toBe(3);
    expect(r.series.C.every((x) => x.v === 100)).toBe(true);
  });
});

describe("Pessoa nos painéis", () => {
  const q = (ref: string, source: PanelSpec["queries"][number]["source"], metric: string, extra = {}) => ({
    ref,
    source,
    metric,
    filters: [],
    ...extra,
  });
  it("explica o que cada consulta conta, sem repetir", () => {
    const notes = panelNotes({
      viz: "table",
      groupBy: "person",
      queries: [
        q("A", "tasks", "count", { label: "Tarefas" }),
        q("B", "tasks", "late", { label: "Atrasadas" }),
        q("C", "hours", "hours", { label: "Horas registradas" }),
      ],
    });
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/^Tarefas: Conta para todos que executaram/);
    expect(notes[1]).toMatch(/^Atrasadas: .*quando o prazo venceu/);
    expect(notes[2]).toMatch(/de quem registrou/);
  });
  it("por equipe explica que a equipe são as pessoas dela", () => {
    const [note] = panelNotes({
      viz: "hbar",
      groupBy: "team",
      queries: [q("A", "tasks", "count")],
    });
    expect(note).toMatch(/entregues direto a alguém/);
    expect(
      panelNotes({ viz: "hbar", groupBy: "team", queries: [q("A", "temperature", "score")] }),
    ).toEqual([]);
  });
  it("responsável atual avisa que em validação é quem valida", () => {
    const [note] = panelNotes({
      viz: "table",
      groupBy: "person",
      queries: [q("A", "tasks", "count", { attribution: "assignee" })],
    });
    expect(note).toMatch(/Em validação, é quem valida/);
  });
  it("tempo no status nunca passa por horas trabalhadas", () => {
    const notes = panelNotes({
      viz: "stat",
      groupBy: "none",
      queries: [q("A", "status_history", "hours")],
    });
    expect(notes[0]).toMatch(/não horas trabalhadas/);
    expect(
      panelNotes({ viz: "stat", groupBy: "none", queries: [q("A", "tasks", "count")] }),
    ).toEqual([]);
  });
  it("o modelo inicial e o de performance explicam os painéis por pessoa", () => {
    for (const p of [...starterPanels(), ...performancePanels()])
      if (p.spec.groupBy === "person") expect(panelNotes(p.spec).length).toBeGreaterThan(0);
  });
});

describe("registros abaixo do painel", () => {
  const p = (id: string, x: number, y: number, w: number, h: number): Panel => ({
    id,
    title: id,
    x,
    y,
    w,
    h,
    spec: { viz: "stat", groupBy: "none", queries: [] },
  });
  it("vão para a primeira linha que nenhum painel atravessa", () => {
    const panels = [p("a", 0, 0, 6, 3), p("b", 6, 0, 6, 5), p("c", 0, 3, 6, 4), p("d", 0, 7, 12, 3)];
    expect(recordsLine(panels, "a")).toBe(7);
    expect(recordsLine(panels, "b")).toBe(7);
    expect(recordsLine(panels, "d")).toBe(10);
    expect(recordsLine(panels, "x")).toBeNull();
  });
});

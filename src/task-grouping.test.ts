import { describe, it, expect, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: null }));
const { demoSnapshot } = await import("./demo");
const { buildNameLookup } = await import("./domain");
const {
  groupTasks,
  groupHint,
  groupOrder,
  groupSummary,
  nestSubtasks,
  normalizeViewConfig,
  sameViewConfig,
  withSubgroups,
} = await import("./task-grouping");
const { DemoStore } = await import("./demo-store");
const { demoUser } = await import("./demo");
const { appliedMessage, describeChange, dayLabel, sides, undoMessage } =
  await import("./task-bulk");
import type { Task } from "./types";

const data = demoSnapshot();
const lookup = buildNameLookup(data);
const ctx = { lookup, today: "2026-09-28", timezone: "America/Sao_Paulo" };
const [contractA, contractB] = data.contracts;
const task = (over: Partial<Task>): Task => ({
  ...data.tasks[0],
  parent_id: null,
  status: "progress",
  estimated_minutes: 60,
  due_date: "2026-09-30",
  created_at: "2026-09-24T13:00:00Z",
  ...over,
});

describe("Agrupar a lista de tarefas", () => {
  it("junta em pacotes o que foi criado para o mesmo cliente no mesmo dia", () => {
    const tasks = [
      task({ id: "a", contract_id: contractA.id }),
      task({ id: "b", contract_id: contractA.id, created_at: "2026-09-24T22:00:00Z" }),
      // 23h30 em São Paulo ainda é dia 24, mesmo já sendo 25 em UTC.
      task({ id: "c", contract_id: contractA.id, created_at: "2026-09-25T02:30:00Z" }),
      task({ id: "d", contract_id: contractA.id, created_at: "2026-09-26T12:00:00Z" }),
      task({ id: "e", contract_id: contractB.id }),
    ];
    const groups = groupTasks(tasks, "pack", ctx);
    const clientA = lookup.clients.get(contractA.client_id)!.name;
    // Os pacotes mais novos vêm primeiro.
    expect(groups[0].label).toBe(`${clientA} · 26/09`);
    const day24 = groups.find((g) => g.label === `${clientA} · 24/09`)!;
    expect(day24.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(groups).toHaveLength(contractA.client_id === contractB.client_id ? 2 : 3);
  });

  it("separa por prazo: atrasadas, hoje, esta semana, próxima e mais tarde", () => {
    const tasks = [
      task({ id: "late", due_date: "2026-09-25" }),
      task({ id: "today", due_date: "2026-09-28" }),
      task({ id: "week", due_date: "2026-10-02" }),
      task({ id: "next", due_date: "2026-10-09" }),
      task({ id: "later", due_date: "2026-11-01" }),
      task({ id: "done-late", due_date: "2026-09-20", status: "done" }),
    ];
    const groups = groupTasks(tasks, "due", ctx);
    expect(groups.map((g) => g.label)).toEqual([
      "Atrasadas",
      "Hoje",
      "Esta semana (até 04/10)",
      "Próxima semana (05/10 a 11/10)",
      "Mais tarde",
    ]);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["late"]);
  });

  it("mostra no cabeçalho as horas estimadas (as atrasadas têm selo próprio)", () => {
    expect(
      groupHint(
        [
          task({ due_date: "2026-09-20", estimated_minutes: 90 }),
          task({ estimated_minutes: 30 }),
        ],
        "2026-09-28",
      ),
    ).toBe("2h estimadas");
    expect(groupHint([task({ estimated_minutes: 0 })], "2026-09-28")).toBe("");
  });

  it("resume o grupo fechado: status, prazos em aberto e pessoas", () => {
    const s = groupSummary(
      [
        task({ status: "review", due_date: "2026-09-20", assignee_id: "b", creator_id: "x" }),
        task({ status: "progress", due_date: "2026-10-04", assignee_id: "a", creator_id: "x" }),
        task({ status: "progress", due_date: "2026-09-30", assignee_id: "a", creator_id: "y" }),
        task({ status: "done", due_date: "2026-09-01", assignee_id: "c", creator_id: "x" }),
      ],
      "2026-09-28",
    );
    expect(s.late).toBe(1);
    expect(s.statuses).toEqual([
      ["progress", 2],
      ["review", 1],
      ["done", 1],
    ]);
    // The done task's date does not count.
    expect([s.firstDue, s.lastDue]).toEqual(["2026-09-20", "2026-10-04"]);
    expect(s.assignees).toEqual(["a", "b", "c"]);
    expect(s.creators).toEqual(["x", "y"]);
  });

  it("monta o segundo nível dentro de cada seção", () => {
    const tasks = [
      task({ id: "a", status: "progress" }),
      task({ id: "b", status: "review" }),
      task({ id: "c", status: "progress" }),
    ];
    const [only] = withSubgroups(groupTasks(tasks, "client", ctx), "status", ctx);
    expect(only.children?.map((g) => [g.label, g.tasks.length])).toEqual([
      ["Em andamento", 2],
      ["Em validação", 1],
    ]);
    expect(only.children?.[0].key.startsWith(`${only.key}>`)).toBe(true);
  });

  it("põe subtarefas logo abaixo da principal quando estão na mesma seção", () => {
    const nodes = nestSubtasks([
      task({ id: "main" }),
      task({ id: "sub1", parent_id: "main" }),
      task({ id: "alone" }),
      task({ id: "sub2", parent_id: "main" }),
      task({ id: "orphan", parent_id: "elsewhere" }),
    ]);
    expect(nodes.map((n) => [n.task.id, n.children.map((c) => c.id), n.parentElsewhere])).toEqual([
      ["main", ["sub1", "sub2"], null],
      ["alone", [], null],
      ["orphan", [], "elsewhere"],
    ]);
  });

  it("pede ao servidor a ordem que mantém as seções inteiras na página", () => {
    expect(groupOrder("pack")).toBe("created");
    expect(groupOrder("assignee")).toBe("assignee");
    expect(groupOrder("due")).toBe("due");
    expect(groupOrder("auto")).toBe("due");
  });
});

describe("Visões salvas", () => {
  it("compara só o que difere do padrão", () => {
    expect(
      normalizeViewConfig({ group: "auto", then: "none", view: "list", status: "", late: false }),
    ).toEqual({});
    expect(
      sameViewConfig({ group: "pack", late: true }, { group: "pack", then: "none", late: true, view: "list" }),
    ).toBe(true);
    expect(sameViewConfig({ group: "pack" }, { group: "client" })).toBe(false);
  });
});

describe("Alteração em massa (demonstração)", () => {
  const member = (store: InstanceType<typeof DemoStore>, id: string) =>
    store.data.members.find((m) => m.user_id === id)?.name ?? "—";

  it("a revisão mostra o resultado sem mudar nada", () => {
    const store = new DemoStore();
    const other = store.data.members.find((m) => m.user_id !== demoUser && m.active)!;
    const mine = store.data.tasks.filter((t) => t.status !== "done").slice(0, 3);
    const before = structuredClone(store.data.tasks);
    const r = store.bulk(
      mine.map((t) => t.id),
      { kind: "assignee", value: other.user_id },
      true,
    );
    expect(r.preview).toBe(true);
    expect(r.results).toHaveLength(3);
    expect(store.data.tasks).toEqual(before);
  });

  it("adia o prazo em dias úteis sem mexer em status nem aprovações, e desfaz", () => {
    const store = new DemoStore();
    const t = store.data.tasks.find((x) => x.status !== "done")!;
    t.creator_id = demoUser;
    t.due_date = "2026-10-02"; // sexta-feira
    t.start_date = null;
    const status = t.status;
    const r = store.bulk([t.id], { kind: "shift", value: 1 }, false);
    expect(r.applied).toBe(1);
    const after = store.data.tasks.find((x) => x.id === t.id)!;
    expect(after.due_date).toBe("2026-10-05"); // pula o fim de semana
    expect(after.status).toBe(status);
    const s = sides(r.results[0], { kind: "shift", value: 1 }, (id) => member(store, id));
    expect(s).toEqual({ before: "02/10 (sex)", after: "05/10 (seg)" });
    const undo = store.undoBulk(r.operation!);
    expect(undo).toEqual({ restored: 1, kept: 0 });
    expect(store.data.tasks.find((x) => x.id === t.id)!.due_date).toBe("2026-10-02");
  });

  it("deixa de fora o que não pode mudar, com o motivo", () => {
    const store = new DemoStore();
    const t = store.data.tasks.find((x) => x.status !== "done")!;
    t.creator_id = demoUser;
    t.start_date = "2026-10-10";
    t.due_date = "2026-10-12";
    const r = store.bulk([t.id], { kind: "due", value: "2026-10-05" }, false);
    expect(r.applied).toBe(0);
    expect(r.results[0].reason).toBe("O prazo ficaria antes do início (10/10)");
    expect(r.operation).toBeNull();
  });

  it("não desfaz a tarefa que alguém mexeu depois do lote", () => {
    const store = new DemoStore();
    const t = store.data.tasks.find((x) => x.status !== "done")!;
    t.creator_id = demoUser;
    t.start_date = null;
    const r = store.bulk([t.id], { kind: "shift", value: 2 }, false);
    store.data.tasks.find((x) => x.id === t.id)!.version++;
    expect(store.undoBulk(r.operation!)).toEqual({ restored: 0, kept: 1 });
  });
});

describe("Textos da alteração em massa", () => {
  it("descreve a mudança e o resultado", () => {
    const names = { member: () => "Ana Souza", team: () => "Criação" };
    expect(describeChange({ kind: "shift", value: -1 }, names)).toBe(
      "Antecipar o prazo em 1 dia útil, a partir do prazo de cada tarefa.",
    );
    expect(describeChange({ kind: "assignee", value: "x" }, names)).toBe(
      "Trocar o responsável para Ana Souza.",
    );
    expect(dayLabel("2026-09-30")).toBe("30/09 (qua)");
    expect(
      appliedMessage({
        preview: false,
        applied: 12,
        results: Array.from({ length: 14 }, (_, i) => ({ id: String(i), ok: i < 12, reason: null })),
      }),
    ).toBe("12 tarefas alteradas · 2 ficaram de fora");
    expect(undoMessage({ restored: 3, kept: 1 })).toBe(
      "3 tarefas voltaram ao que era. 1 foi mexida depois e ficou como está.",
    );
  });
});

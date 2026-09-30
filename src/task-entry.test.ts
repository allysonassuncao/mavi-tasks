import { describe, expect, it } from "vitest";
import { DemoStore } from "./demo-store";
import { demoUser } from "./demo";
import { runPanel } from "./dashboard-engine";
import {
  canChangeEntry,
  enteredAt,
  entryDateError,
  entryDay,
  latestEntry,
} from "./task-entry";
import type { Snapshot, Task } from "./types";

const tz = "America/Sao_Paulo";
const base = {
  created_at: "2026-10-10T15:00:00.000Z", // 12h em Brasília
  entered_at: null,
  due_date: "2026-10-20",
  delivered_at: null,
};

describe("data de entrada da tarefa", () => {
  it("sem ajuste, é o dia da criação no fuso da empresa", () => {
    expect(entryDay({ created_at: "2026-10-11T01:30:00.000Z" }, tz)).toBe("2026-10-10");
    expect(entryDay({ ...base, entered_at: "2026-10-08T15:00:00.000Z" }, tz)).toBe("2026-10-08");
  });

  it("o novo dia guarda a hora da criação; voltar ao dia da criação limpa", () => {
    expect(enteredAt(base.created_at, "2026-10-08", tz)).toBe("2026-10-08T15:00:00.000Z");
    expect(enteredAt(base.created_at, "2026-10-10", tz)).toBeNull();
  });

  it("recusa como o banco: mesma data, depois do prazo ou da entrega, mais de 1 ano antes, sem motivo", () => {
    const reason = "O cliente pediu antes";
    expect(entryDateError(base, "2026-10-10", reason, tz)).toMatch(/já está/);
    expect(entryDateError(base, "2026-10-21", reason, tz)).toMatch(/prazo \(20\/10\/2026\)/);
    const done = { ...base, delivered_at: "2026-10-12T18:00:00.000Z" };
    expect(entryDateError(done, "2026-10-13", reason, tz)).toMatch(/entrega \(12\/10\/2026\)/);
    expect(latestEntry(done, tz)).toBe("2026-10-12");
    expect(entryDateError(base, "2025-10-09", reason, tz)).toMatch(/1 ano/);
    expect(entryDateError(base, "2026-10-08", " ok ", tz)).toMatch(/motivo/);
    expect(entryDateError(base, "2026-10-08", reason, tz)).toBe("");
  });

  it("quem pode: criador, responsável, participante, supervisor da equipe do responsável e líderes", () => {
    const member = (user_id: string, role = "member") => ({
      user_id,
      role,
      active: true,
      name: user_id,
    });
    const data = {
      members: ["eva", "bia", "duda", "sara", "caio", "zeca"].map((u) => member(u)).concat([
        member("gil", "manager"),
        member("ana", "admin"),
      ]),
      teamMembers: [
        { company_id: "c", team_id: "design", user_id: "bia" },
        { company_id: "c", team_id: "design", user_id: "sara", supervisor: true },
        { company_id: "c", team_id: "vendas", user_id: "caio", supervisor: true },
      ],
    } as unknown as Snapshot;
    const task = {
      creator_id: "eva",
      assignee_id: "bia",
      participant_ids: ["bia", "duda"],
    } as Task;
    for (const u of ["eva", "bia", "duda", "sara", "gil", "ana"])
      expect(canChangeEntry(data, task, u), u).toBe(true);
    for (const u of ["caio", "zeca", "fora"]) expect(canChangeEntry(data, task, u), u).toBe(false);
  });

  it("na demonstração: muda a data, registra o motivo no histórico e conta nos Dashboards", () => {
    const store = new DemoStore();
    const task = store.data.tasks.find(
      (t) => t.creator_id === demoUser && !t.archived && t.status !== "done",
    )!;
    const day = entryDay(task, tz);
    const earlier = new Date(Date.parse(`${day}T12:00:00Z`) - 2 * 86400000)
      .toISOString()
      .slice(0, 10);
    expect(() =>
      store.mutate("set_task_entry_date", {
        p_task: task.id,
        p_version: task.version,
        p_date: earlier,
        p_reason: "",
      }),
    ).toThrow(/motivo/);
    const version = task.version;
    store.mutate("set_task_entry_date", {
      p_task: task.id,
      p_version: version,
      p_date: earlier,
      p_reason: "Pedido chegou por e-mail antes",
    });
    expect(task.version).toBe(version + 1);
    expect(entryDay(task, tz)).toBe(earlier);
    const e = store.events.find((x) => x.task_id === task.id && x.action === "entry_changed")!;
    expect(e.detail).toMatchObject({ old_entry: day, new_entry: earlier, reason: "Pedido chegou por e-mail antes" });
    const result = runPanel(
      store.data,
      {
        viz: "stat",
        groupBy: "none",
        queries: [
          { ref: "A", source: "tasks", metric: "entry_adjusted", dateField: "entered_at", filters: [] },
        ],
      },
      { from: earlier, to: earlier },
      {},
      tz,
    );
    expect(result.series.A[0].v).toBeGreaterThanOrEqual(1);
  });
});

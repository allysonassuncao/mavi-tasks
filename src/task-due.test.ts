import { describe, expect, it } from "vitest";
import { DemoStore } from "./demo-store";
import { demoUser } from "./demo";
import { canChangeDue, dueChangeError, dueReasonError } from "./task-due";
import type { Snapshot, Task } from "./types";

describe("mudança de prazo com motivo", () => {
  it("recusa como o banco: mesma data, antes do início, sem motivo", () => {
    const task = { due_date: "2026-10-20", start_date: "2026-10-15" };
    const reason = "Cliente pediu mais tempo";
    expect(dueChangeError(task, "2026-10-20", reason)).toMatch(/já tem esse prazo/);
    expect(dueChangeError(task, "2026-10-14", reason)).toMatch(/início planejado \(15\/10\/2026\)/);
    expect(dueChangeError(task, "2026-10-22", " ok ")).toMatch(/motivo/);
    expect(dueChangeError(task, "2026-10-22", reason)).toBe("");
    expect(dueReasonError("x".repeat(1001))).toMatch(/1000/);
  });

  it("quem pode: criador, responsável, participante, supervisor da equipe do responsável e líderes", () => {
    const member = (user_id: string, role = "member") => ({ user_id, role, active: true, name: user_id });
    const data = {
      members: ["eva", "bia", "duda", "sara", "caio", "zeca"]
        .map((u) => member(u))
        .concat([member("gil", "manager"), member("ana", "admin")]),
      teamMembers: [
        { company_id: "c", team_id: "design", user_id: "bia" },
        { company_id: "c", team_id: "design", user_id: "sara", supervisor: true },
        { company_id: "c", team_id: "vendas", user_id: "caio", supervisor: true },
      ],
    } as unknown as Snapshot;
    const task = { creator_id: "eva", assignee_id: "bia", participant_ids: ["bia", "duda"] } as Task;
    for (const u of ["eva", "bia", "duda", "sara", "gil", "ana"]) expect(canChangeDue(data, task, u), u).toBe(true);
    for (const u of ["caio", "zeca", "fora"]) expect(canChangeDue(data, task, u), u).toBe(false);
  });

  it("na demonstração: só a data muda, com o motivo no histórico", () => {
    const store = new DemoStore();
    const task = store.data.tasks.find(
      (t) => t.creator_id === demoUser && !t.archived && t.status !== "done" && !t.start_date,
    )!;
    const status = task.status;
    const next = new Date(Date.parse(`${task.due_date}T12:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
    const args = { p_task: task.id, p_version: task.version, p_due: next, p_reason: "" };
    expect(() => store.mutate("set_task_due", args)).toThrow(/motivo/);
    const old = task.due_date;
    store.mutate("set_task_due", { ...args, p_reason: "Cliente atrasou o material" });
    expect(task.due_date).toBe(next);
    expect(task.status).toBe(status);
    expect(task.due_manual).toBe(true);
    const e = store.events.find((x) => x.task_id === task.id && x.action === "due_changed")!;
    expect(e.detail).toMatchObject({ old_due: old, new_due: next, reason: "Cliente atrasou o material", source: "task" });
  });

  it("na demonstração: Editar e em massa também pedem o motivo", () => {
    const store = new DemoStore();
    const task = store.data.tasks.find(
      (t) => t.creator_id === demoUser && !t.archived && t.status !== "done" && !t.start_date,
    )!;
    const next = new Date(Date.parse(`${task.due_date}T12:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
    const edit = (reason: string | null) =>
      store.mutate("update_task", {
        p_task: task.id,
        p_version: task.version,
        p_title: task.title,
        p_description: task.description,
        p_due: next,
        p_estimated: task.estimated_minutes,
        p_priority: task.priority,
        p_due_reason: reason,
      });
    expect(() => edit(null)).toThrow(/motivo/);
    expect(task.due_date).not.toBe(next);
    edit("Escopo aumentou");
    expect(task.due_date).toBe(next);
    expect(() => store.bulk([task.id], { kind: "shift", value: 1, reason: "" }, false)).toThrow(/motivo/);
    const r = store.bulk([task.id], { kind: "shift", value: 1, reason: "Feriado local" }, false);
    expect(r.applied).toBe(1);
    const sources = store.events
      .filter((x) => x.task_id === task.id && x.action === "due_changed")
      .map((x) => x.detail.source);
    expect(sources).toEqual(["bulk", "edit"]);
  });
});

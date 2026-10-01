import { describe, expect, it } from "vitest";
import { demoSnapshot } from "./demo";
import { compareTasks } from "./task-grouping";
import { describeChange, sides } from "./task-bulk";
import {
  canChangePriority,
  canPrioritize,
  canPrioritizeTeam,
  canSetPriority,
  isPrioritized,
  priorityBlock,
  priorityWeight,
} from "./task-priority";
import type { Snapshot, Task } from "./types";

// Lucas and Júlia are members, Marina a manager, Allyson an admin; Pedro
// supervises team-3, where Lucas is.
const demo = demoSnapshot();
const data: Snapshot = {
  ...demo,
  members: [
    ...demo.members,
    {
      ...demo.members.find((m) => m.user_id === "user-lucas")!,
      user_id: "user-pedro",
      name: "Pedro",
    },
  ],
  teamMembers: [
    { company_id: demo.tasks[0].company_id, team_id: "team-3", user_id: "user-pedro", supervisor: true },
    { company_id: demo.tasks[0].company_id, team_id: "team-3", user_id: "user-lucas", supervisor: false },
    { company_id: demo.tasks[0].company_id, team_id: "team-1", user_id: "user-julia", supervisor: false },
  ],
};
const task = (extra: Partial<Task> = {}): Task => ({
  ...demo.tasks[0],
  creator_id: "user-julia",
  assignee_id: "user-lucas",
  priority: "normal",
  ...extra,
});

describe("Quem dá ou tira Alta/Urgente", () => {
  it("administrador, gestor e o supervisor da equipe do responsável", () => {
    for (const u of ["user-allyson", "user-marina", "user-pedro"])
      expect(canPrioritize(data, "user-lucas", u)).toBe(true);
  });
  it("não a criadora colaboradora, nem o próprio responsável", () => {
    expect(canPrioritize(data, "user-lucas", "user-julia")).toBe(false);
    expect(canPrioritize(data, "user-lucas", "user-lucas")).toBe(false);
  });
  it("o supervisor não vale para quem é de outra equipe", () => {
    expect(canPrioritize(data, "user-julia", "user-pedro")).toBe(false);
  });
  it("para a equipe: o supervisor dela", () => {
    expect(canPrioritizeTeam(data, "team-3", "user-pedro")).toBe(true);
    expect(canPrioritizeTeam(data, "team-1", "user-pedro")).toBe(false);
    expect(canPrioritizeTeam(data, "team-1", "user-marina")).toBe(true);
    expect(canPrioritizeTeam(data, "", "user-pedro")).toBe(false);
  });
});

describe("Mudar a prioridade de uma tarefa", () => {
  it("Baixa ↔ Normal com quem edita (criadora); Alta não", () => {
    const t = task();
    expect(canSetPriority(data, t, "low", "user-julia")).toBe(true);
    expect(canSetPriority(data, t, "high", "user-julia")).toBe(false);
    expect(priorityBlock(data, t, "urgent", "user-julia")).toMatch(/Só administradores/);
  });
  it("tirar a Alta também é só de quem pode marcar", () => {
    const t = task({ priority: "high" });
    expect(canSetPriority(data, t, "normal", "user-julia")).toBe(false);
    expect(canSetPriority(data, t, "normal", "user-pedro")).toBe(true);
    expect(canChangePriority(data, t, "user-julia")).toBe(false);
  });
  it("o responsável que não edita a tarefa não muda nada", () => {
    expect(canChangePriority(data, task(), "user-lucas")).toBe(false);
  });
  it("o supervisor muda mesmo sem editar a tarefa", () => {
    expect(canChangePriority(data, task(), "user-pedro")).toBe(true);
  });
});

describe("Destaque e ordem", () => {
  it("Alta e Urgente são prioritárias, com peso 1 e 2", () => {
    expect(["low", "normal", "high", "urgent"].map(priorityWeight)).toEqual([0, 0, 1, 2]);
    expect(isPrioritized("high")).toBe(true);
    expect(isPrioritized("normal")).toBe(false);
  });
  it("as prioritárias sobem ao topo, depois o Ordenar por", () => {
    const list = [
      task({ id: "a", due_date: "2026-10-01", priority: "normal" }),
      task({ id: "b", due_date: "2026-10-09", priority: "high" }),
      task({ id: "c", due_date: "2026-10-05", priority: "urgent" }),
      task({ id: "d", due_date: "2026-10-03", priority: "high" }),
      task({ id: "e", due_date: "2026-09-30", priority: "low" }),
    ];
    expect([...list].sort(compareTasks("due")).map((t) => t.id)).toEqual(["c", "d", "b", "e", "a"]);
    // Relevância: depois das prioritárias, a ordem em que vieram.
    expect([...list].sort(compareTasks("relevance")).map((t) => t.id)).toEqual(["c", "b", "d", "a", "e"]);
  });
});

describe("Prioridade em massa", () => {
  const names = { member: () => "", team: () => "" };
  it("descreve a mudança e mostra antes → depois", () => {
    expect(describeChange({ kind: "priority", value: "urgent" }, names)).toMatch(
      /Mudar a prioridade para Urgente/,
    );
    const side = { status: "progress" as const, assignee_id: "x", due_date: "2026-10-01" };
    expect(
      sides(
        { id: "1", ok: true, reason: null, before: { ...side, priority: "normal" }, after: { ...side, priority: "high" } },
        { kind: "priority", value: "high" },
        () => "",
      ),
    ).toEqual({ before: "Normal", after: "Alta" });
  });
});

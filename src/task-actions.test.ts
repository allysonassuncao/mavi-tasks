import { describe, it, expect } from "vitest";
import { taskActions, REOPEN_WINDOW_MS } from "./domain";
import { demoSnapshot } from "./demo";
import type { Snapshot, Status, Task } from "./types";

// Lucas and Júlia are members, Marina a manager, Allyson an admin.
const data: Snapshot = demoSnapshot();
const base = data.tasks.find(
  (t) =>
    t.project_id &&
    data.projects.find((p) => p.id === t.project_id)?.requires_review,
)!;
const project = data.projects.find((p) => p.id === base.project_id)!;
project.approver = "creator";
const task = (status: Status, extra: Partial<Task> = {}): Task => ({
  ...base,
  status,
  creator_id: "user-julia",
  assignee_id: "user-lucas",
  internal_approved_by: null,
  client_approved_by: null,
  requires_client_approval: false,
  delivered_at: null,
  ...extra,
});
const as = (user: string, t: Task, now?: number) =>
  taskActions(data, t, user, now);

describe("Mudar status e responsável", () => {
  it("é do responsável atual, do criador e dos gestores", () => {
    for (const u of ["user-lucas", "user-julia", "user-marina", "user-allyson"])
      expect(as(u, task("progress")).move).toBe(true);
  });
  it("vale para qualquer status ativo, sem ordem fixa", () => {
    for (const s of [
      "open",
      "progress",
      "returned",
      "review",
      "rejected",
    ] as Status[])
      expect(as("user-lucas", task(s)).move).toBe(true);
  });
  it("quem só já foi responsável não muda o status", () => {
    const other = task("progress", {
      assignee_id: "user-julia",
      creator_id: "user-allyson",
    });
    expect(as("user-lucas", other).move).toBe(false);
  });
  it("tarefa entregue só sai pela reabertura", () => {
    expect(as("user-lucas", task("done")).move).toBe(false);
  });
});

describe("Entrega", () => {
  it("com validação no projeto, não é feita pelo menu de status", () => {
    expect(as("user-lucas", task("progress")).deliver).toBe(false);
  });
  it("sem validação, quem move a tarefa também entrega", () => {
    project.requires_review = false;
    expect(as("user-lucas", task("progress")).deliver).toBe(true);
    project.requires_review = true;
  });
});

describe("Validação", () => {
  it("aprovação do cliente só depois da aprovação interna", () => {
    const pending = task("review", { requires_client_approval: true });
    expect(as("user-julia", pending).approveClient).toBe(false);
    expect(as("user-julia", pending).approveInternal).toBe(true);
    const approved = { ...pending, internal_approved_by: "user-julia" };
    expect(as("user-julia", approved).approveClient).toBe(true);
    expect(as("user-julia", approved).approveInternal).toBe(false);
  });
  it("só o validador aprova", () => {
    expect(as("user-lucas", task("review")).approveInternal).toBe(false);
    expect(as("user-julia", task("review")).approveInternal).toBe(true);
  });
});

describe("Reabrir tarefa", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const delivered = (ms: number) =>
    task("done", { delivered_at: new Date(now - ms).toISOString() });
  it("só em tarefas entregues, dentro de 2 dias", () => {
    expect(as("user-julia", delivered(60_000), now).reopen).toBe(true);
    expect(as("user-lucas", delivered(60_000), now).reopen).toBe(true);
    expect(
      as("user-julia", delivered(REOPEN_WINDOW_MS), now).reopen,
    ).toHaveProperty("blocked");
    expect(as("user-julia", task("progress"), now).reopen).toBe(false);
  });
  it("o administrador reabre a qualquer momento", () => {
    expect(
      as("user-allyson", delivered(REOPEN_WINDOW_MS * 5), now).reopen,
    ).toBe(true);
  });
  it("gestor que não criou nem valida a tarefa não reabre", () => {
    expect(as("user-marina", delivered(60_000), now).reopen).toBe(false);
  });
});

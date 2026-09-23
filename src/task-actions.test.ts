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

describe("Enviar para validação", () => {
  it("é do responsável (ou do administrador), não do criador", () => {
    expect(as("user-lucas", task("progress")).submit).toBe(true);
    expect(as("user-allyson", task("progress")).submit).toBe(true);
    expect(as("user-julia", task("progress")).submit).toBe(false);
    expect(as("user-marina", task("progress")).submit).toBe(false);
  });
  it("fica desabilitado em validação e oculto quando devolvida, reprovada ou entregue", () => {
    expect(as("user-lucas", task("review")).submit).toEqual({
      blocked: "Em validação…",
    });
    for (const s of ["returned", "rejected", "done"] as Status[])
      expect(as("user-lucas", task(s)).submit).toBe(false);
  });
});

describe("Devolver ao criador", () => {
  it("o responsável devolve tarefas abertas, em andamento ou reprovadas", () => {
    for (const s of ["open", "progress", "rejected"] as Status[])
      expect(as("user-lucas", task(s)).return).toBe(true);
    expect(as("user-lucas", task("review")).return).toBe(false);
  });
  it("o criador nunca devolve, nem sendo também o responsável", () => {
    expect(as("user-julia", task("progress")).return).toBe(false);
    expect(
      as("user-lucas", task("progress", { creator_id: "user-lucas" })).return,
    ).toBe(false);
  });
  it("o administrador também devolve tarefas em validação", () => {
    expect(as("user-allyson", task("review")).return).toBe(true);
  });
  it("aparece desabilitado quando a tarefa já foi devolvida", () => {
    expect(as("user-lucas", task("returned")).return).toEqual({
      blocked: "Devolvida…",
    });
  });
});

describe("Tarefa devolvida", () => {
  it("volta à execução pelo criador ou administrador", () => {
    expect(as("user-julia", task("returned")).resend).toBe(true);
    expect(as("user-allyson", task("returned")).resend).toBe(true);
    expect(as("user-lucas", task("returned")).resend).toBe(false);
    expect(as("user-julia", task("returned")).start).toBe(false);
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
  it("só o validador aprova ou reprova", () => {
    expect(as("user-lucas", task("review")).reject).toBe(false);
    expect(as("user-julia", task("review")).reject).toBe(true);
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

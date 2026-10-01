import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskTable, runningOn, type Playing } from "./TaskTable";
import { canTimeTask } from "./domain";
import type { NameLookup } from "./domain";
import type { Task, TimeEntry } from "./types";

const me = "u1";
const task = (id: string, extra: Partial<Task> = {}) =>
  ({
    id,
    company_id: "c1",
    contract_id: "k1",
    project_id: null,
    team_id: null,
    parent_id: null,
    title: `Tarefa ${id}`,
    description: "",
    status: "progress",
    priority: "normal",
    creator_id: "u2",
    assignee_id: me,
    due_date: "2026-10-10",
    original_due_date: "2026-10-10",
    estimated_minutes: 0,
    requires_client_approval: false,
    internal_approved_by: null,
    client_approved_by: null,
    client_approval_note: null,
    delivered_at: null,
    ...extra,
  }) as Task;
const entry = (taskId: string, started: string) =>
  ({
    id: `e-${taskId}`,
    company_id: "c1",
    task_id: taskId,
    user_id: me,
    started_at: started,
    ended_at: null,
    note: "",
    source: "timer",
  }) as TimeEntry;
const lookup: NameLookup = {
  contracts: new Map(),
  clients: new Map(),
  products: new Map(),
  projects: new Map(),
  members: new Map(),
};
const render = (tasks: Task[], playing: Playing | null, withTimer = true) =>
  renderToStaticMarkup(
    <TaskTable
      tasks={tasks}
      me={me}
      lookup={lookup}
      today="2026-10-01"
      playing={playing}
      onSelect={() => {}}
      timer={
        withTimer
          ? { canStart: (t) => canTimeTask(t, me), toggle: () => {} }
          : undefined
      }
    />,
  );

describe("play/pause na linha da tarefa", () => {
  it("as tarefas que a pessoa pode cronometrar ganham o play; validação, devolvida e entregue, não", () => {
    const html = render(
      [
        task("a"),
        task("b", { status: "review" }),
        task("c", { status: "returned" }),
        task("d", { status: "done" }),
        // Quem criou só cronometra quando também executa.
        task("e", { creator_id: me, assignee_id: "u3" }),
      ],
      null,
    );
    expect(html.match(/class="row-timer ?"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Iniciar o cronômetro de Tarefa a"');
  });

  it("várias rodando: cada uma com a pausa e o tempo dela", () => {
    const now = new Date().toISOString();
    const playing: Playing = {
      entries: [entry("a", now), entry("b", now)],
      hours: [],
      company: "c1",
      demo: true,
    };
    const html = render([task("a"), task("b"), task("c")], playing);
    expect(html.match(/row-timer is-running/g)).toHaveLength(2);
    expect(html.match(/class="is-playing"/g)).toHaveLength(2);
    expect(html.match(/Em execução/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Iniciar o cronômetro de Tarefa c"');
    // Rodando, a pausa aparece mesmo se a etapa não deixa iniciar.
    const review = render([task("a", { status: "review" })], playing);
    expect(review).toContain("row-timer is-running");
  });

  it("fora de \"Para você\" (sem timer), nenhum botão", () => {
    expect(render([task("a")], null, false)).not.toContain("row-timer");
  });

  it("runningOn acha a entrada da tarefa", () => {
    const playing: Playing = {
      entries: [entry("a", "2026-10-01T10:00:00Z")],
      hours: [],
      company: "c1",
      demo: true,
    };
    expect(runningOn(playing, "a")?.id).toBe("e-a");
    expect(runningOn(playing, "b")).toBeUndefined();
    expect(runningOn(null, "a")).toBeUndefined();
  });
});

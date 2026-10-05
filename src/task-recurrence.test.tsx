import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoStore } from "./demo-store";
import { demoUser } from "./demo";
import { RecurrenceRow } from "./forms";
import type { TaskRecurrence } from "./types";

function series(active = true) {
  const store = new DemoStore();
  const base = store.data.tasks[0];
  const recurrence: TaskRecurrence = {
    id: "series",
    source_task_id: "source",
    frequency: "daily",
    next_run: "2099-10-09",
    active,
    creator_id: demoUser,
    copies: 3,
    last_error: null,
  };
  store.recurrences = [recurrence];
  store.data.tasks = [
    {
      ...base,
      id: "source",
      recurrence_id: "series",
      due_date: "2099-10-06",
      archived: false,
      status: "progress",
    },
    {
      ...base,
      id: "next",
      recurrence_id: "series",
      due_date: "2099-10-07",
      archived: false,
      status: "progress",
    },
    {
      ...base,
      id: "last",
      recurrence_id: "series",
      due_date: "2099-10-08",
      archived: false,
      status: "progress",
    },
    {
      ...base,
      id: "done",
      recurrence_id: "series",
      due_date: "2099-10-09",
      archived: false,
      status: "done",
    },
    {
      ...base,
      id: "other",
      recurrence_id: "other-series",
      due_date: "2099-10-10",
      archived: false,
    },
  ];
  return { store, recurrence };
}

describe("Cancelamento de repetição", () => {
  it("mantém o caminho antigo de apenas parar novas criações", () => {
    const { store, recurrence } = series();
    store.mutate("stop_task_recurrence", { p_task: "source" });
    expect(recurrence.active).toBe(false);
    expect(store.data.tasks.every((t) => !t.archived)).toBe(true);
  });

  it("retira próximas cópias mesmo após cancelamento, preservando a atual, concluídas e outras séries", () => {
    const { store, recurrence } = series(false);
    const result = store.mutate("stop_task_recurrence", {
      p_task: "source",
      p_remove_future: true,
    });
    expect(result).toEqual({
      archived_count: 2,
      archived_task_ids: ["next", "last"],
    });
    expect(
      store.data.tasks.filter((t) => !t.archived).map((t) => t.id),
    ).toEqual(["source", "done", "other"]);
    expect(recurrence.active).toBe(false);
    expect(
      store.mutate("stop_task_recurrence", {
        p_task: "source",
        p_remove_future: true,
      }),
    ).toEqual({
      archived_count: 0,
      archived_task_ids: [],
    });
    expect(
      store.events.filter((e) => e.action === "recurrence_future_removed"),
    ).toHaveLength(1);
  });

  it("mantém a cópia selecionada e as anteriores", () => {
    const { store } = series();
    const result = store.mutate("stop_task_recurrence", {
      p_task: "next",
      p_remove_future: true,
    });
    expect(result).toEqual({ archived_count: 1, archived_task_ids: ["last"] });
  });

  it("oferece retirada quando já cancelada, só para quem pode parar a série", () => {
    const { recurrence } = series(false);
    const render = (canStop: boolean) =>
      renderToStaticMarkup(
        <RecurrenceRow
          recurrence={recurrence}
          cutoff="2099-10-06"
          canStop={canStop}
          busy={false}
          onStop={async () => {}}
        />,
      );
    expect(render(true)).toContain("Retirar próximas cópias");
    expect(render(true)).toContain("cancelada");
    expect(render(false)).not.toContain("Retirar próximas cópias");
  });
});

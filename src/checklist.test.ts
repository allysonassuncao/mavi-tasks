import { describe, expect, it } from "vitest";
import {
  checklistAsItems,
  checklistGateMessage,
  checklistText,
  openChecklistItems,
  parseChecklistText,
  suggestedChecklistTemplates,
  withItemDone,
  withPendingItems,
} from "./checklist";
import { DemoStore } from "./demo-store";
import { demoUser } from "./demo";
import type { ChecklistItem, TaskChecklist } from "./types";

const item = (
  id: string,
  parent: string | null = null,
  position = 0,
): ChecklistItem => ({
  id,
  parent_id: parent,
  title: id,
  position,
  done: false,
  done_by: null,
  done_at: null,
  created_by: "u",
  created_at: "2026-10-01T10:00:00Z",
});
const list = (items: ChecklistItem[]): TaskChecklist => ({
  id: "l",
  task_id: "t",
  title: "Lista",
  position: 0,
  template_id: null,
  created_by: "u",
  created_at: "2026-10-01T10:00:00Z",
  completed_by: null,
  completed_at: null,
  items,
});

describe("checklist", () => {
  it("lê uma linha por item e “-” como subitem", () => {
    const items = parseChecklistText(
      "Briefing\n- Público\n  Oferta\n\nExportar\n- PNG",
    );
    expect(items).toEqual([
      {
        title: "Briefing",
        children: [{ title: "Público" }, { title: "Oferta" }],
      },
      { title: "Exportar", children: [{ title: "PNG" }] },
    ]);
    expect(parseChecklistText(checklistText(items))).toEqual(items);
    // A subitem with nothing above becomes an item.
    expect(parseChecklistText("- Solto")).toEqual([{ title: "Solto" }]);
  });

  it("o item leva os subitens; os subitens decidem o item; o checklist conclui e reabre", () => {
    let l = list([item("a"), item("b"), item("b1", "b"), item("b2", "b", 1)]);
    l = withItemDone(l, "b1", true, "ana");
    expect(l.items.find((i) => i.id === "b")!.done).toBe(false);
    l = withItemDone(l, "b2", true, "ana");
    expect(l.items.find((i) => i.id === "b")!.done).toBe(true);
    expect(l.completed_at).toBeNull();
    l = withItemDone(l, "a", true, "ana");
    expect(l.completed_by).toBe("ana");
    expect(openChecklistItems([l])).toBe(0);
    l = withItemDone(l, "b", false, "ana");
    expect(l.items.filter((i) => i.done).map((i) => i.id)).toEqual(["a"]);
    expect(l.completed_at).toBeNull();
    expect(openChecklistItems([l])).toBe(3);
    expect(checklistAsItems(l)).toEqual([
      { title: "a" },
      { title: "b", children: [{ title: "b1" }, { title: "b2" }] },
    ]);
  });

  it("sugere os modelos do produto e da equipe, nunca os só à mão", () => {
    const data = {
      contracts: [{ id: "c", product_id: "p" }],
      teamMembers: [{ team_id: "design", user_id: "bia" }],
      checklistTemplates: [
        { id: "produto", product_id: "p", team_id: null, active: true },
        { id: "equipe", product_id: null, team_id: "design", active: true },
        { id: "ambos", product_id: "p", team_id: "vendas", active: true },
        { id: "mao", product_id: null, team_id: null, active: true },
        { id: "off", product_id: "p", team_id: null, active: false },
      ],
    } as never;
    const ids = (who: { assignee: string } | { team: string }) =>
      suggestedChecklistTemplates(data, "c", who).map((t) => t.id);
    expect(ids({ assignee: "bia" })).toEqual(["produto", "equipe"]);
    expect(ids({ team: "vendas" })).toEqual(["produto", "ambos"]);
  });

  it("demonstração: trava a entrega com item em aberto, como o banco", () => {
    const store = new DemoStore();
    const task = store.data.tasks.find(
      (t) => t.creator_id === demoUser && t.status === "progress",
    )!;
    store.mutate("apply_checklist_templates", {
      p_task: task.id,
      p_templates: ["chk-review"],
      p_required: true,
    });
    expect(task.checklist_required).toBe(true);
    const move = () =>
      store.mutate("transition_task", {
        p_task: task.id,
        p_version: task.version,
        p_action: "move",
        p_status: "review",
        p_note: "",
      });
    expect(move).toThrow(checklistGateMessage(3));
    expect(task.status).toBe("progress");
    const [l] = store.checklistsOf(task.id);
    store.mutate("complete_task_checklist", { p_checklist: l.id });
    move();
    expect(task.status).toBe("review");
    expect(store.checklistLog.map((e) => e.action)).toEqual([
      "checklist_completed",
      "required_on",
      "checklist_added",
    ]);
  });
  it("itens digitados ainda não salvos não somem quando o banco responde", () => {
    const shown = list([item("a"), item("tmp:1"), item("tmp:2")]);
    // The answer for tmp:1 (now saved as "b"); tmp:2 is still on its way.
    const answer = list([item("a"), item("b")]);
    expect(
      withPendingItems([answer], [shown], "tmp:1")[0].items.map((i) => i.id),
    ).toEqual(["a", "b", "tmp:2"]);
    // A reload with nothing pending keeps the database's copy as it is.
    expect(withPendingItems([answer], [answer])[0]).toBe(answer);
  });
});

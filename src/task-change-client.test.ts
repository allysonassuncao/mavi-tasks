import { describe, expect, it } from "vitest";
import { DemoStore } from "./demo-store";
import { demoUser } from "./demo";

describe("trocar o cliente na edição da tarefa (demonstração)", () => {
  function setup() {
    const store = new DemoStore();
    const main = store.data.tasks.find(
      (t) => !t.parent_id && t.creator_id === demoUser,
    )!;
    const other = store.data.contracts.find(
      (k) =>
        !k.archived &&
        store.data.contracts.find((c) => c.id === main.contract_id)!
          .client_id !== k.client_id,
    )!;
    const sub = { ...main, id: crypto.randomUUID(), parent_id: main.id };
    store.data.tasks.push(sub);
    const edit = (id: string, extra: Record<string, unknown>) => {
      const t = store.data.tasks.find((x) => x.id === id)!;
      return store.mutate("update_task", {
        p_task: id,
        p_version: t.version,
        p_title: t.title,
        p_description: t.description,
        p_due: t.due_date,
        p_estimated: t.estimated_minutes,
        p_priority: t.priority,
        ...extra,
      });
    };
    return { store, main, sub, other, edit };
  }
  it("leva as subtarefas junto e registra no histórico", () => {
    const { store, main, sub, other, edit } = setup();
    edit(main.id, { p_contract: other.id, p_project: null });
    expect(store.data.tasks.find((t) => t.id === main.id)!.contract_id).toBe(
      other.id,
    );
    expect(store.data.tasks.find((t) => t.id === sub.id)!.contract_id).toBe(
      other.id,
    );
    const client = store.data.clients.find((c) => c.id === other.client_id)!;
    expect(store.events[0].detail.new_client).toBe(client.name);
  });
  it("subtarefa não troca de cliente sozinha", () => {
    const { sub, other, edit } = setup();
    expect(() => edit(sub.id, { p_contract: other.id })).toThrow(
      /tarefa principal/,
    );
  });
  it("sem cliente novo, nada muda", () => {
    const { store, main, edit } = setup();
    const before = main.contract_id;
    edit(main.id, {});
    expect(store.data.tasks.find((t) => t.id === main.id)!.contract_id).toBe(
      before,
    );
    expect(store.events[0].detail.new_client).toBeUndefined();
  });
});

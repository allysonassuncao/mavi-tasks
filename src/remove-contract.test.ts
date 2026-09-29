import { describe, expect, it } from "vitest";
import { DemoStore } from "./demo-store";

describe("remove_contract (demonstração)", () => {
  it("exclui o produto sem histórico e arquiva o que tem projetos ou tarefas", () => {
    const store = new DemoStore();
    const used = new Set([
      ...store.data.projects.map((p) => p.contract_id),
      ...store.data.tasks.map((t) => t.contract_id),
    ]);
    const withHistory = store.data.contracts.find((k) => used.has(k.id))!;
    expect(store.mutate("remove_contract", { p_contract: withHistory.id })).toBe(
      "archived",
    );
    expect(
      store.data.contracts.find((k) => k.id === withHistory.id)?.archived,
    ).toBe(true);

    const fresh = store.mutate("create_contract", {
      p_company: store.data.companies[0].id,
      p_client: withHistory.client_id,
      p_product: withHistory.product_id,
      p_name: "Novo",
    }) as string;
    expect(store.mutate("remove_contract", { p_contract: fresh })).toBe(
      "deleted",
    );
    expect(store.data.contracts.some((k) => k.id === fresh)).toBe(false);
  });
});

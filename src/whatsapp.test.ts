import { describe, expect, it } from "vitest";
import { ago, filterGroups, groupFilter, type WhatsappGroup } from "./whatsapp";

const group = (over: Partial<WhatsappGroup>): WhatsappGroup => ({
  id: "g",
  jid: "1@g.us",
  title: "",
  client_id: null,
  product_ids: [],
  linked_by: "auto",
  ignored: false,
  last_message_at: null,
  synced_until: null,
  synced_at: null,
  sync_error: null,
  message_count: 0,
  ...over,
});

describe("grupos do Whatsapp", () => {
  const groups = [
    group({ id: "a", title: "2745 - Facilita & Make", client_id: "c1" }),
    group({ id: "b", title: "CS | CX - Relacionamento", jid: "120363@g.us" }),
    group({ id: "c", title: "Squad 1", ignored: true, client_id: "c1" }),
  ];
  const names: Record<string, string> = { c1: "Aurora Studio" };

  it("cada grupo está numa aba só", () => {
    expect(groups.map(groupFilter)).toEqual(["linked", "unlinked", "ignored"]);
  });
  it("busca por título, cliente (sem acento) e JID", () => {
    const find = (f: Parameters<typeof filterGroups>[1], q: string) =>
      filterGroups(groups, f, q, (id) => names[id]).map((g) => g.id);
    expect(find("linked", "")).toEqual(["a"]);
    expect(find("linked", "aurora")).toEqual(["a"]);
    expect(find("linked", "FACILITA")).toEqual(["a"]);
    expect(find("unlinked", "relacionamento")).toEqual(["b"]);
    expect(find("unlinked", "120363")).toEqual(["b"]);
    expect(find("ignored", "aurora")).toEqual(["c"]);
    expect(find("linked", "nada")).toEqual([]);
  });
  it("tempo desde a última leitura", () => {
    const now = Date.UTC(2026, 8, 26, 12);
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(ago(null, now)).toBe("");
    expect(ago(at(20_000), now)).toBe("agora");
    expect(ago(at(20 * 60_000), now)).toBe("há 20 min");
    expect(ago(at(3 * 3600_000), now)).toBe("há 3 h");
    expect(ago(at(26 * 3600_000), now)).toBe("há 1 dia");
    expect(ago(at(5 * 86400_000), now)).toBe("há 5 dias");
  });
});

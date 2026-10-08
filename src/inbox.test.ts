import { describe, expect, it } from "vitest";
import {
  kindsOf,
  matchesInbox,
  mergeHead,
  pageOf,
  periodRange,
  radarItemOf,
} from "./inbox";
import type { AppNotification } from "./types";

const n = (
  id: string,
  created_at: string,
  extra: Partial<AppNotification> = {},
): AppNotification => ({
  id,
  kind: "mention",
  task_id: "t1",
  task_title: "Post de outubro",
  actor_id: "ana",
  actor_name: "Ana",
  excerpt: null,
  read_at: null,
  created_at,
  ...extra,
});

describe("caixa de entrada", () => {
  const all = [
    n("a", "2026-09-30T10:00:00Z"),
    n("b", "2026-09-29T10:00:00Z", { read_at: "2026-09-29T11:00:00Z" }),
    n("c", "2026-09-28T10:00:00Z", { kind: "temperature", actor_id: null, actor_name: null, client_id: "k1", task_title: "Aurora esfriou" }),
    n("d", "2026-09-28T10:00:00Z", { kind: "reply", actor_id: "bia", actor_name: "Bia", client_id: "k2" }),
  ];

  it("pages newest first and continues after the last one shown", () => {
    const first = pageOf(all, 2, null);
    expect(first.map((x) => x.id)).toEqual(["a", "b"]);
    const next = pageOf(all, 2, first[1]);
    // Same instant: the id breaks the tie, as in the database.
    expect(next.map((x) => x.id)).toEqual(["d", "c"]);
    expect(pageOf(all, 2, next[1])).toEqual([]);
  });

  it("filters unread, kind, sender, automatic ones, client and text", () => {
    const ids = (f: Parameters<typeof matchesInbox>[1]) =>
      all.filter((x) => matchesInbox(x, f)).map((x) => x.id);
    expect(ids({ unread: true })).toEqual(["a", "c", "d"]);
    expect(ids({ kinds: kindsOf(["reply", "temperature"]) })).toEqual(["c", "d"]);
    expect(ids({ actors: ["bia"] })).toEqual(["d"]);
    expect(ids({ system: true })).toEqual(["c"]);
    expect(ids({ actors: ["bia"], system: true })).toEqual(["c", "d"]);
    expect(ids({ clients: ["k1"] })).toEqual(["c"]);
    expect(ids({ search: "aurora" })).toEqual(["c"]);
    expect(ids({ search: "BIA" })).toEqual(["d"]);
  });

  it("keeps what 'Carregar mais' brought when the first page reloads", () => {
    const loaded = [all[1], all[2], all[3]];
    const fresh = n("new", "2026-09-30T12:00:00Z");
    const merged = mergeHead([fresh, all[0]], loaded, 2, false);
    expect(merged.items.map((x) => x.id)).toEqual(["new", "a", "b", "c", "d"]);
    expect(merged.more).toBe(false);
    // A short first page is everything there is.
    expect(mergeHead([fresh], loaded, 2, true)).toEqual({
      items: [fresh],
      more: false,
    });
  });

  it("turns periods into instants, the custom end day included", () => {
    const now = new Date(2026, 8, 30, 15, 0);
    expect(periodRange("today", { from: "", to: "" }, now).from).toBe(
      new Date(2026, 8, 30).toISOString(),
    );
    expect(periodRange("7d", { from: "", to: "" }, now).from).toBe(
      new Date(2026, 8, 24).toISOString(),
    );
    expect(
      periodRange("custom", { from: "2026-09-01", to: "2026-09-10" }, now),
    ).toEqual({
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 8, 11).toISOString(),
    });
    expect(periodRange("all", { from: "", to: "" }, now)).toEqual({
      from: null,
      to: null,
    });
  });
});

describe("radarItemOf", () => {
  it("reads the item of a Radar notice, with or without the company", () => {
    expect(radarItemOf("/radar?item=abc")).toBe("abc");
    expect(radarItemOf("/agencias/make/radar?item=abc")).toBe("abc");
  });
  it("leaves every other link to the router", () => {
    expect(radarItemOf("/radar")).toBeNull();
    expect(radarItemOf("/radar?relatorio=abc")).toBeNull();
    expect(radarItemOf("/radar/pessoal?item=abc")).toBeNull();
    expect(radarItemOf("/tarefas/abc")).toBeNull();
    expect(radarItemOf(null)).toBeNull();
  });
});

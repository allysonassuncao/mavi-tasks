import { describe, expect, it } from "vitest";
import { freshNotice, noticeTitle, titleWithCount } from "./inbox-title";
import type { AppNotification } from "./types";

const notice = (
  id: string,
  created_at: string,
  extra: Partial<AppNotification> = {},
): AppNotification => ({
  id,
  kind: "mention",
  task_id: "t",
  task_title: "Tarefa",
  actor_id: "u",
  actor_name: "Ana",
  excerpt: null,
  read_at: null,
  created_at,
  ...extra,
});

describe("título da aba pela caixa de entrada", () => {
  it("mostra quantas não lidas há", () => {
    expect(titleWithCount("Workspace", 0)).toBe("Workspace");
    expect(titleWithCount("Workspace", 3)).toBe("(3) Workspace");
    expect(titleWithCount("Workspace", 120)).toBe("(99+) Workspace");
  });
  it("diz quem fez o quê", () => {
    expect(noticeTitle(notice("1", "x"))).toBe("🔔 Ana mencionou você");
    expect(
      noticeTitle(notice("1", "x", { kind: "assigned", actor_name: null })),
    ).toBe("🔔 Alguém criou uma tarefa para você");
    expect(noticeTitle(notice("1", "x", { kind: "reply" }))).toBe(
      "🔔 Ana respondeu seu comentário",
    );
  });
  it("só avisa das novas: não lidas, não vistas e depois de abrir o app", () => {
    const since = "2026-09-24T12:00:00.000Z";
    const items = [
      notice("old", "2026-09-24T11:00:00.000Z"),
      notice("read", "2026-09-24T12:05:00.000Z", { read_at: "x" }),
      notice("a", "2026-09-24T12:01:00.000Z"),
      notice("b", "2026-09-24T12:02:00.000Z"),
    ];
    expect(freshNotice(items, new Set(), since)?.id).toBe("b");
    expect(freshNotice(items, new Set(["b"]), since)?.id).toBe("a");
    expect(freshNotice(items, new Set(["a", "b"]), since)).toBeNull();
  });
});

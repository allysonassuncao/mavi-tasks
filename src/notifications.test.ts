import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notificationState,
  showNotification,
  toggleNotifications,
} from "./notifications";

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = "granted";
    return "granted" as NotificationPermission;
  });
  static shown: { title: string; options: NotificationOptions }[] = [];
  onclick: (() => void) | null = null;
  constructor(title: string, options: NotificationOptions) {
    FakeNotification.shown.push({ title, options });
  }
  close() {}
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("window", { focus: vi.fn(), Notification: FakeNotification });
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
  FakeNotification.permission = "default";
  FakeNotification.shown = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("Notificações de novas tarefas", () => {
  it("pede permissão no primeiro clique e passa a notificar", async () => {
    expect(notificationState()).toBe("default");
    expect(await toggleNotifications()).toBe("on");
    showNotification("Nova tarefa para você", {
      body: "Post de lançamento",
      tag: "t1",
      onClick: () => {},
    });
    expect(FakeNotification.shown).toHaveLength(1);
  });
  it("pausar guarda a escolha e silencia", async () => {
    FakeNotification.permission = "granted";
    expect(await toggleNotifications()).toBe("off");
    showNotification("x", { body: "", tag: "t", onClick: () => {} });
    expect(FakeNotification.shown).toHaveLength(0);
    expect(await toggleNotifications()).toBe("on");
  });
  it("respeita o bloqueio do navegador", () => {
    FakeNotification.permission = "denied";
    expect(notificationState()).toBe("denied");
  });
});

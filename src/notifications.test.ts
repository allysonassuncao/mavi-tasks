import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableNotifications,
  notificationEnvironment,
  notificationState,
  setNotificationPause,
  showNotification,
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
    expect(await enableNotifications()).toBe("on");
    showNotification("Nova tarefa para você", {
      body: "Post de lançamento",
      tag: "t1",
      onClick: () => {},
    });
    expect(FakeNotification.shown).toHaveLength(1);
  });
  it("em pausa, silencia até a hora marcada", async () => {
    FakeNotification.permission = "granted";
    setNotificationPause(Date.now() + 60_000);
    showNotification("x", { body: "", tag: "t", onClick: () => {} });
    expect(FakeNotification.shown).toHaveLength(0);
    setNotificationPause(Date.now() - 1);
    showNotification("x", { body: "", tag: "t", onClick: () => {} });
    expect(FakeNotification.shown).toHaveLength(1);
  });
  it("pelo service worker, não repete a que o push já mostrou", async () => {
    FakeNotification.permission = "granted";
    const open = new Set(["t1"]);
    const reg = {
      getNotifications: vi.fn(async ({ tag }: { tag: string }) =>
        open.has(tag) ? [{ tag }] : [],
      ),
      showNotification: vi.fn(async (_: string, o: { tag: string }) => {
        open.add(o.tag);
      }),
    };
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: async () => reg },
    });
    showNotification("x", { body: "", tag: "t1", onClick: () => {} });
    showNotification("y", { body: "", tag: "t2", onClick: () => {} });
    await vi.waitFor(() => expect(open.has("t2")).toBe(true));
    expect(reg.showNotification).toHaveBeenCalledTimes(1);
    expect(FakeNotification.shown).toHaveLength(0);
  });
  it("respeita o bloqueio do navegador", () => {
    FakeNotification.permission = "denied";
    expect(notificationState()).toBe("denied");
  });
  it("reconhece o sistema e o navegador para orientar a liberação", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    });
    expect(notificationEnvironment()).toEqual({
      system: "mac",
      browser: "Google Chrome",
    });
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
    });
    expect(notificationEnvironment()).toEqual({
      system: "windows",
      browser: "Microsoft Edge",
    });
  });
});

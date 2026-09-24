import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn(async () => null);
vi.mock("./api", () => ({ rpc }));
const { syncPush, pushActive } = await import("./push");

// A VAPID public key in base64url, and its bytes.
const publicKey = "AQID";
const keyBytes = new Uint8Array([1, 2, 3]);

/** Node has a read-only `navigator`: redefine globals instead of assigning. */
function setGlobals(values: Record<string, unknown>) {
  for (const [k, value] of Object.entries(values))
    Object.defineProperty(globalThis, k, {
      value,
      configurable: true,
      writable: true,
    });
}

function fakeBrowser(existing: unknown = null) {
  const subscription = {
    endpoint: "https://push.example/abc",
    options: { applicationServerKey: keyBytes.buffer },
    toJSON: () => ({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p", auth: "a" },
    }),
    unsubscribe: vi.fn(async () => true),
  };
  const pushManager = {
    getSubscription: vi.fn(async () => existing),
    subscribe: vi.fn(async () => subscription),
  };
  const reg = { pushManager };
  setGlobals({
    window: { PushManager: class {}, Notification: class {} },
    navigator: {
      userAgent: "Teste",
      serviceWorker: {
        getRegistration: async () => reg,
        ready: Promise.resolve(reg),
      },
    },
    Notification: { permission: "granted" },
    fetch: vi.fn(async () => new Response(JSON.stringify({ publicKey }))),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
  });
  return { pushManager, subscription };
}

describe("syncPush", () => {
  beforeEach(() => rpc.mockClear());
  afterEach(() => {
    for (const k of ["window", "navigator", "Notification", "fetch"])
      delete (globalThis as Record<string, unknown>)[k];
  });

  it("sem service worker, não faz nada", async () => {
    setGlobals({ window: {}, navigator: {} });
    expect(await syncPush(true)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("inscreve o navegador e registra para a pessoa", async () => {
    const { pushManager } = fakeBrowser();
    expect(await syncPush(true)).toBe(true);
    expect(pushActive()).toBe(true);
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: keyBytes,
    });
    expect(rpc).toHaveBeenCalledWith("save_push_subscription", {
      p_endpoint: "https://push.example/abc",
      p_p256dh: "p",
      p_auth: "a",
      p_user_agent: "Teste",
    });
  });

  it("reaproveita a inscrição existente com a mesma chave", async () => {
    const { pushManager, subscription } = fakeBrowser();
    fakeBrowser(subscription);
    await syncPush(true);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("ao desativar, remove do banco e cancela a inscrição", async () => {
    const { subscription } = fakeBrowser();
    fakeBrowser(subscription);
    expect(await syncPush(false)).toBe(false);
    expect(rpc).toHaveBeenCalledWith("remove_push_subscription", {
      p_endpoint: "https://push.example/abc",
    });
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });

  it("servidor sem configuração mantém o aviso só no app", async () => {
    fakeBrowser();
    (globalThis as { fetch: unknown }).fetch = vi.fn(
      async () => new Response("{}", { status: 503 }),
    );
    expect(await syncPush(true)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

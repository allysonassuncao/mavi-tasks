import { rpc } from "./api";

/**
 * Web Push for this browser: with notifications on, it subscribes through
 * the service worker and registers the subscription for the signed-in
 * person, so notifications arrive with the app closed (api/push.ts sends
 * them). Needs the service worker, which only production registers.
 */
function supported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * The service worker, or null when there isn't one (dev, blocked). Waits for
 * it: on the first visit it's only registered on "load", after this runs.
 */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
  ]);
}

function keyBytes(base64url: string) {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const sameKey = (a: ArrayBuffer | null, b: Uint8Array) =>
  !!a &&
  new Uint8Array(a).every((v, i) => v === b[i]) &&
  a.byteLength === b.length;

/**
 * Where this browser's push stands: "on" (registered for the person), "off"
 * (notifications paused or not allowed), "unsupported", "no-worker" (the
 * service worker isn't running), "server-off" (no VAPID key on the server)
 * or "error" (the browser or the database refused; `error` says why).
 */
export type PushResult = {
  state: "on" | "off" | "unsupported" | "no-worker" | "server-off" | "error";
  error?: string;
};

/**
 * Turns this browser's pushes on or off for the signed-in person. Safe to
 * call often: an existing subscription is reused (and re-registered, which
 * also moves it to whoever signed in on this browser).
 */
export async function syncPush(on: boolean): Promise<boolean> {
  return (await connectPush(on)).state === "on";
}

/** syncPush, telling why push isn't on (for "Enviar notificação de teste"). */
export async function connectPush(on: boolean): Promise<PushResult> {
  try {
    if (!supported()) return { state: "unsupported" };
    const reg = await registration();
    if (!reg) return { state: "no-worker" };
    const current = await reg.pushManager.getSubscription();
    if (!on || Notification.permission !== "granted") {
      if (current) {
        await rpc("remove_push_subscription", {
          p_endpoint: current.endpoint,
        }).catch(() => {});
        await current.unsubscribe().catch(() => {});
      }
      return { state: "off" };
    }
    const res = await fetch("/api/push");
    const { publicKey } = (await res.json().catch(() => ({}))) as {
      publicKey?: string;
    };
    // Not configured on the server yet: the app keeps notifying on its own.
    if (!res.ok || !publicKey) return { state: "server-off" };
    const key = keyBytes(publicKey);
    let sub = current;
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    const json = sub.toJSON() as {
      endpoint: string;
      keys?: { p256dh?: string; auth?: string };
    };
    await rpc("save_push_subscription", {
      p_endpoint: json.endpoint,
      p_p256dh: json.keys?.p256dh ?? "",
      p_auth: json.keys?.auth ?? "",
      p_user_agent: navigator.userAgent.slice(0, 400),
    });
    return { state: "on" };
  } catch (err) {
    // Push is an extra: the in-app notices keep working without it.
    return { state: "error", error: (err as Error)?.message || String(err) };
  }
}

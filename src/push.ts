import { rpc } from "./api";

/**
 * Web Push for this browser: with notifications on, it subscribes through
 * the service worker and registers the subscription for the signed-in
 * person, so notifications arrive with the app closed (api/push.ts sends
 * them). Needs the service worker, which only production registers.
 */
let active = false;
/** Whether this browser receives pushes (then the app shows no copy of its own). */
export const pushActive = () => active;

function supported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The service worker, or null when there isn't one (dev, blocked). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
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
 * Turns this browser's pushes on or off for the signed-in person. Safe to
 * call often: an existing subscription is reused (and re-registered, which
 * also moves it to whoever signed in on this browser).
 */
export async function syncPush(on: boolean): Promise<boolean> {
  try {
    const reg = await registration();
    if (!reg) return (active = false);
    const current = await reg.pushManager.getSubscription();
    if (!on || Notification.permission !== "granted") {
      if (current) {
        await rpc("remove_push_subscription", {
          p_endpoint: current.endpoint,
        }).catch(() => {});
        await current.unsubscribe().catch(() => {});
      }
      return (active = false);
    }
    const res = await fetch("/api/push");
    const { publicKey } = (await res.json().catch(() => ({}))) as {
      publicKey?: string;
    };
    // Not configured on the server yet: the app keeps notifying on its own.
    if (!res.ok || !publicKey) return (active = false);
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
    return (active = true);
  } catch {
    // Push is an extra: the in-app notices keep working without it.
    return (active = false);
  }
}

/**
 * Browser notifications. The permission is the browser's; what the person
 * receives and the pause are theirs, kept in the database (notificationPrefs)
 * and valid on every device — a pause holds these notifications, not the inbox.
 */
export type NotificationState = "unsupported" | "default" | "denied" | "on";

export function notificationState(): NotificationState {
  if (typeof window === "undefined" || !("Notification" in window))
    return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  return "on";
}

// Until when the person paused (ms), set by the app from their preferences.
let pausedUntil = 0;
export function setNotificationPause(until: number) {
  pausedUntil = until;
}
const paused = () => pausedUntil > Date.now();

/** Must run from a click: browsers only show the permission prompt on a user gesture. */
export async function enableNotifications(): Promise<NotificationState> {
  if (notificationState() === "default") await Notification.requestPermission();
  return notificationState();
}

export function showNotification(
  title: string,
  options: {
    body: string;
    tag: string;
    onClick: () => void;
    /** Opened when the service worker's notification is clicked. */
    url?: string;
  },
) {
  if (notificationState() !== "on" || paused()) return;
  const fallback = () => {
    try {
      const n = new Notification(title, {
        body: options.body,
        tag: options.tag,
        icon: "/icons/icon-192-v2.png",
      });
      n.onclick = () => {
        window.focus();
        options.onClick();
        n.close();
      };
    } catch {
      // No way to notify here; the in-app toast still informs the user.
    }
  };
  // Installed apps and Android only allow notifications from the service
  // worker (a click there opens the task through its "mavi:open" message).
  if (!("serviceWorker" in navigator)) return fallback();
  navigator.serviceWorker
    .getRegistration()
    .then(async (reg) => {
      if (!reg) return fallback();
      // The push (same tag) may have shown it already.
      const shown = await reg
        .getNotifications({ tag: options.tag })
        .catch(() => []);
      if (shown.length) return;
      await reg.showNotification(title, {
        body: options.body,
        tag: options.tag,
        icon: "/icons/icon-192-v2.png",
        badge: "/icons/icon-192-v2.png",
        data: { url: options.url ?? "/" },
      });
    })
    .catch(fallback);
}

/**
 * Shows a test notification now, through the service worker when there is
 * one. Resolves false when the browser refused it; true only means it was
 * handed over — the system may still hide it (Focus, Do not disturb, the
 * browser's notifications turned off in the system settings).
 */
export async function showTestNotification(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window))
    return false;
  if (Notification.permission !== "granted") return false;
  const title = "Teste de notificação";
  const options = {
    body: "Se você está vendo isto, as notificações funcionam neste navegador.",
    tag: "mavi-test-local",
    icon: "/icons/icon-192-v2.png",
  };
  try {
    const reg =
      "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration()
        : undefined;
    if (reg) {
      await reg.showNotification(title, {
        ...options,
        badge: "/icons/icon-192-v2.png",
        data: { url: "/" },
      });
      return true;
    }
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

export type NotificationSystem = "mac" | "windows" | "other";

/** The system and browser, to say where notifications are turned on. */
export function notificationEnvironment(): {
  system: NotificationSystem;
  browser: string;
} {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const system: NotificationSystem = /Mac OS X|Macintosh/.test(ua)
    ? "mac"
    : /Windows/.test(ua)
      ? "windows"
      : "other";
  const browser = /Edg\//.test(ua)
    ? "Microsoft Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Google Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "navegador";
  return { system, browser };
}

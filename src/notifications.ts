/**
 * Browser notifications for new tasks. The on/off choice is a UI preference
 * kept outside the "mavi:cache:" prefix, so logging out doesn't reset it.
 */
const PREF_KEY = "mavi:notifications";
export type NotificationState =
  "unsupported" | "default" | "denied" | "on" | "off";

export function notificationState(): NotificationState {
  if (typeof window === "undefined" || !("Notification" in window))
    return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  try {
    return localStorage.getItem(PREF_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

function savePreference(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    // Blocked storage: the choice just won't persist.
  }
}

/** Must run from a click: browsers only show the permission prompt on a user gesture. */
export async function toggleNotifications(): Promise<NotificationState> {
  const state = notificationState();
  if (state === "default") {
    const permission = await Notification.requestPermission();
    if (permission === "granted") savePreference(true);
  } else if (state === "on" || state === "off") {
    savePreference(state === "off");
  }
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
  if (notificationState() !== "on") return;
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

/** Pauses or resumes this browser's notifications (permission already given). */
export function setNotificationsOn(on: boolean): NotificationState {
  if (notificationState() === "on" || notificationState() === "off")
    savePreference(on);
  return notificationState();
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

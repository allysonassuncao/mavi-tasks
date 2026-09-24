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
    .then((reg) =>
      reg
        ? reg.showNotification(title, {
            body: options.body,
            tag: options.tag,
            icon: "/icons/icon-192-v2.png",
            badge: "/icons/icon-192-v2.png",
            data: { url: options.url ?? "/" },
          })
        : fallback(),
    )
    .catch(fallback);
}

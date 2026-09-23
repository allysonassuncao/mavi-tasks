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
  options: { body: string; tag: string; onClick: () => void },
) {
  if (notificationState() !== "on") return;
  try {
    const n = new Notification(title, {
      body: options.body,
      tag: options.tag,
      icon: "/favicon.svg",
    });
    n.onclick = () => {
      window.focus();
      options.onClick();
      n.close();
    };
  } catch {
    // Some browsers (e.g. Android Chrome) only allow notifications from a
    // service worker; the in-app toast still informs the user.
  }
}

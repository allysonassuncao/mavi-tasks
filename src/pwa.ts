import { useEffect, useState } from "react";

/** Registers the service worker (production only: dev keeps Vite's HMR clean). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* The app works the same without it; only install/offline are lost. */
    });
  });
}

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
// The browser fires this once, possibly before React mounts: keep it.
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
/** iPhone/iPad Safari installs only through Share → Add to Home Screen. */
export function isIOS() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * How the app can be installed here: "prompt" (Chrome, Edge, Android — the
 * browser's own dialog), "ios" (manual steps), or null (installed/unsupported).
 */
export function useInstall() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const mode: "prompt" | "ios" | null = isStandalone()
    ? null
    : deferred
      ? "prompt"
      : isIOS()
        ? "ios"
        : null;
  async function install() {
    if (!deferred) return false;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    rerender((v) => v + 1);
    return outcome === "accepted";
  }
  return { mode, install };
}

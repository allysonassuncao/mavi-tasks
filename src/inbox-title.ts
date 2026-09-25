import { useEffect, useRef } from "react";
import type { AppNotification } from "./types";

/**
 * The browser tab's title follows the "Caixa de entrada": "(3) Workspace…"
 * while there are unread notices and, when one arrives with the tab in the
 * background, it alternates with who did what ("🔔 Ana mencionou você")
 * until the person comes back to the tab.
 */

/** "(3) Workspace — Gestão de trabalho"; the base alone with none unread. */
export function titleWithCount(base: string, unread: number) {
  return unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${base}` : base;
}

/** What the title says about a notice that just arrived. */
export function noticeTitle(n: AppNotification) {
  const who = n.actor_name?.trim() || "Alguém";
  const what =
    n.kind === "assigned"
      ? "criou uma tarefa para você"
      : n.kind === "reply"
        ? "respondeu seu comentário"
        : "mencionou você";
  return `🔔 ${who} ${what}`;
}

/**
 * The newest unread notice not seen before (created after `since`, so the
 * ones already there when the app opened don't count), or null.
 */
export function freshNotice(
  items: AppNotification[],
  seen: ReadonlySet<string>,
  since: string,
) {
  return (
    items
      .filter((n) => !n.read_at && !seen.has(n.id) && n.created_at > since)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

const BLINK_MS = 1500;

export function useInboxTitle(items: AppNotification[], enabled: boolean) {
  // The page's own title (index.html), restored when signing out.
  const base = useRef(document.title);
  const seen = useRef(new Set<string>());
  const since = useRef(new Date().toISOString());
  const blink = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const unread = enabled ? items.filter((n) => !n.read_at).length : 0;
  const count = useRef(unread);
  count.current = unread;

  useEffect(() => {
    const plain = titleWithCount(base.current, unread);
    const stop = () => {
      clearInterval(blink.current);
      blink.current = undefined;
      document.title = plain;
    };
    const fresh = enabled
      ? freshNotice(items, seen.current, since.current)
      : null;
    for (const n of items) seen.current.add(n.id);
    if (!fresh || document.visibilityState === "visible" || !unread) {
      // A blink already running keeps going while the tab stays hidden
      // (the interval reads the current count).
      if (!blink.current || !unread || !enabled) stop();
      return;
    }
    clearInterval(blink.current);
    const message = noticeTitle(fresh);
    let on = true;
    document.title = message;
    blink.current = setInterval(() => {
      on = !on;
      document.title = on
        ? message
        : titleWithCount(base.current, count.current);
    }, BLINK_MS);
  }, [items, enabled, unread]);

  // Back to the tab: the notice was seen; only the count stays.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== "visible" || !blink.current) return;
      clearInterval(blink.current);
      blink.current = undefined;
      document.title = titleWithCount(base.current, count.current);
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);

  useEffect(
    () => () => {
      clearInterval(blink.current);
      document.title = base.current;
    },
    [],
  );
}

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { Member } from "./types";

/** "online": using the app now; "away": tab hidden or idle for a while. */
export type PresenceState = "online" | "away";
export type Presence = { state: PresenceState; since: string };
/** Who is in the app right now, by user id. */
export type PresenceMap = Map<string, Presence>;

/** What each open tab announces on the company's presence topic. */
export type PresenceMeta = { state?: PresenceState; online_at?: string };

/** Without a click, key or scroll for this long, the person shows as away. */
export const IDLE_MS = 5 * 60 * 1000;

/**
 * One entry per person, from the raw presence state (one list of tabs per
 * person): online when any tab is in use, since their earliest tab opened.
 */
export function summarizePresence(
  raw: Record<string, PresenceMeta[]>,
): PresenceMap {
  const out: PresenceMap = new Map();
  for (const [user, metas] of Object.entries(raw)) {
    if (!metas.length) continue;
    const online = metas.some((m) => m.state !== "away");
    const since = metas
      .map((m) => m.online_at ?? "")
      .filter(Boolean)
      .sort()[0];
    out.set(user, {
      state: online ? "online" : "away",
      since: since ?? new Date().toISOString(),
    });
  }
  return out;
}

/** Active members in the app, online first, then by name. */
export function presentMembers(members: Member[], presence: PresenceMap) {
  return members
    .filter((m) => m.active && presence.has(m.user_id))
    .map((m) => ({ member: m, ...presence.get(m.user_id)! }))
    .sort(
      (a, b) =>
        (a.state === "online" ? 0 : 1) - (b.state === "online" ? 0 : 1) ||
        a.member.name.localeCompare(b.member.name, "pt-BR"),
    );
}

/**
 * Announces the person on "mavi:presence:<company>" and follows who else is
 * there. The topic is private: Realtime only lets active members of the
 * company join, listen and announce (see the realtime.messages policies).
 */
export function joinPresence(
  company: string,
  user: string,
  onChange: (presence: PresenceMap) => void,
): () => void {
  if (!supabase) return () => {};
  const client = supabase;
  const onlineAt = new Date().toISOString();
  let closed = false,
    joined = false,
    state: PresenceState = "online",
    lastInput = Date.now();
  const channel = client.channel(`mavi:presence:${company}`, {
    config: { private: true, presence: { key: user } },
  });
  const current = (): PresenceState =>
    document.visibilityState === "visible" && Date.now() - lastInput < IDLE_MS
      ? "online"
      : "away";
  const announce = () => {
    if (!joined || closed) return;
    void channel.track({ state, online_at: onlineAt }).catch(() => {});
  };
  const refresh = () => {
    const next = current();
    if (next === state) return;
    state = next;
    announce();
  };
  const onInput = () => {
    lastInput = Date.now();
    if (state === "away") refresh();
  };
  channel.on("presence", { event: "sync" }, () =>
    onChange(
      summarizePresence(
        channel.presenceState() as Record<string, PresenceMeta[]>,
      ),
    ),
  );
  void client.realtime
    .setAuth()
    .catch(() => {})
    .finally(() => {
      if (closed) return;
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          joined = true;
          state = current();
          announce();
        } else joined = false;
      });
    });
  const inputs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  for (const e of inputs)
    window.addEventListener(e, onInput, { passive: true });
  document.addEventListener("visibilitychange", refresh);
  const idle = setInterval(refresh, 30_000);
  return () => {
    closed = true;
    clearInterval(idle);
    for (const e of inputs) window.removeEventListener(e, onInput);
    document.removeEventListener("visibilitychange", refresh);
    void client.removeChannel(channel);
  };
}

/** A few colleagues "in the app" for the demo, which has no Realtime. */
export function demoPresence(members: Member[], user: string): PresenceMap {
  const now = Date.now();
  const out: PresenceMap = new Map();
  members
    .filter((m) => m.active)
    .forEach((m, i) => {
      if (m.user_id !== user && i % 4 === 3) return;
      out.set(m.user_id, {
        state: m.user_id === user || i % 4 !== 2 ? "online" : "away",
        since: new Date(now - (i + 1) * 17 * 60 * 1000).toISOString(),
      });
    });
  return out;
}

/** Who from the company is in the app, live. */
export function usePresence(
  company: string,
  user: string,
  demo: boolean,
  members: Member[],
): PresenceMap {
  const [presence, setPresence] = useState<PresenceMap>(new Map());
  const demoKey = demo ? members.map((m) => m.user_id).join() : "";
  useEffect(() => {
    if (!company || !user) return setPresence(new Map());
    if (demo) return setPresence(demoPresence(members, user));
    setPresence(new Map());
    return joinPresence(company, user, setPresence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, user, demo, demoKey]);
  return presence;
}

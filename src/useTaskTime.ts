import { useEffect, useState } from "react";
import { taskPastSeconds } from "./api";
import { taskTimerSeconds } from "./domain";
import type { TimeEntry } from "./types";
import { useNow } from "./useClock";

/** Finished seconds fetched for a task; `session` was running at fetch time. */
export type PastSeconds = { task: string; seconds: number; session?: string };

const span = (from: string, to: number) =>
  Math.max(0, Math.floor((to - Date.parse(from)) / 1000));

/**
 * A task's total: the finished seconds from the database, plus the running
 * session, plus a session that ended after the fetch (refetch still pending).
 * Without a fetched value, the snapshot's entries are all there is.
 */
export function trackedTotal(
  past: PastSeconds | null,
  hours: TimeEntry[],
  running: TimeEntry | null | undefined,
  taskId: string,
  now: number,
) {
  if (past?.task !== taskId)
    return taskTimerSeconds(hours, taskId, running, now);
  const isRunning = running?.task_id === taskId && !running.ended_at;
  const current = isRunning && running ? span(running.started_at, now) : 0;
  const ended =
    past.session && past.session !== running?.id
      ? hours.find((h) => h.id === past.session && h.ended_at)
      : undefined;
  const endedSeconds = ended
    ? span(ended.started_at, Date.parse(ended.ended_at!))
    : 0;
  return past.seconds + endedSeconds + current;
}

/**
 * Total seconds tracked on a task, ticking while its timer runs. The finished
 * part comes from the database (all of the task's entries, not only the
 * company's latest ones kept in the snapshot); the demo uses the snapshot.
 */
export function useTaskSeconds({
  company,
  taskId,
  hours,
  running,
  demo,
}: {
  company: string;
  taskId: string;
  hours: TimeEntry[];
  running: TimeEntry | null | undefined;
  demo: boolean;
}) {
  const isRunning = running?.task_id === taskId && !running.ended_at;
  const now = useNow(isRunning);
  const [past, setPast] = useState<PastSeconds | null>(null);
  // Refetch when a timer starts or stops, or the task's loaded entries change
  // (a manual entry, an edit).
  const loaded = hours.filter((h) => h.task_id === taskId).length;
  useEffect(() => {
    if (demo) return;
    let alive = true;
    const session = isRunning ? running?.id : undefined;
    taskPastSeconds(company, taskId)
      .then((seconds) => {
        if (alive) setPast({ task: taskId, seconds, session });
      })
      .catch(() => {
        /* Keep the snapshot-based total. */
      });
    return () => {
      alive = false;
    };
  }, [company, taskId, demo, running?.id, running?.ended_at, loaded]);

  return trackedTotal(demo ? null : past, hours, running, taskId, now);
}

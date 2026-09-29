import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { rpc } from "./api";
import { addDays, suggestDue } from "./dueRules";
import type { Snapshot, Task } from "./types";

/**
 * Prazo inteligente (migration 20261129120000_smart_due): what the MAVI
 * suggests for a task, computed by public.smart_due_suggestion. When the
 * assignee's Google busy times are older than an hour, /api/google reads
 * them again (only the total per day) and the suggestion is asked again.
 * Requests go out when the form changes, never on a timer.
 */
export interface SmartDue {
  available: boolean;
  /** Why there is no suggestion: history (under 5 similar deliveries), off, target. */
  reason?: "history" | "off" | "target";
  mode?: "off" | "suggest" | "fill";
  due?: string;
  days?: number;
  /** Who it was computed for (in a team, who would receive it now). */
  assignee?: string;
  level?: number;
  level_label?: string;
  sample?: number;
  median_days?: number;
  approval_days?: number;
  rework_days?: number;
  load_minutes?: number;
  load_tasks?: number;
  unestimated_tasks?: number;
  own_minutes?: number;
  daily_minutes?: number;
  busy_minutes?: number;
  load_days?: number;
  history_due?: string;
  busy?: "none" | "stale" | "fresh";
}

export interface SmartDueInput {
  company: string;
  contract: string;
  project: string | null;
  team: string | null;
  assignee: string | null;
  start: string | null;
  approval: boolean;
  priority: Task["priority"];
  /** Minutes. */
  estimated: number;
  timezone: string;
  today: string;
}

const h = (minutes: number) => {
  const v = minutes / 60;
  return `${Number.isInteger(v) ? v : v.toFixed(1).replace(".", ",")} h`;
};
const days = (n: number) => (n === 1 ? "1 dia útil" : `${n} dias úteis`);

/** The why, one line each, in the order it was counted. */
export function smartReasons(
  s: SmartDue,
  data: Pick<Snapshot, "members">,
  priority: Task["priority"] = "normal",
) {
  if (!s.available) return [];
  const first =
    data.members.find((m) => m.user_id === s.assignee)?.name.split(" ")[0] ??
    "Quem executa";
  const out = [
    `Tarefas parecidas (${s.level_label}) levaram ${days(s.median_days ?? 0)} até a primeira entrega — mediana de ${s.sample} entregas.`,
  ];
  if (s.approval_days)
    out.push(
      `+${days(s.approval_days)} pela aprovação do cliente, que as parecidas em geral não tinham.`,
    );
  if (s.rework_days)
    out.push(`+${days(s.rework_days)}: este cliente pede mais ajustes que a média.`);
  const load = (s.load_minutes ?? 0) + (s.own_minutes ?? 0);
  if (load > 0) {
    const meetings = s.busy_minutes ? `, menos ${h(s.busy_minutes)} de reuniões na agenda` : "";
    const fits =
      (s.load_days ?? 0) >
      (s.median_days ?? 0) + (s.approval_days ?? 0) + (s.rework_days ?? 0);
    out.push(
      `${first} tem ${h(s.load_minutes ?? 0)} em aberto vencendo antes${s.own_minutes ? ` e esta tarefa estima ${h(s.own_minutes)}` : ""}, com ${h(s.daily_minutes ?? 480)} por dia${meetings}: ${fits ? `só cabe em ${days(s.load_days ?? 0)}` : "cabe no prazo"}.`,
    );
  }
  if (priority === "urgent" || priority === "high")
    out.push(
      priority === "urgent"
        ? "Urgente: só as tarefas urgentes de quem executa passam na frente."
        : "Alta: as de prioridade baixa e normal não passam na frente.",
    );
  if (s.unestimated_tasks)
    out.push(
      `${s.unestimated_tasks === 1 ? "1 tarefa em aberto sem estimativa não entrou" : `${s.unestimated_tasks} tarefas em aberto sem estimativa não entraram`} na conta.`,
    );
  return out;
}

async function readBusy(input: SmartDueInput, s: SmartDue) {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token || !s.assignee) return;
  const to = [s.due ?? "", addDays(input.today, 30)].sort()[1];
  await fetch("/api/google", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      action: "busy",
      company: input.company,
      user: s.assignee,
      from: input.today,
      to: to > addDays(input.today, 120) ? addDays(input.today, 120) : to,
      timeZone: input.timezone,
    }),
  });
}

async function fetchSmartDue(input: SmartDueInput): Promise<SmartDue> {
  const ask = () =>
    rpc("smart_due_suggestion", {
      p_company: input.company,
      p_contract: input.contract,
      p_project: input.project,
      p_team: input.team,
      p_assignee: input.team ? null : input.assignee,
      p_start: input.start,
      p_approval: input.approval,
      p_priority: input.priority,
      p_estimated: input.estimated,
    }) as Promise<SmartDue>;
  const first = await ask();
  if (!first.available || first.busy !== "stale") return first;
  // Meetings: read them now (a failure keeps the suggestion without them).
  try {
    await readBusy(input, first);
    return await ask();
  } catch {
    return first;
  }
}

/**
 * The demo has no delivery history: an illustrative suggestion, one business
 * day past the rule, as if eight similar tasks had been delivered.
 */
function demoSmartDue(data: Snapshot, input: SmartDueInput): SmartDue {
  const mode = data.companies.find((c) => c.id === input.company)?.smart_due ?? "suggest";
  if (mode === "off") return { available: false, reason: "off", mode };
  const who = input.team
    ? data.teamMembers.find((tm) => tm.team_id === input.team)?.user_id
    : input.assignee;
  const rule = suggestDue(data, {
    contract: input.contract,
    project: input.project,
    team: input.team,
    assignee: who,
    base: input.start || input.today,
    approval: input.approval,
  });
  if (!rule || !who) return { available: false, reason: "history", mode };
  const load = data.tasks
    .filter((t) => t.assignee_id === who && t.status !== "done" && !t.archived && t.due_date <= rule.due)
    .reduce((sum, t) => sum + t.estimated_minutes, 0);
  const n = rule.days + 1;
  return {
    available: true,
    mode,
    assignee: who,
    due: suggestDue(
      { ...data, dueRules: [{ ...rule.rule, business_days: n, approval_days: 0, min_days: null }] },
      { contract: input.contract, assignee: who, base: input.start || input.today },
    )?.due,
    days: n,
    level: 2,
    level_label: "este cliente e produto",
    sample: 8,
    median_days: n,
    approval_days: 0,
    rework_days: 0,
    load_minutes: load,
    load_tasks: 0,
    unestimated_tasks: 0,
    own_minutes: input.estimated,
    daily_minutes: 480,
    busy_minutes: 0,
    load_days: 0,
    busy: "none",
  };
}

const cache = new Map<string, { at: number; value: SmartDue }>();

/** The suggestion for the form's current values (debounced; cached for 2 minutes). */
export function useSmartDue(
  input: SmartDueInput | null,
  demo: boolean,
  data: Snapshot,
) {
  const [state, setState] = useState<SmartDue | null>(null);
  const [loading, setLoading] = useState(false);
  const key = input ? JSON.stringify(input) : "";
  const latest = useRef(key);
  latest.current = key;
  useEffect(() => {
    if (!input) {
      setState(null);
      return;
    }
    if (demo) {
      setState(demoSmartDue(data, input));
      return;
    }
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 120_000) {
      setState(hit.value);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      fetchSmartDue(input)
        .then((value) => {
          cache.set(key, { at: Date.now(), value });
          if (latest.current === key) setState(value);
        })
        // The suggestion is a help: without it, the rule's date stays.
        .catch(() => latest.current === key && setState(null))
        .finally(() => latest.current === key && setLoading(false));
    }, 500);
    return () => clearTimeout(timer);
    // `input` is fully described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, demo, demo ? data : null]);
  return { state, loading };
}

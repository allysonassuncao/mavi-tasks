import { useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, Check, UsersRound } from "lucide-react";
import { Modal } from "./components";
import { Button } from "./ui";
import { rpc } from "./api";
import { dateKey } from "./domain";
import { absencesIn, nextBusinessDay, personOff, suggestDue } from "./dueRules";
import { dayLabel, plural } from "./task-bulk";
import type { Snapshot, Task } from "./types";
import "./due-rules.css";

/**
 * Prazos, Fase 4 (migration 20261201120000_due_assist): who of the client's
 * teams delivers first, the late-risk warning of an open task and the
 * replanning of a person's tasks. The database does the math; the demo has
 * a simpler version of each.
 */

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const h = (minutes: number) => {
  const v = minutes / 60;
  return `${Number.isInteger(v) ? v : v.toFixed(1).replace(".", ",")} h`;
};

// ------------------------------------------------------------ quem entrega antes
export interface Candidate {
  user_id: string;
  name: string;
  due: string | null;
  source: "smart" | "rule" | null;
  open_minutes: number;
  away_today: boolean;
}

function demoCandidates(data: Snapshot, contract: string, start: string | null) {
  const client = data.contracts.find((k) => k.id === contract)?.client_id;
  const teams = new Set(
    data.clientTeams.filter((ct) => ct.client_id === client).map((ct) => ct.team_id),
  );
  const today = dateKey();
  const people = [
    ...new Set(data.teamMembers.filter((tm) => teams.has(tm.team_id)).map((tm) => tm.user_id)),
  ];
  return people
    .map((u): Candidate | null => {
      const m = data.members.find((x) => x.user_id === u && x.active);
      if (!m) return null;
      const rule = suggestDue(data, { contract, assignee: u, base: start || today });
      return {
        user_id: u,
        name: m.name,
        due: rule?.due ?? null,
        source: rule ? "rule" : null,
        open_minutes: data.tasks
          .filter((t) => t.assignee_id === u && t.status !== "done" && !t.archived)
          .reduce((s, t) => s + t.estimated_minutes, 0),
        away_today: absencesIn(data, u, today, today).length > 0,
      };
    })
    .filter((c): c is Candidate => !!c)
    .sort(
      (a, b) =>
        (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
        a.open_minutes - b.open_minutes ||
        a.name.localeCompare(b.name, "pt-BR"),
    );
}

/**
 * On the task form (sending to a person): on request, everyone of the teams
 * that serve the client with the date they would deliver (the MAVI's, or
 * the rule's) and what they have open. Picking one makes them responsible.
 */
export function WhoDeliversFirst({
  input,
  demo,
  data,
  current,
  onPick,
}: {
  input: {
    company: string;
    contract: string;
    project: string | null;
    start: string | null;
    approval: boolean;
    priority: Task["priority"];
    estimated: number;
  };
  demo: boolean;
  data: Snapshot;
  current: string;
  onPick: (user: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Candidate[] | null>(null);
  const [error, setError] = useState("");
  const key = JSON.stringify(input);
  // What was shown no longer fits another client or date.
  useEffect(() => setList(null), [key]);
  async function load() {
    setOpen((v) => !v);
    if (list || open) return;
    setError("");
    try {
      setList(
        demo
          ? demoCandidates(data, input.contract, input.start)
          : ((await rpc("smart_due_candidates", {
              p_company: input.company,
              p_contract: input.contract,
              p_project: input.project,
              p_start: input.start,
              p_approval: input.approval,
              p_priority: input.priority,
              p_estimated: input.estimated,
            })) as Candidate[]),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="who-first">
      <button type="button" className="who-first-toggle" aria-expanded={open} onClick={() => void load()}>
        <UsersRound size={13} aria-hidden="true" /> Quem entrega antes?
      </button>
      {open && (
        <div className="who-first-list" role="list">
          {error && <small className="form-error">{error}</small>}
          {!list && !error && <small className="who-first-empty">Calculando…</small>}
          {list && !list.length && (
            <small className="who-first-empty">Nenhuma equipe atende este cliente.</small>
          )}
          {list?.map((c) => (
            <button
              type="button"
              role="listitem"
              key={c.user_id}
              className={c.user_id === current ? "current" : ""}
              onClick={() => {
                onPick(c.user_id);
                setOpen(false);
              }}
            >
              <strong>{c.name}</strong>
              <span>
                {c.due ? dayLabel(c.due) : "sem prazo padrão"}
                {c.source === "smart" && " · MAVI"}
              </span>
              <small>
                {c.open_minutes ? `${h(c.open_minutes)} em aberto` : "nada em aberto"}
                {c.away_today && " · fora hoje"}
              </small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ risco
export interface DueRisk {
  risky: boolean;
  own: number;
  ahead: number;
  need: number;
  free: number;
  due: string;
}

/**
 * In the task's details: the MAVI's warning when what is left of it, plus
 * what the person has due before, passes their free hours until the due
 * date. Leaders get the way to replan that person's tasks.
 */
export function DueRiskNote({
  task,
  data,
  demo,
  refresh,
  onReplan,
}: {
  task: Task;
  data: Pick<Snapshot, "members">;
  demo: boolean;
  refresh: number;
  /** Given only to whoever may replan. */
  onReplan?: () => void;
}) {
  const [risk, setRisk] = useState<DueRisk | null>(null);
  const open = task.status !== "done" && !task.archived;
  useEffect(() => {
    setRisk(null);
    if (!open || demo) return;
    let alive = true;
    rpc("task_due_risk", { p_task: task.id })
      .then((r) => alive && setRisk(r as DueRisk | null))
      // A warning that fails to load is just not shown.
      .catch(() => null);
    return () => {
      alive = false;
    };
  }, [task.id, task.version, task.assignee_id, open, demo, refresh]);
  if (!risk?.risky) return null;
  const first = data.members.find((m) => m.user_id === task.assignee_id)?.name.split(" ")[0] ?? "Quem executa";
  return (
    <div className="due-risk-note" role="status">
      <AlertTriangle size={15} aria-hidden="true" />
      <span>
        <strong>A MAVI acha que esta tarefa pode atrasar.</strong>{" "}
        {risk.own
          ? `Faltam ${h(risk.own)} dela`
          : "Ela não tem estimativa"}
        {risk.ahead ? ` e ${first} tem ${h(risk.ahead)} vencendo antes` : ""}; até{" "}
        {dayLabel(risk.due)} há {h(risk.free)} livres.
      </span>
      {onReplan && (
        <button type="button" onClick={onReplan}>
          Replanejar tarefas de {first}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ replanejamento
export interface ReplanItem {
  task_id: string;
  title: string;
  contract_id: string;
  due: string;
  priority: Task["priority"];
  own_minutes: number;
  need_minutes: number;
  free_minutes: number;
  reason: "risk" | "off";
  helper: { user_id: string; name: string; slack: number } | null;
  push_due: string;
  proposal: { assignee: string; due: string };
}

/** The demo: tasks due on a day the person is away go to the next day they work. */
function demoProposal(data: Snapshot, user: string): ReplanItem[] {
  const off = personOff(data, user);
  const today = dateKey();
  if (!off) return [];
  return data.tasks
    .filter((t) => t.assignee_id === user && t.status !== "done" && !t.archived && t.due_date >= today && off(t.due_date))
    .map((t) => {
      const push = nextBusinessDay(data.calendarDays, t.due_date, off);
      return {
        task_id: t.id,
        title: t.title,
        contract_id: t.contract_id,
        due: t.due_date,
        priority: t.priority,
        own_minutes: t.estimated_minutes,
        need_minutes: t.estimated_minutes,
        free_minutes: 0,
        reason: "off",
        helper: null,
        push_due: push,
        proposal: { assignee: user, due: push },
      };
    });
}

type Choice = "helper" | "push" | "keep";

/**
 * The MAVI's plan for a person's tasks that are at risk or due on a day
 * they don't work: hand each to whoever of the team fits it by the due
 * date or, with nobody, move it to the first date it fits. The leader
 * picks per task and applies (apply_replan); nothing changes before.
 */
export function ReplanModal({
  company,
  user,
  data,
  demo,
  mutate,
  notify,
  onClose,
}: {
  company: string;
  user: string;
  data: Snapshot;
  demo: boolean;
  mutate: Mutate;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ReplanItem[] | null>(null);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = data.members.find((m) => m.user_id === user)?.name ?? "a pessoa";
  useEffect(() => {
    let alive = true;
    (demo
      ? Promise.resolve(demoProposal(data, user))
      : (rpc("replan_proposal", { p_company: company, p_user: user }) as Promise<ReplanItem[]>)
    )
      .then((list) => {
        if (!alive) return;
        setItems(list);
        setChoice(Object.fromEntries(list.map((i) => [i.task_id, i.helper ? "helper" : "push"])));
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
    // The plan is read once, when the window opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, user, demo]);
  const chosen = (items ?? []).filter((i) => choice[i.task_id] !== "keep");
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const result = (await mutate("apply_replan", {
        p_company: company,
        p_items: chosen.map((i) =>
          choice[i.task_id] === "helper"
            ? { task: i.task_id, assignee: i.helper!.user_id, due: null }
            : { task: i.task_id, assignee: null, due: i.push_due },
        ),
      })) as { applied: number; results: { ok: boolean; reason: string | null }[] } | null;
      const out = (result?.results ?? []).filter((r) => !r.ok);
      notify(
        [
          plural(result?.applied ?? chosen.length, "tarefa replanejada", "tarefas replanejadas"),
          out.length ? `${plural(out.length, "ficou de fora", "ficaram de fora")}: ${out[0].reason}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const client = (contract: string) => {
    const k = data.contracts.find((c) => c.id === contract);
    return data.clients.find((c) => c.id === k?.client_id)?.name ?? "";
  };
  return (
    <Modal title={`Replanejar tarefas de ${name}`} onClose={onClose} busy={busy} className="replan-modal">
      <div className="replan-body">
        <p className="replan-intro">
          A MAVI olhou as tarefas em aberto de {name.split(" ")[0]} nos próximos 60 dias que
          correm risco de atrasar ou vencem num dia em que a pessoa não trabalha. Escolha o que
          fazer com cada uma; nada muda antes de aplicar.
        </p>
        {!items && !error && <p className="replan-empty">Calculando…</p>}
        {items && !items.length && (
          <p className="replan-empty">
            <Check size={16} aria-hidden="true" /> Nenhuma tarefa de {name.split(" ")[0]} precisa de
            outro plano agora.
          </p>
        )}
        {items?.map((i) => (
          <fieldset className="replan-item" key={i.task_id}>
            <legend>
              <strong>{i.title}</strong>
              <small>
                {client(i.contract_id)} · vence {dayLabel(i.due)} ·{" "}
                {i.reason === "off"
                  ? `${name.split(" ")[0]} não trabalha nesse dia`
                  : `${h(i.need_minutes)} de trabalho para ${h(i.free_minutes)} livres`}
              </small>
            </legend>
            {i.helper && (
              <label>
                <input
                  type="radio"
                  name={`replan-${i.task_id}`}
                  checked={choice[i.task_id] === "helper"}
                  onChange={() => setChoice((c) => ({ ...c, [i.task_id]: "helper" }))}
                />
                <UsersRound size={14} aria-hidden="true" /> Passar para <strong>{i.helper.name}</strong>
                <small>mantém {dayLabel(i.due)}; sobram {h(i.helper.slack)} até lá</small>
              </label>
            )}
            <label>
              <input
                type="radio"
                name={`replan-${i.task_id}`}
                checked={choice[i.task_id] === "push"}
                onChange={() => setChoice((c) => ({ ...c, [i.task_id]: "push" }))}
              />
              <CalendarClock size={14} aria-hidden="true" /> Adiar para <strong>{dayLabel(i.push_due)}</strong>
              <small>o primeiro dia em que tudo cabe</small>
            </label>
            <label>
              <input
                type="radio"
                name={`replan-${i.task_id}`}
                checked={choice[i.task_id] === "keep"}
                onChange={() => setChoice((c) => ({ ...c, [i.task_id]: "keep" }))}
              />
              Manter como está
            </label>
          </fieldset>
        ))}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button className="btn secondary" disabled={busy} onClick={onClose}>
            Fechar
          </Button>
          {!!items?.length && (
            <Button className="btn primary" disabled={busy || !chosen.length} loading={busy} onClick={() => void apply()}>
              Aplicar em {plural(chosen.length, "tarefa", "tarefas")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

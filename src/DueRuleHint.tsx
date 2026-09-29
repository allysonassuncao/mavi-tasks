import { useState } from "react";
import { CalendarCheck, Palmtree, Sparkles } from "lucide-react";
import { Input, Textarea } from "./ui";
import { dateKey } from "./domain";
import {
  absencesIn,
  businessDaysLabel,
  personOff,
  ruleScope,
  suggestDue,
  type DueSuggestion,
} from "./dueRules";
import { dayLabel } from "./task-bulk";
import { smartReasons, type SmartDue } from "./smartDue";
import { absenceKinds, type Snapshot, type Task } from "./types";
import "./due-rules.css";

/**
 * Under a due date field: the rule behind the suggested date, a way back to
 * it once the date was changed by hand and, when the date is before the
 * rule's minimum, the reason the history keeps ("prazo apertado").
 */
export function DueRuleHint({
  data,
  suggestion,
  due,
  following,
  byTeam = false,
  shortening = true,
  alternative = false,
  reason,
  onReason,
  onApply,
}: {
  data: Pick<Snapshot, "projects" | "clients" | "products" | "teams" | "members">;
  suggestion: DueSuggestion | null;
  due: string;
  /** The date is the rule's (not picked by hand). */
  following: boolean;
  /** Sent to a team: the database counts again for whoever receives it. */
  byTeam?: boolean;
  /** Only a date moved earlier asks the reason (editing a task). */
  shortening?: boolean;
  /** The date is the MAVI's: the rule's is just the other option. */
  alternative?: boolean;
  reason: string;
  onReason: (value: string) => void;
  onApply: () => void;
}) {
  if (!suggestion) return null;
  const why = `${businessDaysLabel(suggestion.days)} · ${ruleScope(data, suggestion.rule)}`;
  const tight =
    !following && shortening && !!suggestion.min && !!due && due < suggestion.min;
  return (
    <>
      {following || due === suggestion.due ? (
        <small className="due-rule-note" title="Prazo padrão configurado em Equipe e configurações › Prazos">
          <CalendarCheck size={13} aria-hidden="true" />
          <span>
            Pela regra: {why}
            {byTeam && " — conta de novo para quem receber"}
          </span>
        </small>
      ) : (
        <small className={`due-rule-note${alternative ? "" : " differs"}`} role="status">
          <CalendarCheck size={13} aria-hidden="true" />
          <span>
            A regra {alternative ? "daria" : "sugere"} {dayLabel(suggestion.due)} ({why}).
          </span>
          <button type="button" onClick={onApply}>
            Aplicar
          </button>
        </small>
      )}
      {tight && (
        <label className="due-rule-reason">
          Por que antes do mínimo da regra, {dayLabel(suggestion.min!)}?
          <Textarea
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            placeholder="Ex.: o cliente antecipou o lançamento"
            required
            minLength={5}
            maxLength={500}
            rows={2}
          />
          <small>O motivo fica no histórico da tarefa.</small>
        </label>
      )}
    </>
  );
}

/**
 * The due date when editing a task: the rule's date is one click away
 * ("Aplicar" sends due_rule, so the database counts it and the date follows
 * the rule again); shortening it to before the minimum asks the reason.
 * Hidden fields carry both to the form's submit.
 */
export function TaskDueEdit({
  data,
  task,
  start,
}: {
  data: Parameters<typeof suggestDue>[0] &
    Pick<Snapshot, "projects" | "clients" | "products" | "teams" | "members">;
  task: Task;
  /** The start date being edited (the count starts there). */
  start: string;
}) {
  const [due, setDue] = useState(task.due_date);
  const [byRule, setByRule] = useState(false);
  const [reason, setReason] = useState("");
  const suggestion = suggestDue(data, {
    contract: task.contract_id,
    project: task.project_id,
    team: task.team_id,
    assignee: task.assignee_id,
    base: start || dateKey(new Date(task.created_at)),
    approval: task.requires_client_approval,
  });
  const following = byRule || (due === task.due_date && task.due_manual === false);
  return (
    <div className="due-rule-field">
      <label>
        Prazo
        <Input
          type="date"
          name="due"
          value={due}
          onChange={(e) => {
            setDue(e.target.value);
            setByRule(false);
          }}
          required
        />
      </label>
      <DueRuleHint
        data={data}
        suggestion={suggestion}
        due={due}
        following={following}
        shortening={due < task.due_date}
        reason={reason}
        onReason={setReason}
        onApply={() => {
          if (!suggestion) return;
          setDue(suggestion.due);
          setByRule(true);
        }}
      />
      <AbsenceNote data={data} assignee={task.assignee_id} due={due} />
      {byRule && <input type="hidden" name="due_rule" value="1" />}
      <input type="hidden" name="due_reason" value={reason} />
    </div>
  );
}

/**
 * Whoever executes is away before the due date: when, and whether the date
 * lands on a day they don't work (the rule's dates already skip those).
 */
export function AbsenceNote({
  data,
  assignee,
  due,
}: {
  data: Pick<Snapshot, "members" | "absences">;
  assignee: string | null | undefined;
  due: string;
}) {
  const today = dateKey();
  if (!assignee || !due) return null;
  const away = absencesIn(data, assignee, today, due);
  const offOnDue = personOff(data, assignee)?.(due);
  if (!away.length && !offOnDue) return null;
  const name = data.members.find((m) => m.user_id === assignee)?.name ?? "A pessoa";
  const periods = away
    .map((a) =>
      a.starts_on === a.ends_on
        ? `${absenceKinds[a.kind].toLowerCase()} em ${dayLabel(a.starts_on)}`
        : `${absenceKinds[a.kind].toLowerCase()} de ${dayLabel(a.starts_on)} a ${dayLabel(a.ends_on)}`,
    )
    .join("; ");
  return (
    <small className={`due-rule-note absence${offOnDue ? " differs" : ""}`} role="status">
      <Palmtree size={13} aria-hidden="true" />
      <span>
        {periods && `${name}: ${periods}. `}
        {offOnDue
          ? `O prazo cai num dia em que ${name.split(" ")[0]} não trabalha.`
          : "Os prazos pela regra já pulam esses dias."}
      </span>
    </small>
  );
}

/**
 * The MAVI's due date (prazo inteligente): the date, a way to use it and,
 * on request, why — history, workload, meetings, approval, rework.
 */
export function SmartDueHint({
  data,
  smart,
  using,
  due,
  byTeam = false,
  priority,
  onUse,
}: {
  data: Pick<Snapshot, "members">;
  smart: SmartDue | null;
  /** The date shown is the MAVI's. */
  using: boolean;
  due: string;
  byTeam?: boolean;
  priority: Task["priority"];
  onUse: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!smart?.available || !smart.due) return null;
  const who = data.members.find((m) => m.user_id === smart.assignee)?.name.split(" ")[0];
  const same = smart.due === due;
  return (
    <div className="smart-due-note" role="status">
      <Sparkles size={13} aria-hidden="true" />
      <span>
        {using ? (
          <>
            Prazo sugerido pela MAVI
            {byTeam && who ? `, para ${who} (quem a equipe daria agora)` : ""}.
          </>
        ) : same ? (
          <>A MAVI também sugere esta data.</>
        ) : (
          <>
            A MAVI sugere <strong>{dayLabel(smart.due)}</strong>
            {byTeam && who ? ` para ${who} (quem a equipe daria agora)` : ""}.
          </>
        )}
      </span>
      {!using && !same && (
        <button type="button" className="smart-due-use" onClick={onUse}>
          Usar
        </button>
      )}
      <button
        type="button"
        className="smart-due-why"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Por quê?
      </button>
      {open && (
        <ul>
          {smartReasons(smart, data, priority).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

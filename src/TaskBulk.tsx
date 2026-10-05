import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CircleAlert,
  CircleDot,
  Flag,
  Info,
  Minus,
  Plus,
  Undo2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { Avatar, Modal } from "./components";
import { Button, Input, Textarea } from "./ui";
import { dueReasonError } from "./task-due";
import { fold } from "./domain";
import {
  listedStatuses,
  priorities,
  statuses,
  type Snapshot,
  type Status,
  type Task,
} from "./types";
import { PRIORITY_RULE, isPrioritized, mayPrioritize } from "./task-priority";
import {
  NOTE_STATUSES,
  appliedMessage,
  describeChange,
  plural,
  sides,
  suggestionHint,
  undoMessage,
  type BulkChange,
  type BulkResult,
  type BulkUndo,
  type StatusAssignee,
} from "./task-bulk";

export type SelectState = "all" | "some" | "none";
/** How many of `ids` are selected: all, some or none. */
export function selectState(ids: string[], selected: Set<string>, all = false): SelectState {
  if (all && ids.length) return "all";
  const n = ids.filter((id) => selected.has(id)).length;
  return n === 0 ? "none" : n === ids.length ? "all" : "some";
}

/** A checkbox with the "some" state (a group partly selected). */
export function SelectBox({
  state,
  label,
  onToggle,
}: {
  state: SelectState;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      title={label}
      className={`select-box ${state === "none" ? "" : "on"}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {state === "all" && <Check size={12} strokeWidth={3} />}
      {state === "some" && <Minus size={12} strokeWidth={3} />}
    </button>
  );
}

type Panel = "assignee" | "due" | "status" | "priority" | null;

/**
 * The bar of a selection in the task list: how many are selected and the
 * changes that apply to all of them. Every change first opens the review
 * (the database's own dry run), then applies, with "Desfazer" right after.
 */
export function BulkEditor({
  count,
  data,
  me,
  resolveIds,
  run,
  undo,
  onClear,
  onDone,
}: {
  count: number;
  data: Snapshot;
  me: string;
  /** The selected tasks' ids (all of the filter's, when so chosen). */
  resolveIds: () => Promise<string[]>;
  run: (ids: string[], change: BulkChange, preview: boolean) => Promise<BulkResult>;
  undo: (operation: string) => Promise<BulkUndo>;
  onClear: () => void;
  /** After applying or undoing: reload what is on screen. */
  onDone: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [review, setReview] = useState<{
    change: BulkChange;
    ids: string[];
    result: BulkResult | null;
    error: string;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<{
    text: string;
    operation?: string | null;
    error?: boolean;
  } | null>(null);
  const [undoing, setUndoing] = useState(false);

  // The toast stays a while, long enough to undo.
  useEffect(() => {
    if (!toast || undoing) return;
    const timer = setTimeout(() => setToast(null), 12000);
    return () => clearTimeout(timer);
  }, [toast, undoing]);

  const memberName = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Usuário removido";
  const teamName = (id: string) =>
    data.teams.find((t) => t.id === id)?.name ?? "—";

  async function openReview(change: BulkChange) {
    setPanel(null);
    setReview({ change, ids: [], result: null, error: "" });
    try {
      const ids = await resolveIds();
      const result = await run(ids, change, true);
      setReview({ change, ids, result, error: "" });
    } catch (e) {
      setReview({ change, ids: [], result: null, error: errorText(e) });
    }
  }
  async function apply() {
    if (!review?.result) return;
    setApplying(true);
    try {
      const result = await run(review.ids, review.change, false);
      setReview(null);
      setToast({ text: appliedMessage(result), operation: result.operation });
      onClear();
      onDone();
    } catch (e) {
      setReview({ ...review, error: errorText(e) });
    } finally {
      setApplying(false);
    }
  }
  async function undoLast() {
    if (!toast?.operation) return;
    setUndoing(true);
    try {
      const r = await undo(toast.operation);
      setToast({ text: undoMessage(r) });
      onDone();
    } catch (e) {
      setToast({ text: errorText(e), error: true });
    } finally {
      setUndoing(false);
    }
  }

  return (
    <>
      {count > 0 && !review && (
        <div className="bulk-bar" role="toolbar" aria-label="Alterar as tarefas selecionadas">
          <span className="bulk-count">
            <b>{count}</b> {count === 1 ? "selecionada" : "selecionadas"}
          </span>
          <ActionPopover
            open={panel === "assignee"}
            onOpenChange={(o) => setPanel(o ? "assignee" : null)}
            icon={<UserRound size={16} />}
            label="Responsável"
          >
            <AssigneePanel data={data} me={me} onPick={openReview} />
          </ActionPopover>
          <ActionPopover
            open={panel === "due"}
            onOpenChange={(o) => setPanel(o ? "due" : null)}
            icon={<CalendarDays size={16} />}
            label="Prazo"
          >
            <DuePanel onPick={openReview} />
          </ActionPopover>
          <ActionPopover
            open={panel === "status"}
            onOpenChange={(o) => setPanel(o ? "status" : null)}
            icon={<CircleDot size={16} />}
            label="Status"
          >
            <StatusPanel data={data} me={me} onPick={openReview} />
          </ActionPopover>
          <ActionPopover
            open={panel === "priority"}
            onOpenChange={(o) => setPanel(o ? "priority" : null)}
            icon={<Flag size={16} />}
            label="Prioridade"
          >
            <PriorityPanel data={data} me={me} onPick={openReview} />
          </ActionPopover>
          <button
            type="button"
            className="bulk-clear"
            aria-label="Limpar seleção"
            title="Limpar seleção"
            onClick={onClear}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {review && (
        <BulkReview
          change={review.change}
          result={review.result}
          error={review.error}
          applying={applying}
          data={data}
          memberName={memberName}
          teamName={teamName}
          onBack={() => setReview(null)}
          onApply={apply}
        />
      )}
      {toast && count === 0 && !review && (
        <div className={`bulk-toast ${toast.error ? "error" : ""}`} role="status">
          <span className="bulk-toast-mark" aria-hidden="true">
            {toast.error ? <CircleAlert size={14} /> : <Check size={14} />}
          </span>
          <span>{toast.text}</span>
          {toast.operation && (
            <Button className="bulk-undo" loading={undoing} onClick={undoLast}>
              <Undo2 size={15} /> Desfazer
            </Button>
          )}
          <button
            type="button"
            className="bulk-clear"
            aria-label="Fechar aviso"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}

function errorText(e: unknown) {
  return e instanceof Error
    ? e.message
    : ((e as { message?: string })?.message ?? "Não foi possível concluir.");
}

function ActionPopover({
  open,
  onOpenChange,
  icon,
  label,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button type="button" className={`bulk-action ${open ? "on" : ""}`}>
          {icon}
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="bulk-panel"
          side="top"
          sideOffset={10}
          collisionPadding={12}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AssigneePanel({
  data,
  me,
  onPick,
}: {
  data: Snapshot;
  me: string;
  onPick: (change: BulkChange) => void;
}) {
  const [term, setTerm] = useState("");
  const people = useMemo(
    () =>
      data.members
        .filter((m) => m.active && fold(m.name).includes(fold(term)))
        .sort((a, b) =>
          a.user_id === me ? -1 : b.user_id === me ? 1 : a.name.localeCompare(b.name, "pt-BR"),
        ),
    [data.members, term, me],
  );
  const teams = useMemo(
    () =>
      data.teams
        .filter((t) => fold(t.name).includes(fold(term)))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.teams, term],
  );
  return (
    <>
      <h3>Trocar responsável</h3>
      <p className="bulk-panel-sub">Escolha uma pessoa ou deixe a equipe distribuir.</p>
      <Input
        type="search"
        aria-label="Buscar pessoa ou equipe"
        placeholder="Buscar pessoa ou equipe…"
        value={term}
        autoFocus
        onChange={(e) => setTerm(e.target.value)}
      />
      <div className="bulk-options">
        {teams.length > 0 && <p className="bulk-cap">Distribuir na equipe</p>}
        {teams.map((t) => (
          <button
            key={t.id}
            type="button"
            className="bulk-option"
            onClick={() => onPick({ kind: "team", value: t.id })}
          >
            <span className="bulk-team-icon" aria-hidden="true">
              <UsersRound size={15} />
            </span>
            <span className="bulk-option-text">
              {t.name}
              <small>Vai para quem tem menos tarefas em aberto</small>
            </span>
          </button>
        ))}
        {people.length > 0 && <p className="bulk-cap">Uma pessoa</p>}
        {people.map((m) => (
          <button
            key={m.user_id}
            type="button"
            className="bulk-option"
            onClick={() => onPick({ kind: "assignee", value: m.user_id })}
          >
            <Avatar name={m.name} src={m.avatar_url} size="small" />
            <span className="bulk-option-text">
              {m.name}
              {m.user_id === me && <small>Você</small>}
            </span>
          </button>
        ))}
        {!people.length && !teams.length && (
          <p className="bulk-empty">Ninguém encontrado.</p>
        )}
      </div>
    </>
  );
}

function DuePanel({ onPick }: { onPick: (change: BulkChange) => void }) {
  const [mode, setMode] = useState<"shift" | "due" | "rule">("shift");
  const [days, setDays] = useState(1);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const n = Math.abs(days);
  // Every due date change asks why (migration 20270110090000).
  const why = { reason: reason.trim() };
  const reasonOk = !dueReasonError(reason);
  return (
    <>
      <h3>Mudar prazo</h3>
      <p className="bulk-panel-sub">Só a data muda. Aprovações e status continuam como estão.</p>
      <div className="bulk-seg" role="group" aria-label="Como mudar o prazo">
        {(
          [
            ["shift", "Adiar ou antecipar"],
            ["due", "Data fixa"],
            ["rule", "Pela regra"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            className={mode === id ? "on" : ""}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "shift" ? (
        <>
          <div className="bulk-step">
            <button
              type="button"
              aria-label="Um dia útil a menos"
              onClick={() => setDays((d) => Math.max(-365, d - 1 || -1))}
            >
              <Minus size={16} />
            </button>
            <output aria-live="polite">{n}</output>
            <button
              type="button"
              aria-label="Um dia útil a mais"
              onClick={() => setDays((d) => Math.min(365, d + 1 || 1))}
            >
              <Plus size={16} />
            </button>
            <span>
              {n === 1 ? "dia útil" : "dias úteis"} {days > 0 ? "depois" : "antes"}
            </span>
          </div>
          <p className="bulk-hint">
            Cada tarefa anda a partir do próprio prazo, então o espaçamento entre elas se mantém.
            Fins de semana e feriados são pulados.
          </p>
        </>
      ) : mode === "due" ? (
        <>
          <label className="bulk-field">
            Novo prazo para todas
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <p className="bulk-hint">
            Tarefas que começam depois dessa data ficam de fora, e a revisão mostra quais.
          </p>
        </>
      ) : (
        <p className="bulk-hint">
          Cada tarefa ganha o prazo da regra que vale para ela (Prazos, em Equipe e configurações),
          e o prazo volta a seguir a regra. As que não têm regra ficam de fora.
        </p>
      )}
      <label className="bulk-field">
        Motivo da mudança de prazo
        <Textarea
          rows={2}
          maxLength={1000}
          value={reason}
          required
          placeholder="Ex.: o cliente atrasou o envio do material"
          onChange={(e) => setReason(e.target.value)}
        />
        <small className="bulk-hint">
          Obrigatório. Fica no histórico de cada tarefa, conta nos Dashboards e vale como
          justificativa quando um prazo fica antes do mínimo da regra.
        </small>
      </label>
      <div className="bulk-panel-foot">
        <Button
          className="btn primary"
          disabled={!reasonOk || (mode === "due" ? !date : mode === "shift" ? days === 0 : false)}
          onClick={() =>
            onPick(
              mode === "due"
                ? { kind: "due", value: date, ...why }
                : mode === "shift"
                  ? { kind: "shift", value: days, ...why }
                  : { kind: "rule", ...why },
            )
          }
        >
          Revisar alterações
        </Button>
      </div>
    </>
  );
}

/**
 * The status, then (but for Entregue) who holds each task from now on, as
 * one by one: whom the new status suggests in each task, one person for all,
 * or each keeps its responsible. The statuses that need a description ask it
 * in the same step.
 */
function StatusPanel({
  data,
  me,
  onPick,
}: {
  data: Snapshot;
  me: string;
  onPick: (change: BulkChange) => void;
}) {
  const [target, setTarget] = useState<Status | null>(null);
  const [note, setNote] = useState("");
  const [who, setWho] = useState<StatusAssignee>("suggested");
  const [term, setTerm] = useState("");
  const people = useMemo(
    () =>
      data.members
        .filter((m) => m.active && fold(m.name).includes(fold(term)))
        .sort((a, b) =>
          a.user_id === me ? -1 : b.user_id === me ? 1 : a.name.localeCompare(b.name, "pt-BR"),
        ),
    [data.members, term, me],
  );
  const ask = target ? NOTE_STATUSES[target] : undefined;
  if (target) {
    const choice = (value: StatusAssignee, label: string, hint: string) => (
      <button
        type="button"
        role="radio"
        aria-checked={who === value}
        className={`bulk-option ${who === value ? "on" : ""}`}
        onClick={() => setWho(value)}
      >
        <span className="bulk-radio" aria-hidden="true" />
        <span className="bulk-option-text">
          {label}
          <small>{hint}</small>
        </span>
      </button>
    );
    return (
      <>
        <h3>{statuses[target].label}</h3>
        {ask && (
          <>
            <p className="bulk-panel-sub">
              O texto entra no comentário de cada tarefa, como quando se muda uma por uma.
            </p>
            <label className="bulk-field">
              {ask}
              <Textarea
                rows={3}
                value={note}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </>
        )}
        <p className="bulk-cap">Responsável a partir de agora</p>
        <div className="bulk-options" role="radiogroup" aria-label="Responsável a partir de agora">
          {choice("suggested", "Sugerido para cada tarefa", suggestionHint(target))}
          {choice("keep", "Manter o responsável de cada uma", "Ninguém troca de responsável")}
          <p className="bulk-cap">Uma pessoa para todas</p>
          <Input
            type="search"
            aria-label="Buscar pessoa"
            placeholder="Buscar pessoa…"
            value={term}
            autoFocus={!ask}
            onChange={(e) => setTerm(e.target.value)}
          />
          {people.map((m) => (
            <button
              key={m.user_id}
              type="button"
              role="radio"
              aria-checked={who === m.user_id}
              className={`bulk-option ${who === m.user_id ? "on" : ""}`}
              onClick={() => setWho(m.user_id)}
            >
              <Avatar name={m.name} src={m.avatar_url} size="small" />
              <span className="bulk-option-text">
                {m.name}
                {m.user_id === me && <small>Você</small>}
              </span>
              {who === m.user_id && <Check size={15} className="bulk-option-check" />}
            </button>
          ))}
          {!people.length && <p className="bulk-empty">Ninguém encontrado.</p>}
        </div>
        <div className="bulk-panel-foot">
          <Button className="btn secondary" onClick={() => setTarget(null)}>
            Voltar
          </Button>
          <Button
            className="btn primary"
            disabled={!!ask && note.trim().length < 3}
            onClick={() =>
              onPick({
                kind: "status",
                value: target,
                ...(ask ? { note: note.trim() } : {}),
                assignee: who,
              })
            }
          >
            Revisar alterações
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <h3>Mudar status</h3>
      <p className="bulk-panel-sub">As tarefas que você não pode mover ficam de fora.</p>
      <div className="bulk-options">
        {listedStatuses.map((s) => (
          <button
            key={s}
            type="button"
            className="bulk-option"
            onClick={() =>
              // Entregue keeps the responsible, as one by one.
              s === "done" ? onPick({ kind: "status", value: s }) : setTarget(s)
            }
          >
            <span className={`badge ${s}`}>
              <i style={{ background: statuses[s].color }} />
              {statuses[s].label}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Alta e Urgente só para quem pode marcar (gestor, admin ou quem tem o
 * recurso "Marcar prioridade"); o banco confere cada tarefa e deixa de fora
 * as que a pessoa não pode mudar.
 */
function PriorityPanel({
  data,
  me,
  onPick,
}: {
  data: Snapshot;
  me: string;
  onPick: (change: BulkChange) => void;
}) {
  const mayMark = mayPrioritize(data, me);
  const order: Task["priority"][] = ["urgent", "high", "normal", "low"];
  return (
    <>
      <h3>Mudar prioridade</h3>
      <p className="bulk-panel-sub">{PRIORITY_RULE}</p>
      <div className="bulk-options">
        {order.map((p) => (
          <button
            key={p}
            type="button"
            className="bulk-option"
            disabled={isPrioritized(p) && !mayMark}
            onClick={() => onPick({ kind: "priority", value: p })}
          >
            <span className={`priority-flag priority-${p}`}>
              <Flag size={13} fill="currentColor" />
              {priorities[p]}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function BulkReview({
  change,
  result,
  error,
  applying,
  data,
  memberName,
  teamName,
  onBack,
  onApply,
}: {
  change: BulkChange;
  result: BulkResult | null;
  error: string;
  applying: boolean;
  data: Snapshot;
  memberName: (id: string) => string;
  teamName: (id: string) => string;
  onBack: () => void;
  onApply: () => void;
}) {
  const titles = useMemo(
    () => new Map((result?.results ?? []).map((r) => [r.id, r.title])),
    [result],
  );
  const where = (contractId?: string, parentId?: string | null) => {
    if (parentId) {
      const parent =
        titles.get(parentId) ?? data.tasks.find((t) => t.id === parentId)?.title;
      if (parent) return `Subtarefa de ${parent}`;
    }
    const k = data.contracts.find((c) => c.id === contractId);
    const client = data.clients.find((c) => c.id === k?.client_id)?.name;
    const product = data.products.find((p) => p.id === k?.product_id)?.name;
    return [client, product].filter(Boolean).join(" / ");
  };
  const changed = result?.results.filter((r) => r.ok) ?? [];
  const skipped = result?.results.filter((r) => !r.ok) ?? [];
  const dueOnly =
    change.kind === "due" ||
    change.kind === "shift" ||
    change.kind === "rule" ||
    change.kind === "priority";
  return (
    <Modal title="Revisar alterações" onClose={onBack} busy={applying} className="bulk-review">
      <div className="bulk-review-head">
        <p>{describeChange(change, { member: memberName, team: teamName })}</p>
        {result && (
          <div className="bulk-pills">
            <span className="bulk-pill ok">
              <Check size={13} /> {plural(changed.length, "será alterada", "serão alteradas")}
            </span>
            {skipped.length > 0 && (
              <span className="bulk-pill warn">
                {plural(skipped.length, "fica de fora", "ficam de fora")}
              </span>
            )}
            {dueOnly && <span className="bulk-pill info">Aprovações e status não mudam</span>}
          </div>
        )}
      </div>
      <div className="bulk-review-body">
        {error ? (
          <p className="bulk-review-error" role="alert">
            <CircleAlert size={16} /> {error}
          </p>
        ) : !result ? (
          <p className="bulk-review-loading" aria-live="polite">
            Conferindo cada tarefa…
          </p>
        ) : (
          <>
            {changed.length > 0 && <p className="bulk-cap">Serão alteradas</p>}
            {changed.map((r) => {
              const s = sides(r, change, memberName);
              return (
                <div className="bulk-row" key={r.id}>
                  <span className="bulk-row-task">
                    <strong>{r.title}</strong>
                    <small>{where(r.contract_id, r.parent_id)}</small>
                  </span>
                  <span className="bulk-before">{s?.before}</span>
                  <ArrowRight size={15} className="bulk-arrow" aria-label="para" />
                  <span className="bulk-after">{s?.after}</span>
                </div>
              );
            })}
            {skipped.length > 0 && <p className="bulk-cap">Ficam de fora</p>}
            {skipped.map((r) => (
              <div className="bulk-row skipped" key={r.id}>
                <span className="bulk-row-task">
                  <strong>{r.title ?? "Tarefa sem acesso"}</strong>
                  <small>{where(r.contract_id, r.parent_id)}</small>
                </span>
                <span className="bulk-why">
                  <Info size={14} /> {r.reason}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="bulk-review-foot">
        <small>Dá para desfazer logo depois de aplicar.</small>
        <span>
          <Button className="btn secondary" onClick={onBack} disabled={applying}>
            Voltar
          </Button>
          <Button
            className="btn primary"
            loading={applying}
            disabled={!result || !changed.length}
            onClick={onApply}
          >
            {`Aplicar em ${plural(changed.length, "tarefa", "tarefas")}`}
          </Button>
        </span>
      </div>
    </Modal>
  );
}

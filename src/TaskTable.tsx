import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpDown,
  CalendarDays,
  Check,
  ChevronRight,
  Flag,
  Layers,
  Pause,
  Play,
  TriangleAlert,
} from "lucide-react";
import { Button, Select, SelectOption } from "./ui";
import { Avatar, Badge, Empty } from "./components";
import { dateLabel, durationWithSeconds, isLate, namesFrom, type NameLookup } from "./domain";
import { readClosedGroups, writeClosedGroups } from "./remembered-filters";
import { SelectBox, selectState } from "./TaskBulk";
import { PriorityTag, priorityClass } from "./TaskPriority";
import {
  GROUP_OPTIONS,
  SORT_OPTIONS,
  THEN_OPTIONS,
  groupSummary,
  nestSubtasks,
  type GroupBy,
  type TaskGroup,
} from "./task-grouping";
import { statuses, type Task, type TimeEntry } from "./types";
import { useTaskSeconds } from "./useTaskTime";

/**
 * The user's running timers, as the lists need them to mark their tasks —
 * more than one with Várias tarefas ao mesmo tempo (memberships.multi_timer).
 */
export type Playing = {
  /** Oldest first. */
  entries: TimeEntry[];
  hours: TimeEntry[];
  company: string;
  demo: boolean;
};
/** The running entry on a task, if any. */
export function runningOn(playing: Playing | null | undefined, taskId: string) {
  return playing?.entries.find((e) => e.task_id === taskId);
}
/**
 * Live total time of a task being played (every session, not just this
 * one): the given task, or the one started last.
 */
export function TaskTotal({
  playing,
  taskId,
}: {
  playing: Playing;
  taskId?: string;
}) {
  const entry =
    (taskId ? runningOn(playing, taskId) : undefined) ??
    playing.entries[playing.entries.length - 1];
  const seconds = useTaskSeconds({
    company: playing.company,
    taskId: entry.task_id,
    hours: playing.hours,
    running: entry,
    demo: playing.demo,
  });
  return <>{durationWithSeconds(seconds)}</>;
}
/** Marks a task whose timer the user is running, with the task's total time. */
export function PlayingBadge({
  playing,
  taskId,
}: {
  playing: Playing;
  taskId: string;
}) {
  return (
    <span className="playing-badge" title="Seu cronômetro está nesta tarefa">
      <span className="playing-pulse" aria-hidden="true" />
      Em execução · <TaskTotal playing={playing} taskId={taskId} />
    </span>
  );
}
export function TaskTable({
  tasks,
  groups,
  me,
  lookup,
  today,
  playing,
  timer,
  onSelect,
  selection,
  parentTitle,
  rememberGroups,
  growBy,
  growKey,
  renderTitle,
  renderNote,
}: {
  tasks: Task[];
  /** Sections (e.g. "Para você", a pack), each maybe with a second level. */
  groups?: TaskGroup[];
  /** The viewer: their own tasks and creations are marked "Você". */
  me?: string;
  lookup: NameLookup;
  today: string;
  /** The user's running timers, marked on their tasks. */
  playing?: Playing | null;
  /**
   * Play/pause on the rows (the "Para você" tab): shown on hover, and always
   * on a task whose timer runs; not on tasks the person cannot time.
   */
  timer?: {
    canStart: (t: Task) => boolean;
    toggle: (t: Task, running?: TimeEntry) => void;
    /** The task whose play or pause is being saved. */
    pending?: string | null;
    /** What starting does to the other running tasks (the tooltip). */
    startNote?: string;
  };
  onSelect: (id: string) => void;
  /** Checkboxes for a bulk edit: per task, per section and the whole page. */
  selection?: {
    picked: Set<string>;
    /** Every task under the filters is selected. */
    all: boolean;
    toggle: (ids: string[]) => void;
  };
  /** Name of a main task that is in another section or page. */
  parentTitle?: (id: string) => string | undefined;
  /**
   * Keeps the closed sections in this browser, per company, person and way
   * of splitting, so pages, reloads and live updates keep them as left.
   */
  rememberGroups?: { company: string; user: string; split: string };
  /**
   * With sections: about this many rows at first, and as many more on each
   * "Carregar mais" (a closed section counts as one row). Back to the first
   * rows when `growKey` changes (other filters); live updates keep them.
   */
  growBy?: number;
  growKey?: string;
  /** The title as shown (e.g. the searched term marked). */
  renderTitle?: (t: Task) => ReactNode;
  /** A line under the client, e.g. where the search found the term. */
  renderNote?: (t: Task) => ReactNode;
}) {
  const memory = rememberGroups
    ? `${rememberGroups.company}|${rememberGroups.user}|${rememberGroups.split}`
    : "";
  const loadClosed = () =>
    rememberGroups
      ? readClosedGroups(
          rememberGroups.split,
          rememberGroups.company,
          rememberGroups.user,
        )
      : new Set<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(loadClosed);
  // Another split (or person): its own closed sections.
  const [loadedMemory, setLoadedMemory] = useState(memory);
  if (loadedMemory !== memory) {
    setLoadedMemory(memory);
    setCollapsed(loadClosed());
  }
  // Main tasks whose subtasks are hidden.
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [rowLimit, setRowLimit] = useState(growBy ?? Infinity);
  const [grownFor, setGrownFor] = useState(growKey);
  if (grownFor !== growKey) {
    setGrownFor(growKey);
    setRowLimit(growBy ?? Infinity);
  }
  const flip =
    (set: typeof setCollapsed) =>
    (key: string) =>
      set((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
  const toggle = flip(setCollapsed),
    fold = flip(setFolded);
  // Only what the person changed is written (a new split just reads).
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current || !rememberGroups) return;
    writeClosedGroups(
      rememberGroups.split,
      rememberGroups.company,
      rememberGroups.user,
      collapsed,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);
  const check = (ids: string[], label: string) =>
    selection ? (
      <SelectBox
        state={selectState(ids, selection.picked, selection.all)}
        label={label}
        onToggle={() => selection.toggle(ids)}
      />
    ) : null;
  const row = (
    t: Task,
    opts: {
      kids?: Task[];
      open?: boolean;
      isChild?: boolean;
      elsewhere?: string | null;
      nests?: boolean;
    } = {},
  ) => {
    const n = namesFrom(lookup, t),
      creator = lookup.members.get(t.creator_id),
      runningEntry = runningOn(playing, t.id),
      isPlaying = !!runningEntry,
      mineToDo = !!me && t.assignee_id === me,
      mineCreated = !!me && t.creator_id === me,
      kids = opts.kids ?? [],
      picked =
        !!selection && (selection.all || selection.picked.has(t.id));
    const parent = opts.elsewhere
      ? (parentTitle?.(opts.elsewhere) ?? "outra tarefa")
      : null;
    const classes = [
      priorityClass(t.priority),
      isPlaying && "is-playing",
      picked && "is-picked",
      opts.isChild && "is-subtask",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <tr key={t.id} className={classes || undefined}>
        {selection && (
          <td className="col-select">
            {check(
              [t.id, ...kids.map((k) => k.id)],
              kids.length
                ? `Selecionar ${t.title} e as subtarefas`
                : `Selecionar ${t.title}`,
            )}
          </td>
        )}
        <td>
          <div className="task-cell">
            {kids.length > 0 ? (
              <button
                type="button"
                className="subtask-toggle"
                aria-expanded={opts.open}
                aria-label={`${opts.open ? "Ocultar" : "Mostrar"} as subtarefas de ${t.title}`}
                onClick={() => fold(t.id)}
              >
                <ChevronRight
                  size={15}
                  className={opts.open ? "open" : ""}
                  aria-hidden="true"
                />
              </button>
            ) : (
              opts.nests && <span className="subtask-spacer" />
            )}
            <Button className="task-title" onClick={() => onSelect(t.id)}>
              {/* With the selection checkbox beside it, a second box confuses. */}
              {!selection && (
                <span
                  className={`task-check ${t.status === "done" ? "complete" : ""}`}
                >
                  {t.status === "done" && <Check size={13} />}
                </span>
              )}
              <span>
                <strong>
                  <PriorityTag priority={t.priority} />
                  {renderTitle?.(t) ?? t.title}
                </strong>
                <small>
                  {parent ? (
                    <>Subtarefa de {parent}</>
                  ) : (
                    <>
                      {n.client?.name} <span> / </span> {n.product?.name}
                    </>
                  )}
                </small>
                {renderNote?.(t)}
                {isPlaying && playing && (
                  <PlayingBadge playing={playing} taskId={t.id} />
                )}
                <span className="mobile-status">
                  <Badge status={t.status} />
                </span>
              </span>
            </Button>
            {kids.length > 0 && (
              <span className="subtask-count">
                {kids.length} {kids.length === 1 ? "subtarefa" : "subtarefas"}
              </span>
            )}
            {timer && (runningEntry || timer.canStart(t)) && (
              <Button
                className={`row-timer${runningEntry ? " is-running" : ""}`}
                loading={timer.pending === t.id}
                disabled={!!timer.pending}
                title={
                  runningEntry
                    ? "Pausar o cronômetro"
                    : `Iniciar o cronômetro${timer.startNote ? ` — ${timer.startNote}` : ""}`
                }
                aria-label={`${runningEntry ? "Pausar" : "Iniciar"} o cronômetro de ${t.title}`}
                onClick={() => timer.toggle(t, runningEntry)}
              >
                {runningEntry ? (
                  <Pause size={13} fill="currentColor" aria-hidden="true" />
                ) : (
                  <Play size={13} fill="currentColor" aria-hidden="true" />
                )}
              </Button>
            )}
          </div>
        </td>
        <td className="col-status">
          <Badge status={t.status} />
        </td>
        <td>
          <span className={`due ${isLate(t, today) ? "late" : ""}`}>
            <CalendarDays size={14} />
            {t.due_date === today ? "Hoje" : dateLabel(t.due_date)}
            {isLate(t, today) && <span className="late-dot" />}
          </span>
        </td>
        <td className="col-assignee">
          <span className="task-person" title={n.member?.name}>
            <Avatar
              name={n.member?.name ?? "?"}
              src={n.member?.avatar_url}
              size="small"
            />
            {mineToDo ? (
              <span className="you-tag">Você</span>
            ) : (
              <span className="task-person-name">
                {n.member?.name?.split(" ")[0]}
              </span>
            )}
          </span>
        </td>
        <td className="col-creator">
          <span className="task-person">
            <Avatar
              name={creator?.name ?? "?"}
              src={creator?.avatar_url}
              size="small"
            />
            {mineCreated ? (
              <span className="you-tag">Você</span>
            ) : (
              (creator?.name ?? "Usuário removido")
            )}
          </span>
        </td>
      </tr>
    );
  };
  // A section's rows: subtasks under their main task when both are in it.
  const rows = (list: Task[], limit = Infinity) => {
    const nodes = nestSubtasks(list);
    const nests = nodes.some((node) => node.children.length > 0);
    return nodes.slice(0, limit).flatMap((node) => {
      const open = !folded.has(node.task.id);
      return [
        row(node.task, {
          kids: node.children,
          open,
          elsewhere: node.parentElsewhere,
          nests,
        }),
        ...(open
          ? node.children.map((c) => row(c, { isChild: true, nests }))
          : []),
      ];
    });
  };
  // A closed section's people: one shows as in the rows; more, as a stack.
  const people = (ids: string[], role: string) => {
    const names = ids.map(
      (id) => lookup.members.get(id)?.name ?? "Usuário removido",
    );
    if (ids.length === 1) {
      const m = lookup.members.get(ids[0]);
      return (
        <span className="task-person" title={names[0]}>
          <Avatar name={names[0]} src={m?.avatar_url} size="small" />
          {ids[0] === me ? (
            <span className="you-tag">Você</span>
          ) : (
            <span className="task-person-name">{names[0].split(" ")[0]}</span>
          )}
        </span>
      );
    }
    const shown = ids.slice(0, 3);
    return (
      <span
        className="group-people"
        title={`${ids.length} ${role}: ${names.join(", ")}`}
        aria-label={`${ids.length} ${role}: ${names.join(", ")}`}
      >
        {shown.map((id, i) => (
          <Avatar
            key={id}
            name={names[i]}
            src={lookup.members.get(id)?.avatar_url}
            size="small"
          />
        ))}
        {ids.length > shown.length && (
          <span className="group-people-more">+{ids.length - shown.length}</span>
        )}
      </span>
    );
  };
  const dueText = (day: string) => (day === today ? "Hoje" : dateLabel(day));
  // "28 set." — a span of two dates stays on one line.
  const shortDue = (day: string) =>
    day === today ? "Hoje" : dateLabel(day).replace(" de ", " ");
  // Closed, a section fills the columns with a digest of its tasks (worked
  // out only then; open, its rows already say it).
  const digest = (g: TaskGroup, open: () => void) => {
    const s = groupSummary(g.tasks, today);
    return (
      <>
        <td className="col-status group-digest" onClick={open}>
          {s.statuses.length === 1 ? (
            <Badge status={s.statuses[0][0]} />
          ) : (
            <span
              className="group-statuses"
              aria-label={s.statuses
                .map(([st, n]) => `${statuses[st]?.label ?? st}: ${n}`)
                .join(", ")}
            >
              {s.statuses.map(([st, n]) => (
                <span
                  key={st}
                  className="group-status"
                  title={`${statuses[st]?.label ?? st}: ${n}`}
                >
                  <i style={{ background: statuses[st]?.color }} />
                  {n}
                </span>
              ))}
            </span>
          )}
        </td>
        <td className="group-digest" onClick={open}>
          {s.firstDue ? (
            <span
              className={`due ${s.late ? "late" : ""}`}
              title={
                s.firstDue === s.lastDue
                  ? "Prazo das tarefas em aberto"
                  : "Do prazo mais próximo ao mais distante das tarefas em aberto"
              }
            >
              <CalendarDays size={14} />
              {s.lastDue === s.firstDue
                ? dueText(s.firstDue)
                : `${shortDue(s.firstDue)} – ${shortDue(s.lastDue)}`}
              {s.late > 0 && <span className="late-dot" />}
            </span>
          ) : (
            <span className="due">
              <Check size={14} /> Concluídas
            </span>
          )}
        </td>
        <td className="col-assignee group-digest" onClick={open}>
          {people(s.assignees, "responsáveis")}
        </td>
        <td className="col-creator group-digest" onClick={open}>
          {people(s.creators, "criadores")}
        </td>
      </>
    );
  };
  const head = (g: TaskGroup, level: 0 | 1) => {
    const closed = collapsed.has(g.key),
      late = g.tasks.filter((t) => isLate(t, today)).length,
      // Prioridades: as abertas com Urgente e com Alta, cada uma no seu selo.
      open = g.tasks.filter((t) => t.status !== "done"),
      urgent = open.filter((t) => t.priority === "urgent").length,
      high = open.filter((t) => t.priority === "high").length;
    const flipGroup = () => {
      touched.current = true;
      toggle(g.key);
    };
    return (
      <tr className={`task-group-head level-${level}`} key={`head:${g.key}`}>
        {selection && (
          <th className="col-select">
            {check(
              g.tasks.map((t) => t.id),
              `Selecionar todas de ${g.label}`,
            )}
          </th>
        )}
        <th colSpan={closed ? 1 : 5} scope="rowgroup">
          <button type="button" aria-expanded={!closed} onClick={flipGroup}>
            <ChevronRight
              size={15}
              className={closed ? "" : "open"}
              aria-hidden="true"
            />
            <strong>{g.label}</strong>
            <span className="task-group-count">{g.tasks.length}</span>
            {urgent > 0 && (
              <span
                className="task-group-priority priority-tag-urgent"
                title={`${urgent} ${urgent === 1 ? "tarefa" : "tarefas"} com prioridade Urgente`}
              >
                <Flag size={11} fill="currentColor" aria-hidden="true" />
                {urgent} {urgent === 1 ? "urgente" : "urgentes"}
              </span>
            )}
            {high > 0 && (
              <span
                className="task-group-priority priority-tag-high"
                title={`${high} ${high === 1 ? "tarefa" : "tarefas"} com prioridade Alta`}
              >
                <Flag size={11} fill="currentColor" aria-hidden="true" />
                {high} {high === 1 ? "alta" : "altas"}
              </span>
            )}
            {late > 0 && (
              <span className="task-group-late">
                <TriangleAlert size={12} aria-hidden="true" />
                {late} {late === 1 ? "atrasada" : "atrasadas"}
              </span>
            )}
            <small>{g.hint}</small>
          </button>
        </th>
        {closed && digest(g, flipGroup)}
      </tr>
    );
  };
  // The sections that fit the rows shown so far (at least one).
  const shownGroups: TaskGroup[] = [];
  if (groups) {
    let used = 0;
    for (const g of groups) {
      if (shownGroups.length && used >= rowLimit) break;
      shownGroups.push(g);
      used += collapsed.has(g.key) ? 1 : g.tasks.length + 1;
    }
  }
  const hiddenGroups = (groups?.length ?? 0) - shownGroups.length;
  // Without sections, the main tasks (with their subtasks) a batch at a time.
  const mains = groups ? 0 : nestSubtasks(tasks).length;
  const hiddenRows = groups || !growBy ? 0 : Math.max(0, mains - rowLimit);
  return (
    <>
      <div className="table-scroll">
        <table className={`task-table ${selection ? "selectable" : ""}`}>
          <thead>
            <tr>
              {selection && (
                <th className="col-select">
                  {tasks.length > 0 &&
                    check(
                      tasks.map((t) => t.id),
                      "Selecionar todas as tarefas",
                    )}
                </th>
              )}
              <th>Tarefa</th>
              <th className="col-status">Status</th>
              <th>Prazo</th>
              <th className="col-assignee">Responsável</th>
              <th className="col-creator">Criado por</th>
            </tr>
          </thead>
          {groups ? (
            shownGroups.map((g) => (
              <tbody key={g.key} className="task-group">
                {head(g, 0)}
                {!collapsed.has(g.key) &&
                  (g.children
                    ? g.children.flatMap((sub) => [
                        head(sub, 1),
                        ...(collapsed.has(sub.key) ? [] : rows(sub.tasks)),
                      ])
                    : rows(g.tasks))}
              </tbody>
            ))
          ) : (
            <tbody>{rows(tasks, growBy ? rowLimit : Infinity)}</tbody>
          )}
        </table>
      </div>
      {(hiddenGroups > 0 || hiddenRows > 0) && (
        <div className="task-list-more">
          <Button
            className="btn secondary"
            onClick={() => setRowLimit((n) => n + (growBy ?? 0))}
          >
            Carregar mais
          </Button>
          <small>
            {groups
              ? `${shownGroups.length} de ${groups.length} grupos`
              : `Mais ${hiddenRows} ${hiddenRows === 1 ? "tarefa" : "tarefas"}`}
          </small>
        </div>
      )}
      {!tasks.length && (
        <Empty
          title="Tudo livre por aqui"
          body="Nenhuma tarefa corresponde a esta seleção."
        />
      )}
    </>
  );
}

/**
 * "Ordenar por", "Agrupar por … e depois por …": the list's own controls,
 * shared by the task list and the advanced search.
 */
export function ListArrange<S extends string>({
  sort,
  sortOptions = SORT_OPTIONS as { id: S; label: string }[],
  onSort,
  group,
  then,
  groupOptions = GROUP_OPTIONS,
  onGroup,
  onThen,
  showGroup = true,
}: {
  sort: S;
  sortOptions?: { id: S; label: string }[];
  onSort: (value: S) => void;
  group: GroupBy;
  then: GroupBy;
  groupOptions?: { id: GroupBy; label: string }[];
  onGroup: (value: GroupBy) => void;
  onThen: (value: GroupBy) => void;
  /** Only the order (e.g. the board, whose columns are the statuses). */
  showGroup?: boolean;
}) {
  return (
    <>
      <span className="group-pick">
        <ArrowUpDown size={15} aria-hidden="true" />
        Ordenar por
        <Select
          aria-label="Ordenar por"
          value={sort}
          onValueChange={(v) => onSort(v as S)}
        >
          {sortOptions.map((o) => (
            <SelectOption key={o.id} value={o.id}>
              {o.label}
            </SelectOption>
          ))}
        </Select>
      </span>
      {showGroup && (
        <>
          <span className="group-pick">
            <Layers size={15} aria-hidden="true" />
            Agrupar por
            <Select
              aria-label="Agrupar por"
              value={group}
              onValueChange={(v) => {
                onGroup(v as GroupBy);
                if (v === then) onThen("none");
              }}
            >
              {groupOptions.map((o) => (
                <SelectOption key={o.id} value={o.id}>
                  {o.label}
                </SelectOption>
              ))}
            </Select>
          </span>
          <span className="group-pick">
            e depois por
            <Select
              aria-label="E depois por"
              value={then}
              onValueChange={(v) => onThen(v as GroupBy)}
            >
              {THEN_OPTIONS.filter((o) => o.id !== group).map((o) => (
                <SelectOption key={o.id} value={o.id}>
                  {o.label}
                </SelectOption>
              ))}
            </Select>
          </span>
        </>
      )}
    </>
  );
}

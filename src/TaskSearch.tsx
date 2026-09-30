import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, TriangleAlert, X } from "lucide-react";
import { Button, Input, Select, SelectOption } from "./ui";
import { Empty, Loading } from "./components";
import { buildNameLookup, dateKey } from "./domain";
import { navigate, useUrlState } from "./router";
import { readFilters, writeFilters } from "./remembered-filters";
import { BulkEditor } from "./TaskBulk";
import { ListArrange, TaskTable, type Playing } from "./TaskTable";
import type { BulkChange, BulkResult, BulkUndo } from "./task-bulk";
import {
  GROUP_OPTIONS,
  SEARCH_SORT_OPTIONS,
  compareTasks,
  groupTasks,
  parseGroupBy,
  parseSearchSort,
  withSubgroups,
  type TaskGroup,
} from "./task-grouping";
import {
  listedStatuses,
  statuses,
  type Comment,
  type Snapshot,
  type Task,
} from "./types";
import {
  SEARCH_FIELDS,
  hasCriteria,
  highlightParts,
  searchTaskRows,
  searchTaskRowsLocal,
  type SearchField,
  type TaskSearchHit,
  type TaskSearchParams,
  type TaskSearchRows,
} from "./task-search";

/**
 * The search's filters (URL params) kept for the next visit, with the term;
 * the order and the split too, as the task list keeps its own.
 */
const FILTER_PARAMS = [
  "em",
  "cli",
  "proj",
  "resp",
  "criador",
  "situacao",
  "de",
  "ate",
  "ordenar",
  "agrupar",
  "depois",
] as const;
/** Splits of the search: the list's, but the tab's own (there is no tab). */
const SEARCH_GROUPS = GROUP_OPTIONS.filter((o) => o.id !== "auto");

const MATCH_LABEL: Record<TaskSearchHit["match_in"], string> = {
  title: "Título",
  description: "Descrição",
  comment: "Comentário",
  filters: "",
};

/**
 * Advanced task search: title, description and comments, delivered tasks
 * included, with filters. Criteria live in the URL, so opening a result and
 * closing it comes back to the same search. The tasks found show in the task
 * list's own table: order, split, closed sections' digest, bulk edit.
 */
export function TaskSearch({
  data,
  company,
  user,
  demo,
  demoComments,
  onOpen,
  onBack,
  runBulk,
  undoBulk,
  onBulkDone,
  playing,
}: {
  data: Snapshot;
  company: string;
  user: string;
  demo: boolean;
  demoComments: () => Comment[];
  onOpen: (taskId: string) => void;
  onBack: () => void;
  /** The same bulk edit as the task list's, over the tasks found. */
  runBulk: (
    ids: string[],
    change: BulkChange,
    preview: boolean,
  ) => Promise<BulkResult>;
  undoBulk: (operation: string) => Promise<BulkUndo>;
  onBulkDone: () => void;
  /** The person's running timer, marked on its task as in the list. */
  playing?: Playing | null;
}) {
  const [query, setQuery] = useUrlState<string>("termo", "");
  const [fieldsParam, setFieldsParam] = useUrlState<string>("em", "");
  const [client, setClient] = useUrlState<string>("cli", "");
  const [project, setProject] = useUrlState<string>("proj", "");
  const [assignee, setAssignee] = useUrlState<string>("resp", "");
  const [creator, setCreator] = useUrlState<string>("criador", "");
  const [status, setStatus] = useUrlState<string>("situacao", "");
  const [from, setFrom] = useUrlState<string>("de", "");
  const [to, setTo] = useUrlState<string>("ate", "");
  const [sortParam, setSortParam] = useUrlState<string>("ordenar", "");
  const [groupParam, setGroupParam] = useUrlState<string>("agrupar", "none");
  const [thenParam, setThenParam] = useUrlState<string>("depois", "none");
  const sort = parseSearchSort(sortParam);
  const groupBy = parseGroupBy(groupParam, "none");
  const thenChoice = parseGroupBy(thenParam, "none");
  const thenBy =
    groupBy === "auto" || thenChoice === "auto" || thenChoice === groupBy
      ? "none"
      : thenChoice;
  const [text, setText] = useState(query);
  const [found, setFound] = useState<TaskSearchRows | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);

  // Opened without filters, the search brings back the person's last ones;
  // without a term, the last term too (a term typed in the list's quick
  // search, carried here, wins over it).
  // Whose filters are on screen ("company:user"), once restored.
  const [filtersFor, setFiltersFor] = useState("");
  useEffect(() => {
    const url = new URL(window.location.href);
    const saved = readFilters<Record<string, string>>("search", company, user);
    if (saved) {
      if (!FILTER_PARAMS.some((k) => url.searchParams.has(k)))
        for (const k of FILTER_PARAMS)
          if (typeof saved[k] === "string" && saved[k])
            url.searchParams.set(k, saved[k]);
      if (!url.searchParams.get("termo") && typeof saved.termo === "string") {
        if (saved.termo) url.searchParams.set("termo", saved.termo);
        setText(saved.termo);
      }
      navigate(url.pathname + url.search + url.hash, true);
    }
    setFiltersFor(`${company}:${user}`);
  }, [company, user]);
  const savedFilters = JSON.stringify({
    termo: query,
    em: fieldsParam,
    cli: client,
    proj: project,
    resp: assignee,
    criador: creator,
    situacao: status,
    de: from,
    ate: to,
    ordenar: sortParam,
    agrupar: groupParam === "none" ? "" : groupParam,
    depois: thenParam === "none" ? "" : thenParam,
  });
  useEffect(() => {
    if (filtersFor === `${company}:${user}`)
      writeFilters("search", company, user, JSON.parse(savedFilters));
  }, [filtersFor, savedFilters, company, user]);

  // Typing updates the URL (and so the search) after a short pause.
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 350);
    return () => clearTimeout(id);
  }, [text, setQuery]);

  const fields = useMemo<SearchField[]>(() => {
    const chosen = fieldsParam
      .split(",")
      .filter((f): f is SearchField => SEARCH_FIELDS.some((s) => s.id === f));
    return chosen.length ? chosen : SEARCH_FIELDS.map((f) => f.id);
  }, [fieldsParam]);
  const params: TaskSearchParams = useMemo(
    () => ({
      query,
      fields,
      client,
      project,
      assignee,
      creator,
      status,
      from,
      to,
    }),
    [query, fields, client, project, assignee, creator, status, from, to],
  );
  const active = hasCriteria(params);

  // Every task found at once (up to SEARCH_CAP): the sections come whole
  // and the table shows them a batch at a time ("Carregar mais").
  function run(quiet = false) {
    const id = ++request.current;
    setError("");
    if (!quiet) setLoading(true);
    (demo
      ? Promise.resolve(searchTaskRowsLocal(data, demoComments(), user, params))
      : searchTaskRows(company, params)
    )
      .then((rows) => {
        if (id === request.current) setFound(rows);
      })
      .catch((e) => {
        if (id === request.current) setError((e as Error).message);
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
  }
  useEffect(() => {
    if (!active) {
      request.current++;
      setFound(null);
      setLoading(false);
      return;
    }
    run();
    // `run` reads the current params; re-run only when they change.
  }, [params, active, company, demo]);

  // Tasks picked for a bulk edit, among the ones found.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const clearPicked = useCallback(() => setPicked(new Set()), []);
  useEffect(clearPicked, [params, company, clearPicked]);
  function togglePicked(ids: string[]) {
    setPicked((prev) => {
      const on = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }
  function afterBulk() {
    onBulkDone();
    // The results stay on screen while they are read again.
    run(true);
  }

  function toggleField(id: SearchField) {
    const next = fields.includes(id)
      ? fields.filter((f) => f !== id)
      : [...fields, id];
    // At least one place to search; all of them is the default (no param).
    if (!next.length) return;
    setFieldsParam(next.length === SEARCH_FIELDS.length ? "" : next.join(","));
  }
  function clearAll() {
    setText("");
    setQuery("");
    setFieldsParam("");
    setClient("");
    setProject("");
    setAssignee("");
    setCreator("");
    setStatus("");
    setFrom("");
    setTo("");
  }

  const clients = data.clients
    .filter((c) => !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const contractIds = new Set(
    data.contracts
      .filter((k) => !client || k.client_id === client)
      .map((k) => k.id),
  );
  const projects = data.projects
    .filter((p) => !p.archived && contractIds.has(p.contract_id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const people = data.members
    .filter((m) => m.active)
    .sort((a, b) => a.name.localeCompare(b.name));
  const total = found?.total ?? 0;

  // The list's table: its order, its split, its sections.
  const lookup = useMemo(() => buildNameLookup(data), [data]);
  const timezone =
    data.companies.find((c) => c.id === company)?.timezone ??
    "America/Sao_Paulo";
  const today = dateKey(new Date(), timezone);
  const tasks = useMemo(
    () => [...(found?.tasks ?? [])].sort(compareTasks(sort)),
    [found, sort],
  );
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const groups: TaskGroup[] | undefined = useMemo(() => {
    const ctx = { lookup, today, timezone, sort };
    if (groupBy === "none")
      return thenBy === "none" ? undefined : groupTasks(tasks, thenBy, ctx);
    return withSubgroups(groupTasks(tasks, groupBy, ctx), thenBy, ctx);
  }, [tasks, groupBy, thenBy, lookup, today, timezone, sort]);
  const marked = (value: string) =>
    highlightParts(value, query).map((p, i) =>
      p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
    );
  const titleOf = (t: Task) =>
    found?.matches.get(t.id)?.match_in === "title" ? marked(t.title) : t.title;
  const noteOf = (t: Task) => {
    const m = found?.matches.get(t.id);
    if (!m || m.match_in === "title" || m.match_in === "filters") return null;
    return (
      <span className="task-search-snippet">
        <em>{MATCH_LABEL[m.match_in]}:</em> {marked(m.snippet)}
      </span>
    );
  };

  return (
    <section className="panel task-search">
      <header className="task-search-head">
        <Button className="text-btn" onClick={onBack}>
          <ArrowLeft size={15} /> Voltar para tarefas
        </Button>
        <h2>Busca avançada</h2>
        <p>
          Procure no título, na descrição e nos comentários — inclusive em
          tarefas entregues.
        </p>
      </header>

      <div className="task-search-box">
        <Search size={20} aria-hidden="true" />
        <input
          type="search"
          autoFocus
          aria-label="Termo da busca"
          placeholder="O que você procura? Ex.: briefing, logotipo, reunião…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {text && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Limpar termo"
            onClick={() => setText("")}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="task-search-in" role="group" aria-label="Procurar em">
        <span>Procurar em</span>
        {SEARCH_FIELDS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`filter-chip ${fields.includes(f.id) ? "selected" : ""}`}
            aria-pressed={fields.includes(f.id)}
            onClick={() => toggleField(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="task-search-filters">
        <Select
          aria-label="Cliente"
          value={client}
          onValueChange={(v) => {
            setClient(v);
            setProject("");
          }}
        >
          <SelectOption value="">Todos os clientes</SelectOption>
          {clients.map((c) => (
            <SelectOption key={c.id} value={c.id}>
              {c.name}
            </SelectOption>
          ))}
        </Select>
        <Select aria-label="Projeto" value={project} onValueChange={setProject}>
          <SelectOption value="">Todos os projetos</SelectOption>
          {projects.map((p) => (
            <SelectOption key={p.id} value={p.id}>
              {p.name}
            </SelectOption>
          ))}
        </Select>
        <Select
          aria-label="Responsável"
          value={assignee}
          onValueChange={setAssignee}
        >
          <SelectOption value="">Qualquer responsável</SelectOption>
          {people.map((m) => (
            <SelectOption key={m.user_id} value={m.user_id}>
              {m.name}
            </SelectOption>
          ))}
        </Select>
        <Select
          aria-label="Criado por"
          value={creator}
          onValueChange={setCreator}
        >
          <SelectOption value="">Qualquer criador</SelectOption>
          {people.map((m) => (
            <SelectOption key={m.user_id} value={m.user_id}>
              {m.name}
            </SelectOption>
          ))}
        </Select>
        <Select aria-label="Status" value={status} onValueChange={setStatus}>
          <SelectOption value="">Todos os status</SelectOption>
          {listedStatuses.map((k) => (
            <SelectOption key={k} value={k}>
              {statuses[k].label}
            </SelectOption>
          ))}
        </Select>
        <label className="task-search-date">
          <span>Prazo de</span>
          <Input
            type="date"
            aria-label="Prazo a partir de"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="task-search-date">
          <span>até</span>
          <Input
            type="date"
            aria-label="Prazo até"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        {active && (
          <Button className="text-btn" onClick={clearAll}>
            Limpar tudo <X size={14} />
          </Button>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {!active ? (
        <Empty
          title="Comece pela busca"
          body="Digite um termo ou escolha um filtro. Tarefas entregues também aparecem aqui."
        />
      ) : loading ? (
        <Loading compact />
      ) : !tasks.length ? (
        <Empty
          title="Nada encontrado"
          body="Tente outro termo, procure em mais lugares ou remova algum filtro."
        />
      ) : (
        <>
          <div className="task-search-count">
            <p role="status">
              {total === 1
                ? "1 tarefa encontrada"
                : `${total} tarefas encontradas`}
            </p>
            <div className="list-tools">
              <ListArrange
                sort={sort}
                sortOptions={SEARCH_SORT_OPTIONS}
                onSort={(v) => setSortParam(v === "relevance" ? "" : v)}
                group={groupBy}
                then={thenBy}
                groupOptions={SEARCH_GROUPS}
                onGroup={setGroupParam}
                onThen={setThenParam}
              />
            </div>
          </div>
          {total > tasks.length && (
            <p className="task-list-capped" role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              Mostrando as primeiras {tasks.length} das {total} tarefas
              encontradas. Use os filtros para ver as outras.
            </p>
          )}
          <TaskTable
            tasks={tasks}
            groups={groups}
            me={user}
            lookup={lookup}
            today={today}
            playing={playing}
            onSelect={onOpen}
            selection={{ picked, all: false, toggle: togglePicked }}
            parentTitle={(id) => byId.get(id)?.title}
            rememberGroups={{
              company,
              user,
              split: `busca:${groupBy}>${thenBy}`,
            }}
            growBy={50}
            growKey={`${company}|${JSON.stringify(params)}|${sort}|${groupBy}|${thenBy}`}
            renderTitle={titleOf}
            renderNote={noteOf}
          />
        </>
      )}
      <BulkEditor
        count={picked.size}
        data={data}
        me={user}
        resolveIds={async () => [...picked]}
        run={runBulk}
        undo={undoBulk}
        onClear={clearPicked}
        onDone={afterBulk}
      />
    </section>
  );
}

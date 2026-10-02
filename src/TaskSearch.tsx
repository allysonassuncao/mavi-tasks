import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Flag, Sparkles, TriangleAlert, X } from "lucide-react";
import { Button, Input } from "./ui";
import { MultiPick } from "./MultiPick";
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
  highlightTerms,
  readMaviSearch,
  requestMaviSearch,
  searchTaskRows,
  searchTaskRowsLocal,
  searchTaskRowsMavi,
  writeMaviSearch,
  type SearchField,
  type TaskSearchHit,
  type TaskSearchParams,
  type TaskSearchRows,
} from "./task-search";
import {
  MAVI_FILTER_KEYS,
  MAVI_PARAM,
  filterValues,
  readPrepared,
  type MaviSearch,
  type PreparedSearch,
  type MaviSearchFilters,
} from "./task-search-mavi";

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
  "prioritarias",
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
  meaning: "Pelo sentido",
  filters: "",
};

/** The MAVI on a request: asking, what she understood, or why she couldn't. */
type MaviState =
  | { key: string; status: "asking" }
  | { key: string; status: "ready"; search: MaviSearch }
  | { key: string; status: "failed"; error: string };

/**
 * Advanced task search: title, description and comments, delivered tasks
 * included, with filters. Criteria live in the URL, so opening a result and
 * closing it comes back to the same search. The tasks found show in the task
 * list's own table: order, split, closed sections' digest, bulk edit.
 *
 * Every request typed goes through the MAVI (on Enter): she fills the
 * screen's filters, writes the terms and their variations and the subject's
 * vector, and the database searches with them (search_task_rows_mavi). What
 * she understood is kept in the tab, so changing a filter, or opening a task
 * and coming back, doesn't ask her again. When she fails, the exact words
 * are searched.
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
  const [prioritized, setPrioritized] = useUrlState<boolean>("prioritarias", false);
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
    // A link with filters of its own (a person's "Ver tarefas", the MAVI's
    // "Ver na Busca avançada") shows just those: neither the saved filters
    // nor the saved term.
    const linked =
      FILTER_PARAMS.some((k) => url.searchParams.has(k)) || url.searchParams.has("mavi");
    if (saved) {
      if (!linked)
        for (const k of FILTER_PARAMS)
          if (typeof saved[k] === "string" && saved[k])
            url.searchParams.set(k, saved[k]);
      if (
        !linked &&
        !url.searchParams.get("termo") &&
        typeof saved.termo === "string"
      ) {
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
    prioritarias: prioritized ? "1" : "",
    ordenar: sortParam,
    agrupar: groupParam === "none" ? "" : groupParam,
    depois: thenParam === "none" ? "" : thenParam,
  });
  useEffect(() => {
    if (filtersFor === `${company}:${user}`)
      writeFilters("search", company, user, JSON.parse(savedFilters));
  }, [filtersFor, savedFilters, company, user]);

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
      priority: prioritized,
    }),
    [query, fields, client, project, assignee, creator, status, from, to, prioritized],
  );
  const active = hasCriteria(params);
  const timezone =
    data.companies.find((c) => c.id === company)?.timezone ??
    "America/Sao_Paulo";
  const today = dateKey(new Date(), timezone);

  // The MAVI on the request in the URL: what she understood comes from the
  // tab's memory or from asking her (and then fills the screen's filters).
  const maviKey = `${company}|${user}|${query}`;
  const [mavi, setMavi] = useState<MaviState | null>(null);
  const [retry, setRetry] = useState(0);
  // "Tentar de novo" asks her again even with an answer kept in the tab.
  const forceAsk = useRef(false);
  const maviRequest = useRef(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  // A search the MAVI built in the conversation ("Ver na Busca avançada"):
  // its terms and filters come in the link (read once, as the page opens);
  // only the subject's vector is made again. Its part leaves the URL.
  const fromLink = useRef<{ query: string; search: PreparedSearch } | null | undefined>(undefined);
  if (fromLink.current === undefined) {
    const link = new URL(window.location.href).searchParams;
    const search = readPrepared(link.get("mavi"));
    fromLink.current = search ? { query: (link.get("termo") ?? "").trim(), search } : null;
  }
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("mavi")) return;
    url.searchParams.delete("mavi");
    navigate(url.pathname + url.search + url.hash, true);
  }, []);
  useEffect(() => {
    if (!query || demo) {
      maviRequest.current++;
      setMavi(null);
      return;
    }
    const prepared =
      fromLink.current?.query === query ? fromLink.current.search : null;
    const cached = forceAsk.current || prepared ? null : readMaviSearch(maviKey);
    forceAsk.current = false;
    if (cached) {
      setMavi({ key: maviKey, status: "ready", search: cached });
      return;
    }
    const id = ++maviRequest.current;
    setMavi({ key: maviKey, status: "asking" });
    const now = paramsRef.current;
    requestMaviSearch({
      company,
      query,
      today,
      filters: {
        client: now.client,
        project: now.project,
        assignee: now.assignee,
        creator: now.creator,
        status: now.status,
        from: now.from,
        to: now.to,
        priority: now.priority,
        fields: now.fields,
      },
      ...(prepared ? { prepared } : {}),
    })
      .then((search) => {
        if (id !== maviRequest.current) return;
        writeMaviSearch(maviKey, search);
        // The prepared search's filters are already on the screen.
        if (prepared) fromLink.current = null;
        else applyMaviFilters(search.filters);
        setMavi({ key: maviKey, status: "ready", search });
      })
      .catch((e) => {
        if (id !== maviRequest.current) return;
        setMavi({ key: maviKey, status: "failed", error: (e as Error).message });
      });
    // Asked again only when the request (or a retry) changes.
  }, [maviKey, query, demo, retry]);
  const understood =
    mavi?.key === maviKey && mavi.status === "ready" ? mavi.search : null;
  // Nothing to search with (no terms, no subject, no filter on the screen):
  // the exact words.
  const usable =
    understood &&
    (understood.terms.length ||
      understood.embedding ||
      MAVI_FILTER_KEYS.some((k) => understood.filters[k]) ||
      understood.filters.priority ||
      hasCriteria({ ...params, query: "" }))
      ? understood
      : null;
  const asking = !!query && !demo && (mavi?.key !== maviKey || mavi.status === "asking");
  const maviFailed =
    mavi?.key === maviKey && mavi.status === "failed" ? mavi.error : "";

  /** The filters she understood, on the screen (one URL change). */
  function applyMaviFilters(f: MaviSearchFilters) {
    const url = new URL(window.location.href);
    const set = (param: string, value: string) =>
      value ? url.searchParams.set(param, value) : url.searchParams.delete(param);
    for (const k of MAVI_FILTER_KEYS)
      if (typeof f[k] === "string") set(MAVI_PARAM[k], f[k]!);
    // Projects bring their clients; clients of her own drop the projects of
    // other clients.
    const ownerOf = (id: string) => {
      const contract = data.projects.find((p) => p.id === id)?.contract_id;
      return data.contracts.find((k) => k.id === contract)?.client_id ?? "";
    };
    const picked = filterValues(url.searchParams.get("proj"));
    if (f.project && picked.length)
      set("cli", [...new Set(picked.map(ownerOf).filter(Boolean))].join(","));
    else if (picked.length && f.client) {
      const allowed = filterValues(f.client);
      set("proj", picked.filter((id) => allowed.includes(ownerOf(id))).join(","));
    }
    if (typeof f.priority === "boolean") set("prioritarias", f.priority ? "1" : "");
    if (f.fields?.length)
      set("em", f.fields.length >= SEARCH_FIELDS.length ? "" : f.fields.join(","));
    navigate(url.pathname + url.search + url.hash, true);
  }
  function dropTerm(term: string) {
    if (!understood) return;
    const search = { ...understood, terms: understood.terms.filter((t) => t !== term) };
    writeMaviSearch(maviKey, search);
    setMavi({ key: maviKey, status: "ready", search });
  }
  function submit() {
    const next = text.trim();
    if (next !== query) setQuery(next);
    // The same request again, after she failed: ask her once more.
    else if (maviFailed) askAgain();
  }
  function askAgain() {
    forceAsk.current = true;
    setRetry((n) => n + 1);
  }

  // Every task found at once (up to SEARCH_CAP): the sections come whole
  // and the table shows them a batch at a time ("Carregar mais").
  function run(quiet = false) {
    const id = ++request.current;
    setError("");
    if (!quiet) setLoading(true);
    (demo
      ? Promise.resolve(searchTaskRowsLocal(data, demoComments(), user, params))
      : query && usable
        ? searchTaskRowsMavi(company, usable, params)
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
    // While the MAVI reads the request, the search waits for her.
    if (asking) {
      request.current++;
      setLoading(true);
      return;
    }
    run();
    // `run` reads the current params; re-run only when they (or what the
    // MAVI understood) change.
  }, [params, active, company, demo, asking, usable]);

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
    setPrioritized(false);
  }

  const clients = data.clients
    .filter((c) => !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const pickedClients = filterValues(client);
  const contractIds = new Set(
    data.contracts
      .filter((k) => !pickedClients.length || pickedClients.includes(k.client_id))
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
  const marks = usable?.terms.length ? usable.terms : [query];
  const marked = (value: string) =>
    highlightTerms(value, marks).map((p, i) =>
      p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
    );
  const titleOf = (t: Task) => {
    const m = found?.matches.get(t.id)?.match_in;
    return m && m !== "filters" ? marked(t.title) : t.title;
  };
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
          Peça do seu jeito: a MAVI entende o pedido, preenche os filtros e
          procura no título, na descrição e nos comentários, pelas palavras e
          pelo sentido, inclusive em tarefas entregues.
        </p>
      </header>

      <form
        className="task-search-box"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Sparkles size={20} aria-hidden="true" className="task-search-mavi-icon" />
        <input
          type="search"
          autoFocus
          aria-label="O que você procura"
          placeholder="Peça à MAVI. Ex.: artes de Black Friday que a Ana entregou em setembro"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setQuery("");
          }}
        />
        {text && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Limpar busca"
            onClick={() => {
              setText("");
              setQuery("");
            }}
          >
            <X size={16} />
          </button>
        )}
        <Button
          type="submit"
          className="btn primary task-search-go"
          disabled={!text.trim() || (asking && text.trim() === query)}
        >
          Buscar
        </Button>
      </form>
      {query && !demo && (
        <MaviUnderstood
          asking={asking}
          failed={maviFailed}
          search={usable}
          onDrop={dropTerm}
          onRetry={askAgain}
        />
      )}

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
        <MultiPick
          label="Cliente"
          allLabel="Todos os clientes"
          noun="clientes"
          options={clients.map((c) => ({ value: c.id, label: c.name }))}
          value={pickedClients}
          onChange={(next) => {
            setClient(next.join(","));
            // The projects of clients no longer picked leave too.
            const owners = new Set(
              data.contracts
                .filter((k) => !next.length || next.includes(k.client_id))
                .map((k) => k.id),
            );
            setProject(
              filterValues(project)
                .filter((id) => owners.has(data.projects.find((p) => p.id === id)?.contract_id ?? ""))
                .join(","),
            );
          }}
        />
        <MultiPick
          label="Projeto"
          allLabel="Todos os projetos"
          noun="projetos"
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          value={filterValues(project)}
          onChange={(next) => setProject(next.join(","))}
        />
        <MultiPick
          label="Responsável"
          allLabel="Qualquer responsável"
          noun="responsáveis"
          options={people.map((m) => ({ value: m.user_id, label: m.name }))}
          value={filterValues(assignee)}
          onChange={(next) => setAssignee(next.join(","))}
        />
        <MultiPick
          label="Criado por"
          allLabel="Qualquer criador"
          noun="criadores"
          options={people.map((m) => ({ value: m.user_id, label: m.name }))}
          value={filterValues(creator)}
          onChange={(next) => setCreator(next.join(","))}
        />
        <MultiPick
          label="Status"
          allLabel="Todos os status"
          noun="status"
          options={listedStatuses.map((k) => ({ value: k, label: statuses[k].label }))}
          value={filterValues(status)}
          onChange={(next) => setStatus(next.join(","))}
        />
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
        <Button
          className={`filter-chip priority-chip ${prioritized ? "selected" : ""}`}
          aria-pressed={prioritized}
          title="Só as tarefas com prioridade Alta ou Urgente"
          onClick={() => setPrioritized(!prioritized)}
        >
          <Flag size={15} /> Prioritárias
        </Button>
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
          body="Escreva o que você procura e aperte Enter, ou escolha um filtro. Tarefas entregues também aparecem aqui."
        />
      ) : loading ? (
        <Loading compact />
      ) : !tasks.length ? (
        <Empty
          title="Nada encontrado"
          body="Peça de outro jeito, procure em mais lugares ou remova algum filtro."
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

/**
 * What the MAVI understood of the request, under the box: her sentence, the
 * terms she searched (each can be taken out) and whether the search by
 * meaning ran. When she fails, why — and that the exact words were searched.
 */
function MaviUnderstood({
  asking,
  failed,
  search,
  onDrop,
  onRetry,
}: {
  asking: boolean;
  failed: string;
  search: MaviSearch | null;
  onDrop: (term: string) => void;
  onRetry: () => void;
}) {
  if (asking)
    return (
      <p className="task-search-mavi is-asking" role="status">
        <Sparkles size={14} aria-hidden="true" /> A MAVI está entendendo o pedido…
      </p>
    );
  if (failed)
    return (
      <p className="task-search-mavi is-failed" role="status">
        <TriangleAlert size={14} aria-hidden="true" />
        <span>
          A MAVI não respondeu agora ({failed.replace(/[.\s]+$/, "")}). Mostrando
          a busca pelas palavras exatas.
        </span>
        <Button className="text-btn" onClick={onRetry}>
          Tentar de novo
        </Button>
      </p>
    );
  if (!search) return null;
  return (
    <div className="task-search-mavi" role="status">
      <p title={search.model ? `Modelo: ${search.model}` : undefined}>
        <Sparkles size={14} aria-hidden="true" />
        <span>
          <strong>A MAVI entendeu:</strong>{" "}
          {search.summary || "procurando pelas palavras abaixo."}
        </span>
      </p>
      {(search.terms.length > 0 || search.embedding) && (
        <div className="task-search-mavi-terms">
          {search.terms.length > 0 && <span>Procurando por</span>}
          {search.terms.map((t) => (
            <span key={t} className="task-search-term">
              {t}
              {search.terms.length ? (
                <button
                  type="button"
                  aria-label={`Tirar “${t}” da busca`}
                  onClick={() => onDrop(t)}
                >
                  <X size={12} />
                </button>
              ) : null}
            </span>
          ))}
          {search.embedding && (
            <span className="task-search-meaning">
              {search.terms.length ? "e pelo sentido" : "Procurando pelo sentido"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

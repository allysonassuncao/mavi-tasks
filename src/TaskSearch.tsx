import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, Search, X } from "lucide-react";
import { Button, Input, Select, SelectOption } from "./ui";
import { Avatar, Badge, Empty, Loading } from "./components";
import { dateLabel } from "./domain";
import { useUrlState } from "./router";
import { listedStatuses, statuses, type Comment, type Snapshot } from "./types";
import {
  SEARCH_FIELDS,
  hasCriteria,
  highlightParts,
  searchTasks,
  searchTasksLocal,
  type SearchField,
  type TaskSearchHit,
  type TaskSearchParams,
} from "./task-search";

const MATCH_LABEL: Record<TaskSearchHit["match_in"], string> = {
  title: "Título",
  description: "Descrição",
  comment: "Comentário",
  filters: "",
};

/**
 * Advanced task search: title, description and comments, delivered tasks
 * included, with filters. Criteria live in the URL, so opening a result and
 * closing it comes back to the same search.
 */
export function TaskSearch({
  data,
  company,
  user,
  demo,
  demoComments,
  onOpen,
  onBack,
}: {
  data: Snapshot;
  company: string;
  user: string;
  demo: boolean;
  demoComments: () => Comment[];
  onOpen: (taskId: string) => void;
  onBack: () => void;
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
  const [text, setText] = useState(query);
  const [hits, setHits] = useState<TaskSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);

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

  function run(offset: number) {
    const id = ++request.current;
    setError("");
    if (offset) setMore(true);
    else setLoading(true);
    const search = demo
      ? Promise.resolve(
          searchTasksLocal(data, demoComments(), user, { ...params, offset }),
        )
      : searchTasks(company, { ...params, offset });
    search
      .then((rows) => {
        if (id !== request.current) return;
        setHits((list) => (offset ? [...list, ...rows] : rows));
      })
      .catch((e) => {
        if (id === request.current) setError((e as Error).message);
      })
      .finally(() => {
        if (id === request.current) {
          setLoading(false);
          setMore(false);
        }
      });
  }
  useEffect(() => {
    if (!active) {
      request.current++;
      setHits([]);
      setLoading(false);
      return;
    }
    run(0);
    // `run` reads the current params; re-run only when they change.
  }, [params, active, company, demo]);

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
  const member = (id: string) => data.members.find((m) => m.user_id === id);
  const total = hits[0]?.total ?? 0;

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
      ) : !hits.length ? (
        <Empty
          title="Nada encontrado"
          body="Tente outro termo, procure em mais lugares ou remova algum filtro."
        />
      ) : (
        <>
          <p className="task-search-count" role="status">
            {total === 1
              ? "1 tarefa encontrada"
              : `${total} tarefas encontradas`}
          </p>
          <ol className="task-search-results">
            {hits.map((h) => {
              const contract = data.contracts.find(
                (k) => k.id === h.contract_id,
              );
              const clientName = data.clients.find(
                (c) => c.id === contract?.client_id,
              )?.name;
              const productName = data.products.find(
                (p) => p.id === contract?.product_id,
              )?.name;
              const projectName = data.projects.find(
                (p) => p.id === h.project_id,
              )?.name;
              const who = member(h.assignee_id);
              return (
                <li key={h.task_id}>
                  <button
                    type="button"
                    className="task-search-hit"
                    onClick={() => onOpen(h.task_id)}
                  >
                    <span className="task-search-hit-top">
                      <strong>
                        {h.match_in === "title"
                          ? highlightParts(h.title, query).map((p, i) =>
                              p.match ? (
                                <mark key={i}>{p.text}</mark>
                              ) : (
                                <span key={i}>{p.text}</span>
                              ),
                            )
                          : h.title}
                      </strong>
                      <Badge status={h.status} />
                    </span>
                    <small className="task-search-hit-meta">
                      {[clientName, productName, projectName]
                        .filter(Boolean)
                        .join(" / ")}
                    </small>
                    {h.match_in !== "title" && h.match_in !== "filters" && (
                      <span className="task-search-snippet">
                        <em>{MATCH_LABEL[h.match_in]}:</em>{" "}
                        {highlightParts(h.snippet, query).map((p, i) =>
                          p.match ? (
                            <mark key={i}>{p.text}</mark>
                          ) : (
                            <span key={i}>{p.text}</span>
                          ),
                        )}
                      </span>
                    )}
                    <span className="task-search-hit-foot">
                      <span>
                        <Avatar
                          name={who?.name ?? "?"}
                          src={who?.avatar_url}
                          size="small"
                        />
                        {who?.name ?? "—"}
                      </span>
                      <span>
                        <CalendarDays size={14} /> {dateLabel(h.due_date)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {hits.length < total && (
            <div className="task-search-more">
              <Button
                className="btn secondary"
                loading={more}
                disabled={more}
                onClick={() => run(hits.length)}
              >
                Carregar mais
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, CalendarClock, Layers, List, RefreshCw, Settings2, X } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { Empty } from "./components";
import type { Snapshot } from "./types";
import { appPath, openInApp } from "./temperature";
import { RadarItemPanel, SeverityDot } from "./RadarItemPanel";
import { RadarThemes } from "./RadarThemes";
import type { FormPreset } from "./forms";
import {
  dateBr,
  loadItems,
  loadOverview,
  overdue,
  statusOf,
  type RadarFilters,
  type RadarItem,
  type RadarOverview,
  type TopicCounts,
} from "./radar";

const ALL = "__all__";
const OPEN = "__open__";
const PAGE = 50;
type Saved = {
  topic?: string;
  product?: string;
  client?: string;
  team?: string;
  status?: string;
  severity?: string;
  assignee?: string;
  days?: string;
  sort?: RadarFilters["sort"];
  view?: "items" | "themes";
};
const savedKey = (company: string, user: string) => `mavi:radar:${company}:${user}`;
function readSaved(key: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

/**
 * Radar do cliente (administradores e gestores): o que os clientes reclamam,
 * o que o time promete e os outros tópicos que a MAVI acompanha nas reuniões
 * e nos grupos de WhatsApp. Um cartão por tópico com os números, a lista com
 * os filtros resolvidos no banco e o item aberto num painel. Os filtros
 * ficam guardados neste navegador, por empresa e pessoa.
 */
export function RadarPage({
  company,
  user,
  data,
  onNewTask,
  notify,
}: {
  company: string;
  user: string;
  data: Snapshot;
  onNewTask?: (preset: FormPreset) => void;
  notify: (message: string) => void;
}) {
  const key = savedKey(company, user);
  const initial = useMemo(() => readSaved(key), [key]);
  const [overview, setOverview] = useState<RadarOverview | null>(null);
  const [error, setError] = useState("");
  const [topicId, setTopicId] = useState(initial.topic ?? "");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [product, setProduct] = useState(initial.product ?? ALL);
  const [client, setClient] = useState(initial.client ?? ALL);
  const [team, setTeam] = useState(initial.team ?? ALL);
  const [status, setStatus] = useState(initial.status ?? OPEN);
  const [severity, setSeverity] = useState(initial.severity ?? ALL);
  const [assignee, setAssignee] = useState(initial.assignee ?? ALL);
  const [days, setDays] = useState(initial.days ?? ALL);
  const [sort, setSort] = useState<NonNullable<RadarFilters["sort"]>>(initial.sort ?? "recent");
  const [items, setItems] = useState<RadarItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<"items" | "themes">(initial.view ?? "items");
  // Os itens de um tema (vindo da visão de temas); não fica guardado.
  const [themeFilter, setThemeFilter] = useState<{ id: string; label: string } | null>(null);
  const request = useRef(0);

  const loadTop = useCallback(() => {
    loadOverview(company)
      .then(setOverview)
      .catch((e) => setError((e as Error).message));
  }, [company]);
  useEffect(loadTop, [loadTop]);

  // A busca espera a pessoa parar de digitar.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const topic: TopicCounts | undefined =
    overview?.topics.find((t) => t.id === topicId) ?? overview?.topics[0];

  useEffect(() => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ topic: topic?.id, product, client, team, status, severity, assignee, days, sort, view }),
      );
    } catch {
      /* sem armazenamento: os filtros só não ficam guardados */
    }
  }, [key, topic?.id, product, client, team, status, severity, assignee, days, sort, view]);

  const filters = useMemo<RadarFilters | null>(() => {
    if (!topic) return null;
    const statuses =
      status === ALL
        ? []
        : status === OPEN
          ? topic.statuses.filter((s) => s.kind !== "closed").map((s) => s.key!)
          : [status];
    return {
      topic: topic.id,
      ...(q ? { q } : {}),
      ...(product !== ALL ? { product } : {}),
      ...(client !== ALL ? { client } : {}),
      ...(team !== ALL ? { team } : {}),
      ...(statuses.length ? { statuses } : {}),
      ...(severity !== ALL ? { severity: Number(severity) } : {}),
      ...(assignee !== ALL ? { assignee } : {}),
      ...(days !== ALL ? { days: Number(days) } : {}),
      ...(themeFilter ? { theme: themeFilter.id } : {}),
      sort,
    };
  }, [topic, q, product, client, team, status, severity, assignee, days, sort, themeFilter]);

  const load = useCallback(
    (offset = 0) => {
      if (!filters) return;
      const n = ++request.current;
      setBusy(true);
      setError("");
      loadItems(company, { ...filters, limit: PAGE, offset })
        .then((page) => {
          if (n !== request.current) return;
          setTotal(page.total);
          setItems((prev) => (offset && prev ? [...prev, ...page.items] : page.items));
        })
        .catch((e) => n === request.current && setError((e as Error).message))
        .finally(() => n === request.current && setBusy(false));
    },
    [company, filters],
  );
  useEffect(() => {
    setItems(null);
    load(0);
  }, [load]);

  if (!overview)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="table" />
    );
  if (!topic)
    return (
      <Empty
        title="Nenhum tópico ligado"
        body="Ligue ou crie tópicos em Painel da MAVI › Radar para a MAVI começar a acompanhar."
      />
    );

  const members = data.members.filter((m) => m.active);
  const changeTopic = (id: string) => {
    setTopicId(id);
    setStatus(OPEN);
    setThemeFilter(null);
  };
  const refresh = () => {
    loadTop();
    load(0);
  };

  return (
    <div className="radar-page">
      <section className="radar-topics" aria-label="Tópicos">
        {overview.topics.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`radar-topic-card${t.id === topic.id ? " selected" : ""}`}
            style={{ "--topic": t.color } as CSSProperties}
            aria-pressed={t.id === topic.id}
            onClick={() => changeTopic(t.id)}
          >
            <span className="radar-topic-name">{t.name}</span>
            <strong>{t.open}</strong>
            <small>em aberto</small>
            <span className="radar-topic-stats">
              <span>{t.new_7d} novos na semana</span>
              {t.severity && t.severe > 0 && (
                <span className="warn">
                  <AlertTriangle size={11} aria-hidden="true" /> {t.severe}{" "}
                  {t.severe === 1 ? "sério" : "sérios"}
                </span>
              )}
              {t.has_due && (t.overdue ?? 0) > 0 && (
                <span className="warn">
                  <CalendarClock size={11} aria-hidden="true" /> {t.overdue}{" "}
                  {t.overdue === 1 ? "vencido" : "vencidos"}
                </span>
              )}
            </span>
          </button>
        ))}
      </section>

      <nav className="drive-view radar-view" aria-label="Como ver">
        <button
          type="button"
          className={view === "items" ? "selected" : ""}
          aria-pressed={view === "items"}
          onClick={() => setView("items")}
        >
          <List size={15} aria-hidden="true" /> Itens
        </button>
        <button
          type="button"
          className={view === "themes" ? "selected" : ""}
          aria-pressed={view === "themes"}
          onClick={() => setView("themes")}
        >
          <Layers size={15} aria-hidden="true" /> Temas
        </button>
      </nav>

      {view === "themes" ? (
        <RadarThemes
          key={topic.id}
          company={company}
          topic={topic}
          data={data}
          user={user}
          onNewTask={onNewTask}
          notify={notify}
          onChanged={loadTop}
          onShowItems={(id, label) => {
            setThemeFilter({ id, label });
            setStatus(ALL);
            setView("items");
          }}
        />
      ) : (
        <>
        <div className="thermo-filters radar-filters">
          <span className="thermo-search">
            <Input
              type="search"
              aria-label="Buscar"
              placeholder="Buscar no título, no resumo ou pelo cliente"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
          <span className="thermo-filter">
            <Select aria-label="Status" value={status} onValueChange={setStatus}>
              <SelectOption value={OPEN}>Em aberto</SelectOption>
              <SelectOption value={ALL}>Todos os status</SelectOption>
              {topic.statuses.map((s) => (
                <SelectOption key={s.key} value={s.key!}>
                  {s.label}
                </SelectOption>
              ))}
            </Select>
          </span>
          <span className="thermo-filter">
            <Select aria-label="Produto" value={product} onValueChange={setProduct}>
              <SelectOption value={ALL}>Todos os produtos</SelectOption>
              <SelectOption value="none">Geral / Agência</SelectOption>
              {data.products.map((p) => (
                <SelectOption key={p.id} value={p.id}>
                  {p.name}
                </SelectOption>
              ))}
            </Select>
          </span>
          <span className="thermo-filter">
            <Select aria-label="Cliente" value={client} onValueChange={setClient}>
              <SelectOption value={ALL}>Todos os clientes</SelectOption>
              {data.clients
                .filter((c) => !c.archived)
                .map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
            </Select>
          </span>
          <span className="thermo-filter">
            <Select aria-label="Equipe" value={team} onValueChange={setTeam}>
              <SelectOption value={ALL}>Todas as equipes</SelectOption>
              {data.teams.map((t) => (
                <SelectOption key={t.id} value={t.id}>
                  {t.name}
                </SelectOption>
              ))}
            </Select>
          </span>
          {topic.severity && (
            <span className="thermo-filter">
              <Select aria-label={topic.severity_label} value={severity} onValueChange={setSeverity}>
                <SelectOption value={ALL}>Qualquer {topic.severity_label.toLowerCase()}</SelectOption>
                {topic.severity_levels.map((l, i) => (
                  <SelectOption key={i} value={String(i)}>
                    {`${l.split(":")[0]}${i < 3 ? " ou mais" : ""}`}
                  </SelectOption>
                ))}
              </Select>
            </span>
          )}
          <span className="thermo-filter">
            <Select aria-label="Responsável" value={assignee} onValueChange={setAssignee}>
              <SelectOption value={ALL}>Qualquer responsável</SelectOption>
              <SelectOption value="none">Sem responsável</SelectOption>
              {members.map((m) => (
                <SelectOption key={m.user_id} value={m.user_id}>
                  {m.name}
                </SelectOption>
              ))}
            </Select>
          </span>
          <span className="thermo-filter">
            <Select aria-label="Período" value={days} onValueChange={setDays}>
              <SelectOption value={ALL}>Qualquer data</SelectOption>
              <SelectOption value="7">Vistos nos últimos 7 dias</SelectOption>
              <SelectOption value="30">Vistos nos últimos 30 dias</SelectOption>
              <SelectOption value="90">Vistos nos últimos 90 dias</SelectOption>
            </Select>
          </span>
          <span className="thermo-filter">
            <Select
              aria-label="Ordenar"
              value={sort}
              onValueChange={(v) => setSort(v as NonNullable<RadarFilters["sort"]>)}
            >
              <SelectOption value="recent">Mais recentes</SelectOption>
              <SelectOption value="mentions">Mais repetidos</SelectOption>
              {topic.severity && <SelectOption value="severity">Mais sérios</SelectOption>}
              <SelectOption value="oldest">Mais antigos</SelectOption>
            </Select>
          </span>
          <div className="thermo-filters-actions">
            <Button className="icon-btn" onClick={refresh} loading={busy} aria-label="Atualizar" title="Atualizar">
              <RefreshCw size={15} />
            </Button>
            <a
              className="btn secondary"
              href={appPath("/mavi#radar")}
              onClick={(e) => {
                e.preventDefault();
                openInApp("/mavi#radar");
              }}
            >
              <Settings2 size={15} aria-hidden="true" /> Configurar
            </a>
          </div>
        </div>
        <p className="radar-caption">
          {items ? `${total} ${total === 1 ? "item" : "itens"}` : "Carregando…"}
          {overview.pending > 0 &&
            ` · ${overview.pending} ${overview.pending === 1 ? "reunião ou conversa na fila" : "reuniões e conversas na fila"} da MAVI`}
          {overview.started_at && ` · lendo desde ${dateBr(overview.started_at)}`}
          {themeFilter && (
            <span className="radar-chip">
              <Layers size={12} aria-hidden="true" /> {themeFilter.label}
              <button type="button" aria-label="Tirar o filtro do tema" onClick={() => setThemeFilter(null)}>
                <X size={12} />
              </button>
            </span>
          )}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {!items ? (
          <Loading variant="table" />
        ) : !items.length ? (
          <Empty
            title={topic.total ? "Nenhum item com esses filtros" : "Ainda sem itens"}
            body={
              topic.total
                ? "Mude os filtros ou o status escolhido."
                : "A MAVI lê cada reunião gravada e as mensagens novas dos grupos de WhatsApp. Os itens aparecem aos poucos."
            }
          />
        ) : (
          <div className="drive-table-wrap">
            <table className="drive-table radar-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Produto</th>
                  <th>Status</th>
                  {topic.severity && <th>{topic.severity_label}</th>}
                  {topic.has_due && <th>Prazo</th>}
                  <th>Responsável</th>
                  <th className="num">Vezes</th>
                  <th>Última vez</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const s = statusOf(topic, i.status);
                  const late = overdue(topic, i);
                  return (
                    <tr key={i.id} className="radar-row" onClick={() => setOpen(i.id)}>
                      <td>
                        <button
                          type="button"
                          className="radar-row-title"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(i.id);
                          }}
                        >
                          {i.title}
                        </button>
                        <small className="radar-row-client">
                          <span className="thermo-dot" style={{ background: i.client_color ?? "#a3acab" }} aria-hidden="true" />
                          {i.client_name}
                          {i.reopened_at && <em> · reaberto</em>}
                          {i.theme_title && (
                            <span className="radar-row-theme">
                              {" · "}
                              <Layers size={11} aria-hidden="true" /> {i.theme_title}
                            </span>
                          )}
                        </small>
                      </td>
                      <td>{i.product_name ?? <span className="muted">Geral</span>}</td>
                      <td>
                        <span className="radar-status" style={{ "--status": s?.color ?? "#a3acab" } as CSSProperties}>
                          {s?.label ?? i.status}
                        </span>
                      </td>
                      {topic.severity && (
                        <td>
                          <SeverityDot topic={topic} value={i.severity} />
                        </td>
                      )}
                      {topic.has_due && (
                        <td className={late ? "radar-late" : ""}>
                          {i.due_date ? dateBr(i.due_date) : <span className="muted">—</span>}
                        </td>
                      )}
                      <td>
                        {i.assignee_name ??
                          data.members.find((m) => m.user_id === i.assignee_id)?.name ?? (
                            <span className="muted">—</span>
                          )}
                      </td>
                      <td className="num">{i.mentions}</td>
                      <td>{dateBr(i.last_seen_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {items && items.length < total && (
          <div className="radar-more">
            <Button className="btn secondary" loading={busy} onClick={() => load(items.length)}>
              Carregar mais ({total - items.length})
            </Button>
          </div>
        )}
        </>
      )}

      {open && (
        <RadarItemPanel
          company={company}
          itemId={open}
          members={data.members}
          data={data}
          user={user}
          onNewTask={onNewTask}
          notify={notify}
          onClose={() => setOpen(null)}
          onChanged={(next) => {
            setItems((list) => list?.map((x) => (x.id === next.id ? { ...x, ...next } : x)) ?? list);
            loadTop();
          }}
        />
      )}
    </div>
  );
}


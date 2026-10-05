import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CircleCheck,
  CircleHelp,
  Clock3,
  Copy,
  Film,
  GraduationCap,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Search,
  Settings2,
  Users,
  X,
} from "lucide-react";
import { Empty } from "./components";
import { Button, Loading, Select, SelectOption } from "./ui";
import { MultiPick } from "./MultiPick";
import { RichTextContent } from "./RichTextContent";
import { TutorialMediaContext, TutorialVideoInfo } from "./TutorialVideo";
import { TutorialEditor } from "./TutorialEditor";
import { TutorialSearchResults } from "./TutorialSearch";
import { TutorialGaps } from "./TutorialGaps";
import { RequiredTrails, TrailBar, TrailView, TrailsTab } from "./TutorialTrails";
import { TutorialTrailEditor } from "./TutorialTrailEditor";
import {
  TRAIL_PARAM,
  demoTrails,
  itemStates,
  nextInTrail,
  serverTrails,
  type TrailDetail,
  type TrailRow,
  type TrailsApi,
} from "./tutorial-trails";
import { headingAnchors } from "./rich-text";
import {
  TUTORIAL_MODULES,
  TUTORIAL_PARAM,
  audienceSummary,
  demoTutorials,
  moduleLabel,
  readingMinutes,
  serverTutorials,
  videoIds,
  videoUrlCache,
  type TutorialDetail,
  type TutorialFacet,
  type TutorialGap,
  type TutorialProgress,
  type TutorialRow,
  type TutorialScope,
  type TutorialsApi,
} from "./tutorials";
import { fold } from "./domain";
import { pageUrl, routeParts, useUrlState } from "./router";
import type { Snapshot } from "./types";
import "./tutorials.css";

const PAGE = 30;
const TOP_CATEGORIES = 8;
const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "America/Sao_Paulo",
      })
    : "";

/**
 * Tutoriais: os guias de uso do sistema. Todos leem os publicados do seu
 * público (busca sem acento em tudo que o tutorial tem, filtros por
 * módulo, categoria e tag); administradores e gestores escrevem na área
 * administrativa (rascunhos, publicação, versões). A lista vem do banco já
 * filtrada e se atualiza pelos avisos ao vivo ("mavi:tutorials").
 */
export function TutorialsPage({
  data,
  company,
  user,
  isLeader,
  demo,
  notify,
}: {
  data: Snapshot;
  company: string;
  user: string;
  isLeader: boolean;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const api = useMemo(
    () => (demo ? demoTutorials(data, user) : serverTutorials),
    [demo],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const videoUrls = useMemo(() => videoUrlCache(api), [api]);
  const trailsApi = useMemo(
    () => (demo ? demoTrails(data, user, api) : serverTrails),
    [api],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab] = useUrlState<string>("aba", "");
  const [openId, setOpenId] = useUrlState<string>(TUTORIAL_PARAM, "");
  const [trailId, setTrailId] = useUrlState<string>(TRAIL_PARAM, "");
  const [editingTrail, setEditingTrail] = useState<{ detail: TrailDetail | null } | null>(null);
  const [trailRows, setTrailRows] = useState<TrailRow[]>([]);
  const [term, setTerm] = useUrlState<string>("termo", "");
  const [module, setModule] = useUrlState<string>("modulo", "");
  const [category, setCategory] = useUrlState<string>("categoria", "");
  const [tagParam, setTagParam] = useUrlState<string>("tag", "");
  const [typed, setTyped] = useState(term);
  const [rows, setRows] = useState<TutorialRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [facets, setFacets] = useState<TutorialFacet[]>([]);
  const [editing, setEditing] = useState<{
    detail: TutorialDetail | null;
    /** Criado a partir de uma dúvida sem tutorial: ela fica resolvida ao publicar. */
    gap?: TutorialGap;
  } | null>(null);
  const [gapCount, setGapCount] = useState(0);
  const gapsTab = tab === "duvidas" && isLeader;
  const trailsTab = tab === "trilhas";
  const scope: TutorialScope = tab === "admin" && isLeader ? "admin" : "library";
  const tags = useMemo(() => tagParam.split("|").filter(Boolean), [tagParam]);
  // Na biblioteca, buscar é com a MAVI (Enter); a lista mostra os resultados dela.
  const searching = !gapsTab && !trailsTab && scope === "library" && !!term;
  const request = useRef(0);

  useEffect(() => setTyped(term), [term]);

  const load = useCallback(
    (offset = 0) => {
      if (searching || gapsTab || trailsTab) return;
      const n = ++request.current;
      if (!offset) setError("");
      api
        .list(company, {
          scope,
          query: term,
          module,
          category,
          tags,
          limit: PAGE,
          offset,
        })
        .then((list) => {
          if (n !== request.current) return;
          setRows((prev) => (offset && prev ? [...prev, ...list] : list));
          setTotal(list[0]?.total ?? (offset ? total : 0));
          setMore(offset + list.length < (list[0]?.total ?? 0));
        })
        .catch((e) => {
          if (n === request.current)
            setError(
              (e as Error).message || "Não foi possível buscar os tutoriais.",
            );
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, company, scope, term, module, category, tagParam, searching, gapsTab, trailsTab],
  );
  const loadFacets = useCallback(() => {
    api
      .facets(company)
      .then(setFacets)
      .catch(() => {});
    if (isLeader)
      api
        .gapCount(company)
        .then(setGapCount)
        .catch(() => {});
  }, [api, company, isLeader]);
  useEffect(() => load(0), [load]);
  useEffect(loadFacets, [loadFacets]);

  // Avisos ao vivo (App.tsx repassa como "mavi:tutorials"): a lista pergunta
  // de novo o que a pessoa pode ver, agrupando rajadas de avisos. Os de
  // trilhas e de progresso só releem as trilhas (o tutorial aberto fica).
  const reloadSoon = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const trailSoon = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [tick, setTick] = useState(0);
  const [trailTick, setTrailTick] = useState(0);
  const refreshTrails = useCallback(() => {
    clearTimeout(trailSoon.current);
    trailSoon.current = setTimeout(() => setTrailTick((n) => n + 1), 400);
  }, []);
  const refresh = useCallback(() => {
    clearTimeout(reloadSoon.current);
    reloadSoon.current = setTimeout(() => {
      load(0);
      loadFacets();
      setTick((n) => n + 1);
    }, 400);
    refreshTrails();
  }, [load, loadFacets, refreshTrails]);
  useEffect(() => {
    const onLive = (e: Event) => {
      const change = (e as CustomEvent<{ trails?: boolean; progress?: boolean }>).detail ?? {};
      if (change.trails || change.progress) refreshTrails();
      else refresh();
    };
    window.addEventListener("mavi:tutorials", onLive);
    return () => {
      window.removeEventListener("mavi:tutorials", onLive);
      clearTimeout(reloadSoon.current);
      clearTimeout(trailSoon.current);
    };
  }, [refresh, refreshTrails]);
  // As trilhas da pessoa: as obrigatórias no topo da biblioteca e o número na aba.
  useEffect(() => {
    let alive = true;
    trailsApi
      .list(company)
      .then((r) => alive && setTrailRows(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [trailsApi, company, trailTick]);
  const pendingTrails = trailRows.filter(
    (r) => r.required_for_me && !(r.total > 0 && r.done === r.total),
  ).length;

  const categories = facets.filter((f) => f.kind === "category");
  const tagFacets = facets.filter((f) => f.kind === "tag");
  const shownCategories = categories.filter((c) => c.tutorials > 0);
  const filtered = !!(term || module || category || tags.length);
  const clearFilters = () => {
    setTyped("");
    setTerm("");
    setModule("");
    setCategory("");
    setTagParam("");
  };
  const companyPath = routeParts(window.location.pathname).company;
  const linkTo = (id: string, anchor = "") =>
    `${window.location.origin}${pageUrl("tutorials", companyPath)}?${TUTORIAL_PARAM}=${id}${anchor ? `#${anchor}` : ""}`;

  if (editingTrail)
    return (
      <TutorialTrailEditor
        api={trailsApi}
        tutorials={api}
        company={company}
        data={data}
        user={user}
        detail={editingTrail.detail}
        notify={notify}
        onClose={(id) => {
          setEditingTrail(null);
          setTrailId(id ?? "");
          if (!id) setTab("trilhas");
          refreshTrails();
        }}
      />
    );

  if (editing)
    return (
      <TutorialMediaContext.Provider value={videoUrls}>
        <TutorialEditor
          api={api}
          company={company}
          data={data}
          user={user}
          detail={editing.detail}
          gap={editing.gap}
          facets={facets}
          demo={demo}
          notify={notify}
          onClose={(id) => {
            setEditing(null);
            if (id) setOpenId(id);
            refresh();
          }}
        />
      </TutorialMediaContext.Provider>
    );

  if (openId)
    return (
      <TutorialMediaContext.Provider value={videoUrls}>
        <TutorialReader
          key={`${openId}-${tick}`}
          api={api}
          trailsApi={trailsApi}
          trailId={trailId}
          trailTick={trailTick}
          id={openId}
          data={data}
          videoUrls={videoUrls}
          linkTo={linkTo}
          notify={notify}
          onBack={() => setOpenId("")}
          onEdit={(detail) => setEditing({ detail })}
          onOpenTrail={(id) => {
            setOpenId("");
            setTrailId(id);
          }}
          onOpenTutorial={(id) => {
            setOpenId(id);
            window.scrollTo({ top: 0 });
          }}
          onPick={(kind, value) => {
            setOpenId("");
            setTrailId("");
            setTab("");
            if (kind === "module") setModule(value);
            else if (kind === "category") setCategory(value);
            else setTagParam(value);
          }}
        />
      </TutorialMediaContext.Provider>
    );

  if (trailId)
    return (
      <TrailView
        api={trailsApi}
        id={trailId}
        data={data}
        isLeader={isLeader}
        tick={trailTick}
        onBack={() => {
          setTrailId("");
          setTab("trilhas");
        }}
        onOpenTutorial={(id) => {
          setOpenId(id);
          window.scrollTo({ top: 0 });
        }}
        onEdit={(detail) => setEditingTrail({ detail })}
      />
    );

  return (
    <div className="tutorials-page">
      <form
        className="cases-top"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (gapsTab || trailsTab) setTab("");
          setTerm(typed.trim());
        }}
      >
        <label className="cases-search">
          <Search size={20} aria-hidden="true" />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="O que você quer aprender? Ex.: como mudar o prazo de uma tarefa"
            aria-label="Buscar nos tutoriais"
            enterKeyHint="search"
          />
          {typed && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Limpar busca"
              onClick={() => {
                setTyped("");
                setTerm("");
              }}
            >
              <X size={16} />
            </button>
          )}
          <button type="submit" className="btn primary tutorials-search-go" disabled={!typed.trim()}>
            Buscar
          </button>
        </label>
        {isLeader && (
          <Button
            className="btn primary"
            onClick={() => setEditing({ detail: null })}
            type="button"
          >
            <Plus size={17} /> Novo tutorial
          </Button>
        )}
      </form>

      <nav className="cases-tabs" aria-label="Tutoriais">
        {[
          { param: "", label: "Tutoriais", icon: BookOpen, count: 0 },
          { param: "trilhas", label: "Trilhas", icon: Route, count: pendingTrails },
          ...(isLeader
            ? [
                { param: "admin", label: "Administração", icon: Settings2, count: 0 },
                { param: "duvidas", label: "Dúvidas sem tutorial", icon: CircleHelp, count: gapCount },
              ]
            : []),
        ].map((t) => {
          const on =
            (t.param === "trilhas" && trailsTab) ||
            (t.param === "admin" && scope === "admin") ||
            (t.param === "duvidas" && gapsTab) ||
            (!t.param && !trailsTab && scope !== "admin" && !gapsTab);
          return (
            <button
              type="button"
              key={t.param}
              className={on ? "active" : ""}
              aria-current={on ? "page" : undefined}
              onClick={() => setTab(t.param)}
            >
              <t.icon size={16} />
              {t.label}
              {t.count > 0 && <span className="nav-count">{t.count}</span>}
            </button>
          );
        })}
      </nav>

      {trailsTab ? (
        <TrailsTab
          api={trailsApi}
          company={company}
          isLeader={isLeader}
          tick={trailTick}
          onOpen={setTrailId}
          onNew={() => setEditingTrail({ detail: null })}
        />
      ) : gapsTab ? (
        <TutorialGaps
          api={api}
          company={company}
          tick={tick}
          notify={notify}
          onCreate={(gap) => setEditing({ detail: null, gap })}
          onOpenTutorial={(id) => setOpenId(id)}
          onChanged={refresh}
        />
      ) : (
      <>
      {scope === "library" && !filtered && (
        <RequiredTrails rows={trailRows} onOpen={setTrailId} />
      )}
      <div className="cases-filters">
        <div
          className="cases-niche-row"
          role="group"
          aria-label="Filtrar por categoria"
        >
          {shownCategories.slice(0, TOP_CATEGORIES).map((c) => {
            const on = fold(category) === fold(c.value);
            return (
              <button
                type="button"
                key={c.value}
                className={`chip ${on ? "selected" : ""}`}
                aria-pressed={on}
                onClick={() => setCategory(on ? "" : c.value)}
              >
                {c.value}
                <small>{c.tutorials}</small>
              </button>
            );
          })}
          {shownCategories.length > TOP_CATEGORIES && (
            <Select
              value={
                shownCategories
                  .slice(TOP_CATEGORIES)
                  .some((c) => fold(c.value) === fold(category))
                  ? category
                  : ""
              }
              onValueChange={setCategory}
              aria-label="Mais categorias"
            >
              <SelectOption value="">Mais categorias…</SelectOption>
              {shownCategories.slice(TOP_CATEGORIES).map((c) => (
                <SelectOption key={c.value} value={c.value}>
                  {`${c.value} (${c.tutorials})`}
                </SelectOption>
              ))}
            </Select>
          )}
        </div>
        <div className="cases-filter-side">
          <Select
            value={module}
            onValueChange={setModule}
            aria-label="Módulo"
          >
            <SelectOption value="">Todos os módulos</SelectOption>
            {TUTORIAL_MODULES.map((m) => (
              <SelectOption key={m.id} value={m.id}>
                {m.label}
              </SelectOption>
            ))}
          </Select>
          {!!tagFacets.length && (
            <MultiPick
              label="Tags"
              allLabel="Todas as tags"
              noun="tags"
              options={tagFacets.map((t) => ({
                value: t.value,
                label: `${t.value} (${t.tutorials})`,
              }))}
              value={tags}
              onChange={(next) => setTagParam(next.join("|"))}
            />
          )}
          {filtered && (
            <button type="button" className="text-btn" onClick={clearFilters}>
              <X size={14} /> Limpar filtros
            </button>
          )}
        </div>
      </div>

      {searching ? (
        <TutorialSearchResults
          key={`${term}|${module}|${category}|${tagParam}`}
          api={api}
          company={company}
          query={{ query: term, module, category, tags }}
          isLeader={isLeader}
          onOpen={(id, anchor) => {
            setOpenId(id);
            if (anchor)
              window.history.replaceState(
                window.history.state,
                "",
                `${window.location.pathname}${window.location.search}#${anchor}`,
              );
          }}
          onCreate={(question) =>
            setEditing({
              detail: null,
              gap: { question } as TutorialGap,
            })
          }
        />
      ) : (
      <>
      {error && <p className="form-error">{error}</p>}
      {rows === null && !error ? (
        <Loading variant={scope === "admin" ? "list" : "grid"} />
      ) : rows && rows.length ? (
        <>
          <p className="cases-count">
            {total === 1 ? "1 tutorial" : `${total} tutoriais`}
            {module ? ` sobre ${moduleLabel(module)}` : ""}
            {term ? ` para “${term}”` : ""}
          </p>
          {scope === "admin" ? (
            <AdminTable rows={rows} onOpen={(id) => setOpenId(id)} />
          ) : (
            <div className="tutorials-grid">
              {rows.map((r) => (
                <TutorialCard
                  key={r.id}
                  row={r}
                  onOpen={() => setOpenId(r.id)}
                />
              ))}
            </div>
          )}
          {more && (
            <div className="cases-more">
              <Button
                className="btn secondary"
                onClick={() => load(rows.length)}
              >
                Carregar mais
              </Button>
            </div>
          )}
        </>
      ) : rows ? (
        <div className="panel">
          {filtered ? (
            <Empty
              title="Nenhum tutorial encontrado"
              body="Tente outras palavras ou menos filtros."
              action={
                <Button className="btn secondary" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              }
            />
          ) : isLeader ? (
            <Empty
              title="Ainda não há tutoriais"
              body="Escreva o primeiro guia: um passo a passo com seções, imagens e vídeos. Ele só aparece para o time depois de publicado."
              action={
                <Button
                  className="btn primary"
                  onClick={() => setEditing({ detail: null })}
                >
                  <Plus size={16} /> Novo tutorial
                </Button>
              }
            />
          ) : (
            <Empty
              title="Ainda não há tutoriais para você"
              body="Quando os administradores e gestores publicarem guias de uso do sistema, eles aparecem aqui."
            />
          )}
        </div>
      ) : null}
      </>
      )}
      </>
      )}
    </div>
  );
}

function ModuleChips({
  modules,
  max = 3,
  onPick,
}: {
  modules: string[];
  max?: number;
  onPick?: (module: string) => void;
}) {
  if (!modules.length) return null;
  const shown = modules.slice(0, max);
  return (
    <span className="tutorial-modules">
      {shown.map((m) =>
        onPick ? (
          <button
            type="button"
            key={m}
            className="tutorial-module"
            onClick={() => onPick(m)}
          >
            {moduleLabel(m)}
          </button>
        ) : (
          <span key={m} className="tutorial-module">
            {moduleLabel(m)}
          </span>
        ),
      )}
      {modules.length > max && (
        <span className="tutorial-module more">+{modules.length - max}</span>
      )}
    </span>
  );
}

function TutorialCard({
  row,
  onOpen,
}: {
  row: TutorialRow;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="tutorial-card" onClick={onOpen}>
      <span className="tutorial-card-top">
        <GraduationCap size={18} aria-hidden="true" />
        {row.category && (
          <span className="tutorial-card-category">{row.category}</span>
        )}
      </span>
      <strong className="tutorial-card-title">{row.title}</strong>
      {row.summary && (
        <span className="tutorial-card-summary">{row.summary}</span>
      )}
      <ModuleChips modules={row.modules} />
      <span className="tutorial-card-foot">
        {row.video_count > 0 && (
          <span title="Vídeos">
            <Film size={13} /> {row.video_count}
          </span>
        )}
        <span className="tutorial-card-when">
          Atualizado em {shortDate(row.published_at)}
        </span>
      </span>
    </button>
  );
}

const statusOf = (r: Pick<TutorialRow, "status" | "has_draft" | "version">) =>
  r.status === "draft"
    ? { cls: "draft", label: r.version ? "Fora do ar" : "Rascunho" }
    : r.has_draft
      ? { cls: "changed", label: "Alteração não publicada" }
      : { cls: "published", label: `Publicado · v${r.version}` };

function AdminTable({
  rows,
  onOpen,
}: {
  rows: TutorialRow[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="panel tutorials-admin">
      <table className="stack-mobile">
        <thead>
          <tr>
            <th>Tutorial</th>
            <th>Situação</th>
            <th>Público</th>
            <th>Autor</th>
            <th>Atualizado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = statusOf(r);
            return (
              <tr key={r.id}>
                <td data-label="Tutorial">
                  <button
                    type="button"
                    className="link-btn tutorials-admin-title"
                    onClick={() => onOpen(r.id)}
                  >
                    {r.title}
                  </button>
                  <ModuleChips modules={r.modules} max={2} />
                </td>
                <td data-label="Situação">
                  <span className={`tutorial-status ${s.cls}`}>{s.label}</span>
                </td>
                <td data-label="Público">
                  {r.aud_all ? "Todos" : (
                    <span className="tutorial-restricted">
                      <Users size={13} /> Restrito
                    </span>
                  )}
                </td>
                <td data-label="Autor">
                  <span data-person={r.created_by}>{r.author_name}</span>
                </td>
                <td data-label="Atualizado">
                  {shortDate(r.updated_at)}
                  {!r.can_edit && (
                    <small className="tutorial-readonly"> · só leitura</small>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A tutorial for reading: index on the side, sections with anchors. */
function TutorialReader({
  api,
  trailsApi,
  trailId,
  trailTick,
  id,
  data,
  videoUrls,
  linkTo,
  notify,
  onBack,
  onEdit,
  onOpenTrail,
  onOpenTutorial,
  onPick,
}: {
  api: TutorialsApi;
  trailsApi: TrailsApi;
  /** Aberto por uma trilha: a faixa no topo e o próximo no fim. */
  trailId: string;
  trailTick: number;
  id: string;
  data: Snapshot;
  videoUrls: (ids: string[]) => Promise<Record<string, string>>;
  linkTo: (id: string, anchor?: string) => string;
  notify: (message: string) => void;
  onBack: () => void;
  onEdit: (detail: TutorialDetail) => void;
  onOpenTrail: (id: string) => void;
  onOpenTutorial: (id: string) => void;
  onPick: (kind: "module" | "category" | "tag", value: string) => void;
}) {
  const [detail, setDetail] = useState<TutorialDetail | null | undefined>();
  const [error, setError] = useState("");
  const [active, setActive] = useState("");
  const [progress, setProgress] = useState<TutorialProgress | null>(null);
  const [trail, setTrail] = useState<TrailDetail | null>(null);
  const [marking, setMarking] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  useEffect(() => {
    let alive = true;
    api
      .detail(id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setProgress(d?.progress ?? null);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [api, id]);

  // A trilha de onde veio (relida quando o progresso muda).
  useEffect(() => {
    if (!trailId) {
      setTrail(null);
      return;
    }
    let alive = true;
    trailsApi
      .detail(trailId)
      .then((t) => alive && setTrail(t))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [trailsApi, trailId, trailTick, progress?.completed_at]);

  // Abrir conta como "abriu"; chegar ao fim (depois de um tempo na página)
  // conclui sozinho, menos para quem desmarcou.
  const trackable = !!detail?.trackable;
  useEffect(() => {
    if (!detail || !trackable) return;
    void api.progress(detail.id, "open").catch(() => {});
    const el = end.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const started = Date.now();
    const minimum = Math.min(30_000, Math.max(8_000, readingMinutes(detail.body) * 15_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fired = false;
    const fire = () => {
      const p = progressRef.current;
      if (fired || p?.completed_at || p?.undone) return;
      fired = true;
      api
        .progress(detail.id, "auto")
        .then((next) => {
          if (!next) return;
          setProgress(next);
          if (next.completed_at) notify("Tutorial concluído.");
        })
        .catch(() => {
          fired = false;
        });
    };
    const observer = new IntersectionObserver((entries) => {
      clearTimeout(timer);
      if (!entries.some((e) => e.isIntersecting)) return;
      timer = setTimeout(fire, Math.max(0, minimum - (Date.now() - started)));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [api, detail, trackable]); // eslint-disable-line react-hooks/exhaustive-deps

  const mark = async (action: "complete" | "undo") => {
    if (!detail) return;
    setMarking(true);
    try {
      const next = await api.progress(detail.id, action);
      if (next) setProgress(next);
      notify(action === "undo" ? "Marcado como não concluído." : "Tutorial concluído.");
    } catch (e) {
      notify((e as Error).message || "Não foi possível marcar.");
    } finally {
      setMarking(false);
    }
  };

  const sections = useMemo(
    () => (detail ? headingAnchors(detail.body) : []),
    [detail],
  );

  // Os vídeos da página pedem os links de uma vez.
  useEffect(() => {
    if (detail) void videoUrls(videoIds(detail.body)).catch(() => {});
  }, [detail, videoUrls]);

  // Aberto por um link com #secao: vai até ela.
  useEffect(() => {
    if (!detail) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (!hash) return;
    requestAnimationFrame(() =>
      document.getElementById(hash)?.scrollIntoView({ block: "start" }),
    );
  }, [detail]);

  // A seção que está na tela fica marcada no índice.
  useEffect(() => {
    const root = body.current;
    if (!root || !sections.length || typeof IntersectionObserver === "undefined")
      return;
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = sections.find((s) => seen.get(s.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections]);

  const goTo = (anchor: string) => {
    const el = document.getElementById(anchor);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#${anchor}`,
    );
    setActive(anchor);
  };
  const copy = async (anchor = "") => {
    try {
      await navigator.clipboard.writeText(linkTo(id, anchor));
      notify(anchor ? "Link da seção copiado." : "Link do tutorial copiado.");
    } catch {
      notify("Não foi possível copiar o link.");
    }
  };

  if (error)
    return (
      <div className="tutorial-reader">
        <BackLink onBack={onBack} />
        <p className="form-error">{error}</p>
      </div>
    );
  if (detail === undefined) return <Loading variant="page" />;
  if (detail === null)
    return (
      <div className="tutorial-reader">
        <BackLink onBack={onBack} />
        <div className="panel">
          <Empty
            title="Tutorial indisponível"
            body="Ele pode ter saído do ar, sido apagado ou não ser para o seu público."
          />
        </div>
      </div>
    );

  const unpublished = detail.status === "draft";
  const completed = !!progress?.completed_at;
  const updated =
    completed && progress?.completed_version != null && detail.version > progress.completed_version;
  // Na trilha: a posição deste tutorial, se está travado e o próximo.
  const inTrail = trail?.items.some((i) => i.tutorial_id === detail.id) ? trail : null;
  const trailState = inTrail
    ? itemStates(inTrail, inTrail.items)[inTrail.items.findIndex((i) => i.tutorial_id === detail.id)]
    : null;
  const next = inTrail ? nextInTrail(inTrail.items, detail.id) : null;
  const nextLocked = !!inTrail?.sequential && !completed;
  return (
    <div className="tutorial-reader">
      {inTrail ? (
        <button type="button" className="text-btn tutorial-back" onClick={() => onOpenTrail(inTrail.id)}>
          <ArrowLeft size={15} /> Voltar à trilha
        </button>
      ) : (
        <BackLink onBack={onBack} />
      )}
      {inTrail && (
        <TrailBar trail={inTrail} tutorial={detail.id} onOpenTrail={() => onOpenTrail(inTrail.id)} />
      )}
      <div className={`tutorial-layout ${sections.length ? "with-toc" : ""}`}>
        <article className="tutorial-article">
          {trailState === "locked" && (
            <p className="tutorial-banner" role="status">
              Esta trilha é em sequência: conclua os tutoriais anteriores antes deste.
            </p>
          )}
          {(unpublished || detail.draft) && (
            <p className="tutorial-banner" role="status">
              {unpublished
                ? "Rascunho: só quem edita vê este tutorial. Publique para o time ver."
                : `Há uma alteração não publicada (salva por ${detail.draft!.saved_by_name}). Abaixo, a versão no ar.`}
            </p>
          )}
          <header className="tutorial-head">
            {detail.category && (
              <button
                type="button"
                className="tutorial-head-category"
                onClick={() => onPick("category", detail.category)}
              >
                {detail.category}
              </button>
            )}
            <h1>{detail.title}</h1>
            {detail.summary && <p className="tutorial-lead">{detail.summary}</p>}
            <div className="tutorial-meta">
              <span>
                <Clock3 size={14} /> {readingMinutes(detail.body)} min de leitura
              </span>
              {detail.published_at && (
                <span>Atualizado em {shortDate(detail.published_at)}</span>
              )}
              <span>
                por <span data-person={detail.created_by}>{detail.author_name}</span>
              </span>
              {detail.audience && (
                <span>
                  <Users size={14} /> {audienceSummary(detail.audience, data)}
                </span>
              )}
              {completed && (
                <span className={`tutorial-done-chip ${updated ? "updated" : ""}`}>
                  {updated ? <RefreshCw size={13} /> : <CircleCheck size={13} />}
                  {updated ? "Atualizado depois que você concluiu" : "Concluído"}
                </span>
              )}
              {!!detail.trails?.length && (
                <span className="tutorial-in-trails">
                  <Route size={14} /> Trilha{detail.trails.length > 1 ? "s" : ""}:{" "}
                  {detail.trails.map((t, i) => (
                    <span key={t.id}>
                      {i > 0 && ", "}
                      <button type="button" className="link-btn" onClick={() => onOpenTrail(t.id)}>
                        {t.title}
                      </button>
                    </span>
                  ))}
                </span>
              )}
            </div>
            <div className="tutorial-head-row">
              <ModuleChips
                modules={detail.modules}
                max={6}
                onPick={(m) => onPick("module", m)}
              />
              <span className="tutorial-head-actions">
                <Button className="btn secondary" onClick={() => void copy()}>
                  <Copy size={15} /> Copiar link
                </Button>
                {detail.can_edit && (
                  <Button className="btn primary" onClick={() => onEdit(detail)}>
                    <Pencil size={15} /> Editar
                  </Button>
                )}
              </span>
            </div>
          </header>
          <div className="tutorial-body" ref={body}>
            <TutorialVideoInfo.Provider value={{ media: mediaInfo(detail) }}>
              <RichTextContent value={detail.body} />
            </TutorialVideoInfo.Provider>
          </div>
          {!!detail.tags.length && (
            <footer className="tutorial-tags">
              {detail.tags.map((t) => (
                <button
                  type="button"
                  key={t}
                  className="chip"
                  onClick={() => onPick("tag", t)}
                >
                  #{t}
                </button>
              ))}
            </footer>
          )}
          {trackable && (
            <section className={`tutorial-finish ${completed ? (updated ? "updated" : "done") : ""}`} aria-label="Conclusão">
              {!completed ? (
                <>
                  <span>
                    <strong>Terminou?</strong>
                    <small>
                      {progress?.undone
                        ? "Você desmarcou: chegar ao fim não marca mais sozinho."
                        : "Chegar ao fim marca sozinho; ou marque agora."}
                    </small>
                  </span>
                  <Button className="btn primary" onClick={() => void mark("complete")} loading={marking}>
                    <CircleCheck size={15} /> Marcar como concluído
                  </Button>
                </>
              ) : updated ? (
                <>
                  <span>
                    <strong>
                      <RefreshCw size={15} /> Atualizado depois que você concluiu
                    </strong>
                    <small>
                      Você concluiu a versão {progress?.completed_version}; agora está na versão {detail.version}.
                    </small>
                  </span>
                  <span className="tutorial-finish-actions">
                    <button type="button" className="text-btn" onClick={() => void mark("undo")} disabled={marking}>
                      Desmarcar
                    </button>
                    <Button className="btn primary" onClick={() => void mark("complete")} loading={marking}>
                      Li a versão nova
                    </Button>
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <strong>
                      <CircleCheck size={15} /> Concluído
                    </strong>
                    <small>
                      Em {shortDate(progress!.completed_at)}
                      {progress?.completed_how === "auto" ? ", ao chegar ao fim" : ""}.
                    </small>
                  </span>
                  <button type="button" className="text-btn" onClick={() => void mark("undo")} disabled={marking}>
                    Desmarcar
                  </button>
                </>
              )}
            </section>
          )}
          {inTrail && (
            <section className="tutorial-trail-next" aria-label="Na trilha">
              {next ? (
                <>
                  <span>
                    <small>Próximo na trilha</small>
                    <strong>{next.title}</strong>
                    {nextLocked && <small>Conclua este tutorial para liberar o próximo.</small>}
                  </span>
                  <Button
                    className="btn secondary"
                    onClick={() => onOpenTutorial(next.tutorial_id)}
                    disabled={nextLocked}
                  >
                    Próximo <ArrowRight size={15} />
                  </Button>
                </>
              ) : (
                <>
                  <span>
                    <small>Último tutorial da trilha</small>
                    <strong>
                      {inTrail.total > 0 && inTrail.done === inTrail.total
                        ? "Você concluiu a trilha."
                        : `${inTrail.done} de ${inTrail.total} concluídos.`}
                    </strong>
                  </span>
                  <Button className="btn secondary" onClick={() => onOpenTrail(inTrail.id)}>
                    Ver a trilha
                  </Button>
                </>
              )}
            </section>
          )}
          <div ref={end} className="tutorial-end" aria-hidden="true" />
        </article>
        {!!sections.length && (
          <aside className="tutorial-toc" aria-label="Índice do tutorial">
            <span className="tutorial-toc-title">
              <ListTree size={15} /> Neste tutorial
            </span>
            <ol>
              {sections.map((s) => (
                <li key={s.id} className={`level-${s.level}`}>
                  <a
                    href={`#${s.id}`}
                    className={active === s.id ? "active" : ""}
                    aria-current={active === s.id ? "location" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      goTo(s.id);
                    }}
                  >
                    {s.text}
                  </a>
                  <button
                    type="button"
                    className="icon-btn tutorial-toc-copy"
                    aria-label={`Copiar link da seção ${s.text}`}
                    title="Copiar link da seção"
                    onClick={() => void copy(s.id)}
                  >
                    <Copy size={12} />
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>
    </div>
  );
}

/** A transcrição de cada vídeo enviado, para o player mostrar. */
export function mediaInfo(detail: Pick<TutorialDetail, "media">) {
  return Object.fromEntries(
    detail.media.map((m) => [
      m.id,
      {
        transcript: m.transcript ?? null,
        transcript_status: m.transcript_status ?? "pending",
        transcript_source: m.transcript_source ?? null,
        transcript_error: m.transcript_error ?? null,
      },
    ]),
  );
}

function BackLink({ onBack }: { onBack: () => void }): ReactNode {
  return (
    <button type="button" className="text-btn tutorial-back" onClick={onBack}>
      <ArrowLeft size={15} /> Todos os tutoriais
    </button>
  );
}

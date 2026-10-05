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
  BookOpen,
  Clock3,
  Copy,
  Film,
  GraduationCap,
  ListTree,
  Pencil,
  Plus,
  Search,
  Settings2,
  Users,
  X,
} from "lucide-react";
import { Empty } from "./components";
import { Button, Loading, Select, SelectOption } from "./ui";
import { MultiPick } from "./MultiPick";
import { RichTextContent } from "./RichTextContent";
import { TutorialMediaContext } from "./TutorialVideo";
import { TutorialEditor } from "./TutorialEditor";
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
  const [tab, setTab] = useUrlState<string>("aba", "");
  const [openId, setOpenId] = useUrlState<string>(TUTORIAL_PARAM, "");
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
  } | null>(null);
  const scope: TutorialScope = tab === "admin" && isLeader ? "admin" : "library";
  const tags = useMemo(() => tagParam.split("|").filter(Boolean), [tagParam]);
  const request = useRef(0);

  // Digitar não refaz a busca a cada letra.
  useEffect(() => {
    const t = setTimeout(() => setTerm(typed.trim()), 280);
    return () => clearTimeout(t);
  }, [typed, setTerm]);
  useEffect(() => setTyped(term), [term]);

  const load = useCallback(
    (offset = 0) => {
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
    [api, company, scope, term, module, category, tagParam],
  );
  const loadFacets = useCallback(() => {
    api
      .facets(company)
      .then(setFacets)
      .catch(() => {});
  }, [api, company]);
  useEffect(() => load(0), [load]);
  useEffect(loadFacets, [loadFacets]);

  // Avisos ao vivo (App.tsx repassa como "mavi:tutorials"): a lista pergunta
  // de novo o que a pessoa pode ver, agrupando rajadas de avisos.
  const reloadSoon = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => {
    clearTimeout(reloadSoon.current);
    reloadSoon.current = setTimeout(() => {
      load(0);
      loadFacets();
      setTick((n) => n + 1);
    }, 400);
  }, [load, loadFacets]);
  useEffect(() => {
    window.addEventListener("mavi:tutorials", refresh);
    return () => {
      window.removeEventListener("mavi:tutorials", refresh);
      clearTimeout(reloadSoon.current);
    };
  }, [refresh]);

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

  if (editing)
    return (
      <TutorialMediaContext.Provider value={videoUrls}>
        <TutorialEditor
          api={api}
          company={company}
          data={data}
          user={user}
          detail={editing.detail}
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
          id={openId}
          data={data}
          videoUrls={videoUrls}
          linkTo={linkTo}
          notify={notify}
          onBack={() => setOpenId("")}
          onEdit={(detail) => setEditing({ detail })}
          onPick={(kind, value) => {
            setOpenId("");
            setTab("");
            if (kind === "module") setModule(value);
            else if (kind === "category") setCategory(value);
            else setTagParam(value);
          }}
        />
      </TutorialMediaContext.Provider>
    );

  return (
    <div className="tutorials-page">
      <section className="cases-top">
        <label className="cases-search">
          <Search size={20} aria-hidden="true" />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="O que você quer aprender? Ex.: como mudar o prazo de uma tarefa"
            aria-label="Buscar nos tutoriais"
          />
          {typed && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Limpar busca"
              onClick={() => setTyped("")}
            >
              <X size={16} />
            </button>
          )}
        </label>
        {isLeader && (
          <Button
            className="btn primary"
            onClick={() => setEditing({ detail: null })}
          >
            <Plus size={17} /> Novo tutorial
          </Button>
        )}
      </section>

      {isLeader && (
        <nav className="cases-tabs" aria-label="Tutoriais">
          {[
            { param: "", label: "Tutoriais", icon: BookOpen },
            { param: "admin", label: "Administração", icon: Settings2 },
          ].map((t) => (
            <button
              type="button"
              key={t.param}
              className={tab === t.param || (!t.param && tab !== "admin") ? "active" : ""}
              aria-current={tab === t.param ? "page" : undefined}
              onClick={() => setTab(t.param)}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </nav>
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
  id,
  data,
  videoUrls,
  linkTo,
  notify,
  onBack,
  onEdit,
  onPick,
}: {
  api: TutorialsApi;
  id: string;
  data: Snapshot;
  videoUrls: (ids: string[]) => Promise<Record<string, string>>;
  linkTo: (id: string, anchor?: string) => string;
  notify: (message: string) => void;
  onBack: () => void;
  onEdit: (detail: TutorialDetail) => void;
  onPick: (kind: "module" | "category" | "tag", value: string) => void;
}) {
  const [detail, setDetail] = useState<TutorialDetail | null | undefined>();
  const [error, setError] = useState("");
  const [active, setActive] = useState("");
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .detail(id)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [api, id]);

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
  return (
    <div className="tutorial-reader">
      <BackLink onBack={onBack} />
      <div className={`tutorial-layout ${sections.length ? "with-toc" : ""}`}>
        <article className="tutorial-article">
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
            <RichTextContent value={detail.body} />
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

function BackLink({ onBack }: { onBack: () => void }): ReactNode {
  return (
    <button type="button" className="text-btn tutorial-back" onClick={onBack}>
      <ArrowLeft size={15} /> Todos os tutoriais
    </button>
  );
}

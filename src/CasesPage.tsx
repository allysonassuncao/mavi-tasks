import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  Film,
  Image as ImageIcon,
  Inbox,
  Library,
  Link2,
  Play,
  Plus,
  Search,
  Trophy,
  UserRound,
  X,
} from "lucide-react";
import { Empty } from "./components";
import { Button, Loading } from "./ui";
import { MultiPick } from "./MultiPick";
import { NicheChips, useMediaUrls, type UrlLoader } from "./CaseParts";
import { CaseForm } from "./CaseForm";
import { CaseView } from "./CaseView";
import {
  caseQueryParam,
  demoCases,
  serverCases,
  statusLabel,
  type CaseClient,
  type CaseDetail,
  type CaseRow,
  type CaseScope,
  type NicheCount,
  type SaveResult,
} from "./cases";
import { fold } from "./domain";
import { pageUrl, routeParts, useUrlState } from "./router";
import type { Snapshot } from "./types";

const PAGE = 24;
const TOP_NICHES = 10;
const TABS: {
  scope: CaseScope;
  param: string;
  label: string;
  icon: typeof Library;
}[] = [
  { scope: "library", param: "", label: "Biblioteca", icon: Library },
  { scope: "mine", param: "meus", label: "Meus cases", icon: UserRound },
  { scope: "review", param: "aprovar", label: "Para aprovar", icon: Inbox },
];
const TINTS = [
  "#c8ec8e",
  "#b9dcd2",
  "#f3d9a4",
  "#d6cdf2",
  "#f2c4b5",
  "#bcd3f0",
  "#e4e9b0",
];
const tint = (id: string) =>
  TINTS[
    [...id].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7) %
      TINTS.length
  ];
const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        timeZone: "America/Sao_Paulo",
      })
    : "";

/**
 * Cases de Sucesso: a biblioteca de provas sociais. Qualquer pessoa busca
 * por termo e nicho e cadastra cases; administradores e gestores aprovam.
 * A lista vem do banco já filtrada (busca sem acento em tudo que o case
 * tem, inclusive o nome do cliente) e se atualiza pelos avisos ao vivo.
 */
export function CasesPage({
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
    () => (demo ? demoCases(data, user) : serverCases),
    [demo],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab] = useUrlState<string>("aba", "");
  const [openId, setOpenId] = useUrlState<string>(caseQueryParam, "");
  const [term, setTerm] = useUrlState<string>("termo", "");
  const [nicheParam, setNicheParam] = useUrlState<string>("nicho", "");
  const [typed, setTyped] = useState(term);
  const [products, setProducts] = useState<string[]>([]);
  const [rows, setRows] = useState<CaseRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [niches, setNiches] = useState<NicheCount[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [clients, setClients] = useState<CaseClient[] | null>(null);
  const [form, setForm] = useState<{ detail: CaseDetail | null } | null>(null);
  const scope = (TABS.find((t) => t.param === tab) ?? TABS[0]).scope;
  const pickedNiches = useMemo(
    () => nicheParam.split("|").filter(Boolean),
    [nicheParam],
  );
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
        .search(company, {
          scope,
          query: term,
          niches: pickedNiches,
          products,
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
              (e as Error).message || "Não foi possível buscar os cases.",
            );
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, company, scope, term, nicheParam, products.join()],
  );
  const loadSide = useCallback(() => {
    api
      .niches(company)
      .then(setNiches)
      .catch(() => {});
    if (isLeader)
      api
        .reviewCount(company)
        .then(setPendingCount)
        .catch(() => {});
  }, [api, company, isLeader]);
  useEffect(() => load(0), [load]);
  useEffect(loadSide, [loadSide]);

  // Avisos ao vivo (App.tsx repassa como "mavi:cases"): a lista pergunta de
  // novo o que a pessoa pode ver, agrupando rajadas de avisos.
  const reloadSoon = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const refresh = useCallback(() => {
    clearTimeout(reloadSoon.current);
    reloadSoon.current = setTimeout(() => {
      load(0);
      loadSide();
    }, 400);
  }, [load, loadSide]);
  useEffect(() => {
    window.addEventListener("mavi:cases", refresh);
    return () => {
      window.removeEventListener("mavi:cases", refresh);
      clearTimeout(reloadSoon.current);
    };
  }, [refresh]);

  const loader: UrlLoader = useCallback(
    (ids, inline) => api.mediaUrls(ids, inline),
    [api],
  );
  const covers = useMediaUrls(
    loader,
    (rows ?? [])
      .filter((r) => r.cover_id && r.cover_type?.startsWith("image/"))
      .map((r) => r.cover_id!),
  );

  const openForm = async (detail: CaseDetail | null) => {
    if (!clients)
      try {
        setClients(await api.clients(company));
      } catch (e) {
        return notify(
          (e as Error).message || "Não foi possível carregar os clientes.",
        );
      }
    setForm({ detail });
  };
  const saved = (id: string, r: SaveResult) => {
    setForm(null);
    notify(
      r.mode === "draft"
        ? "Alteração enviada para aprovação. A versão aprovada continua no ar até lá."
        : r.mode === "created"
          ? r.status === "approved"
            ? "Case publicado na biblioteca."
            : "Case enviado para aprovação. Você recebe um aviso quando for aprovado."
          : r.status === "pending" && !isLeader
            ? "Case salvo e enviado para aprovação."
            : "Case salvo.",
    );
    setOpenId(id);
    refresh();
  };
  const toggleNiche = (n: string) => {
    const key = fold(n);
    setNicheParam(
      (pickedNiches.some((x) => fold(x) === key)
        ? pickedNiches.filter((x) => fold(x) !== key)
        : [...pickedNiches, n]
      ).join("|"),
    );
  };
  const clearFilters = () => {
    setTyped("");
    setTerm("");
    setNicheParam("");
    setProducts([]);
  };
  const filtered = !!(term || pickedNiches.length || products.length);
  const topNiches = niches.filter((n) => n.cases > 0).slice(0, TOP_NICHES);
  const otherNiches = niches.filter((n) => n.cases > 0).slice(TOP_NICHES);
  const companyPath = routeParts(window.location.pathname).company;
  const internalUrl = (id: string) =>
    `${window.location.origin}${pageUrl("cases", companyPath)}?${caseQueryParam}=${id}`;

  return (
    <div className="cases-page">
      <section className="cases-top">
        <label className="cases-search">
          <Search size={20} aria-hidden="true" />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Busque por cliente, nicho ou resultado…"
            aria-label="Buscar cases"
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
        <Button className="btn primary" onClick={() => openForm(null)}>
          <Plus size={17} /> Cadastrar case
        </Button>
      </section>

      <nav className="cases-tabs" aria-label="Cases">
        {TABS.filter((t) => t.scope !== "review" || isLeader).map((t) => (
          <button
            type="button"
            key={t.scope}
            className={scope === t.scope ? "active" : ""}
            aria-current={scope === t.scope ? "page" : undefined}
            onClick={() => setTab(t.param)}
          >
            <t.icon size={16} />
            {t.label}
            {t.scope === "review" && pendingCount > 0 && (
              <span className="nav-count">{pendingCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="cases-filters">
        <div
          className="cases-niche-row"
          role="group"
          aria-label="Filtrar por nicho"
        >
          {topNiches.map((n) => {
            const on = pickedNiches.some((x) => fold(x) === fold(n.niche));
            return (
              <button
                type="button"
                key={n.niche}
                className={`chip ${on ? "selected" : ""}`}
                aria-pressed={on}
                onClick={() => toggleNiche(n.niche)}
              >
                {n.niche}
                <small>{n.cases}</small>
              </button>
            );
          })}
          {!!otherNiches.length && (
            <MultiPick
              label="Mais nichos"
              allLabel={`+${otherNiches.length} nichos`}
              noun="nichos"
              options={otherNiches.map((n) => ({
                value: n.niche,
                label: `${n.niche} (${n.cases})`,
              }))}
              value={pickedNiches.filter((p) =>
                otherNiches.some((n) => fold(n.niche) === fold(p)),
              )}
              onChange={(next) =>
                setNicheParam(
                  [
                    ...pickedNiches.filter(
                      (p) =>
                        !otherNiches.some((n) => fold(n.niche) === fold(p)),
                    ),
                    ...next,
                  ].join("|"),
                )
              }
            />
          )}
        </div>
        <div className="cases-filter-side">
          {!!data.products.length && (
            <MultiPick
              label="Produtos"
              allLabel="Todos os produtos"
              noun="produtos"
              options={data.products.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              value={products}
              onChange={setProducts}
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
        <Loading variant="grid" />
      ) : rows && rows.length ? (
        <>
          <p className="cases-count">
            {total === 1 ? "1 case" : `${total} cases`}
            {pickedNiches.length ? ` em ${pickedNiches.join(", ")}` : ""}
            {term ? ` para “${term}”` : ""}
          </p>
          <div className="cases-grid">
            {rows.map((r) => (
              <CaseCard
                key={r.id}
                row={r}
                scope={scope}
                cover={r.cover_id ? covers[r.cover_id] : undefined}
                color={
                  data.clients.find((c) => c.id === r.client_id)?.color ??
                  tint(r.client_id)
                }
                onOpen={() => setOpenId(r.id)}
              />
            ))}
          </div>
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
              title="Nenhum case encontrado"
              body="Tente outras palavras, menos filtros ou um nicho parecido."
              action={
                <Button className="btn secondary" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              }
            />
          ) : scope === "review" ? (
            <Empty
              title="Nada esperando aprovação"
              body="Cases novos e alterações aparecem aqui para você aprovar."
            />
          ) : scope === "mine" ? (
            <Empty
              title="Você ainda não cadastrou cases"
              body="Um bom resultado de cliente vira argumento de venda para todo o time."
              action={
                <Button className="btn primary" onClick={() => openForm(null)}>
                  <Plus size={16} /> Cadastrar case
                </Button>
              }
            />
          ) : (
            <Empty
              title="A biblioteca ainda está vazia"
              body="Cadastre o primeiro case de sucesso. Depois de aprovado, todo o time encontra por termo ou nicho."
              action={
                <Button className="btn primary" onClick={() => openForm(null)}>
                  <Plus size={16} /> Cadastrar case
                </Button>
              }
            />
          )}
        </div>
      ) : null}

      {openId && !form && (
        <CaseView
          key={openId}
          api={api}
          id={openId}
          products={data.products}
          notify={notify}
          internalUrl={internalUrl}
          onClose={() => setOpenId("")}
          onEdit={(d) => openForm(d)}
          onChanged={refresh}
          onPickNiche={(n) => {
            setOpenId("");
            setTab("");
            setNicheParam(n);
          }}
        />
      )}
      {form && clients && (
        <CaseForm
          api={api}
          company={company}
          detail={form.detail}
          clients={clients}
          niches={niches}
          products={data.products}
          isLeader={isLeader}
          onClose={() => setForm(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}

function CaseCard({
  row,
  scope,
  cover,
  color,
  onOpen,
}: {
  row: CaseRow;
  scope: CaseScope;
  cover?: string;
  color: string;
  onOpen: () => void;
}) {
  const video = row.cover_type?.startsWith("video/");
  const status =
    scope !== "library" && row.status !== "approved"
      ? { cls: row.status, label: statusLabel[row.status] }
      : row.draft_status === "pending"
        ? { cls: "pending", label: "Alteração em análise" }
        : row.draft_status === "returned"
          ? { cls: "returned", label: "Alteração devolvida" }
          : null;
  return (
    <button
      type="button"
      className="case-card"
      onClick={onOpen}
      style={{ ["--tint" as string]: color }}
    >
      <span className={`case-card-cover ${cover ? "photo" : ""}`}>
        {cover ? (
          <img src={cover} alt="" loading="lazy" decoding="async" />
        ) : video ? (
          <span className="case-card-play">
            <Play size={22} fill="currentColor" />
          </span>
        ) : (
          <Trophy size={30} className="case-card-mark" aria-hidden="true" />
        )}
        {!!row.highlights[0] && (
          <span className="case-card-big">
            <strong>{row.highlights[0].value}</strong>
            <small>{row.highlights[0].label}</small>
          </span>
        )}
        {status && (
          <span className={`case-status ${status.cls}`}>{status.label}</span>
        )}
      </span>
      <span className="case-card-body">
        <span className="case-card-client">
          {row.client_name}
          {row.client_archived && <span className="case-flag">ex-cliente</span>}
        </span>
        <strong className="case-card-title">{row.title}</strong>
        {row.highlights.length > 1 && (
          <span className="case-card-stats">
            {row.highlights.slice(1, 4).map((h, i) => (
              <span key={i}>
                <b>{h.value}</b> {h.label}
              </span>
            ))}
          </span>
        )}
        {row.status === "returned" &&
          row.review_note &&
          scope !== "library" && (
            <span className="case-card-note">{row.review_note}</span>
          )}
        <NicheChips niches={row.niches} max={3} />
        <span className="case-card-foot">
          {row.media_count > 0 && (
            <span title="Mídias">
              {video ? <Film size={13} /> : <ImageIcon size={13} />}{" "}
              {row.media_count}
            </span>
          )}
          {row.link_count > 0 && (
            <span title="Links">
              <Link2 size={13} /> {row.link_count}
            </span>
          )}
          <span className="case-card-when">
            {scope === "review" ? (
              <>
                <Clock3 size={13} /> {row.author_name} ·{" "}
                {shortDate(row.updated_at)}
              </>
            ) : (
              shortDate(row.approved_at ?? row.created_at)
            )}
          </span>
        </span>
      </span>
    </button>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, Search, X } from "lucide-react";
import * as api from "./api";
import type { InboxFilters } from "./api";
import { DateInput } from "./DateInput";
import {
  INBOX_KINDS,
  INBOX_PAGE,
  kindsOf,
  mergeHead,
  pageOf,
  periodRange,
  type InboxPeriod,
} from "./inbox";
import { InboxEmpty, InboxList } from "./NotificationInbox";
import { MultiPick } from "./MultiPick";
import { Loading, Select, SelectOption } from "./ui";
import type { AppNotification, Client, Member } from "./types";

/** "Quem enviou": the automatic notices (the MAVI, the system) have no person. */
const SYSTEM = "__system";

const PERIODS: { id: InboxPeriod; label: string }[] = [
  { id: "all", label: "Qualquer data" },
  { id: "today", label: "Hoje" },
  { id: "7d", label: "Últimos 7 dias" },
  { id: "30d", label: "Últimos 30 dias" },
  { id: "custom", label: "Escolher datas" },
];

/**
 * The "Caixa de entrada" page: every notice of the person, 30 at a time
 * ("Carregar mais"), with the filters resolved in the database (my_inbox).
 * Opening and reading go through the app, which keeps the top bar's panel
 * and count in step; the app's "mavi:inbox" event brings the new ones and
 * the reads made elsewhere.
 */
export function InboxPage({
  company,
  demo,
  demoInbox,
  members,
  clients,
  unread,
  onOpen,
  onRead,
  onUnread,
  onReadAll,
  notify,
}: {
  company: string;
  demo: boolean;
  /** The demo's notices (no database). */
  demoInbox: () => AppNotification[];
  members: Member[];
  clients: Client[];
  /** Every unread notice of the person. */
  unread: number;
  onOpen: (n: AppNotification) => void;
  onRead: (n: AppNotification) => void;
  onUnread: (n: AppNotification) => void;
  onReadAll: () => void;
  notify: (message: string) => void;
}) {
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [kindGroups, setKindGroups] = useState<string[]>([]);
  const [actors, setActors] = useState<string[]>([]);
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [period, setPeriod] = useState<InboxPeriod>("all");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const filters = useMemo<InboxFilters>(() => {
    const range = periodRange(period, custom);
    return {
      unread: onlyUnread,
      kinds: kindsOf(kindGroups),
      actors: actors.filter((a) => a !== SYSTEM),
      system: actors.includes(SYSTEM),
      clients: clientIds,
      from: range.from,
      to: range.to,
      search,
    };
  }, [onlyUnread, kindGroups, actors, clientIds, period, custom, search]);
  const filtered = !!(
    kindGroups.length ||
    actors.length ||
    clientIds.length ||
    period !== "all" ||
    search
  );
  const clearFilters = () => {
    setKindGroups([]);
    setActors([]);
    setClientIds([]);
    setPeriod("all");
    setCustom({ from: "", to: "" });
    setTyped("");
    setSearch("");
  };

  // null: the first page of these filters is on its way.
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const state = useRef({ items, more, filters });
  state.current = { items, more, filters };
  // Answers for filters no longer shown are dropped.
  const request = useRef(0);

  // A new function each render: read when used, not a dependency.
  const demoRows = useRef(demoInbox);
  demoRows.current = demoInbox;
  const fetchPage = useCallback(
    (
      after: AppNotification | null,
      f: InboxFilters,
    ): Promise<AppNotification[]> =>
      demo
        ? Promise.resolve(pageOf(demoRows.current(), INBOX_PAGE, after, f))
        : api.myInbox(company, INBOX_PAGE, after, f),
    [company, demo],
  );

  // The first page again. `keep`: merge into what is loaded (a new notice
  // arrived) instead of starting over (the filters changed).
  const loadHead = useCallback(
    (keep: boolean) => {
      const id = ++request.current;
      const f = state.current.filters;
      if (!keep) setItems(null);
      fetchPage(null, f)
        .then((head) => {
          if (id !== request.current) return;
          setError("");
          if (keep && state.current.items) {
            const merged = mergeHead(
              head,
              state.current.items,
              INBOX_PAGE,
              state.current.more,
            );
            setItems(merged.items);
            setMore(merged.more);
          } else {
            setItems(head);
            setMore(head.length === INBOX_PAGE);
          }
        })
        .catch(() => {
          if (id !== request.current) return;
          setError("Não deu para carregar a caixa de entrada. Tente de novo.");
          setItems((list) => list ?? []);
        });
    },
    [fetchPage],
  );
  useEffect(() => loadHead(false), [loadHead, filters]);

  function loadMore() {
    const last = items?.[items.length - 1];
    if (!last || loadingMore) return;
    const id = request.current;
    setLoadingMore(true);
    fetchPage(last, filters)
      .then((page) => {
        if (id !== request.current) return;
        setItems((list) => {
          const ids = new Set((list ?? []).map((n) => n.id));
          return [...(list ?? []), ...page.filter((n) => !ids.has(n.id))];
        });
        setMore(page.length === INBOX_PAGE);
      })
      .catch(() => notify("Não deu para carregar mais avisos. Tente de novo."))
      .finally(() => setLoadingMore(false));
  }

  // New notices, and reads made here, in the top bar or on another device.
  useEffect(() => {
    const onInbox = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        read?: string[] | "all";
        unread?: string[];
        at?: string;
      };
      if (detail?.unread) {
        const back = detail.unread;
        // "Não lidas" shows only unread ones: the notice comes back in.
        if (state.current.filters.unread) loadHead(true);
        else
          setItems((list) =>
            list
              ? list.map((n) =>
                  back.includes(n.id) ? { ...n, read_at: null } : n,
                )
              : list,
          );
        return;
      }
      if (!detail?.read) {
        loadHead(true);
        return;
      }
      const { read, at } = detail;
      const stamp = at ?? new Date().toISOString();
      if (state.current.filters.unread)
        setItems((list) =>
          list ? list.filter((n) => read !== "all" && !read.includes(n.id)) : list,
        );
      else
        setItems((list) =>
          list
            ? list.map((n) =>
                !n.read_at && (read === "all" || read.includes(n.id))
                  ? { ...n, read_at: stamp }
                  : n,
              )
            : list,
        );
    };
    window.addEventListener("mavi:inbox", onInbox);
    return () => window.removeEventListener("mavi:inbox", onInbox);
  }, [loadHead]);

  const memberOptions = useMemo(
    () => [
      { value: SYSTEM, label: "Automáticos (MAVI e sistema)" },
      ...members
        .filter((m) => m.name)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
        .map((m) => ({ value: m.user_id, label: m.name })),
    ],
    [members],
  );
  const clientOptions = useMemo(
    () =>
      [...clients]
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
        .map((c) => ({ value: c.id, label: c.name })),
    [clients],
  );

  return (
    <section className="panel inbox-page">
      <div className="scope-tabs" role="tablist" aria-label="Quais avisos">
        <button
          type="button"
          role="tab"
          aria-selected={!onlyUnread}
          className={!onlyUnread ? "selected" : ""}
          onClick={() => setOnlyUnread(false)}
        >
          Todas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={onlyUnread}
          className={onlyUnread ? "selected" : ""}
          onClick={() => setOnlyUnread(true)}
        >
          Não lidas
          {unread > 0 && <span>{unread > 99 ? "99+" : unread}</span>}
        </button>
        {unread > 0 && (
          <button
            type="button"
            className="inbox-page-read-all"
            onClick={onReadAll}
            title="Marcar todas como lidas"
            aria-label="Marcar todas como lidas"
          >
            <CheckCheck size={15} /> <span>Marcar todas como lidas</span>
          </button>
        )}
      </div>

      <div className="inbox-page-filters">
        <label className="inbox-page-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Buscar por tarefa, pessoa ou texto…"
            aria-label="Buscar na caixa de entrada"
          />
        </label>
        <MultiPick
          label="Tipo"
          allLabel="Todos os tipos"
          noun="tipos"
          options={INBOX_KINDS.map((k) => ({ value: k.id, label: k.label }))}
          value={kindGroups}
          onChange={setKindGroups}
        />
        <MultiPick
          label="Quem enviou"
          allLabel="Qualquer pessoa"
          noun="pessoas"
          options={memberOptions}
          value={actors}
          onChange={setActors}
        />
        <MultiPick
          label="Cliente"
          allLabel="Todos os clientes"
          noun="clientes"
          options={clientOptions}
          value={clientIds}
          onChange={setClientIds}
        />
        <span className="inbox-page-period">
          <Select
            aria-label="Período"
            value={period}
            onValueChange={(v) => setPeriod(v as InboxPeriod)}
          >
            {PERIODS.map((p) => (
              <SelectOption key={p.id} value={p.id}>
                {p.label}
              </SelectOption>
            ))}
          </Select>
        </span>
        {period === "custom" && (
          <span className="inbox-page-dates">
            <DateInput
              aria-label="De"
              value={custom.from}
              max={custom.to || undefined}
              onChange={(e) =>
                setCustom((c) => ({ ...c, from: e.target.value }))
              }
            />
            <span aria-hidden="true">até</span>
            <DateInput
              aria-label="Até"
              value={custom.to}
              min={custom.from || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
            />
          </span>
        )}
        {filtered && (
          <button type="button" className="text-btn" onClick={clearFilters}>
            <X size={14} /> Limpar filtros
          </button>
        )}
      </div>

      {error && <p className="form-error inbox-page-error">{error}</p>}
      {items === null ? (
        <Loading variant="list" />
      ) : items.length ? (
        <>
          <InboxList
            items={items}
            members={members}
            onOpen={onOpen}
            onRead={onRead}
            onUnread={onUnread}
          />
          {more && (
            <div className="inbox-page-more">
              <button
                type="button"
                className="btn secondary"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Carregando…" : "Carregar mais"}
              </button>
            </div>
          )}
        </>
      ) : filtered || onlyUnread ? (
        <p className="inbox-empty">
          {onlyUnread && !filtered
            ? "Tudo lido por aqui."
            : "Nenhum aviso com esses filtros."}
          {filtered && (
            <button type="button" className="text-btn" onClick={clearFilters}>
              Limpar filtros
            </button>
          )}
        </p>
      ) : (
        <InboxEmpty />
      )}
    </section>
  );
}

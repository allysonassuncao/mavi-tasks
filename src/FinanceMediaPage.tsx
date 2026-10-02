import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Bot,
  Megaphone,
  Paperclip,
  Plus,
  RefreshCw,
  ShieldCheck,
  Tags,
  Undo2,
  Wallet,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Empty, Modal } from "./components";
import { useUrlState } from "./router";
import { dateKey } from "./domain";
import { money } from "./campaigns";
import { getGcsPublicUrl } from "./gcs";
import { ATTACHMENT_HINT } from "./attachments";
import type { Snapshot } from "./types";
import {
  CATEGORY_KIND_LABEL,
  CLIENT_STATUS_LABEL,
  archivedById,
  clientStatus,
  coalesce,
  fetchOnce,
  forgetStatements,
  remember,
  remembered,
  statementKey,
  toggleStatus,
  type ClientStatus,
  KIND_LABEL,
  LEVEL_LABEL,
  categoriesFor,
  demoMedia,
  entryInput,
  parseMoney,
  platformName,
  summary,
  supabaseMedia,
  type MediaAccount,
  type MediaAccounts,
  type MediaBackend,
  type MediaCategory,
  type MediaEntry,
  type MediaKind,
  type MediaLevel,
  type MediaStatement,
  type StatementFilter,
} from "./finance-media";
import "./finance-media.css";

const PAGE = 100;
const NO_FILTER: StatementFilter = { from: "", to: "", kind: "", category: "" };
const dateBr = (d: string) => d.split("-").reverse().join("/");
const dateTimeBr = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const accountLabel = (a: Pick<MediaAccount, "client_name" | "product_name">) =>
  `${a.client_name} › ${a.product_name}`;

/**
 * Financeiro › Mídia: the media account of each client's product. On the
 * left, the accounts with their balance; on the right, the statement of the
 * chosen one (?contrato=<id>): entries, the running balance, who made each
 * one, reversals and receipts. Updates arrive by Realtime (mavi:media), not
 * by polling.
 */
export function FinanceMediaPage({
  company,
  user,
  data,
  demo,
  notify,
}: {
  company: string;
  user: string;
  data: Snapshot;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const dataRef = useRef(data);
  dataRef.current = data;
  const media = useMemo<MediaBackend>(
    () => (demo ? demoMedia(() => dataRef.current, user) : supabaseMedia(company)),
    [demo, company, user],
  );
  const [selected, setSelected] = useUrlState<string>("contrato", "");
  // What this tab already loaded shows at once; the database answers behind.
  const scope = `${company}:${user}:${demo ? "demo" : "db"}`;
  const [all, setAll] = useState(false);
  const accountsKey = `${scope}:contas:${all}`;
  const categoriesKey = `${scope}:categorias`;
  const [list, setList] = useState<MediaAccounts | null>(
    () => remembered<MediaAccounts>(accountsKey) ?? null,
  );
  const [categories, setCategories] = useState<MediaCategory[]>(
    () => remembered<MediaCategory[]>(categoriesKey) ?? [],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<MediaLevel | "">("");
  // Clients' status: only the active ones unless the person adds archived.
  const [statuses, setStatuses] = useState<ClientStatus[]>(["active"]);
  const [entryFor, setEntryFor] = useState<{ contract: string; kind: MediaKind } | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const [showCap, setShowCap] = useState(false);
  // From a campaign's "Lançar entrada" (?contrato=<id>&lancar=entrada).
  const [launch, setLaunch] = useUrlState<string>("lancar", "");
  useEffect(() => {
    if (launch !== "entrada") return;
    setLaunch("");
    setEntryFor({ contract: selected, kind: "credit" });
  }, [launch, setLaunch, selected]);
  // Bumped on each change heard live: the statement reloads itself.
  const [tick, setTick] = useState(0);

  // The accounts (saldo pronto no banco, migração 20270119090000); the
  // categories only change by an administrator's hand, here.
  const load = useCallback(() => {
    const cached = remembered<MediaAccounts>(accountsKey);
    if (cached) setList(cached);
    setBusy(true);
    fetchOnce(accountsKey, () => media.accounts(all))
      .then((accounts) => {
        setList(accounts);
        setError("");
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [media, all, accountsKey]);
  useEffect(load, [load]);
  useEffect(() => {
    fetchOnce(categoriesKey, () => media.categories())
      .then(setCategories)
      .catch((e) => setError((e as Error).message));
  }, [media, categoriesKey]);

  // Live notices come in bursts (the Campanhas sync sends one per day it
  // records): one reload after the burst, not one per notice.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const loadRef = useRef(load);
  loadRef.current = load;
  const touched = useRef<Set<string> | null>(new Set());
  const reload = useMemo(
    () =>
      coalesce(() => {
        const contracts = touched.current;
        touched.current = new Set();
        loadRef.current();
        if (!contracts || contracts.has(selectedRef.current)) setTick((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    const onChange = (e: Event) => {
      const contracts = (e as CustomEvent<{ contracts: string[] | null }>).detail?.contracts;
      if (!contracts) {
        touched.current = null;
        forgetStatements(scope, null);
      } else
        for (const c of contracts) {
          touched.current?.add(c);
          forgetStatements(scope, c);
        }
      reload();
    };
    window.addEventListener("mavi:media", onChange);
    return () => {
      window.removeEventListener("mavi:media", onChange);
      reload.cancel();
    };
  }, [reload, scope]);

  // Warms the statement up while the pointer rests on an account.
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prefetch = (contract: string) => {
    clearTimeout(hover.current);
    hover.current = setTimeout(() => {
      const key = statementKey(scope, contract, NO_FILTER, PAGE);
      if (!remembered(key))
        fetchOnce(key, () => media.statement(contract, NO_FILTER, PAGE, 0)).catch(() => {});
    }, 150);
  };
  useEffect(() => () => clearTimeout(hover.current), []);

  const accounts = list?.accounts ?? [];
  // One lookup per account, not a search through every client.
  const archivedMap = useMemo(() => archivedById(data.clients), [data.clients]);
  const statusOf = useCallback((a: MediaAccount) => clientStatus(a, archivedMap), [archivedMap]);
  const byStatus = useMemo(() => {
    const count = { active: 0, archived: 0 };
    for (const a of accounts) count[statusOf(a)]++;
    return count;
  }, [accounts, statusOf]);
  // The cards count the accounts of the chosen statuses; the list also
  // follows the search and the card clicked.
  const inStatus = useMemo(
    () => accounts.filter((a) => statuses.includes(statusOf(a))),
    [accounts, statuses, statusOf],
  );
  const rows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("pt-BR");
    return inStatus.filter(
      (a) =>
        (!q || accountLabel(a).toLocaleLowerCase("pt-BR").includes(q)) &&
        (!level || a.level === level),
    );
  }, [inStatus, query, level]);
  const totals = summary(inStatus);
  const current = accounts.find((a) => a.contract_id === selected) ?? null;
  // An account opened by link (a notice) but not listed yet: every one.
  useEffect(() => {
    if (list && selected && !current && !all) setAll(true);
  }, [list, selected, current, all]);

  const changed = (contract = selected) => {
    forgetStatements(scope, contract);
    load();
    setTick((n) => n + 1);
  };

  if (!list)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="table" />
    );

  return (
    <div className="media-page">
      <section className="media-cards" aria-label="Resumo das contas">
        <div className="media-card">
          <span>
            <Wallet size={14} aria-hidden="true" /> Saldo das contas
          </span>
          <strong className={totals.balance < 0 ? "neg" : ""}>{money(totals.balance)}</strong>
          <small>
            {totals.count} {totals.count === 1 ? "conta" : "contas"} de clientes{" "}
            {statuses.length > 1 ? "ativos e arquivados" : statuses[0] === "active" ? "ativos" : "arquivados"}
          </small>
        </div>
        <button
          type="button"
          className={`media-card alert${level === "negative" ? " selected" : ""}`}
          aria-pressed={level === "negative"}
          onClick={() => setLevel((v) => (v === "negative" ? "" : "negative"))}
        >
          <span>
            <AlertTriangle size={14} aria-hidden="true" /> Negativas
          </span>
          <strong>{totals.negative}</strong>
          <small>saldo abaixo de zero</small>
        </button>
        <button
          type="button"
          className={`media-card low${level === "low" ? " selected" : ""}`}
          aria-pressed={level === "low"}
          onClick={() => setLevel((v) => (v === "low" ? "" : "low"))}
        >
          <span>
            <AlertTriangle size={14} aria-hidden="true" /> Abaixo do mínimo
          </span>
          <strong>{totals.low}</strong>
          <small>saldo menor que o mínimo da conta</small>
        </button>
      </section>

      <div className="media-toolbar">
        <span className="media-search">
          <Input
            type="search"
            aria-label="Buscar conta"
            placeholder="Buscar cliente ou produto"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <div className="media-status" role="group" aria-label="Status do cliente">
          <span>Clientes</span>
          {(["active", "archived"] as const).map((st) => (
            <button
              key={st}
              type="button"
              className={`media-status-option${statuses.includes(st) ? " selected" : ""}`}
              aria-pressed={statuses.includes(st)}
              title={
                statuses.includes(st) && statuses.length === 1
                  ? "Ao menos um status fica marcado"
                  : undefined
              }
              onClick={() => setStatuses((on) => toggleStatus(on, st))}
            >
              {CLIENT_STATUS_LABEL[st]}
              <small>{byStatus[st]}</small>
            </button>
          ))}
        </div>
        <label className="media-check">
          <Checkbox checked={all} onCheckedChange={(v) => setAll(v === true)} />
          Mostrar todos os produtos contratados
        </label>
        <div className="media-toolbar-actions">
          <Button
            className="icon-btn"
            onClick={load}
            loading={busy}
            aria-label="Atualizar"
            title="Atualizar"
          >
            <RefreshCw size={15} />
          </Button>
          {list.is_admin && (
            <Button className="btn secondary" onClick={() => setShowCategories(true)}>
              <Tags size={15} aria-hidden="true" /> Categorias
            </Button>
          )}
          {list.is_admin && (
            <Button
              className="btn secondary"
              onClick={() => setShowCap(true)}
              title="Quanto administradores e gestores podem liberar acima do saldo ao cadastrar um ciclo de campanha"
            >
              <ShieldCheck size={15} aria-hidden="true" /> Liberação
            </Button>
          )}
          <Button
            className="btn primary"
            onClick={() => setEntryFor({ contract: selected, kind: "credit" })}
          >
            <Plus size={16} aria-hidden="true" /> Novo lançamento
          </Button>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className={`media-layout${current ? " open" : ""}`}>
        <section className="media-accounts panel" aria-label="Contas">
          {!rows.length ? (
            <Empty
              title={accounts.length ? "Nenhuma conta com esses filtros" : "Nenhuma conta ainda"}
              body={
                accounts.length
                  ? statuses.includes("archived")
                    ? "Mude a busca ou o filtro escolhido."
                    : "Mude a busca ou o filtro escolhido, ou inclua os clientes arquivados."
                  : "A conta de mídia aparece quando o produto contratado tem campanha ou o primeiro lançamento. Use Novo lançamento ou marque Mostrar todos os produtos contratados."
              }
            />
          ) : (
            <ul className="media-account-list">
              {rows.map((a) => (
                <li key={a.contract_id}>
                  <button
                    type="button"
                    className={`media-account${a.contract_id === selected ? " selected" : ""}`}
                    aria-current={a.contract_id === selected || undefined}
                    onClick={() => setSelected(a.contract_id)}
                    onMouseEnter={() => prefetch(a.contract_id)}
                    onFocus={() => prefetch(a.contract_id)}
                    onMouseLeave={() => clearTimeout(hover.current)}
                  >
                    <span className="media-account-name">
                      <span
                        className="product-dot"
                        style={{ background: a.product_color ?? "#a3acab" }}
                        aria-hidden="true"
                      />
                      <span>
                        <strong>{a.client_name}</strong>
                        <small>
                          {a.product_name}
                          {statusOf(a) === "archived"
                            ? " · cliente arquivado"
                            : a.archived && " · produto arquivado"}
                        </small>
                      </span>
                    </span>
                    <span className="media-account-balance">
                      <strong className={a.balance < 0 ? "neg" : ""}>{money(a.balance)}</strong>
                      {a.level !== "ok" && (
                        <span className={`media-level ${a.level}`}>{LEVEL_LABEL[a.level]}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {current ? (
          <Statement
            key={current.contract_id}
            scope={scope}
            media={media}
            account={current}
            categories={categories}
            tick={tick}
            onBack={() => setSelected("")}
            onNew={(kind) => setEntryFor({ contract: current.contract_id, kind })}
            onChanged={() => changed(current.contract_id)}
            notify={notify}
          />
        ) : (
          <section className="media-statement panel media-statement-empty">
            <Wallet size={28} aria-hidden="true" />
            <p>Escolha uma conta para ver o extrato.</p>
            <small>
              O gasto das Campanhas (gasto da plataforma × M) entra como saída sozinho, todo dia.
            </small>
          </section>
        )}
      </div>

      {entryFor && (
        <EntryModal
          media={media}
          accounts={all ? accounts : null}
          loadAll={() => fetchOnce(`${scope}:contas:true`, () => media.accounts(true)).then((r) => r.accounts)}
          categories={categories}
          initial={entryFor}
          onClose={() => setEntryFor(null)}
          onSaved={(contract) => {
            setEntryFor(null);
            notify("Lançamento registrado.");
            if (contract !== selected) setSelected(contract);
            if (!accounts.some((a) => a.contract_id === contract)) setAll(true);
            changed(contract);
          }}
        />
      )}
      {showCap && (
        <OverrideCapModal
          media={media}
          onClose={() => setShowCap(false)}
          onSaved={(cap) => {
            setShowCap(false);
            notify(cap > 0 ? `Liberação de até ${money(cap)} acima do saldo.` : "Liberação acima do saldo desligada.");
          }}
        />
      )}
      {showCategories && (
        <CategoriesModal
          media={media}
          categories={categories}
          onChange={(list) => {
            remember(categoriesKey, list);
            setCategories(list);
          }}
          onClose={() => setShowCategories(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Statement({
  scope,
  media,
  account,
  categories,
  tick,
  onBack,
  onNew,
  onChanged,
  notify,
}: {
  /** Whose memory of statements (see remembered). */
  scope: string;
  media: MediaBackend;
  account: MediaAccount;
  categories: MediaCategory[];
  tick: number;
  onBack: () => void;
  onNew: (kind: MediaKind) => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) {
  const [filter, setFilter] = useState<StatementFilter>(NO_FILTER);
  const contract = account.contract_id;
  // Warmed up by the hover, or loaded before in this tab: shown at once.
  const [statement, setStatement] = useState<MediaStatement | null>(
    () => remembered<MediaStatement>(statementKey(scope, contract, NO_FILTER, PAGE)) ?? null,
  );
  // "Mostrar mais": the next pages, appended (the first page stays).
  const [more, setMore] = useState<MediaEntry[]>([]);
  const shown = useRef(PAGE);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  // The rows on screen are of another filter, until its answer arrives.
  const [stale, setStale] = useState(false);
  const [reversing, setReversing] = useState<MediaEntry | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [editingMin, setEditingMin] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachFor = useRef("");

  // The first page of the filter; after a live change, as many rows as
  // were on screen, in one question.
  const filterRef = useRef(filter);
  useEffect(() => {
    let alive = true;
    const sameFilter = filterRef.current === filter;
    filterRef.current = filter;
    const limit = sameFilter ? Math.max(PAGE, shown.current) : PAGE;
    const key = statementKey(scope, contract, filter, limit);
    const cached = remembered<MediaStatement>(key);
    if (cached) setStatement(cached);
    setStale(!cached && !sameFilter);
    fetchOnce(key, () => media.statement(contract, filter, limit, 0))
      .then((s) => {
        if (!alive) return;
        setStatement(s);
        setMore([]);
        setStale(false);
        shown.current = s.entries.length;
        setError("");
      })
      .catch((e) => {
        if (!alive) return;
        setStale(false);
        setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [media, scope, contract, filter, tick]);

  async function showMore() {
    if (!statement || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await media.statement(contract, filter, PAGE, statement.entries.length + more.length);
      setMore((list) => [...list, ...next.entries]);
      shown.current = statement.entries.length + more.length + next.entries.length;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function attach(entry: string, files: FileList | null) {
    if (!files?.length) return;
    setAttaching(entry);
    try {
      for (const f of Array.from(files)) await media.attach(entry, f);
      notify(files.length === 1 ? "Comprovante anexado." : "Comprovantes anexados.");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAttaching(null);
    }
  }

  const set = (patch: Partial<StatementFilter>) => {
    shown.current = PAGE;
    setFilter((f) => ({ ...f, ...patch }));
  };
  const filtered = filter.from || filter.to || filter.kind || filter.category;
  const s = statement;
  const rows = s ? (more.length ? [...s.entries, ...more] : s.entries) : [];
  return (
    <section className="media-statement panel" aria-label={`Extrato de ${accountLabel(account)}`}>
      <header className="media-statement-head">
        <button type="button" className="btn secondary media-back" onClick={onBack}>
          ← Contas
        </button>
        <div className="media-statement-title">
          <small>Conta de mídia</small>
          <h2>{accountLabel(account)}</h2>
        </div>
        <div className="media-statement-balance">
          <small>Saldo atual</small>
          <strong className={(s?.balance ?? account.balance) < 0 ? "neg" : ""}>
            {money(s?.balance ?? account.balance)}
          </strong>
          <button type="button" className="media-min" onClick={() => setEditingMin(true)}>
            {(s?.min_balance ?? account.min_balance) === null
              ? "Definir saldo mínimo"
              : `Mínimo ${money((s?.min_balance ?? account.min_balance) as number)}`}
          </button>
        </div>
      </header>
      {(s?.level ?? account.level) !== "ok" && (
        <p className={`media-alert ${s?.level ?? account.level}`} role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          {(s?.level ?? account.level) === "negative"
            ? "Saldo negativo: o cliente precisa repor a verba."
            : "Saldo abaixo do mínimo desta conta."}
        </p>
      )}
      <div className="media-statement-actions">
        <Button className="btn primary" onClick={() => onNew("credit")}>
          <ArrowDownLeft size={16} aria-hidden="true" /> Entrada
        </Button>
        <Button className="btn secondary" onClick={() => onNew("debit")}>
          <ArrowUpRight size={16} aria-hidden="true" /> Saída
        </Button>
      </div>

      <div className="media-filters">
        <label>
          De
          <Input type="date" value={filter.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label>
          Até
          <Input type="date" value={filter.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        <label>
          Tipo
          <Select value={filter.kind || "all"} onValueChange={(v) => set({ kind: v === "all" ? "" : v })}>
            <SelectOption value="all">Todos</SelectOption>
            <SelectOption value="credit">Entradas</SelectOption>
            <SelectOption value="debit">Saídas</SelectOption>
            <SelectOption value="campaign">Gasto das Campanhas</SelectOption>
            <SelectOption value="reversal">Estornos</SelectOption>
          </Select>
        </label>
        <label>
          Categoria
          <Select
            value={filter.category || "all"}
            onValueChange={(v) => set({ category: v === "all" ? "" : v })}
          >
            <SelectOption value="all">Todas</SelectOption>
            {categories.map((c) => (
              <SelectOption key={c.id} value={c.id}>
                {c.name}
                {c.archived ? " (arquivada)" : ""}
              </SelectOption>
            ))}
          </Select>
        </label>
        {filtered && (
          <button type="button" className="btn secondary media-clear" onClick={() => set(NO_FILTER)}>
            Limpar
          </button>
        )}
      </div>
      {s && (
        <p className="media-period">
          {filter.from && (
            <span>
              Saldo antes de {dateBr(filter.from)}: <strong>{money(s.opening)}</strong>
            </span>
          )}
          <span>
            Entradas <strong className="pos">{money(s.credits)}</strong>
          </span>
          <span>
            Saídas <strong className="neg">{money(s.debits)}</strong>
          </span>
          <span>
            {s.total} {s.total === 1 ? "lançamento" : "lançamentos"}
          </span>
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void attach(attachFor.current, e.target.files);
          e.target.value = "";
        }}
      />
      {!s ? (
        <Loading variant="table" />
      ) : !rows.length ? (
        <Empty
          title={filtered ? "Nenhum lançamento com esses filtros" : "Sem lançamentos"}
          body={
            filtered
              ? "Mude o período, o tipo ou a categoria."
              : "Registre a primeira entrada (o saldo inicial ou o depósito do cliente)."
          }
        />
      ) : (
        <div className={`drive-table-wrap${stale ? " media-stale" : ""}`} aria-busy={stale || undefined}>
          <table className="drive-table media-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Lançamento</th>
                <th className="num">Valor</th>
                <th className="num">Saldo</th>
                <th>
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.reversed_by ? "reversed" : ""}>
                  <td className="media-date">{dateBr(e.occurred_on)}</td>
                  <td>
                    <span className="media-what">
                      {e.source === "campaign" ? (
                        <span className="media-tag campaign">
                          <Megaphone size={12} aria-hidden="true" /> Gasto {platformName(e.platform)}
                        </span>
                      ) : e.source === "reversal" ? (
                        <span className="media-tag reversal">
                          <Undo2 size={12} aria-hidden="true" /> Estorno
                        </span>
                      ) : (
                        <span className={`media-tag ${e.kind}`}>{e.category_name}</span>
                      )}
                      <span className="media-reason">{e.reason}</span>
                      <small className="media-who">
                        {e.created_by ? (
                          <>Lançado por {e.created_by_name ?? "pessoa removida"}</>
                        ) : (
                          <span className="media-system">
                            <Bot size={12} aria-hidden="true" /> Lançado pelo Sistema
                          </span>
                        )}{" "}
                        em {dateTimeBr(e.created_at)}
                      </small>
                    </span>
                    {e.reversed_by && (
                      <small className="media-note">
                        Estornado por {e.reversed_by.by_name ?? "Sistema"} em{" "}
                        {dateTimeBr(e.reversed_by.created_at)}: {e.reversed_by.reason}
                      </small>
                    )}
                    {e.reversal_of && (
                      <small className="media-note">Estorno de um lançamento anterior.</small>
                    )}
                    {!!e.receipts.length && (
                      <span className="media-receipts">
                        {e.receipts.map((r) =>
                          r.path ? (
                            <a
                              key={r.id}
                              href={getGcsPublicUrl(r.path)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Paperclip size={12} aria-hidden="true" /> {r.name}
                            </a>
                          ) : (
                            <span key={r.id}>
                              <Paperclip size={12} aria-hidden="true" /> {r.name}
                            </span>
                          ),
                        )}
                      </span>
                    )}
                  </td>
                  <td className={`num media-amount ${e.kind}`}>
                    {e.kind === "credit" ? "+" : "−"} {money(e.amount)}
                  </td>
                  <td className={`num${e.balance_after < 0 ? " neg" : ""}`}>{money(e.balance_after)}</td>
                  <td className="media-row-actions">
                    <Button
                      className="icon-btn"
                      title="Anexar comprovante"
                      aria-label="Anexar comprovante"
                      loading={attaching === e.id}
                      onClick={() => {
                        attachFor.current = e.id;
                        fileRef.current?.click();
                      }}
                    >
                      <Paperclip size={15} />
                    </Button>
                    {e.source !== "reversal" && !e.reversed_by && (
                      <Button
                        className="icon-btn"
                        title="Estornar"
                        aria-label="Estornar"
                        onClick={() => setReversing(e)}
                      >
                        <Undo2 size={15} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length < s.total && (
            <div className="media-more">
              <Button className="btn secondary" loading={loadingMore} onClick={() => void showMore()}>
                Mostrar mais ({s.total - rows.length})
              </Button>
            </div>
          )}
        </div>
      )}
      {reversing && (
        <ReverseModal
          entry={reversing}
          onClose={() => setReversing(null)}
          onSave={async (reason) => {
            await media.reverse(reversing.id, reason);
            setReversing(null);
            notify("Lançamento estornado.");
            onChanged();
          }}
        />
      )}
      {editingMin && (
        <MinBalanceModal
          account={account}
          current={s?.min_balance ?? account.min_balance}
          onClose={() => setEditingMin(false)}
          onSave={async (min) => {
            await media.setMinBalance(account.contract_id, min);
            setEditingMin(false);
            notify(min === null ? "Saldo mínimo removido." : "Saldo mínimo salvo.");
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function EntryModal({
  media,
  accounts,
  loadAll,
  categories,
  initial,
  onClose,
  onSaved,
}: {
  media: MediaBackend;
  /** Every account the person uses, when already loaded. */
  accounts: MediaAccount[] | null;
  loadAll: () => Promise<MediaAccount[]>;
  categories: MediaCategory[];
  initial: { contract: string; kind: MediaKind };
  onClose: () => void;
  onSaved: (contract: string) => void;
}) {
  const today = dateKey();
  const [options, setOptions] = useState<MediaAccount[] | null>(accounts);
  const [contract, setContract] = useState(initial.contract);
  const [kind, setKind] = useState<MediaKind>(initial.kind);
  const [amount, setAmount] = useState("");
  const [on, setOn] = useState(today);
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!options) loadAll().then(setOptions).catch((e) => setError((e as Error).message));
  }, [options, loadAll]);
  const usable = categoriesFor(categories, kind);
  useEffect(() => {
    if (category && !usable.some((c) => c.id === category)) setCategory("");
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = parseMoney(amount);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const checked = entryInput({ contract, kind, amount, occurred_on: on, category, reason }, today);
    if ("error" in checked) return setError(checked.error);
    setError("");
    setSaving(true);
    try {
      const id = await media.createEntry(checked.input);
      // The entry stands even if a receipt fails: it can be attached later.
      for (const f of files)
        await media.attach(id, f).catch((err) => {
          throw Error(`Lançamento registrado, mas o comprovante ${f.name} não foi enviado: ${(err as Error).message} Anexe de novo pelo extrato.`);
        });
      onSaved(checked.input.contract);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  const chosen = options?.find((a) => a.contract_id === contract);
  return (
    <Modal title="Novo lançamento" onClose={() => !saving && onClose()} busy={saving}>
      <form className="entity-form media-entry-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          <div className="media-kind" role="radiogroup" aria-label="Tipo">
            {(["credit", "debit"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                className={`media-kind-option ${k}${kind === k ? " selected" : ""}`}
                onClick={() => setKind(k)}
              >
                {k === "credit" ? <ArrowDownLeft size={16} aria-hidden="true" /> : <ArrowUpRight size={16} aria-hidden="true" />}
                {KIND_LABEL[k]}
                <small>{k === "credit" ? "crédito na conta" : "débito da conta"}</small>
              </button>
            ))}
          </div>
          <label>
            Conta (cliente › produto)
            {options ? (
              <Select value={contract} onValueChange={setContract} required>
                <SelectOption value="">Escolha a conta</SelectOption>
                {options
                  .filter((a) => !a.archived || a.contract_id === contract)
                  .map((a) => (
                    <SelectOption key={a.contract_id} value={a.contract_id}>
                      {accountLabel(a)}
                    </SelectOption>
                  ))}
              </Select>
            ) : (
              <Loading compact />
            )}
            {chosen && <small>Saldo agora: {money(chosen.balance)}</small>}
          </label>
          <div className="media-form-row">
            <label>
              Valor (R$)
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
                required
              />
              {!Number.isNaN(value) && value > 0 && <small>{money(value)}</small>}
            </label>
            <label>
              Data
              <Input type="date" value={on} max={today} onChange={(e) => setOn(e.target.value)} required />
              <small>Quando o dinheiro {kind === "credit" ? "entrou" : "saiu"}.</small>
            </label>
          </div>
          <label>
            Categoria
            <Select value={category} onValueChange={setCategory} required>
              <SelectOption value="">Escolha a categoria</SelectOption>
              {usable.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.name}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label>
            Motivo
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={1000}
              required
              placeholder={
                kind === "credit"
                  ? "Ex.: Pix do cliente para a verba de outubro"
                  : "Ex.: devolução do saldo que sobrou do ciclo de setembro"
              }
            />
            <small>Fica no extrato com o seu nome. Lançamentos não são editados: um erro se corrige com estorno.</small>
          </label>
          <label>
            Comprovantes (opcional)
            <input
              type="file"
              multiple
              className="ui-input"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <small>{ATTACHMENT_HINT}.</small>
          </label>
          {error && <p className="form-error">{error}</p>}
        </fieldset>
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={saving}>
            Registrar {kind === "credit" ? "entrada" : "saída"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReverseModal({
  entry,
  onClose,
  onSave,
}: {
  entry: MediaEntry;
  onClose: () => void;
  onSave: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // The dialog focuses its first input; here the reason comes first.
  useEffect(() => {
    requestAnimationFrame(() => form.current?.querySelector("textarea")?.focus());
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (reason.trim().length < 3) return setError("Escreva o motivo do estorno.");
    setError("");
    setSaving(true);
    try {
      await onSave(reason.trim());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <Modal title="Estornar lançamento" onClose={() => !saving && onClose()} busy={saving}>
      <form ref={form} className="entity-form" onSubmit={submit}>
        <p className="campaign-form-context">
          {KIND_LABEL[entry.kind]} de {money(entry.amount)} em {dateBr(entry.occurred_on)}
          <br />
          <small>{entry.reason}</small>
        </p>
        <p className="media-hint">
          O estorno lança {entry.kind === "credit" ? "uma saída" : "uma entrada"} de {money(entry.amount)} com a data de
          hoje. O lançamento original continua no extrato, marcado como estornado.
        </p>
        <label>
          Motivo do estorno
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
            required
            placeholder="Ex.: lançado no cliente errado"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={saving}>
            Estornar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MinBalanceModal({
  account,
  current,
  onClose,
  onSave,
}: {
  account: MediaAccount;
  current: number | null;
  onClose: () => void;
  onSave: (min: number | null) => Promise<void>;
}) {
  const [value, setValue] = useState(
    current === null ? "" : current.toLocaleString("pt-BR", { minimumFractionDigits: 2 }),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(min: number | null) {
    setSaving(true);
    setError("");
    try {
      await onSave(min);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!value.trim()) return void save(null);
    const min = parseMoney(value);
    if (Number.isNaN(min) || min < 0) return setError("Informe um valor em reais, zero ou mais.");
    void save(Math.round(min * 100) / 100);
  }
  return (
    <Modal title="Saldo mínimo" onClose={() => !saving && onClose()} busy={saving}>
      <form className="entity-form" onSubmit={submit}>
        <p className="campaign-form-context">{accountLabel(account)}</p>
        <label>
          Saldo mínimo (R$)
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ex.: 500,00" />
          <small>
            Quando o saldo ficar abaixo dele, os líderes e quem atende o cliente recebem um aviso (sino e push). Sem
            mínimo, o aviso sai só quando o saldo fica negativo.
          </small>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-footer">
          {current !== null && (
            <Button type="button" className="btn secondary" onClick={() => void save(null)} disabled={saving}>
              Remover mínimo
            </Button>
          )}
          <Button type="submit" className="btn primary" loading={saving}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The release cap of the cycles' budget (migration 20270222090000). */
function OverrideCapModal({
  media,
  onClose,
  onSaved,
}: {
  media: MediaBackend;
  onClose: () => void;
  onSaved: (cap: number) => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    media
      .overrideCap()
      .then((cap) => setValue(cap.toLocaleString("pt-BR", { minimumFractionDigits: 2 })))
      .catch((e) => {
        setValue("");
        setError((e as Error).message);
      });
  }, [media]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || value === null) return;
    const cap = value.trim() ? parseMoney(value) : 0;
    if (Number.isNaN(cap) || cap < 0) return setError("Informe um valor em reais, zero ou mais.");
    setSaving(true);
    setError("");
    try {
      onSaved(await media.setOverrideCap(Math.round(cap * 100) / 100));
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <Modal title="Liberação acima do saldo" onClose={() => !saving && onClose()} busy={saving}>
      {value === null ? (
        <Loading compact />
      ) : (
        <form className="entity-form" onSubmit={submit}>
          <label>
            Valor máximo da liberação (R$)
            <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ex.: 2.000,00" />
            <small>
              Nas Campanhas, a verba de um ciclo precisa caber no saldo de mídia do cliente (saldo menos o que os ciclos
              abertos ainda vão gastar). Administradores e gestores podem passar por cima, com um motivo, até este valor
              acima do disponível; a liberação fica no histórico da campanha. Zero desliga a liberação.
            </small>
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-footer">
            <Button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" className="btn primary" loading={saving}>
              Salvar
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function CategoriesModal({
  media,
  categories,
  onChange,
  onClose,
}: {
  media: MediaBackend;
  categories: MediaCategory[];
  onChange: (list: MediaCategory[]) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<{
    id: string | null;
    name: string;
    kind: MediaCategory["kind"];
    archived: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(c: NonNullable<typeof editing>) {
    setSaving(true);
    setError("");
    try {
      onChange(await media.saveCategory(c));
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Categorias dos lançamentos" onClose={() => !saving && onClose()} busy={saving}>
      <div className="entity-form media-categories">
        <p className="media-hint">
          A categoria é escolhida em cada entrada e saída. Arquivar tira dos novos lançamentos e mantém nos antigos.
        </p>
        <ul>
          {categories.map((c) => (
            <li key={c.id} className={c.archived ? "archived" : ""}>
              <span>
                <strong>{c.name}</strong>
                <small>
                  {CATEGORY_KIND_LABEL[c.kind]} · {c.entries} {c.entries === 1 ? "lançamento" : "lançamentos"}
                  {c.archived && " · arquivada"}
                </small>
              </span>
              <span className="media-category-actions">
                <button type="button" className="btn secondary" disabled={saving} onClick={() => setEditing({ ...c })}>
                  Editar
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={saving}
                  onClick={() => void save({ ...c, archived: !c.archived })}
                >
                  {c.archived ? "Reativar" : "Arquivar"}
                </button>
              </span>
            </li>
          ))}
        </ul>
        {editing ? (
          <form
            className="media-category-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save(editing);
            }}
          >
            <label>
              Nome
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={60}
                required
                autoFocus
              />
            </label>
            <label>
              Vale para
              <Select
                value={editing.kind}
                onValueChange={(v) => setEditing({ ...editing, kind: v as MediaCategory["kind"] })}
              >
                <SelectOption value="credit">Entradas</SelectOption>
                <SelectOption value="debit">Saídas</SelectOption>
                <SelectOption value="both">Entradas e saídas</SelectOption>
              </Select>
            </label>
            <div className="form-footer">
              <Button type="button" className="btn secondary" onClick={() => setEditing(null)} disabled={saving}>
                Cancelar
              </Button>
              <Button type="submit" className="btn primary" loading={saving}>
                {editing.id ? "Salvar" : "Criar categoria"}
              </Button>
            </div>
          </form>
        ) : (
          <Button
            className="btn secondary"
            onClick={() => setEditing({ id: null, name: "", kind: "credit", archived: false })}
          >
            <Plus size={15} aria-hidden="true" /> Nova categoria
          </Button>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}

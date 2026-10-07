import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CalendarPlus, History, Maximize2, Minimize2, Plus, Sparkles, Trash2, Wallet } from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading, Textarea } from "./ui";
import { addMonths, fmtMoney, labelMesFull, monthStart, numberFormat, type CsDataClient } from "./cs-engine";
import { HS_CRITERIA } from "./cs-hs";
import { demoCsData, demoHsSuggestions, loadHsSuggestions, type HsSuggestions } from "./cs-dashboard";
import { csPill } from "./CsCommon";
import {
  canEdit,
  demoEntry,
  gridRows,
  logChanges,
  parseDate,
  parseMoney,
  realEntry,
  type CsEditLog,
  type CsEntryAccess,
  type CsEntryBackend,
  type CycleFields,
  type EntryClient,
  type EntryCycle,
  type EntryGoal,
  type EntryHs,
  type EntryMonth,
  type GridRow,
  type HsKey,
  type OpenMonth,
} from "./cs-entry";
import { SourceSwitchDialog } from "./CsSourceSwitch";
import "./cs-dashboard.css";
import "./cs-entry.css";

/**
 * Customer Success › Lançamentos (fase 5, migração 20270525090000): a grade
 * do mês no jeito da planilha — ciclos e Health Score com edição na célula —,
 * o cadastro dos clientes, as metas dos squads, o "Abrir mês" e o histórico.
 * Líderes lançam tudo; quem está num squad, os ciclos e o HS dos seus
 * clientes. Enquanto a fonte é a planilha, é só prévia.
 */

type Tab = "cycles" | "hs" | "clients" | "goals" | "log";
const TABS: { id: Tab; label: string }[] = [
  { id: "cycles", label: "Ciclos" },
  { id: "hs", label: "Health Score" },
  { id: "clients", label: "Clientes" },
  { id: "goals", label: "Metas" },
  { id: "log", label: "Histórico" },
];
const PROB = ["ALTA", "PROVAVEL", "BAIXA"] as const;
const PROB_LABEL: Record<string, string> = { ALTA: "Alta", PROVAVEL: "Provável", BAIXA: "Baixa" };
const STATUS = ["PENDENTE", "PAGO", "PARCIAL", "PERDA", "ISENTO"] as const;
const STATUS_LABEL: Record<string, string> = { PENDENTE: "Pendente", PAGO: "Pago", PARCIAL: "Parcial", PERDA: "Perda", ISENTO: "Isento" };
const ADIMP = ["ADIMPLENTE", "INADIMPLENTE", "PERDA"] as const;
const ADIMP_LABEL: Record<string, string> = { ADIMPLENTE: "Adimplente", INADIMPLENTE: "Inadimplente", PERDA: "Perda" };
const KIND = ["BASE", "TRIAL", "BASE_RA"] as const;
const KIND_LABEL: Record<string, string> = { BASE: "Base", TRIAL: "Trial", BASE_RA: "Base RA" };
const ORIGIN = ["comercial", "reativacao", "troca"] as const;
const ORIGIN_LABEL: Record<string, string> = { comercial: "Comercial", reativacao: "Reativação", troca: "Troca" };
const CLIENT_STATUS = ["ATIVO", "MAKE_IN", "INATIVO"] as const;
const CLIENT_STATUS_LABEL: Record<string, string> = { ATIVO: "Ativo", MAKE_IN: "Make In", INATIVO: "Inativo" };
const REASONS = ["performance", "financeiro", "fechou", "estrategia"] as const;
const REASON_LABEL: Record<string, string> = {
  performance: "Performance", financeiro: "Financeiro", fechou: "Fechou/pivotou", estrategia: "Estratégia",
};
const ENTITY_LABEL: Record<CsEditLog["entity"], string> = {
  source: "Fonte dos dados", client: "Cliente", cycle: "Ciclo", hs: "Health Score", goal: "Meta", month: "Abrir mês",
};
const ACTION_LABEL: Record<CsEditLog["action"], string> = { insert: "criou", update: "alterou", delete: "excluiu" };

const dateBr = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");
const dateShort = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");
const moneyRaw = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const errMsg = (e: unknown) => (e as Error)?.message ?? String(e);

export function CustomerSuccessPage({
  company,
  demo,
  notify,
}: {
  company: string;
  demo: boolean;
  notify: (message: string) => void;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo<CsEntryBackend>(() => (demo ? demoEntry() : realEntry), [demo]);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  });
  const [tab, setTab] = useState<Tab>("cycles");
  const [squad, setSquad] = useState<string>("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<EntryMonth | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<null | "open" | "switch" | "client">(null);
  // Tela cheia: a grade ocupa a janela toda (sem o menu); Esc sai, a não ser
  // que esteja editando uma célula ou com uma janela aberta.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("dialog[open]")) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, select, textarea, [contenteditable='true']")) return;
      setFull(false);
    };
    document.documentElement.classList.add("cs-entry-full-open");
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove("cs-entry-full-open");
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);
  const load = useCallback(() => {
    api.month(company, month)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(errMsg(e)));
  }, [api, company, month]);
  useEffect(() => {
    load();
    let timer: number | undefined;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 600);
    };
    window.addEventListener("mavi:cs", onChange);
    return () => {
      window.removeEventListener("mavi:cs", onChange);
      window.clearTimeout(timer);
    };
  }, [load]);

  if (error && !data) return <section className="panel"><p className="cs-error">{error}</p></section>;
  if (!data) return <Loading variant="grid" />;
  const access = data.access;
  const isMavi = access.source === "mavi";
  const shownMonth = data.month;
  const cur = monthStart(access.today);
  const canOpen = access.is_leader && isMavi && shownMonth <= addMonths(cur, 1);
  const squadName = (id: string | null | undefined) => data.squads.find((s) => s.id === id)?.name ?? "—";
  const rows = gridRows(data, squad || null, query);

  const ctx: GridCtx = {
    api, company, data, access, notify, squadName,
    patch: (fn) => setData((d) => (d ? fn(structuredClone(d)) : d)),
  };
  return (
    <div className={`cs-entry ${full ? "full" : ""}`}>
      <SourceBanner access={access} onSwitch={() => setDialog("switch")} />
      <div className="cs-entry-bar">
        <div className="cs-entry-month" role="group" aria-label="Mês">
          <button type="button" className="btn ghost icon" aria-label="Mês anterior" onClick={() => setMonth(addMonths(shownMonth, -1))}>
            <ChevronLeft size={18} />
          </button>
          <strong>{labelMesFull(shownMonth)}</strong>
          <button type="button" className="btn ghost icon" aria-label="Próximo mês" onClick={() => setMonth(addMonths(shownMonth, 1))}>
            <ChevronRight size={18} />
          </button>
          {shownMonth !== cur && (
            <button type="button" className="btn ghost small" onClick={() => setMonth(cur)}>Mês atual</button>
          )}
        </div>
        {tab !== "goals" && tab !== "log" && (
          <>
            <select className="cs-entry-filter" value={squad} onChange={(e) => setSquad(e.target.value)} aria-label="Squad">
              <option value="">Todos os squads</option>
              {data.squads.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <Input className="cs-entry-search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar cliente ou ID" aria-label="Buscar cliente" />
          </>
        )}
        <div className="cs-entry-actions">
          {tab === "clients" && access.is_leader && isMavi && (
            <Button className="btn secondary" onClick={() => setDialog("client")}><Plus size={16} /> Novo cliente</Button>
          )}
          {canOpen && (
            <Button className="btn primary" onClick={() => setDialog("open")}>
              <CalendarPlus size={16} /> Abrir {labelMesFull(shownMonth)}
            </Button>
          )}
          <Button className="btn secondary" aria-pressed={full} onClick={() => setFull((v) => !v)}
            title={full ? "Voltar ao tamanho normal (Esc)" : "Ampliar a tabela para a tela inteira"}>
            {full ? <><Minimize2 size={16} /> Sair da tela cheia</> : <><Maximize2 size={16} /> Tela cheia</>}
          </Button>
        </div>
      </div>
      <div className="cs-entry-tabs" role="tablist">
        {TABS.filter((t) => t.id !== "goals" || access.is_leader).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "cycles" && <CyclesGrid ctx={ctx} rows={rows} />}
      {tab === "hs" && <HsGrid ctx={ctx} rows={rows} demo={demo} />}
      {tab === "clients" && <ClientsGrid ctx={ctx} squad={squad} query={query} />}
      {tab === "goals" && <GoalsGrid ctx={ctx} />}
      {tab === "log" && <LogList ctx={ctx} />}
      {dialog === "open" && (
        <OpenMonthDialog ctx={ctx} onClose={() => setDialog(null)} onDone={(n) => {
          setDialog(null);
          notify(n ? `${n} ${n === 1 ? "ciclo criado" : "ciclos criados"} em ${labelMesFull(shownMonth)}.` : "Nenhum ciclo a criar.");
          load();
        }} />
      )}
      {dialog === "switch" && (
        <SourceSwitchDialog api={api} company={company} access={access} onClose={() => setDialog(null)} onDone={() => {
          setDialog(null);
          load();
        }} notify={notify} />
      )}
      {dialog === "client" && <ClientDialog ctx={ctx} onClose={() => setDialog(null)} />}
    </div>
  );
}

type GridCtx = {
  api: CsEntryBackend;
  company: string;
  data: EntryMonth;
  access: CsEntryAccess;
  notify: (m: string) => void;
  squadName: (id: string | null | undefined) => string;
  patch: (fn: (d: EntryMonth) => EntryMonth) => void;
};

// ------------------------------------------------------------ a chave
function SourceBanner({ access, onSwitch }: { access: CsEntryAccess; onSwitch: () => void }) {
  if (access.source === "mavi")
    return (
      <p className="cs-entry-source mavi">
        <b>Fonte: MAVI.</b> Os lançamentos são feitos aqui
        {access.source_changed_at && <> desde {new Date(access.source_changed_at).toLocaleDateString("pt-BR")}</>}
        {access.source_changed_by && <> ({access.source_changed_by} virou a chave)</>}. A planilha não é mais lida.
        {!access.is_leader && " Você lança os ciclos e o Health Score dos clientes do seu squad."}
      </p>
    );
  return (
    <div className="cs-entry-source sheet" role="status">
      <div>
        <b>Prévia: a fonte do CS ainda é a planilha.</b> Os números aqui vêm da leitura a cada 10 minutos e não dá para lançar.
        Quando o time estiver pronto, {access.can_switch ? "vire a chave" : "um administrador vira a chave"}: a leitura para, o
        histórico fica e os lançamentos passam a ser feitos aqui.
      </div>
      {access.can_switch && <Button className="btn secondary small" onClick={onSwitch}>Virar a chave</Button>}
    </div>
  );
}

// ------------------------------------------------------------ células
type CellKind = "money" | "date" | "text" | "int" | "pct";
/** Uma célula editável como na planilha: clique, Enter ou F2 edita; Enter grava, Esc desiste. */
function EditCell({
  value,
  kind,
  editable,
  month,
  onSave,
  display,
  className = "",
  title,
  onOpen,
}: {
  value: string | number | null | undefined;
  kind: CellKind;
  editable: boolean;
  month: string;
  onSave: (v: string | number | null) => Promise<unknown>;
  display?: ReactNode;
  className?: string;
  title?: string;
  /** Em vez de editar na célula, abre uma janela (as parcelas). */
  onOpen?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState("");
  const ref = useRef<HTMLTableCellElement>(null);
  const raw = kind === "money" ? moneyRaw(value as number | null) : kind === "date" ? dateBr(value as string | null)
    : value === null || value === undefined ? "" : String(value);
  const shown = display ?? (kind === "money" ? (value === null || value === undefined ? "" : fmtMoney(value as number))
    : kind === "date" ? dateShort(value as string | null) : kind === "pct" && value !== null && value !== undefined ? `${value}%` : raw);
  function start() {
    if (!editable || busy) return;
    if (onOpen) return onOpen();
    setBad("");
    setEditing(true);
  }
  async function commit(text: string) {
    let v: string | number | null;
    if (kind === "money") {
      const n = parseMoney(text);
      if (Number.isNaN(n)) return setBad("Valor inválido");
      v = n;
    } else if (kind === "int" || kind === "pct") {
      const t = text.trim().replace("%", "").replace(",", ".");
      if (t && !/^\d+(\.\d+)?$/.test(t)) return setBad("Número inválido");
      v = t ? Number(t) : null;
    } else if (kind === "date") {
      const d = parseDate(text, month);
      if (d === undefined) return setBad("Data inválida (dd/mm/aaaa)");
      v = d;
    } else v = text.trim() || null;
    setEditing(false);
    if ((v ?? "") === (value ?? "") || (kind === "money" && v === (value === null ? null : Number(value)))) return;
    setBusy(true);
    try {
      await onSave(v);
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTableCellElement>) => {
    if (!editing && (e.key === "Enter" || e.key === "F2")) {
      e.preventDefault();
      start();
    }
  };
  return (
    <td ref={ref} className={`cs-cell ${kind} ${editable ? "editable" : ""} ${busy ? "busy" : ""} ${bad ? "bad" : ""} ${className}`}
      tabIndex={editable ? 0 : undefined} onClick={() => !editing && start()} onKeyDown={onKey} title={bad || title}>
      {editing ? (
        <input autoFocus defaultValue={raw} aria-label={title ?? "Valor"} onFocus={(e) => e.target.select()} inputMode={kind === "text" || kind === "date" ? undefined : "decimal"}
          onBlur={(e) => void commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setBad("");
              setEditing(false);
              ref.current?.focus();
            }
          }} />
      ) : shown}
    </td>
  );
}

function SelectCell<T extends string>({
  value,
  options,
  labels,
  editable,
  onSave,
  pill = true,
  allowEmpty = false,
  title,
}: {
  value: T | null;
  options: readonly T[];
  labels: Record<string, string>;
  editable: boolean;
  onSave: (v: T | null) => Promise<unknown>;
  pill?: boolean;
  allowEmpty?: boolean;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  if (!editable)
    return <td className="cs-cell">{value ? (pill ? <span className={`cs-pill ${csPill(value)}`}>{labels[value] ?? value}</span> : labels[value] ?? value) : ""}</td>;
  return (
    <td className={`cs-cell select editable ${busy ? "busy" : ""}`}>
      <select value={value ?? ""} aria-label={title} className={pill && value ? `tone-${csPill(value) || "plain"}` : ""}
        onChange={async (e) => {
          setBusy(true);
          try {
            await onSave((e.target.value || null) as T | null);
          } finally {
            setBusy(false);
          }
        }}>
        {(allowEmpty || !value) && <option value="">—</option>}
        {options.map((o) => <option key={o} value={o}>{labels[o] ?? o}</option>)}
      </select>
    </td>
  );
}

function CheckCell({ value, editable, onSave, title }: {
  value: boolean; editable: boolean; onSave: (v: boolean) => Promise<unknown>; title: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <td className={`cs-cell check ${editable ? "editable" : ""} ${busy ? "busy" : ""}`}>
      <input type="checkbox" checked={value} disabled={!editable || busy} aria-label={title}
        onChange={async (e) => {
          setBusy(true);
          try {
            await onSave(e.target.checked);
          } finally {
            setBusy(false);
          }
        }} />
    </td>
  );
}

// ------------------------------------------------------------ ciclos
function CyclesGrid({ ctx, rows }: { ctx: GridCtx; rows: GridRow[] }) {
  const { api, company, data, access, notify } = ctx;
  const [payments, setPayments] = useState<GridRow | null>(null);
  const [remove, setRemove] = useState<GridRow | null>(null);
  const month = data.month;
  const writable = access.scope.scope === "all" ? data.squads.filter((s) => !s.archived).map((s) => s.id)
    : access.scope.squads;
  async function save(r: GridRow, fields: CycleFields) {
    try {
      const y = await api.saveCycle(company, r.client.id, month, fields);
      ctx.patch((d) => ({ ...d, cycles: [...d.cycles.filter((x) => x.cs_client_id !== r.client.id), y] }));
    } catch (e) {
      notify(errMsg(e));
      throw e;
    }
  }
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
  const withCycle = rows.filter((r) => r.cycle);
  const sum = (f: (y: EntryCycle) => number | null) => withCycle.reduce((s, r) => s + (f(r.cycle!) ?? 0), 0);
  if (!rows.length) return <p className="cs-entry-empty">Nenhum cliente na carteira em {labelMesFull(month)} com esse filtro.</p>;
  return (
    <>
      <div className="cs-entry-grid-wrap">
        <table className="cs-entry-grid">
          <thead>
            <tr>
              <th className="sticky">Cliente</th>
              <th>Squad</th>
              <th>Início</th>
              <th>Fim</th>
              <th>Cobrança</th>
              <th className="r">Melhor</th>
              <th className="r">Provável</th>
              <th>Prob.</th>
              <th className="r">Pago</th>
              <th>Pago em</th>
              <th>Status</th>
              <th>Adimplência</th>
              <th title="Ajuste de comissão de lead">ACL</th>
              <th className="r" title="Mensalidade pós-graduação prevista">Mensal. prev.</th>
              <th className="r" title="Mensalidade pós-graduação paga">Mensal. paga</th>
              <th>Observações</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const y = r.cycle;
              const ed = canEdit(access, r.squad);
              const set = (k: keyof CycleFields) => (v: unknown) => quiet(save(r, { [k]: v } as CycleFields));
              return (
                <tr key={r.client.id} className={y ? "" : "empty"}>
                  <th className="sticky" scope="row">
                    <span className="cs-entry-name">{r.client.name}</span>
                    <small>#{r.client.external_id}{r.client.kind === "TRIAL" && <span className="cs-pill orange">Trial</span>}
                      {!y && <span className="cs-entry-nocycle">sem ciclo</span>}</small>
                  </th>
                  <SelectCell value={y?.squad_id ?? r.client.squad_id} options={writable.includes(r.squad) ? writable : [r.squad, ...writable]}
                    labels={Object.fromEntries(data.squads.map((s) => [s.id, s.name]))} pill={false} title="Squad"
                    editable={ed && writable.length > 1} onSave={set("squad_id")} />
                  <EditCell kind="date" value={y?.start_date} editable={ed} month={month} onSave={set("start_date")} title="Início do ciclo" />
                  <EditCell kind="date" value={y?.end_date} editable={ed} month={month} onSave={set("end_date")} title="Fim do ciclo" />
                  <EditCell kind="date" value={y?.billing_date} editable={ed} month={month} onSave={set("billing_date")} title="Cobrança" />
                  <EditCell kind="money" value={y?.best} editable={ed} month={month} onSave={set("best")} title="Melhor cenário" className="r" />
                  <EditCell kind="money" value={y?.probable} editable={ed} month={month} onSave={set("probable")} className="r"
                    title={r.previous ? `Provável · mês anterior: ${fmtMoney(r.previous.probable)} (${STATUS_LABEL[r.previous.status]})` : "Provável"} />
                  <SelectCell value={y?.probability ?? null} options={PROB} labels={PROB_LABEL} pill={false} editable={ed}
                    onSave={set("probability")} title="Probabilidade" />
                  <EditCell kind="money" value={y?.paid} editable={ed} month={month} onSave={set("paid")} className="r" title="Pago"
                    onOpen={y && y.payments.length > 1 ? () => setPayments(r) : undefined}
                    display={y && y.payments.length > 1 ? <>{fmtMoney(y.paid)} <small className="cs-muted">· {y.payments.length}x</small></> : undefined} />
                  <EditCell kind="date" value={y?.paid_date} editable={ed && !(y && y.payments.length > 1)} month={month}
                    onSave={set("paid_date")} title="Data do pagamento" />
                  <SelectCell value={y?.status ?? null} options={STATUS} labels={STATUS_LABEL} editable={ed} onSave={set("status")} title="Status" />
                  <SelectCell value={y?.adimplencia ?? null} options={ADIMP} labels={ADIMP_LABEL} editable={ed} onSave={set("adimplencia")}
                    title="Adimplência" />
                  <td className={`cs-cell check acl ${ed ? "editable" : ""}`}>
                    <input type="checkbox" checked={!!y?.acl} disabled={!ed} aria-label="ACL"
                      onChange={(e) => void quiet(save(r, { acl: e.target.checked }))} />
                    {y?.acl && (
                      <button type="button" className="cs-entry-link" disabled={!ed} onClick={() => {
                        const t = window.prompt("Valor do ACL (vazio: o ciclo inteiro)", moneyRaw(y.acl_value));
                        if (t === null) return;
                        const n = parseMoney(t);
                        if (Number.isNaN(n)) return notify("Valor inválido.");
                        void quiet(save(r, { acl_value: n }));
                      }}>{y.acl_value ? fmtMoney(y.acl_value) : "ciclo"}</button>
                    )}
                  </td>
                  <EditCell kind="money" value={y?.fee_planned} editable={ed} month={month} onSave={set("fee_planned")} className="r" title="Mensalidade prevista" />
                  <EditCell kind="money" value={y?.fee_paid} editable={ed} month={month} onSave={set("fee_paid")} className="r" title="Mensalidade paga" />
                  <EditCell kind="text" value={y?.notes} editable={ed} month={month} onSave={set("notes")} className="notes" title="Observações" />
                  <td className="cs-cell actions">
                    {ed && (
                      <>
                        <button type="button" className="btn ghost icon small" title="Pagamento em parcelas" aria-label="Parcelas"
                          onClick={() => setPayments(r)}><Wallet size={14} /></button>
                        {y && (
                          <button type="button" className="btn ghost icon small" title="Excluir o ciclo" aria-label="Excluir o ciclo"
                            onClick={() => setRemove(r)}><Trash2 size={14} /></button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th className="sticky" scope="row">{withCycle.length} {withCycle.length === 1 ? "ciclo" : "ciclos"}</th>
              <td colSpan={4} />
              <td className="r">{fmtMoney(sum((y) => y.best))}</td>
              <td className="r">{fmtMoney(sum((y) => y.probable))}</td>
              <td />
              <td className="r">{fmtMoney(sum((y) => y.paid))}</td>
              <td colSpan={4} />
              <td className="r">{fmtMoney(sum((y) => y.fee_planned))}</td>
              <td className="r">{fmtMoney(sum((y) => y.fee_paid))}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="cs-muted cs-small cs-entry-help">
        Clique na célula (ou Enter) para editar, Enter grava, Esc desiste. Datas como 10/10 ou 10/10/2026; valores como 1.500,00.
        Mudar o fim do ciclo, a cobrança ou o provável guarda o replanejamento.
      </p>
      {payments && <PaymentsDialog row={payments} month={month} onClose={() => setPayments(null)}
        onSave={async (list) => {
          await save(payments, { payments: list, ...(list.length ? {} : { paid: 0, paid_date: null }) });
          setPayments(null);
        }} />}
      {remove && <ReasonDialog title={`Excluir o ciclo de ${remove.client.name}`} action="Excluir"
        text={`O ciclo de ${labelMesFull(month)} sai do painel (receita, recebimento e carteira). Fica no histórico.`}
        onClose={() => setRemove(null)} onConfirm={async (reason) => {
          await api.deleteCycle(company, remove.client.id, month, reason);
          ctx.patch((d) => ({ ...d, cycles: d.cycles.filter((x) => x.cs_client_id !== remove.client.id) }));
          setRemove(null);
          notify("Ciclo excluído.");
        }} />}
    </>
  );
}

function PaymentsDialog({ row, month, onClose, onSave }: {
  row: GridRow; month: string; onClose: () => void; onSave: (list: { date: string; amount: number }[]) => Promise<void>;
}) {
  const init = row.cycle?.payments.length ? row.cycle.payments.map((p) => ({ date: dateBr(p.date), amount: moneyRaw(p.amount) }))
    : row.cycle?.paid ? [{ date: dateBr(row.cycle.paid_date), amount: moneyRaw(row.cycle.paid) }] : [{ date: "", amount: "" }];
  const [list, setList] = useState(init);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsed = list.map((p) => ({ date: parseDate(p.date, month), amount: parseMoney(p.amount) }));
  const total = parsed.reduce((s, p) => s + (p.amount && !Number.isNaN(p.amount) ? p.amount : 0), 0);
  return (
    <Modal title={`Pagamento de ${row.client.name}`} onClose={() => !busy && onClose()} busy={busy}>
      <form className="entity-form" onSubmit={async (ev) => {
        ev.preventDefault();
        const ok = parsed.filter((p) => p.amount);
        if (ok.some((p) => !p.date || Number.isNaN(p.amount))) return setError("Cada parcela precisa de data (dd/mm/aaaa) e valor.");
        setBusy(true);
        try {
          await onSave(ok.map((p) => ({ date: p.date!, amount: p.amount! })));
        } catch (e) {
          setError(errMsg(e));
          setBusy(false);
        }
      }}>
        <p className="cs-hint">O pago do ciclo é a soma das parcelas, e a data do pagamento é a da primeira. Até 6 parcelas.</p>
        <div className="cs-entry-payments">
          {list.map((p, i) => (
            <div key={i} className="cs-entry-payment">
              <Input value={p.date} placeholder="dd/mm/aaaa" aria-label={`Data da parcela ${i + 1}`}
                onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
              <Input value={p.amount} placeholder="R$" inputMode="decimal" aria-label={`Valor da parcela ${i + 1}`}
                onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <button type="button" className="btn ghost icon small" aria-label="Remover a parcela"
                onClick={() => setList((l) => l.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        {list.length < 6 && (
          <button type="button" className="btn ghost small" onClick={() => setList((l) => [...l, { date: "", amount: "" }])}>
            <Plus size={14} /> Parcela
          </button>
        )}
        <p><b>Total: {fmtMoney(total)}</b></p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button className="btn primary" type="submit" loading={busy}>Gravar o pagamento</Button>
      </form>
    </Modal>
  );
}

function ReasonDialog({ title, text, action, onClose, onConfirm }: {
  title: string; text: string; action: string; onClose: () => void; onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={title} onClose={() => !busy && onClose()} busy={busy}>
      <form className="entity-form" onSubmit={async (ev) => {
        ev.preventDefault();
        if (reason.trim().length < 3) return setError("Diga o motivo.");
        setBusy(true);
        try {
          await onConfirm(reason.trim());
        } catch (e) {
          setError(errMsg(e));
          setBusy(false);
        }
      }}>
        <p className="cs-hint">{text}</p>
        <label>
          Motivo
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button className="btn primary danger" type="submit" loading={busy}>{action}</Button>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ Health Score
function HsGrid({ ctx, rows, demo }: { ctx: GridCtx; rows: GridRow[]; demo: boolean }) {
  const { api, company, data, access, notify } = ctx;
  const month = data.month;
  const [sug, setSug] = useState<HsSuggestions | null>(null);
  useEffect(() => {
    let live = true;
    (demo ? Promise.resolve(demoHsSuggestions(demoCsData(), month)) : loadHsSuggestions(company, month))
      .then((s) => live && setSug(s))
      .catch(() => live && setSug(null));
    return () => {
      live = false;
    };
  }, [company, month, demo]);
  async function save(r: GridRow, fields: Partial<EntryHs>) {
    try {
      const h = await api.saveHs(company, r.client.id, month, fields);
      ctx.patch((d) => ({ ...d, hs: [...d.hs.filter((x) => x.cs_client_id !== r.client.id), h] }));
    } catch (e) {
      notify(errMsg(e));
      throw e;
    }
  }
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
  const w = data.rules.hs_weights;
  const scored = rows.filter((r) => r.hs);
  const avg = scored.length ? scored.reduce((s, r) => s + r.hs!.score, 0) / scored.length : 0;
  if (!rows.length) return <p className="cs-entry-empty">Nenhum cliente na carteira em {labelMesFull(month)} com esse filtro.</p>;
  return (
    <>
      <div className="cs-entry-grid-wrap">
        <table className="cs-entry-grid hs">
          <thead>
            <tr>
              <th className="sticky">Cliente</th>
              <th>Squad</th>
              {HS_CRITERIA.map((c) => <th key={c.key} className="c" title={`${c.label}: ${w[c.key]} pontos`}>{c.label}<small> {w[c.key]}</small></th>)}
              <th className="c">Nota</th>
              <th>Observações</th>
              <th className="c" title="A sugestão da MAVI para o mês"><Sparkles size={13} /> MAVI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const h = r.hs;
              const ed = canEdit(access, r.squad);
              const s = sug?.items.find((x) => x.cs_client_id === r.client.id && x.done_at && x.score !== null);
              const apply: Partial<Record<HsKey, boolean>> = {};
              if (s) for (const c of HS_CRITERIA) {
                const v = s.criteria[c.key]?.value;
                if (v !== null && v !== undefined && v !== (h?.[c.key] ?? false)) apply[c.key] = v;
              }
              const diffs = Object.keys(apply).length;
              return (
                <tr key={r.client.id}>
                  <th className="sticky" scope="row">
                    <span className="cs-entry-name">{r.client.name}</span>
                    <small>#{r.client.external_id}</small>
                  </th>
                  <td className="cs-cell">{ctx.squadName(r.squad)}</td>
                  {HS_CRITERIA.map((c) => (
                    <CheckCell key={c.key} value={!!h?.[c.key]} editable={ed} title={c.label}
                      onSave={(v) => quiet(save(r, { [c.key]: v }))} />
                  ))}
                  <td className="cs-cell c">
                    {h ? <span className={`cs-pill ${csPill(h.band)}`} title={h.manual_score && !HS_CRITERIA.some((c) => h[c.key]) ? "Nota digitada (sem critérios)" : h.band}>
                      {numberFormat(h.score, 0)}%</span> : <span className="cs-muted">—</span>}
                  </td>
                  <EditCell kind="text" value={h?.notes} editable={ed} month={month} onSave={(v) => quiet(save(r, { notes: v as string | null }))}
                    className="notes" title="Observações do Health Score" />
                  <td className="cs-cell c">
                    {s ? (
                      <span className="cs-entry-sug">
                        <span className={`cs-pill ${csPill(s.band)}`} title={HS_CRITERIA.map((c) => `${c.label}: ${s.criteria[c.key]?.value === true ? "sim" : s.criteria[c.key]?.value === false ? "não" : "?"} — ${s.criteria[c.key]?.why ?? ""}`).join("\n")}>
                          {numberFormat(s.score ?? 0, 0)}%
                        </span>
                        {ed && diffs > 0 && (
                          <button type="button" className="cs-entry-link" onClick={() => void quiet(save(r, apply))}
                            title="Marca os critérios como a MAVI sugeriu (os sem evidência ficam como estão)">
                            Aplicar ({diffs})
                          </button>
                        )}
                      </span>
                    ) : <span className="cs-muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th className="sticky" scope="row">{scored.length} com nota</th>
              <td colSpan={1 + HS_CRITERIA.length} />
              <td className="c">{scored.length ? `${numberFormat(avg, 0)}%` : ""}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="cs-muted cs-small cs-entry-help">
        A nota é a soma dos pesos dos critérios marcados (regras de {labelMesFull(month)}). Passe o mouse na sugestão da MAVI para ver o
        porquê; "Aplicar" marca o que ela sugeriu com evidência.
      </p>
    </>
  );
}

// ------------------------------------------------------------ clientes
function ClientsGrid({ ctx, squad, query }: { ctx: GridCtx; squad: string; query: string }) {
  const { api, company, data, access, notify } = ctx;
  const [remove, setRemove] = useState<EntryClient | null>(null);
  const ed = access.is_leader && access.source === "mavi";
  const q = query.trim().toLocaleLowerCase("pt-BR");
  const list = data.clients
    .filter((c) => (!squad || c.squad_id === squad) && (!q || c.name.toLocaleLowerCase("pt-BR").includes(q) || c.external_id.includes(q)))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
  const squads = data.squads.filter((s) => !s.archived).map((s) => s.id);
  const labels = Object.fromEntries(data.squads.map((s) => [s.id, s.name]));
  async function save(c: EntryClient, fields: Partial<CsDataClient>) {
    try {
      const k = await api.saveClient(company, c.id, fields);
      ctx.patch((d) => ({ ...d, clients: d.clients.map((x) => (x.id === c.id ? { ...x, ...k } : x)) }));
    } catch (e) {
      notify(errMsg(e));
      throw e;
    }
  }
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
  return (
    <>
      <div className="cs-entry-grid-wrap">
        <table className="cs-entry-grid clients">
          <thead>
            <tr>
              <th className="sticky">Cliente</th>
              <th>ID</th>
              <th>Squad</th>
              <th>Tipo</th>
              <th title="Meses de trial cumpridos ao graduar">Mês trial</th>
              <th>Origem</th>
              <th>Status</th>
              <th>Entrada</th>
              <th>Churn</th>
              <th>Motivo</th>
              <th>Reativação</th>
              <th>Vertical</th>
              <th>Cliente no MAVI</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {list.map((c) => {
              const set = (k: keyof CsDataClient) => (v: unknown) => quiet(save(c, { [k]: v }));
              return (
                <tr key={c.id} className={c.active ? "" : "empty"}>
                  <EditCell kind="text" value={c.name} editable={ed} month={data.month} onSave={set("name")} className="sticky name" title="Nome" />
                  <EditCell kind="int" value={c.external_id} editable={ed} month={data.month} onSave={(v) => set("external_id")(v === null ? null : String(v))} title="ID (código)" />
                  <SelectCell value={c.squad_id} options={squads.includes(c.squad_id) ? squads : [c.squad_id, ...squads]} labels={labels}
                    pill={false} editable={ed} onSave={set("squad_id")} title="Squad" />
                  <SelectCell value={c.kind} options={KIND} labels={KIND_LABEL} pill={false} editable={ed} onSave={set("kind")} title="Tipo" />
                  <EditCell kind="int" value={c.trial_month} editable={ed} month={data.month} onSave={set("trial_month")} title="Mês de trial" className="c" />
                  <SelectCell value={c.origin} options={ORIGIN} labels={ORIGIN_LABEL} pill={false} editable={ed} onSave={set("origin")} title="Origem" />
                  <SelectCell value={c.status} options={CLIENT_STATUS} labels={CLIENT_STATUS_LABEL} pill={false} editable={ed}
                    onSave={set("status")} title="Status" />
                  <EditCell kind="date" value={c.entry_date} editable={ed} month={data.month} onSave={set("entry_date")} title="Entrada" />
                  <EditCell kind="date" value={c.churn_date} editable={ed} month={data.month} onSave={set("churn_date")} title="Churn" />
                  <SelectCell value={c.churn_reason} options={REASONS} labels={REASON_LABEL} pill={false} allowEmpty editable={ed}
                    onSave={set("churn_reason")} title="Motivo do churn" />
                  <EditCell kind="date" value={c.reactivation_date} editable={ed} month={data.month} onSave={set("reactivation_date")} title="Reativação" />
                  <EditCell kind="text" value={c.vertical} editable={ed} month={data.month} onSave={set("vertical")} title="Vertical" />
                  <td className="cs-cell">{c.client_name ?? <span className="cs-muted">—</span>}</td>
                  <td className="cs-cell actions">
                    {ed && <button type="button" className="btn ghost icon small" aria-label="Excluir o cliente" title="Excluir o cliente"
                      onClick={() => setRemove(c)}><Trash2 size={14} /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="cs-muted cs-small cs-entry-help">
        {ed ? "Churn de novo de quem foi reativado: preencha a nova data de churn e o par antigo vai sozinho para os eventos. A ligação com o cliente do MAVI fica em Equipe e configurações › Customer Success."
          : "O cadastro dos clientes é feito por administradores e gestores."}
      </p>
      {remove && <ReasonDialog title={`Excluir ${remove.name}`} action="Excluir o cliente"
        text="O cliente sai do CS com todos os ciclos, Health Score e eventos. Para quem saiu da carteira, prefira a data de churn."
        onClose={() => setRemove(null)} onConfirm={async (reason) => {
          await api.deleteClient(company, remove.id, reason);
          ctx.patch((d) => ({ ...d, clients: d.clients.filter((x) => x.id !== remove.id) }));
          setRemove(null);
          notify("Cliente excluído.");
        }} />}
    </>
  );
}

function ClientDialog({ ctx, onClose }: { ctx: GridCtx; onClose: () => void }) {
  const { api, company, data, notify } = ctx;
  const squads = data.squads.filter((s) => !s.archived);
  const [f, setF] = useState({ external_id: "", name: "", squad_id: squads[0]?.id ?? "", kind: "TRIAL", origin: "comercial",
    entry_date: dateBr(ctx.access.today), vertical: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const up = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title="Novo cliente de CS" onClose={() => !busy && onClose()} busy={busy}>
      <form className="entity-form cs-entry-form" onSubmit={async (ev) => {
        ev.preventDefault();
        const entry = parseDate(f.entry_date, data.month);
        if (!entry) return setError("Data de entrada inválida (dd/mm/aaaa).");
        setBusy(true);
        try {
          const k = await api.saveClient(company, null, { ...f, entry_date: entry, vertical: f.vertical.trim() || null } as Partial<CsDataClient>);
          ctx.patch((d) => ({ ...d, clients: [...d.clients, { ...k, client_name: null, active: true }] }));
          notify(`${k.name} cadastrado. Ele entra na grade de ciclos a partir de agora.`);
          onClose();
        } catch (e) {
          setError(errMsg(e));
          setBusy(false);
        }
      }}>
        <label>ID (código do cliente)<Input value={f.external_id} onChange={(e) => up("external_id")(e.target.value)} inputMode="numeric" required /></label>
        <label>Nome<Input value={f.name} onChange={(e) => up("name")(e.target.value)} required maxLength={200} /></label>
        <label>Squad
          <select className="cs-entry-filter" value={f.squad_id} onChange={(e) => up("squad_id")(e.target.value)}>
            {squads.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Tipo
          <select className="cs-entry-filter" value={f.kind} onChange={(e) => up("kind")(e.target.value)}>
            {KIND.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label>Origem
          <select className="cs-entry-filter" value={f.origin} onChange={(e) => up("origin")(e.target.value)}>
            {ORIGIN.map((k) => <option key={k} value={k}>{ORIGIN_LABEL[k]}</option>)}
          </select>
        </label>
        <label>Entrada<Input value={f.entry_date} onChange={(e) => up("entry_date")(e.target.value)} placeholder="dd/mm/aaaa" required /></label>
        <label>Vertical<Input value={f.vertical} onChange={(e) => up("vertical")(e.target.value)} maxLength={120} /></label>
        <p className="cs-hint">O MAVI liga ao cliente do MAVI pelo código ou pelo nome, como na leitura da planilha.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button className="btn primary" type="submit" loading={busy}>Cadastrar</Button>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ metas
function GoalsGrid({ ctx }: { ctx: GridCtx }) {
  const { api, company, data, access, notify } = ctx;
  const ed = access.is_leader && access.source === "mavi";
  const goals = new Map(data.goals.map((g) => [g.squad_id, g]));
  type GoalFields = { revenue?: number | null; retention_pct?: number | null; ticket?: number | null };
  async function save(squad: string, g: EntryGoal | undefined, fields: GoalFields) {
    const next = { revenue: g?.revenue ?? null, retention_pct: g?.retention_pct ?? null, ticket: g?.ticket ?? null, ...fields };
    if (next.revenue === null && (next.retention_pct !== null || next.ticket !== null))
      return notify("Lance primeiro a meta de faturamento do squad.");
    try {
      const row = await api.saveGoal(company, squad, data.month, next.revenue, next.retention_pct, next.ticket);
      ctx.patch((d) => ({ ...d, goals: [...d.goals.filter((x) => x.squad_id !== squad), ...(row ? [row] : [])] }));
    } catch (e) {
      notify(errMsg(e));
    }
  }
  const squads = data.squads.filter((s) => !s.archived || goals.has(s.id));
  const total = data.goals.reduce((s, g) => s + g.revenue, 0);
  return (
    <>
      <div className="cs-entry-grid-wrap">
        <table className="cs-entry-grid goals">
          <thead>
            <tr>
              <th className="sticky">Squad</th>
              <th className="r">Meta de faturamento</th>
              <th className="r">Retenção</th>
              <th className="r">Ticket médio</th>
            </tr>
          </thead>
          <tbody>
            {squads.map((s) => {
              const g = goals.get(s.id);
              return (
                <tr key={s.id}>
                  <th className="sticky" scope="row"><span className="cs-entry-dot" style={{ background: s.color }} />{s.name}</th>
                  <EditCell kind="money" value={g?.revenue} editable={ed} month={data.month} className="r" title="Meta de faturamento"
                    onSave={(v) => save(s.id, g, { revenue: v as number | null })} />
                  <EditCell kind="pct" value={g?.retention_pct} editable={ed && !!g} month={data.month} className="r" title="Retenção (%)"
                    onSave={(v) => save(s.id, g, { retention_pct: v as number | null })} />
                  <EditCell kind="money" value={g?.ticket} editable={ed && !!g} month={data.month} className="r" title="Ticket médio"
                    onSave={(v) => save(s.id, g, { ticket: v as number | null })} />
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th className="sticky" scope="row">Total</th>
              <td className="r">{fmtMoney(total)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="cs-muted cs-small cs-entry-help">Apagar a meta de faturamento (célula vazia) tira a meta do squad no mês.</p>
    </>
  );
}

// ------------------------------------------------------------ histórico
function LogList({ ctx }: { ctx: GridCtx }) {
  const { api, company, squadName } = ctx;
  const [list, setList] = useState<CsEditLog[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api.log(company, null, 200).then(setList).catch((e) => setError(errMsg(e)));
  }, [api, company]);
  useEffect(() => {
    load();
    window.addEventListener("mavi:cs", load);
    return () => window.removeEventListener("mavi:cs", load);
  }, [load]);
  if (error) return <p className="cs-error">{error}</p>;
  if (!list) return <Loading compact />;
  if (!list.length) return <p className="cs-entry-empty"><History size={16} /> Nada lançado no MAVI ainda.</p>;
  return (
    <ul className="cs-entry-log">
      {list.map((l) => {
        const changes = l.entity === "source" ? [`${l.before === "mavi" ? "MAVI" : "planilha"} → ${l.after === "mavi" ? "MAVI" : "planilha"}`]
          : l.entity === "month" ? [`${(l.after as { created?: number })?.created ?? 0} ciclos criados`]
            : logChanges(l.before, l.after, (id) => squadName(id));
        return (
          <li key={l.id}>
            <div className="cs-entry-log-head">
              <b>{l.by_name ?? "Alguém"}</b> {ACTION_LABEL[l.action]} <span className="cs-pill">{ENTITY_LABEL[l.entity]}</span>
              {l.client_name && <> · {l.client_name}</>}
              {l.month && <> · {labelMesFull(l.month)}</>}
              {l.squad_id && l.entity === "goal" && <> · {squadName(l.squad_id)}</>}
              <time className="cs-muted">{new Date(l.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
            </div>
            {changes.length > 0 && <p className="cs-entry-log-changes">{changes.slice(0, 8).join(" · ")}{changes.length > 8 && ` · e mais ${changes.length - 8}`}</p>}
            {l.reason && <p className="cs-entry-log-reason">Motivo: {l.reason}</p>}
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------ abrir o mês
function OpenMonthDialog({ ctx, onClose, onDone }: { ctx: GridCtx; onClose: () => void; onDone: (n: number) => void }) {
  const { api, company, data, squadName } = ctx;
  const [preview, setPreview] = useState<OpenMonth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api.openMonth(company, data.month, false).then(setPreview).catch((e) => setError(errMsg(e)));
  }, [api, company, data.month]);
  const n = preview?.items.length ?? 0;
  return (
    <Modal title={`Abrir ${labelMesFull(data.month)}`} onClose={() => !busy && onClose()} busy={busy} wide>
      <div className="entity-form">
        <p className="cs-hint">
          Cria o ciclo de {labelMesFull(data.month)} de cada cliente na carteira que ainda não tem, com o squad, o melhor, o provável, a
          probabilidade, a mensalidade e as datas do mês anterior (um mês depois). Status e pagamento começam pendentes. Quem já tem
          ciclo no mês não muda.
        </p>
        {!preview && !error && <Loading compact />}
        {preview && !n && <p>Todos os clientes da carteira já têm ciclo em {labelMesFull(data.month)}.</p>}
        {n > 0 && (
          <div className="cs-entry-grid-wrap short">
            <table className="cs-entry-grid">
              <thead>
                <tr><th>Cliente</th><th>Squad</th><th className="r">Provável</th><th>Cobrança</th><th>Fim</th><th /></tr>
              </thead>
              <tbody>
                {preview!.items.map((it) => (
                  <tr key={it.cs_client_id}>
                    <td className="cs-cell">{it.name} <small className="cs-muted">#{it.external_id}</small></td>
                    <td className="cs-cell">{squadName(it.squad_id)}</td>
                    <td className="cs-cell r">{fmtMoney(it.probable)}</td>
                    <td className="cs-cell">{dateShort(it.billing_date) || "—"}</td>
                    <td className="cs-cell">{dateShort(it.end_date) || "—"}</td>
                    <td className="cs-cell">{it.from_previous ? "" : <span className="cs-pill warn">sem ciclo no mês anterior</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button className="btn primary" loading={busy} disabled={!n} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.openMonth(company, data.month, true);
            onDone(r.created);
          } catch (e) {
            setError(errMsg(e));
            setBusy(false);
          }
        }}>
          {n ? `Criar ${n} ${n === 1 ? "ciclo" : "ciclos"}` : "Nada a criar"}
        </Button>
      </div>
    </Modal>
  );
}

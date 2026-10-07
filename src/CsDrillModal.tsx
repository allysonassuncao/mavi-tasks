import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Modal } from "./components";
import { Input, Select, SelectOption } from "./ui";
import { fmtDateBr, fmtMoney, labelMes, numberFormat, type CsEngine } from "./cs-engine";
import { drilldownRun, type DdCol, type DdParams, type DdResult, type DdRow, type DdStat } from "./cs-drilldowns";

/**
 * A janela de detalhe de um número do painel de CS (o "ver"/"explorar" do
 * dash antigo, assets/js/drilldown.js): números de resumo (os clicáveis
 * filtram a lista), resumo por mês, quebras, busca, filtros, tabela
 * ordenável e, no detalhe da meta, a calculadora de fechamento.
 */

export type CsDrill = { metrica: string; params: DdParams; title?: string };

const TIPO: Record<string, string> = { TRIAL: "Trial", BASE: "Base", BASE_RA: "Base RA", ACL: "ACL" };
const TRIAL_STATUS: Record<string, string> = { TRIAL: "🟡 Em trial", GRADUOU: "🟢 Graduou (Base)", CHURN: "🔴 Churn" };
const TRIAL_FASE: Record<string, string> = {
  M1: "M1 — onboarding", M2: "M2 — performance", M3: "M3 — retenção", M4plus: "⚠️ M4+ (estendido)",
  PosTrial: "Pós-trial (Base)", GRADUADO: "→ Base (graduado)",
};
const HS_FAIXA: Record<string, string> = { SATISFEITO: "🟢 Satisfeito", ALERTA: "🟡 Alerta", CRITICO: "🔴 Crítico" };
const ADIMP: Record<string, string> = { ADIMPLENTE: "🟢 Adimplente", INADIMPLENTE: "🟡 Inadimplente", PERDA: "🔴 Perda" };
const empty = (v: unknown) => v === null || v === undefined || v === "";
const num = (v: unknown) => Number(v);

export function ddFormat(e: CsEngine, type: string, v: unknown): string {
  if (type === "money") return empty(v) || !Number.isFinite(num(v)) ? "—" : fmtMoney(num(v));
  if (type === "pct") return empty(v) || !Number.isFinite(num(v)) ? "—" : `${numberFormat(num(v), 1)}%`;
  if (type === "date") return empty(v) || v === "0000-00-00" ? "—" : fmtDateBr(String(v));
  if (type === "mes") return empty(v) ? "—" : labelMes(String(v));
  if (type === "squad") return empty(v) ? "—" : e.squadName(String(v));
  if (type === "tipo") return TIPO[String(v)] ?? (empty(v) ? "—" : String(v));
  if (type === "m1") return v === true || num(v) === 1 ? "M1" : "";
  if (type === "check") return v === true || num(v) === 1 ? "✓" : "✗";
  if (type === "trial_status") return TRIAL_STATUS[String(v)] ?? (empty(v) ? "—" : String(v));
  if (type === "trial_fase") return TRIAL_FASE[String(v)] ?? (empty(v) ? "—" : String(v));
  if (type === "hs_faixa") return HS_FAIXA[String(v)] ?? (empty(v) ? "—" : String(v));
  if (type === "adimp") return ADIMP[String(v)] ?? (empty(v) ? "—" : String(v));
  return empty(v) ? "—" : String(v);
}

const NUMERIC = new Set(["money", "int", "pct"]);
/** A calculadora: um ciclo marcado e o valor escolhido. */
type Sim = { on: boolean; mode: "provavel" | "melhor" | "outro" | "incremento"; custom: number; prov: number; melhor: number };
const simKey = (r: DdRow) => `${r.mes ?? ""}|${r.id_externo ?? ""}|${r.nome ?? ""}`;
function parseMoney(s: string) {
  let t = s.trim().replace(/[R$\s]/g, "");
  if (!t) return 0;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(t);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}
const simValue = (s: Sim) =>
  !s.on ? 0 : s.mode === "incremento" || s.mode === "outro" ? s.custom : s.mode === "melhor" ? s.melhor : s.prov;

export function CsDrillModal({ engine, drill, onClose }: { engine: CsEngine; drill: CsDrill; onClose: () => void }) {
  const result = useMemo<DdResult | Error>(() => {
    try {
      return drilldownRun(engine, drill.metrica, drill.params);
    } catch (err) {
      return err as Error;
    }
  }, [engine, drill]);
  const [search, setSearch] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [sim, setSim] = useState<Record<string, Sim>>({});

  if (result instanceof Error)
    return (
      <Modal title={drill.title ?? "Detalhe"} onClose={onClose}>
        <p className="form-error" role="alert">{result.message}</p>
      </Modal>
    );
  const r = result;
  const fmt = (type: string, v: unknown) => ddFormat(engine, type, v);

  let rows = r.rows;
  for (const [k, v] of Object.entries(values)) {
    if (!v || v === "all") continue;
    // Categoria ACL também pega os ciclos com parcela ACL.
    rows = k === "categoria" && v === "ACL"
      ? rows.filter((x) => String(x.categoria) === "ACL" || num(x.valor_acl_efetivo) > 0)
      : rows.filter((x) => String(x[k]) === v);
  }
  const q = search.trim().toLowerCase();
  if (q) rows = rows.filter((x) => Object.values(x).some((v) => !empty(v) && String(v).toLowerCase().includes(q)));
  if (sort) {
    const c = r.columns.find((x) => x.key === sort.key);
    rows = [...rows].sort((a, b) =>
      c && NUMERIC.has(c.type)
        ? ((num(a[sort.key]) || 0) - (num(b[sort.key]) || 0)) * sort.dir
        : String(a[sort.key] ?? "").localeCompare(String(b[sort.key] ?? ""), "pt-BR") * sort.dir);
  }

  const toggleStat = (s: DdStat) => {
    if (!s.filter) return;
    const v = String(s.filter.value);
    setValues((cur) => ({ ...cur, [s.filter!.key]: cur[s.filter!.key] === v ? "all" : v }));
  };
  const setSel = (row: DdRow, patch: Partial<Sim>) => {
    const key = simKey(row);
    setSim((cur) => {
      const prev = cur[key] ?? { on: false, mode: num(row.valor_pago) > 0 ? "incremento" : "provavel", custom: 0,
        prov: num(row.provavel) || 0, melhor: num(row.melhor) || 0 };
      return { ...cur, [key]: { ...prev, ...patch } };
    });
  };

  return (
    <Modal title={r.title || drill.title || drill.metrica} onClose={onClose} wide className="cs-dd">
      <div className="cs-dd-body">
      {r.stats.length > 0 && (
        <div className="cs-dd-stats">
          {r.stats.map((s, i) => {
            const active = !!s.filter && values[s.filter.key] === String(s.filter.value);
            const body = (
              <>
                <span className="cs-dd-stat-label">
                  {s.label}
                  {active && <X size={12} aria-hidden="true" />}
                </span>
                <strong>{fmt(s.type, s.value)}</strong>
                {s.hint && <small title={s.hint}>{s.hint}</small>}
              </>
            );
            return s.filter ? (
              <button key={i} type="button" className={`cs-dd-stat clickable ${s.highlight ? "hl" : ""} ${active ? "active" : ""}`}
                aria-pressed={active} onClick={() => toggleStat(s)}>
                {body}
              </button>
            ) : (
              <div key={i} className={`cs-dd-stat ${s.highlight ? "hl" : ""}`}>{body}</div>
            );
          })}
        </div>
      )}
      <MonthlySummary r={r} />
      {r.breakdown.length > 0 && (
        <div className="cs-dd-breakdowns">
          {r.breakdown.map((b, i) => (
            <div key={i} className={`cs-dd-bk ${b.columns.length > 3 ? "wide" : ""}`}>
              <span className="cs-dd-bk-title">{b.title}</span>
              <div className="cs-dd-bk-scroll">
              <table>
                <thead>
                  <tr>{b.columns.map((c) => <th key={c.key} className={`al-${c.align}`}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((row, j) => (
                    <tr key={j}>{b.columns.map((c) => <td key={c.key} className={`al-${c.align}`}>{fmt(c.type, row[c.key])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="cs-dd-toolbar">
        <label className="cs-dd-search">
          <Input type="search" placeholder="Filtrar por nome, ID…" value={search} aria-label="Filtrar a lista"
            onChange={(ev) => setSearch(ev.target.value)} />
        </label>
        {r.filters.map((f) => (
          <label key={f.key} className="cs-dd-filter">
            <span>{f.label}</span>
            <Select value={values[f.key] ?? "all"} onValueChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))}
              aria-label={f.label}>
              {f.options.map((o) => <SelectOption key={o.value} value={String(o.value)}>{o.label}</SelectOption>)}
            </Select>
          </label>
        ))}
        <span className="cs-dd-count">
          {rows.length === r.rows.length ? `${rows.length} ${rows.length === 1 ? "registro" : "registros"}`
            : `${rows.length} de ${r.rows.length} registros`}
        </span>
      </div>
      <div className="cs-dd-table">
        <table>
          <thead>
            <tr>
              {r.simulador && <th className="cs-sim-th" title="Calculadora de fechamento: marque os clientes e escolha o valor">Simular</th>}
              {r.columns.map((c) => (
                <th key={c.key} className={`al-${c.align}`} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                  <button type="button" onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}>
                    {c.label}
                    {sort?.key === c.key && (sort.dir === 1 ? " ▲" : " ▼")}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {r.simulador && <SimCell row={row} sel={sim[simKey(row)]} onChange={(p) => setSel(row, p)} />}
                {r.columns.map((c: DdCol) => (
                  <td key={c.key} className={`al-${c.align} ${c.type === "check" ? (row[c.key] === true || num(row[c.key]) === 1 ? "ok" : "fail") : ""}`}>
                    {fmt(c.type, row[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="cs-muted cs-dd-empty">Sem registros.</p>}
      </div>
      {r.simulador && (
        <SimBar meta={r.simulador.meta} realizado={r.simulador.realizado} sim={sim}
          onAll={() => {
            for (const row of r.rows)
              if (!(num(row.valor_pago) > 0) && row.status_pagamento === "PENDENTE") setSel(row, { on: true });
          }}
          onClear={() => setSim({})} />
      )}
      </div>
    </Modal>
  );
}

function MonthlySummary({ r }: { r: DdResult }) {
  const s = r.monthly_summary;
  if (s.length < 2) return null;
  const money = !!r.summary_field;
  const hasMeta = s.some((x) => (x.meta ?? 0) > 0);
  const total = s.reduce((t, x) => t + (money ? x.total : x.count), 0);
  const metaSum = s.reduce((t, x) => t + (x.meta ?? 0), 0);
  const tone = (att: number) => (att >= 100 ? "good" : att >= 80 ? "warn" : "bad");
  return (
    <div className="cs-dd-monthly">
      <div className="cs-dd-monthly-head">
        Resumo por mês
        <span>
          Total: {money ? fmtMoney(total) : `${total} registro${total === 1 ? "" : "s"}`}
          {hasMeta && metaSum > 0 && ` · Meta: ${fmtMoney(metaSum)} · ${((total / metaSum) * 100).toFixed(1).replace(".", ",")}%`}
        </span>
      </div>
      <div className="cs-dd-monthly-grid">
        {s.map((x) => {
          const v = money ? x.total : x.count;
          const att = hasMeta && (x.meta ?? 0) > 0 ? x.atingimento ?? (x.total / x.meta!) * 100 : null;
          const bar = att !== null ? Math.min(att, 100) : total > 0 ? (v / total) * 100 : 0;
          const d = x.delta_pct;
          return (
            <div key={x.mes} className="cs-dd-month">
              <span className="cs-dd-month-label">
                {x.label}
                {d !== null && d !== undefined && (
                  <i className={d > 0.5 ? "up" : d < -0.5 ? "down" : "flat"}>
                    {d > 0.5 ? "▲" : d < -0.5 ? "▼" : "→"} {Math.abs(d).toFixed(0)}%
                  </i>
                )}
              </span>
              <strong>{money ? fmtMoney(x.total) : `${x.count} ${x.count === 1 ? "cliente" : "clientes"}`}</strong>
              {att !== null && (
                <small>Meta {fmtMoney(x.meta!)} · <b className={tone(att)}>{att.toFixed(0)}%</b></small>
              )}
              <span className={`cs-dd-month-bar ${att !== null ? tone(att) : ""}`}><i style={{ width: `${bar.toFixed(1)}%` }} /></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SimCell({ row, sel, onChange }: { row: DdRow; sel?: Sim; onChange: (p: Partial<Sim>) => void }) {
  const pago = num(row.valor_pago) > 0;
  const [text, setText] = useState(sel?.custom ? String(sel.custom).replace(".", ",") : "");
  return (
    <td className="cs-sim-cell">
      <input type="checkbox" checked={!!sel?.on} aria-label={`Simular ${String(row.nome ?? "")}`}
        onChange={(ev) => onChange({ on: ev.target.checked })} />
      {pago ? (
        <input className="cs-sim-input" placeholder="+ incremento" value={text} aria-label="Incremento em cima do pago"
          onChange={(ev) => {
            setText(ev.target.value);
            const v = parseMoney(ev.target.value);
            onChange({ mode: "incremento", custom: v, ...(v > 0 && !sel?.on ? { on: true } : {}) });
          }} />
      ) : (
        <>
          <select className="cs-sim-input" value={sel?.mode ?? "provavel"} aria-label="Valor da simulação"
            onChange={(ev) => onChange({ mode: ev.target.value as Sim["mode"], on: true })}>
            <option value="provavel">Provável</option>
            <option value="melhor">Melhor</option>
            <option value="outro">Outro…</option>
          </select>
          {sel?.mode === "outro" && (
            <input className="cs-sim-input" placeholder="R$" value={text} aria-label="Valor combinado"
              onChange={(ev) => {
                setText(ev.target.value);
                onChange({ custom: parseMoney(ev.target.value), on: true });
              }} />
          )}
        </>
      )}
    </td>
  );
}

function SimBar({ meta, realizado, sim, onAll, onClear }: {
  meta: number; realizado: number; sim: Record<string, Sim>; onAll: () => void; onClear: () => void;
}) {
  const on = Object.values(sim).filter((s) => s.on);
  const soma = on.reduce((t, s) => t + simValue(s), 0);
  const proj = realizado + soma;
  const pct = meta > 0 ? (proj / meta) * 100 : null;
  const falta = meta - proj;
  const tone = pct === null ? "" : pct >= 100 ? "good" : pct >= 80 ? "warn" : "bad";
  return (
    <div className="cs-sim-bar">
      <strong>🧮 Calculadora</strong>
      <span>
        Realizado <b>{fmtMoney(realizado)}</b> + <b className="accent">{fmtMoney(soma)}</b> ({on.length} selec.) = Projeção{" "}
        <b className={tone}>{fmtMoney(proj)}</b>
        {meta > 0 && pct !== null && (
          <>
            {" "}· {pct.toFixed(1).replace(".", ",")}% da meta {fmtMoney(meta)} ·{" "}
            {falta > 0 ? <>faltam <b className="bad">{fmtMoney(falta)}</b></> : <b className="good">meta batida +{fmtMoney(-falta)}</b>}
          </>
        )}
      </span>
      <span className="cs-sim-actions">
        <button type="button" className="btn secondary small" onClick={onAll}>Marcar pendentes</button>
        <button type="button" className="btn secondary small" onClick={onClear}>Limpar</button>
      </span>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { History, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { addMonths, labelMesFull, numberFormat, type CsRules } from "./cs-engine";
import { monthName, rulesAt, when, type CsBackend, type CsRulesAdmin } from "./cs";

/**
 * Equipe e configurações › Customer Success › Regras (migração
 * 20270523090000): comissão M1, pesos e faixas do Health Score, Ranking e
 * Recebimento, com vigência. Valem do mês escolhido em diante (do atual para
 * a frente: os meses fechados nunca mudam), sempre com motivo, e cada
 * mudança fica no histórico. Só administradores mudam; gestores consultam.
 */

type Field = { path: string; label: string; unit: "money" | "pct" | "day" | "days" | "months" | "points" | "cap" };
type Section = { title: string; hint?: string; fields: Field[] };
const SECTIONS: Section[] = [
  {
    title: "Faturamento",
    fields: [{ path: "m1_commission", label: "Comissão do 1º mês de trial (regra M1), em R$", unit: "money" }],
  },
  {
    title: "Pesos do Health Score",
    hint: "Somam 100. A nota de cada cliente é a soma dos critérios marcados.",
    fields: [
      { path: "hs_weights.goal", label: "Meta batida", unit: "points" },
      { path: "hs_weights.perception", label: "Percepção de valor", unit: "points" },
      { path: "hs_weights.payment", label: "Pagamento em dia", unit: "points" },
      { path: "hs_weights.meeting", label: "Reunião de alinhamento", unit: "points" },
      { path: "hs_weights.creatives", label: "Aprovação de criativos", unit: "points" },
    ],
  },
  {
    title: "Faixas do Health Score",
    fields: [
      { path: "hs_bands.satisfied", label: "Satisfeito a partir de", unit: "pct" },
      { path: "hs_bands.alert", label: "Alerta a partir de (abaixo é Crítico)", unit: "pct" },
    ],
  },
  {
    title: "Ranking dos squads",
    hint: "Quem lidera o critério leva o peso cheio; os demais, proporcional.",
    fields: [
      { path: "ranking_weights.goal", label: "Atingimento da meta", unit: "points" },
      { path: "ranking_weights.hs", label: "HS médio", unit: "points" },
      { path: "ranking_weights.adimplencia", label: "Adimplência", unit: "points" },
      { path: "ranking_weights.retention", label: "Retenção", unit: "points" },
      { path: "ranking_weights.graduation", label: "Taxa de graduação", unit: "points" },
      { path: "ranking_weights.realization", label: "Provável realizado", unit: "points" },
      { path: "ranking_realization_cap", label: "Teto do provável realizado", unit: "cap" },
    ],
  },
  {
    title: "Recebimento",
    fields: [
      { path: "receiving.yellow_day", label: "Zona amarela a partir do dia", unit: "day" },
      { path: "receiving.red_day", label: "Zona vermelha a partir do dia", unit: "day" },
      { path: "receiving.floor_day", label: "Antecipar cobranças até o dia (piso)", unit: "day" },
      { path: "receiving.max_shift_days", label: "Antecipar no máximo", unit: "days" },
      { path: "receiving.red_share_medium", label: "Aviso médio: zona vermelha com", unit: "pct" },
      { path: "receiving.red_share_high", label: "Aviso alto: zona vermelha com", unit: "pct" },
      { path: "receiving.history_months", label: "Histórico de pagamento de cada cliente", unit: "months" },
    ],
  },
];
const FIELDS = SECTIONS.flatMap((s) => s.fields);

const get = (r: CsRules, path: string): number => {
  const [a, b] = path.split(".");
  const v = (r as unknown as Record<string, unknown>)[a];
  return Number(b ? (v as Record<string, unknown>)?.[b] : v);
};
function set(r: CsRules, path: string, value: number): CsRules {
  const [a, b] = path.split(".");
  const next = structuredClone(r) as unknown as Record<string, unknown>;
  if (b) next[a] = { ...(next[a] as object), [b]: value };
  else next[a] = value;
  return next as unknown as CsRules;
}
function show(f: Field, v: number) {
  switch (f.unit) {
    case "money": return `R$ ${numberFormat(v, 2)}`;
    case "pct": return `${numberFormat(v, 0)}%`;
    case "cap": return `${numberFormat(v * 100, 0)}%`;
    case "day": return `dia ${v}`;
    case "days": return `${v} ${v === 1 ? "dia" : "dias"}`;
    case "months": return `${v} ${v === 1 ? "mês" : "meses"}`;
    default: return `${numberFormat(v, 0)} pts`;
  }
}
/** O que mudou entre duas versões, em palavras. */
function changes(before: CsRules | null, after: CsRules | null) {
  if (!before || !after) return [];
  return FIELDS.filter((f) => get(before, f.path) !== get(after, f.path))
    .map((f) => `${f.label}: ${show(f, get(before, f.path))} → ${show(f, get(after, f.path))}`);
}

export function CsRulesCard({ api, company, notify }: { api: CsBackend; company: string; notify: (m: string) => void }) {
  const [info, setInfo] = useState<CsRulesAdmin | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const load = useCallback(() => {
    api.rules(company).then((r) => { setInfo(r); setError(""); }).catch((e) => setError((e as Error).message));
  }, [api, company]);
  useEffect(() => {
    load();
    window.addEventListener("mavi:cs", load);
    return () => window.removeEventListener("mavi:cs", load);
  }, [load]);

  const cur = info?.current_month ?? "";
  const changedNow = useMemo(
    () => (info ? FIELDS.filter((f) => get(info.current, f.path) !== get(info.defaults, f.path)).map((f) => f.path) : []),
    [info],
  );
  if (error && !info) return <section className="panel cs-rules"><p className="cs-error">{error}</p></section>;
  if (!info) return <Loading compact />;
  const future = info.versions.filter((v) => v.valid_from > cur);
  const inForce = info.versions.filter((v) => v.valid_from <= cur).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  return (
    <section className="panel cs-rules">
      <div className="panel-heading">
        <div>
          <h2>Regras do painel de CS</h2>
          <p>
            Comissão M1, Health Score, Ranking e Recebimento. Uma mudança vale do mês escolhido em diante: os meses que já
            fecharam continuam como foram apresentados. {info.can_edit ? "Toda mudança pede o motivo e fica no histórico."
              : "Só administradores mudam as regras."}
          </p>
        </div>
        {info.can_edit && (
          <Button className="btn secondary" onClick={() => setEditing("new")}>
            <Plus size={16} /> Mudar as regras
          </Button>
        )}
      </div>
      <div className="cs-rules-body">
        <h3 className="cs-rules-title">Em vigor em {labelMesFull(cur)}</h3>
        <div className="cs-rules-grid">
          {SECTIONS.map((s) => (
            <div key={s.title} className="cs-rules-section">
              <strong>{s.title}</strong>
              <dl>
                {s.fields.map((f) => (
                  <div key={f.path} className={changedNow.includes(f.path) ? "changed" : ""}
                    title={changedNow.includes(f.path) ? `Padrão: ${show(f, get(info.defaults, f.path))}` : undefined}>
                    <dt>{f.label}</dt>
                    <dd>{show(f, get(info.current, f.path))}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        {changedNow.length > 0 && <p className="cs-hint">Em destaque, o que está diferente do padrão do dash antigo.</p>}

        <h3 className="cs-rules-title">Versões</h3>
        {info.versions.length ? (
          <ul className="cs-rules-versions">
            {info.versions.map((v) => {
              const prev = rulesAt(info.versions.filter((x) => x.valid_from < v.valid_from), v.valid_from);
              const open = v.valid_from >= cur;
              return (
                <li key={v.valid_from}>
                  <div>
                    <b>A partir de {labelMesFull(v.valid_from)}</b>
                    {v.valid_from > cur && <span className="cs-chip">programada</span>}
                    {v === inForce && <span className="cs-chip">em vigor</span>}
                    <small>
                      {v.set_by_name ?? "—"} em {when(v.set_at)} · {v.reason}
                    </small>
                    <ul className="cs-rules-diff">
                      {changes(prev, v.rules).map((c) => <li key={c}>{c}</li>)}
                      {!changes(prev, v.rules).length && <li>Sem diferença das regras anteriores.</li>}
                    </ul>
                  </div>
                  {info.can_edit && open && (
                    <span className="cs-rules-actions">
                      <Button className="icon-btn" aria-label={`Editar as regras de ${monthName(v.valid_from)}`} title="Editar"
                        onClick={() => setEditing(v.valid_from)}>
                        <Pencil size={15} />
                      </Button>
                      <Button className="icon-btn danger" aria-label={`Remover as regras de ${monthName(v.valid_from)}`} title="Remover"
                        onClick={() => setRemoving(v.valid_from)}>
                        <Trash2 size={15} />
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="cs-hint">Nenhuma mudança ainda: valem os padrões do dash antigo.</p>
        )}
        {future.length > 0 && (
          <p className="cs-hint">Regras programadas passam a valer sozinhas no mês delas.</p>
        )}

        {info.log.length > 0 && (
          <>
            <button type="button" className="cs-rules-logtoggle" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
              <History size={14} /> Histórico de mudanças ({info.log.length})
            </button>
            {showLog && (
              <ul className="cs-rules-log">
                {info.log.map((l, i) => (
                  <li key={i}>
                    <small>{when(l.at)} · {l.by_name ?? "—"}</small>
                    <span>
                      {l.action === "delete" ? "Removeu" : "Gravou"} as regras a partir de {labelMesFull(l.valid_from)} — {l.reason}
                    </span>
                    <ul className="cs-rules-diff">
                      {changes(l.before, l.after).map((c) => <li key={c}>{c}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {editing && (
        <RulesDialog
          info={info}
          month={editing === "new" ? cur : editing}
          fixedMonth={editing !== "new"}
          onClose={() => setEditing(null)}
          onSave={async (month, rules, reason) => {
            const next = await api.setRules(company, month, rules, reason);
            setInfo(next);
            setEditing(null);
            notify(`Regras gravadas a partir de ${labelMesFull(month)}.`);
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          month={removing}
          onClose={() => setRemoving(null)}
          onRemove={async (reason) => {
            const next = await api.deleteRules(company, removing, reason);
            setInfo(next);
            setRemoving(null);
            notify(`Regras de ${labelMesFull(removing)} removidas.`);
          }}
        />
      )}
    </section>
  );
}

function RulesDialog({ info, month, fixedMonth, onClose, onSave }: {
  info: CsRulesAdmin; month: string; fixedMonth: boolean; onClose: () => void;
  onSave: (month: string, rules: CsRules, reason: string) => Promise<void>;
}) {
  const cur = info.current_month;
  const months = Array.from({ length: 13 }, (_, i) => addMonths(cur, i));
  const [valid, setValid] = useState(month);
  const base = useMemo(() => rulesAt(info.versions, valid), [info.versions, valid]);
  const [rules, setRules] = useState<CsRules>(base);
  const [touched, setTouched] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Ao trocar o mês, o formulário parte das regras que valem nele.
  useEffect(() => {
    if (!touched) setRules(base);
  }, [base, touched]);
  const hsSum = ["goal", "perception", "payment", "meeting", "creatives"].reduce((s, k) => s + get(rules, `hs_weights.${k}`), 0);
  const diff = changes(base, rules);
  return (
    <Modal title="Mudar as regras do painel de CS" onClose={() => !busy && onClose()} busy={busy} className="cs-rules-dialog">
      <form className="entity-form" onSubmit={async (ev) => {
        ev.preventDefault();
        setError("");
        if (!diff.length && !info.versions.some((v) => v.valid_from === valid))
          return setError("Nada mudou em relação às regras que já valem nesse mês.");
        if (hsSum !== 100) return setError(`Os pesos do Health Score somam ${hsSum}; precisam somar 100.`);
        if (reason.trim().length < 3) return setError("Diga o motivo da mudança.");
        setBusy(true);
        try {
          await onSave(valid, rules, reason.trim());
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}>
        <label>
          Vale a partir de
          <Select value={valid} onValueChange={setValid} disabled={fixedMonth} aria-label="Vale a partir de">
            {months.map((m) => <SelectOption key={m} value={m}>{labelMesFull(m)}{m === cur ? " (mês atual)" : ""}</SelectOption>)}
          </Select>
          <small className="cs-hint">Os meses antes deste continuam com as regras de antes.</small>
        </label>
        {SECTIONS.map((s) => (
          <fieldset key={s.title} className="cs-rules-fieldset">
            <legend>{s.title}</legend>
            {s.hint && <small className="cs-hint">{s.hint}{s.title === "Pesos do Health Score" && ` Hoje: ${hsSum}.`}</small>}
            <div className="cs-rules-inputs">
              {s.fields.map((f) => {
                const v = get(rules, f.path);
                const shown = f.unit === "cap" ? Math.round(v * 100) : v;
                return (
                  <label key={f.path} className={get(base, f.path) !== v ? "changed" : ""}>
                    {f.label}
                    <span className="cs-rules-input">
                      <Input type="number" inputMode="decimal" value={Number.isFinite(shown) ? String(shown) : ""}
                        step={f.unit === "money" ? 100 : 1} min={0}
                        onChange={(ev) => {
                          const n = Number(ev.target.value.replace(",", "."));
                          setTouched(true);
                          setRules((r) => set(r, f.path, f.unit === "cap" ? n / 100 : n));
                        }} />
                      {f.unit === "pct" || f.unit === "cap" ? <i>%</i> : f.unit === "points" ? <i>pts</i>
                        : f.unit === "days" ? <i>dias</i> : f.unit === "months" ? <i>meses</i> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        {diff.length > 0 && (
          <div className="cs-rules-preview" role="status">
            <strong>O que muda a partir de {labelMesFull(valid)}</strong>
            <ul className="cs-rules-diff">{diff.map((c) => <li key={c}>{c}</li>)}</ul>
            {FIELDS.some((f) => f.path.startsWith("hs_") && get(base, f.path) !== get(rules, f.path)) && (
              <small className="cs-hint">As notas de Health Score desses meses são recalculadas.</small>
            )}
          </div>
        )}
        <label>
          Motivo
          <Textarea value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} rows={2} required
            placeholder="Ex.: comissão comercial do trial mudou no novo contrato" />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button className="btn primary" type="submit" loading={busy}>Gravar as regras</Button>
      </form>
    </Modal>
  );
}

function RemoveDialog({ month, onClose, onRemove }: { month: string; onClose: () => void; onRemove: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`Remover as regras de ${labelMesFull(month)}`} onClose={() => !busy && onClose()} busy={busy}>
      <form className="entity-form" onSubmit={async (ev) => {
        ev.preventDefault();
        if (reason.trim().length < 3) return setError("Diga o motivo.");
        setBusy(true);
        try {
          await onRemove(reason.trim());
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}>
        <p className="cs-hint">Os meses a partir de {labelMesFull(month)} voltam às regras da versão anterior. Fica registrado no histórico.</p>
        <label>
          Motivo
          <Textarea value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} rows={2} required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button className="btn primary danger" type="submit" loading={busy}>Remover</Button>
      </form>
    </Modal>
  );
}

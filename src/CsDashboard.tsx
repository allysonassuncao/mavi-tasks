import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Modal } from "./components";
import { Button, Loading, Select, SelectOption } from "./ui";
import {
  CHURN_REASONS,
  CsEngine,
  ORIGIN_LABEL,
  addMonths,
  fmtDateBr,
  fmtMoney,
  labelMes,
  labelMesFull,
  monthStart,
  monthsBetween,
  numberFormat,
  type CsDim,
} from "./cs-engine";
import {
  demoHsSuggestions,
  loadCsData,
  loadHsSuggestions,
  requestHsSuggestions,
  type HsSuggestions,
  resolvePeriod,
  shiftPeriod,
  type CsLoaded,
  type CsPeriodSetting,
  type CsSource,
  type CsWindow,
} from "./cs-dashboard";
import { CsContext, csPill, useCs, type CsCtx } from "./CsCommon";
import { CsDrillModal, type CsDrill } from "./CsDrillModal";
import { HsProfileSection } from "./CsHsSuggestions";
import { CsPanelBlocks } from "./CsPanelBlocks";
import { CsReceivingView } from "./CsReceivingView";
import { CsRankingView } from "./CsRankingView";
import "./cs-dashboard.css";

/**
 * O painel "CS Make" dentro de Dashboards (migração 20270522090000): a mesma
 * tela do dash de CS antigo (cs-make-dashboard/dash/home.php, recebimento.php
 * e ranking.php), com os números do motor src/cs-engine.ts.
 */

type View = "painel" | "recebimento" | "ranking";

export function CsDashboard({
  source,
  onSync,
  head,
  hsCompany,
}: {
  source: CsSource;
  /** A empresa, para as sugestões de Health Score da MAVI (no app; "demo" na demonstração). */
  hsCompany?: string;
  /** "Sincronizar agora" (administradores e gestores no app). */
  onSync?: () => Promise<void>;
  /** O título e as ações do dashboard, à esquerda do cabeçalho do painel. */
  head?: ReactNode;
}) {
  const [data, setData] = useState<CsLoaded | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const sourceKey = JSON.stringify(source);
  useEffect(() => {
    let current = true;
    loadCsData(source)
      .then((d) => {
        if (!current) return;
        setData(d);
        setError("");
      })
      .catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, tick]);
  // Realtime: uma leitura da planilha ou uma importação muda os dados.
  useEffect(() => {
    if (source.kind === "link") return;
    const onChange = () => setTick((v) => v + 1);
    window.addEventListener("mavi:cs", onChange);
    return () => window.removeEventListener("mavi:cs", onChange);
  }, [source.kind]);

  if (error && !data)
    return (
      <div className="panel cs-dash-message">
        <h3>Painel indisponível</h3>
        <p>{error}</p>
      </div>
    );
  if (!data) return <Loading variant="chart" />;
  return (
    <CsDashboardScreen key={data.today} data={data} onReload={() => setTick((v) => v + 1)} onSync={onSync} head={head}
      hsCompany={hsCompany} tick={tick} />
  );
}

function CsDashboardScreen({ data, onReload, onSync, head, hsCompany, tick }: {
  data: CsLoaded; onReload: () => void; onSync?: () => Promise<void>; head?: ReactNode; hsCompany?: string; tick: number;
}) {
  const e = useMemo(() => new CsEngine(data), [data]);
  const today = data.today;
  const [view, setView] = useState<View>("painel");
  const [period, setPeriod] = useState<CsPeriodSetting>({ tipo: "mes", mes: monthStart(today) });
  const [squad, setSquad] = useState<string | null>(null);
  const [dim, setDim] = useState<CsDim>("tudo");
  const [semana, setSemana] = useState<string | null>(null);
  const [drill, setDrill] = useState<CsDrill | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [periodDialog, setPeriodDialog] = useState<"custom" | "compare" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const p = useMemo(() => resolvePeriod(period, today), [period, today]);
  const mes = p.mes_ref;
  // As sugestões de Health Score da MAVI no mês (fase 4b): só no app, para quem vê CS.
  const [hs, setHs] = useState<HsSuggestions | null>(null);
  useEffect(() => {
    if (!hsCompany) return;
    let current = true;
    (hsCompany === "demo" ? Promise.resolve(demoHsSuggestions(data, mes)) : loadHsSuggestions(hsCompany, mes))
      .then((r) => current && setHs(r))
      .catch(() => current && setHs(null));
    return () => {
      current = false;
    };
  }, [hsCompany, mes, data, tick]);

  const ctx = useMemo<CsCtx>(() => ({
    e,
    drill: (metrica, params, title) => setDrill({ metrica, params, title }),
    profile: setProfile,
    color: (id) => e.squadOf(id ?? null)?.color || "#84908f",
    hs,
    requestHs: hsCompany && hs?.can_request
      ? async () => {
          if (hsCompany === "demo") return;
          await requestHsSuggestions(hsCompany, mes);
          setHs(await loadHsSuggestions(hsCompany, mes));
        }
      : null,
  }), [e, hs, hsCompany, mes]);

  // Squads nas abas: os ativos e os arquivados que têm ciclo no mês.
  const squadTabs = e.squads.filter((s) => !s.archived || e.cyclesOfMonth(mes).some((y) => e.cycleSquad(y) === s.id));
  const months = useMemo(() => {
    let min = monthStart(today);
    for (const c of e.clients) if (c.entry_date && monthStart(c.entry_date) < min) min = monthStart(c.entry_date);
    for (const y of e.cycles) if (y.month < min) min = y.month;
    const out: string[] = [];
    for (let m = monthStart(today); m >= min && out.length < 60; m = addMonths(m, -1)) out.push(m);
    return out;
  }, [e, today]);

  async function sync() {
    if (!onSync) return;
    setSyncing(true);
    setSyncError("");
    try {
      await onSync();
      onReload();
    } catch (err) {
      setSyncError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const periodValue = p.is_compare ? "compare" : period.tipo;
  return (
    <CsContext.Provider value={ctx}>
      <div className="cs-dash">
        <div className="cs-dash-head">
          {head}
          <div className="cs-dash-sync">
            <SyncChip sync={data.sync} />
            {onSync && (
              <Button className="btn secondary small" onClick={() => void sync()} loading={syncing} title="Ler a planilha de CS agora">
                <RefreshCw size={14} /> Sincronizar agora
              </Button>
            )}
            {syncError && <span className="cs-bad-text" role="alert">{syncError}</span>}
          </div>
        </div>

        <div className="cs-dash-bar">
          <div className="cs-seg" role="tablist" aria-label="Tela">
            {(["painel", "recebimento", "ranking"] as View[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                {v === "painel" ? "Painel" : v === "recebimento" ? "📅 Recebimento" : "🏆 Ranking"}
              </button>
            ))}
          </div>
          <div className="cs-month-nav">
            <button type="button" className="icon-btn" aria-label="Mês anterior" onClick={() => { setPeriod(shiftPeriod(period, -1, today)); setSemana(null); }}>
              <ChevronLeft size={16} />
            </button>
            <strong>{labelMesFull(mes)}</strong>
            <button type="button" className="icon-btn" aria-label="Mês seguinte" disabled={mes >= monthStart(today)}
              onClick={() => { setPeriod(shiftPeriod(period, 1, today)); setSemana(null); }}>
              <ChevronRight size={16} />
            </button>
          </div>
          {view === "painel" && (
            <Select value={periodValue} aria-label="Período" onValueChange={(v) => {
              if (v === "custom" || v === "compare") setPeriodDialog(v);
              else setPeriod({ tipo: v as CsWindow, mes });
            }}>
              <SelectOption value="mes">Mês</SelectOption>
              <SelectOption value="3m">Últimos 3 meses</SelectOption>
              <SelectOption value="6m">Últimos 6 meses</SelectOption>
              <SelectOption value="12m">Últimos 12 meses</SelectOption>
              <SelectOption value="custom">Período personalizado…</SelectOption>
              <SelectOption value="compare">Comparar dois períodos…</SelectOption>
            </Select>
          )}
          {view !== "ranking" && (
            <div className="cs-seg" role="group" aria-label="Squad">
              <button type="button" aria-pressed={squad === null} className={squad === null ? "on" : ""} onClick={() => setSquad(null)}>
                Consolidado
              </button>
              {squadTabs.map((s) => (
                <button key={s.id} type="button" aria-pressed={squad === s.id} className={squad === s.id ? "on" : ""} onClick={() => setSquad(s.id)}>
                  <i className="cs-dot" style={{ background: ctx.color(s.id) }} /> {s.name}
                </button>
              ))}
            </div>
          )}
          {view === "painel" && (
            <div className="cs-seg" role="group" aria-label="Recorte">
              {(["tudo", "trial", "base"] as CsDim[]).map((d) => (
                <button key={d} type="button" aria-pressed={dim === d} className={dim === d ? "on" : ""} onClick={() => setDim(d)}>
                  {d === "tudo" ? "Tudo" : d === "trial" ? "Trial" : "Base"}
                </button>
              ))}
            </div>
          )}
        </div>

        {view === "painel" && !p.is_single && (
          <div className="cs-banner info">
            📅 <strong>Período:</strong> {p.label} · {p.qtd_meses} {p.qtd_meses === 1 ? "mês" : "meses"}
            {p.is_compare && <> · <strong>Modo comparação ativo</strong></>}
            <button type="button" className="cs-link" onClick={() => setPeriod({ tipo: "mes", mes })}>← Voltar para o mês</button>
          </div>
        )}

        {view === "painel" && (
          <CsPanelBlocks f={{ mes_ref: mes, squad_id: squad, dim, modo: p.is_single ? "mensal" : "anual" }} p={p}
            semana={semana} onSemana={setSemana} onReceiving={() => setView("recebimento")}
            onYear={() => setPeriod({ tipo: "12m", mes })} />
        )}
        {view === "recebimento" && <CsReceivingView mes={mes} squad={squad} />}
        {view === "ranking" && <CsRankingView mes={mes} />}
      </div>

      {drill && <CsDrillModal engine={e} drill={drill} onClose={() => setDrill(null)} />}
      {profile && <CsClientProfile id={profile} onClose={() => setProfile(null)} />}
      {periodDialog && (
        <PeriodDialog kind={periodDialog} months={months} current={p} onClose={() => setPeriodDialog(null)}
          onApply={(s) => { setPeriod(s); setPeriodDialog(null); }} />
      )}
    </CsContext.Provider>
  );
}

function SyncChip({ sync }: { sync: CsLoaded["sync"] }) {
  const ago = (iso: string) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return "agora há pouco";
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    return `em ${new Date(iso).toLocaleDateString("pt-BR")}`;
  };
  if (!sync || !sync.finished_at)
    return <span className="cs-sync bad">⚠️ A planilha de CS ainda não foi lida</span>;
  if (sync.status === "error")
    return <span className="cs-sync bad" title={`Última tentativa ${ago(sync.finished_at)}`}>❌ A última leitura da planilha falhou — mostrando os dados anteriores</span>;
  return (
    <span className={`cs-sync ${sync.status === "warning" ? "warn" : ""}`} title={new Date(sync.finished_at).toLocaleString("pt-BR")}>
      {sync.status === "warning" ? "⚠️" : "🔄"} Planilha lida {ago(sync.finished_at)}
      {sync.status === "warning" && ` · ${sync.warnings} ${sync.warnings === 1 ? "aviso" : "avisos"}`}
    </span>
  );
}

function PeriodDialog({ kind, months, current, onClose, onApply }: {
  kind: "custom" | "compare"; months: string[]; current: ReturnType<typeof resolvePeriod>; onClose: () => void;
  onApply: (s: CsPeriodSetting) => void;
}) {
  const [ini, setIni] = useState(current.inicio);
  const [fim, setFim] = useState(current.fim);
  const [janela, setJanela] = useState<CsWindow>(current.compare?.janela ?? "mes");
  const [aFim, setAFim] = useState(current.compare?.a.fim ?? current.mes_ref);
  const [bFim, setBFim] = useState(current.compare?.b.fim ?? addMonths(current.mes_ref, -1));
  const [error, setError] = useState("");
  const monthSelect = (value: string, set: (v: string) => void, label: string) => (
    <label>
      {label}
      <Select value={value} onValueChange={set} aria-label={label}>
        {months.map((m) => <SelectOption key={m} value={m}>{labelMesFull(m)}</SelectOption>)}
      </Select>
    </label>
  );
  return (
    <Modal title={kind === "custom" ? "📅 Período personalizado" : "⚖️ Comparar dois períodos"} onClose={onClose}>
      <form className="entity-form" onSubmit={(ev) => {
        ev.preventDefault();
        if (kind === "custom") {
          if (ini > fim) return setError("O início precisa ser anterior ou igual ao fim.");
          if (monthsBetween(ini, fim) > 24) return setError("Janela máxima de 24 meses.");
          onApply({ tipo: "custom", ini, fim });
        } else {
          if (aFim === bFim) return setError("Os períodos A e B precisam terminar em meses diferentes.");
          onApply({ tipo: "compare", janela, a_fim: aFim, b_fim: bFim });
        }
      }}>
        {kind === "custom" ? (
          <>
            <p className="cs-muted">Janela máxima: 24 meses. Não pode incluir mês futuro.</p>
            {monthSelect(ini, setIni, "De")}
            {monthSelect(fim, setFim, "Até")}
          </>
        ) : (
          <>
            <p className="cs-muted">Escolha a janela e o mês final de cada período. Os dois têm o mesmo tamanho.</p>
            <label>
              Janela
              <Select value={janela} onValueChange={(v) => setJanela(v as CsWindow)} aria-label="Janela">
                <SelectOption value="mes">Mês</SelectOption>
                <SelectOption value="3m">3 meses</SelectOption>
                <SelectOption value="6m">6 meses</SelectOption>
                <SelectOption value="12m">12 meses</SelectOption>
              </Select>
            </label>
            {monthSelect(aFim, setAFim, "Período A — termina em")}
            {monthSelect(bFim, setBFim, "Período B — termina em")}
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button className="btn primary" type="submit">{kind === "custom" ? "Aplicar" : "Comparar"}</Button>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ perfil do cliente
function CsClientProfile({ id, onClose }: { id: string; onClose: () => void }) {
  const { e } = useCs();
  const c = e.clientOf(id);
  const all = e.cyclesOfClient(id);
  const cycles = [...all].reverse().slice(0, 12);
  const hs = [...e.hs.filter((h) => h.client === id)].sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, 12);
  const trialMes = (() => {
    const n = monthsBetween(c.entry_date, e.today) + 1;
    return n >= 4 ? "4+" : String(Math.max(1, n));
  })();
  const tipo = c.kind === "TRIAL" ? `Trial M${trialMes}` : c.kind === "BASE_RA" ? "Base (reativado)" : "Base";
  // As movimentações: entrada, graduação, churns e reativações (de todos os tempos).
  const movs = [
    { date: c.entry_date, text: `Entrada (${ORIGIN_LABEL[c.origin]})` },
    ...(e.gradMonth(c) && c.kind !== "TRIAL" ? [{ date: e.gradMonth(c)!, text: `Graduação Trial → Base (M${c.trial_month})` }] : []),
    ...e.churns.filter((x) => x.client.id === id).map((x) => ({
      date: x.date, text: `Churn${x.reason ? ` · motivo: ${CHURN_REASONS[x.reason].label}` : ""}`,
    })),
    ...e.reactivations.filter((x) => x.client.id === id).map((x) => ({ date: x.date, text: "Reativação" })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  const crit = (h: (typeof hs)[number]) =>
    [h.creatives && "Crv", h.meeting && "Aln", h.payment && "Pgto", h.perception && "PV", h.goal && "Meta"].filter(Boolean).join(" ") || "—";
  return (
    <Modal title={c.name} onClose={onClose} wide className="cs-profile">
      <div className="cs-profile-body">
      <div className="cs-profile-head">
        <span className="cs-muted">
          #{c.external_id} · {e.squadName(c.squad_id)} · entrou em {fmtDateBr(c.entry_date)} · vertical {c.vertical || "—"} · origem{" "}
          {ORIGIN_LABEL[c.origin]}
        </span>
        <span className="cs-pills">
          <span className={`cs-pill ${c.kind === "TRIAL" ? "orange" : "info"}`}>{tipo}</span>
          <span className={`cs-pill ${c.churn_date ? "bad" : c.status === "ATIVO" ? "good" : ""}`}>
            {c.churn_date ? `Churn ${fmtDateBr(c.churn_date)}` : c.status === "MAKE_IN" ? "Make IN" : c.status === "ATIVO" ? "Ativo" : "Inativo"}
          </span>
        </span>
      </div>
      <div className="cs-grid-3 cs-gap">
        <div className="cs-tight"><small>LTV histórico (R$)</small><strong>{fmtMoney(all.reduce((t, y) => t + y.paid, 0))}</strong></div>
        <div className="cs-tight"><small>Ciclos pagos</small>
          <strong>{all.filter((y) => y.status === "PAGO" || y.status === "PARCIAL").length} / {all.length}</strong></div>
        <div className="cs-tight"><small>Ciclos em PERDA</small><strong>{all.filter((y) => y.status === "PERDA").length}</strong></div>
      </div>
      {c.notes && <div className="cs-tight cs-gap"><small>Observações</small><p>{c.notes}</p></div>}
      <HsProfileSection client={id} />
      <h4 className="cs-label">Últimos {cycles.length} ciclos</h4>
      <div className="cs-table-wrap">
        <table className="cs-table">
          <thead><tr><th>Mês</th><th className="r">Melhor</th><th className="r">Provável</th><th className="r">Pago</th><th>Status</th><th>Adimp.</th></tr></thead>
          <tbody>
            {cycles.map((y) => (
              <tr key={y.id}>
                <td>{labelMes(y.month)}</td>
                <td className="r cs-muted">{fmtMoney(y.best)}</td>
                <td className="r cs-muted">{fmtMoney(y.probable)}</td>
                <td className="r"><b>{fmtMoney(y.paid)}</b></td>
                <td><span className={`cs-pill ${csPill(y.status)}`}>{y.status}</span></td>
                <td><span className={`cs-pill ${csPill(y.adimplencia)}`}>{y.adimplencia}</span></td>
              </tr>
            ))}
            {!cycles.length && <tr><td colSpan={6} className="cs-muted">Sem ciclos.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="cs-grid-2 cs-gap">
        <div>
          <h4 className="cs-label">Health Score</h4>
          {hs.length ? (
            <table className="cs-table">
              <thead><tr><th>Mês</th><th className="r">Score</th><th>Faixa</th><th>Critérios</th></tr></thead>
              <tbody>
                {hs.map((h) => (
                  <tr key={h.month}>
                    <td>{labelMes(h.month)}</td>
                    <td className="r">{numberFormat(h.score, 0)}%</td>
                    <td><span className={`cs-pill ${csPill(h.band)}`}>{h.band}</span></td>
                    <td className="cs-muted">{crit(h)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="cs-muted">Sem registros de HS.</p>}
        </div>
        <div>
          <h4 className="cs-label">Movimentações</h4>
          <ul className="cs-movs">
            {movs.map((m, i) => <li key={i}><span className="cs-muted">{fmtDateBr(m.date)}</span> · {m.text}</li>)}
          </ul>
        </div>
      </div>
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  History,
  Lightbulb,
  Radar,
  RefreshCw,
  Sparkles,
  Star,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { Button, Loading } from "./ui";
import { Empty } from "./components";
import { useUrlState } from "./router";
import {
  KIND_LABELS,
  LEVEL_LABELS,
  PRIORITY_LABELS,
  RUN_STATUS,
  SOURCE_LABELS,
  WINDOW_LABELS,
  basisHint,
  basisLabel,
  dayLabel,
  formatEvidence,
  localParts,
  money,
  nextScheduled,
  scheduleText,
  usageText,
  waitText,
  whenText,
  type CampaignInsight,
  type CampaignInsightsView,
  type InsightBadge,
  type InsightKind,
  type InsightRun,
  type InsightsBackend,
} from "./campaign-insights";
import "./campaign-insights.css";

/**
 * Campanhas › Insights da MAVI: o painel ao lado da campanha (os insights
 * abertos da última análise), a aba "Insights" (todos + o histórico das
 * análises, com custo) e o selo da lista. A análise é agendada pelo Painel
 * da MAVI ou pedida em "Analisar agora"; quando fica pronta, o banco avisa
 * (Realtime, evento mavi:campaign-insights) e a tela se recarrega.
 */

const KIND_ICONS: Record<InsightKind, typeof Star> = {
  highlight: Star,
  opportunity: TrendingUp,
  problem: TriangleAlert,
  tracking: Radar,
};

/** Os insights de uma campanha, recarregados quando o banco avisa. */
export function useCampaignInsights(backend: InsightsBackend, company: string, campaign: string) {
  const [view, setView] = useState<CampaignInsightsView | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    backend
      .view(company, campaign)
      .then((v) => {
        if (!live) return;
        setView(v);
        setError("");
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [backend, company, campaign, tick]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ campaign?: string }>).detail;
      if (!d?.campaign || d.campaign === campaign) setTick((t) => t + 1);
    };
    window.addEventListener("mavi:campaign-insights", on);
    return () => window.removeEventListener("mavi:campaign-insights", on);
  }, [campaign]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { view, error, reload };
}
export type InsightsState = ReturnType<typeof useCampaignInsights>;

/** "Analisar agora", com o porquê quando não dá (e quando libera). */
function AnalyzeNow({
  state,
  backend,
  company,
  campaign,
  notify,
  compact = false,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const v = state.view;
  if (!v) return null;
  const now = new Date();
  const waiting = v.wait_until && new Date(v.wait_until) > now ? v.wait_until : null;
  const last = v.runs.find((r) => r.status === "done");
  const disabled = !!v.pending || !!v.blocker || !!waiting || v.capped;
  const why = v.pending
    ? "Já há uma análise em andamento."
    : v.blocker
      ? v.blocker
      : v.capped
        ? "O teto do mês dos insights foi atingido."
        : waiting
          ? `A última análise é recente: a próxima libera ${waitText(waiting, now)}.`
          : "";
  const run = async () => {
    setBusy(true);
    setMessage("");
    try {
      const r = await backend.request(company, campaign);
      if (r.ok) notify("A MAVI começou a analisar a campanha. Os insights aparecem aqui quando ficarem prontos.");
      else setMessage(r.reason ?? "Não foi possível pedir a análise agora.");
      state.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`insights-analyze${compact ? " compact" : ""}`}>
      <Button
        className="btn secondary"
        onClick={() => void run()}
        loading={busy}
        disabled={disabled}
        title={why || "Pedir uma análise da MAVI agora (fica no histórico, com o custo)"}
      >
        <RefreshCw size={15} /> Analisar agora
      </Button>
      {(message || (why && !v.pending)) && (
        <small className="insights-why" role="status">
          {message || why}
          {last && (waiting || message) && (
            <>
              {" "}
              Última: {whenText(last.finished_at ?? last.created_at, now, v.timezone)}
              {last.trigger === "manual" && last.requested_by_name ? `, por ${last.requested_by_name}` : ", agendada"}.
            </>
          )}
        </small>
      )}
    </div>
  );
}

/** Quando foi a última e quando é a próxima. */
function statusLine(v: CampaignInsightsView) {
  const now = new Date();
  const last = v.runs.find((r) => r.status === "done");
  const parts: string[] = [];
  if (last) parts.push(`Última análise ${whenText(last.finished_at ?? last.created_at, now, v.timezone)}`);
  const next = nextScheduled(v.schedule, v.last_scheduled_day, now, v.timezone);
  if (next) {
    const today = localParts(now, v.timezone).day;
    parts.push(`próxima ${dayLabel(next.day, today)} a partir das ${next.hour}h`);
  } else parts.push("agendamento desligado");
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A análise em andamento — ou esperando a cota da plataforma liberar. */
function PendingLine({
  pending,
  timezone,
}: {
  pending: NonNullable<CampaignInsightsView["pending"]>;
  timezone: string;
}) {
  const who = pending.trigger === "manual" && pending.requested_by_name ? ` Pedida por ${pending.requested_by_name}.` : "";
  if (pending.waiting_until) {
    const at = new Date(pending.waiting_until).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone || undefined,
    });
    return (
      <p className="insights-running waiting" role="status" title={pending.note || undefined}>
        <span className="insights-pulse" aria-hidden="true" />
        Na fila: volta às {at}
        {pending.note ? ` (${pending.note.replace(/: a análise espera.*$/, "")})` : ""}.{who}
      </p>
    );
  }
  return (
    <p className="insights-running" role="status">
      <span className="insights-pulse" aria-hidden="true" />
      {pending.status === "running" ? "Analisando a campanha…" : "Análise na fila…"}
      {who}
    </p>
  );
}

/** Um insight: o que os números mostram, a ação e as evidências. */
export function InsightCard({ insight, compact = false }: { insight: CampaignInsight; compact?: boolean }) {
  const Icon = KIND_ICONS[insight.kind];
  const evidence = compact ? insight.evidence.slice(0, 2) : insight.evidence;
  return (
    <article className={`insight-card kind-${insight.kind} prio-${insight.priority}${compact ? " compact" : ""}`}>
      <header>
        <span className="insight-kind">
          <Icon size={13} aria-hidden="true" /> {KIND_LABELS[insight.kind]}
        </span>
        <span className={`insight-prio prio-${insight.priority}`} title="Prioridade">
          {PRIORITY_LABELS[insight.priority]}
        </span>
        {insight.seen_count > 1 && (
          <span className="insight-seen" title="A MAVI encontrou de novo nas análises seguintes">
            visto {insight.seen_count}x
          </span>
        )}
      </header>
      <h4>{insight.title}</h4>
      {insight.target && (
        <p className="insight-target">
          {LEVEL_LABELS[insight.target.level]}: <strong>{insight.target.name}</strong>
          {insight.target.parent ? <> · em {insight.target.parent}</> : null}
        </p>
      )}
      {insight.body && <p className="insight-body">{insight.body}</p>}
      {insight.action && (
        <p className="insight-action">
          <ArrowRight size={14} aria-hidden="true" />
          <span>{insight.action}</span>
        </p>
      )}
      <ul className="insight-evidence" aria-label="Evidências">
        {evidence.map((e) => (
          <li key={`${e.entity}|${e.window}|${e.metric}`}>
            <span>{e.label}</span>
            <strong>{formatEvidence(e)}</strong>
            <small>
              {e.name} · {WINDOW_LABELS[e.window]}
            </small>
          </li>
        ))}
      </ul>
      <footer>
        <span className="insight-basis" title={basisHint(insight.money_basis)}>
          Valores {basisLabel(insight.money_basis)}
        </span>
        {insight.source === "rule" ? (
          <span title="Encontrado pelas regras do sistema, sem modelo">Detecção automática</span>
        ) : insight.confidence !== null ? (
          <span title="O Jev conferiu que as evidências sustentam o insight">
            <BadgeCheck size={12} aria-hidden="true" /> Conferido ({Math.round(insight.confidence * 100)}%)
          </span>
        ) : (
          <span>
            <Sparkles size={12} aria-hidden="true" /> MAVI
          </span>
        )}
      </footer>
    </article>
  );
}

const COLLAPSED_KEY = "mavi:campanhas:insights-recolhido";
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};

/** O painel ao lado da campanha (em qualquer aba). */
export function CampaignInsightsAside({
  state,
  backend,
  company,
  campaign,
  notify,
  showTab,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
  /** A aba Insights está ligada (o link "Ver tudo"). */
  showTab: boolean;
}) {
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const [tab, setTab] = useUrlState<string>("aba", "dia");
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      /* sem armazenamento: só nesta visita */
    }
  };
  const v = state.view;
  // Na aba Insights o painel repetiria o mesmo conteúdo.
  if (!v || !v.enabled || !v.places.panel || (showTab && tab === "insights")) return null;
  const list = v.current;
  const high = list.filter((i) => i.priority === "high").length;
  if (collapsed)
    return (
      <aside className="campaign-insights-aside collapsed" aria-label="Insights da MAVI">
        <button
          type="button"
          className="insights-rail"
          onClick={() => setCollapsed(false)}
          title="Mostrar os insights da MAVI"
        >
          <ChevronsLeft size={15} aria-hidden="true" />
          <Lightbulb size={16} aria-hidden="true" />
          {list.length > 0 && <span className={`insights-count${high ? " high" : ""}`}>{list.length}</span>}
          <span className="insights-rail-label">Insights</span>
        </button>
      </aside>
    );
  return (
    <aside className="panel campaign-insights-aside" aria-label="Insights da MAVI">
      <header>
        <Lightbulb size={17} aria-hidden="true" />
        <div>
          <strong>Insights da MAVI</strong>
          <small>{statusLine(v)}</small>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setCollapsed(true)}
          title="Recolher"
          aria-label="Recolher os insights"
        >
          <ChevronsRight size={16} />
        </button>
      </header>
      {v.pending && <PendingLine pending={v.pending} timezone={v.timezone} />}
      <div className="insights-aside-list">
        {list.slice(0, 4).map((i) => (
          <InsightCard key={i.id} insight={i} compact />
        ))}
        {!list.length && !v.pending && (
          <p className="insights-empty">
            {v.blocker
              ? v.blocker
              : v.runs.some((r) => r.status === "done")
                ? "Nada que mereça ação na última análise."
                : "A MAVI ainda não analisou esta campanha."}
          </p>
        )}
      </div>
      <footer>
        <AnalyzeNow state={state} backend={backend} company={company} campaign={campaign} notify={notify} compact />
        {showTab && (list.length > 4 || v.runs.length > 0) && (
          <button type="button" className="text-btn" onClick={() => setTab("insights")}>
            {list.length > 4 ? `Ver os ${list.length} insights` : "Ver tudo"} e o histórico
          </button>
        )}
      </footer>
    </aside>
  );
}

function RunRow({ run, timezone }: { run: InsightRun; timezone: string }) {
  const [open, setOpen] = useState(false);
  const now = new Date();
  const who = run.trigger === "manual" ? `Pedida por ${run.requested_by_name ?? "alguém"}` : "Agendada";
  const count =
    run.status === "done"
      ? [
          run.insights_count ? `${run.insights_count} ${run.insights_count === 1 ? "novo" : "novos"}` : "",
          run.repeated_count ? `${run.repeated_count} ${run.repeated_count === 1 ? "confirmado" : "confirmados"}` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "nada novo"
      : "";
  return (
    <li className={`insights-run status-${run.status}`}>
      <button type="button" className="insights-run-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span className="insights-run-when">{whenText(run.created_at, now, timezone)}</span>
        <span className="insights-run-who">{who}</span>
        <span className={`insights-run-status status-${run.status}`}>{RUN_STATUS[run.status]}</span>
        <span className="insights-run-count">{count}</span>
        <span className="insights-run-cost" title={run.model ? `Modelo: ${run.model}${run.provider_name ? ` (${run.provider_name})` : ""}` : undefined}>
          {run.status === "done" || run.cost_usd ? money(run.cost_usd) : ""}
        </span>
      </button>
      {open && (
        <div className="insights-run-body">
          {run.summary && <p className="insights-run-summary">{run.summary}</p>}
          {run.note && (
            <p className="insights-run-note">
              <CircleAlert size={13} aria-hidden="true" /> {run.note}
            </p>
          )}
          <dl className="insights-run-meta">
            {run.model && (
              <>
                <dt>Modelo</dt>
                <dd>
                  {run.model}
                  {run.provider_name ? ` (${run.provider_name})` : ""}
                </dd>
              </>
            )}
            {run.money_basis && (
              <>
                <dt>Valores</dt>
                <dd title={basisHint(run.money_basis)}>{basisLabel(run.money_basis)}</dd>
              </>
            )}
            {run.windows.cycle && (
              <>
                <dt>Ciclo lido</dt>
                <dd>
                  {run.windows.cycle.since.split("-").reverse().slice(0, 2).join("/")} a{" "}
                  {run.windows.cycle.until.split("-").reverse().slice(0, 2).join("/")}
                </dd>
              </>
            )}
            <dt>Custo</dt>
            <dd>{money(run.cost_usd)}</dd>
            {usageText(run) && (
              <>
                <dt>Uso</dt>
                <dd>{usageText(run)}</dd>
              </>
            )}
          </dl>
          {run.insights.length > 0 && (
            <div className="insights-grid">
              {run.insights.map((i) => (
                <InsightCard key={i.id} insight={i} />
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** A aba "Insights": os abertos e o histórico das análises (auditoria e custo). */
export function CampaignInsightsTab({
  state,
  backend,
  company,
  campaign,
  notify,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
}) {
  const v = state.view;
  if (state.error && !v)
    return (
      <p className="form-error campaign-tab-body" role="alert">
        Não foi possível carregar os insights: {state.error}
      </p>
    );
  if (!v) return <Loading variant="list" />;
  if (!v.enabled)
    return (
      <div className="campaign-tab-body">
        <Empty
          title="Insights da MAVI desligados"
          body="Administradores e gestores ligam as análises da MAVI em Painel da MAVI › Campanhas."
        />
      </div>
    );
  return (
    <div className="campaign-tab-body campaign-insights-tab">
      <div className="insights-tab-top">
        <div>
          <h3>
            <Lightbulb size={17} aria-hidden="true" /> Insights da MAVI
          </h3>
          <p>
            {scheduleText(v.schedule)} ({SOURCE_LABELS[v.schedule.source]}). {statusLine(v)}. A MAVI cruza a plataforma,
            o MakeCRM (por UTM) e o contexto do cliente; cada número vem das evidências.
          </p>
        </div>
        <AnalyzeNow state={state} backend={backend} company={company} campaign={campaign} notify={notify} />
      </div>
      {v.pending && <PendingLine pending={v.pending} timezone={v.timezone} />}
      <section aria-label="Insights abertos">
        <h4 className="insights-section-title">Da última análise</h4>
        {v.current.length ? (
          <div className="insights-grid">
            {v.current.map((i) => (
              <InsightCard key={i.id} insight={i} />
            ))}
          </div>
        ) : (
          <p className="insights-empty">
            {v.blocker ??
              (v.runs.some((r) => r.status === "done")
                ? "Nada que mereça ação na última análise."
                : "A MAVI ainda não analisou esta campanha.")}
          </p>
        )}
      </section>
      <section aria-label="Histórico das análises">
        <h4 className="insights-section-title">
          <History size={15} aria-hidden="true" /> Histórico das análises
        </h4>
        {v.runs.length ? (
          <ul className="insights-runs">
            {v.runs.map((r) => (
              <RunRow key={r.id} run={r} timezone={v.timezone} />
            ))}
          </ul>
        ) : (
          <p className="insights-empty">Nenhuma análise ainda.</p>
        )}
      </section>
    </div>
  );
}

/** O selo da lista de Campanhas. */
export function InsightsBadgeChip({ badge, onOpen }: { badge: InsightBadge | undefined; onOpen: () => void }) {
  if (!badge) return <span className="cell-note">—</span>;
  if (!badge.open && badge.running)
    return (
      <span className="insights-badge running" title="A MAVI está analisando">
        <span className="insights-pulse" aria-hidden="true" /> Analisando
      </span>
    );
  const label = `${badge.open} ${badge.open === 1 ? "insight" : "insights"}${badge.high ? ` (${badge.high} de prioridade alta)` : ""}`;
  return (
    <button
      type="button"
      className={`insights-badge${badge.high ? " high" : badge.medium ? " medium" : ""}`}
      title={`${label}: abrir`}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <Lightbulb size={13} aria-hidden="true" />
      {badge.open}
      {badge.high > 0 && <span className="insights-badge-high">{badge.high} alta</span>}
    </button>
  );
}

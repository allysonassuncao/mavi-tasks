import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  CalendarClock,
  ExternalLink,
  ListChecks,
  Megaphone,
  Pencil,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { Modal } from "./components";
import { PanelChart } from "./DashboardCharts";
import type { Display, PanelSpec, Unit } from "./dashboards";
import { useUrlState } from "./router";
import { contractParts } from "./domain";
import type { Snapshot } from "./types";
import {
  addDays,
  cycleDays,
  destinations,
  money,
  objectives,
  parseAmount,
  platforms,
  searchablePlatform,
  shortDate,
  type AdCampaign,
  type AdCampaignEvent,
  type AdCycle,
  type AdObjective,
} from "./campaigns";
import {
  conversionRate,
  costLabel,
  cpa,
  cpc,
  ctr,
  cycleKpis,
  dateRange,
  diverges,
  frequency,
  historicalGoal,
  liveDeltas,
  sumDays,
  type CampaignMetrics,
  type CycleKpis,
  type CycleSnapshot,
  type DailyMetric,
  type MetricValues,
  type MetricsBackend,
  type Totals,
} from "./campaign-metrics";

/**
 * The campaign's day to day (MASO: registro/analista/v6): the cycle's header
 * (media, goal, pace, score…), the "Dia a Dia" charts and the "Linha do
 * tempo" with the cycle's snapshots, the daily records (with the "LIVE"
 * check) and what the client sees. Values without M by default; the switch
 * in the header shows everything with M (what the client contracted). The
 * records of the "Linha do tempo" can be edited, as in the MASO.
 */

const count = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const n = (v: number) => count.format(v);
const d2 = (v: number | null) => (v === null ? "—" : decimal.format(v));
const pct = (v: number | null) => (v === null ? "—" : `${decimal.format(v)}%`);
const brl = (v: number | null) => (v === null ? "—" : money(v));
const dayLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

const M_KEY = "mavi:campanhas:com-m";
function useWithM(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(M_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(M_KEY, v ? "1" : "0");
    } catch {
      // A preference only: without storage it lasts until the page closes.
    }
  };
  return [value, set];
}

type Tab = "dia" | "linha" | "ciclos";

export function CampaignDayToDay({
  campaign,
  cycles,
  current,
  company,
  data,
  metricsBackend,
  today,
  events,
  describeEvent,
  notify,
  tags,
  actions,
  banner,
  connection,
  cyclesTab,
  onRecordEdited,
  onConversions,
  metricsTick = 0,
}: {
  campaign: AdCampaign;
  /** Oldest first. */
  cycles: AdCycle[];
  current: AdCycle | null;
  company: string;
  /** For the client, the product and the teams serving the client. */
  data: Snapshot;
  metricsBackend: MetricsBackend;
  today: string;
  events: AdCampaignEvent[] | null;
  describeEvent: (e: AdCampaignEvent) => string;
  notify: (message: string) => void;
  /** Platform and status chips, the actions and the cycle's alert. */
  tags: ReactNode;
  actions: ReactNode;
  banner: ReactNode;
  /** The client's Facebook connection (Meta), under the ad accounts. */
  connection?: ReactNode;
  cyclesTab: ReactNode;
  /** A record was edited: the history (events) changed too. */
  onRecordEdited: () => void;
  /** Google: opens "Conversões do Google que contam" for the cycle. */
  onConversions?: (cycle: AdCycle) => void;
  /** Bumped after the numbers changed elsewhere (read them again). */
  metricsTick?: number;
}) {
  const [tab, setTab] = useUrlState<string>("aba", "dia");
  const [cycleId, setCycleId] = useUrlState<string>("ciclo", "");
  const [withM, setWithM] = useWithM();
  const [metrics, setMetrics] = useState<CampaignMetrics | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  useEffect(() => {
    let live = true;
    metricsBackend
      .load(company, campaign.id)
      .then((m) => {
        if (!live) return;
        setMetrics(m);
        setError("");
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [metricsBackend, company, campaign.id, tick, metricsTick]);

  const cycle =
    cycles.find((y) => y.id === cycleId) ??
    current ??
    cycles[cycles.length - 1] ??
    null;
  const active: Tab =
    !cycle || (tab !== "linha" && tab !== "ciclos")
      ? cycle
        ? "dia"
        : "ciclos"
      : (tab as Tab);
  const k =
    metrics && cycle
      ? cycleKpis(cycle, campaign.platform, metrics, today, withM)
      : null;
  const running =
    !!cycle && cycle.start_date <= today && today <= cycle.end_date;

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await metricsBackend.sync(company, campaign.id);
      notify(
        result.errors.length
          ? `Sincronização com erro: ${result.errors[0].message}`
          : result.synced
            ? "Números atualizados com a plataforma."
            : "Nenhum ciclo com vínculos para sincronizar agora.",
      );
      setTick((t) => t + 1);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <CampaignSummary
        campaign={campaign}
        cycles={cycles}
        cycle={cycle}
        current={current}
        data={data}
        metrics={metrics}
        error={error}
        k={k}
        withM={withM}
        onWithM={setWithM}
        onCycle={setCycleId}
        syncing={syncing}
        onSync={() => void sync()}
        tags={tags}
        actions={actions}
        connection={connection}
        onConversions={onConversions}
      />
      {banner}
      {k?.overPace && running && (
        <div className="campaign-alert danger" role="status">
          <TriangleAlert size={18} />
          <span>
            Gastamos mais do que o esperado: {money(k.overPace.spent)} até
            ontem, quando deveríamos ter gasto {money(k.overPace.expected)}.
            Verifique a integração ou o orçamento na plataforma.
          </span>
        </div>
      )}
      <div className="campaign-workspace">
        <section className="panel campaign-tabs-panel">
          <div className="scope-tabs" role="tablist" aria-label="Visões">
            {(
              [
                ["dia", "Dia a Dia"],
                ["linha", "Linha do tempo"],
                ["ciclos", "Ciclos e histórico"],
              ] as [Tab, string][]
            )
              .filter(([id]) => cycle || id === "ciclos")
              .map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active === id}
                  className={active === id ? "selected" : ""}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
          </div>
          {active === "ciclos" ? (
            <div className="campaign-tab-body flush">{cyclesTab}</div>
          ) : !metrics ? (
            error ? (
              <p className="form-error campaign-tab-body" role="alert">
                Não foi possível carregar os números: {error}
              </p>
            ) : (
              <Loading compact />
            )
          ) : active === "dia" && cycle ? (
            <DayToDay
              cycles={cycles}
              cycle={cycle}
              metrics={metrics}
              objective={cycle.objective}
              today={today}
              withM={withM}
            />
          ) : cycle ? (
            <Timeline
              campaign={campaign}
              cycles={cycles}
              cycle={cycle}
              metrics={metrics}
              today={today}
              withM={withM}
              events={events}
              describeEvent={describeEvent}
              onEdit={setEditing}
            />
          ) : null}
        </section>
      </div>
      {editing && cycle && (
        <RecordEditor
          target={editing}
          cycle={cycles.find((y) => y.id === editing.row.cycle_id) ?? cycle}
          backend={metricsBackend}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setTick((t) => t + 1);
            onRecordEdited();
            notify("Registro atualizado.");
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Summary (the MASO's header)                                         */

function CampaignSummary({
  campaign,
  cycles,
  cycle,
  current,
  data,
  metrics,
  error,
  k,
  withM,
  onWithM,
  onCycle,
  syncing,
  onSync,
  tags,
  actions,
  connection,
  onConversions,
}: {
  campaign: AdCampaign;
  cycles: AdCycle[];
  cycle: AdCycle | null;
  current: AdCycle | null;
  data: Snapshot;
  metrics: CampaignMetrics | null;
  error: string;
  k: CycleKpis | null;
  withM: boolean;
  onWithM: (v: boolean) => void;
  onCycle: (id: string) => void;
  syncing: boolean;
  onSync: () => void;
  tags: ReactNode;
  actions: ReactNode;
  connection?: ReactNode;
  onConversions?: (cycle: AdCycle) => void;
}) {
  const parts = contractParts(data, campaign.contract_id);
  const lastRun = cycle
    ? metrics?.runs.find((r) => r.cycle_id === cycle.id)
    : undefined;
  // Teams serving the client, with their people (supervisors first).
  const teams = data.clientTeams
    .filter((ct) => ct.client_id === parts.client?.id)
    .map((ct) => data.teams.find((t) => t.id === ct.team_id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({
      name: t.name,
      people: data.teamMembers
        .filter((m) => m.team_id === t.id)
        .sort((a, b) => Number(!!b.supervisor) - Number(!!a.supervisor))
        .map(
          (m) =>
            `${data.members.find((x) => x.user_id === m.user_id)?.name ?? "—"}${m.supervisor ? " (supervisão)" : ""}`,
        ),
    }));
  const accounts = cycle
    ? [...new Map(cycle.links.map((l) => [l.account_id, l])).values()]
    : [];
  const linkedCampaigns = cycle
    ? cycle.links.filter((l) => l.campaign_id).length
    : 0;
  const result = cycle ? objectives[cycle.objective].result : "";
  const costName = cycle ? costLabel[cycle.objective] : "";
  const pages =
    cycle?.destination === "make_landing_page" && cycle.landing_pages.length
      ? ` (${cycle.landing_pages.join(", ")})`
      : "";
  return (
    <section className="panel campaign-summary">
      <div className="campaign-summary-top">
        <div className="campaign-summary-title">
          <span className="campaign-eyebrow">
            <Megaphone size={14} /> {parts.client?.name} · {parts.product?.name}
            {parts.detail && ` (${parts.detail})`}
          </span>
          <h2>{campaign.name}</h2>
          <div className="campaign-tags">
            {k?.status ? (
              <span
                className={`campaign-chip ${k.status === "good" ? "current" : "danger"}`}
                title="Resultado do ciclo contra a meta (custo por resultado)"
              >
                {k.status === "good" ? "Bom" : "Ruim"}
              </span>
            ) : (
              <span
                className="campaign-chip muted"
                title="Sem números do ciclo"
              >
                N/D
              </span>
            )}
            {tags}
          </div>
        </div>
        <div className="campaign-summary-side">
          <div className="campaign-actions">{actions}</div>
          {cycle && (
            <div className="campaign-m-control">
              <span
                className="campaign-m-value"
                title="Índice de performance (M) do ciclo: a verba do cliente ÷ M é o que a plataforma pode gastar"
              >
                M <strong>{decimal.format(cycle.multiplier)}</strong>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={withM}
                aria-label="Valores com M aplicado"
                className={`template-switch campaign-m-switch${withM ? " on" : ""}`}
                title={
                  withM
                    ? `Tudo com M (× ${decimal.format(cycle.multiplier)}), como o cliente contratou e vê. Clique para ver sem M.`
                    : "Tudo sem M: o que a plataforma gasta. Clique para ver com M."
                }
                onClick={() => onWithM(!withM)}
              >
                <span aria-hidden="true" />
                {withM ? "Com M aplicado" : "Sem M"}
              </button>
            </div>
          )}
        </div>
      </div>

      {cycle && (
        <dl className="campaign-facts-row">
          <div>
            <dt>Cliente</dt>
            <dd>{parts.client?.name ?? "—"}</dd>
          </div>
          <div>
            <dt>Plataforma</dt>
            <dd>{platforms[campaign.platform]}</dd>
          </div>
          <div className="campaign-facts-cycle">
            <dt>Ciclo</dt>
            <dd>
              <Select
                value={cycle.id}
                onValueChange={onCycle}
                aria-label="Ciclo"
              >
                {[...cycles].reverse().map((y, i) => (
                  <SelectOption key={y.id} value={y.id}>
                    {cycles.length - i}º · {shortDate(y.start_date)} a{" "}
                    {shortDate(y.end_date)}
                    {y.id === current?.id ? " (atual)" : ""}
                  </SelectOption>
                ))}
              </Select>
            </dd>
          </div>
          <div>
            <dt>Objetivo</dt>
            <dd>{objectives[cycle.objective].label}</dd>
          </div>
          <div>
            <dt>Página de destino</dt>
            <dd title={pages ? cycle.landing_pages.join(", ") : undefined}>
              {destinations[cycle.destination]}
              {pages}
            </dd>
          </div>
          <div>
            <dt title="Índice de performance">M</dt>
            <dd>
              {decimal.format(cycle.multiplier)}{" "}
              <small className="cell-note">
                {withM ? "(valores com M)" : "(valores sem M)"}
              </small>
            </dd>
          </div>
        </dl>
      )}

      {cycle && !k && !error && <Loading compact />}
      {error && !metrics && (
        <p className="form-error" role="alert">
          Não foi possível carregar os números: {error}
        </p>
      )}
      {cycle && k && (
        <dl className="campaign-kpi-row">
          <Kpi
            label="Mídia total"
            hint={
              withM
                ? "Verba do ciclo, com M"
                : "Verba do ciclo ÷ M (o que a plataforma pode gastar)"
            }
          >
            {money(k.budget)}
          </Kpi>
          <Kpi
            label="Mídia restante"
            hint={`Gasto até ontem: ${money(k.spent)}`}
          >
            {money(k.left)}
          </Kpi>
          <Kpi
            label="Meta"
            hint="Quantidade de resultados esperada e o custo por resultado que ela implica (verba ÷ meta)"
            sub={k.goalCost === null ? undefined : money(k.goalCost)}
          >
            {k.goal ? n(k.goal) : "—"}
          </Kpi>
          <Kpi
            label="Conversões diárias ideais"
            hint={
              k.idealConversions
                ? `Hoje precisamos alcançar em média ${n(k.idealConversions)} ${result} por dia para bater a meta`
                : k.goal
                  ? "Superamos a meta, parabéns!"
                  : "Sem meta"
            }
          >
            {n(k.idealConversions)}
          </Kpi>
          <Kpi
            label="Atual"
            hint={`${d2(k.conversions)} ${result} no ciclo; ${costName}: ${brl(k.cost)}`}
            sub={brl(k.cost)}
            tone={
              k.cost !== null && k.goalCost !== null
                ? k.cost <= k.goalCost
                  ? "good"
                  : "bad"
                : undefined
            }
          >
            {d2(k.conversions)}
          </Kpi>
          <Kpi
            label="Orçamento diário"
            hint={`Mídia restante ÷ ${k.remaining} ${k.remaining === 1 ? "dia restante" : "dias restantes"} (hoje incluído)`}
          >
            {money(k.idealBudget)}
          </Kpi>
          <Kpi
            label="Taxa de melhoramento"
            hint="Custo por resultado de hoje contra o do início do ciclo"
            tone={
              k.improvement === null
                ? undefined
                : k.improvement >= 0
                  ? "good"
                  : "bad"
            }
          >
            {k.improvement === null
              ? "—"
              : `${k.improvement >= 0 ? "" : "−"}${decimal.format(Math.abs(k.improvement))}%`}
          </Kpi>
          <Kpi
            label="Dia da campanha"
            hint={`${cycles.findIndex((y) => y.id === cycle.id) + 1}º ciclo, ${k.days} dias; números até ontem`}
          >
            D-{k.elapsed}
          </Kpi>
          <Kpi
            label="Score"
            hint="CTR, CPC, CPM e custo por resultado, de 0 a 100 (regra do MASO)"
          >
            {k.score === null ? "—" : decimal.format(k.score)}
          </Kpi>
        </dl>
      )}

      <div className="campaign-summary-foot">
        <div>
          <span className="campaign-foot-label">Contas de anúncio</span>
          {accounts.length ? (
            <span
              title={accounts
                .map((l) => `${l.account_name || "Conta"} (${l.account_id})`)
                .join("\n")}
            >
              {accounts[0].account_name || accounts[0].account_id}
              {accounts.length > 1 ? ` +${accounts.length - 1}` : ""} ·{" "}
              {linkedCampaigns
                ? `${linkedCampaigns} ${linkedCampaigns === 1 ? "campanha" : "campanhas"}`
                : "conta inteira"}
            </span>
          ) : (
            <span className="muted">Nenhuma vinculada ao ciclo</span>
          )}
          {connection}
        </div>
        <div>
          <span className="campaign-foot-label">Números</span>
          {searchablePlatform(campaign.platform) ? (
            <span className="campaign-foot-sync">
              <span
                className={lastRun?.status === "error" ? "danger-text" : ""}
              >
                {lastRun
                  ? `${lastRun.status === "error" ? "Falha" : "Sincronizado"} em ${new Date(
                      lastRun.created_at,
                    ).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : accounts.length
                    ? "Ainda não sincronizado"
                    : "Vincule contas ao ciclo"}
              </span>
              <Button
                className="text-btn"
                onClick={onSync}
                disabled={syncing || !accounts.length}
                title={
                  lastRun?.status === "error"
                    ? lastRun.message
                    : "Buscar agora os números na plataforma"
                }
              >
                <RefreshCw
                  size={13}
                  className={syncing ? "campaign-spin" : ""}
                />{" "}
                {syncing ? "Sincronizando…" : "Sincronizar"}
              </Button>
              {campaign.platform === "google" && cycle && onConversions && (
                <Button
                  className="text-btn"
                  onClick={() => onConversions(cycle)}
                  title="Quais ações de conversão do Google contam como resultado deste ciclo"
                >
                  <ListChecks size={13} /> Conversões que contam
                </Button>
              )}
            </span>
          ) : (
            <span className="muted">Automáticos só para Meta e Google Ads</span>
          )}
        </div>
        <div>
          <span className="campaign-foot-label">Responsáveis pelo cliente</span>
          {teams.length ? (
            <span
              title={teams
                .map((t) => `${t.name}: ${t.people.join(", ") || "—"}`)
                .join("\n")}
            >
              {teams
                .map(
                  (t) =>
                    `${t.name}${t.people.length ? ` (${t.people.length})` : ""}`,
                )
                .join(" · ")}
            </span>
          ) : (
            <span className="muted">Nenhuma equipe atende o cliente</span>
          )}
        </div>
        {(campaign.briefing_url || campaign.media_plan_url) && (
          <div>
            <span className="campaign-foot-label">Documentos</span>
            <span className="campaign-foot-links">
              {campaign.briefing_url && (
                <a
                  href={campaign.briefing_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Briefing <ExternalLink size={11} />
                </a>
              )}
              {campaign.media_plan_url && (
                <a
                  href={campaign.media_plan_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Plano de mídia <ExternalLink size={11} />
                </a>
              )}
            </span>
          </div>
        )}
      </div>
      {campaign.notes && (
        <p className="campaign-summary-notes" title="Observações da campanha">
          {campaign.notes}
        </p>
      )}
    </section>
  );
}
function Kpi({
  label,
  hint,
  sub,
  tone,
  children,
}: {
  label: string;
  /** Shown on hover (the explanations stay out of the way). */
  hint?: string;
  /** A second value under the main one (e.g. the cost of the goal). */
  sub?: string;
  tone?: "good" | "bad";
  children: ReactNode;
}) {
  return (
    <div className="campaign-kpi" title={hint}>
      <dt>{label}</dt>
      <dd
        className={
          tone === "good" ? "good-text" : tone === "bad" ? "danger-text" : ""
        }
      >
        {children}
      </dd>
      {sub && <small className="campaign-kpi-sub">{sub}</small>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Charts                                                              */

const COLORS = ["#5b8fd6", "#8fbf5a", "#d09b61", "#a879c9"];
function chart(
  days: string[],
  unit: Unit,
  series: { name: string; values: (number | null)[] }[],
): Display {
  return {
    keys: days,
    labels: days.map(dayLabel),
    series: series.map((s, i) => ({
      id: String(i),
      name: s.name,
      color: COLORS[i % COLORS.length],
      unit,
      values: s.values,
    })),
    unit,
    interval: "day",
  };
}
function Chart({
  title,
  display,
  viz,
}: {
  title: string;
  display: Display;
  viz: "bar" | "line";
}) {
  const spec: PanelSpec = {
    viz,
    groupBy: "time",
    queries: [],
    unit: display.unit,
  };
  return (
    <figure className="campaign-chart">
      <figcaption>{title}</figcaption>
      <div className="campaign-chart-body">
        <PanelChart display={display} spec={spec} />
      </div>
    </figure>
  );
}

type Period = { from: string; to: string };
function PeriodPicker({
  cycle,
  today,
  value,
  onChange,
}: {
  cycle: AdCycle;
  today: string;
  value: Period;
  onChange: (p: Period) => void;
}) {
  const yesterday = addDays(today, -1);
  const month = today.slice(0, 7);
  const lastMonthEnd = addDays(`${month}-01`, -1);
  const shortcuts: [string, Period][] = [
    [
      "Ciclo",
      { from: cycle.start_date, to: [cycle.end_date, yesterday].sort()[0] },
    ],
    ["Ontem", { from: yesterday, to: yesterday }],
    ["7 dias", { from: addDays(today, -7), to: yesterday }],
    ["30 dias", { from: addDays(today, -30), to: yesterday }],
    ["Este mês", { from: `${month}-01`, to: yesterday }],
    [
      "Mês passado",
      { from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
    ],
  ];
  return (
    <div className="campaign-period">
      <label>
        De
        <Input
          type="date"
          value={value.from}
          max={value.to}
          onChange={(e) =>
            e.target.value && onChange({ ...value, from: e.target.value })
          }
        />
      </label>
      <label>
        Até
        <Input
          type="date"
          value={value.to}
          min={value.from}
          onChange={(e) =>
            e.target.value && onChange({ ...value, to: e.target.value })
          }
        />
      </label>
      <div className="drive-view" role="group" aria-label="Atalhos de período">
        {shortcuts.map(([label, p]) => (
          <button
            key={label}
            type="button"
            className={
              value.from === p.from && value.to === p.to ? "selected" : ""
            }
            onClick={() => onChange(p)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function usePeriod(cycle: AdCycle, today: string) {
  const initial = useCallback(
    () => ({
      from: cycle.start_date,
      to: [cycle.end_date, addDays(today, -1)].sort()[0],
    }),
    [cycle.start_date, cycle.end_date, today],
  );
  const [period, setPeriod] = useState<Period>(initial);
  useEffect(() => setPeriod(initial()), [initial]);
  return [period, setPeriod] as const;
}

function DayToDay({
  cycles,
  cycle,
  metrics,
  objective,
  today,
  withM,
}: {
  cycles: AdCycle[];
  cycle: AdCycle;
  metrics: CampaignMetrics;
  objective: AdObjective;
  today: string;
  withM: boolean;
}) {
  const [period, setPeriod] = usePeriod(cycle, today);
  const days =
    period.from <= period.to ? dateRange(period.from, period.to) : [];
  const byDay = useMemo(() => {
    const map = new Map<string, DailyMetric[]>();
    for (const r of metrics.daily)
      if (r.day >= period.from && r.day <= period.to)
        map.set(r.day, [...(map.get(r.day) ?? []), r]);
    return map;
  }, [metrics.daily, period]);
  const rows = [...byDay.values()].flat();
  const at = (d: string) => byDay.get(d) ?? [];
  const spendOf = (list: DailyMetric[]) =>
    list.reduce((s, r) => s + r.spend * (withM ? r.multiplier : 1), 0);
  const total = sumDays(rows);
  const totalSpend = spendOf(rows);
  const funnel = objective === "sale" || objective === "custom";
  const result = objectives[objective].result;
  const value = (d: string, f: (t: Totals) => number | null) => {
    const list = at(d);
    if (!list.length) return null;
    const t = sumDays(list);
    return f({ ...t, spend: spendOf(list) });
  };
  return (
    <div className="campaign-tab-body">
      <PeriodPicker
        cycle={cycle}
        today={today}
        value={period}
        onChange={setPeriod}
      />
      {!rows.length ? (
        <p className="muted">
          Não existem registros para o período selecionado.
        </p>
      ) : (
        <>
          <dl className="campaign-period-totals">
            <div>
              <dt>Investimento{withM ? " (com M)" : ""}</dt>
              <dd>{money(totalSpend)}</dd>
            </div>
            <div>
              <dt>Resultados</dt>
              <dd>
                {d2(total.conversions)} {result}
              </dd>
            </div>
            <div>
              <dt>{costLabel[objective]}</dt>
              <dd>
                {brl(total.conversions ? totalSpend / total.conversions : null)}
              </dd>
            </div>
            <div>
              <dt>Impressões</dt>
              <dd>{n(total.impressions)}</dd>
            </div>
            <div>
              <dt>Cliques</dt>
              <dd>{n(total.clicks)}</dd>
            </div>
            <div>
              <dt>CTR</dt>
              <dd>{pct(ctr(total))}</dd>
            </div>
            <div>
              <dt>CPC</dt>
              <dd>{brl(total.clicks ? totalSpend / total.clicks : null)}</dd>
            </div>
          </dl>
          <div className="campaign-charts">
            <Chart
              title={`Consumo por dia${withM ? " (com M)" : ""}`}
              viz="bar"
              display={chart(days, "money", [
                {
                  name: "Investimento",
                  values: days.map((d) => value(d, (t) => t.spend)),
                },
              ])}
            />
            <Chart
              title="Conversões por dia"
              viz="bar"
              display={chart(days, "number", [
                {
                  name: "Resultados",
                  values: days.map((d) => value(d, (t) => t.conversions)),
                },
              ])}
            />
            {funnel && (
              <Chart
                title="Etapas de venda"
                viz="bar"
                display={chart(days, "number", [
                  {
                    name: "Visualização de produto",
                    values: days.map((d) => value(d, (t) => t.view_content)),
                  },
                  {
                    name: "Adição ao carrinho",
                    values: days.map((d) => value(d, (t) => t.add_to_cart)),
                  },
                  {
                    name: "Finalização de compra",
                    values: days.map((d) =>
                      value(d, (t) => t.initiate_checkout),
                    ),
                  },
                ])}
              />
            )}
            <Chart
              title="CTR (cliques ÷ impressões)"
              viz="line"
              display={chart(days, "percent", [
                { name: "CTR", values: days.map((d) => value(d, ctr)) },
              ])}
            />
            <Chart
              title={`CPC${withM ? " (com M)" : ""}`}
              viz="line"
              display={chart(days, "money", [
                { name: "CPC", values: days.map((d) => value(d, cpc)) },
              ])}
            />
            <Chart
              title="Alcance e cliques"
              viz="line"
              display={chart(days, "number", [
                {
                  name: "Alcance",
                  values: days.map((d) => value(d, (t) => t.reach)),
                },
                {
                  name: "Cliques",
                  values: days.map((d) => value(d, (t) => t.clicks)),
                },
              ])}
            />
            <Chart
              title="Frequência (impressões ÷ alcance)"
              viz="line"
              display={chart(days, "number", [
                {
                  name: "Frequência",
                  values: days.map((d) => value(d, frequency)),
                },
              ])}
            />
          </div>
          <p className="cell-note">
            Números até ontem. O alcance dos dias se soma (no acumulado do
            ciclo, na Linha do tempo, ele vem sem repetir pessoas).
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */

type Sub = "maso" | "diario" | "cliente";
function Timeline({
  campaign,
  cycles,
  cycle,
  metrics,
  today,
  withM,
  events,
  describeEvent,
  onEdit,
}: {
  campaign: AdCampaign;
  cycles: AdCycle[];
  cycle: AdCycle;
  metrics: CampaignMetrics;
  today: string;
  withM: boolean;
  events: AdCampaignEvent[] | null;
  describeEvent: (e: AdCampaignEvent) => string;
  onEdit: (target: EditTarget) => void;
}) {
  const [sub, setSub] = useUrlState<string>("linha", "maso");
  const active: Sub = sub === "diario" || sub === "cliente" ? sub : "maso";
  return (
    <div className="campaign-tab-body">
      <div
        className="drive-view campaign-subtabs"
        role="tablist"
        aria-label="Linha do tempo"
      >
        {(
          [
            ["maso", "MASO"],
            ["diario", "Dia a dia"],
            ["cliente", "Minha Máquina do cliente"],
          ] as [Sub, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active === id}
            className={`${active === id ? "selected" : ""} ${id}`}
            onClick={() => setSub(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {active === "maso" && (
        <SnapshotsTable
          cycle={cycle}
          metrics={metrics}
          today={today}
          withM={withM}
          events={(events ?? []).filter((e) => e.cycle_id === cycle.id)}
          describeEvent={describeEvent}
          onEdit={(row) => onEdit({ kind: "snapshot", row })}
        />
      )}
      {active === "diario" && (
        <DailyTable
          cycles={cycles}
          metrics={metrics}
          withM={withM}
          objective={cycle.objective}
          onEdit={(row) => onEdit({ kind: "daily", row })}
        />
      )}
      {active === "cliente" && (
        <ClientView
          campaign={campaign}
          cycles={cycles}
          cycle={cycle}
          metrics={metrics}
          today={today}
          withM={withM}
        />
      )}
    </div>
  );
}

function SnapshotsTable({
  cycle,
  metrics,
  today,
  withM,
  events,
  describeEvent,
  onEdit,
}: {
  cycle: AdCycle;
  metrics: CampaignMetrics;
  today: string;
  withM: boolean;
  events: AdCampaignEvent[];
  describeEvent: (e: AdCampaignEvent) => string;
  onEdit: (row: CycleSnapshot) => void;
}) {
  const funnel = cycle.objective === "sale" || cycle.objective === "custom";
  const m = withM ? cycle.multiplier : 1;
  type Row =
    | { kind: "snapshot"; at: string; s: CampaignMetrics["snapshots"][number] }
    | { kind: "event"; at: string; e: AdCampaignEvent };
  const rows: Row[] = [
    ...metrics.snapshots
      .filter((s) => s.cycle_id === cycle.id)
      .map((s) => ({
        kind: "snapshot" as const,
        at: `${s.taken_on}T23:59:59`,
        s,
      })),
    ...events.map((e) => ({ kind: "event" as const, at: e.created_at, e })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const columns = 13 + (funnel ? 3 : 0);
  const history = historicalGoal(metrics.snapshots, cycle);
  // The cycle's cumulative line (MASO: conversions and cost per result).
  const series = metrics.snapshots
    .filter((s) => s.cycle_id === cycle.id)
    .sort((a, b) => a.taken_on.localeCompare(b.taken_on));
  const days = series.map((s) => s.period_end);
  return (
    <>
      {history && (
        <div className="campaign-history-goal" role="note">
          <strong>Meta desta campanha (com base histórica)</strong>
          <span>
            Com base em {history.analyses} análises, a quantidade ideal de{" "}
            {objectives[cycle.objective].result} para este ciclo é de{" "}
            {n(history.quantity)}, a um custo médio de {money(history.cost * m)}{" "}
            — a meta atual pede {n(cycle.goal_results)}.
          </span>
        </div>
      )}
      {series.length > 1 && (
        <div className="campaign-charts">
          <Chart
            title="Resultados acumulados no ciclo"
            viz="line"
            display={chart(days, "number", [
              { name: "Resultados", values: series.map((s) => s.conversions) },
            ])}
          />
          <Chart
            title={`${costLabel[cycle.objective]} acumulado${withM ? " (com M)" : ""}`}
            viz="line"
            display={chart(days, "money", [
              {
                name: costLabel[cycle.objective],
                values: series.map((s) => {
                  const c = cpa(s);
                  return c === null ? null : c * m;
                }),
              },
            ])}
          />
        </div>
      )}
      {today > cycle.end_date && (
        <div className="campaign-alert danger" role="status">
          <CalendarClock size={18} />
          <span>
            <strong>Ciclo da campanha encerrado</strong> — terminou em{" "}
            {shortDate(cycle.end_date)}.
          </span>
        </div>
      )}
      {!rows.length ? (
        <p className="muted">
          Nenhum registro neste ciclo ainda. A sincronização diária grava um
          acumulado por dia.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="campaign-table campaign-timeline-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Ciclo do acompanhamento</th>
                <th>Conversões</th>
                <th>Investimento{withM ? " (com M)" : ""}</th>
                <th>{costLabel[cycle.objective]} do ciclo</th>
                <th>Impressões</th>
                <th>Alcance</th>
                <th>Cliques</th>
                {funnel && (
                  <>
                    <th>Vis. produto</th>
                    <th>Add. carrinho</th>
                    <th>Fin. compra</th>
                  </>
                )}
                <th>Taxa de conversão</th>
                <th>Frequência</th>
                <th>Status</th>
                <th>Por</th>
                <th aria-label="Editar" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) =>
                r.kind === "event" ? (
                  <tr key={`e${r.e.id}`} className="campaign-timeline-event">
                    <td>{shortDate(r.e.created_at)}</td>
                    <td colSpan={columns - 1}>
                      Alteração: {describeEvent(r.e)}
                    </td>
                  </tr>
                ) : (
                  <tr key={`s${r.s.id}`}>
                    <td>{shortDate(r.s.taken_on)}</td>
                    <td>
                      {shortDate(r.s.period_start)} a{" "}
                      {shortDate(r.s.period_end)}
                    </td>
                    <td>{d2(r.s.conversions)}</td>
                    <td>{money(r.s.spend * m)}</td>
                    <td>{brl(cpa(r.s) === null ? null : cpa(r.s)! * m)}</td>
                    <td>{n(r.s.impressions)}</td>
                    <td>{r.s.reach ? n(r.s.reach) : "—"}</td>
                    <td>{n(r.s.clicks)}</td>
                    {funnel && (
                      <>
                        <td>{n(r.s.view_content)}</td>
                        <td>{n(r.s.add_to_cart)}</td>
                        <td>{n(r.s.initiate_checkout)}</td>
                      </>
                    )}
                    <td>{pct(conversionRate(cycle.objective, r.s))}</td>
                    <td>{d2(frequency(r.s))}</td>
                    <td>
                      {r.s.goal_status ? (
                        <span
                          className={`campaign-chip ${r.s.goal_status === "good" ? "current" : "danger"}`}
                        >
                          {r.s.goal_status === "good" ? "Bom" : "Ruim"}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {/* A span: cell-note is display:block, which breaks a td. */}
                      <span className="campaign-by">
                        {r.s.author_label || "—"}
                        {r.s.source === "manual" && " · editado"}
                      </span>
                    </td>
                    <td>
                      <EditButton
                        label={`Editar o registro de ${shortDate(r.s.taken_on)}`}
                        onClick={() => onEdit(r.s)}
                      />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function DailyTable({
  cycles,
  metrics,
  withM,
  objective,
  onEdit,
}: {
  cycles: AdCycle[];
  metrics: CampaignMetrics;
  withM: boolean;
  objective: AdObjective;
  onEdit: (row: DailyMetric) => void;
}) {
  const funnel = objective === "sale" || objective === "custom";
  const live = useMemo(
    () => liveDeltas(metrics.snapshots),
    [metrics.snapshots],
  );
  const ordinal = new Map(cycles.map((y, i) => [y.id, i + 1]));
  const rows = [...metrics.daily].sort((a, b) => b.day.localeCompare(a.day));
  if (!rows.length)
    return <p className="muted">Nenhum registro diário ainda.</p>;
  const next = addDays(rows[0].day, 1);
  const cell = (
    r: DailyMetric,
    key: keyof Totals,
    format: (v: number) => string,
    factor = 1,
  ) => {
    // Reach isn't additive (the cumulative counts each person once), so a
    // day's reach never matches the difference of two cumulatives.
    const delta =
      key === "reach" ? undefined : live.get(`${r.cycle_id}:${r.day}`);
    return (
      <td>
        {format(r[key] * factor)}
        {delta && (
          <span
            className={`campaign-live ${diverges(r[key], delta[key]) ? "diverges" : ""}`}
            title={
              diverges(r[key], delta[key])
                ? "O acumulado da plataforma indica outro valor para este dia"
                : "Confere com o acumulado da plataforma"
            }
          >
            LIVE: {format(delta[key] * factor)}
          </span>
        )}
      </td>
    );
  };
  return (
    <div className="table-scroll">
      <table className="campaign-table campaign-daily-table">
        <thead>
          <tr>
            <th>Data</th>
            <th title="Índice de performance do dia">M</th>
            <th>Nº do ciclo</th>
            <th>Conversões</th>
            <th>Investimento{withM ? " (com M)" : ""}</th>
            <th>Impressões</th>
            <th>Alcance</th>
            <th>Cliques</th>
            {funnel && (
              <>
                <th>Vis. produto</th>
                <th>Add. carrinho</th>
                <th>Fin. compra</th>
              </>
            )}
            <th aria-label="Editar" />
          </tr>
        </thead>
        <tbody>
          <tr className="campaign-daily-next">
            <td colSpan={9 + (funnel ? 3 : 0)}>
              {dayLabel(next)} — O registro desta data ainda não está
              disponível.
            </td>
          </tr>
          {rows.map((r) => (
            <tr key={`${r.cycle_id}:${r.day}`}>
              <td>
                {shortDate(r.day)}
                {r.source === "maso" && (
                  <small className="cell-note">MASO</small>
                )}
                {r.source === "manual" && (
                  <small className="cell-note">Editado</small>
                )}
              </td>
              <td>{decimal.format(r.multiplier)}</td>
              <td>{ordinal.get(r.cycle_id) ?? "—"}º</td>
              {cell(r, "conversions", d2Number)}
              {cell(r, "spend", money, withM ? r.multiplier : 1)}
              {cell(r, "impressions", n)}
              {cell(r, "reach", n)}
              {cell(r, "clicks", n)}
              {funnel && (
                <>
                  {cell(r, "view_content", n)}
                  {cell(r, "add_to_cart", n)}
                  {cell(r, "initiate_checkout", n)}
                </>
              )}
              <td>
                <EditButton
                  label={`Editar o registro de ${shortDate(r.day)}`}
                  onClick={() => onEdit(r)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const d2Number = (v: number) => decimal.format(v);

/**
 * What the client sees in "Minha Máquina": always with M, the period against
 * the previous one of the same length. (The MASO embedded the report of an
 * external service; this rebuilds its indicators from the same numbers.)
 */
function ClientView({
  campaign,
  cycles,
  cycle,
  metrics,
  today,
  withM,
}: {
  campaign: AdCampaign;
  cycles: AdCycle[];
  cycle: AdCycle;
  metrics: CampaignMetrics;
  today: string;
  withM: boolean;
}) {
  const [period, setPeriod] = usePeriod(cycle, today);
  const factor = (r: DailyMetric) => (withM ? r.multiplier : 1);
  const length =
    period.from <= period.to ? dateRange(period.from, period.to).length : 0;
  const previous = {
    from: addDays(period.from, -length),
    to: addDays(period.from, -1),
  };
  const within = (p: Period) =>
    metrics.daily.filter((r) => r.day >= p.from && r.day <= p.to);
  const gross = (rows: DailyMetric[]) => ({
    ...sumDays(rows),
    spend: rows.reduce((s, r) => s + r.spend * factor(r), 0),
  });
  const now = gross(within(period));
  const before = gross(within(previous));
  const hasBefore = within(previous).length > 0;
  const days = length ? dateRange(period.from, period.to) : [];
  const byDay = new Map<string, DailyMetric[]>();
  for (const r of within(period))
    byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const result = objectives[cycle.objective].result;
  const card = (
    label: string,
    value: number | null,
    was: number | null,
    format: (v: number | null) => string,
    lowerIsBetter = false,
  ) => {
    const change =
      hasBefore && value !== null && was ? ((value - was) / was) * 100 : null;
    const good = change !== null && (lowerIsBetter ? change <= 0 : change >= 0);
    return (
      <div className="campaign-kpi">
        <dt>{label}</dt>
        <dd>{format(value)}</dd>
        {change !== null && (
          <small className={good ? "good-text" : "danger-text"}>
            {change >= 0 ? "▲" : "▼"} {decimal.format(Math.abs(change))}% contra{" "}
            {shortDate(previous.from)} a {shortDate(previous.to)}
          </small>
        )}
      </div>
    );
  };
  return (
    <>
      <p className="cell-note">
        Como o cliente vê a campanha {campaign.name} na Minha Máquina (
        {cycleDays(cycle)} dias de ciclo, M {decimal.format(cycle.multiplier)}
        ).{" "}
        {withM
          ? "Valores com M, como o cliente vê."
          : "Valores sem M agora: o cliente vê com M (ligue o M no topo)."}
      </p>
      <PeriodPicker
        cycle={cycle}
        today={today}
        value={period}
        onChange={setPeriod}
      />
      <dl className="campaign-kpi-grid">
        {card("Total investido", now.spend, before.spend, brl)}
        {card(`Total de ${result}`, now.conversions, before.conversions, d2)}
        {card(costLabel[cycle.objective], cpa(now), cpa(before), brl, true)}
        {card("Pessoas alcançadas", now.reach, before.reach, (v) =>
          v === null ? "—" : n(v),
        )}
        {card("Total de cliques", now.clicks, before.clicks, (v) =>
          v === null ? "—" : n(v),
        )}
        {card("Impressões", now.impressions, before.impressions, (v) =>
          v === null ? "—" : n(v),
        )}
        {card("CTR", ctr(now), ctr(before), pct)}
      </dl>
      <div className="campaign-charts">
        <Chart
          title={`Investimento por dia${withM ? " (com M)" : " (sem M)"}`}
          viz="bar"
          display={chart(days, "money", [
            {
              name: "Investimento",
              values: days.map((d) => {
                const list = byDay.get(d);
                return list
                  ? list.reduce((s, r) => s + r.spend * factor(r), 0)
                  : null;
              }),
            },
          ])}
        />
        <Chart
          title={`Resultados por dia (${result})`}
          viz="bar"
          display={chart(days, "number", [
            {
              name: "Resultados",
              values: days.map((d) => {
                const list = byDay.get(d);
                return list ? sumDays(list).conversions : null;
              }),
            },
          ])}
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Editing a record ("Editar registro" of the MASO)                     */

type EditTarget =
  | { kind: "daily"; row: DailyMetric }
  | { kind: "snapshot"; row: CycleSnapshot };

function EditButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className="icon-btn campaign-edit-record"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Pencil size={13} />
    </Button>
  );
}

const METRIC_FIELDS: {
  key: keyof MetricValues;
  label: string;
  whole?: boolean;
  funnel?: boolean;
}[] = [
  { key: "conversions", label: "Conversões" },
  { key: "spend", label: "Investimento (sem M)" },
  { key: "impressions", label: "Impressões", whole: true },
  { key: "reach", label: "Alcance", whole: true },
  { key: "clicks", label: "Cliques", whole: true },
  { key: "view_content", label: "Visualização de produto", funnel: true },
  { key: "add_to_cart", label: "Adição ao carrinho", funnel: true },
  { key: "initiate_checkout", label: "Finalização de compra", funnel: true },
];
/** 1234.5 → "1234,50"; whole numbers without separators ("12345"). */
const editText = (v: number, whole = false) =>
  whole ? String(Math.round(v)) : v.toFixed(2).replace(".", ",");
/** "1.234,50" or "1234.5" → 1234.5; whole numbers also take "12.345". */
const editNumber = (v: string, whole = false) =>
  whole ? parseAmount(v.replace(/[.\s]/g, "")) : parseAmount(v);

function RecordEditor({
  target,
  cycle,
  backend,
  onClose,
  onSaved,
}: {
  target: EditTarget;
  cycle: AdCycle;
  backend: MetricsBackend;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { row } = target;
  const funnel = cycle.objective === "sale" || cycle.objective === "custom";
  const fields = METRIC_FIELDS.filter(
    (f) => !f.funnel || funnel || row[f.key] > 0,
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      METRIC_FIELDS.map((f) => [f.key, editText(row[f.key], f.whole)]),
    ),
  );
  const [multiplier, setMultiplier] = useState(
    target.kind === "daily" ? editText(target.row.multiplier) : "",
  );
  const [end, setEnd] = useState(
    target.kind === "snapshot" ? target.row.period_end : "",
  );
  const [status, setStatus] = useState<"good" | "bad" | "auto">(
    target.kind === "snapshot" ? (target.row.goal_status ?? "auto") : "auto",
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const lastEnd =
    target.kind === "snapshot"
      ? [cycle.end_date, target.row.period_end].sort()[1]
      : "";
  const m = target.kind === "daily" ? editNumber(multiplier) : cycle.multiplier;
  const spend = editNumber(values.spend);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const metrics = {} as MetricValues;
    for (const f of METRIC_FIELDS) {
      const x = editNumber(values[f.key], f.whole);
      if (!Number.isFinite(x))
        return setError(
          `Informe um número em ${f.label.replace(/ \(.*\)$/, "")}.`,
        );
      metrics[f.key] = x;
    }
    setError("");
    setSaving(true);
    try {
      if (target.kind === "daily") {
        if (!Number.isFinite(m)) {
          setSaving(false);
          return setError("Informe o M do dia.");
        }
        await backend.updateDaily(target.row, { ...metrics, multiplier: m });
      } else
        await backend.updateSnapshot(target.row, {
          ...metrics,
          period_end: end,
          goal_status: status,
        });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  const title =
    target.kind === "daily"
      ? `Editar o registro diário de ${shortDate(target.row.day)}`
      : `Editar o registro de ${shortDate(target.row.taken_on)}`;
  return (
    <Modal title={title} onClose={() => !saving && onClose()} busy={saving}>
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          <p className="cell-note">
            {target.kind === "daily"
              ? "Os números do dia na plataforma."
              : `O acumulado do ciclo, de ${shortDate(target.row.period_start)} até a data final.`}{" "}
            Os valores em dinheiro são sem M. Depois de salvo, o registro passa
            a ser manual: a sincronização diária não o sobrescreve.
          </p>
          {target.kind === "snapshot" ? (
            <div className="form-columns">
              <label>
                Data final
                <Input
                  type="date"
                  value={end}
                  min={target.row.period_start}
                  max={lastEnd}
                  onChange={(e) => setEnd(e.target.value)}
                  required
                />
              </label>
              <label>
                Status
                <Select
                  value={status}
                  onValueChange={(v) => setStatus(v as typeof status)}
                  aria-label="Status"
                >
                  <SelectOption value="good">Bom</SelectOption>
                  <SelectOption value="bad">Ruim</SelectOption>
                  <SelectOption value="auto">
                    Pela meta do ciclo (recalcular)
                  </SelectOption>
                </Select>
              </label>
            </div>
          ) : (
            <label>
              M do dia (índice de performance)
              <Input
                inputMode="decimal"
                value={multiplier}
                onChange={(e) => setMultiplier(e.target.value)}
                required
              />
            </label>
          )}
          <div className="campaign-record-fields">
            {fields.map((f) => (
              <label key={f.key}>
                {f.label}
                <Input
                  inputMode={f.whole ? "numeric" : "decimal"}
                  value={values[f.key]}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                  required
                />
                {f.key === "spend" && Number.isFinite(spend) && (
                  <small>
                    Com M (× {Number.isFinite(m) ? decimal.format(m) : "—"}):{" "}
                    {Number.isFinite(m) ? money(spend * m) : "—"}
                  </small>
                )}
              </label>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </fieldset>
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={saving}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

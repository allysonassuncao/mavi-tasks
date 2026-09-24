import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { PanelChart } from "./DashboardCharts";
import type { Display, PanelSpec, Unit } from "./dashboards";
import { useUrlState } from "./router";
import {
  addDays,
  cycleDays,
  money,
  objectives,
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
  liveDeltas,
  sumDays,
  type CampaignMetrics,
  type DailyMetric,
  type MetricsBackend,
  type Totals,
} from "./campaign-metrics";

/**
 * The campaign's day to day (MASO: registro/analista/v6): the cycle's header
 * (media, goal, pace, score…), the "Dia a Dia" charts and the "Linha do
 * tempo" with the cycle's snapshots, the daily records (with the "LIVE"
 * check) and what the client sees. Values without M by default; the button
 * shows them with M (what the client contracted).
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
  metricsBackend,
  today,
  events,
  describeEvent,
  notify,
  cyclesTab,
}: {
  campaign: AdCampaign;
  /** Oldest first. */
  cycles: AdCycle[];
  current: AdCycle | null;
  company: string;
  metricsBackend: MetricsBackend;
  today: string;
  events: AdCampaignEvent[] | null;
  describeEvent: (e: AdCampaignEvent) => string;
  notify: (message: string) => void;
  cyclesTab: ReactNode;
}) {
  const [tab, setTab] = useUrlState<string>("aba", "dia");
  const [cycleId, setCycleId] = useUrlState<string>("ciclo", "");
  const [withM, setWithM] = useWithM();
  const [metrics, setMetrics] = useState<CampaignMetrics | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [syncing, setSyncing] = useState(false);
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
  }, [metricsBackend, company, campaign.id, tick]);

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
      {cycle && (
        <CycleHeader
          campaign={campaign}
          cycles={cycles}
          cycle={cycle}
          current={current}
          metrics={metrics}
          error={error}
          today={today}
          withM={withM}
          onWithM={setWithM}
          onCycle={setCycleId}
          syncing={syncing}
          onSync={() => void sync()}
        />
      )}
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
          />
        ) : null}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Header                                                              */

function CycleHeader({
  campaign,
  cycles,
  cycle,
  current,
  metrics,
  error,
  today,
  withM,
  onWithM,
  onCycle,
  syncing,
  onSync,
}: {
  campaign: AdCampaign;
  cycles: AdCycle[];
  cycle: AdCycle;
  current: AdCycle | null;
  metrics: CampaignMetrics | null;
  error: string;
  today: string;
  withM: boolean;
  onWithM: (v: boolean) => void;
  onCycle: (id: string) => void;
  syncing: boolean;
  onSync: () => void;
}) {
  const k = metrics
    ? cycleKpis(cycle, campaign.platform, metrics, today, withM)
    : null;
  const lastRun = metrics?.runs.find((r) => r.cycle_id === cycle.id);
  const running = cycle.start_date <= today && today <= cycle.end_date;
  const ordinal = cycles.findIndex((y) => y.id === cycle.id) + 1;
  const result = objectives[cycle.objective].result;
  return (
    <section className="panel campaign-kpis">
      <div className="campaign-kpis-top">
        <label className="campaign-cycle-pick">
          Ciclo
          <Select value={cycle.id} onValueChange={onCycle} aria-label="Ciclo">
            {[...cycles].reverse().map((y, i) => (
              <SelectOption key={y.id} value={y.id}>
                {cycles.length - i}º · {shortDate(y.start_date)} a{" "}
                {shortDate(y.end_date)}
                {y.id === current?.id ? " (ciclo atual)" : ""}
              </SelectOption>
            ))}
          </Select>
        </label>
        <label className="checkbox-label campaign-m-toggle">
          <Checkbox
            checked={withM}
            onCheckedChange={(v) => onWithM(v === true)}
          />
          <span>
            Valores com M
            <small className="cell-note">
              {withM
                ? `× ${decimal.format(cycle.multiplier)}: como o cliente contratou`
                : "Sem M: o que a plataforma gasta"}
            </small>
          </span>
        </label>
        <div className="campaign-sync">
          {searchablePlatform(campaign.platform) ? (
            <>
              <small
                className={`cell-note ${lastRun?.status === "error" ? "danger-text" : ""}`}
              >
                {lastRun
                  ? `${lastRun.status === "error" ? "Falhou" : "Sincronizado"} em ${new Date(
                      lastRun.created_at,
                    ).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}${lastRun.status === "error" ? `: ${lastRun.message}` : ""}`
                  : cycle.links.length
                    ? "Ainda não sincronizado"
                    : "Sem vínculos na plataforma: vincule contas no ciclo"}
              </small>
              <Button
                className="btn secondary"
                onClick={onSync}
                disabled={syncing || !cycle.links.length}
                title="Buscar agora os números na plataforma"
              >
                <RefreshCw
                  size={15}
                  className={syncing ? "campaign-spin" : ""}
                />{" "}
                {syncing ? "Sincronizando…" : "Sincronizar"}
              </Button>
            </>
          ) : (
            <small className="cell-note">
              Números automáticos só para Meta e Google Ads.
            </small>
          )}
        </div>
      </div>
      {error && !metrics && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {k?.overPace && running && (
        <div className="campaign-alert danger" role="status">
          <TriangleAlert size={18} />
          <span>
            Gastamos mais do que o esperado até ontem: {money(k.overPace.spent)}{" "}
            de {money(k.overPace.expected)} para {k.elapsed} de {k.days} dias.
          </span>
        </div>
      )}
      {!k ? (
        <Loading compact />
      ) : (
        <dl className="campaign-kpi-grid">
          <Kpi label="Status da meta">
            {k.status ? (
              <span
                className={`campaign-chip ${k.status === "good" ? "current" : "danger"}`}
              >
                {k.status === "good" ? "Bom" : "Ruim"}
              </span>
            ) : (
              <span className="campaign-chip muted">N/D</span>
            )}
          </Kpi>
          <Kpi
            label="Mídia total"
            hint={withM ? "Verba do ciclo (com M)" : "Verba do ciclo ÷ M"}
          >
            {money(k.budget)}
          </Kpi>
          <Kpi label="Mídia restante" hint={`Gasto: ${money(k.spent)}`}>
            {money(k.left)}
          </Kpi>
          <Kpi
            label="Meta"
            hint={
              k.goalCost === null
                ? "Sem meta"
                : `${money(k.goalCost)} por resultado`
            }
          >
            {k.goal ? `${n(k.goal)} ${result}` : "—"}
          </Kpi>
          <Kpi
            label="Conversões diárias ideais"
            hint={
              k.idealConversions
                ? `Em média ${n(k.idealConversions)} por dia para bater a meta`
                : k.goal
                  ? "Superamos a meta, parabéns!"
                  : undefined
            }
          >
            {n(k.idealConversions)}
          </Kpi>
          <Kpi
            label="Atual"
            hint={`${costLabel[cycle.objective]}: ${brl(k.cost)}`}
          >
            <span
              className={
                k.cost !== null && k.goalCost !== null
                  ? k.cost <= k.goalCost
                    ? "good-text"
                    : "danger-text"
                  : ""
              }
            >
              {d2(k.conversions)} {result}
            </span>
          </Kpi>
          <Kpi
            label="Orçamento diário"
            hint={`Restante ÷ ${k.remaining} ${k.remaining === 1 ? "dia" : "dias"}`}
          >
            {money(k.idealBudget)}
          </Kpi>
          <Kpi
            label="Taxa de melhoramento"
            hint="Custo por resultado de hoje contra o do início do ciclo"
          >
            {k.improvement === null ? (
              "—"
            ) : (
              <span
                className={k.improvement >= 0 ? "good-text" : "danger-text"}
              >
                {k.improvement >= 0 ? (
                  <ArrowDownRight size={14} />
                ) : (
                  <ArrowUpRight size={14} />
                )}{" "}
                {decimal.format(Math.abs(k.improvement))}%{" "}
                {k.improvement >= 0 ? "melhorou" : "piorou"}
              </span>
            )}
          </Kpi>
          <Kpi
            label="Dia da campanha"
            hint={`${ordinal}º ciclo · ${k.days} dias`}
          >
            D-{k.elapsed}
          </Kpi>
          <Kpi
            label="Score"
            hint="CTR, CPC, CPM e custo por resultado (0 a 100)"
          >
            {k.score === null ? "—" : decimal.format(k.score)}
          </Kpi>
          <Kpi label="Índice de performance (M)">
            {decimal.format(cycle.multiplier)}
          </Kpi>
        </dl>
      )}
    </section>
  );
}
function Kpi({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="campaign-kpi" title={hint}>
      <dt>{label}</dt>
      <dd>{children}</dd>
      {hint && <small className="cell-note">{hint}</small>}
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
  cycles,
  cycle,
  today,
  value,
  onChange,
}: {
  cycles: AdCycle[];
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
        {cycles.length > 1 && (
          <Select
            value=""
            aria-label="Período de outro ciclo"
            onValueChange={(id) => {
              const y = cycles.find((c) => c.id === id);
              if (y)
                onChange({
                  from: y.start_date,
                  to: [y.end_date, yesterday].sort()[0],
                });
            }}
          >
            <SelectOption value="">Nº ciclo</SelectOption>
            {cycles.map((y, i) => (
              <SelectOption key={y.id} value={y.id}>
                {i + 1}º ciclo ({shortDate(y.start_date)})
              </SelectOption>
            ))}
          </Select>
        )}
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
        cycles={cycles}
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
}: {
  campaign: AdCampaign;
  cycles: AdCycle[];
  cycle: AdCycle;
  metrics: CampaignMetrics;
  today: string;
  withM: boolean;
  events: AdCampaignEvent[] | null;
  describeEvent: (e: AdCampaignEvent) => string;
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
        />
      )}
      {active === "diario" && (
        <DailyTable
          cycles={cycles}
          metrics={metrics}
          withM={withM}
          objective={cycle.objective}
        />
      )}
      {active === "cliente" && (
        <ClientView
          campaign={campaign}
          cycles={cycles}
          cycle={cycle}
          metrics={metrics}
          today={today}
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
}: {
  cycle: AdCycle;
  metrics: CampaignMetrics;
  today: string;
  withM: boolean;
  events: AdCampaignEvent[];
  describeEvent: (e: AdCampaignEvent) => string;
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
  const columns = 11 + (funnel ? 3 : 0);
  return (
    <>
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
                    <td>
                      {shortDate(r.s.taken_on)}
                      <small className="cell-note">{r.s.author_label}</small>
                    </td>
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
}: {
  cycles: AdCycle[];
  metrics: CampaignMetrics;
  withM: boolean;
  objective: AdObjective;
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
          </tr>
        </thead>
        <tbody>
          <tr className="campaign-daily-next">
            <td colSpan={8 + (funnel ? 3 : 0)}>
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
}: {
  campaign: AdCampaign;
  cycles: AdCycle[];
  cycle: AdCycle;
  metrics: CampaignMetrics;
  today: string;
}) {
  const [period, setPeriod] = usePeriod(cycle, today);
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
    spend: rows.reduce((s, r) => s + r.spend * r.multiplier, 0),
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
        Como o cliente vê a campanha {campaign.name} na Minha Máquina: valores
        com M ({cycleDays(cycle)} dias de ciclo, M{" "}
        {decimal.format(cycle.multiplier)}).
      </p>
      <PeriodPicker
        cycles={cycles}
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
          title="Investimento por dia"
          viz="bar"
          display={chart(days, "money", [
            {
              name: "Investimento",
              values: days.map((d) => {
                const list = byDay.get(d);
                return list
                  ? list.reduce((s, r) => s + r.spend * r.multiplier, 0)
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

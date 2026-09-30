import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarRange,
  ExternalLink,
  GitCompareArrows,
  Image as ImageIcon,
  Play,
  Target,
} from "lucide-react";
import { Input, Select, SelectOption } from "./ui";
import { PanelChart } from "./DashboardCharts";
import type { Display, PanelSpec, Unit } from "./dashboards";
import { addDays, shortDate } from "./campaigns";
import {
  CHARTS,
  daysIn,
  deltaOf,
  lowerIsBetter,
  previousRange,
  rangeLabel,
  reachOf,
  formatMetric,
  goalOf,
  itemsIn,
  metricKind,
  metricLabel,
  metricValue,
  resultName,
  totalsOf,
  type PublicConfig,
  type ReportChart,
  type ReportView,
} from "./campaign-reports";
import "./campaign-reports.css";

/**
 * A campaign report, as the client sees it (the public link) and as the
 * agency previews it: the period (narrowed inside the report's, when
 * allowed), the chosen numbers, the goal, the charts, the analysis and the
 * ads with their creative. The numbers already come with or without M.
 * With a second period (saved, or chosen inside what the report keeps), the
 * numbers show the change and the charts draw both periods day by day.
 */
export function CampaignReportView({
  company,
  title,
  view,
  config,
  analysis,
  periodStart,
  periodEnd,
  compareStart = null,
  compareEnd = null,
  analysisSlot,
  topSlot,
}: {
  company?: string;
  title: string;
  view: ReportView;
  config: PublicConfig;
  analysis: string;
  periodStart: string;
  periodEnd: string;
  /** The comparison period saved with the report. */
  compareStart?: string | null;
  compareEnd?: string | null;
  /** Inside the MAVI: the analysis with its editor. */
  analysisSlot?: ReactNode;
  topSlot?: ReactNode;
}) {
  const [range, setRange] = useState({ from: periodStart, to: periodEnd });
  const whole = range.from === periodStart && range.to === periodEnd;
  const days = useMemo(() => daysIn(view, range.from, range.to), [view, range]);
  const t = useMemo(() => totalsOf(days), [days]);
  const saved = { start: periodStart, end: periodEnd, compareStart, compareEnd };
  const reach = reachOf(view, range, saved);
  // The comparison: the saved period, the one right before, or chosen
  // dates, always inside the days the report keeps.
  const first = compareStart && compareStart < periodStart ? compareStart : periodStart;
  const last = compareEnd && compareEnd > periodEnd ? compareEnd : periodEnd;
  const [cmpMode, setCmpMode] = useState<"none" | "saved" | "previous" | "custom">(
    compareStart ? "saved" : "none",
  );
  const [cmpCustom, setCmpCustom] = useState(() =>
    compareStart && compareEnd
      ? { from: compareStart, to: compareEnd }
      : previousRange(periodStart, periodEnd).from >= first
        ? previousRange(periodStart, periodEnd)
        : { from: first, to: periodStart },
  );
  const previous = previousRange(range.from, range.to);
  const hasPrevious = previous.from >= first;
  const cmp =
    cmpMode === "saved" && compareStart && compareEnd
      ? { from: compareStart, to: compareEnd }
      : cmpMode === "previous" && hasPrevious
        ? previous
        : cmpMode === "custom"
          ? cmpCustom
          : null;
  const cmpDays = useMemo(
    () => (cmp ? daysIn(view, cmp.from, cmp.to) : []),
    // The range is a new object each render: its dates are the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, cmp?.from, cmp?.to],
  );
  const c = useMemo(() => totalsOf(cmpDays), [cmpDays]);
  const cmpReach = cmp ? reachOf(view, cmp, saved) : null;
  // The client chooses the comparison when the report lets them narrow the
  // period; otherwise the saved one (if any) is fixed.
  const canCompare = config.allow_filter;
  const goal = config.sections.goal ? goalOf(view) : null;
  const currency = view.currency || "BRL";
  const result = resultName(view);
  const ads = useMemo(
    () => itemsIn(view.ads, range.from, range.to, view.ad_results),
    [view.ads, view.ad_results, range],
  );
  const adsets = useMemo(
    () => itemsIn(view.adsets, range.from, range.to, view.ad_results),
    [view.adsets, view.ad_results, range],
  );
  const google = view.platform === "google";
  const keywords = useMemo(
    () => itemsIn(view.keywords, range.from, range.to, view.ad_results),
    [view.keywords, view.ad_results, range],
  );
  const terms = useMemo(
    () => itemsIn(view.search_terms, range.from, range.to, view.ad_results),
    [view.search_terms, view.ad_results, range],
  );
  const presets = useMemo(() => {
    const list: { label: string; from: string; to: string }[] = [
      { label: "Período todo", from: periodStart, to: periodEnd },
    ];
    if (view.cycles.length > 1)
      for (const c of view.cycles)
        list.push({
          label: `Ciclo ${shortDate(c.start_date).slice(0, 5)} a ${shortDate(c.end_date).slice(0, 5)}`,
          from: c.start_date < periodStart ? periodStart : c.start_date,
          to: c.end_date > periodEnd ? periodEnd : c.end_date,
        });
    const span = Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000) + 1;
    if (span > 7) list.push({ label: "Últimos 7 dias", from: addDays(periodEnd, -6), to: periodEnd });
    if (span > 15) list.push({ label: "Últimos 15 dias", from: addDays(periodEnd, -14), to: periodEnd });
    return list;
  }, [view.cycles, periodStart, periodEnd]);

  const metrics = config.metrics.filter(
    (id) => !(id === "reach" || id === "frequency") || view.reach !== null,
  );
  const charts = config.charts.filter(
    (c) =>
      (c !== "cumulative" || goal || days.length > 1) &&
      (c !== "ads" || (config.sections.ads && view.ad_results && ads.length > 0)) &&
      (c !== "funnel" || t.view_content + t.add_to_cart + t.initiate_checkout > 0),
  );
  const shownAds = ads.slice(0, config.ads_limit || 10);
  const text = analysis.trim();

  return (
    <article className="creport">
      <header className="creport-head">
        <div>
          {company && <span className="creport-company">{company}</span>}
          <h1>{title}</h1>
          <p className="creport-sub">
            {[view.client_name, view.product_name].filter(Boolean).join(" · ")}
            {" · "}
            {shortDate(periodStart)} a {shortDate(periodEnd)}
            {compareStart && compareEnd && (
              <> · comparado com {shortDate(compareStart)} a {shortDate(compareEnd)}</>
            )}
          </p>
        </div>
        {topSlot}
      </header>

      {config.allow_filter && (
        <section className="creport-filter" aria-label="Período">
          <CalendarRange size={16} aria-hidden="true" />
          <div className="creport-chips">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={range.from === p.from && range.to === p.to ? "selected" : ""}
                onClick={() => setRange({ from: p.from, to: p.to })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <span className="creport-dates">
            <Input
              type="date"
              aria-label="De"
              value={range.from}
              min={periodStart}
              max={range.to}
              onChange={(e) =>
                e.target.value &&
                setRange((r) => ({ ...r, from: e.target.value < periodStart ? periodStart : e.target.value }))
              }
            />
            <span>a</span>
            <Input
              type="date"
              aria-label="Até"
              value={range.to}
              min={range.from}
              max={periodEnd}
              onChange={(e) =>
                e.target.value &&
                setRange((r) => ({ ...r, to: e.target.value > periodEnd ? periodEnd : e.target.value }))
              }
            />
          </span>
        </section>
      )}

      {canCompare ? (
        <section className="creport-filter creport-compare" aria-label="Comparação">
          <GitCompareArrows size={16} aria-hidden="true" />
          <span className="creport-compare-label">Comparar com</span>
          <Select
            aria-label="Comparar com"
            value={cmpMode === "previous" && !hasPrevious ? "none" : cmpMode}
            onValueChange={(v) => setCmpMode(v as typeof cmpMode)}
          >
            <SelectOption value="none">Sem comparação</SelectOption>
            {compareStart && compareEnd ? (
              <SelectOption value="saved">
                {`Período de comparação (${rangeLabel({ from: compareStart, to: compareEnd })})`}
              </SelectOption>
            ) : null}
            {hasPrevious ? (
              <SelectOption value="previous">
                {`Período anterior (${rangeLabel(previous)})`}
              </SelectOption>
            ) : null}
            <SelectOption value="custom">Outras datas</SelectOption>
          </Select>
          {cmpMode === "custom" && (
            <span className="creport-dates">
              <Input
                type="date"
                aria-label="Comparar de"
                value={cmpCustom.from}
                min={first}
                max={cmpCustom.to}
                onChange={(e) =>
                  e.target.value &&
                  setCmpCustom((r) => ({ ...r, from: e.target.value < first ? first : e.target.value }))
                }
              />
              <span>a</span>
              <Input
                type="date"
                aria-label="Comparar até"
                value={cmpCustom.to}
                min={cmpCustom.from}
                max={last}
                onChange={(e) =>
                  e.target.value &&
                  setCmpCustom((r) => ({ ...r, to: e.target.value > last ? last : e.target.value }))
                }
              />
            </span>
          )}
          {cmp && (
            <small className="creport-compare-note">
              {rangeLabel(range)} contra {rangeLabel(cmp)}
            </small>
          )}
        </section>
      ) : cmp ? (
        <p className="creport-compare-note">
          <GitCompareArrows size={14} aria-hidden="true" /> Comparando {rangeLabel(range)} com{" "}
          {rangeLabel(cmp)}
        </p>
      ) : null}

      {metrics.length > 0 && (
        <section className="creport-kpis" aria-label="Números do período">
          {metrics.map((id) => {
            const value = metricValue(id, t, reach);
            const before = cmp ? metricValue(id, c, cmpReach) : null;
            const delta = cmp ? deltaOf(value, before) : null;
            // Spending more is neither good nor bad by itself.
            const good =
              delta === null || id === "spend" ? null : lowerIsBetter(id) ? delta < 0 : delta > 0;
            return (
              <div
                key={id}
                className={`creport-kpi ${id === "results" ? "main" : ""}`}
                title={
                  (id === "reach" || id === "frequency") && !whole
                    ? "O alcance só é exato para o período todo do relatório."
                    : undefined
                }
              >
                <span>{metricLabel(id, view)}</span>
                <strong>{formatMetric(metricKind(id), value, currency)}</strong>
                {(id === "reach" || id === "frequency") && reach === null && (
                  <small>Só no período todo</small>
                )}
                {cmp && !(value === null && before === null) && (
                  <small
                    className={`creport-delta ${
                      delta === null || good === null || Math.abs(delta) < 0.05 ? "" : good ? "good" : "bad"
                    }`}
                    title={`No período comparado: ${formatMetric(metricKind(id), before, currency)}`}
                  >
                    {delta !== null && Math.abs(delta) >= 0.05 ? (
                      delta > 0 ? (
                        <ArrowUpRight size={13} aria-hidden="true" />
                      ) : (
                        <ArrowDownRight size={13} aria-hidden="true" />
                      )
                    ) : null}
                    {delta === null
                      ? "Sem base para comparar"
                      : `${delta > 0 ? "+" : ""}${delta.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}
                    {before !== null && (
                      <span> vs {formatMetric(metricKind(id), before, currency)}</span>
                    )}
                  </small>
                )}
              </div>
            );
          })}
        </section>
      )}

      {goal && (
        <section className="creport-goal" aria-label="Meta">
          <Target size={18} aria-hidden="true" />
          <div className="creport-goal-bars">
            <GoalBar
              label={`${result}: ${formatMetric("count", t.conversions)} de ${formatMetric("count", goal.results)}`}
              value={goal.results ? t.conversions / goal.results : 0}
            />
            {goal.budget > 0 && (
              <GoalBar
                label={`Investimento: ${formatMetric("money", t.spend, currency)} de ${formatMetric("money", goal.budget, currency)}`}
                value={t.spend / goal.budget}
                muted
              />
            )}
          </div>
          <small>
            Meta {view.cycles.length > 1 ? "dos ciclos" : "do ciclo"} no período
            {goal.single
              ? ` (${shortDate(goal.single.start_date)} a ${shortDate(goal.single.end_date)})`
              : ""}
          </small>
        </section>
      )}

      {charts.length > 0 && days.length > 0 && (
        <section className="creport-charts">
          {charts.map((c) => (
            <ReportChartView
              key={c}
              id={c}
              view={view}
              days={days}
              currency={currency}
              goalResults={goal?.results ?? null}
              ads={ads}
              result={result}
              compare={cmp ? cmpDays : null}
            />
          ))}
        </section>
      )}

      {(analysisSlot || (config.sections.analysis && text)) && (
        <section className="creport-analysis">
          <h2>Análise do período</h2>
          {analysisSlot ?? <AnalysisText text={text} />}
        </section>
      )}

      {config.sections.ads && shownAds.length > 0 && (
        <section className="creport-ads">
          <h2>
            Anúncios que mais {view.ad_results ? "trouxeram resultado" : "investiram"}
          </h2>
          <div className="creport-ad-grid">
            {shownAds.map((a) => (
              <figure key={a.item.id} className="creport-ad">
                {google && !a.item.thumb ? (
                  <div className="creport-gad" aria-label="Anúncio no Google">
                    <span className="creport-gad-sponsor">Patrocinado</span>
                    {a.item.link && <span className="creport-gad-site">{siteOf(a.item.link)}</span>}
                    <span className="creport-gad-title">{a.item.title || a.item.name}</span>
                    {a.item.body && <span className="creport-gad-text">{a.item.body}</span>}
                  </div>
                ) : (
                <div className="creport-ad-media">
                  {a.item.thumb ? (
                    <img src={a.item.thumb} alt={`Criativo do anúncio ${a.item.name}`} loading="lazy" />
                  ) : (
                    <ImageIcon size={28} aria-hidden="true" />
                  )}
                  {a.item.video && (
                    <span className="creport-ad-video" aria-label="Vídeo">
                      <Play size={14} />
                    </span>
                  )}
                </div>
                )}
                <figcaption>
                  {!(google && !a.item.thumb) && <strong title={a.item.name}>{a.item.name}</strong>}
                  {(a.item.adset || a.item.kind) && (
                    <small>{[a.item.kind, a.item.adset].filter(Boolean).join(" · ")}</small>
                  )}
                  <dl>
                    {view.ad_results && (
                      <>
                        <div>
                          <dt>{result}</dt>
                          <dd>{formatMetric("count", a.results)}</dd>
                        </div>
                        <div>
                          <dt>Custo</dt>
                          <dd>{formatMetric("money", a.results ? a.spend / a.results : null, currency)}</dd>
                        </div>
                      </>
                    )}
                    <div>
                      <dt>Investimento</dt>
                      <dd>{formatMetric("money", a.spend, currency)}</dd>
                    </div>
                    <div>
                      <dt>CTR</dt>
                      <dd>
                        {formatMetric("percent", a.impressions ? (a.clicks / a.impressions) * 100 : null)}
                      </dd>
                    </div>
                  </dl>
                  {a.item.body && !(google && !a.item.thumb) && <p className="creport-ad-body">{a.item.body}</p>}
                  {a.item.link && /^https:\/\//.test(a.item.link) && (
                    <a href={a.item.link} target="_blank" rel="noreferrer">
                      {google ? "Ver a página" : "Ver a publicação"} <ExternalLink size={12} />
                    </a>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      {config.sections.adsets && adsets.length > 0 && (
        <ItemTable
          title={google ? "Grupos de anúncios" : "Conjuntos de anúncios"}
          heading={google ? "Grupo de anúncios" : "Conjunto"}
          items={adsets}
          view={view}
          result={result}
          currency={currency}
        />
      )}
      {config.sections.keywords && keywords.length > 0 && (
        <ItemTable
          title="Palavras-chave"
          heading="Palavra-chave"
          items={keywords.slice(0, 30)}
          view={view}
          result={result}
          currency={currency}
          detail
        />
      )}
      {config.sections.search_terms && terms.length > 0 && (
        <ItemTable
          title="Termos de pesquisa"
          heading="Termo pesquisado"
          items={terms.slice(0, 30)}
          view={view}
          result={result}
          currency={currency}
          detail
        />
      )}

      {!days.length && (
        <p className="creport-empty">Sem números nos dias escolhidos.</p>
      )}
      <footer className="creport-foot">
        Números registrados em{" "}
        {new Date(view.captured_at).toLocaleDateString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })}
        . O relatório não muda depois de criado.
      </footer>
    </article>
  );
}

const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Ad sets / ad groups, keywords, search terms: a table of the period. */
function ItemTable({
  title,
  heading,
  items,
  view,
  result,
  currency,
  detail = false,
}: {
  title: string;
  heading: string;
  items: ReturnType<typeof itemsIn>;
  view: ReportView;
  result: string;
  currency: string;
  /** Under the name: the match type and the ad group. */
  detail?: boolean;
}) {
  return (
    <section className="creport-adsets">
      <h2>{title}</h2>
      <div className="creport-table-wrap">
        <table>
          <thead>
            <tr>
              <th>{heading}</th>
              {view.ad_results && <th className="num">{result}</th>}
              {view.ad_results && <th className="num">Custo por resultado</th>}
              <th className="num">Investimento</th>
              <th className="num">Impressões</th>
              <th className="num">Cliques</th>
              <th className="num">CTR</th>
              <th className="num">CPC</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.item.id}>
                <td>
                  {s.item.name}
                  {detail && (s.item.kind || s.item.adset) && (
                    <small className="creport-item-sub">
                      {[s.item.kind, s.item.adset].filter(Boolean).join(" · ")}
                    </small>
                  )}
                </td>
                {view.ad_results && <td className="num">{formatMetric("count", s.results)}</td>}
                {view.ad_results && (
                  <td className="num">
                    {formatMetric("money", s.results ? s.spend / s.results : null, currency)}
                  </td>
                )}
                <td className="num">{formatMetric("money", s.spend, currency)}</td>
                <td className="num">{formatMetric("count", s.impressions)}</td>
                <td className="num">{formatMetric("count", s.clicks)}</td>
                <td className="num">
                  {formatMetric("percent", s.impressions ? (s.clicks / s.impressions) * 100 : null)}
                </td>
                <td className="num">{formatMetric("money", s.clicks ? s.spend / s.clicks : null, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GoalBar({ label, value, muted = false }: { label: string; value: number; muted?: boolean }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className={`creport-bar ${muted ? "muted" : ""}`}>
      <span>
        {label} <b>({Math.round(value * 100)}%)</b>
      </span>
      <i>
        <em style={{ width: `${pct * 100}%` }} />
      </i>
    </div>
  );
}

/** The analysis: paragraphs, "- " lists and **bold**, nothing else. */
export function AnalysisText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const bold = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
    );
  const flush = () => {
    if (list.length)
      blocks.push(
        <ul key={blocks.length}>
          {list.map((l, i) => (
            <li key={i}>{bold(l)}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^[-•*]\s+/.test(line)) {
      list.push(line.replace(/^[-•*]\s+/, ""));
      continue;
    }
    flush();
    if (line) blocks.push(<p key={blocks.length}>{bold(line)}</p>);
  }
  flush();
  return <div className="creport-text">{blocks}</div>;
}

const COLORS = ["#2f6fdb", "#8fbf5a", "#d09b61", "#a879c9"];
function ReportChartView({
  id,
  view,
  days,
  currency,
  goalResults,
  ads,
  result,
  compare,
}: {
  id: ReportChart;
  view: ReportView;
  days: ReportView["days"];
  currency: string;
  goalResults: number | null;
  ads: ReturnType<typeof itemsIn>;
  result: string;
  /** The comparison's days, drawn day by day under the period's. */
  compare: ReportView["days"] | null;
}) {
  void view;
  void currency;
  const label = (CHARTS.find((c) => c.id === id)?.label ?? "").replace(
    "Resultados",
    result,
  );
  const keys = days.map((d) => d.day);
  const labels = keys.map((d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`);
  // The comparison's n-th day under the period's n-th day.
  const cmpValues = (pick: (d: ReportView["days"][number]) => number | null) =>
    compare ? keys.map((_, i) => (compare[i] ? pick(compare[i]) : null)) : null;
  const time = (
    unit: Unit,
    series: { name: string; values: (number | null)[] }[],
    viz: "bar" | "line",
    pick?: (d: ReportView["days"][number]) => number | null,
  ) => {
    const other = pick ? cmpValues(pick) : null;
    if (other) series = [...series, { name: "Período comparado", values: other }];
    return (
    <Chart
      title={label}
      viz={viz}
      display={{
        keys,
        labels,
        series: series.map((s, i) => ({
          id: String(i),
          name: s.name,
          color: COLORS[i % COLORS.length],
          unit,
          values: s.values,
        })),
        unit,
        interval: "day",
      }}
    />
    );
  };
  switch (id) {
    case "results":
      return time("number", [{ name: result, values: days.map((d) => d.conversions) }], "bar", (d) => d.conversions);
    case "spend":
      return time("money", [{ name: "Investimento", values: days.map((d) => d.spend) }], "bar", (d) => d.spend);
    case "cpa":
      return time(
        "money",
        [
          {
            name: "Custo por resultado",
            values: days.map((d) => (d.conversions ? d.spend / d.conversions : null)),
          },
        ],
        "line",
        (d) => (d.conversions ? d.spend / d.conversions : null),
      );
    case "impressions":
      return time("number", [{ name: "Impressões", values: days.map((d) => d.impressions) }], "bar", (d) => d.impressions);
    case "clicks":
      return time("number", [{ name: "Cliques no link", values: days.map((d) => d.clicks) }], "bar", (d) => d.clicks);
    case "ctr":
      return time(
        "percent",
        [
          {
            name: "CTR",
            values: days.map((d) => (d.impressions ? (d.clicks / d.impressions) * 100 : null)),
          },
        ],
        "line",
        (d) => (d.impressions ? (d.clicks / d.impressions) * 100 : null),
      );
    case "cumulative": {
      let sum = 0;
      const acc = days.map((d) => (sum += d.conversions));
      let before = 0;
      const accBefore = compare
        ? keys.map((_, i) => (compare[i] ? (before += compare[i].conversions) : null))
        : null;
      // The goal spread evenly over the days shown.
      const pace = goalResults
        ? days.map((_, i) => Math.round((goalResults * (i + 1)) / days.length))
        : null;
      return time(
        "number",
        [
          { name: `${result} acumulados`, values: acc },
          ...(pace && !accBefore ? [{ name: "Ritmo da meta", values: pace }] : []),
          ...(accBefore ? [{ name: "Período comparado", values: accBefore }] : []),
        ],
        "line",
      );
    }
    case "funnel": {
      const t = totalsOf(days);
      const steps: [string, number][] = [
        ["Cliques no link", t.clicks],
        ["Visualizações da página", t.view_content],
        ["Adições ao carrinho", t.add_to_cart],
        ["Finalizações de compra", t.initiate_checkout],
        [result, t.conversions],
      ];
      return (
        <Chart
          title={label}
          viz="hbar"
          display={{
            keys: steps.map(([k]) => k),
            labels: steps.map(([k]) => k),
            series: [{ id: "0", name: "Funil", color: COLORS[0], unit: "number", values: steps.map(([, v]) => v) }],
            unit: "number",
            interval: "day",
          }}
        />
      );
    }
    case "ads": {
      const top = ads.slice(0, 8);
      return (
        <Chart
          title={label}
          viz="hbar"
          display={{
            keys: top.map((a) => a.item.id),
            labels: top.map((a) => a.item.name),
            series: [{ id: "0", name: result, color: COLORS[1], unit: "number", values: top.map((a) => a.results) }],
            unit: "number",
            interval: "day",
          }}
        />
      );
    }
    default:
      return null;
  }
}

function Chart({
  title,
  display,
  viz,
}: {
  title: string;
  display: Display;
  viz: "bar" | "line" | "hbar";
}) {
  const spec: PanelSpec = {
    viz,
    groupBy: viz === "hbar" ? "client" : "time",
    queries: [],
    unit: display.unit,
  };
  return (
    <figure className="creport-chart">
      <figcaption>{title}</figcaption>
      <div className="creport-chart-body">
        <PanelChart display={display} spec={spec} />
      </div>
    </figure>
  );
}

import { rpc } from "./api";
import { driveServer } from "./drive";
import {
  addDays,
  adsServer,
  objectives,
  type AdCycle,
  type AdObjective,
} from "./campaigns";
import type { MetricsBackend } from "./campaign-metrics";

/**
 * Campanhas › Relatórios (migration 20270113090000_campaign_reports): a
 * report is a photo of a period of the campaign, kept for later, that can
 * have a public link (/relatorio/<token>) for the client. Who creates it
 * chooses what it shows: the numbers, the charts, the ads with their
 * creative, the MAVI's analysis, the cycle's goal, with or without M and
 * whether the client may narrow the period. The database hands the numbers
 * already with or without M (never the M itself).
 */

export type ReportMetric =
  | "spend"
  | "results"
  | "cpa"
  | "impressions"
  | "reach"
  | "frequency"
  | "clicks"
  | "ctr"
  | "cpc"
  | "cpm"
  | "conversion_rate"
  | "view_content"
  | "add_to_cart"
  | "initiate_checkout";
export type ReportChart =
  | "results"
  | "spend"
  | "cpa"
  | "cumulative"
  | "impressions"
  | "clicks"
  | "ctr"
  | "funnel"
  | "ads";
export type ReportConfig = {
  with_m: boolean;
  metrics: ReportMetric[];
  charts: ReportChart[];
  sections: {
    ads: boolean;
    adsets: boolean;
    analysis: boolean;
    goal: boolean;
    /** Google: the keywords and the search terms. */
    keywords?: boolean;
    search_terms?: boolean;
  };
  /** How many ads with their creative (the ones that spent the most). */
  ads_limit: number;
  /** The client may narrow the period inside the report's. */
  allow_filter: boolean;
};
export type PublicConfig = Omit<ReportConfig, "with_m">;

export type ReportDay = {
  day: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  view_content: number;
  add_to_cart: number;
  initiate_checkout: number;
};
/** An ad's or ad set's day: spend, impressions, link clicks, results. */
export type ItemDay = { d: string; s: number; i: number; c: number; r: number };
export type ReportItem = {
  id: string;
  name: string;
  adset?: string;
  campaign?: string;
  reach?: number;
  thumb?: string;
  title?: string;
  body?: string;
  /** Google: the ad type, or the keyword's match type. */
  kind?: string;
  link?: string;
  video?: boolean;
  days: ItemDay[];
};
export type ReportCycle = {
  start_date: string;
  end_date: string;
  objective: AdObjective;
  destination: string;
  goal_results?: number;
  budget?: number;
};
export type ReportView = {
  platform: string;
  campaign_name: string;
  client_name: string | null;
  product_name: string | null;
  captured_at: string;
  currency: string;
  days: ReportDay[];
  cycles: ReportCycle[];
  /** The period's deduplicated reach (Meta), when read. */
  reach: number | null;
  /** The comparison period's reach (Meta), when there is one. */
  compare_reach?: number | null;
  /** False: the results come from the Make pages, not per ad. */
  ad_results: boolean;
  ads?: ReportItem[];
  adsets?: ReportItem[];
  /** Google. */
  keywords?: ReportItem[];
  search_terms?: ReportItem[];
  meta_error?: string | null;
};
export type ReportLink = {
  token: string;
  expires_at: string | null;
  expired: boolean;
  has_password: boolean;
};
export type CampaignReport = {
  id: string;
  campaign_id: string;
  title: string;
  period_start: string;
  period_end: string;
  /** The saved comparison period (both or neither). */
  compare_start: string | null;
  compare_end: string | null;
  config: ReportConfig;
  analysis: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  link: ReportLink | null;
  can_manage: boolean;
  view: ReportView | null;
};
export type PublicReport =
  | {
      status: "ok";
      company: string;
      title: string;
      period_start: string;
      period_end: string;
      compare_start: string | null;
      compare_end: string | null;
      expires_at: string | null;
      config: PublicConfig;
      analysis: string;
      view: ReportView;
    }
  | { status: "expired" | "password" | "wrong" | "locked" };

export type ReportInput = {
  campaign: string;
  title: string;
  start: string;
  end: string;
  config: ReportConfig;
  analysis?: string;
  link: boolean;
  expires_at?: string | null;
  password?: string | null;
  /** The campaign's platform (where the ads are read from). */
  provider?: "meta" | "google";
  compare_start?: string | null;
  compare_end?: string | null;
};
export type AnalysisInput = {
  campaign: string;
  title: string;
  period: string;
  client: string;
  focus?: string;
  numbers: unknown;
};

export interface ReportsBackend {
  list(company: string, campaign: string): Promise<CampaignReport[]>;
  get(id: string): Promise<CampaignReport>;
  create(company: string, input: ReportInput): Promise<CampaignReport>;
  update(
    id: string,
    title: string,
    config: ReportConfig,
    analysis: string,
  ): Promise<CampaignReport>;
  setLink(
    id: string,
    enabled: boolean,
    expiresAt: string | null,
    password: string | null,
    keepPassword: boolean,
  ): Promise<CampaignReport>;
  remove(id: string): Promise<void>;
  /** The MAVI's analysis (not saved: the report's author decides). */
  writeAnalysis(company: string, input: AnalysisInput): Promise<string>;
}

// ------------------------------------------------------------ choices
export const METRICS: { id: ReportMetric; label: string; hint?: string }[] = [
  { id: "spend", label: "Investimento" },
  { id: "results", label: "Resultados" },
  { id: "cpa", label: "Custo por resultado" },
  { id: "impressions", label: "Impressões" },
  {
    id: "reach",
    label: "Alcance",
    hint: "Pessoas diferentes que viram os anúncios no período inteiro do relatório.",
  },
  { id: "frequency", label: "Frequência" },
  { id: "clicks", label: "Cliques no link" },
  { id: "ctr", label: "CTR (taxa de cliques)" },
  { id: "cpc", label: "CPC (custo por clique)" },
  { id: "cpm", label: "CPM (custo por mil impressões)" },
  { id: "conversion_rate", label: "Taxa de conversão" },
  { id: "view_content", label: "Visualizações da página" },
  { id: "add_to_cart", label: "Adições ao carrinho" },
  { id: "initiate_checkout", label: "Finalizações de compra" },
];
export const CHARTS: { id: ReportChart; label: string }[] = [
  { id: "results", label: "Resultados por dia" },
  { id: "spend", label: "Investimento por dia" },
  { id: "cpa", label: "Custo por resultado por dia" },
  { id: "cumulative", label: "Resultados acumulados (com a meta)" },
  { id: "impressions", label: "Impressões por dia" },
  { id: "clicks", label: "Cliques no link por dia" },
  { id: "ctr", label: "CTR por dia" },
  { id: "funnel", label: "Funil de vendas" },
  { id: "ads", label: "Resultados por anúncio" },
];
export function defaultConfig(
  objective: AdObjective | null,
  platform: string = "meta",
): ReportConfig {
  const google = platform === "google";
  const sale = objective === "sale" || objective === "custom";
  return {
    with_m: true,
    metrics: [
      "spend",
      "results",
      "cpa",
      "impressions",
      ...(google ? [] : (["reach"] as const)),
      "clicks",
      "ctr",
      ...(google ? (["cpc"] as const) : []),
      ...(sale ? (["view_content", "add_to_cart", "initiate_checkout"] as const) : []),
    ],
    charts: ["results", "spend", "cpa", "cumulative", ...(sale ? (["funnel"] as const) : []), "ads"],
    sections: google
      ? { ads: true, adsets: true, analysis: true, goal: true, keywords: true, search_terms: true }
      : { ads: true, adsets: false, analysis: true, goal: true },
    ads_limit: 10,
    allow_filter: true,
  };
}
/** A config read from the database, with what is missing filled in. */
export function configFrom(raw: Partial<ReportConfig> | null | undefined): ReportConfig {
  const base = defaultConfig(null);
  const known = <T extends string>(list: unknown, allowed: { id: T }[]) =>
    Array.isArray(list)
      ? list.filter((x): x is T => allowed.some((a) => a.id === x))
      : null;
  return {
    with_m: raw?.with_m ?? base.with_m,
    metrics: known(raw?.metrics, METRICS) ?? base.metrics,
    charts: known(raw?.charts, CHARTS) ?? base.charts,
    sections: { ...base.sections, ...(raw?.sections ?? {}) },
    ads_limit: Math.min(30, Math.max(0, Number(raw?.ads_limit ?? base.ads_limit) || 0)),
    allow_filter: raw?.allow_filter ?? base.allow_filter,
  };
}

// ------------------------------------------------------------ numbers
export type Totals = Omit<ReportDay, "day">;
const zero = (): Totals => ({
  spend: 0,
  impressions: 0,
  reach: 0,
  clicks: 0,
  conversions: 0,
  view_content: 0,
  add_to_cart: 0,
  initiate_checkout: 0,
});
export function daysIn(view: ReportView, from: string, to: string) {
  return view.days.filter((d) => d.day >= from && d.day <= to);
}
export function totalsOf(days: ReportDay[]): Totals {
  return days.reduce((t, d) => {
    for (const k of Object.keys(t) as (keyof Totals)[]) t[k] += Number(d[k]) || 0;
    return t;
  }, zero());
}
const ratio = (a: number, b: number) => (b ? a / b : null);
/**
 * A metric's value in the period. Reach is only exact for the whole report
 * (Meta's deduplicated number); narrowed, it is null.
 */
export function metricValue(
  id: ReportMetric,
  t: Totals,
  reach: number | null,
): number | null {
  switch (id) {
    case "spend":
      return t.spend;
    case "results":
      return t.conversions;
    case "cpa":
      return ratio(t.spend, t.conversions);
    case "impressions":
      return t.impressions;
    case "reach":
      return reach;
    case "frequency":
      return reach ? t.impressions / reach : null;
    case "clicks":
      return t.clicks;
    case "ctr": {
      const r = ratio(t.clicks, t.impressions);
      return r === null ? null : r * 100;
    }
    case "cpc":
      return ratio(t.spend, t.clicks);
    case "cpm": {
      const r = ratio(t.spend, t.impressions);
      return r === null ? null : r * 1000;
    }
    case "conversion_rate": {
      const r = ratio(t.conversions, t.clicks);
      return r === null ? null : r * 100;
    }
    default:
      return t[id];
  }
}
export const metricKind = (
  id: ReportMetric,
): "money" | "count" | "percent" | "decimal" =>
  id === "spend" || id === "cpa" || id === "cpc" || id === "cpm"
    ? "money"
    : id === "ctr" || id === "conversion_rate"
      ? "percent"
      : id === "frequency"
        ? "decimal"
        : "count";
export function formatMetric(
  kind: "money" | "count" | "percent" | "decimal",
  value: number | null,
  currency = "BRL",
) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (kind === "money")
    return value.toLocaleString("pt-BR", { style: "currency", currency });
  if (kind === "percent")
    return `${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  if (kind === "decimal")
    return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}
/** "Leads", "Conversas"… by the period's (last) cycle objective. */
export function resultName(view: ReportView) {
  const objective = view.cycles[view.cycles.length - 1]?.objective;
  const word = objective ? objectives[objective]?.result : "";
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : "Resultados";
}
export function metricLabel(id: ReportMetric, view: ReportView) {
  const name = resultName(view);
  if (id === "results") return name;
  if (id === "cpa") return `Custo por ${singular(name).toLocaleLowerCase("pt-BR")}`;
  return METRICS.find((m) => m.id === id)?.label ?? id;
}
function singular(word: string) {
  const map: Record<string, string> = {
    Leads: "Lead",
    Conversas: "Conversa",
    Vendas: "Venda",
    Cliques: "Clique",
    Engajamentos: "Engajamento",
    "Conversões": "Conversão",
    "Visualizações": "Visualização",
    Resultados: "Resultado",
  };
  return map[word] ?? word;
}
/** The metrics that make sense for the report's objective. */
export function metricsFor(
  view: ReportView | null,
  objective?: AdObjective | null,
  platform?: string,
) {
  const o = objective ?? view?.cycles[view.cycles.length - 1]?.objective;
  const sale = o === "sale" || o === "custom";
  // Google has no deduplicated reach for these campaigns.
  const google = (platform ?? view?.platform) === "google";
  return METRICS.filter(
    (m) =>
      (sale ||
        (m.id !== "view_content" && m.id !== "add_to_cart" && m.id !== "initiate_checkout")) &&
      !(google && (m.id === "reach" || m.id === "frequency")),
  );
}
export function chartsFor(objective?: AdObjective | null) {
  const sale = objective === "sale" || objective === "custom";
  return CHARTS.filter((c) => sale || c.id !== "funnel");
}

export type ItemTotals = {
  item: ReportItem;
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
};
/** Each ad's (or ad set's) numbers in the period, the best first. */
export function itemsIn(
  items: ReportItem[] | undefined,
  from: string,
  to: string,
  byResults: boolean,
): ItemTotals[] {
  return (items ?? [])
    .map((item) => {
      const t = { item, spend: 0, impressions: 0, clicks: 0, results: 0 };
      for (const d of item.days)
        if (d.d >= from && d.d <= to) {
          t.spend += d.s;
          t.impressions += d.i;
          t.clicks += d.c;
          t.results += d.r;
        }
      return t;
    })
    .filter((t) => t.impressions > 0 || t.spend > 0)
    .sort((a, b) =>
      byResults && b.results !== a.results ? b.results - a.results : b.spend - a.spend,
    );
}
/** The goal of the cycles inside the period (their sum), when shown. */
export function goalOf(view: ReportView) {
  const cycles = view.cycles.filter((c) => c.goal_results !== undefined);
  if (!cycles.length) return null;
  return {
    results: cycles.reduce((s, c) => s + (c.goal_results ?? 0), 0),
    budget: cycles.reduce((s, c) => s + (c.budget ?? 0), 0),
    single: cycles.length === 1 ? cycles[0] : null,
  };
}

/** The change from B to A, in percent (null: nothing to compare). */
export function deltaOf(a: number | null, b: number | null) {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0)
    return null;
  return ((a - b) / Math.abs(b)) * 100;
}
/** Costs are better when they go down. */
export const lowerIsBetter = (id: ReportMetric) =>
  id === "cpa" || id === "cpc" || id === "cpm";
/** Reach of a period: Meta's exact number only for the saved periods. */
export function reachOf(
  view: ReportView,
  range: { from: string; to: string },
  report: { start: string; end: string; compareStart: string | null; compareEnd: string | null },
) {
  if (range.from === report.start && range.to === report.end) return view.reach;
  if (report.compareStart && range.from === report.compareStart && range.to === report.compareEnd)
    return view.compare_reach ?? null;
  return null;
}
/** The same number of days right before a period. */
export function previousRange(from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}
export const rangeLabel = (r: { from: string; to: string }) => {
  const f = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  return `${f(r.from)} a ${f(r.to)}`;
};

/** What the MAVI reads to write the analysis (the numbers the client sees). */
export function numbersForMavi(
  view: ReportView,
  config: ReportConfig,
  from: string,
  to: string,
  compare?: { from: string; to: string } | null,
  compareReach?: number | null,
) {
  const days = daysIn(view, from, to);
  const t = totalsOf(days);
  // The reach is Meta's for the whole report only.
  const whole =
    from <= (view.days[0]?.day ?? from) &&
    to >= (view.days[view.days.length - 1]?.day ?? to);
  const reach = whole ? view.reach : null;
  const goal = config.sections.goal ? goalOf(view) : null;
  const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
  const ads = itemsIn(view.ads, from, to, view.ad_results).slice(0, 8);
  const weeks: { de: string; ate: string; investimento: number; resultados: number }[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const w = totalsOf(days.slice(i, i + 7));
    weeks.push({
      de: days[i].day,
      ate: days[Math.min(i + 6, days.length - 1)].day,
      investimento: round(w.spend)!,
      resultados: w.conversions,
    });
  }
  return {
    moeda: view.currency,
    resultado_chamado_de: resultName(view),
    objetivo: view.cycles.map((c) => objectives[c.objective]?.label).filter(Boolean),
    periodo: { de: from, ate: to, dias: days.length },
    totais: {
      investimento: round(t.spend),
      resultados: t.conversions,
      custo_por_resultado: round(ratio(t.spend, t.conversions)),
      impressoes: t.impressions,
      alcance: reach,
      cliques_no_link: t.clicks,
      ctr_percentual: round(metricValue("ctr", t, reach)),
      cpc: round(ratio(t.spend, t.clicks)),
      cpm: round(metricValue("cpm", t, reach)),
      ...(t.view_content || t.add_to_cart || t.initiate_checkout
        ? {
            visualizacoes_da_pagina: t.view_content,
            adicoes_ao_carrinho: t.add_to_cart,
            finalizacoes_de_compra: t.initiate_checkout,
          }
        : {}),
    },
    ...(goal
      ? {
          meta: {
            resultados_esperados: goal.results,
            verba: round(goal.budget),
            custo_por_resultado_esperado: round(ratio(goal.budget, goal.results)),
          },
        }
      : {}),
    semanas: weeks,
    ...(config.sections.ads && ads.length
      ? {
          anuncios: ads.map((a) => ({
            nome: a.item.name,
            conjunto: a.item.adset,
            investimento: round(a.spend),
            resultados: view.ad_results ? a.results : null,
            custo_por_resultado: view.ad_results ? round(ratio(a.spend, a.results)) : null,
            cliques: a.clicks,
          })),
        }
      : {}),
    ...(compare
      ? (() => {
          const c = totalsOf(daysIn(view, compare.from, compare.to));
          const pct = (a: number | null, b: number | null) => round(deltaOf(a, b));
          return {
            comparacao: {
              periodo: { de: compare.from, ate: compare.to },
              investimento: round(c.spend),
              resultados: c.conversions,
              custo_por_resultado: round(ratio(c.spend, c.conversions)),
              impressoes: c.impressions,
              alcance: compareReach ?? null,
              cliques_no_link: c.clicks,
              variacao_percentual: {
                investimento: pct(t.spend, c.spend),
                resultados: pct(t.conversions, c.conversions),
                custo_por_resultado: pct(ratio(t.spend, t.conversions), ratio(c.spend, c.conversions)),
                cliques_no_link: pct(t.clicks, c.clicks),
              },
            },
          };
        })()
      : {}),
    ...(config.sections.keywords && view.keywords?.length
      ? {
          palavras_chave: itemsIn(view.keywords, from, to, view.ad_results)
            .slice(0, 10)
            .map((k) => ({ palavra: k.item.name, investimento: round(k.spend), cliques: k.clicks, resultados: view.ad_results ? k.results : null })),
        }
      : {}),
    ...(config.sections.search_terms && view.search_terms?.length
      ? {
          termos_de_pesquisa: itemsIn(view.search_terms, from, to, view.ad_results)
            .slice(0, 10)
            .map((k) => ({ termo: k.item.name, cliques: k.clicks, resultados: view.ad_results ? k.results : null })),
        }
      : {}),
    ...(view.ad_results ? {} : { observacao: "Os resultados vêm das páginas de captura; por anúncio só há investimento e cliques." }),
  };
}

// ------------------------------------------------------------ links
export const reportUrl = (token: string) =>
  `${window.location.origin}/relatorio/${token}`;
export async function publicReport(token: string, password: string | null) {
  return (await rpc("ad_report_public", {
    p_token: token,
    p_password: password,
  })) as PublicReport | null;
}
const fromDb = (r: CampaignReport): CampaignReport => ({
  ...r,
  config: configFrom(r.config),
});

export const supabaseReports: ReportsBackend = {
  async list(_company, campaign) {
    return ((await rpc("ad_reports", { p_campaign: campaign })) as CampaignReport[]).map(fromDb);
  },
  async get(id) {
    return fromDb((await rpc("ad_report", { p_id: id })) as CampaignReport);
  },
  async create(company, input) {
    const { report } = await adsServer<{ report: CampaignReport }>({
      action: "report-create",
      company,
      ...input,
      provider: input.provider ?? "meta",
    });
    return fromDb(report);
  },
  async update(id, title, config, analysis) {
    return fromDb(
      (await rpc("update_ad_report", {
        p_id: id,
        p_title: title,
        p_config: config,
        p_analysis: analysis,
      })) as CampaignReport,
    );
  },
  async setLink(id, enabled, expiresAt, password, keepPassword) {
    return fromDb(
      (await rpc("set_ad_report_link", {
        p_id: id,
        p_enabled: enabled,
        p_expires_at: expiresAt,
        p_password: password,
        p_keep_password: keepPassword,
      })) as CampaignReport,
    );
  },
  async remove(id) {
    await rpc("delete_ad_report", { p_id: id });
  },
  async writeAnalysis(company, input) {
    const { text } = await driveServer<{ text: string }>({
      action: "campaign-report-mavi",
      company,
      ...input,
      numbers: JSON.stringify(input.numbers),
    });
    return text;
  },
};

// ------------------------------------------------------------ demonstration
/**
 * The demonstration's reports, in memory: the numbers are the campaign's
 * days (with or without M applied here as the database does) and a few ads.
 */
export function demoReports(deps: {
  metrics: MetricsBackend;
  cycles: (campaign: string) => AdCycle[];
  names: (campaign: string) => {
    campaign: string;
    client: string;
    product: string;
    platform?: string;
  };
  user: string;
}): ReportsBackend {
  type Stored = Omit<CampaignReport, "view" | "can_manage"> & {
    raw: { days: (ReportDay & { m: number })[]; cycles: AdCycle[]; ads: ReportItem[]; adsets: ReportItem[]; keywords?: ReportItem[]; search_terms?: ReportItem[]; reach: number | null; compare_reach: number | null };
    company: string;
    password: string | null;
  };
  const store: Stored[] = [];
  const token = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const view = (r: Stored): ReportView => {
    const withM = r.config.with_m;
    const factor = new Map(r.raw.days.map((d) => [d.day, withM ? d.m : 1]));
    const last = r.raw.cycles[r.raw.cycles.length - 1];
    const byDay = new Map<string, ReportDay>();
    for (const d of r.raw.days) {
      const t = byDay.get(d.day) ?? { ...zero(), day: d.day };
      for (const k of Object.keys(zero()) as (keyof Totals)[])
        t[k] += (Number(d[k]) || 0) * (k === "spend" && withM ? d.m : 1);
      byDay.set(d.day, t);
    }
    const items = (list: ReportItem[]) =>
      list.map((i) => ({
        ...i,
        days: i.days.map((d) => ({
          ...d,
          s: Math.round(d.s * (withM ? (factor.get(d.d) ?? last?.multiplier ?? 1) : 1) * 100) / 100,
        })),
      }));
    const names = deps.names(r.campaign_id);
    return {
      platform: names.platform ?? "meta",
      campaign_name: names.campaign,
      client_name: names.client,
      product_name: names.product,
      captured_at: r.created_at,
      currency: "BRL",
      days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      cycles: r.raw.cycles.map((c) => ({
        start_date: c.start_date,
        end_date: c.end_date,
        objective: c.objective,
        destination: c.destination,
        goal_results: c.goal_results,
        budget: withM ? c.budget : Math.round((c.budget / c.multiplier) * 100) / 100,
      })),
      reach: r.raw.reach,
      compare_reach: r.raw.compare_reach,
      ad_results: true,
      ads: items(r.raw.ads),
      adsets: items(r.raw.adsets),
      ...(r.raw.keywords ? { keywords: items(r.raw.keywords), search_terms: items(r.raw.search_terms ?? []) } : {}),
    };
  };
  const out = (r: Stored, withView = true): CampaignReport => ({
    id: r.id,
    campaign_id: r.campaign_id,
    title: r.title,
    period_start: r.period_start,
    period_end: r.period_end,
    compare_start: r.compare_start,
    compare_end: r.compare_end,
    config: r.config,
    analysis: r.analysis,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_by: r.updated_by,
    updated_at: r.updated_at,
    link: r.link,
    can_manage: true,
    view: withView ? view(r) : null,
  });
  const find = (id: string) => {
    const r = store.find((x) => x.id === id);
    if (!r) throw Error("Relatório não encontrado.");
    return r;
  };
  const wait = <T,>(v: T) => new Promise<T>((res) => setTimeout(() => res(v), 200));
  return {
    list: async (_company, campaign) =>
      wait(store.filter((r) => r.campaign_id === campaign).map((r) => out(r, false)).reverse()),
    get: async (id) => wait(out(find(id))),
    async create(company, input) {
      if (input.title.trim().length < 2) throw Error("Dê um nome ao relatório.");
      if (!input.start || !input.end || input.end < input.start)
        throw Error("Escolha o período do relatório.");
      const metrics = await deps.metrics.load(company, input.campaign);
      const days = metrics.daily
        .filter(
          (d) =>
            (d.day >= input.start && d.day <= input.end) ||
            (!!input.compare_start &&
              d.day >= input.compare_start &&
              d.day <= (input.compare_end ?? input.compare_start)),
        )
        .map((d) => ({
          day: d.day,
          m: d.multiplier,
          spend: d.spend,
          impressions: d.impressions,
          reach: d.reach,
          clicks: d.clicks,
          conversions: d.conversions,
          view_content: d.view_content,
          add_to_cart: d.add_to_cart,
          initiate_checkout: d.initiate_checkout,
        }));
      const cycles = deps
        .cycles(input.campaign)
        .filter(
          (y) =>
            (y.start_date <= input.end && y.end_date >= input.start) ||
            (!!input.compare_start &&
              y.start_date <= (input.compare_end ?? input.compare_start) &&
              y.end_date >= input.compare_start),
        );
      const google = deps.names(input.campaign).platform === "google";
      // A few ads sharing the days' numbers.
      const names = google
        ? ["Café especial | Norte Coffee", "Torra fresca toda semana", "Assinatura com desconto", "Café em grãos 1 kg", "Presente para quem ama café"]
        : ["Vídeo depoimento", "Carrossel benefícios", "Imagem oferta", "Reels bastidores", "Story pergunta"];
      const weights = [0.34, 0.26, 0.18, 0.14, 0.08];
      const ads: ReportItem[] = names.map((name, i) => ({
        id: `demo-ad-${i}`,
        name,
        adset: google ? (i < 3 ? "Café especial" : "Café em grãos") : i < 3 ? "Aberto 25-54" : "Remarketing 30 dias",
        campaign: google ? "Pesquisa · Genéricas" : "[MSG] Motion · Conversas WhatsApp",
        title: google ? `${name} | Frete grátis acima de R$ 150 | Peça hoje` : name,
        body: google
          ? "Cafés especiais de pequenos produtores, torrados toda semana. Assine e receba em casa."
          : "Conheça a solução que já ajudou centenas de clientes. Fale com a gente!",
        kind: google ? "Anúncio responsivo de pesquisa" : undefined,
        video: !google && (i === 0 || i === 3),
        reach: Math.round(days.reduce((s, d) => s + d.reach, 0) * weights[i] * 0.7),
        days: days.map((d) => ({
          d: d.day,
          s: Math.round(d.spend * weights[i] * 100) / 100,
          i: Math.round(d.impressions * weights[i]),
          c: Math.round(d.clicks * weights[i]),
          r: Math.round(d.conversions * weights[(i + 1) % 5]),
        })),
      }));
      const share = (list: string[], weightsOf: number[], kind?: (i: number) => string) =>
        list.map((name, i): ReportItem => ({
          id: `demo-${name}`,
          name,
          adset: i % 2 ? "Café em grãos" : "Café especial",
          kind: kind?.(i),
          days: days.map((d) => ({
            d: d.day,
            s: Math.round(d.spend * weightsOf[i] * 100) / 100,
            i: Math.round(d.impressions * weightsOf[i]),
            c: Math.round(d.clicks * weightsOf[i]),
            r: Math.round(d.conversions * weightsOf[i]),
          })),
        }));
      const keywords = google
        ? share(["[café especial]", '"café em grãos"', "comprar café gourmet", "[norte coffee]", "café torrado na hora"], [0.3, 0.24, 0.2, 0.16, 0.1], (i) => ["Correspondência exata", "Correspondência de frase", "Correspondência ampla"][i % 3])
        : undefined;
      const searchTerms = google
        ? share(["café especial", "café especial preço", "café em grãos 1kg", "melhor café gourmet", "norte coffee", "café torrado perto de mim"], [0.22, 0.2, 0.18, 0.16, 0.14, 0.1])
        : undefined;
      const adsets: ReportItem[] = (google ? ["Café especial", "Café em grãos"] : ["Aberto 25-54", "Remarketing 30 dias"]).map((name) => {
        const own = ads.filter((a) => a.adset === name);
        return {
          id: `demo-set-${name}`,
          name,
          days: days.map((d) => ({
            d: d.day,
            s: own.reduce((s, a) => s + (a.days.find((x) => x.d === d.day)?.s ?? 0), 0),
            i: own.reduce((s, a) => s + (a.days.find((x) => x.d === d.day)?.i ?? 0), 0),
            c: own.reduce((s, a) => s + (a.days.find((x) => x.d === d.day)?.c ?? 0), 0),
            r: own.reduce((s, a) => s + (a.days.find((x) => x.d === d.day)?.r ?? 0), 0),
          })),
        };
      });
      const now = new Date().toISOString();
      const r: Stored = {
        id: crypto.randomUUID(),
        campaign_id: input.campaign,
        company,
        title: input.title.trim(),
        period_start: input.start,
        period_end: input.end,
        compare_start: input.compare_start ?? null,
        compare_end: input.compare_end ?? null,
        config: configFrom(input.config),
        analysis: input.analysis ?? "",
        created_by: deps.user,
        created_at: now,
        updated_by: null,
        updated_at: now,
        link: input.link
          ? { token: token(), expires_at: input.expires_at ?? null, expired: false, has_password: !!input.password }
          : null,
        password: input.password ?? null,
        raw: {
          days,
          cycles,
          ads: ads.slice(0, Math.max(input.config.ads_limit, 5)),
          adsets,
          ...(keywords ? { keywords, search_terms: searchTerms } : {}),
          // Google has no deduplicated reach.
          reach: google
            ? null
            : Math.round(
                days
                  .filter((d) => d.day >= input.start && d.day <= input.end)
                  .reduce((s, d) => s + d.reach, 0) * 0.62,
              ),
          compare_reach: input.compare_start && !google
            ? Math.round(
                days
                  .filter((d) => d.day >= input.compare_start! && d.day <= input.compare_end!)
                  .reduce((s, d) => s + d.reach, 0) * 0.62,
              )
            : null,
        },
      };
      store.push(r);
      return wait(out(r));
    },
    async update(id, title, config, analysis) {
      const r = find(id);
      if (title.trim().length < 2) throw Error("Dê um nome ao relatório.");
      Object.assign(r, { title: title.trim(), config, analysis, updated_at: new Date().toISOString(), updated_by: deps.user });
      return wait(out(r));
    },
    async setLink(id, enabled, expiresAt, password, keepPassword) {
      const r = find(id);
      if (!enabled) {
        r.link = null;
        r.password = null;
      } else {
        if (expiresAt && expiresAt <= new Date().toISOString())
          throw Error("Escolha uma validade no futuro.");
        const pass = r.link && keepPassword ? r.password : password || null;
        if (pass && (pass.length < 4 || pass.length > 72))
          throw Error("A senha precisa ter de 4 a 72 caracteres.");
        r.password = pass;
        r.link = {
          token: r.link?.token ?? token(),
          expires_at: expiresAt,
          expired: false,
          has_password: !!pass,
        };
      }
      return wait(out(r, false));
    },
    async remove(id) {
      const i = store.findIndex((x) => x.id === id);
      if (i >= 0) store.splice(i, 1);
    },
    async writeAnalysis(_company, input) {
      const n = input.numbers as ReturnType<typeof numbersForMavi>;
      const money = (v: number | null) =>
        v === null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      const best = n.anuncios?.[0];
      return wait(
        [
          `No período, investimos **${money(n.totais.investimento)}** e a campanha trouxe **${n.totais.resultados.toLocaleString("pt-BR")} ${n.resultado_chamado_de.toLocaleLowerCase("pt-BR")}**, a ${money(n.totais.custo_por_resultado)} cada.`,
          "",
          "Destaques:",
          `- Os anúncios foram vistos ${n.totais.impressoes.toLocaleString("pt-BR")} vezes e receberam ${n.totais.cliques_no_link.toLocaleString("pt-BR")} cliques no link.`,
          ...(best ? [`- O anúncio que mais trouxe resultado foi "${best.nome}".`] : []),
          ...(n.meta ? [`- A meta do ciclo é de ${n.meta.resultados_esperados} resultados.`] : []),
          "",
          "Próximos passos:",
          "- Manter os anúncios com melhor custo e testar novas variações do criativo que mais converteu.",
          "",
          "(Texto de demonstração: com a MAVI configurada, a análise é escrita a partir dos números do relatório.)",
        ].join("\n"),
      );
    },
  };
}

/** The comparison periods offered for a report's period. */
export function comparePeriods(
  start: string,
  end: string,
  cycles: AdCycle[],
) {
  const prev = previousRange(start, end);
  const out: { id: string; label: string; start: string; end: string }[] = [
    { id: "previous", label: "Período anterior (mesma duração)", start: prev.from, end: prev.to },
  ];
  const cycle = [...cycles]
    .filter((y) => y.end_date < start)
    .sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
  if (cycle)
    out.push({ id: "cycle", label: "Ciclo anterior", start: cycle.start_date, end: cycle.end_date });
  // The same days of the month before (clamped to the month's end).
  const shift = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    const month = m === 1 ? 12 : m - 1;
    const year = m === 1 ? y - 1 : y;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
  };
  out.push({ id: "month", label: "Mesmo período do mês anterior", start: shift(start), end: shift(end) });
  return out;
}

/** The periods offered when creating a report. */
export function reportPeriods(cycles: AdCycle[], current: AdCycle | null, today: string) {
  const yesterday = addDays(today, -1);
  const clamp = (end: string) => (end > yesterday ? yesterday : end);
  const out: { id: string; label: string; start: string; end: string }[] = [];
  if (current && current.start_date <= yesterday)
    out.push({ id: "current", label: "Ciclo atual (até ontem)", start: current.start_date, end: clamp(current.end_date) });
  const previous = [...cycles]
    .filter((y) => y.end_date < (current?.start_date ?? today) && y.id !== current?.id)
    .sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
  if (previous)
    out.push({ id: "previous", label: "Ciclo anterior", start: previous.start_date, end: clamp(previous.end_date) });
  out.push(
    { id: "7", label: "Últimos 7 dias", start: addDays(today, -7), end: yesterday },
    { id: "15", label: "Últimos 15 dias", start: addDays(today, -15), end: yesterday },
    { id: "30", label: "Últimos 30 dias", start: addDays(today, -30), end: yesterday },
  );
  const month = today.slice(0, 7);
  const lastEnd = addDays(`${month}-01`, -1);
  out.push({ id: "last_month", label: "Mês passado", start: `${lastEnd.slice(0, 7)}-01`, end: lastEnd });
  return out;
}

import { callRpc } from "./_drive.js";
import type { LlmAdapter } from "./_ai-llm.js";
import {
  adapterFor,
  routeConfig,
  type ProviderConfig,
  type ResolvedRoute,
} from "./_ai-providers.js";
import { workerAuthorized } from "./_copilot.js";
import { askJev, type JevQuestion, type JevResponse } from "./_temperature.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { AdsEnv } from "./_ads.js";
import {
  platformWindows,
  type Metrics as PlatformMetrics,
  type WindowRange,
  type WindowRow,
} from "./_ads-platform.js";
import {
  googleWindows,
  type GoogleRow,
  type GoogleWindowRow,
  type Search,
} from "./_ads-google-platform.js";
import { unseal } from "./_google.js";
import {
  crmUtmDeals,
  crmUtmFunnel,
  type CrmEnv,
  type CrmFunnel,
  type CrmFunnelRow,
  type CrmUtmDeals,
} from "./_crm.js";
import { modelPrice } from "./_social-leads.js";
import { readCreatives, type CreativeAd } from "./_campaign-creatives.js";
import { learnFromFeedback } from "./_campaign-insight-learning.js";
import { watchPlatforms } from "./_campaign-watch.js";
import { meteredFetch, newApiMeter, type ApiMeter, type Throttle } from "./_ads-meter.js";

/**
 * Campanhas › Insights da MAVI (migração 20270327090000_campaign_insights).
 *
 * O worker do pg_cron (ação "ai-campaign-insights" de /api/ai): pega as
 * análises da fila e, para cada campanha,
 *  1. lê a plataforma ao vivo (Meta: campanhas, conjuntos, anúncios e o
 *     público por idade e gênero dos conjuntos; Google: campanhas, grupos,
 *     anúncios, palavras-chave, termos de pesquisa, idade e gênero) nas
 *     janelas ciclo, 7, 15 e 30 dias e desde a última análise;
 *  2. cruza com o MakeCRM por UTM (o mesmo nome exato da aba Plataforma);
 *  3. roda as detecções automáticas (conversões sem lead no CRM, UTMs quase
 *     iguais ao nome, custo acima da meta do ciclo);
 *  4. pede à MAVI os insights (funcionalidade 'campaign_insights'): cada um
 *     aponta ONDE estão os números (entidade, janela, métrica) e o servidor
 *     preenche os valores — insight sem evidência que confira é descartado;
 *  5. o Jev (funcionalidade 'campaign_insights_check'), quando cadastrado,
 *     confere se as evidências sustentam cada insight;
 *  6. grava (ai_campaign_insight_store), dentro do teto por análise.
 *
 * Os valores em R$ seguem a escolha da empresa (sem M ou com M).
 */

type Row = Record<string, unknown>;
type Fetch = typeof fetch;

export class InsightsError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Não adianta tentar de novo (falta conexão, teto pequeno demais…). */
    public final = false,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ material do banco
export type Basis = "net" | "gross";
export type InsightMaterial = {
  blocked?: string;
  run: { id: string; trigger: "schedule" | "manual" };
  company_id: string;
  today: string;
  timezone: string;
  campaign: { id: string; name: string; platform: "meta" | "google"; notes: string };
  client: { id: string; name: string } | null;
  product: { id: string; name: string } | null;
  contract_id: string;
  cycle: {
    id: string;
    start_date: string;
    end_date: string;
    objective: string;
    destination: string;
    goal_results: number;
    budget: number;
    multiplier: number;
    niche: string;
  };
  links: { account_id: string; campaign_id: string; manager_id?: string | null }[];
  meta_tokens: Record<string, { token_cipher: string; expires_at: string | null }> | null;
  google_token: { refresh_token_cipher: string } | null;
  crm_company_id: string | null;
  /** A etapa do CRM que importa nesta campanha e a meta de custo por lead nela (R$, na base dos insights). */
  crm_goal?: CrmGoal | null;
  daily: { day: string; spend: number; conversions: number; multiplier: number }[];
  settings: { money_basis: Basis; run_cap_usd: number; min_new_days?: number; min_results?: number; max_insights?: number };
  last_done_at: string | null;
  previous: {
    kind: string;
    priority: string;
    title: string;
    fingerprint: string;
    status: string;
    seen_count: number;
    last_seen_at: string;
    status_reason?: string | null;
  }[];
  /** Os aplicados nos últimos 30 dias (para medir antes × depois). */
  applied?: {
    id: string;
    title: string;
    kind: string;
    target: { key: string; level: string; name: string } | null;
    applied_at: string;
    effect: Effect | null;
  }[];
  /** Os aprendizados do time que valem para este cliente. */
  lessons?: { scope: string; kind: string | null; text: string }[];
  context: {
    dossier: { kind: string; text: string }[];
    radar: { topic: string; title: string; summary: string; severity: number | null; last_seen: string }[];
    temperature: { score: number; summary: string | null } | null;
    meetings: { title: string; date: string; text: string }[];
  };
  jev: ResolvedRoute | null;
};

// ------------------------------------------------------------ janelas
export type WindowKey = "cycle" | "d7" | "d15" | "d30" | "since_last";
export const WINDOW_LABELS: Record<WindowKey, string> = {
  cycle: "ciclo até ontem",
  d7: "últimos 7 dias",
  d15: "últimos 15 dias",
  d30: "últimos 30 dias",
  since_last: "desde a última análise",
};
export type Range = { since: string; until: string };

export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** O dia local de um instante. */
export function localDay(at: string, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  } catch {
    return at.slice(0, 10);
  }
}

/**
 * As janelas da análise, todas até ontem (dias fechados): o ciclo atual, os
 * últimos 7, 15 e 30 dias e, quando houve análise antes, desde o dia dela.
 */
export function windowsFor(
  today: string,
  cycle: { start_date: string; end_date: string },
  lastDoneAt: string | null,
  timezone: string,
): Partial<Record<WindowKey, Range>> {
  const until = addDays(today, -1);
  const cycleUntil = cycle.end_date < until ? cycle.end_date : until;
  const out: Partial<Record<WindowKey, Range>> = {
    cycle: { since: cycle.start_date, until: cycleUntil },
    d7: { since: addDays(until, -6), until },
    d15: { since: addDays(until, -14), until },
    d30: { since: addDays(until, -29), until },
  };
  if (lastDoneAt) {
    const since = localDay(lastDoneAt, timezone);
    // Só quando cobre ao menos um dia fechado e é diferente das outras.
    if (since <= until && since !== out.d7!.since && since !== out.d15!.since && since !== out.d30!.since)
      out.since_last = { since, until };
  }
  return out;
}

// ------------------------------------------------------------ entidades
export type Level = "total" | "campaign" | "adset" | "ad" | "keyword" | "search_term" | "segment" | "utm";
export type Numbers = Record<string, number | null>;
export type Entity = {
  key: string;
  level: Level;
  name: string;
  /** A chave da entidade de cima (conjunto do anúncio, campanha do conjunto…). */
  parent?: string;
  status?: string;
  /** Textos que ajudam a ler: criativo, tipo de correspondência, otimização… */
  info?: Record<string, string>;
  /** Os números por janela (já na base de dinheiro escolhida). */
  n: Partial<Record<WindowKey, Numbers>>;
  /** A chave da UTM no CRM (nome exato: campanha; + termo; + conteúdo). */
  utm?: string;
  /** Anúncios: de onde vem o criativo (Meta: o criativo e a conta; Google: a imagem). */
  source?: { creative?: string; account?: string; image?: string };
};

/** As métricas, com a unidade de cada uma (para mostrar e para conferir). */
export const METRICS: Record<string, { label: string; unit: "money" | "count" | "pct" | "ratio" | "days" }> = {
  spend: { label: "Investimento", unit: "money" },
  impressions: { label: "Impressões", unit: "count" },
  reach: { label: "Alcance", unit: "count" },
  clicks: { label: "Cliques", unit: "count" },
  results: { label: "Resultados na plataforma", unit: "count" },
  cpa: { label: "Custo por resultado", unit: "money" },
  ctr: { label: "Taxa de cliques (CTR)", unit: "pct" },
  cpc: { label: "Custo por clique (CPC)", unit: "money" },
  cpm: { label: "Custo por mil impressões (CPM)", unit: "money" },
  frequency: { label: "Vezes que cada pessoa viu (frequência)", unit: "ratio" },
  value: { label: "Valor de conversão", unit: "money" },
  roas: { label: "Retorno na plataforma (ROAS)", unit: "ratio" },
  crm_opportunities: { label: "Oportunidades no CRM", unit: "count" },
  crm_wins: { label: "Ganhos no CRM", unit: "count" },
  crm_revenue: { label: "Receita no CRM", unit: "money" },
  crm_cpl: { label: "Custo por oportunidade (CRM)", unit: "money" },
  crm_cost_win: { label: "Custo por ganho (CRM)", unit: "money" },
  crm_roas: { label: "Retorno em vendas no CRM (ROAS)", unit: "ratio" },
  crm_rate: { label: "Resultados que viraram oportunidade no CRM", unit: "pct" },
  // O funil do CRM (oportunidades criadas no ciclo).
  crm_open: { label: "Oportunidades abertas", unit: "count" },
  crm_won_deals: { label: "Oportunidades ganhas", unit: "count" },
  crm_lost: { label: "Oportunidades perdidas", unit: "count" },
  crm_lost_rate: { label: "Oportunidades perdidas no CRM (%)", unit: "pct" },
  crm_qualified: { label: "Oportunidades qualificadas", unit: "count" },
  crm_score: { label: "Pontuação média da qualificação", unit: "ratio" },
  // A maturidade dos leads (as etapas que importam vão como goal:<etapa>:<métrica>, com rótulo).
  young_leads: { label: "Leads abertos ainda recentes", unit: "count" },
  young_rate: { label: "Leads abertos ainda recentes (%)", unit: "pct" },
  // Só no total: a meta do ciclo e o que o MAVI conta.
  goal_results: { label: "Meta de resultados do ciclo", unit: "count" },
  goal_cpa: { label: "Custo por resultado da meta", unit: "money" },
  budget: { label: "Verba do ciclo", unit: "money" },
  mavi_results: { label: "Resultados que contam (MAVI)", unit: "count" },
  mavi_cpa: { label: "Custo por resultado (MAVI)", unit: "money" },
  cost_vs_goal: { label: "Custo por resultado em relação à meta", unit: "pct" },
  spend_pace: { label: "Ritmo de gasto", unit: "pct" },
  results_pace: { label: "Ritmo de resultados", unit: "pct" },
  days_elapsed: { label: "Dias do ciclo passados", unit: "days" },
  days_total: { label: "Dias do ciclo", unit: "days" },
};
/** As métricas de cada etapa que importa: goal:<etapa>:<métrica>. */
const GOAL_UNITS: Record<string, "money" | "count" | "pct"> = {
  leads: "count",
  rate: "pct",
  cost: "money",
  target: "money",
  vs_target: "pct",
  young: "count",
  young_rate: "pct",
};
export const goalMetric = (stage: string, m: keyof typeof GOAL_UNITS | string) => `goal:${stage}:${m}`;
export const unitOf = (metric: string) =>
  METRICS[metric]?.unit ?? (metric.startsWith("goal:") ? GOAL_UNITS[metric.split(":")[2]] : undefined) ?? "count";
const MONEY = new Set(Object.entries(METRICS).filter(([, m]) => m.unit === "money").map(([k]) => k));

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const div = (a: number | null | undefined, b: number | null | undefined, times = 1) =>
  a === null || a === undefined || !b ? null : round((a / b) * times, 4);
const numOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Números base → as derivadas (custos, taxas, ROAS) já na base de dinheiro. */
export function derive(base: {
  spend: number;
  impressions?: number;
  reach?: number | null;
  clicks?: number;
  results?: number;
  value?: number | null;
}): Numbers {
  const out: Numbers = {
    spend: round(base.spend),
    impressions: base.impressions ?? null,
    clicks: base.clicks ?? null,
    results: base.results ?? null,
    cpa: div(base.spend, base.results),
    ctr: div(base.clicks, base.impressions, 100),
    cpc: div(base.spend, base.clicks),
    cpm: div(base.spend, base.impressions, 1000),
  };
  if (base.reach !== undefined) {
    out.reach = base.reach;
    out.frequency = div(base.impressions, base.reach);
  }
  if (base.value) {
    out.value = round(base.value);
    out.roas = div(base.value, base.spend);
  }
  for (const k of ["cpa", "cpc", "cpm"]) if (out[k] !== null) out[k] = round(out[k]!);
  if (out.ctr !== null) out.ctr = round(out.ctr!);
  return out;
}

export type CrmCounts = { opportunities: number; wins: number; revenue: number };
/** O CRM somado aos números de uma janela. */
export function withCrm(n: Numbers, crm: CrmCounts | null | undefined): Numbers {
  if (!crm) return n;
  const spend = n.spend ?? 0;
  return {
    ...n,
    crm_opportunities: crm.opportunities,
    crm_wins: crm.wins,
    crm_revenue: round(crm.revenue),
    crm_cpl: crm.opportunities ? round(spend / crm.opportunities) : null,
    crm_cost_win: crm.wins ? round(spend / crm.wins) : null,
    crm_roas: spend ? round(crm.revenue / spend, 2) : null,
    crm_rate: n.results ? round((crm.opportunities / n.results) * 100, 1) : null,
  };
}

// ------------------------------------------------------------ CRM por UTM
/** As chaves do CRM: campanha; campanha+termo (conjunto/grupo); +conteúdo (anúncio). */
export type CrmIndex = {
  campaign: Map<string, CrmCounts>;
  adset: Map<string, CrmCounts>;
  ad: Map<string, CrmCounts>;
};
const SEP = "\u0000";
export const utmKey = (...parts: string[]) => parts.join(SEP);
/** Igual à aba Plataforma (src/platform-crm.ts): nome exato, sem ajustes. */
export function crmIndex(d: CrmUtmDeals | null): CrmIndex | null {
  if (!d) return null;
  const add = (map: Map<string, CrmCounts>, key: string, opp: number, wins: number, revenue: number) => {
    const c = map.get(key) ?? { opportunities: 0, wins: 0, revenue: 0 };
    c.opportunities += opp;
    c.wins += wins;
    c.revenue += revenue;
    map.set(key, c);
  };
  const idx: CrmIndex = { campaign: new Map(), adset: new Map(), ad: new Map() };
  for (const [c, opp, wins, , rev] of d.campaigns) add(idx.campaign, utmKey(c), opp, wins, rev);
  for (const [c, t, opp, wins, , rev] of d.adsets) add(idx.adset, utmKey(c, t), opp, wins, rev);
  for (const [c, t, ct, rows, wins, , rev] of d.ads) add(idx.ad, utmKey(c, t, ct), rows, wins, rev);
  return idx;
}

/** Para comparar nomes "quase iguais": sem acento, caixa, espaços e pontuação. */
export const looseName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

// ------------------------------------------------------------ o material lido
export type Analysis = {
  platform: "meta" | "google";
  basis: Basis;
  multiplier: number;
  windows: Partial<Record<WindowKey, Range>>;
  result_label: string;
  entities: Entity[];
  /** O CRM: ligado e lido, ligado com erro, ou sem ligação. */
  crm: "ok" | "error" | "unlinked" | "off";
  /** Avisos de leitura (conta que não abriu, CRM fora do ar…). */
  notes: string[];
  /** As contas de anúncios lidas (para pausar pela cota). */
  accounts?: string[];
  /** O funil do CRM: lido, sem a consulta no CRM, com erro, ou sem CRM. */
  funnel?: "ok" | "missing" | "error" | "off";
  /** Os rótulos das métricas do funil (stage:…, lost:…, bucket:…, answer:…). */
  labels?: Record<string, string>;
  /** Campanhas cujas UTMs chegam ao CRM com utm_content preenchido. */
  contentCampaigns?: string[];
  /** O efeito medido dos insights aplicados. */
  effects?: { insight: string; effect: Effect }[];
  /** Quantos dias o lead costuma levar até cada etapa que importa (mediana do CRM; nulo: sem histórico). */
  stageDays?: Record<string, number | null>;
  /** Google: termos de pesquisa do ciclo que gastaram sem conversão (candidatos a negativa). */
  negCandidates?: NegCandidate[];
};

/** O total da campanha (as campanhas vinculadas somadas) e a meta do ciclo. */
export function totalEntity(
  m: InsightMaterial,
  a: Pick<Analysis, "entities" | "windows" | "basis">,
): Entity {
  const campaigns = a.entities.filter((e) => e.level === "campaign");
  const n: Entity["n"] = {};
  for (const w of Object.keys(a.windows) as WindowKey[]) {
    const sum = { spend: 0, impressions: 0, clicks: 0, results: 0, value: 0 };
    let crm: CrmCounts | null = null;
    let any = false;
    for (const c of campaigns) {
      const x = c.n[w];
      if (!x) continue;
      any = true;
      sum.spend += numOr(x.spend);
      sum.impressions += numOr(x.impressions);
      sum.clicks += numOr(x.clicks);
      sum.results += numOr(x.results);
      sum.value += numOr(x.value);
      if (x.crm_opportunities !== undefined && x.crm_opportunities !== null) {
        crm ??= { opportunities: 0, wins: 0, revenue: 0 };
        crm.opportunities += numOr(x.crm_opportunities);
        crm.wins += numOr(x.crm_wins);
        crm.revenue += numOr(x.crm_revenue);
      }
    }
    if (any) n[w] = withCrm(derive(sum), crm);
  }
  // A meta do ciclo e o que o MAVI conta (as "Conversões que contam").
  const y = m.cycle;
  const gross = a.basis === "gross";
  const budget = gross ? y.budget : y.budget / (y.multiplier || 1);
  const until = a.windows.cycle?.until ?? addDays(m.today, -1);
  const days = m.daily.filter((d) => d.day >= y.start_date && d.day <= until);
  const spent = days.reduce((s, d) => s + Number(d.spend) * (gross ? Number(d.multiplier) || 1 : 1), 0);
  const results = days.reduce((s, d) => s + Number(d.conversions), 0);
  const total = daysBetween(y.start_date, y.end_date) + 1;
  const elapsed = Math.min(Math.max(daysBetween(y.start_date, until) + 1, 0), total);
  const goalCpa = y.goal_results > 0 ? round(budget / y.goal_results) : null;
  const maviCpa = results > 0 ? round(spent / results) : null;
  n.cycle = {
    ...(n.cycle ?? {}),
    budget: round(budget),
    goal_results: y.goal_results,
    goal_cpa: goalCpa,
    mavi_results: round(results, 2),
    mavi_cpa: maviCpa,
    cost_vs_goal: maviCpa !== null && goalCpa ? round((maviCpa / goalCpa) * 100, 1) : null,
    spend_pace: budget && elapsed ? round((spent / (budget * (elapsed / total))) * 100, 1) : null,
    results_pace:
      y.goal_results && elapsed ? round((results / (y.goal_results * (elapsed / total))) * 100, 1) : null,
    days_elapsed: elapsed,
    days_total: total,
  };
  // As etapas que importam: a soma das campanhas e a meta de custo de cada uma.
  const opp = numOr(n.cycle.crm_opportunities);
  for (const st of m.crm_goal?.stages ?? []) {
    const k = (x: string) => goalMetric(st.stage_id, x);
    const withGoal = campaigns.map((c) => c.n.cycle).filter((x) => x && x[k("leads")] !== undefined);
    if (!withGoal.length) continue;
    const leads = withGoal.reduce((sum, x) => sum + numOr(x![k("leads")]), 0);
    const young = withGoal.reduce((sum, x) => sum + numOr(x![k("young")]), 0);
    const cost = leads ? round(numOr(n.cycle.spend) / leads) : null;
    const target = st.cost_goal ? Number(st.cost_goal) : null;
    n.cycle[k("leads")] = leads;
    n.cycle[k("rate")] = opp ? round((leads / opp) * 100, 1) : null;
    n.cycle[k("cost")] = cost;
    n.cycle[k("young")] = young;
    n.cycle[k("young_rate")] = opp ? round((young / opp) * 100, 1) : null;
    if (target) {
      n.cycle[k("target")] = target;
      n.cycle[k("vs_target")] = cost ? round((cost / target) * 100, 1) : null;
    }
  }
  const withAge = campaigns.map((c) => c.n.cycle).filter((x) => x && x.young_leads !== undefined);
  if (withAge.length) {
    const young = withAge.reduce((sum, x) => sum + numOr(x!.young_leads), 0);
    n.cycle.young_leads = young;
    n.cycle.young_rate = opp ? round((young / opp) * 100, 1) : null;
  }
  return { key: "total", level: "total", name: "Campanha (total)", n };
}

export type GoalStage = {
  pipeline_id: string;
  pipeline_name: string;
  stage_id: string;
  stage_name: string;
  cost_goal: number | null;
};
/** As etapas que importam na campanha: as dela ou, sem elas, as do cliente. */
export type CrmGoal = { source: "campaign" | "client"; stages: GoalStage[] };

/** O valor de uma evidência no material (nulo: não existe). */
export function evidenceValue(
  entities: Map<string, Entity>,
  ref: { entity: string; window: string; metric: string },
  labels: Record<string, string> = {},
) {
  const e = entities.get(ref.entity);
  if (!e || !(ref.metric in METRICS || ref.metric in labels)) return null;
  const v = e.n[ref.window as WindowKey]?.[ref.metric];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ------------------------------------------------------------ insights
export type InsightKind = "highlight" | "opportunity" | "problem" | "tracking";
export type Priority = "high" | "medium" | "low";
export type Evidence = {
  label: string;
  value: number;
  unit: string;
  window: WindowKey;
  entity: string;
  name: string;
  metric: string;
};
export type Insight = {
  kind: InsightKind;
  priority: Priority;
  title: string;
  body: string;
  action: string;
  evidence: Evidence[];
  target: { key: string; level: Level; name: string; parent?: string } | null;
  source: "rule" | "mavi";
  fingerprint: string;
  confidence?: number;
  /** Fase 8: a lista de negativas para copiar. */
  extra?: { negatives: Negative[] };
};

const KINDS: InsightKind[] = ["highlight", "opportunity", "problem", "tracking"];
const PRIORITIES: Priority[] = ["high", "medium", "low"];
export const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
/** tipo#alvo#assunto (as chaves das entidades têm ":"; o assunto é um slug). */
export const fingerprintOf = (kind: string, target: string | null, topic: string) =>
  `${kind}#${target ?? "total"}#${slug(topic) || "geral"}`;
export function fingerprintParts(f: string) {
  const first = f.indexOf("#");
  const last = f.lastIndexOf("#");
  if (first < 0 || last === first) return { kind: f, target: "total", topic: "" };
  return { kind: f.slice(0, first), target: f.slice(first + 1, last), topic: f.slice(last + 1) };
}

/** Monta as evidências pedidas com os valores do material (as que não existem caem). */
export function buildEvidence(
  entities: Map<string, Entity>,
  refs: unknown,
  /** Os rótulos do funil do CRM (stage:…, lost:…, bucket:…, answer:…). */
  labels: Record<string, string> = {},
): Evidence[] {
  if (!Array.isArray(refs)) return [];
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const r of refs.slice(0, 8)) {
    if (!r || typeof r !== "object") continue;
    const ref = r as Row;
    const entity = String(ref.entity ?? "");
    const window = String(ref.window ?? "cycle");
    const metric = String(ref.metric ?? "");
    const value = evidenceValue(entities, { entity, window, metric }, labels);
    const id = `${entity}|${window}|${metric}`;
    if (value === null || seen.has(id)) continue;
    seen.add(id);
    const e = entities.get(entity)!;
    out.push({
      label: labels[metric] ?? METRICS[metric]?.label,
      value,
      unit: unitOf(metric),
      window: window as WindowKey,
      entity,
      name: e.name,
      metric,
    });
  }
  return out;
}

const targetOf = (entities: Map<string, Entity>, key: unknown): Insight["target"] => {
  const e = typeof key === "string" ? entities.get(key) : undefined;
  if (!e || e.level === "total") return null;
  const parent = e.parent ? entities.get(e.parent)?.name : undefined;
  return { key: e.key, level: e.level, name: e.name, ...(parent ? { parent } : {}) };
};

/** "O que fazer": até 3 passos, um por linha. */
export function stepsOf(v: unknown): string {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n+/) : [];
  return list
    .map((x) => (typeof x === "string" ? x.replace(/^\s*(\d+[.)]|[-•*])\s*/, "").trim() : ""))
    .filter(Boolean)
    .slice(0, 3)
    .join("\n")
    .slice(0, 800);
}

/** Lê a resposta da MAVI: só o que é bem formado e tem evidência que confere. */
export function parseInsights(
  text: string,
  entities: Map<string, Entity>,
  max = 6,
  labels: Record<string, string> = {},
): { summary: string; insights: Insight[]; dropped: number } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new InsightsError(502, "A MAVI não devolveu a análise no formato esperado.");
  let raw: Row;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Row;
  } catch {
    throw new InsightsError(502, "A MAVI não devolveu a análise no formato esperado.");
  }
  const list = Array.isArray(raw.insights) ? (raw.insights as Row[]) : [];
  const insights: Insight[] = [];
  let dropped = 0;
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const kind = x.kind as InsightKind;
    const priority = x.priority as Priority;
    const title = typeof x.title === "string" ? x.title.trim().slice(0, 200) : "";
    if (!KINDS.includes(kind) || !PRIORITIES.includes(priority) || title.length < 3) {
      dropped++;
      continue;
    }
    const evidence = buildEvidence(entities, x.evidence, labels);
    if (!evidence.length) {
      dropped++;
      continue;
    }
    const target = targetOf(entities, x.target);
    insights.push({
      kind,
      priority,
      title,
      body: typeof x.body === "string" ? x.body.trim().slice(0, 2000) : "",
      action: stepsOf(x.steps ?? x.action),
      evidence,
      target,
      source: "mavi",
      fingerprint: fingerprintOf(kind, target?.key ?? null, typeof x.topic === "string" ? x.topic : title),
    });
    if (insights.length >= max) break;
  }
  return {
    summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 600) : "",
    insights,
    dropped,
  };
}

/** UTM para o nome do que a plataforma mostra (o padrão da aba Plataforma). */
export const UTM_HINT = {
  meta: "utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}",
  // O Google não tem parâmetro com o nome da campanha ou do grupo (só ids):
  // os nomes vão escritos no sufixo de cada grupo; {keyword} vai no conteúdo.
  google:
    "no sufixo do URL final de cada grupo de anúncios: utm_campaign=<nome exato da campanha>&utm_term=<nome exato do grupo>&utm_content={keyword}",
} as const;

const fmtCount = (v: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(v);

const fmtMoney = (v: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
const fmtPct = (v: number) => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(v)}%`;
const LEVEL_NAME: Partial<Record<Level, string>> = { campaign: "a campanha", adset: "o conjunto", ad: "o anúncio" };

/**
 * As detecções automáticas (sem modelo, sempre conferidas):
 *  - conversões na plataforma e nenhuma oportunidade no CRM com o nome da
 *    campanha (UTM ausente ou errada);
 *  - UTMs do CRM quase iguais ao nome de uma campanha ou conjunto (só a
 *    grafia difere: maiúsculas, acentos, espaços);
 *  - Google: leads no CRM sem a palavra-chave;
 *  - custo por resultado do ciclo bem acima da meta;
 *  - Meta: conjunto em "Aprendizado limitado" que pesa na campanha;
 *  - Meta: anúncio cansado (frequência alta nos últimos 7 dias e taxa de
 *    cliques bem abaixo da dos últimos 30).
 */
export function ruleInsights(m: InsightMaterial, a: Analysis, entities: Map<string, Entity>): Insight[] {
  const out: Insight[] = [];
  const ev = (entity: string, window: WindowKey, metric: string) =>
    buildEvidence(entities, [{ entity, window, metric }], a.labels ?? {});
  if (a.crm === "ok") {
    for (const c of a.entities.filter((e) => e.level === "campaign")) {
      const x = c.n.cycle;
      if (!x || numOr(x.results) < 5 || numOr(x.spend) <= 0 || numOr(x.crm_opportunities) > 0) continue;
      const near = a.entities.find(
        (u) => u.level === "utm" && u.parent === c.key && u.info?.kind === "campaign",
      );
      out.push({
        kind: "tracking",
        priority: "high",
        title: `${c.name}: a plataforma registra leads, mas nenhum chega ao CRM`,
        body: `No ciclo, a plataforma contou ${fmtCount(numOr(x.results))} ${a.result_label.toLowerCase() || "resultados"}, mas nenhum lead com o nome desta campanha entrou no MakeCRM. ${
          near
            ? `Os leads estão chegando com o nome "${near.name}", escrito um pouco diferente, e por isso não contam para a campanha.`
            : "Provavelmente os links dos anúncios estão sem as UTMs (ou com outro nome), ou o formulário não está mandando os leads para o CRM."
        } Sem isso, não dá para saber quais anúncios trazem clientes de verdade.`,
        action: near
          ? `Nos anúncios, troque a UTM "${near.name}" por "${c.name}" (exatamente igual)\nDepois de 1 ou 2 dias, confira se os novos leads aparecem no CRM com o nome certo`
          : `Abra os anúncios e confira os parâmetros de URL: ${UTM_HINT[a.platform]}\nFaça um cadastro de teste e veja se ele chega ao CRM com as UTMs`,
        evidence: [...ev(c.key, "cycle", "results"), ...ev(c.key, "cycle", "crm_opportunities"), ...(near ? ev(near.key, "cycle", "crm_opportunities") : [])],
        target: targetOf(entities, c.key),
        source: "rule",
        fingerprint: fingerprintOf("tracking", c.key, "sem-lead-no-crm"),
      });
    }
    for (const u of a.entities.filter((e) => e.level === "utm")) {
      const owner = u.parent ? entities.get(u.parent) : undefined;
      if (!owner) continue;
      // A campanha sem lead nenhum já fala desta UTM.
      if (owner.level === "campaign" && out.some((i) => i.target?.key === owner.key && i.kind === "tracking")) continue;
      const opp = numOr(u.n.cycle?.crm_opportunities);
      if (opp <= 0) continue;
      out.push({
        kind: "tracking",
        priority: "medium",
        title: `Leads de "${owner.name}" chegam ao CRM com o nome escrito diferente`,
        body: `${fmtCount(opp)} ${opp === 1 ? "lead chegou" : "leads chegaram"} ao MakeCRM com a UTM "${u.name}", quase igual ao nome d${owner.level === "campaign" ? "a campanha" : owner.level === "ad" ? "o anúncio" : "o conjunto"} "${owner.name}". O CRM liga pelo nome exato, então esses leads não contam para ${LEVEL_NAME[owner.level] ?? "ele"} nos relatórios.`,
        action: `Nos parâmetros de URL, troque "${u.name}" por "${owner.name}" (com as mesmas maiúsculas, acentos e espaços)`,
        evidence: [...ev(u.key, "cycle", "crm_opportunities"), ...ev(owner.key, "cycle", "results")],
        target: targetOf(entities, owner.key),
        source: "rule",
        fingerprint: fingerprintOf("tracking", owner.key, `utm-grafia-${slug(u.name)}`),
      });
    }
  }
  // Google: os leads chegam ao CRM sem a palavra-chave (utm_content vazio).
  if (a.crm === "ok" && a.platform === "google") {
    const content = new Set(a.contentCampaigns ?? []);
    for (const c of a.entities.filter((e) => e.level === "campaign")) {
      const opp = numOr(c.n.cycle?.crm_opportunities);
      if (opp <= 0 || content.has(c.name)) continue;
      const groups = new Set(a.entities.filter((e) => e.level === "adset" && e.parent === c.key).map((e) => e.key));
      if (!a.entities.some((e) => e.level === "keyword" && e.parent && groups.has(e.parent))) continue;
      out.push({
        kind: "tracking",
        priority: "low",
        title: `${c.name}: não dá para saber qual palavra-chave trouxe cada lead`,
        body: `${fmtCount(opp)} ${opp === 1 ? "lead chegou" : "leads chegaram"} ao MakeCRM por esta campanha, mas sem a palavra-chave. Com ela, dá para ver quais palavras trazem leads que viram venda e cortar as que só gastam.`,
        action: `No Google Ads, no sufixo do URL final de cada grupo, use: ${UTM_HINT.google.replace(/^no sufixo do URL final de cada grupo de anúncios: /, "")}`,
        evidence: ev(c.key, "cycle", "crm_opportunities"),
        target: targetOf(entities, c.key),
        source: "rule",
        fingerprint: fingerprintOf("tracking", c.key, "google-sem-palavra-chave"),
      });
    }
  }
  const t = entities.get("total")?.n.cycle;
  if (t && numOr(t.days_elapsed) >= 3 && t.goal_cpa) {
    const ratio = t.cost_vs_goal;
    const zero = !numOr(t.mavi_results) && numOr(t.spend) >= 2 * t.goal_cpa;
    if (zero || (ratio !== null && ratio !== undefined && ratio >= 130))
      out.push({
        kind: "problem",
        priority: zero || (ratio ?? 0) >= 160 ? "high" : "medium",
        title: zero ? "O ciclo já gastou e ainda não trouxe resultados" : "Cada resultado está custando mais que a meta",
        body: zero
          ? `O ciclo já investiu ${fmtMoney(numOr(t.spend))}, o suficiente para dois resultados pela meta (${fmtMoney(t.goal_cpa)} cada), e ainda não registrou nenhum resultado que conta.`
          : `Cada resultado do ciclo está custando ${fmtMoney(numOr(t.mavi_cpa))}, ${fmtPct(ratio! - 100)} acima da meta de ${fmtMoney(t.goal_cpa)}. Se continuar assim, o ciclo entrega menos resultados do que o combinado.`,
        action:
          "Veja nos outros insights onde o custo sobe (conjunto, anúncio ou palavra-chave)\nCorte ou ajuste esses itens antes de mexer na verba da campanha",
        evidence: [
          ...ev("total", "cycle", zero ? "spend" : "mavi_cpa"),
          ...ev("total", "cycle", "goal_cpa"),
          ...ev("total", "cycle", "mavi_results"),
        ],
        target: null,
        source: "rule",
        fingerprint: fingerprintOf("problem", null, zero ? "sem-resultados" : "custo-acima-da-meta"),
      });
  }
  // As etapas que importam: a que mais estoura a meta de custo vira o aviso (as outras vão no texto).
  const stages = (m.crm_goal?.stages ?? []).filter((x) => x.cost_goal);
  if (stages.length && t && a.funnel === "ok" && numOr(t.days_elapsed) >= 3) {
    const spend = numOr(t.spend);
    const over = stages
      .map((st) => {
        const k = (x: string) => goalMetric(st.stage_id, x);
        const target = Number(st.cost_goal);
        const leads = numOr(t[k("leads")]);
        const cost = numOr(t[k("cost")]);
        const none = !leads && spend >= 2 * target && t[k("leads")] !== undefined;
        const ratio = none ? Infinity : leads ? cost / target : 0;
        return { st, k, target, leads, cost, none, ratio, young: numOr(t[k("young_rate")]) };
      })
      .filter((x) => x.ratio >= 1.3)
      .sort((x, y) => y.ratio - x.ratio);
    const w = over[0];
    if (w) {
      const days = a.stageDays?.[w.st.stage_id] ?? 7;
      const name = w.st.stage_name;
      const early =
        w.young >= 40
          ? ` Mas ${fmtPct(w.young)} dos leads ainda são recentes (entraram há menos de ${days} dias, o tempo que um lead costuma levar até lá): o número tende a melhorar nos próximos dias.`
          : "";
      const others = over
        .slice(1)
        .map((x) => (x.none ? `"${x.st.stage_name}" (nenhum lead ainda)` : `"${x.st.stage_name}" (${fmtMoney(x.cost)}, meta ${fmtMoney(x.target)})`));
      out.push({
        kind: "problem",
        priority: w.young >= 40 ? "medium" : "high",
        title: w.none
          ? `O ciclo já gastou e nenhum lead chegou a "${name}"`
          : `Cada lead que chega a "${name}" está custando mais que a meta`,
        body:
          (w.none
            ? `O ciclo investiu ${fmtMoney(spend)}, o suficiente para 2 leads em "${name}" pela meta (${fmtMoney(w.target)} cada), e nenhum chegou lá ainda.`
            : `Cada lead que chega a "${name}" está custando ${fmtMoney(w.cost)}, ${fmtPct((w.ratio - 1) * 100)} acima da meta de ${fmtMoney(w.target)}. É essa etapa que mostra se o tráfego traz clientes de verdade.`) +
          (others.length ? ` Também acima da meta: ${others.join(", ")}.` : "") +
          early,
        action:
          "Veja nos outros insights quais conjuntos e anúncios trazem leads que avançam até a etapa\nTire verba dos que trazem leads que param no começo do funil",
        evidence: [
          ...ev("total", "cycle", w.none ? "spend" : w.k("cost")),
          ...ev("total", "cycle", w.k("target")),
          ...ev("total", "cycle", w.k("leads")),
          ...(w.young >= 40 ? ev("total", "cycle", w.k("young_rate")) : []),
        ],
        target: null,
        source: "rule",
        fingerprint: fingerprintOf("problem", null, w.none ? "etapa-sem-leads" : "etapa-acima-da-meta"),
      });
    }
  }
  if (a.platform === "meta") {
    const spendOf = (e: Entity, w: WindowKey) => numOr(e.n[w]?.spend);
    const campaignSpend = (w: WindowKey) =>
      a.entities.filter((e) => e.level === "campaign").reduce((sum, e) => sum + spendOf(e, w), 0);
    // Aprendizado limitado: o conjunto não junta resultados para a entrega se estabilizar.
    const total7 = campaignSpend("d7");
    for (const e of a.entities.filter((x) => x.level === "adset" && x.status === "Aprendizado limitado")) {
      if (!total7 || spendOf(e, "d7") < total7 * 0.1) continue;
      out.push({
        kind: "problem",
        priority: "medium",
        title: `O conjunto "${e.name}" está travado em "Aprendizado limitado"`,
        body: `O Meta avisa que este conjunto não consegue juntar resultados suficientes (cerca de 50 por semana) para a entrega se estabilizar. Enquanto isso, o custo tende a oscilar e ficar mais alto. Ele recebeu ${fmtPct((spendOf(e, "d7") / total7) * 100)} do investimento da campanha nos últimos 7 dias.`,
        action:
          "Junte este conjunto com outro parecido, para somar os resultados\nOu amplie o público (menos filtros de interesse e idade)\nOu otimize para um evento que acontece mais vezes (ex.: lead em vez de compra)",
        evidence: [...ev(e.key, "d7", "results"), ...ev(e.key, "d7", "spend"), ...ev(e.key, "d7", "cpa")],
        target: targetOf(entities, e.key),
        source: "rule",
        fingerprint: fingerprintOf("problem", e.key, "aprendizado-limitado"),
      });
    }
    // Anúncio cansado: o público já viu demais e clica menos.
    for (const e of a.entities.filter((x) => x.level === "ad")) {
      const w7 = e.n.d7;
      const w30 = e.n.d30;
      if (!w7 || !w30 || !total7) continue;
      if (spendOf(e, "d7") < total7 * 0.05 || numOr(w7.impressions) < 2000 || numOr(w30.clicks) < 30) continue;
      const freq = numOr(w7.frequency);
      const ctr7 = numOr(w7.ctr);
      const ctr30 = numOr(w30.ctr);
      if (freq < 3 || !ctr30 || ctr7 > ctr30 * 0.75) continue;
      out.push({
        kind: "problem",
        priority: "medium",
        title: `O anúncio "${e.name}" está cansando o público`,
        body: `Nos últimos 7 dias, cada pessoa viu este anúncio ${fmtCount(freq)} vezes, em média, e a taxa de cliques caiu para ${fmtPct(ctr7)}, contra ${fmtPct(ctr30)} nos últimos 30 dias. Quando o público já viu demais, clica menos e o custo por lead sobe.`,
        action:
          "Crie uma variação do anúncio com outra imagem ou outro começo de vídeo, mantendo a mesma oferta\nSe a campanha tiver outros anúncios bons, deixe este com menos peso ou pause",
        evidence: [...ev(e.key, "d7", "frequency"), ...ev(e.key, "d7", "ctr"), ...ev(e.key, "d30", "ctr")],
        target: targetOf(entities, e.key),
        source: "rule",
        fingerprint: fingerprintOf("problem", e.key, "anuncio-cansado"),
      });
    }
  }
  return out.filter((i) => i.evidence.length > 0);
}

/**
 * Amostra mínima: um insight da MAVI (fora rastreamento) só fica se o item de
 * que fala tem número suficiente numa das janelas citadas — resultados, ou
 * metade disso em oportunidades no CRM, ou o investimento de 2 resultados da
 * meta (para os que gastam sem trazer nada).
 */
export function sampleOk(i: Insight, entities: Map<string, Entity>, min: number) {
  if (min <= 0 || i.kind === "tracking") return true;
  const key = i.target?.key ?? "total";
  const e = entities.get(key);
  if (!e) return true;
  const goal = numOr(entities.get("total")?.n.cycle?.goal_cpa);
  const windows = new Set<WindowKey>(i.evidence.filter((x) => x.entity === key).map((x) => x.window));
  if (!windows.size) windows.add("cycle");
  return [...windows].some((w) => {
    const n = e.n[w];
    if (!n) return false;
    return (
      numOr(n.results) >= min ||
      numOr(n.crm_opportunities) >= Math.ceil(min / 2) ||
      (goal > 0 && numOr(n.spend) >= 2 * goal)
    );
  });
}

/** A ordem final: pela prioridade, mantendo a ordem de cada um (detecções e depois a MAVI), até o limite. */
export function rankInsights(list: Insight[], max: number) {
  const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => order[a.x.priority] - order[b.x.priority] || a.i - b.i)
    .slice(0, max)
    .map(({ x }) => x);
}

// ------------------------------------------------------------ leitura do Meta
/** Quantos itens de cada nível vão para a MAVI (os que mais pesam). */
export type Limits = { adsets: number; ads: number; keywords: number; terms: number; segments: number };
export const LIMITS: Limits = { adsets: 15, ads: 15, keywords: 15, terms: 12, segments: 12 };
const ZERO: CrmCounts = { opportunities: 0, wins: 0, revenue: 0 };

function metaNumbers(x: PlatformMetrics, k: number): Numbers {
  const money = (v: unknown) => numOr(v) * k;
  return derive({
    spend: money(x.spend),
    impressions: numOr(x.impressions),
    reach: x.reach === null || x.reach === undefined ? null : numOr(x.reach),
    clicks: numOr(x.link_clicks ?? x.clicks),
    results: numOr(x.results),
    value: x.purchase_value ? money(x.purchase_value) : null,
  });
}
/** Os números de cada janela, com o CRM só no ciclo (é a janela que o CRM lê). */
function windowNumbers(
  windows: Record<string, PlatformMetrics>,
  numbers: (x: PlatformMetrics) => Numbers,
  counts: CrmCounts | undefined,
): Entity["n"] {
  return Object.fromEntries(
    Object.entries(windows).map(([w, x]) => [w, withCrm(numbers(x), w === "cycle" ? counts : undefined)]),
  );
}
const delivered = (e: Entity) =>
  Object.values(e.n).some((x) => numOr(x?.spend) > 0 || numOr(x?.results) > 0 || numOr(x?.impressions) > 0);

export type MetaRead = { campaigns: WindowRow[]; adsets: WindowRow[]; ads: WindowRow[] };
/** As linhas do Meta (uma leitura por nível, todas as janelas) viram entidades com o CRM ao lado. */
export function metaEntities(
  read: MetaRead,
  crm: CrmIndex | null,
  k: number,
  limits: Limits = LIMITS,
  /** A conta lida (para buscar os criativos com o token dela). */
  account?: string,
): Entity[] {
  const out: Entity[] = [];
  const nums = (x: PlatformMetrics) => metaNumbers(x, k);
  for (const r of read.campaigns)
    out.push({
      key: `c:${r.id}`,
      level: "campaign",
      name: r.name,
      utm: utmKey(r.name),
      status: r.delivery?.label,
      info: {
        ...(r.objective ? { objetivo: r.objective } : {}),
        ...(r.result_label ? { resultado: r.result_label } : {}),
      },
      n: windowNumbers(r.windows, nums, crm ? (crm.campaign.get(utmKey(r.name)) ?? ZERO) : undefined),
    });
  for (const r of read.adsets)
    out.push({
      key: `s:${r.id}`,
      level: "adset",
      name: r.name,
      parent: `c:${r.campaign_id}`,
      utm: utmKey(r.campaign_name, r.name),
      status: r.delivery?.label,
      info: {
        ...(r.optimization ? { otimizacao: r.optimization } : {}),
        ...(r.result_label ? { resultado: r.result_label } : {}),
      },
      n: windowNumbers(
        r.windows,
        nums,
        crm ? (crm.adset.get(utmKey(r.campaign_name, r.name)) ?? ZERO) : undefined,
      ),
    });
  for (const r of read.ads)
    out.push({
      key: `a:${r.id}`,
      level: "ad",
      name: r.name,
      parent: `s:${r.adset_id}`,
      utm: utmKey(r.campaign_name, r.adset_name ?? "", r.name),
      ...(r.creative?.id && account ? { source: { creative: r.creative.id, account } } : {}),
      status: r.delivery?.label,
      info: {
        ...(r.creative?.title ? { titulo: r.creative.title.slice(0, 160) } : {}),
        ...(r.creative?.body ? { texto: r.creative.body.slice(0, 300) } : {}),
        ...(r.creative?.cta ? { cta: r.creative.cta } : {}),
        ...(r.creative?.type ? { formato: r.creative.type } : {}),
      },
      n: windowNumbers(
        r.windows,
        nums,
        crm ? (crm.ad.get(utmKey(r.campaign_name, r.adset_name ?? "", r.name)) ?? ZERO) : undefined,
      ),
    });
  // O público (idade × gênero) dos conjuntos que mais investiram: os 4 maiores de cada.
  const top = [...read.adsets]
    .filter((r) => r.breakdown?.length)
    .sort((a, b) => numOr(b.windows.cycle?.spend) - numOr(a.windows.cycle?.spend))
    .slice(0, Math.ceil(limits.segments / 4));
  for (const r of top)
    for (const seg of [...(r.breakdown ?? [])]
      .sort((a, b) => numOr(b.metrics.spend) - numOr(a.metrics.spend))
      .slice(0, 4))
      out.push({
        key: `g:${r.id}:${seg.key}`,
        level: "segment",
        name: `${r.name} · ${seg.label}`,
        parent: `s:${r.id}`,
        info: { publico: seg.label },
        n: { cycle: metaNumbers(seg.metrics, k) },
      });
  return focus(out, limits);
}

/**
 * Só o que pesa vai para a MAVI: as campanhas sempre; os demais itens com ao
 * menos 2% do investimento do ciclo ou com oportunidades no CRM — e, dentro
 * de cada nível, os maiores até o limite (os com CRM primeiro).
 */
export function focus(list: Entity[], limits: Limits = LIMITS) {
  const total = list.filter((e) => e.level === "campaign").reduce((s, e) => s + numOr(e.n.cycle?.spend), 0);
  const spendOf = (e: Entity) => numOr(e.n.cycle?.spend ?? e.n.d7?.spend);
  const crmOf = (e: Entity) => numOr(e.n.cycle?.crm_opportunities);
  const matters = (e: Entity) =>
    e.level === "campaign" ||
    e.level === "total" ||
    e.level === "utm" ||
    (delivered(e) && (crmOf(e) > 0 || (total > 0 ? spendOf(e) >= total * 0.02 : true)));
  const caps: Partial<Record<Level, number>> = {
    adset: limits.adsets,
    ad: limits.ads,
    keyword: limits.keywords,
    search_term: limits.terms,
    segment: limits.segments,
  };
  const kept = list.filter(matters);
  const allowed = new Set<string>();
  for (const [level, cap] of Object.entries(caps) as [Level, number][])
    kept
      .filter((e) => e.level === level)
      .sort((a, b) => Number(crmOf(b) > 0) - Number(crmOf(a) > 0) || spendOf(b) - spendOf(a))
      .slice(0, cap)
      .forEach((e) => allowed.add(e.key));
  return kept.filter((e) => !(e.level in caps) || allowed.has(e.key));
}

// ------------------------------------------------------------ leitura do Google
function googleNumbers(x: PlatformMetrics, k: number): Numbers {
  return derive({
    spend: numOr(x.cost) * k,
    impressions: numOr(x.impressions),
    clicks: numOr(x.clicks),
    results: numOr(x.conversions),
    value: x.conversions_value ? numOr(x.conversions_value) * k : null,
  });
}

/** As visões lidas no Google (uma consulta por visão, todas as janelas). */
export const GOOGLE_VIEWS = ["campaigns", "ad_groups", "ads", "keywords", "search_terms", "age", "gender"] as const;
export type GoogleRead = { view: (typeof GOOGLE_VIEWS)[number]; rows: GoogleWindowRow[] };
export function googleEntities(reads: GoogleRead[], crm: CrmIndex | null, k: number, limits: Limits = LIMITS): Entity[] {
  const out: Entity[] = [];
  const nums = (x: PlatformMetrics) => googleNumbers(x, k);
  for (const read of reads) {
    for (const r of read.rows) {
      let key: string;
      let level: Level;
      let parent: string | undefined;
      let counts: CrmCounts | undefined;
      let utm: string | undefined;
      let source: Entity["source"];
      const info: Record<string, string> = {};
      switch (read.view) {
        case "campaigns":
          key = `c:${r.id}`;
          level = "campaign";
          utm = utmKey(r.name);
          if (r.info.type) info.tipo = String(r.info.type);
          if (r.info.bidding) info.lance = String(r.info.bidding);
          if (crm) counts = crm.campaign.get(utmKey(r.name)) ?? ZERO;
          break;
        case "ad_groups":
          key = `s:${r.id}`;
          level = "adset";
          parent = `c:${r.campaign_id}`;
          utm = utmKey(String(r.info.campaign ?? ""), r.name);
          if (crm) counts = crm.adset.get(utm) ?? ZERO;
          break;
        case "ads":
          key = `a:${r.id}`;
          level = "ad";
          parent = `s:${r.ad_group_id}`;
          if (r.preview?.headlines?.length) info.titulos = r.preview.headlines.slice(0, 5).join(" | ").slice(0, 300);
          if (r.preview?.descriptions?.length)
            info.descricoes = r.preview.descriptions.slice(0, 3).join(" | ").slice(0, 300);
          if (r.info.strength) info.forca = String(r.info.strength);
          if (r.preview?.images?.[0]) source = { image: r.preview.images[0] };
          break;
        case "keywords":
          key = `k:${r.id}`;
          level = "keyword";
          parent = `s:${r.ad_group_id}`;
          if (r.info.match) info.correspondencia = String(r.info.match);
          if (r.info.quality !== null && r.info.quality !== undefined) info.qualidade = String(r.info.quality);
          // A palavra no utm_content ({keyword}): grupo + campanha pelo nome, a palavra sem [ ] nem aspas.
          if (crm) {
            const found = keywordCrm(crm, String(r.info.campaign ?? ""), String(r.info.ad_group ?? ""), r.name);
            if (found) {
              utm = found.key;
              counts = found.counts;
            }
          }
          break;
        case "search_terms":
          key = `t:${r.id}`;
          level = "search_term";
          parent = r.ad_group_id ? `s:${r.ad_group_id}` : undefined;
          if (r.info.keyword) info.palavra_chave = String(r.info.keyword);
          if (r.info.added) info.situacao = String(r.info.added);
          break;
        default:
          // age / gender: o público das campanhas vinculadas.
          key = `g:${read.view}:${r.id}`;
          level = "segment";
          info.publico = r.name;
          break;
      }
      out.push({
        key,
        level,
        name: level === "segment" ? `${read.view === "age" ? "Idade" : "Gênero"} · ${r.name}` : r.name,
        ...(parent ? { parent } : {}),
        ...(utm ? { utm } : {}),
        ...(source ? { source } : {}),
        status: r.status?.label || undefined,
        info,
        n: windowNumbers(r.windows, nums, counts),
      });
    }
  }
  return focus(out, limits);
}

export type NegCandidate = {
  ref: string;
  term: string;
  campaign: string;
  keyword: string;
  spend: number;
  clicks: number;
};
export type Negative = {
  term: string;
  match: "exact" | "phrase";
  spend: number;
  clicks: number;
  campaign: string;
  why: string;
};
/**
 * Os termos de pesquisa do ciclo que gastaram sem nenhuma conversão e ainda
 * não foram negativados (somados por campanha + termo), do maior gasto para o
 * menor: a partir de 30% do custo por resultado da meta (mín. R$ 5; sem meta,
 * R$ 10). A MAVI só escolhe entre eles.
 */
export function negativeCandidates(reads: GoogleRead[], k: number, goalCpa: number | null, max = 40): NegCandidate[] {
  const min = goalCpa ? Math.max(goalCpa * 0.3, 5) : 10;
  const sum = new Map<string, Omit<NegCandidate, "ref"> & { conversions: number }>();
  for (const read of reads) {
    if (read.view !== "search_terms") continue;
    for (const r of read.rows) {
      if (r.status?.code === "EXCLUDED" || r.status?.code === "ADDED_EXCLUDED") continue;
      const x = r.windows.cycle;
      if (!x) continue;
      const campaign = String(r.info.campaign ?? "");
      const id = `${campaign}\u0000${r.name.trim().toLowerCase()}`;
      const cur = sum.get(id) ?? { term: r.name.trim(), campaign, keyword: String(r.info.keyword ?? ""), spend: 0, clicks: 0, conversions: 0 };
      cur.spend += numOr(x.cost) * k;
      cur.clicks += numOr(x.clicks);
      cur.conversions += numOr(x.conversions);
      sum.set(id, cur);
    }
  }
  return [...sum.values()]
    .filter((t) => t.conversions === 0 && t.spend >= min && t.term)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, max)
    .map(({ conversions: _c, ...t }, i) => ({ ...t, ref: `N${i + 1}`, spend: round(t.spend) }));
}

/** As negativas que a MAVI escolheu (só entre as candidatas). */
export function parseNegatives(text: string, candidates: NegCandidate[]): Negative[] {
  if (!candidates.length) return [];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: Row;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Row;
  } catch {
    return [];
  }
  const byRef = new Map(candidates.map((c) => [c.ref, c]));
  const seen = new Set<string>();
  const out: Negative[] = [];
  for (const x of Array.isArray(raw.negatives) ? (raw.negatives as Row[]) : []) {
    const c = byRef.get(String(x?.ref ?? ""));
    if (!c || seen.has(c.ref)) continue;
    seen.add(c.ref);
    out.push({
      term: c.term,
      match: x.match === "phrase" ? "phrase" : "exact",
      spend: c.spend,
      clicks: c.clicks,
      campaign: c.campaign,
      why: typeof x.why === "string" ? x.why.trim().slice(0, 160) : "",
    });
  }
  return out;
}

/** Um insight só com as negativas: o gasto somado e a lista para copiar. */
export function negativesInsight(a: Analysis, picked: Negative[], entities: Map<string, Entity>): Insight | null {
  if (!picked.length) return null;
  const spend = round(picked.reduce((s, n) => s + n.spend, 0));
  const total = numOr(entities.get("total")?.n.cycle?.spend);
  const share = total ? (spend / total) * 100 : 0;
  const n = picked.length;
  const name = entities.get("total")?.name ?? "Campanha";
  return {
    kind: "opportunity",
    priority: share >= 10 ? "high" : "medium",
    title: `Negativar ${n === 1 ? "1 termo de pesquisa" : `${n} termos de pesquisa`} que gastaram ${fmtMoney(spend)} sem converter`,
    body: `${n === 1 ? "Este termo acionou" : "Estes termos acionaram"} os anúncios, gastaram ${fmtMoney(spend)} no ciclo${share >= 1 ? ` (${fmtPct(share)} do investimento)` : ""} e não trouxeram nenhuma conversão — e não têm a ver com o que o cliente vende. Negativando, essa verba vai para as buscas que convertem.`,
    action:
      'Clique em "Copiar negativas" e confira a lista\nNo Google Ads, em Palavras-chave › Palavras-chave negativas, cole no nível da campanha\nDaqui a 7 dias, veja se o custo por resultado caiu',
    evidence: [
      { label: "Gasto dos termos sem conversão", value: spend, unit: "money", window: "cycle", entity: "total", name, metric: "negatives_spend" },
      { label: "Termos para negativar", value: n, unit: "count", window: "cycle", entity: "total", name, metric: "negatives_count" },
      ...(total
        ? [{ label: "Do investimento do ciclo", value: round(share, 1), unit: "pct", window: "cycle" as WindowKey, entity: "total", name, metric: "negatives_share" }]
        : []),
    ],
    target: null,
    source: "mavi",
    fingerprint: fingerprintOf("opportunity", null, "negativas-termos-de-pesquisa"),
    extra: { negatives: picked },
  };
}

/**
 * A linha do CRM de uma palavra-chave do Google: utm_content = {keyword}
 * (a palavra como está na conta, sem os sinais da correspondência), dentro
 * da campanha e do grupo pelo nome exato.
 */
export function keywordCrm(crm: CrmIndex, campaign: string, adGroup: string, keyword: string) {
  const prefix = utmKey(campaign, adGroup, "");
  const want = looseName(keyword);
  if (!want) return null;
  for (const [key, counts] of crm.ad)
    if (key.startsWith(prefix) && looseName(key.slice(prefix.length)) === want) return { key, counts };
  return null;
}

/**
 * O funil do CRM em cada entidade com UTM (só no ciclo, a janela que o CRM
 * lê): abertas, ganhas, perdidas, taxa de perda, qualificadas e pontuação;
 * e as métricas com rótulo — stage:<id> (chegaram àquela etapa ou além, no
 * funil dela), lost:<id> (motivo), bucket:<id> (faixa da qualificação) e,
 * em campanhas e conjuntos, answer:<id> (as respostas mais escolhidas).
 * Devolve os rótulos usados.
 */
/** Abertas mais novas que T dias (pelas faixas de idade do CRM: 0-3, 4-7, 8-14, 15-30, 31+). */
const AGE_END: Record<string, number> = { "0": 3, "4": 7, "8": 14, "15": 30 };
export function youngOf(ages: Record<string, number> | null, days: number) {
  return Object.entries(ages ?? {}).reduce((sum, [k, v]) => sum + (AGE_END[k] !== undefined && AGE_END[k] < days ? v : 0), 0);
}
/** Os dias típicos até uma etapa (mediana do CRM; nulo: sem histórico). */
export const typicalDays = (funnel: CrmFunnel, stage: string | null | undefined) => {
  const d = stage ? funnel.stage_days?.[stage]?.median : undefined;
  return typeof d === "number" && d > 0 ? Math.max(Math.round(d), 1) : null;
};
/** Os dias típicos de cada etapa que importa. */
export const stageDaysOf = (funnel: CrmFunnel, goal: CrmGoal | null | undefined) =>
  Object.fromEntries((goal?.stages ?? []).map((st) => [st.stage_id, typicalDays(funnel, st.stage_id)]));

export function applyFunnel(entities: Entity[], funnel: CrmFunnel, goal?: CrmGoal | null): Record<string, string> {
  const labels: Record<string, string> = {};
  const rows = new Map<string, CrmFunnelRow>();
  for (const r of funnel.rows)
    rows.set(`${r.l}|${r.l === "c" ? utmKey(r.c) : r.l === "s" ? utmKey(r.c, r.t) : utmKey(r.c, r.t, r.n)}`, r);
  const pipelines = new Map(funnel.pipelines.map((p) => [p.id, p.name]));
  const manyPipelines = new Set(funnel.stages.map((x) => x.pipeline_id)).size > 1;
  const stages = funnel.stages
    .slice()
    .sort((a, b) => a.pipeline_id.localeCompare(b.pipeline_id) || (a.order ?? 0) - (b.order ?? 0));
  const byPipeline = new Map<string, typeof stages>();
  for (const st of stages) byPipeline.set(st.pipeline_id, [...(byPipeline.get(st.pipeline_id) ?? []), st]);
  const reasons = new Map(funnel.reasons.map((r) => [r.id, r.name]));
  const manyForms = new Set(funnel.buckets.map((b) => b.form)).size > 1;
  const buckets = new Map(funnel.buckets.map((b) => [b.id, manyForms ? `${b.name} (${b.form})` : b.name]));
  const options = new Map(funnel.options.map((o) => [o.id, o]));
  // Cada etapa que importa: ela e as de ordem maior no mesmo funil ("chegou lá ou além").
  const goals = (goal?.stages ?? []).map((st) => {
    const found = funnel.stages.find((x) => x.id === st.stage_id);
    const ids = found
      ? (byPipeline.get(found.pipeline_id) ?? []).filter((x) => (x.order ?? 0) >= (found.order ?? 0)).map((x) => x.id)
      : [st.stage_id];
    const days = typicalDays(funnel, st.stage_id) ?? 7;
    const k = (x: string) => goalMetric(st.stage_id, x);
    const name = st.stage_name;
    labels[k("leads")] = `Leads que chegaram a "${name}" (etapa que importa)`;
    labels[k("rate")] = `Leads que chegam a "${name}" (%)`;
    labels[k("cost")] = `Custo por lead que chega a "${name}"`;
    labels[k("target")] = `Meta de custo por lead em "${name}"`;
    labels[k("vs_target")] = `Custo por lead em "${name}" em relação à meta`;
    labels[k("young")] = `Leads abertos há menos de ${days} dias (cedo para chegar a "${name}")`;
    labels[k("young_rate")] = `Leads abertos há menos de ${days} dias (cedo para "${name}", %)`;
    return { st, ids, days, k };
  });
  // A maturidade geral: pelo tempo típico da primeira etapa escolhida (sem histórico: 7 dias).
  const days = goals[0]?.days ?? 7;
  const level = (e: Entity) =>
    e.level === "campaign" ? "c" : e.level === "adset" ? "s" : e.level === "ad" || e.level === "keyword" ? "a" : null;
  for (const e of entities) {
    const l = level(e);
    if (!l || !e.utm) continue;
    const r = rows.get(`${l}|${e.utm}`);
    if (!r) continue;
    const n: Numbers = {
      crm_open: r.open,
      crm_won_deals: r.won,
      crm_lost: r.lost,
      crm_lost_rate: r.deals ? round((r.lost / r.deals) * 100, 1) : null,
      ...(r.qualified ? { crm_qualified: r.qualified, crm_score: r.score } : {}),
    };
    for (const g of goals) {
      const reached = g.ids.reduce((sum, id) => sum + (r.reach?.[id] ?? 0), 0);
      const spend = numOr(e.n.cycle?.spend);
      n[g.k("leads")] = reached;
      n[g.k("rate")] = r.deals ? round((reached / r.deals) * 100, 1) : null;
      n[g.k("cost")] = reached ? round(spend / reached) : null;
      if (g.st.cost_goal && reached) n[g.k("vs_target")] = round((spend / reached / Number(g.st.cost_goal)) * 100, 1);
      if (r.ages) {
        const young = youngOf(r.ages, g.days);
        n[g.k("young")] = young;
        n[g.k("young_rate")] = r.deals ? round((young / r.deals) * 100, 1) : null;
      }
    }
    if (r.ages) {
      labels.young_leads = `Leads abertos há menos de ${days} dias${goals[0] ? ` (cedo para chegar a "${goals[0].st.stage_name}")` : ""}`;
      labels.young_rate = `Leads abertos há menos de ${days} dias (%)`;
      const young = youngOf(r.ages, days);
      n.young_leads = young;
      n.young_rate = r.deals ? round((young / r.deals) * 100, 1) : null;
    }
    // Chegaram à etapa ou além: a soma das etapas de ordem igual ou maior, no mesmo funil.
    if (r.reach)
      for (const [pipeline, list] of byPipeline) {
        list.forEach((st, i) => {
          if (i === 0) return; // a primeira: todas
          const total = list.slice(i).reduce((sum, x) => sum + (r.reach?.[x.id] ?? 0), 0);
          if (!total) return;
          const key = `stage:${st.id}`;
          n[key] = total;
          labels[key] = `Chegaram a "${st.name}" ou além${manyPipelines ? ` (${pipelines.get(pipeline) ?? "funil"})` : ""}`;
        });
      }
    for (const [id, k] of Object.entries(r.lost_by ?? {})) {
      const key = `lost:${id}`;
      n[key] = k;
      labels[key] = `Perdidas por "${reasons.get(id) ?? "motivo removido"}"`;
    }
    for (const [id, k] of Object.entries(r.buckets ?? {})) {
      const key = `bucket:${id}`;
      n[key] = k;
      labels[key] = `Qualificação "${buckets.get(id) ?? "faixa removida"}"`;
    }
    if (l !== "a")
      for (const [id, k] of Object.entries(r.answers ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)) {
        const o = options.get(id);
        if (!o) continue;
        const key = `answer:${id}`;
        n[key] = k;
        labels[key] = `Responderam "${o.label}" em "${o.question}"`;
      }
    e.n.cycle = { ...(e.n.cycle ?? {}), ...n };
  }
  return labels;
}

/**
 * As UTMs do CRM que quase batem com um nome lido (mesma grafia solta,
 * exata diferente): viram entidades "utm" para as evidências.
 */
export function nearMissUtms(entities: Entity[], crm: CrmIndex | null): Entity[] {
  if (!crm) return [];
  const out: Entity[] = [];
  const campaigns = entities.filter((e) => e.level === "campaign");
  const exactCampaigns = new Set(campaigns.map((c) => c.name));
  const looseCampaigns = new Map(campaigns.map((c) => [looseName(c.name), c]));
  for (const [key, counts] of crm.campaign) {
    const [name] = key.split(SEP);
    if (exactCampaigns.has(name)) continue;
    const owner = looseCampaigns.get(looseName(name));
    if (!owner || !counts.opportunities) continue;
    out.push({
      key: `u:${out.length + 1}`,
      level: "utm",
      name,
      parent: owner.key,
      info: { kind: "campaign" },
      n: { cycle: withCrm({ spend: 0 }, counts) },
    });
  }
  // Conjuntos: dentro das campanhas que batem pelo nome exato.
  const adsets = entities.filter((e) => e.level === "adset");
  for (const [key, counts] of crm.adset) {
    const [campaign, term] = key.split(SEP);
    if (!exactCampaigns.has(campaign) || !counts.opportunities) continue;
    const inCampaign = adsets.filter((s) => entities.find((c) => c.key === s.parent)?.name === campaign);
    if (inCampaign.some((s) => s.name === term)) continue;
    const owner = inCampaign.find((s) => looseName(s.name) === looseName(term));
    if (!owner) continue;
    out.push({
      key: `u:${out.length + 1}`,
      level: "utm",
      name: term,
      parent: owner.key,
      info: { kind: "adset" },
      n: { cycle: withCrm({ spend: 0 }, counts) },
    });
  }
  return out.slice(0, 10);
}

// ------------------------------------------------------------ antes × depois
export type Effect = {
  /** Dias de cada lado (os mesmos antes e depois de aplicar). */
  days: number;
  before: Numbers;
  after: Numbers;
  /** Variação (%) do custo por resultado, dos resultados por dia e do CTR. */
  change: { cpa: number | null; results_per_day: number | null; ctr: number | null };
  verdict: "better" | "worse" | "neutral";
  money_basis?: Basis;
};
export type EffectPlan = {
  id: string;
  level: "campaign" | "adset" | "ad" | "keyword" | "total";
  target: string | null;
  days: number;
  before: WindowRange;
  after: WindowRange;
};
/**
 * Os períodos de cada insight aplicado: os N dias antes de aplicar e os N
 * depois (N = os dias desde então, até 14; mínimo de 3). Entram na mesma
 * leitura da plataforma (mais períodos na mesma chamada, sem chamada a mais).
 */
export function effectPlans(m: InsightMaterial): EffectPlan[] {
  const yesterday = addDays(m.today, -1);
  return (m.applied ?? []).flatMap((a): EffectPlan[] => {
    const day = localDay(a.applied_at, m.timezone);
    const after = daysBetween(day, yesterday) + 1;
    if (after < 3) return [];
    const days = Math.min(after, 14);
    const level = (["campaign", "adset", "ad", "keyword"] as const).find((l) => l === a.target?.level) ?? "total";
    const short = a.id.replace(/-/g, "").slice(0, 8);
    return [
      {
        id: a.id,
        level,
        target: level === "total" ? null : a.target!.key,
        days,
        before: { key: `b:${short}`, since: addDays(day, -days), until: addDays(day, -1) },
        after: { key: `x:${short}`, since: day, until: addDays(day, days - 1) },
      },
    ];
  });
}
export const plannedRanges = (plans: EffectPlan[], level: "campaign" | "adset" | "ad" | "keyword") =>
  plans.filter((p) => (p.level === "total" ? "campaign" : p.level) === level).flatMap((p) => [p.before, p.after]);

/** O efeito: a variação do custo por resultado (ou, sem resultados, dos resultados por dia). */
export function effectOf(before: Numbers, after: Numbers, days: number, basis?: Basis): Effect {
  const pct = (a: number | null | undefined, b: number | null | undefined) =>
    a === null || a === undefined || b === null || b === undefined || !a ? null : round(((b - a) / a) * 100, 1);
  const perDay = (n: Numbers) => (n.results === null || n.results === undefined ? null : n.results / days);
  const keep = (n: Numbers) =>
    Object.fromEntries(["spend", "results", "cpa", "ctr", "cpc"].map((k) => [k, n[k] ?? null])) as Numbers;
  const change = {
    cpa: before.results && after.results ? pct(before.cpa, after.cpa) : null,
    results_per_day: pct(perDay(before), perDay(after)),
    ctr: pct(before.ctr, after.ctr),
  };
  const verdict: Effect["verdict"] =
    change.cpa !== null
      ? change.cpa <= -10
        ? "better"
        : change.cpa >= 10
          ? "worse"
          : "neutral"
      : change.results_per_day !== null
        ? change.results_per_day >= 10
          ? "better"
          : change.results_per_day <= -10
            ? "worse"
            : "neutral"
        : "neutral";
  return { days, before: keep(before), after: keep(after), change, verdict, ...(basis ? { money_basis: basis } : {}) };
}

/** Mede os aplicados e tira os períodos de medida das entidades (não vão para a MAVI). */
export function measureEffects(plans: EffectPlan[], entities: Entity[], basis?: Basis) {
  const out: { insight: string; effect: Effect }[] = [];
  const at = (e: Entity, key: string) => (e.n as Record<string, Numbers | undefined>)[key];
  const sum = (key: string) => {
    const list = entities.filter((e) => e.level === "campaign").map((e) => at(e, key)).filter(Boolean) as Numbers[];
    if (!list.length) return undefined;
    return derive({
      spend: list.reduce((s, x) => s + numOr(x.spend), 0),
      impressions: list.reduce((s, x) => s + numOr(x.impressions), 0),
      clicks: list.reduce((s, x) => s + numOr(x.clicks), 0),
      results: list.reduce((s, x) => s + numOr(x.results), 0),
    });
  };
  for (const p of plans) {
    const e = p.target ? entities.find((x) => x.key === p.target) : null;
    const before = p.target ? (e ? at(e, p.before.key) : undefined) : sum(p.before.key);
    const after = p.target ? (e ? at(e, p.after.key) : undefined) : sum(p.after.key);
    if (before && after) out.push({ insight: p.id, effect: effectOf(before, after, p.days, basis) });
  }
  for (const e of entities)
    for (const k of Object.keys(e.n)) if (/^[bx]:/.test(k)) delete (e.n as Record<string, unknown>)[k];
  return out;
}

// ------------------------------------------------------------ contexto da conversa
/** O que campaign_insights_ai devolve (nulo: desligado ou sem acesso). */
export type InsightsContext = {
  money_basis: Basis;
  open: { priority: string; kind: string; title: string; action: string; evidence: Evidence[] }[];
  applied: { title: string; applied_at: string; effect: Effect | null }[];
  dismissed: { title: string; reason: string }[];
} | null;
const PRIORITY_PT: Record<string, string> = { high: "alta", medium: "média", low: "baixa" };
/** A linha do contexto da MAVI na conversa sobre a campanha. */
export function insightsContextLine(x: InsightsContext) {
  if (!x || (!x.open?.length && !x.applied?.length && !x.dismissed?.length)) return "";
  const money = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const value = (e: Evidence) =>
    e.unit === "money" ? money(e.value) : e.unit === "pct" ? `${e.value.toLocaleString("pt-BR")}%` : e.value.toLocaleString("pt-BR");
  const parts = [
    `Insights da MAVI desta campanha (valores ${x.money_basis === "gross" ? "com M" : "sem M"}; o time vê os mesmos no painel ao lado):`,
    ...(x.open ?? []).map(
      (i) =>
        `- [aberto, prioridade ${PRIORITY_PT[i.priority] ?? i.priority}] ${i.title}${i.action ? ` → ${i.action}` : ""}${
          i.evidence?.length ? ` (${i.evidence.slice(0, 3).map((e) => `${e.label}: ${value(e)}`).join("; ")})` : ""
        }`,
    ),
    ...(x.applied ?? []).map(
      (i) =>
        `- [aplicado em ${String(i.applied_at).slice(0, 10)}] ${i.title}${
          i.effect
            ? ` — efeito em ${i.effect.days} dias: ${i.effect.verdict === "better" ? "melhorou" : i.effect.verdict === "worse" ? "piorou" : "estável"}${
                i.effect.change.cpa !== null ? ` (custo por resultado ${i.effect.change.cpa > 0 ? "+" : ""}${i.effect.change.cpa.toLocaleString("pt-BR")}%)` : ""
              }`
            : " — efeito ainda em medição"
        }`,
    ),
    ...(x.dismissed ?? []).map((i) => `- [descartado pelo time${i.reason ? `: ${i.reason}` : ""}] ${i.title}`),
    "Use esses insights quando ajudarem a responder; não repita os descartados como sugestão.",
  ];
  return parts.join("\n");
}

// ------------------------------------------------------------ o pedido à MAVI
export const INSIGHTS_INSTRUCTIONS = `Você é a MAVI, a inteligência de uma agência de marketing (seu nome é MAVI, no feminino). Aqui você é a analista sênior de tráfego pago da agência: lê os números de UMA campanha na plataforma (Meta Ads ou Google Ads), o resultado comercial no CRM (MakeCRM, ligado por UTM) e o contexto do cliente, e entrega poucos insights, claros e aplicáveis, para quem opera a campanha — de quem começou ontem na agência ao gestor mais experiente.

COMO ESCREVER (o mais importante):
- Linguagem simples, de conversa. Frases curtas (até ~20 palavras). Sem jargão: diga "custo por lead", "taxa de cliques", "vezes que cada pessoa viu o anúncio". Se precisar de uma sigla, explique na primeira vez: "retorno sobre o investimento (ROAS)".
- Número sempre com comparação que dá sentido: "R$ 48 por lead, quase o dobro da meta de R$ 25"; "3 de cada 10 leads chegam à Negociação, contra 1 de cada 10 nos outros conjuntos". Poucos números no texto: os que provam a ideia.
- "title": a conclusão em uma frase, até 90 caracteres, com o nome do item. Ex.: "O anúncio 'Frete grátis' traz os leads que mais viram venda". Nada de títulos vagos ("Oportunidade de otimização").
- "body" (O que está acontecendo): 2 a 3 frases. O que os números mostram, por que isso importa (dinheiro perdido ou ganho, leads bons ou ruins) e o porquê provável. Fato é fato; hipótese vem com "provavelmente" ou "vale testar".
- "steps" (O que fazer): de 1 a 3 passos curtos, no imperativo, que alguém sem experiência consegue seguir, dizendo onde e o quê. Ex.: ["No Gerenciador, duplique o conjunto 'Mulheres 25-34'", "No novo conjunto, suba a verba em 20%", "Daqui a 3 dias, compare o custo por lead com o original"]. Nada genérico como "teste novos criativos" ou "acompanhe os resultados".

O QUE É UM BOM INSIGHT:
- Específico: fala de um anúncio, conjunto/grupo, palavra-chave, termo de pesquisa, público ou da campanha, pelo nome.
- Cruzado: o melhor insight junta a plataforma com o CRM (ex.: "o anúncio X tem o lead mais caro, mas é o que mais gera oportunidades"; "o conjunto Y gera leads baratos que quase nunca viram oportunidade").
- Prioritário: traga poucos — no máximo o "limite" do material; 3 bons valem mais que 5 médios. Ordene do mais importante para o menos: o primeiro é o que a pessoa deve fazer hoje.
- Novo: não repita insights anteriores ainda abertos com outras palavras. Se um anterior continua valendo, repita-o com o MESMO "topic" e o MESMO "target" (ele é confirmado, não duplicado). Se nada mudou, devolva menos insights (ou nenhum).

Tipos ("kind"): "highlight" (algo dando certo), "opportunity" (chance de ganhar mais), "problem" (algo custando dinheiro ou resultado), "tracking" (rastreamento/UTM/integração). Prioridade ("priority"): "high" (agir hoje: dinheiro sendo perdido ou ganho relevante), "medium" (nesta semana), "low" (quando der).

BOAS PRÁTICAS DE TRÁFEGO (obrigatório):
- Amostra: só afirme que algo "vai bem" ou "vai mal" com número suficiente (o mínimo vem em "amostra_minima"). Abaixo disso, não conclua; no máximo, diga para esperar.
- Fase de aprendizado (Meta): conjunto com status "Aprendizado" ainda está calibrando — não sugira pausar, mudar público, criativo ou verba nele; espere sair (cerca de 50 resultados em 7 dias). "Aprendizado limitado" pede o contrário: juntar conjuntos parecidos, ampliar o público ou otimizar para um evento mais frequente.
- Verba: nunca sugira subir ou baixar mais de 20% a 30% de uma vez em um conjunto que vai bem (reinicia o aprendizado); para crescer mais, duplique o conjunto.
- Cansaço do criativo: frequência subindo junto com a taxa de cliques caindo indica que o público já viu demais o anúncio: sugira trocar ou variar o criativo.
- Mudanças recentes: depois de aplicar algo, espere ao menos 3 dias de dados antes de julgar.

REGRAS DOS NÚMEROS (obrigatório):
- Toda afirmação numérica vem de "evidence": cada evidência aponta a entidade ("entity", a "key" do material), a janela ("window": cycle, d7, d15, d30 ou since_last) e a métrica ("metric", um nome da lista de métricas). O sistema preenche o valor a partir do material; evidência que não existe é descartada, e insight sem evidência é descartado.
- Use de 1 a 4 evidências por insight, as que provam o que você diz. No texto, os números iguais aos do material, no formato brasileiro (R$ 1.234,56; 12,3%).
- Nunca invente números, nomes, metas, datas ou comparações que não estejam no material.
- O dinheiro já vem na base indicada em "valores" (com ou sem M). Não fale de M, multiplicador ou índice de performance.
- Resultados na plataforma (results) seguem o que a plataforma otimiza; "Resultados que contam (MAVI)" é o que a agência conta para a meta do ciclo.
- O CRM liga pelo nome exato: utm_campaign = nome da campanha, utm_term = nome do conjunto (no Google, do grupo), utm_content = nome do anúncio (no Google, a palavra-chave, quando a agência usa {keyword}). Oportunidade zerada pode ser falta de UTM, não falta de lead.
- O funil do CRM (quando vem) mostra a QUALIDADE do lead: abertas, ganhas, perdidas, taxa de perda, quantas chegaram a cada etapa ("stage:…", ou além), os motivos de perda ("lost:…"), a faixa da qualificação ("bucket:…") e as respostas mais escolhidas no formulário ("answer:…"); os nomes estão em "funil_crm.legenda". Use isso para separar volume de qualidade e cite essas métricas nas evidências pelo nome da chave. O CRM não tem idade nem gênero do lead: o cruzamento com o público é pelo conjunto.
- AS ETAPAS QUE IMPORTAM (quando vêm em "etapas_que_importam"): são a régua principal desta campanha, em ordem do funil (ex.: Qualificado, Negociação, Ganho), cada uma com a sua meta de custo por lead. Compare conjuntos, anúncios e palavras-chave pelo custo por lead que chega a cada etapa e pela porcentagem que chega — as métricas de cada etapa estão em "metricas" (ex.: goal:<id>:cost) e valem nas evidências —, não só pelo custo por lead da plataforma. Mostre em que etapa o funil estoura. Ex.: "o conjunto A tem lead mais caro, mas cada lead em Negociação custa a metade do conjunto B".
- MATURIDADE DOS LEADS: a métrica "recentes" de cada etapa (e young_leads / young_rate) são os leads abertos mais novos que o tempo que um lead costuma levar até a etapa ("dias_tipicos_ate_a_etapa"). Com 40% ou mais de recentes, não conclua que um item vai mal naquela etapa: diga que ainda é cedo e quando reavaliar.
- NEGATIVAS (Google): "termos_sem_conversao" traz os termos de pesquisa do ciclo que gastaram sem nenhuma conversão e ainda não foram negativados. Escolha só os claramente fora do que o cliente vende ou de intenção errada (procura de emprego, grátis, curso, como fazer sozinho, outra cidade ou outro produto, concorrente quando não faz sentido) e devolva em "negatives": [{"ref": "N1", "match": "exact" ou "phrase", "why": "motivo curto"}]. "phrase" quando a palavra-problema deve bloquear qualquer busca com ela (ex.: "emprego"); "exact" para o termo exato. Termo que pode trazer cliente e só não converteu ainda fica de fora. Na dúvida, deixe de fora. O sistema monta o insight das negativas com o gasto somado: não escreva outro insight sobre elas.
- As "detecções automáticas" já viram insights: não as repita; você pode aprofundar com outra conclusão (outro topic).
- Anúncios podem trazer "criativo" (o que a imagem ou o vídeo comunica: promessa, gancho, oferta — lido pela MAVI) e "audio" (trecho da transcrição do vídeo). Use para explicar o porquê do desempenho e sugerir variações concretas; a descrição do criativo não é número e não entra nas evidências.
- "aprendizados_do_time" são regras que o time ensinou (para a agência, o produto ou este cliente): siga-as sempre; nunca sugira o que elas proíbem.
- Insights anteriores "dismissed" foram descartados pelo time (veja o "motivo"): não os traga de volta com outras palavras. "expired" ficaram dias abertos sem que ninguém agisse: o time não viu valor neles; só volte ao assunto se os números pioraram bem desde então, com um ângulo novo. "applied" já foram aplicados: veja "insights_aplicados" — se o efeito piorou, diga e sugira o ajuste; se melhorou, você pode sugerir levar a mesma ideia a outro conjunto ou anúncio.
- O contexto do cliente (dossiê, Radar, termômetro, reuniões) serve para interpretar e priorizar; não copie trechos dele nem exponha conversas internas.

Responda SOMENTE com um JSON, sem texto antes ou depois:
{"summary": "uma frase simples sobre o momento da campanha", "insights": [{"kind": "...", "priority": "...", "topic": "assunto curto e estável, ex.: anuncio-x-promessa-frete", "target": "key da entidade principal ou null", "title": "...", "body": "...", "steps": ["...", "..."], "evidence": [{"entity": "key", "window": "cycle", "metric": "crm_opportunities"}]}], "negatives": [{"ref": "N1", "match": "exact", "why": "..."}]}
("negatives" só quando houver "termos_sem_conversao"; senão, omita.)
Português do Brasil.

As métricas (nomes usados em "n" e em "evidence"): ${Object.entries(METRICS)
  .map(([k, v]) => `${k} = ${v.label}`)
  .join("; ")}. Cada entidade traz "n" por janela; "dentro_de" é a key da entidade de cima. A entidade "total" é a campanha toda, com a meta do ciclo.`;

/** Insights por análise e amostra mínima (Painel da MAVI). */
export const maxInsights = (m: Pick<InsightMaterial, "settings">) =>
  Math.min(Math.max(Number(m.settings.max_insights ?? 4) || 4, 2), 8);
export const minResults = (m: Pick<InsightMaterial, "settings">) =>
  Math.min(Math.max(Number(m.settings.min_results ?? 10), 0), 100);

/** O material da conversa (compacto: só o que ajuda a decidir). */
export function insightMessage(m: InsightMaterial, a: Analysis, rules: Insight[]): string {
  const y = m.cycle;
  const windows = Object.fromEntries(
    Object.entries(a.windows).map(([k, r]) => [k, `${WINDOW_LABELS[k as WindowKey]}: ${r!.since} a ${r!.until}`]),
  );
  const compact = (n: Numbers) =>
    Object.fromEntries(Object.entries(n).filter(([, v]) => v !== null && v !== undefined));
  const material = {
    campanha: {
      nome: m.campaign.name,
      plataforma: m.campaign.platform === "meta" ? "Meta Ads" : "Google Ads",
      cliente: m.client?.name ?? "",
      produto: m.product?.name ?? "",
      notas: m.campaign.notes || undefined,
    },
    ciclo: {
      inicio: y.start_date,
      fim: y.end_date,
      objetivo: y.objective,
      destino: y.destination,
      nicho: y.niche || undefined,
    },
    valores: a.basis === "gross" ? "R$ com M (o que o cliente vê)" : "R$ sem M (o investimento real na plataforma)",
    limite: `no máximo ${maxInsights(m)} insights`,
    amostra_minima: minResults(m)
      ? `${minResults(m)} resultados (ou ${Math.ceil(minResults(m) / 2)} oportunidades no CRM, ou o investimento de 2 resultados da meta) no item e na janela citados`
      : "sem mínimo",
    resultado_da_plataforma: a.result_label || undefined,
    janelas: windows,
    funil_crm:
      a.funnel === "ok" && a.labels && Object.keys(a.labels).length
        ? { legenda: a.labels }
        : undefined,
    termos_sem_conversao: a.negCandidates?.length
      ? a.negCandidates.map((t) => ({
          ref: t.ref,
          termo: t.term,
          ...(t.keyword ? { palavra_chave: t.keyword } : {}),
          campanha: t.campaign,
          gasto: t.spend,
          cliques: t.clicks,
        }))
      : undefined,
    etapas_que_importam: m.crm_goal?.stages?.length
      ? {
          origem: m.crm_goal.source === "client" ? "padrão do cliente" : "ajuste desta campanha",
          etapas: m.crm_goal.stages.map((st) => ({
            etapa: st.stage_name,
            ...(st.pipeline_name ? { funil: st.pipeline_name } : {}),
            meta_de_custo_por_lead: st.cost_goal ? Number(st.cost_goal) : "sem meta definida",
            dias_tipicos_ate_a_etapa: a.stageDays?.[st.stage_id] ?? "sem histórico (considere 7 dias)",
            metricas: {
              leads: goalMetric(st.stage_id, "leads"),
              porcentagem: goalMetric(st.stage_id, "rate"),
              custo_por_lead: goalMetric(st.stage_id, "cost"),
              recentes: goalMetric(st.stage_id, "young_rate"),
            },
          })),
        }
      : undefined,
    crm:
      a.crm === "ok"
        ? a.funnel === "ok"
          ? "ligado: oportunidades, ganhos, receita e o funil do ciclo por UTM (etapa alcançada, perdas, qualificação)"
          : "ligado: oportunidades, ganhos e receita do ciclo por UTM"
        : a.crm === "error"
          ? "ligado, mas não respondeu agora (sem números do CRM nesta análise)"
          : "o cliente não está ligado ao MakeCRM (sem números do CRM)",
    entidades: a.entities.map((e) => ({
      key: e.key,
      nivel: e.level,
      nome: e.name,
      ...(e.parent ? { dentro_de: e.parent } : {}),
      ...(e.status ? { status: e.status } : {}),
      ...(e.info && Object.keys(e.info).length ? { info: e.info } : {}),
      n: Object.fromEntries(Object.entries(e.n).map(([w, n]) => [w, compact(n!)])),
    })),
    deteccoes_automaticas: rules.map((r) => ({ kind: r.kind, title: r.title, target: r.target?.key ?? null })),
    insights_anteriores: m.previous.slice(0, 15).map((p) => {
      const f = fingerprintParts(p.fingerprint);
      return {
        kind: p.kind,
        title: p.title,
        topic: f.topic,
        target: f.target,
        status: p.status,
        visto: p.seen_count,
        ...(p.status_reason ? { motivo: p.status_reason } : {}),
      };
    }),
    aprendizados_do_time: m.lessons?.length
      ? m.lessons.map((l) => ({ alcance: l.scope, ...(l.kind ? { tipo: l.kind } : {}), regra: l.text }))
      : undefined,
    insights_aplicados: m.applied?.length
      ? m.applied.map((x) => ({
          title: x.title,
          aplicado_em: x.applied_at.slice(0, 10),
          ...(x.effect
            ? {
                efeito: {
                  dias: x.effect.days,
                  resultado: x.effect.verdict === "better" ? "melhorou" : x.effect.verdict === "worse" ? "piorou" : "estável",
                  custo_por_resultado: x.effect.change.cpa,
                  resultados_por_dia: x.effect.change.results_per_day,
                },
              }
            : { efeito: "ainda medindo" }),
        }))
      : undefined,
    contexto_do_cliente: {
      dossie: m.context.dossier.length ? m.context.dossier : undefined,
      radar: m.context.radar.length ? m.context.radar : undefined,
      termometro: m.context.temperature ?? undefined,
      reunioes: m.context.meetings.length ? m.context.meetings : undefined,
    },
  };
  return `Hoje é ${m.today}. Analise a campanha abaixo e devolva os insights no JSON pedido.\n\n${JSON.stringify(material)}`;
}

// ------------------------------------------------------------ custo
/** Estimativa (US$) de uma chamada: ~3,2 caracteres por token na entrada. */
export function estimateCost(chars: number, maxTokens: number, price: { input: number; output: number }) {
  return ((chars / 3.2) * price.input + maxTokens * price.output) / 1e6;
}

/**
 * Enxuga o material até a estimativa caber no teto por análise. Devolve o
 * texto, o teto de saída e o que foi cortado (vai para a nota da análise).
 */
export function fitToCap(
  build: (cut: number) => { text: string; maxTokens: number },
  cap: number,
  price: { input: number; output: number },
  steps = 4,
): { text: string; maxTokens: number; cut: number; estimate: number } | null {
  for (let cut = 0; cut <= steps; cut++) {
    const b = build(cut);
    const estimate = estimateCost(b.text.length + INSIGHTS_INSTRUCTIONS.length, b.maxTokens, price);
    if (estimate <= cap) return { ...b, cut, estimate };
  }
  return null;
}
export const CUT_NOTES = [
  "",
  "Sem as reuniões no contexto para caber no teto por análise.",
  "Menos conjuntos, anúncios e termos para caber no teto por análise.",
  "Só o ciclo e os últimos 7 dias nos detalhes para caber no teto por análise.",
  "Resposta mais curta para caber no teto por análise.",
];

/** O material cortado em níveis (0 = inteiro). */
export function cutAnalysis(m: InsightMaterial, a: Analysis, cut: number): { m: InsightMaterial; a: Analysis } {
  let mm = m;
  let aa = a;
  if (cut >= 1) mm = { ...mm, context: { ...mm.context, meetings: [] } };
  if (cut >= 2)
    aa = {
      ...aa,
      entities: focus(aa.entities, { adsets: 8, ads: 8, keywords: 8, terms: 6, segments: 6 }),
      negCandidates: aa.negCandidates?.slice(0, 15),
    };
  if (cut >= 3)
    aa = {
      ...aa,
      entities: aa.entities.map((e) =>
        e.level === "campaign" || e.level === "total"
          ? e
          : { ...e, n: Object.fromEntries(Object.entries(e.n).filter(([w]) => w === "cycle" || w === "d7")) },
      ),
    };
  return { m: mm, a: aa };
}

// ------------------------------------------------------------ o Jev
export function checkQuestions(list: Insight[]) {
  const q: Record<string, JevQuestion> = {};
  list.forEach((x, i) => {
    q[`ok_${i + 1}`] = {
      type: "noul",
      instructions: `O insight ${i + 1} ("${x.title}") é sustentado pelas evidências numéricas dele: os números confirmam o que o texto afirma, e a ação sugerida faz sentido para esses números?`,
      criteria: {
        true: "Sim: as evidências mostram isso e a ação decorre delas",
        false: "Não: os números não mostram isso, contradizem o texto ou a ação não tem relação",
      },
    };
  });
  return q;
}
export function checkState(m: InsightMaterial, list: Insight[], basis: Basis) {
  return {
    campanha: m.campaign.name,
    plataforma: m.campaign.platform,
    valores: basis === "gross" ? "R$ com M" : "R$ sem M",
    insights: list.map((x, i) => ({
      insight: i + 1,
      titulo: x.title,
      texto: x.body,
      acao: x.action,
      evidencias: x.evidence.map((e) => `${e.label} — ${e.name} (${WINDOW_LABELS[e.window]}): ${e.value}`),
    })),
  };
}
/** Tira o que o Jev recusa; guarda a confiança dos que ficam. */
export function applyCheck(list: Insight[], res: JevResponse, threshold = 0.3) {
  const got = res.answers ?? {};
  return list.filter((x, i) => {
    const ok = got[`ok_${i + 1}`]?.noul;
    if (typeof ok !== "number") return true;
    x.confidence = Math.round(ok * 1000) / 1000;
    return ok >= threshold;
  });
}

// ------------------------------------------------------------ cota das APIs
// O medidor fica em api/_ads-meter.ts (o leitor do "hoje" da lista usa também).
export { metaUsage, meteredFetch, newApiMeter, type ApiMeter, type Throttle } from "./_ads-meter.js";

/** A leitura parou pela cota: a análise espera, a conta (ou a plataforma) fica pausada. */
export class ThrottledError extends InsightsError {
  constructor(
    public throttle: Throttle,
    public accounts: string[],
  ) {
    super(429, throttle.reason);
  }
}

/** Consumo a partir do qual a conta descansa depois da análise. */
export const SOFT_LIMIT_PCT = 75;
/** Operações do Google por conta numa análise (uma por visão). */
export const GOOGLE_OPS_PER_ACCOUNT = 7;

// ------------------------------------------------------------ o worker
export type CampaignInsightsEnv = AiEnv & {
  ads: AdsEnv;
  crm: CrmEnv;
  insightsBudgetMs?: number;
};
type Usage = {
  kind: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  provider_id?: string;
  provider?: string;
};

async function workerRpc<T>(env: AiEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
  if (!r.ok) throw new InsightsError(r.status, r.error);
  return r.data;
}

type Company = { llm: LlmAdapter; route: ResolvedRoute | null; model: string; price: { input: number; output: number } };
async function companyOf(env: AiEnv, deps: AiDeps, id: string): Promise<Company> {
  const route = await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
    p_company: id,
    p_feature: "campaign_insights",
  });
  const config = route && route.key_cipher ? routeConfig(env, route) : null;
  if (!config && !env.anthropicKey) throw new InsightsError(503, "Sem provedor para os insights.", true);
  const model = config?.model ?? env.model;
  const listed = config?.price ?? route?.price ?? null;
  const [input, output] = listed ? [listed.input, listed.output] : modelPrice(model);
  return {
    llm: config ? (deps.providerLlm ?? ((p: ProviderConfig) => adapterFor(p, deps.fetch)))(config) : deps.llm,
    route,
    model,
    price: { input, output },
  };
}

/** O Google Ads da agência com o refresh token selado (sem pessoa logada). */
export async function googleSearchFor(env: AdsEnv, fetchImpl: Fetch, refreshCipher: string) {
  if (!env.tokenKey) throw new InsightsError(503, "Falta GOOGLE_TOKEN_KEY_ADS no servidor.", true);
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      refresh_token: unseal(env.tokenKey, refreshCipher),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token)
    throw new InsightsError(
      body.error === "invalid_grant" ? 409 : 502,
      body.error === "invalid_grant"
        ? "A conexão com o Google Ads expirou. Conecte de novo em Campanhas."
        : `Google: ${body.error ?? res.statusText}`,
      body.error === "invalid_grant",
    );
  const access = body.access_token;
  return (account: string, manager: string): Search =>
    async (query: string) => {
      const r = await fetchImpl(
        `https://googleads.googleapis.com/${env.google.version}/customers/${account}/googleAds:searchStream`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access}`,
            "developer-token": env.google.developerToken,
            "login-customer-id": manager || account,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        },
      );
      const data = (await r.json().catch(() => null)) as unknown;
      if (!r.ok) {
        const e = (Array.isArray(data) ? data[0] : data) as {
          error?: { message?: string; details?: { errors?: { message?: string }[] }[] };
        } | null;
        throw new InsightsError(
          502,
          `Google Ads: ${e?.error?.details?.[0]?.errors?.[0]?.message ?? e?.error?.message ?? r.statusText}`,
        );
      }
      return ((data as { results?: GoogleRow[] }[]) ?? []).flatMap((b) => b.results ?? []);
    };
}

/** Poucas leituras ao mesmo tempo (as APIs limitam por conta). */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await job();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** As contas vinculadas e as campanhas de cada uma ("" = a conta toda). */
export function accountsOf(links: InsightMaterial["links"]) {
  const out = new Map<string, { manager: string; campaigns: string[] }>();
  for (const l of links) {
    const id = String(l.account_id).replace(/^act_/i, "").replace(/-/g, "");
    if (!/^[0-9]+$/.test(id)) continue;
    const entry = out.get(id) ?? { manager: String(l.manager_id ?? "").replace(/-/g, ""), campaigns: [] };
    if (/^[0-9]+$/.test(l.campaign_id)) entry.campaigns.push(l.campaign_id);
    out.set(id, entry);
  }
  return out;
}

/**
 * Pular sem chamar a API nem a MAVI: sem investimento desde a última análise
 * (os dias do Dia a Dia já sincronizados vêm zerados) ou, no agendamento,
 * com menos dias novos com investimento que o mínimo da empresa. Sem os dias
 * sincronizados (a sincronização falhou), não dá para saber: analisa.
 */
export function skipReason(m: InsightMaterial): string | null {
  if (!m.last_done_at) return null;
  const covered = addDays(localDay(m.last_done_at, m.timezone), -1);
  const fresh = m.daily.filter((d) => d.day > covered);
  if (!fresh.length) return null;
  const spent = fresh.filter((d) => Number(d.spend) > 0).length;
  const [, mm, dd] = covered.split("-");
  if (!spent) return `Sem investimento desde a última análise (que leu até ${dd}/${mm}): nada novo para ler.`;
  const min = Number(m.settings.min_new_days ?? 0);
  if (m.run.trigger === "schedule" && min > 0 && spent < min)
    return `Só ${spent} ${spent === 1 ? "dia novo" : "dias novos"} com investimento desde a última análise (o mínimo é ${min}): os insights abertos continuam valendo.`;
  return null;
}

/** Lê a plataforma e o CRM e monta as entidades. */
export async function readAnalysis(
  env: CampaignInsightsEnv,
  fetchImpl: Fetch,
  m: InsightMaterial,
  meter: ApiMeter = newApiMeter(),
): Promise<Analysis> {
  const basis: Basis = m.settings.money_basis === "gross" ? "gross" : "net";
  const k = basis === "gross" ? Number(m.cycle.multiplier) || 1 : 1;
  const windows = windowsFor(m.today, m.cycle, m.last_done_at, m.timezone);
  const ranges: WindowRange[] = (Object.keys(windows) as WindowKey[]).map((key) => ({ key, ...windows[key]! }));
  const short = ranges.filter((r) => r.key === "cycle" || r.key === "d7");
  const cycle = ranges.filter((r) => r.key === "cycle");
  // Os aplicados: os períodos de antes × depois entram nas mesmas leituras.
  const plans = effectPlans(m);
  const notes: string[] = [];
  const f = meteredFetch(fetchImpl, meter);
  // O CRM primeiro (as linhas da plataforma já saem com ele).
  let crm: CrmIndex | null = null;
  let crmState: Analysis["crm"] = "unlinked";
  let funnel: CrmFunnel | null = null;
  let funnelState: Analysis["funnel"] = "off";
  if (m.crm_company_id) {
    if (!env.crm.secret) crmState = "off";
    else {
      const since = windows.cycle!.since;
      const until = windows.cycle!.until;
      const [r, f] = await Promise.all([
        crmUtmDeals(env.crm, fetchImpl, m.crm_company_id, since, until),
        crmUtmFunnel(env.crm, fetchImpl, m.crm_company_id, since, until),
      ]);
      if (r.ok) {
        crm = crmIndex(r.data);
        crmState = "ok";
      } else {
        crmState = "error";
        notes.push(`MakeCRM: ${r.error}`);
      }
      // O funil é um extra: sem ele, a análise segue com oportunidades e ganhos.
      if (f.ok) {
        funnel = f.data;
        funnelState = "ok";
      } else if (r.ok) {
        const missing = /mavi_utm_funnel/.test(f.error);
        funnelState = missing ? "missing" : "error";
        notes.push(
          missing
            ? "Funil do CRM indisponível: falta criar a consulta mavi_utm_funnel no MakeCRM."
            : `Funil do CRM: ${f.error}`,
        );
      }
    }
  }
  const accounts = accountsOf(m.links);
  if (!accounts.size) throw new InsightsError(409, "O ciclo não tem contas vinculadas.", true);
  const ids = [...accounts.keys()];
  let entities: Entity[] = [];
  let resultLabel = "";
  // Google: os termos de pesquisa de todas as contas (para as negativas).
  const termReads: GoogleRead[] = [];
  // No máximo duas leituras ao mesmo tempo (e uma conta por vez: a fila garante).
  const slot = limiter(2);
  try {
    if (m.campaign.platform === "meta") {
      if (!env.ads.tokenKey) throw new InsightsError(503, "Falta GOOGLE_TOKEN_KEY_ADS no servidor.", true);
      for (const [account, { campaigns }] of accounts) {
        const stored = m.meta_tokens?.[account];
        if (!stored) {
          notes.push(`A conta ${account} não tem conexão do Facebook.`);
          continue;
        }
        const token = unseal(env.ads.tokenKey, stored.token_cipher);
        const read = (level: "campaign" | "adset" | "ad", list: WindowRange[], breakdown = false) =>
          slot(() =>
            platformWindows(env.ads, f, token, {
              account,
              level,
              campaigns,
              ranges: list,
              ...(breakdown ? { breakdown: { kind: "age_gender" as const, range: cycle[0] } } : {}),
            }),
          );
        // Campanhas (todas as janelas) primeiro; o público só com folga na cota.
        const top = await read("campaign", [...ranges, ...plannedRanges(plans, "campaign")]);
        resultLabel ||= top.result_label;
        const roomy = meter.pct < 60;
        if (!roomy) notes.push(`Cota do Meta em ${Math.round(meter.pct)}%: sem o público por idade e gênero.`);
        const [adsets, ads] = await Promise.all([
          read("adset", [...short, ...plannedRanges(plans, "adset")], roomy),
          read("ad", [...short, ...plannedRanges(plans, "ad")]),
        ]);
        entities.push(...metaEntities({ campaigns: top.rows, adsets: adsets.rows, ads: ads.rows }, crm, k, LIMITS, account));
      }
    } else {
      if (!m.google_token) throw new InsightsError(409, "Conecte o Google Ads da agência em Campanhas.", true);
      const searchFor = await googleSearchFor(env.ads, f, m.google_token.refresh_token_cipher);
      for (const [account, { manager, campaigns }] of accounts) {
        const search = searchFor(account, manager);
        const read = (view: GoogleRead["view"], list: WindowRange[]) =>
          slot(() => googleWindows(search, { account, manager, view, campaigns, ranges: list })).then(
            (rows): GoogleRead => ({ view, rows }),
          );
        const reads = await Promise.all([
          read("campaigns", [...ranges, ...plannedRanges(plans, "campaign")]),
          read("ad_groups", [...short, ...plannedRanges(plans, "adset")]),
          ...(["ads", "keywords", "search_terms", "age", "gender"] as const).map((view) =>
            read(
              view,
              view === "ads"
                ? [...cycle, ...plannedRanges(plans, "ad")]
                : view === "keywords"
                  ? [...cycle, ...plannedRanges(plans, "keyword")]
                  : cycle,
            ).catch((e) => {
              if (meter.throttle) throw e;
              notes.push(`Google: a visão ${view} não pôde ser lida.`);
              return { view, rows: [] } as GoogleRead;
            }),
          ),
        ]);
        entities.push(...googleEntities(reads, crm, k));
        termReads.push(...reads);
      }
      resultLabel = "Conversões";
    }
  } catch (e) {
    if (meter.throttle) throw new ThrottledError(meter.throttle, ids);
    const msg = (e as Error).message;
    if (m.campaign.platform === "meta" && /expirou|token|OAuth|session|190/i.test(msg))
      throw new InsightsError(409, "A conexão do Facebook desta conta expirou. Conecte de novo em Campanhas.", true);
    throw e;
  }
  if (!entities.some((e) => e.level === "campaign"))
    throw new InsightsError(409, notes[0] ?? "Nenhuma campanha vinculada foi encontrada na plataforma.", true);
  const effects = measureEffects(plans, entities, basis);
  entities = [...entities, ...nearMissUtms(entities, crm)];
  const labels = funnel ? applyFunnel(entities, funnel, m.crm_goal) : {};
  const contentCampaigns = crm
    ? [...new Set([...crm.ad.keys()].filter((k) => (k.split(SEP)[2] ?? "") !== "").map((k) => k.split(SEP)[0]))]
    : [];
  const analysis: Analysis = {
    platform: m.campaign.platform,
    basis,
    multiplier: Number(m.cycle.multiplier) || 1,
    windows,
    result_label: resultLabel,
    entities,
    crm: crmState,
    notes,
    accounts: ids,
    funnel: funnelState,
    labels,
    contentCampaigns,
    effects,
    stageDays: funnel ? stageDaysOf(funnel, m.crm_goal) : {},
    negCandidates: termReads.length
      ? negativeCandidates(
          termReads,
          k,
          m.cycle.goal_results > 0
            ? (basis === "gross" ? m.cycle.budget : m.cycle.budget / (Number(m.cycle.multiplier) || 1)) / m.cycle.goal_results
            : null,
        )
      : [],
  };
  analysis.entities = [totalEntity(m, analysis), ...analysis.entities];
  return analysis;
}

const minutesFromNow = (now: number, minutes: number) => new Date(now + minutes * 60_000).toISOString();

/** Uma análise inteira (a fila já reservou). */
export async function analyse(
  env: CampaignInsightsEnv,
  deps: AiDeps,
  runId: string,
  companies: Map<string, Promise<Company>>,
  read: typeof readAnalysis = readAnalysis,
  creatives: typeof readCreatives = readCreatives,
): Promise<{ skipped?: boolean; deferred?: boolean; insights?: number }> {
  const now = deps.now ?? Date.now;
  const m = await workerRpc<InsightMaterial | null>(env, deps, "ai_campaign_insight_material", { p_run: runId });
  if (!m) return { skipped: true };
  const skip = m.blocked ?? skipReason(m);
  if (skip) {
    await workerRpc(env, deps, "ai_campaign_insight_store", {
      p_run: runId,
      p_result: { status: "skipped", note: skip },
    });
    return { skipped: true };
  }
  const defer = (until: string, note: string) =>
    workerRpc(env, deps, "ai_campaign_insight_defer", { p_run: runId, p_until: until, p_note: note });
  // Google: o orçamento de operações da MAVI nas últimas 24 h (o developer
  // token é o mesmo da sincronização e da aba Plataforma).
  const google = m.campaign.platform === "google";
  const reserved = google ? Math.max(accountsOf(m.links).size, 1) * GOOGLE_OPS_PER_ACCOUNT : 0;
  if (google) {
    const b = await workerRpc<{ ok: boolean; used: number; budget: number; retry_at?: string }>(
      env,
      deps,
      "ai_campaign_insight_google_ops",
      { p_company: m.company_id, p_ops: reserved, p_check: true },
    );
    if (!b.ok) {
      await defer(
        b.retry_at ?? minutesFromNow(now(), 60),
        `Orçamento de operações do Google da MAVI nas últimas 24 h atingido (${b.used} de ${b.budget}): a análise espera liberar.`,
      );
      return { deferred: true };
    }
  }
  const settle = (meter: ApiMeter) =>
    google && meter.google !== reserved
      ? workerRpc(env, deps, "ai_campaign_insight_google_ops", {
          p_company: m.company_id,
          p_ops: meter.google - reserved,
          p_check: false,
        }).catch(() => {})
      : Promise.resolve();
  if (!companies.has(m.company_id)) companies.set(m.company_id, companyOf(env, deps, m.company_id));
  const company = await companies.get(m.company_id)!;
  const meter = newApiMeter();
  let full: Analysis;
  try {
    full = await read(env, deps.fetch, m, meter);
  } catch (e) {
    await settle(meter);
    if (e instanceof ThrottledError) {
      const until = minutesFromNow(now(), e.throttle.minutes);
      const targets = e.throttle.scope === "platform" ? ["*"] : e.accounts;
      for (const account of targets)
        await workerRpc(env, deps, "ai_campaign_insight_cooldown", {
          p_platform: e.throttle.platform,
          p_account: account,
          p_until: until,
          p_reason: e.throttle.reason,
        }).catch(() => {});
      await defer(until, `${e.throttle.reason}: a análise espera a cota liberar.`);
      return { deferred: true };
    }
    throw e;
  }
  await settle(meter);
  // Perto do limite: a conta descansa antes da próxima análise.
  if (meter.pct >= SOFT_LIMIT_PCT)
    for (const account of full.accounts ?? [])
      await workerRpc(env, deps, "ai_campaign_insight_cooldown", {
        p_platform: m.campaign.platform,
        p_account: account,
        p_until: minutesFromNow(now(), Math.max(meter.regainMinutes, 15)),
        p_reason: `Consumo da cota em ${Math.round(meter.pct)}%`,
      }).catch(() => {});
  const entities = new Map(full.entities.map((e) => [e.key, e]));
  const rules = ruleInsights(m, full, entities);
  // O efeito medido agora vai para a MAVI (e é gravado com a análise).
  const measured = new Map((full.effects ?? []).map((x) => [x.insight, x.effect]));
  if (m.applied?.length) m.applied = m.applied.map((a) => ({ ...a, effect: measured.get(a.id) ?? a.effect }));
  const cap = Number(m.settings.run_cap_usd) || 0.5;
  const usage: Usage[] = [];
  const notes = [...full.notes];
  // Os criativos dos anúncios que pesam (cada um lido uma vez; até 40% do teto).
  const withCreative = full.entities
    .filter((e) => e.level === "ad" && e.source)
    .sort((a, b) => numOr(b.n.cycle?.spend ?? b.n.d7?.spend) - numOr(a.n.cycle?.spend ?? a.n.d7?.spend));
  if (withCreative.length) {
    try {
      const tokens = new Map<string, string>();
      if (m.campaign.platform === "meta" && env.ads.tokenKey)
        for (const [account, t] of Object.entries(m.meta_tokens ?? {})) tokens.set(account, unseal(env.ads.tokenKey, t.token_cipher));
      const ads: CreativeAd[] = withCreative.map((e) => ({
        entity: e.key,
        spend: numOr(e.n.cycle?.spend ?? e.n.d7?.spend),
        title: e.info?.titulo ?? e.info?.titulos,
        body: e.info?.texto ?? e.info?.descricoes,
        cta: e.info?.cta,
        ...(e.source?.creative && e.source.account
          ? { meta: { creative: e.source.creative, account: e.source.account } }
          : {}),
        ...(e.source?.image ? { google: { image: e.source.image } } : {}),
      }));
      const cr = await creatives(env, deps, {
        company: m.company_id,
        platform: m.campaign.platform,
        ads,
        tokens,
        platformFetch: meteredFetch(deps.fetch, meter),
        budget: cap * 0.4,
      });
      for (const [key, c] of cr.byEntity) {
        const e = entities.get(key);
        if (!e) continue;
        e.info = { ...(e.info ?? {}), criativo: c.line, ...(c.transcript ? { audio: c.transcript } : {}) };
      }
      usage.push(...cr.usage);
      notes.push(...cr.notes);
      if (cr.read || cr.reused)
        notes.push(
          `Criativos: ${cr.read} ${cr.read === 1 ? "lido agora" : "lidos agora"}, ${cr.reused} ${cr.reused === 1 ? "reaproveitado" : "reaproveitados"}.`,
        );
    } catch (e) {
      notes.push(`Os criativos não puderam ser lidos agora: ${(e as Error).message}`.slice(0, 200));
    }
  }
  const creativeCost = usage.reduce((sum, u) => sum + u.cost, 0);
  const fit = fitToCap(
    (cut) => {
      const c = cutAnalysis(m, full, cut);
      return { text: insightMessage(c.m, c.a, rules), maxTokens: cut >= 4 ? 2500 : 5000 };
    },
    Math.max(cap - creativeCost, 0),
    company.price,
  );
  let summary = "";
  let found: Insight[] = [];
  let negatives: Insight | null = null;
  if (!fit) {
    // Nem o mínimo cabe: ficam só as detecções automáticas (sem custo).
    notes.push(`O teto por análise (US$ ${cap.toFixed(2)}) não cobre a leitura da MAVI desta campanha: só as detecções automáticas.`);
  } else {
    if (CUT_NOTES[fit.cut]) notes.push(CUT_NOTES[fit.cut]);
    const result = await company.llm({
      instructions: INSIGHTS_INSTRUCTIONS,
      context: "",
      messages: [{ role: "user", content: fit.text }],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      maxTokens: fit.maxTokens,
      effort: "medium",
    });
    usage.push({
      kind: "campaign_insights",
      model: result.meter.model || company.model,
      input: result.meter.input,
      output: result.meter.output,
      cache_read: result.meter.cacheRead,
      cache_write: result.meter.cacheWrite,
      cost: Math.round(result.meter.cost * 1e6) / 1e6,
      ...(company.route ? { provider_id: company.route.provider_id, provider: company.route.provider } : {}),
    });
    const parsed = parseInsights(result.text, entities, maxInsights(m) + 2, full.labels ?? {});
    summary = parsed.summary;
    negatives = negativesInsight(full, parseNegatives(result.text, full.negCandidates ?? []), entities);
    // Amostra mínima: sem número suficiente, a MAVI não conclui.
    const min = minResults(m);
    found = parsed.insights.filter((x) => sampleOk(x, entities, min));
    const small = parsed.insights.length - found.length;
    if (small)
      notes.push(
        `${small} ${small === 1 ? "ideia ficou" : "ideias ficaram"} de fora por amostra pequena (menos de ${min} resultados).`,
      );
    if (parsed.dropped)
      notes.push(
        `${parsed.dropped} ${parsed.dropped === 1 ? "insight foi descartado" : "insights foram descartados"} por falta de evidência que conferisse.`,
      );
  }
  // As detecções primeiro; a MAVI não repete o mesmo assunto.
  const byPrint = new Set(rules.map((r) => r.fingerprint));
  let list = [...rules, ...found.filter((x) => !byPrint.has(x.fingerprint))];
  // A conferência do Jev nunca trava: fora do ar, os insights entram sem ela.
  const jev = m.jev?.key_cipher ? routeConfig(env, m.jev) : null;
  const mavi = list.filter((x) => x.source === "mavi");
  if (jev && mavi.length) {
    try {
      const res = await askJev(
        jev,
        checkState(m, mavi, full.basis),
        checkQuestions(mavi),
        deps.fetch,
        AbortSignal.timeout(30_000),
      );
      const kept = new Set(applyCheck(mavi, res));
      const removed = mavi.length - kept.size;
      if (removed)
        notes.push(`O Jev recusou ${removed} ${removed === 1 ? "insight" : "insights"} sem sustentação nos números.`);
      list = list.filter((x) => x.source === "rule" || kept.has(x));
      usage.push({
        kind: "campaign_insights_check",
        model: res.model || jev.model,
        input: res.tokens,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        cost: Math.round(res.cost * 1e6) / 1e6,
        ...(m.jev ? { provider_id: m.jev.provider_id, provider: m.jev.provider } : {}),
      });
    } catch (e) {
      notes.push(`Conferência do Jev indisponível: ${(e as Error).message}`.slice(0, 200));
    }
  }
  // As negativas: os números vêm da plataforma, a MAVI só escolheu os termos (sem o Jev).
  if (negatives) list = [...list, negatives];
  // Menos e melhor: pela prioridade, até o limite do Painel (o primeiro é o "Comece por aqui").
  const ranked = rankInsights(list, maxInsights(m));
  if (ranked.length < list.length)
    notes.push(
      `${list.length - ranked.length} ${list.length - ranked.length === 1 ? "insight de menor prioridade ficou" : "insights de menor prioridade ficaram"} de fora pelo limite de ${maxInsights(m)} por análise.`,
    );
  list = ranked;
  await workerRpc(env, deps, "ai_campaign_insight_store", {
    p_run: runId,
    p_result: {
      status: "done",
      summary,
      note: notes.join(" ").slice(0, 1000),
      money_basis: full.basis,
      multiplier: full.multiplier,
      windows: full.windows,
      model: company.model,
      provider: company.route?.provider ?? "",
      insights: list,
      usage,
      api_calls: { meta: meter.meta, google: meter.google },
      effects: full.effects ?? [],
      tokens: {
        input: usage.reduce((sum, u) => sum + u.input + u.cache_read + u.cache_write, 0),
        output: usage.reduce((sum, u) => sum + u.output, 0),
      },
    },
  });
  return { insights: list.length };
}

/** Pega as análises da fila (duas por vez) até o tempo acabar. */
export async function runCampaignInsights(
  env: CampaignInsightsEnv,
  deps: AiDeps,
  /** A leitura da plataforma e do CRM (trocada nos testes). */
  read: typeof readAnalysis = readAnalysis,
  /** A leitura dos criativos (trocada nos testes). */
  creatives: typeof readCreatives = readCreatives,
  /** O aprendizado com as avaliações (trocado nos testes). */
  learn: typeof learnFromFeedback = learnFromFeedback,
  /** A leitura leve da vigia diária (trocada nos testes). */
  watch: typeof watchPlatforms = watchPlatforms,
) {
  const now = deps.now ?? Date.now;
  const deadline = now() + (env.insightsBudgetMs ?? 240_000);
  const stats = { done: 0, skipped: 0, deferred: 0, failed: 0, insights: 0, learned: 0, watched: 0 };
  // A vigia diária (sem a MAVI; poucas chamadas por campanha): até 1 minuto.
  try {
    stats.watched = (await watch(env, deps, Math.min(deadline - 120_000, now() + 60_000))).done;
  } catch (e) {
    console.error("campaign insights · vigia", (e as Error).message);
  }
  // Primeiro, o aprendizado de uma empresa com avaliações paradas (rápido; nunca trava as análises).
  try {
    const r = await learn(env, deps);
    if (r) stats.learned = r.changed;
  } catch (e) {
    console.error("campaign insights · aprendizado", (e as Error).message);
  }
  const companies = new Map<string, Promise<Company>>();
  // Uma análise leva até ~2 min (leitura da plataforma + a MAVI).
  while (now() < deadline - 120_000) {
    const claimed = await workerRpc<{ id: string; company_id: string }[]>(env, deps, "ai_campaign_insight_claim", {
      p_limit: 2,
    });
    if (!claimed.length) break;
    await Promise.all(
      claimed.map(async (c) => {
        try {
          const r = await analyse(env, deps, c.id, companies, read, creatives);
          if (r.skipped) stats.skipped++;
          else if (r.deferred) stats.deferred++;
          else {
            stats.done++;
            stats.insights += r.insights ?? 0;
          }
        } catch (e) {
          stats.failed++;
          const err = e as InsightsError;
          console.error("campaign insights", c.id, err.message);
          await workerRpc(env, deps, "ai_campaign_insight_fail", {
            p_run: c.id,
            p_error: String(err.message ?? "Erro na análise.").slice(0, 900),
            p_final: err instanceof InsightsError && err.final,
          }).catch(() => {});
        }
      }),
    );
  }
  return stats;
}

/** "ai-campaign-insights": só o agendamento (pg_cron) com o segredo do worker. */
export async function handleCampaignInsightsWorker(
  authorization: string | null,
  env: CampaignInsightsEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Row }> {
  if (!workerAuthorized(authorization, env)) return { status: 401, body: { error: "Não autorizado." } };
  try {
    return { status: 200, body: await runCampaignInsights(env, deps) };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return {
      status: typeof e.status === "number" ? e.status : 500,
      body: { error: e.message ?? "Erro nos insights das campanhas." },
    };
  }
}

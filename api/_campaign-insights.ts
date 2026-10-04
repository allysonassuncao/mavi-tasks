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
  daily: { day: string; spend: number; conversions: number; multiplier: number }[];
  settings: { money_basis: Basis; run_cap_usd: number; min_new_days?: number };
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
  ctr: { label: "CTR", unit: "pct" },
  cpc: { label: "CPC", unit: "money" },
  cpm: { label: "CPM", unit: "money" },
  frequency: { label: "Frequência", unit: "ratio" },
  value: { label: "Valor de conversão", unit: "money" },
  roas: { label: "ROAS da plataforma", unit: "ratio" },
  crm_opportunities: { label: "Oportunidades no CRM", unit: "count" },
  crm_wins: { label: "Ganhos no CRM", unit: "count" },
  crm_revenue: { label: "Receita no CRM", unit: "money" },
  crm_cpl: { label: "Custo por oportunidade (CRM)", unit: "money" },
  crm_cost_win: { label: "Custo por ganho (CRM)", unit: "money" },
  crm_roas: { label: "ROAS do CRM", unit: "ratio" },
  crm_rate: { label: "Resultados que viraram oportunidade", unit: "pct" },
  // O funil do CRM (oportunidades criadas no ciclo).
  crm_open: { label: "Oportunidades abertas", unit: "count" },
  crm_won_deals: { label: "Oportunidades ganhas", unit: "count" },
  crm_lost: { label: "Oportunidades perdidas", unit: "count" },
  crm_lost_rate: { label: "Taxa de perda (CRM)", unit: "pct" },
  crm_qualified: { label: "Oportunidades qualificadas", unit: "count" },
  crm_score: { label: "Pontuação média da qualificação", unit: "ratio" },
  // Só no total: a meta do ciclo e o que o MAVI conta.
  goal_results: { label: "Meta de resultados do ciclo", unit: "count" },
  goal_cpa: { label: "Custo por resultado da meta", unit: "money" },
  budget: { label: "Verba do ciclo", unit: "money" },
  mavi_results: { label: "Resultados que contam (MAVI)", unit: "count" },
  mavi_cpa: { label: "Custo por resultado (MAVI)", unit: "money" },
  cost_vs_goal: { label: "Custo × meta", unit: "pct" },
  spend_pace: { label: "Ritmo de gasto", unit: "pct" },
  results_pace: { label: "Ritmo de resultados", unit: "pct" },
  days_elapsed: { label: "Dias do ciclo passados", unit: "days" },
  days_total: { label: "Dias do ciclo", unit: "days" },
};
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
  return { key: "total", level: "total", name: "Campanha (total)", n };
}

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
      label: METRICS[metric]?.label ?? labels[metric],
      value,
      unit: METRICS[metric]?.unit ?? "count",
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
      action: typeof x.action === "string" ? x.action.trim().slice(0, 800) : "",
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

/**
 * As detecções automáticas (sem modelo, sempre conferidas):
 *  - conversões na plataforma e nenhuma oportunidade no CRM com o nome da
 *    campanha (UTM ausente ou errada);
 *  - UTMs do CRM quase iguais ao nome de uma campanha ou conjunto (só a
 *    grafia difere: maiúsculas, acentos, espaços);
 *  - custo por resultado do ciclo bem acima da meta.
 */
export function ruleInsights(m: InsightMaterial, a: Analysis, entities: Map<string, Entity>): Insight[] {
  const out: Insight[] = [];
  const ev = (entity: string, window: WindowKey, metric: string) =>
    buildEvidence(entities, [{ entity, window, metric }]);
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
        title: `${c.name}: conversões na plataforma e nenhum lead no CRM`,
        body: `No ciclo, a campanha registrou ${fmtCount(numOr(x.results))} ${a.result_label.toLowerCase() || "resultados"} na plataforma, mas nenhuma oportunidade com utm_campaign igual ao nome dela chegou ao MakeCRM.${
          near
            ? ` O CRM recebeu oportunidades com a UTM "${near.name}", quase igual ao nome da campanha: só a grafia difere.`
            : " É provável que as UTMs dos anúncios estejam ausentes ou com outro nome, ou que os leads não estejam chegando ao CRM."
        }`,
        action: near
          ? `Troque a UTM "${near.name}" pelo nome exato da campanha ("${c.name}") nos parâmetros de URL dos anúncios.`
          : `Confira os parâmetros de URL dos anúncios (${UTM_HINT[a.platform]}) e se o formulário ou a página leva as UTMs até o CRM.`,
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
        title: `UTM com grafia diferente de "${owner.name}"`,
        body: `${fmtCount(opp)} ${opp === 1 ? "oportunidade chegou" : "oportunidades chegaram"} ao MakeCRM com a UTM "${u.name}", quase igual ao nome ${owner.level === "campaign" ? "da campanha" : owner.level === "ad" ? "do anúncio" : "do conjunto"} "${owner.name}" — só a grafia difere. O CRM e a aba Plataforma ligam pelo nome exato, então esses leads não contam para ${owner.level === "campaign" ? "a campanha" : "ele"}.`,
        action: `Ajuste a UTM para "${owner.name}" (exatamente igual, com maiúsculas, acentos e espaços).`,
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
        title: `${c.name}: os leads chegam ao CRM sem a palavra-chave`,
        body: `${fmtCount(opp)} ${opp === 1 ? "oportunidade chegou" : "oportunidades chegaram"} ao MakeCRM pela campanha, mas nenhuma com utm_content: não dá para saber qual palavra-chave trouxe cada lead, nem qual chega à negociação. O Google não tem parâmetro com o nome da campanha ou do grupo (só ids), então os nomes vão escritos e a palavra vai pelo {keyword}.`,
        action: `Use ${UTM_HINT.google}.`,
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
        title: zero ? "Investimento sem resultados no ciclo" : "Custo por resultado acima da meta do ciclo",
        body: zero
          ? "O ciclo já investiu mais que o custo de dois resultados da meta e ainda não registrou resultados que contam."
          : `O custo por resultado do ciclo está em ${fmtCount(ratio!)}% da meta.`,
        action: "Veja abaixo onde o custo sobe (conjuntos, anúncios ou termos) antes de mexer no orçamento.",
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
  return out.filter((i) => i.evidence.length > 0);
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
export function applyFunnel(entities: Entity[], funnel: CrmFunnel): Record<string, string> {
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
export const INSIGHTS_INSTRUCTIONS = `Você é a MAVI, a inteligência de uma agência de marketing (seu nome é MAVI, no feminino). Aqui você é a analista sênior de tráfego pago da agência: lê os números de UMA campanha na plataforma (Meta Ads ou Google Ads), o resultado comercial no CRM (MakeCRM, ligado por UTM) e o contexto do cliente, e entrega insights técnicos, reais e aplicáveis para a equipe que opera a campanha.

O que é um bom insight:
- Específico: fala de um anúncio, conjunto/grupo, palavra-chave, termo de pesquisa, público ou da campanha, pelo nome.
- Cruzado: o melhor insight junta a plataforma com o CRM (ex.: "o anúncio X tem o CPL mais alto, mas é o que mais gera oportunidades no CRM"; "o conjunto Y converte barato na plataforma e quase nada vira oportunidade").
- Explicado: diga o porquê provável quando os dados permitirem (o texto/título do criativo, a promessa, o público, a correspondência da palavra-chave, a frequência alta, o horário…). Separe o que é fato (números) do que é hipótese ("provavelmente", "vale testar").
- Acionável: a ação é concreta (pausar, escalar duplicando o conjunto, mover verba de A para B, testar uma variação do criativo X com a promessa Y, negativar o termo Z, revisar a UTM…). Nada genérico como "teste novos criativos" ou "acompanhe os resultados".
- Novo: não repita insights anteriores ainda abertos com outras palavras. Se um anterior continua valendo, repita-o com o MESMO "topic" e o MESMO "target" (ele é confirmado, não duplicado). Se nada mudou, devolva menos insights.

Tipos ("kind"): "highlight" (destaque positivo), "opportunity" (oportunidade de ganho), "problem" (problema que custa dinheiro ou resultado), "tracking" (rastreamento/UTM/integração). Prioridade ("priority"): "high" (age hoje: dinheiro sendo perdido ou ganho relevante), "medium", "low".

Regras dos números (obrigatório):
- Toda afirmação numérica vem de "evidence": cada evidência aponta a entidade ("entity", a "key" do material), a janela ("window": cycle, d7, d15, d30 ou since_last) e a métrica ("metric", um nome da lista de métricas). O sistema preenche o valor a partir do material; evidência que não existe é descartada, e insight sem evidência é descartado.
- Use de 1 a 5 evidências por insight, as que provam o que você diz. No texto, cite números com moderação e sempre iguais aos do material, no formato brasileiro (R$ 1.234,56; 12,3%).
- Nunca invente números, nomes, metas, datas ou comparações que não estejam no material. Amostra pequena (poucos resultados ou poucos dias) pede cautela: diga isso ou não conclua.
- O dinheiro já vem na base indicada em "valores" (com ou sem M). Não fale de M, multiplicador ou índice de performance.
- Resultados na plataforma (results) seguem o que a plataforma otimiza; "Resultados que contam (MAVI)" é o que a agência conta para a meta do ciclo.
- O CRM liga pelo nome exato: utm_campaign = nome da campanha, utm_term = nome do conjunto (no Google, do grupo), utm_content = nome do anúncio (no Google, a palavra-chave, quando a agência usa {keyword}). Oportunidade zerada pode ser falta de UTM, não falta de lead.
- O funil do CRM (quando vem) mostra a QUALIDADE do lead de cada campanha, conjunto, anúncio ou palavra-chave: abertas, ganhas, perdidas, taxa de perda, quantas chegaram a cada etapa ("stage:…", ou além), os motivos de perda ("lost:…"), a faixa da qualificação ("bucket:…") e as respostas mais escolhidas no formulário ("answer:…"); os nomes estão em "funil_crm.legenda". Use isso para separar volume de qualidade (ex.: o conjunto mais barato que só gera leads perdidos por "sem orçamento"; a palavra-chave cara que leva à Negociação) e cite essas métricas nas evidências pelo nome da chave. O CRM não tem idade nem gênero do lead: o cruzamento com o público é pelo conjunto (o público dele na plataforma × a qualidade dos leads dele no CRM).
- As "detecções automáticas" já viram insights: não as repita; você pode aprofundar com outra conclusão (outro topic).
- Anúncios podem trazer "criativo" (o que a imagem ou o vídeo comunica: promessa, gancho, oferta, prova, formato — lido pela MAVI a partir da imagem e do texto) e "audio" (trecho da transcrição do vídeo). Use para explicar o porquê do desempenho (ex.: a promessa de frete grátis do anúncio que mais gera oportunidades no CRM) e para sugerir variações concretas; a descrição do criativo não é número e não entra nas evidências.
- "aprendizados_do_time" são regras que o time ensinou (para a agência, o produto ou este cliente): siga-as sempre; nunca sugira o que elas proíbem.
- Insights anteriores "dismissed" foram descartados pelo time (veja o "motivo"): não os traga de volta com outras palavras. "expired" ficaram dias abertos sem que ninguém agisse: o time não viu valor neles; só volte ao assunto se os números pioraram bem desde então, com um ângulo novo. "applied" já foram aplicados: veja "insights_aplicados" — se o efeito piorou, diga e sugira o ajuste; se melhorou, você pode sugerir levar a mesma ideia a outro conjunto ou anúncio.
- O contexto do cliente (dossiê, Radar, termômetro, reuniões) serve para interpretar e priorizar; não copie trechos dele nem exponha conversas internas.

Responda SOMENTE com um JSON, sem texto antes ou depois:
{"summary": "uma frase sobre o momento da campanha", "insights": [{"kind": "...", "priority": "...", "topic": "assunto curto e estável, ex.: anuncio-x-promessa-frete", "target": "key da entidade principal ou null", "title": "até 120 caracteres, direto", "body": "o que os dados mostram e o porquê provável, até 600 caracteres", "action": "o que fazer, até 300 caracteres", "evidence": [{"entity": "key", "window": "cycle", "metric": "crm_opportunities"}]}]}
No máximo 6 insights, do mais importante para o menos. Português do Brasil.

As métricas (nomes usados em "n" e em "evidence"): ${Object.entries(METRICS)
  .map(([k, v]) => `${k} = ${v.label}`)
  .join("; ")}. Cada entidade traz "n" por janela; "dentro_de" é a key da entidade de cima. A entidade "total" é a campanha toda, com a meta do ciclo.`;

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
    resultado_da_plataforma: a.result_label || undefined,
    janelas: windows,
    funil_crm:
      a.funnel === "ok" && a.labels && Object.keys(a.labels).length
        ? { legenda: a.labels }
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
    aa = { ...aa, entities: focus(aa.entities, { adsets: 8, ads: 8, keywords: 8, terms: 6, segments: 6 }) };
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
/** O que uma análise gastou das APIs e o quanto da cota a plataforma diz que já foi. */
export type Throttle = { platform: "meta" | "google"; scope: "account" | "platform"; minutes: number; reason: string };
export type ApiMeter = {
  meta: number;
  google: number;
  /** O maior consumo da cota informado pelo Meta (%), entre todas as respostas. */
  pct: number;
  /** Minutos até liberar, quando o Meta informa. */
  regainMinutes: number;
  throttle: Throttle | null;
};
export const newApiMeter = (): ApiMeter => ({ meta: 0, google: 0, pct: 0, regainMinutes: 0, throttle: null });
/** Os erros de limite do Meta (app, usuário, conta, Business Use Case). */
const META_THROTTLE = new Set([4, 17, 32, 613, ...Array.from({ length: 15 }, (_, i) => 80000 + i)]);

/**
 * O consumo que o Meta informa em cada resposta: X-Business-Use-Case-Usage
 * (por conta e tipo, com o tempo até liberar), X-Ad-Account-Usage,
 * X-FB-Ads-Insights-Throttle e X-App-Usage — o maior percentual vale.
 */
export function metaUsage(headers: Headers) {
  let pct = 0;
  let regain = 0;
  const read = (name: string) => {
    const raw = headers.get(name);
    if (!raw) return;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      return;
    }
    const visit = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(visit);
      if (!x || typeof x !== "object") return;
      for (const [k, val] of Object.entries(x as Row)) {
        if (typeof val === "object") visit(val);
        else if (typeof val === "number") {
          if (["call_count", "total_cputime", "total_time", "acc_id_util_pct", "app_id_util_pct"].includes(k))
            pct = Math.max(pct, val);
          if (k === "estimated_time_to_regain_access") regain = Math.max(regain, val);
          if (k === "reset_time_duration") regain = Math.max(regain, Math.ceil(val / 60));
        }
      }
    };
    visit(v);
  };
  for (const h of ["x-business-use-case-usage", "x-ad-account-usage", "x-fb-ads-insights-throttle", "x-app-usage"])
    read(h);
  return { pct, regain };
}

/** Um fetch que conta as chamadas e percebe a cota (sem mudar as leituras). */
export function meteredFetch(base: Fetch, meter: ApiMeter): Fetch {
  return (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await base(input, init);
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    if (host === "graph.facebook.com") {
      meter.meta++;
      const u = metaUsage(res.headers);
      meter.pct = Math.max(meter.pct, u.pct);
      meter.regainMinutes = Math.max(meter.regainMinutes, u.regain);
      if (!res.ok) {
        const body = (await res.clone().json().catch(() => null)) as { error?: { code?: number } } | null;
        const code = Number(body?.error?.code);
        if (META_THROTTLE.has(code))
          meter.throttle = {
            platform: "meta",
            scope: code === 4 ? "platform" : "account",
            minutes: Math.max(u.regain, code === 4 || code === 17 ? 60 : 15),
            reason: `Meta: limite de requisições (código ${code})`,
          };
      }
    } else if (host === "googleads.googleapis.com") {
      meter.google++;
      if (!res.ok) {
        const text = await res.clone().text().catch(() => "");
        if (/RESOURCE_EXHAUSTED/.test(text)) {
          const delay = Number(/"retryDelay"\s*:\s*"(\d+)s"/.exec(text)?.[1] ?? 0);
          meter.throttle = {
            platform: "google",
            scope: "platform",
            minutes: Math.max(Math.ceil(delay / 60), 60),
            reason: "Google Ads: cota do developer token esgotada (RESOURCE_EXHAUSTED)",
          };
        }
      }
    }
    return res;
  }) as Fetch;
}

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
async function googleSearchFor(env: AdsEnv, fetchImpl: Fetch, refreshCipher: string) {
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
  const labels = funnel ? applyFunnel(entities, funnel) : {};
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
    const parsed = parseInsights(result.text, entities, 6, full.labels ?? {});
    summary = parsed.summary;
    found = parsed.insights;
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
) {
  const now = deps.now ?? Date.now;
  const deadline = now() + (env.insightsBudgetMs ?? 240_000);
  const stats = { done: 0, skipped: 0, deferred: 0, failed: 0, insights: 0, learned: 0 };
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

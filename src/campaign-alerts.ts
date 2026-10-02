/**
 * Campanhas › Meus avisos (migração 20270218090000_campaign_alerts): o
 * formato de uma regra de aviso, o catálogo de métricas e condições, o
 * ajuste e a conferência (os mesmos do banco) e a frase que descreve a
 * regra. Vale na tela, no servidor (a MAVI que monta a regra) e no cartão de
 * confirmação da conversa. Quem grava é sempre save_campaign_alert_rule.
 */

export const ALERT_PLATFORMS = ["meta", "google", "linkedin", "tiktok", "kwai"] as const;
export type AlertPlatform = (typeof ALERT_PLATFORMS)[number];
export const ALERT_PLATFORM_LABELS: Record<AlertPlatform, string> = {
  meta: "Meta",
  google: "Google",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  kwai: "Kwai",
};
export const ALERT_OBJECTIVES = ["lead", "sale", "message", "traffic", "engagement", "custom", "video"] as const;
export type AlertObjective = (typeof ALERT_OBJECTIVES)[number];
export const ALERT_OBJECTIVE_LABELS: Record<AlertObjective, string> = {
  lead: "Leads",
  sale: "Vendas",
  message: "Mensagens",
  traffic: "Tráfego",
  engagement: "Engajamento",
  custom: "Personalizado",
  video: "Visualizações de vídeo",
};

export const ALERT_METRICS = [
  "spend",
  "conversions",
  "cpa",
  "ctr",
  "cpc",
  "cpm",
  "impressions",
  "clicks",
  "reach",
  "frequency",
  "media_left",
  "daily_budget",
  "spend_pace",
  "results_pace",
  "cost_vs_goal",
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];
export type AlertUnit = "money" | "number" | "percent";
export const METRIC_INFO: Record<
  AlertMetric,
  { label: string; unit: AlertUnit; cycle: boolean; zero: boolean; hint: string }
> = {
  spend: { label: "Consumo", unit: "money", cycle: false, zero: true, hint: "O que a campanha gastou." },
  conversions: { label: "Conversões", unit: "number", cycle: false, zero: true, hint: "Os resultados (leads, mensagens, vendas…)." },
  cpa: { label: "Custo por resultado", unit: "money", cycle: false, zero: false, hint: "Consumo ÷ conversões (CPL, CPA, custo por conversa)." },
  ctr: { label: "CTR", unit: "percent", cycle: false, zero: false, hint: "Cliques ÷ impressões." },
  cpc: { label: "CPC", unit: "money", cycle: false, zero: false, hint: "Consumo ÷ cliques." },
  cpm: { label: "CPM", unit: "money", cycle: false, zero: false, hint: "Consumo por mil impressões." },
  impressions: { label: "Impressões", unit: "number", cycle: false, zero: true, hint: "" },
  clicks: { label: "Cliques", unit: "number", cycle: false, zero: true, hint: "" },
  reach: { label: "Alcance", unit: "number", cycle: false, zero: true, hint: "Somado dia a dia (no ciclo, o acumulado da plataforma)." },
  frequency: { label: "Frequência", unit: "number", cycle: false, zero: false, hint: "Impressões ÷ alcance." },
  media_left: { label: "Mídia restante", unit: "money", cycle: true, zero: false, hint: "O que falta gastar da verba do ciclo." },
  daily_budget: { label: "Orçamento diário", unit: "money", cycle: true, zero: false, hint: "Mídia restante ÷ dias que faltam (hoje incluído)." },
  spend_pace: { label: "Ritmo de gasto", unit: "percent", cycle: true, zero: false, hint: "O gasto até ontem em % do esperado para os dias que passaram (100% = no ritmo)." },
  results_pace: { label: "Ritmo de resultados", unit: "percent", cycle: true, zero: false, hint: "As conversões até ontem em % do esperado pela meta do ciclo (100% = no ritmo)." },
  cost_vs_goal: { label: "Custo × meta", unit: "percent", cycle: true, zero: false, hint: "O custo por resultado do ciclo em % do custo da meta (verba ÷ meta). Acima de 100%, mais caro que o combinado." },
};
export const isMoney = (m: AlertMetric) => METRIC_INFO[m].unit === "money";

export const ALERT_CONDITIONS = ["above", "below", "unchanged", "zero", "rise", "drop"] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];
export const CONDITION_LABELS: Record<AlertCondition, string> = {
  above: "chegar a ou passar de",
  below: "ficar em ou abaixo de",
  unchanged: "ficar igual por",
  zero: "ficar zerado por",
  rise: "subir",
  drop: "cair",
};
/** As condições que valem para a métrica. */
export function conditionsFor(metric: AlertMetric): AlertCondition[] {
  const info = METRIC_INFO[metric];
  if (info.cycle) return ["above", "below"];
  return ALERT_CONDITIONS.filter((c) => c !== "zero" || info.zero);
}

export type AlertPeriod = "day" | "days" | "cycle";
export type AlertRepeat = "once" | "daily" | "every";
export type AlertChannel = "now" | "digest";

export type CampaignAlertRule = {
  id?: string;
  name: string;
  /** Uma campanha; nula: todas as ativas que passam pelos filtros. */
  campaign_id: string | null;
  client_ids: string[];
  product_ids: string[];
  platforms: AlertPlatform[];
  objectives: AlertObjective[];
  team_ids: string[];
  metric: AlertMetric;
  condition: AlertCondition;
  period: AlertPeriod;
  days: number;
  value: number | null;
  tolerance: number;
  with_m: boolean;
  repeat: AlertRepeat;
  repeat_days: number;
  channel: AlertChannel;
  active: boolean;
  origin?: "screen" | "mavi";
  labels?: {
    campaign: string | null;
    campaign_client: string | null;
    clients: string[];
    products: string[];
    teams: string[];
  };
  last_hit?: { day: string; detail: string; campaign: string | null } | null;
  hits_30d?: number;
  /** Com uma campanha aberta: se a regra vale para ela. */
  applies?: boolean;
};

export function blankRule(campaign: string | null = null): CampaignAlertRule {
  return {
    name: "",
    campaign_id: campaign,
    client_ids: [],
    product_ids: [],
    platforms: [],
    objectives: [],
    team_ids: [],
    metric: "spend",
    condition: "unchanged",
    period: "days",
    days: 3,
    value: null,
    tolerance: 0,
    with_m: false,
    repeat: "once",
    repeat_days: 3,
    channel: "now",
    active: true,
  };
}

const clampInt = (v: number, min: number, max: number) => Math.min(Math.max(Math.round(v), min), max);

/** O que não vale para a condição volta ao padrão (como o banco faz). */
export function normalizeRule(r: CampaignAlertRule): CampaignAlertRule {
  const out = { ...r, days: clampInt(r.days || 1, 1, 30), tolerance: Math.min(Math.max(r.tolerance || 0, 0), 50) };
  if (out.campaign_id) {
    out.client_ids = [];
    out.product_ids = [];
    out.platforms = [];
    out.objectives = [];
    out.team_ids = [];
  }
  if (METRIC_INFO[out.metric].cycle) {
    out.period = "cycle";
    out.days = 1;
  } else if (["unchanged", "zero", "rise", "drop"].includes(out.condition)) out.period = "days";
  else if (out.period !== "days") out.days = 1;
  if (out.condition !== "unchanged") out.tolerance = 0;
  if (out.condition === "unchanged" || out.condition === "zero") out.value = null;
  if (out.value !== null) out.value = Math.round(Math.abs(out.value) * 100) / 100;
  if (!isMoney(out.metric)) out.with_m = false;
  out.repeat_days = out.repeat === "every" ? clampInt(out.repeat_days || 3, 2, 30) : 3;
  return out;
}

/** O que está errado na regra (null: está boa). As mesmas mensagens do banco. */
export function ruleProblem(r: CampaignAlertRule): string | null {
  const name = r.name.trim();
  if (name.length < 2 || name.length > 120) return "Dê um nome de 2 a 120 caracteres ao aviso.";
  const info = METRIC_INFO[r.metric];
  if (info.cycle && r.condition !== "above" && r.condition !== "below")
    return `${info.label} é do ciclo: use "chegar a ou passar de" ou "ficar em ou abaixo de".`;
  if (r.condition === "zero" && !info.zero)
    return "Só consumo, conversões, impressões, cliques e alcance podem ficar zerados.";
  if (["above", "below", "rise", "drop"].includes(r.condition) && r.value === null)
    return r.condition === "rise" || r.condition === "drop" ? "Diga de quantos % é a variação." : "Diga o valor do limite.";
  if ((r.condition === "rise" || r.condition === "drop") && (r.value ?? 0) <= 0)
    return "A variação precisa ser maior que 0%.";
  if (r.condition === "unchanged" && r.days < 2) return 'Para "igual", conte ao menos 2 dias.';
  if ((r.condition === "above" || r.condition === "below") && r.period === "days" && r.days < 2)
    return 'Para "nos últimos dias", conte ao menos 2 dias.';
  return null;
}

// ------------------------------------------------------------ texto
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const num = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
export function formatAlertValue(metric: AlertMetric, value: number | null) {
  if (value === null) return "—";
  const unit = METRIC_INFO[metric].unit;
  // Espaço comum depois do "R$" (o Intl usa o inseparável), como o banco escreve.
  return unit === "money"
    ? brl.format(value).replace(/\u00a0/g, " ")
    : unit === "percent"
      ? `${num.format(value)}%`
      : num.format(value);
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Consumo igual por 3 dias", "Custo por resultado (no ciclo) a partir de R$ 20,00". */
export function conditionText(r: CampaignAlertRule) {
  const info = METRIC_INFO[r.metric];
  const window = info.cycle
    ? ""
    : r.period === "cycle"
      ? " (no ciclo)"
      : r.period === "days"
        ? ` (últimos ${r.days} dias)`
        : " (ontem)";
  const m = isMoney(r.metric) ? (r.with_m ? ", com M" : ", sem M") : "";
  const value = formatAlertValue(r.metric, r.value);
  switch (r.condition) {
    case "above":
      return `${info.label}${window} a partir de ${value}${m}`;
    case "below":
      return `${info.label}${window} em ou abaixo de ${value}${m}`;
    case "unchanged":
      return `${info.label} igual por ${plural(r.days, "dia", "dias")}${r.tolerance > 0 ? ` (±${num.format(r.tolerance)}%)` : ""}${m}`;
    case "zero":
      return `Sem ${info.label.toLowerCase()} por ${plural(r.days, "dia", "dias")}`;
    case "rise":
    case "drop": {
      const span = r.days === 1 ? "ontem × anteontem" : `${r.days} dias × ${r.days} anteriores`;
      return `${info.label} ${r.condition === "rise" ? "subir" : "cair"} ${num.format(r.value ?? 0)}% ou mais (${span})${m}`;
    }
  }
}

export function scopeText(r: CampaignAlertRule) {
  if (r.campaign_id)
    return r.labels?.campaign
      ? `${r.labels.campaign}${r.labels.campaign_client ? ` (${r.labels.campaign_client})` : ""}`
      : "Uma campanha";
  const parts = [
    r.labels?.clients.length ? r.labels.clients.join(", ") : r.client_ids.length ? plural(r.client_ids.length, "cliente", "clientes") : "",
    r.labels?.products.length ? r.labels.products.join(", ") : r.product_ids.length ? plural(r.product_ids.length, "produto", "produtos") : "",
    r.platforms.map((p) => ALERT_PLATFORM_LABELS[p]).join(", "),
    r.objectives.map((o) => ALERT_OBJECTIVE_LABELS[o]).join(", "),
    r.labels?.teams.length ? `equipe ${r.labels.teams.join(", ")}` : r.team_ids.length ? plural(r.team_ids.length, "equipe", "equipes") : "",
  ].filter(Boolean);
  return parts.length ? `Campanhas ativas: ${parts.join(" · ")}` : "Todas as campanhas ativas";
}

export function repeatText(r: Pick<CampaignAlertRule, "repeat" | "repeat_days">) {
  return r.repeat === "once"
    ? "avisa uma vez (de novo só depois de deixar de valer)"
    : r.repeat === "daily"
      ? "avisa todo dia enquanto valer"
      : `avisa a cada ${r.repeat_days} dias enquanto valer`;
}
export const channelText = (c: AlertChannel) => (c === "now" ? "na hora" : "no resumo das 11h");

/** A regra inteira em uma linha (lista, cartão da MAVI). */
export function describeRule(r: CampaignAlertRule) {
  return `${conditionText(r)} · ${scopeText(r)} · ${repeatText(r)} · ${channelText(r.channel)}`;
}

// ------------------------------------------------------------ entrada solta
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pickOne = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback;
const pickMany = <T extends string>(v: unknown, list: readonly T[]): T[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is T => list.includes(x as T)))] : [];
const ids = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && UUID.test(x)))].slice(0, 50) : [];
const number = (v: unknown) => {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * Uma regra a partir do que veio de fora (a MAVI, um cartão gravado): só os
 * campos e valores do catálogo; o resto vira o padrão. error: o que falta.
 */
export function ruleFromInput(raw: unknown): { rule: CampaignAlertRule; error: string | null } {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const base = blankRule();
  const metric = pickOne(a.metric, ALERT_METRICS, base.metric);
  const rule = normalizeRule({
    ...base,
    id: typeof a.id === "string" && UUID.test(a.id) ? a.id : undefined,
    name: typeof a.name === "string" ? a.name.trim().slice(0, 120) : "",
    campaign_id: typeof a.campaign_id === "string" && UUID.test(a.campaign_id) ? a.campaign_id : null,
    client_ids: ids(a.client_ids),
    product_ids: ids(a.product_ids),
    team_ids: ids(a.team_ids),
    platforms: pickMany(a.platforms, ALERT_PLATFORMS),
    objectives: pickMany(a.objectives, ALERT_OBJECTIVES),
    metric,
    condition: pickOne(a.condition, ALERT_CONDITIONS, conditionsFor(metric)[0]),
    period: pickOne(a.period, ["day", "days", "cycle"] as const, "day"),
    days: number(a.days) ?? 1,
    value: number(a.value),
    tolerance: number(a.tolerance) ?? 0,
    with_m: a.with_m === true,
    repeat: pickOne(a.repeat, ["once", "daily", "every"] as const, "once"),
    repeat_days: number(a.repeat_days) ?? 3,
    channel: pickOne(a.channel, ["now", "digest"] as const, "now"),
    active: a.active !== false,
    ...(a.origin === "mavi" ? { origin: "mavi" as const } : {}),
  });
  const labels = a.labels && typeof a.labels === "object" ? (a.labels as Record<string, unknown>) : null;
  if (labels) {
    const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 160) : null);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : []);
    rule.labels = {
      campaign: s(labels.campaign),
      campaign_client: s(labels.campaign_client),
      clients: list(labels.clients),
      products: list(labels.products),
      teams: list(labels.teams),
    };
  }
  if (!ALERT_METRICS.includes(a.metric as AlertMetric)) return { rule, error: "Escolha a métrica do aviso." };
  if (!ALERT_CONDITIONS.includes(a.condition as AlertCondition)) return { rule, error: "Escolha a condição do aviso." };
  return { rule, error: ruleProblem(rule) };
}

/** Um nome curto quando a pessoa não deu um: "Consumo igual por 3 dias". */
export function suggestedName(r: CampaignAlertRule) {
  const t = conditionText({ ...r, with_m: false, metric: r.metric }).replace(/, (com|sem) M$/, "");
  return t.length <= 80 ? t : `${t.slice(0, 79)}…`;
}

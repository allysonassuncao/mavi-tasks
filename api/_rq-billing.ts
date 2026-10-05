/**
 * Financeiro › Make Ads RQ (migração 20270430090000_make_ads_rq_billing).
 *
 * A conta do mês de um cliente: os leads do MakeCRM que geram cobrança
 * (sql/mavi_billing.sql no CRM: chegou à etapa ou passou dela, ou venda
 * ganha), o filtro de quais leads contam (todos, com UTM, por origem/campanha
 * do CRM), os ajustes à mão (tirar/incluir com motivo), o que já foi cobrado
 * em outro mês validado e o contrato (só variável, fixo + variável, mínimo
 * garantido, teto). O banco guarda a regra e congela o resultado ao validar.
 */

export type RqUtm = { s?: string | null; m?: string | null; c?: string | null; t?: string | null; n?: string | null };
/** Um lead que gera cobrança, como vem do CRM. */
export type RqLead = {
  key: string;
  deal_id: string;
  name: string;
  contact: string;
  phone: string;
  /** Quando chegou à etapa (ou foi ganho). */
  at: string;
  /** O CRM não registrou a entrada: a data é a melhor que havia. */
  estimated: boolean;
  /** Na venda: o valor fechado; na reunião: o valor da oportunidade. */
  value: number;
  status: number | null;
  stage: string;
  created_at: string | null;
  source_id: string | null;
  source: string;
  campaign_id: string | null;
  campaign: string;
  utms: RqUtm[];
};
export type RqLeadFilter =
  | { mode: "all" }
  | { mode: "utm"; utm_sources?: string[] }
  | { mode: "crm"; sources?: { id: string; name: string }[]; campaigns?: { id: string; name: string }[] };
export type RqConfig = {
  model: "meeting" | "sale";
  pipeline_id: string | null;
  pipeline_name: string;
  stage_id: string | null;
  stage_name: string;
  price_kind: "fixed" | "percent";
  unit_price: number | null;
  percent: number | null;
  contract_kind: "variable" | "fixed_plus" | "minimum";
  fixed_amount: number | null;
  cap: number | null;
  lead_filter: RqLeadFilter;
};
export type RqAdjustment = {
  key: string;
  action: "exclude" | "include";
  reason: string;
  lead: Partial<RqLead>;
  created_at: string;
  by: string | null;
};
/** Por que um lead ficou de fora da conta. */
export type RqOutside = "filtered" | "excluded" | "billed";
export type RqRow = RqLead & {
  /** Incluído à mão (com o motivo) ou tirado (com o motivo). */
  adjustment?: { action: "exclude" | "include"; reason: string; by: string | null; created_at: string } | null;
  /** Fora da conta: por quê. */
  outside?: RqOutside;
  /** O mês em que já foi cobrado. */
  billed_month?: string;
  /** Não veio do CRM nesta conta: só o que foi guardado ao incluir. */
  manual?: boolean;
};
export type RqTotals = {
  count: number;
  /** Soma dos valores (na venda, o que foi vendido). */
  sales_value: number;
  variable: number;
  fixed: number;
  total: number;
  minimum_applied: boolean;
  capped: boolean;
  spend_net: number;
  spend_gross: number;
  /** Receita − mídia investida (gasto real na plataforma). */
  result: number;
  margin: number | null;
  media_per_lead: number | null;
  revenue_per_lead: number | null;
  estimated: number;
};
export type RqResult = { leads: RqRow[]; outside: RqRow[]; totals: RqTotals };

const cents = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const fold = (v: unknown) => text(v).trim().toLowerCase();

/** Só o que é bem formado (o CRM é outro sistema). */
export function rqLeadsFrom(raw: any): RqLead[] {
  const rows = Array.isArray(raw?.rows) ? raw.rows : [];
  return rows
    .filter((r: any) => r && typeof r.key === "string" && r.key && typeof r.deal_id === "string")
    .map((r: any) => ({
      key: r.key,
      deal_id: r.deal_id,
      name: text(r.name),
      contact: text(r.contact),
      phone: text(r.phone),
      at: text(r.at),
      estimated: r.estimated === true,
      value: num(r.value),
      status: typeof r.status === "number" ? r.status : null,
      stage: text(r.stage),
      created_at: r.created_at ? text(r.created_at) : null,
      source_id: r.source_id === null || r.source_id === undefined ? null : text(r.source_id),
      source: text(r.source),
      campaign_id: r.campaign_id === null || r.campaign_id === undefined ? null : text(r.campaign_id),
      campaign: text(r.campaign),
      utms: Array.isArray(r.utms) ? r.utms.filter((u: any) => u && typeof u === "object").slice(0, 5) : [],
    }));
}

/** O lead passa no filtro de quais leads contam? */
export function rqMatches(lead: RqLead, filter: RqLeadFilter | null | undefined): boolean {
  if (!filter || filter.mode === "all") return true;
  if (filter.mode === "utm") {
    const withUtm = lead.utms.filter((u) => [u.s, u.m, u.c, u.t, u.n].some((x) => fold(x)));
    if (!withUtm.length) return false;
    const wanted = (filter.utm_sources ?? []).map(fold).filter(Boolean);
    return !wanted.length || withUtm.some((u) => wanted.includes(fold(u.s)));
  }
  // Origem e campanha do CRM: escolhidas as duas, o lead precisa bater nas duas.
  const sources = (filter.sources ?? []).map((x) => String(x.id));
  const campaigns = (filter.campaigns ?? []).map((x) => String(x.id));
  if (!sources.length && !campaigns.length) return true;
  return (
    (!sources.length || (lead.source_id !== null && sources.includes(lead.source_id))) &&
    (!campaigns.length || (lead.campaign_id !== null && campaigns.includes(lead.campaign_id)))
  );
}

/** A receita do mês pela regra do contrato. */
export function rqRevenue(config: RqConfig, count: number, salesValue: number) {
  const variable = cents(
    config.price_kind === "percent" ? (salesValue * num(config.percent)) / 100 : count * num(config.unit_price),
  );
  const fixedAmount = num(config.fixed_amount);
  let total = variable;
  let fixed = 0;
  let minimum_applied = false;
  if (config.contract_kind === "fixed_plus") {
    fixed = fixedAmount;
    total = variable + fixedAmount;
  } else if (config.contract_kind === "minimum" && variable < fixedAmount) {
    fixed = cents(fixedAmount - variable);
    total = fixedAmount;
    minimum_applied = true;
  }
  const cap = config.cap === null || config.cap === undefined ? null : num(config.cap);
  const capped = cap !== null && cap > 0 && total > cap;
  if (capped) total = cap!;
  return { variable, fixed: cents(fixed), total: cents(total), minimum_applied, capped };
}

/**
 * A conta: os leads que geram cobrança (passaram no filtro, não foram
 * tirados e não foram cobrados em outro mês validado, mais os incluídos à
 * mão), os que ficaram de fora (para incluir) e os totais com a mídia.
 */
export function rqCompute(
  config: RqConfig,
  crmLeads: RqLead[],
  adjustments: RqAdjustment[],
  billed: Record<string, string>,
  spend: { net?: unknown; gross?: unknown } | null,
): RqResult {
  const adj = new Map(adjustments.map((a) => [a.key, a]));
  const leads: RqRow[] = [];
  const outside: RqRow[] = [];
  const seen = new Set<string>();
  for (const lead of crmLeads) {
    if (seen.has(lead.key)) continue;
    seen.add(lead.key);
    const a = adj.get(lead.key);
    const adjustment = a ? { action: a.action, reason: a.reason, by: a.by, created_at: a.created_at } : null;
    if (billed[lead.key]) {
      outside.push({ ...lead, outside: "billed", billed_month: billed[lead.key], adjustment });
      continue;
    }
    if (a?.action === "exclude") outside.push({ ...lead, outside: "excluded", adjustment });
    else if (a?.action === "include" || rqMatches(lead, config.lead_filter)) leads.push({ ...lead, adjustment });
    else outside.push({ ...lead, outside: "filtered", adjustment: null });
  }
  // Incluídos à mão que o CRM não trouxe nesta conta (mudou de data, de etapa…).
  for (const a of adjustments) {
    if (a.action !== "include" || seen.has(a.key) || billed[a.key]) continue;
    const l = a.lead ?? {};
    leads.push({
      key: a.key,
      deal_id: text(l.deal_id) || a.key.split(":")[0],
      name: text(l.name),
      contact: text(l.contact),
      phone: text(l.phone),
      at: text(l.at),
      estimated: l.estimated === true,
      value: num(l.value),
      status: null,
      stage: text(l.stage),
      created_at: l.created_at ? text(l.created_at) : null,
      source_id: l.source_id ? text(l.source_id) : null,
      source: text(l.source),
      campaign_id: l.campaign_id ? text(l.campaign_id) : null,
      campaign: text(l.campaign),
      utms: Array.isArray(l.utms) ? l.utms : [],
      manual: true,
      adjustment: { action: "include", reason: a.reason, by: a.by, created_at: a.created_at },
    });
  }
  const byDate = (x: RqRow, y: RqRow) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0);
  leads.sort(byDate);
  outside.sort(byDate);
  const count = leads.length;
  const salesValue = cents(leads.reduce((s, l) => s + num(l.value), 0));
  const revenue = rqRevenue(config, count, salesValue);
  const spendNet = cents(num(spend?.net));
  const spendGross = cents(num(spend?.gross));
  const result = cents(revenue.total - spendNet);
  return {
    leads,
    outside,
    totals: {
      count,
      sales_value: salesValue,
      ...revenue,
      spend_net: spendNet,
      spend_gross: spendGross,
      result,
      margin: revenue.total > 0 ? Math.round((result / revenue.total) * 1000) / 1000 : null,
      media_per_lead: count ? cents(spendNet / count) : null,
      revenue_per_lead: count ? cents(revenue.total / count) : null,
      estimated: leads.filter((l) => l.estimated).length,
    },
  };
}

/** O que fica guardado de cada lead no fechamento validado. */
export const rqFrozenLead = (l: RqRow) => ({
  key: l.key,
  deal_id: l.deal_id,
  name: l.name,
  contact: l.contact,
  phone: l.phone,
  at: l.at,
  estimated: l.estimated,
  value: l.value,
  stage: l.stage,
  source: l.source,
  campaign: l.campaign,
  ...(l.manual ? { manual: true } : {}),
  ...(l.adjustment ? { adjustment: l.adjustment } : {}),
});

/** O começo e o fim do mês em Brasília, como o CRM pede. */
export function rqMonthRange(month: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return {
    start: `${month}-01T00:00:00.000-03:00`,
    end: `${month}-${String(last).padStart(2, "0")}T23:59:59.999-03:00`,
  };
}

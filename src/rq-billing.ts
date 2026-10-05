import { supabase } from "./supabase";

/**
 * Financeiro › Make Ads RQ (migração 20270430090000_make_ads_rq_billing).
 *
 * Clientes com o produto "Make Ads RQ" pagam por resultado, todo mês, pelo
 * mês anterior: por reunião qualificada (o lead chegou a uma etapa do funil
 * do MakeCRM, ou passou dela) ou por venda realizada (ganho no CRM). A regra
 * fica no modal "Etapas que importam no CRM" da campanha; o fechamento, no
 * Financeiro › Make Ads RQ e na própria campanha. A conta junta os leads do
 * CRM na hora (api/_rq-billing.ts); validar congela.
 */

export type RqModel = "meeting" | "sale";
export type RqPriceKind = "fixed" | "percent";
export type RqContractKind = "variable" | "fixed_plus" | "minimum";
export type RqNamed = { id: string; name: string };
export type RqLeadFilter =
  | { mode: "all" }
  | { mode: "utm"; utm_sources?: string[] }
  | { mode: "crm"; sources?: RqNamed[]; campaigns?: RqNamed[] };
export type RqConfig = {
  model: RqModel;
  pipeline_id: string | null;
  pipeline_name: string;
  stage_id: string | null;
  stage_name: string;
  price_kind: RqPriceKind;
  unit_price: number | null;
  percent: number | null;
  contract_kind: RqContractKind;
  fixed_amount: number | null;
  cap: number | null;
  lead_filter: RqLeadFilter;
  updated_at?: string;
  updated_by_name?: string | null;
};
/** O que a tela manda (valores como digitados). */
export type RqConfigInput = {
  model: RqModel;
  pipeline_id: string | null;
  pipeline_name: string;
  stage_id: string | null;
  stage_name: string;
  price_kind: RqPriceKind;
  unit_price: string;
  percent: string;
  contract_kind: RqContractKind;
  fixed_amount: string;
  cap: string;
  lead_filter: RqLeadFilter;
};
export type RqBillingView = { is_rq: boolean; can_edit: boolean; config: RqConfig | null };

export type RqUtm = { s?: string | null; m?: string | null; c?: string | null; t?: string | null; n?: string | null };
export type RqAdjustmentNote = { action: "exclude" | "include"; reason: string; by: string | null; created_at: string };
export type RqRow = {
  key: string;
  deal_id: string;
  name: string;
  contact: string;
  phone: string;
  at: string;
  estimated: boolean;
  value: number;
  status?: number | null;
  stage: string;
  created_at?: string | null;
  source_id?: string | null;
  source: string;
  campaign_id?: string | null;
  campaign: string;
  utms?: RqUtm[];
  adjustment?: RqAdjustmentNote | null;
  outside?: "filtered" | "excluded" | "billed";
  billed_month?: string;
  manual?: boolean;
};
export type RqTotals = {
  count: number;
  sales_value: number;
  variable: number;
  fixed: number;
  total: number;
  minimum_applied: boolean;
  capped: boolean;
  spend_net: number;
  spend_gross: number;
  result: number;
  margin: number | null;
  media_per_lead: number | null;
  revenue_per_lead: number | null;
  estimated: number;
};
export type RqClosing = {
  status: "validated" | "reopened";
  config?: RqConfig;
  totals: RqTotals;
  validated_at: string | null;
  validated_by_name: string | null;
  reopened_at: string | null;
  reopened_by_name: string | null;
  reopen_reason: string | null;
};
export type RqMonthView = {
  client: string;
  client_name: string;
  month: string;
  is_rq: boolean;
  closed_month: boolean;
  current_month: boolean;
  today: string;
  config: RqConfig | null;
  closing: RqClosing | null;
  can_reopen: boolean;
  spend: { net: number; gross: number; campaigns: number };
};
export type RqMonth = {
  view: RqMonthView;
  crm_url: string;
  frozen?: boolean;
  /** O que falta para contar: a regra ou a ligação com o MakeCRM. */
  missing?: "config" | "crm";
  result?: { leads: RqRow[]; outside: RqRow[]; totals: RqTotals };
};
export type RqOverviewClient = {
  client: string;
  client_name: string;
  color: string | null;
  config: RqConfig | null;
  closing: RqClosing | null;
  linked: boolean;
  spend: { net: number; gross: number; campaigns: number };
  /** Uma campanha do cliente (a do RQ, ativa primeiro), para abrir a regra. */
  campaign: string | null;
};
export type RqOverview = {
  month: string;
  closed_month: boolean;
  current_month: boolean;
  can_reopen: boolean;
  clients: RqOverviewClient[];
};
export type RqEvent = {
  action: "config" | "exclude" | "include" | "undo" | "validated" | "reopened";
  reason: string | null;
  detail: Record<string, any>;
  month: string | null;
  created_at: string;
  user_name: string | null;
};
export type RqCrmOptions = {
  linked: boolean;
  pipelines: { id: string; name: string; stages: { id: string; name: string; order: number | null }[] }[];
  sources: RqNamed[];
  campaigns: RqNamed[];
};

export interface RqBackend {
  billing(company: string, client: string): Promise<RqBillingView>;
  /** Grava a regra do cliente; nulo remove. */
  setBilling(company: string, client: string, config: RqConfigInput | null): Promise<RqConfig | null>;
  overview(company: string, month: string): Promise<RqOverview>;
  month(company: string, client: string, month: string): Promise<RqMonth>;
  validate(company: string, client: string, month: string): Promise<RqMonth>;
  /** Tira ou inclui um lead (com motivo); nulo desfaz. */
  adjust(company: string, client: string, month: string, lead: RqRow, action: "exclude" | "include" | null, reason?: string): Promise<void>;
  reopen(company: string, client: string, month: string, reason: string): Promise<void>;
  events(company: string, client: string, month: string): Promise<RqEvent[]>;
  crmOptions(company: string, client: string): Promise<RqCrmOptions>;
}

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}
const crm = async <T>(body: Record<string, unknown>) => {
  const { crmServer } = await import("./CampaignCrm");
  return crmServer<T>(body);
};
const numbers = <T extends RqConfig | null>(c: T): T =>
  (c
    ? {
        ...c,
        unit_price: c.unit_price === null ? null : Number(c.unit_price),
        percent: c.percent === null ? null : Number(c.percent),
        fixed_amount: c.fixed_amount === null ? null : Number(c.fixed_amount),
        cap: c.cap === null ? null : Number(c.cap),
      }
    : c) as T;
/** O lead como fica guardado no ajuste (para mostrar e, incluído, contar). */
const leadNote = (l: RqRow) => ({
  deal_id: l.deal_id,
  name: l.name,
  contact: l.contact,
  phone: l.phone,
  at: l.at,
  estimated: l.estimated,
  value: l.value,
  stage: l.stage,
  source_id: l.source_id ?? null,
  source: l.source,
  campaign_id: l.campaign_id ?? null,
  campaign: l.campaign,
  utms: l.utms ?? [],
});

export const serverRq: RqBackend = {
  async billing(company, client) {
    const v = await rpc<RqBillingView>("rq_billing", { p_company: company, p_client: client });
    return { ...v, config: numbers(v.config) };
  },
  async setBilling(company, client, config) {
    return numbers(await rpc<RqConfig | null>("set_rq_billing", { p_company: company, p_client: client, p_config: config }));
  },
  async overview(company, month) {
    const o = await rpc<RqOverview>("rq_overview", { p_company: company, p_month: month });
    return { ...o, clients: o.clients.map((c) => ({ ...c, config: numbers(c.config) })) };
  },
  month: (company, client, month) => crm<RqMonth>({ action: "rq-month", company, client, month }),
  validate: (company, client, month) => crm<RqMonth>({ action: "rq-validate", company, client, month }),
  adjust: (company, client, month, lead, action, reason) =>
    rpc<void>("rq_adjust", {
      p_company: company,
      p_client: client,
      p_month: month,
      p_key: lead.key,
      p_action: action,
      p_reason: reason ?? null,
      p_lead: action ? leadNote(lead) : null,
    }),
  reopen: (company, client, month, reason) =>
    rpc<void>("rq_reopen", { p_company: company, p_client: client, p_month: month, p_reason: reason }),
  events: (company, client, month) => rpc<RqEvent[]>("rq_events", { p_company: company, p_client: client, p_month: month }),
  async crmOptions(company, client) {
    const r = await crm<Partial<RqCrmOptions>>({ action: "pipelines", company, client });
    return { linked: !!r.linked, pipelines: r.pipelines ?? [], sources: r.sources ?? [], campaigns: r.campaigns ?? [] };
  },
};

// ------------------------------------------------------------ textos
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const rqMoney = brl;
export const RQ_MODEL_LABEL: Record<RqModel, string> = {
  meeting: "Por reunião qualificada",
  sale: "Por venda realizada",
};
/** "R$ 150,00 por reunião (Reunião qualificada)" / "10% de cada venda". */
export function rqPriceText(c: RqConfig) {
  const price =
    c.price_kind === "percent"
      ? `${(c.percent ?? 0).toLocaleString("pt-BR", { maximumFractionDigits: 3 })}% de cada venda`
      : `${brl(c.unit_price ?? 0)} por ${c.model === "meeting" ? "reunião" : "venda"}`;
  return c.model === "meeting" && c.stage_name ? `${price} (${c.stage_name})` : price;
}
/** "mínimo de R$ 1.000,00 · teto R$ 5.000,00". */
export function rqContractText(c: RqConfig) {
  const parts: string[] = [];
  if (c.contract_kind === "fixed_plus" && c.fixed_amount) parts.push(`+ ${brl(c.fixed_amount)} fixo`);
  if (c.contract_kind === "minimum" && c.fixed_amount) parts.push(`mínimo de ${brl(c.fixed_amount)}`);
  if (c.cap) parts.push(`teto ${brl(c.cap)}`);
  return parts.join(" · ");
}
export function rqFilterText(f: RqLeadFilter | null | undefined) {
  if (!f || f.mode === "all") return "Todos os leads do funil";
  if (f.mode === "utm")
    return f.utm_sources?.length ? `Com UTM (utm_source: ${f.utm_sources.join(", ")})` : "Só leads com UTM";
  const parts = [
    f.sources?.length ? `origem ${f.sources.map((x) => x.name).join(", ")}` : "",
    f.campaigns?.length ? `campanha ${f.campaigns.map((x) => x.name).join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `CRM: ${parts.join(" e ")}` : "Todos os leads do funil";
}
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** "setembro de 2026". */
export function rqMonthName(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} de ${y}`;
}
/** "2026-09" ± n meses. */
export function rqShiftMonth(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
/** O mês corrente e o anterior no fuso de Brasília. */
export function rqMonths(now = new Date()) {
  const local = new Date(now.getTime() - 3 * 3600_000);
  const current = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
  return { current, previous: rqShiftMonth(current, -1) };
}
/** O produto contratado é o Make Ads RQ (pelo nome, igual ao banco). */
export const isRqProduct = (name: string | null | undefined) =>
  (name ?? "").trim().replace(/\s+/g, " ").toLowerCase() === "make ads rq";

/** A config salva como a tela edita. */
export function rqInputFrom(c: RqConfig | null): RqConfigInput {
  const s = (v: number | null) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
  return {
    model: c?.model ?? "meeting",
    pipeline_id: c?.pipeline_id ?? null,
    pipeline_name: c?.pipeline_name ?? "",
    stage_id: c?.stage_id ?? null,
    stage_name: c?.stage_name ?? "",
    price_kind: c?.price_kind ?? "fixed",
    unit_price: s(c?.unit_price ?? null),
    percent: s(c?.percent ?? null),
    contract_kind: c?.contract_kind ?? "variable",
    fixed_amount: s(c?.fixed_amount ?? null),
    cap: s(c?.cap ?? null),
    lead_filter: c?.lead_filter ?? { mode: "all" },
  };
}
/** Os valores digitados ("1.500,50") como o banco lê ("1500.50"). */
export function rqNumber(v: string) {
  const t = v.trim();
  if (!t) return "";
  return t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
}
export function rqInputOut(i: RqConfigInput): RqConfigInput {
  return {
    ...i,
    price_kind: i.model === "meeting" ? "fixed" : i.price_kind,
    unit_price: rqNumber(i.unit_price),
    percent: rqNumber(i.percent),
    fixed_amount: i.contract_kind === "variable" ? "" : rqNumber(i.fixed_amount),
    cap: rqNumber(i.cap),
  };
}

// ------------------------------------------------------------ demonstração
/** Sem banco: um cliente de exemplo, só leitura. */
export function demoRq(): RqBackend {
  const config: RqConfig = {
    model: "meeting",
    pipeline_id: "p1",
    pipeline_name: "Vendas",
    stage_id: "s3",
    stage_name: "Reunião qualificada",
    price_kind: "fixed",
    unit_price: 150,
    percent: null,
    contract_kind: "minimum",
    fixed_amount: 1500,
    cap: null,
    lead_filter: { mode: "all" },
  };
  const lead = (i: number, extra: Partial<RqRow> = {}): RqRow => ({
    key: `d${i}`,
    deal_id: `d${i}`,
    name: `Oportunidade ${i}`,
    contact: ["Ana Souza", "Bruno Lima", "Carla Dias", "Diego Reis", "Elisa Prado"][i % 5],
    phone: "",
    at: `2026-09-${String(Math.min(2 + i * 2, 29)).padStart(2, "0")}T14:00:00-03:00`,
    estimated: i === 3,
    value: 0,
    stage: "Reunião qualificada",
    source: "Meta Ads",
    campaign: "",
    ...extra,
  });
  const leads = Array.from({ length: 12 }, (_, i) => lead(i + 1));
  const totals: RqTotals = {
    count: 12, sales_value: 0, variable: 1800, fixed: 0, total: 1800, minimum_applied: false, capped: false,
    spend_net: 1200, spend_gross: 1560, result: 600, margin: 0.333, media_per_lead: 100, revenue_per_lead: 150, estimated: 1,
  };
  const view = (month: string): RqMonthView => ({
    client: "demo", client_name: "Clínica Exemplo", month, is_rq: true, closed_month: true, current_month: false,
    today: "2026-10-05", config, closing: null, can_reopen: true, spend: { net: 1200, gross: 1560, campaigns: 1 },
  });
  const readOnly = () => Promise.reject(Error("Na demonstração, o fechamento é só leitura."));
  return {
    billing: async () => ({ is_rq: true, can_edit: true, config }),
    setBilling: readOnly,
    overview: async (_c, month) => ({
      month, closed_month: true, current_month: false, can_reopen: true,
      clients: [{ client: "demo", client_name: "Clínica Exemplo", color: "#8576cf", config, closing: null, linked: true,
        spend: { net: 1200, gross: 1560, campaigns: 1 }, campaign: null }],
    }),
    month: async (_c, _cl, month) => ({
      view: view(month), crm_url: "https://app.usemakecrm.com.br", frozen: false,
      result: { leads, outside: [lead(20, { outside: "filtered", source: "Indicação" })], totals },
    }),
    validate: readOnly,
    adjust: readOnly,
    reopen: readOnly,
    events: async () => [],
    crmOptions: async () => ({
      linked: true,
      pipelines: [{ id: "p1", name: "Vendas", stages: [
        { id: "s1", name: "Novo lead", order: 1 }, { id: "s2", name: "Contato feito", order: 2 },
        { id: "s3", name: "Reunião qualificada", order: 3 }, { id: "s4", name: "Proposta", order: 4 },
      ] }],
      sources: [{ id: "1", name: "Meta Ads" }, { id: "2", name: "Indicação" }],
      campaigns: [],
    }),
  };
}

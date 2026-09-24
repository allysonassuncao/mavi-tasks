import { supabase } from "./supabase";
import { fetchAllRows, rpc } from "./api";
import type { MetricsBackend } from "./campaign-metrics";

/**
 * Campanhas (tráfego pago): each belongs to a contracted product and goes
 * through cycles — periods in which a media budget is spent, with an
 * objective and an expected number of results. The end of a cycle is when
 * the next investment has to come in. The current cycle changes only by
 * hand. Tables and rules: supabase/migrations/20260930090000_ad_campaigns.sql.
 */
export type AdPlatform = "meta" | "google" | "linkedin" | "tiktok" | "kwai";
export type AdObjective =
  "lead" | "sale" | "message" | "traffic" | "engagement" | "custom" | "video";
export type AdDestination = "lead_form" | "external_page" | "make_landing_page";
export type AdCampaignStatus = "active" | "inactive";

export interface AdCampaign {
  id: string;
  company_id: string;
  contract_id: string;
  name: string;
  platform: AdPlatform;
  status: AdCampaignStatus;
  current_cycle_id: string | null;
  briefing_url: string;
  media_plan_url: string;
  notes: string;
  archived: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
}
/** An ad account and, optionally, one of its campaigns on the platform. */
export interface AdCycleLink {
  account_id: string;
  campaign_id: string;
  /** Google: the MCC the account is reached through (login-customer-id). */
  manager_id?: string;
  /** Names as they were when picked from the platform. */
  account_name?: string;
  campaign_name?: string;
}
export interface AdCycle {
  id: string;
  company_id: string;
  campaign_id: string;
  /** First day of the financial month (YYYY-MM-01). */
  competence_month: string;
  start_date: string;
  end_date: string;
  objective: AdObjective;
  goal_results: number;
  budget: number;
  /** "Índice de performance" (M) of the operation. */
  multiplier: number;
  destination: AdDestination;
  landing_pages: string[];
  niche: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
  links: AdCycleLink[];
}
export interface AdCampaignEvent {
  id: number;
  campaign_id: string;
  cycle_id: string | null;
  actor_id: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}
export interface CampaignData {
  campaigns: AdCampaign[];
  cycles: AdCycle[];
}

export const platforms: Record<AdPlatform, string> = {
  meta: "Meta Ads",
  google: "Google Ads",
  linkedin: "LinkedIn Ads",
  tiktok: "TikTok Ads",
  kwai: "Kwai Ads",
};
export const objectives: Record<
  AdObjective,
  { label: string; result: string }
> = {
  lead: { label: "Lead", result: "leads" },
  message: { label: "Mensagem", result: "conversas" },
  sale: { label: "Venda", result: "vendas" },
  traffic: { label: "Tráfego", result: "cliques" },
  engagement: { label: "Engajamento", result: "engajamentos" },
  custom: { label: "Conversão personalizada", result: "conversões" },
  video: { label: "Vídeo", result: "visualizações" },
};
export const destinations: Record<AdDestination, string> = {
  external_page: "Página externa (site do cliente)",
  lead_form: "Formulário instantâneo (Lead Ads)",
  make_landing_page: "Página de captura da Make",
};
export const campaignStatuses: Record<AdCampaignStatus, string> = {
  active: "Ativa",
  inactive: "Inativa",
};

/* ------------------------------------------------------------------ */
/* Dates (YYYY-MM-DD, read at noon UTC so no time zone shifts the day) */

const DAY = 86_400_000;
const at = (date: string) => Date.parse(`${date.slice(0, 10)}T12:00:00Z`);
export function addDays(date: string, days: number) {
  return new Date(at(date) + days * DAY).toISOString().slice(0, 10);
}
/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string) {
  return Math.round((at(to) - at(from)) / DAY);
}
/** Inclusive: a cycle from the 1st to the 30th has 30 days. */
export function cycleDays(cycle: Pick<AdCycle, "start_date" | "end_date">) {
  return daysBetween(cycle.start_date, cycle.end_date) + 1;
}
export function shortDate(date: string) {
  const [y, m, d] = date.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}
/** "2026-09" → "Setembro de 2026". */
export function monthLabel(month: string) {
  const label = new Date(at(`${month.slice(0, 7)}-01`)).toLocaleDateString(
    "pt-BR",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );
  return label.charAt(0).toUpperCase() + label.slice(1);
}
/** Numbers in the form fields, as people type them: 3000 → "3.000,00". */
export function amountText(value: number, decimals = 2) {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 3),
  });
}
export function money(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/* ------------------------------------------------------------------ */
/* Cycle rules                                                         */

export type CycleState = "planned" | "running" | "ended";
export function cycleState(cycle: AdCycle, today: string): CycleState {
  if (today < cycle.start_date) return "planned";
  if (today > cycle.end_date) return "ended";
  return "running";
}
export const cycleStates: Record<CycleState, string> = {
  planned: "Futuro",
  running: "Em andamento",
  ended: "Encerrado",
};
/** Days still to go, today included (0 once it has ended). */
export function daysLeft(cycle: AdCycle, today: string) {
  if (today > cycle.end_date) return 0;
  const from = today < cycle.start_date ? cycle.start_date : today;
  return daysBetween(from, cycle.end_date) + 1;
}
/**
 * The cost per result the cycle aims for: budget ÷ expected results (the
 * "meta de performance técnica" of the MASO). Null without a goal.
 */
export function goalCost(cycle: Pick<AdCycle, "budget" | "goal_results">) {
  return cycle.goal_results > 0 ? cycle.budget / cycle.goal_results : null;
}
export function cyclesOf(data: CampaignData, campaignId: string) {
  return data.cycles
    .filter((y) => y.campaign_id === campaignId)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
}
export function currentCycle(data: CampaignData, campaign: AdCampaign) {
  return data.cycles.find((y) => y.id === campaign.current_cycle_id) ?? null;
}
/** The first cycle, among the others, that starts after `cycle` ends. */
export function nextCycle(cycles: AdCycle[], cycle: AdCycle) {
  return (
    cycles.find((y) => y.id !== cycle.id && y.start_date > cycle.end_date) ??
    null
  );
}
/** Days before the end when the investment for the next cycle is due. */
export const BILLING_NOTICE_DAYS = 10;

export type CycleAlert =
  | { kind: "none" }
  | { kind: "no_cycle" }
  | { kind: "no_current"; suggestion: AdCycle | null }
  | { kind: "ending"; days: number; next: AdCycle | null }
  | { kind: "ends_today"; next: AdCycle | null }
  | { kind: "ended"; days: number; next: AdCycle | null };
/**
 * What needs attention about a campaign's cycles. The switch is manual:
 * this only points out an ended current cycle and the one that could
 * replace it, or that the next investment is due and no cycle follows.
 */
export function cycleAlert(
  data: CampaignData,
  campaign: AdCampaign,
  today: string,
): CycleAlert {
  const cycles = cyclesOf(data, campaign.id);
  if (!cycles.length) return { kind: "no_cycle" };
  const current = currentCycle(data, campaign);
  const covering = cycles.find((y) => cycleState(y, today) === "running");
  if (!current)
    return {
      kind: "no_current",
      suggestion:
        covering ??
        cycles.find((y) => y.start_date > today) ??
        cycles[cycles.length - 1],
    };
  const next = nextCycle(cycles, current);
  if (today > current.end_date)
    return {
      kind: "ended",
      days: daysBetween(current.end_date, today),
      next: covering ?? next,
    };
  if (today === current.end_date) return { kind: "ends_today", next };
  const left = daysLeft(current, today);
  if (left <= BILLING_NOTICE_DAYS && !next)
    return { kind: "ending", days: left, next };
  return { kind: "none" };
}

/** A cycle form's values (numbers as typed, so empty fields can be told apart). */
export interface CycleDraft {
  competence: string;
  start_date: string;
  end_date: string;
  objective: AdObjective;
  goal_results: string;
  budget: string;
  multiplier: string;
  destination: AdDestination;
  landing_pages: string;
  niche: string;
  links: AdCycleLink[];
}
/** One month after `start`, minus a day: 01/09 → 30/09 (short months clamp: 31/08 → 29/09). */
export function monthlyEnd(start: string) {
  const [y, m, d] = start.split("-").map(Number);
  const target = new Date(Date.UTC(y, m, 1, 12));
  const last = new Date(Date.UTC(y, m + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return addDays(target.toISOString().slice(0, 10), -1);
}
/**
 * A new cycle continues the last one: it starts the day after it ends, runs
 * for a month and repeats objective, goal, budget, M, destination and links
 * (the MASO copied links and M from the previous cycle as well).
 */
export function nextCycleDraft(
  last: AdCycle | null,
  today: string,
): CycleDraft {
  const start = last ? addDays(last.end_date, 1) : today;
  return {
    competence: start.slice(0, 7),
    start_date: start,
    end_date: monthlyEnd(start),
    objective: last?.objective ?? "lead",
    goal_results: last ? String(last.goal_results) : "",
    budget: last ? amountText(last.budget) : "",
    multiplier: last ? amountText(last.multiplier, 0) : "1",
    destination: last?.destination ?? "external_page",
    landing_pages: last?.landing_pages.join(", ") ?? "",
    niche: last?.niche ?? "",
    links: last?.links.map((l) => ({ ...l })) ?? [],
  };
}
export function cycleDraft(cycle: AdCycle): CycleDraft {
  return {
    competence: cycle.competence_month.slice(0, 7),
    start_date: cycle.start_date,
    end_date: cycle.end_date,
    objective: cycle.objective,
    goal_results: String(cycle.goal_results),
    budget: amountText(cycle.budget),
    multiplier: amountText(cycle.multiplier, 0),
    destination: cycle.destination,
    landing_pages: cycle.landing_pages.join(", "),
    niche: cycle.niche,
    links: cycle.links.map((l) => ({ ...l })),
  };
}
/** "1.234,56" or "1234.56" → 1234.56; NaN when it isn't a number. */
export function parseAmount(value: string) {
  const text = value.trim().replace(/\s|R\$/g, "");
  if (!text) return Number.NaN;
  const normalized = text.includes(",")
    ? text.replace(/\./g, "").replace(",", ".")
    : text;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}
export function splitList(value: string) {
  return [
    ...new Set(
      value
        .split(/[,;\n]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}
export type CycleInput = {
  competence: string;
  start_date: string;
  end_date: string;
  objective: AdObjective;
  goal_results: number;
  budget: number;
  /** Null keeps (or inherits) the current value. */
  multiplier: number | null;
  destination: AdDestination;
  landing_pages: string[];
  niche: string;
  links: AdCycleLink[];
};
/** Checks a draft the way the database will, with friendlier messages. */
export function cycleInput(
  draft: CycleDraft,
): { input: CycleInput } | { error: string } {
  if (!draft.start_date || !draft.end_date)
    return { error: "Informe o início e o término do ciclo." };
  if (draft.end_date < draft.start_date)
    return { error: "O término precisa ser igual ou posterior ao início." };
  const goal = Number(draft.goal_results);
  if (!draft.goal_results.trim() || !Number.isInteger(goal) || goal < 0)
    return {
      error: "Informe a quantidade de resultados esperada (número inteiro).",
    };
  const budget = parseAmount(draft.budget);
  if (Number.isNaN(budget) || budget < 0)
    return { error: "Informe a verba do ciclo em reais." };
  const multiplier = parseAmount(draft.multiplier);
  if (Number.isNaN(multiplier) || multiplier <= 0 || multiplier > 100)
    return {
      error: "O índice de performance (M) precisa estar entre 0 e 100.",
    };
  const pages = splitList(draft.landing_pages);
  if (draft.destination === "make_landing_page" && !pages.length)
    return { error: "Informe ao menos uma página de captura da Make." };
  const links = draft.links
    .map((l) => ({
      ...l,
      account_id: l.account_id.trim(),
      campaign_id: l.campaign_id.trim(),
    }))
    .filter((l) => l.account_id || l.campaign_id);
  if (links.some((l) => !l.account_id))
    return { error: "Informe a conta de anúncio de cada vínculo." };
  return {
    input: {
      competence: `${(draft.competence || draft.start_date).slice(0, 7)}-01`,
      start_date: draft.start_date,
      end_date: draft.end_date,
      objective: draft.objective,
      goal_results: goal,
      budget: Math.round(budget * 100) / 100,
      multiplier,
      destination: draft.destination,
      landing_pages: draft.destination === "make_landing_page" ? pages : [],
      niche: draft.niche.trim(),
      links,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Backend                                                             */

export type CampaignInput = {
  contract_id: string;
  name: string;
  platform: AdPlatform;
  briefing_url: string;
  media_plan_url: string;
  notes: string;
};
/**
 * The list is paged on the server (migration 20261003090000): only active
 * campaigns — never the inactive ones — or, in "pending", campaigns created
 * in MAVI in the last 60 days that were never activated.
 */
export type PageQuery = {
  scope: "active" | "pending";
  search: string;
  platform: string;
  attention: boolean;
  limit: number;
  offset: number;
};
export type CampaignRow = {
  campaign: AdCampaign;
  client_name: string;
  product_name: string;
  current: AdCycle | null;
  alert: CycleAlert;
};
export type CampaignPage = {
  rows: CampaignRow[];
  /** Rows matching the search and filters. */
  total: number;
  /** Every campaign of the scope, and those needing attention. */
  all: number;
  attention: number;
  /** New campaigns waiting for their first activation. */
  pending: number;
};
type RawCycle = Omit<AdCycle, "links"> & { links?: AdCycleLink[] };
const cycleFrom = (y: RawCycle | null): AdCycle | null =>
  y
    ? {
        ...y,
        // numeric columns may arrive as strings
        budget: Number(y.budget),
        multiplier: Number(y.multiplier),
        links: y.links ?? [],
      }
    : null;
/** The alert as the database computes it, in cycleAlert's shape. */
export function alertFrom(raw: {
  kind: CycleAlert["kind"];
  days?: number | null;
  next?: RawCycle | null;
}): CycleAlert {
  const next = cycleFrom(raw.next ?? null);
  switch (raw.kind) {
    case "no_current":
      return { kind: "no_current", suggestion: next };
    case "ending":
      return { kind: "ending", days: raw.days ?? 0, next };
    case "ended":
      return { kind: "ended", days: raw.days ?? 0, next };
    case "ends_today":
      return { kind: "ends_today", next };
    case "no_cycle":
      return { kind: "no_cycle" };
    default:
      return { kind: "none" };
  }
}

export interface CampaignsBackend {
  /** A page of the list: only active campaigns (or the ones "pending"). */
  page(company: string, query: PageQuery): Promise<CampaignPage>;
  /** One campaign with its cycles (and links), or none. */
  campaign(company: string, id: string): Promise<CampaignData>;
  events(company: string, campaign: string): Promise<AdCampaignEvent[]>;
  createCampaign(company: string, input: CampaignInput): Promise<string>;
  updateCampaign(
    campaign: AdCampaign,
    input: Omit<CampaignInput, "contract_id">,
  ): Promise<void>;
  setStatus(
    campaign: AdCampaign,
    status: AdCampaignStatus,
    reason: string,
  ): Promise<void>;
  setCurrentCycle(campaign: AdCampaign, cycle: string): Promise<void>;
  createCycle(
    campaign: AdCampaign,
    input: CycleInput,
    makeCurrent: boolean,
  ): Promise<string>;
  updateCycle(cycle: AdCycle, input: CycleInput): Promise<void>;
  /** The platforms' accounts and campaigns, read live (api/_ads.ts). */
  ads: AdsBackend;
  /** Each cycle's numbers (the daily sync, api/_ads-sync.ts). */
  metrics: MetricsBackend;
}

/* ------------------------------------------------------------------ */
/* Platforms (Meta and Google Ads)                                     */

export type AdsProvider = "meta" | "google";
/** The platforms whose accounts and campaigns can be searched. */
export const searchablePlatform = (p: AdPlatform): p is AdsProvider =>
  p === "meta" || p === "google";
export type AdsConnection = {
  /** The server has the app's credentials for this platform. */
  configured: boolean;
  /** Server variables still missing (names only). */
  missing?: string[];
  /** Meta: accounts reached, who connected them, earliest expiry. */
  accounts?: number;
  people?: string[];
  expires_at?: string | null;
  /** Google: the agency account connected. */
  email?: string;
  connected_at?: string;
};
export type AdsStatus = { meta: AdsConnection; google: AdsConnection };
export type PlatformAccount = {
  id: string;
  name: string;
  status: string;
  active: boolean;
  currency: string;
  manager_id: string;
  manager_name: string;
  expires_at?: string | null;
  connected_by?: string;
};
export type PlatformCampaign = {
  id: string;
  name: string;
  status: string;
  active: boolean;
  kind: string;
};
export interface AdsBackend {
  status(company: string): Promise<AdsStatus>;
  /** Where to send the administrator to allow access (null: done here). */
  connect(company: string, provider: AdsProvider): Promise<string | null>;
  disconnect(company: string, provider: AdsProvider): Promise<void>;
  accounts(company: string, provider: AdsProvider): Promise<PlatformAccount[]>;
  campaigns(
    company: string,
    provider: AdsProvider,
    account: string,
    manager: string,
  ): Promise<PlatformCampaign[]>;
}
export class AdsApiError extends Error {
  constructor(
    message: string,
    /** not_configured, not_connected or expired. */
    public code?: string,
  ) {
    super(message);
  }
}
async function adsServer<T>(body: Record<string, unknown>): Promise<T> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token) throw new AdsApiError("Entre novamente para buscar campanhas.");
  const res = await fetch("/api/ads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new AdsApiError(
      data.error ?? "Não foi possível falar com a plataforma de anúncios.",
      data.code,
    );
  return data as T;
}
export const serverAds: AdsBackend = {
  status: (company) => adsServer({ action: "status", company }),
  async connect(company, provider) {
    return (
      await adsServer<{ url: string }>({ action: "connect", company, provider })
    ).url;
  },
  async disconnect(company, provider) {
    await adsServer({ action: "disconnect", company, provider });
  },
  async accounts(company, provider) {
    return (
      await adsServer<{ accounts: PlatformAccount[] }>({
        action: "accounts",
        company,
        provider,
      })
    ).accounts;
  },
  async campaigns(company, provider, account, manager) {
    return (
      await adsServer<{ campaigns: PlatformCampaign[] }>({
        action: "campaigns",
        company,
        provider,
        account,
        manager,
      })
    ).campaigns;
  },
};
/** What the connection's return (?conexao=meta-conectado) means. */
export function connectionResult(value: string) {
  const [provider, ...rest] = value.split("-");
  const name = provider === "google" ? "Google Ads" : "Facebook";
  const result = rest.join("-");
  return (
    {
      conectado: `${name} conectado.`,
      "sem-contas": `${name} conectado, mas este usuário não tem acesso a nenhuma conta de anúncio.`,
      cancelado: `Conexão com o ${name} cancelada.`,
      "sem-permissao": `O ${name} não concedeu a permissão necessária. Conecte de novo e aceite o acesso ao Google Ads.`,
      expirado: `A conexão demorou demais ou você não é mais administrador. Tente de novo.`,
    }[result] ?? `Não foi possível conectar o ${name}. Tente de novo.`
  );
}

const CAMPAIGN_COLUMNS =
  "id,company_id,contract_id,name,platform,status,current_cycle_id,briefing_url,media_plan_url,notes,archived,created_by,created_at,updated_at,version";
const CYCLE_COLUMNS =
  "id,company_id,campaign_id,competence_month,start_date,end_date,objective,goal_results,budget,multiplier,destination,landing_pages,niche,created_by,created_at,updated_at,version";

function cycleArgs(input: CycleInput) {
  return {
    p_competence: input.competence,
    p_start: input.start_date,
    p_end: input.end_date,
    p_objective: input.objective,
    p_goal_results: input.goal_results,
    p_budget: input.budget,
    p_multiplier: input.multiplier,
    p_destination: input.destination,
    p_landing_pages: input.landing_pages,
    p_niche: input.niche,
    p_links: input.links,
  };
}

export const supabaseCampaigns: CampaignsBackend = {
  async page(company, q) {
    const raw = (await rpc("ad_campaign_page", {
      p_company: company,
      p_scope: q.scope,
      p_search: q.search,
      p_platform: q.platform,
      p_attention: q.attention,
      p_limit: q.limit,
      p_offset: q.offset,
    })) as {
      total: number;
      all: number;
      attention: number;
      pending?: number;
      rows: {
        campaign: AdCampaign;
        client_name: string;
        product_name: string;
        current: RawCycle | null;
        alert: Parameters<typeof alertFrom>[0];
      }[];
    };
    return {
      total: raw.total,
      all: raw.all,
      attention: raw.attention,
      pending: raw.pending ?? 0,
      rows: raw.rows.map((r) => ({
        campaign: r.campaign,
        client_name: r.client_name,
        product_name: r.product_name,
        current: cycleFrom(r.current),
        alert: alertFrom(r.alert),
      })),
    };
  },
  async campaign(company, id) {
    if (!supabase) throw Error("Supabase não configurado");
    const [campaigns, cycles] = await Promise.all([
      supabase
        .from("ad_campaigns")
        .select(CAMPAIGN_COLUMNS)
        .eq("company_id", company)
        .eq("id", id)
        .then(({ data, error }) => {
          if (error) throw error;
          return (data ?? []) as AdCampaign[];
        }),
      fetchAllRows<Omit<AdCycle, "links">>((count) =>
        supabase!
          .from("ad_cycles")
          .select(CYCLE_COLUMNS, count ? { count } : undefined)
          .eq("company_id", company)
          .eq("campaign_id", id)
          .order("id"),
      ),
    ]);
    const ids = cycles.map((y) => y.id);
    const links: {
      cycle_id: string;
      account_id: string;
      external_campaign_id: string;
      manager_id: string;
      account_name: string;
      campaign_name: string;
    }[] = [];
    // A campaign has tens of cycles: their links in a few requests.
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await supabase
        .from("ad_cycle_links")
        .select(
          "cycle_id,account_id,external_campaign_id,manager_id,account_name,campaign_name",
        )
        .eq("company_id", company)
        .in("cycle_id", ids.slice(i, i + 150))
        .order("id");
      if (error) throw error;
      links.push(...((data ?? []) as typeof links));
    }
    const byCycle = new Map<string, AdCycleLink[]>();
    for (const l of links)
      byCycle.set(l.cycle_id, [
        ...(byCycle.get(l.cycle_id) ?? []),
        {
          account_id: l.account_id,
          campaign_id: l.external_campaign_id,
          manager_id: l.manager_id,
          account_name: l.account_name,
          campaign_name: l.campaign_name,
        },
      ]);
    return {
      campaigns,
      cycles: cycles.map((y) =>
        cycleFrom({ ...y, links: byCycle.get(y.id) ?? [] })!,
      ),
    };
  },
  async events(company, campaign) {
    if (!supabase) throw Error("Supabase não configurado");
    const { data, error } = await supabase
      .from("ad_campaign_events")
      .select("id,campaign_id,cycle_id,actor_id,action,detail,created_at")
      .eq("company_id", company)
      .eq("campaign_id", campaign)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []) as AdCampaignEvent[];
  },
  async createCampaign(company, input) {
    return (await rpc("create_ad_campaign", {
      p_company: company,
      p_contract: input.contract_id,
      p_name: input.name,
      p_platform: input.platform,
      p_briefing_url: input.briefing_url,
      p_media_plan_url: input.media_plan_url,
      p_notes: input.notes,
    })) as string;
  },
  async updateCampaign(campaign, input) {
    await rpc("update_ad_campaign", {
      p_campaign: campaign.id,
      p_version: campaign.version,
      p_name: input.name,
      p_platform: input.platform,
      p_briefing_url: input.briefing_url,
      p_media_plan_url: input.media_plan_url,
      p_notes: input.notes,
    });
  },
  async setStatus(campaign, status, reason) {
    await rpc("set_ad_campaign_status", {
      p_campaign: campaign.id,
      p_status: status,
      p_reason: reason,
    });
  },
  async setCurrentCycle(campaign, cycle) {
    await rpc("set_ad_campaign_current_cycle", {
      p_campaign: campaign.id,
      p_cycle: cycle,
    });
  },
  async createCycle(campaign, input, makeCurrent) {
    return (await rpc("create_ad_cycle", {
      p_campaign: campaign.id,
      ...cycleArgs(input),
      p_make_current: makeCurrent,
    })) as string;
  },
  async updateCycle(cycle, input) {
    await rpc("update_ad_cycle", {
      p_cycle: cycle.id,
      p_version: cycle.version,
      ...cycleArgs(input),
    });
  },
  ads: serverAds,
  // Loaded on demand (and keeps campaign-metrics.ts out of this module).
  metrics: {
    load: (company, campaign) =>
      import("./campaign-metrics").then((m) =>
        m.loadMetrics(company, campaign),
      ),
    sync: (_company, campaign) =>
      import("./campaign-metrics").then((m) => m.syncNow(campaign)),
  },
};

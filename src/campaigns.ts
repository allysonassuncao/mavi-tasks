import { supabase } from "./supabase";
import { fetchAllRows, rpc } from "./api";
import type { MetricsBackend } from "./campaign-metrics";
import { loadMediaRoom, type MediaRoom } from "./campaign-media";
import {
  multiplierError,
  serverMultiplier,
  type MultiplierBackend,
  type MultiplierChange,
} from "./campaign-multiplier";
import {
  addBusinessDays,
  calendarEntry,
  isBusinessDay,
  nationalHoliday,
  nextBusinessDay,
} from "./dueRules";
import type { CalendarDay } from "./types";

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
  /**
   * The turnover day this cycle shares with the previous one (it starts on
   * the day that one ends): where it counts. Null: no shared day, or a cycle
   * imported from the MASO (counts in both). Migration 20270301090000.
   */
  shared_day?: SharedDayChoice | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
  links: AdCycleLink[];
}
/**
 * Where a turnover day counts, for the platform campaigns (and Make pages)
 * both cycles have: in the cycle that starts (recommended), in the one that
 * ends, or in both (twice in the campaign's totals and the media balance).
 */
export type SharedDayChoice = "later" | "earlier" | "both";
export const sharedDayLabels: Record<SharedDayChoice, string> = {
  later: "no ciclo novo",
  earlier: "no ciclo que termina",
  both: "nos dois ciclos",
};
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
/**
 * The first cycle, among the others, that starts after `cycle` ends — or on
 * its last day (the turnover day).
 */
export function nextCycle(cycles: AdCycle[], cycle: AdCycle) {
  return (
    cycles.find(
      (y) =>
        y.id !== cycle.id &&
        y.start_date >= cycle.end_date &&
        y.start_date > cycle.start_date,
    ) ?? null
  );
}
/**
 * The cycles a period shares a turnover day with: the one ending on its
 * first day and the one starting on its last (others than `own`).
 */
export function turnover(
  cycles: AdCycle[],
  start: string,
  end: string,
  own?: string,
) {
  const others = cycles.filter((y) => y.id !== own);
  return {
    before:
      start < end
        ? (others.find((y) => y.end_date === start && y.start_date < start) ??
          null)
        : null,
    after:
      start < end
        ? (others.find((y) => y.start_date === end && y.end_date > end) ??
          null)
        : null,
  };
}
/**
 * Why a cycle date is not a business day — weekend, national holiday or the
 * company's day off (the calendar of the due dates, src/dueRules.ts) — or
 * null. Starting or ending a cycle then risks the budget's pace: nobody
 * follows the consumption on that day.
 */
export function dayOffReason(
  calendar: CalendarDay[] | undefined,
  day: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isBusinessDay(calendar, day))
    return null;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return "fim de semana";
  const off = calendarEntry(calendar, day, "off");
  if (off) return `folga da empresa (${off.name})`;
  return `feriado (${nationalHoliday(day)})`;
}
/** The business days just before and just after `day`. */
export function businessDaysAround(
  calendar: CalendarDay[] | undefined,
  day: string,
) {
  return {
    before: addBusinessDays(calendar, day, -1),
    after: nextBusinessDay(calendar, day),
  };
}
/** "sexta-feira, 02/10". */
export function weekdayDate(day: string) {
  const name = new Date(`${day}T12:00:00Z`).toLocaleDateString("pt-BR", {
    weekday: "long",
    timeZone: "UTC",
  });
  return `${name}, ${shortDate(day).slice(0, 5)}`;
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
  // On a turnover day, the cycle that starts.
  const covering = [...cycles]
    .reverse()
    .find((y) => cycleState(y, today) === "running");
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
  /** Where the turnover day with the previous cycle counts ("": not chosen). */
  shared_start: SharedDayChoice | "";
  /** The same, with the next cycle (stored in the next one). */
  shared_end: SharedDayChoice | "";
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
 * (the MASO copied links and M from the previous cycle as well). Without
 * links in the last one, they come from `linksFrom` (the latest with links).
 */
export function nextCycleDraft(
  last: AdCycle | null,
  today: string,
  linksFrom?: AdCycle | null,
): CycleDraft {
  const start = last ? addDays(last.end_date, 1) : today;
  const links = last?.links.length ? last.links : (linksFrom?.links ?? []);
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
    links: links.map((l) => ({ ...l })),
    shared_start: "",
    shared_end: "",
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
    shared_start: cycle.shared_day ?? "",
    // The next cycle's choice (the form fills it in).
    shared_end: "",
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
  /** Turnover days: where each counts (null keeps the saved choice). */
  shared_start?: SharedDayChoice | null;
  shared_end?: SharedDayChoice | null;
  /**
   * The M changed (from the cycle's, or the previous cycle's in a new one):
   * the reason and, editing, which registered days take it (migration
   * 20270322090000).
   */
  multiplier_change?: MultiplierChange | null;
};
/**
 * Checks a draft the way the database will, with friendlier messages.
 * `currentMultiplier`: the M it had (one below 1 from before the rule may
 * stay as it is).
 */
export function cycleInput(
  draft: CycleDraft,
  currentMultiplier: number | null = null,
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
  const multiplierWrong = multiplierError(multiplier, currentMultiplier);
  if (multiplierWrong) return { error: multiplierWrong };
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
      shared_start: draft.shared_start || null,
      shared_end: draft.shared_end || null,
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
 * The list is paged on the server (migration 20261003090000): by default only
 * active campaigns; in "pending", campaigns created in MAVI in the last 60
 * days that were never activated; "inactive" and "all" when the Status
 * filter asks (migration 20270207090000, the active ones first).
 */
export type CampaignScope = "active" | "pending" | "inactive" | "all";
export type PageQuery = {
  scope: CampaignScope;
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
  /** A new campaign waiting for its first activation. */
  waiting: boolean;
  /**
   * What the current cycle spent so far: net (the platform's) and gross
   * (each day × its M). Null without a current cycle.
   */
  spent: { net: number; gross: number } | null;
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
  /** A page of the list, by status (active ones unless asked otherwise). */
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
  /** Google: which conversion actions count (null: by category). */
  setConversionActions(cycle: AdCycle, actions: string[] | null): Promise<void>;
  /**
   * Meta: which action types count (null: by objective), for the whole
   * cycle or from today on (migration 20270302090000).
   */
  setMetaConversions(
    cycle: AdCycle,
    actions: string[] | null,
    mode: MetaConversionMode,
  ): Promise<void>;
  /**
   * `override`: the reason an administrator or manager gives to release a
   * budget above the client's media balance (migration 20270222090000).
   */
  createCycle(
    campaign: AdCampaign,
    input: CycleInput,
    makeCurrent: boolean,
    override?: string | null,
  ): Promise<string>;
  updateCycle(
    cycle: AdCycle,
    input: CycleInput,
    override?: string | null,
  ): Promise<void>;
  /** The client's media balance, reserved and available (Financeiro › Mídia). */
  mediaRoom(campaign: AdCampaign): Promise<MediaRoom>;
  /** The M's rules: the days a change reaches and the audit log. */
  multiplier: MultiplierBackend;
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
  /** Meta: the Facebook profile whose token reaches the account. */
  connected_by_id?: string;
  /** Meta: the client the account belongs to. */
  client_id?: string | null;
  client_name?: string;
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
  /**
   * Starts a connection. Meta is always for a client (its Facebook
   * profile); the campaign is where to come back to. Gives the platform's
   * address, or (demonstration) the pending choice right away.
   */
  connect(
    company: string,
    provider: AdsProvider,
    context?: { client?: string; campaign?: string },
  ): Promise<ConnectStart>;
  /** Meta: a client's accounts, or a profile's; otherwise the platform. */
  disconnect(
    company: string,
    provider: AdsProvider,
    target?: { client?: string; profile?: string },
  ): Promise<void>;
  /** After the Facebook login: the accounts to choose the client's. */
  pending(id: string): Promise<PendingConnection>;
  /** The accounts chosen become the client's; returns how many. */
  confirm(id: string, accounts: string[]): Promise<number>;
  /** Clients with active Meta campaigns or connected accounts. */
  clients(company: string): Promise<MetaClient[]>;
  /** How the daily sync is going (ad_sync_overview). */
  overview(company: string): Promise<SyncOverview>;
  /** Meta with a client: only that client's accounts. */
  accounts(
    company: string,
    provider: AdsProvider,
    client?: string,
  ): Promise<PlatformAccount[]>;
  campaigns(
    company: string,
    provider: AdsProvider,
    account: string,
    manager: string,
  ): Promise<PlatformCampaign[]>;
  /** Meta lead forms: the Pages the account's Facebook profile manages. */
  pages(company: string, account: string): Promise<FacebookPage[]>;
  /** A Page's lead forms (active first). */
  forms(
    company: string,
    account: string,
    page: string,
  ): Promise<{ page: FacebookPage; forms: LeadForm[] }>;
  /** Links a form to a Make capture page (subscribes the Page's leads). */
  linkForm(company: string, input: LeadFormInput): Promise<void>;
  /** Google: the cycle's conversion actions and which of them count. */
  conversionActions(
    company: string,
    cycle: string,
  ): Promise<ConversionActionsView>;
  /** Meta: the cycle's action types and which of them count. */
  metaConversions(company: string, cycle: string): Promise<MetaConversionsView>;
  /** The forms linked (a client's, or all). */
  leadForms(company: string, client?: string | null): Promise<LinkedLeadForm[]>;
  unlinkForm(id: string): Promise<void>;
}
/** "Conversões do Google que contam" (api/_conversions.ts). */
export const PHONE_CALLS = "phone_calls";
export type ConversionActionRow = {
  id: string;
  name: string;
  category: string;
  category_label: string;
  conversions: number;
  counted: boolean;
  counted_by_default: boolean;
};
export type ConversionActionsView = {
  /** The cycle's period read (null: nothing to read yet). */
  period: { since: string; until: string } | null;
  /** The cycle's choice (null: Google's categories decide). */
  selection: string[] | null;
  actions: ConversionActionRow[];
  phone_calls: number;
  calls_counted: boolean;
  counted: number;
};
/** "Conversões que contam" on Meta (api/_meta-conversions.ts). */
export type MetaConversionRule = {
  from: string | null;
  actions: string[] | null;
  inherited?: boolean;
};
export type MetaConversionMode = "all" | "forward";
export type MetaConversionRow = {
  /** The insights' action_type. */
  type: string;
  label: string;
  /** Where it comes from (Pixel, Conversão personalizada…). */
  detail: string;
  conversions: number;
  by_default: boolean;
  /** Two choices sharing one may count the same lead twice. */
  families: string[];
  /** Clicks, views and engagement (listed apart). */
  engagement: boolean;
};
export type MetaConversionsView = {
  objective: AdObjective;
  destination: AdDestination;
  start_date: string;
  end_date: string;
  today: string;
  rules: MetaConversionRule[] | null;
  /** What counts now (null: the objective's rule). */
  current: string[] | null;
  /** The choice came from the previous cycle. */
  inherited: boolean;
  /** What the objective's rule counts, in words. */
  default_label: string;
  /** Make capture page: its leads always count. */
  make_page: boolean;
  /** The period read: the cycle up to yesterday, or the last 30 days. */
  period: { since: string; until: string; cycle: boolean } | null;
  actions: MetaConversionRow[];
  /** What counts today in the period (the platform's part). */
  counted: number | null;
};
/** Campaign objectives that collect leads with Facebook forms (MASO rule). */
export const LEAD_OBJECTIVES = ["OUTCOME_LEADS", "LEAD_GENERATION"];
export const isLeadObjective = (kind: string) =>
  LEAD_OBJECTIVES.includes(kind.toUpperCase());
export type FacebookPage = { id: string; name: string };
export type LeadForm = {
  id: string;
  name: string;
  status: string;
  active: boolean;
  leads: number | null;
};
export type LeadFormInput = {
  account: string;
  page: string;
  form: string;
  form_name: string;
  client: string | null;
  landing_page: string;
  make_user: string;
};
export type LinkedLeadForm = {
  id: string;
  client_id: string | null;
  client: string | null;
  page_id: string;
  page_name: string;
  form_id: string;
  form_name: string;
  landing_page_id: string;
  make_user_id: string;
  source: "mavi" | "maso";
  updated_at: string;
  last_lead_at: string | null;
  sent_30d: number;
  last_error: { at: string; message: string } | null;
};
export type ConnectStart = { url: string } | { pending: string };
export type PendingConnection = {
  id: string;
  client_id: string;
  client: string;
  campaign_id: string | null;
  /** The Facebook profile that logged in. */
  profile: string;
  expires_at: string | null;
  accounts: {
    account_id: string;
    name: string;
    currency: string;
    account_status: number | null;
    /** The client the account already belongs to, if any. */
    client_id: string | null;
    client: string | null;
  }[];
};
export type MetaClient = {
  client_id: string;
  client: string;
  /** Active Meta campaigns of the client. */
  campaigns: number;
  expires_at: string | null;
  accounts: {
    account_id: string;
    name: string;
    profile: string;
    expires_at: string | null;
    account_status: number | null;
  }[];
};
export type SyncOverview = {
  /** ad_sync_config has the URL and the secret. */
  configured: boolean;
  /** The pg_cron job (null: not scheduled, or pg_cron missing). */
  job: {
    schedule: string;
    active: boolean;
    last_run: { status: string; start_time: string; message: string } | null;
  } | null;
  today: string;
  last_schedule: string | null;
  /** Cycles to sync today, and how they went. */
  due: number;
  synced: number;
  failed: number;
  pending: number;
  /** Cycles with numbers up to yesterday (or their end). */
  up_to_date: number;
  errors: { campaign_id: string; campaign: string; message: string }[];
  stale: { campaign_id: string; campaign: string; last_day: string | null }[];
};
export class AdsApiError extends Error {
  constructor(
    message: string,
    /** not_configured, not_connected or expired. */
    public code?: string,
  ) {
    super(message);
  }
}
export async function adsServer<T>(body: Record<string, unknown>): Promise<T> {
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
  async connect(company, provider, context) {
    return await adsServer<{ url: string }>({
      action: "connect",
      company,
      provider,
      client: context?.client,
      campaign: context?.campaign,
    });
  },
  async disconnect(company, provider, target) {
    await adsServer({
      action: "disconnect",
      company,
      provider,
      profile: target?.profile,
      client: target?.client,
    });
  },
  async pending(id) {
    return (await rpc("ad_meta_pending", {
      p_pending: id,
    })) as PendingConnection;
  },
  async confirm(id, accounts) {
    return (await rpc("ad_confirm_meta_accounts", {
      p_pending: id,
      p_accounts: accounts,
    })) as number;
  },
  async clients(company) {
    return (await rpc("ad_meta_clients", {
      p_company: company,
    })) as MetaClient[];
  },
  async overview(company) {
    return (await rpc("ad_sync_overview", {
      p_company: company,
    })) as SyncOverview;
  },
  async accounts(company, provider, client) {
    return (
      await adsServer<{ accounts: PlatformAccount[] }>({
        action: "accounts",
        company,
        provider,
        client,
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
  async pages(company, account) {
    return (
      await adsServer<{ pages: FacebookPage[] }>({
        action: "pages",
        company,
        provider: "meta",
        account,
      })
    ).pages;
  },
  forms: (company, account, page) =>
    adsServer({ action: "forms", company, provider: "meta", account, page }),
  metaConversions: (company, cycle) =>
    adsServer({ action: "meta-conversions", company, provider: "meta", cycle }),
  conversionActions: (company, cycle) =>
    adsServer({
      action: "conversion-actions",
      company,
      provider: "google",
      cycle,
    }),
  async linkForm(company, input) {
    await adsServer({
      action: "link-form",
      company,
      provider: "meta",
      ...input,
    });
  },
  async leadForms(company, client) {
    return (await rpc("ad_lead_forms_overview", {
      p_company: company,
      p_client: client ?? null,
    })) as LinkedLeadForm[];
  },
  async unlinkForm(id) {
    await rpc("ad_delete_lead_form", { p_id: id });
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
      "sem-contas": `${name} conectado, mas este perfil não tem acesso a nenhuma conta de anúncio. Entre no Facebook com o perfil do cliente e conecte de novo.`,
      cancelado: `Conexão com o ${name} cancelada.`,
      "sem-permissao": `O ${name} não concedeu a permissão necessária. Conecte de novo e aceite o acesso ao Google Ads.`,
      expirado: `A conexão demorou demais ou você não tem mais acesso a Campanhas deste cliente. Tente de novo.`,
    }[result] ?? `Não foi possível conectar o ${name}. Tente de novo.`
  );
}

const CAMPAIGN_COLUMNS =
  "id,company_id,contract_id,name,platform,status,current_cycle_id,briefing_url,media_plan_url,notes,archived,created_by,created_at,updated_at,version";
const CYCLE_COLUMNS =
  "id,company_id,campaign_id,competence_month,start_date,end_date,objective,goal_results,budget,multiplier,destination,landing_pages,niche,created_by,created_at,updated_at,version";
/** With the turnover day's choice (migration 20270301090000). */
const CYCLE_COLUMNS_SHARED = `${CYCLE_COLUMNS},shared_day`;
const cyclesOfCampaign = (company: string, campaign: string, columns: string) =>
  fetchAllRows<Omit<AdCycle, "links">>((count) =>
    supabase!
      .from("ad_cycles")
      // A column list built at runtime (the rows are typed above).
      .select(columns as "*", count ? { count } : undefined)
      .eq("company_id", company)
      .eq("campaign_id", campaign)
      .order("id"),
  );

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
    // Only with a turnover day (older databases don't take them).
    ...(input.shared_start ? { p_shared_start: input.shared_start } : {}),
    ...(input.shared_end ? { p_shared_end: input.shared_end } : {}),
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
        waiting?: boolean;
        spent?: { net: number | string; gross: number | string } | null;
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
        waiting: !!r.waiting,
        spent: r.spent
          ? { net: Number(r.spent.net), gross: Number(r.spent.gross) }
          : null,
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
      cyclesOfCampaign(company, id, CYCLE_COLUMNS_SHARED).catch((e: Error) =>
        // Before the migration: without the column.
        /shared_day/.test(e.message)
          ? cyclesOfCampaign(company, id, CYCLE_COLUMNS)
          : Promise.reject(e),
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
  async setConversionActions(cycle, actions) {
    await rpc("set_ad_cycle_conversion_actions", {
      p_cycle: cycle.id,
      p_actions: actions,
    });
  },
  async setMetaConversions(cycle, actions, mode) {
    await rpc("set_ad_cycle_meta_conversions", {
      p_cycle: cycle.id,
      p_actions: actions,
      p_mode: mode,
    });
  },
  async createCycle(campaign, input, makeCurrent, override) {
    return (await rpc("create_ad_cycle", {
      p_campaign: campaign.id,
      ...cycleArgs(input),
      p_make_current: makeCurrent,
      p_media_override: override || null,
      // Only with another M (older databases don't take it).
      ...(input.multiplier_change
        ? { p_multiplier_reason: input.multiplier_change.reason }
        : {}),
    })) as string;
  },
  async updateCycle(cycle, input, override) {
    const change = input.multiplier_change;
    await rpc("update_ad_cycle", {
      p_cycle: cycle.id,
      p_version: cycle.version,
      ...cycleArgs(input),
      p_media_override: override || null,
      ...(change
        ? {
            p_multiplier_reason: change.reason,
            p_multiplier_apply: change.apply,
            p_multiplier_from: change.apply === "range" ? change.from : null,
            p_multiplier_to: change.apply === "range" ? change.to : null,
          }
        : {}),
    });
  },
  mediaRoom: (campaign) => loadMediaRoom(campaign.id),
  multiplier: serverMultiplier,
  ads: serverAds,
  // Loaded on demand (and keeps campaign-metrics.ts out of this module).
  metrics: {
    load: (company, campaign) =>
      import("./campaign-metrics").then((m) =>
        m.loadMetrics(company, campaign),
      ),
    sync: (_company, campaign) =>
      import("./campaign-metrics").then((m) => m.syncNow(campaign)),
    async updateDaily(row, values) {
      const { reason, ...rest } = values;
      await rpc("update_ad_daily_metric", {
        p_cycle: row.cycle_id,
        p_day: row.day,
        p_values: rest,
        // Only with another M (older databases don't take it).
        ...(reason ? { p_reason: reason } : {}),
      });
    },
    async updateSnapshot(snapshot, values) {
      await rpc("update_ad_cycle_snapshot", {
        p_id: snapshot.id,
        p_values: values,
      });
    },
  },
};

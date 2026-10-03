import { rpc } from "./api";

/**
 * The rules of the índice de performance (M) (migration
 * 20270322090000_campaign_multiplier_rules): what is changed must be at
 * least 1 (values below 1 from before the rule stay until someone changes
 * them), every change has a reason, and changing a cycle's M asks which
 * registered days take the new one. Every change goes to an audit log that
 * no one edits; administrators and managers read it. The database enforces
 * it; this mirrors it for the forms.
 */

export const MULTIPLIER_MIN = 1;
export const MULTIPLIER_MAX = 100;
/** Stored with 3 decimals: 1.5 and 1.5004 are the same M. */
export const sameMultiplier = (a: number, b: number) =>
  Math.round(a * 1000) === Math.round(b * 1000);
export const MULTIPLIER_RANGE_ERROR = `O índice de performance (M) precisa ser no mínimo ${MULTIPLIER_MIN} e no máximo ${MULTIPLIER_MAX}.`;
/**
 * The M typed in a form: an error when it isn't valid. `current`: the
 * value it had (one below 1 from before the rule may stay as it is).
 */
export function multiplierError(m: number, current: number | null) {
  if (!Number.isFinite(m)) return MULTIPLIER_RANGE_ERROR;
  if (current !== null && sameMultiplier(m, current)) return null;
  return m < MULTIPLIER_MIN || m > MULTIPLIER_MAX
    ? MULTIPLIER_RANGE_ERROR
    : null;
}

/** Which registered days of the cycle take the new M. */
export type MultiplierApply = "all" | "forward" | "range";
/** A change of the cycle's M, sent with the cycle. */
export type MultiplierChange = {
  reason: string;
  /** Editing a cycle with registered days (null: no day to choose). */
  apply: MultiplierApply | null;
  /** The period, with "range". */
  from: string | null;
  to: string | null;
};
export type MultiplierOption = {
  /** Registered days whose M changes. */
  days: number;
  /** Of them, the ones edited by hand. */
  manual: number;
  /** How much their spend × M (the media debit) changes. */
  diff: number;
};
export type MultiplierImpact = {
  today: string;
  /** The cycle's registered days. */
  registered: number;
  first_day: string | null;
  last_day: string | null;
  options: Partial<Record<MultiplierApply, MultiplierOption>>;
};
export type MultiplierLogItem = {
  id: number;
  at: string;
  actor: string | null;
  actor_name: string;
  campaign_id: string;
  cycle_id: string;
  campaign: string;
  client: string;
  product: string;
  platform: string | null;
  cycle_start: string | null;
  cycle_end: string | null;
  /** cycle: edited the cycle; new_cycle: a new cycle with another M; day: one day in the Dia a Dia. */
  kind: "cycle" | "new_cycle" | "day";
  day: string | null;
  from: number | null;
  to: number;
  reason: string;
  apply: MultiplierApply | null;
  apply_from: string | null;
  apply_to: string | null;
  days: { day: string; from: number }[];
  media_diff: number;
};
export type MultiplierLogQuery = {
  campaign?: string | null;
  actor?: string | null;
  from?: string | null;
  to?: string | null;
  search?: string;
  /** The id of the last item loaded. */
  before?: number | null;
  limit?: number;
};
export type MultiplierLogPage = { items: MultiplierLogItem[]; more: boolean };
/** A cycle with M below 1, in the cycle or in some day (from before the rule). */
export type MultiplierBelow = {
  campaign_id: string;
  campaign: string;
  client: string;
  product: string;
  platform: string;
  archived: boolean;
  cycle_id: string;
  start_date: string;
  end_date: string;
  multiplier: number;
  days_below: number;
  lowest_day: number | null;
};

export interface MultiplierBackend {
  /** What each choice changes in the cycle's registered days. */
  impact(
    cycle: string,
    multiplier: number,
    from: string | null,
    to: string | null,
  ): Promise<MultiplierImpact>;
  /** The company's changes (administrators and managers). */
  log(company: string, q: MultiplierLogQuery): Promise<MultiplierLogPage>;
  belowMin(company: string): Promise<MultiplierBelow[]>;
}

export const serverMultiplier: MultiplierBackend = {
  async impact(cycle, multiplier, from, to) {
    return (await rpc("ad_multiplier_impact", {
      p_cycle: cycle,
      p_multiplier: multiplier,
      p_from: from,
      p_to: to,
    })) as MultiplierImpact;
  },
  async log(company, q) {
    return (await rpc("ad_multiplier_log", {
      p_company: company,
      p_campaign: q.campaign ?? null,
      p_actor: q.actor ?? null,
      p_from: q.from || null,
      p_to: q.to || null,
      p_search: q.search ?? "",
      p_before: q.before ?? null,
      p_limit: q.limit ?? 30,
    })) as MultiplierLogPage;
  },
  async belowMin(company) {
    return (await rpc("ad_multiplier_below_min", {
      p_company: company,
    })) as MultiplierBelow[];
  },
};

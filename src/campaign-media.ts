import { rpc } from "./api";
import type { MediaLevel } from "./finance-media";

/**
 * Campanhas × Financeiro › Mídia (migration 20270222090000): the media
 * account of the campaign's contracted product (client + product), what
 * the open cycles of its campaigns still have to spend (reserved) and what
 * is left for new cycles (available). A cycle's budget must fit the
 * available; administrators and managers may release up to the company's
 * cap, with a reason. The database enforces it; this mirrors it for the
 * form.
 */

export type MediaReservation = {
  cycle_id: string;
  campaign_id: string;
  campaign_name: string;
  start_date: string;
  end_date: string;
  budget: number;
  /** The spend × M already debited for the cycle. */
  spent: number;
  remaining: number;
};
export type MediaRoom = {
  contract_id: string;
  client_name: string;
  product_name: string;
  balance: number;
  min_balance: number | null;
  level: MediaLevel;
  /** Entries in the account (zero: nothing registered yet). */
  entries: number;
  reserved: number;
  /** Balance − reserved; negative when the open cycles ask for more. */
  available: number;
  /** The account's spend × M per day over the last 7 full days. */
  daily: number;
  reservations: MediaReservation[];
  /** How much a leader may release above the available. */
  override_cap: number;
  can_override: boolean;
  /** Uses Financeiro › Mídia (the statement and entry shortcuts). */
  finance: boolean;
};

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export function mediaRoom(raw: MediaRoom): MediaRoom {
  return {
    ...raw,
    balance: num(raw.balance),
    min_balance:
      raw.min_balance === null || raw.min_balance === undefined
        ? null
        : Number(raw.min_balance),
    reserved: num(raw.reserved),
    available: num(raw.available),
    daily: num(raw.daily),
    override_cap: num(raw.override_cap),
    reservations: (raw.reservations ?? []).map((r) => ({
      ...r,
      budget: num(r.budget),
      spent: num(r.spent),
      remaining: num(r.remaining),
    })),
  };
}

export async function loadMediaRoom(campaign: string): Promise<MediaRoom> {
  return mediaRoom(
    (await rpc("ad_media_room", { p_campaign: campaign })) as MediaRoom,
  );
}

const cents = (v: number) => Math.round(v * 100) / 100;

export type CycleFit = {
  /** What the cycle still has to spend with this budget. */
  need: number;
  /** For this cycle: the available without its own reservation. */
  available: number;
  /** Missing to fit (zero: it fits). */
  shortfall: number;
  /** An ended cycle (or a smaller one) does not reserve anything new. */
  free: boolean;
};

/**
 * Whether the budget fits, as the database checks it: an ended cycle is
 * free; on an edit, only the increase counts.
 */
export function cycleFit(
  room: MediaRoom,
  cycle: { id: string | null; end_date: string; budget: number },
  today: string,
): CycleFit {
  const own = cycle.id
    ? room.reservations.find((r) => r.cycle_id === cycle.id)
    : undefined;
  const available = cents(room.available + (own?.remaining ?? 0));
  const need = cents(Math.max(cycle.budget - (own?.spent ?? 0), 0));
  if (cycle.end_date < today || need <= (own?.remaining ?? 0))
    return { need, available, shortfall: 0, free: true };
  return {
    need,
    available,
    shortfall: Math.max(cents(need - available), 0),
    free: false,
  };
}

/** Whether the person may release the shortfall (with a reason). */
export const canRelease = (room: MediaRoom, shortfall: number) =>
  room.can_override && shortfall > 0 && shortfall <= room.override_cap;

/** Days the balance lasts at the last week's pace (null: no pace). */
export function runway(room: MediaRoom): number | null {
  if (room.daily <= 0) return null;
  return Math.max(Math.floor(room.balance / room.daily), 0);
}

/** The demo's account: a fixed balance per contracted product. */
export function demoMediaRoom(
  contract: { id: string; client: string; product: string },
  open: MediaReservation[],
): MediaRoom {
  const balance = 6000;
  const reserved = cents(open.reduce((s, r) => s + r.remaining, 0));
  return {
    contract_id: contract.id,
    client_name: contract.client,
    product_name: contract.product,
    balance,
    min_balance: null,
    level: "ok",
    entries: 2,
    reserved,
    available: cents(balance - reserved),
    daily: 0,
    reservations: open,
    override_cap: 1000,
    can_override: true,
    finance: true,
  };
}

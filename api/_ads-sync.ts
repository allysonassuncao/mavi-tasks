import crypto from "node:crypto";
import { callRpc } from "./_drive.js";
import { unseal } from "./_google.js";
import {
  AdsError,
  accountId,
  configured,
  graphAll,
  notConfiguredMessage,
  type AdsEnv,
  type Fetch,
} from "./_ads.js";

/**
 * Campanhas: the daily sync of each cycle's numbers (migration
 * 20261002090000_ad_metrics), as the MASO crons did, reading Meta and Google
 * Ads with the connections of api/_ads.ts:
 *  - the days since the last sync (the whole cycle the first time), always
 *    reprocessing the last 7 for late attribution, up to yesterday;
 *  - the cycle-to-date totals up to yesterday (a snapshot: reach and
 *    frequency are only right at that level).
 * The database calls POST /api/ads-sync with ADS_SYNC_SECRET on a schedule
 * (pg_cron, like the push notifications); an admin or manager can also sync a
 * campaign now, with their session.
 */

export type SyncEnv = AdsEnv & { secret: string };
export function syncEnv(
  env: Record<string, string | undefined> = process.env,
  base: AdsEnv,
): SyncEnv {
  return { ...base, secret: env.ADS_SYNC_SECRET ?? "" };
}

type Objective =
  "lead" | "sale" | "message" | "traffic" | "engagement" | "custom" | "video";
type Destination = "lead_form" | "external_page" | "make_landing_page";
export type SyncTarget = {
  cycle_id: string;
  company_id: string;
  campaign_id: string;
  platform: "meta" | "google";
  objective: Objective;
  destination: Destination;
  start_date: string;
  end_date: string;
  today: string;
  last_day: string | null;
  links: { account_id: string; campaign_id: string; manager_id: string }[];
  meta_tokens: Record<
    string,
    { token_cipher: string; expires_at: string | null }
  > | null;
  google_token: { refresh_token_cipher: string } | null;
};
export type Totals = {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  view_content: number;
  add_to_cart: number;
  initiate_checkout: number;
};
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
const add = (a: Totals, b: Totals): Totals => ({
  spend: a.spend + b.spend,
  impressions: a.impressions + b.impressions,
  reach: a.reach + b.reach,
  clicks: a.clicks + b.clicks,
  conversions: a.conversions + b.conversions,
  view_content: a.view_content + b.view_content,
  add_to_cart: a.add_to_cart + b.add_to_cart,
  initiate_checkout: a.initiate_checkout + b.initiate_checkout,
});
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Days to read: from the last sync (7 days back) or the cycle's start. */
export function syncWindow(t: SyncTarget) {
  const until = [t.end_date, addDays(t.today, -1)].sort()[0];
  const since = t.last_day
    ? [t.start_date, addDays(t.today, -7)].sort().reverse()[0]
    : t.start_date;
  return since <= until ? { since, until } : null;
}

// ------------------------------------------------------------ Meta
type MetaAction = { action_type: string; value: string };
/**
 * What counts as a result on Meta, by objective and destination (the MASO's
 * rule, spec 11.4): the first action type present in the list wins; for
 * custom conversions they add up. Messages: conversations started (7 days),
 * the one the MASO showed on screen.
 */
export function metaResults(
  objective: Objective,
  destination: Destination,
  row: { actions?: MetaAction[]; inline_link_clicks?: string },
): Pick<
  Totals,
  "conversions" | "view_content" | "add_to_cart" | "initiate_checkout"
> {
  const actions = row.actions ?? [];
  const value = (type: string) =>
    actions.find((a) => a.action_type === type)?.value;
  const first = (types: string[]) => {
    for (const t of types) {
      const v = value(t);
      if (v !== undefined) return num(v);
    }
    return 0;
  };
  const sum = (types: string[]) =>
    types.reduce((s, t) => s + num(value(t) ?? 0), 0);
  const conversions =
    objective === "traffic"
      ? num(row.inline_link_clicks)
      : objective === "engagement"
        ? first(["post_engagement"])
        : objective === "message"
          ? first(["onsite_conversion.messaging_conversation_started_7d"])
          : objective === "video"
            ? first(["video_view"])
            : objective === "sale"
              ? first([
                  "offsite_conversion.fb_pixel_purchase",
                  "purchase",
                  "omni_purchase",
                ])
              : objective === "custom"
                ? sum([
                    "offsite_conversion.fb_pixel_custom",
                    "offsite_conversion.fb_pixel_complete_registration",
                  ])
                : destination === "lead_form"
                  ? first([
                      "onsite_conversion.lead_grouped",
                      "leadgen_grouped",
                      "lead",
                    ])
                  : first(["offsite_conversion.fb_pixel_lead", "lead"]);
  const funnel = objective === "sale" || objective === "custom";
  return {
    conversions,
    view_content: funnel ? first(["landing_page_view"]) : 0,
    add_to_cart: funnel
      ? first(["offsite_conversion.fb_pixel_add_to_cart", "add_to_cart"])
      : 0,
    initiate_checkout: funnel
      ? first([
          "offsite_conversion.fb_pixel_initiate_checkout",
          "initiate_checkout",
        ])
      : 0,
  };
}

type MetaRow = {
  date_start?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  inline_link_clicks?: string;
  actions?: MetaAction[];
};
function metaTotals(t: SyncTarget, row: MetaRow): Totals {
  return {
    spend: num(row.spend),
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.inline_link_clicks),
    ...metaResults(t.objective, t.destination, row),
  };
}

async function readMeta(
  env: AdsEnv,
  fetchImpl: Fetch,
  t: SyncTarget,
  since: string,
  until: string,
) {
  const days = new Map<string, Totals>();
  let snapshot = zero();
  const accounts = new Map<string, string[]>();
  for (const l of t.links) {
    const id = accountId("meta", l.account_id);
    if (!id) continue;
    const list = accounts.get(id) ?? [];
    if (l.campaign_id) list.push(l.campaign_id);
    accounts.set(id, list);
  }
  for (const [account, campaigns] of accounts) {
    const stored = t.meta_tokens?.[account];
    if (!stored)
      throw new AdsError(
        409,
        `A conta ${account} não está conectada ao Facebook.`,
        "not_connected",
      );
    if (stored.expires_at && Date.parse(stored.expires_at) < Date.now())
      throw new AdsError(
        409,
        `O acesso ao Facebook da conta ${account} expirou. Conecte de novo.`,
        "expired",
      );
    const token = unseal(env.tokenKey!, stored.token_cipher);
    const base: Record<string, string> = {
      level: "account",
      fields: "spend,impressions,reach,inline_link_clicks,actions",
      limit: "500",
      ...(campaigns.length
        ? {
            filtering: JSON.stringify([
              { field: "campaign.id", operator: "IN", value: campaigns },
            ]),
          }
        : {}),
    };
    const daily = await graphAll<MetaRow>(
      env,
      fetchImpl,
      token,
      `/act_${account}/insights`,
      {
        ...base,
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
      },
    );
    for (const row of daily) {
      if (!row.date_start) continue;
      days.set(
        row.date_start,
        add(days.get(row.date_start) ?? zero(), metaTotals(t, row)),
      );
    }
    // Cycle-to-date, deduplicated reach (the snapshot).
    const [total] = await graphAll<MetaRow>(
      env,
      fetchImpl,
      token,
      `/act_${account}/insights`,
      {
        ...base,
        time_range: JSON.stringify({ since: t.start_date, until }),
      },
    );
    if (total) snapshot = add(snapshot, metaTotals(t, total));
  }
  return { days, snapshot };
}

// ------------------------------------------------------------ Google Ads
async function googleAccess(env: AdsEnv, fetchImpl: Fetch, t: SyncTarget) {
  if (!t.google_token)
    throw new AdsError(
      409,
      "Conecte o Google Ads da agência.",
      "not_connected",
    );
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      refresh_token: unseal(env.tokenKey!, t.google_token.refresh_token_cipher),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token)
    throw new AdsError(
      body.error === "invalid_grant" ? 409 : 502,
      body.error === "invalid_grant"
        ? "A conexão com o Google Ads expirou. Conecte de novo."
        : `Google: ${body.error_description || body.error || res.statusText}`,
      body.error === "invalid_grant" ? "not_connected" : undefined,
    );
  return body.access_token;
}

type GoogleRow = {
  segments?: { date?: string };
  metrics?: Record<string, string | number | undefined>;
};
/** Google results: conversions, or clicks/impressions/views (MASO rule). */
export function googleTotals(objective: Objective, row: GoogleRow): Totals {
  const m = row.metrics ?? {};
  const impressions = num(m.impressions);
  const clicks = num(m.clicks);
  return {
    ...zero(),
    spend: num(m.costMicros) / 1e6,
    impressions,
    clicks,
    conversions:
      objective === "traffic"
        ? clicks
        : objective === "engagement"
          ? impressions
          : objective === "video"
            ? num(m.videoTrueviewViews)
            : num(m.conversions),
  };
}

async function readGoogle(
  env: AdsEnv,
  fetchImpl: Fetch,
  t: SyncTarget,
  since: string,
  until: string,
) {
  const access = await googleAccess(env, fetchImpl, t);
  const days = new Map<string, Totals>();
  let snapshot = zero();
  const accounts = new Map<string, { manager: string; campaigns: string[] }>();
  for (const l of t.links) {
    const id = accountId("google", l.account_id);
    if (!id) continue;
    const entry = accounts.get(id) ?? {
      manager: accountId("google", l.manager_id) ?? "",
      campaigns: [],
    };
    if (/^[0-9]+$/.test(l.campaign_id)) entry.campaigns.push(l.campaign_id);
    accounts.set(id, entry);
  }
  const search = async (account: string, manager: string, query: string) => {
    const res = await fetchImpl(
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
    const body = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
      const error = (Array.isArray(body) ? body[0] : body) as {
        error?: {
          message?: string;
          details?: { errors?: { message?: string }[] }[];
        };
      };
      throw new AdsError(
        502,
        `Google Ads: ${error?.error?.details?.[0]?.errors?.[0]?.message ?? error?.error?.message ?? res.statusText}`,
      );
    }
    return (body as { results?: GoogleRow[] }[]).flatMap(
      (b) => b.results ?? [],
    );
  };
  // video_views became video_trueview_views in v22 (the MASO's v21 still
  // took the old name; v25 rejects it).
  const metrics =
    "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.video_trueview_views";
  for (const [account, { manager, campaigns }] of accounts) {
    const filter = campaigns.length
      ? ` AND campaign.id IN (${campaigns.join(",")})`
      : "";
    const daily = await search(
      account,
      manager,
      `SELECT segments.date, ${metrics} FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'${filter}`,
    );
    for (const row of daily) {
      const day = row.segments?.date;
      if (!day) continue;
      days.set(
        day,
        add(days.get(day) ?? zero(), googleTotals(t.objective, row)),
      );
    }
    const total = await search(
      account,
      manager,
      `SELECT ${metrics} FROM campaign WHERE segments.date BETWEEN '${t.start_date}' AND '${until}'${filter}`,
    );
    for (const row of total)
      snapshot = add(snapshot, googleTotals(t.objective, row));
  }
  return { days, snapshot };
}

// ------------------------------------------------------------ run
const round = (t: Totals) => ({
  ...t,
  spend: Math.round(t.spend * 100) / 100,
  conversions: Math.round(t.conversions * 100) / 100,
});

/** Syncs one cycle and stores the result (or the error) in the database. */
export async function syncCycle(
  env: SyncEnv,
  fetchImpl: Fetch,
  t: SyncTarget,
  auth: { authorization: string | null; secret: string | null },
  trigger: "schedule" | "manual",
) {
  const store = (status: "ok" | "error", extra: Record<string, unknown>) =>
    callRpc<number>(env, fetchImpl, auth.authorization, "ad_sync_store", {
      p_secret: auth.secret,
      p_cycle: t.cycle_id,
      p_trigger: trigger,
      p_status: status,
      p_message: "",
      p_days: [],
      p_snapshot: null,
      ...extra,
    });
  const window = syncWindow(t);
  if (!window) return { cycle: t.cycle_id, status: "ok" as const, days: 0 };
  try {
    if (!configured(env, t.platform))
      throw new AdsError(500, notConfiguredMessage(env, t.platform));
    const read = t.platform === "meta" ? readMeta : readGoogle;
    const { days, snapshot } = await read(
      env,
      fetchImpl,
      t,
      window.since,
      window.until,
    );
    // Days without delivery are stored as zero, so gaps read as zero.
    const list = [];
    for (let d = window.since; d <= window.until; d = addDays(d, 1))
      list.push({ day: d, ...round(days.get(d) ?? zero()) });
    const saved = await store("ok", {
      p_days: list,
      p_snapshot: { period_end: window.until, ...round(snapshot) },
    });
    if (!saved.ok) throw new AdsError(saved.status, saved.error);
    return { cycle: t.cycle_id, status: "ok" as const, days: saved.data };
  } catch (e) {
    const message = (e as Error).message;
    await store("error", { p_message: message }).catch(() => null);
    return { cycle: t.cycle_id, status: "error" as const, message };
  }
}

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ads-sync. With the schedule's secret: the next cycles not synced
 * today, in batches, while time allows (the schedule calls again). With an
 * admin's or manager's session and { campaign }: that campaign's cycles, now.
 */
export async function handleAdsSync(
  body: unknown,
  authorization: string | null,
  env: SyncEnv,
  fetchImpl: Fetch = fetch,
  budgetMs = 45_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({
    status,
    body: { error },
  });
  if (!env.tokenKey)
    return fail(
      500,
      "A sincronização não está configurada no servidor: falta GOOGLE_TOKEN_KEY_ADS (32 bytes em base64) na Vercel.",
    );
  const scheduled =
    !!env.secret &&
    !!authorization &&
    sameSecret(authorization, `Bearer ${env.secret}`);
  if (!scheduled && !authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");
  const campaign = String((body as { campaign?: unknown })?.campaign ?? "");
  if (!scheduled && !UUID.test(campaign))
    return fail(400, "Informe a campanha.");
  const auth = scheduled
    ? { authorization: null, secret: env.secret }
    : { authorization, secret: null };
  const started = Date.now();
  const results: Awaited<ReturnType<typeof syncCycle>>[] = [];
  const seen = new Set<string>();
  for (;;) {
    const found = await callRpc<SyncTarget[]>(
      env,
      fetchImpl,
      auth.authorization,
      "ad_sync_targets",
      {
        p_secret: auth.secret,
        p_campaign: scheduled ? null : campaign,
        p_limit: 15,
      },
    );
    if (!found.ok) return fail(found.status, found.error);
    const batch = found.data.filter((t) => !seen.has(t.cycle_id));
    for (const t of batch) {
      seen.add(t.cycle_id);
      results.push(
        await syncCycle(
          env,
          fetchImpl,
          t,
          auth,
          scheduled ? "schedule" : "manual",
        ),
      );
      if (Date.now() - started > budgetMs) break;
    }
    // A campaign is one batch; the schedule goes on while there's time.
    if (!scheduled || !batch.length || Date.now() - started > budgetMs) break;
  }
  return {
    status: 200,
    body: {
      synced: results.filter((r) => r.status === "ok").length,
      errors: results
        .filter((r) => r.status === "error")
        .map((r) => ({ cycle: r.cycle, message: r.message })),
    },
  };
}

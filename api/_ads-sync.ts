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
import {
  actionId,
  classifyActions,
  type ConversionAction,
} from "./_conversions.js";

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

export type SyncEnv = AdsEnv & {
  secret: string;
  /** The Make server's endpoint for the capture pages' leads. */
  makeLeadsUrl: string;
  makeLeadsSecret: string;
};
export const MAKE_LEADS_URL =
  "https://www.makevendas.com.br/api/capture/mavi-leads.php";
export function syncEnv(
  env: Record<string, string | undefined> = process.env,
  base: AdsEnv,
): SyncEnv {
  const url = env.MAKE_LEADS_URL?.trim();
  return {
    ...base,
    secret: env.ADS_SYNC_SECRET ?? "",
    makeLeadsUrl: url && /^https:\/\//.test(url) ? url : MAKE_LEADS_URL,
    makeLeadsSecret: env.MAKE_LEADS_SECRET ?? "",
  };
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
  /** The Make capture pages (destination make_landing_page). */
  landing_pages?: string[];
  /** Google: the conversion actions chosen for the cycle (null: by category). */
  conversion_actions?: string[] | null;
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
/**
 * Days to read: the whole cycle up to yesterday (or its end), every time —
 * late attribution and a change of rule reach every day, and a cycle is a
 * few weeks (one call per account).
 */
export function syncWindow(t: SyncTarget) {
  const until = [t.end_date, addDays(t.today, -1)].sort()[0];
  const since = t.start_date;
  return since <= until ? { since, until } : null;
}

// ------------------------------------------------------------ rules
/*
 * What counts as the cycle's result, by platform, objective and
 * destination — the rules of the MASO crons (cron/registro-acompanhamento-
 * campanhas-facebook.php and -google.php), with their accidents fixed:
 *
 * Meta (insights `actions`):
 *  - TRÁFEGO: link clicks (inline_link_clicks); ENGAJAMENTO: post_engagement
 *    (whatever the destination);
 *  - formulário do Facebook (Lead Ads): leadgen_grouped, for any objective
 *    (the MASO computed it so; its record then read the objective's field);
 *  - página de captura da Make: the pages' distinct leads, from the Make
 *    server (makeLeads below), as the MASO read dados_capture;
 *  - página externa: VENDA purchase (+ funnel landing_page_view,
 *    add_to_cart, initiate_checkout); PERSONALIZADA
 *    offsite_conversion.fb_pixel_custom; MENSAGEM
 *    onsite_conversion.messaging_first_reply (the MASO's since 19/07/2023);
 *    VIDEO video_view; LEAD and the rest offsite_conversion.fb_pixel_lead.
 *
 * Google:
 *  - TRÁFEGO: clicks; ENGAJAMENTO: impressions; VIDEO: TrueView views;
 *  - otherwise the conversion actions the cycle chose or, by default, the
 *    ones of the objective's categories (api/_conversions.ts): the MASO's
 *    name list counted an action named outside it as zero, and its
 *    analysts then typed the number by hand;
 *  - on the Make capture page the leads come from the Make server; VENDA
 *    splits the funnel by category.
 */
type MetaAction = { action_type: string; value: string };
type MetaRow = {
  date_start?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  inline_link_clicks?: string;
  actions?: MetaAction[];
};

/** The Make capture page's leads are the result (not the platform's). */
export const usesMakeLeads = (
  t: Pick<SyncTarget, "objective" | "destination">,
) =>
  t.destination === "make_landing_page" &&
  t.objective !== "traffic" &&
  t.objective !== "engagement";

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
    num(actions.find((a) => a.action_type === type)?.value);
  const has = (type: string) => actions.some((a) => a.action_type === type);
  const none = { view_content: 0, add_to_cart: 0, initiate_checkout: 0 };
  if (objective === "traffic")
    return { conversions: num(row.inline_link_clicks), ...none };
  if (objective === "engagement")
    return { conversions: value("post_engagement"), ...none };
  if (destination === "lead_form")
    return {
      // leadgen_grouped is the MASO's; newer answers name it so too.
      conversions: has("leadgen_grouped")
        ? value("leadgen_grouped")
        : value("onsite_conversion.lead_grouped"),
      ...none,
    };
  // The Make capture page's leads come from the Make server.
  if (destination === "make_landing_page") return { conversions: 0, ...none };
  const funnel = objective === "sale" || objective === "custom";
  return {
    conversions:
      objective === "sale"
        ? value("purchase")
        : objective === "custom"
          ? value("offsite_conversion.fb_pixel_custom")
          : objective === "message"
            ? value("onsite_conversion.messaging_first_reply")
            : objective === "video"
              ? value("video_view")
              : value("offsite_conversion.fb_pixel_lead"),
    view_content: funnel ? value("landing_page_view") : 0,
    add_to_cart: funnel ? value("add_to_cart") : 0,
    initiate_checkout: funnel ? value("initiate_checkout") : 0,
  };
}

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
    // Every account adds up (the MASO kept only the last account's results).
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
    // Cycle-to-date at the account level: deduplicated reach (the MASO
    // summed its ad sets' reach, counting a person once per ad set).
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
  segments?: {
    date?: string;
    conversionAction?: string;
    conversionActionName?: string;
    conversionActionCategory?: string;
  };
  campaign?: { id?: string };
  metrics?: Record<string, string | number | undefined>;
};

/**
 * One campaign's (or the sum's) totals on Google, by objective and
 * destination; the conversion actions that count come from
 * api/_conversions.ts (the cycle's choice, or Google's categories).
 */
export function googleTotals(
  t: Pick<SyncTarget, "objective" | "destination" | "conversion_actions">,
  row: GoogleRow,
  actions: ConversionAction[] = [],
): Totals {
  const m = row.metrics ?? {};
  const impressions = num(m.impressions);
  const clicks = num(m.clicks);
  const base = {
    ...zero(),
    spend: num(m.costMicros) / 1e6,
    impressions,
    clicks,
  };
  if (t.objective === "traffic") return { ...base, conversions: clicks };
  if (t.objective === "engagement")
    return { ...base, conversions: impressions };
  if (t.objective === "video")
    return { ...base, conversions: num(m.videoTrueviewViews) };
  const a = classifyActions(
    t.objective,
    t.destination,
    actions,
    num(m.phoneCalls),
    t.conversion_actions,
  );
  const sale = t.objective === "sale" && t.destination !== "make_landing_page";
  return {
    ...base,
    // The Make page's leads are added from the Make server.
    conversions: a.counted,
    view_content: sale ? a.view_content : 0,
    add_to_cart: sale ? a.add_to_cart : 0,
    initiate_checkout: sale ? a.initiate_checkout : 0,
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
    "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.phone_calls";
  // Totals of one period: metrics per campaign, and each campaign's
  // conversion actions (a segment the cost metrics can't come with).
  const read = async (
    account: string,
    manager: string,
    filter: string,
    period: string,
    daily: boolean,
  ) => {
    const date = daily ? "segments.date, " : "";
    const [rows, actionRows] = await Promise.all([
      search(
        account,
        manager,
        `SELECT ${date}campaign.id, ${metrics} FROM campaign WHERE ${period}${filter}`,
      ),
      search(
        account,
        manager,
        `SELECT ${date}campaign.id, segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions FROM campaign WHERE ${period}${filter}`,
      ),
    ]);
    const key = (r: GoogleRow) =>
      `${daily ? (r.segments?.date ?? "") : ""}|${r.campaign?.id ?? ""}`;
    const actions = new Map<string, ConversionAction[]>();
    for (const r of actionRows) {
      const id = actionId(r.segments?.conversionAction);
      if (!id) continue;
      const list = actions.get(key(r)) ?? [];
      list.push({
        id,
        name: r.segments?.conversionActionName ?? id,
        category: r.segments?.conversionActionCategory ?? "",
        conversions: num(r.metrics?.conversions),
      });
      actions.set(key(r), list);
    }
    return rows.map((r) => ({
      day: r.segments?.date ?? "",
      totals: googleTotals(t, r, actions.get(key(r)) ?? []),
    }));
  };
  for (const [account, { manager, campaigns }] of accounts) {
    const filter = campaigns.length
      ? ` AND campaign.id IN (${campaigns.join(",")})`
      : "";
    for (const { day, totals } of await read(
      account,
      manager,
      filter,
      `segments.date BETWEEN '${since}' AND '${until}'`,
      true,
    ))
      if (day) days.set(day, add(days.get(day) ?? zero(), totals));
    for (const { totals } of await read(
      account,
      manager,
      filter,
      `segments.date BETWEEN '${t.start_date}' AND '${until}'`,
      false,
    ))
      snapshot = add(snapshot, totals);
  }
  return { days, snapshot };
}

// ------------------------------------------------------------ Make pages
/**
 * The distinct leads of the cycle's Make capture pages (MASO:
 * buscaQntLeadsLPMake, dados_capture visible leads), per day and for the
 * period, from the Make server (api/capture/mavi-leads.php there).
 */
export async function makeLeads(
  env: SyncEnv,
  fetchImpl: Fetch,
  pages: string[],
  since: string,
  until: string,
) {
  if (!env.makeLeadsSecret)
    throw new AdsError(
      500,
      "Esta campanha conta os cadastros da página de captura da Make, e a leitura deles não está configurada: falta MAKE_LEADS_SECRET na Vercel.",
    );
  const squeezes = [...new Set(pages.map((p) => p.trim()).filter(Boolean))];
  if (!squeezes.length)
    throw new AdsError(
      400,
      "O ciclo tem destino página de captura da Make, mas nenhuma página: informe as páginas no ciclo.",
    );
  let res: Response;
  try {
    res = await fetchImpl(env.makeLeadsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mavi-Secret": env.makeLeadsSecret,
      },
      body: JSON.stringify({ squeezes, since, until }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new AdsError(502, `Make: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    days?: Record<string, number>;
    total?: number;
    error?: string;
  };
  if (!res.ok) throw new AdsError(502, `Make: ${body.error ?? res.statusText}`);
  return {
    days: new Map(
      Object.entries(body.days ?? {}).map(([d, n]) => [d, num(n)] as const),
    ),
    total: num(body.total),
  };
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
    // The capture page's leads are the result (Google adds its calls and
    // WhatsApp/purchase actions to them, as the MASO did).
    if (usesMakeLeads(t)) {
      const leads = await makeLeads(
        env,
        fetchImpl,
        t.landing_pages ?? [],
        window.since,
        window.until,
      );
      for (const [day, n] of leads.days) {
        const d = days.get(day) ?? zero();
        days.set(day, { ...d, conversions: d.conversions + n });
      }
      snapshot.conversions += leads.total;
    }
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

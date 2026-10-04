import crypto from "node:crypto";
import { callRpc } from "./_drive.js";
import { unseal } from "./_google.js";
import {
  AdsError,
  accountId,
  configured,
  graphAll,
  notConfiguredMessage,
  type Fetch,
} from "./_ads.js";
import { actionId, type ConversionAction } from "./_conversions.js";
import {
  googleAccess,
  googleTotals,
  mapLimit,
  metaTotals,
  type GoogleRow,
  type MetaRow,
  type SyncEnv,
  type SyncTarget,
  type Totals,
} from "./_ads-sync.js";
import { meteredFetch, newApiMeter, type ApiMeter } from "./_ads-meter.js";

/**
 * Campanhas › lista: o leitor do "hoje" (migração
 * 20270331090000_campaign_list_results). O pg_cron chama POST /api/ads-sync
 * com {"today": true} e o segredo da sincronização; aqui:
 *  1. os ciclos atuais a ler (ad_today_targets) são juntados por conta de
 *     anúncios — uma leitura por conta traz todas as campanhas dela (Meta:
 *     uma chamada de insights por campanha da conta; Google: duas consultas,
 *     as métricas e as ações de conversão);
 *  2. cada ciclo soma as suas campanhas com a mesma regra da sincronização
 *     (as "Conversões que contam" do Meta e as ações escolhidas do Google);
 *     os cadastros das páginas da Make entram no banco;
 *  3. ad_today_store grava, com as tentativas que falharam e as contas que
 *     a cota pausou (as mesmas pausas dos Insights da MAVI).
 * A lista nunca chama as plataformas: lê o banco.
 */

type CampaignRow = MetaRow & { campaign_id?: string };
export type TodayTarget = Pick<
  SyncTarget,
  | "cycle_id"
  | "company_id"
  | "campaign_id"
  | "platform"
  | "objective"
  | "destination"
  | "conversion_actions"
  | "meta_conversions"
  | "today"
  | "links"
  | "meta_tokens"
  | "google_token"
>;

/** Uma conta de anúncios e os ciclos que leem dela. */
export type AccountGroup = {
  company: string;
  platform: "meta" | "google";
  account: string;
  manager: string;
  today: string;
  /** Algum ciclo vinculou a conta inteira: sem filtro de campanhas. */
  whole: boolean;
  campaigns: string[];
  targets: TodayTarget[];
};

const validCampaign = (platform: "meta" | "google", id: string) =>
  platform === "google" ? /^[0-9]+$/.test(id) : !!id;

/** Junta os ciclos por empresa, plataforma e conta. */
export function groupByAccount(targets: TodayTarget[]): AccountGroup[] {
  const groups = new Map<string, AccountGroup>();
  for (const t of targets)
    for (const l of t.links ?? []) {
      const account = accountId(t.platform, l.account_id);
      if (!account) continue;
      const key = `${t.company_id}|${t.platform}|${account}`;
      const g = groups.get(key) ?? {
        company: t.company_id,
        platform: t.platform,
        account,
        manager: accountId("google", l.manager_id) ?? "",
        today: t.today,
        whole: false,
        campaigns: [],
        targets: [],
      };
      if (!g.targets.includes(t)) g.targets.push(t);
      if (validCampaign(t.platform, l.campaign_id)) {
        if (!g.campaigns.includes(l.campaign_id)) g.campaigns.push(l.campaign_id);
      } else g.whole = true;
      groups.set(key, g);
    }
  return [...groups.values()];
}

/** As campanhas de um ciclo nesta conta (null: a conta toda). */
export function ownCampaigns(t: TodayTarget, g: AccountGroup): Set<string> | null {
  const own = new Set<string>();
  for (const l of t.links ?? []) {
    if (accountId(t.platform, l.account_id) !== g.account) continue;
    if (!validCampaign(t.platform, l.campaign_id)) return null;
    own.add(l.campaign_id);
  }
  return own;
}

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
const plus = (a: Totals, b: Totals): Totals => {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof Totals)[]) out[k] = a[k] + b[k];
  return out;
};

/** Os totais de hoje de cada ciclo da conta, a partir das linhas por campanha. */
export function splitRows<R>(
  g: AccountGroup,
  rows: R[],
  campaignOf: (row: R) => string,
  totalsOf: (t: TodayTarget, row: R) => Totals,
): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const t of g.targets) {
    const own = ownCampaigns(t, g);
    let sum = zero();
    for (const row of rows)
      if (!own || own.has(campaignOf(row))) sum = plus(sum, totalsOf(t, row));
    out.set(t.cycle_id, sum);
  }
  return out;
}

async function readMetaAccount(env: SyncEnv, fetchImpl: Fetch, g: AccountGroup) {
  const stored = g.targets.map((t) => t.meta_tokens?.[g.account]).find(Boolean);
  if (!stored)
    throw new AdsError(409, `A conta ${g.account} não está conectada ao Facebook.`, "not_connected");
  const token = unseal(env.tokenKey!, stored.token_cipher);
  const rows = await graphAll<CampaignRow>(env, fetchImpl, token, `/act_${g.account}/insights`, {
    level: "campaign",
    fields: "campaign_id,spend,impressions,inline_link_clicks,actions",
    time_range: JSON.stringify({ since: g.today, until: g.today }),
    limit: "500",
    ...(g.whole || !g.campaigns.length
      ? {}
      : { filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: g.campaigns }]) }),
  });
  return splitRows(
    g,
    rows,
    (r) => String(r.campaign_id ?? ""),
    (t, r) => metaTotals(t, r, g.today),
  );
}

async function readGoogleAccount(env: SyncEnv, fetchImpl: Fetch, g: AccountGroup, access: string) {
  const search = async (query: string) => {
    const res = await fetchImpl(
      `https://googleads.googleapis.com/${env.google.version}/customers/${g.account}/googleAds:searchStream`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "developer-token": env.google.developerToken,
          "login-customer-id": g.manager || g.account,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
      const error = (Array.isArray(body) ? body[0] : body) as {
        error?: { message?: string; details?: { errors?: { message?: string }[] }[] };
      };
      throw new AdsError(
        502,
        `Google Ads: ${error?.error?.details?.[0]?.errors?.[0]?.message ?? error?.error?.message ?? res.statusText}`,
      );
    }
    return (body as { results?: GoogleRow[] }[]).flatMap((b) => b.results ?? []);
  };
  const filter =
    g.whole || !g.campaigns.length ? "" : ` AND campaign.id IN (${g.campaigns.join(",")})`;
  const period = `segments.date BETWEEN '${g.today}' AND '${g.today}'`;
  const [rows, actionRows] = await Promise.all([
    search(
      `SELECT campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.phone_calls FROM campaign WHERE ${period}${filter}`,
    ),
    search(
      `SELECT campaign.id, segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions FROM campaign WHERE ${period}${filter}`,
    ),
  ]);
  const actions = new Map<string, ConversionAction[]>();
  for (const r of actionRows) {
    const id = actionId(r.segments?.conversionAction);
    if (!id) continue;
    const key = r.campaign?.id ?? "";
    const list = actions.get(key) ?? [];
    list.push({
      id,
      name: r.segments?.conversionActionName ?? id,
      category: r.segments?.conversionActionCategory ?? "",
      conversions: Number(r.metrics?.conversions) || 0,
    });
    actions.set(key, list);
  }
  return splitRows(
    g,
    rows,
    (r) => String(r.campaign?.id ?? ""),
    (t, r) => googleTotals(t, r, actions.get(r.campaign?.id ?? "") ?? []),
  );
}

/** Uma pausa pela cota para gravar em mavi_private.ad_api_cooldowns. */
export type Cooldown = { platform: "meta" | "google"; account: string; until: string; reason: string };
const SOFT_LIMIT_PCT = 75;
const inMinutes = (now: number, minutes: number) => new Date(now + minutes * 60_000).toISOString();

/** O que a leitura de uma conta deixou: totais por ciclo, erro e pausas. */
export function cooldownsOf(g: AccountGroup, meter: ApiMeter, now: number): Cooldown[] {
  if (meter.throttle)
    return [
      {
        platform: meter.throttle.platform,
        account: meter.throttle.scope === "platform" ? "*" : g.account,
        until: inMinutes(now, meter.throttle.minutes),
        reason: meter.throttle.reason,
      },
    ];
  // Perto do limite: a conta descansa antes da próxima leitura.
  if (meter.pct >= SOFT_LIMIT_PCT)
    return [
      {
        platform: g.platform,
        account: g.account,
        until: inMinutes(now, Math.max(meter.regainMinutes, 15)),
        reason: `Consumo da cota em ${Math.round(meter.pct)}%`,
      },
    ];
  return [];
}

/** Cada chamada às plataformas desiste depois de 15 s (a função tem 60 s). */
const withTimeout =
  (fetchImpl: Fetch, ms: number): Fetch =>
  (input, init) =>
    fetchImpl(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) });

/**
 * Lê as contas e devolve o que gravar. Um ciclo com várias contas só é
 * gravado quando todas foram lidas; uma conta que falhou marca a tentativa
 * (com o erro) nos ciclos dela.
 */
export async function readToday(
  env: SyncEnv,
  fetchImpl: Fetch,
  targets: TodayTarget[],
  opts: { budgetMs?: number; now?: () => number } = {},
) {
  const now = opts.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? 35_000;
  const groups = groupByAccount(targets);
  const sums = new Map<string, Totals>();
  const failed = new Map<string, string>();
  const done = new Set<string>();
  const cooldowns: Cooldown[] = [];
  const googleTokens = new Map<string, Promise<string>>();
  const timed = withTimeout(fetchImpl, 15_000);
  await mapLimit(groups, 4, async (g) => {
    // Nenhuma conta começa depois do orçamento: as que ficaram vão na próxima.
    if (now() - started > budget) return;
    const meter = newApiMeter();
    const f = meteredFetch(timed, meter);
    try {
      if (!configured(env, g.platform)) throw new AdsError(500, notConfiguredMessage(env, g.platform));
      let totals: Map<string, Totals>;
      if (g.platform === "meta") totals = await readMetaAccount(env, f, g);
      else {
        if (!googleTokens.has(g.company))
          googleTokens.set(g.company, googleAccess(env, timed, g.targets[0]));
        totals = await readGoogleAccount(env, f, g, await googleTokens.get(g.company)!);
      }
      for (const [cycle, t] of totals) sums.set(cycle, plus(sums.get(cycle) ?? zero(), t));
    } catch (e) {
      const message = meter.throttle
        ? `${meter.throttle.reason}: a conta ${g.account} volta a ser lida quando a cota liberar.`
        : (e as Error).name === "TimeoutError"
          ? `A conta ${g.account} não respondeu a tempo.`
          : `Conta ${g.account}: ${(e as Error).message}`;
      for (const t of g.targets) if (!failed.has(t.cycle_id)) failed.set(t.cycle_id, message.slice(0, 480));
    } finally {
      cooldowns.push(...cooldownsOf(g, meter, now()));
      for (const t of g.targets) done.add(`${t.cycle_id}|${g.account}`);
    }
  });
  const rows = [];
  const errors = [];
  for (const t of targets) {
    if (failed.has(t.cycle_id)) {
      errors.push({ cycle_id: t.cycle_id, error: failed.get(t.cycle_id)! });
      continue;
    }
    const accounts = groups.filter((g) => g.targets.includes(t));
    // Sem conta válida nos vínculos, ou alguma conta que não chegou a ser lida.
    if (!accounts.length) {
      errors.push({ cycle_id: t.cycle_id, error: "O ciclo não tem contas válidas vinculadas." });
      continue;
    }
    if (!accounts.every((g) => done.has(`${t.cycle_id}|${g.account}`))) continue;
    const s = sums.get(t.cycle_id) ?? zero();
    rows.push({
      cycle_id: t.cycle_id,
      day: t.today,
      spend: Math.round(s.spend * 100) / 100,
      conversions: Math.round(s.conversions * 100) / 100,
      clicks: Math.round(s.clicks),
      impressions: Math.round(s.impressions),
    });
  }
  return { rows, errors, cooldowns, accounts: groups.length };
}

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** POST /api/ads-sync {"today": true}: só o agendamento, com o segredo. */
export async function handleAdsToday(
  authorization: string | null,
  env: SyncEnv,
  fetchImpl: Fetch = fetch,
  budgetMs = 35_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!env.tokenKey)
    return {
      status: 500,
      body: { error: "Falta GOOGLE_TOKEN_KEY_ADS (32 bytes em base64) na Vercel." },
    };
  if (!env.secret || !authorization || !sameSecret(authorization, `Bearer ${env.secret}`))
    return { status: 401, body: { error: "Autenticação necessária." } };
  const found = await callRpc<TodayTarget[]>(env, fetchImpl, null, "ad_today_targets", {
    p_secret: env.secret,
    p_limit: 300,
  });
  if (!found.ok) return { status: found.status, body: { error: found.error } };
  if (!found.data.length) return { status: 200, body: { read: 0, errors: 0, accounts: 0 } };
  const r = await readToday(env, fetchImpl, found.data, { budgetMs });
  const saved = await callRpc<number>(env, fetchImpl, null, "ad_today_store", {
    p_secret: env.secret,
    p_rows: r.rows,
    p_errors: r.errors,
    p_cooldowns: r.cooldowns,
  });
  if (!saved.ok) return { status: saved.status, body: { error: saved.error } };
  return { status: 200, body: { read: saved.data, errors: r.errors.length, accounts: r.accounts } };
}

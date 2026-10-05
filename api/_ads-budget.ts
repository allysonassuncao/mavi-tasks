import { callRpc } from "./_drive.js";
import { unseal } from "./_google.js";
import { AdsError, configured, graphAll, notConfiguredMessage, type Fetch } from "./_ads.js";
import { fromMinor } from "./_ads-platform.js";
import { googleAccess, mapLimit, type SyncEnv, type SyncTarget } from "./_ads-sync.js";
import { meteredFetch, newApiMeter } from "./_ads-meter.js";
import {
  cooldownsOf,
  googleSearch,
  groupByAccount,
  ownCampaigns,
  sameSecret,
  withTimeout,
  type AccountGroup,
  type Cooldown,
} from "./_ads-today.js";

/**
 * Campanhas › lista: o orçamento configurado no Meta e no Google (migração
 * 20270427090000_campaign_platform_budget). Vai junto do leitor do "hoje"
 * (o mesmo agendamento, a cada ~3 h por ciclo) e no botão "Atualizar" da
 * lista ({"budget": "<campanha>"}, por quem vê a campanha). Uma leitura leve
 * por conta de anúncios:
 *  - Meta: as campanhas com os conjuntos numa chamada (só a estrutura, sem
 *    insights). Com CBO conta o orçamento da campanha; sem, a soma dos
 *    conjuntos ativos;
 *  - Google: uma consulta GAQL; um orçamento compartilhado conta uma vez.
 * Só entra o que está entregando (campanha e conjunto ativos, sem fim no
 * passado). O vitalício fica à parte. A lista só lê o banco.
 */

export type BudgetTarget = Pick<
  SyncTarget,
  "cycle_id" | "company_id" | "campaign_id" | "platform" | "today" | "links" | "google_token"
> & {
  meta_tokens: Record<string, { token_cipher: string; expires_at: string | null; currency?: string | null }> | null;
};

/** Uma campanha (CBO, Google) ou um conjunto (ABO) com orçamento próprio. */
export type BudgetItem = {
  id: string;
  name: string;
  level: "campaign" | "adset";
  /** A campanha da plataforma (a do vínculo). */
  campaign_id: string;
  /** Entregando agora: o orçamento conta. */
  active: boolean;
  status: string;
  daily: number;
  lifetime: number;
  lifetime_left: number;
  /** Google: o orçamento (compartilhado conta uma vez). */
  budget_id?: string;
  shared?: boolean;
};

export type BudgetRow = {
  cycle_id: string;
  daily: number;
  lifetime: number;
  lifetime_left: number;
  active: number;
  total: number;
  items: BudgetItem[];
  currency: string;
};

type MetaAdset = {
  id: string;
  name?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  budget_remaining?: string;
  end_time?: string;
};
export type MetaCampaign = MetaAdset & {
  stop_time?: string;
  adsets?: { data?: MetaAdset[] };
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number) => Math.round(n * 100) / 100;
/** O valor do Meta (na menor unidade da moeda); sem valor, 0. */
const minor = (v: unknown, currency: string) => fromMinor(v, currency) ?? 0;
const ended = (end: string | undefined, now: number) => !!end && Date.parse(end) <= now;

/** Os itens com orçamento de uma campanha do Meta (CBO: ela; ABO: os conjuntos). */
export function metaItems(c: MetaCampaign, currency: string, now: number): BudgetItem[] {
  const status = c.effective_status ?? "";
  const running = status === "ACTIVE" && !ended(c.stop_time, now);
  const adsets = c.adsets?.data ?? [];
  const adsetRunning = (a: MetaAdset) => a.effective_status === "ACTIVE" && !ended(a.end_time, now);
  const daily = minor(c.daily_budget, currency);
  const lifetime = minor(c.lifetime_budget, currency);
  if (daily || lifetime)
    return [
      {
        id: c.id,
        name: c.name ?? c.id,
        level: "campaign",
        campaign_id: c.id,
        // CBO sem nenhum conjunto entregando não gasta.
        active: running && adsets.some(adsetRunning),
        status: running && !adsets.some(adsetRunning) ? "NO_ACTIVE_ADSETS" : status,
        daily,
        lifetime,
        lifetime_left: lifetime ? minor(c.budget_remaining, currency) : 0,
      },
    ];
  return adsets.map((a) => ({
    id: a.id,
    name: a.name ?? a.id,
    level: "adset" as const,
    campaign_id: c.id,
    active: running && adsetRunning(a),
    status: running ? (a.effective_status ?? "") : status,
    daily: minor(a.daily_budget, currency),
    lifetime: minor(a.lifetime_budget, currency),
    lifetime_left: a.lifetime_budget ? minor(a.budget_remaining, currency) : 0,
  }));
}

const META_FIELDS =
  "id,name,effective_status,daily_budget,lifetime_budget,budget_remaining,stop_time," +
  "adsets.limit(200){id,name,effective_status,daily_budget,lifetime_budget,budget_remaining,end_time}";

async function readMetaBudgets(env: SyncEnv, fetchImpl: Fetch, g: AccountGroup<BudgetTarget>, now: number) {
  const stored = g.targets.map((t) => t.meta_tokens?.[g.account]).find(Boolean);
  if (!stored)
    throw new AdsError(409, `A conta ${g.account} não está conectada ao Facebook.`, "not_connected");
  const token = unseal(env.tokenKey!, stored.token_cipher);
  const currency = stored.currency || "BRL";
  // A conta toda: só as campanhas entregando; senão, as vinculadas (paradas
  // também, para a lista dizer que estão paradas).
  const campaigns = await graphAll<MetaCampaign>(env, fetchImpl, token, `/act_${g.account}/campaigns`, {
    fields: META_FIELDS,
    limit: "100",
    filtering: JSON.stringify(
      g.whole || !g.campaigns.length
        ? [{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]
        : [{ field: "campaign.id", operator: "IN", value: g.campaigns }],
    ),
  });
  return { items: campaigns.flatMap((c) => metaItems(c, currency, now)), currency };
}

type GoogleBudgetRow = {
  campaign?: { id?: string; name?: string; status?: string; primaryStatus?: string };
  campaignBudget?: {
    resourceName?: string;
    amountMicros?: string;
    totalAmountMicros?: string;
    explicitlyShared?: boolean;
  };
  customer?: { currencyCode?: string };
};
/** As que não entregam (o Google diz por primary_status). */
const GOOGLE_STOPPED = new Set(["PAUSED", "REMOVED", "ENDED", "PENDING", "NOT_ELIGIBLE"]);

export function googleItems(rows: GoogleBudgetRow[]): BudgetItem[] {
  return rows.map((r) => {
    const id = String(r.campaign?.id ?? "");
    const status = r.campaign?.primaryStatus ?? r.campaign?.status ?? "";
    const b = r.campaignBudget ?? {};
    return {
      id,
      name: r.campaign?.name ?? id,
      level: "campaign" as const,
      campaign_id: id,
      active: r.campaign?.status === "ENABLED" && !GOOGLE_STOPPED.has(r.campaign?.primaryStatus ?? ""),
      status,
      daily: cents(num(b.amountMicros) / 1e6),
      lifetime: cents(num(b.totalAmountMicros) / 1e6),
      lifetime_left: 0,
      budget_id: b.resourceName ?? "",
      shared: !!b.explicitlyShared,
    };
  });
}

async function readGoogleBudgets(env: SyncEnv, fetchImpl: Fetch, g: AccountGroup<BudgetTarget>, access: string) {
  const filter =
    g.whole || !g.campaigns.length
      ? " AND campaign.status = 'ENABLED'"
      : ` AND campaign.id IN (${g.campaigns.join(",")})`;
  const rows = await googleSearch<GoogleBudgetRow>(
    env,
    fetchImpl,
    g,
    access,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.explicitly_shared, customer.currency_code FROM campaign WHERE campaign.status != 'REMOVED'${filter}`,
  );
  return { items: googleItems(rows), currency: rows[0]?.customer?.currencyCode || "BRL" };
}

/**
 * A soma de um ciclo: o diário e o vitalício do que está entregando. Um
 * orçamento compartilhado do Google conta uma vez.
 */
export function summarize(items: BudgetItem[]) {
  const seen = new Set<string>();
  let daily = 0;
  let lifetime = 0;
  let lifetimeLeft = 0;
  let active = 0;
  for (const i of items) {
    if (!i.active) continue;
    active++;
    if (i.budget_id) {
      if (seen.has(i.budget_id)) continue;
      seen.add(i.budget_id);
    }
    daily += i.daily;
    lifetime += i.lifetime;
    lifetimeLeft += i.lifetime_left;
  }
  return {
    daily: cents(daily),
    lifetime: cents(lifetime),
    lifetime_left: cents(lifetimeLeft),
    active,
    total: items.length,
  };
}

/**
 * Lê as contas e devolve o que gravar. Um ciclo com várias contas só é
 * gravado quando todas foram lidas; uma conta que falhou marca a tentativa
 * (com o erro) nos ciclos dela.
 */
export async function readBudgets(
  env: SyncEnv,
  fetchImpl: Fetch,
  targets: BudgetTarget[],
  opts: { budgetMs?: number; now?: () => number } = {},
) {
  const now = opts.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? 35_000;
  const groups = groupByAccount(targets);
  const items = new Map<string, BudgetItem[]>();
  const currencies = new Map<string, string>();
  const failed = new Map<string, string>();
  const done = new Set<string>();
  const cooldowns: Cooldown[] = [];
  const googleTokens = new Map<string, Promise<string>>();
  const timed = withTimeout(fetchImpl, 15_000);
  await mapLimit(groups, 4, async (g) => {
    if (now() - started > budget) return;
    const meter = newApiMeter();
    const f = meteredFetch(timed, meter);
    try {
      if (!configured(env, g.platform)) throw new AdsError(500, notConfiguredMessage(env, g.platform));
      let read: { items: BudgetItem[]; currency: string };
      if (g.platform === "meta") read = await readMetaBudgets(env, f, g, now());
      else {
        if (!googleTokens.has(g.company))
          googleTokens.set(g.company, googleAccess(env, timed, g.targets[0]));
        read = await readGoogleBudgets(env, f, g, await googleTokens.get(g.company)!);
      }
      for (const t of g.targets) {
        const own = ownCampaigns(t, g);
        const mine = read.items.filter((i) => !own || own.has(i.campaign_id));
        items.set(t.cycle_id, [...(items.get(t.cycle_id) ?? []), ...mine]);
        currencies.set(t.cycle_id, read.currency);
      }
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
  const rows: BudgetRow[] = [];
  const errors: { cycle_id: string; error: string }[] = [];
  for (const t of targets) {
    if (failed.has(t.cycle_id)) {
      errors.push({ cycle_id: t.cycle_id, error: failed.get(t.cycle_id)! });
      continue;
    }
    const accounts = groups.filter((g) => g.targets.includes(t));
    if (!accounts.length) {
      errors.push({ cycle_id: t.cycle_id, error: "O ciclo não tem contas válidas vinculadas." });
      continue;
    }
    if (!accounts.every((g) => done.has(`${t.cycle_id}|${g.account}`))) continue;
    const list = items.get(t.cycle_id) ?? [];
    // Os que entregam primeiro, depois os maiores (o balão mostra até 60).
    list.sort((a, b) => Number(b.active) - Number(a.active) || b.daily + b.lifetime - (a.daily + a.lifetime));
    rows.push({
      cycle_id: t.cycle_id,
      ...summarize(list),
      items: list,
      currency: currencies.get(t.cycle_id) ?? "BRL",
    });
  }
  return { rows, errors, cooldowns, accounts: groups.length };
}

/**
 * Junto do leitor do "hoje" (POST /api/ads-sync {"today": true}, só o
 * agendamento): os ciclos em dia de leitura. Sem a migração, não faz nada.
 */
export async function handleBudgetSchedule(
  authorization: string | null,
  env: SyncEnv,
  fetchImpl: Fetch = fetch,
  budgetMs = 35_000,
): Promise<{ read: number; errors: number; accounts: number } | null> {
  if (!env.tokenKey || !env.secret || !authorization || !sameSecret(authorization, `Bearer ${env.secret}`))
    return null;
  const found = await callRpc<BudgetTarget[]>(env, fetchImpl, null, "ad_budget_targets", {
    p_secret: env.secret,
    p_campaign: null,
    p_limit: 300,
  });
  if (!found.ok || !found.data.length) return null;
  const r = await readBudgets(env, fetchImpl, found.data, { budgetMs });
  const saved = await callRpc<number>(env, fetchImpl, null, "ad_budget_store", {
    p_secret: env.secret,
    p_rows: r.rows,
    p_errors: r.errors,
    p_cooldowns: r.cooldowns,
  });
  if (!saved.ok) return null;
  return { read: saved.data, errors: r.errors.length, accounts: r.accounts };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O botão "Atualizar" da lista: POST /api/ads-sync {"budget": "<campanha>"}
 * com a sessão da pessoa. O banco confere quem pode, o intervalo de 5 min e
 * as pausas da cota; a gravação é com o segredo (as telas recarregam).
 */
export async function handleBudgetRefresh(
  body: unknown,
  authorization: string | null,
  env: SyncEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!env.tokenKey || !env.secret)
    return {
      status: 500,
      body: { error: "A leitura do orçamento não está configurada no servidor (GOOGLE_TOKEN_KEY_ADS e ADS_SYNC_SECRET)." },
    };
  if (!authorization?.startsWith("Bearer ")) return { status: 401, body: { error: "Autenticação necessária." } };
  const campaign = String((body as { budget?: unknown })?.budget ?? "");
  if (!UUID.test(campaign)) return { status: 400, body: { error: "Informe a campanha." } };
  const found = await callRpc<BudgetTarget[]>(env, fetchImpl, authorization, "ad_budget_targets", {
    p_secret: null,
    p_campaign: campaign,
    p_limit: 1,
  });
  if (!found.ok) return { status: found.status, body: { error: found.error } };
  if (!found.data.length) return { status: 404, body: { error: "Campanha não encontrada." } };
  const r = await readBudgets(env, fetchImpl, found.data, { budgetMs: 40_000 });
  const saved = await callRpc<number>(env, fetchImpl, null, "ad_budget_store", {
    p_secret: env.secret,
    p_rows: r.rows,
    p_errors: r.errors,
    p_cooldowns: r.cooldowns,
  });
  if (!saved.ok) return { status: saved.status, body: { error: saved.error } };
  if (r.errors.length) return { status: 502, body: { error: r.errors[0].error } };
  const row = r.rows[0];
  return {
    status: 200,
    body: row
      ? { daily: row.daily, lifetime: row.lifetime, active: row.active, total: row.total }
      : { daily: null },
  };
}

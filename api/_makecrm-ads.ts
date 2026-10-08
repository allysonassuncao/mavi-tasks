import { callRpc } from "./_drive.js";
import { graph, graphAll, type Fetch } from "./_ads.js";
import { sameSecret } from "./_ads-today.js";
import { unseal } from "./_google.js";
import type { SyncEnv } from "./_ads-sync.js";

/**
 * MakeCRM › Anúncios (contas Make Ads): os números das campanhas do MAVI
 * quando o MASO não tem os registros diários delas no período (migração
 * 20270621090000_makecrm_ads_report). A edge function ads-report do MakeCRM
 * chama POST /api/makecrm-ads com X-Mavi-Secret (MAKECRM_ADS_SECRET, o
 * MAVI_ADS_SECRET do MakeCRM) e {action, crm_company, refs, since, until}:
 *  - campaigns: as campanhas do MASO pedidas (refs = id_campanha, o
 *    legacy_id daqui) e todas as dos clientes ligados à empresa do MakeCRM
 *    (client_crm_links), com a soma dos dias do período, o ciclo e os
 *    vínculos na plataforma;
 *  - ads: os anúncios do Meta de uma campanha (refs = [id do MAVI ou do
 *    MASO]) com os números da Meta no período e os criativos, e a campanha
 *    (os totais do MAVI, que o MakeCRM reparte entre os anúncios);
 *  - audience: idade, gênero e região das campanhas do Meta pedidas, por
 *    campanha da plataforma (o MakeCRM rateia os totais pelas faixas).
 * Os tokens nunca saem daqui: o MAVI lê a Meta e devolve só os números.
 */

export type MakecrmAdsEnv = SyncEnv & {
  /** MAKECRM_ADS_SECRET: o que o MakeCRM manda em X-Mavi-Secret. */
  makecrmSecret: string;
};
type Result = { status: number; body: Record<string, unknown> };
type Json = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[0-9A-Za-z_-]{1,64}$/;
const META_ID = /^[0-9]{1,30}$/;
/** At most this many campaigns per call (a client has a few dozen). */
export const MAX_REFS = 500;
/** Graph pages of ads per campaign, as in the MakeCRM. */
const ADS_PAGES = 5;
const AUDIENCE_PAGES = 20;

export type MakecrmQuery = {
  action: "campaigns" | "ads" | "audience";
  crmCompany: string;
  refs: string[];
  since: string;
  until: string;
};

function validDay(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)
    ? value
    : null;
}

/** The request, or null when anything is off. */
export function makecrmQuery(body: unknown): MakecrmQuery | null {
  const input = (body ?? {}) as Record<string, unknown>;
  const action = input.action;
  if (action !== "campaigns" && action !== "ads" && action !== "audience")
    return null;
  const crmCompany = String(input.crm_company ?? "");
  const since = validDay(input.since);
  const until = validDay(input.until);
  if (!UUID.test(crmCompany) || !since || !until || until < since) return null;
  if (input.refs !== undefined && !Array.isArray(input.refs)) return null;
  const refs = [
    ...new Set(
      ((input.refs as unknown[]) ?? []).map((r) => String(r ?? "").trim()),
    ),
  ];
  if (refs.length > MAX_REFS || refs.some((r) => !REF.test(r))) return null;
  if (action === "ads" && refs.length !== 1) return null;
  if (action === "audience" && refs.length === 0) return null;
  return { action, crmCompany, refs, since, until };
}

const fail = (status: number, error: string): Result => ({
  status,
  body: { error },
});

export async function handleMakecrmAds(
  body: unknown,
  given: string | null,
  env: MakecrmAdsEnv,
  fetchImpl: Fetch = fetch,
): Promise<Result> {
  if (env.makecrmSecret.length < 32 || !env.secret)
    return fail(
      503,
      "Os números para o MakeCRM não estão configurados: faltam MAKECRM_ADS_SECRET e ADS_SYNC_SECRET na Vercel.",
    );
  if (!given || !sameSecret(given, env.makecrmSecret))
    return fail(401, "Não autorizado.");
  const q = makecrmQuery(body);
  if (!q) return fail(400, "Pedido inválido.");

  if (q.action === "campaigns") {
    const found = await campaigns(env, fetchImpl, q, q.refs);
    return found.ok
      ? { status: 200, body: { campaigns: found.data } }
      : fail(found.status, found.error);
  }
  if (q.action === "ads") return ads(env, fetchImpl, q);
  return audience(env, fetchImpl, q);
}

function campaigns(
  env: MakecrmAdsEnv,
  fetchImpl: Fetch,
  q: MakecrmQuery,
  legacy: string[],
) {
  return callRpc<Json[]>(env, fetchImpl, null, "makecrm_ads_campaigns", {
    p_secret: env.secret,
    p_crm_company: q.crmCompany,
    p_legacy: legacy,
    p_since: q.since,
    p_until: q.until,
  });
}

type MetaAccess = {
  campaign: string;
  legacy_id: string | null;
  account_id: string;
  campaign_ids: string[];
  token_cipher: string | null;
  expires_at: string | null;
};

/** The Meta accounts of the campaigns asked for, each with its token opened. */
async function metaAccess(
  env: MakecrmAdsEnv,
  fetchImpl: Fetch,
  q: MakecrmQuery,
) {
  const found = await callRpc<MetaAccess[]>(
    env,
    fetchImpl,
    null,
    "makecrm_ads_meta_access",
    {
      p_secret: env.secret,
      p_crm_company: q.crmCompany,
      p_refs: q.refs,
      p_since: q.since,
      p_until: q.until,
    },
  );
  if (!found.ok) return found;
  const warnings: string[] = [];
  const accounts: (MetaAccess & { token: string })[] = [];
  for (const access of found.data ?? []) {
    if (!META_ID.test(access.account_id)) continue;
    if (!access.token_cipher) {
      warnings.push(
        `Conta do Meta ${access.account_id}: sem conexão do Facebook no MAVI (Campanhas › Conexões).`,
      );
      continue;
    }
    if (!env.tokenKey) {
      warnings.push(
        "O MAVI não abre os tokens do Meta: falta GOOGLE_TOKEN_KEY_ADS na Vercel.",
      );
      break;
    }
    try {
      accounts.push({
        ...access,
        token: unseal(env.tokenKey, access.token_cipher),
      });
    } catch {
      warnings.push(
        `Conta do Meta ${access.account_id}: o token guardado não abre.`,
      );
    }
  }
  return { ok: true as const, accounts, warnings };
}

const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Os anúncios do MakeCRM (metaCampaignAds): os mesmos campos da Meta. */
async function ads(
  env: MakecrmAdsEnv,
  fetchImpl: Fetch,
  q: MakecrmQuery,
): Promise<Result> {
  const ref = q.refs[0];
  const found = await campaigns(env, fetchImpl, q, UUID.test(ref) ? [] : [ref]);
  if (!found.ok) return fail(found.status, found.error);
  const campaign =
    (found.data ?? []).find((c) => c.id === ref || c.legacy_id === ref) ?? null;
  if (!campaign || campaign.platform !== "meta")
    return { status: 200, body: { campaign, ads: [], warnings: [] } };

  const access = await metaAccess(env, fetchImpl, q);
  if (!access.ok) return fail(access.status, access.error);
  const warnings = [...access.warnings];
  const list: Json[] = [];
  for (const account of access.accounts) {
    for (const id of account.campaign_ids) {
      if (!META_ID.test(id)) continue;
      try {
        list.push(...(await campaignAds(env, fetchImpl, account.token, id, q)));
      } catch (e) {
        warnings.push(`Campanha ${id} do Meta: ${message(e)}`);
      }
    }
  }
  return { status: 200, body: { campaign, ads: list, warnings } };
}

async function campaignAds(
  env: MakecrmAdsEnv,
  fetchImpl: Fetch,
  token: string,
  campaignId: string,
  q: MakecrmQuery,
) {
  const insights =
    `insights.time_range({"since":"${q.since}","until":"${q.until}"})` +
    "{impressions,reach,frequency,inline_link_clicks,spend,actions,cost_per_action_type}";
  const rows = await graphAll<Json>(
    env,
    fetchImpl,
    token,
    `/${campaignId}/ads`,
    {
      fields: `id,name,status,adset{id,name},creative,preview_shareable_link,${insights}`,
      limit: "100",
    },
    ADS_PAGES,
  );

  // The creatives, 50 per call (?ids=).
  const ids = [
    ...new Set(
      rows
        .map((ad) => ad.creative?.id)
        .filter((id) => META_ID.test(String(id ?? ""))),
    ),
  ] as string[];
  const creatives: Record<string, Json> = {};
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const page = await graph<Record<string, Json>>(
        env,
        fetchImpl,
        token,
        "/",
        {
          ids: ids.slice(i, i + 50).join(","),
          fields: "name,image_url,thumbnail_url,body,object_story_spec",
        },
      );
      for (const [id, creative] of Object.entries(page ?? {}))
        if (creative?.id) creatives[id] = creative;
    } catch {
      // As in the MakeCRM: a creative that doesn't come stays without details.
    }
  }

  return rows.map((ad) => ({
    id: ad.id,
    name: ad.name,
    status: ad.status,
    adset_id: ad.adset?.id,
    adset_name: ad.adset?.name,
    preview_url: ad.preview_shareable_link,
    performance: ad.insights?.data?.[0] ?? null,
    creative_details: (ad.creative?.id && creatives[ad.creative.id]) || {
      id: ad.creative?.id,
      _msg: "Aviso: Detalhes do criativo não indexados nesta execução do lote",
    },
  }));
}

/** O público do MakeCRM (metaAudience), só das campanhas pedidas. */
async function audience(
  env: MakecrmAdsEnv,
  fetchImpl: Fetch,
  q: MakecrmQuery,
): Promise<Result> {
  const access = await metaAccess(env, fetchImpl, q);
  if (!access.ok) return fail(access.status, access.error);
  const warnings = [...access.warnings];

  // One read per account, for all its campaigns asked for.
  const byAccount = new Map<
    string,
    { token: string; campaigns: Set<string> }
  >();
  for (const a of access.accounts) {
    const entry = byAccount.get(a.account_id) ?? {
      token: a.token,
      campaigns: new Set<string>(),
    };
    a.campaign_ids
      .filter((id) => META_ID.test(id))
      .forEach((id) => entry.campaigns.add(id));
    byAccount.set(a.account_id, entry);
  }

  const rows: Json[] = [];
  for (const [accountId, { token, campaigns: ids }] of byAccount) {
    if (ids.size === 0) continue;
    const params = {
      level: "campaign",
      fields: "campaign_id,spend,impressions,inline_link_clicks,actions",
      time_range: JSON.stringify({ since: q.since, until: q.until }),
      filtering: JSON.stringify([
        { field: "campaign.id", operator: "IN", value: [...ids] },
      ]),
      limit: "500",
    };
    const path = `/act_${accountId}/insights`;
    try {
      const [ageGender, region] = await Promise.all([
        graphAll<Json>(
          env,
          fetchImpl,
          token,
          path,
          { ...params, breakdowns: "age,gender" },
          AUDIENCE_PAGES,
        ),
        graphAll<Json>(
          env,
          fetchImpl,
          token,
          path,
          { ...params, breakdowns: "region" },
          AUDIENCE_PAGES,
        ),
      ]);
      for (const [kind, list] of [
        ["age_gender", ageGender],
        ["region", region],
      ] as const) {
        for (const row of list) {
          if (!ids.has(String(row.campaign_id))) continue;
          rows.push({
            kind,
            campaign_id: String(row.campaign_id),
            ...(kind === "age_gender"
              ? { age: row.age, gender: row.gender }
              : { region: row.region }),
            spend: Number(row.spend) || 0,
            impressions: Number(row.impressions) || 0,
            clicks: Number(row.inline_link_clicks) || 0,
            actions: (Array.isArray(row.actions) ? row.actions : []).map(
              (a: Json) => ({
                action_type: a.action_type,
                value: Number(a.value) || 0,
              }),
            ),
          });
        }
      }
    } catch (e) {
      warnings.push(
        `Conta ${accountId}: a Meta não devolveu o público (${message(e)}).`,
      );
    }
  }
  return { status: 200, body: { rows, warnings } };
}

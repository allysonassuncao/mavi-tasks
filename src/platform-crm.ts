/**
 * Campanhas › Plataforma × MakeCRM: as oportunidades e os ganhos que o CRM
 * do cliente atribui a cada campanha, conjunto e anúncio pela UTM — a mesma
 * conta da página Anúncios do MakeCRM (api/_crm.ts, ação "utm"; no CRM,
 * sql/mavi_utm_deals.sql):
 *  - por nome exato (maiúsculas e espaços contam): utm_campaign = campanha,
 *    utm_term = conjunto (no Google, grupo), utm_content = anúncio;
 *  - o período é a data de criação da oportunidade no CRM;
 *  - campanha e conjunto contam oportunidades únicas, anúncio conta linhas
 *    de UTM; ganhos contam registros de ganho, receita é o valor fechado.
 */
import { DEMO_ADS, DEMO_ADSETS, DEMO_CAMPAIGNS } from "./campaign-platform";

export type CrmUtm =
  | { linked: false }
  | {
      linked: true;
      campaigns: [string, number, number, number, number][];
      adsets: [string, string, number, number, number, number][];
      ads: [string, string, string, number, number, number, number][];
    };
export type CrmCounts = {
  leads: number;
  wons: number;
  won_deals: number;
  revenue: number;
};
export type CrmLevel = "campaign" | "adset" | "ad";
/** What a platform row is in UTMs. */
export type CrmKey = { campaign: string; term?: string; content?: string };
export type CrmIndex = Record<CrmLevel, Map<string, CrmCounts>>;

const SEP = "\u0000";
const keyOf = (level: CrmLevel, k: CrmKey) =>
  level === "campaign"
    ? k.campaign
    : level === "adset"
      ? [k.campaign, k.term ?? ""].join(SEP)
      : [k.campaign, k.term ?? "", k.content ?? ""].join(SEP);
const keyBack = (level: CrmLevel, s: string): CrmKey => {
  const [campaign, term, content] = s.split(SEP);
  return level === "campaign"
    ? { campaign }
    : level === "adset"
      ? { campaign, term }
      : { campaign, term, content };
};

export function crmIndex(d: CrmUtm): CrmIndex | null {
  if (!d.linked) return null;
  const counts = (n: number[]): CrmCounts => ({
    leads: n[0],
    wons: n[1],
    won_deals: n[2],
    revenue: n[3],
  });
  return {
    campaign: new Map(d.campaigns.map(([c, ...n]) => [c, counts(n)])),
    adset: new Map(d.adsets.map(([c, t, ...n]) => [[c, t].join(SEP), counts(n)])),
    ad: new Map(d.ads.map(([c, t, a, ...n]) => [[c, t, a].join(SEP), counts(n)])),
  };
}

const ZERO: CrmCounts = { leads: 0, wons: 0, won_deals: 0, revenue: 0 };
/** A row's numbers (zero when the CRM has nothing with its names). */
export const crmCounts = (idx: CrmIndex, level: CrmLevel, k: CrmKey) =>
  idx[level].get(keyOf(level, k)) ?? ZERO;

/** The platform's metrics that the CRM columns read. */
export const crmMetrics = (c: CrmCounts) => ({
  crm_leads: c.leads,
  crm_wons: c.wons,
  crm_won_deals: c.won_deals,
  crm_revenue: c.revenue,
});
export const CRM_METRICS = ["crm_leads", "crm_wons", "crm_won_deals", "crm_revenue"];
export const isCrmColumn = (id: string) => id.startsWith("crm_");

/** The rows with the CRM's numbers in their metrics, and the footer's sums. */
export function withCrm<R extends { metrics: Record<string, number | null> | null }>(
  rows: R[],
  idx: CrmIndex,
  level: CrmLevel,
  key: (r: R) => CrmKey | null,
): { rows: R[]; totals: Record<string, number> } {
  const totals: Record<string, number> = Object.fromEntries(CRM_METRICS.map((m) => [m, 0]));
  const out = rows.map((r) => {
    const k = key(r);
    if (!k) return r;
    const m = crmMetrics(crmCounts(idx, level, k));
    for (const [id, v] of Object.entries(m)) totals[id] += v;
    return { ...r, metrics: { ...(r.metrics ?? {}), ...m } };
  });
  return { rows: out, totals };
}

/**
 * The CRM's UTMs that no row here answers for — as the CRM's Anúncios page
 * lists them in yellow. Conjuntos e anúncios: only inside the campaigns
 * shown (and the ad sets, when the ads were filtered by ad set).
 */
export function crmUnmatched(
  idx: CrmIndex,
  level: CrmLevel,
  shown: CrmKey[],
  scope: { campaigns?: Set<string>; terms?: Set<string> } = {},
): { key: CrmKey; counts: CrmCounts }[] {
  const seen = new Set(shown.map((k) => keyOf(level, k)));
  return [...idx[level]]
    .filter(([s]) => !seen.has(s))
    .map(([s, counts]) => ({ key: keyBack(level, s), counts }))
    .filter(
      ({ key, counts }) =>
        (counts.leads > 0 || counts.wons > 0) &&
        (!scope.campaigns || scope.campaigns.has(key.campaign)) &&
        (!scope.terms || scope.terms.has(key.term ?? "")),
    )
    .sort((a, b) => b.counts.leads - a.counts.leads || b.counts.wons - a.counts.wons);
}

/** How a UTM reads in the list of the unmatched ones. */
export function crmKeyLabel(level: CrmLevel, k: CrmKey) {
  const v = (s: string | undefined) => (s ? s : "(vazio)");
  return level === "campaign"
    ? v(k.campaign)
    : level === "adset"
      ? `${v(k.campaign)} › ${v(k.term)}`
      : `${v(k.campaign)} › ${v(k.term)} › ${v(k.content)}`;
}

/**
 * The CRM's pipeline filtered by the row's UTMs and the period, as the CRM's
 * Anúncios page opens it (createdFrom/createdTo: the Brasília day).
 */
export function crmPipelinePath(k: CrmKey, since: string, until: string) {
  const q = new URLSearchParams();
  q.set("utmCampaign", k.campaign);
  if (k.content) q.set("utmContent", k.content);
  if (k.term) q.set("utmTerm", k.term);
  if (since) q.set("createdFrom", new Date(`${since}T00:00:00.000-03:00`).toISOString());
  if (until) q.set("createdTo", new Date(`${until}T23:59:59.999-03:00`).toISOString());
  return `/pipeline-v2?${q.toString()}`;
}

/** What the Plataforma needs to show and open the CRM of the client. */
export type PlatformCrm = {
  /** The client is linked to a company of the MakeCRM. */
  linked: boolean;
  clientName: string;
  load: (since: string, until: string, fresh: boolean) => Promise<CrmUtm>;
  /** Opens the CRM, logged in, at this path (crmPipelinePath). */
  open: (path: string) => void;
};

/**
 * The demonstration's CRM: numbers for the demonstration's Meta account
 * (src/campaign-platform.ts), plus UTMs that match nothing there.
 */
export function demoCrmUtm(): CrmUtm {
  const campaigns: [string, number, number, number, number][] = DEMO_CAMPAIGNS.map((c, i) => [
    c.name,
    Math.max(0, 18 - i * 5),
    Math.max(0, 4 - i),
    Math.max(0, 3 - i),
    Math.max(0, 4 - i) * 2400,
  ]);
  const adsets: [string, string, number, number, number, number][] = [];
  const ads: [string, string, string, number, number, number, number][] = [];
  DEMO_CAMPAIGNS.slice(0, 2).forEach((c, ci) =>
    DEMO_ADSETS.forEach((s, si) => {
      const leads = Math.max(0, 8 - ci * 3 - si * 3);
      const wons = si === 0 ? 2 - ci : 0;
      adsets.push([c.name, s, leads, wons, wons, wons * 2400]);
      DEMO_ADS.slice(0, 2).forEach((a, ai) =>
        ads.push([c.name, s, `${a} · ${s}`, Math.max(0, leads - ai * 2), ai ? 0 : wons, ai ? 0 : wons, ai ? 0 : wons * 2400]),
      );
    }),
  );
  campaigns.push(["Google Pesquisa · Marca", 7, 1, 1, 1800]);
  adsets.push([DEMO_CAMPAIGNS[0].name, "Aberto 25-54 (antigo)", 2, 0, 0, 0]);
  ads.push([DEMO_CAMPAIGNS[0].name, DEMO_ADSETS[0], "Vídeo depoimento v2", 1, 0, 0, 0]);
  return { linked: true, campaigns, adsets, ads };
}

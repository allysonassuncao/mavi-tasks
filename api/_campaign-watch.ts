import { callRpc } from "./_drive.js";
import type { AiDeps } from "./_ai.js";
import { graph } from "./_ads.js";
import { crmUtmDeals } from "./_crm.js";
import { unseal } from "./_google.js";
import type { Search } from "./_ads-google-platform.js";
import {
  InsightsError,
  accountsOf,
  googleSearchFor,
  meteredFetch,
  newApiMeter,
  type ApiMeter,
  type CampaignInsightsEnv,
  type InsightMaterial,
} from "./_campaign-insights.js";

/**
 * Campanhas › Insights da MAVI, Fase 7 (migração 20270404150000_campaign_watch):
 * a leitura leve da vigia, uma por campanha por dia, sem a MAVI.
 *
 *  - Meta: os anúncios reprovados ou com problema das campanhas vinculadas
 *    (uma chamada por conta) e, com o CRM ligado, os nomes delas (outra).
 *  - Google: o status das campanhas (limitada pelo orçamento) e os anúncios
 *    reprovados (duas consultas por conta, no orçamento de operações da MAVI).
 *  - MakeCRM: as oportunidades por UTM dos 2 últimos dias e dos 7 antes, para
 *    ver se a plataforma registra conversões e nada chega ao CRM (quando antes
 *    chegava).
 *
 * O que acha vira insight de origem 'watch' (grupo "api"); o que deixou de
 * valer o banco resolve sozinho. Uma leitura incompleta não muda nada.
 */

type Row = Record<string, unknown>;
type Fetch = typeof fetch;

export type WatchClaim = {
  company_id: string;
  campaign_id: string;
  day: string;
  campaign: { id: string; name: string; platform: "meta" | "google" };
  money_basis: "net" | "gross";
  links: InsightMaterial["links"];
  meta_tokens: InsightMaterial["meta_tokens"];
  google_token: InsightMaterial["google_token"];
  crm_company_id: string | null;
  yesterday: string;
  d2: { days: number; conversions: number; spend: number };
  cycle: { spend: number; conversions: number; goal_cpa: number | null };
};
export type WatchFound = {
  disapproved: { name: string; group: string; reason: string }[];
  /** Google: campanhas limitadas pelo orçamento. */
  limited: string[];
  /** Oportunidades no CRM com o nome das campanhas: 2 últimos dias e os 7 antes (nulo: sem CRM). */
  crm: { recent: number; before: number } | null;
};
export type WatchItem = {
  kind: "problem" | "tracking" | "opportunity";
  priority: "high" | "medium";
  title: string;
  body: string;
  action: string;
  evidence: { label: string; value: number; unit: string; window: string; entity: string; name: string; metric: string }[];
  fingerprint: string;
};

const GOOGLE_OPS = 2;
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const count = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** O que a leitura achou vira os avisos (as regras, em linguagem simples). */
export function watchItems(c: WatchClaim, f: WatchFound): WatchItem[] {
  const name = c.campaign.name;
  const ev = (label: string, value: number, unit: string, window: string, metric: string) => ({
    label,
    value: Math.round(value * 100) / 100,
    unit,
    window,
    entity: "total",
    name,
    metric,
  });
  const out: WatchItem[] = [];
  if (f.disapproved.length) {
    const n = f.disapproved.length;
    const list = f.disapproved
      .slice(0, 4)
      .map((a) => `"${a.name}"${a.group ? ` (em ${a.group})` : ""}${a.reason ? `: ${a.reason}` : ""}`)
      .join("; ");
    out.push({
      kind: "problem",
      priority: "high",
      title: n === 1 ? "Um anúncio foi reprovado pela plataforma" : `${n} anúncios foram reprovados pela plataforma`,
      body: `Anúncio reprovado não entrega, e a verba vai para os outros (ou fica parada). ${list}${n > 4 ? ` e mais ${n - 4}` : ""}.`,
      action:
        "Abra o anúncio no Gerenciador e leia o motivo da reprovação\nAjuste o texto ou a imagem e envie para nova revisão\nSe for engano da plataforma, peça uma nova análise",
      evidence: [ev("Anúncios reprovados", n, "count", "now", "disapproved_ads")],
      fingerprint: "problem#total#vigia-api-reprovados",
    });
  }
  const cpa = c.cycle.conversions > 0 ? c.cycle.spend / c.cycle.conversions : null;
  const goal = c.cycle.goal_cpa ? Number(c.cycle.goal_cpa) : null;
  if (f.limited.length && cpa !== null && goal && cpa <= goal)
    out.push({
      kind: "opportunity",
      priority: "medium",
      title: "O Google está segurando a campanha pela verba",
      body: `O Google avisa que ${f.limited.map((x) => `"${x}"`).join(", ")} poderia aparecer mais vezes, mas está limitada pelo orçamento diário. Como cada resultado do ciclo custa ${brl(cpa)}, dentro da meta de ${brl(goal)}, há espaço para crescer.`,
      action:
        "Confira o saldo de mídia do cliente\nSe houver saldo, suba o orçamento diário em até 20%\nDepois de 3 dias, veja se o custo por resultado continua dentro da meta",
      evidence: [
        ev("Custo por resultado", cpa, "money", "cycle", "cpa"),
        ev("Custo por resultado da meta", goal, "money", "cycle", "goal_cpa"),
      ],
      fingerprint: "opportunity#total#vigia-api-verba-limitada",
    });
  if (f.crm && f.crm.recent === 0 && f.crm.before > 0 && c.d2.days === 2 && c.d2.conversions >= 4)
    out.push({
      kind: "tracking",
      priority: "high",
      title: "A plataforma registrou leads nos últimos 2 dias, mas nenhum chegou ao CRM",
      body: `Nos últimos 2 dias a plataforma contou ${count(c.d2.conversions)} conversões e nenhuma oportunidade com o nome da campanha entrou no MakeCRM — na semana anterior chegaram ${count(f.crm.before)}. O mais comum é a integração do formulário ou as UTMs terem parado de funcionar.`,
      action:
        "Faça um cadastro de teste pelo anúncio e veja se ele chega ao CRM\nConfira se as UTMs dos anúncios mudaram nos últimos dias\nSe o teste não chegar, avise quem cuida da integração antes que mais leads se percam",
      evidence: [
        ev("Conversões na plataforma", c.d2.conversions, "count", "d2", "results"),
        ev("Oportunidades no CRM", 0, "count", "d2", "crm_opportunities"),
        ev("Oportunidades no CRM", f.crm.before, "count", "prev7", "crm_opportunities"),
      ],
      fingerprint: "tracking#total#vigia-api-sem-lead-crm",
    });
  return out;
}

async function workerRpc<T>(env: CampaignInsightsEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
  if (!r.ok) throw new InsightsError(r.status, r.error);
  return r.data;
}

/** A leitura de uma campanha: o que a vigia achou (lança se não deu para ler tudo). */
export async function readWatch(env: CampaignInsightsEnv, fetchImpl: Fetch, c: WatchClaim): Promise<WatchFound> {
  const accounts = accountsOf(c.links);
  const found: WatchFound = { disapproved: [], limited: [], crm: null };
  const names: string[] = [];
  const wantNames = !!c.crm_company_id && c.d2.conversions >= 4;
  if (c.campaign.platform === "meta") {
    if (!env.ads.tokenKey) throw new InsightsError(503, "Falta GOOGLE_TOKEN_KEY_ADS no servidor.", true);
    for (const [account, { campaigns }] of accounts) {
      const stored = c.meta_tokens?.[account];
      if (!stored) throw new InsightsError(409, `A conta ${account} não tem conexão do Facebook.`, true);
      if (!campaigns.length) continue;
      const token = unseal(env.ads.tokenKey, stored.token_cipher);
      const ads = await graph<{ data?: Row[] }>(env.ads, fetchImpl, token, `/act_${account}/ads`, {
        fields: "name,effective_status,adset{name},ad_review_feedback",
        filtering: JSON.stringify([
          { field: "campaign.id", operator: "IN", value: campaigns },
          { field: "effective_status", operator: "IN", value: ["DISAPPROVED", "WITH_ISSUES"] },
        ]),
        limit: "50",
      });
      for (const a of ads.data ?? []) {
        const feedback = (a.ad_review_feedback as { global?: Record<string, string> } | undefined)?.global;
        found.disapproved.push({
          name: String(a.name ?? "Anúncio"),
          group: String((a.adset as { name?: string } | undefined)?.name ?? ""),
          reason: feedback ? Object.values(feedback)[0]?.slice(0, 160) ?? "" : "",
        });
      }
      if (wantNames) {
        const byId = await graph<Record<string, { name?: string }>>(env.ads, fetchImpl, token, "/", {
          ids: campaigns.join(","),
          fields: "name",
        });
        for (const id of campaigns) if (byId[id]?.name) names.push(byId[id].name!);
      }
    }
  } else {
    if (!c.google_token) throw new InsightsError(409, "Conecte o Google Ads da agência em Campanhas.", true);
    const searchFor = await googleSearchFor(env.ads, fetchImpl, c.google_token.refresh_token_cipher);
    for (const [account, { manager, campaigns }] of accounts) {
      if (!campaigns.length) continue;
      const search: Search = searchFor(account, manager);
      const ids = campaigns.join(",");
      const [status, ads] = await Promise.all([
        search(
          `SELECT campaign.id, campaign.name, campaign.primary_status, campaign.primary_status_reasons FROM campaign WHERE campaign.id IN (${ids})`,
        ),
        search(
          `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group.name, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE campaign.id IN (${ids}) AND ad_group_ad.status = 'ENABLED' AND ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'`,
        ),
      ]);
      for (const r of status) {
        const name = String(r.campaign?.name ?? "");
        if (name) names.push(name);
        const reasons = (r.campaign?.primaryStatusReasons ?? []) as string[];
        if (reasons.includes("BUDGET_CONSTRAINED")) found.limited.push(name || "a campanha");
      }
      for (const r of ads)
        found.disapproved.push({
          name: String(r.adGroupAd?.ad?.name || `Anúncio ${r.adGroupAd?.ad?.id ?? ""}`).trim(),
          group: String(r.adGroup?.name ?? ""),
          reason: "",
        });
    }
  }
  if (wantNames && names.length) {
    const y = c.yesterday;
    const [recent, before] = await Promise.all([
      crmUtmDeals(env.crm, fetchImpl, c.crm_company_id!, addDays(y, -1), y),
      crmUtmDeals(env.crm, fetchImpl, c.crm_company_id!, addDays(y, -8), addDays(y, -2)),
    ]);
    if (!recent.ok) throw new InsightsError(recent.status, recent.error);
    if (!before.ok) throw new InsightsError(before.status, before.error);
    const sum = (rows: [string, number, number, number, number][]) =>
      rows.filter(([n]) => names.includes(n)).reduce((s, r) => s + r[1], 0);
    found.crm = { recent: sum(recent.data.campaigns), before: sum(before.data.campaigns) };
  }
  return found;
}

/** As leituras da vigia que estão na fila (rápidas; nunca travam as análises). */
export async function watchPlatforms(
  env: CampaignInsightsEnv,
  deps: AiDeps,
  deadline: number,
  read: typeof readWatch = readWatch,
): Promise<{ done: number; failed: number; found: number }> {
  const now = deps.now ?? Date.now;
  const stats = { done: 0, failed: 0, found: 0 };
  while (now() < deadline) {
    const claimed = await workerRpc<WatchClaim[]>(env, deps, "ai_campaign_watch_claim", { p_limit: 5 });
    if (!claimed.length) break;
    for (const c of claimed) {
      const meter: ApiMeter = newApiMeter();
      const google = c.campaign.platform === "google";
      const reserved = google ? Math.max(accountsOf(c.links).size, 1) * GOOGLE_OPS : 0;
      const where = { p_company: c.company_id, p_campaign: c.campaign_id, p_day: c.day };
      try {
        if (google) {
          const b = await workerRpc<{ ok: boolean; retry_at?: string }>(env, deps, "ai_campaign_insight_google_ops", {
            p_company: c.company_id,
            p_ops: reserved,
            p_check: true,
          });
          if (!b.ok) {
            await workerRpc(env, deps, "ai_campaign_watch_fail", {
              ...where,
              p_error: "Orçamento de operações do Google da MAVI atingido: a vigia espera.",
              p_until: b.retry_at ?? new Date(now() + 3600_000).toISOString(),
            });
            continue;
          }
        }
        const found = await read(env, meteredFetch(deps.fetch, meter), c);
        const items = watchItems(c, found);
        await workerRpc(env, deps, "ai_campaign_watch_store", { ...where, p_items: items, p_note: "" });
        stats.done++;
        stats.found += items.length;
      } catch (e) {
        stats.failed++;
        const err = e as InsightsError;
        const throttle = meter.throttle;
        if (throttle)
          for (const account of throttle.scope === "platform" ? ["*"] : [...accountsOf(c.links).keys()])
            await workerRpc(env, deps, "ai_campaign_insight_cooldown", {
              p_platform: throttle.platform,
              p_account: account,
              p_until: new Date(now() + throttle.minutes * 60_000).toISOString(),
              p_reason: throttle.reason,
            }).catch(() => {});
        // Conexão que não abre: não adianta repetir hoje (nada muda nos avisos).
        if (!throttle && err instanceof InsightsError && err.final)
          await workerRpc(env, deps, "ai_campaign_watch_store", { ...where, p_items: null, p_note: err.message }).catch(
            () => {},
          );
        else
          await workerRpc(env, deps, "ai_campaign_watch_fail", {
            ...where,
            p_error: String(err.message ?? "Erro na vigia.").slice(0, 900),
            p_until: throttle ? new Date(now() + throttle.minutes * 60_000).toISOString() : null,
          }).catch(() => {});
      } finally {
        if (google && meter.google !== reserved)
          await workerRpc(env, deps, "ai_campaign_insight_google_ops", {
            p_company: c.company_id,
            p_ops: meter.google - reserved,
            p_check: false,
          }).catch(() => {});
      }
    }
  }
  return stats;
}

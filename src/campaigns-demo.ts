import type { Snapshot } from "./types";
import {
  AdsApiError,
  addDays,
  currentCycle,
  cycleAlert,
  monthlyEnd,
  type AdCampaign,
  type AdCampaignEvent,
  type AdCycle,
  type AdCycleLink,
  type AdPlatform,
  type AdsBackend,
  type PlatformAccount,
  type PlatformCampaign,
  type CampaignData,
  type CampaignsBackend,
  type CycleInput,
} from "./campaigns";
import { dateKey } from "./domain";
import {
  dateRange,
  type CampaignMetrics,
  type CycleSnapshot,
  type DailyMetric,
  type MetricsBackend,
  type SyncRun,
} from "./campaign-metrics";

/**
 * The campaigns of the demonstration, in memory only: reloading discards
 * changes. Applies the same rules as the database functions (overlapping
 * periods, inherited M, versions, manual current cycle). Only administrators
 * reach the page, as in the database.
 */
export function demoCampaigns(
  data: () => Snapshot,
  user: string,
): CampaignsBackend {
  const store = demoStore(data());
  const now = () => new Date().toISOString();
  const campaignOf = (id: string) => {
    const a = store.campaigns.find((c) => c.id === id);
    if (!a) throw Error("Sem permissão");
    return a;
  };
  const log = (
    a: AdCampaign,
    cycle: string | null,
    action: string,
    detail: Record<string, unknown>,
  ) =>
    store.events.unshift({
      id: ++store.seq,
      campaign_id: a.id,
      cycle_id: cycle,
      actor_id: user,
      action,
      detail,
      created_at: now(),
    });
  const bump = (a: AdCampaign) => {
    a.version++;
    a.updated_at = now();
  };
  function checkCycle(a: AdCampaign, input: CycleInput, except?: string) {
    if (input.end_date < input.start_date)
      throw Error("O término precisa ser igual ou posterior ao início");
    const other = store.cycles.find(
      (y) =>
        y.campaign_id === a.id &&
        y.id !== except &&
        y.start_date <= input.end_date &&
        y.end_date >= input.start_date,
    );
    if (other)
      throw Error(
        `O período conflita com o ciclo de ${fmt(other.start_date)} a ${fmt(other.end_date)} desta campanha`,
      );
    // As in the database: a platform campaign belongs to one campaign.
    for (const l of input.links) {
      if (!l.campaign_id) continue;
      const taken = store.cycles.find(
        (y) =>
          y.campaign_id !== a.id &&
          y.links.some(
            (k) =>
              k.campaign_id === l.campaign_id &&
              normalized(a.platform, k.account_id) ===
                normalized(a.platform, l.account_id),
          ),
      );
      if (taken)
        throw Error(
          `A campanha ${l.campaign_name || l.campaign_id} da plataforma já está vinculada à campanha "${store.campaigns.find((c) => c.id === taken.campaign_id)?.name}"`,
        );
    }
  }
  const linksOf = (a: AdCampaign, links: AdCycleLink[]) =>
    links.map((l) => ({
      ...l,
      account_id: normalized(a.platform, l.account_id),
      manager_id:
        a.platform === "google" ? (l.manager_id ?? "").replace(/-/g, "") : "",
    }));
  const changes = (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    fields: string[],
  ) =>
    Object.fromEntries(
      fields
        .filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))
        .map((f) => [f, { from: before[f], to: after[f] }]),
    );
  const clone = (): CampaignData => ({
    campaigns: store.campaigns.map((c) => ({ ...c })),
    cycles: store.cycles.map((y) => ({
      ...y,
      landing_pages: [...y.landing_pages],
      links: y.links.map((l) => ({ ...l })),
    })),
  });

  return {
    ads: demoAds(),
    metrics: demoMetrics(store, () => user),
    // The same rules as ad_campaign_page: only active campaigns, or the new
    // ones never activated ("pending"), searched, filtered and paged.
    async page(_company, q) {
      const snapshot = clone();
      const today = dateKey();
      const fold = (t: string) =>
        t
          .normalize("NFD")
          .replace(/\p{Diacritic}/gu, "")
          .toLowerCase();
      const pending = (c: AdCampaign) =>
        c.status === "inactive" &&
        !store.events.some(
          (e) => e.campaign_id === c.id && e.action === "status",
        ) &&
        Date.now() - Date.parse(c.created_at) < 60 * 86_400_000;
      const rows = snapshot.campaigns
        .filter((c) => !c.archived)
        .map((c) => {
          const contract = data().contracts.find((k) => k.id === c.contract_id);
          return {
            campaign: c,
            client_name:
              data().clients.find((x) => x.id === contract?.client_id)?.name ??
              "",
            product_name:
              data().products.find((x) => x.id === contract?.product_id)
                ?.name ?? "",
            current: currentCycle(snapshot, c),
            alert: cycleAlert(snapshot, c, today),
          };
        })
        .sort(
          (a, b) =>
            fold(a.client_name).localeCompare(fold(b.client_name)) ||
            fold(a.campaign.name).localeCompare(fold(b.campaign.name)),
        );
      const scoped = rows.filter((r) =>
        q.scope === "pending"
          ? pending(r.campaign)
          : r.campaign.status === "active",
      );
      const term = fold(q.search.trim());
      const filtered = scoped.filter(
        (r) =>
          (!term ||
            fold(`${r.campaign.name} ${r.client_name}`).includes(term)) &&
          (!q.platform || r.campaign.platform === q.platform) &&
          (!q.attention || r.alert.kind !== "none"),
      );
      return {
        rows: filtered.slice(q.offset, q.offset + q.limit),
        total: filtered.length,
        all: scoped.length,
        attention: scoped.filter((r) => r.alert.kind !== "none").length,
        pending: rows.filter((r) => pending(r.campaign)).length,
      };
    },
    async campaign(_company, id) {
      const snapshot = clone();
      const campaigns = snapshot.campaigns.filter((c) => c.id === id);
      return {
        campaigns,
        cycles: snapshot.cycles.filter((y) => y.campaign_id === id),
      };
    },
    async events(_company, campaign) {
      return store.events
        .filter((e) => e.campaign_id === campaign)
        .map((e) => ({ ...e }));
    },
    async createCampaign(company, input) {
      const contract = data().contracts.find(
        (k) => k.id === input.contract_id && !k.archived,
      );
      if (!contract) throw Error("Produto contratado inválido");
      const a: AdCampaign = {
        id: crypto.randomUUID(),
        company_id: company,
        contract_id: contract.id,
        name: input.name.trim(),
        platform: input.platform,
        status: "inactive",
        current_cycle_id: null,
        briefing_url: input.briefing_url.trim(),
        media_plan_url: input.media_plan_url.trim(),
        notes: input.notes,
        archived: false,
        created_by: user,
        created_at: now(),
        updated_at: now(),
        version: 1,
      };
      store.campaigns.push(a);
      log(a, null, "created", { name: a.name, platform: a.platform });
      return a.id;
    },
    async updateCampaign(campaign, input) {
      const a = campaignOf(campaign.id);
      if (a.version !== campaign.version)
        throw Error(
          "A campanha foi alterada por outra pessoa. Recarregue e tente de novo.",
        );
      if (
        input.platform !== a.platform &&
        store.cycles.filter((y) => y.campaign_id === a.id).length > 1
      )
        throw Error(
          "A plataforma não muda depois do segundo ciclo: cadastre uma nova campanha",
        );
      const before = { ...a };
      Object.assign(a, {
        name: input.name.trim(),
        platform: input.platform,
        briefing_url: input.briefing_url.trim(),
        media_plan_url: input.media_plan_url.trim(),
        notes: input.notes,
      });
      bump(a);
      log(
        a,
        null,
        "updated",
        changes(before, { ...a }, [
          "name",
          "platform",
          "briefing_url",
          "media_plan_url",
          "notes",
        ]),
      );
    },
    async setStatus(campaign, status, reason) {
      const a = campaignOf(campaign.id);
      if (a.status === status)
        throw Error(
          `A campanha já está ${status === "active" ? "ativa" : "inativa"}`,
        );
      if (reason.trim().length < 3) throw Error("Informe o motivo");
      if (status === "active" && !a.current_cycle_id)
        throw Error("Defina o ciclo atual antes de ativar a campanha");
      const from = a.status;
      a.status = status;
      bump(a);
      log(a, a.current_cycle_id, "status", {
        from,
        to: status,
        reason: reason.trim(),
      });
    },
    async setCurrentCycle(campaign, cycle) {
      const a = campaignOf(campaign.id);
      if (!store.cycles.some((y) => y.id === cycle && y.campaign_id === a.id))
        throw Error("Ciclo inválido para esta campanha");
      if (a.current_cycle_id === cycle) return;
      const from = a.current_cycle_id;
      a.current_cycle_id = cycle;
      bump(a);
      log(a, cycle, "current_cycle", { from, to: cycle });
    },
    async createCycle(campaign, input, makeCurrent) {
      const a = campaignOf(campaign.id);
      checkCycle(a, input);
      const previous = store.cycles
        .filter((y) => y.campaign_id === a.id)
        .sort((x, y) => y.start_date.localeCompare(x.start_date))[0];
      const inherited = previous?.multiplier ?? 1;
      const y: AdCycle = {
        id: crypto.randomUUID(),
        company_id: a.company_id,
        campaign_id: a.id,
        competence_month: input.competence,
        start_date: input.start_date,
        end_date: input.end_date,
        objective: input.objective,
        goal_results: input.goal_results,
        budget: input.budget,
        multiplier: input.multiplier ?? inherited,
        destination: input.destination,
        landing_pages: input.landing_pages,
        niche: input.niche,
        created_by: user,
        created_at: now(),
        updated_at: now(),
        version: 1,
        links: linksOf(a, input.links),
      };
      store.cycles.push(y);
      log(a, y.id, "cycle_created", {
        start_date: y.start_date,
        end_date: y.end_date,
        objective: y.objective,
        goal_results: y.goal_results,
        budget: y.budget,
        multiplier: y.multiplier,
        links: y.links,
      });
      if (makeCurrent) {
        const from = a.current_cycle_id;
        a.current_cycle_id = y.id;
        bump(a);
        log(a, y.id, "current_cycle", { from, to: y.id });
      }
      return y.id;
    },
    async updateCycle(cycle, input) {
      const y = store.cycles.find((c) => c.id === cycle.id);
      if (!y) throw Error("Sem permissão");
      const a = campaignOf(y.campaign_id);
      if (y.version !== cycle.version)
        throw Error(
          "O ciclo foi alterado por outra pessoa. Recarregue e tente de novo.",
        );
      checkCycle(a, input, y.id);
      const before = { ...y, competence_month: y.competence_month };
      Object.assign(y, {
        competence_month: input.competence,
        start_date: input.start_date,
        end_date: input.end_date,
        objective: input.objective,
        goal_results: input.goal_results,
        budget: input.budget,
        multiplier: input.multiplier ?? y.multiplier,
        destination: input.destination,
        landing_pages: input.landing_pages,
        niche: input.niche,
        links: linksOf(a, input.links),
        updated_at: now(),
        version: y.version + 1,
      });
      const diff = changes(before, { ...y }, [
        "competence_month",
        "start_date",
        "end_date",
        "objective",
        "goal_results",
        "budget",
        "multiplier",
        "destination",
        "landing_pages",
        "niche",
        "links",
      ]);
      if (Object.keys(diff).length) log(a, y.id, "cycle_updated", diff);
    },
  };
}

const fmt = (date: string) => date.split("-").reverse().join("/");
/** Meta accounts without "act_", Google ones without dashes (as stored). */
const normalized = (platform: AdPlatform, account: string) =>
  platform === "meta"
    ? account.replace(/^act_/i, "")
    : platform === "google"
      ? account.replace(/-/g, "")
      : account;

/* ------------------------------------------------------------------ */
/* Platforms in the demonstration: made-up accounts and campaigns.      */

const DEMO_ACCOUNTS: Record<"meta" | "google", PlatformAccount[]> = {
  meta: [
    ["1234567890", "Norte Coffee · Make", "Ativa", true],
    ["2345678901", "Aurora Estética · Make", "Ativa", true],
    ["3456789012", "Conta antiga (livre)", "Desativada", false],
  ].map(([id, name, status, active]) => ({
    id: id as string,
    name: name as string,
    status: status as string,
    active: active as boolean,
    currency: "BRL",
    manager_id: "",
    manager_name: "",
    expires_at: new Date(Date.now() + 45 * 86_400_000).toISOString(),
    connected_by: "Allyson Assunção",
  })),
  google: [
    ["1234567890", "Norte Coffee Ads"],
    ["9876543210", "Aurora Estética Ads"],
  ].map(([id, name]) => ({
    id,
    name,
    status: "Ativa",
    active: true,
    currency: "BRL",
    manager_id: "5550001111",
    manager_name: "MCC Make Vendas",
  })),
};
const DEMO_CAMPAIGNS: Record<string, [string, string, boolean, string][]> = {
  "meta:1234567890": [
    [
      "23850001",
      "[MSG] Motion · Conversas WhatsApp",
      true,
      "OUTCOME_ENGAGEMENT",
    ],
    ["23850002", "[LEAD] Cadastro · Formulário", true, "OUTCOME_LEADS"],
    ["23850003", "[VENDA] Black Friday", false, "OUTCOME_SALES"],
    ["23850004", "[RMKT] Visitantes 30 dias", false, "OUTCOME_TRAFFIC"],
  ],
  "meta:2345678901": [
    ["23860001", "[LEAD] Avaliação gratuita", true, "OUTCOME_LEADS"],
    ["23860002", "[MSG] Agendamento", false, "OUTCOME_ENGAGEMENT"],
  ],
  "google:1234567890": [
    ["21000001", "Pesquisa · Marca", true, "SEARCH"],
    ["21000002", "Pesquisa · Cafés especiais", true, "SEARCH"],
    ["21000003", "PMax · Loja", false, "PERFORMANCE_MAX"],
  ],
  "google:9876543210": [["22000001", "Pesquisa · Estética", true, "SEARCH"]],
};

/** One set of connections for the whole demonstration session. */
const demoConnected = { meta: true, google: true };
function demoAds(): AdsBackend {
  const wait = () => new Promise((r) => setTimeout(r, 250));
  const need = (provider: "meta" | "google") => {
    if (!demoConnected[provider])
      throw new AdsApiError(
        provider === "meta"
          ? "Conecte o Facebook para buscar as contas."
          : "Conecte o Google Ads da agência.",
        "not_connected",
      );
  };
  return {
    async status() {
      return {
        meta: demoConnected.meta
          ? {
              configured: true,
              accounts: DEMO_ACCOUNTS.meta.length,
              people: ["Allyson Assunção"],
              expires_at: DEMO_ACCOUNTS.meta[0].expires_at,
            }
          : { configured: true },
        google: demoConnected.google
          ? {
              configured: true,
              email: "trafego@makevendas.demo",
              connected_at: new Date().toISOString(),
            }
          : { configured: true },
      };
    },
    async connect(_company, provider) {
      await wait();
      demoConnected[provider] = true;
      return null;
    },
    async disconnect(_company, provider) {
      demoConnected[provider] = false;
    },
    async accounts(_company, provider) {
      await wait();
      need(provider);
      return DEMO_ACCOUNTS[provider].map((a) => ({ ...a }));
    },
    async campaigns(_company, provider, account) {
      await wait();
      need(provider);
      const id = normalized(provider, account);
      if (!DEMO_ACCOUNTS[provider].some((a) => a.id === id))
        throw new AdsApiError(
          "Esta conta de anúncio não está conectada. Conecte com um usuário que tenha acesso a ela.",
          "not_connected",
        );
      return (DEMO_CAMPAIGNS[`${provider}:${id}`] ?? []).map(
        ([cid, name, active, kind]): PlatformCampaign => ({
          id: cid,
          name,
          status: active ? "Ativa" : "Pausada",
          active,
          kind,
        }),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Numbers in the demonstration: made up, but consistent with the cycle  */
/* (budget, M, goal), one snapshot a day and one "LIVE" divergence.      */

/** A repeatable 0..1 from a text (the same demo numbers every time). */
function noise(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}
function demoCycleMetrics(y: AdCycle, today: string) {
  const until = [y.end_date, addDays(today, -1)].sort()[0];
  const daily: DailyMetric[] = [];
  const snapshots: CycleSnapshot[] = [];
  if (y.start_date > until || !y.links.length) return { daily, snapshots };
  const days = dateRange(y.start_date, y.end_date).length;
  const perDay = y.budget / y.multiplier / days;
  const goalCost =
    y.goal_results > 0 ? y.budget / y.multiplier / y.goal_results : 20;
  const funnel = y.objective === "sale" || y.objective === "custom";
  const cumulative = {
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    conversions: 0,
    view_content: 0,
    add_to_cart: 0,
    initiate_checkout: 0,
  };
  for (const day of dateRange(y.start_date, until)) {
    const r = noise(`${y.id}:${day}`);
    const spend = Math.round(perDay * (0.8 + r * 0.5) * 100) / 100;
    const impressions = Math.round(spend * (32 + r * 20));
    const reach = Math.round(impressions * (0.55 + r * 0.15));
    const clicks = Math.round(impressions * (0.01 + r * 0.012));
    const conversions = Math.max(
      0,
      Math.round(spend / (goalCost * (0.35 + noise(`${day}:${y.id}`) * 0.9))),
    );
    const row: DailyMetric = {
      cycle_id: y.id,
      day,
      multiplier: y.multiplier,
      spend,
      impressions,
      reach,
      clicks,
      conversions,
      view_content: funnel ? Math.round(clicks * 0.6) : 0,
      add_to_cart: funnel ? Math.round(clicks * 0.12) : 0,
      initiate_checkout: funnel ? Math.round(clicks * 0.06) : 0,
      source: "meta",
    };
    daily.push(row);
    for (const k of Object.keys(cumulative) as (keyof typeof cumulative)[])
      cumulative[k] += row[k];
    snapshots.push({
      id: snapshots.length + 1,
      cycle_id: y.id,
      taken_on: addDays(day, 1),
      period_start: y.start_date,
      period_end: day,
      ...cumulative,
      spend: Math.round(cumulative.spend * 100) / 100,
      reach: Math.round(cumulative.reach * 0.72),
      goal_status:
        y.goal_results > 0 &&
        cumulative.conversions > 0 &&
        cumulative.spend / cumulative.conversions <= goalCost
          ? "good"
          : "bad",
      source: "meta",
      author_label: "Sincronização diária",
    });
  }
  // One day stored differently from what the snapshots say (the MASO's
  // red "LIVE" badge), to show it.
  if (daily.length > 3) daily[2] = { ...daily[2], spend: daily[2].spend + 5 };
  return { daily, snapshots };
}
function demoMetrics(store: Store, user: () => string): MetricsBackend {
  const runs: SyncRun[] = [];
  const build = (campaign: string): CampaignMetrics => {
    const today = dateKey();
    const cycles = store.cycles.filter((y) => y.campaign_id === campaign);
    const parts = cycles.map((y) => demoCycleMetrics(y, today));
    return {
      daily: parts
        .flatMap((p) => p.daily)
        .sort((a, b) => a.day.localeCompare(b.day)),
      snapshots: parts.flatMap((p) => p.snapshots),
      runs: runs.filter((r) => cycles.some((y) => y.id === r.cycle_id)),
    };
  };
  return {
    async load(_company, campaign) {
      return build(campaign);
    },
    async sync(_company, campaign) {
      await new Promise((r) => setTimeout(r, 400));
      void user;
      const cycles = store.cycles.filter(
        (y) => y.campaign_id === campaign && y.links.length,
      );
      for (const y of cycles)
        runs.unshift({
          cycle_id: y.id,
          trigger: "manual",
          status: "ok",
          message: "",
          days: Math.min(7, demoCycleMetrics(y, dateKey()).daily.length),
          created_at: new Date().toISOString(),
        });
      return { synced: cycles.length, errors: [] };
    },
  };
}

type Store = {
  campaigns: AdCampaign[];
  cycles: AdCycle[];
  events: AdCampaignEvent[];
  seq: number;
};
let shared: { company: string; store: Store } | null = null;
/** One store per company for the whole session (a remount keeps changes). */
function demoStore(data: Snapshot): Store {
  const company = data.companies[0]?.id ?? "";
  if (shared?.company === company) return shared.store;
  shared = { company, store: seed(data) };
  return shared.store;
}

/** Two Make Ads campaigns, one mid-cycle and one whose cycle ended. */
function seed(data: Snapshot): Store {
  const store: Store = { campaigns: [], cycles: [], events: [], seq: 0 };
  const contracts = data.contracts.filter(
    (k) =>
      !k.archived &&
      /make ads/i.test(
        data.products.find((p) => p.id === k.product_id)?.name ?? "",
      ),
  );
  const today = dateKey();
  const author = data.members[0]?.user_id ?? "";
  const stamp = new Date().toISOString();
  const plans = [
    {
      name: "Motion · Meta · Mensagem",
      platform: "meta" as const,
      start: addDays(today, -20),
      objective: "message" as const,
      goal: 100,
      budget: 3000,
      m: 2.5,
    },
    {
      name: "Captação · Google · Lead",
      platform: "google" as const,
      start: addDays(today, -35),
      objective: "lead" as const,
      goal: 60,
      budget: 2400,
      m: 2,
    },
  ];
  contracts.slice(0, plans.length).forEach((contract, i) => {
    const plan = plans[i];
    const campaignId = `demo-campaign-${i + 1}`;
    const cycleId = `demo-cycle-${i + 1}`;
    const cycle: AdCycle = {
      id: cycleId,
      company_id: contract.company_id,
      campaign_id: campaignId,
      competence_month: `${plan.start.slice(0, 7)}-01`,
      start_date: plan.start,
      end_date: monthlyEnd(plan.start),
      objective: plan.objective,
      goal_results: plan.goal,
      budget: plan.budget,
      multiplier: plan.m,
      destination: "external_page",
      landing_pages: [],
      niche: "",
      created_by: author,
      created_at: stamp,
      updated_at: stamp,
      version: 1,
      links: [
        {
          account_id: "1234567890",
          campaign_id: plan.platform === "meta" ? "23850001" : "21000001",
          manager_id: plan.platform === "google" ? "5550001111" : "",
          account_name:
            plan.platform === "meta"
              ? "Norte Coffee · Make"
              : "Norte Coffee Ads",
          campaign_name:
            plan.platform === "meta"
              ? "[MSG] Motion · Conversas WhatsApp"
              : "Pesquisa · Marca",
        },
      ],
    };
    store.cycles.push(cycle);
    store.campaigns.push({
      id: campaignId,
      company_id: contract.company_id,
      contract_id: contract.id,
      name: plan.name,
      platform: plan.platform,
      status: "active",
      current_cycle_id: cycleId,
      briefing_url: "",
      media_plan_url: "",
      notes: "",
      archived: false,
      created_by: author,
      created_at: stamp,
      updated_at: stamp,
      version: 1,
    });
  });
  return store;
}

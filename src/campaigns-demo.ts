import type { Snapshot } from "./types";
import {
  AdsApiError,
  addDays,
  currentCycle,
  cycleAlert,
  monthlyEnd,
  shortDate,
  type AdCampaign,
  type AdCampaignEvent,
  type AdCycle,
  type AdCycleLink,
  type AdPlatform,
  type AdsBackend,
  type PendingConnection,
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
  type MetricValues,
  type MetricsBackend,
  type SyncRun,
} from "./campaign-metrics";

/**
 * The campaigns of the demonstration, in memory only: reloading discards
 * changes. Applies the same rules as the database functions (overlapping
 * periods, inherited M, versions, manual current cycle). Only administrators
 * and managers reach the page, as in the database.
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
    ads: demoAds(store, data),
    metrics: demoMetrics(store, (campaign, cycle, action, detail) =>
      log(campaignOf(campaign), cycle, action, detail),
    ),
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
  // Two Facebook profiles, as in the agency: each reaches its own accounts.
  meta: (
    [
      ["1234567890", "Norte Coffee · Make", "Ativa", true, "fb-demo-1", 45],
      ["2345678901", "Aurora Estética · Make", "Ativa", true, "fb-demo-2", 5],
      [
        "3456789012",
        "Conta antiga (livre)",
        "Desativada",
        false,
        "fb-demo-1",
        45,
      ],
    ] as const
  ).map(([id, name, status, active, profile, days]) => ({
    id,
    name,
    status,
    active,
    currency: "BRL",
    manager_id: "",
    manager_name: "",
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    connected_by:
      profile === "fb-demo-1" ? "Allyson Assunção" : "Perfil Tráfego 02",
    connected_by_id: profile,
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
/** Connections waiting for the client's accounts to be chosen. */
const demoPending = new Map<string, PendingConnection>();
function demoAds(store: Store, data: () => Snapshot): AdsBackend {
  const clientOf = (campaignId: string) => {
    const c = store.campaigns.find((x) => x.id === campaignId);
    return (
      data().contracts.find((k) => k.id === c?.contract_id)?.client_id ?? null
    );
  };
  const clientName = (id: string | null | undefined) =>
    data().clients.find((c) => c.id === id)?.name ?? "";
  // Each demo account belongs to the client of a seeded campaign.
  for (const a of DEMO_ACCOUNTS.meta)
    if (a.client_id === undefined)
      a.client_id =
        a.id === "1234567890"
          ? clientOf("demo-campaign-1")
          : a.id === "2345678901"
            ? clientOf("demo-campaign-2")
            : null;
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
    async connect(_company, provider, context) {
      await wait();
      demoConnected[provider] = true;
      if (provider !== "meta") return { pending: "" };
      if (!context?.client)
        throw Error("Escolha o cliente da conexão do Facebook");
      // The client's profile sees its account (and, here, another client's).
      const id = crypto.randomUUID();
      const own = DEMO_ACCOUNTS.meta.find(
        (a) => a.client_id === context.client,
      );
      const other = DEMO_ACCOUNTS.meta.find(
        (a) => a.client_id && a.client_id !== context.client,
      );
      demoPending.set(id, {
        id,
        client_id: context.client,
        client: clientName(context.client),
        campaign_id: context.campaign ?? null,
        profile: `Perfil de ${clientName(context.client)}`,
        expires_at: new Date(Date.now() + 60 * 86_400_000).toISOString(),
        accounts: [
          own
            ? {
                account_id: own.id,
                name: own.name,
                currency: "BRL",
                account_status: 1,
                client_id: own.client_id ?? null,
                client: clientName(own.client_id),
              }
            : {
                account_id: "4567890123",
                name: `${clientName(context.client)} · Make`,
                currency: "BRL",
                account_status: 1,
                client_id: null,
                client: null,
              },
          ...(other && other.client_id !== own?.client_id
            ? [
                {
                  account_id: other.id,
                  name: other.name,
                  currency: "BRL",
                  account_status: 1,
                  client_id: other.client_id ?? null,
                  client: clientName(other.client_id),
                },
              ]
            : []),
        ],
      });
      return { pending: id };
    },
    async disconnect(_company, provider, target) {
      if (provider === "meta" && target?.client) {
        DEMO_ACCOUNTS.meta = DEMO_ACCOUNTS.meta.filter(
          (a) => a.client_id !== target.client,
        );
        return;
      }
      if (provider === "meta" && target?.profile) {
        DEMO_ACCOUNTS.meta = DEMO_ACCOUNTS.meta.filter(
          (a) => a.connected_by_id !== target.profile,
        );
        return;
      }
      demoConnected[provider] = false;
    },
    async pending(id) {
      const p = demoPending.get(id);
      if (!p) throw Error("A conexão expirou. Conecte de novo.");
      return structuredClone(p);
    },
    async confirm(id, accounts) {
      const p = demoPending.get(id);
      if (!p) throw Error("A conexão expirou. Conecte de novo.");
      if (!accounts.length) throw Error("Marque ao menos uma conta do cliente");
      for (const a of p.accounts.filter((x) =>
        accounts.includes(x.account_id),
      )) {
        if (a.client_id && a.client_id !== p.client_id)
          throw Error(`A conta ${a.account_id} já é do cliente ${a.client}`);
        const account: PlatformAccount = {
          id: a.account_id,
          name: a.name,
          status: "Ativa",
          active: true,
          currency: a.currency,
          manager_id: "",
          manager_name: "",
          expires_at: p.expires_at,
          connected_by: p.profile,
          connected_by_id: `fb-${p.client_id}`,
          client_id: p.client_id,
          client_name: p.client,
        };
        DEMO_ACCOUNTS.meta = [
          ...DEMO_ACCOUNTS.meta.filter((x) => x.id !== a.account_id),
          account,
        ];
      }
      demoPending.delete(id);
      return accounts.length;
    },
    async clients() {
      const ids = new Set<string>();
      for (const c of store.campaigns)
        if (c.platform === "meta" && c.status === "active") {
          const id = clientOf(c.id);
          if (id) ids.add(id);
        }
      for (const a of DEMO_ACCOUNTS.meta) if (a.client_id) ids.add(a.client_id);
      return [...ids]
        .map((id) => {
          const accounts = DEMO_ACCOUNTS.meta.filter((a) => a.client_id === id);
          return {
            client_id: id,
            client: clientName(id),
            campaigns: store.campaigns.filter(
              (c) =>
                c.platform === "meta" &&
                c.status === "active" &&
                clientOf(c.id) === id,
            ).length,
            expires_at:
              accounts
                .map((a) => a.expires_at ?? "")
                .filter(Boolean)
                .sort()[0] ?? null,
            accounts: accounts.map((a) => ({
              account_id: a.id,
              name: a.name,
              profile: a.connected_by ?? "",
              expires_at: a.expires_at ?? null,
              account_status: 1,
            })),
          };
        })
        .sort((a, b) => a.client.localeCompare(b.client, "pt-BR"));
    },
    async overview() {
      const today = dateKey();
      const due = store.cycles.filter(
        (y) =>
          y.links.length &&
          y.start_date < today &&
          y.end_date >= addDays(today, -8),
      );
      const name = (y: AdCycle) =>
        store.campaigns.find((c) => c.id === y.campaign_id)?.name ?? "";
      const failed = due.slice(0, 1);
      return {
        configured: true,
        job: {
          schedule: "*/20 9-12 * * *",
          active: true,
          last_run: {
            status: "succeeded",
            start_time: `${today}T09:40:00Z`,
            message: "1 row",
          },
        },
        today,
        last_schedule: `${today}T09:40:12Z`,
        due: due.length,
        synced: due.length - failed.length,
        failed: failed.length,
        pending: 0,
        up_to_date: due.length - failed.length,
        errors: failed.map((y) => ({
          campaign_id: y.campaign_id,
          campaign: name(y),
          message:
            "O acesso ao Facebook da conta 2345678901 expirou. Conecte de novo.",
        })),
        stale: failed.map((y) => ({
          campaign_id: y.campaign_id,
          campaign: name(y),
          last_day: addDays(today, -3),
        })),
      };
    },
    async accounts(_company, provider, client) {
      await wait();
      need(provider);
      return DEMO_ACCOUNTS[provider]
        .filter((a) => !client || a.client_id === client)
        .map((a) => ({ ...a }));
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
const METRIC_KEYS: [keyof MetricValues, string][] = [
  ["spend", "Investimento"],
  ["impressions", "Impressões"],
  ["reach", "Alcance"],
  ["clicks", "Cliques"],
  ["conversions", "Conversões"],
  ["view_content", "Visualização de produto"],
  ["add_to_cart", "Adição ao carrinho"],
  ["initiate_checkout", "Finalização de compra"],
];
/** The checks of mavi_private.ad_edit_metrics. */
function checkMetrics(values: MetricValues): MetricValues {
  const out = {} as MetricValues;
  for (const [k, label] of METRIC_KEYS) {
    const x = values[k];
    if (typeof x !== "number" || !Number.isFinite(x))
      throw Error(`Informe um número em ${label}`);
    if (x < 0) throw Error(`${label} não pode ser negativo`);
    if (x >= 1e12) throw Error(`${label} está grande demais`);
    const whole = k === "impressions" || k === "reach" || k === "clicks";
    if (whole && !Number.isInteger(x))
      throw Error(`${label} é um número inteiro`);
    out[k] = whole ? x : Math.round(x * 100) / 100;
  }
  return out;
}
function changes(before: object, after: object) {
  const b = before as Record<string, unknown>,
    a = after as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(a)
      .filter((k) => b[k] !== a[k])
      .map((k) => [k, { from: b[k], to: a[k] }]),
  );
}
function demoMetrics(
  store: Store,
  log: (
    campaign: string,
    cycle: string,
    action: string,
    detail: Record<string, unknown>,
  ) => void,
): MetricsBackend {
  const runs: SyncRun[] = [];
  const build = (campaign: string): CampaignMetrics => {
    const today = dateKey();
    const cycles = store.cycles.filter((y) => y.campaign_id === campaign);
    const parts = cycles.map((y) => demoCycleMetrics(y, today));
    return {
      daily: parts
        .flatMap((p) => p.daily)
        .map((r) => ({ ...r, ...store.edits.get(`d:${r.cycle_id}:${r.day}`) }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      snapshots: parts
        .flatMap((p) => p.snapshots)
        .map((x) => ({ ...x, ...store.edits.get(`s:${x.cycle_id}:${x.id}`) })),
      runs: runs.filter((r) => cycles.some((y) => y.id === r.cycle_id)),
    };
  };
  const cycleOf = (id: string) => {
    const y = store.cycles.find((c) => c.id === id);
    if (!y) throw Error("Sem permissão");
    return y;
  };
  return {
    async load(_company, campaign) {
      return build(campaign);
    },
    async updateDaily(row, values) {
      const y = cycleOf(row.cycle_id);
      const m = checkMetrics(values);
      if (!(values.multiplier > 0 && values.multiplier <= 100))
        throw Error("O M deve ser maior que 0 e no máximo 100");
      const after = {
        multiplier: Math.round(values.multiplier * 1000) / 1000,
        ...m,
      };
      const diff = changes(row, after);
      if (!Object.keys(diff).length) return;
      store.edits.set(`d:${row.cycle_id}:${row.day}`, {
        ...after,
        source: "manual",
      });
      log(y.campaign_id, y.id, "daily_edited", { day: row.day, changes: diff });
    },
    async updateSnapshot(snapshot, values) {
      const y = cycleOf(snapshot.cycle_id);
      const m = checkMetrics(values);
      const last = [y.end_date, snapshot.period_end].sort()[1];
      if (
        !values.period_end ||
        values.period_end < snapshot.period_start ||
        values.period_end > last
      )
        throw Error(
          `A data final vai de ${shortDate(snapshot.period_start)} a ${shortDate(last)}`,
        );
      const net = y.budget / y.multiplier;
      const goal_status =
        values.goal_status !== "auto"
          ? values.goal_status
          : y.goal_results <= 0
            ? null
            : m.conversions > 0 &&
                m.spend / m.conversions <= net / y.goal_results
              ? "good"
              : "bad";
      const after = { period_end: values.period_end, ...m, goal_status };
      const diff = changes(snapshot, after);
      if (!Object.keys(diff).length) return;
      store.edits.set(`s:${snapshot.cycle_id}:${snapshot.id}`, {
        ...after,
        source: "manual",
      });
      log(y.campaign_id, y.id, "snapshot_edited", {
        taken_on: snapshot.taken_on,
        changes: diff,
      });
    },
    async sync(_company, campaign) {
      await new Promise((r) => setTimeout(r, 400));
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
  /** The records edited by hand, over the generated numbers. */
  edits: Map<string, Partial<DailyMetric & CycleSnapshot>>;
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
  const store: Store = {
    campaigns: [],
    cycles: [],
    events: [],
    edits: new Map(),
    seq: 0,
  };
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

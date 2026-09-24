import type { Snapshot } from "./types";
import {
  addDays,
  monthlyEnd,
  type AdCampaign,
  type AdCampaignEvent,
  type AdCycle,
  type CampaignData,
  type CampaignsBackend,
  type CycleInput,
} from "./campaigns";
import { dateKey } from "./domain";

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
  }
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
    async load() {
      const visible = new Set(data().contracts.map((k) => k.id));
      const snapshot = clone();
      const campaigns = snapshot.campaigns.filter((c) =>
        visible.has(c.contract_id),
      );
      const ids = new Set(campaigns.map((c) => c.id));
      return {
        campaigns,
        cycles: snapshot.cycles.filter((y) => ids.has(y.campaign_id)),
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
        links: input.links,
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
        links: input.links,
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
          account_id:
            plan.platform === "meta" ? "act_1234567890" : "123-456-7890",
          campaign_id: "",
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

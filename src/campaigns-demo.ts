import type { Snapshot } from "./types";
import {
  AdsApiError,
  addDays,
  currentCycle,
  cycleAlert,
  money,
  monthlyEnd,
  noResults,
  shortDate,
  type AdCampaign,
  type AdCampaignEvent,
  type AdCycle,
  type AdCycleLink,
  type AdPlatform,
  type AdsBackend,
  type LeadForm,
  type LinkedLeadForm,
  type PendingConnection,
  type PlatformAccount,
  type PlatformCampaign,
  type CampaignData,
  type CampaignsBackend,
  type CycleInput,
  type SharedDayChoice,
  type MetaConversionRule,
  type RowResults,
} from "./campaigns";
import { contractParts, dateKey } from "./domain";
import type { PlatformBudget } from "./campaign-platform-budget";
import { cycleFit, demoMediaRoom } from "./campaign-media";
import {
  multiplierError,
  sameMultiplier,
  type MultiplierLogItem,
} from "./campaign-multiplier";
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
  // The M's rules, as in the database: 1 or more and a reason, logged.
  const multiplierReason = (reason: string | undefined) => {
    const text = (reason ?? "").trim();
    if (!text)
      throw Error("Informe o motivo da alteração do índice de performance (M)");
    return text;
  };
  const recordMultiplier = (
    a: AdCampaign,
    y: AdCycle,
    item: Pick<
      MultiplierLogItem,
      "kind" | "from" | "to" | "reason" | "apply" | "apply_from" | "apply_to"
    >,
  ) => {
    const parts = contractParts(data(), a.contract_id);
    store.multiplierLog.unshift({
      id: ++store.seq,
      at: now(),
      actor: user,
      actor_name:
        data().members.find((m) => m.user_id === user)?.name ?? "",
      campaign_id: a.id,
      cycle_id: y.id,
      campaign: a.name,
      client: parts.client?.name ?? "",
      product: parts.product?.name ?? "",
      platform: a.platform,
      cycle_start: y.start_date,
      cycle_end: y.end_date,
      day: null,
      days: [],
      media_diff: 0,
      ...item,
    });
  };
  function checkCycle(a: AdCampaign, input: CycleInput, except?: string) {
    if (input.end_date < input.start_date)
      throw Error("O término precisa ser igual ou posterior ao início");
    // As in the database: an edit that keeps the period is not rechecked
    // (imported cycles may share the turnover day with the previous one).
    const kept = store.cycles.some(
      (y) =>
        y.id === except &&
        y.start_date === input.start_date &&
        y.end_date === input.end_date,
    );
    const other =
      !kept &&
      store.cycles.find(
        (y) =>
          y.campaign_id === a.id &&
          y.id !== except &&
          y.start_date <= input.end_date &&
          y.end_date >= input.start_date &&
          // The turnover day (migration 20270301090000).
          !(
            y.end_date === input.start_date &&
            y.start_date < input.start_date &&
            input.end_date > input.start_date
          ) &&
          !(
            y.start_date === input.end_date &&
            y.end_date > input.end_date &&
            input.start_date < input.end_date
          ),
      );
    if (other)
      throw Error(
        `O período conflita com o ciclo de ${fmt(other.start_date)} a ${fmt(other.end_date)} desta campanha. Só o dia de virada pode ser dividido: o ciclo pode começar no dia em que o outro termina`,
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
  // As in the database: where a turnover day counts, on the cycle that
  // starts on it (asked when the shared day is new), in the history too.
  function setSharedDay(
    a: AdCampaign,
    later: AdCycle,
    choice: SharedDayChoice | null | undefined,
    required: boolean,
  ) {
    const earlier = store.cycles.find(
      (y) =>
        y.campaign_id === a.id &&
        y.id !== later.id &&
        y.end_date === later.start_date &&
        y.start_date < later.start_date,
    );
    if (!earlier) return;
    if (!choice && !later.shared_day && required)
      throw Error(
        `Escolha em qual ciclo conta o dia de virada (${fmt(later.start_date)})`,
      );
    if (!choice || choice === later.shared_day) return;
    const from = later.shared_day ?? null;
    later.shared_day = choice;
    later.version++;
    later.updated_at = now();
    log(a, later.id, "shared_day", {
      day: later.start_date,
      from,
      to: choice,
      earlier: {
        id: earlier.id,
        start_date: earlier.start_date,
        end_date: earlier.end_date,
      },
      later: {
        id: later.id,
        start_date: later.start_date,
        end_date: later.end_date,
      },
    });
  }
  function sharedDays(
    a: AdCampaign,
    y: AdCycle,
    input: CycleInput,
    changed: { start: boolean; end: boolean },
  ) {
    // Those no longer sharing a day lose their choice.
    for (const z of store.cycles)
      if (
        z.campaign_id === a.id &&
        z.shared_day &&
        !store.cycles.some(
          (x) =>
            x.campaign_id === a.id &&
            x.id !== z.id &&
            x.end_date === z.start_date &&
            x.start_date < z.start_date,
        )
      )
        z.shared_day = null;
    setSharedDay(a, y, input.shared_start, changed.start);
    const next = store.cycles.find(
      (x) =>
        x.campaign_id === a.id &&
        x.id !== y.id &&
        x.start_date === y.end_date &&
        x.end_date > y.end_date,
    );
    if (next) setSharedDay(a, next, input.shared_end, changed.end);
  }
  // As in the database: the budget must fit the client's media available.
  const mediaRoomOf = (a: AdCampaign) => {
    const today = dateKey(new Date());
    const parts = contractParts(data(), a.contract_id);
    const open = store.cycles
      .filter((y) => y.end_date >= today)
      .flatMap((y) => {
        const c = store.campaigns.find((x) => x.id === y.campaign_id);
        return c && !c.archived && c.contract_id === a.contract_id
          ? [
              {
                cycle_id: y.id,
                campaign_id: c.id,
                campaign_name: c.name,
                start_date: y.start_date,
                end_date: y.end_date,
                budget: y.budget,
                spent: 0,
                remaining: y.budget,
              },
            ]
          : [];
      });
    return demoMediaRoom(
      {
        id: a.contract_id,
        client: parts.client?.name ?? "",
        product: parts.product?.name ?? "",
      },
      open,
    );
  };
  function mediaGuard(
    a: AdCampaign,
    cycle: string | null,
    input: CycleInput,
    override?: string | null,
  ) {
    const room = mediaRoomOf(a);
    const fit = cycleFit(
      room,
      { id: cycle, end_date: input.end_date, budget: input.budget },
      dateKey(new Date()),
    );
    if (!fit.shortfall) return null;
    const reason = (override ?? "").trim();
    if (!reason)
      throw Error(
        `Saldo de mídia insuficiente: o disponível para ciclos é ${money(fit.available)}, e o ciclo precisa de ${money(fit.need)}. Faltam ${money(fit.shortfall)}.`,
      );
    if (fit.shortfall > room.override_cap)
      throw Error(
        `A liberação acima do saldo vai até ${money(room.override_cap)} nesta empresa, e faltam ${money(fit.shortfall)}.`,
      );
    if (reason.length < 3) throw Error("Escreva o motivo da liberação");
    return {
      shortfall: fit.shortfall,
      available: fit.available,
      need: fit.need,
      budget: input.budget,
      cap: room.override_cap,
      reason,
    };
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
    // The same rules as ad_campaign_page: active campaigns, the new ones
    // never activated ("pending"), the inactive ones or all, searched,
    // filtered and paged.
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
          const current = currentCycle(snapshot, c);
          return {
            campaign: c,
            client_name:
              data().clients.find((x) => x.id === contract?.client_id)?.name ??
              "",
            product_name:
              data().products.find((x) => x.id === contract?.product_id)
                ?.name ?? "",
            current,
            alert:
              c.status === "inactive" && !pending(c)
                ? { kind: "none" as const }
                : cycleAlert(snapshot, c, today),
            waiting: pending(c),
            spent: current ? demoSpent(store, current, today) : null,
            results:
              current && c.status === "active"
                ? demoResults(store, current, today)
                : noResults(),
            platform_budget:
              current && c.status === "active"
                ? demoPlatformBudget(c, current, demoSpent(store, current, today).gross, today)
                : null,
          };
        })
        .sort(
          (a, b) =>
            Number(a.campaign.status !== "active") -
              Number(b.campaign.status !== "active") ||
            fold(a.client_name).localeCompare(fold(b.client_name)) ||
            fold(a.campaign.name).localeCompare(fold(b.campaign.name)),
        );
      const scoped = rows.filter((r) =>
        q.scope === "pending"
          ? r.waiting
          : q.scope === "inactive"
            ? r.campaign.status === "inactive"
            : q.scope === "all" || r.campaign.status === "active",
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
        pending: rows.filter((r) => r.waiting).length,
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
    async setConversionActions(cycle, actions) {
      const y = store.cycles.find((c) => c.id === cycle.id);
      if (!y) throw Error("Sem permissão");
      const v = actions?.length ? [...new Set(actions)].sort() : null;
      if (v?.some((x) => !/^([0-9]{1,30}|phone_calls)$/.test(x)))
        throw Error("Ação de conversão inválida");
      const from = demoConversionChoice.get(y.id) ?? null;
      if (JSON.stringify(from) === JSON.stringify(v)) return;
      demoConversionChoice.set(y.id, v);
      log(campaignOf(y.campaign_id), y.id, "conversion_actions", {
        from,
        to: v,
      });
    },
    async setMetaConversions(cycle, actions, mode) {
      const y = store.cycles.find((c) => c.id === cycle.id);
      if (!y) throw Error("Sem permissão");
      const v = actions?.length ? [...new Set(actions)].sort() : null;
      const today = dateKey();
      const from = demoMetaChoice.get(y.id) ?? null;
      let to: MetaConversionRule[] | null;
      if (mode === "all" || today <= y.start_date)
        to = v ? [{ from: null, actions: v }] : null;
      else {
        const kept = (from ?? []).filter((r) => !r.from || r.from < today);
        if (!kept.length) kept.push({ from: null, actions: null });
        const last = kept[kept.length - 1].actions;
        to =
          JSON.stringify(last) === JSON.stringify(v)
            ? kept
            : [...kept, { from: today, actions: v }];
        if (!to.some((r) => r.actions)) to = null;
      }
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      demoMetaChoice.set(y.id, to);
      log(campaignOf(y.campaign_id), y.id, "meta_conversions", {
        from,
        to,
        mode,
        actions: v,
        since: mode === "forward" ? today : null,
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
    async createCycle(campaign, input, makeCurrent, override) {
      const a = campaignOf(campaign.id);
      checkCycle(a, input);
      const release = mediaGuard(a, null, input, override);
      const previous = store.cycles
        .filter((y) => y.campaign_id === a.id)
        .sort((x, y) => y.start_date.localeCompare(x.start_date))[0];
      const inherited = previous?.multiplier ?? 1;
      const m = input.multiplier ?? inherited;
      const wrong = multiplierError(m, null);
      if (wrong) throw Error(wrong);
      const reason =
        previous && !sameMultiplier(m, previous.multiplier)
          ? multiplierReason(input.multiplier_change?.reason)
          : null;
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
        multiplier: m,
        destination: input.destination,
        landing_pages: input.landing_pages,
        niche: input.niche,
        created_by: user,
        created_at: now(),
        updated_at: now(),
        version: 1,
        links: linksOf(a, input.links),
        shared_day: null,
      };
      // A missing turnover choice stores nothing.
      store.cycles.push(y);
      try {
        sharedDays(a, y, input, { start: true, end: true });
      } catch (e) {
        store.cycles.splice(store.cycles.indexOf(y), 1);
        throw e;
      }
      // Google: the conversions that count come from the previous cycle.
      const counted = previous && demoConversionChoice.get(previous.id);
      if (a.platform === "google" && counted)
        demoConversionChoice.set(y.id, [...counted]);
      log(a, y.id, "cycle_created", {
        start_date: y.start_date,
        end_date: y.end_date,
        objective: y.objective,
        goal_results: y.goal_results,
        budget: y.budget,
        multiplier: y.multiplier,
        links: y.links,
      });
      if (previous && reason) {
        log(a, y.id, "multiplier_changed", {
          kind: "new_cycle",
          from: previous.multiplier,
          to: m,
          reason,
          days: 0,
          media_diff: 0,
        });
        recordMultiplier(a, y, {
          kind: "new_cycle",
          from: previous.multiplier,
          to: m,
          reason,
          apply: null,
          apply_from: null,
          apply_to: null,
        });
      }
      if (release) log(a, y.id, "media_override", release);
      if (makeCurrent) {
        const from = a.current_cycle_id;
        a.current_cycle_id = y.id;
        bump(a);
        log(a, y.id, "current_cycle", { from, to: y.id });
      }
      return y.id;
    },
    async updateCycle(cycle, input, override) {
      const y = store.cycles.find((c) => c.id === cycle.id);
      if (!y) throw Error("Sem permissão");
      const a = campaignOf(y.campaign_id);
      if (y.version !== cycle.version)
        throw Error(
          "O ciclo foi alterado por outra pessoa. Recarregue e tente de novo.",
        );
      checkCycle(a, input, y.id);
      const m = input.multiplier ?? y.multiplier;
      const mChanged = !sameMultiplier(m, y.multiplier);
      const wrong = multiplierError(m, y.multiplier);
      if (wrong) throw Error(wrong);
      // The demonstration's days follow the cycle's M: all of them change.
      const reason = mChanged
        ? multiplierReason(input.multiplier_change?.reason)
        : null;
      const release = mediaGuard(a, y.id, input, override);
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
        // Another start: another turnover day, another choice.
        shared_day:
          input.start_date === before.start_date ? before.shared_day : null,
        updated_at: now(),
        version: y.version + 1,
      });
      // As in the database, a missing turnover choice changes nothing.
      const saved = store.cycles.map((z) => [z, z.shared_day] as const);
      try {
        sharedDays(a, y, input, {
          start: input.start_date !== before.start_date,
          end: input.end_date !== before.end_date,
        });
      } catch (e) {
        for (const [z, v] of saved) z.shared_day = v;
        Object.assign(y, before);
        throw e;
      }
      const diff = changes(before, { ...y }, [
        "competence_month",
        "start_date",
        "end_date",
        "objective",
        "goal_results",
        "budget",
        "destination",
        "landing_pages",
        "niche",
        "links",
      ]);
      if (Object.keys(diff).length) log(a, y.id, "cycle_updated", diff);
      if (reason) {
        log(a, y.id, "multiplier_changed", {
          kind: "cycle",
          from: before.multiplier,
          to: y.multiplier,
          reason,
          apply: "all",
          days: 0,
          media_diff: 0,
        });
        recordMultiplier(a, y, {
          kind: "cycle",
          from: before.multiplier,
          to: y.multiplier,
          reason,
          apply: "all",
          apply_from: null,
          apply_to: null,
        });
      }
      if (release) log(a, y.id, "media_override", release);
    },
    async mediaRoom(campaign) {
      return mediaRoomOf(campaignOf(campaign.id));
    },
    multiplier: {
      // The demonstration's days are generated from the cycle's M.
      async impact() {
        return {
          today: dateKey(),
          registered: 0,
          first_day: null,
          last_day: null,
          options: {},
        };
      },
      async log(_company, q) {
        const search = (q.search ?? "").trim().toLowerCase();
        const rows = store.multiplierLog.filter(
          (l) =>
            (!q.campaign || l.campaign_id === q.campaign) &&
            (!q.actor || l.actor === q.actor) &&
            (!q.from || l.at.slice(0, 10) >= q.from) &&
            (!q.to || l.at.slice(0, 10) <= q.to) &&
            (!search ||
              [l.campaign, l.client, l.product].some((t) =>
                t.toLowerCase().includes(search),
              )) &&
            (q.before == null || l.id < q.before),
        );
        const limit = q.limit ?? 30;
        return { items: rows.slice(0, limit), more: rows.length > limit };
      },
      async belowMin() {
        return [];
      },
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
    async metaConversions(_company, cycle) {
      await wait();
      const y = store.cycles.find((c) => c.id === cycle);
      const a = store.campaigns.find((c) => c.id === y?.campaign_id);
      if (!y || !a || a.platform !== "meta")
        throw new AdsApiError("Este ciclo não é de uma campanha do Meta Ads.");
      const rules = demoMetaChoice.get(y.id) ?? null;
      const current = rules?.[rules.length - 1] ?? null;
      const message = y.objective === "message";
      const byDefault = message
        ? "onsite_conversion.messaging_first_reply"
        : "offsite_conversion.fb_pixel_lead";
      const picked = current?.actions ?? [byDefault];
      return {
        objective: y.objective,
        destination: y.destination,
        start_date: y.start_date,
        end_date: y.end_date,
        today: dateKey(),
        rules,
        current: current?.actions ?? null,
        inherited: !!current?.inherited,
        default_label: message
          ? "as primeiras respostas nas mensagens"
          : "os leads do pixel no site",
        make_page: y.destination === "make_landing_page",
        period: {
          since: y.start_date,
          until: addDays(dateKey(), -1),
          cycle: true,
        },
        actions: DEMO_META_ACTIONS.map((x) => ({
          ...x,
          by_default: x.type === byDefault,
        })),
        counted: DEMO_META_ACTIONS.filter((x) => picked.includes(x.type)).reduce(
          (n, x) => n + x.conversions,
          0,
        ),
      };
    },
    async conversionActions(_company, cycle) {
      await wait();
      const y = store.cycles.find((c) => c.id === cycle);
      const a = store.campaigns.find((c) => c.id === y?.campaign_id);
      if (!y || !a || a.platform !== "google")
        throw new AdsApiError(
          "Este ciclo não é de uma campanha do Google Ads.",
        );
      const choice = demoConversionChoice.get(y.id) ?? null;
      const lead = new Set([
        "SUBMIT_LEAD_FORM",
        "CONTACT",
        "PHONE_CALL_LEAD",
        "SIGNUP",
        "REQUEST_QUOTE",
        "BOOK_APPOINTMENT",
      ]);
      const byDefault = (category: string) =>
        y.objective === "sale" ? category === "PURCHASE" : lead.has(category);
      const actions = DEMO_CONVERSION_ACTIONS.map((x) => ({
        ...x,
        counted: choice ? choice.includes(x.id) : byDefault(x.category),
        counted_by_default: byDefault(x.category),
      }));
      const phone_calls = 6;
      const calls_counted = !!choice?.includes("phone_calls");
      return {
        period: { since: y.start_date, until: addDays(dateKey(), -1) },
        selection: choice,
        actions,
        phone_calls,
        calls_counted,
        counted:
          actions
            .filter((x) => x.counted)
            .reduce((n, x) => n + x.conversions, 0) +
          (calls_counted ? phone_calls : 0),
      };
    },
    async pages(_company, account) {
      await wait();
      need("meta");
      if (!DEMO_ACCOUNTS.meta.some((a) => a.id === normalized("meta", account)))
        throw new AdsApiError(
          "Esta conta de anúncio não está conectada. Conecte com um usuário que tenha acesso a ela.",
          "not_connected",
        );
      return DEMO_PAGES.map(({ id, name }) => ({ id, name }));
    },
    async forms(_company, _account, page) {
      await wait();
      const p = DEMO_PAGES.find((x) => x.id === page.trim());
      if (!p)
        throw new AdsApiError(
          "O perfil do Facebook desta conta não administra esta página. Use a página certa ou conecte o Facebook com quem a administra.",
          "no_page_access",
        );
      return {
        page: { id: p.id, name: p.name },
        forms: p.forms.map((f) => ({ ...f })),
      };
    },
    async linkForm(_company, input) {
      await wait();
      const p = DEMO_PAGES.find((x) => x.id === input.page);
      const f = p?.forms.find((x) => x.id === input.form);
      if (!p || !f) throw new AdsApiError("Formulário do Facebook inválido.");
      if (!/^[0-9A-Za-z_-]{1,60}$/.test(input.landing_page.trim()))
        throw new AdsApiError("Escolha a página de captura da Make");
      if (!/^[0-9]{1,20}$/.test(input.make_user.trim()))
        throw new AdsApiError("Informe o ID do cliente na Make (números)");
      const now = new Date().toISOString();
      const row: LinkedLeadForm = {
        id:
          demoLeadForms.find((x) => x.form_id === f.id)?.id ??
          crypto.randomUUID(),
        client_id: input.client,
        client: data().clients.find((c) => c.id === input.client)?.name ?? null,
        page_id: p.id,
        page_name: p.name,
        form_id: f.id,
        form_name: input.form_name || f.name,
        landing_page_id: input.landing_page.trim(),
        make_user_id: input.make_user.trim(),
        source: "mavi",
        updated_at: now,
        last_lead_at: null,
        sent_30d: 0,
        last_error: null,
      };
      demoLeadForms = [row, ...demoLeadForms.filter((x) => x.form_id !== f.id)];
    },
    async leadForms(_company, client) {
      return demoLeadForms
        .filter((f) => !client || f.client_id === client)
        .map((f) => ({ ...f }));
    },
    async unlinkForm(id) {
      demoLeadForms = demoLeadForms.filter((f) => f.id !== id);
    },
  };
}

/** Meta action types of the demonstration (any Meta cycle). */
const DEMO_META_ACTIONS = [
  {
    type: "onsite_conversion.messaging_conversation_started_7d",
    label: "Conversas por mensagem iniciadas",
    detail: "",
    conversions: 64,
    families: ["messaging"],
    engagement: false,
  },
  {
    type: "onsite_conversion.messaging_first_reply",
    label: "Primeiras respostas nas mensagens",
    detail: "",
    conversions: 52,
    families: ["messaging"],
    engagement: false,
  },
  {
    type: "lead",
    label: "Leads (site e formulário)",
    detail: "",
    conversions: 41,
    families: ["lead_site", "lead_form"],
    engagement: false,
  },
  {
    type: "offsite_conversion.fb_pixel_lead",
    label: "Leads no site",
    detail: "Pixel",
    conversions: 29,
    families: ["lead_site"],
    engagement: false,
  },
  {
    type: "offsite_conversion.custom.555",
    label: "Obrigado — formulário",
    detail: "Conversão personalizada",
    conversions: 27,
    families: ["lead_site"],
    engagement: false,
  },
  {
    type: "onsite_conversion.lead_grouped",
    label: "Leads no formulário do Facebook",
    detail: "",
    conversions: 12,
    families: ["lead_form"],
    engagement: false,
  },
  {
    type: "link_click",
    label: "Cliques no link",
    detail: "",
    conversions: 812,
    families: [],
    engagement: true,
  },
  {
    type: "landing_page_view",
    label: "Visualizações da página de destino",
    detail: "",
    conversions: 530,
    families: [],
    engagement: true,
  },
];
const demoMetaChoice = new Map<string, MetaConversionRule[] | null>();

/** Google conversion actions of the demonstration (any Google cycle). */
const DEMO_CONVERSION_ACTIONS = [
  {
    id: "7001",
    name: "Formulário do site",
    category: "SUBMIT_LEAD_FORM",
    category_label: "Envio de formulário",
    conversions: 33,
  },
  {
    id: "7002",
    name: "Clique no WhatsApp",
    category: "DEFAULT",
    category_label: "Outro",
    conversions: 71,
  },
  {
    id: "7003",
    name: "Ligação pelo site",
    category: "PHONE_CALL_LEAD",
    category_label: "Ligação",
    conversions: 9,
  },
  {
    id: "7004",
    name: "Página de obrigado vista",
    category: "PAGE_VIEW",
    category_label: "Visualização de página",
    conversions: 120,
  },
];
const demoConversionChoice = new Map<string, string[] | null>();

/** Facebook Pages of the demonstration, with their lead forms. */
const DEMO_PAGES: { id: string; name: string; forms: LeadForm[] }[] = [
  {
    id: "104455667788",
    name: "Norte Coffee",
    forms: [
      {
        id: "880011",
        name: "Avaliação gratuita",
        status: "Ativo",
        active: true,
        leads: 42,
      },
      {
        id: "880012",
        name: "Cadastro · Black Friday",
        status: "Arquivado",
        active: false,
        leads: 310,
      },
    ],
  },
  {
    id: "104455667799",
    name: "Aurora Estética",
    forms: [
      {
        id: "880021",
        name: "Agende sua consulta",
        status: "Ativo",
        active: true,
        leads: 17,
      },
    ],
  },
];
let demoLeadForms: LinkedLeadForm[] = [];

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
/** The current cycle's spend, as ad_campaign_page sums it. */
function demoSpent(store: Store, y: AdCycle, today: string) {
  const parts = demoCycleMetrics(y, today);
  const days = parts.daily.map((r) => ({
    ...r,
    ...store.edits.get(`d:${r.cycle_id}:${r.day}`),
  }));
  if (days.length)
    return {
      net: days.reduce((t, r) => t + r.spend, 0),
      gross: days.reduce((t, r) => t + r.spend * r.multiplier, 0),
    };
  const last = parts.snapshots
    .map((x) => ({ ...x, ...store.edits.get(`s:${x.cycle_id}:${x.id}`) }))
    .sort((a, b) => b.taken_on.localeCompare(a.taken_on))[0];
  const spend = last?.spend ?? 0;
  return { net: spend, gross: spend * y.multiplier };
}
/**
 * O orçamento na plataforma de demonstração: perto do recomendado, um pouco
 * acima, bem acima, parada ou vitalício, conforme a campanha.
 */
function demoPlatformBudget(c: AdCampaign, y: AdCycle, gross: number, today: string): PlatformBudget | null {
  if (c.platform !== "meta" && c.platform !== "google") return null;
  if (today < y.start_date || today > y.end_date) return null;
  const from = today < y.start_date ? y.start_date : today;
  const left = Math.max(Math.round((Date.parse(y.end_date) - Date.parse(from)) / 86_400_000) + 1, 1);
  const rec = Math.max(y.budget / y.multiplier - gross / y.multiplier, 0) / left;
  const seed = [...c.id].reduce((t, ch) => t + ch.charCodeAt(0), 0) % 6;
  const read = new Date(Date.now() - (20 + seed * 17) * 60_000).toISOString();
  const kind = (["near", "above", "far", "near", "stopped", "lifetime"] as const)[seed];
  const factor = { near: 1.04, above: 1.18, far: 1.6, stopped: 1, lifetime: 0 }[kind];
  const daily = kind === "lifetime" ? 0 : Math.round(rec * factor);
  const active = kind === "stopped" ? 0 : 2;
  const item = (n: number, value: number) => ({
    id: `${c.id}-${n}`,
    name: c.platform === "meta" ? `[LEAD] Conjunto ${n}` : `Pesquisa ${n}`,
    level: c.platform === "meta" ? ("adset" as const) : ("campaign" as const),
    campaign_id: `${c.id}-c`,
    active: kind !== "stopped",
    status: kind === "stopped" ? "PAUSED" : "ACTIVE",
    daily: kind === "lifetime" ? 0 : value,
    lifetime: kind === "lifetime" ? value * left : 0,
    lifetime_left: kind === "lifetime" ? value * (left - 1) : 0,
  });
  const half = Math.round(daily / 2);
  return {
    daily: kind === "stopped" ? 0 : daily,
    lifetime: kind === "lifetime" ? Math.round(rec) * left : 0,
    lifetime_left: kind === "lifetime" ? Math.round(rec) * (left - 1) : 0,
    active,
    total: 2,
    items:
      kind === "lifetime"
        ? [item(1, Math.round(rec / 2)), item(2, Math.round(rec / 2))]
        : [item(1, half), item(2, daily - half)],
    currency: "BRL",
    previous_daily: kind === "above" ? Math.round(rec) : null,
    changed_at: kind === "above" ? new Date(Date.now() - 95 * 60_000).toISOString() : null,
    read_at: read,
    tried_at: read,
    error: null,
  };
}
/** Hoje: a parte do dia que já passou de um dia como ontem. */
function demoResults(store: Store, y: AdCycle, today: string): RowResults {
  const parts = demoCycleMetrics(y, today);
  const days = parts.daily.map((r) => ({
    ...r,
    ...store.edits.get(`d:${r.cycle_id}:${r.day}`),
  }));
  const last = parts.snapshots
    .map((x) => ({ ...x, ...store.edits.get(`s:${x.cycle_id}:${x.id}`) }))
    .sort((a, b) => b.taken_on.localeCompare(a.taken_on))[0];
  const sum = (key: "spend" | "conversions") =>
    days.reduce((t, r) => t + r[key], 0);
  const yesterday = days.find((r) => r.day === addDays(today, -1));
  const now = new Date();
  const part = Math.min(Math.max((now.getHours() - 6) / 18, 0.1), 1);
  return {
    cycle: last
      ? { spend: last.spend, conversions: last.conversions }
      : days.length
        ? { spend: sum("spend"), conversions: sum("conversions") }
        : null,
    yesterday: yesterday
      ? {
          spend: yesterday.spend,
          conversions: yesterday.conversions,
          multiplier: yesterday.multiplier,
        }
      : null,
    today:
      yesterday && today <= y.end_date
        ? {
            spend: Math.round(yesterday.spend * part * 100) / 100,
            conversions: Math.round(yesterday.conversions * part),
            multiplier: y.multiplier,
            read_at: new Date(now.getTime() - 25 * 60_000).toISOString(),
          }
        : null,
  };
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
      const wrong = multiplierError(values.multiplier, row.multiplier);
      if (wrong) throw Error(wrong);
      const mChanged = !sameMultiplier(values.multiplier, row.multiplier);
      if (mChanged && !values.reason?.trim())
        throw Error("Informe o motivo da alteração do índice de performance (M)");
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
      log(y.campaign_id, y.id, "daily_edited", {
        day: row.day,
        changes: diff,
        ...(mChanged ? { reason: values.reason?.trim() } : {}),
      });
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
  /** The M's audit log (ad_multiplier_log), newest first. */
  multiplierLog: MultiplierLogItem[];
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
    multiplierLog: [],
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

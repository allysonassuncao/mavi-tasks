import { describe, it, expect } from "vitest";
import {
  addDays,
  amountText,
  connectionResult,
  cycleAlert,
  cycleDays,
  cycleInput,
  cycleState,
  daysLeft,
  goalCost,
  monthLabel,
  monthlyEnd,
  nextCycleDraft,
  parseAmount,
  type AdCampaign,
  type AdCycle,
  type CampaignData,
} from "./campaigns";
import { demoCampaigns } from "./campaigns-demo";
import { demoSnapshot, demoUser } from "./demo";

const cycle = (
  id: string,
  start: string,
  end: string,
  extra: Partial<AdCycle> = {},
): AdCycle => ({
  id,
  company_id: "co",
  campaign_id: "cp",
  competence_month: `${start.slice(0, 7)}-01`,
  start_date: start,
  end_date: end,
  objective: "message",
  goal_results: 100,
  budget: 3000,
  multiplier: 2.5,
  destination: "external_page",
  landing_pages: [],
  niche: "",
  created_by: "u",
  created_at: "",
  updated_at: "",
  version: 1,
  links: [{ account_id: "act_1", campaign_id: "" }],
  ...extra,
});
const campaign = (current: string | null): AdCampaign => ({
  id: "cp",
  company_id: "co",
  contract_id: "ct",
  name: "Motion",
  platform: "meta",
  status: "active",
  current_cycle_id: current,
  briefing_url: "",
  media_plan_url: "",
  notes: "",
  archived: false,
  created_by: "u",
  created_at: "",
  updated_at: "",
  version: 1,
});

describe("datas do ciclo", () => {
  it("conta os dias incluindo início e término (31/08 a 30/09 = 31)", () => {
    expect(
      cycleDays({ start_date: "2026-08-31", end_date: "2026-09-30" }),
    ).toBe(31);
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });
  it("um ciclo mensal termina na véspera do mesmo dia do mês seguinte", () => {
    expect(monthlyEnd("2026-09-01")).toBe("2026-09-30");
    expect(monthlyEnd("2026-08-31")).toBe("2026-09-29");
    expect(monthlyEnd("2026-01-31")).toBe("2026-02-27");
    expect(monthlyEnd("2026-12-15")).toBe("2027-01-14");
  });
  it("dias restantes contam hoje e zeram depois do término", () => {
    const y = cycle("a", "2026-08-31", "2026-09-30");
    expect(daysLeft(y, "2026-09-24")).toBe(7);
    expect(daysLeft(y, "2026-09-30")).toBe(1);
    expect(daysLeft(y, "2026-10-01")).toBe(0);
    expect(cycleState(y, "2026-08-30")).toBe("planned");
    expect(cycleState(y, "2026-10-01")).toBe("ended");
  });
  it("custo por resultado esperado = verba ÷ meta", () => {
    expect(goalCost({ budget: 3000, goal_results: 100 })).toBe(30);
    expect(goalCost({ budget: 3000, goal_results: 0 })).toBeNull();
  });
});

describe("alertas do ciclo atual (troca manual)", () => {
  const sept = cycle("sept", "2026-08-31", "2026-09-30");
  const oct = cycle("oct", "2026-10-01", "2026-10-31");
  const data = (cycles: AdCycle[]): CampaignData => ({ campaigns: [], cycles });
  it("sem ciclo e sem ciclo atual", () => {
    expect(cycleAlert(data([]), campaign(null), "2026-09-24").kind).toBe(
      "no_cycle",
    );
    const alert = cycleAlert(data([sept]), campaign(null), "2026-09-24");
    expect(alert).toEqual({ kind: "no_current", suggestion: sept });
  });
  it("faltando 10 dias ou menos sem próximo ciclo: cobrar investimento", () => {
    expect(cycleAlert(data([sept]), campaign("sept"), "2026-09-20").kind).toBe(
      "none",
    );
    expect(cycleAlert(data([sept]), campaign("sept"), "2026-09-21")).toEqual({
      kind: "ending",
      days: 10,
      next: null,
    });
    expect(
      cycleAlert(data([sept, oct]), campaign("sept"), "2026-09-24").kind,
    ).toBe("none");
  });
  it("termina hoje e encerrado sem troca apontam o próximo ciclo", () => {
    expect(
      cycleAlert(data([sept, oct]), campaign("sept"), "2026-09-30"),
    ).toEqual({
      kind: "ends_today",
      next: oct,
    });
    expect(
      cycleAlert(data([sept, oct]), campaign("sept"), "2026-10-03"),
    ).toEqual({
      kind: "ended",
      days: 3,
      next: oct,
    });
    expect(cycleAlert(data([sept]), campaign("sept"), "2026-10-03")).toEqual({
      kind: "ended",
      days: 3,
      next: null,
    });
  });
});

describe("formulário do ciclo", () => {
  it("o próximo ciclo continua o último", () => {
    const draft = nextCycleDraft(
      cycle("sept", "2026-08-31", "2026-09-30"),
      "2026-09-24",
    );
    expect(draft).toMatchObject({
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      competence: "2026-10",
      objective: "message",
      goal_results: "100",
      budget: "3.000,00",
      multiplier: "2,5",
    });
    expect(draft.links).toEqual([{ account_id: "act_1", campaign_id: "" }]);
    expect(nextCycleDraft(null, "2026-09-24").start_date).toBe("2026-09-24");
  });
  it("mostra competência e valores no formato brasileiro", () => {
    expect(monthLabel("2026-09-01")).toBe("Setembro de 2026");
    expect(amountText(6500)).toBe("6.500,00");
    expect(amountText(2.5, 0)).toBe("2,5");
    expect(amountText(1.125, 0)).toBe("1,125");
    expect(parseAmount(amountText(6500))).toBe(6500);
  });
  it("aceita valores em reais com vírgula", () => {
    expect(parseAmount("3.000,50")).toBe(3000.5);
    expect(parseAmount("R$ 1.234,56")).toBe(1234.56);
    expect(parseAmount("2400.75")).toBe(2400.75);
    expect(parseAmount("abc")).toBeNaN();
  });
  it("valida datas, meta, verba, M, páginas e vínculos", () => {
    const base = nextCycleDraft(
      cycle("sept", "2026-08-31", "2026-09-30"),
      "2026-09-24",
    );
    expect(cycleInput({ ...base, end_date: "2026-09-01" })).toEqual({
      error: "O término precisa ser igual ou posterior ao início.",
    });
    expect("error" in cycleInput({ ...base, goal_results: "1.5" })).toBe(true);
    expect("error" in cycleInput({ ...base, budget: "" })).toBe(true);
    expect("error" in cycleInput({ ...base, multiplier: "0" })).toBe(true);
    expect("error" in cycleInput({ ...base, multiplier: "101" })).toBe(true);
    expect(
      "error" in
        cycleInput({
          ...base,
          destination: "make_landing_page",
          landing_pages: " ",
        }),
    ).toBe(true);
    expect(
      "error" in
        cycleInput({ ...base, links: [{ account_id: "", campaign_id: "c9" }] }),
    ).toBe(true);
    const ok = cycleInput({
      ...base,
      budget: "3.500,00",
      multiplier: "2,75",
      links: [
        { account_id: " act_1 ", campaign_id: "" },
        { account_id: "", campaign_id: "" },
      ],
    });
    expect(ok).toEqual({
      input: expect.objectContaining({
        competence: "2026-10-01",
        budget: 3500,
        multiplier: 2.75,
        links: [{ account_id: "act_1", campaign_id: "" }],
        landing_pages: [],
      }),
    });
  });
});

describe("demonstração segue as regras do banco", () => {
  const data = demoSnapshot();
  const contract = data.contracts.find((k) =>
    k.name.startsWith("Make Ads"),
  )!.id;
  const company = data.companies[0].id;
  it("cadastra campanha inativa, ciclo e troca manual do atual", async () => {
    const backend = demoCampaigns(() => data, demoUser);
    const id = await backend.createCampaign(company, {
      contract_id: contract,
      name: "Nova campanha",
      platform: "meta",
      briefing_url: "",
      media_plan_url: "",
      notes: "",
    });
    let state = await backend.campaign(company, id);
    let a = state.campaigns[0];
    expect(a.status).toBe("inactive");
    await expect(backend.setStatus(a, "active", "Começar")).rejects.toThrow(
      /ciclo atual/,
    );
    const input = {
      competence: "2026-09-01",
      start_date: "2026-09-01",
      end_date: "2026-09-30",
      objective: "lead" as const,
      goal_results: 50,
      budget: 2000,
      multiplier: 3,
      destination: "external_page" as const,
      landing_pages: [],
      niche: "",
      links: [],
    };
    const first = await backend.createCycle(a, input, true);
    await expect(
      backend.createCycle(
        a,
        { ...input, start_date: "2026-09-30", end_date: "2026-10-29" },
        false,
      ),
    ).rejects.toThrow(/conflita com o ciclo de 01\/09\/2026 a 30\/09\/2026/);
    await backend.createCycle(
      a,
      {
        ...input,
        start_date: "2026-10-01",
        end_date: "2026-10-31",
        multiplier: null,
      },
      false,
    );
    state = await backend.campaign(company, id);
    a = state.campaigns[0];
    expect(a.current_cycle_id).toBe(first);
    expect(
      state.cycles.filter((y) => y.campaign_id === id).map((y) => y.multiplier),
    ).toEqual([3, 3]);
    const events = await backend.events(company, id);
    expect(events.map((e) => e.action)).toEqual([
      "cycle_created",
      "current_cycle",
      "cycle_created",
      "created",
    ]);
  });
});

describe("contas e campanhas das plataformas", () => {
  const data = demoSnapshot();
  const company = data.companies[0].id;
  const contracts = data.contracts.filter((k) => k.name.startsWith("Make Ads"));
  it("lista contas e campanhas da conta; conta desconhecida pede conexão", async () => {
    const { ads } = demoCampaigns(() => data, demoUser);
    const accounts = await ads.accounts(company, "google");
    expect(accounts[0]).toMatchObject({ manager_id: "5550001111" });
    const campaigns = await ads.campaigns(
      company,
      "meta",
      "act_1234567890",
      "",
    );
    expect(campaigns.map((c) => c.active)).toContain(false);
    await expect(
      ads.campaigns(company, "meta", "999", ""),
    ).rejects.toMatchObject({ code: "not_connected" });
    await ads.disconnect(company, "google");
    await expect(ads.accounts(company, "google")).rejects.toMatchObject({
      code: "not_connected",
    });
    expect((await ads.status(company)).google.email).toBeUndefined();
    expect(await ads.connect(company, "google")).toBeNull();
    expect((await ads.status(company)).google.email).toBeTruthy();
  });
  it("uma campanha da plataforma fica em uma só campanha; ids normalizados", async () => {
    const backend = demoCampaigns(() => data, demoUser);
    const create = (name: string, contract: string) =>
      backend.createCampaign(company, {
        contract_id: contract,
        name,
        platform: "meta",
        briefing_url: "",
        media_plan_url: "",
        notes: "",
      });
    const a = await create("A", contracts[0].id);
    const b = await create("B", contracts[1 % contracts.length].id);
    const campA = (await backend.campaign(company, a)).campaigns[0];
    const campB = (await backend.campaign(company, b)).campaigns[0];
    const input = (start: string, end: string) => ({
      competence: `${start.slice(0, 7)}-01`,
      start_date: start,
      end_date: end,
      objective: "lead" as const,
      goal_results: 10,
      budget: 100,
      multiplier: 1,
      destination: "external_page" as const,
      landing_pages: [],
      niche: "",
      links: [
        {
          account_id: "act_555",
          campaign_id: "777",
          campaign_name: "[LEAD] BF",
        },
      ],
    });
    const y = await backend.createCycle(
      campA,
      input("2031-01-01", "2031-01-31"),
      false,
    );
    const saved = (await backend.campaign(company, a)).cycles.find(
      (c) => c.id === y,
    )!;
    expect(saved.links[0]).toMatchObject({ account_id: "555", manager_id: "" });
    await expect(
      backend.createCycle(campB, input("2031-01-01", "2031-01-31"), false),
    ).rejects.toThrow(
      /\[LEAD\] BF da plataforma já está vinculada à campanha "A"/,
    );
    // The same campaign's next cycle keeps it.
    await backend.createCycle(campA, input("2031-02-01", "2031-02-28"), false);
  });
  it("explica o retorno da conexão", () => {
    expect(connectionResult("meta-conectado")).toBe("Facebook conectado.");
    expect(connectionResult("google-sem-permissao")).toMatch(/Google Ads/);
    expect(connectionResult("meta-sem-contas")).toMatch(/nenhuma conta/);
    expect(connectionResult("xyz")).toMatch(/Não foi possível/);
  });
});

describe("lista paginada (demonstração com as regras do servidor)", () => {
  const data = demoSnapshot();
  const company = data.companies[0].id;
  it("só ativas; as novas ficam em aguardando ativação", async () => {
    const backend = demoCampaigns(() => data, demoUser);
    const q = {
      scope: "active" as const,
      search: "",
      platform: "",
      attention: false,
      limit: 1,
      offset: 0,
    };
    const first = await backend.page(company, q);
    expect(first.rows).toHaveLength(1);
    expect(first.total).toBe(first.all);
    const everything = [
      ...first.rows,
      ...(await backend.page(company, { ...q, limit: 50, offset: 1 })).rows,
    ];
    expect(everything.every((r) => r.campaign.status === "active")).toBe(true);
    expect(everything).toHaveLength(first.all);
    const pending = await backend.page(company, {
      ...q,
      scope: "pending",
      limit: 50,
    });
    expect(pending.rows.every((r) => r.campaign.status === "inactive")).toBe(
      true,
    );
    expect(pending.total).toBe(first.pending);
    // Search ignores accents and case.
    const google = await backend.page(company, {
      ...q,
      platform: "google",
      limit: 50,
    });
    expect(google.rows.every((r) => r.campaign.platform === "google")).toBe(
      true,
    );
    const name = everything[0].campaign.name;
    const found = await backend.page(company, {
      ...q,
      search: name
        .toUpperCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, ""),
      limit: 50,
    });
    expect(found.rows.map((r) => r.campaign.name)).toContain(name);
  });
});

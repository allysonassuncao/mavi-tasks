import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  canManageDueScope,
  dueRuleFor,
  easter,
  isBusinessDay,
  nationalHoliday,
  nationalHolidays,
  ruleScope,
  suggestDue,
} from "./dueRules";
import type { CalendarDay, Snapshot, TaskDueRule } from "./types";

const rule = (r: Partial<TaskDueRule>): TaskDueRule => ({
  id: r.id ?? "r",
  company_id: "c",
  project_id: null,
  client_id: null,
  product_id: null,
  team_id: null,
  user_id: null,
  business_days: 3,
  min_days: null,
  approval_days: 0,
  active: true,
  ...r,
});
const day = (d: Partial<CalendarDay>): CalendarDay => ({
  id: d.day ?? "d",
  company_id: "c",
  day: "2026-01-01",
  yearly: false,
  kind: "off",
  name: "Dia",
  ...d,
});

describe("calendário", () => {
  it("calcula a Páscoa e os feriados móveis", () => {
    expect(easter(2026)).toBe("2026-04-05");
    expect(easter(2027)).toBe("2027-03-28");
    expect(nationalHoliday("2026-02-16")).toBe("Carnaval");
    expect(nationalHoliday("2026-04-03")).toBe("Sexta-feira Santa");
    expect(nationalHoliday("2026-06-04")).toBe("Corpus Christi");
    expect(nationalHoliday("2026-11-20")).toBe("Dia da Consciência Negra");
    expect(nationalHoliday("2023-11-20")).toBeNull();
    expect(nationalHolidays(2026)).toHaveLength(13);
  });
  it("pula fins de semana, feriados e os dias de folga da empresa", () => {
    expect(addBusinessDays([], "2026-11-18", 2)).toBe("2026-11-23");
    expect(addBusinessDays([], "2026-11-23", -2)).toBe("2026-11-18");
    const calendar = [
      day({ day: "2025-12-08", yearly: true }),
      day({ day: "2026-06-04", kind: "workday" }),
    ];
    expect(isBusinessDay(calendar, "2026-12-08")).toBe(false);
    expect(isBusinessDay(calendar, "2023-12-08")).toBe(true);
    expect(isBusinessDay(calendar, "2026-06-04")).toBe(true);
    expect(isBusinessDay([], "2026-06-04")).toBe(false);
  });
});

const data = {
  contracts: [
    { id: "k1", client_id: "clinica", product_id: "ads" },
    { id: "k2", client_id: "padaria", product_id: "ads" },
  ],
  projects: [{ id: "p1", contract_id: "k1", name: "Lançamento" }],
  teamMembers: [
    { company_id: "c", team_id: "design", user_id: "ana" },
    { company_id: "c", team_id: "design", user_id: "gil" },
    { company_id: "c", team_id: "social", user_id: "caio" },
  ],
  clientTeams: [
    { company_id: "c", client_id: "clinica", team_id: "design" },
    { company_id: "c", client_id: "padaria", team_id: "social" },
  ],
  members: [
    { user_id: "adm", role: "admin", active: true, name: "Adm" },
    { user_id: "gil", role: "manager", active: true, name: "Gil" },
    { user_id: "ana", role: "member", active: true, name: "Ana" },
  ],
  clients: [{ id: "clinica", name: "Clínica" }],
  products: [{ id: "ads", name: "Make Ads" }],
  teams: [{ id: "design", name: "Design" }],
  calendarDays: [],
  dueRules: [
    rule({ id: "company", business_days: 3 }),
    rule({ id: "product", product_id: "ads", business_days: 5 }),
    rule({ id: "client", client_id: "clinica", business_days: 2, approval_days: 3 }),
    rule({ id: "cp", client_id: "clinica", product_id: "ads", business_days: 4, min_days: 2 }),
    rule({ id: "project", project_id: "p1", business_days: 1 }),
    rule({ id: "team", team_id: "social", business_days: 6 }),
    rule({ id: "person", user_id: "caio", business_days: 7 }),
    rule({ id: "off", client_id: "padaria", business_days: 9, active: false }),
  ],
} as unknown as Snapshot;

describe("regras", () => {
  it("vence a mais específica", () => {
    const pick = (t: Parameters<typeof dueRuleFor>[1]) => dueRuleFor(data, t)?.id;
    expect(pick({ contract: "k1", project: "p1", assignee: "ana" })).toBe("project");
    expect(pick({ contract: "k1", assignee: "ana" })).toBe("cp");
    expect(pick({ contract: "k2", assignee: "caio" })).toBe("product");
    const noProduct = {
      ...data,
      dueRules: data.dueRules!.filter((r) => r.id !== "product"),
    };
    // Caio é da Social, que atende a Padaria; Ana não.
    expect(dueRuleFor(noProduct, { contract: "k2", assignee: "caio" })?.id).toBe("team");
    expect(dueRuleFor(noProduct, { contract: "k2", assignee: "ana" })?.id).toBe("company");
    expect(dueRuleFor(noProduct, { contract: "k2", team: "social" })?.id).toBe("team");
  });
  it("conta do início, com o mínimo e os dias da aprovação do cliente", () => {
    expect(suggestDue(data, { contract: "k1", assignee: "ana", base: "2026-11-18" })).toMatchObject({
      due: "2026-11-25",
      min: "2026-11-23",
      days: 4,
    });
    // Sábado conta como segunda.
    expect(
      suggestDue(data, { contract: "k1", assignee: "ana", base: "2026-11-21" })?.due,
    ).toBe("2026-11-27");
    const client = { ...data, dueRules: [rule({ client_id: "clinica", business_days: 2, approval_days: 3 })] };
    expect(suggestDue(client, { contract: "k1", base: "2026-11-18", approval: true })?.due).toBe("2026-11-26");
    expect(suggestDue({ ...data, dueRules: [] }, { contract: "k1", base: "2026-11-18" })).toBeNull();
  });
  it("descreve onde a regra vale", () => {
    expect(ruleScope(data, rule({ client_id: "clinica", product_id: "ads" }))).toBe(
      "Cliente Clínica · Produto Make Ads",
    );
    expect(ruleScope(data, rule({}))).toBe("Padrão da empresa");
  });
  it("gestores configuram só a sua área", () => {
    const can = (user: string, s: Partial<TaskDueRule>) =>
      canManageDueScope(data, user, { project_id: null, client_id: null, team_id: null, user_id: null, ...s });
    expect(can("adm", {})).toBe(true);
    expect(can("gil", {})).toBe(false);
    expect(can("gil", { client_id: "clinica" })).toBe(true);
    expect(can("gil", { project_id: "p1" })).toBe(true);
    expect(can("gil", { user_id: "ana" })).toBe(true);
    expect(can("gil", { team_id: "design", user_id: "caio" })).toBe(false);
    expect(can("gil", { client_id: "padaria" })).toBe(false);
    expect(can("ana", { client_id: "clinica" })).toBe(false);
  });
});

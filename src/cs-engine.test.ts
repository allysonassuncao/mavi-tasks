import { describe, expect, it } from "vitest";
import {
  CsEngine,
  f0,
  monthsBetween,
  numberFormat,
  type CsData,
  type CsDataClient,
  type CsDataCycle,
} from "./cs-engine";
import { kpiStripData } from "./cs-blocks";
import { resolvePeriod } from "./cs-dashboard";

// Uma carteira mínima, inventada, para as regras do dash de CS
// (a conferência número a número com o dash antigo é scripts/cs-parity.ts).
const client = (id: string, over: Partial<CsDataClient> = {}): CsDataClient => ({
  id, external_id: id, name: `Cliente ${id}`, squad_id: "A", vertical: null, origin: "comercial", kind: "BASE",
  trial_month: null, status: "ATIVO", entry_date: "2026-01-10", churn_date: null, reactivation_date: null,
  churn_reason: null, notes: null, ...over,
});
const cycle = (client: string, month: string, over: Partial<CsDataCycle> = {}): CsDataCycle => ({
  id: `${client}-${month}`, client, month, squad_id: null, start_date: null, end_date: null, billing_date: null,
  best: 0, probable: 0, probability: "PROVAVEL", paid: 0, paid_date: null, status: "PENDENTE", adimplencia: "ADIMPLENTE",
  acl: false, acl_value: null, fee_planned: null, fee_paid: null, m1_discounted: false, ...over,
});
const data = (clients: CsDataClient[], cycles: CsDataCycle[], over: Partial<CsData> = {}): CsData => ({
  today: "2026-10-06", squads: [{ id: "A", name: "Alfa", color: "#000", sort: 1, archived: false },
    { id: "B", name: "Beta", color: "#111", sort: 2, archived: false }],
  clients, cycles, payments: [], hs: [], goals: [], events: [], history: [], rules: [], ...over,
});
const paid = (v: number) => ({ paid: v, status: "PAGO" as const });

describe("regra M1 (comissão do primeiro mês de trial)", () => {
  const e = new CsEngine(data(
    [
      client("trial", { kind: "TRIAL", entry_date: "2026-03-10" }),
      client("grad", { kind: "BASE", trial_month: 3, entry_date: "2026-03-05" }),
      client("base", { kind: "BASE", entry_date: "2026-03-05" }),
      client("late", { kind: "TRIAL", entry_date: "2026-02-20" }),
      client("done", { kind: "TRIAL", entry_date: "2026-03-01" }),
    ],
    [
      cycle("trial", "2026-03-01", paid(5000)), cycle("trial", "2026-04-01", paid(5000)),
      cycle("grad", "2026-03-01", paid(2500)),
      cycle("base", "2026-03-01", paid(5000)),
      cycle("late", "2026-03-01", paid(5000)),
      cycle("done", "2026-03-01", { ...paid(5000), m1_discounted: true }),
    ],
  ));
  const vef = (id: string) => e.vef(e.cycleAt(id, "2026-03-01")!);
  it("desconta R$ 3.000 só no primeiro ciclo, no mês de entrada", () => {
    expect(vef("trial")).toBe(2000);
    expect(e.vef(e.cycleAt("trial", "2026-04-01")!)).toBe(5000);
  });
  it("é fato histórico: quem já graduou também teve M1 (e nunca fica negativo)", () => {
    expect(vef("grad")).toBe(0);
    expect(e.isPayer(e.cycleAt("grad", "2026-03-01")!)).toBe(true);
    expect(e.isEffectivePayer(e.cycleAt("grad", "2026-03-01")!)).toBe(false);
  });
  it("não vale para quem não passou pelo trial, entrou em outro mês ou já veio descontado", () => {
    expect(vef("base")).toBe(5000);
    expect(vef("late")).toBe(5000);
    expect(vef("done")).toBe(5000);
  });
  it("o faturamento do mês soma os valores efetivos", () => {
    expect(kpiStripData(e, { mes_ref: "2026-03-01", squad_id: null, dim: "tudo" }).fat_mes).toBe(2000 + 0 + 5000 + 5000 + 5000);
  });
});

describe("regras com vigência", () => {
  it("a comissão M1 muda a partir do mês da nova regra", () => {
    const e = new CsEngine(data(
      [client("abr", { kind: "TRIAL", entry_date: "2026-04-02" }), client("mai", { kind: "TRIAL", entry_date: "2026-05-02" })],
      [cycle("abr", "2026-04-01", paid(5000)), cycle("mai", "2026-05-01", paid(5000))],
      { rules: [{ valid_from: "2026-05-01", rules: { m1_commission: 2000 } }] },
    ));
    expect(e.vef(e.cycleAt("abr", "2026-04-01")!)).toBe(2000);
    expect(e.vef(e.cycleAt("mai", "2026-05-01")!)).toBe(3000);
  });
});

describe("categoria histórica e ACL", () => {
  const e = new CsEngine(data(
    [client("g", { kind: "BASE", trial_month: 3, entry_date: "2025-01-15" }), client("x", { entry_date: "2024-01-01" })],
    [
      cycle("g", "2025-01-01", paid(1000)), cycle("g", "2025-02-01", paid(4000)), cycle("g", "2025-04-01", paid(4000)),
      cycle("x", "2025-02-01", { ...paid(4000), acl: true, acl_value: 1000 }),
      cycle("x", "2025-03-01", { ...paid(4000), acl: true, acl_value: null }),
    ],
  ));
  it("os meses antes da graduação contam como trial", () => {
    expect(e.gradMonth(e.clientOf("g"))).toBe("2025-03-01");
    expect(e.phase(e.cycleAt("g", "2025-02-01")!)).toBe("TRIAL");
    expect(e.phase(e.cycleAt("g", "2025-04-01")!)).toBe("BASE");
  });
  it("ACL parcial fica na fase do ciclo; ACL sem valor é o ciclo todo", () => {
    const parcial = e.cycleAt("x", "2025-02-01")!;
    expect(e.category(parcial)).toBe("BASE");
    expect(e.aclEf(parcial)).toBe(1000);
    const total = e.cycleAt("x", "2025-03-01")!;
    expect(e.category(total)).toBe("ACL");
    expect(e.aclEf(total)).toBe(4000);
  });
});

describe("squad do mês", () => {
  const e = new CsEngine(data(
    [client("c", { squad_id: "B" })],
    [cycle("c", "2026-01-01", { squad_id: "A" }), cycle("c", "2026-03-01", { squad_id: "B" })],
  ));
  const c = e.clientOf("c");
  it("usa o ciclo do mês, depois o anterior, depois o seguinte", () => {
    expect(e.squadInMonth(c, "2026-01-01")).toBe("A");
    expect(e.squadInMonth(c, "2026-02-01")).toBe("A");
    expect(e.squadInMonth(c, "2025-12-01")).toBe("A");
    expect(e.squadInMonth(c, "2026-04-01")).toBe("B");
  });
});

describe("datas e números como no dash antigo", () => {
  it("o mês do trial fecha no aniversário da entrada (TIMESTAMPDIFF)", () => {
    expect(monthsBetween("2026-01-29", "2026-02-28")).toBe(0);
    expect(monthsBetween("2026-01-29", "2026-03-01")).toBe(1);
    expect(monthsBetween("2026-01-31", "2026-02-28")).toBe(0);
    expect(monthsBetween("2026-01-10", "2026-04-10")).toBe(3);
  });
  it("sprintf arredonda o empate para o par; number_format para longe do zero", () => {
    expect(f0(14.5)).toBe("14");
    expect(f0(15.5)).toBe("16");
    expect(f0(-0.4)).toBe("-0");
    expect(numberFormat(2.5, 0)).toBe("3");
    expect(numberFormat(1234567.891, 2)).toBe("1.234.567,89");
  });
});

describe("período do painel", () => {
  const today = "2026-10-06";
  it("janelas de 3, 6 e 12 meses terminam no mês escolhido", () => {
    const p = resolvePeriod({ tipo: "3m", mes: "2026-08-01" }, today);
    expect(p.meses).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
    expect(p.label).toBe("3 meses até Agosto 2026");
    expect(p.is_single).toBe(false);
  });
  it("não passa do mês corrente", () => {
    expect(resolvePeriod({ tipo: "mes", mes: "2027-01-01" }, today).mes_ref).toBe("2026-10-01");
  });
  it("personalizado: inverte início e fim e limita a 24 meses", () => {
    const p = resolvePeriod({ tipo: "custom", ini: "2026-09-01", fim: "2026-01-01" }, today);
    expect([p.inicio, p.fim, p.qtd_meses]).toEqual(["2026-01-01", "2026-09-01", 9]);
    const q = resolvePeriod({ tipo: "custom", ini: "2020-01-01", fim: "2026-10-01" }, today);
    expect(q.qtd_meses).toBe(25);
  });
  it("comparação com o mesmo mês empurra o período B para trás", () => {
    const p = resolvePeriod({ tipo: "compare", janela: "3m", a_fim: "2026-09-01", b_fim: "2026-09-01" }, today);
    expect(p.compare?.b.fim).toBe("2026-06-01");
    expect(p.is_compare).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { CS_DEFAULT_RULES } from "./cs-engine";
import {
  activeIn,
  canEdit,
  demoEntry,
  gridRows,
  hsScore,
  logChanges,
  parseDate,
  parseMoney,
  type CsEntryAccess,
  type EntryMonth,
} from "./cs-entry";

// O lançamento de CS no MAVI (fase 5, migração 20270525090000): as regras da grade.
const access = (over: Partial<CsEntryAccess> = {}): CsEntryAccess => ({
  source: "mavi", source_changed_at: null, source_changed_by: null, has_sheet: true, can_switch: false, is_leader: false,
  scope: { scope: "squads", squads: ["P"] }, today: "2026-10-06", ...over,
});

describe("lançamento de CS", () => {
  it("o squad lança só os seus; com a planilha como fonte, ninguém", () => {
    expect(canEdit(access(), "P")).toBe(true);
    expect(canEdit(access(), "T")).toBe(false);
    expect(canEdit(access({ scope: { scope: "all" } }), "T")).toBe(true);
    expect(canEdit(access({ source: "sheet", scope: { scope: "all" } }), "T")).toBe(false);
  });
  it("lê valores e datas do jeito que se digita na planilha", () => {
    expect(parseMoney("1.500,00")).toBe(1500);
    expect(parseMoney("R$ 2.345,5")).toBe(2345.5);
    expect(parseMoney("1.500")).toBe(1500);
    expect(parseMoney("1500.75")).toBe(1500.75);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNaN();
    expect(parseMoney("22.55021.000,50")).toBeNaN();
    expect(parseMoney("1,234.50")).toBe(1234.5);
    expect(parseMoney("0")).toBe(0);
    expect(parseDate("10/10", "2026-10-01")).toBe("2026-10-10");
    expect(parseDate("5/1/27", "2026-10-01")).toBe("2027-01-05");
    expect(parseDate("2026-11-30", "2026-10-01")).toBe("2026-11-30");
    expect(parseDate("31/02/2026", "2026-10-01")).toBeUndefined();
    expect(parseDate("", "2026-10-01")).toBeNull();
  });
  it("carteira do mês igual à do banco (cs_active_in)", () => {
    const k = { entry_date: "2026-03-15", churn_date: "2026-08-20", reactivation_date: null };
    expect(activeIn(k, "2026-02-01")).toBe(false);
    expect(activeIn(k, "2026-03-01")).toBe(true);
    expect(activeIn(k, "2026-08-01")).toBe(false);
    expect(activeIn({ ...k, reactivation_date: "2026-10-02" }, "2026-10-01")).toBe(true);
  });
  it("as linhas: na carteira ou com ciclo, filtradas e por squad", () => {
    const client = (id: string, name: string, squad: string, active: boolean) => ({
      id, external_id: id, name, squad_id: squad, vertical: null, origin: "comercial" as const, kind: "BASE" as const,
      trial_month: null, status: "ATIVO" as const, entry_date: "2026-01-01", churn_date: null, reactivation_date: null,
      churn_reason: null, notes: null, client_name: null, active,
    });
    const m = {
      month: "2026-10-01", access: access(), rules: CS_DEFAULT_RULES, goals: [], hs: [], previous: [],
      squads: [{ id: "P", name: "P", color: "#000", archived: false }, { id: "T", name: "T", color: "#000", archived: false }],
      clients: [client("1", "Zeta", "P", true), client("2", "Alfa", "T", true), client("3", "Saiu", "P", false),
        client("4", "Mudou", "T", false)],
      cycles: [{ cs_client_id: "4", squad_id: "P" }],
    } as unknown as EntryMonth;
    expect(gridRows(m, null).map((r) => r.client.name)).toEqual(["Mudou", "Zeta", "Alfa"]);
    expect(gridRows(m, "P").map((r) => r.squad)).toEqual(["P", "P"]);
    expect(gridRows(m, null, "alf").map((r) => r.client.name)).toEqual(["Alfa"]);
  });
  it("a nota de HS como o gatilho do banco", () => {
    expect(hsScore({ goal: true, payment: true, meeting: true }, CS_DEFAULT_RULES)).toEqual({ score: 65, band: "ALERTA" });
    expect(hsScore({ goal: true, perception: true, payment: true, meeting: true }, CS_DEFAULT_RULES).band).toBe("SATISFEITO");
    expect(hsScore({ manual_score: 72 }, CS_DEFAULT_RULES)).toEqual({ score: 72, band: "ALERTA" });
  });
  it("o histórico diz o que mudou", () => {
    expect(logChanges({ probable: "5000.00", notes: null, updated_at: "x" }, { probable: 4000, notes: "Boleto", updated_at: "y" }))
      .toEqual(["provável: 5.000 → 4.000", "observações: — → Boleto"]);
    expect(logChanges(null, { squad_id: "P", paid: 0, status: "PENDENTE" }, () => "Primogênito"))
      .toEqual(["squad: Primogênito", "status: PENDENTE"]);
  });
  it("demonstração: prévia até virar a chave; depois lança e abre o mês", async () => {
    const api = demoEntry();
    const m = await api.month("c", "2026-10-01");
    const row = gridRows(m, null)[0];
    await expect(api.saveCycle("c", row.client.id, m.month, { probable: 1 })).rejects.toThrow(/planilha/);
    expect((await api.setSource("c", "mavi", "pronto")).source).toBe("mavi");
    const y = await api.saveCycle("c", row.client.id, m.month, { payments: [{ date: "2026-10-12", amount: 300 }, { date: "2026-10-05", amount: 200 }] });
    expect([y.paid, y.paid_date]).toEqual([500, "2026-10-05"]);
    const next = await api.openMonth("c", "2099-01-01", false);
    expect(next.created).toBe(0);
    expect((await api.log("c", null))[0].entity).toBe("cycle");
    await api.setSource("c", "sheet", "voltar");
  });
});

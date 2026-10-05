import { describe, expect, it } from "vitest";
import {
  isRqProduct,
  rqContractText,
  rqFilterText,
  rqInputFrom,
  rqInputOut,
  rqMonthName,
  rqMonths,
  rqNumber,
  rqPriceText,
  rqShiftMonth,
  type RqConfig,
} from "./rq-billing";
import { rqInputProblem } from "./RqBilling";

const config: RqConfig = {
  model: "meeting",
  pipeline_id: "p",
  pipeline_name: "Vendas",
  stage_id: "s",
  stage_name: "Reunião qualificada",
  price_kind: "fixed",
  unit_price: 150,
  percent: null,
  contract_kind: "minimum",
  fixed_amount: 1000,
  cap: 5000,
  lead_filter: { mode: "all" },
};

describe("Make Ads RQ na tela", () => {
  it("reconhece o produto pelo nome, como o banco", () => {
    expect(isRqProduct("Make  Ads RQ ")).toBe(true);
    expect(isRqProduct("make ads rq")).toBe(true);
    expect(isRqProduct("Make Ads")).toBe(false);
    expect(isRqProduct(null)).toBe(false);
  });
  it("textos da regra", () => {
    const sp = (t: string) => t.replace(/\u00a0/g, " ");
    expect(sp(rqPriceText(config))).toBe("R$ 150,00 por reunião (Reunião qualificada)");
    expect(rqPriceText({ ...config, model: "sale", price_kind: "percent", percent: 7.5 })).toBe("7,5% de cada venda");
    expect(sp(rqContractText(config))).toBe("mínimo de R$ 1.000,00 · teto R$ 5.000,00");
    expect(rqFilterText({ mode: "utm", utm_sources: ["facebook"] })).toBe("Com UTM (utm_source: facebook)");
    expect(rqFilterText({ mode: "crm", sources: [{ id: "1", name: "Meta" }] })).toBe("CRM: origem Meta");
  });
  it("valores digitados em reais", () => {
    expect(rqNumber("1.500,50")).toBe("1500.50");
    expect(rqNumber("150")).toBe("150");
    expect(rqNumber(" ")).toBe("");
    const out = rqInputOut({ ...rqInputFrom(config), unit_price: "150,00", price_kind: "percent", contract_kind: "variable" });
    expect(out).toMatchObject({ unit_price: "150.00", price_kind: "fixed", fixed_amount: "" });
  });
  it("confere antes de salvar", () => {
    expect(rqInputProblem(rqInputFrom(config))).toBe("");
    expect(rqInputProblem({ ...rqInputFrom(config), stage_id: null })).toMatch(/etapa/);
    expect(rqInputProblem({ ...rqInputFrom(config), unit_price: "0" })).toMatch(/reunião/);
    expect(rqInputProblem({ ...rqInputFrom(config), fixed_amount: "" })).toMatch(/mínimo/);
    expect(rqInputProblem({ ...rqInputFrom(config), model: "sale", price_kind: "percent", percent: "120" })).toMatch(/porcentagem/);
  });
  it("meses", () => {
    expect(rqMonthName("2026-09")).toBe("setembro de 2026");
    expect(rqShiftMonth("2026-01", -1)).toBe("2025-12");
    expect(rqMonths(new Date("2026-10-01T02:00:00Z"))).toEqual({ current: "2026-09", previous: "2026-08" });
    expect(rqMonths(new Date("2026-10-05T12:00:00Z")).previous).toBe("2026-09");
  });
});

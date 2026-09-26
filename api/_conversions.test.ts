import { describe, expect, it } from "vitest";
import {
  PHONE_CALLS,
  actionId,
  classifyActions,
  countsByDefault,
} from "./_conversions";

const actions = [
  { id: "1", name: "WhatsApp", category: "CONTACT", conversions: 3.4 },
  {
    id: "2",
    name: "Formulário site",
    category: "SUBMIT_LEAD_FORM",
    conversions: 2.5,
  },
  { id: "3", name: "Tempo no site", category: "DEFAULT", conversions: 30 },
  { id: "4", name: "Compra", category: "PURCHASE", conversions: 1 },
];

describe("ações de conversão do Google que contam", () => {
  it("sem escolha, pela categoria do objetivo e do destino", () => {
    expect(countsByDefault("lead", "external_page", "SUBMIT_LEAD_FORM")).toBe(
      true,
    );
    expect(countsByDefault("lead", "external_page", "DEFAULT")).toBe(false);
    expect(countsByDefault("lead", "external_page", "PAGE_VIEW")).toBe(false);
    expect(countsByDefault("sale", "external_page", "PURCHASE")).toBe(true);
    expect(countsByDefault("sale", "external_page", "SUBMIT_LEAD_FORM")).toBe(
      false,
    );
    // Make page: not the form (its leads come from the Make).
    expect(
      countsByDefault("lead", "make_landing_page", "SUBMIT_LEAD_FORM"),
    ).toBe(false);
    expect(countsByDefault("lead", "make_landing_page", "CONTACT")).toBe(true);
  });
  it("arredonda cada ação e soma as que contam", () => {
    const r = classifyActions("lead", "external_page", actions, 5, null);
    // 3 + 3 (2.5 rounds up); "Outro" and the purchase don't count; calls only when chosen.
    expect(r.counted).toBe(6);
    expect(r.rows.map((x) => [x.id, x.conversions, x.counted])).toEqual([
      ["1", 3, true],
      ["2", 3, true],
      ["3", 30, false],
      ["4", 1, false],
    ]);
    expect(r.callsCounted).toBe(false);
  });
  it("com a escolha do ciclo: só as marcadas, e as ligações se marcadas", () => {
    expect(
      classifyActions("lead", "external_page", actions, 5, ["3"]).counted,
    ).toBe(30);
    expect(
      classifyActions("lead", "external_page", actions, 5, ["2", PHONE_CALLS]),
    ).toMatchObject({ counted: 8, callsCounted: true });
    // An empty choice is no choice.
    expect(
      classifyActions("lead", "external_page", actions, 5, []).counted,
    ).toBe(6);
  });
  it("id da ação a partir do resource name", () => {
    expect(actionId("customers/123/conversionActions/456")).toBe("456");
    expect(actionId(undefined)).toBe("");
  });
});

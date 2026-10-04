import { describe, expect, it } from "vitest";
import {
  crmCounts,
  crmIndex,
  crmKeyLabel,
  crmPipelinePath,
  crmUnmatched,
  withCrm,
  type CrmUtm,
} from "./platform-crm";

const data: CrmUtm = {
  linked: true,
  campaigns: [
    ["[774] [MAKE ADS] [FACEFORMS]", 5, 2, 1, 3000],
    ["Google Pesquisa", 3, 0, 0, 0],
  ],
  adsets: [
    ["[774] [MAKE ADS] [FACEFORMS]", "[001] [H-M] [24-60] [BRASIL]", 4, 2, 1, 3000],
    ["[774] [MAKE ADS] [FACEFORMS]", "[002] [LAL]", 1, 0, 0, 0],
  ],
  ads: [
    ["[774] [MAKE ADS] [FACEFORMS]", "[001] [H-M] [24-60] [BRASIL]", "AD002", 6, 2, 1, 3000],
    ["[774] [MAKE ADS] [FACEFORMS]", "[002] [LAL]", "AD009", 1, 0, 0, 0],
  ],
};
const idx = crmIndex(data)!;

describe("MakeCRM na Plataforma", () => {
  it("liga pelo nome exato, nos três níveis", () => {
    expect(crmCounts(idx, "campaign", { campaign: "[774] [MAKE ADS] [FACEFORMS]" })).toEqual({
      leads: 5,
      wons: 2,
      won_deals: 1,
      revenue: 3000,
    });
    expect(
      crmCounts(idx, "adset", {
        campaign: "[774] [MAKE ADS] [FACEFORMS]",
        term: "[001] [H-M] [24-60] [BRASIL]",
      }).leads,
    ).toBe(4);
    expect(
      crmCounts(idx, "ad", {
        campaign: "[774] [MAKE ADS] [FACEFORMS]",
        term: "[001] [H-M] [24-60] [BRASIL]",
        content: "AD002",
      }).leads,
    ).toBe(6);
    // Maiúsculas e espaços contam, como no CRM.
    expect(crmCounts(idx, "campaign", { campaign: "[774] [make ads] [FACEFORMS]" }).leads).toBe(0);
    expect(crmCounts(idx, "campaign", { campaign: "[774] [MAKE ADS] [FACEFORMS] " }).leads).toBe(0);
  });

  it("sem ligação não há números", () => {
    expect(crmIndex({ linked: false })).toBeNull();
  });

  it("põe os números nas linhas e soma o rodapé", () => {
    const rows = [
      { name: "[774] [MAKE ADS] [FACEFORMS]", metrics: { spend: 1000 } as Record<string, number | null> },
      { name: "Outra", metrics: { spend: 50 } },
    ];
    const out = withCrm(rows, idx, "campaign", (r) => ({ campaign: r.name }));
    expect(out.rows[0].metrics).toEqual({
      spend: 1000,
      crm_leads: 5,
      crm_wons: 2,
      crm_won_deals: 1,
      crm_revenue: 3000,
    });
    expect(out.rows[1].metrics.crm_leads).toBe(0);
    expect(out.totals).toEqual({ crm_leads: 5, crm_wons: 2, crm_won_deals: 1, crm_revenue: 3000 });
  });

  it("lista as UTMs sem linha com o mesmo nome", () => {
    const campaigns = crmUnmatched(idx, "campaign", [{ campaign: "[774] [MAKE ADS] [FACEFORMS]" }]);
    expect(campaigns.map((u) => u.key.campaign)).toEqual(["Google Pesquisa"]);
    // Conjuntos: só dentro das campanhas que aparecem.
    const adsets = crmUnmatched(
      idx,
      "adset",
      [{ campaign: "[774] [MAKE ADS] [FACEFORMS]", term: "[001] [H-M] [24-60] [BRASIL]" }],
      { campaigns: new Set(["[774] [MAKE ADS] [FACEFORMS]"]) },
    );
    expect(adsets.map((u) => crmKeyLabel("adset", u.key))).toEqual([
      "[774] [MAKE ADS] [FACEFORMS] › [002] [LAL]",
    ]);
    expect(crmUnmatched(idx, "adset", [], { campaigns: new Set(["Outra"]) })).toEqual([]);
  });

  it("abre o funil do CRM filtrado como a página Anúncios", () => {
    const path = crmPipelinePath(
      { campaign: "[774] [MAKE ADS]", term: "[001] [H-M]", content: "AD002" },
      "2026-09-27",
      "2026-10-03",
    );
    expect(path.startsWith("/pipeline-v2?")).toBe(true);
    const q = new URLSearchParams(path.split("?")[1]);
    expect(q.get("utmCampaign")).toBe("[774] [MAKE ADS]");
    expect(q.get("utmTerm")).toBe("[001] [H-M]");
    expect(q.get("utmContent")).toBe("AD002");
    expect(q.get("createdFrom")).toBe("2026-09-27T03:00:00.000Z");
    expect(q.get("createdTo")).toBe("2026-10-04T02:59:59.999Z");
    // "Máximo": sem começo.
    expect(crmPipelinePath({ campaign: "X" }, "", "2026-10-03")).not.toContain("createdFrom");
  });
});

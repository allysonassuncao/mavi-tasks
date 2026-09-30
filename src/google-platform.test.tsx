import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  G_PRESETS,
  MENU,
  TEXT_COLUMNS,
  demoGooglePlatform,
  metricColumn,
  type GoogleView,
} from "./google-platform";
import { AdPreview } from "./GooglePlatform";
import { CampaignReportView } from "./CampaignReportView";
import { defaultConfig, metricsFor, type ReportView } from "./campaign-reports";

const q = { account: "1234567890", manager: "", since: "2026-09-01", until: "2026-09-07", campaigns: [], ad_groups: [] };

describe("a plataforma do Google", () => {
  it("o menu tem todas as visões pedidas e as colunas existem", () => {
    const views = MENU.flatMap((g) => g.items.map(([id]) => id));
    for (const v of ["campaigns", "ad_groups", "ads", "assets", "keywords", "search_terms", "negatives", "asset_groups", "age", "gender", "devices", "locations", "day_of_week", "hour", "auction"] as GoogleView[])
      expect(views).toContain(v);
    for (const p of G_PRESETS) for (const id of p.columns) expect(metricColumn.has(id)).toBe(true);
    const cpc = metricColumn.get("cpc")!.value!({ cost: 10, clicks: 4 });
    expect(cpc).toBe(2.5);
    expect(metricColumn.get("conv_rate")!.value!({ conversions: 1, interactions: 4 })).toBe(25);
    expect(TEXT_COLUMNS.keywords.map((c) => c.id)).toContain("quality");
  });
  it("a demonstração segue a campanha e o grupo escolhidos", async () => {
    const p = demoGooglePlatform(["21000001"]);
    const campaigns = await p.list("co", { ...q, view: "campaigns" });
    expect(campaigns.rows[0].id).toBe("21000001");
    const groups = await p.list("co", { ...q, view: "ad_groups", campaigns: ["21000001"] });
    expect(groups.rows.every((r) => r.campaign_id === "21000001")).toBe(true);
    const keywords = await p.list("co", { ...q, view: "keywords", ad_groups: [groups.rows[0].id], segment: "device" });
    expect(keywords.rows.every((r) => r.ad_group_id === groups.rows[0].id)).toBe(true);
    expect(keywords.rows[0].segments?.map((s) => s.label)).toEqual(["Celulares", "Computadores", "Tablets"]);
    const negatives = await p.list("co", { ...q, view: "negatives" });
    expect(negatives.totals).toBeNull();
    const auction = await p.list("co", { ...q, view: "auction" });
    expect(auction.notice).toMatch(/leilão/);
  });
  it("o anúncio de pesquisa como no Google", () => {
    const html = renderToStaticMarkup(
      <AdPreview preview={{ headlines: ["Café especial", "Entrega rápida", "Frete grátis"], descriptions: ["Compre hoje."], path: "norte.com.br/cafe", business: "Norte", images: [], videos: [] }} />,
    );
    expect(html).toContain("Patrocinado");
    expect(html).toContain("Café especial | Entrega rápida | Frete grátis");
    expect(html).toContain("norte.com.br/cafe");
  });
});

describe("o relatório do Google", () => {
  const view: ReportView = {
    platform: "google",
    campaign_name: "Google",
    client_name: "Norte",
    product_name: "Make Ads",
    captured_at: "2026-09-10T12:00:00Z",
    currency: "BRL",
    days: [{ day: "2026-09-01", spend: 100, impressions: 1000, reach: 0, clicks: 50, conversions: 5, view_content: 0, add_to_cart: 0, initiate_checkout: 0 }],
    cycles: [{ start_date: "2026-09-01", end_date: "2026-09-30", objective: "lead", destination: "external_page" }],
    reach: null,
    ad_results: true,
    ads: [{ id: "5~7", name: "Café especial", title: "Café especial | Frete grátis", body: "Compre hoje.", link: "https://www.norte.com.br/x", kind: "Anúncio responsivo de pesquisa", days: [{ d: "2026-09-01", s: 40, i: 400, c: 20, r: 3 }] }],
    adsets: [{ id: "5", name: "Café especial", days: [{ d: "2026-09-01", s: 60, i: 600, c: 30, r: 3 }] }],
    keywords: [{ id: "5~1", name: "[café especial]", kind: "Correspondência exata", adset: "Café especial", days: [{ d: "2026-09-01", s: 30, i: 300, c: 12, r: 2 }] }],
    search_terms: [{ id: "5~t", name: "café especial preço", adset: "Café especial", days: [{ d: "2026-09-01", s: 10, i: 90, c: 4, r: 1 }] }],
  };
  it("padrão com palavras-chave, termos e grupos; sem alcance", () => {
    const c = defaultConfig("lead", "google");
    expect(c.sections).toMatchObject({ ads: true, adsets: true, keywords: true, search_terms: true });
    expect(c.metrics).not.toContain("reach");
    expect(metricsFor(null, "lead", "google").map((m) => m.id)).not.toContain("reach");
  });
  it("mostra o anúncio em texto, os grupos, as palavras-chave e os termos", () => {
    const html = renderToStaticMarkup(
      <CampaignReportView
        title="Google setembro"
        view={view}
        config={defaultConfig("lead", "google")}
        analysis=""
        periodStart="2026-09-01"
        periodEnd="2026-09-01"
      />,
    ).replace(/ /g, " ");
    expect(html).toContain("Patrocinado");
    expect(html).toContain("Café especial | Frete grátis");
    expect(html).toContain("norte.com.br");
    expect(html).toContain("Grupos de anúncios");
    expect(html).toContain("[café especial]");
    expect(html).toContain("Correspondência exata · Café especial");
    expect(html).toContain("Termos de pesquisa");
    expect(html).toContain("café especial preço");
    expect(html).toContain("Ver a página");
    expect(html).not.toContain("Alcance");
  });
});

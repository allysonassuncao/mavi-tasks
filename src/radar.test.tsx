import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientRadarGroups } from "./ClientRadar";
import {
  backfillCost,
  campaignCells,
  change,
  loadAlertRules,
  saveAlertRule,
  clientRadarPath,
  loadItem,
  loadTheme,
  loadThemes,
  mergeThemes,
  radarTaskPreset,
  setItemTheme,
  loadClientRadar,
  loadItems,
  loadOverview,
  occurrencePath,
  overdue,
  saveRadarTopics,
  loadRadarConfig,
  severityName,
  updateItem,
} from "./radar";

// Empresa "demo-agency": os dados de exemplo, sem banco.
const DEMO = "demo-agency";

describe("Radar do cliente (demonstração)", () => {
  it("os cartões contam os abertos, os sérios e os vencidos", async () => {
    const ov = await loadOverview(DEMO);
    const [problems, promises] = ov.topics;
    expect(problems.name).toBe("Problemas / reclamações");
    expect(problems.open).toBe(5);
    expect(problems.severe).toBe(3);
    expect(problems.overdue).toBeNull();
    expect(promises.overdue).toBe(2);
  });

  it("os filtros e a ordem da lista", async () => {
    const ov = await loadOverview(DEMO);
    const topic = ov.topics[0].id;
    const open = await loadItems(DEMO, { topic, statuses: ["aberto", "em_tratamento"] });
    expect(open.total).toBe(5);
    expect(open.items.map((i) => i.title)).toContain("Leads caíram em setembro");
    const byMentions = await loadItems(DEMO, { topic, sort: "mentions", limit: 1 });
    expect(byMentions.total).toBe(6);
    expect(byMentions.items[0].mentions).toBe(2);
    expect((await loadItems(DEMO, { topic, product: "none" })).items.map((i) => i.title)).toEqual([
      "Demora para responder no grupo",
    ]);
    expect((await loadItems(DEMO, { q: "logo" })).total).toBe(2);
  });

  it("a aba do cliente mostra os itens por tópico, e os fechados só quando pedidos", async () => {
    const data = await loadClientRadar(DEMO, "cl-1");
    const html = renderToStaticMarkup(<ClientRadarGroups data={data} closed={false} onOpen={() => {}} />);
    expect(html).toContain("Problemas / reclamações");
    expect(html).toContain("Leads caíram em setembro");
    expect(html).toContain("Enviar o relatório de campanhas");
    expect(html).not.toContain("Poucos stories na semana");
    expect(html).toMatch(/2 em aberto · 3 no total|1 em aberto · 2 no total/);
    const all = renderToStaticMarkup(<ClientRadarGroups data={data} closed onOpen={() => {}} />);
    expect(all).toContain("Poucos stories na semana");
    expect(all).toContain("Resolvido");
  });

  it("editar muda o item e os links abrem o momento da reunião ou a mensagem", async () => {
    const item = await updateItem(DEMO, "demo-1", { status: "resolvido", severity: 3 });
    expect(item.status).toBe("resolvido");
    expect(severityName(item.topic, item.severity)).toBe("Crítica");
    const meeting = item.occurrences.find((o) => o.source_type === "meeting")!;
    expect(occurrencePath(meeting)).toBe("/drive?gravacao=demo&t=312");
    const wa = item.occurrences.find((o) => o.source_type === "whatsapp")!;
    expect(occurrencePath(wa)).toBe("/drive?whatsapp=demo-group");
    expect(clientRadarPath("x")).toBe("/drive?radar=x");
  });

  it("prazo passado de item aberto é vencido; fechado não", async () => {
    const ov = await loadOverview(DEMO);
    const promises = ov.topics[1];
    expect(overdue(promises, { due_date: "2020-01-01", status: "pendente" })).toBe(true);
    expect(overdue(promises, { due_date: "2020-01-01", status: "cumprida" })).toBe(false);
    expect(overdue(promises, { due_date: null, status: "pendente" })).toBe(false);
  });

  it("salvar tópicos cria o novo com chaves para os status e campos", async () => {
    const cfg = await loadRadarConfig(DEMO);
    const next = await saveRadarTopics(DEMO, [
      ...cfg.topics,
      {
        ...cfg.topics[0],
        id: undefined,
        key: undefined,
        name: "Pedidos de novos serviços",
        fields: [{ label: "Valor", type: "number", options: [] }],
      },
    ]);
    const novo = next.topics.find((t) => t.name === "Pedidos de novos serviços")!;
    expect(novo.id).toBeTruthy();
    expect(novo.fields[0].key).toBe("campo_1");
    expect(novo.statuses.every((s) => s.key)).toBe(true);
  });

  it("os temas contam clientes e itens; mover e juntar", async () => {
    const ov = await loadOverview(DEMO);
    const topic = ov.topics[0].id;
    const page = await loadThemes(DEMO, { topic });
    expect(page.themes.map((t) => [t.title, t.clients, t.open_items])).toEqual([
      // O item da Aurora foi resolvido no teste de edição acima.
      ["Queda na quantidade e na qualidade dos leads", 2, 1],
      ["Artes com a marca errada", 1, 1],
    ]);
    expect(page.pending).toBe(3);
    const moved = await setItemTheme(DEMO, "demo-10", { theme: "demo-theme-leads" });
    expect(moved.theme_title).toBe("Queda na quantidade e na qualidade dos leads");
    expect(moved.theme_locked).toBe(true);
    const created = await setItemTheme(DEMO, "demo-3", { title: "Demora no atendimento" });
    expect(created.theme_title).toBe("Demora no atendimento");
    const theme = await loadTheme(DEMO, "demo-theme-leads");
    expect(theme.items.map((i) => i.id).sort()).toEqual(["demo-1", "demo-10", "demo-9"]);
    // Juntar temas de produtos diferentes não acontece na tela (só os do mesmo tópico e produto aparecem).
    expect(theme.others).toEqual([]);
    const merged = await mergeThemes(DEMO, "demo-theme-leads", []);
    expect(merged.items).toHaveLength(3);
  });

  it("a tarefa a partir do item leva as falas, o link do item e o prazo da promessa", async () => {
    const item = await loadItem(DEMO, "demo-5");
    const data = {
      members: [{ company_id: "c", user_id: "u", name: "Ana", role: "admin", active: true }],
      contracts: [
        { id: "k-social", client_id: "cl-1", product_id: "pd-3", archived: false },
        { id: "k-trafego", client_id: "cl-1", product_id: "pd-1", archived: false },
      ],
      clients: [{ id: "cl-1", name: "4282", archived: false }],
      teamMembers: [],
      clientTeams: [],
    } as unknown as Parameters<typeof radarTaskPreset>[1];
    // Os links levam a empresa do endereço atual.
    (globalThis as { window?: unknown }).window = { location: { pathname: "/agencias/make/radar" } };
    const preset = radarTaskPreset(item, data, "u")!;
    expect(preset.contract).toBe("k-trafego");
    expect(preset.title).toBe("Enviar o relatório de campanhas");
    expect(preset.due).toBe(item.due_date);
    expect(preset.description).toContain("Até sexta te mando o relatório completo.");
    expect(preset.description).toContain("/agencias/make/drive?radar=cl-1&item=demo-5");
    expect(radarTaskPreset(item, { ...data, members: [] }, "u")).toBeNull();
    delete (globalThis as { window?: unknown }).window;
  });

  it("custo do histórico: pelo custo médio das leituras feitas, ou pelo texto e o preço", () => {
    const base = {
      from: "2026-06-01",
      until: "2026-08-31",
      oldest: "2026-01-10",
      meetings: 10,
      whatsapp_days: 100,
      meeting_chars: 350_000,
      whatsapp_chars: 350_000,
      avg_meeting_cost: 0.1,
      avg_whatsapp_cost: 0.01,
      samples: 50,
      price: null,
    };
    const measured = backfillCost(base);
    expect(measured.signals).toBe(110);
    expect(measured.measured).toBe(true);
    // (10 × 0,10 + 100 × 0,01) × 1,1 = 2,2; faixa de ±30%.
    expect(measured.low).toBeCloseTo(1.54, 5);
    expect(measured.high).toBeCloseTo(2.86, 5);
    const guessed = backfillCost({ ...base, samples: 2, price: { input: 1, output: 5 } });
    expect(guessed.measured).toBe(false);
    // 700 mil caracteres / 3,5 + 110 × 3.500 = 585 mil de entrada; 77 mil de saída.
    const total = ((200_000 + 385_000) / 1e6) * 1 + (77_000 / 1e6) * 5;
    expect(guessed.low).toBeCloseTo(total * 1.1 * 0.7, 5);
    expect(backfillCost({ ...base, meetings: 0, whatsapp_days: 0 }).high).toBe(0);
  });

  it("os avisos do Radar ficam guardados por pessoa (demonstração)", async () => {
    const before = await loadAlertRules(DEMO);
    const after = await saveAlertRule(DEMO, {
      name: "Prazos da Forma",
      topic_id: null,
      product_id: null,
      product_none: true,
      client_id: null,
      team_id: null,
      min_severity: null,
      events: ["due_soon", "overdue"],
      channel: "digest",
      active: true,
    });
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)!.labels!.product).toBe("Geral / Agência");
  });
});

describe("Radar × Campanhas no relatório", () => {
  it("a campanha em textos curtos: meta, custo × meta, gasto × esperado e o período", () => {
    const cells = campaignCells({
      name: "Captação",
      platform: "meta",
      product: "Make Ads",
      status: "inactive",
      objective: "lead",
      cycle: { start: "2026-09-01", end: "2026-09-30", days: 30, elapsed: 30, goal: 120, budget: 4500, spent: 4230, results: 71, cost: 59.58, goal_cost: 37.5, expected: 4500, status: "bad" },
      period: { spend: 4230, results: 71, impressions: 1, clicks: 1, cost: 59.58 },
      previous: { spend: 4410, results: 118, cost: 37.37 },
    });
    expect(cells.meta).toBe("Meta · Make Ads · inativa");
    expect(cells.goal).toBe("71 de 120 leads");
    expect(cells.cycle).toBe("01/09 a 30/09 · dia 30 de 30");
    expect(cells.cost).toMatch(/^CPL R\$\s59,58 × R\$\s37,50$/);
    expect(cells.spend).toMatch(/^R\$\s4\.230,00 de R\$\s4\.500,00 · esperado R\$\s4\.500,00$/);
    expect(cells.period).toMatch(/^71 leads · R\$\s4\.230,00 · -40% vs\. anterior$/);
    expect(change(5, 0)).toBeNull();
    expect(change(12, 10)).toBe("+20%");
  });
});

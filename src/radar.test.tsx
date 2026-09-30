import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientRadarGroups } from "./ClientRadar";
import {
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
});

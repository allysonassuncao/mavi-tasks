import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientRadarGroups } from "./ClientRadar";
import {
  clientRadarPath,
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
    expect(problems.open).toBe(3);
    expect(problems.severe).toBe(2);
    expect(problems.overdue).toBeNull();
    expect(promises.overdue).toBe(2);
  });

  it("os filtros e a ordem da lista", async () => {
    const ov = await loadOverview(DEMO);
    const topic = ov.topics[0].id;
    const open = await loadItems(DEMO, { topic, statuses: ["aberto", "em_tratamento"] });
    expect(open.total).toBe(3);
    expect(open.items.map((i) => i.title)).toContain("Leads caíram em setembro");
    const byMentions = await loadItems(DEMO, { topic, sort: "mentions", limit: 1 });
    expect(byMentions.total).toBe(4);
    expect(byMentions.items[0].mentions).toBe(2);
    expect((await loadItems(DEMO, { topic, product: "none" })).items.map((i) => i.title)).toEqual([
      "Demora para responder no grupo",
    ]);
    expect((await loadItems(DEMO, { q: "logo" })).total).toBe(2);
  });

  it("a aba do cliente mostra os itens por tópico, e os fechados só quando pedidos", async () => {
    const data = await loadClientRadar(DEMO, "demo-client-1");
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
});

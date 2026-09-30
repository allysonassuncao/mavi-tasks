import { describe, expect, it, vi } from "vitest";
import { radarLine, runTool, summarizeStep, type RadarAiRow, type ToolContext } from "./_ai-tools";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const meeting = "00000000-0000-4000-8000-0000000000e1";
const group = "00000000-0000-4000-8000-0000000000e3";
const message = "00000000-0000-4000-8000-0000000000e4";

function database(data: unknown) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init?.headers).get("Authorization"),
    });
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const ctx = (fetchImpl: typeof fetch, scope = {}): ToolContext => ({
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  fetch: fetchImpl,
  auth: "Bearer pessoa",
  company,
  scope,
  embed: vi.fn(),
  members: new Map(),
  clients: new Map([[client, "4282"]]),
  today: "2026-09-30",
  usage: { embeddingTokens: 0, embeddingModel: "" },
  sources: [],
  chunks: new Map(),
});

const row: RadarAiRow = {
  scope: "client",
  leader: false,
  today: "2026-09-30",
  started_at: "2026-09-01T12:00:00Z",
  topics: [
    { key: "problemas", name: "Problemas / reclamações", has_due: false, open: 3, severe: 1, overdue: 0, new_30d: 4, closed_30d: 1, clients: 1 },
    { key: "promessas", name: "Promessas", has_due: true, open: 2, severe: 0, overdue: 1, new_30d: 2, closed_30d: 0, clients: 1 },
  ],
  items: [
    {
      id: "i1",
      topic: "Problemas / reclamações",
      client_id: client,
      client: "4282",
      product: "Make Ads",
      title: "Leads caíram",
      summary: "Reclamou da queda.",
      status: "Aberto",
      closed: false,
      severity: "Alta",
      due_date: null,
      overdue: false,
      mentions: 3,
      first_seen: "2026-09-10T12:00:00Z",
      last_seen: "2026-09-28T12:00:00Z",
      theme: "Queda de leads",
      assignee: null,
      quote: { text: "os leads caíram muito", speaker: "Carlos", role: "client", source_type: "meeting", source_id: meeting, group_id: null, message_id: null, at_seconds: 312, occurred_at: "2026-09-28T12:05:12Z", title: "Alinhamento" },
    },
    {
      id: "i2",
      topic: "Promessas",
      client_id: client,
      client: "4282",
      product: "Make Ads",
      title: "Enviar o relatório",
      summary: "",
      status: "Pendente",
      closed: false,
      severity: null,
      due_date: "2026-09-26",
      overdue: true,
      mentions: 1,
      first_seen: "2026-09-24T12:00:00Z",
      last_seen: "2026-09-24T12:00:00Z",
      theme: null,
      assignee: "Bruno",
      quote: { text: "até sexta te mando", speaker: "Bruno", role: "team", source_type: "whatsapp", source_id: "day", group_id: group, message_id: message, at_seconds: null, occurred_at: "2026-09-24T14:00:00Z", title: 'Grupo "4282"' },
    },
  ],
  total: 5,
  themes: [{ title: "Queda de leads", topic: "Problemas / reclamações", product: "Make Ads", clients: 4, open: 5, client_names: ["4282", "5120"] }],
  report: null,
};

describe("o Radar na conversa com a MAVI", () => {
  it("com o cliente: números, itens com a última fala citada (no momento da reunião ou na mensagem) e temas", async () => {
    const { fetchImpl, calls } = database(row);
    const c = ctx(fetchImpl, { client });
    const out = await runTool(c, "client_radar", { topic: "problemas", limit: 5 });
    expect(out).toMatch(/^Radar do cliente 4282 \(lendo desde 01\/09\/2026\):/);
    expect(out).toMatch(/- Problemas \/ reclamações: 3 em aberto \(1 sério\) · 4 novos e 1 fechados em 30 dias/);
    expect(out).toMatch(/- Promessas: 2 em aberto · 1 com prazo vencido/);
    expect(out).toMatch(/- \[S1\] Leads caíram — Problemas \/ reclamações · Make Ads · Aberto · Alta · sem responsável · 3 vezes, desde 10\/09\/2026, última em 28\/09\/2026 · tema "Queda de leads"/);
    expect(out).toMatch(/Última fala \(Carlos, cliente, 28\/09\/2026\): "os leads caíram muito"/);
    expect(out).toMatch(/- \[S2\] Enviar o relatório — .*prazo 26\/09\/2026 \(vencido\) · responsável Bruno/);
    expect(out).toMatch(/Temas em que este cliente aparece.*\n- Queda de leads · Problemas \/ reclamações · Make Ads · 4 clientes \(4282, 5120\) · 5 em aberto/);
    expect(c.sources.map((s) => [s.type, s.id, s.start, s.group])).toEqual([
      ["meeting", meeting, 312, undefined],
      ["whatsapp", message, undefined, group],
    ]);
    expect(calls[0].auth).toBe("Bearer pessoa");
    expect(calls[0].body).toMatchObject({ p_company: company, p_client: client, p_topic: "problemas", p_status: "open", p_limit: 5 });
    expect(summarizeStep("client_radar", out)).toBe("2 itens");
  });

  it("sem cliente: a carteira e o último relatório do Radar", async () => {
    const { fetchImpl, calls } = database({
      ...row,
      scope: "portfolio",
      leader: true,
      report: {
        title: "Semanal",
        period_from: "2026-09-22",
        period_to: "2026-09-28",
        finished_at: "2026-09-29T11:00:00Z",
        headline: "Atrasos em Make Ads.",
        summary: "Cinco clientes.",
        actions: [{ priority: "alta", text: "Revisar a aprovação", product: "Make Ads" }],
      },
    });
    const out = await runTool(ctx(fetchImpl), "client_radar", { status: "all" });
    expect(out).toMatch(/^Radar da carteira que você acessa/);
    expect(out).toMatch(/· 1 clientes com itens em aberto/);
    expect(out).toMatch(/- \[S1\] Leads caíram — Problemas \/ reclamações · cliente 4282 ·/);
    expect(out).toMatch(/Último relatório do Radar \("Semanal", 22\/09\/2026 a 28\/09\/2026, pronto em 29\/09\/2026\): Atrasos em Make Ads\. Cinco clientes\./);
    expect(out).toMatch(/- Ação \(alta\): Revisar a aprovação \(Make Ads\)/);
    expect(calls[0].body).toMatchObject({ p_client: null, p_status: "all" });
  });

  it("sem nada anotado ainda, explica desde quando o Radar lê", async () => {
    const { fetchImpl } = database({ ...row, topics: [], items: [], themes: [] });
    const out = await runTool(ctx(fetchImpl, { client }), "client_radar", {});
    expect(out).toMatch(/O Radar ainda não anotou nada do cliente 4282 \(ele lê as reuniões e os grupos desde 01\/09\/2026/);
  });

  it("a linha do contexto no cliente resume o que está em aberto", () => {
    expect(radarLine(row)).toBe(
      "Radar do cliente (o que a MAVI anotou nas reuniões e nos grupos): Problemas / reclamações: 3 em aberto (1 sério); Promessas: 2 em aberto · 1 com prazo vencido. Em aberto: Problemas / reclamações: Leads caíram (Alta); Promessas: Enviar o relatório (vencida). Para os detalhes e as falas, use client_radar.",
    );
    expect(radarLine(null)).toBe("");
    expect(radarLine({ ...row, topics: [] })).toBe("");
  });
});

import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { seal } from "./_google";
import { newMeter } from "./_social-leads";
import {
  applyCheck,
  checkQuestions,
  clipLines,
  extractionMessage,
  handleRadarWorker,
  parseCandidates,
  parseThemes,
  runRadar,
  themesMessage,
  type ThemeGroup,
  type RadarMaterial,
  type RadarTopic,
} from "./_radar";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const signal = "00000000-0000-4000-8000-0000000000a1";
const trafego = "00000000-0000-4000-8000-0000000000f1";
const social = "00000000-0000-4000-8000-0000000000f2";
const existing = "00000000-0000-4000-8000-0000000000e1";
const msg1 = "00000000-0000-4000-8000-0000000000c1";
const msg2 = "00000000-0000-4000-8000-0000000000c2";
const provider = "00000000-0000-4000-8000-000000000800";
const providerKey = crypto.randomBytes(32);
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-haiku-4-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey,
  imageModel: "gpt-image-1",
};
const embed = vi.fn();

const levels = ["Baixa: x", "Média: x", "Alta: x", "Crítica: x"];
const problems: RadarTopic = {
  id: "00000000-0000-4000-8000-0000000000d1",
  key: "problemas",
  name: "Problemas / reclamações",
  description: "Reclamações do cliente sobre a agência.",
  exclude: "Dúvidas simples.",
  speaker: "client",
  has_due: false,
  severity: true,
  severity_label: "Gravidade",
  severity_levels: levels,
  fields: [],
  products: [trafego, social],
};
const promises: RadarTopic = {
  id: "00000000-0000-4000-8000-0000000000d2",
  key: "promessas",
  name: "Promessas",
  description: "Compromissos do time com o cliente.",
  exclude: "",
  speaker: "team",
  has_due: true,
  severity: true,
  severity_label: "Importância",
  severity_levels: levels,
  fields: [{ key: "canal", label: "Canal", type: "choice", options: ["WhatsApp", "E-mail"] }],
  products: [trafego],
};
const material = (): RadarMaterial => ({
  id: signal,
  company_id: company,
  client_id: client,
  source_type: "whatsapp",
  client_name: "4282",
  title: 'Grupo "4282 - Tráfego"',
  date: "12/09/2026",
  products: [
    { id: social, name: "Social" },
    { id: trafego, name: "Tráfego" },
  ],
  group_products: [trafego],
  topics: [problems, promises],
  items: [
    {
      id: existing,
      topic_id: problems.id,
      title: "Logo errado na arte",
      product_id: social,
      status: "Resolvido",
      closed: true,
      last_seen: "01/09/2026",
    },
  ],
  lines: [
    { role: "client", who: "Carlos", text: "Os leads caíram muito essa semana.", msg: msg1, at: "09:01" },
    { role: "team", who: "Bruno", text: "Até sexta te mando o relatório por e-mail.", msg: msg2, at: "09:02" },
    { role: "team", who: "Bruno", text: "O cliente está bravo com o logo.", at: "09:03" },
  ],
  context: [{ role: "client", who: "Carlos", text: "Bom dia", at: "08:00" }],
  seen: [msg1, msg2],
});

describe("o material para a MAVI", () => {
  it("numera tópicos, produtos, itens e falas, com o contexto à parte", () => {
    const { text, refs } = extractionMessage(material());
    expect(text).toMatch(/T1 · Problemas \/ reclamações\n {2}Conta: Reclamações/);
    expect(text).toMatch(/Quem fala: só falas do cliente/);
    expect(text).toMatch(/T2 · Promessas \(vale nos produtos P2 e em "geral"\)/);
    expect(text).toMatch(/Campos extras \(fields\): "canal" = Canal \(uma de: WhatsApp \| E-mail\)/);
    expect(text).toMatch(/o grupo é do\(s\) produto\(s\) P2/);
    expect(text).toMatch(/I1 · T1 · P1 · Resolvido \(fechado\) · visto em 01\/09\/2026: Logo errado na arte/);
    expect(text).toMatch(/Mensagens já lidas do dia[^\n]*\n08:00 \[cliente\] Carlos: Bom dia/);
    expect(text).toMatch(/L2 09:02 \[time\] Bruno: Até sexta/);
    expect(refs.products.get("P2")).toBe(trafego);
    expect(refs.lines.get("L1")?.msg).toBe(msg1);
  });

  it("transcrição longa fica com o começo e o fim, sem mudar as referências", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      role: "client" as const,
      who: "C",
      text: `fala ${i} `.padEnd(160, "x"),
      t: i * 10,
    }));
    const shown = clipLines(lines, 4000);
    expect(shown.length).toBeLessThan(100);
    expect(shown[0].i).toBe(0);
    expect(shown[shown.length - 1].i).toBe(99);
    const { text } = extractionMessage({ ...material(), source_type: "meeting", lines, context: [] }, 4000);
    expect(text).toMatch(/\[… falas do meio omitidas …\]/);
    expect(text).toMatch(/L100 16:30 \[cliente\] C: fala 99/);
  });
});

describe("os itens da MAVI", () => {
  const answer = JSON.stringify({
    items: [
      {
        topic: "T1",
        item: null,
        title: "Leads caíram na semana",
        summary: "O cliente reclamou da queda.",
        product: "P2",
        lines: [{ ref: "L1", quote: "Os leads caíram muito" }],
      },
      // Reclamação dita pelo time: não é do cliente.
      { topic: "T1", title: "Cliente bravo com o logo", product: "geral", lines: [{ ref: "L3" }] },
      {
        topic: "T2",
        title: "Enviar o relatório",
        product: "P1",
        lines: [{ ref: "L2", quote: "trecho que não está na fala" }],
        due: "2026-09-18",
        fields: { canal: "E-mail", outro: "x" },
      },
      // O item existente, duas vezes: vira uma ocorrência só.
      { topic: "T1", item: "I1", title: "Logo", lines: ["L1"] },
      { topic: "T1", item: "I1", title: "Logo", lines: [{ ref: "L1", quote: "caíram" }] },
      { topic: "T9", title: "Tópico que não existe", lines: ["L1"] },
      { topic: "T1", title: "Sem fala", lines: [{ ref: "L99" }] },
    ],
  });

  it("troca as referências, respeita quem fala e junta o item existente", () => {
    const { refs } = extractionMessage(material());
    const list = parseCandidates(`Aqui está:\n${answer}`, refs);
    expect(list.map((c) => c.title)).toEqual(["Leads caíram na semana", "Enviar o relatório", "Logo"]);
    const [leads, report, logo] = list;
    expect(leads.product_id).toBe(trafego);
    expect(leads.lines[0]).toMatchObject({ quote: "Os leads caíram muito", line: { msg: msg1 } });
    expect(leads.speaker_confirmed).toBe(true);
    // Promessas só valem em Tráfego: P1 (Social) vira Geral.
    expect(report.product_id).toBeNull();
    expect(report.due_date).toBe("2026-09-18");
    expect(report.fields).toEqual({ canal: "E-mail" });
    expect(report.lines[0].quote).toBe("Até sexta te mando o relatório por e-mail.");
    expect(logo.item_id).toBe(existing);
    expect(logo.lines).toHaveLength(2);
  });

  it("o Jev tira o que não é do tópico e dá a gravidade", () => {
    const { refs } = extractionMessage(material());
    const list = parseCandidates(answer, refs);
    const q = checkQuestions(list);
    expect(Object.keys(q)).toEqual(["ok_1", "sev_1", "ok_2", "sev_2", "ok_3", "sev_3"]);
    expect(q.sev_2).toMatchObject({ type: "score", criteria: levels });
    const kept = applyCheck(list, {
      answers: {
        ok_1: { noul: 0.9 },
        sev_1: { score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } },
        ok_2: { noul: 0.1 },
        sev_3: { score: 1, probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 } },
      },
    });
    expect(kept.map((c) => [c.title, c.severity])).toEqual([
      ["Leads caíram na semana", 3],
      ["Logo", 1],
    ]);
  });

  it("sem JSON, a leitura falha (e volta para a fila)", () => {
    const { refs } = extractionMessage(material());
    expect(() => parseCandidates("não achei nada", refs)).toThrow(/não devolveu JSON/);
  });
});

function database(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    if (!key) return new Response("[]", { status: 200 });
    const value = routes[key];
    const data = typeof value === "function" ? (value as (b: any) => unknown)(body) : value;
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("worker do Radar", () => {
  it("recusa sem o segredo", async () => {
    const res = await handleRadarWorker("Bearer errado", env, { fetch: vi.fn() as any, llm: vi.fn(), embed });
    expect(res.status).toBe(401);
  });

  it("lê com a MAVI, confere com o Jev, grava e soma o custo; Jev fora do ar não trava", async () => {
    let claims = 0;
    const jevRoute = {
      provider_id: provider,
      provider: "OpenRouter",
      kind: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      key_cipher: seal(providerKey, "sk-or"),
      model: "~typesafe/jev-latest",
      price: { id: "~typesafe/jev-latest", input: 0.042, output: 0 },
    };
    let decisions = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_radar_claim": () =>
        claims++ < 2 ? [{ id: signal, company_id: company, client_id: client, source_type: "whatsapp" }] : [],
      "rpc/ai_radar_material": material(),
      "rpc/ai_worker_route": null,
      "rpc/ai_radar_config": { jev: jevRoute },
      "rpc/ai_radar_store": 1,
      // A primeira conferência responde; a segunda encontra o Jev fora do ar.
      "alpha/decisions": () =>
        decisions++ > 0
          ? new Response("erro", { status: 500 })
          : {
              model: "typesafe/jev-1.13",
              answers: { ok_1: { noul: 0.95 }, sev_1: { score: 2, probabilities: { 2: 1 } } },
              usage: { input_tokens: 800, cost: 0.00004 },
            },
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toMatch(/Você é a MAVI/);
      expect(req.messages[0].content).toMatch(/Mensagens novas:/);
      const meter = newMeter("claude-haiku-4-5");
      meter.input = 5000;
      meter.output = 300;
      meter.cost = 0.01;
      return {
        text: JSON.stringify({
          items: [{ topic: "T1", title: "Leads caíram", product: "P2", lines: [{ ref: "L1", quote: "Os leads caíram" }] }],
        }),
        meter,
        rounds: 1,
      };
    });
    let t = 0;
    const stats = await runRadar(
      { ...env, radarBudgetMs: 400_000 },
      {
        fetch: fetchImpl,
        llm,
        embed,
        // Cada volta do laço anda um minuto.
        now: () => (t += 60_000),
      },
    );
    expect(stats).toEqual({ signals: 2, items: 2, skipped: 0, failed: 0, themed: 0 });
    const stores = calls.filter((c) => c.url.includes("rpc/ai_radar_store"));
    expect(stores).toHaveLength(2);
    const [first, second] = stores.map((s) => s.body.p_result);
    expect(first.items[0]).toMatchObject({
      topic_id: problems.id,
      product_id: trafego,
      severity: 2,
      mentions: [{ quote: "Os leads caíram", role: "client", speaker: "Carlos", message_id: msg1 }],
    });
    expect(first.seen).toEqual([msg1, msg2]);
    expect(first.usage.map((u: any) => u.kind)).toEqual(["radar", "radar_check"]);
    expect(first.usage[1]).toMatchObject({ provider: "OpenRouter", input: 800 });
    // Sem o Jev: o item entra sem gravidade.
    expect(second.items[0].severity).toBeNull();
    expect(second.usage.map((u: any) => u.kind)).toEqual(["radar"]);
    expect(calls.filter((c) => c.url.includes("rpc/ai_radar_fail"))).toHaveLength(0);
  });

  it("resposta sem JSON vai para ai_radar_fail", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_radar_claim": () =>
        claims++ === 0 ? [{ id: signal, company_id: company, client_id: client, source_type: "whatsapp" }] : [],
      "rpc/ai_radar_material": material(),
      "rpc/ai_worker_route": null,
      "rpc/ai_radar_config": { jev: null },
    });
    const llm: LlmAdapter = vi.fn(async () => ({ text: "sem nada", meter: newMeter("x"), rounds: 1 }));
    const stats = await runRadar({ ...env, radarBudgetMs: 400_000 }, { fetch: fetchImpl, llm, embed });
    expect(stats.failed).toBe(1);
    const fail = calls.find((c) => c.url.includes("rpc/ai_radar_fail"));
    expect(fail?.body).toMatchObject({ p_id: signal, p_error: "A MAVI não devolveu JSON." });
  });
});

describe("temas do Radar", () => {
  const group: ThemeGroup = {
    company_id: company,
    topic_id: problems.id,
    product_id: trafego,
    topic: { name: "Problemas / reclamações", description: "Reclamações do cliente." },
    product_name: "Tráfego",
    items: [
      { id: "00000000-0000-4000-8000-0000000001a1", title: "Atraso na aprovação", summary: "x", client: "4282" },
      { id: "00000000-0000-4000-8000-0000000001a2", title: "Aprovação demorada", summary: "", client: "5120" },
      { id: "00000000-0000-4000-8000-0000000001a3", title: "Leads ruins", summary: "", client: "4282" },
    ],
    themes: [
      { id: "00000000-0000-4000-8000-0000000002b1", title: "Leads de baixa qualidade", summary: "s", items: 4, clients: 3 },
    ],
  };

  it("a mensagem numera temas e itens com o cliente", () => {
    const text = themesMessage(group);
    expect(text).toMatch(/Produto: Tráfego\./);
    expect(text).toMatch(/H1 · Leads de baixa qualidade \(4 itens, 3 clientes\) — s/);
    expect(text).toMatch(/I2 · cliente 5120: Aprovação demorada/);
  });

  it("troca as referências; item repetido, tema inexistente e tema novo sem nome saem", () => {
    const decided = parseThemes(
      JSON.stringify({
        assign: [
          { item: "I1", theme: "N1" },
          { item: "I2", theme: "N1" },
          { item: "I3", theme: "H1" },
          { item: "I3", theme: "N1" },
          { item: "I9", theme: "H1" },
          { item: "I1", theme: "H7" },
        ],
        new: [
          { ref: "N1", title: "Atraso na aprovação de criativos", summary: "Clientes esperam." },
          { ref: "N2", title: "x" },
        ],
        update: [{ theme: "H1", summary: "Novo resumo" }, { theme: "H5", summary: "?" }],
      }),
      group,
    );
    expect(decided.new).toEqual([{ ref: "N1", title: "Atraso na aprovação de criativos", summary: "Clientes esperam." }]);
    expect(decided.assign).toEqual([
      { item_id: group.items[0].id, ref: "N1" },
      { item_id: group.items[1].id, ref: "N1" },
      { item_id: group.items[2].id, theme_id: group.themes[0].id },
    ]);
    expect(decided.update).toEqual([{ theme_id: group.themes[0].id, summary: "Novo resumo" }]);
  });

  it("o worker agrupa depois das leituras e grava com o custo", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_radar_claim": [],
      "rpc/ai_radar_theme_claim": () => (claims++ === 0 ? [group] : []),
      "rpc/ai_worker_route": null,
      "rpc/ai_radar_theme_store": 2,
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toMatch(/temas/);
      const meter = newMeter("claude-haiku-4-5");
      meter.cost = 0.002;
      return {
        text: JSON.stringify({
          assign: [{ item: "I1", theme: "N1" }, { item: "I2", theme: "N1" }],
          new: [{ ref: "N1", title: "Atraso na aprovação" }],
        }),
        meter,
        rounds: 1,
      };
    });
    const stats = await runRadar({ ...env, radarBudgetMs: 400_000 }, { fetch: fetchImpl, llm, embed });
    expect(stats.themed).toBe(2);
    const store = calls.find((c) => c.url.includes("rpc/ai_radar_theme_store"))!;
    expect(store.body.p_result).toMatchObject({
      company_id: company,
      topic_id: problems.id,
      product_id: trafego,
      claimed: group.items.map((i) => i.id),
      new: [{ ref: "N1", title: "Atraso na aprovação" }],
      usage: { cost: 0.002 },
    });
    expect(store.body.p_result.assign).toHaveLength(2);
  });
});

import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import {
  parseRuleOps,
  ruleText,
  rulesMessage,
  runTaskRules,
  type RuleCheck,
  type RulesClaim,
} from "./_radar-task-rules";

const company = "00000000-0000-4000-8000-000000000001";
const topic = "00000000-0000-4000-8000-0000000000d1";
const product = "00000000-0000-4000-8000-0000000000a1";
const [s1, s2, s3, s4] = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`);
const traffic = "00000000-0000-4000-8000-0000000000f1";
const design = "00000000-0000-4000-8000-0000000000f2";
const bruno = "00000000-0000-4000-8000-0000000000b1";
const rule = "00000000-0000-4000-8000-0000000000e1";
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-haiku-4-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: crypto.randomBytes(32),
  imageModel: "gpt-image-1",
};

const claim: RulesClaim = {
  company,
  product_key: product,
  topic: {
    id: topic,
    name: "Problemas / reclamações",
    description: "Reclamações do cliente.",
    statuses: [
      { label: "Aberto", kind: "open" },
      { label: "Resolvido", kind: "closed" },
    ],
  },
  product: { id: product, name: "Make Ads" },
  signals: [
    {
      id: s1,
      kind: "created",
      at: "05/10/2026",
      title: "Leads sem telefone",
      summary: "O formulário perdeu o campo",
      severity: 2,
      client: "Clínica Sorriso",
      task_title: "Corrigir o formulário",
      team_id: traffic,
      by_team: true,
      assignee_id: bruno,
      due_days: 2,
      priority: "high",
      changed: ["title"],
      from_item: true,
      preset_title: "Leads sem telefone",
    },
    { id: s2, kind: "linked", at: "04/10/2026", title: "Pixel fora do ar", severity: 3, team_id: traffic, due_days: 1 },
    { id: s3, kind: "no_task", at: "03/10/2026", title: "Dúvida de boleto", severity: 0, closed_as: "Descartado", by_mavi: true, reopened: true },
    { id: s4, kind: "created", at: "02/10/2026", title: "Campanha parada", severity: 2, team_id: traffic, from_item: true },
  ],
  teams: [
    { id: design, name: "Design" },
    { id: traffic, name: "Tráfego", product: true },
  ],
  people: [{ id: bruno, name: "Bruno" }],
  rules: [{ id: rule, action: "task", condition: "Problema de captação", team_id: traffic, due_days: 2, status: "suggested", origin: "mavi" }],
};

describe("regras das tarefas do Radar · material", () => {
  it("troca os ids por referências curtas e conta o que tem e o que não tem tarefa", () => {
    const { text, refs } = rulesMessage(claim);
    expect(text).toContain("Produto: Make Ads");
    expect(text).toContain("T2 Tráfego (atende o produto)");
    expect(text).toContain("P1 Bruno");
    expect(text).toContain("R1 [sugerida, esperando um líder, da MAVI] Quando: Problema de captação → abrir tarefa, para T2 Tráfego, prazo 2 dias úteis");
    expect(text).toContain("Registros (3 com tarefa, 1 fechados sem tarefa");
    expect(text).toContain(
      'S1 · 05/10/2026 · TAREFA CRIADA · [gravidade alta] "Leads sem telefone" — O formulário perdeu o campo · cliente Clínica Sorriso → tarefa "Corrigir o formulário" · para equipe T2 Tráfego (enviada à equipe), pessoa P1 Bruno · prazo 2 dias úteis · prioridade alta · mudou: título · título que veio: "Leads sem telefone"',
    );
    expect(text).toContain("S3 · 03/10/2026 · FECHADO SEM TAREFA");
    expect(text).toContain("fechado como Descartado (pela MAVI) · REABRIU depois");
    expect(text).toContain("S4 · 02/10/2026 · TAREFA CRIADA · [gravidade alta]");
    expect(text).toContain("como veio preenchida");
    expect(text).not.toContain(traffic);
    expect(refs.signals.get("S2")).toBe(s2);
  });

  it("as operações voltam com ids; inválidas saem; não abrir não leva equipe nem prazo", () => {
    const { refs } = rulesMessage(claim);
    const ops = parseRuleOps(
      "Aqui está: " +
        JSON.stringify({
          ops: [
            { op: "add", action: "task", condition: "Problema que trava a captação", team: "T2", assignee: "P9", due_days: 2,
              priority: "high", min_severity: 2, title_hint: "Corrigir <x>", why: "3 de 3", signals: ["S1", "s4", "S99", "S1"],
              replaces: "R1" },
            { op: "add", action: "no_task", condition: "Dúvida simples de cobrança", team: "T1", due_days: 3, priority: "high", signals: ["S3"] },
            { op: "update", id: "R7", action: "task", condition: "Sem regra para atualizar" },
            { op: "update", id: "R1", action: "task", condition: "Problema de captação de leads", team: "T2", due_days: 99 },
            { op: "retire", id: "R1", why: "não se sustentou" },
            { op: "add", action: "talvez", condition: "Ação inválida" },
            { op: "add", action: "task", condition: "ok" },
          ],
        }),
      refs,
    );
    expect(ops).toEqual([
      { op: "add", action: "task", condition: "Problema que trava a captação", team_id: traffic, due_days: 2, priority: "high",
        min_severity: 2, title_hint: "Corrigir <x>", why: "3 de 3", signals: [s1, s4], replaces: rule },
      { op: "add", action: "no_task", condition: "Dúvida simples de cobrança", why: "", signals: [s3] },
      { op: "update", id: rule, action: "task", condition: "Problema de captação de leads", team_id: traffic, why: "", signals: [] },
      { op: "retire", id: rule, why: "não se sustentou" },
    ]);
    expect(parseRuleOps('{"ops": "nada"}', refs)).toEqual([]);
    expect(() => parseRuleOps("sem json", refs)).toThrow("A MAVI não devolveu JSON.");
  });

  it("o texto da regra para o Jev", () => {
    expect(
      ruleText({ topic_name: "x", action: "task", condition: "Pixel fora", min_severity: 3, team_name: "Tráfego", due_days: 1, priority: "urgent" }),
    ).toBe("Quando: Pixel fora (gravidade crítica ou mais) → abrir tarefa, para a equipe Tráfego, prazo de 1 dias úteis, prioridade urgente");
    expect(ruleText({ topic_name: "x", action: "no_task", condition: "Elogio" })).toBe("Quando: Elogio → não abrir tarefa");
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
    const value = key ? routes[key] : null;
    const data = typeof value === "function" ? (value as (b: any) => unknown)(body) : value;
    return new Response(JSON.stringify(data ?? null), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("regras das tarefas do Radar · worker", () => {
  it("propõe com a MAVI, grava com o custo e, sem o Jev, a sugestão segue para um líder", async () => {
    let claims = 0;
    let checks = 0;
    const check: RuleCheck = {
      id: rule,
      company,
      rule: { topic_name: "Problemas", action: "task", condition: "Problema que trava a captação", team_name: "Tráfego" },
      signals: [],
      group: { task: 3, no_task: 1 },
      active: [],
      jev: null,
    };
    const { fetchImpl, calls } = database({
      "rpc/ai_radar_task_rules_claim": () => (claims++ === 0 ? claim : null),
      "rpc/ai_worker_route": null,
      "rpc/ai_radar_task_rules_store": 1,
      "rpc/ai_radar_task_rule_check_claim": () => (checks++ === 0 ? check : null),
      "rpc/ai_radar_task_rule_check_store": null,
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toContain("Proponha REGRAS curtas");
      expect(req.messages[0].content).toContain("S1 ·");
      return {
        text: JSON.stringify({ ops: [{ op: "add", action: "task", condition: "Problema que trava a captação", team: "T2", signals: ["S1", "S2", "S4"] }] }),
        meter: { ...newMeter("m"), input: 1200, output: 300, cost: 0.004 },
        rounds: 1,
      };
    });
    const stats = await runTaskRules(env, { fetch: fetchImpl, llm, embed: vi.fn() }, Date.now() + 300_000);
    expect(stats).toEqual({ rules: 1, checked: 1, failed: 0 });
    const store = calls.find((c) => c.url.includes("rpc/ai_radar_task_rules_store"))!;
    expect(store.body).toMatchObject({
      p_secret: env.workerSecret,
      p_company: company,
      p_topic: topic,
      p_product_key: product,
      p_ops: [{ op: "add", action: "task", team_id: traffic, signals: [s1, s2, s4] }],
      p_usage: { input: 1200, output: 300, cost: 0.004 },
    });
    const stored = calls.find((c) => c.url.includes("rpc/ai_radar_task_rule_check_store"))!;
    expect(stored.body).toMatchObject({ p_rule: rule, p_ok: true });
  });

  it("resposta sem JSON vai para a fila de novo (ai_radar_task_rules_fail)", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_radar_task_rules_claim": () => (claims++ === 0 ? claim : null),
      "rpc/ai_worker_route": null,
    });
    const llm: LlmAdapter = vi.fn(async () => ({ text: "não sei", meter: newMeter("m"), rounds: 1 }));
    const stats = await runTaskRules(env, { fetch: fetchImpl, llm, embed: vi.fn() }, Date.now() + 300_000);
    expect(stats.failed).toBe(1);
    const fail = calls.find((c) => c.url.includes("rpc/ai_radar_task_rules_fail"))!;
    expect(fail.body).toMatchObject({ p_topic: topic, p_product_key: product, p_error: "A MAVI não devolveu JSON." });
  });

  it("sem a chave do Jev, a sugestão segue para um líder sem conferência", async () => {
    let checks = 0;
    const jev = {
      provider_id: "00000000-0000-4000-8000-000000000800",
      provider: "OpenRouter",
      kind: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      key_cipher: null,
      model: "~typesafe/jev-latest",
    };
    const { fetchImpl, calls } = database({
      "rpc/ai_radar_task_rule_check_claim": () =>
        checks++ === 0
          ? { id: rule, company, rule: { topic_name: "x", action: "no_task", condition: "Elogio" }, signals: [], group: { task: 0, no_task: 1 }, active: [], jev }
          : null,
      "rpc/ai_radar_task_rule_check_store": null,
    });
    // Sem a chave do provedor, o Jev não é chamado (sem conferência).
    await runTaskRules(env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn() }, Date.now() + 300_000);
    const stored = calls.find((c) => c.url.includes("rpc/ai_radar_task_rule_check_store"))!;
    expect(stored.body).toMatchObject({ p_ok: true, p_note: "Sem o Jev cadastrado: sem conferência." });
  });
});

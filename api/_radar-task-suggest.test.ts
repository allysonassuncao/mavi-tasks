import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import { parseSuggestion, runTaskSuggestions, suggestMessage, type SuggestClaim } from "./_radar-task-suggest";

const company = "00000000-0000-4000-8000-000000000001";
const item = "00000000-0000-4000-8000-0000000000a1";
const [ruleTask, ruleNo] = ["00000000-0000-4000-8000-0000000000e1", "00000000-0000-4000-8000-0000000000e2"];
const traffic = "00000000-0000-4000-8000-0000000000f1";
const design = "00000000-0000-4000-8000-0000000000f2";
const outside = "00000000-0000-4000-8000-0000000000f9";
const bruno = "00000000-0000-4000-8000-0000000000b1";
const task = "00000000-0000-4000-8000-0000000000c1";
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

const claim: SuggestClaim = {
  company,
  item,
  item_data: {
    title: "Pixel fora do ar",
    summary: "O cliente diz que as conversões zeraram.",
    severity: 3,
    mentions: 2,
    first_seen: "05/10/2026",
    last_seen: "06/10/2026",
    theme: "Rastreamento quebrado",
    client: "Clínica Sorriso",
    product: "Make Ads",
    topic: "Problemas",
    reopened: true,
    quotes: ["Carla: as conversões zeraram desde ontem"],
  },
  rules: [
    { id: ruleTask, action: "task", condition: "Problema que trava a captação", min_severity: 2, team_id: traffic, team: "Tráfego",
      team_serves: true, assignee_id: bruno, assignee: "Bruno", due_days: 1, priority: "urgent", title_hint: "Corrigir <x> — <cliente>" },
    { id: ruleNo, action: "no_task", condition: "Elogio" },
  ],
  examples: [
    { kind: "created", title: "Leads sem telefone", severity: 2, same_theme: true, team: "Tráfego", due_days: 1, priority: "urgent", task_title: "Corrigir o formulário" },
    { kind: "dismissed", title: "Página lenta", reason: "wrong_due" },
    { kind: "no_task", title: "Dúvida de boleto", closed_as: "Descartado" },
  ],
  open_tasks: [{ id: task, title: "Revisar o pixel", status: "progress", due: "2026-10-10" }],
  teams: [
    { id: design, name: "Design" },
    { id: traffic, name: "Tráfego" },
  ],
  people: [{ id: bruno, name: "Bruno" }],
};

describe("tarefa sugerida no item · material", () => {
  it("monta o item, as regras, os casos e as tarefas abertas com referências curtas", () => {
    const { text, refs } = suggestMessage(claim);
    expect(text).toContain("Item do Radar — tópico Problemas · produto Make Ads · cliente Clínica Sorriso");
    expect(text).toContain("gravidade crítica · apareceu 2x · desde 05/10/2026 · última vez 06/10/2026 · tema \"Rastreamento quebrado\" · REABERTO");
    expect(text).toContain("- Carla: as conversões zeraram desde ontem");
    expect(text).toContain(
      "R1 Quando: Problema que trava a captação (gravidade alta ou mais) → ABRIR tarefa, para T2 Tráfego, pessoa P1 Bruno, prazo 1 dias úteis, prioridade urgente, título: Corrigir <x> — <cliente>",
    );
    expect(text).toContain("R2 Quando: Elogio → NÃO abrir tarefa");
    expect(text).toContain('- [mesmo tema] "Leads sem telefone" (gravidade alta) → tarefa "Corrigir o formulário" para Tráfego, prazo 1 dias úteis, prioridade urgente');
    expect(text).toContain('- "Página lenta" → sugestão recusada: prazo errado');
    expect(text).toContain('- "Dúvida de boleto" → fechado sem tarefa (Descartado)');
    expect(text).toContain('K1 "Revisar o pixel" · em andamento · prazo 2026-10-10');
    expect(text).toContain("Equipes que atendem o cliente: T1 Design, T2 Tráfego");
    expect(text).not.toContain(traffic);
    expect(refs.tasks.get("K1")).toBe(task);
  });

  it("equipe da regra que não atende o cliente fica avisada", () => {
    const { text } = suggestMessage({
      ...claim,
      rules: [{ ...claim.rules[0], team_id: outside, team: "Outra", team_serves: false, assignee_id: "x", assignee: "Zé" }],
    });
    expect(text).toContain("para a equipe Outra (que NÃO atende este cliente), pessoa Zé (fora das equipes do cliente)");
  });

  it("a decisão volta com ids; referências inválidas saem", () => {
    const { refs } = suggestMessage(claim);
    expect(
      parseSuggestion(
        JSON.stringify({ decision: "task", rule: "r1", title: "Corrigir o pixel — Clínica Sorriso", description: "Refazer o pixel.",
          team: "T2", assignee: "P1", due_days: 1, priority: "urgent", why: "Conversões zeraram.", task: "K1" }),
        refs,
      ),
    ).toEqual({ decision: "task", rule_id: ruleTask, title: "Corrigir o pixel — Clínica Sorriso", description: "Refazer o pixel.",
      team_id: traffic, assignee_id: bruno, due_days: 1, priority: "urgent", why: "Conversões zeraram." });
    expect(parseSuggestion('{"decision":"link","rule":"R1","task":"K1","why":"já existe"}', refs)).toEqual({
      decision: "link", rule_id: ruleTask, link_task_id: task, why: "já existe" });
    expect(parseSuggestion('{"decision":"task","rule":"R9","team":"T9","assignee":"P7","due_days":99,"priority":"máxima","title":"x"}', refs))
      .toEqual({ decision: "task", title: "x" });
    expect(parseSuggestion('{"decision":"talvez"}', refs)).toEqual({ decision: "unsure" });
    expect(() => parseSuggestion("nada", refs)).toThrow("A MAVI não devolveu JSON.");
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

describe("tarefa sugerida no item · worker", () => {
  it("decide com a MAVI, grava com o custo; falha volta para a fila", async () => {
    let claims = 0;
    const second = { ...claim, item: "00000000-0000-4000-8000-0000000000a2" };
    const { fetchImpl, calls } = database({
      "rpc/ai_radar_task_suggest_claim": () => (claims++ === 0 ? [claim, second] : []),
      "rpc/ai_worker_route": null,
      "rpc/ai_radar_task_suggest_store": "open",
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toContain("Na dúvida, escolha \"unsure\"");
      if (req.messages[0].content.includes("Pixel") && (llm as any).mock.calls.length === 2) return { text: "sem json", meter: newMeter("m"), rounds: 1 };
      return {
        text: JSON.stringify({ decision: "task", rule: "R1", title: "Corrigir o pixel", team: "T2", due_days: 1 }),
        meter: { ...newMeter("m"), input: 900, output: 120, cost: 0.002 },
        rounds: 1,
      };
    });
    const stats = await runTaskSuggestions(env, { fetch: fetchImpl, llm, embed: vi.fn() }, Date.now() + 300_000);
    expect(stats).toEqual({ suggested: 1, quiet: 0, failed: 1 });
    const store = calls.find((c) => c.url.includes("rpc/ai_radar_task_suggest_store"))!;
    expect(store.body).toMatchObject({
      p_secret: env.workerSecret,
      p_item: item,
      p_result: { decision: "task", rule_id: ruleTask, title: "Corrigir o pixel", team_id: traffic, due_days: 1 },
      p_usage: { input: 900, output: 120, cost: 0.002 },
    });
    const fail = calls.find((c) => c.url.includes("rpc/ai_radar_task_suggest_fail"))!;
    expect(fail.body).toMatchObject({ p_item: second.item, p_error: "A MAVI não devolveu JSON." });
  });
});

import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import { learnFromFeedback, learningMessage, parseLessonOps, type LearningClaim } from "./_campaign-insight-learning";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-0000000000c1";
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: crypto.randomBytes(32),
  imageModel: "gpt-image-1",
};
const claim: LearningClaim = {
  company,
  feedback: [
    {
      id: 41, vote: "dismiss", reason: "client", comment: "sem margem para frete", leader: false, kind: "opportunity",
      priority: "medium", title: "Testar frete grátis", body: "O anúncio com frete grátis…", action: "Duplicar",
      client_id: client, product_id: "p1", client_name: "Vittalium", product_name: "Make Ads", campaign_name: "Motion",
    },
    {
      id: 42, vote: "up", reason: null, comment: "", leader: true, kind: "tracking", priority: "high", title: "UTM errada",
      body: "", action: "", client_id: client, product_id: "p1", client_name: "Vittalium", product_name: "Make Ads", campaign_name: "Motion",
    },
  ],
  lessons: [{ id: "l1", scope: "company", client_id: null, product_id: null, kind: null, text: "Regra antiga", status: "active", origin: "person" }],
};

describe("aprendizado dos insights", () => {
  it("a mensagem: aprendizados atuais e as avaliações com motivo, sem nomes de pessoas", () => {
    const m = learningMessage(claim);
    expect(m).toContain("- id l1 · company · escrito por líder: Regra antiga");
    expect(m).toContain("[F1] Descartado · cliente Vittalium · produto Make Ads · campanha Motion");
    expect(m).toContain("motivo: restrição do cliente");
    expect(m).toContain("comentário: sem margem para frete");
    expect(m).toContain("[F2] 👍 (líder)");
  });

  it("as operações: o cliente vem das avaliações citadas; sem cliente certo, cai", () => {
    const ops = parseLessonOps(
      JSON.stringify({
        ops: [
          { op: "add", scope: "client", kind: "opportunity", text: "Para a Vittalium, não sugerir frete grátis.", feedback: ["F1"] },
          { op: "add", scope: "client", text: "Sem citação", feedback: [] },
          { op: "update", id: "l9", text: "Ajuste", feedback: ["F2"] },
          { op: "retire", id: "l8" },
          { op: "inventada" },
        ],
      }),
      claim,
    );
    expect(ops).toEqual([
      { op: "add", scope: "client", client_id: client, kind: "opportunity", text: "Para a Vittalium, não sugerir frete grátis.", feedback: [41] },
      { op: "update", id: "l9", text: "Ajuste", feedback: [42] },
      { op: "retire", id: "l8" },
    ]);
  });

  it("pega uma empresa, pergunta à MAVI e grava (todas as lidas contam como aprendidas)", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      const out = url.includes("learning_claim") ? claim : url.includes("ai_worker_route") ? null : 1;
      return new Response(JSON.stringify(out), { status: 200 });
    }) as unknown as typeof fetch;
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toMatch(/aprender com essas avaliações/);
      const meter = newMeter("claude-opus-5-5");
      meter.cost = 0.004;
      return {
        text: JSON.stringify({ ops: [{ op: "add", scope: "client", text: "Para a Vittalium, não sugerir frete grátis.", feedback: ["F1"] }] }),
        meter,
        rounds: 1,
      };
    });
    const r = await learnFromFeedback(env, { fetch: fetchImpl, llm, embed: vi.fn() });
    expect(r).toEqual({ company, changed: 1 });
    const store = calls.find((c) => c.url.includes("ai_campaign_insight_learning_store"))!.body;
    expect(store.p_learned).toEqual([41, 42]);
    expect(store.p_ops[0]).toMatchObject({ scope: "client", client_id: client, feedback: [41] });
    expect(store.p_usage.cost).toBe(0.004);
  });

  it("nada para aprender: não chama a MAVI", async () => {
    const fetchImpl = vi.fn(async () => new Response("null", { status: 200 })) as unknown as typeof fetch;
    const llm = vi.fn();
    expect(await learnFromFeedback(env, { fetch: fetchImpl, llm, embed: vi.fn() })).toBeNull();
    expect(llm).not.toHaveBeenCalled();
  });
});

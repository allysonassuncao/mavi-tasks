import { describe, expect, it, vi } from "vitest";
import { streamAi, type AiEnv, type AiStreamEvent } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { handleLearningWorker, type LearningEnv } from "./_copilot-learning";
import {
  answerSignals,
  followupSignals,
  jevDecision,
  jevVerdict,
  judgeMessage,
  parseDecision,
  similar,
} from "./_mavi-judge";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const conversation = "00000000-0000-4000-8000-0000000000c9";
const run = "00000000-0000-4000-8000-0000000000e1";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
};
const lenv: LearningEnv = { ...env, learningModel: "claude-opus-5-5" };

describe("autoavaliação · sinais", () => {
  const base = { answer: "Os 17 clientes estão abaixo, com as fontes [S1].", failedTools: 0, found: 3, cited: 1 };
  it("a resposta: limite, erro de ferramenta, sem fonte e trabalho anunciado", () => {
    expect(answerSignals(base)).toEqual([]);
    expect(answerSignals({ ...base, capped: true, failedTools: 2 })).toEqual(["capped", "tool_errors"]);
    expect(answerSignals({ ...base, answer: "x".repeat(400), cited: 0 })).toEqual(["no_sources"]);
    expect(answerSignals({ ...base, answer: "O modo simples funcionou. Agora vou puxar as reuniões de cada cliente." })).toEqual([
      "announce",
    ]);
    // Perguntou ou montou um plano: não é resposta final.
    expect(answerSignals({ ...base, answer: `${"x".repeat(400)} Vou montar o plano.`, cited: 0, waiting: true })).toEqual([]);
  });

  it("a pergunta seguinte: reclamação e pedido repetido (o botão de continuar não conta)", () => {
    expect(followupSignals("Me mande o que te pedi", "Faça a passagem dos clientes")).toEqual(["frustration"]);
    expect(followupSignals("Não foi isso que eu pedi", null)).toEqual(["frustration"]);
    expect(followupSignals("Faça a passagem dos clientes 5022 e 5017, por favor", "Faça a passagem dos clientes 5022 e 5017")).toEqual([
      "repeated",
    ]);
    expect(followupSignals("Continue de onde parou.", "Faça a passagem")).toEqual([]);
    expect(followupSignals("Agora quero o de outubro", "Relatório de setembro do 5022")).toEqual([]);
    expect(similar("abc", "")).toBe(0);
  });
});

describe("autoavaliação · decisão", () => {
  it("o Jev: probabilidades e o problema principal", () => {
    expect(jevVerdict(null)).toBeNull();
    expect(
      jevVerdict({
        answers: { complete: { noul: 0.123456 }, announce: { noul: 0.9 }, grounded: {}, format: { noul: 0.8 }, problem: { choice: "incomplete" } },
      }),
    ).toEqual({ complete: 0.123, announce: 0.9, grounded: null, format: 0.8, problem: "incomplete" });
    expect(jevVerdict({ answers: { problem: { choice: "qualquer" } } })?.problem).toBeNull();
  });

  it("sem modelo de texto, o Jev decide com limites conservadores", () => {
    expect(jevDecision({ complete: 0.9, announce: 0.1, grounded: 0.9, format: 0.9, problem: "ok" }).ok).toBe(true);
    const bad = jevDecision({ complete: 0.1, announce: 0.9, grounded: 0.9, format: 0.9, problem: null });
    expect(bad).toMatchObject({ ok: false, reason: "incomplete" });
    expect(bad.explanation).toContain("anunciou trabalho em vez de entregar");
  });

  it("a resposta do juiz: JSON conferido", () => {
    expect(parseDecision('Aqui: {"ok": false, "reason": "incomplete", "explanation": "Parou no meio.", "confidence": 0.9}')).toEqual({
      ok: false,
      reason: "incomplete",
      explanation: "Parou no meio.",
      confidence: 0.9,
    });
    expect(parseDecision('{"ok": false, "reason": "outro", "confidence": 7}')).toMatchObject({ reason: null, confidence: 1 });
    expect(() => parseDecision("nada")).toThrow(/JSON/);
  });
});

const item = {
  message: 42,
  company,
  conversation,
  signals: ["capped", "announce"] as ("capped" | "announce")[],
  question: "Faça a passagem dos 17 clientes",
  answer: "O modo simples funcionou. Agora vou puxar as reuniões de cada cliente.",
  steps: "Procurando 17 clientes; Chegou ao limite de passos desta resposta (limite de passos)",
  artifacts: [],
  client: null,
  sources: [{ ref: "S1", type: "task", title: "Criar artes", date: "2026-09-10T12:00:00Z", excerpt: "O cliente pediu 8 posts." }],
  dossier: [],
  person: [{ vote: "down", reason: "format", comment: "Quero em tabela", question: "Quais clientes" }],
};

describe("autoavaliação · o juiz no worker", () => {
  function database(routes: Record<string, unknown | ((b: any) => unknown)>) {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      const key = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((k) => url.includes(k));
      const value = key ? routes[key] : null;
      return new Response(JSON.stringify(typeof value === "function" ? (value as (b: any) => unknown)(body) : value), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("o material vai ao Jev e ao juiz; resposta ruim vira avaliação da MAVI com o gasto", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_learning_claim": null,
      "rpc/mavi_learning_claim": null,
      "rpc/mavi_judge_claim": () => (claims++ === 0 ? [item] : []),
      "rpc/ai_worker_route": null,
      "rpc/mavi_judge_jev": {
        provider_id: "00000000-0000-4000-8000-0000000000f9",
        provider: "OpenRouter",
        kind: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_cipher: null,
        model: "~typesafe/jev-latest",
      },
      "rpc/mavi_judge_store": null,
    });
    const requests: string[] = [];
    const llm: LlmAdapter = async (req) => {
      requests.push(req.messages[0].content);
      const meter = newMeter("claude-opus-5-5");
      meter.cost = 0.02;
      return {
        text: '{"ok": false, "reason": "incomplete", "explanation": "Com 17 clientes, devia montar uma tarefa longa.", "confidence": 0.85}',
        meter,
        rounds: 0,
      };
    };
    const deps = { fetch: fetchImpl, llm, embed: vi.fn() };
    const res = await handleLearningWorker(`Bearer ${env.workerSecret}`, lenv, deps, {
      env,
      deps,
      judge: { env, deps, budgetMs: 100_000 },
    });
    expect((res.body as any).judge).toEqual({ checked: 1, bad: 1, failed: 0 });
    // Sem a chave do Jev (key_cipher), só o juiz de texto.
    expect(requests[0]).toContain("Sinais automáticos: parou no limite de passos; anunciou trabalho em vez de entregar");
    expect(requests[0]).toContain("Jev: não configurado.");
    expect(requests[0]).toContain("[S1] task “Criar artes” (2026-09-10): O cliente pediu 8 posts.");
    expect(requests[0]).toContain("👎 formato ruim “Quero em tabela”");
    const store = calls.find((c) => c.url.endsWith("/rpc/mavi_judge_store"))!;
    expect(store.body).toMatchObject({
      p_message: 42,
      p_bad: true,
      p_reason: "incomplete",
      p_comment: "Com 17 clientes, devia montar uma tarefa longa.",
    });
    expect(store.body.p_usage[0]).toMatchObject({ cost: 0.02 });
    const route = calls.find((c) => c.url.endsWith("/rpc/ai_worker_route"))!;
    expect(route.body.p_feature).toBe("mavi_judge");
  });

  it("na dúvida (pouca confiança), a MAVI não se pune; erro volta para a fila", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_learning_claim": null,
      "rpc/mavi_learning_claim": null,
      "rpc/mavi_judge_claim": () => (claims++ === 0 ? [item, { ...item, message: 43 }] : []),
      "rpc/ai_worker_route": null,
      "rpc/mavi_judge_jev": null,
      "rpc/mavi_judge_store": null,
      "rpc/mavi_judge_fail": null,
    });
    const llm: LlmAdapter = async (req) => {
      if (req.messages[0].content.includes("x-erro")) throw Error("529");
      return { text: '{"ok": false, "reason": "format", "explanation": "Talvez.", "confidence": 0.4}', meter: newMeter("x"), rounds: 0 };
    };
    const deps = { fetch: fetchImpl, llm, embed: vi.fn() };
    const broken = { ...item, message: 43, answer: "x-erro" };
    let n = 0;
    const judgeDeps = {
      ...deps,
      fetch: (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/rpc/mavi_judge_claim")) return new Response(JSON.stringify(n++ === 0 ? [item, broken] : []));
        return fetchImpl(url, init);
      }) as typeof fetch,
    };
    const res = await handleLearningWorker(`Bearer ${env.workerSecret}`, lenv, deps, {
      env,
      deps,
      judge: { env, deps: judgeDeps, budgetMs: 100_000 },
    });
    expect((res.body as any).judge).toEqual({ checked: 1, bad: 0, failed: 1 });
    const store = calls.find((c) => c.url.endsWith("/rpc/mavi_judge_store"))!;
    expect(store.body).toMatchObject({ p_message: 42, p_bad: false, p_reason: null });
    const fail = calls.find((c) => c.url.endsWith("/rpc/mavi_judge_fail"))!;
    expect(fail.body).toMatchObject({ p_message: 43, p_error: "529" });
  });

  it("o texto do juiz traz o Jev quando ele respondeu", () => {
    const text = judgeMessage(item, { complete: 0.1, announce: 0.95, grounded: null, format: 0.7, problem: "incomplete" });
    expect(text).toContain("Jev: entregou tudo 0.1; anunciou em vez de entregar 0.95; fatos nas fontes ?; seguiu o formato 0.7; problema principal: incomplete");
  });
});

describe("autoavaliação · na conversa", () => {
  function world(routes: Record<string, (b: any) => unknown>) {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      const key = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((k) => url.includes(k));
      return new Response(JSON.stringify(key ? routes[key](body) : []), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }
  it("a resposta que parou anunciando vira sinal; a reclamação seguinte marca a anterior", async () => {
    const { fetchImpl, calls } = world({
      "memberships?": () => [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "rpc/ai_check_limits": () => ({ blocked: false, message: null, warnings: [] }),
      "rpc/ai_resolve_route": () => null,
      "rpc/ai_my_powers": () => [],
      "rpc/ai_run_start": () => ({ id: run, conversation, created: false }),
      "rpc/ai_save_turn": () => conversation,
      "rpc/ai_usage_close_turn": () => 77,
      "ai_conversations?": () => [{ owner_id: me }],
      "ai_messages?": () => [
        { id: 76, role: "assistant", content: "O modo simples funcionou. Agora vou puxar as reuniões." },
        { id: 75, role: "user", content: "Faça a passagem dos 17 clientes" },
      ],
      "rpc/mavi_answer_signal": () => null,
    });
    const llm: LlmAdapter = async (r) => {
      r.onRound?.({ model: "claude-opus-5-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, tools: [] });
      const meter = newMeter("claude-opus-5-5");
      meter.cost = 0.01;
      return { text: "A busca isolada funcionou. Vou puxar os briefings em lotes menores.", meter, rounds: 0, capped: true };
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, conversation, question: "Me mande o que te pedi", surface: "page" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
      { onClose: () => {} },
    );
    const signals = calls.filter((c) => c.url.endsWith("/rpc/mavi_answer_signal")).map((c) => c.body);
    expect(signals).toContainEqual({ p_message: 76, p_signals: ["frustration"] });
    expect(signals).toContainEqual({ p_message: 77, p_signals: ["capped", "announce"] });
  });
});

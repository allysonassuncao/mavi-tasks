import { describe, expect, it, vi } from "vitest";
import {
  classify,
  decide,
  modelProfile,
  needTier,
  routedLlm,
  serverCandidates,
  type Candidate,
  type RouteInput,
} from "./_ai-router";
import { newMeter } from "./_social-leads";
import type { LlmAdapter } from "./_ai-llm";

const ask = (question: string, extra: Partial<RouteInput> = {}) =>
  classify({ question, surface: "page", feature: "mavi_page", ...extra });

describe("roteador · classificação do pedido", () => {
  it("cumprimento curto é conversa, complexidade 1", () => {
    expect(ask("Bom dia!")).toMatchObject({ taskType: "conversa", complexity: 1 });
    expect(ask("obrigado, valeu")).toMatchObject({ taskType: "conversa", complexity: 1 });
  });

  it("identifica as famílias de pedido", () => {
    expect(ask("Analise o ROAS das campanhas do cliente este mês").taskType).toBe("analise");
    expect(ask("Escreva uma legenda para o post de sexta").taskType).toBe("redacao");
    expect(ask("Monte um plano de lançamento para o produto novo").taskType).toBe("planejamento");
    expect(ask("Crie uma tarefa para a Ana revisar o site").taskType).toBe("acao");
    expect(ask("Gere uma imagem para o banner da campanha").taskType).toBe("visual");
    expect(ask("Me ajude com a fórmula da planilha").taskType).toBe("codigo");
    expect(ask("O que foi combinado na última reunião?").taskType).toBe("busca");
    expect(ask("Qual o telefone do cliente?").taskType).toBe("consulta");
  });

  it("nas reuniões e no WhatsApp, sem pista, é busca no histórico", () => {
    expect(ask("e sobre o preço?", { surface: "meetings" }).taskType).toBe("busca");
    expect(ask("e sobre o preço?", { surface: "whatsapp" }).taskType).toBe("busca");
  });

  it("planejamento é complexo; pedido curto de consulta é simples", () => {
    expect(ask("Monte a estratégia de mídia do trimestre").complexity).toBe(3);
    expect(ask("Quem é o gestor do cliente?").complexity).toBe(1);
  });

  it("profundidade, vários pedidos e anexos para analisar sobem a complexidade", () => {
    expect(ask("Escreva um e-mail para o cliente").complexity).toBe(2);
    expect(ask("Escreva um e-mail detalhado para o cliente").complexity).toBe(3);
    const many = ask("1. compare as campanhas\n2. diga por que caiu\n3. sugira ajustes");
    expect(many.complexity).toBe(3);
    expect(many.why).toContain("vários pedidos juntos");
    expect(ask("Analise este relatório", { attachments: { documents: 1 } })).toMatchObject({
      complexity: 3,
      modalities: ["text", "document"],
    });
  });

  it("utilitário estruturado ignora o resto; tela rápida e tamanho do contexto", () => {
    const s = ask("Analise detalhadamente todas as campanhas", { structured: true, surface: "task_search" });
    expect(s).toMatchObject({ taskType: "utilitario", complexity: 1, latency: "rapida" });
    expect(ask("oi", { contextChars: 36_000 }).contextTokens).toBe(10_001);
  });
});

describe("roteador · perfil dos modelos", () => {
  it("faixas pelo nome", () => {
    expect(modelProfile("anthropic", "claude-haiku-4-5").tier).toBe(1);
    expect(modelProfile("anthropic", "claude-sonnet-5").tier).toBe(2);
    expect(modelProfile("anthropic", "claude-opus-5-5").tier).toBe(3);
    expect(modelProfile("anthropic", "claude-fable-5-1").tier).toBe(3);
    expect(modelProfile("openai", "gpt-5-mini").tier).toBe(1);
    expect(modelProfile("openai", "gpt-5").tier).toBe(3);
    expect(modelProfile("openai", "gpt-4.1").tier).toBe(2);
    expect(modelProfile("google", "gemini-2.5-flash-lite").tier).toBe(1);
    expect(modelProfile("google", "gemini-2.5-flash").tier).toBe(2);
    expect(modelProfile("google", "gemini-2.5-pro").tier).toBe(3);
    expect(modelProfile("openrouter", "anthropic/claude-sonnet-4.5").tier).toBe(2);
  });

  it("sem pista no nome, a faixa vem do preço de saída", () => {
    expect(modelProfile("custom", "modelo-x", { id: "x", input: 1, output: 20 }).tier).toBe(3);
    expect(modelProfile("custom", "modelo-x", { id: "x", input: 0.1, output: 0.4 }).tier).toBe(1);
  });

  it("transcrição e imagens não conversam; visão e contexto", () => {
    expect(modelProfile("openai", "whisper-1").speechOnly).toBe(true);
    expect(modelProfile("deepgram", "nova-3").speechOnly).toBe(true);
    expect(modelProfile("openai", "gpt-image-1").speechOnly).toBe(true);
    expect(modelProfile("anthropic", "claude-sonnet-5")).toMatchObject({ vision: true, contextK: 200 });
    expect(modelProfile("deepseek", "deepseek-reasoner")).toMatchObject({ vision: false, tools: false });
  });
});

const lib: Candidate[] = [
  { providerId: "p1", provider: "OpenAI", kind: "openai", model: "gpt-5-mini", price: { id: "gpt-5-mini", input: 0.25, output: 2 } },
  { providerId: "p1", provider: "OpenAI", kind: "openai", model: "whisper-1", price: { id: "whisper-1", input: 0, output: 0 } },
  ...serverCandidates(true),
];

describe("roteador · decisão", () => {
  it("equilibrado: simples no barato, complexo no forte", () => {
    const easy = decide({ signals: ask("Qual o e-mail do cliente?"), level: "equilibrado", candidates: lib });
    expect(easy.needTier).toBe(1);
    expect(easy.suggested?.model).toBe("gpt-5-mini");
    const hard = decide({ signals: ask("Monte a estratégia de mídia do trimestre"), level: "equilibrado", candidates: lib });
    expect(hard.needTier).toBe(3);
    expect(hard.suggestedTier).toBe(3);
    expect(hard.reason).toMatch(/^Planejamento, complexidade 3 → faixa 3; claude-/);
  });

  it("os níveis mudam a faixa mínima", () => {
    const s = ask("Escreva um e-mail para o cliente");
    expect(needTier(s, "economico")).toBe(1);
    expect(needTier(s, "equilibrado")).toBe(2);
    expect(needTier(s, "maxima")).toBe(3);
  });

  it("com muitas ferramentas, nunca a faixa 1 em pedido médio", () => {
    expect(needTier(ask("Escreva um e-mail para o cliente", { toolCount: 30 }), "economico")).toBe(2);
  });

  it("transcrição fica de fora; contexto que não cabe também", () => {
    const d = decide({ signals: ask("oi", { contextChars: 3_600_000 }), level: "equilibrado", candidates: lib });
    expect(d.scored.find((x) => x.model === "whisper-1")?.out).toBe("não conversa");
    expect(d.scored.every((x) => x.out === "não conversa" || x.out === "contexto não cabe")).toBe(true);
    expect(d.suggested).toBeNull();
    expect(d.reason).toMatch(/nenhum modelo/);
  });

  it("ninguém atende a faixa: vai o mais forte disponível", () => {
    const only = lib.filter((c) => c.model === "gpt-5-mini");
    const d = decide({ signals: ask("Monte a estratégia de mídia do trimestre"), level: "equilibrado", candidates: only });
    expect(d.suggested?.model).toBe("gpt-5-mini");
    expect(d.reason).toMatch(/mais forte disponível/);
  });

  it("o desempenho real da empresa vale com amostras suficientes", () => {
    const s = ask("Escreva um e-mail para o cliente");
    const two: Candidate[] = [
      { providerId: "a", provider: "A", kind: "anthropic", model: "claude-sonnet-5", price: { id: "s", input: 2, output: 10 } },
      { providerId: "b", provider: "B", kind: "openai", model: "gpt-4.1", price: { id: "g", input: 2, output: 8 } },
    ];
    expect(decide({ signals: s, level: "equilibrado", candidates: two }).suggested?.model).toBe("gpt-4.1");
    const stats = [{ model: "gpt-4.1", taskType: "redacao" as const, n: 40, quality: 0.6 }];
    expect(decide({ signals: s, level: "equilibrado", candidates: two, stats }).suggested?.model).toBe("claude-sonnet-5");
    const few = [{ ...stats[0], n: 5 }];
    expect(decide({ signals: s, level: "equilibrado", candidates: two, stats: few }).suggested?.model).toBe("gpt-4.1");
  });

  it("regras de pessoa/cliente/funcionalidade travam; a da empresa não", () => {
    const s = ask("oi");
    expect(decide({ signals: s, level: "equilibrado", candidates: lib, lockedScope: "client" })).toMatchObject({
      mode: "locked",
      lockedBy: "client",
    });
    expect(decide({ signals: s, level: "equilibrado", candidates: lib, lockedScope: "company" }).mode).toBe("auto");
  });

  it("imagens nativas exigem um modelo que enxerga", () => {
    const s = ask("O que tem nesta imagem?", { attachments: { images: 1 } });
    const blind: Candidate[] = [
      { providerId: "d", provider: "DeepSeek", kind: "deepseek", model: "deepseek-chat", price: { id: "d", input: 0.3, output: 1 } },
      ...serverCandidates(true),
    ];
    const d = decide({ signals: s, level: "equilibrado", candidates: blind, nativeImages: true });
    expect(d.scored.find((x) => x.model === "deepseek-chat")?.out).toBe("não enxerga imagens");
    expect(d.suggested?.kind).toBe("anthropic");
  });
});

describe("roteador · telas de uma chamada (sombra)", () => {
  it("responde igual, mede a espera e registra a decisão depois", async () => {
    const meter = newMeter("claude-haiku-4-5");
    meter.cost = 0.002;
    const inner: LlmAdapter = async (req) => {
      req.onEvent?.({ type: "text", text: "ok" });
      return { text: "resposta", meter, rounds: 1 };
    };
    const log = vi.fn(async () => null);
    const pending: Promise<unknown>[] = [];
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    const llm = routedLlm(inner, {
      env: { supabaseUrl: "https://x.supabase.co", supabaseKey: "k" },
      fetch: fetchImpl,
      auth: "Bearer t",
      where: { company: "c", surface: "task_search", feature: "task_search" },
      used: { providerId: null, model: "claude-haiku-4-5" },
      question: "tarefas atrasadas da Ana",
      structured: true,
      hasServerKey: true,
      log: log as never,
      later: (w) => pending.push(w),
    });
    const out = await llm({ instructions: "regras", context: "", messages: [{ role: "user", content: "x" }], tools: [], execute: async () => "" });
    expect(out.text).toBe("resposta");
    await Promise.all(pending);
    expect(log).toHaveBeenCalledOnce();
    const [, , , where, signals, decision, outcome] = log.mock.calls[0] as unknown as [
      unknown, unknown, unknown, { surface: string }, { taskType: string }, { suggested: Candidate | null }, Record<string, unknown>,
    ];
    expect(where.surface).toBe("task_search");
    expect(signals.taskType).toBe("utilitario");
    expect(decision.suggested?.model).toBe("claude-haiku-4-5");
    expect(outcome).toMatchObject({ usedModel: "claude-haiku-4-5", cost: 0.002, rounds: 1 });
    expect(typeof outcome.firstTokenMs).toBe("number");
  });

  it("a falha também é registrada e segue para a tela", async () => {
    const log = vi.fn(async () => null);
    const pending: Promise<unknown>[] = [];
    const llm = routedLlm(async () => Promise.reject(new Error("caiu")), {
      env: { supabaseUrl: "https://x.supabase.co", supabaseKey: "k" },
      fetch: (async () => new Response("[]")) as unknown as typeof fetch,
      auth: "Bearer t",
      where: { company: "c", surface: "dashboard", feature: "dashboard_mavi" },
      used: { providerId: null, model: "m" },
      question: "q",
      hasServerKey: false,
      log: log as never,
      later: (w) => pending.push(w),
    });
    await expect(llm({ instructions: "", context: "", messages: [{ role: "user", content: "q" }], tools: [], execute: async () => "" })).rejects.toThrow("caiu");
    await Promise.all(pending);
    expect((log.mock.calls[0] as unknown[])[6]).toMatchObject({ error: "caiu", cost: 0 });
  });
});

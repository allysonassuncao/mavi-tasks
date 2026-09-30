import { describe, expect, it, vi } from "vitest";
import { anthropicAdapter, type AgentRequest, type LlmAdapter } from "./_ai-llm";
import { openAiChatAdapter, type ProviderConfig } from "./_ai-providers";
import { streamAi, type AiEnv, type AiStreamEvent, type Live } from "./_ai";
import { newMeter } from "./_social-leads";
import { seal } from "./_google";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const conversation = "00000000-0000-4000-8000-0000000000c1";
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
type Call = { url: string; body: any };
function world(routes: Record<string, (c: Call) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    let body: any = init?.body;
    try {
      body = JSON.parse(String(init?.body));
    } catch {
      /* não é JSON */
    }
    const call = { url, body };
    calls.push(call);
    const k = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((x) => url.includes(x));
    if (!k) return new Response("[]", { status: 200 });
    const data = routes[k](call);
    return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const answer = (text: string) => ({ text, meter: newMeter("claude-opus-5-5"), rounds: 1 });
const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

describe("cache do prompt", () => {
  it("Claude: instruções, contexto e a conversa (cache automático no fim)", async () => {
    const requests: any[] = [];
    const client = {
      beta: {
        messages: {
          stream: (params: any) => {
            requests.push(JSON.parse(JSON.stringify(params)));
            return {
              on: () => undefined,
              finalMessage: async () => ({
                model: "claude-opus-5-5",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
                usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 },
              }),
            };
          },
        },
      },
    };
    const run = (extra: Partial<AgentRequest>) =>
      anthropicAdapter({ anthropicKey: "", model: "claude-opus-5-5" }, client as never)({
        instructions: "i",
        context: "c",
        messages: [{ role: "user", content: "oi" }],
        tools: [],
        execute: async () => "",
        ...extra,
      });
    const out = await run({ cacheContext: true, cacheConversation: true });
    expect(requests[0].system).toEqual([
      { type: "text", text: "i", cache_control: { type: "ephemeral" } },
      { type: "text", text: "c", cache_control: { type: "ephemeral" } },
    ]);
    expect(requests[0].cache_control).toEqual({ type: "ephemeral" });
    // O que veio do cache fica no medidor (e vai para o Consumo).
    expect(out.meter).toMatchObject({ cacheRead: 9000, cacheWrite: 300 });
    // Uma chamada avulsa (copiloto, resumo) não paga para gravar o fim.
    await run({});
    expect(requests[1].cache_control).toBeUndefined();
    expect(requests[1].system[1].cache_control).toBeUndefined();
  });

  it("OpenAI: a chave do cache; Claude pelo OpenRouter: pontos de cache nas instruções e no contexto", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return sse([{ choices: [{ delta: { content: "ok" } }] }]);
    }) as unknown as typeof fetch;
    const base = { name: "x", baseUrl: "https://api.x.com/v1", apiKey: "k", price: null };
    const req = { instructions: "INSTR", context: "CTX", messages: [{ role: "user" as const, content: "oi" }], tools: [], execute: vi.fn(), cacheKey: "empresa:pessoa" };
    await openAiChatAdapter({ ...base, kind: "openai", model: "gpt-x" } as ProviderConfig, fetchImpl)(req);
    expect(bodies[0].prompt_cache_key).toBe("empresa:pessoa");
    expect(bodies[0].messages[0]).toEqual({ role: "system", content: "INSTR\n\nCTX" });
    await openAiChatAdapter({ ...base, kind: "openrouter", model: "anthropic/claude-sonnet-5.5" } as ProviderConfig, fetchImpl)(req);
    expect(bodies[1].prompt_cache_key).toBeUndefined();
    expect(bodies[1].messages[0].content).toEqual([
      { type: "text", text: "INSTR", cache_control: { type: "ephemeral" } },
      { type: "text", text: "CTX", cache_control: { type: "ephemeral" } },
    ]);
    // Outros provedores compatíveis: nada a mais (podem recusar campos que não conhecem).
    await openAiChatAdapter({ ...base, kind: "groq", model: "llama" } as ProviderConfig, fetchImpl)(req);
    expect(bodies[2].prompt_cache_key).toBeUndefined();
    expect(typeof bodies[2].messages[0].content).toBe("string");
  });

  it("a MAVI pede cache do contexto e da conversa, com a chave da empresa e da pessoa", async () => {
    const { fetchImpl } = world({
      "memberships?": () => [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "rpc/ai_check_limits": () => ({ blocked: false, message: null, warnings: [] }),
      "rpc/ai_resolve_route": () => null,
      "rpc/ai_save_turn": () => conversation,
    });
    let request: AgentRequest | undefined;
    const events: AiStreamEvent[] = [];
    await streamAi({ action: "ai-ask", company, scope: {}, question: "Oi" }, token, env, {
      fetch: fetchImpl,
      llm: async (r) => ((request = r), answer("Olá")),
      embed: vi.fn(),
    }, (e) => events.push(e));
    expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: "done" });
    expect(request).toMatchObject({ cacheContext: true, cacheConversation: true, cacheKey: `${company}:${me}` });
  });
});

describe("conversas longas", () => {
  /** 20 mensagens antigas (ids 1..20) e um resumo que cobre até a 8. */
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    role: i % 2 === 0 ? "user" : "assistant",
    content: i % 2 === 0 ? `Pergunta ${i / 2 + 1}` : `Resposta ${(i + 1) / 2}`,
  }));
  const routes = (summary: string | null, upto: number | null) => ({
    "memberships?": () => [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
    "ai_conversations?select=owner_id": () => [{ owner_id: me, summary, summary_upto: upto }],
    "ai_messages?select=": () => [...rows].reverse(),
    "rpc/ai_check_limits": () => ({ blocked: false, message: null, warnings: [] }),
    "rpc/ai_resolve_route": () => null,
    "rpc/ai_run_start": () => ({ id: "00000000-0000-4000-8000-0000000000e1", conversation, created: false }),
    "rpc/ai_run_finish": () => null,
    "rpc/ai_save_turn": () => conversation,
    "rpc/ai_conversation_summary_save": () => true,
    "rpc/ai_log_usage": () => null,
  });

  it("o resumo vem no começo, e só as mensagens que ele não cobre", async () => {
    const { fetchImpl } = world(routes("Resumo: a Ana pediu o relatório do cliente 4282.", 8));
    let request: AgentRequest | undefined;
    const events: AiStreamEvent[] = [];
    await streamAi({ action: "ai-ask", company, scope: {}, question: "E agora?", conversation }, token, env, {
      fetch: fetchImpl,
      llm: async (r) => ((request = r), answer("Certo.")),
      embed: vi.fn(),
    }, (e) => events.push(e));
    const msgs = request!.messages;
    expect(msgs[0].content).toMatch(/^\[Resumo das mensagens anteriores desta conversa, feito pela MAVI\]\nResumo: a Ana pediu/);
    expect(msgs[1].role).toBe("assistant");
    // Depois do resumo: as mensagens 9..20 e a pergunta nova.
    expect(msgs[2].content).toBe("Pergunta 5");
    expect(msgs.at(-2)!.content).toBe("Resposta 10");
    expect(msgs.at(-1)!.content).toBe("E agora?");
    expect(events.some((e) => e.type === "step" && e.label === "Relembrando o começo da conversa")).toBe(true);
  });

  it("cresceu: resume as antigas em segundo plano (as 6 mais recentes ficam inteiras)", async () => {
    const { fetchImpl, calls } = world(routes(null, null));
    const later: Promise<unknown>[] = [];
    const live: Live = { onClose: () => {}, later: (w) => later.push(w) };
    const prompts: string[] = [];
    const llm: LlmAdapter = async (r) => {
      if (r.instructions.startsWith("Você mantém a memória")) {
        prompts.push(r.messages[0].content);
        return answer("- A Ana quer o relatório de setembro do cliente 4282.\n- Pendente: enviar na sexta.");
      }
      return answer("Resposta nova.");
    };
    await streamAi({ action: "ai-ask", company, scope: {}, question: "Mais uma", conversation }, token, env, {
      fetch: fetchImpl,
      llm,
      embed: vi.fn(),
    }, () => {}, live);
    expect(later).toHaveLength(1);
    await Promise.all(later);
    // 20 antigas: resume as 14 primeiras (até a resposta 7, id 14); as 6 últimas ficam.
    expect(prompts[0]).toContain("Pessoa: Pergunta 1");
    expect(prompts[0]).toContain("MAVI: Resposta 7");
    expect(prompts[0]).not.toContain("Pergunta 8");
    const saved = calls.find((c) => c.url.includes("ai_conversation_summary_save"))!.body;
    expect(saved).toMatchObject({ p_conversation: conversation, p_upto: 14 });
    expect(saved.p_summary).toContain("relatório de setembro");
    expect(calls.some((c) => c.url.includes("ai_log_usage") && c.body.p_kind === "summary")).toBe(true);
  });
});

describe("reordenação da busca", () => {
  it("com um modelo escolhido: a busca traz mais candidatos e o modelo escolhe a ordem", async () => {
    const key = Buffer.alloc(32, 7);
    const search = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        chunk_id: i + 1,
        document_id: "d",
        source_type: "meeting",
        source_id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
        title: `Reunião ${i + 1}`,
        content: `cabeçalho\ntexto ${i + 1}`,
        meta: {},
        client_id: null,
        occurred_at: "2026-09-01",
      }));
    const { fetchImpl, calls } = world({
      "memberships?": () => [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "rpc/ai_check_limits": () => ({ blocked: false, message: null, warnings: [] }),
      "rpc/ai_resolve_route": (c) =>
        c.body.p_feature === "mavi_rerank"
          ? {
              scope: "feature",
              provider_id: "00000000-0000-4000-8000-0000000000f1",
              provider: "Claude",
              kind: "anthropic",
              base_url: "",
              key_cipher: seal(key, "sk-rerank"),
              model: "claude-haiku-4-5",
              price: null,
            }
          : null,
      "rpc/ai_search": (c) => search(Math.min(c.body.p_limit, 30)),
      "rpc/ai_save_turn": () => conversation,
      "rpc/ai_log_usage": () => null,
      "rpc/ai_log_tool_calls": () => null,
    });
    const asked: string[] = [];
    const rerankLlm: LlmAdapter = async (r) => (asked.push(r.messages[0].content), answer("3, 1, 99"));
    let found = "";
    const events: AiStreamEvent[] = [];
    await streamAi({ action: "ai-ask", company, scope: {}, question: "O que foi combinado?" }, token, { ...env, providerKey: key }, {
      fetch: fetchImpl,
      llm: async (r) => {
        found = await r.execute("search_knowledge", { query: "combinado verba", limit: 5 });
        return answer("Veja [S1].");
      },
      embed: vi.fn(async (t: string[]) => ({ vectors: t.map(() => [0.1]), tokens: 1, model: "m" })),
      providerLlm: () => rerankLlm,
    }, (e) => events.push(e));
    expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: "done" });
    // Com reordenação, a busca pede mais candidatos (5 × 2 + 4).
    expect(calls.find((c) => c.url.includes("rpc/ai_search"))!.body.p_limit).toBe(14);
    expect(asked[0]).toContain("Pergunta: combinado verba");
    expect(asked[0]).toContain("[14] Reunião 14");
    // A ordem do modelo (o número que não existe fica de fora).
    expect(found.match(/Reunião "Reunião \d+"/g)).toEqual(['Reunião "Reunião 3"', 'Reunião "Reunião 1"']);
    expect(calls.some((c) => c.url.includes("ai_log_usage") && c.body.p_kind === "rerank")).toBe(true);
  });
});

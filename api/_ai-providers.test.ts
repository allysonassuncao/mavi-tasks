import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleAi, type AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { claudeFeatures } from "./_ai-llm";
import {
  handleProviders,
  openAiChatAdapter,
  priceCost,
  routeConfig,
  type ProviderConfig,
} from "./_ai-providers";
import { seal, unseal } from "./_google";
import { pickRoute, safeBaseUrl, type AiRoute } from "../src/ai-providers";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const me = "00000000-0000-4000-8000-000000000003";
const providerId = "00000000-0000-4000-8000-000000000009";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const providerKey = crypto.randomBytes(32);
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey,
};

/** Banco falso: respostas por trecho da URL; guarda as chamadas. */
function database(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      url,
      body,
      auth: new Headers(init?.headers).get("Authorization"),
    });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    if (!key) return new Response("[]", { status: 200 });
    const value = routes[key];
    const data =
      typeof value === "function"
        ? (value as (b: any) => unknown)(body)
        : value;
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Uma resposta em SSE, como a API de chat manda. */
const sse = (chunks: unknown[]) =>
  new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const config: ProviderConfig = {
  kind: "openai",
  name: "OpenAI da agência",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-live",
  model: "gpt-x",
  price: { id: "gpt-x", input: 2, output: 8, cached: 0.5 },
};

describe("adaptador da API de chat (OpenAI e compatíveis)", () => {
  it("chama ferramentas em paralelo, repassa o texto e soma o custo pelos preços cadastrados", async () => {
    const bodies: any[] = [];
    let round = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer sk-live",
      );
      bodies.push(JSON.parse(String(init!.body)));
      if (round++ === 0)
        return sse([
          {
            choices: [
              {
                delta: {
                  content: "Vou buscar.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      function: { name: "search_knowledge", arguments: '{"que' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: 'ry":"verba"}' } },
                    {
                      index: 1,
                      id: "c2",
                      function: { name: "list_tasks", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          {
            choices: [],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 100,
              prompt_tokens_details: { cached_tokens: 200 },
            },
          },
        ]);
      return sse([
        { choices: [{ delta: { reasoning_content: "pensando" } }] },
        { choices: [{ delta: { content: "A verba é 3 mil [S1]." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 500, completion_tokens: 50 } },
      ]);
    }) as unknown as typeof fetch;
    const events: string[] = [];
    const execute = vi.fn(async (name: string, input: unknown) =>
      `${name}:${JSON.stringify(input)}`,
    );
    const out = await openAiChatAdapter(config, fetchImpl)({
      instructions: "INSTR",
      context: "CTX",
      messages: [{ role: "user", content: "Qual a verba?" }],
      tools: [
        { name: "search_knowledge", description: "busca", parameters: {} },
        { name: "list_tasks", description: "tarefas", parameters: {} },
      ],
      execute,
      onEvent: (e) => events.push(e.type === "round_end" ? "|" : e.text),
    });
    expect(out.text).toBe("A verba é 3 mil [S1].");
    expect(execute).toHaveBeenCalledWith("search_knowledge", { query: "verba" });
    expect(execute).toHaveBeenCalledWith("list_tasks", {});
    expect(events).toEqual(["Vou buscar.", "|", "pensando", "A verba é 3 mil [S1]."]);
    // Instruções e contexto vão juntos como mensagem de sistema.
    expect(bodies[0].messages[0]).toEqual({
      role: "system",
      content: "INSTR\n\nCTX",
    });
    expect(bodies[0].tools[0].function.name).toBe("search_knowledge");
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    // Os resultados voltam na mesma ordem das chamadas.
    expect(bodies[1].messages.slice(-3)).toEqual([
      {
        role: "assistant",
        content: "Vou buscar.",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "search_knowledge", arguments: '{"query":"verba"}' },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "list_tasks", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: 'search_knowledge:{"query":"verba"}',
      },
      { role: "tool", tool_call_id: "c2", content: "list_tasks:{}" },
    ]);
    // 800 + 500 de entrada a US$ 2, 200 do cache a US$ 0,50, 150 de saída a US$ 8.
    expect(out.meter).toMatchObject({ input: 1300, cacheRead: 200, output: 150 });
    expect(out.meter.cost).toBeCloseTo((1300 * 2 + 200 * 0.5 + 150 * 8) / 1e6, 10);
  });

  it("depois do limite de rodadas, só a resposta; sem texto, pede uma vez", async () => {
    const bodies: any[] = [];
    const replies = [
      sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
      sse([{ choices: [{ delta: { content: "Não encontrei." } }] }]),
    ];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return replies.shift()!;
    }) as unknown as typeof fetch;
    const out = await openAiChatAdapter(config, fetchImpl)({
      instructions: "",
      context: "",
      messages: [{ role: "user", content: "Oi" }],
      tools: [{ name: "t", description: "", parameters: {} }],
      execute: vi.fn(),
      maxRounds: 3,
    });
    expect(out.text).toBe("Não encontrei.");
    expect(bodies[0].tool_choice).toBe("auto");
    expect(bodies[1].tool_choice).toBe("none");
    expect(bodies[1].messages.at(-1).role).toBe("user");
  });

  it("provedor sem stream_options: tenta de novo sem ele; chave recusada vira mensagem clara", async () => {
    const bodies: any[] = [];
    const replies = [
      new Response(
        JSON.stringify({ error: { message: "Unknown field stream_options" } }),
        { status: 400 },
      ),
      sse([{ choices: [{ delta: { content: "ok" } }] }]),
    ];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return replies.shift()!;
    }) as unknown as typeof fetch;
    const out = await openAiChatAdapter(config, fetchImpl)({
      instructions: "",
      context: "",
      messages: [{ role: "user", content: "Oi" }],
      tools: [],
      execute: vi.fn(),
    });
    expect(out.text).toBe("ok");
    expect(bodies[1].stream_options).toBeUndefined();
    const denied = vi.fn(
      async () => new Response("{}", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      openAiChatAdapter(config, denied)({
        instructions: "",
        context: "",
        messages: [{ role: "user", content: "Oi" }],
        tools: [],
        execute: vi.fn(),
      }),
    ).rejects.toThrow('A API Key do provedor "OpenAI da agência" foi recusada');
  });

  it("custo sem preço de cache usa o de entrada", () => {
    expect(
      priceCost({ id: "m", input: 1, output: 2 }, { input: 10, output: 5, cached: 10 }),
    ).toBeCloseTo((10 + 10 + 10) / 1e6, 12);
    expect(priceCost(null, { input: 10, output: 5, cached: 0 })).toBe(0);
  });
});

describe("recursos da Claude por modelo", () => {
  it("Haiku 4.5 sem raciocínio adaptativo; Opus 5 com fallback", () => {
    expect(claudeFeatures("claude-haiku-4-5")).toEqual({
      adaptive: false,
      fallbacks: false,
    });
    expect(claudeFeatures("claude-sonnet-5")).toEqual({
      adaptive: true,
      fallbacks: false,
    });
    expect(claudeFeatures("claude-opus-5")).toEqual({
      adaptive: true,
      fallbacks: true,
    });
    expect(claudeFeatures("claude-fable-5-1").fallbacks).toBe(true);
    // O padrão do servidor: raciocínio adaptativo e fallback.
    expect(claudeFeatures("claude-opus-5-5")).toEqual({
      adaptive: true,
      fallbacks: true,
    });
  });
});

describe("qual IA responde", () => {
  const routes = (route: unknown, hidden: string[] = []) => ({
    "memberships?": [
      {
        user_id: me,
        name: "Ana Admin",
        email: "ana@x.com",
        role: "admin",
        active: true,
        hidden_pages: hidden,
      },
    ],
    "clients?": [{ id: client, name: "4282" }],
    "rpc/ai_resolve_route": route,
    "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
    "rpc/ai_save_turn": "conv-1",
    "rpc/ai_log_usage": null,
  });
  const route = {
    scope: "client",
    provider_id: providerId,
    provider: "OpenAI da agência",
    kind: "openai",
    base_url: null,
    key_cipher: seal(providerKey, "sk-da-agencia"),
    model: "gpt-x",
    price: { id: "gpt-x", input: 2, output: 8 },
  };
  const answer: LlmAdapter = async () => ({
    text: "Resposta",
    meter: {
      model: "gpt-x",
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.001,
    },
    rounds: 0,
  });

  it("usa o provedor da regra, com a chave aberta, e registra o provedor no consumo", async () => {
    const { fetchImpl, calls } = database(routes(route));
    const seen: ProviderConfig[] = [];
    const defaultLlm = vi.fn();
    const res = await handleAi(
      {
        action: "ai-ask",
        company,
        scope: { client, module: "assistant" },
        question: "Qual a verba?",
      },
      token,
      env,
      {
        fetch: fetchImpl,
        llm: defaultLlm,
        embed: vi.fn(),
        providerLlm: (c) => {
          seen.push(c);
          return answer;
        },
      },
    );
    expect(res.status).toBe(200);
    expect(defaultLlm).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({
      apiKey: "sk-da-agencia",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-x",
      name: "OpenAI da agência",
    });
    const resolve = calls.find((c) => c.url.includes("ai_resolve_route"))!;
    expect(resolve.auth).toBe(token);
    expect(resolve.body).toEqual({
      p_company: company,
      p_client: client,
      p_contract: null,
      p_project: null,
    });
    const log = calls.find((c) => c.url.includes("ai_log_usage"))!;
    expect(log.body).toMatchObject({
      p_provider: providerId,
      p_model: "gpt-x",
      p_cost: 0.001,
    });
  });

  it("sem regra: o padrão do servidor, sem provedor no consumo", async () => {
    const { fetchImpl, calls } = database(routes(null));
    const llm = vi.fn(answer);
    const res = await handleAi(
      { action: "ai-ask", company, scope: { client }, question: "Qual a verba?" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(res.status).toBe(200);
    expect(llm).toHaveBeenCalled();
    const log = calls.find((c) => c.url.includes("ai_log_usage"))!;
    expect(log.body.p_provider).toBeUndefined();
  });

  it("assistente desligado para a pessoa: recusa sem chamar a IA (as Gravações seguem)", async () => {
    const { fetchImpl } = database(routes(null, ["assistant"]));
    const llm = vi.fn(answer);
    const res = await handleAi(
      { action: "ai-ask", company, scope: { module: "assistant" }, question: "Oi, tudo?" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("A MAVI está desligada para você");
    expect(llm).not.toHaveBeenCalled();
    const meetings = await handleAi(
      { action: "ai-ask", company, scope: { client, module: "meetings" }, question: "Oi, tudo?" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(meetings.status).toBe(200);
  });

  it("sem AI_PROVIDER_KEY no servidor: avisa o que falta", () => {
    expect(() => routeConfig({ providerKey: null }, route as any)).toThrow(
      /AI_PROVIDER_KEY/,
    );
    expect(() =>
      routeConfig({ providerKey: crypto.randomBytes(32) }, route as any),
    ).toThrow(/Salve a chave de novo/);
  });
});

describe("administração dos provedores", () => {
  it("sela a chave antes de ir ao banco e guarda só o final dela", async () => {
    const { fetchImpl, calls } = database({ "rpc/ai_save_provider": providerId });
    const res = await handleProviders(
      {
        action: "ai-provider-save",
        company,
        name: "OpenAI",
        kind: "openai",
        api_key: " sk-segredo-1234 ",
        models: [{ id: "gpt-x", input: 2, output: 8 }],
      },
      token,
      env,
      { fetch: fetchImpl },
    );
    expect(res).toEqual({ status: 200, body: { id: providerId } });
    const body = calls[0].body;
    expect(calls[0].auth).toBe(token);
    expect(JSON.stringify(body)).not.toContain("sk-segredo");
    expect(unseal(providerKey, body.p_key_cipher)).toBe("sk-segredo-1234");
    expect(body.p_key_hint).toBe("1234");
    // O endereço do catálogo não é guardado.
    expect(body.p_base_url).toBeNull();
  });

  it("alterar sem chave mantém a salva; sem AI_PROVIDER_KEY não salva chave nova", async () => {
    const { fetchImpl, calls } = database({ "rpc/ai_save_provider": providerId });
    await handleProviders(
      {
        action: "ai-provider-save",
        company,
        id: providerId,
        name: "OpenAI",
        kind: "openai",
        models: [{ id: "gpt-x", input: 2, output: 8 }],
      },
      token,
      env,
      { fetch: fetchImpl },
    );
    expect(calls[0].body.p_key_cipher).toBeNull();
    const res = await handleProviders(
      {
        action: "ai-provider-save",
        company,
        name: "OpenAI",
        kind: "openai",
        api_key: "sk-1",
        models: [],
      },
      token,
      { ...env, providerKey: null },
      { fetch: fetchImpl },
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("AI_PROVIDER_KEY");
  });

  it("recusa endereços internos", async () => {
    const res = await handleProviders(
      {
        action: "ai-provider-save",
        company,
        name: "Local",
        kind: "custom",
        base_url: "https://169.254.169.254/v1",
        api_key: "x",
        models: [],
      },
      token,
      env,
      { fetch: vi.fn() as any },
    );
    expect(res.status).toBe(400);
    expect(safeBaseUrl("http://api.exemplo.com")).toMatch(/https/);
    expect(safeBaseUrl("https://localhost:8080")).toBeTruthy();
    expect(safeBaseUrl("https://10.0.0.2/v1")).toBeTruthy();
    expect(safeBaseUrl("https://api.together.xyz/v1")).toBeNull();
  });

  it("busca os modelos com a chave salva e traz os preços que o provedor informa", async () => {
    const { fetchImpl, calls } = database({
      "rpc/ai_provider_secret": [
        {
          kind: "openrouter",
          base_url: null,
          key_cipher: seal(providerKey, "sk-or"),
          models: [{ id: "b/modelo", input: 3, output: 4 }],
        },
      ],
      "openrouter.ai/api/v1/models": {
        data: [
          {
            id: "b/modelo",
            name: "Modelo B",
          },
          {
            id: "a/modelo",
            name: "Modelo A",
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      },
    });
    const res = await handleProviders(
      { action: "ai-provider-models", company, id: providerId },
      token,
      env,
      { fetch: fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      { id: "a/modelo", label: "Modelo A", input: 1, output: 2 },
      { id: "b/modelo", label: "Modelo B", input: 3, output: 4 },
    ]);
    const list = calls.find((c) => c.url.includes("/models"))!;
    expect(list.auth).toBe("Bearer sk-or");
  });

  it("testa a conexão com uma pergunta curtinha", async () => {
    const { fetchImpl } = database({
      "rpc/ai_provider_list": { providers: [], routes: [] },
      "api.groq.com/openai/v1/chat/completions": {
        choices: [{ message: { content: "ok" } }],
      },
    });
    let t = 0;
    const res = await handleProviders(
      {
        action: "ai-provider-test",
        company,
        kind: "groq",
        api_key: "gsk",
        model: "llama",
      },
      token,
      env,
      { fetch: fetchImpl, now: () => (t += 150) },
    );
    expect(res).toEqual({ status: 200, body: { ok: true, ms: 150, reply: "ok" } });
  });

  it("Claude: lista os modelos pelo SDK", async () => {
    const { fetchImpl } = database({
      "rpc/ai_provider_list": { providers: [], routes: [] },
    });
    const res = await handleProviders(
      { action: "ai-provider-models", company, kind: "anthropic", api_key: "sk-ant" },
      token,
      env,
      {
        fetch: fetchImpl,
        anthropic: () =>
          ({
            models: {
              list: async function* () {
                yield { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" };
                yield { id: "claude-nova", display_name: "Claude Nova" };
              },
            },
          }) as any,
      },
    );
    expect(res.body.models).toEqual([
      { id: "claude-nova", label: "Claude Nova", input: undefined, output: undefined },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", input: 2, output: 10 },
    ]);
  });
});

describe("regra que vale (a mesma ordem do banco)", () => {
  const r = (type: AiRoute["type"], scope_id: string | null, provider_id = "p1"): AiRoute => ({
    id: `${type}-${scope_id}`,
    type,
    scope_id,
    provider_id,
    model: "m",
  });
  const all = [
    r("company", null),
    r("user", "u1"),
    r("client", "c1"),
    r("contract", "k1"),
    r("project", "p9", "off"),
  ];
  const on = new Set(["p1"]);
  it("projeto › produto › cliente › pessoa › empresa, só provedores ativos", () => {
    expect(pickRoute(all, { user: "u1", client: "c1", contract: "k1", project: "p9" }, on)?.type).toBe("contract");
    expect(pickRoute(all, { user: "u1", client: "c1" }, on)?.type).toBe("client");
    expect(pickRoute(all, { user: "u1" }, on)?.type).toBe("user");
    expect(pickRoute(all, { user: "u2" }, on)?.type).toBe("company");
    expect(pickRoute([], { user: "u2" }, on)).toBeNull();
  });
});

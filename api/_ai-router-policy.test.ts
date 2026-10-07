import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleAi, type AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import type { ProviderConfig } from "./_ai-providers";
import {
  chooseRoute,
  classify,
  NO_PROVIDER,
  routedLlm,
  routeContext,
  serverCandidates,
  strongerThan,
  type Candidate,
  type RouteContext,
} from "./_ai-router";
import { seal } from "./_google";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const me = "00000000-0000-4000-8000-000000000003";
const pOpenai = "00000000-0000-4000-8000-000000000009";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const providerKey = crypto.randomBytes(32);
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey,
};

const mini: Candidate = {
  providerId: pOpenai,
  provider: "OpenAI",
  kind: "openai",
  model: "gpt-5-mini",
  price: { id: "gpt-5-mini", input: 0.25, output: 2 },
  keyCipher: seal(providerKey, "sk-openai-agencia"),
  baseUrl: null,
};
const ctxOf = (over: Partial<RouteContext> = {}): RouteContext => ({
  mode: "active",
  level: "equilibrado",
  escalate: true,
  escalateCap: 0.5,
  sigiloso: false,
  restricted: false,
  server: true,
  candidates: [mini, ...serverCandidates(true)],
  ...over,
});
const simple = classify({ question: "Qual o e-mail do cliente?", surface: "page", feature: "mavi_page" });
const hard = classify({ question: "Monte a estratégia de mídia do trimestre", surface: "page", feature: "mavi_page" });
const rule = (scope: string, auto = false) => ({ scope, provider_id: pOpenai, model: "gpt-5-mini", auto });

describe("roteador · política", () => {
  it("sombra só sugere; ativo troca", () => {
    expect(chooseRoute({ signals: simple, ctx: ctxOf({ mode: "shadow" }), current: null })).toMatchObject({ apply: false, pick: null });
    const on = chooseRoute({ signals: simple, ctx: ctxOf(), current: null });
    expect(on.apply).toBe(true);
    expect(on.pick?.model).toBe("gpt-5-mini");
  });

  it("regra travada fica; com Automático e a da empresa, o roteador escolhe", () => {
    const locked = chooseRoute({ signals: hard, ctx: ctxOf(), current: rule("client") });
    expect(locked).toMatchObject({ apply: false, blocked: false });
    expect(locked.decision.mode).toBe("locked");
    expect(chooseRoute({ signals: hard, ctx: ctxOf(), current: rule("client", true) }).pick?.kind).toBe("anthropic");
    expect(chooseRoute({ signals: hard, ctx: ctxOf(), current: rule("company") }).apply).toBe(true);
  });

  it("privacidade vale até no modo sombra e até sobre a regra travada", () => {
    const only = ctxOf({ mode: "shadow", restricted: true, sigiloso: true, server: true, candidates: serverCandidates(true) });
    const ch = chooseRoute({ signals: simple, ctx: only, current: rule("client") });
    expect(ch).toMatchObject({ apply: true, blocked: true });
    expect(ch.pick?.providerId).toBeNull();
    expect(ch.decision.reason).toMatch(/não é permitida aqui \(cliente sigiloso\)/);
    // Sem lista, a regra vale mesmo que o provedor não esteja entre os candidatos.
    expect(chooseRoute({ signals: simple, ctx: ctxOf({ mode: "shadow", candidates: [] }), current: rule("client") }).blocked).toBe(false);
  });

  it("servidor fora da lista e nenhum candidato: bloqueado sem escolha", () => {
    const none = ctxOf({ restricted: true, server: false, candidates: [] });
    expect(chooseRoute({ signals: simple, ctx: none, current: null })).toMatchObject({ blocked: true, pick: null, apply: false });
  });

  it("reserva: outro provedor primeiro", () => {
    const ch = chooseRoute({ signals: simple, ctx: ctxOf(), current: null });
    expect(ch.fallbacks[0].providerId).toBeNull();
  });

  it("segunda tentativa: faixa acima da usada e dentro do teto", () => {
    expect(strongerThan(ctxOf(), simple, { providerId: pOpenai, model: "gpt-5-mini", kind: "openai" })?.model).toMatch(/opus|fable/);
    expect(strongerThan(ctxOf({ escalateCap: 0.0001 }), simple, { providerId: pOpenai, model: "gpt-5-mini", kind: "openai" })).toBeNull();
    expect(strongerThan(ctxOf(), simple, { providerId: null, model: "claude-opus-5-5", kind: "anthropic" })).toBeNull();
  });

  it("sem a migração da fase 2: sombra, sem escalonamento", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const c = await routeContext(env, fetchImpl, token, company, {}, "page", true);
    expect(c).toMatchObject({ mode: "shadow", escalate: false, restricted: false, server: true });
    expect(c.candidates.every((x) => x.providerId === null)).toBe(true);
  });
});

/** Banco falso: respostas por trecho da URL; guarda as chamadas. */
function database(routes: Record<string, unknown>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? routes[key] : []), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const policyRow = (over: Record<string, unknown> = {}) => ({
  mode: "active",
  level: "equilibrado",
  escalate: true,
  escalate_cap: 0.5,
  sigiloso: false,
  restricted: false,
  server: true,
  candidates: [
    {
      provider_id: pOpenai,
      name: "OpenAI",
      kind: "openai",
      base_url: null,
      key_cipher: seal(providerKey, "sk-openai-agencia"),
      models: [{ id: "gpt-5-mini", input: 0.25, output: 2 }],
    },
  ],
  ...over,
});
const world = (policy: unknown, route: unknown = null) =>
  database({
    "memberships?": [{ user_id: me, name: "Ana", email: "a@x.com", role: "admin", active: true, hidden_pages: [] }],
    "clients?": [{ id: client, name: "4282" }],
    "rpc/ai_resolve_route": route,
    "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
    "rpc/ai_save_turn": "conv-1",
    "rpc/ai_route_context": policy,
  });
const reply = (text: string, model: string): LlmAdapter => async (req) => {
  req.onEvent?.({ type: "text", text });
  const meter = newMeter(model);
  meter.cost = 0.001;
  return { text, meter, rounds: 1 };
};

describe("roteador · na MAVI (ativo)", () => {
  it("pergunta simples: o roteador escolhe o modelo barato e registra o motivo", async () => {
    const { fetchImpl, calls } = world(policyRow());
    const seen: ProviderConfig[] = [];
    const res = await handleAi({ action: "ai-ask", company, scope: { client }, question: "Qual o e-mail do cliente?" }, token, env, {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed: vi.fn(),
      providerLlm: (c) => (seen.push(c), reply("contato@x.com", c.model)),
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ model: "gpt-5-mini", apiKey: "sk-openai-agencia", name: "OpenAI" });
    expect(res.body.route).toMatchObject({ model: "gpt-5-mini", mode: "auto", escalated: false });
    const ctx = calls.find((c) => c.url.includes("ai_route_context"))!;
    expect(ctx.body).toMatchObject({ p_company: company, p_client: client, p_surface: "assistant" });
    const log = calls.find((c) => c.url.includes("ai_route_log"))!;
    expect(log.body.p_entry).toMatchObject({ mode: "auto", used_model: "gpt-5-mini", used_provider_id: pOpenai });
    const usage = calls.find((c) => c.url.includes("ai_log_usage"))!;
    expect(usage.body).toMatchObject({ p_provider: pOpenai, p_model: "gpt-5-mini" });
  });

  it("o escolhido falha: a reserva de outro provedor responde", async () => {
    const { fetchImpl, calls } = world(policyRow());
    const seen: string[] = [];
    const res = await handleAi({ action: "ai-ask", company, scope: { client }, question: "Qual o e-mail do cliente?" }, token, env, {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed: vi.fn(),
      providerLlm: (c) => {
        seen.push(c.model);
        return c.kind === "openai" ? async () => Promise.reject(new Error("503 fora do ar")) : reply("contato@x.com", c.model);
      },
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toBe("gpt-5-mini");
    expect(seen[1]).toMatch(/^claude-/);
    expect(res.body.answer).toBe("contato@x.com");
    expect(res.body.route.reason).toMatch(/gpt-5-mini falhou; respondeu claude-/);
    const log = calls.find((c) => c.url.includes("ai_route_log"))!;
    expect(log.body.p_entry.used_provider_id).toBeNull();
  });

  it("resposta fraca (prometeu e não fez): refaz com um modelo mais forte, marcado", async () => {
    const { fetchImpl, calls } = world(policyRow());
    const seen: string[] = [];
    // A Claude do servidor no modelo padrão usa o adaptador que a MAVI já tem.
    const server = vi.fn(reply("É contato@x.com.", env.model));
    const res = await handleAi({ action: "ai-ask", company, scope: { client }, question: "Qual o e-mail do cliente?" }, token, env, {
      fetch: fetchImpl,
      llm: async (req) => (seen.push(env.model), server(req)),
      embed: vi.fn(),
      providerLlm: (c) => {
        seen.push(c.model);
        return c.kind === "openai" ? reply("Certo, agora vou buscar o e-mail.", c.model) : reply("É contato@x.com.", c.model);
      },
    });
    expect(res.body.error).toBeUndefined();
    expect(res.body.answer).toBe("É contato@x.com.");
    expect(seen).toHaveLength(2);
    expect(res.body.route.escalated).toBe(true);
    expect(calls.find((c) => c.url.includes("ai_route_log"))!.body.p_entry.escalated).toBe(true);
    // O gasto das duas tentativas entra no consumo.
    expect(calls.filter((c) => c.url.includes("ai_log_usage") && c.body.p_kind === "ask")).toHaveLength(2);
  });

  it("no modo sombra nada muda: a regra (ou o servidor) responde", async () => {
    const { fetchImpl } = world(policyRow({ mode: "shadow" }));
    const llm = vi.fn(reply("ok", "claude-opus-5-5"));
    const res = await handleAi({ action: "ai-ask", company, scope: { client }, question: "Qual o e-mail do cliente?" }, token, env, {
      fetch: fetchImpl,
      llm,
      embed: vi.fn(),
      providerLlm: () => {
        throw new Error("não devia");
      },
    });
    expect(llm).toHaveBeenCalledOnce();
    expect(res.body.route).toMatchObject({ mode: "shadow", suggested: "gpt-5-mini" });
  });

  it("nenhum provedor permitido: avisa e não responde", async () => {
    const { fetchImpl } = world(policyRow({ restricted: true, server: false, candidates: [] }));
    const res = await handleAi({ action: "ai-ask", company, scope: { client }, question: "oi" }, token, env, {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed: vi.fn(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NO_PROVIDER);
  });
});

describe("roteador · telas de uma chamada (ativo)", () => {
  const base = {
    env: { supabaseUrl: "https://db.example.com", supabaseKey: "k" },
    auth: token,
    where: { company, surface: "task_search", feature: "task_search" },
    used: { providerId: null, model: "claude-opus-5-5" },
    question: "tarefas atrasadas",
    structured: true,
    hasServerKey: true,
    log: (async () => null) as never,
    later: () => {},
  };
  const request = { instructions: "", context: "", messages: [{ role: "user" as const, content: "x" }], tools: [], execute: async () => "" };

  it("troca para o escolhido e avisa quem registra o consumo", async () => {
    const { fetchImpl } = world(policyRow());
    const onUsed = vi.fn();
    const made: string[] = [];
    const llm = routedLlm(vi.fn(), {
      ...base,
      fetch: fetchImpl,
      open: { providerKey, anthropicKey: "sk-ant", make: (c) => (made.push(c.model), reply("{}", c.model)) },
      onUsed,
    });
    const out = await llm(request);
    expect(out.meter.model).toBe("gpt-5-mini");
    expect(made).toEqual(["gpt-5-mini"]);
    expect(onUsed.mock.calls[0][0]).toMatchObject({ providerId: pOpenai });
  });

  it("o escolhido falha: a reserva responde; sem provedor permitido, avisa", async () => {
    const { fetchImpl } = world(policyRow());
    const llm = routedLlm(vi.fn(), {
      ...base,
      fetch: fetchImpl,
      open: {
        providerKey,
        anthropicKey: "sk-ant",
        make: (c) => (c.kind === "openai" ? async () => Promise.reject(new Error("caiu")) : reply("{}", c.model)),
      },
    });
    expect((await llm(request)).meter.model).toMatch(/^claude-/);
    const blocked = world(policyRow({ restricted: true, server: false, candidates: [] }));
    const none = routedLlm(vi.fn(), { ...base, fetch: blocked.fetchImpl, open: { providerKey, anthropicKey: "sk-ant", make: vi.fn() } });
    await expect(none(request)).rejects.toThrow(NO_PROVIDER);
  });
});

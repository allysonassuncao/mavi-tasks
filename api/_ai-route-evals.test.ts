import { describe, expect, it, vi } from "vitest";
import {
  chooseRoute,
  classify,
  decide,
  evalCandidate,
  routeContext,
  serverCandidates,
  type Candidate,
  type RouteContext,
} from "./_ai-router";
import { evalItem, parsePairwise, runRouteEvals, verdictFor, type EvalItem } from "./_ai-route-evals";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import type { CompanyKit } from "./_mavi-judge";
import { newMeter } from "./_social-leads";

const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
};
const claude = serverCandidates(true);
const write = classify({ question: "Escreva um e-mail para o cliente", surface: "page", feature: "mavi_page" });

describe("roteador · aprendizado", () => {
  it("um modelo abaixo da faixa entra quando provou que dá conta (nota real ≥ 90% em 20+ respostas)", () => {
    expect(decide({ signals: write, level: "equilibrado", candidates: claude }).suggested?.model).toBe("claude-sonnet-5");
    const proved = [{ model: "claude-haiku-4-5", taskType: "redacao" as const, n: 30, quality: 0.95 }];
    const d = decide({ signals: write, level: "equilibrado", candidates: claude, stats: proved });
    expect(d.suggested?.model).toBe("claude-haiku-4-5");
    expect(d.reason).toMatch(/aprendido: atendeu redação com 95% em 30 respostas/);
    expect(d.scored.find((x) => x.model === "claude-haiku-4-5")?.out).toBeUndefined();
    // Sem provar (nota baixa ou poucas respostas): continua de fora.
    for (const stats of [[{ ...proved[0], quality: 0.8 }], [{ ...proved[0], n: 10 }]])
      expect(decide({ signals: write, level: "equilibrado", candidates: claude, stats }).suggested?.model).toBe("claude-sonnet-5");
  });

  it("nota real ruim de um modelo da faixa: outro ganha", () => {
    const bad = [{ model: "claude-sonnet-5", taskType: "redacao" as const, n: 40, quality: 0.6 }];
    const d = decide({ signals: write, level: "equilibrado", candidates: claude, stats: bad });
    expect(d.suggested?.model).not.toBe("claude-sonnet-5");
  });

  it("pessoa com respostas ruins recentes no tipo de pedido: um degrau a mais (e o registro mostra)", () => {
    const ctx: RouteContext = {
      mode: "active",
      level: "equilibrado",
      escalate: true,
      escalateCap: 0.5,
      sigiloso: false,
      restricted: false,
      server: true,
      candidates: claude,
      stats: [],
      personBad: ["redacao"],
    };
    const ch = chooseRoute({ signals: write, ctx, current: null });
    expect(ch.signals.complexity).toBe(3);
    expect(ch.signals.why).toContain("respostas ruins recentes para esta pessoa");
    expect(ch.decision.needTier).toBe(3);
    expect(chooseRoute({ signals: write, ctx: { ...ctx, personBad: [] }, current: null }).signals.complexity).toBe(2);
  });

  it("a política traz o ranking e os tipos ruins da pessoa", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          mode: "active",
          level: "equilibrado",
          escalate: true,
          escalate_cap: 0.5,
          sigiloso: false,
          restricted: false,
          server: true,
          candidates: [],
          stats: [{ task_type: "consulta", model: "claude-haiku-4-5", n: 25, quality: "0.940" }, { task_type: "x", model: "m", n: 9, quality: 1 }],
          person_bad: ["analise", "inventado"],
        }),
      ),
    ) as unknown as typeof fetch;
    const c = await routeContext(env, fetchImpl, "Bearer t", "c", {}, "page", true);
    expect(c.stats).toEqual([{ model: "claude-haiku-4-5", taskType: "consulta", n: 25, quality: 0.94 }]);
    expect(c.personBad).toEqual(["analise"]);
  });

  it("candidato do teste fora do ar: o sugerido, se for outro; senão, um da faixa abaixo e mais barato", () => {
    const d = decide({ signals: write, level: "equilibrado", candidates: claude });
    expect(evalCandidate(d, { providerId: null, model: "claude-opus-5-5" })).toEqual({ provider_id: null, model: "claude-sonnet-5" });
    expect(evalCandidate(d, { providerId: null, model: "claude-sonnet-5" })).toEqual({ provider_id: null, model: "claude-haiku-4-5" });
    const learned = decide({
      signals: write,
      level: "equilibrado",
      candidates: claude,
      stats: [{ model: "claude-haiku-4-5", taskType: "redacao", n: 30, quality: 0.95 }],
    });
    // O mais barato já respondeu e não há faixa abaixo: nada a testar.
    expect(evalCandidate(learned, { providerId: null, model: "claude-haiku-4-5" })).toBeNull();
    expect(evalCandidate(d, { providerId: "outro", model: "x" })).toEqual({ provider_id: null, model: "claude-sonnet-5" });
  });
});

describe("testes fora do ar", () => {
  it("o veredito segue a ordem em que o candidato apareceu", () => {
    expect(verdictFor({ winner: "A", confidence: 1, explanation: "" }, true)).toBe("better");
    expect(verdictFor({ winner: "A", confidence: 1, explanation: "" }, false)).toBe("worse");
    expect(verdictFor({ winner: "tie", confidence: 1, explanation: "" }, true)).toBe("same");
    expect(parsePairwise('ok {"winner":"B","confidence":1.4,"explanation":"x"}')).toEqual({ winner: "B", confidence: 1, explanation: "x" });
    expect(parsePairwise('{"winner":"?"}').winner).toBe("tie");
    expect(() => parsePairwise("sem json")).toThrow();
  });

  const item = (over: Partial<EvalItem> = {}): EvalItem => ({
    id: 2,
    company: "c",
    message: 10,
    task_type: "redacao",
    base_model: "claude-opus-5-5",
    candidate_model: "claude-opus-5-5",
    candidate: null,
    material: {
      question: "Escreva o e-mail de boas-vindas",
      answer: "Resposta real [S1]",
      client: "ACME",
      sources: [{ ref: "S1", type: "task", title: "Onboarding", date: null, excerpt: "Boas-vindas na segunda." }],
      dossier: [{ kind: "prefers", text: "Tom informal" }],
    },
    ...over,
  });
  const world = () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("null", { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it("o candidato responde com o material; o juiz compara às cegas; grava veredito e gasto", async () => {
    const { calls, fetchImpl } = world();
    const seen: { who: string; content: string; context: string }[] = [];
    const candidate: LlmAdapter = async (r) => {
      seen.push({ who: "candidato", content: r.messages[0].content, context: r.context });
      const meter = newMeter("claude-opus-5-5");
      meter.cost = 0.01;
      return { text: "Resposta do candidato [S1]", meter, rounds: 1 };
    };
    const judge: LlmAdapter = async (r) => {
      seen.push({ who: "juiz", content: r.messages[0].content, context: "" });
      return { text: '{"winner":"A","confidence":0.8,"explanation":"A cita a fonte e segue o tom."}', meter: newMeter("claude-sonnet-5"), rounds: 1 };
    };
    const kit: CompanyKit = { llm: judge, route: null, model: "claude-sonnet-5", jev: null, jevRoute: null };
    const v = await evalItem(env, { fetch: fetchImpl, llm: candidate, embed: vi.fn() }, kit, item());
    // Teste par: o candidato é a resposta A (e ganhou).
    expect(v).toBe("better");
    expect(seen[0].content).toBe("Escreva o e-mail de boas-vindas");
    expect(seen[0].context).toContain("[S1] task “Onboarding”: Boas-vindas na segunda.");
    expect(seen[0].context).toContain("Tom informal");
    expect(seen[1].content.indexOf("Resposta do candidato")).toBeLessThan(seen[1].content.indexOf("Resposta real"));
    const store = calls.find((c) => c.url.includes("ai_route_eval_store"))!.body;
    expect(store).toMatchObject({ p_id: 2, p_verdict: "better", p_confidence: 0.8, p_answer: "Resposta do candidato [S1]" });
    expect(store.p_usage.map((u: any) => u.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
    // Ímpar: o candidato é a B; "A" ganhou = a resposta real ganhou.
    const odd = await evalItem(env, { fetch: fetchImpl, llm: candidate, embed: vi.fn() }, kit, item({ id: 3 }));
    expect(odd).toBe("worse");
  });

  it("candidato da biblioteca: abre o provedor; sem pergunta ou sem juiz, falha (e a fila tenta de novo)", async () => {
    const { fetchImpl } = world();
    const made: string[] = [];
    const deps = {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed: vi.fn(),
      providerLlm: ((c: { model: string; kind: string }) => {
        made.push(`${c.kind}:${c.model}`);
        return async () => ({ text: "ok", meter: newMeter(c.model), rounds: 1 });
      }) as any,
    };
    const kit: CompanyKit = {
      llm: async () => ({ text: '{"winner":"tie","confidence":0.6}', meter: newMeter("j"), rounds: 1 }),
      route: null,
      model: "j",
      jev: null,
      jevRoute: null,
    };
    await evalItem(env, deps, kit, item({ candidate_model: "claude-haiku-4-5" }));
    expect(made).toEqual(["anthropic:claude-haiku-4-5"]);
    await expect(evalItem(env, deps, kit, item({ material: null }))).rejects.toThrow("Sem a pergunta");
    await expect(evalItem(env, deps, { ...kit, llm: null }, item())).rejects.toThrow("Sem modelo para comparar");
  });

  it("a fila: pega, testa, registra a falha e para quando acaba", async () => {
    let claims = 0;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("ai_route_eval_claim"))
        return new Response(JSON.stringify(claims++ === 0 ? [item({ id: 4 }), item({ id: 5, material: null })] : []));
      if (url.includes("ai_worker_route") || url.includes("mavi_judge_jev")) return new Response("null");
      return new Response("null");
    }) as unknown as typeof fetch;
    const llm: LlmAdapter = async (r) =>
      r.instructions.startsWith("Você compara")
        ? { text: '{"winner":"tie","confidence":0.7}', meter: newMeter("j"), rounds: 1 }
        : { text: "ok", meter: newMeter(env.model), rounds: 1 };
    const stats = await runRouteEvals(env, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => 0 }, 120_000);
    expect(stats).toMatchObject({ tested: 1, same: 1, failed: 1 });
    expect(calls.filter((u) => u.includes("ai_route_eval_fail"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("ai_route_eval_claim"))).toHaveLength(2);
  });
});

// O teste de "sem sinal: entra no sorteio" fica no de ponta a ponta da MAVI (abaixo).
describe("amostra na MAVI", () => {
  it("resposta sem sinal pede o sorteio; com sinal, não", async () => {
    const { handleAi } = await import("./_ai");
    const me = "00000000-0000-4000-8000-000000000003";
    const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
    const run = async (text: string) => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        calls.push(url);
        const routes: Record<string, unknown> = {
          "memberships?": [{ user_id: me, name: "Ana", email: "", role: "admin", active: true }],
          "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
          "rpc/ai_save_turn": "00000000-0000-4000-8000-0000000000c1",
          "rpc/ai_usage_close_turn": 77,
        };
        const k = Object.keys(routes).find((x) => url.includes(x));
        return new Response(JSON.stringify(k ? routes[k] : []), { status: 200 });
      }) as unknown as typeof fetch;
      const meter = newMeter(env.model);
      meter.cost = 0.001;
      await handleAi({ action: "ai-ask", company: "00000000-0000-4000-8000-000000000001", scope: {}, question: "Oi" }, token, env, {
        fetch: fetchImpl,
        llm: async () => ({ text, meter, rounds: 1 }),
        embed: vi.fn(),
      });
      return calls;
    };
    const plain = await run("Olá! Como posso ajudar?");
    expect(plain.some((u) => u.includes("mavi_answer_sample"))).toBe(true);
    const flagged = await run("Certo, agora vou buscar os dados.");
    expect(flagged.some((u) => u.includes("mavi_answer_signal"))).toBe(true);
    expect(flagged.some((u) => u.includes("mavi_answer_sample"))).toBe(false);
  });
});

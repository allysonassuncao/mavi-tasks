import { describe, expect, it, vi } from "vitest";
import {
  chooseRoute,
  classify,
  decide,
  logDecision,
  needTier,
  observedComplexity,
  routeContext,
  serverCandidates,
  underestimated,
  type Candidate,
  type RouteContext,
} from "./_ai-router";

const ask = (question: string) => classify({ question, surface: "page", feature: "mavi_page", toolCount: 40 });
const deepseek: Candidate = {
  providerId: "or",
  provider: "OpenRouter",
  kind: "openrouter",
  model: "deepseek/deepseek-v4.1-flash",
  price: { id: "deepseek/deepseek-v4.1-flash", input: 0.1, output: 0.4 },
};
const pool = [deepseek, ...serverCandidates(true)];

describe("leitura do pedido: entregáveis e várias etapas", () => {
  it("pedir um entregável não é consulta simples, mesmo numa frase curta", () => {
    const s = ask("Monte a apresentação do cliente 4841 com os resultados");
    expect(s).toMatchObject({ taskType: "visual", deliverable: true });
    expect(s.complexity).toBeGreaterThanOrEqual(2);
    expect(s.why).toContain("pede um entregável");
    expect(ask("Escreva o relatório mensal da ACME")).toMatchObject({ taskType: "redacao", deliverable: true });
  });

  it("trabalho com várias etapas também sobe", () => {
    const s = ask("Levante os resultados das campanhas do cliente 4841");
    expect(s.deliverable).toBe(true);
    expect(s.complexity).toBeGreaterThanOrEqual(2);
    expect(s.why).toContain("trabalho com várias etapas");
  });

  it("citar um entregável numa pergunta não é pedir para criar", () => {
    expect(ask("Qual o prazo do relatório?")).toMatchObject({ taskType: "consulta", complexity: 1 });
    expect(ask("Qual o prazo do relatório?").deliverable).toBeUndefined();
    expect(ask("Como faço para mudar a senha?").deliverable).toBeUndefined();
  });

  it("entregável pede faixa 2 em qualquer nível de custo", () => {
    const s = ask("Monte a apresentação do cliente 4841");
    expect(needTier(s, "economico")).toBe(2);
    expect(needTier(s, "equilibrado")).toBeGreaterThanOrEqual(2);
  });
});

describe("modelo sem histórico", () => {
  it("família desconhecida começa abaixo: no simples, ganha o barato conhecido; no entregável, o intermediário conhecido", () => {
    const simple = decide({ signals: ask("Qual o e-mail do cliente?"), level: "equilibrado", candidates: pool });
    expect(simple.suggested?.model).toBe("claude-haiku-4-5");
    const made = decide({ signals: ask("Monte a apresentação do cliente 4841"), level: "equilibrado", candidates: pool });
    expect(made.suggested?.model).toBe("claude-sonnet-5");
  });

  it("com nota real, o desconhecido volta a concorrer", () => {
    const s = ask("Qual o e-mail do cliente?");
    const stats = [{ model: deepseek.model, taskType: "consulta" as const, n: 40, quality: 0.95 }];
    expect(decide({ signals: s, level: "equilibrado", candidates: pool, stats }).suggested?.model).toBe(deepseek.model);
  });
});

describe("conferência depois da resposta", () => {
  it("complexidade observada pelas rodadas, ferramentas e entregáveis", () => {
    expect(observedComplexity({ rounds: 0 })).toBe(1);
    expect(observedComplexity({ rounds: 1, toolCalls: 3 })).toBe(2);
    expect(observedComplexity({ rounds: 2 })).toBe(2);
    expect(observedComplexity({ rounds: 4 })).toBe(3);
    expect(observedComplexity({ rounds: 1, artifacts: 1 })).toBe(3);
  });

  it("subestimada: a leitura ficou abaixo e o sugerido era de faixa abaixo do necessário", () => {
    const s = classify({ question: "Qual o e-mail do cliente?", surface: "page", feature: "mavi_page" });
    expect(underestimated(s, { suggestedTier: 1 }, 3)).toBe(true);
    expect(underestimated(s, { suggestedTier: 3 }, 3)).toBe(false);
    expect(underestimated(s, { suggestedTier: 1 }, 1)).toBe(false);
  });

  it("o registro leva o observado, a marca e não testa fora do ar o que criou entregável ou teve muitas rodadas", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("1");
    }) as unknown as typeof fetch;
    const s = classify({ question: "Qual o e-mail do cliente?", surface: "page", feature: "mavi_page" });
    const d = decide({ signals: s, level: "equilibrado", candidates: serverCandidates(true) });
    const base = { usedProviderId: null, usedModel: "claude-opus-5-5", firstTokenMs: 1, totalMs: 2, cost: 0.1 };
    const env = { supabaseUrl: "https://db.example.com", supabaseKey: "k" };
    await logDecision(env, fetchImpl, "Bearer t", { company: "c", surface: "page", feature: "mavi_page" }, s, d, {
      ...base,
      rounds: 3,
      artifacts: 1,
      toolsOk: 5,
    });
    expect(bodies[0].p_entry).toMatchObject({ observed_complexity: 3, underestimated: true, artifacts: 1, eval_candidate: null });
    await logDecision(env, fetchImpl, "Bearer t", { company: "c", surface: "page", feature: "mavi_page" }, s, d, { ...base, rounds: 0 });
    expect(bodies[1].p_entry).toMatchObject({ observed_complexity: 1, underestimated: false });
    expect(bodies[1].p_entry.eval_candidate).not.toBeNull();
  });

  it("tipos de pedido que costumam ficar abaixo sobem um degrau", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          mode: "shadow",
          level: "equilibrado",
          escalate: true,
          escalate_cap: 0.5,
          sigiloso: false,
          restricted: false,
          server: true,
          candidates: [],
          underestimated_types: ["consulta", "inventado"],
        }),
      ),
    ) as unknown as typeof fetch;
    const ctx: RouteContext = await routeContext({ supabaseUrl: "https://db.example.com", supabaseKey: "k" }, fetchImpl, "Bearer t", "c", {}, "page", true);
    expect(ctx.underestimatedTypes).toEqual(["consulta"]);
    const ch = chooseRoute({ signals: classify({ question: "Qual o e-mail do cliente?", surface: "page", feature: "mavi_page" }), ctx, current: null });
    expect(ch.signals.complexity).toBe(2);
    expect(ch.signals.why).toContain("pedidos assim costumam precisar de mais");
  });
});

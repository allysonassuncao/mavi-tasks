import { describe, expect, it, vi } from "vitest";
import { logCost, meterEntries, newTurn, turnCost, turnDetail } from "./_ai-cost";
import { anthropicAdapter, type RoundUsage } from "./_ai-llm";
import { addUsage, newMeter } from "./_social-leads";

describe("custo da conversa por modelo", () => {
  it("o fallback da Claude conta à parte: uma linha por modelo que respondeu", () => {
    const meter = newMeter("claude-fable-5-1");
    addUsage(meter, "claude-fable-5-1", { input_tokens: 1000, output_tokens: 200 });
    addUsage(meter, "claude-opus-4-8", { input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 9000 });
    const lines = meterEntries("ask", meter, "p1", "", "Claude da agência");
    expect(lines.map((l) => [l.model, l.input, l.output, l.cacheRead])).toEqual([
      ["claude-fable-5-1", 1000, 200, 0],
      ["claude-opus-4-8", 3000, 500, 9000],
    ]);
    // A soma das linhas é o total do medidor.
    expect(lines.reduce((n, l) => n + l.cost, 0)).toBeCloseTo(meter.cost, 9);
    expect(lines.every((l) => l.provider === "p1" && l.providerName === "Claude da agência")).toBe(true);
  });

  it("medidor sem divisão: uma linha com o modelo de reserva", () => {
    expect(meterEntries("ask", newMeter(""), null, "claude-opus-5-5")).toMatchObject([
      { kind: "ask", model: "claude-opus-5-5", cost: 0 },
    ]);
  });

  it("o resumo da vez junta por modelo e diz para que cada um foi usado", () => {
    const base = { provider: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, embedding: 0 };
    const t = turnCost([
      { ...base, kind: "ask", model: "claude-opus-5-5", input: 100, cost: 0.01 },
      { ...base, kind: "search", model: "text-embedding-3-small", embedding: 50, cost: 0.000001 },
      { ...base, kind: "canvas", model: "claude-opus-5-5", output: 30, cost: 0.02 },
      { ...base, kind: "image", model: "gpt-image-1", cost: 0.042, provider: "p2", providerName: "OpenAI" },
    ]);
    expect(t.cost).toBe(0.072001);
    expect(t.models.map((m) => [m.model, m.kinds, m.cost])).toEqual([
      ["gpt-image-1", ["image"], 0.042],
      ["claude-opus-5-5", ["ask", "canvas"], 0.03],
      ["text-embedding-3-small", ["search"], 0.000001],
    ]);
    expect(t.models[0].provider).toBe("OpenAI");
  });

  it("registra com a conversa e a vez; banco antigo (sem a migração) registra sem elas", async () => {
    const bodies: any[] = [];
    let first = true;
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      if (first) {
        first = false;
        return new Response(JSON.stringify({ message: "Could not find the function" }), { status: 404 });
      }
      return new Response("null", { status: 200 });
    }) as unknown as typeof fetch;
    const turn = newTurn("00000000-0000-4000-8000-0000000000c1");
    await logCost(
      { supabaseUrl: "https://db", supabaseKey: "k" },
      fetchImpl,
      "Bearer x",
      { company: "c" },
      { kind: "ask", model: "m", provider: null, input: 1, output: 2, cacheRead: 0, cacheWrite: 0, embedding: 0, cost: 0.5 },
      turn,
    );
    expect(bodies[0]).toMatchObject({ p_conversation: turn.conversation, p_turn: turn.turn, p_cost: 0.5 });
    expect(bodies[1].p_turn).toBeUndefined();
    expect(turn.entries).toHaveLength(1);
    expect(turn.pending).toHaveLength(1);
  });

  it("o passo a passo: a entrada da 1ª rodada dividida pelas partes, e quanto da saída é o texto", () => {
    const d = turnDetail({
      rounds: [
        { model: "claude-opus-5-5", input: 900, cacheRead: 9000, cacheWrite: 100, output: 300, cost: 0.02, tools: ["search_knowledge"] },
        { model: "claude-opus-5-5", input: 2500, cacheRead: 10000, cacheWrite: 0, output: 700, cost: 0.03, tools: [] },
      ],
      tools: [{ tool: "search_knowledge", label: "Buscando “verba”", ok: true, ms: 812.4, cost: 0 }],
      parts: { question: 100, extras: 0, history: 900, instructions: 8000, context: 1000 },
      answerChars: 1400,
    });
    // 10.000 tokens na 1ª rodada, divididos pelo tamanho de cada parte.
    expect(d.prompt).toEqual({ question: 100, extras: 0, history: 900, instructions: 8000, context: 1000 });
    expect(d.output).toBe(1000);
    expect(d.answer).toBe(400);
    expect(d.tools[0]).toEqual({ tool: "search_knowledge", label: "Buscando “verba”", ok: true, ms: 812, cost: 0 });
  });

  it("a Claude conta cada rodada: tokens, custo e as ferramentas pedidas", async () => {
    let round = 0;
    const client = {
      beta: {
        messages: {
          stream: () => {
            const first = round++ === 0;
            return {
              on: () => undefined,
              finalMessage: async () => ({
                model: "claude-opus-5-5",
                stop_reason: first ? "tool_use" : "end_turn",
                content: first
                  ? [{ type: "tool_use", id: "t1", name: "search_knowledge", input: {} }]
                  : [{ type: "text", text: "pronto" }],
                usage: first
                  ? { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 4000 }
                  : { input_tokens: 600, output_tokens: 400, cache_read_input_tokens: 4000 },
              }),
            };
          },
        },
      },
    };
    const rounds: RoundUsage[] = [];
    const out = await anthropicAdapter({ anthropicKey: "", model: "claude-opus-5-5" }, client as never)({
      instructions: "i",
      context: "c",
      messages: [{ role: "user", content: "oi" }],
      tools: [{ name: "search_knowledge", description: "d", parameters: { type: "object" } }],
      execute: async () => "achei",
      onRound: (r) => rounds.push(r),
    });
    expect(rounds.map((r) => [r.input, r.cacheWrite, r.cacheRead, r.output, r.tools])).toEqual([
      [1000, 4000, 0, 50, ["search_knowledge"]],
      [600, 0, 4000, 400, []],
    ]);
    // As rodadas somam o total do medidor.
    expect(rounds[0].cost + rounds[1].cost).toBeCloseTo(out.meter.cost, 9);
  });
});

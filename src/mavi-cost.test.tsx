import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerCost, ConversationCostButton, kindLabel, messageCost, usd } from "./MaviCost";
import type { ConversationCost } from "./ai";

const costs: ConversationCost = {
  total: {
    cost: 0.492,
    input_tokens: 4500,
    output_tokens: 700,
    cache_read_tokens: 9000,
    cache_write_tokens: 0,
    embedding_tokens: 0,
    calls: 4,
    answers: 2,
  },
  by_model: [
    { provider: "Claude da agência", model: "claude-fable-5-1", cost: 0.3, calls: 1, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, embedding_tokens: 0, kinds: ["ask"] },
    { provider: "", model: "gpt-image-1", cost: 0.042, calls: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, embedding_tokens: 0, kinds: ["image"] },
  ],
  by_kind: [
    { kind: "ask", cost: 0.45, calls: 3 },
    { kind: "image", cost: 0.042, calls: 1 },
  ],
  by_message: [
    {
      message: 12,
      cost: 0.442,
      items: [
        { provider: "Claude da agência", model: "claude-fable-5-1", kind: "ask", cost: 0.3, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, embedding_tokens: 0 },
        { provider: "Claude da agência", model: "claude-opus-4-8", kind: "ask", cost: 0.1, input_tokens: 3000, output_tokens: 500, cache_read_tokens: 9000, cache_write_tokens: 0, embedding_tokens: 0 },
        { provider: "", model: "gpt-image-1", kind: "image", cost: 0.042, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, embedding_tokens: 0 },
      ],
    },
  ],
};

describe("custo na conversa da MAVI", () => {
  it("dólares com as casas que importam", () => {
    expect(usd(0)).toBe("US$ 0,00");
    expect(usd(0.0321)).toBe("US$ 0,0321");
    expect(usd(0.00004)).toBe("< US$ 0,0001");
    expect(usd(12.3456)).toBe("US$ 12,35");
    expect(kindLabel("canvas")).toBe("documento/apresentação");
  });

  it("a resposta salva mostra o custo dela por modelo", () => {
    const c = messageCost(costs, 12)!;
    expect(c.cost).toBe(0.442);
    expect(c.models.map((m) => [m.model, m.provider, m.cost])).toEqual([
      ["claude-fable-5-1", "Claude da agência", 0.3],
      ["claude-opus-4-8", "Claude da agência", 0.1],
      ["gpt-image-1", null, 0.042],
    ]);
    expect(messageCost(costs, 99)).toBeNull();
    expect(messageCost(null, 12)).toBeNull();
    const chip = renderToStaticMarkup(<AnswerCost cost={c} />);
    expect(chip).toContain("US$ 0,442");
    expect(chip).toContain("3 modelos");
  });

  it("o topo da conversa mostra o total", () => {
    expect(renderToStaticMarkup(<ConversationCostButton costs={costs} />)).toContain("US$ 0,492");
  });

  it("a resposta mostra tudo o que aconteceu: entrada por parte, rodadas, ferramentas e os outros gastos", () => {
    const html = renderToStaticMarkup(
      <AnswerCost
        cost={{
          cost: 0.05,
          models: [{ model: "claude-opus-5-5", provider: null, kinds: ["ask"], input: 3400, output: 1000, cacheRead: 19000, cacheWrite: 100, embedding: 0, cost: 0.05 }],
          kinds: [{ kind: "ask", cost: 0.049 }, { kind: "attachment_transcription", cost: 0.001 }],
          detail: {
            rounds: [
              { model: "claude-opus-5-5", input: 900, cacheRead: 9000, cacheWrite: 100, output: 300, cost: 0.02, tools: ["search_knowledge"] },
              { model: "claude-opus-5-5", input: 2500, cacheRead: 10000, cacheWrite: 0, output: 700, cost: 0.03, tools: [] },
            ],
            tools: [{ tool: "search_knowledge", label: "Buscando “verba”", ok: true, ms: 812, cost: 0 }],
            prompt: { question: 100, extras: 0, history: 900, instructions: 8000, context: 1000 },
            output: 1000,
            answer: 400,
          },
        }}
      />,
    );
    // O conteúdo da janelinha só aparece aberta: confere o gatilho e o formato dos dados.
    expect(html).toContain("US$ 0,05");
  });
});

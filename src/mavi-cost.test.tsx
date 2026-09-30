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
});

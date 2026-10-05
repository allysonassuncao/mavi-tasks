import { describe, expect, it } from "vitest";
import { applySuggestion, removedMessage } from "./agent-check";

describe("o ajuste sugerido pelo Radar no prompt do robô", () => {
  const prompt = "## Agendamento\n- Atendemos de segunda a sexta,\n  das 8h às 18h.\n- Limpeza: R$ 180,00.\n";

  it("troca o trecho exato", () => {
    expect(applySuggestion(prompt, { before: "Limpeza: R$ 180,00.", after: "Limpeza: R$ 200,00." })).toBe(
      "## Agendamento\n- Atendemos de segunda a sexta,\n  das 8h às 18h.\n- Limpeza: R$ 200,00.\n",
    );
  });

  it("acha o trecho com outras quebras de linha e espaços", () => {
    expect(
      applySuggestion(prompt, {
        before: "Atendemos de segunda a sexta, das 8h às 18h.",
        after: "Atendemos de segunda a sábado, das 8h às 18h.",
      }),
    ).toContain("- Atendemos de segunda a sábado, das 8h às 18h.\n- Limpeza");
  });

  it("sem trecho, acrescenta no fim; trecho que sumiu do prompt devolve nulo", () => {
    expect(applySuggestion(prompt, { before: "", after: " Aos sábados, das 8h às 12h. " })).toBe(
      "## Agendamento\n- Atendemos de segunda a sexta,\n  das 8h às 18h.\n- Limpeza: R$ 180,00.\n\nAos sábados, das 8h às 12h.",
    );
    expect(applySuggestion(prompt, { before: "Clareamento: R$ 500.", after: "x" })).toBeNull();
  });

  it("a mensagem diz quantas leituras do Termômetro voltam", () => {
    expect(removedMessage({ temperature: 0 })).toBe("Caso excluído.");
    expect(removedMessage({ temperature: 1 })).toMatch(/ler de novo a conversa sem essas falas/);
    expect(removedMessage({ temperature: 3 })).toMatch(/ler de novo 3 conversas/);
  });
});

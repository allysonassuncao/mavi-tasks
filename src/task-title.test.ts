import { describe, expect, it } from "vitest";
import { cleanTaskTitle, fallbackTaskTitle, TASK_TITLE_MAX } from "./task-title";

describe("título da tarefa pela MAVI", () => {
  it("limpa a resposta: uma linha, sem rótulo, aspas, markdown nem ponto final", () => {
    expect(cleanTaskTitle('\n**Título:** "Criar 3 artes para a Black Friday".\nOutra linha')).toBe(
      "Criar 3 artes para a Black Friday",
    );
    expect(cleanTaskTitle("“Revisar landing page”")).toBe("Revisar landing page");
    expect(cleanTaskTitle("")).toBe("");
  });

  it("corta títulos longos numa palavra inteira", () => {
    const long = cleanTaskTitle(
      "Criar a sequência completa de criativos em vídeo e carrossel para a campanha de lançamento do novo produto no Instagram",
    );
    expect(long.length).toBeLessThanOrEqual(TASK_TITLE_MAX);
    expect(long.endsWith(" ")).toBe(false);
    expect(
      "Criar a sequência completa de criativos em vídeo e carrossel para a campanha de lançamento".startsWith(long),
    ).toBe(true);
    expect(long.length).toBeGreaterThan(60);
  });

  it("sem a MAVI, usa a primeira frase em até 10 palavras", () => {
    expect(
      fallbackTaskTitle("  precisamos trocar o banner do site. O cliente mandou as fotos ontem."),
    ).toBe("Precisamos trocar o banner do site");
    expect(
      fallbackTaskTitle("um dois três quatro cinco seis sete oito nove dez onze doze"),
    ).toBe("Um dois três quatro cinco seis sete oito nove dez");
    expect(fallbackTaskTitle("   ")).toBe("");
  });
});

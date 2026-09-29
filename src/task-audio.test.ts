import { describe, expect, it } from "vitest";
import {
  audioRetryable,
  audioTranscripts,
  audioWorking,
  baseMime,
  formatDuration,
  pickRecorderMime,
} from "./task-audio";

const at = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

describe("áudios das tarefas", () => {
  it("grava no formato que o navegador aceita (WebM; no Safari, MP4)", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime((t) => t.startsWith("audio/mp4"))).toBe(
      "audio/mp4;codecs=mp4a.40.2",
    );
    expect(pickRecorderMime(() => false)).toBe("");
    expect(baseMime("audio/webm;codecs=opus")).toBe("audio/webm");
  });
  it("mostra a duração em minutos e segundos", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(94.4)).toBe("1:34");
    expect(formatDuration(300)).toBe("5:00");
  });
  it("tentar de novo: falhou, travou ou o resumo não saiu", () => {
    const base = {
      purpose: "description" as const,
      summary: null,
      error: null,
    };
    expect(audioWorking({ status: "transcribing", status_at: at(1) })).toBe(true);
    expect(audioRetryable({ ...base, status: "transcribing", status_at: at(1) })).toBe(false);
    expect(audioRetryable({ ...base, status: "transcribing", status_at: at(9) })).toBe(true);
    expect(audioRetryable({ ...base, status: "failed", status_at: at(0) })).toBe(true);
    expect(
      audioRetryable({ ...base, status: "ready", status_at: at(0), error: "sem resumo" }),
    ).toBe(true);
    // Fala curta: pronto sem resumo e sem erro.
    expect(audioRetryable({ ...base, status: "ready", status_at: at(0) })).toBe(false);
    expect(
      audioRetryable({ ...base, purpose: "comment", status: "ready", status_at: at(0), error: "x" }),
    ).toBe(false);
  });
  it("o Assistente MAVI lê o que foi dito, na ordem dos áudios", () => {
    expect(
      audioTranscripts([
        { transcript: "Subir a campanha." },
        { transcript: null },
        { transcript: "Sem laranja." },
      ]),
    ).toBe("Áudio 1: Subir a campanha.\nÁudio 3: Sem laranja.");
  });
});

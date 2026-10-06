import { describe, expect, it } from "vitest";
import { meaningfulChange, type CopilotDraft } from "./copilot";

const base: CopilotDraft = {
  company: "c",
  contract: "k1",
  title: "Carrossel da oferta de outubro",
  description: "Cinco cards com o preço e a chamada para o WhatsApp",
  due: "2026-10-10",
  extra: "Formato: 1080x1350",
  files: "",
};

describe("quando a MAVI analisa de novo sozinha", () => {
  it("texto, áudio ou produto mudaram: sim", () => {
    expect(meaningfulChange(null, base)).toBe(true);
    expect(
      meaningfulChange(base, {
        ...base,
        description: `${base.description} e um vídeo curto para os stories com depoimento`,
      }),
    ).toBe(true);
    expect(meaningfulChange(base, { ...base, audio: "Use a cor da marca" })).toBe(true);
    expect(meaningfulChange(base, { ...base, contract: "k2" })).toBe(true);
  });

  it("campos, anexos ou prazo: não (só com Revisar agora)", () => {
    expect(meaningfulChange(base, { ...base, due: "2026-10-12" })).toBe(false);
    expect(meaningfulChange(base, { ...base, files: "briefing.pdf" })).toBe(false);
    expect(meaningfulChange(base, { ...base, extra: "Formato: 1080x1920" })).toBe(false);
    expect(meaningfulChange(base, { ...base, description: `${base.description}.` })).toBe(false);
  });
});

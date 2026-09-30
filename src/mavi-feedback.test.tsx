import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerFeedback } from "./MaviFeedback";
import { MAVI_KIND_LABELS, MAVI_REASONS } from "./mavi-feedback";
import { AI_TABS, aiTab } from "./router";

describe("avaliação das respostas da MAVI", () => {
  it("os motivos do 👎 e os assuntos dos aprendizados são os do banco", () => {
    expect(MAVI_REASONS.map((r) => r.id)).toEqual(["incomplete", "wrong", "ignored", "invented", "format", "other"]);
    expect(Object.keys(MAVI_KIND_LABELS)).toEqual(["research", "answer", "format", "facts", "tasks"]);
  });

  it("os botões mostram o voto da pessoa", () => {
    const none = renderToStaticMarkup(<AnswerFeedback message={7} mine={null} onChange={() => {}} />);
    expect(none).toContain('aria-label="Boa resposta"');
    expect(none).toContain('aria-label="Resposta ruim"');
    expect(none.match(/aria-pressed="true"/g)).toBeNull();
    const down = renderToStaticMarkup(
      <AnswerFeedback message={7} mine={{ message: 7, vote: "down", reason: "incomplete", comment: "" }} onChange={() => {}} />,
    );
    expect(down).toMatch(/class="mavi-vote down on" aria-pressed="true"/);
  });

  it("a aba do Painel tem endereço próprio", () => {
    expect(AI_TABS).toContain("aprendizado");
    expect(aiTab("aprendizado")).toBe("aprendizado");
  });
});

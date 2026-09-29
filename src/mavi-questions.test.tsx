import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sanitizeArtifact, sanitizeQuestions, type QuestionArtifact } from "./mavi-artifacts";
import { QuestionCard, questionReply } from "./MaviQuestions";
import { AnswerText } from "./AiChat";
import { FEATURES, pickRoute, type AiRoute } from "./ai-providers";

const a: QuestionArtifact = {
  id: "question-1",
  ref: "Q1",
  type: "question",
  questions: [
    { question: "Para qual cliente?", options: ["4282", "4283"] },
    { question: "Quais canais?", options: ["Meta", "Google"], multiple: true },
  ],
};

describe("perguntas da MAVI", () => {
  it("até 3, com respostas sem repetir; o resto fica de fora", () => {
    expect(
      sanitizeQuestions([
        { question: "Qual período?", options: ["Setembro", "Setembro", "", "Agosto"] },
        { question: "?" },
        { question: "Tom?", options: [], multiple: "sim" },
        { question: "Público?" },
        { question: "Formato?" },
      ]),
    ).toEqual([
      { question: "Qual período?", options: ["Setembro", "Agosto"] },
      { question: "Tom?", options: [] },
      { question: "Público?", options: [] },
    ]);
    expect(sanitizeArtifact({ ...a, questions: [] })).toBeNull();
    expect(sanitizeArtifact(a)).toEqual(a);
  });

  it("as respostas viram a próxima mensagem", () => {
    expect(questionReply(a, [["4282"], ["Meta", "Google"]], ["", "e TikTok"])).toBe(
      "Minhas respostas:\n1. Para qual cliente?\n→ 4282\n2. Quais canais?\n→ Meta; Google; e TikTok",
    );
    expect(questionReply(a, [[], []], ["", ""])).toContain("→ tanto faz");
  });

  it("o card mostra as opções; respondido, só as perguntas", () => {
    const open = renderToStaticMarkup(<QuestionCard artifact={a} answered={false} disabled={false} onReply={() => {}} />);
    expect(open).toContain("Antes de seguir, a MAVI quer saber");
    expect(open).toContain('role="radio"');
    expect(open).toContain('role="checkbox"');
    expect(open).toContain("Pode seguir sem responder");
    const done = renderToStaticMarkup(<QuestionCard artifact={a} answered disabled={false} onReply={() => {}} />);
    expect(done).toContain("Perguntas respondidas");
    expect(done).not.toContain('role="radio"');
  });

  it("na bolinha, a linha [[Q1]] some (o card vem logo abaixo)", () => {
    const html = renderToStaticMarkup(<AnswerText text={"Antes, me diga:\n[[Q1]]"} />);
    expect(html).not.toContain("abra esta conversa no módulo MAVI");
    expect(html).toContain("Antes, me diga:");
  });
});

describe("um modelo para cada parte", () => {
  const routes: AiRoute[] = [
    { id: "c", type: "company", scope_id: null, provider_id: "p", model: "empresa" },
    { id: "b", type: "feature", scope_id: null, feature: "assistant", provider_id: "p", model: "bolinha" },
  ];
  const on = new Set(["p"]);
  it("o módulo sem regra segue a bolinha; com regra, a dele", () => {
    expect(pickRoute(routes, { feature: "mavi_page" }, on)?.model).toBe("bolinha");
    const own = [...routes, { id: "m", type: "feature" as const, scope_id: null, feature: "mavi_page" as const, provider_id: "p", model: "modulo" }];
    expect(pickRoute(own, { feature: "mavi_page" }, on)?.model).toBe("modulo");
    expect(pickRoute(own, { feature: "assistant" }, on)?.model).toBe("bolinha");
  });
  it("busca e escritor não herdam a empresa; estão no painel", () => {
    expect(pickRoute(routes, { feature: "web_search" }, on)).toBeNull();
    expect(pickRoute(routes, { feature: "canvas_writer" }, on)).toBeNull();
    const ids = FEATURES.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["assistant", "mavi_page", "web_search", "canvas_writer", "image_generation"]));
    expect(FEATURES.find((f) => f.id === "web_search")).toMatchObject({ web: true, own: true });
  });
});

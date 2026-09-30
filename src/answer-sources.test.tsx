import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerSources, SOURCES_FOLDED } from "./AiChat";
import type { AiSource } from "./ai";

const source = (n: number): AiSource => ({
  ref: `S${n}`,
  type: "meeting",
  id: `m${n}`,
  title: `Reunião ${n}`,
  date: "2026-08-31T12:00:00Z",
  client_id: null,
  start: n * 60,
});

describe("fontes da resposta", () => {
  it("poucas: todas, sem botão", () => {
    const html = renderToStaticMarkup(<AnswerSources sources={[1, 2, 3].map(source)} />);
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).not.toContain("Ver todas");
    expect(html).toContain(">Fontes<");
  });

  it("muitas: abre recolhida, com o total e o botão", () => {
    const list = Array.from({ length: 38 }, (_, i) => source(i + 1));
    const html = renderToStaticMarkup(<AnswerSources sources={list} />);
    expect(html.match(/<li>/g)).toHaveLength(5);
    expect(html).toContain("Fontes (38)");
    expect(html).toContain("Ver todas as 38 fontes");
    expect(html).toContain('aria-expanded="false"');
    expect(SOURCES_FOLDED).toBe(6);
    // No limite, ainda todas.
    expect(renderToStaticMarkup(<AnswerSources sources={list.slice(0, 6)} />).match(/<li>/g)).toHaveLength(6);
  });
});

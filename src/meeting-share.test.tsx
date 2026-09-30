import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedRecording } from "./PublicMeeting";
import {
  summaryPlainText,
  transcriptPlainText,
  type PublicMeeting,
} from "./meetings";

const transcript = {
  speakers: ["Cliente", "Ana"],
  segments: [
    [0, 3, 0, "Bom dia."],
    [3, 5, 0, "Tudo certo?"],
    [65, 70, 1, "Vamos falar da verba."],
    [null, null, 4, "Sem tempo."],
  ] as [number | null, number | null, number | null, string][],
  timed: true,
};
const view: Extract<PublicMeeting, { status: "ok" }> = {
  status: "ok",
  company: "Agência A",
  title: "Alinhamento de campanha",
  recorded_at: "2026-09-01T14:00:00Z",
  duration_seconds: 1800,
  speakers: ["Cliente", "Ana"],
  video: true,
  download: true,
  expires_at: null,
  show_transcript: true,
  show_summary: true,
  summary: {
    overview: "Falamos da verba.",
    notes: [{ title: "Verba", description: "Sobe em outubro." }],
    keywords: ["verba"],
  },
  transcript,
};
const render = (v: typeof view) =>
  renderToStaticMarkup(
    <SharedRecording
      token={"a".repeat(64)}
      password={null}
      view={v}
      start={0}
    />,
  );

describe("downloads em texto do link público", () => {
  it("a transcrição agrupa as falas de cada pessoa, com o tempo", () => {
    expect(transcriptPlainText("Reunião", transcript)).toBe(
      "Reunião\n\n[00:00] Cliente:\nBom dia.\nTudo certo?\n\n[01:05] Ana:\nVamos falar da verba.\n\nFalante 5:\nSem tempo.\n",
    );
  });
  it("o resumo leva visão geral, assuntos e temas", () => {
    expect(summaryPlainText("Reunião", view.summary!)).toBe(
      "Reunião\n\nFalamos da verba.\n\nAssuntos discutidos:\n1. Verba\n   Sobe em outubro.\n\nTemas: verba\n",
    );
  });
});

describe("página da gravação compartilhada", () => {
  it("mostra só as abas e os downloads que o link permite", () => {
    const all = render(view);
    expect(all).toContain("Agência A · Gravação compartilhada");
    const tabs = [
      ...all.matchAll(/role="tab"[^>]*>.*?<\/svg> (\S+)<\/button>/g),
    ];
    expect(tabs.map((t) => t[1])).toEqual(["Transcrição", "Resumo"]);
    expect(all).toContain("</svg> Vídeo</button>");
    expect(all).not.toContain("Perguntar à MAVI");
    expect(all).not.toContain("Próximos passos");

    const noDownload = render({ ...view, download: false });
    expect(noDownload).not.toContain("public-meeting-downloads");

    const summaryOnly = render({
      ...view,
      video: false,
      show_transcript: false,
      transcript: null,
    });
    expect(summaryOnly).not.toContain('aria-label="Vídeo"');
    expect(summaryOnly).not.toContain('role="tablist"');
    expect(summaryOnly).toContain("Falamos da verba.");
    expect(summaryOnly).toContain("no-video");
  });
  it("mostra até quando o link vale", () => {
    expect(render({ ...view, expires_at: "2026-10-10T15:00:00Z" })).toContain(
      "link válido até",
    );
  });
});

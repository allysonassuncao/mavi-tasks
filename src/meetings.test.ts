import { describe, expect, it } from "vitest";
import { parseDescription, richTextPlain } from "./rich-text";
import { hidePartial } from "./AiChat";
import {
  answerPieces,
  deadlineDate,
  eventRecordingWindow,
  meetLinkPattern,
  meetingKind,
  segmentAt,
  stepDescription,
  type MeetingSegment,
} from "./meetings";

describe("descrição da tarefa criada a partir de um próximo passo", () => {
  const value = stepDescription(
    {
      description: "Enviar proposta <final>",
      owner: "Kamilli",
      deadline: "Até 05/10",
    },
    {
      title: "Alinhamento",
      clientName: "4282",
      date: "01/10/2026",
      link: "https://app/drive?gravacao=x",
    },
  );
  it("sai no formato do editor, sem tags HTML visíveis", () => {
    expect(value.startsWith("mavi:richtext:v1:")).toBe(true);
    expect(richTextPlain(value)).not.toMatch(/<p>|<strong>/);
    expect(richTextPlain(value)).toContain("Enviar proposta <final>");
  });
  it("rótulos em negrito e o link da gravação", () => {
    const doc = parseDescription(value);
    const lines = doc.content!.map((p) =>
      (p.content ?? [])
        .map((t) =>
          t.marks?.some((m) => m.type === "bold") ? `*${t.text}*` : t.text,
        )
        .join(""),
    );
    expect(lines).toEqual([
      "Enviar proposta <final>",
      "*Responsável na reunião: *Kamilli",
      "*Prazo combinado: *Até 05/10",
      "*Reunião: *Alinhamento com 4282 em 01/10/2026",
      "*Gravação: *https://app/drive?gravacao=x",
    ]);
  });
  it("sem responsável nem prazo, essas linhas não aparecem", () => {
    const doc = parseDescription(
      stepDescription(
        { description: "Revisar", owner: "", deadline: "" },
        { title: "T", clientName: "C", date: "d", link: "l" },
      ),
    );
    expect(doc.content).toHaveLength(3);
  });
});

describe("apresentação das gravações", () => {
  it("tipo pela agenda", () => {
    expect(meetingKind("R2 4282")).toBe("R2");
    expect(meetingKind("RP 5027")).toBe("RP");
    expect(meetingKind("5038 - Possivel RP")).toBe("RP");
    expect(meetingKind("Alinhamento 4007")).toBe("Alinhamento");
    expect(meetingKind("Leandro & Make")).toBe("Outras");
  });
  it("prazo: só datas que ainda não passaram", () => {
    const today = new Date(2026, 8, 26);
    expect(deadlineDate("Até 05/10/2026", today)).toBe("2026-10-05");
    expect(deadlineDate("Até 25/07/2025", today)).toBe("");
    expect(deadlineDate("Antes da próxima reunião", today)).toBe("");
  });
  it("trecho tocando pela busca binária", () => {
    const segs: MeetingSegment[] = [
      [0, 2, 0, "a"],
      [2, 5, 1, "b"],
      [9, 12, 0, "c"],
    ];
    expect(segmentAt(segs, 3)).toBe(1);
    expect(segmentAt(segs, 7)).toBe(1);
    expect(segmentAt(segs, 10)).toBe(2);
    expect(segmentAt([[null, null, 0, "x"]], 3)).toBe(-1);
  });
  it("citações da IA viram momentos e reuniões", () => {
    expect(answerPieces("Veja **isto** [12:34] e [S2].")).toEqual([
      { kind: "text", text: "Veja " },
      { kind: "text", text: "isto", bold: true },
      { kind: "text", text: " " },
      { kind: "time", seconds: 754, label: "12:34" },
      { kind: "text", text: " e " },
      { kind: "source", ref: "S2" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("resposta digitando", () => {
  it("esconde citação, negrito e asterisco pela metade", () => {
    expect(hidePartial("o **Andrey** fez [S")).toBe("o **Andrey** fez ");
    expect(hidePartial("até **sexta-feira (19/09)** [S")).toBe(
      "até **sexta-feira (19/09)** ",
    );
    expect(hidePartial("até **sexta")).toBe("até ");
    expect(hidePartial("até *")).toBe("até ");
    expect(hidePartial("pronto [S1].")).toBe("pronto [S1].");
  });
});

describe("gravação de um evento da Agenda", () => {
  it("reconhece o link do Meet de qualquer jeito que foi salvo", () => {
    const pattern = "%meet.google.com/abc-defg-hij%";
    expect(meetLinkPattern("https://meet.google.com/abc-defg-hij")).toBe(
      pattern,
    );
    expect(
      meetLinkPattern(" meet.google.com/ABC-DEFG-HIJ?authuser=1&hs=122 "),
    ).toBe(pattern);
    expect(meetLinkPattern("https://meet.google.com/lookup/abc-defg-hij")).toBe(
      pattern,
    );
  });

  it("usa endereço e caminho nos outros serviços, sem curingas", () => {
    expect(meetLinkPattern("https://www.zoom.us/j/123_45%6?pwd=segredo")).toBe(
      "%zoom.us/j/123\\_45\\%6%",
    );
    expect(meetLinkPattern("")).toBeNull();
    expect(meetLinkPattern("reunião")).toBeNull();
  });

  it("procura de 30 min antes do início a 30 min depois do fim", () => {
    const { from, to } = eventRecordingWindow(
      "2026-10-01T14:00:00-03:00",
      "2026-10-01T15:30:00-03:00",
    );
    expect(from.toISOString()).toBe("2026-10-01T16:30:00.000Z");
    expect(to.toISOString()).toBe("2026-10-01T19:00:00.000Z");
  });
});

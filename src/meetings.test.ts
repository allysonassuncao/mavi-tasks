import { describe, expect, it } from "vitest";
import { parseDescription, richTextPlain } from "./rich-text";
import {
  answerPieces,
  deadlineDate,
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

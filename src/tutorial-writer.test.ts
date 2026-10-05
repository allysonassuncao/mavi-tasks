import { describe, expect, it } from "vitest";
import { DESCRIPTION_PREFIX, parseDescription, type RichNode } from "./rich-text";
import { draftBody, inlineNodes, transcribedVideos, writerOutline } from "./tutorial-writer";
import { periodDates } from "./TutorialMetrics";

const MEDIA = "00000000-0000-4000-8000-000000000001";
const IMAGE = "00000000-0000-4000-8000-000000000002";
const doc = (...content: RichNode[]) => DESCRIPTION_PREFIX + JSON.stringify({ type: "doc", content });
const p = (text: string, bold = false): RichNode => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(bold ? { marks: [{ type: "bold" }] } : {}) }],
});
const video: RichNode = { type: "tutorialVideo", attrs: { mediaId: MEDIA, label: "Passo a passo" } };
const image: RichNode = {
  type: "paragraph",
  content: [{ type: "inlineImage", attrs: { imageId: IMAGE, alt: "Tela" } }],
};

describe("o texto aberto para a MAVI", () => {
  it("vira linhas com títulos, listas e [[MIDIA n]] no lugar das imagens e vídeos", () => {
    const body = doc(
      p("Introdução"),
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Criar" }] },
      video,
      {
        type: "orderedList",
        content: [
          { type: "listItem", content: [p("Abra")] },
          { type: "listItem", content: [p("Salvar", true)] },
        ],
      },
      image,
    );
    const out = writerOutline(body);
    expect(out.text).toBe(
      "Introdução\n## Criar\n[[MIDIA 1]] (vídeo: Passo a passo)\n1. Abra\n2. **Salvar**\n[[MIDIA 2]] (imagem)",
    );
    expect(out.media).toEqual([video, image]);
  });
});

describe("os blocos da MAVI no editor", () => {
  it("negrito vira marca", () => {
    expect(inlineNodes("Clique em **Salvar** e pronto")).toEqual([
      { type: "text", text: "Clique em " },
      { type: "text", text: "Salvar", marks: [{ type: "bold" }] },
      { type: "text", text: " e pronto" },
    ]);
    expect(inlineNodes("sem ** fechar")).toEqual([{ type: "text", text: "sem  fechar" }]);
  });

  it("monta seções, passos e listas; as mídias voltam no lugar e as que sobraram no fim", () => {
    const body = draftBody(
      [
        { type: "paragraph", text: "Intro" },
        { type: "heading", level: 3, text: "Passos" },
        { type: "steps", items: ["Um", "Dois"] },
        { type: "media", n: 2 },
        { type: "list", items: ["Item"] },
        { type: "media", n: 2 },
        { type: "media", n: 7 },
      ],
      [video, image],
    );
    const nodes = parseDescription(body).content ?? [];
    expect(nodes.map((n) => n.type)).toEqual([
      "paragraph",
      "heading",
      "orderedList",
      "paragraph", // a imagem (MIDIA 2), uma vez só
      "bulletList",
      "tutorialVideo", // o vídeo que a MAVI não recolocou
    ]);
    expect(nodes[1].attrs?.level).toBe(3);
    expect(nodes[2].content).toHaveLength(2);
    expect(nodes[3].content?.[0].type).toBe("inlineImage");
    expect(nodes[5].attrs?.mediaId).toBe(MEDIA);
  });
});

describe("os vídeos com transcrição", () => {
  it("os enviados (pela transcrição do envio) e os de link (no próprio texto)", () => {
    const body = doc(video, {
      type: "tutorialVideo",
      attrs: { provider: "youtube", videoId: "abcdefghijk", label: "", transcript: "fala do vídeo" },
    });
    const list = transcribedVideos(body, [
      { id: MEDIA, name: "tela.mp4", transcript: "transcrição enviada" },
      { id: "outro", name: "extra.mp4", transcript: "" },
    ]);
    expect(list.map((v) => [v.label, v.transcript])).toEqual([
      ["Passo a passo", "transcrição enviada"],
      ["Vídeo de link", "fala do vídeo"],
    ]);
  });
});

describe("período das métricas", () => {
  it("inclui hoje, no fuso de São Paulo", () => {
    // 01h UTC de 5/10 ainda é 4/10 em São Paulo.
    expect(periodDates(7, new Date("2026-10-05T01:00:00Z"))).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(periodDates(1, new Date("2026-10-05T15:00:00Z"))).toEqual({ from: "2026-10-05", to: "2026-10-05" });
  });
});

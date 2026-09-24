import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DESCRIPTION_PREFIX,
  parseDescription,
  serializeDescription,
} from "./rich-text";
import { RichTextContent } from "./RichTextContent";
describe("task descriptions", () => {
  it("preserves legacy plain text and never interprets its HTML", () => {
    const text = "<img src=x onerror=alert(1)>\nBriefing";
    const html = renderToStaticMarkup(<RichTextContent value={text} />);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(parseDescription(text).content).toHaveLength(2);
  });
  it("round trips formatting and rejects executable nodes and attributes", () => {
    const value = serializeDescription({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { onclick: "alert(1)" },
          content: [
            {
              type: "text",
              text: "Briefing",
              marks: [
                { type: "bold" },
                { type: "link", attrs: { href: "javascript:alert(1)" } },
              ],
            },
          ],
        },
        { type: "script", text: "alert(1)" },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Entrega" }],
                },
              ],
            },
          ],
        },
      ],
    });
    const html = renderToStaticMarkup(<RichTextContent value={value} />);
    expect(html).toContain("<strong>Briefing</strong>");
    expect(html).toContain("<ul><li><p>Entrega</p></li></ul>");
    expect(html).not.toMatch(/script|onclick|href/);
    expect(serializeDescription(parseDescription(value))).toBe(value);
  });
  it("handles empty and malformed content safely", () => {
    expect(
      serializeDescription({ type: "doc", content: [{ type: "paragraph" }] }),
    ).toBe("");
    expect(() =>
      renderToStaticMarkup(
        <RichTextContent
          value={DESCRIPTION_PREFIX + '{"type":"doc","content":[null,{}]}'}
        />,
      ),
    ).not.toThrow();
    expect(
      parseDescription(DESCRIPTION_PREFIX + "invalid").content?.[0].content?.[0]
        .text,
    ).toContain("invalid");
  });
});

it("preserva apenas IDs de imagens privadas, sem aceitar URLs externas ou código", () => {
  const valid = "00000000-0000-4000-8000-000000000001";
  const value = serializeDescription({
    type: "doc",
    content: [
      {
        type: "inlineImage",
        attrs: {
          imageId: valid,
          alt: "teste",
          src: "https://evil.test/tracker",
        },
      },
      { type: "inlineImage", attrs: { imageId: "javascript:alert(1)" } },
    ],
  });
  expect(value).toContain(valid);
  expect(value).not.toContain("https:");
  expect(value).not.toContain("javascript:");
  expect(parseDescription(value).content).toHaveLength(1);
});

describe("cor do texto e destaque", () => {
  const doc = (marks: unknown[]) => ({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Olá", marks }] },
    ],
  });
  const marksOf = (value: unknown) =>
    parseDescription(serializeDescription(value)).content![0].content![0].marks;
  it("guarda cor do texto e destaque com cor", () => {
    expect(
      marksOf(
        doc([
          { type: "textStyle", attrs: { color: "#C0392B" } },
          { type: "highlight", attrs: { color: "#fef08a" } },
        ]),
      ),
    ).toEqual([
      { type: "textStyle", attrs: { color: "#c0392b" } },
      { type: "highlight", attrs: { color: "#fef08a" } },
    ]);
  });
  it("converte rgb() e hex curto colados de outros lugares", () => {
    expect(
      marksOf(
        doc([{ type: "textStyle", attrs: { color: "rgb(29, 78, 216)" } }]),
      ),
    ).toEqual([{ type: "textStyle", attrs: { color: "#1d4ed8" } }]);
    expect(
      marksOf(doc([{ type: "highlight", attrs: { color: "#fa0" } }])),
    ).toEqual([{ type: "highlight", attrs: { color: "#ffaa00" } }]);
  });
  it("descarta cores que não são cores", () => {
    for (const color of [
      "red; background:url(https://x.example/a.png)",
      "expression(alert(1))",
      "#12345",
      "rgb(300, 0, 0)",
    ])
      expect(marksOf(doc([{ type: "textStyle", attrs: { color } }]))).toEqual(
        [],
      );
    // A highlight without a valid color falls back to the default yellow.
    expect(
      marksOf(doc([{ type: "highlight", attrs: { color: "javascript:x" } }])),
    ).toEqual([{ type: "highlight" }]);
  });
  it("mostra as cores no texto salvo", () => {
    const html = renderToStaticMarkup(
      <RichTextContent
        value={serializeDescription(
          doc([
            { type: "textStyle", attrs: { color: "#1d4ed8" } },
            { type: "highlight", attrs: { color: "#bbf7d0" } },
          ]),
        )}
      />,
    );
    expect(html).toContain('style="color:#1d4ed8"');
    expect(html).toContain(
      '<mark class="rt-highlight" style="background-color:#bbf7d0">',
    );
  });
});

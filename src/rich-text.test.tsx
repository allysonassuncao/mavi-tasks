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

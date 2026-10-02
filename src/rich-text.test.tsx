import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DESCRIPTION_PREFIX,
  parseDescription,
  safeHref,
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

describe("links", () => {
  const withLink = (href: string) =>
    serializeDescription({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "abrir",
              marks: [
                {
                  type: "link",
                  attrs: { href, target: "_self", onclick: "x" },
                },
              ],
            },
          ],
        },
      ],
    });
  it("guarda só endereços web e caminhos do app", () => {
    expect(safeHref("https://make.com.br/a?b=1")).toBe(
      "https://make.com.br/a?b=1",
    );
    expect(safeHref("/agencias/make/drive?whatsapp=g&msg=m")).toBe(
      "/agencias/make/drive?whatsapp=g&msg=m",
    );
    for (const bad of [
      "javascript:alert(1)",
      "//evil.com",
      "/\\evil.com",
      "data:text/html,x",
      "https://",
      "/a b",
      3,
    ])
      expect(safeHref(bad)).toBeNull();
    expect(
      parseDescription(withLink("javascript:alert(1)")).content?.[0]
        .content?.[0].marks,
    ).toEqual([]);
    expect(
      parseDescription(withLink("/agencias/make/drive")).content?.[0]
        .content?.[0].marks,
    ).toEqual([{ type: "link", attrs: { href: "/agencias/make/drive" } }]);
  });
  it("link do app fica no app; link de fora abre em nova aba", () => {
    const inside = renderToStaticMarkup(
      <RichTextContent value={withLink("/agencias/make/drive?msg=1")} />,
    );
    expect(inside).toContain(
      '<a href="/agencias/make/drive?msg=1" class="rt-link">abrir</a>',
    );
    const outside = renderToStaticMarkup(
      <RichTextContent value={withLink("https://site.com")} />,
    );
    expect(outside).toContain('href="https://site.com"');
    expect(outside).toContain('target="_blank"');
    expect(outside).toContain('rel="noopener noreferrer"');
  });
  it("keeps a note secret as a reference only, never a value", () => {
    const id = "00000000-0000-4000-8000-000000000030";
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "noteSecret",
              attrs: { secretId: id, label: "Senha do Meta", value: "s3nh@" },
            },
            { type: "noteSecret", attrs: { secretId: "x", label: "Falso" } },
          ],
        },
      ],
    };
    const stored = serializeDescription(doc);
    expect(stored).not.toContain("s3nh@");
    expect(stored).not.toContain("Falso");
    expect(parseDescription(stored).content?.[0].content).toEqual([
      { type: "noteSecret", attrs: { secretId: id, label: "Senha do Meta" } },
    ]);
    const html = renderToStaticMarkup(<RichTextContent value={stored} />);
    expect(html).toContain("Senha do Meta");
    expect(html).toContain("••••••");
  });
});

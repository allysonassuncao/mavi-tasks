import { describe, expect, it } from "vitest";
import { DESCRIPTION_PREFIX, richTextClipboard } from "./rich-text";

const rich = (content: unknown[]) =>
  DESCRIPTION_PREFIX + JSON.stringify({ type: "doc", content });

describe("richTextClipboard", () => {
  it("copia texto antigo (sem formatação) linha a linha", () => {
    const r = richTextClipboard("Linha 1\nLinha 2");
    expect(r.text).toBe("Linha 1\nLinha 2");
    expect(r.html).toBe("<p>Linha 1</p><p>Linha 2</p>");
  });

  it("mantém negrito, link, listas e menções; secreto e imagem sem conteúdo", () => {
    const r = richTextClipboard(
      rich([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Olá ", marks: [{ type: "bold" }] },
            { type: "mention", attrs: { id: "u1", label: "Ana" } },
            { type: "text", text: " <veja>" },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "site",
                      marks: [
                        { type: "link", attrs: { href: "https://x.com" } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "noteSecret",
                      attrs: { secretId: "6f1c2a7e-3b4d-4c5e-9f10-a1b2c3d4e5f6", label: "Senha" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(r.text).toBe("Olá @Ana <veja>\n• site\n1. Senha: ••••••");
    expect(r.html).toContain("<strong>Olá </strong>@Ana &lt;veja&gt;");
    expect(r.html).toContain('<ul><li><a href="https://x.com">site</a></li></ul>');
    expect(r.html).not.toContain("6f1c2a7e");
  });
});

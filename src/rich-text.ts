/** Structured descriptions are versioned; legacy descriptions stay plain text. */
export const DESCRIPTION_PREFIX = "mavi:richtext:v1:";
export type RichNode = {
  type: string;
  text?: string;
  content?: RichNode[];
  marks?: { type: string }[];
  attrs?: { imageId: string; alt: string };
};
const blocks = new Set([
  "doc",
  "paragraph",
  "bulletList",
  "orderedList",
  "listItem",
  "hardBreak",
]);
const marks = new Set(["bold", "italic", "strike"]);
export function sanitizeDescription(value: unknown): RichNode {
  let remaining = 10000;
  function clean(value: unknown, depth: number): RichNode | null {
    if (!value || typeof value !== "object" || depth > 30 || --remaining < 0)
      return null;
    const node = value as RichNode;
    if (
      node.type === "inlineImage" &&
      typeof node.attrs?.imageId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        node.attrs.imageId,
      )
    )
      return {
        type: "inlineImage",
        attrs: {
          imageId: node.attrs.imageId,
          alt:
            typeof node.attrs.alt === "string"
              ? node.attrs.alt.slice(0, 240)
              : "Imagem anexada",
        },
      };
    if (node.type === "text" && typeof node.text === "string") {
      if (!node.text) return null;
      return {
        type: "text",
        text: node.text,
        marks: Array.isArray(node.marks)
          ? node.marks
              .filter((m) => m && marks.has(m.type))
              .map((m) => ({ type: m.type }))
          : [],
      };
    }
    if (!blocks.has(node.type)) return null;
    return {
      type: node.type,
      ...(node.type === "hardBreak"
        ? {}
        : {
            content: Array.isArray(node.content)
              ? node.content
                  .map((n) => clean(n, depth + 1))
                  .filter((n): n is RichNode => !!n)
              : [],
          }),
    };
  }
  const result = clean(value, 0);
  return result?.type === "doc"
    ? result
    : { type: "doc", content: [{ type: "paragraph" }] };
}
export function parseDescription(value: string): RichNode {
  if (value.startsWith(DESCRIPTION_PREFIX)) {
    try {
      return sanitizeDescription(
        JSON.parse(value.slice(DESCRIPTION_PREFIX.length)),
      );
    } catch {
      /* Preserve malformed legacy text. */
    }
  }
  return {
    type: "doc",
    content: value.split("\n").map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    })),
  };
}
export function serializeDescription(value: unknown): string {
  const doc = sanitizeDescription(value);
  const hasText = (node: RichNode): boolean =>
    node.type === "inlineImage" ||
    !!node.text?.trim() ||
    !!node.content?.some(hasText);
  return hasText(doc) ? DESCRIPTION_PREFIX + JSON.stringify(doc) : "";
}
/** Visible text of a description (rich or legacy), for length validation. */
export function richTextPlain(value: string): string {
  const text = (node: RichNode): string =>
    node.type === "text"
      ? (node.text ?? "")
      : (node.content ?? []).map(text).join(node.type === "doc" ? "\n" : "");
  return text(parseDescription(value)).trim();
}
/**
 * Mirrors mavi_private.transition_comment: the comment posted with a
 * transition note is a bold label followed by the note's own content.
 */
export function transitionComment(label: string, note: string): string {
  const doc = parseDescription(note);
  return serializeDescription({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: label, marks: [{ type: "bold" }] }],
      },
      ...(doc.content ?? []),
    ],
  });
}

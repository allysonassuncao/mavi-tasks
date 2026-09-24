/** Structured descriptions are versioned; legacy descriptions stay plain text. */
export const DESCRIPTION_PREFIX = "mavi:richtext:v1:";
export type RichNode = {
  type: string;
  text?: string;
  content?: RichNode[];
  marks?: RichMark[];
  /** inlineImage: imageId and alt; mention: id (the person) and label. */
  attrs?: { imageId?: string; alt?: string; id?: string; label?: string };
};
/** Text formatting; colored ones carry `attrs.color` as "#rrggbb". */
export type RichMark = { type: string; attrs?: { color?: string } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const blocks = new Set([
  "doc",
  "paragraph",
  "bulletList",
  "orderedList",
  "listItem",
  "hardBreak",
]);
const marks = new Set(["bold", "italic", "strike"]);
/** Marks whose color is kept: text color (textStyle) and highlight. */
const colorMarks = new Set(["textStyle", "highlight"]);
/**
 * A color as stored: "#rrggbb", or null. Pasted text may bring rgb() or
 * short hex; anything else (names, url(), expressions) is dropped, so a
 * color can never carry more than a color into the page's style.
 */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v))
    return "#" + [...v.slice(1)].map((c) => c + c).join("");
  const rgb = v.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/,
  );
  if (rgb && rgb.slice(1, 4).every((n) => Number(n) <= 255))
    return (
      "#" +
      rgb
        .slice(1, 4)
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join("")
    );
  return null;
}
function cleanMark(m: RichMark | null | undefined): RichMark | null {
  if (!m || typeof m !== "object") return null;
  if (marks.has(m.type)) return { type: m.type };
  if (colorMarks.has(m.type)) {
    const color = normalizeColor(m.attrs?.color);
    // A highlight without a color is the default yellow; a text style
    // without one means nothing and is left out.
    if (color) return { type: m.type, attrs: { color } };
    return m.type === "highlight" ? { type: "highlight" } : null;
  }
  return null;
}
export function sanitizeDescription(value: unknown): RichNode {
  let remaining = 10000;
  function clean(value: unknown, depth: number): RichNode | null {
    if (!value || typeof value !== "object" || depth > 30 || --remaining < 0)
      return null;
    const node = value as RichNode;
    // A person mentioned with "@" (demo people have non-UUID ids).
    if (node.type === "mention" && typeof node.attrs?.id === "string")
      return /^[\w-]{1,64}$/.test(node.attrs.id)
        ? {
            type: "mention",
            attrs: {
              id: node.attrs.id,
              label:
                typeof node.attrs.label === "string"
                  ? node.attrs.label.slice(0, 120)
                  : "",
            },
          }
        : null;
    if (
      node.type === "inlineImage" &&
      typeof node.attrs?.imageId === "string" &&
      UUID.test(node.attrs.imageId)
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
          ? node.marks.map(cleanMark).filter((m): m is RichMark => !!m)
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
    node.type === "mention" ||
    !!node.text?.trim() ||
    !!node.content?.some(hasText);
  return hasText(doc) ? DESCRIPTION_PREFIX + JSON.stringify(doc) : "";
}
/** Visible text of a description (rich or legacy), for length validation. */
export function richTextPlain(value: string): string {
  const text = (node: RichNode): string =>
    node.type === "text"
      ? (node.text ?? "")
      : node.type === "mention"
        ? `@${node.attrs?.label ?? ""}`
        : (node.content ?? []).map(text).join(node.type === "doc" ? "\n" : "");
  return text(parseDescription(value)).trim();
}
/**
 * Mirrors mavi_private.transition_comment: the comment posted with a
 * transition note is a bold label followed by the note's own content.
 */
export function transitionComment(label: string, note: string): string {
  // An empty note adds nothing (the SQL version splits "" into no lines).
  const doc: RichNode = note.trim()
    ? parseDescription(note)
    : { type: "doc", content: [] };
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
/** The people mentioned with "@" in a comment or note (ids, no repeats). */
export function mentionedIds(value: string): string[] {
  const ids = new Set<string>();
  const walk = (node: RichNode) => {
    if (node.type === "mention" && node.attrs?.id) ids.add(node.attrs.id);
    node.content?.forEach(walk);
  };
  walk(parseDescription(value));
  return [...ids];
}

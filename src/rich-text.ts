/** Structured descriptions are versioned; legacy descriptions stay plain text. */
export const DESCRIPTION_PREFIX = "mavi:richtext:v1:";
export type RichNode = {
  type: string;
  text?: string;
  content?: RichNode[];
  marks?: RichMark[];
  /**
   * inlineImage: imageId and alt; mention: id (the person) and label;
   * noteSecret: secretId (o valor cifrado, fora do texto) and label;
   * heading (Tutoriais): level 2 or 3; tutorialVideo (Tutoriais): mediaId
   * (a vídeo enviado) or provider + videoId (YouTube, Loom, Vimeo), and an
   * optional label.
   */
  attrs?: {
    imageId?: string;
    alt?: string;
    id?: string;
    label?: string;
    secretId?: string;
    level?: number;
    mediaId?: string;
    provider?: VideoProvider;
    videoId?: string;
  };
};
/** Where an embedded video plays. Only the id is stored; the app builds the address. */
export type VideoProvider = "youtube" | "loom" | "vimeo";
const VIDEO_IDS: Record<VideoProvider, RegExp> = {
  youtube: /^[\w-]{11}$/,
  loom: /^[0-9a-f]{32}$/i,
  vimeo: /^\d{6,12}$/,
};
/**
 * The video of a YouTube, Loom or Vimeo link (the addresses people paste:
 * watch, youtu.be, shorts, embed, share…), or null.
 */
export function videoFromUrl(
  value: string,
): { provider: VideoProvider; videoId: string } | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^(www\.|m\.)/, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const pick = (provider: VideoProvider, id: string | null | undefined) =>
    id && VIDEO_IDS[provider].test(id) ? { provider, videoId: id } : null;
  if (host === "youtu.be") return pick("youtube", parts[0]);
  if (host === "youtube.com" || host === "youtube-nocookie.com")
    return ["embed", "shorts", "live", "v"].includes(parts[0])
      ? pick("youtube", parts[1])
      : pick("youtube", url.searchParams.get("v"));
  if (host === "loom.com" && ["share", "embed"].includes(parts[0]))
    return pick("loom", parts[1]);
  if (host === "vimeo.com") return pick("vimeo", parts[0]);
  if (host === "player.vimeo.com" && parts[0] === "video")
    return pick("vimeo", parts[1]);
  return null;
}
/** The player's address for an embedded video (built here, never stored). */
export function videoEmbedUrl(provider: VideoProvider, videoId: string) {
  if (!VIDEO_IDS[provider]?.test(videoId)) return null;
  return provider === "youtube"
    ? `https://www.youtube-nocookie.com/embed/${videoId}?rel=0`
    : provider === "loom"
      ? `https://www.loom.com/embed/${videoId}`
      : `https://player.vimeo.com/video/${videoId}`;
}
/** A heading's anchor: its words, without accents, joined by "-". */
export function slugify(text: string) {
  return (
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "secao"
  );
}
/**
 * The sections of a text (its headings, in order) with unique anchors:
 * the second "Passo a passo" becomes "passo-a-passo-2".
 */
export function headingAnchors(
  value: string | RichNode,
): { id: string; level: number; text: string }[] {
  const doc = typeof value === "string" ? parseDescription(value) : value;
  const used = new Map<string, number>();
  const out: { id: string; level: number; text: string }[] = [];
  const text = (n: RichNode): string =>
    n.type === "text" ? (n.text ?? "") : (n.content ?? []).map(text).join("");
  for (const node of doc.content ?? []) {
    if (node.type !== "heading") continue;
    const label = text(node).trim();
    if (!label) continue;
    const base = slugify(label);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    out.push({
      id: n > 1 ? `${base}-${n}` : base,
      level: node.attrs?.level === 3 ? 3 : 2,
      text: label,
    });
  }
  return out;
}
/** Text formatting; colored ones carry `attrs.color` as "#rrggbb". */
export type RichMark = {
  type: string;
  attrs?: { color?: string; href?: string };
};
/**
 * A link that can be stored: a web address (http/https) or a path inside
 * the app ("/agencias/…"). Anything else (javascript:, data:, "//host")
 * is dropped, so a description can never carry a script into the page.
 */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  // Sem espaços nem barra invertida: o navegador lê "/\site" como "//site".
  if (!v || v.length > 2000 || /[\s\\]/.test(v)) return null;
  if (/^https?:\/\/[^/\s]+/i.test(v)) return v;
  if (/^\/(?!\/)/.test(v)) return v;
  return null;
}
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
  if (m.type === "link") {
    const href = safeHref(m.attrs?.href);
    return href ? { type: "link", attrs: { href } } : null;
  }
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
    // Trecho secreto das Anotações do cliente: só o nome e a referência; o
    // valor fica cifrado no servidor (client-notes.ts).
    if (node.type === "noteSecret")
      return typeof node.attrs?.secretId === "string" &&
        UUID.test(node.attrs.secretId)
        ? {
            type: "noteSecret",
            attrs: {
              secretId: node.attrs.secretId,
              label:
                typeof node.attrs.label === "string"
                  ? node.attrs.label.slice(0, 120)
                  : "",
            },
          }
        : null;
    // Títulos de seção (Tutoriais): só os níveis 2 e 3.
    if (node.type === "heading")
      return {
        type: "heading",
        attrs: { level: node.attrs?.level === 3 ? 3 : 2 },
        content: Array.isArray(node.content)
          ? node.content
              .map((n) => clean(n, depth + 1))
              .filter((n): n is RichNode => n?.type === "text")
          : [],
      };
    // Vídeo (Tutoriais): um enviado (o id dele) ou o id num provedor
    // conhecido; nunca um endereço livre.
    if (node.type === "tutorialVideo") {
      const label =
        typeof node.attrs?.label === "string"
          ? node.attrs.label.slice(0, 200)
          : "";
      if (typeof node.attrs?.mediaId === "string" && UUID.test(node.attrs.mediaId))
        return {
          type: "tutorialVideo",
          attrs: { mediaId: node.attrs.mediaId, label },
        };
      const provider = node.attrs?.provider;
      const videoId = node.attrs?.videoId;
      return provider &&
        Object.hasOwn(VIDEO_IDS, provider) &&
        typeof videoId === "string" &&
        VIDEO_IDS[provider].test(videoId)
        ? { type: "tutorialVideo", attrs: { provider, videoId, label } }
        : null;
    }
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
    node.type === "tutorialVideo" ||
    node.type === "mention" ||
    node.type === "noteSecret" ||
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
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
/**
 * A descrição para a área de transferência: HTML (cola formatado em e-mail,
 * Docs, WhatsApp Web) e texto puro (campos simples). Secretos vão só com o
 * nome e ••••••, nunca o valor; imagens viram "[Imagem: …]".
 */
export function richTextClipboard(value: string): {
  text: string;
  html: string;
} {
  const lines: string[] = [];
  const inline = (node: RichNode): { text: string; html: string } => {
    if (node.type === "text") {
      const t = node.text ?? "";
      let html = escapeHtml(t);
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold") html = `<strong>${html}</strong>`;
        if (mark.type === "italic") html = `<em>${html}</em>`;
        if (mark.type === "strike") html = `<s>${html}</s>`;
        const href = mark.type === "link" ? safeHref(mark.attrs?.href) : null;
        if (href) {
          const abs = href.startsWith("/")
            ? window.location.origin + href
            : href;
          html = `<a href="${escapeHtml(abs)}">${html}</a>`;
        }
        if (mark.type === "textStyle" && mark.attrs?.color)
          html = `<span style="color:${mark.attrs.color}">${html}</span>`;
        if (mark.type === "highlight")
          html = `<mark${mark.attrs?.color ? ` style="background-color:${mark.attrs.color}"` : ""}>${html}</mark>`;
      }
      return { text: t, html };
    }
    if (node.type === "hardBreak") return { text: "\n", html: "<br>" };
    const plain = (t: string) => ({ text: t, html: escapeHtml(t) });
    if (node.type === "mention") return plain(`@${node.attrs?.label ?? ""}`);
    if (node.type === "noteSecret")
      return plain(`${node.attrs?.label || "Secreto"}: ••••••`);
    if (node.type === "inlineImage")
      return plain(`[Imagem${node.attrs?.alt ? `: ${node.attrs.alt}` : ""}]`);
    const parts = (node.content ?? []).map(inline);
    return {
      text: parts.map((p) => p.text).join(""),
      html: parts.map((p) => p.html).join(""),
    };
  };
  const block = (node: RichNode, depth: number): string => {
    if (node.type === "bulletList" || node.type === "orderedList") {
      const tag = node.type === "bulletList" ? "ul" : "ol";
      const items = (node.content ?? []).map((item, i) => {
        const marker = tag === "ul" ? "•" : `${i + 1}.`;
        const pad = "  ".repeat(depth);
        let first = true;
        const html = (item.content ?? [])
          .map((child) => {
            if (child.type === "bulletList" || child.type === "orderedList")
              return block(child, depth + 1);
            const { text, html } = inline(child);
            lines.push(`${pad}${first ? `${marker} ` : "   "}${text}`);
            const out = first ? html : `<br>${html}`;
            first = false;
            return out;
          })
          .join("");
        return `<li>${html}</li>`;
      });
      return `<${tag}>${items.join("")}</${tag}>`;
    }
    if (node.type === "paragraph") {
      const { text, html } = inline(node);
      lines.push(text);
      return `<p>${html || "<br>"}</p>`;
    }
    if (node.type === "heading") {
      const { text, html } = inline(node);
      const tag = node.attrs?.level === 3 ? "h3" : "h2";
      lines.push(text);
      return `<${tag}>${html}</${tag}>`;
    }
    if (node.type === "tutorialVideo") {
      const url = node.attrs?.provider
        ? videoEmbedUrl(node.attrs.provider, node.attrs.videoId ?? "")
        : null;
      const label = `[Vídeo${node.attrs?.label ? `: ${node.attrs.label}` : ""}]`;
      lines.push(url ? `${label} ${url}` : label);
      return `<p>${escapeHtml(label)}</p>`;
    }
    return (node.content ?? []).map((n) => block(n, depth)).join("");
  };
  const html = block(parseDescription(value), 0);
  return { text: lines.join("\n").trim(), html };
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

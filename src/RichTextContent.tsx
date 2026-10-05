import { InlineImage } from "./inline-images";
import { Fragment, type ReactNode } from "react";
import { headingAnchors, parseDescription, type RichNode } from "./rich-text";
import { TutorialVideo } from "./TutorialVideo";
import { navigate } from "./router";
import { NoteSecretChip } from "./NoteSecret";

/** Links do próprio app abrem a tela sem recarregar; os outros, em nova aba. */
function internalPath(href: string) {
  if (href.startsWith("/")) return href;
  try {
    const url = new URL(href);
    return url.origin === window.location.origin
      ? url.pathname + url.search + url.hash
      : null;
  } catch {
    return null;
  }
}
function RichLink({ href, children }: { href: string; children: ReactNode }) {
  const inside = internalPath(href);
  return inside ? (
    <a
      href={inside}
      className="rt-link"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(inside);
      }}
    >
      {children}
    </a>
  ) : (
    <a
      href={href}
      className="rt-link"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
/** What every node of one text shares: the note of secrets and the anchors of its sections, in order. */
type Ctx = { note: string | null; anchors: string[]; next: number };
const plainText = (n: RichNode): string =>
  n.type === "text" ? (n.text ?? "") : (n.content ?? []).map(plainText).join("");
function renderNode(node: RichNode, key: number, ctx: Ctx): ReactNode {
  const note = ctx.note;
  const children = node.content?.map((n, i) => renderNode(n, i, ctx));
  if (node.type === "text") {
    let text: ReactNode = node.text;
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") text = <strong>{text}</strong>;
      if (mark.type === "italic") text = <em>{text}</em>;
      if (mark.type === "strike") text = <s>{text}</s>;
      if (mark.type === "link" && mark.attrs?.href)
        text = <RichLink href={mark.attrs.href}>{text}</RichLink>;
      // Colors were reduced to "#rrggbb" by sanitizeDescription.
      if (mark.type === "textStyle" && mark.attrs?.color)
        text = <span style={{ color: mark.attrs.color }}>{text}</span>;
      if (mark.type === "highlight")
        text = (
          <mark
            className="rt-highlight"
            style={
              mark.attrs?.color
                ? { backgroundColor: mark.attrs.color }
                : undefined
            }
          >
            {text}
          </mark>
        );
    }
    return <Fragment key={key}>{text}</Fragment>;
  }
  switch (node.type) {
    case "inlineImage":
      return (
        <InlineImage
          key={key}
          id={node.attrs!.imageId!}
          alt={node.attrs!.alt!}
          zoomable
        />
      );
    case "noteSecret":
      return (
        <NoteSecretChip
          key={key}
          secretId={node.attrs!.secretId!}
          label={node.attrs?.label ?? ""}
          note={note}
        />
      );
    case "mention":
      return (
        <span key={key} className="mention" data-user={node.attrs?.id}>
          @{node.attrs?.label}
        </span>
      );
    case "paragraph":
      return <p key={key}>{children?.length ? children : <br />}</p>;
    case "heading": {
      // A âncora de cada seção (o índice do tutorial e os links levam até ela).
      const id = plainText(node).trim() ? ctx.anchors[ctx.next++] : undefined;
      return node.attrs?.level === 3 ? (
        <h3 key={key} id={id} className="rt-heading">
          {children}
        </h3>
      ) : (
        <h2 key={key} id={id} className="rt-heading">
          {children}
        </h2>
      );
    }
    case "tutorialVideo":
      return (
        <TutorialVideo
          key={key}
          mediaId={node.attrs?.mediaId}
          provider={node.attrs?.provider}
          videoId={node.attrs?.videoId}
          label={node.attrs?.label}
          transcript={node.attrs?.transcript}
        />
      );
    case "bulletList":
      return <ul key={key}>{children}</ul>;
    case "orderedList":
      return <ol key={key}>{children}</ol>;
    case "listItem":
      return <li key={key}>{children}</li>;
    case "hardBreak":
      return <br key={key} />;
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}
export function RichTextContent({
  value,
  note = null,
}: {
  value: string;
  /** A anotação do cliente de onde vem o texto (registro dos secretos). */
  note?: string | null;
}) {
  return (
    <div className="rich-text-content">
      {value ? (
        (() => {
          const doc = parseDescription(value);
          const anchors = headingAnchors(doc).map((a) => a.id);
          return renderNode(doc, 0, { note, anchors, next: 0 });
        })()
      ) : (
        <p>Nenhuma descrição adicionada.</p>
      )}
    </div>
  );
}

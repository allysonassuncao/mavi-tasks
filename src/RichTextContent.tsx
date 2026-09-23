import { InlineImage } from "./inline-images";
import { Fragment, type ReactNode } from "react";
import { parseDescription, type RichNode } from "./rich-text";
function renderNode(node: RichNode, key: number): ReactNode {
  const children = node.content?.map(renderNode);
  if (node.type === "text") {
    let text: ReactNode = node.text;
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") text = <strong>{text}</strong>;
      if (mark.type === "italic") text = <em>{text}</em>;
      if (mark.type === "strike") text = <s>{text}</s>;
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
    case "mention":
      return (
        <span key={key} className="mention" data-user={node.attrs?.id}>
          @{node.attrs?.label}
        </span>
      );
    case "paragraph":
      return <p key={key}>{children?.length ? children : <br />}</p>;
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
export function RichTextContent({ value }: { value: string }) {
  return (
    <div className="rich-text-content">
      {value ? (
        renderNode(parseDescription(value), 0)
      ) : (
        <p>Nenhuma descrição adicionada.</p>
      )}
    </div>
  );
}

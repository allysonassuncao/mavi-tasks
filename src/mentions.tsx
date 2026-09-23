import Mention from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionProps } from "@tiptap/suggestion";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type RefObject,
} from "react";
import { Avatar } from "./components";
import { fold } from "./domain";

/** Someone who can be mentioned with "@". */
export interface MentionPerson {
  id: string;
  label: string;
  avatar?: string | null;
}
type ListProps = SuggestionProps<MentionPerson>;
type ListHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

const MentionList = forwardRef<ListHandle, ListProps>(function MentionList(
  { items, command },
  ref,
) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [items]);
  const pick = (i: number) => {
    const person = items[i];
    if (person) command({ id: person.id, label: person.label });
  };
  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") {
        setActive((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        pick(active);
        return true;
      }
      return false;
    },
  }));
  if (!items.length)
    return (
      <div className="mention-menu">
        <p>Ninguém com esse nome</p>
      </div>
    );
  return (
    <div className="mention-menu" role="listbox" aria-label="Mencionar pessoa">
      {items.map((person, i) => (
        <button
          key={person.id}
          type="button"
          role="option"
          aria-selected={i === active}
          className={i === active ? "active" : ""}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            // Keep the editor's selection while clicking.
            e.preventDefault();
            pick(i);
          }}
        >
          <Avatar name={person.label} src={person.avatar} size="small" />
          {person.label}
        </button>
      ))}
    </div>
  );
});

/**
 * The "@" mention node for the rich-text editor. Typing "@" lists the people
 * from `people` (read at each keystroke, so the list can change); picking one
 * inserts a mention of them. Without people, "@" stays plain text.
 */
export function mentionExtension(people: RefObject<MentionPerson[]>) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    renderText: ({ node }) => `@${node.attrs.label ?? ""}`,
    renderHTML: ({ node, options }) => [
      "span",
      { ...options.HTMLAttributes, "data-user": node.attrs.id },
      `@${node.attrs.label ?? ""}`,
    ],
    suggestion: {
      char: "@",
      allow: () => !!people.current?.length,
      items: ({ query }) => {
        const q = fold(query);
        return (people.current ?? [])
          .filter((p) => fold(p.label).includes(q))
          .slice(0, 8);
      },
      render: () => {
        let renderer: ReactRenderer<ListHandle, ListProps> | null = null;
        const place = (props: ListProps) => {
          const rect = props.clientRect?.();
          const el = renderer?.element as HTMLElement | undefined;
          if (!rect || !el) return;
          el.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
          // Below the caret, or above it when there's no room (comment box).
          requestAnimationFrame(() => {
            const below =
              rect.bottom + 6 + el.offsetHeight <= window.innerHeight;
            el.style.top = `${below ? rect.bottom + 6 : Math.max(rect.top - 6 - el.offsetHeight, 8)}px`;
          });
        };
        return {
          onStart: (props) => {
            renderer = new ReactRenderer(MentionList, {
              props,
              editor: props.editor,
            });
            const el = renderer.element as HTMLElement;
            el.className = "mention-popup";
            // Inside an open <dialog> (the task modal, in the top layer) the
            // list must live in the dialog to show above it.
            (props.editor.view.dom.closest("dialog") ?? document.body).append(
              el,
            );
            place(props);
          },
          onUpdate: (props) => {
            renderer?.updateProps(props);
            place(props);
          },
          onKeyDown: ({ event }) => {
            if (event.key === "Escape") {
              renderer?.destroy();
              renderer?.element.remove();
              renderer = null;
              return true;
            }
            return renderer?.ref?.onKeyDown(event) ?? false;
          },
          onExit: () => {
            renderer?.destroy();
            renderer?.element.remove();
            renderer = null;
          },
        };
      },
    },
  });
}

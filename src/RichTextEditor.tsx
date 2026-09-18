import { useEffect, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List, ListOrdered, Undo2, Redo2 } from "lucide-react";
import { parseDescription, serializeDescription } from "./rich-text";
import { Loading } from "./ui";
export default function RichTextEditor({
  name = "description",
  defaultValue = "",
  disabled = false,
}: {
  name?: string;
  defaultValue?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: false,
        underline: false,
      }),
    ],
    content: parseDescription(defaultValue),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Descrição",
        "aria-multiline": "true",
        class: "rich-text-content rich-text-input",
      },
    },
    onUpdate: ({ editor }) => setValue(serializeDescription(editor.getJSON())),
  });
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold"),
      italic: editor?.isActive("italic"),
      bullet: editor?.isActive("bulletList"),
      ordered: editor?.isActive("orderedList"),
    }),
  });
  if (!editor) return <Loading compact />;
  const actions = [
    {
      label: "Negrito",
      icon: Bold,
      active: state?.bold,
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      label: "Itálico",
      icon: Italic,
      active: state?.italic,
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      label: "Lista com marcadores",
      icon: List,
      active: state?.bullet,
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      label: "Lista numerada",
      icon: ListOrdered,
      active: state?.ordered,
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "Desfazer",
      icon: Undo2,
      run: () => editor.chain().focus().undo().run(),
    },
    {
      label: "Refazer",
      icon: Redo2,
      run: () => editor.chain().focus().redo().run(),
    },
  ];
  return (
    <div className="description-field">
      <span>Descrição</span>
      <div className="rich-text-editor">
        <div
          className="editor-toolbar"
          role="group"
          aria-label="Formatação da descrição"
        >
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={disabled}
              className="icon-btn"
              aria-label={a.label}
              title={a.label}
              aria-pressed={a.active}
              onClick={a.run}
            >
              <a.icon size={17} />
            </button>
          ))}
        </div>
        <EditorContent editor={editor} />
        <input type="hidden" name={name} value={value} />
      </div>
      <small>
        Contexto, referências e critérios de entrega. Use a barra para formatar
        o texto.
      </small>
    </div>
  );
}

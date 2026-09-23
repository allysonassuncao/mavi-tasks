import { Node } from "@tiptap/core";
import { InlineImage, uploadInlineImage } from "./inline-images";
import { useEffect, useRef, useState } from "react";
import {
  EditorContent,
  useEditor,
  useEditorState,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Undo2,
  Redo2,
  ImagePlus,
} from "lucide-react";
import { parseDescription, serializeDescription } from "./rich-text";
import { mentionExtension, type MentionPerson } from "./mentions";
import { Loading } from "./ui";
function ImageNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper className="editor-image" contentEditable={false}>
      <InlineImage id={node.attrs.imageId} alt={node.attrs.alt} />
    </NodeViewWrapper>
  );
}
const ImageNode = Node.create({
  name: "inlineImage",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { imageId: { default: "" }, alt: { default: "Imagem anexada" } };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      { "data-image-id": HTMLAttributes.imageId },
      HTMLAttributes.alt,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});
export default function RichTextEditor({
  name = "description",
  defaultValue = "",
  disabled = false,
  label = "Descrição",
  company,
  demo = false,
  mentions,
  onUploading,
}: {
  name?: string;
  defaultValue?: string;
  disabled?: boolean;
  label?: string;
  company: string;
  demo?: boolean;
  /** People who can be mentioned with "@" (none: no mentions). */
  mentions?: MentionPerson[];
  onUploading?: (busy: boolean) => void;
}) {
  const people = useRef<MentionPerson[]>(mentions ?? []);
  people.current = mentions ?? [];
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const [value, setValue] = useState(defaultValue);
  const editor = useEditor({
    extensions: [
      ImageNode,
      mentionExtension(people),
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
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (!files.length) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (!files.length) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
      attributes: {
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
        class: "rich-text-content rich-text-input",
      },
    },
    onUpdate: ({ editor }) => setValue(serializeDescription(editor.getJSON())),
  });
  useEffect(() => {
    editor?.setEditable(!disabled && !uploading);
  }, [editor, disabled, uploading]);
  async function insertImages(files: File[]) {
    if (!editor || disabled || uploadLock.current) return;
    uploadLock.current = true;
    setUploading(true);
    onUploading?.(true);
    setError("");
    try {
      for (const file of files) {
        const id = await uploadInlineImage(company, file, demo);
        if (!editor.isDestroyed)
          editor
            .chain()
            .focus()
            .insertContent([
              { type: "inlineImage", attrs: { imageId: id, alt: file.name } },
              { type: "paragraph" },
            ])
            .run();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      uploadLock.current = false;
      setUploading(false);
      onUploading?.(false);
    }
  }
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
      <span>{label}</span>
      <div className="rich-text-editor">
        <div
          className="editor-toolbar"
          role="group"
          aria-label={`Formatação: ${label}`}
        >
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={disabled || uploading}
              className="icon-btn"
              aria-label={a.label}
              title={a.label}
              aria-pressed={a.active}
              onClick={a.run}
            >
              <a.icon size={17} />
            </button>
          ))}
          <button
            type="button"
            className="icon-btn"
            aria-label={`Inserir imagem em ${label.toLowerCase()}`}
            title="Inserir imagem (ou cole/arraste aqui)"
            disabled={disabled || uploading}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus size={17} />
          </button>
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            tabIndex={-1}
            aria-label={`Arquivo de imagem: ${label}`}
            disabled={disabled || uploading}
            onChange={(e) => {
              void insertImages(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
        {uploading && <Loading compact />}
        <EditorContent editor={editor} />
        <input type="hidden" name={name} value={value} />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <small>
        Formate o texto e insira, cole ou arraste imagens JPG, PNG e WebP (até 5
        MB).{mentions?.length ? " Digite @ para mencionar alguém." : ""}
      </small>
    </div>
  );
}

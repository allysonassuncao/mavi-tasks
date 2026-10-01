import { Node, type Editor } from "@tiptap/core";
import { InlineImage, uploadInlineImage } from "./inline-images";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  EditorContent,
  useEditor,
  useEditorState,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import { ColorMenu, HIGHLIGHT_COLORS, TEXT_COLORS } from "./ColorMenu";
import {
  Baseline,
  Bold,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  Undo2,
  Redo2,
  ImagePlus,
} from "lucide-react";
import { parseDescription, safeHref, serializeDescription } from "./rich-text";
import { mentionExtension, type MentionPerson } from "./mentions";
import { Loading } from "./ui";
/**
 * O texto para quem lê a descrição sem vê-la (o Assistente MAVI): as imagens
 * viram "[imagem]" e os links saem com o endereço — sem isso, "o briefing
 * está aqui" chegava sem o link e a MAVI pedia o briefing.
 */
function readableText(editor: Editor) {
  const text = editor.getText({
    textSerializers: { inlineImage: () => "[imagem]" },
  });
  const links = new Set<string>();
  editor.state.doc.descendants((node) => {
    const link = node.marks.find((m) => m.type.name === "link");
    if (link && node.text) links.add(`${node.text.trim()}: ${link.attrs.href}`);
  });
  return links.size
    ? `${text}\n\nLinks na descrição:\n${[...links].join("\n")}`
    : text;
}

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
  images = true,
  onUploading,
  onTextChange,
  onChange,
  appendRef,
}: {
  name?: string;
  defaultValue?: string;
  disabled?: boolean;
  label?: string;
  company: string;
  demo?: boolean;
  /** People who can be mentioned with "@" (none: no mentions). */
  mentions?: MentionPerson[];
  /** Imagens no texto (o Mural anexa arquivos à parte). */
  images?: boolean;
  onUploading?: (busy: boolean) => void;
  /** O texto puro a cada mudança (o Assistente MAVI lê o rascunho). */
  onTextChange?: (text: string) => void;
  /** O valor serializado a cada mudança ("" sem conteúdo): o rascunho guardado. */
  onChange?: (value: string) => void;
  /** Recebe a função que acrescenta um parágrafo no fim ("Aplicar na descrição"). */
  appendRef?: MutableRefObject<((text: string) => void) | null>;
}) {
  const people = useRef<MentionPerson[]>(mentions ?? []);
  const imagesOn = useRef(images);
  imagesOn.current = images;
  const textListener = useRef(onTextChange);
  textListener.current = onTextChange;
  const valueListener = useRef(onChange);
  valueListener.current = onChange;
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
        // Links: só endereços web e caminhos do app (os mesmos que se guardam).
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: "https",
          isAllowedUri: (url) => !!safeHref(url),
          HTMLAttributes: { rel: "noopener noreferrer", target: null },
        },
        underline: false,
      }),
      // Text color and highlight (any color): kept as "#rrggbb" when saved.
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
    ],
    content: parseDescription(defaultValue),
    editorProps: {
      handlePaste: (_view, event) => {
        if (!imagesOn.current) return false;
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (!files.length) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
      handleDrop: (_view, event) => {
        if (!imagesOn.current) return false;
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
    onCreate: ({ editor }) => textListener.current?.(readableText(editor)),
    onUpdate: ({ editor }) => {
      const next = serializeDescription(editor.getJSON());
      setValue(next);
      valueListener.current?.(next);
      textListener.current?.(readableText(editor));
    },
  });
  useEffect(() => {
    if (!appendRef) return;
    appendRef.current = (text: string) => {
      if (!editor || editor.isDestroyed) return;
      editor
        .chain()
        .focus("end")
        .insertContent({ type: "paragraph", content: [{ type: "text", text }] })
        .run();
    };
    return () => {
      appendRef.current = null;
    };
  }, [editor, appendRef]);
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
      color: (editor?.getAttributes("textStyle").color as string) ?? null,
      highlight: editor?.isActive("highlight")
        ? ((editor.getAttributes("highlight").color as string) ??
          HIGHLIGHT_COLORS[0].color)
        : null,
    }),
  });
  if (!editor) return <Loading variant="editor" />;
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
          {actions.slice(0, 2).map((a) => (
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
          <ColorMenu
            label="Cor do texto"
            icon={Baseline}
            swatches={TEXT_COLORS}
            current={state?.color}
            disabled={disabled || uploading}
            onPick={(color) => editor.chain().focus().setColor(color).run()}
            onClear={() => editor.chain().focus().unsetColor().run()}
            clearLabel="Cor padrão"
          />
          <ColorMenu
            label="Destacar texto"
            icon={Highlighter}
            swatches={HIGHLIGHT_COLORS}
            current={state?.highlight}
            disabled={disabled || uploading}
            onPick={(color) =>
              editor.chain().focus().setHighlight({ color }).run()
            }
            onClear={() => editor.chain().focus().unsetHighlight().run()}
            clearLabel="Sem destaque"
          />
          <span className="editor-toolbar-sep" aria-hidden="true" />
          {actions.slice(2).map((a) => (
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
          {images && (
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
          )}
          {images && (
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
          )}
        </div>
        {uploading && <Loading variant="inline" label="Enviando imagem…" />}
        <EditorContent editor={editor} />
        <input type="hidden" name={name} value={value} />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <small>
        {images
          ? "Formate o texto e insira, cole ou arraste imagens JPG, PNG e WebP (até 5 MB)."
          : "Negrito, itálico, cores, listas e links."}
        {mentions?.length ? " Digite @ para mencionar alguém." : ""}
      </small>
    </div>
  );
}

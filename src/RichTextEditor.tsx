import { Node, type Editor } from "@tiptap/core";
import { InlineImage, uploadInlineImage } from "./inline-images";
import { TutorialVideo } from "./TutorialVideo";
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
  KeyRound,
  Heading2,
  Heading3,
  Clapperboard,
  X,
} from "lucide-react";
import {
  parseDescription,
  safeHref,
  serializeDescription,
  videoFromUrl,
} from "./rich-text";
import { mentionExtension, type MentionPerson } from "./mentions";
import { Loading } from "./ui";
import { NoteSecretForm, noteSecretExtension } from "./NoteSecret";
/**
 * O texto para quem lê a descrição sem vê-la (o Assistente MAVI): as imagens
 * viram "[imagem]" e os links saem com o endereço — sem isso, "o briefing
 * está aqui" chegava sem o link e a MAVI pedia o briefing.
 */
function readableText(editor: Editor) {
  const text = editor.getText({
    textSerializers: {
      inlineImage: () => "[imagem]",
      tutorialVideo: () => "[vídeo]",
      noteSecret: ({ node }) => `[secreto: ${node.attrs.label}]`,
    },
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
function VideoNodeView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper className="editor-video" contentEditable={false}>
      <TutorialVideo
        mediaId={node.attrs.mediaId || undefined}
        provider={node.attrs.provider || undefined}
        videoId={node.attrs.videoId || undefined}
        label={node.attrs.label || undefined}
        transcript={node.attrs.transcript || undefined}
        onTranscript={(transcript) => updateAttributes({ transcript })}
      />
    </NodeViewWrapper>
  );
}
/** Vídeo no texto (Tutoriais): enviado (mediaId) ou de um provedor. */
const VideoNode = Node.create({
  name: "tutorialVideo",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      mediaId: { default: "" },
      provider: { default: "" },
      videoId: { default: "" },
      label: { default: "" },
      transcript: { default: "" },
    };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-video": "" }, HTMLAttributes.label || "Vídeo"];
  },
  addNodeView() {
    return ReactNodeViewRenderer(VideoNodeView);
  },
});
/** Envia um vídeo (Tutoriais) e devolve o id dele. */
export type VideoUploader = (
  file: File,
  onProgress: (fraction: number) => void,
) => Promise<string>;
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
  secrets,
  headings = false,
  videos,
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
  /**
   * Trechos secretos (Anotações do cliente): o botão "Secreto" e a anotação
   * aberta, para registrar onde o valor foi visto.
   */
  secrets?: { company: string; client: string; note: string | null };
  /** Títulos de seção (níveis 2 e 3), que viram o índice (Tutoriais). */
  headings?: boolean;
  /** Vídeos no texto: enviados por aqui ou de YouTube, Loom e Vimeo (Tutoriais). */
  videos?: VideoUploader;
}) {
  const secretContext = useRef({ note: secrets?.note ?? null });
  secretContext.current.note = secrets?.note ?? null;
  const [addingSecret, setAddingSecret] = useState(false);
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
  const [videoPanel, setVideoPanel] = useState(false);
  const [videoLink, setVideoLink] = useState("");
  const [videoLabel, setVideoLabel] = useState("");
  const [videoProgress, setVideoProgress] = useState<number | null>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [
      ImageNode,
      VideoNode,
      noteSecretExtension(secretContext),
      mentionExtension(people),
      StarterKit.configure({
        heading: headings ? { levels: [2, 3] } : false,
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
  function insertVideo(attrs: Record<string, string>) {
    if (!editor || editor.isDestroyed) return;
    editor
      .chain()
      .focus()
      .insertContent([
        { type: "tutorialVideo", attrs: { ...attrs, label: videoLabel.trim() } },
        { type: "paragraph" },
      ])
      .run();
    setVideoPanel(false);
    setVideoLink("");
    setVideoLabel("");
  }
  function insertVideoLink() {
    const found = videoFromUrl(videoLink);
    if (!found)
      return setError(
        "Cole o link de um vídeo do YouTube, do Loom ou do Vimeo.",
      );
    setError("");
    insertVideo(found);
  }
  async function uploadVideo(file: File | undefined) {
    if (!file || !videos || uploadLock.current) return;
    if (!file.type.startsWith("video/"))
      return setError("Escolha um arquivo de vídeo (MP4, WebM ou MOV).");
    uploadLock.current = true;
    setUploading(true);
    onUploading?.(true);
    setError("");
    setVideoProgress(0);
    try {
      const mediaId = await videos(file, setVideoProgress);
      insertVideo({ mediaId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      uploadLock.current = false;
      setUploading(false);
      setVideoProgress(null);
      onUploading?.(false);
    }
  }
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold"),
      h2: editor?.isActive("heading", { level: 2 }),
      h3: editor?.isActive("heading", { level: 3 }),
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
          {headings &&
            [
              { level: 2 as const, icon: Heading2, label: "Título de seção", on: state?.h2 },
              { level: 3 as const, icon: Heading3, label: "Subtítulo", on: state?.h3 },
            ].map((h) => (
              <button
                key={h.level}
                type="button"
                disabled={disabled || uploading}
                className="icon-btn"
                aria-label={h.label}
                title={`${h.label} (aparece no índice)`}
                aria-pressed={h.on}
                onClick={() =>
                  editor.chain().focus().toggleHeading({ level: h.level }).run()
                }
              >
                <h.icon size={17} />
              </button>
            ))}
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
          {videos && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Inserir vídeo"
              title="Inserir vídeo: enviar arquivo ou link do YouTube, Loom ou Vimeo"
              aria-pressed={videoPanel}
              disabled={disabled || uploading}
              onClick={() => setVideoPanel((v) => !v)}
            >
              <Clapperboard size={17} />
            </button>
          )}
          {secrets && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Adicionar secreto (senha, token)"
              title="Secreto: senha ou token guardado criptografado"
              disabled={disabled || uploading}
              onClick={() => setAddingSecret(true)}
            >
              <KeyRound size={17} />
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
        {videos && videoPanel && (
          <div className="editor-video-panel" role="group" aria-label="Inserir vídeo">
            <input
              className="ui-input"
              type="url"
              value={videoLink}
              onChange={(e) => setVideoLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  insertVideoLink();
                }
              }}
              placeholder="Link do YouTube, Loom ou Vimeo"
              aria-label="Link do vídeo"
              disabled={uploading}
            />
            <input
              className="ui-input"
              type="text"
              value={videoLabel}
              maxLength={200}
              onChange={(e) => setVideoLabel(e.target.value)}
              placeholder="Legenda (opcional)"
              aria-label="Legenda do vídeo"
              disabled={uploading}
            />
            <button
              type="button"
              className="btn secondary"
              disabled={uploading || !videoLink.trim()}
              onClick={insertVideoLink}
            >
              Inserir link
            </button>
            <span className="editor-video-or">ou</span>
            <button
              type="button"
              className="btn secondary"
              disabled={uploading}
              onClick={() => videoInput.current?.click()}
            >
              Enviar arquivo
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Fechar inserir vídeo"
              disabled={uploading}
              onClick={() => setVideoPanel(false)}
            >
              <X size={16} />
            </button>
            <input
              ref={videoInput}
              className="sr-only"
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/*"
              tabIndex={-1}
              aria-label="Arquivo de vídeo"
              onChange={(e) => {
                void uploadVideo(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        )}
        {uploading && (
          <Loading
            variant="inline"
            label={
              videoProgress !== null
                ? `Enviando vídeo… ${Math.round(videoProgress * 100)}%`
                : "Enviando imagem…"
            }
          />
        )}
        <EditorContent editor={editor} />
        <input type="hidden" name={name} value={value} />
      </div>
      {addingSecret && secrets && (
        <NoteSecretForm
          company={secrets.company}
          client={secrets.client}
          onClose={() => setAddingSecret(false)}
          onCreated={(secret) => {
            setAddingSecret(false);
            if (editor.isDestroyed) return;
            editor
              .chain()
              .focus()
              .insertContent([
                {
                  type: "noteSecret",
                  attrs: { secretId: secret.id, label: secret.label },
                },
                { type: "text", text: " " },
              ])
              .run();
          }}
        />
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <small>
        {images
          ? "Formate o texto e insira, cole ou arraste imagens JPG, PNG e WebP (até 5 MB)."
          : "Negrito, itálico, cores, listas e links."}
        {headings ? " Os títulos de seção viram o índice." : ""}
        {videos ? " Vídeos: envie até 500 MB ou cole um link." : ""}
        {mentions?.length ? " Digite @ para mencionar alguém." : ""}
        {secrets
          ? " Senhas e tokens: use o botão Secreto (a chave), nunca o texto comum."
          : ""}
      </small>
    </div>
  );
}

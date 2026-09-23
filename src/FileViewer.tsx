import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  File as FileIcon,
  X,
} from "lucide-react";
import { Loading } from "./ui";

/** A file the viewer can show; `load` resolves a URL to display it inline. */
export type ViewerFile = {
  key: string;
  name: string;
  contentType: string;
  size?: number;
  load: () => Promise<string>;
  download?: () => unknown;
  /** Opens the original (e.g. the file in GCS) in a new tab. */
  openOriginal?: () => unknown;
};

/** Saves a same-origin or CORS-enabled URL under `name`. */
export async function downloadUrl(url: string, name: string) {
  const res = await fetch(url);
  if (!res.ok) throw Error("Não foi possível baixar o arquivo.");
  const blob = URL.createObjectURL(await res.blob()),
    link = document.createElement("a");
  link.href = blob;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blob), 10000);
}

type Kind = "image" | "video" | "audio" | "pdf" | "text" | "other";
/** Text previews stop here; bigger files are better downloaded. */
const TEXT_LIMIT = 512 * 1024;

export function previewKind(contentType: string, name: string): Kind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (contentType.startsWith("image/") && contentType !== "image/svg+xml")
    return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf" || ext === "pdf") return "pdf";
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    ["txt", "csv", "md", "json", "log"].includes(ext)
  )
    return "text";
  return "other";
}

function sizeLabel(bytes?: number) {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0).replace(".", ",")} ${units[unit]}`;
}

/**
 * Full-screen preview of images, video, audio, PDF and text files, with
 * download and "open original" actions. Other formats show a card with the
 * same actions. Arrow keys move between the files of the list.
 */
export function FileViewer({
  files,
  start = 0,
  onClose,
}: {
  files: ViewerFile[];
  start?: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(start);
  const [url, setUrl] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const file = files[index];
  const kind = file ? previewKind(file.contentType, file.name) : "other";
  // Parents rebuild `files` on every render (a running timer ticks each
  // second); loading follows the file's key so it happens once per file —
  // a Drive view is also an audit entry.
  const latest = useRef(file);
  latest.current = file;

  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);

  useEffect(() => {
    const file = latest.current;
    if (!file) return;
    let alive = true;
    setUrl("");
    setText(null);
    setError("");
    if (kind === "other") return;
    file
      .load()
      .then(async (u) => {
        if (!alive) return;
        if (kind !== "text") return setUrl(u);
        if (file.size !== undefined && file.size > TEXT_LIMIT)
          throw Error("Arquivo de texto grande demais para pré-visualizar.");
        const res = await fetch(u);
        if (!res.ok) throw Error("Não foi possível carregar o arquivo.");
        const body = await res.text();
        if (alive) setText(body.slice(0, TEXT_LIMIT));
      })
      .catch((e) => {
        if (alive)
          setError((e as Error).message || "Pré-visualização indisponível.");
      });
    return () => {
      alive = false;
    };
  }, [file?.key, kind]);

  const go = (step: number) =>
    setIndex((i) => (i + step + files.length) % files.length);
  async function run(action?: () => unknown) {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!file) return null;
  const many = files.length > 1;
  // Portaled to <body>, and events stop here: React would otherwise bubble
  // them to whatever opened the viewer (a task modal, a table row…).
  return createPortal(
    <dialog
      ref={ref}
      className="file-viewer"
      aria-label={`Visualizar ${file.name}`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (!many || (e.target as HTMLElement).closest("video, audio")) return;
        if (e.key === "ArrowRight") go(1);
        if (e.key === "ArrowLeft") go(-1);
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="file-viewer-head">
        <div>
          <strong title={file.name}>{file.name}</strong>
          <small>
            {[
              sizeLabel(file.size),
              many ? `${index + 1} de ${files.length}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </div>
        <span className="file-viewer-actions">
          {file.openOriginal && (
            <button
              type="button"
              className="file-viewer-btn"
              disabled={busy}
              onClick={() => void run(file.openOriginal)}
            >
              <ExternalLink size={16} /> Abrir original
            </button>
          )}
          {file.download && (
            <button
              type="button"
              className="file-viewer-btn"
              disabled={busy}
              onClick={() => void run(file.download)}
            >
              <Download size={16} /> Baixar
            </button>
          )}
          <button
            type="button"
            className="file-viewer-btn icon"
            aria-label="Fechar visualização"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </span>
      </header>
      <div
        className="file-viewer-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {many && (
          <button
            type="button"
            className="file-viewer-nav prev"
            aria-label="Arquivo anterior"
            onClick={() => go(-1)}
          >
            <ChevronLeft size={26} />
          </button>
        )}
        {error ? (
          <Fallback file={file} message={error} />
        ) : kind === "other" ? (
          <Fallback
            file={file}
            message="A pré-visualização deste formato não está disponível. Baixe o arquivo ou abra o original."
          />
        ) : kind === "text" ? (
          text === null ? (
            <Loading compact />
          ) : (
            <pre className="file-viewer-text">{text}</pre>
          )
        ) : !url ? (
          <Loading compact />
        ) : kind === "image" ? (
          <img
            key={url}
            className="file-viewer-media"
            src={url}
            alt={file.name}
            onError={() => setError("Não foi possível carregar a imagem.")}
          />
        ) : kind === "video" ? (
          <video
            key={url}
            className="file-viewer-media"
            src={url}
            controls
            autoPlay
            onError={() =>
              setError("Este vídeo não pode ser reproduzido no navegador.")
            }
          />
        ) : kind === "audio" ? (
          <audio key={url} src={url} controls autoPlay />
        ) : (
          <iframe
            key={url}
            className="file-viewer-pdf"
            src={url}
            title={file.name}
          />
        )}
        {many && (
          <button
            type="button"
            className="file-viewer-nav next"
            aria-label="Próximo arquivo"
            onClick={() => go(1)}
          >
            <ChevronRight size={26} />
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}

function Fallback({ file, message }: { file: ViewerFile; message: string }) {
  return (
    <div className="file-viewer-fallback" role="status">
      <FileIcon size={40} aria-hidden="true" />
      <strong>{file.name}</strong>
      <p>{message}</p>
    </div>
  );
}

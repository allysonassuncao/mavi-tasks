import { createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, FileText, Film, Loader2, RotateCcw } from "lucide-react";
import { videoEmbedUrl, type VideoProvider } from "./rich-text";
import { Button, Skeleton, Textarea } from "./ui";
import { Modal } from "./components";

/**
 * Where the links of uploaded videos come from: the Tutoriais page gives the
 * one that asks the server (signed links) or, in the demo, memory. Without
 * it (a task description), an uploaded video shows as unavailable.
 */
export type VideoUrls = (ids: string[]) => Promise<Record<string, string>>;
export const TutorialMediaContext = createContext<VideoUrls | null>(null);

/** What the page knows about each uploaded video: its transcript and how it is going. */
export type VideoInfo = {
  transcript: string | null;
  transcript_status: "pending" | "working" | "ready" | "failed" | "skipped";
  transcript_source: "auto" | "manual" | null;
  transcript_error?: string | null;
};
export type VideoInfoContext = {
  media: Record<string, VideoInfo>;
  /** Only in the editor: write or fix the transcript, or transcribe again. */
  edit?: {
    save: (media: string, text: string) => Promise<void>;
    retry: (media: string) => Promise<void>;
  };
};
export const TutorialVideoInfo = createContext<VideoInfoContext | null>(null);

const PROVIDER_LABEL: Record<VideoProvider, string> = {
  youtube: "YouTube",
  loom: "Loom",
  vimeo: "Vimeo",
};

/** A video in a tutorial's text: uploaded (player of the app) or embedded. */
export function TutorialVideo({
  mediaId,
  provider,
  videoId,
  label,
  transcript,
  onTranscript,
}: {
  mediaId?: string;
  provider?: VideoProvider;
  videoId?: string;
  label?: string;
  /** YouTube, Loom ou Vimeo: a transcrição colada (fica no texto). */
  transcript?: string;
  /** No editor: guarda a transcrição colada de um vídeo de link. */
  onTranscript?: (text: string) => void;
}) {
  const urls = useContext(TutorialMediaContext);
  const info = useContext(TutorialVideoInfo);
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const embed = provider && videoId ? videoEmbedUrl(provider, videoId) : null;

  useEffect(() => {
    if (!mediaId) return;
    let alive = true;
    setSrc("");
    setFailed(false);
    if (!urls) {
      setFailed(true);
      return;
    }
    urls([mediaId])
      .then((map) => {
        if (!alive) return;
        if (map[mediaId]) setSrc(map[mediaId]);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [mediaId, urls]);

  const title = label || (provider ? `Vídeo do ${PROVIDER_LABEL[provider]}` : "Vídeo");
  const media = mediaId ? info?.media[mediaId] : undefined;
  const text = mediaId ? (media?.transcript ?? "") : (transcript ?? "");
  // No editor: o vídeo enviado tem a sua transcrição; o de link, a colada no texto.
  const editing = mediaId ? info?.edit : onTranscript ? {} : undefined;
  return (
    <figure className="tutorial-video">
      {embed ? (
        <div className="tutorial-video-frame">
          <iframe
            src={embed}
            title={title}
            loading="lazy"
            allow="fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      ) : failed || !mediaId ? (
        <div className="tutorial-video-missing" role="status">
          <Film size={20} aria-hidden="true" />
          Vídeo indisponível ou sem permissão.
        </div>
      ) : src ? (
        <video
          className="tutorial-video-player"
          src={src}
          controls
          preload="metadata"
          playsInline
          onError={() => setFailed(true)}
        >
          <track kind="captions" />
        </video>
      ) : (
        <Skeleton className="tutorial-video-loading" />
      )}
      {label && <figcaption>{label}</figcaption>}
      {editing ? (
        <TranscriptEditor
          title={title}
          text={text}
          media={mediaId ? media : undefined}
          uploaded={!!mediaId}
          onSave={async (value) => {
            if (mediaId) await info!.edit!.save(mediaId, value);
            else onTranscript?.(value);
          }}
          onRetry={mediaId && info?.edit ? () => info.edit!.retry(mediaId) : undefined}
        />
      ) : (
        text && (
          <details className="tutorial-transcript">
            <summary>
              <FileText size={14} aria-hidden="true" /> Transcrição do vídeo
            </summary>
            <p>{text}</p>
          </details>
        )
      )}
    </figure>
  );
}

const STATUS: Record<VideoInfo["transcript_status"], string> = {
  pending: "Na fila para transcrever",
  working: "Transcrevendo…",
  ready: "Transcrito",
  failed: "Não foi transcrito",
  skipped: "Grande demais para transcrever",
};

/** Under the video in the editor: how the transcript is going and the button to write it. */
function TranscriptEditor({
  title,
  text,
  media,
  uploaded,
  onSave,
  onRetry,
}: {
  title: string;
  text: string;
  media?: VideoInfo;
  uploaded: boolean;
  onSave: (text: string) => Promise<void>;
  onRetry?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = media?.transcript_status;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      setOpen(false);
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tutorial-transcript-bar">
      {uploaded ? (
        <span className={`tutorial-transcript-state ${status ?? "pending"}`}>
          {status === "ready" ? (
            <CheckCircle2 size={13} aria-hidden="true" />
          ) : status === "failed" || status === "skipped" ? (
            <AlertTriangle size={13} aria-hidden="true" />
          ) : (
            <Loader2 size={13} className="spin" aria-hidden="true" />
          )}
          {status === "ready" && media?.transcript_source === "manual"
            ? "Transcrição escrita por quem edita"
            : STATUS[status ?? "pending"]}
          {(status === "failed" || status === "skipped") && media?.transcript_error && (
            <small>{media.transcript_error}</small>
          )}
        </span>
      ) : (
        <span className={`tutorial-transcript-state ${text ? "ready" : "pending"}`}>
          {text ? "Transcrição colada" : "Sem transcrição: cole a do vídeo para a MAVI conhecer o conteúdo"}
        </span>
      )}
      <button
        type="button"
        className="text-btn"
        onClick={() => {
          setValue(text);
          setError("");
          setOpen(true);
        }}
      >
        <FileText size={14} /> {text ? "Ver ou corrigir" : "Escrever transcrição"}
      </button>
      {onRetry && (status === "failed" || status === "skipped" || status === "ready") && (
        <button
          type="button"
          className="text-btn"
          disabled={busy}
          onClick={() => void run(onRetry)}
          title="Transcrever de novo com o provedor de Quem usa qual modelo"
        >
          <RotateCcw size={14} /> Transcrever de novo
        </button>
      )}
      {open &&
        createPortal(
          <Modal title={`Transcrição · ${title}`} onClose={() => setOpen(false)} busy={busy}>
            <div className="entity-form tutorial-transcript-form">
              <Textarea
                value={value}
                rows={14}
                maxLength={uploaded ? 400000 : 60000}
                onChange={(e) => setValue(e.target.value)}
                placeholder="O que é dito no vídeo. Entra na busca e no que a MAVI sabe."
                aria-label="Transcrição do vídeo"
              />
              <small>
                {uploaded
                  ? "Salvar vale na hora e fica marcado como escrito por quem edita. Apagar tudo e salvar devolve o vídeo para a fila de transcrição."
                  : "A transcrição vai junto com o texto do tutorial: salve ou publique o tutorial depois."}
              </small>
              {error && <p className="form-error">{error}</p>}
              <div className="form-footer">
                <Button className="btn secondary" onClick={() => setOpen(false)} disabled={busy}>
                  Cancelar
                </Button>
                <Button
                  className="btn primary"
                  loading={busy}
                  onClick={() => void run(() => onSave(value.trim()))}
                >
                  Salvar transcrição
                </Button>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
}

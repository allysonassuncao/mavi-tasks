import { createContext, useContext, useEffect, useState } from "react";
import { Film } from "lucide-react";
import { videoEmbedUrl, type VideoProvider } from "./rich-text";
import { Skeleton } from "./ui";

/**
 * Where the links of uploaded videos come from: the Tutoriais page gives the
 * one that asks the server (signed links) or, in the demo, memory. Without
 * it (a task description), an uploaded video shows as unavailable.
 */
export type VideoUrls = (ids: string[]) => Promise<Record<string, string>>;
export const TutorialMediaContext = createContext<VideoUrls | null>(null);

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
}: {
  mediaId?: string;
  provider?: VideoProvider;
  videoId?: string;
  label?: string;
}) {
  const urls = useContext(TutorialMediaContext);
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
    </figure>
  );
}

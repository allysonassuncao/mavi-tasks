import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  ExternalLink,
  Facebook,
  File as FileIcon,
  FileText,
  Film,
  FolderOpen,
  Globe,
  Instagram,
  Linkedin,
  Mail,
  MapPin,
  MessageCircle,
  Music,
  Phone,
  Play,
  StickyNote,
  Youtube,
  type LucideIcon,
} from "lucide-react";
import { FileViewer, type ViewerFile } from "./FileViewer";
import {
  groupMedia,
  linkInfo,
  mediaKind,
  textInfo,
  type CaseLink,
  type CaseMedia,
  type CaseText,
  type Highlight,
  type LinkKind,
} from "./cases";
import { formatBytes } from "./drive";

/** Shared by the case page in the app and the public page for the lead. */

export type UrlLoader = (
  ids: string[],
  inline: boolean,
) => Promise<Record<string, string>>;

// Signed links last 15 minutes; they're reused for 10.
const urlCache = new Map<string, { url: string; at: number }>();
const FRESH_MS = 10 * 60 * 1000;

/** Signed URLs for media, asked in one batch and remembered for a while. */
export function useMediaUrls(load: UrlLoader, ids: string[]) {
  const key = ids.join(",");
  const [urls, setUrls] = useState<Record<string, string>>(() => cached(ids));
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const now = Date.now();
    const missing = ids.filter((id) => {
      const hit = urlCache.get(`i:${id}`);
      return !hit || now - hit.at > FRESH_MS;
    });
    setUrls(cached(ids));
    if (!missing.length) return;
    let alive = true;
    latest
      .current(missing, true)
      .then((found) => {
        for (const [id, url] of Object.entries(found))
          urlCache.set(`i:${id}`, { url, at: Date.now() });
        if (alive) setUrls(cached(ids));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}
function cached(ids: string[]) {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const hit = urlCache.get(`i:${id}`);
    if (hit) out[id] = hit.url;
  }
  return out;
}
/** Forgets a link (e.g. the media was removed). */
export const forgetMediaUrl = (id: string) => urlCache.delete(`i:${id}`);

export const LINK_ICONS: Record<LinkKind, LucideIcon> = {
  instagram: Instagram,
  facebook: Facebook,
  youtube: Youtube,
  tiktok: Music,
  linkedin: Linkedin,
  whatsapp: MessageCircle,
  google: MapPin,
  drive: FolderOpen,
  site: Globe,
};

export function HighlightTiles({ items }: { items: Highlight[] }) {
  if (!items.length) return null;
  return (
    <div className="case-highlights" data-count={items.length}>
      {items.map((h, i) => (
        <div className="case-highlight" key={i}>
          <strong>{h.value}</strong>
          {h.label && <span>{h.label}</span>}
        </div>
      ))}
    </div>
  );
}

export function NicheChips({
  niches,
  max,
  onPick,
}: {
  niches: string[];
  max?: number;
  onPick?: (niche: string) => void;
}) {
  const shown = max ? niches.slice(0, max) : niches;
  const rest = niches.length - shown.length;
  return (
    <span className="case-niches">
      {shown.map((n) =>
        onPick ? (
          <button
            type="button"
            key={n}
            className="case-niche"
            onClick={() => onPick(n)}
          >
            {n}
          </button>
        ) : (
          <span key={n} className="case-niche">
            {n}
          </span>
        ),
      )}
      {rest > 0 && <span className="case-niche more">+{rest}</span>}
    </span>
  );
}

async function copy(text: string, done?: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    done?.("Copiado.");
  } catch {
    done?.("Não foi possível copiar.");
  }
}

export function LinkList({
  links,
  notify,
}: {
  links: CaseLink[];
  notify?: (message: string) => void;
}) {
  if (!links.length) return null;
  return (
    <ul className="case-links">
      {links.map((l, i) => {
        const info = linkInfo(l);
        const Icon = LINK_ICONS[info.kind];
        return (
          <li key={`${l.url}-${i}`} data-kind={info.kind}>
            <a href={l.url} target="_blank" rel="noopener noreferrer nofollow">
              <span className="case-link-icon">
                <Icon size={18} />
              </span>
              <span className="case-link-text">
                <strong>{info.title}</strong>
                <small>{info.short}</small>
              </span>
              <ExternalLink
                size={15}
                className="case-link-open"
                aria-hidden="true"
              />
            </a>
            {notify && (
              <button
                type="button"
                className="icon-btn"
                aria-label={`Copiar ${info.title}`}
                title="Copiar endereço"
                onClick={() => copy(l.url, notify)}
              >
                <Copy size={15} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const TEXT_ICONS = {
  phone: Phone,
  whatsapp: MessageCircle,
  email: Mail,
  url: Globe,
  text: StickyNote,
};
const TEXT_ACTIONS = {
  phone: "Ligar",
  whatsapp: "WhatsApp",
  email: "Escrever",
  url: "Abrir",
  text: "",
};

export function TextList({
  texts,
  notify,
}: {
  texts: CaseText[];
  notify?: (message: string) => void;
}) {
  if (!texts.length) return null;
  return (
    <ul className="case-texts">
      {texts.map((t, i) => {
        const info = textInfo(t);
        const Icon = TEXT_ICONS[info.kind];
        return (
          <li key={i} data-kind={info.kind}>
            <span className="case-text-icon">
              <Icon size={16} />
            </span>
            <span className="case-text-body">
              {t.label && <small>{t.label}</small>}
              <span>{t.value}</span>
            </span>
            <span className="case-text-actions">
              {info.href && (
                <a
                  className="btn secondary compact"
                  href={info.href}
                  target={
                    info.kind === "phone" || info.kind === "email"
                      ? undefined
                      : "_blank"
                  }
                  rel="noopener noreferrer"
                >
                  {TEXT_ACTIONS[info.kind]}
                </a>
              )}
              <button
                type="button"
                className="icon-btn"
                aria-label={`Copiar ${t.label || t.value}`}
                title="Copiar"
                onClick={() => copy(t.value, notify)}
              >
                <Copy size={15} />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export type GalleryMedia = Pick<
  CaseMedia,
  "id" | "name" | "content_type" | "size_bytes"
> & {
  pending?: boolean;
};

const FILE_ICONS = {
  audio: Music,
  pdf: FileText,
  doc: FileText,
  other: FileIcon,
  image: FileIcon,
  video: Film,
};

/**
 * Photos and videos as a gallery (the first one bigger when there are
 * several), then documents and other files as a list; everything opens in
 * the full-screen viewer.
 */
export function MediaGallery({
  media,
  load,
  pendingLabel = "Aguardando aprovação",
  removed = [],
}: {
  media: GalleryMedia[];
  load: UrlLoader;
  pendingLabel?: string;
  removed?: string[];
}) {
  const list = media;
  const { visual, files } = useMemo(() => groupMedia(list), [list]);
  const ordered = useMemo(() => [...visual, ...files], [visual, files]);
  const thumbs = useMediaUrls(
    load,
    visual.filter((m) => mediaKind(m) === "image").map((m) => m.id),
  );
  const [open, setOpen] = useState<number | null>(null);
  const viewer: ViewerFile[] = ordered.map((m) => ({
    key: m.id,
    name: m.name,
    contentType: m.content_type,
    size: m.size_bytes,
    load: async () =>
      (await load([m.id], true))[m.id] ??
      Promise.reject(Error("Sem acesso a esta mídia.")),
    download: async () => {
      const url = (await load([m.id], false))[m.id];
      if (url) window.location.assign(url);
    },
  }));
  if (!list.length) return null;
  const badge = (m: { id: string; pending?: boolean }) =>
    removed.includes(m.id) ? (
      <span className="case-media-flag removed">Sai quando aprovarem</span>
    ) : m.pending ? (
      <span className="case-media-flag">{pendingLabel}</span>
    ) : null;
  return (
    <div className="case-media">
      {!!visual.length && (
        <div className="case-gallery" data-count={Math.min(visual.length, 5)}>
          {visual.map((m, i) => (
            <button
              type="button"
              key={m.id}
              className="case-gallery-item"
              onClick={() => setOpen(i)}
              aria-label={`Abrir ${m.name}`}
            >
              {mediaKind(m) === "image" && thumbs[m.id] ? (
                <img
                  src={thumbs[m.id]}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              ) : mediaKind(m) === "video" ? (
                <span className="case-gallery-video">
                  <Play size={26} fill="currentColor" />
                  <small>{m.name}</small>
                </span>
              ) : (
                <span className="case-gallery-wait" />
              )}
              {badge(m)}
            </button>
          ))}
        </div>
      )}
      {!!files.length && (
        <ul className="case-files">
          {files.map((m, i) => {
            const Icon = FILE_ICONS[mediaKind(m)];
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setOpen(visual.length + i)}
                >
                  <Icon size={18} />
                  <span>
                    <strong>{m.name}</strong>
                    <small>{formatBytes(m.size_bytes)}</small>
                  </span>
                  {badge(m)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open !== null && (
        <FileViewer files={viewer} start={open} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

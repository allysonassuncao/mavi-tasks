import { useEffect, useReducer, useState } from "react";
import { rpc } from "./api";
import { driveServer } from "./drive";
import type { DriveFile } from "./types";

/**
 * Drive thumbnails (migration 20261209090000_drive_thumbnails), as in Google
 * Drive: the browser draws a small picture of images, videos and PDFs right
 * after an upload and stores it next to the file. Files sent before that get
 * theirs the first time someone sees them: /api/drive hands out the file
 * itself, the browser draws it once and stores it for everyone.
 */

/** Longest side of a thumbnail, in pixels. */
export const THUMB_SIZE = 480;
/** Mirrors drive_thumb_sources: bigger images and PDFs keep the icon. */
const SOURCE_MAX_BYTES = 26214400;

type ThumbFile = Pick<DriveFile, "id" | "content_type" | "size_bytes">;
type ThumbKind = "image" | "video" | "pdf";

export function thumbKind(
  f: Pick<DriveFile, "content_type" | "size_bytes">,
): ThumbKind | null {
  if (f.content_type.startsWith("video/")) return "video";
  if (f.size_bytes > SOURCE_MAX_BYTES) return null;
  if (f.content_type.startsWith("image/")) return "image";
  if (f.content_type === "application/pdf") return "pdf";
  return null;
}

/** The file cannot be drawn (unknown format, damaged): no more attempts. */
class Unreadable extends Error {}

// ------------------------------------------------------------------ drawing
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82));
  // Browsers without a WebP encoder answer with PNG: JPEG is smaller.
  return encode("image/webp").then(async (blob) => {
    if (blob?.type === "image/webp") return blob;
    const jpeg = await encode("image/jpeg");
    if (!jpeg) throw new Unreadable("Não foi possível gerar a miniatura.");
    return jpeg;
  });
}

function draw(
  source: CanvasImageSource,
  width: number,
  height: number,
  background?: string,
) {
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Unreadable("Sem canvas.");
  if (background) {
    // JPEG has no transparency: a transparent PNG would turn black.
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasBlob(canvas);
}

async function imageThumb(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new Unreadable("Imagem ilegível.");
    });
    // SVGs without a size still get drawn.
    const width = img.naturalWidth || THUMB_SIZE;
    const height = img.naturalHeight || THUMB_SIZE;
    return await draw(img, width, height, "#fff");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A frame near the start (not the very first, often black). */
function videoThumb(src: string, crossOrigin: boolean) {
  return new Promise<Blob>((resolve, reject) => {
    const video = document.createElement("video");
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
      video.removeAttribute("src");
      video.load();
    };
    // A slow connection is not a broken file: it is tried again later.
    const timer = setTimeout(
      () => done(() => reject(Error("Tempo esgotado."))),
      30000,
    );
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    if (crossOrigin) video.crossOrigin = "anonymous";
    video.onerror = () => done(() => reject(new Unreadable("Vídeo ilegível.")));
    video.onloadedmetadata = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = Math.min(1, d / 3);
    };
    video.onseeked = () => {
      if (!video.videoWidth)
        return done(() => reject(new Unreadable("Vídeo sem imagem.")));
      draw(video, video.videoWidth, video.videoHeight).then(
        (blob) => done(() => resolve(blob)),
        (e) => done(() => reject(e)),
      );
    };
    video.src = src;
  });
}

async function pdfThumb(blob: Blob) {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(
    new Uint8Array(await blob.arrayBuffer()),
  ).catch(() => {
    throw new Unreadable("PDF ilegível.");
  });
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    // Like Google Drive: the top of the first page, as wide as the card.
    const viewport = page.getViewport({ scale: THUMB_SIZE / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(Math.min(viewport.height, THUMB_SIZE * 1.3));
    const context = canvas.getContext("2d");
    if (!context) throw new Unreadable("Sem canvas.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return await canvasBlob(canvas);
  } finally {
    void pdf.cleanup();
  }
}

/** A thumbnail of a local file (an upload) or of a signed URL. */
export async function makeThumb(kind: ThumbKind, source: File | string) {
  if (kind === "video")
    return typeof source === "string"
      ? videoThumb(source, true)
      : (async () => {
          const url = URL.createObjectURL(source);
          try {
            return await videoThumb(url, false);
          } finally {
            URL.revokeObjectURL(url);
          }
        })();
  const blob =
    typeof source === "string"
      ? await fetch(source).then((res) => {
          if (!res.ok) throw Error(`Falha ao ler o arquivo (${res.status}).`);
          return res.blob();
        })
      : source;
  return kind === "image" ? imageThumb(blob) : pdfThumb(blob);
}

/**
 * A public link (/pasta or /arquivo) has no sign-in: its token stands for
 * the person (20270108090000_drive_public_thumbnails).
 */
function markThumb(id: string, ready: boolean, token?: string) {
  return token
    ? rpc("set_drive_public_thumb", {
        p_token: token,
        p_file: id,
        p_ready: ready,
      })
    : rpc("set_drive_thumb", { p_file: id, p_ready: ready });
}

async function storeThumb(id: string, thumb: Blob, token?: string) {
  const { url, headers } = await driveServer<{
    url: string;
    headers: Record<string, string>;
  }>(
    token
      ? { action: "public-sign-thumb", token, file: id, type: thumb.type }
      : { action: "sign-thumb", file: id, type: thumb.type },
  );
  const res = await fetch(url, { method: "PUT", headers, body: thumb });
  if (!res.ok) throw Error(`Falha ao guardar a miniatura (${res.status}).`);
  await markThumb(id, true, token);
}

// -------------------------------------------------------------------- store
/** What each file shows, shared by every list on the screen. */
const shown = new Map<string, { url: string; until: number }>();
/** Files still without a thumbnail: the signed URL of the file itself. */
const sources = new Map<
  string,
  { kind: ThumbKind; url: string; until: number; token?: string }
>();
/** Asked recently and nothing to show (other types, failed ones). */
const nothing = new Map<string, number>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function show(id: string, url: string, until: number) {
  shown.set(id, { url, until });
  emit();
}
const fresh = (id: string) => {
  const s = shown.get(id);
  return s && s.until > Date.now() ? s.url : undefined;
};

/** Draws one thumbnail at a time (at most two), in the order they appear. */
const queue: { id: string; run: () => Promise<void> }[] = [];
let running = 0;
function enqueue(id: string, run: () => Promise<void>) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  queue.push({ id, run });
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running++;
    job
      .run()
      .catch(() => {})
      .finally(() => {
        running--;
        inFlight.delete(job.id);
        pump();
      });
  }
}

async function makeAndStore(
  id: string,
  kind: ThumbKind,
  source: File | string,
  token?: string,
) {
  let thumb: Blob;
  try {
    thumb = await makeThumb(kind, source);
  } catch (e) {
    sources.delete(id);
    // A damaged or unknown file keeps its icon for good; anything else
    // (connection, an expired link) is tried again in a minute.
    const unreadable = e instanceof Unreadable;
    nothing.set(id, Date.now() + (unreadable ? 3600000 : 60000));
    if (unreadable) await markThumb(id, false, token);
    throw e;
  }
  // Seen right away; stored for the next visits.
  sources.delete(id);
  show(id, URL.createObjectURL(thumb), Infinity);
  await storeThumb(id, thumb, token);
}

/** Right after an upload, from the file still in memory. */
export function thumbAfterUpload(id: string, file: File, token?: string) {
  const kind = thumbKind({
    content_type: file.type,
    size_bytes: file.size,
  });
  if (kind) enqueue(id, () => makeAndStore(id, kind, file, token));
}

/** Whether the file has no thumbnail yet but the browser can draw one. */
export const canDraw = (id: string) =>
  (sources.get(id)?.until ?? 0) > Date.now();

/** The first time a file without a thumbnail shows on screen. */
export function drawWhenSeen(id: string) {
  const source = sources.get(id);
  if (source && canDraw(id) && !fresh(id))
    enqueue(id, () => makeAndStore(id, source.kind, source.url, source.token));
}

/** One answer of /api/drive: the thumbnail, or the file to draw it from. */
function ingest(
  id: string,
  kind: ThumbKind | null,
  t: { url: string; ready: boolean } | undefined,
  now: number,
  token?: string,
) {
  // A signed thumbnail URL lasts at least an hour.
  if (t?.ready) show(id, t.url, now + 55 * 60000);
  // The file's own URL lasts 15 minutes.
  else if (t && kind)
    sources.set(id, { kind, url: t.url, until: now + 14 * 60000, token });
  else nothing.set(id, now + 10 * 60000);
}

type Thumbs = { thumbs: Record<string, { url: string; ready: boolean }> };

async function request(files: ThumbFile[], token?: string) {
  const now = Date.now();
  const wanted = files.filter(
    (f) =>
      !fresh(f.id) &&
      !inFlight.has(f.id) &&
      (nothing.get(f.id) ?? 0) < now &&
      (sources.get(f.id)?.until ?? 0) < now,
  );
  if (!wanted.length) return;
  wanted.forEach((f) => inFlight.add(f.id));
  const ids = wanted.map((f) => f.id);
  try {
    const { thumbs } = await driveServer<Thumbs>(
      token
        ? { action: "public-thumbs", token, files: ids }
        : { action: "thumbs", files: ids },
    );
    for (const f of wanted)
      ingest(f.id, thumbKind(f), thumbs[f.id], now, token);
  } catch {
    // Icons stay; the next visit tries again.
    wanted.forEach((f) => nothing.set(f.id, now + 60000));
  } finally {
    wanted.forEach((f) => inFlight.delete(f.id));
    emit();
  }
}

/** Redraws whoever calls it when a thumbnail arrives. */
function useThumbUpdates() {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(redraw);
    return () => void listeners.delete(redraw);
  }, []);
}

/**
 * The thumbnails of a list: asks for them once per list and redraws as they
 * arrive. Returns the URL to show for a file, if there is one yet. On a
 * public folder link, `token` is the link's.
 */
export function useDriveThumbs(files: ThumbFile[], token?: string) {
  useThumbUpdates();
  const candidates = files.filter((f) => thumbKind(f));
  const key = candidates.map((f) => f.id).join(",");
  useEffect(() => {
    if (candidates.length) void request(candidates, token);
  }, [key, token]);
  return (id: string) => fresh(id);
}

/**
 * The thumbnail of a file's own public link (/arquivo/<token>): the page
 * does not know the file's id, the link answers with it.
 */
export function usePublicFileThumb(
  token: string,
  file: Pick<DriveFile, "content_type" | "size_bytes"> | null,
) {
  useThumbUpdates();
  const [id, setId] = useState<string>();
  const kind = file ? thumbKind(file) : null;
  useEffect(() => {
    if (!kind) return;
    let alive = true;
    const now = Date.now();
    driveServer<Thumbs>({ action: "public-thumbs", token })
      .then(({ thumbs }) => {
        const [entry] = Object.entries(thumbs);
        if (!alive || !entry) return;
        ingest(entry[0], kind, entry[1], now, token);
        setId(entry[0]);
        emit();
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token, kind]);
  return id ? { id, url: fresh(id) } : undefined;
}

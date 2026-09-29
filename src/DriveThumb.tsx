import { useEffect, useRef, useState } from "react";
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Play,
} from "lucide-react";
import type { DriveFile } from "./types";
import { canDraw, drawWhenSeen } from "./drive-thumbs";

/** The kind of file, for its icon and color (as in Google Drive). */
export function fileTone(type: string, name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (
    /zip|rar|7z|tar|gzip/.test(type) ||
    ["zip", "rar", "7z", "gz"].includes(ext)
  )
    return "archive";
  if (/sheet|excel|csv/.test(type) || ["xlsx", "xls", "csv"].includes(ext))
    return "sheet";
  if (/presentation|powerpoint/.test(type) || ["pptx", "ppt"].includes(ext))
    return "slides";
  if (type.startsWith("text/") || /word|document/.test(type)) return "doc";
  return "other";
}
type Tone = ReturnType<typeof fileTone>;

const ICONS: Record<Tone, typeof FileIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  archive: FileArchive,
  sheet: FileSpreadsheet,
  slides: FileText,
  doc: FileText,
  other: FileIcon,
};

export function FileTypeIcon({
  file,
  size = 17,
}: {
  file: Pick<DriveFile, "content_type" | "name">;
  size?: number;
}) {
  const tone = fileTone(file.content_type, file.name);
  const Icon = ICONS[tone];
  return (
    <Icon size={size} className={`drive-type ${tone}`} aria-hidden="true" />
  );
}

/**
 * The picture of a file: its thumbnail when there is one, the type icon
 * otherwise. A file still without a thumbnail gets one drawn when it
 * scrolls into view.
 */
export function DriveThumb({
  file,
  url,
  variant,
}: {
  file: Pick<DriveFile, "id" | "content_type" | "name">;
  url?: string;
  variant: "card" | "row";
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [broken, setBroken] = useState<string>();
  const drawable = !url && canDraw(file.id);
  useEffect(() => {
    const el = box.current;
    if (!drawable || !el) return;
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) drawWhenSeen(file.id);
      },
      { rootMargin: "200px" },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [drawable, file.id]);
  const tone = fileTone(file.content_type, file.name);
  const picture = url && broken !== url ? url : undefined;
  return (
    <span
      ref={box}
      className={`drive-thumb ${variant} ${tone} ${picture ? "has-picture" : ""}`}
    >
      {picture ? (
        <img
          src={picture}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(picture)}
        />
      ) : (
        <FileTypeIcon file={file} size={variant === "card" ? 44 : 17} />
      )}
      {picture && tone === "video" && (
        <span className="drive-thumb-play" aria-hidden="true">
          <Play size={variant === "card" ? 16 : 9} fill="currentColor" />
        </span>
      )}
    </span>
  );
}

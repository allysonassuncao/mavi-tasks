import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BellRing,
  Download,
  File as FileIcon,
  HardDrive,
  Info,
} from "lucide-react";
import { formatBytes } from "./drive";
import {
  LEVELS,
  type NoticeAttachment,
  type NoticeLevel,
  type NoticesApi,
} from "./notices";

export const LEVEL_ICONS = {
  info: Info,
  important: BellRing,
  critical: AlertTriangle,
} as const;

export function LevelChip({ level }: { level: NoticeLevel }) {
  const Icon = LEVEL_ICONS[level];
  return (
    <span className={`notice-level ${level}`}>
      <Icon size={13} aria-hidden="true" />
      {LEVELS[level].label}
    </span>
  );
}

/**
 * Os anexos de um aviso: imagens aparecem (links assinados de poucos
 * minutos, pedidos de uma vez), o resto vira um botão de baixar.
 */
export function NoticeAttachments({
  api,
  items,
}: {
  api: NoticesApi;
  items: NoticeAttachment[];
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const images = items.filter((a) => a.content_type.startsWith("image/"));
  const files = items.filter((a) => !a.content_type.startsWith("image/"));
  const imageIds = images.map((a) => a.id).join();
  useEffect(() => {
    if (!imageIds) return;
    let alive = true;
    api
      .attachmentUrls(imageIds.split(","), true)
      .then((u) => alive && setUrls(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, imageIds]);
  if (!items.length) return null;
  async function open(a: NoticeAttachment) {
    setError("");
    // A aba abre no clique (antes do link assinado) para o navegador permitir.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const u = await api.attachmentUrls([a.id], true);
      if (!u[a.id]) throw Error("Anexo indisponível.");
      if (tab) tab.location.href = u[a.id];
      else window.location.assign(u[a.id]);
    } catch (e) {
      tab?.close();
      setError((e as Error).message || "Não foi possível abrir o anexo.");
    }
  }
  return (
    <div className="notice-attachments">
      {!!images.length && (
        <div className="notice-images">
          {images.map((a) =>
            urls[a.id] ? (
              <button
                type="button"
                key={a.id}
                onClick={() => void open(a)}
                title={a.name}
              >
                <img src={urls[a.id]} alt={a.name} loading="lazy" />
              </button>
            ) : (
              <span
                key={a.id}
                className="notice-image-wait"
                aria-hidden="true"
              />
            ),
          )}
        </div>
      )}
      {!!files.length && (
        <ul className="notice-files">
          {files.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => void open(a)}>
                {a.source === "drive" ? (
                  <HardDrive size={16} aria-hidden="true" />
                ) : (
                  <FileIcon size={16} aria-hidden="true" />
                )}
                <span>
                  {a.name}
                  <small>
                    {formatBytes(a.size_bytes)}
                    {a.source === "drive" ? " · do Drive" : ""}
                  </small>
                </span>
                <Download size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

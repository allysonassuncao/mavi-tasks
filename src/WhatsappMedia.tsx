import { useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  FileText,
  Film,
  Image as ImageIcon,
  Link2,
  MessageCircle,
  Mic,
  Play,
} from "lucide-react";
import { Loading, Select, SelectOption } from "./ui";
import { Pagination } from "./Pagination";
import { FileViewer, type ViewerFile } from "./FileViewer";
import {
  bytesLabel,
  linksIn,
  listMedia,
  MEDIA_PAGE,
  mediaUrls,
  plainText,
  secondsLabel,
  senderLabel,
  shortDate,
  type MediaTab,
  type WhatsappGroup,
  type WhatsappMessage,
  viewerFile,
} from "./whatsapp";

const TABS: [MediaTab, string, typeof ImageIcon][] = [
  ["image", "Fotos", ImageIcon],
  ["video", "Vídeos", Film],
  ["audio", "Áudios", Mic],
  ["document", "Documentos", FileText],
  ["link", "Links", Link2],
];

/**
 * Drive › cliente › Whatsapp › Mídias: fotos, vídeos, áudios, documentos e
 * links de todos os grupos do cliente (ou de um), do mais novo ao mais antigo.
 */
export function WhatsappMedia({
  company,
  groups,
  onOpenMessage,
}: {
  company: string;
  groups: WhatsappGroup[];
  onOpenMessage: (m: WhatsappMessage) => void;
}) {
  const [tab, setTab] = useState<MediaTab>("image");
  const [group, setGroup] = useState("");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{
    rows: WhatsappMessage[];
    total: number;
  } | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [viewer, setViewer] = useState<{
    files: ViewerFile[];
    start: number;
  } | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const ids = useMemo(
    () => (group ? [group] : groups.map((g) => g.id)),
    [group, groups],
  );
  const titles = useMemo(
    () => new Map(groups.map((g) => [g.id, g.title])),
    [groups],
  );

  useEffect(() => {
    let alive = true;
    setResult(null);
    setError("");
    listMedia(company, ids, tab, page)
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [company, ids, tab, page]);

  // As fotos da página, em um pedido só.
  useEffect(() => {
    if (tab !== "image" || !result) return;
    const need = result.rows
      .filter((m) => m.media_status === "stored")
      .map((m) => m.id);
    if (!need.length) return;
    let alive = true;
    mediaUrls(need)
      .then((got) => alive && setUrls((u) => ({ ...u, ...got })))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab, result]);

  const rows = result?.rows ?? [];
  const stored = rows.filter((m) => m.media_status === "stored");
  const open = (m: WhatsappMessage) => {
    const list = tab === "image" || tab === "video" ? stored : [m];
    setViewer({
      files: list.map(viewerFile),
      start: Math.max(
        0,
        list.findIndex((x) => x.id === m.id),
      ),
    });
  };
  const where = (m: WhatsappMessage) =>
    `${shortDate(m.sent_at)} · ${senderLabel(m)}${group ? "" : ` · ${titles.get(m.group_id) ?? ""}`}`;
  const inChat = (m: WhatsappMessage) => (
    <button
      type="button"
      className="icon-btn"
      title="Ver na conversa"
      aria-label="Ver na conversa"
      onClick={() => onOpenMessage(m)}
    >
      <MessageCircle size={15} />
    </button>
  );
  const unavailable = (m: WhatsappMessage) =>
    m.media_status === "pending" || m.media_status === "failed"
      ? "Copiando…"
      : m.media_status === "stored"
        ? ""
        : "Indisponível";

  return (
    <div className="panel wa-media" ref={top}>
      <div className="wa-media-toolbar">
        <div className="scope-tabs" role="tablist" aria-label="Tipo de mídia">
          {TABS.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "selected" : ""}
              onClick={() => {
                setTab(id);
                setPage(0);
              }}
            >
              <Icon size={14} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
        {groups.length > 1 && (
          <Select
            aria-label="Grupo"
            value={group}
            onValueChange={(v) => {
              setGroup(v);
              setPage(0);
            }}
          >
            <SelectOption value="">Todos os grupos</SelectOption>
            {groups.map((g) => (
              <SelectOption key={g.id} value={g.id}>
                {g.title || "Grupo sem título"}
              </SelectOption>
            ))}
          </Select>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!result ? (
        <Loading
          variant={tab === "image" || tab === "video" ? "grid" : "list"}
        />
      ) : !rows.length ? (
        <p className="template-empty">
          {tab === "image"
            ? "Nenhuma foto nos grupos."
            : tab === "video"
              ? "Nenhum vídeo nos grupos."
              : tab === "audio"
                ? "Nenhum áudio nos grupos."
                : tab === "document"
                  ? "Nenhum documento nos grupos."
                  : "Nenhum link enviado nos grupos."}
        </p>
      ) : tab === "image" || tab === "video" ? (
        <div className="wa-grid">
          {rows.map((m) => {
            const thumb = m.extra.thumb
              ? `data:image/jpeg;base64,${m.extra.thumb}`
              : "";
            const src = (tab === "image" && urls[m.id]) || thumb;
            const note = unavailable(m);
            return (
              <figure key={m.id} className="wa-grid-item">
                <button
                  type="button"
                  disabled={!!note}
                  onClick={() => open(m)}
                  aria-label={`${tab === "image" ? "Abrir a foto" : "Assistir ao vídeo"} de ${where(m)}`}
                >
                  {src ? (
                    <img src={src} alt={m.body || ""} loading="lazy" />
                  ) : (
                    <span className="wa-grid-blank">
                      {tab === "image" ? (
                        <ImageIcon size={22} />
                      ) : (
                        <Film size={22} />
                      )}
                    </span>
                  )}
                  {tab === "video" && (
                    <span className="wa-play">
                      <Play size={18} />
                    </span>
                  )}
                  {note && <small className="wa-grid-note">{note}</small>}
                </button>
                <figcaption>
                  <span title={where(m)}>{where(m)}</span>
                  {inChat(m)}
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : (
        <ul className="wa-list">
          {rows.map((m) => {
            const note = unavailable(m);
            return (
              <li key={m.id}>
                {tab === "link" ? (
                  <div className="wa-list-main">
                    {linksIn(m.body).map((href) => (
                      <a
                        key={href}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink size={13} aria-hidden="true" /> {href}
                      </a>
                    ))}
                    <small>{where(m)}</small>
                    {m.body.trim() !== linksIn(m.body).join(" ") && (
                      <p>{plainText(m.body)}</p>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="wa-list-main"
                    disabled={!!note}
                    onClick={() => open(m)}
                  >
                    <strong>
                      {tab === "audio" ? (
                        <>
                          <Mic size={14} aria-hidden="true" /> Áudio{" "}
                          {secondsLabel(m.media_seconds)}
                        </>
                      ) : (
                        <>
                          <FileText size={14} aria-hidden="true" />{" "}
                          {m.media_name || "Documento"}
                        </>
                      )}
                    </strong>
                    <small>
                      {[where(m), bytesLabel(m.media_bytes), note]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    {m.body.trim() && <p>{plainText(m.body)}</p>}
                  </button>
                )}
                {inChat(m)}
              </li>
            );
          })}
        </ul>
      )}
      {result && (
        <Pagination
          page={page}
          pageCount={Math.ceil(result.total / MEDIA_PAGE)}
          pageSize={MEDIA_PAGE}
          total={result.total}
          noun={
            tab === "image"
              ? "fotos"
              : tab === "video"
                ? "vídeos"
                : tab === "audio"
                  ? "áudios"
                  : tab === "document"
                    ? "documentos"
                    : "links"
          }
          onPage={setPage}
          anchor={top}
        />
      )}
      {viewer && (
        <FileViewer
          files={viewer.files}
          start={viewer.start}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

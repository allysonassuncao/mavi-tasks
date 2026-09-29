import { useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  FileText,
  Film,
  ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  X,
} from "lucide-react";
import { attachmentUrl } from "./ai";
import {
  ATTACH_ACCEPT,
  MAX_PER_MESSAGE,
  attachFile,
  attachmentKind,
  attachmentProblem,
  formatBytes,
  removeAttachment,
  type Attachment,
  type AttachStage,
} from "./mavi-attachments";

/**
 * Os anexos na caixa de mensagem do módulo MAVI: o clipe, arrastar e soltar,
 * colar; cada arquivo com o progresso (preparando, enviando, lendo) até
 * ficar pronto. A mensagem só sai com todos prontos (ou tirados).
 */

export type TrayItem = {
  key: string;
  name: string;
  size: number;
  kind: string;
  stage: AttachStage | "ready" | "failed";
  progress?: number;
  error?: string;
  attachment?: Attachment;
};

export const KIND_ICONS = { document: FileText, image: ImageIcon, audio: Mic, video: Film } as const;
const kindIcon = (kind: string) => KIND_ICONS[kind as keyof typeof KIND_ICONS] ?? FileText;

export function useAttachmentTray(company: string, conversation: string | null) {
  const [items, setItems] = useState<TrayItem[]>([]);
  const seq = useRef(0);
  const patch = (key: string, p: Partial<TrayItem>) =>
    setItems((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const current = useRef<TrayItem[]>([]);
  current.current = items;
  function add(list: FileList | File[]) {
    const files = [...list];
    const room = MAX_PER_MESSAGE - current.current.filter((x) => x.stage !== "failed").length;
    const fresh = files.map((file, i) => {
      const problem = i >= room ? `Até ${MAX_PER_MESSAGE} arquivos por mensagem.` : attachmentProblem(file);
      const item: TrayItem = {
        key: `f${++seq.current}`,
        name: file.name,
        size: file.size,
        kind: attachmentKind(file.name) ?? "document",
        stage: problem ? "failed" : "preparing",
        ...(problem ? { error: problem } : {}),
      };
      return { file, item, problem };
    });
    setItems((l) => [...l, ...fresh.map((f) => f.item)]);
    for (const { file, item, problem } of fresh) {
      if (problem) continue;
      const key = item.key;
      void attachFile(company, conversation, file, (stage, progress) => patch(key, { stage, progress }))
        .then((a) =>
          patch(key, {
            attachment: a,
            name: a.name,
            stage: a.status === "ready" ? "ready" : "failed",
            ...(a.status === "ready" ? {} : { error: a.error ?? "Não foi possível ler o arquivo." }),
          }),
        )
        .catch((e) => patch(key, { stage: "failed", error: (e as Error).message }));
    }
  }
  function remove(key: string) {
    const item = current.current.find((x) => x.key === key);
    if (item?.attachment) void removeAttachment(item.attachment.id).catch(() => null);
    setItems((l) => l.filter((x) => x.key !== key));
  }
  const working = items.some((x) => x.stage === "preparing" || x.stage === "uploading" || x.stage === "reading");
  const ready = items.filter((x) => x.stage === "ready" && x.attachment);
  return {
    items,
    add,
    remove,
    working,
    ready,
    /** Depois de enviada, a mensagem leva os prontos (os com erro ficam para tirar). */
    sent: () => setItems((l) => l.filter((x) => x.stage !== "ready")),
  };
}

const STAGE: Record<string, string> = {
  preparing: "Preparando…",
  uploading: "Enviando",
  reading: "Lendo…",
  ready: "Pronto",
};

export function AttachmentTray({
  items,
  onRemove,
}: {
  items: TrayItem[];
  onRemove: (key: string) => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="mavi-tray" aria-label="Anexos desta mensagem">
      {items.map((x) => {
        const Icon = kindIcon(x.kind);
        const busy = x.stage === "preparing" || x.stage === "uploading" || x.stage === "reading";
        return (
          <li key={x.key} className={`mavi-tray-item ${x.stage}`} title={x.error ?? x.name}>
            <span className="mavi-tray-icon" aria-hidden="true">
              {x.stage === "failed" ? <AlertTriangle size={15} /> : <Icon size={15} />}
            </span>
            <span className="mavi-tray-text">
              <strong>{x.name}</strong>
              <small>
                {x.stage === "failed"
                  ? x.error
                  : x.stage === "uploading"
                    ? `${STAGE.uploading} ${Math.round((x.progress ?? 0) * 100)}%`
                    : x.stage === "ready"
                      ? `${formatBytes(x.size)}${x.attachment?.pages ? ` · ${x.attachment.pages} ${x.attachment.pages === 1 ? "parte" : "partes"}` : ""}`
                      : STAGE[x.stage]}
              </small>
              {x.stage === "uploading" && (
                <span className="mavi-tray-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round((x.progress ?? 0) * 100)}%` }} />
                </span>
              )}
            </span>
            {busy ? (
              <Loader2 size={14} className="spin" aria-label="Em andamento" />
            ) : x.stage === "ready" ? (
              <Check size={14} className="mavi-tray-ok" aria-label="Pronto" />
            ) : null}
            <button type="button" className="mavi-tray-remove" aria-label={`Tirar ${x.name}`} onClick={() => onRemove(x.key)}>
              <X size={13} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** O clipe da caixa de mensagem. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: FileList) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={ATTACH_ACCEPT}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="mavi-attach"
        disabled={disabled}
        aria-label="Anexar arquivos"
        title="Anexar documentos, imagens, áudios ou vídeos (ou arraste para cá)"
        onClick={() => input.current?.click()}
      >
        <Paperclip size={17} />
      </button>
    </>
  );
}

/** Um anexo já enviado (na mensagem ou na lista da conversa): abre o arquivo. */
export function FileChip({ file }: { file: { id: string; name: string; kind: string; status?: string; error?: string | null } }) {
  const Icon = kindIcon(file.kind);
  const bad = file.status && file.status !== "ready";
  return (
    <button
      type="button"
      className={`mavi-file-chip${bad ? " bad" : ""}`}
      title={bad ? (file.error ?? "Não foi lido") : `Abrir ${file.name}`}
      onClick={() => {
        const tab = window.open("", "_blank");
        if (tab) tab.opener = null;
        void attachmentUrl(file.id)
          .then((url) => {
            if (tab) tab.location.href = url;
          })
          .catch(() => tab?.close());
      }}
    >
      {bad ? <AlertTriangle size={13} aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}
      <span>{file.name}</span>
    </button>
  );
}

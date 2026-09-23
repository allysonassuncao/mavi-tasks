import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { statuses, type Status, type TimeEntry } from "./types";
import { initials, durationWithSeconds, entrySeconds } from "./domain";
import { useNow } from "./useClock";
export function Avatar({
  name,
  size = "normal",
  src,
}: {
  name: string;
  size?: "small" | "normal" | "large" | "xlarge";
  src?: string | null;
}) {
  return (
    <span className={`avatar ${size}`} title={name}>
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" />
      ) : (
        initials(name)
      )}
    </span>
  );
}
export function Badge({ status }: { status: Status }) {
  return (
    <span className={`badge ${status}`}>
      <i style={{ background: statuses[status].color }} />
      {statuses[status].label}
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    // showModal() moves focus to the close button, undoing the form's
    // autoFocus (which ran while the dialog was still closed).
    if (!wide)
      d?.querySelector<HTMLElement>(
        ".entity-form input:not([type=hidden]):not([tabindex='-1']):not(:disabled):not([readonly])",
      )?.focus();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={wide ? "modal sheet" : "modal"}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          disabled={busy}
          aria-label="Fechar"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark">◇</span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
export { Loading } from "./ui";
export function LiveDuration({ entry }: { entry: TimeEntry }) {
  const now = useNow(!entry.ended_at);
  return <>{durationWithSeconds(entrySeconds(entry, now))}</>;
}

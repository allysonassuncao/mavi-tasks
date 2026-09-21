import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { statuses, type Status, type TimeEntry } from "./types";
import { initials, duration, minutes } from "./domain";
import { useNow } from "./useClock";
export function Avatar({
  name,
  size = "normal",
}: {
  name: string;
  size?: "small" | "normal" | "large";
}) {
  return (
    <span className={`avatar ${size}`} title={name}>
      {initials(name)}
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
  return <>{duration(minutes(entry, now))}</>;
}

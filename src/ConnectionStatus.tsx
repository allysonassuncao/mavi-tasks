import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Wifi, WifiOff } from "lucide-react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Whether the browser has a network connection, updated as it changes. */
export function useOnline() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

export type ConnectionNotice = "offline" | "back" | null;

/**
 * Modals open with showModal() and sit in the browser's top layer, above any
 * z-index. The notice joins that layer as a manual popover and moves back to
 * the front whenever a dialog opens after it, so nothing ever covers it.
 */
function useAlwaysOnTop(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el?.showPopover) return;
    const raise = () => {
      if (el.matches(":popover-open")) el.hidePopover();
      el.showPopover();
    };
    raise();
    const observer = new MutationObserver((changes) => {
      if (
        changes.some(
          (c) => c.target !== el && c.target instanceof HTMLDialogElement,
        )
      )
        raise();
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, [active]);
  return ref;
}

export function ConnectionToast({ notice }: { notice: ConnectionNotice }) {
  const ref = useAlwaysOnTop(notice !== null);
  if (!notice) return null;
  const offline = notice === "offline";
  return (
    <div
      ref={ref}
      popover="manual"
      className={`toast connection-toast${offline ? " toast-offline" : ""}`}
      role={offline ? "alert" : "status"}
    >
      {offline ? (
        <>
          <WifiOff size={17} />
          <span>
            <strong>Sem conexão com a internet.</strong> Alterações feitas agora
            podem não ser salvas até a conexão voltar.
          </span>
        </>
      ) : (
        <>
          <Wifi size={17} />
          Conexão restabelecida
        </>
      )}
    </div>
  );
}

/**
 * Warns while the connection is down (the toast stays until it comes back),
 * then briefly confirms when it returns.
 */
export function ConnectionStatus() {
  const online = useOnline();
  const wasOffline = useRef(false);
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setBack(false);
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    setBack(true);
    const id = setTimeout(() => setBack(false), 3500);
    return () => clearTimeout(id);
  }, [online]);
  return (
    <ConnectionToast notice={!online ? "offline" : back ? "back" : null} />
  );
}

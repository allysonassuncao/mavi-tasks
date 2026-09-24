import { useEffect, useRef, useState, type DragEvent } from "react";
import { CloudUpload } from "lucide-react";

const carriesFiles = (e: { dataTransfer: DataTransfer | null }) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
/**
 * Places inside a drop area that take files themselves: a text editor
 * (images go into the text) or a nested drop area (the Drive inside a
 * task). While over them, the outer highlight steps aside.
 */
const ownDrop = (e: DragEvent) => {
  const hit =
    e.target instanceof Element &&
    e.target.closest('[contenteditable="true"], [data-drop-zone]');
  return !!hit && hit !== e.currentTarget;
};

/**
 * Makes an element a drop area for files. Enter and leave are counted, since
 * the browser fires them for every child the cursor crosses (a single flag
 * flickers or gets stuck); only drags carrying files count, not text or
 * links. A drop an inner element already took (the rich-text editor
 * inserting an image) is left alone.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const latest = useRef(onFiles);
  latest.current = onFiles;
  // A drag cancelled with Esc, or dropped elsewhere, never sends "leave".
  useEffect(() => {
    if (!active) return;
    const reset = () => {
      depth.current = 0;
      setActive(false);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [active]);
  useEffect(() => {
    if (enabled) return;
    depth.current = 0;
    setActive(false);
  }, [enabled]);
  const handlers = {
    onDragEnter(e: DragEvent) {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setActive(!ownDrop(e));
    },
    onDragOver(e: DragEvent) {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setActive(!ownDrop(e));
    },
    onDragLeave(e: DragEvent) {
      if (!enabled || !carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setActive(false);
    },
    onDrop(e: DragEvent) {
      if (!enabled || !carriesFiles(e)) return;
      depth.current = 0;
      setActive(false);
      if (e.defaultPrevented) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      if (files.length) latest.current(files);
    },
  };
  // The marker lets an outer area know it is over this one (ownDrop).
  return { active, handlers: { ...handlers, "data-drop-zone": "" } };
}

/** The highlight shown over a drop area while files are dragged onto it. */
export function DropOverlay({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <CloudUpload size={32} />
      <strong>{label}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/**
 * A file dropped outside every drop area would make the browser open it,
 * leaving the app (and losing whatever was being typed). Called once.
 */
export function guardStrayFileDrops() {
  const guard = (e: globalThis.DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  window.addEventListener("dragover", guard);
  window.addEventListener("drop", guard);
}

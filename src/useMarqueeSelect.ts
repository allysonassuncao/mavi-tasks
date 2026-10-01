import { useEffect, useRef, useState, type PointerEvent } from "react";

export type MarqueeSelection = { files: string[]; folders: string[] };
type Box = { left: number; top: number; width: number; height: number };

/** Onde o arrasto não começa: itens (arrastá-los move), controles e menus. */
const NOT_HERE =
  "[data-select-id], button, a, input, textarea, select, label, [role='menu'], [role='dialog'], dialog, [contenteditable='true'], .drive-toolbar, .drive-breadcrumb, .drive-selection, .drive-uploads, .drive-menu";
/** Antes disso é um clique, não um arrasto. */
const THRESHOLD = 5;
/** Perto da borda da área que rola, a tela rola sozinha. */
const EDGE = 48;

function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (/(auto|scroll)/.test(overflowY) && p.scrollHeight > p.clientHeight)
      return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/**
 * Clique e arraste num espaço vazio para escolher vários itens, como no
 * Google Drive: um retângulo marca os que toca. Com Shift, Ctrl ou ⌘ soma à
 * escolha de antes; sem, troca. Um clique no vazio limpa a escolha e Esc
 * desfaz o arrasto. Só com mouse (no toque, arrastar rola a tela).
 *
 * Os itens se marcam com data-select-kind ("files" | "folders") e
 * data-select-id, dentro do elemento do `ref`.
 */
export function useMarqueeSelect(
  enabled: boolean,
  selected: MarqueeSelection,
  onSelect: (next: MarqueeSelection) => void,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const latest = useRef({ selected, onSelect });
  latest.current = { selected, onSelect };
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  useEffect(() => {
    if (!enabled) stop.current?.();
  }, [enabled]);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    const page = ref.current;
    if (
      !enabled ||
      !page ||
      e.button !== 0 ||
      e.pointerType === "touch" ||
      !(e.target instanceof Element)
    )
      return;
    // Só o que está dentro da página conta (a aba Drive da tarefa vive numa janela).
    const blocked = e.target.closest(NOT_HERE);
    if (blocked && page.contains(blocked)) return;
    const keep = e.shiftKey || e.ctrlKey || e.metaKey;
    const before = latest.current.selected;
    const base = keep ? before : { files: [], folders: [] };
    const scroller = scrollParent(page);
    // Coordenadas da página do Drive: não mudam quando a tela rola.
    const at = (x: number, y: number) => {
      const r = page.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const start = at(e.clientX, e.clientY);
    let pointer = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let last = "";
    let frame = 0;

    const update = () => {
      const now = at(pointer.x, pointer.y);
      const rect = {
        left: Math.min(start.x, now.x),
        top: Math.min(start.y, now.y),
        width: Math.abs(now.x - start.x),
        height: Math.abs(now.y - start.y),
      };
      setBox(rect);
      const pageRect = page.getBoundingClientRect();
      const hit: MarqueeSelection = { files: [], folders: [] };
      for (const el of page.querySelectorAll<HTMLElement>("[data-select-id]")) {
        const r = el.getBoundingClientRect();
        const left = r.left - pageRect.left,
          top = r.top - pageRect.top;
        if (
          left < rect.left + rect.width &&
          left + r.width > rect.left &&
          top < rect.top + rect.height &&
          top + r.height > rect.top
        ) {
          const kind = el.dataset.selectKind as keyof MarqueeSelection;
          if (kind === "files" || kind === "folders")
            hit[kind].push(el.dataset.selectId!);
        }
      }
      const next = {
        files: [...new Set([...base.files, ...hit.files])],
        folders: [...new Set([...base.folders, ...hit.folders])],
      };
      const key = `${next.files.join()}|${next.folders.join()}`;
      if (key !== last) {
        last = key;
        latest.current.onSelect(next);
      }
    };
    // Rola enquanto o cursor fica perto da borda (e segue marcando).
    const tick = () => {
      const r =
        scroller === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight }
          : scroller.getBoundingClientRect();
      const step =
        pointer.y < r.top + EDGE
          ? -Math.ceil((r.top + EDGE - pointer.y) / 4)
          : pointer.y > r.bottom - EDGE
            ? Math.ceil((pointer.y - (r.bottom - EDGE)) / 4)
            : 0;
      if (step) {
        scroller.scrollTop += step;
        update();
      }
      frame = requestAnimationFrame(tick);
    };

    const move = (ev: globalThis.PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (
          Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) <
          THRESHOLD
        )
          return;
        dragging = true;
        page.classList.add("marquee");
        frame = requestAnimationFrame(tick);
      }
      ev.preventDefault();
      update();
    };
    const end = (cancel: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("keydown", key);
      cancelAnimationFrame(frame);
      page.classList.remove("marquee");
      setBox(null);
      stop.current = null;
      // Esc: volta à escolha de antes do arrasto.
      if (cancel) latest.current.onSelect(before);
    };
    const up = () => {
      // Um clique no vazio (sem arrastar) limpa a escolha.
      if (!dragging && !keep) {
        const s = latest.current.selected;
        if (s.files.length || s.folders.length)
          latest.current.onSelect({ files: [], folders: [] });
      }
      end(false);
    };
    const cancelled = () => end(dragging);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && dragging) {
        ev.preventDefault();
        end(true);
      }
    };
    stop.current = () => end(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelled);
    window.addEventListener("keydown", key);
    // Sem selecionar texto enquanto arrasta.
    e.preventDefault();
  }

  return { ref, onPointerDown, box };
}

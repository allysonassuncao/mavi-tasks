import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerLeftUp,
  ImagePlus,
  Italic,
  Loader2,
  Move,
  Palette,
  Redo2,
  Trash2,
  Type,
  Undo2,
  Upload,
} from "lucide-react";
import { DESIGN_FORMATS, designPage, designParts, type DesignFormat } from "./mavi-design";
import { COLOR_LABELS, GOOGLE_FONTS, type IdentityColors, type Look } from "./visual-identity";
import "./canvas-edit.css";

/**
 * O editor do design livre: as páginas abrem num iframe (sem scripts; quem
 * edita é esta tela, que mexe no documento dele) e a pessoa clica num
 * elemento para escolher (Alt + clique: o que está por baixo), dá dois
 * cliques para escrever, muda cores, fontes e imagens, arrasta e
 * redimensiona (Shift: proporcional), põe na frente ou atrás, muda as
 * páginas, troca as cores e as fontes do material inteiro (Tema) e desfaz.
 * Ao salvar, o HTML volta com as referências (file:<id>, img:I1) no lugar
 * dos links.
 */

export type EditImage = { token: string; url: string; label: string };
export type DesignEditorHandle = { serialize: () => { html: string; look: Look | null } };
/** Enviar uma imagem do computador: devolve a imagem pronta para pôr. */
export type ImageUpload = (file: File) => Promise<EditImage>;

const MARK = ["data-mv-sel", "data-mv-hover"];
const EDITOR_CSS = `[data-mv-hover]{outline:1px dashed #4f7d2dcc;outline-offset:2px;cursor:pointer}
[data-mv-sel]{outline:2px solid #4f7d2d;outline-offset:2px}
[contenteditable=true]{outline:2px solid #2563eb !important;outline-offset:2px;cursor:text}
body{cursor:default}`;
const SYSTEM = ["Arial", "Georgia", "Times New Roman", "Verdana"];
const FONTS = [...Object.keys(GOOGLE_FONTS), ...SYSTEM];
const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi;

const hexOf = (rgb: string) => {
  const m = rgb.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return "#000000";
  return `#${m
    .slice(0, 3)
    .map((x) => Math.round(Number(x)).toString(16).padStart(2, "0"))
    .join("")}`;
};
const full = (h: string) => (h.length === 4 ? `#${h.slice(1).replace(/./g, "$&$&")}` : h).toUpperCase();
const transparent = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
const firstFamily = (f: string) => f.split(",")[0].replace(/["']/g, "").trim();
const parseTranslate = (t: string) => {
  const [x, y] = (t && t !== "none" ? t : "0px 0px").split(/\s+/).map((v) => parseFloat(v) || 0);
  return { x, y: y ?? 0 };
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A cor nas duas grafias (#AABBCC e, quando dá, #ABC), sem pegar pedaço de outra. */
function colorRe(hex: string) {
  const h = hex.slice(1).toLowerCase();
  const short = h[0] === h[1] && h[2] === h[3] && h[4] === h[5] ? `|#${h[0]}${h[2]}${h[4]}` : "";
  return new RegExp(`(?:#${h}${short})(?![0-9a-f])`, "gi");
}
const fontRe = (family: string) => new RegExp(`(["']?)${escapeRe(family)}\\1`, "g");
/** Cria um contexto de empilhamento (o z-index de dentro fica preso nele). */
function stacks(cs: CSSStyleDeclaration) {
  return (
    (cs.position !== "static" && cs.zIndex !== "auto") ||
    Number(cs.opacity) < 1 ||
    cs.transform !== "none" ||
    cs.filter !== "none" ||
    cs.isolation === "isolate" ||
    cs.mixBlendMode !== "normal"
  );
}

export const DesignEditor = forwardRef<
  DesignEditorHandle,
  {
    html: string;
    format: DesignFormat;
    look: Look | null;
    /** Troca as referências pelos links (tela). */
    url: (token: string) => string | null;
    /** As imagens que dá para pôr (da conversa, as enviadas e da Marca). */
    images: EditImage[];
    onUpload?: ImageUpload;
    title: string;
    onDirty: () => void;
  }
>(function DesignEditor({ html, format, look, url, images, onUpload, title, onDirty }, ref) {
  const f = DESIGN_FORMATS[format];
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const parts = useMemo(() => designParts(html), [html]);
  // Os estilos da MAVI (o Tema troca cores e fontes neles) e o tema: o iframe é a fonte da verdade.
  const styles = useRef(parts.styles);
  const lk = useRef<Look | null>(look);
  const fonts = useRef(new Set<string>());
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(f.height + 32);
  const [sel, setSel] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, force] = useState(0);
  const history = useRef<{ list: { body: string; head: string[] }[]; at: number }>({ list: [], at: -1 });

  // Os links das referências e o caminho de volta (link → referência).
  const tokens = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of html.matchAll(/(file:[0-9a-f-]{36}|img:I\d{1,2})/gi)) {
      const u = url(m[1]);
      if (u) map.set(u, m[1]);
    }
    for (const i of images) map.set(i.url, i.token);
    return map;
  }, [html, images, url]);
  // O desenho só se faz uma vez: daqui para a frente, o editor muda o documento do iframe.
  const page = useMemo(
    () =>
      designPage(`${parts.styles}\n${parts.body}`, format, look, url).replace(
        "</head>",
        `<style id="mv-editor">${EDITOR_CSS}</style></head>`,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const doc = () => frame.current?.contentDocument ?? null;
  const measure = useCallback(() => {
    const d = doc();
    if (!d) return;
    setHeight(Math.max(f.height, d.documentElement.scrollHeight));
    const s = d.querySelector<HTMLElement>("[data-mv-sel]");
    setRect(s ? s.getBoundingClientRect() : null);
  }, [f.height]);

  const headStyles = () => [...(doc()?.querySelectorAll<HTMLStyleElement>("head style:not(#mv-editor)") ?? [])];
  /** O corpo do iframe como fica salvo: sem as marcas do editor e com as referências. */
  const bodyHtml = useCallback(() => {
    const d = doc();
    if (!d) return parts.body;
    const clone = d.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("*").forEach((el) => {
      for (const a of MARK) el.removeAttribute(a);
      el.removeAttribute("contenteditable");
      for (const attr of ["src", "href", "style"]) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        let next = v;
        for (const [u, t] of tokens) if (next.includes(u)) next = next.split(u).join(t);
        if (next !== v) el.setAttribute(attr, next);
      }
    });
    return clone.innerHTML.trim();
  }, [parts.body, tokens]);

  const snapshot = useCallback(() => {
    const d = doc();
    if (!d) return;
    const h = history.current;
    const now = { body: d.body.innerHTML, head: headStyles().map((s) => s.textContent ?? "") };
    const last = h.list[h.at];
    if (last && last.body === now.body && last.head.join("\u0000") === now.head.join("\u0000")) return;
    h.list = [...h.list.slice(0, h.at + 1), now].slice(-60);
    h.at = h.list.length - 1;
    force((n) => n + 1);
  }, []);
  const commit = useCallback(() => {
    snapshot();
    onDirty();
    requestAnimationFrame(measure);
  }, [snapshot, onDirty, measure]);

  useImperativeHandle(ref, () => ({
    serialize: () => {
      // As fontes do Google escolhidas aqui (as do tema já vêm com a página).
      const links = [...fonts.current]
        .filter((fam) => GOOGLE_FONTS[fam])
        .map(
          (fam) =>
            `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fam.replace(/ /g, "+")}:wght@${GOOGLE_FONTS[fam].join(";")}&display=swap">`,
        )
        .join("\n");
      return { html: [links, styles.current, bodyHtml()].filter(Boolean).join("\n"), look: lk.current };
    },
  }));

  const select = useCallback((el: HTMLElement | null) => {
    const d = doc();
    if (!d) return;
    d.querySelectorAll("[data-mv-sel]").forEach((x) => x.removeAttribute("data-mv-sel"));
    const ok = el && el !== d.body && el !== d.documentElement;
    if (ok) el.setAttribute("data-mv-sel", "");
    setSel(ok ? el : null);
    setRect(ok ? el.getBoundingClientRect() : null);
  }, []);
  const stopEditing = useCallback(() => {
    const d = doc();
    if (!d) return;
    const on = d.querySelector<HTMLElement>("[contenteditable=true]");
    if (on) {
      on.removeAttribute("contenteditable");
      commit();
    }
    setEditing(false);
  }, [commit]);

  // As escutas no documento do iframe.
  const wire = useCallback(() => {
    const d = doc();
    if (!d) return;
    if (history.current.at < 0) {
      history.current = { list: [{ body: d.body.innerHTML, head: headStyles().map((s) => s.textContent ?? "") }], at: 0 };
      force((n) => n + 1);
    }
    d.addEventListener("mouseover", (e) => {
      const t = e.target as HTMLElement;
      d.querySelectorAll("[data-mv-hover]").forEach((x) => x.removeAttribute("data-mv-hover"));
      if (t !== d.body && t !== d.documentElement) t.setAttribute("data-mv-hover", "");
    });
    d.addEventListener("mouseleave", () => d.querySelectorAll("[data-mv-hover]").forEach((x) => x.removeAttribute("data-mv-hover")));
    d.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable) return;
      e.preventDefault();
      stopEditing();
      if (e.altKey) {
        // Alt + clique: o próximo elemento por baixo (para chegar ao que está coberto).
        const stack = d.elementsFromPoint(e.clientX, e.clientY).filter((x): x is HTMLElement => x !== d.body && x !== d.documentElement);
        const cur = d.querySelector<HTMLElement>("[data-mv-sel]");
        const at = cur ? stack.indexOf(cur) : -1;
        select(stack[(at + 1) % Math.max(1, stack.length)] ?? null);
        return;
      }
      select(t === d.body || t === d.documentElement ? null : t);
    });
    d.addEventListener("dblclick", (e) => {
      let t = e.target as HTMLElement;
      if (!t.textContent?.trim() || t.tagName === "IMG") return;
      // Um trecho dentro do texto (um destaque, um negrito): escreve no bloco inteiro.
      while (t.parentElement && t.parentElement !== d.body && getComputedStyle(t).display === "inline") t = t.parentElement;
      e.preventDefault();
      select(t);
      t.setAttribute("contenteditable", "true");
      t.focus();
      setEditing(true);
    });
    d.addEventListener("input", () => {
      onDirty();
      requestAnimationFrame(measure);
    });
    d.addEventListener("focusout", (e) => {
      if ((e.target as HTMLElement).isContentEditable) stopEditing();
    });
    d.addEventListener("keydown", (e) => keys(e));
    void d.fonts?.ready.then(measure);
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, select, stopEditing, onDirty]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  function undo(step: -1 | 1) {
    const d = doc();
    const h = history.current;
    const at = h.at + step;
    if (!d || at < 0 || at >= h.list.length) return;
    h.at = at;
    d.body.innerHTML = h.list[at].body;
    headStyles().forEach((s, k) => {
      if (h.list[at].head[k] !== undefined) s.textContent = h.list[at].head[k];
    });
    select(null);
    setEditing(false);
    onDirty();
    force((n) => n + 1);
    requestAnimationFrame(measure);
  }
  function keys(e: KeyboardEvent) {
    const d = doc();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      if ((e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      undo(e.shiftKey ? 1 : -1);
      return;
    }
    if (e.key === "Escape") {
      if (d?.querySelector("[contenteditable=true]")) stopEditing();
      else select(null);
      return;
    }
    const s = d?.querySelector<HTMLElement>("[data-mv-sel]");
    if (!s || s.isContentEditable) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(s);
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const p = parseTranslate(s.style.translate);
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      s.style.translate = `${p.x + dx}px ${p.y + dy}px`;
      commit();
    }
  }

  // ------------------------------------------------------------ ações
  const pageOf = (el: HTMLElement | null) => el?.closest<HTMLElement>("section.page") ?? null;
  function remove(el: HTMLElement) {
    if (el.matches("section.page") && doc()!.querySelectorAll("section.page").length <= 1) return;
    el.remove();
    select(null);
    commit();
  }
  function duplicate(el: HTMLElement) {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.removeAttribute("data-mv-sel");
    if (!el.matches("section.page")) {
      const p = parseTranslate(el.style.translate);
      copy.style.translate = `${p.x + 16}px ${p.y + 16}px`;
    }
    el.after(copy);
    select(copy);
    commit();
  }
  /**
   * Na frente ou atrás de tudo o que está por cima ou por baixo dele na página
   * (o que se sobrepõe). Quando um bloco de fora prende a camada (um contexto de
   * empilhamento), ele sobe ou desce junto.
   */
  function layer(el: HTMLElement, toFront: boolean) {
    const d = doc();
    if (!d) return;
    const scope = pageOf(el) ?? d.body;
    const r = el.getBoundingClientRect();
    const zOf = (x: Element) => Number.parseInt(getComputedStyle(x).zIndex) || 0;
    const others = [...scope.querySelectorAll<HTMLElement>("*")].filter((o) => {
      if (o === el || o.contains(el) || el.contains(o)) return false;
      const q = o.getBoundingClientRect();
      return q.width > 0 && q.height > 0 && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top;
    });
    const zs = others.map(zOf);
    const target = toFront ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
    const put = (x: HTMLElement) => {
      if (getComputedStyle(x).position === "static") x.style.position = "relative";
      x.style.zIndex = String(target);
    };
    put(el);
    for (let a = el.parentElement; a && a !== scope && a !== d.body; a = a.parentElement) if (stacks(getComputedStyle(a))) put(a);
    commit();
  }
  function movePage(el: HTMLElement, up: boolean) {
    const sib = up ? el.previousElementSibling : el.nextElementSibling;
    if (!sib?.matches("section.page")) return;
    if (up) sib.before(el);
    else sib.after(el);
    select(el);
    commit();
  }
  function style(prop: keyof CSSStyleDeclaration, value: string) {
    const d = doc();
    if (!d || !sel) return;
    if (editing && ["color", "fontWeight", "fontStyle"].includes(String(prop))) {
      // Escrevendo: vale para o trecho escolhido.
      d.execCommand("styleWithCSS", false, "true");
      if (prop === "color") d.execCommand("foreColor", false, value);
      if (prop === "fontWeight") d.execCommand("bold");
      if (prop === "fontStyle") d.execCommand("italic");
      onDirty();
      return;
    }
    (sel.style as unknown as Record<string, string>)[prop as string] = value;
    commit();
  }
  function loadFont(family: string) {
    const d = doc();
    if (!d || !GOOGLE_FONTS[family]) return;
    fonts.current.add(family);
    const href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${GOOGLE_FONTS[family].join(";")}&display=swap`;
    if (!d.querySelector(`link[href="${href}"]`)) {
      const link = d.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      d.head.appendChild(link);
    }
    void d.fonts?.ready.then(measure);
  }
  function font(family: string) {
    loadFont(family);
    style("fontFamily", `"${family}", ${SYSTEM.includes(family) ? "serif" : "Arial, sans-serif"}`);
  }
  function putImage(img: EditImage) {
    const d = doc();
    if (!d) return;
    if (sel?.tagName === "IMG") (sel as HTMLImageElement).src = img.url;
    else if (sel && getComputedStyle(sel).backgroundImage !== "none") sel.style.backgroundImage = `url("${img.url}")`;
    else {
      const target = pageOf(sel) ?? d.querySelector<HTMLElement>("section.page");
      if (!target) return;
      const el = d.createElement("img");
      el.src = img.url;
      el.alt = "";
      Object.assign(el.style, { position: "absolute", left: "80px", top: "120px", width: "320px", height: "auto", zIndex: "5" });
      target.appendChild(el);
      select(el);
    }
    commit();
  }
  function addText() {
    const d = doc();
    if (!d) return;
    const target = pageOf(sel) ?? d.querySelector<HTMLElement>("section.page");
    if (!target) return;
    const el = d.createElement("div");
    el.textContent = "Novo texto";
    Object.assign(el.style, {
      position: "absolute",
      left: "80px",
      top: "80px",
      fontSize: "32px",
      fontWeight: "700",
      color: lk.current?.colors.ink ?? "#1c2728",
      fontFamily: lk.current ? "var(--font-head)" : "Arial, sans-serif",
      zIndex: "5",
    });
    target.appendChild(el);
    select(el);
    el.setAttribute("contenteditable", "true");
    el.focus();
    d.getSelection()?.selectAllChildren(el);
    setEditing(true);
    commit();
  }

  // ------------------------------------------------------------ tema (o material inteiro)
  /** Os textos onde cor e fonte aparecem: as folhas e os estilos de cada elemento. */
  function everywhere(fn: (text: string) => string) {
    const d = doc();
    if (!d) return;
    headStyles().forEach((s) => {
      const next = fn(s.textContent ?? "");
      if (next !== s.textContent) s.textContent = next;
    });
    d.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
      const v = el.getAttribute("style") ?? "";
      const next = fn(v);
      if (next !== v) el.setAttribute("style", next);
    });
    const root = d.documentElement.getAttribute("style");
    if (root) d.documentElement.setAttribute("style", fn(root));
    styles.current = fn(styles.current);
  }
  /** Troca uma cor em todo o material (e no tema, quando é uma cor dele). */
  function recolor(from: string, to: string) {
    if (full(from) === full(to)) return;
    const re = colorRe(full(from));
    everywhere((t) => t.replace(re, to.toUpperCase()));
    if (lk.current) {
      const c = { ...lk.current.colors };
      for (const k of Object.keys(c) as (keyof IdentityColors)[]) if (full(c[k]) === full(from)) c[k] = to.toUpperCase();
      lk.current = { ...lk.current, colors: c };
    }
    onDirty();
  }
  /** Troca uma fonte em todo o material. */
  function refont(from: string, to: string) {
    if (from === to) return;
    loadFont(to);
    const re = fontRe(from);
    everywhere((t) => t.replace(re, `"${to}"`));
    if (lk.current)
      for (const k of ["heading", "body"] as const)
        if (lk.current[k].family === from)
          lk.current = { ...lk.current, [k]: { ...lk.current[k], family: to, source: GOOGLE_FONTS[to] ? "google" : lk.current[k].source } };
    commit();
  }
  /** As cores e as fontes que o material usa (as mais usadas primeiro). */
  function palette() {
    const d = doc();
    if (!d) return { colors: [] as string[], families: [] as string[] };
    const texts = [
      ...headStyles().map((s) => s.textContent ?? ""),
      ...[...d.querySelectorAll<HTMLElement>("[style]")].map((e) => e.getAttribute("style") ?? ""),
    ];
    const count = new Map<string, number>();
    const fam = new Map<string, number>();
    for (const t of texts) {
      for (const m of t.matchAll(HEX)) count.set(full(m[0]), (count.get(full(m[0])) ?? 0) + 1);
      for (const m of t.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
        const name = firstFamily(m[1]);
        if (name && !/^var\(/.test(name) && !/^(inherit|initial|serif|sans-serif|monospace)$/i.test(name)) fam.set(name, (fam.get(name) ?? 0) + 1);
      }
    }
    for (const k of lk.current ? [lk.current.heading.family, lk.current.body.family] : []) fam.set(k, (fam.get(k) ?? 0) + 5);
    // As do editor (contorno de seleção) e o cinza em volta das páginas não são do material.
    for (const x of ["#4F7D2D", "#2563EB", "#DFE4E1"]) count.delete(x);
    return {
      colors: [...count].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([c]) => c),
      families: [...fam].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n]) => n),
    };
  }

  // ------------------------------------------------------------ arrastar
  const frameWidth = f.width + 32;
  const scale = width ? Math.min(1, width / frameWidth) : 1;
  function drag(kind: "move" | "e" | "s" | "se" | "w" | "n" | "nw" | "ne" | "sw") {
    return (e: React.PointerEvent) => {
      if (!sel) return;
      e.preventDefault();
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY };
      const r0 = sel.getBoundingClientRect();
      const t0 = parseTranslate(sel.style.translate);
      const ratio = r0.width / Math.max(1, r0.height);
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / scale;
        const dy = (ev.clientY - start.y) / scale;
        if (kind === "move") {
          sel.style.translate = `${Math.round(t0.x + dx)}px ${Math.round(t0.y + dy)}px`;
          setRect(sel.getBoundingClientRect());
          return;
        }
        let w = r0.width + (kind.includes("e") ? dx : kind.includes("w") ? -dx : 0);
        let h = r0.height + (kind.includes("s") ? dy : kind.includes("n") ? -dy : 0);
        // Shift: proporcional (pela borda que mais mudou).
        const keep = ev.shiftKey;
        if (keep) {
          if (kind === "n" || kind === "s") w = h * ratio;
          else if (kind === "e" || kind === "w") h = w / ratio;
          else if (Math.abs(w - r0.width) / r0.width >= Math.abs(h - r0.height) / r0.height) h = w / ratio;
          else w = h * ratio;
        }
        w = Math.max(16, w);
        h = Math.max(12, h);
        const tx = kind.includes("w") ? t0.x + (r0.width - w) : t0.x;
        const ty = kind.includes("n") ? t0.y + (r0.height - h) : t0.y;
        if (keep || (kind !== "n" && kind !== "s")) sel.style.width = `${Math.round(w)}px`;
        if (keep || (kind !== "e" && kind !== "w")) {
          sel.style.height = `${Math.round(h)}px`;
          if (sel.tagName === "IMG") sel.style.objectFit ||= keep ? "contain" : "cover";
        }
        sel.style.translate = `${Math.round(tx)}px ${Math.round(ty)}px`;
        setRect(sel.getBoundingClientRect());
      };
      // O ponteiro fica preso na alça: sobre o iframe, os eventos iriam para ele.
      const grip = e.currentTarget as HTMLElement;
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        // Sem captura (ponteiro já solto): segue com os eventos da própria alça.
      }
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        commit();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    };
  }

  // ------------------------------------------------------------ barra
  // Os controles ficam sempre na barra (desligados quando não servem): a altura não muda ao escolher.
  const cs = sel ? getComputedStyle(sel) : null;
  const isPage = !!sel?.matches("section.page");
  const isImage = !!sel && (sel.tagName === "IMG" || (cs?.backgroundImage ?? "none") !== "none");
  const textOff = !sel || isPage;
  const h = history.current;
  const colorInput = (label: string, value: string, onPick: (v: string) => void, disabled = false) => (
    <label className={`cedit-color${disabled ? " off" : ""}`} title={label}>
      <span>{label}</span>
      <input type="color" value={value} disabled={disabled} onChange={(e) => onPick(e.target.value)} />
    </label>
  );
  const family = cs ? firstFamily(cs.fontFamily) : "";
  return (
    <div className="cedit">
      <div className="cedit-bar wrap" role="toolbar" aria-label="Edição do design">
        <span className="cedit-group">
          <button type="button" className="icon-btn" title="Desfazer (Ctrl+Z)" aria-label="Desfazer" disabled={h.at <= 0} onClick={() => undo(-1)}>
            <Undo2 size={16} />
          </button>
          <button type="button" className="icon-btn" title="Refazer (Ctrl+Shift+Z)" aria-label="Refazer" disabled={h.at >= h.list.length - 1} onClick={() => undo(1)}>
            <Redo2 size={16} />
          </button>
        </span>
        <span className="cedit-group">
          <button type="button" className="cedit-btn" onClick={addText}>
            <Type size={15} /> Texto
          </button>
          <ImagePicker images={images} label={isImage ? "Trocar imagem" : "Imagem"} onPick={putImage} onUpload={onUpload} />
          <DesignTheme palette={palette} onColor={recolor} onFont={refont} onDone={commit} />
        </span>
        <span className="cedit-group">
          <button type="button" className="icon-btn" title="Escolher o bloco de fora" aria-label="Escolher o bloco de fora" disabled={!sel?.parentElement || sel.parentElement === doc()?.body} onClick={() => sel && select(sel.parentElement)}>
            <CornerLeftUp size={16} />
          </button>
          <select className="cedit-font" aria-label="Fonte" disabled={textOff} value={family} onChange={(e) => font(e.target.value)}>
            {[...new Set([family, ...(lk.current ? [lk.current.heading.family, lk.current.body.family] : []), ...FONTS])].filter(Boolean).map((fam) => (
              <option key={fam} value={fam}>
                {fam}
              </option>
            ))}
          </select>
          <input
            className="cedit-size"
            type="number"
            min={6}
            max={400}
            aria-label="Tamanho da letra"
            title="Tamanho da letra (px)"
            disabled={textOff}
            value={cs ? Math.round(parseFloat(cs.fontSize)) : ""}
            onChange={(e) => style("fontSize", `${e.target.value}px`)}
          />
          <button type="button" className={`icon-btn${cs && Number(cs.fontWeight) >= 600 ? " on" : ""}`} title="Negrito" aria-label="Negrito" disabled={textOff} onClick={() => cs && style("fontWeight", Number(cs.fontWeight) >= 600 ? "400" : "700")}>
            <Bold size={15} />
          </button>
          <button type="button" className={`icon-btn${cs?.fontStyle === "italic" ? " on" : ""}`} title="Itálico" aria-label="Itálico" disabled={textOff} onClick={() => cs && style("fontStyle", cs.fontStyle === "italic" ? "normal" : "italic")}>
            <Italic size={15} />
          </button>
          {(["left", "center", "right"] as const).map((a) => {
            const Icon = a === "left" ? AlignLeft : a === "center" ? AlignCenter : AlignRight;
            return (
              <button key={a} type="button" className={`icon-btn${cs?.textAlign === a ? " on" : ""}`} title={`Alinhar ${a === "left" ? "à esquerda" : a === "center" ? "ao centro" : "à direita"}`} aria-label={`Alinhar ${a}`} disabled={textOff} onClick={() => style("textAlign", a)}>
                <Icon size={15} />
              </button>
            );
          })}
          {colorInput("Letra", cs ? hexOf(cs.color) : "#000000", (v) => style("color", v), textOff)}
          {colorInput("Fundo", cs && !transparent(cs.backgroundColor) ? hexOf(cs.backgroundColor) : "#ffffff", (v) => style("backgroundColor", v), !sel)}
          <button type="button" className="cedit-btn" disabled={!sel || isPage || !cs || transparent(cs.backgroundColor)} onClick={() => style("backgroundColor", "transparent")}>
            Sem fundo
          </button>
        </span>
        <span className="cedit-group">
          <button type="button" className="icon-btn" title={isPage ? "Página para cima" : "Trazer para a frente (na frente do que está por cima)"} aria-label={isPage ? "Página para cima" : "Trazer para a frente"} disabled={!sel} onClick={() => sel && (isPage ? movePage(sel, true) : layer(sel, true))}>
            {isPage ? <ChevronUp size={16} /> : <ArrowUpToLine size={16} />}
          </button>
          <button type="button" className="icon-btn" title={isPage ? "Página para baixo" : "Mandar para trás (atrás do que está por baixo)"} aria-label={isPage ? "Página para baixo" : "Mandar para trás"} disabled={!sel} onClick={() => sel && (isPage ? movePage(sel, false) : layer(sel, false))}>
            {isPage ? <ChevronDown size={16} /> : <ArrowDownToLine size={16} />}
          </button>
          <button type="button" className="icon-btn" title={isPage ? "Duplicar a página" : "Duplicar"} aria-label="Duplicar" disabled={!sel} onClick={() => sel && duplicate(sel)}>
            <Copy size={15} />
          </button>
          <button type="button" className="icon-btn cedit-danger" title={isPage ? "Apagar a página" : "Apagar (Delete)"} aria-label="Apagar" disabled={!sel} onClick={() => sel && remove(sel)}>
            <Trash2 size={15} />
          </button>
        </span>
      </div>
      <p className="cedit-hint">
        Clique para escolher · Alt + clique: o que está por baixo · dois cliques para escrever · arraste pela alça · Shift nos cantos: proporcional
      </p>
      <div className="cedit-stage" ref={box}>
        <div className="cedit-scaled" style={{ width: frameWidth * scale, height: height * scale }}>
          <div style={{ width: frameWidth, height, transform: `scale(${scale})`, transformOrigin: "0 0", position: "relative" }}>
            <iframe
              ref={frame}
              title={`Editando: ${title}`}
              sandbox="allow-same-origin"
              srcDoc={page}
              onLoad={wire}
              style={{ width: frameWidth, height, border: 0, display: "block" }}
            />
            {sel && rect && !editing && (
              <div className="cedit-box" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
                {!isPage && (
                  <>
                    <span className="cedit-grip" title="Arraste para mover" onPointerDown={drag("move")}>
                      <Move size={13} />
                    </span>
                    {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((k) => (
                      <span key={k} className={`cedit-handle ${k}`} title="Arraste para redimensionar (Shift: proporcional)" onPointerDown={drag(k)} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export function ImagePicker({
  images,
  label,
  onPick,
  onUpload,
}: {
  images: EditImage[];
  label: string;
  onPick: (i: EditImage) => void;
  onUpload?: ImageUpload;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function upload(file: File | undefined) {
    if (!file || !onUpload) return;
    setBusy(true);
    setError("");
    try {
      const img = await onUpload(file);
      onPick(img);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message || "Não foi possível enviar a imagem.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="cedit-btn" disabled={!images.length && !onUpload}>
          <ImagePlus size={15} /> {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="status-menu cedit-pop" align="start" sideOffset={6}>
          {onUpload && (
            <>
              <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => void upload(e.target.files?.[0])} />
              <button type="button" className="cedit-upload" disabled={busy} onClick={() => input.current?.click()}>
                {busy ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
                {busy ? "Enviando…" : "Enviar do computador"}
                <small>PNG, JPG ou WebP, até 10 MB</small>
              </button>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
          <p className="cedit-pop-title">{images.length ? "Imagens da conversa e da Marca" : "Ainda não há imagens nesta conversa."}</p>
          {images.length > 0 && (
            <div className="cedit-images">
              {images.map((i) => (
                <button
                  key={i.token}
                  type="button"
                  title={i.label}
                  onClick={() => {
                    onPick(i);
                    setOpen(false);
                  }}
                >
                  <img src={i.url} alt={i.label} />
                </button>
              ))}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * O Tema do design livre: as cores e as fontes que o material usa; trocar
 * uma muda em todo lugar onde ela aparece, na hora.
 */
function DesignTheme({
  palette,
  onColor,
  onFont,
  onDone,
}: {
  palette: () => { colors: string[]; families: string[] };
  onColor: (from: string, to: string) => void;
  onFont: (from: string, to: string) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Cada cor guarda a de origem e a de agora (a troca vai sempre da de agora para a nova).
  const [colors, setColors] = useState<{ from: string; now: string }[]>([]);
  const [families, setFamilies] = useState<string[]>([]);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          const p = palette();
          setColors(p.colors.map((c) => ({ from: c, now: c })));
          setFamilies(p.families);
        } else onDone();
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className="cedit-btn">
          <Palette size={15} /> Tema
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="status-menu cedit-pop wide" align="start" sideOffset={6}>
          <p className="cedit-pop-title">Cores do material (troca em todo lugar)</p>
          <div className="cedit-swatches">
            {colors.map((c, k) => (
              <label key={c.from} className="cedit-swatch" title={`${c.now}${c.now !== c.from ? ` (era ${c.from})` : ""}`}>
                <input
                  type="color"
                  value={c.now.toLowerCase()}
                  onChange={(e) => {
                    const next = e.target.value.toUpperCase();
                    onColor(c.now, next);
                    setColors((list) => list.map((x, j) => (j === k ? { ...x, now: next } : x)));
                  }}
                />
                <span>{c.now}</span>
              </label>
            ))}
            {!colors.length && <small className="cedit-hint">Nenhuma cor escrita no material.</small>}
          </div>
          <p className="cedit-pop-title">Fontes do material</p>
          <div className="cedit-theme">
            {families.map((fam, k) => (
              <label key={k} className="cedit-theme-font">
                <span>{k === 0 ? "A mais usada" : "Outra fonte"}</span>
                <select
                  value={fam}
                  onChange={(e) => {
                    onFont(fam, e.target.value);
                    setFamilies((list) => list.map((x, j) => (j === k ? e.target.value : x)));
                  }}
                >
                  {[...new Set([fam, ...FONTS])].map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** O tema das apresentações e dos documentos: as cores por função e as duas fontes. */
export function ThemePicker({ look, onChange }: { look: Look; onChange: (next: Look) => void }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="cedit-btn">
          <Palette size={15} /> Tema
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="status-menu cedit-pop" align="start" sideOffset={6}>
          <p className="cedit-pop-title">Cores e fontes do material todo</p>
          <div className="cedit-theme">
            {(Object.keys(COLOR_LABELS) as (keyof IdentityColors)[]).map((k) => (
              <label key={k} className="cedit-color wide">
                <span>{COLOR_LABELS[k]}</span>
                <input
                  type="color"
                  value={look.colors[k].toLowerCase()}
                  onChange={(e) => onChange({ ...look, colors: { ...look.colors, [k]: e.target.value.toUpperCase() } })}
                />
              </label>
            ))}
            {(["heading", "body"] as const).map((k) => (
              <label key={k} className="cedit-theme-font">
                <span>{k === "heading" ? "Títulos" : "Texto"}</span>
                <select
                  value={look[k].family}
                  onChange={(e) =>
                    onChange({ ...look, [k]: { family: e.target.value, weight: look[k].weight, source: GOOGLE_FONTS[e.target.value] ? "google" : look[k].source } })
                  }
                >
                  {[...new Set([look[k].family, ...Object.keys(GOOGLE_FONTS)])].map((fam) => (
                    <option key={fam} value={fam}>
                      {fam}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

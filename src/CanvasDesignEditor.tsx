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
  Move,
  Palette,
  Redo2,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { DESIGN_FORMATS, designPage, designParts, type DesignFormat } from "./mavi-design";
import { COLOR_LABELS, GOOGLE_FONTS, type IdentityColors, type Look } from "./visual-identity";
import "./canvas-edit.css";

/**
 * O editor do design livre: as páginas abrem num iframe (sem scripts; quem
 * edita é esta tela, que mexe no documento dele) e a pessoa clica num
 * elemento para escolher, dá dois cliques para escrever, muda cores, fontes
 * e imagens, arrasta e redimensiona, muda a ordem das camadas e das páginas,
 * e desfaz. Ao salvar, o HTML volta com as referências (file:<id>, img:I1)
 * no lugar dos links.
 */

export type EditImage = { token: string; url: string; label: string };
export type DesignEditorHandle = { serialize: () => { html: string; look: Look | null } };

const MARK = ["data-mv-sel", "data-mv-hover"];
const EDITOR_CSS = `[data-mv-hover]{outline:1px dashed #4f7d2dcc;outline-offset:2px;cursor:pointer}
[data-mv-sel]{outline:2px solid #4f7d2d;outline-offset:2px}
[contenteditable=true]{outline:2px solid #2563eb !important;outline-offset:2px;cursor:text}
body{cursor:default}`;
const SYSTEM = ["Arial", "Georgia", "Times New Roman", "Verdana"];
const FONTS = [...Object.keys(GOOGLE_FONTS), ...SYSTEM];

const hexOf = (rgb: string) => {
  const m = rgb.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return "#000000";
  return `#${m
    .slice(0, 3)
    .map((x) => Math.round(Number(x)).toString(16).padStart(2, "0"))
    .join("")}`;
};
const transparent = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
const firstFamily = (f: string) => f.split(",")[0].replace(/["']/g, "").trim();
const parseTranslate = (t: string) => {
  const [x, y] = (t && t !== "none" ? t : "0px 0px").split(/\s+/).map((v) => parseFloat(v) || 0);
  return { x, y: y ?? 0 };
};

export const DesignEditor = forwardRef<
  DesignEditorHandle,
  {
    html: string;
    format: DesignFormat;
    look: Look | null;
    /** Troca as referências pelos links (tela). */
    url: (token: string) => string | null;
    /** As imagens que dá para pôr (da conversa e da Marca). */
    images: EditImage[];
    title: string;
    onDirty: () => void;
  }
>(function DesignEditor({ html, format, look, url, images, title, onDirty }, ref) {
  const f = DESIGN_FORMATS[format];
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const parts = useMemo(() => designParts(html), [html]);
  // O corpo atual (o que o editor mudou) e o tema: trocar o tema redesenha.
  const [body, setBody] = useState(parts.body);
  const [lk, setLk] = useState<Look | null>(look);
  const fonts = useRef(new Set<string>());
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(f.height + 32);
  const [sel, setSel] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, force] = useState(0);
  const history = useRef<{ list: string[]; at: number }>({ list: [], at: -1 });

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
  const page = useMemo(
    () => designPage(`${parts.styles}\n${body}`, format, lk, url).replace("</head>", `<style id="mv-editor">${EDITOR_CSS}</style></head>`),
    // O corpo só entra no primeiro desenho e quando o tema muda (o iframe é a fonte da verdade).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts.styles, format, lk, url],
  );

  const doc = () => frame.current?.contentDocument ?? null;
  const measure = useCallback(() => {
    const d = doc();
    if (!d) return;
    setHeight(Math.max(f.height, d.documentElement.scrollHeight));
    const s = d.querySelector<HTMLElement>("[data-mv-sel]");
    setRect(s ? s.getBoundingClientRect() : null);
  }, [f.height]);

  /** O corpo do iframe como fica salvo: sem as marcas do editor e com as referências. */
  const bodyHtml = useCallback(() => {
    const d = doc();
    if (!d) return body;
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
  }, [body, tokens]);

  const snapshot = useCallback(() => {
    const d = doc();
    if (!d) return;
    const h = history.current;
    const now = d.body.innerHTML;
    if (h.list[h.at] === now) return;
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
        .map(
          (fam) =>
            `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fam.replace(/ /g, "+")}:wght@${GOOGLE_FONTS[fam].join(";")}&display=swap">`,
        )
        .join("\n");
      return { html: [links, parts.styles, bodyHtml()].filter(Boolean).join("\n"), look: lk };
    },
  }));

  const select = useCallback((el: HTMLElement | null) => {
    const d = doc();
    if (!d) return;
    d.querySelectorAll("[data-mv-sel]").forEach((x) => x.removeAttribute("data-mv-sel"));
    if (el && el !== d.body) el.setAttribute("data-mv-sel", "");
    setSel(el && el !== d.body ? el : null);
    setRect(el && el !== d.body ? el.getBoundingClientRect() : null);
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

  // As escutas no documento do iframe (a cada desenho novo).
  const wire = useCallback(() => {
    const d = doc();
    if (!d) return;
    if (history.current.at < 0) {
      history.current = { list: [d.body.innerHTML], at: 0 };
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
    d.body.innerHTML = h.list[at];
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
  function layer(el: HTMLElement, up: boolean) {
    const cs = getComputedStyle(el);
    if (cs.position === "static") el.style.position = "relative";
    const z = Number.parseInt(cs.zIndex) || 0;
    el.style.zIndex = String(up ? z + 1 : z - 1);
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
  function font(family: string) {
    const d = doc();
    if (!d || !sel) return;
    if (GOOGLE_FONTS[family] && !(lk && [lk.heading.family, lk.body.family].includes(family))) {
      fonts.current.add(family);
      const href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${GOOGLE_FONTS[family].join(";")}&display=swap`;
      if (!d.querySelector(`link[href="${href}"]`)) {
        const link = d.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        d.head.appendChild(link);
      }
    }
    style("fontFamily", `"${family}", ${SYSTEM.includes(family) ? "serif" : "Arial, sans-serif"}`);
    void d.fonts?.ready.then(measure);
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
      color: lk?.colors.ink ?? "#1c2728",
      fontFamily: lk ? "var(--font-head)" : "Arial, sans-serif",
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
  function theme(next: Look) {
    // Guarda o que foi editado e redesenha com o tema novo.
    setBody(bodyHtml());
    history.current = { list: [], at: -1 };
    setLk(next);
    select(null);
    onDirty();
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
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / scale;
        const dy = (ev.clientY - start.y) / scale;
        if (kind === "move") sel.style.translate = `${Math.round(t0.x + dx)}px ${Math.round(t0.y + dy)}px`;
        else {
          let w = r0.width;
          let h = r0.height;
          let tx = t0.x;
          let ty = t0.y;
          if (kind.includes("e")) w = r0.width + dx;
          if (kind.includes("s")) h = r0.height + dy;
          if (kind.includes("w")) {
            w = r0.width - dx;
            tx = t0.x + dx;
          }
          if (kind.includes("n")) {
            h = r0.height - dy;
            ty = t0.y + dy;
          }
          if (kind !== "n" && kind !== "s") sel.style.width = `${Math.max(16, Math.round(w))}px`;
          if (kind !== "e" && kind !== "w") {
            sel.style.height = `${Math.max(12, Math.round(h))}px`;
            if (sel.tagName === "IMG") sel.style.objectFit ||= "cover";
          }
          sel.style.translate = `${Math.round(tx)}px ${Math.round(ty)}px`;
        }
        setRect(sel.getBoundingClientRect());
      };
      // O ponteiro fica preso na alça: sobre o iframe, os eventos iriam para ele.
      const grip = e.currentTarget as HTMLElement;
      grip.setPointerCapture(e.pointerId);
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
  const cs = sel ? getComputedStyle(sel) : null;
  const isPage = !!sel?.matches("section.page");
  const isImage = !!sel && (sel.tagName === "IMG" || (cs?.backgroundImage ?? "none") !== "none");
  const h = history.current;
  const colorInput = (label: string, value: string, onPick: (v: string) => void) => (
    <label className="cedit-color" title={label}>
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onPick(e.target.value)} />
    </label>
  );
  return (
    <div className="cedit">
      <div className="cedit-bar" role="toolbar" aria-label="Edição do design">
        <button type="button" className="icon-btn" title="Desfazer (Ctrl+Z)" aria-label="Desfazer" disabled={h.at <= 0} onClick={() => undo(-1)}>
          <Undo2 size={16} />
        </button>
        <button type="button" className="icon-btn" title="Refazer (Ctrl+Shift+Z)" aria-label="Refazer" disabled={h.at >= h.list.length - 1} onClick={() => undo(1)}>
          <Redo2 size={16} />
        </button>
        <span className="cedit-sep" />
        <button type="button" className="cedit-btn" onClick={addText}>
          <Type size={15} /> Texto
        </button>
        <ImagePicker images={images} label={isImage ? "Trocar imagem" : "Imagem"} onPick={putImage} />
        {lk && <ThemePicker look={lk} onChange={theme} />}
        <span className="cedit-sep" />
        {sel && cs ? (
          <>
            <button type="button" className="icon-btn" title="Escolher o bloco de fora" aria-label="Escolher o bloco de fora" disabled={!sel.parentElement || sel.parentElement === doc()?.body} onClick={() => select(sel.parentElement)}>
              <CornerLeftUp size={16} />
            </button>
            {!isPage && (
              <>
                <select
                  className="cedit-font"
                  aria-label="Fonte"
                  value={firstFamily(cs.fontFamily)}
                  onChange={(e) => font(e.target.value)}
                >
                  {[...new Set([firstFamily(cs.fontFamily), ...(lk ? [lk.heading.family, lk.body.family] : []), ...FONTS])].map((fam) => (
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
                  value={Math.round(parseFloat(cs.fontSize))}
                  onChange={(e) => style("fontSize", `${e.target.value}px`)}
                />
                <button type="button" className={`icon-btn${Number(cs.fontWeight) >= 600 ? " on" : ""}`} title="Negrito" aria-label="Negrito" onClick={() => style("fontWeight", Number(cs.fontWeight) >= 600 ? "400" : "700")}>
                  <Bold size={15} />
                </button>
                <button type="button" className={`icon-btn${cs.fontStyle === "italic" ? " on" : ""}`} title="Itálico" aria-label="Itálico" onClick={() => style("fontStyle", cs.fontStyle === "italic" ? "normal" : "italic")}>
                  <Italic size={15} />
                </button>
                {(["left", "center", "right"] as const).map((a) => {
                  const Icon = a === "left" ? AlignLeft : a === "center" ? AlignCenter : AlignRight;
                  return (
                    <button key={a} type="button" className={`icon-btn${cs.textAlign === a ? " on" : ""}`} title={`Alinhar ${a === "left" ? "à esquerda" : a === "center" ? "ao centro" : "à direita"}`} aria-label={`Alinhar ${a}`} onClick={() => style("textAlign", a)}>
                      <Icon size={15} />
                    </button>
                  );
                })}
                {colorInput("Letra", hexOf(cs.color), (v) => style("color", v))}
              </>
            )}
            {colorInput("Fundo", transparent(cs.backgroundColor) ? "#ffffff" : hexOf(cs.backgroundColor), (v) => style("backgroundColor", v))}
            {!isPage && !transparent(cs.backgroundColor) && (
              <button type="button" className="cedit-btn" onClick={() => style("backgroundColor", "transparent")}>
                Sem fundo
              </button>
            )}
            <span className="cedit-sep" />
            {isPage ? (
              <>
                <button type="button" className="icon-btn" title="Página para cima" aria-label="Página para cima" onClick={() => movePage(sel, true)}>
                  <ChevronUp size={16} />
                </button>
                <button type="button" className="icon-btn" title="Página para baixo" aria-label="Página para baixo" onClick={() => movePage(sel, false)}>
                  <ChevronDown size={16} />
                </button>
              </>
            ) : (
              <>
                <button type="button" className="icon-btn" title="Trazer para a frente" aria-label="Trazer para a frente" onClick={() => layer(sel, true)}>
                  <ArrowUpToLine size={16} />
                </button>
                <button type="button" className="icon-btn" title="Mandar para trás" aria-label="Mandar para trás" onClick={() => layer(sel, false)}>
                  <ArrowDownToLine size={16} />
                </button>
              </>
            )}
            <button type="button" className="icon-btn" title={isPage ? "Duplicar a página" : "Duplicar"} aria-label="Duplicar" onClick={() => duplicate(sel)}>
              <Copy size={15} />
            </button>
            <button type="button" className="icon-btn cedit-danger" title={isPage ? "Apagar a página" : "Apagar (Delete)"} aria-label="Apagar" onClick={() => remove(sel)}>
              <Trash2 size={15} />
            </button>
          </>
        ) : (
          <small className="cedit-hint">Clique num elemento para escolher; dois cliques para escrever. Arraste pela alça para mover.</small>
        )}
      </div>
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
                      <span key={k} className={`cedit-handle ${k}`} onPointerDown={drag(k)} />
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

function ImagePicker({ images, label, onPick }: { images: EditImage[]; label: string; onPick: (i: EditImage) => void }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="cedit-btn" disabled={!images.length} title={images.length ? undefined : "Sem imagens na conversa nem na Marca"}>
          <ImagePlus size={15} /> {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="status-menu cedit-pop" align="start" sideOffset={6}>
          <p className="cedit-pop-title">Imagens da conversa e da Marca</p>
          <div className="cedit-images">
            {images.map((i) => (
              <Popover.Close asChild key={i.token}>
                <button type="button" title={i.label} onClick={() => onPick(i)}>
                  <img src={i.url} alt={i.label} />
                </button>
              </Popover.Close>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** O tema do documento: as cores por função e as duas fontes. */
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
          <p className="cedit-pop-title">Cores e fontes do documento todo</p>
          <div className="cedit-theme">
            {(Object.keys(COLOR_LABELS) as (keyof IdentityColors)[]).map((k) => (
              <label key={k} className="cedit-color wide">
                <span>{COLOR_LABELS[k]}</span>
                <input
                  type="color"
                  value={look.colors[k]}
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

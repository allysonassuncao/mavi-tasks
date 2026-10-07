import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  LayoutTemplate,
  ListPlus,
  Plus,
  Redo2,
  Rows3,
  Trash2,
  Undo2,
  Columns3,
} from "lucide-react";
import { CANVAS_CSS, docBlocks, documentFromBlocks, slideHtml, type HtmlOptions } from "./mavi-doc-html";
import { blocksToMarkdown, type DocBlock } from "./mavi-export";
import { ImagePicker, ThemePicker, type EditImage, type ImageUpload } from "./CanvasDesignEditor";
import { SLIDE_LAYOUTS, type Canvas, type SheetTab, type Slide, type SlideLayout, type TableColumn } from "./mavi-artifacts";
import type { Look } from "./visual-identity";
import "./canvas-edit.css";

/**
 * Os editores do canvas com conteúdo estruturado: apresentação (o texto no
 * próprio slide, layout, imagem, tema, ordem dos slides), documento (o texto
 * no próprio documento, tipo de bloco, listas e tabelas) e planilha (células,
 * linhas, colunas). O texto que a pessoa digita fica no lugar enquanto ela
 * escreve; o desenho só se refaz quando muda a estrutura (um tópico novo, um
 * slide a mais), para o cursor não pular.
 */

export type StructuredHandle = { serialize: () => Canvas };

// ------------------------------------------------------------ texto ↔ Markdown
/** O texto de um campo de volta no formato da MAVI (negrito e itálico em Markdown). */
export function inlineFrom(el: Element): string {
  let out = "";
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) out += n.textContent ?? "";
    else if (n.nodeType === 1) {
      const e = n as HTMLElement;
      const inner = inlineFrom(e);
      const tag = e.tagName;
      const bold = tag === "STRONG" || tag === "B" || Number(e.style.fontWeight) >= 600;
      const italic = tag === "EM" || tag === "I" || e.style.fontStyle === "italic";
      if (tag === "BR") out += " ";
      else if (!inner.trim()) out += inner;
      else if (bold) out += `**${inner}**`;
      else if (italic) out += `*${inner}*`;
      else if (tag === "CODE") out += `\`${inner}\``;
      else out += inner;
    }
  });
  return out.replace(/ /g, " ").replace(/\s+/g, " ");
}

const PLACEHOLDERS = `[data-f]:empty::before,[data-b]:empty::before{content:attr(data-ph);opacity:.35;pointer-events:none}
[data-f],[data-b]{outline:none;border-radius:3px;transition:box-shadow .12s}
[data-f]:hover,[data-b]:hover{box-shadow:0 0 0 1px #4f7d2d55}
[data-f]:focus,[data-b]:focus{box-shadow:0 0 0 2px #2563eb}`;
const PH: Record<string, string> = {
  title: "Título",
  subtitle: "Subtítulo (opcional)",
  quote: "A citação",
  author: "Quem disse",
  left_title: "Título da coluna",
  right_title: "Título da coluna",
};

/**
 * O HTML num shadow DOM com os campos (data-f / data-b) editáveis. O texto
 * vai para `onText` a cada tecla; `onKey` decide Enter e Backspace.
 */
function EditableShadow({
  css,
  html,
  onText,
  onKey,
  onFocus,
  focus,
}: {
  css: string;
  html: string;
  onText: (path: string, value: string, el: HTMLElement) => void;
  onKey?: (path: string, e: KeyboardEvent, el: HTMLElement) => void;
  onFocus?: (path: string) => void;
  /** O campo para pôr o cursor depois de redesenhar. */
  focus?: { path: string; at: "end" | "start" } | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onText, onKey, onFocus });
  handlers.current = { onText, onKey, onFocus };
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block}${css}${PLACEHOLDERS}</style>${html}`;
    root.querySelectorAll<HTMLElement>("[data-f],[data-b]").forEach((f) => {
      if (f.tagName === "HR" || f.tagName === "TABLE") return;
      f.contentEditable = "true";
      f.spellcheck = true;
      const key = f.dataset.f ?? "";
      if (PH[key]) f.dataset.ph = PH[key];
      else if (f.dataset.b !== undefined) f.dataset.ph = "Escreva aqui";
    });
    if (focus) {
      const target = root.querySelector<HTMLElement>(`[data-f="${focus.path}"],[data-b="${focus.path}"]`);
      if (target) {
        target.focus();
        const r = document.createRange();
        r.selectNodeContents(target);
        r.collapse(focus.at === "start");
        const sel = (root as unknown as { getSelection?: () => Selection }).getSelection?.() ?? window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
    }
  }, [css, html, focus]);
  useEffect(() => {
    const el = host.current;
    const root = el?.shadowRoot;
    if (!root) return;
    const path = (t: EventTarget | null) => {
      const e = (t as HTMLElement | null)?.closest?.<HTMLElement>("[data-f],[data-b]");
      return e ? { e, p: e.dataset.f ?? e.dataset.b ?? "" } : null;
    };
    const input = (ev: Event) => {
      const x = path(ev.target);
      if (x) handlers.current.onText(x.p, inlineFrom(x.e), x.e);
    };
    const keydown = (ev: Event) => {
      const x = path(ev.target);
      if (x) handlers.current.onKey?.(x.p, ev as KeyboardEvent, x.e);
    };
    const focusin = (ev: Event) => {
      const x = path(ev.target);
      if (x) handlers.current.onFocus?.(x.p);
    };
    // Colar só o texto (sem a formatação de fora).
    const paste = (ev: Event) => {
      const e = ev as ClipboardEvent;
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      document.execCommand("insertText", false, text.replace(/\s*\n\s*/g, " "));
    };
    root.addEventListener("input", input);
    root.addEventListener("keydown", keydown);
    root.addEventListener("focusin", focusin);
    root.addEventListener("paste", paste);
    return () => {
      root.removeEventListener("input", input);
      root.removeEventListener("keydown", keydown);
      root.removeEventListener("focusin", focusin);
      root.removeEventListener("paste", paste);
    };
  }, []);
  return <div ref={host} />;
}

/** Desfazer e refazer pelo estado inteiro (cópias). */
function useHistory<T>(initial: T) {
  const [state, setState] = useState(initial);
  const h = useRef<{ list: string[]; at: number }>({ list: [JSON.stringify(initial)], at: 0 });
  const [, tick] = useState(0);
  const push = (next: T) => {
    const s = JSON.stringify(next);
    const cur = h.current;
    if (cur.list[cur.at] !== s) {
      cur.list = [...cur.list.slice(0, cur.at + 1), s].slice(-80);
      cur.at = cur.list.length - 1;
    }
    tick((n) => n + 1);
  };
  const go = (step: -1 | 1) => {
    const cur = h.current;
    const at = cur.at + step;
    if (at < 0 || at >= cur.list.length) return null;
    cur.at = at;
    const v = JSON.parse(cur.list[at]) as T;
    setState(v);
    tick((n) => n + 1);
    return v;
  };
  return { state, setState, push, go, canUndo: h.current.at > 0, canRedo: h.current.at < h.current.list.length - 1 };
}

const setPath = (obj: Record<string, unknown>, path: string, value: string) => {
  const keys = path.split(".");
  let cur: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = (cur as Record<string, unknown>)[k];
    (cur as Record<string, unknown>)[k] = Array.isArray(next) ? [...next] : { ...(next as object) };
    cur = (cur as Record<string, unknown>)[k] as Record<string, unknown>;
  }
  (cur as Record<string, unknown>)[keys[keys.length - 1]] = value;
};

function UndoButtons({ canUndo, canRedo, go }: { canUndo: boolean; canRedo: boolean; go: (s: -1 | 1) => void }) {
  return (
    <>
      <button type="button" className="icon-btn" title="Desfazer" aria-label="Desfazer" disabled={!canUndo} onClick={() => go(-1)}>
        <Undo2 size={16} />
      </button>
      <button type="button" className="icon-btn" title="Refazer" aria-label="Refazer" disabled={!canRedo} onClick={() => go(1)}>
        <Redo2 size={16} />
      </button>
    </>
  );
}

// ------------------------------------------------------------ apresentação
const LAYOUT_LABELS: Record<SlideLayout, string> = {
  title: "Capa",
  section: "Abertura de seção",
  bullets: "Tópicos",
  two_columns: "Duas colunas",
  stats: "Números",
  quote: "Citação",
  image: "Imagem",
  closing: "Encerramento",
};

export const SlidesEditor = forwardRef<
  StructuredHandle,
  {
    canvas: Extract<Canvas, { kind: "slides" }>;
    look: Look;
    options: HtmlOptions;
    images: EditImage[];
    onUpload?: ImageUpload;
    onDirty: () => void;
  }
>(function SlidesEditor({ canvas, look: initialLook, options, images, onUpload, onDirty }, ref) {
  const hist = useHistory({ slides: canvas.slides, look: initialLook });
  const { slides, look } = hist.state;
  // O texto que está sendo digitado (sem redesenhar).
  const live = useRef(hist.state);
  const [at, setAt] = useState(0);
  const [focus, setFocus] = useState<{ path: string; at: "end" | "start" } | null>(null);
  const i = Math.min(at, slides.length - 1);
  useImperativeHandle(ref, () => ({ serialize: () => ({ ...canvas, slides: live.current.slides, look: live.current.look }) }));

  const change = (next: { slides: Slide[]; look: Look }, f: typeof focus = null) => {
    live.current = next;
    hist.setState(next);
    hist.push(next);
    setFocus(f);
    onDirty();
  };
  const editSlide = (k: number, fn: (s: Slide) => Slide, f: typeof focus = null) =>
    change({ ...live.current, slides: live.current.slides.map((s, j) => (j === k ? fn(structuredClone(s)) : s)) }, f);
  const html = useMemo(() => slideHtml(slides[i], look, i, { ...options, marks: true }), [slides, i, look, options]);

  function onText(path: string, value: string) {
    const s = structuredClone(live.current.slides[i]) as unknown as Record<string, unknown>;
    setPath(s, path, value);
    live.current = { ...live.current, slides: live.current.slides.map((x, j) => (j === i ? (s as unknown as Slide) : x)) };
    onDirty();
  }
  function onKey(path: string, e: KeyboardEvent, el: HTMLElement) {
    const m = path.match(/^(bullets|left|right)\.(\d+)$/);
    if (e.key === "Enter") {
      e.preventDefault();
      if (!m) return el.blur();
      const [, key, n] = m;
      const idx = Number(n);
      editSlide(i, (s) => {
        const list = [...((s[key as "bullets"] as string[] | undefined) ?? [])];
        list.splice(idx + 1, 0, "");
        return { ...s, [key]: list };
      }, { path: `${key}.${idx + 1}`, at: "end" });
    }
    if (e.key === "Backspace" && m && !el.textContent) {
      e.preventDefault();
      const [, key, n] = m;
      const idx = Number(n);
      editSlide(i, (s) => {
        const list = [...((s[key as "bullets"] as string[] | undefined) ?? [])];
        list.splice(idx, 1);
        return { ...s, [key]: list };
      }, idx > 0 ? { path: `${key}.${idx - 1}`, at: "end" } : null);
    }
  }
  // O texto digitado entra no histórico quando sai do campo.
  const commitText = () => {
    hist.setState(live.current);
    hist.push(live.current);
  };
  const s = slides[i];
  const listKey: "bullets" | "left" | null = s.layout === "two_columns" ? "left" : ["bullets", "image"].includes(s.layout) ? "bullets" : null;
  return (
    <div className="cedit">
      <div className="cedit-bar wrap" role="toolbar" aria-label="Edição da apresentação">
        <UndoButtons canUndo={hist.canUndo} canRedo={hist.canRedo} go={(st) => { const v = hist.go(st); if (v) { live.current = v; setFocus(null); onDirty(); } }} />
        <span className="cedit-sep" />
        <label className="cedit-color">
          <LayoutTemplate size={14} aria-hidden="true" />
          <select
            className="cedit-inline-select"
            aria-label="Layout do slide"
            value={s.layout}
            onChange={(e) =>
              editSlide(i, (x) => {
                const layout = e.target.value as SlideLayout;
                const next: Slide = { ...x, layout };
                if (layout === "stats" && !next.stats?.length) next.stats = [{ value: "00", label: "rótulo" }];
                if (layout === "two_columns" && !next.left?.length) next.left = next.bullets?.slice(0, 3) ?? [""];
                if (layout === "two_columns" && !next.right?.length) next.right = [""];
                if (layout === "quote" && !next.quote) next.quote = x.title;
                return next;
              })
            }
          >
            {SLIDE_LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {LAYOUT_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
        {listKey && (
          <button
            type="button"
            className="cedit-btn"
            onClick={() => editSlide(i, (x) => ({ ...x, [listKey]: [...((x[listKey] as string[] | undefined) ?? []), ""] }), { path: `${listKey}.${(s[listKey] ?? []).length}`, at: "end" })}
          >
            <ListPlus size={15} /> Tópico
          </button>
        )}
        {s.layout === "two_columns" && (
          <button type="button" className="cedit-btn" onClick={() => editSlide(i, (x) => ({ ...x, right: [...(x.right ?? []), ""] }), { path: `right.${(s.right ?? []).length}`, at: "end" })}>
            <ListPlus size={15} /> Na direita
          </button>
        )}
        {s.layout === "stats" && (s.stats?.length ?? 0) < 4 && (
          <button type="button" className="cedit-btn" onClick={() => editSlide(i, (x) => ({ ...x, stats: [...(x.stats ?? []), { value: "00", label: "rótulo" }] }), { path: `stats.${(s.stats ?? []).length}.value`, at: "end" })}>
            <Plus size={15} /> Número
          </button>
        )}
        {s.layout === "stats" && (s.stats?.length ?? 0) > 1 && (
          <button type="button" className="cedit-btn" onClick={() => editSlide(i, (x) => ({ ...x, stats: (x.stats ?? []).slice(0, -1) }))}>
            <Trash2 size={14} /> Número
          </button>
        )}
        <ImagePicker
          images={images.filter((m) => m.token.startsWith("img:"))}
          label={s.layout === "image" ? "Trocar imagem" : "Imagem"}
          onUpload={onUpload}
          // Num slide sem imagem, a imagem muda o layout para "Imagem" (com os tópicos ao lado).
          onPick={(m) => editSlide(i, (x) => ({ ...x, layout: "image", image: m.token.slice(4) }))}
        />
        <ThemePicker look={look} onChange={(next) => change({ ...live.current, look: next })} />
        <span className="cedit-sep" />
        <button type="button" className="icon-btn" title="Slide para trás" aria-label="Slide para trás" disabled={i === 0} onClick={() => { const list = [...live.current.slides]; [list[i - 1], list[i]] = [list[i], list[i - 1]]; change({ ...live.current, slides: list }); setAt(i - 1); }}>
          <ArrowUp size={16} />
        </button>
        <button type="button" className="icon-btn" title="Slide para a frente" aria-label="Slide para a frente" disabled={i === slides.length - 1} onClick={() => { const list = [...live.current.slides]; [list[i + 1], list[i]] = [list[i], list[i + 1]]; change({ ...live.current, slides: list }); setAt(i + 1); }}>
          <ArrowDown size={16} />
        </button>
        <button type="button" className="icon-btn" title="Duplicar o slide" aria-label="Duplicar o slide" onClick={() => { const list = [...live.current.slides]; list.splice(i + 1, 0, structuredClone(list[i])); change({ ...live.current, slides: list }); setAt(i + 1); }}>
          <Copy size={15} />
        </button>
        <button type="button" className="icon-btn" title="Slide novo depois deste" aria-label="Slide novo" onClick={() => { const list = [...live.current.slides]; list.splice(i + 1, 0, { layout: "bullets", title: "Novo slide", bullets: [""] }); change({ ...live.current, slides: list }, { path: "title", at: "end" }); setAt(i + 1); }}>
          <Plus size={16} />
        </button>
        <button type="button" className="icon-btn cedit-danger" title="Apagar o slide" aria-label="Apagar o slide" disabled={slides.length <= 1} onClick={() => { const list = live.current.slides.filter((_, j) => j !== i); change({ ...live.current, slides: list }); setAt(Math.max(0, i - 1)); }}>
          <Trash2 size={15} />
        </button>
      </div>
      <div onBlur={commitText}>
        <EditableShadow
          css={`${CANVAS_CSS.slides}.s{border-radius:10px;box-shadow:0 10px 30px #1c272814}`}
          html={html}
          onText={onText}
          onKey={onKey}
          focus={focus}
        />
      </div>
      <label className="cedit-notes">
        <span>Notas do apresentador</span>
        <textarea
          rows={2}
          value={live.current.slides[i]?.notes ?? ""}
          placeholder="O que falar neste slide"
          onChange={(e) => editSlide(i, (x) => ({ ...x, notes: e.target.value }))}
        />
      </label>
      <ol className="cedit-thumbs" aria-label="Slides">
        {slides.map((x, k) => (
          <li key={k}>
            <button type="button" className={k === i ? "current" : ""} onClick={() => { commitText(); setAt(k); setFocus(null); }} aria-label={`Slide ${k + 1}: ${x.title}`}>
              <ThumbShadow html={slideHtml(x, look, k, options)} />
              <small>{k + 1}</small>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
});

function ThumbShadow({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block;pointer-events:none}${CANVAS_CSS.slides}.s{border-radius:4px}</style>${html}`;
  }, [html]);
  return <div ref={host} />;
}

// ------------------------------------------------------------ documento
type BlockKind = "h2" | "h3" | "p" | "ul" | "ol" | "quote";
const BLOCK_LABELS: Record<BlockKind, string> = {
  h2: "Título de seção",
  h3: "Subtítulo",
  p: "Texto",
  ul: "Lista",
  ol: "Lista numerada",
  quote: "Destaque",
};
const kindOf = (b: DocBlock): BlockKind | null =>
  b.kind === "heading" ? (b.level <= 2 ? "h2" : "h3") : b.kind === "paragraph" ? "p" : b.kind === "list" ? (b.ordered ? "ol" : "ul") : b.kind === "quote" ? "quote" : null;
const textOf = (b: DocBlock) => (b.kind === "list" ? b.items.join(" ") : "text" in b ? b.text : "");
function asKind(b: DocBlock, k: BlockKind): DocBlock {
  const text = textOf(b);
  if (k === "h2") return { kind: "heading", level: 2, text };
  if (k === "h3") return { kind: "heading", level: 3, text };
  if (k === "p") return { kind: "paragraph", text };
  if (k === "quote") return { kind: "quote", text };
  return { kind: "list", ordered: k === "ol", items: b.kind === "list" ? b.items : [text] };
}

export const DocumentEditor = forwardRef<
  StructuredHandle,
  { canvas: Extract<Canvas, { kind: "document" }>; look: Look; options: HtmlOptions; onDirty: () => void }
>(function DocumentEditor({ canvas, look: initialLook, options, onDirty }, ref) {
  const hist = useHistory({ title: canvas.title, blocks: docBlocks(canvas.title, canvas.markdown) as DocBlock[], look: initialLook });
  const live = useRef(hist.state);
  const [focus, setFocus] = useState<{ path: string; at: "end" | "start" } | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const { blocks, look, title } = hist.state;
  useImperativeHandle(ref, () => ({
    serialize: () => ({ ...canvas, title: live.current.title.trim() || canvas.title, markdown: blocksToMarkdown(live.current.blocks), look: live.current.look }),
  }));
  const html = useMemo(() => documentFromBlocks(title, blocks, look, { ...options, marks: true }), [title, blocks, look, options]);
  const change = (next: typeof live.current, f: typeof focus = null) => {
    live.current = next;
    hist.setState(next);
    hist.push(next);
    setFocus(f);
    onDirty();
  };
  const editBlocks = (fn: (b: DocBlock[]) => DocBlock[], f: typeof focus = null) =>
    change({ ...live.current, blocks: fn(structuredClone(live.current.blocks)) }, f);

  function onText(path: string, value: string) {
    if (path === "title") {
      live.current = { ...live.current, title: value };
      onDirty();
      return;
    }
    const next = structuredClone(live.current.blocks);
    const [n, a, b, c] = path.split(".");
    const blk = next[Number(n)];
    if (!blk) return;
    if (a === undefined && "text" in blk) (blk as { text: string }).text = value;
    else if (blk.kind === "list" && a !== undefined) blk.items[Number(a)] = value;
    else if (blk.kind === "table" && a === "h") blk.head[Number(b)] = value;
    else if (blk.kind === "table" && a === "r") {
      const row = [...(blk.rows[Number(b)] ?? [])];
      row[Number(c)] = value;
      blk.rows[Number(b)] = row;
    }
    live.current = { ...live.current, blocks: next };
    onDirty();
  }
  function onKey(path: string, e: KeyboardEvent, el: HTMLElement) {
    if (path === "title") {
      if (e.key === "Enter") {
        e.preventDefault();
        el.blur();
      }
      return;
    }
    const [n, a] = path.split(".");
    const idx = Number(n);
    const blk = live.current.blocks[idx];
    if (!blk || blk.kind === "table" || blk.kind === "code") {
      if (e.key === "Enter" && blk?.kind === "table") {
        e.preventDefault();
        el.blur();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (blk.kind === "list" && a !== undefined) {
        const k = Number(a);
        if (!el.textContent?.trim()) {
          // Item vazio + Enter: sai da lista para um texto.
          editBlocks((bs) => {
            const l = bs[idx] as Extract<DocBlock, { kind: "list" }>;
            l.items.splice(k, 1);
            bs.splice(idx + 1, 0, { kind: "paragraph", text: "" });
            return l.items.length ? bs : bs.filter((_, j) => j !== idx);
          }, { path: String(blk.items.length > 1 ? idx + 1 : idx), at: "end" });
          return;
        }
        editBlocks((bs) => {
          (bs[idx] as Extract<DocBlock, { kind: "list" }>).items.splice(k + 1, 0, "");
          return bs;
        }, { path: `${idx}.${k + 1}`, at: "end" });
        return;
      }
      editBlocks((bs) => {
        bs.splice(idx + 1, 0, { kind: "paragraph", text: "" });
        return bs;
      }, { path: String(idx + 1), at: "end" });
    }
    if (e.key === "Backspace" && !el.textContent) {
      e.preventDefault();
      if (blk.kind === "list" && a !== undefined) {
        const k = Number(a);
        editBlocks((bs) => {
          const l = bs[idx] as Extract<DocBlock, { kind: "list" }>;
          l.items.splice(k, 1);
          return l.items.length ? bs : bs.filter((_, j) => j !== idx);
        }, k > 0 ? { path: `${idx}.${k - 1}`, at: "end" } : idx > 0 ? { path: String(idx - 1), at: "end" } : null);
        return;
      }
      if (live.current.blocks.length > 1) editBlocks((bs) => bs.filter((_, j) => j !== idx), idx > 0 ? { path: String(idx - 1), at: "end" } : null);
    }
  }
  const commitText = () => {
    hist.setState(live.current);
    hist.push(live.current);
  };
  const cur = current !== null ? blocks[current] : undefined;
  const curKind = cur ? kindOf(cur) : null;
  return (
    <div className="cedit">
      <div className="cedit-bar wrap" role="toolbar" aria-label="Edição do documento">
        <UndoButtons canUndo={hist.canUndo} canRedo={hist.canRedo} go={(st) => { const v = hist.go(st); if (v) { live.current = v; setFocus(null); onDirty(); } }} />
        <span className="cedit-sep" />
        <label className="cedit-color">
          <span>Bloco</span>
          <select
            className="cedit-inline-select"
            aria-label="Tipo do bloco"
            disabled={curKind === null}
            value={curKind ?? "p"}
            onChange={(e) => current !== null && editBlocks((bs) => bs.map((b, j) => (j === current ? asKind(b, e.target.value as BlockKind) : b)), { path: String(current), at: "end" })}
          >
            {(Object.keys(BLOCK_LABELS) as BlockKind[]).map((k) => (
              <option key={k} value={k}>
                {BLOCK_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="cedit-btn"
          onClick={() => {
            const at = current ?? live.current.blocks.length - 1;
            editBlocks((bs) => {
              bs.splice(at + 1, 0, { kind: "paragraph", text: "" });
              return bs;
            }, { path: String(at + 1), at: "end" });
          }}
        >
          <Plus size={15} /> Parágrafo
        </button>
        <button
          type="button"
          className="cedit-btn"
          onClick={() => {
            const at = current ?? live.current.blocks.length - 1;
            editBlocks((bs) => {
              bs.splice(at + 1, 0, { kind: "table", head: ["Coluna", "Coluna"], rows: [["", ""]] });
              return bs;
            }, { path: `${at + 1}.h.0`, at: "end" });
          }}
        >
          <Rows3 size={15} /> Tabela
        </button>
        {/* Sempre na barra (desligados fora de uma tabela): a altura não muda ao clicar. */}
        <button type="button" className="cedit-btn" disabled={cur?.kind !== "table"} title="Linha na tabela" onClick={() => editBlocks((bs) => { const t = bs[current!] as Extract<DocBlock, { kind: "table" }>; t.rows.push(t.head.map(() => "")); return bs; })}>
          <Plus size={14} /> Linha
        </button>
        <button type="button" className="cedit-btn" disabled={cur?.kind !== "table"} title="Coluna na tabela" onClick={() => editBlocks((bs) => { const t = bs[current!] as Extract<DocBlock, { kind: "table" }>; t.head.push("Coluna"); t.rows = t.rows.map((r) => [...r, ""]); return bs; })}>
          <Columns3 size={14} /> Coluna
        </button>
        <button type="button" className="cedit-btn" disabled={cur?.kind !== "table" || cur.rows.length <= 1} title="Tirar a última linha da tabela" onClick={() => editBlocks((bs) => { (bs[current!] as Extract<DocBlock, { kind: "table" }>).rows.pop(); return bs; })}>
          <Trash2 size={13} /> Linha
        </button>
        <button
          type="button"
          className="icon-btn cedit-danger"
          title="Apagar o bloco"
          aria-label="Apagar o bloco"
          disabled={current === null || blocks.length <= 1}
          onClick={() => { editBlocks((bs) => bs.filter((_, j) => j !== current)); setCurrent(null); }}
        >
          <Trash2 size={15} />
        </button>
        <span className="cedit-sep" />
        <ThemePicker look={look} onChange={(next) => change({ ...live.current, look: next })} />
      </div>
      <div onBlur={commitText}>
        <EditableShadow
          css={`${CANVAS_CSS.document}.doc{max-width:820px;margin:0 auto;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px #1c272814}`}
          html={html}
          onText={onText}
          onKey={onKey}
          onFocus={(p) => setCurrent(p === "title" ? null : Number(p.split(".")[0]))}
          focus={focus}
        />
      </div>
    </div>
  );
});

// ------------------------------------------------------------ planilha
const UNITS: { value: NonNullable<TableColumn["unit"]> | "text"; label: string }[] = [
  { value: "text", label: "Texto" },
  { value: "number", label: "Número" },
  { value: "money", label: "R$" },
  { value: "percent", label: "%" },
  { value: "hours", label: "Horas" },
  { value: "days", label: "Dias" },
];

export const SheetEditor = forwardRef<StructuredHandle, { canvas: Extract<Canvas, { kind: "sheet" }>; onDirty: () => void }>(
  function SheetEditor({ canvas, onDirty }, ref) {
    const hist = useHistory(canvas.sheets);
    const sheets = hist.state;
    const [tab, setTab] = useState(0);
    const t = sheets[Math.min(tab, sheets.length - 1)];
    useImperativeHandle(ref, () => ({ serialize: () => ({ ...canvas, sheets: hist.state }) }));
    const change = (fn: (s: SheetTab) => SheetTab, record = true) => {
      const next = sheets.map((s, k) => (k === tab ? fn(structuredClone(s)) : s));
      hist.setState(next);
      if (record) hist.push(next);
      onDirty();
    };
    const cellValue = (v: string, unit?: string) => {
      if (!unit || unit === "text") return v;
      const n = Number(v.replace(/\./g, "").replace(",", "."));
      return v.trim() === "" ? null : Number.isFinite(n) ? n : v;
    };
    return (
      <div className="cedit">
        <div className="cedit-bar wrap" role="toolbar" aria-label="Edição da planilha">
          <UndoButtons canUndo={hist.canUndo} canRedo={hist.canRedo} go={(st) => { hist.go(st); onDirty(); }} />
          <span className="cedit-sep" />
          <button type="button" className="cedit-btn" onClick={() => change((s) => ({ ...s, rows: [...s.rows, s.columns.map(() => null)] }))}>
            <Plus size={14} /> Linha
          </button>
          <button type="button" className="cedit-btn" onClick={() => change((s) => ({ ...s, columns: [...s.columns, { label: `Coluna ${s.columns.length + 1}` }], rows: s.rows.map((r) => [...r, null]) }))}>
            <Columns3 size={14} /> Coluna
          </button>
          <button type="button" className="cedit-btn" onClick={() => { hist.setState([...sheets, { name: `Aba ${sheets.length + 1}`, columns: [{ label: "Coluna 1" }], rows: [[null]] }]); hist.push([...sheets, { name: `Aba ${sheets.length + 1}`, columns: [{ label: "Coluna 1" }], rows: [[null]] }]); setTab(sheets.length); onDirty(); }}>
            <Plus size={14} /> Aba
          </button>
          {sheets.length > 1 && (
            <button type="button" className="cedit-btn cedit-danger" onClick={() => { const next = sheets.filter((_, k) => k !== tab); hist.setState(next); hist.push(next); setTab(0); onDirty(); }}>
              <Trash2 size={13} /> Aba
            </button>
          )}
        </div>
        {sheets.length > 1 && (
          <div className="drive-view canvas-tabs" role="tablist">
            {sheets.map((s, k) => (
              <button key={k} type="button" role="tab" aria-selected={k === tab} className={k === tab ? "selected" : ""} onClick={() => setTab(k)}>
                {s.name}
              </button>
            ))}
          </div>
        )}
        <label className="cedit-sheet-name">
          <span>Nome da aba</span>
          <input value={t.name} maxLength={31} onChange={(e) => change((s) => ({ ...s, name: e.target.value.replace(/[\\/?*[\]:]/g, " ") }), false)} onBlur={() => hist.push(hist.state)} />
        </label>
        <div className="mavi-table-wrap canvas-table">
          <table className="mavi-table cedit-sheet">
            <thead>
              <tr>
                <th className="canvas-rownum" aria-hidden="true" />
                {t.columns.map((c, k) => (
                  <th key={k}>
                    <input aria-label={`Nome da coluna ${k + 1}`} value={c.label} onChange={(e) => change((s) => { s.columns[k] = { ...s.columns[k], label: e.target.value }; return s; }, false)} onBlur={() => hist.push(hist.state)} />
                    <span className="cedit-col-tools">
                      <select aria-label="Tipo da coluna" value={c.unit ?? "text"} onChange={(e) => change((s) => { s.columns[k] = { ...s.columns[k], unit: e.target.value === "text" ? undefined : (e.target.value as TableColumn["unit"]) }; return s; })}>
                        {UNITS.map((u) => (
                          <option key={u.value} value={u.value}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                      {t.columns.length > 1 && (
                        <button type="button" className="icon-btn" title="Apagar a coluna" aria-label={`Apagar a coluna ${c.label}`} onClick={() => change((s) => ({ ...s, columns: s.columns.filter((_, j) => j !== k), rows: s.rows.map((r) => r.filter((_, j) => j !== k)) }))}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r, ri) => (
                <tr key={ri}>
                  <td className="canvas-rownum">
                    <span>{ri + 2}</span>
                    <button type="button" className="icon-btn cedit-row-del" title="Apagar a linha" aria-label={`Apagar a linha ${ri + 2}`} onClick={() => change((s) => ({ ...s, rows: s.rows.filter((_, j) => j !== ri) }))}>
                      <Trash2 size={11} />
                    </button>
                  </td>
                  {t.columns.map((c, k) => (
                    <td key={k} className={c.unit && c.unit !== "text" ? "num" : ""}>
                      <input
                        aria-label={`${c.label}, linha ${ri + 2}`}
                        value={r[k] === null || r[k] === undefined ? "" : typeof r[k] === "number" ? String(r[k]).replace(".", ",") : String(r[k])}
                        // Enquanto digita fica como texto (para a vírgula entrar); ao sair, vira número.
                        onChange={(e) => change((s) => { const row = [...s.rows[ri]]; row[k] = e.target.value; s.rows[ri] = row; return s; }, false)}
                        onBlur={(e) => change((s) => { const row = [...s.rows[ri]]; row[k] = cellValue(e.target.value, c.unit) as string | number | null; s.rows[ri] = row; return s; })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
);

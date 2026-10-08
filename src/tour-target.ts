import { fold } from "./domain";

/**
 * Onboarding: how a step remembers the element it points at and finds it
 * again on someone else's screen. The app has no fixed markers on its
 * elements, so a step keeps several "fingerprints" (data-tour, a stable id,
 * the text, the label, the CSS path, the panel or modal it sits in, the
 * position) and the player scores every candidate on the screen against
 * them. A `data-tour="…"` attribute, where present, wins outright.
 */

export interface TourTarget {
  tag: string;
  /** data-tour (fixed marker). */
  tour: string | null;
  /** The element's id, when it does not look generated. */
  id: string | null;
  role: string | null;
  /** aria-label, title, placeholder, name, alt or the field's <label>. */
  label: string | null;
  /** Its visible text (empty when long: a table, a whole panel). */
  text: string;
  classes: string[];
  /** CSS path from the nearest fixed point (dialog, id, data-tour). */
  path: string;
  /** The modal's or panel's title around it. */
  context: string;
  dialog: boolean;
  /** Among the elements with the same tag, text and label, which one. */
  nth: number;
  /** Where it was, in viewport fractions (a tie-breaker). */
  box: { x: number; y: number; w: number; h: number };
}

/** The layer's own elements (bar, balloons) are never picked or scored. */
export const TOUR_UI_ATTR = "data-tour-ui";

const INTERACTIVE =
  "button, a[href], input, select, textarea, summary, label, [role=button], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=radio], [role=combobox], [role=link]";
const INLINE = new Set(["SPAN", "I", "B", "STRONG", "EM", "SMALL", "IMG", "SVG", "PATH", "G", "USE", "CIRCLE", "RECT", "LINE", "POLYLINE", "POLYGON", "KBD", "ABBR"]);
const STATE_CLASS =
  /^(is-|has-)|(^|-)(active|selected|open|opened|closed|hover|focus|focused|disabled|loading|collapsed|expanded|pulse|current|checked|on|off|dragging|over|visible|hidden|show|shown|error|dirty|busy|new)$/;
const MAX_TEXT = 120;

const clean = (s: string | null | undefined) =>
  (s ?? "").replace(/\s+/g, " ").trim();
export const sameText = (a: string, b: string) =>
  !!a && !!b && fold(clean(a)) === fold(clean(b));

/** A useful id: not React's (:r1:), not a uuid, not numbered. */
export function stableId(id: string | null | undefined) {
  if (!id || id.length > 48) return null;
  if (/[:\s]/.test(id) || /\d{3,}/.test(id) || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return null;
  return /^[a-zA-Z][\w-]+$/.test(id) ? id : null;
}
export function stableClasses(list: Iterable<string>) {
  const out: string[] = [];
  for (const c of list) {
    if (out.length >= 4) break;
    if (c.length > 40 || /\d{3,}/.test(c) || STATE_CLASS.test(c) || c.startsWith("tour-")) continue;
    out.push(c);
  }
  return out;
}

export function isTourUi(el: Element | null) {
  return !!el?.closest(`[${TOUR_UI_ATTR}]`);
}
/** The modal on top (showModal): what is outside it can't be used. */
export function topModal(): HTMLElement | null {
  const open = [...document.querySelectorAll("dialog[open]")].filter((d) => {
    try {
      return d.matches(":modal");
    } catch {
      return false;
    }
  });
  return (open[open.length - 1] as HTMLElement | undefined) ?? null;
}
export function isVisible(el: Element) {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.02;
}

/**
 * What a click on `el` means: an icon or a word inside a button is the
 * button; an svg piece is its box.
 */
export function pickable(el: Element | null): HTMLElement | null {
  if (!el || isTourUi(el)) return null;
  const hit = el.closest(INTERACTIVE);
  if (hit instanceof HTMLElement && !isTourUi(hit)) return hit;
  let cur: Element | null = el;
  while (cur && (INLINE.has(cur.tagName.toUpperCase()) || !(cur instanceof HTMLElement))) {
    const up: Element | null = cur.parentElement;
    if (!up || up === document.body) break;
    cur = up;
  }
  return cur instanceof HTMLElement && cur !== document.body && cur !== document.documentElement ? cur : null;
}

/** The bigger element around (the "Elemento maior" button). */
export function parentPick(el: HTMLElement): HTMLElement | null {
  let up = el.parentElement;
  while (up && up !== document.body) {
    if (isTourUi(up)) return null;
    const a = up.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    // Skips wrappers of the very same size.
    if (Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) return up;
    up = up.parentElement;
  }
  return null;
}

function labelOf(el: HTMLElement) {
  const direct =
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.getAttribute("placeholder") ||
    el.getAttribute("alt") ||
    "";
  if (direct) return clean(direct).slice(0, 80);
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = by
      .split(/\s+/)
      .map((id) => {
        const n = document.getElementById(id);
        return n ? ownText(n) : "";
      })
      .join(" ");
    if (clean(t)) return clean(t).slice(0, 80);
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels?.length) {
    const t = ownText(labels[0]);
    if (t) return t.slice(0, 80);
  }
  const name = el.getAttribute("name");
  return name ? name.slice(0, 80) : null;
}

/** A label's own words, without the field (and its options) inside it. */
function ownText(label: Element) {
  const copy = label.cloneNode(true) as Element;
  copy
    .querySelectorAll("input, select, textarea, button, [role=combobox], [role=listbox], ul, ol, [hidden]")
    .forEach((n) => n.remove());
  return clean(copy.textContent);
}

/** A field: what shows inside is someone's value, not what identifies it. */
const isField = (el: Element) =>
  /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
  el.getAttribute("role") === "combobox" ||
  el.getAttribute("aria-haspopup") === "listbox" ||
  (el as HTMLElement).isContentEditable;

/** Visible text, without what people type (fields keep only the label). */
export function textOf(el: Element) {
  if (isField(el)) return "";
  const t = clean((el as HTMLElement).innerText ?? el.textContent);
  return t.length > MAX_TEXT ? "" : t;
}

function contextOf(el: HTMLElement) {
  const dialog = el.closest("dialog");
  if (dialog) {
    const t = dialog.getAttribute("aria-label") || dialog.querySelector("h1, h2, h3")?.textContent;
    return clean(t).slice(0, 80);
  }
  const box = el.closest("section, aside, nav, header, [role=region], [role=dialog], .panel, .section-layout-main, main");
  if (!box) return "";
  const t =
    box.getAttribute("aria-label") ||
    box.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > header h1, :scope > header h2, :scope > div > h2")?.textContent;
  return clean(t).slice(0, 80);
}

const esc = (v: string) =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");

function segment(el: Element): { text: string; anchor: boolean } {
  const tag = el.tagName.toLowerCase();
  const tour = el.getAttribute("data-tour");
  if (tour) return { text: `[data-tour="${esc(tour)}"]`, anchor: true };
  const id = stableId(el.id);
  if (id) return { text: `#${esc(id)}`, anchor: true };
  if (tag === "dialog") return { text: "dialog[open]", anchor: true };
  const classes = stableClasses(el.classList).slice(0, 2);
  let s = tag + classes.map((c) => `.${esc(c)}`).join("");
  const parent = el.parentElement;
  if (parent) {
    const same = [...parent.children].filter((c) => c.tagName === el.tagName);
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return { text: s, anchor: false };
}

/** A CSS path from the nearest fixed point (or the page body), 8 levels at most. */
export function cssPath(el: Element) {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 8) {
    const s = segment(cur);
    parts.unshift(s.text);
    if (s.anchor) break;
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}
/** The path without positions, to compare the shape of two paths. */
export const pathShape = (path: string, last = 3) =>
  path
    .split(" > ")
    .slice(-last)
    .map((p) => p.replace(/:nth-of-type\(\d+\)/g, ""))
    .join(" > ");

function signatureMatch(a: Element, tag: string, text: string, label: string | null) {
  if (a.tagName.toLowerCase() !== tag) return false;
  const h = a as HTMLElement;
  return clean(textOf(h)) === text && (labelOf(h) ?? null) === label;
}

export function captureTarget(el: HTMLElement): TourTarget {
  const tag = el.tagName.toLowerCase();
  const text = textOf(el);
  const label = labelOf(el);
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  let nth = 0;
  if (text || label) {
    const same = [...document.querySelectorAll(tag)].filter(
      (c) => !isTourUi(c) && signatureMatch(c, tag, text, label),
    );
    nth = Math.max(0, same.indexOf(el));
  }
  return {
    tag,
    tour: el.getAttribute("data-tour"),
    id: stableId(el.id),
    role: el.getAttribute("role"),
    label,
    text,
    classes: stableClasses(el.classList),
    path: cssPath(el),
    context: contextOf(el),
    dialog: !!el.closest("dialog"),
    nth,
    box: {
      x: round(r.left / vw),
      y: round(r.top / vh),
      w: round(r.width / vw),
      h: round(r.height / vh),
    },
  };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

/** What the player knows about one candidate on the screen. */
export interface Candidate {
  text: string;
  label: string | null;
  role: string | null;
  classes: string[];
  dialog: boolean;
  context: string;
  /** Matches the step's CSS path exactly. */
  pathMatch: boolean;
  /** The last levels of its path have the same shape. */
  shapeMatch: boolean;
  /** Its order among the same tag + text + label. */
  nth: number;
  box: { x: number; y: number; w: number; h: number };
}

/** The most a candidate could score against this target. */
export function maxScore(t: TourTarget) {
  return (
    (t.text ? 6 : 0) +
    (t.label ? 5 : 0) +
    (t.role ? 1 : 0) +
    Math.min(t.classes.length, 3) +
    2 + // dialog
    (t.context ? 3 : 0) +
    4 + // path
    2 + // shape
    1.5 + // nth
    2 // position
  );
}

/** How much a candidate looks like the recorded element. */
export function scoreCandidate(t: TourTarget, c: Candidate) {
  let s = 0;
  if (t.text) {
    if (sameText(t.text, c.text)) s += 6;
    else if (c.text && fold(c.text).startsWith(fold(t.text).slice(0, 12))) s += 2;
    else s -= 3;
  }
  if (t.label) {
    if (c.label && sameText(t.label, c.label)) s += 5;
    else s -= 1;
  }
  if (t.role && t.role === c.role) s += 1;
  s += Math.min(3, t.classes.filter((x) => c.classes.includes(x)).length);
  s += t.dialog === c.dialog ? 2 : -4;
  if (t.context && sameText(t.context, c.context)) s += 3;
  if (c.pathMatch) s += 4;
  if (c.shapeMatch) s += 2;
  if ((t.text || t.label) && c.nth === t.nth) s += 1.5;
  const dx = t.box.x + t.box.w / 2 - (c.box.x + c.box.w / 2);
  const dy = t.box.y + t.box.h / 2 - (c.box.y + c.box.h / 2);
  s += 2 * (1 - Math.min(1, Math.hypot(dx, dy) / 0.5));
  return s;
}
/** The least score that counts as "found". */
export const threshold = (t: TourTarget) => Math.min(9, maxScore(t) * 0.45);

/** The element of a step on this screen (null: not here). */
export function findTarget(t: TourTarget, root: ParentNode = document): HTMLElement | null {
  const modal = topModal();
  const usable = (el: Element | null): el is HTMLElement =>
    el instanceof HTMLElement &&
    !isTourUi(el) &&
    (!modal || modal.contains(el)) &&
    !el.closest("[inert]") &&
    isVisible(el);
  if (t.tour) {
    const el = root.querySelector(`[data-tour="${esc(t.tour)}"]`);
    if (usable(el)) return el;
  }
  if (t.id) {
    const el = document.getElementById(t.id);
    if (usable(el) && el.tagName.toLowerCase() === t.tag) return el;
  }
  let byPath: HTMLElement[] = [];
  try {
    byPath = [...root.querySelectorAll(t.path)].filter(usable);
  } catch {
    byPath = [];
  }
  if (byPath.length === 1 && byPath[0].tagName.toLowerCase() === t.tag) {
    const only = byPath[0];
    // The same place with other text (another record) still counts when the
    // text is not what identifies it.
    if (!t.text || sameText(t.text, textOf(only)) || !t.label) return only;
  }
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const all = [...root.querySelectorAll(t.tag)].filter(usable).slice(0, 4000);
  const shape = pathShape(t.path);
  const order = new Map<string, number>();
  let best: HTMLElement | null = null;
  let bestScore = -Infinity;
  for (const el of all) {
    const text = textOf(el);
    const label = labelOf(el);
    const key = `${text}\u0000${label ?? ""}`;
    const nth = order.get(key) ?? 0;
    order.set(key, nth + 1);
    const r = el.getBoundingClientRect();
    const score = scoreCandidate(t, {
      text,
      label,
      role: el.getAttribute("role"),
      classes: stableClasses(el.classList),
      dialog: !!el.closest("dialog"),
      context: contextOf(el),
      pathMatch: byPath.includes(el),
      shapeMatch: pathShape(cssPath(el)) === shape,
      nth,
      box: { x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh },
    });
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best && bestScore >= threshold(t) ? best : null;
}

const TAG_NAMES: Record<string, string> = {
  button: "Botão",
  a: "Link",
  input: "Campo",
  textarea: "Campo de texto",
  select: "Lista",
  table: "Tabela",
  tr: "Linha da tabela",
  td: "Célula",
  th: "Coluna",
  img: "Imagem",
  svg: "Ícone",
  dialog: "Janela",
  nav: "Menu",
  aside: "Painel lateral",
  header: "Topo",
  section: "Seção",
  form: "Formulário",
  label: "Rótulo",
  li: "Item",
  ul: "Lista",
  h1: "Título",
  h2: "Título",
  h3: "Título",
};
/** "Botão “Nova tarefa”" — how the editor names an element. */
export function describeTarget(t: Pick<TourTarget, "tag" | "role" | "text" | "label">) {
  const kind =
    t.role === "tab"
      ? "Aba"
      : t.role === "menuitem"
        ? "Item do menu"
        : t.role === "combobox"
          ? "Lista"
          : (TAG_NAMES[t.tag] ?? "Elemento");
  const name = t.label || t.text;
  return name ? `${kind} “${name.length > 40 ? `${name.slice(0, 40)}…` : name}”` : kind;
}

/** Destructive buttons: a step never clicks them by itself nor waits on them. */
export const looksDestructive = (t: Pick<TourTarget, "text" | "label">) =>
  /\b(excluir|apagar|remover|deletar|delete|remove)\b/i.test(`${t.text} ${t.label ?? ""}`);

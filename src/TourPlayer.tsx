import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  MousePointerClick,
  SearchX,
  TextCursorInput,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { RichTextContent } from "./RichTextContent";
import { VOTE_REASONS, type VoteReason } from "./tutorials";
import { navigate } from "./router";
import { TOUR_UI_ATTR, findTarget, looksDestructive, topModal, type TourTarget } from "./tour-target";
import {
  currentScreen,
  onStepScreen,
  stepInRecord,
  placeBalloon,
  stepHref,
  type Box,
  type TourStep,
} from "./tours";
import "./tours.css";

/**
 * The layer's pieces on screen. Modals open with showModal() and make the
 * rest of the page inert (a popover above them doesn't take clicks either),
 * so everything here renders inside the topmost open modal when there is
 * one, and in the page body otherwise.
 */
const topHost = () => topModal() ?? document.body;
export function useTourHost() {
  const [host, setHost] = useState<HTMLElement>(() => topHost());
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setHost(topHost()));
    };
    update();
    const obs = new MutationObserver((changes) => {
      if (
        changes.some(
          (c) =>
            c.target instanceof HTMLDialogElement ||
            [...c.addedNodes, ...c.removedNodes].some(
              (n) => n instanceof HTMLDialogElement || (n instanceof Element && !!n.querySelector("dialog")),
            ),
        )
      )
        update();
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return host;
}

export function TourPortal({ children }: { children: ReactNode }) {
  const host = useTourHost();
  useEffect(() => {
    document.documentElement.classList.add("tour-active");
    return () => document.documentElement.classList.remove("tour-active");
  }, []);
  return createPortal(
    <div className="tour-root" {...{ [TOUR_UI_ATTR]: "" }}>
      {children}
    </div>,
    host,
  );
}

/** Where an element is, frame by frame (it scrolls, moves, animates). */
export function useBox(el: HTMLElement | null, onLost?: () => void): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  const lost = useRef(onLost);
  lost.current = onLost;
  useEffect(() => {
    if (!el) {
      setBox(null);
      return;
    }
    let raf = 0;
    let last = "";
    const tick = () => {
      if (!el.isConnected) {
        setBox(null);
        lost.current?.();
        return;
      }
      const r = el.getBoundingClientRect();
      const b = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      const key = `${b.left},${b.top},${b.width},${b.height}`;
      if (key !== last) {
        last = key;
        setBox(b.width || b.height ? b : null);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [el]);
  return box;
}

export function useViewport() {
  const [view, setView] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const on = () => setView({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return view;
}

/**
 * Looks for a step's element on the screen for up to `wait` ms (the screen
 * may still be loading or animating). `missing` turns true when it gives up.
 */
export function useStepElement(
  target: TourTarget | null,
  active: boolean,
  key: unknown,
  wait = 5000,
  anyRecord = false,
) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setEl(null);
    setMissing(false);
    if (!active || !target) return;
    const started = Date.now();
    let done = false;
    const look = () => {
      if (done) return;
      const found = findTarget(target, { anyRecord });
      if (found) {
        done = true;
        setEl(found);
        const r = found.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth)
          found.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        return;
      }
      if (Date.now() - started > wait) {
        done = true;
        setMissing(true);
      }
    };
    look();
    const timer = window.setInterval(look, 250);
    return () => {
      done = true;
      window.clearInterval(timer);
    };
  }, [target, active, key, retry, wait, anyRecord]);
  // The page redrew the element (a new node): look again.
  const relook = useCallback(() => setRetry((n) => n + 1), []);
  return { el, missing, relook };
}

/** The dimmed screen with a hole on the element; `block` stops clicks outside it. */
export function Spotlight({
  box,
  block,
  dim = true,
  moving = false,
}: {
  box: Box | null;
  block: boolean;
  dim?: boolean;
  /** Between steps: the light slides from one element to the next. */
  moving?: boolean;
}) {
  const pad = 6;
  const view = useViewport();
  if (!box && !dim) return null;
  // Always the same piece: without an element the hole closes in the middle
  // of the screen (all dark), so changing steps never flashes.
  const hole = box
    ? { left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 }
    : { left: view.width / 2, top: view.height / 2, width: 0, height: 0 };
  const ring = (
    <div
      key="ring"
      className={`tour-ring ${dim ? "dim" : ""} ${box ? "" : "closed"} ${moving ? "moving" : ""}`}
      style={hole}
    />
  );
  if (!box) return block ? [ring, <div key="all" className="tour-blocker" style={{ inset: 0 }} />] : ring;
  const bars: CSSProperties[] = [
    { left: 0, top: 0, right: 0, height: Math.max(0, hole.top) },
    { left: 0, top: hole.top + hole.height, right: 0, bottom: 0 },
    { left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height },
    { left: hole.left + hole.width, top: hole.top, right: 0, height: hole.height },
  ];
  return [ring, ...(block ? bars.map((s, i) => <div key={i} className="tour-blocker" style={s} />) : [])];
}

/** A balloon beside a box (or in the middle of the screen). */
export function Balloon({
  box,
  placement,
  children,
  className = "",
  label,
}: {
  box: Box | null;
  placement: TourStep["placement"];
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const view = useViewport();
  const [size, setSize] = useState({ width: 340, height: 180 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) =>
        Math.abs(s.width - r.width) > 1 || Math.abs(s.height - r.height) > 1
          ? { width: r.width, height: r.height }
          : s,
      );
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const pos = placeBalloon(box, size, placement, view);
  // The arrow points at the middle of the element.
  let arrow: CSSProperties | undefined;
  if (box && pos.side !== "center") {
    if (pos.side === "top" || pos.side === "bottom")
      arrow = { left: Math.max(18, Math.min(size.width - 18, box.left + box.width / 2 - pos.left)) };
    else arrow = { top: Math.max(18, Math.min(size.height - 18, box.top + box.height / 2 - pos.top)) };
  }
  return (
    <div
      ref={ref}
      className={`tour-balloon side-${pos.side} ${className}`}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={label}
    >
      {arrow && <span className="tour-arrow" style={arrow} aria-hidden="true" />}
      {children}
    </div>
  );
}

/** Clicks like a person does (menus open on pointerdown). */
export function pressElement(el: HTMLElement) {
  const base = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, view: window };
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    el.focus();
    return;
  }
  el.dispatchEvent(new PointerEvent("pointerdown", pointer));
  el.dispatchEvent(new MouseEvent("mousedown", base));
  el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
  el.click();
}

const hasText = (s: TourStep) => !!s.title || /"text"/.test(s.body);

/**
 * Whether the person is on the step's screen: any record of the kind
 * counts, unless the step is about the recorded one.
 */
function onScreen(step: TourStep) {
  const current = currentScreen();
  if (step.record === "same" && stepInRecord(step))
    return current.split(/[?#]/)[0] === step.url.split(/[?#]/)[0] && onStepScreen(current, step.url);
  return onStepScreen(current, step.url);
}

/**
 * Plays a tour: goes to each step's screen, finds its element, dims around
 * it and shows the balloon. `test`: the editor trying its own steps (no
 * progress, no "not found" records).
 */
export function TourPlayer({
  title,
  steps,
  start,
  companyPath,
  test = false,
  onStep,
  onFinish,
  onClose,
  onMiss,
}: {
  title: string;
  steps: TourStep[];
  start: number;
  companyPath: string;
  test?: boolean;
  onStep?: (index: number, step: TourStep) => void;
  onFinish: () => void;
  onClose: (index: number, step: TourStep | undefined) => void;
  onMiss?: (step: TourStep) => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, steps.length - 1)));
  const step = steps[index] as TourStep | undefined;
  const navigated = useRef(-1);
  const [ready, setReady] = useState(false);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const missLogged = useRef(new Set<string>());

  // 1) The step's screen: opens it when the person is elsewhere (and lets
  // it draw before looking). On the same screen it looks right away.
  useEffect(() => {
    setFilled(false);
    setBusy(false);
    if (!step) return;
    if (!onScreen(step) && navigated.current !== index) {
      navigated.current = index;
      setReady(false);
      navigate(stepHref(step.url, companyPath));
      const t = window.setTimeout(() => setReady(true), 120);
      return () => window.clearTimeout(t);
    }
    setReady(true);
  }, [index, step, companyPath]);

  // 2) Its element.
  const anyRecord = !!step && step.record !== "same";
  const { el, missing, relook } = useStepElement(step?.target ?? null, ready, index, 5000, anyRecord);
  const box = useBox(el, relook);
  // Between steps the light keeps the last element until it finds the new
  // one and slides there (no flash of a fully dark screen); only a slow
  // search (another screen loading) moves the balloon to the middle.
  const lastBox = useRef<Box | null>(null);
  if (box) lastBox.current = box;
  const searchingNow = !!step?.target && !el && !missing;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!searchingNow) return;
    const t = window.setTimeout(() => setSlow(true), 450);
    return () => window.clearTimeout(t);
  }, [searchingNow, index]);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    setMoving(true);
    const t = window.setTimeout(() => setMoving(false), 400);
    return () => window.clearTimeout(t);
  }, [index]);
  useEffect(() => {
    if (missing && step && !missLogged.current.has(step.id)) {
      missLogged.current.add(step.id);
      if (!test) onMiss?.(step);
    }
  }, [missing, step, test, onMiss]);

  const latest = useRef({ index, steps });
  latest.current = { index, steps };
  const go = useCallback(
    (to: number) => {
      const { steps: list } = latest.current;
      if (to >= list.length) {
        onFinish();
        return;
      }
      const next = Math.max(0, to);
      setIndex(next);
      onStep?.(next, list[next]);
    },
    [onFinish, onStep],
  );
  const next = useCallback(() => go(latest.current.index + 1), [go]);

  // 3) "Esperar o clique": the person's click on the element moves on (the
  // app handles the click first: a modal opens, a screen changes).
  // "Só mostrar": the click never reaches the app (nothing is saved or
  // sent) and the tour moves on. Delete buttons are never pressed in a tour.
  const shown = !!step && step.kind === "click" && step.real === false;
  const guarded = !!step?.target && looksDestructive(step.target);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!el || !step) return;
    if (step.kind !== "click" && !guarded) return;
    const inside = (e: Event) => e.target instanceof Node && el.contains(e.target);
    const stop = (e: Event) => {
      if (!inside(e) || !(shown || guarded)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const on = (e: MouseEvent) => {
      if (!inside(e)) return;
      stop(e);
      if (guarded) return setBlocked(true);
      window.setTimeout(next, shown ? 450 : 300);
    };
    const press = ["pointerdown", "mousedown", "pointerup", "mouseup", "keydown"];
    for (const t of press) document.addEventListener(t, stop, true);
    document.addEventListener("click", on, true);
    return () => {
      for (const t of press) document.removeEventListener(t, stop, true);
      document.removeEventListener("click", on, true);
    };
  }, [el, step, next, shown, guarded]);
  useEffect(() => setBlocked(false), [index]);

  // 4) "Esperar preencher": a value typed or chosen in the field.
  useEffect(() => {
    if (!el || !step || step.kind !== "input") return;
    const on = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Node) || !el.contains(t)) return;
      const input = t as HTMLInputElement;
      if (e.type === "change" || input.type === "checkbox" || (input.value ?? "").trim()) setFilled(true);
    };
    document.addEventListener("input", on, true);
    document.addEventListener("change", on, true);
    // Lists and pickers of the app change their own text when something is chosen.
    const obs = new MutationObserver(() => setFilled(true));
    if (!/^(INPUT|TEXTAREA)$/.test(el.tagName))
      obs.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-checked", "value"] });
    return () => {
      document.removeEventListener("input", on, true);
      document.removeEventListener("change", on, true);
      obs.disconnect();
    };
  }, [el, step]);

  // 5) "O tour clica sozinho": without text, it clicks right away.
  const auto = useCallback(() => {
    if (!el) return next();
    setBusy(true);
    pressElement(el);
    window.setTimeout(next, 400);
  }, [el, next]);
  useEffect(() => {
    if (!el || !step || step.kind !== "auto" || hasText(step)) return;
    const t = window.setTimeout(auto, 700);
    return () => window.clearTimeout(t);
  }, [el, step, auto]);

  if (!step) return null;
  const centered = !step.target || missing;
  const searching = searchingNow;
  const lit = centered ? null : (box ?? (slow ? null : lastBox.current));
  const last = index === steps.length - 1;
  const kind = missing ? "next" : step.kind;
  const nextLabel = last ? "Concluir" : "Próximo";
  const nextButton =
    kind === "click" ? null : (
      <button
        type="button"
        className="btn primary"
        disabled={(kind === "input" && !filled) || busy || searching}
        onClick={kind === "auto" ? auto : next}
      >
        {last ? <Check size={15} /> : null}
        {nextLabel}
        {!last && <ArrowRight size={15} />}
      </button>
    );

  return (
    <TourPortal>
      {/* Ao preencher, listas e calendários abrem fora do destaque: só o contorno. */}
      <Spotlight box={lit} block={kind !== "input"} dim={kind !== "input" || centered} moving={moving} />
      <Balloon
        box={lit}
        // Listas abrem para baixo: ao preencher, o balão prefere o lado.
        placement={step.placement === "auto" && kind === "input" ? "right" : step.placement}
        label={`${title}: passo ${index + 1} de ${steps.length}`}
        className={`${test ? "testing" : ""} ${moving ? "moving" : ""}`}
      >
        <div className="tour-balloon-head">
          <span className="tour-count">
            {test && <b>Teste · </b>}
            Passo {index + 1} de {steps.length}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label={test ? "Parar o teste" : "Fechar o onboarding"}
            title={test ? "Parar o teste" : "Fechar (você pode continuar depois)"}
            onClick={() => onClose(index, step)}
          >
            <X size={16} />
          </button>
        </div>
        {step.title && <h3 className="tour-balloon-title">{step.title}</h3>}
        {/"text"|inlineImage/.test(step.body) && (
          <div className="tour-balloon-body">
            <RichTextContent value={step.body} />
          </div>
        )}
        {searching && <p className="tour-hint">Procurando na tela…</p>}
        {missing && (
          <p className="tour-hint warn">
            <SearchX size={14} /> Este item não apareceu na sua tela. Siga pelo texto e avance.
          </p>
        )}
        {!missing && el && kind === "click" && (
          <p className="tour-hint">
            <MousePointerClick size={14} />{" "}
            {shown
              ? "Clique no destaque para continuar. Aqui o tour só mostra: nada é salvo nem enviado."
              : "Clique no destaque para continuar."}
          </p>
        )}
        {blocked && (
          <p className="tour-hint warn">
            <SearchX size={14} /> Durante o tour, este botão não é acionado.
          </p>
        )}
        {!missing && el && kind === "input" && !filled && (
          <p className="tour-hint">
            <TextCursorInput size={14} /> Preencha o campo em destaque para continuar.
          </p>
        )}
        <div className="tour-balloon-foot">
          <div className="tour-dots" aria-hidden="true">
            {steps.length <= 12 &&
              steps.map((s, i) => <span key={s.id} className={i === index ? "on" : i < index ? "done" : ""} />)}
          </div>
          <div className="tour-actions">
            {index > 0 && (
              <button type="button" className="btn secondary" onClick={() => go(index - 1)}>
                <ArrowLeft size={15} /> Voltar
              </button>
            )}
            {kind === "click" && (
              <button type="button" className="text-btn" onClick={next}>
                Pular
              </button>
            )}
            {nextButton}
          </div>
        </div>
      </Balloon>
    </TourPortal>
  );
}

/**
 * "Isso ajudou?" no fim de um onboarding: 👍 fecha; no 👎, um motivo e um
 * comentário opcionais. Fechar sem votar também vale.
 */
export function TourFeedback({
  title,
  onVote,
  onClose,
}: {
  title: string;
  onVote: (vote: "up" | "down", reason: VoteReason | null, comment: string) => Promise<void>;
  onClose: () => void;
}) {
  const [down, setDown] = useState(false);
  const [reason, setReason] = useState<VoteReason | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (vote: "up" | "down") => {
    setBusy(true);
    try {
      await onVote(vote, vote === "down" ? reason : null, vote === "down" ? comment : "");
    } finally {
      setBusy(false);
    }
  };
  return (
    <TourPortal>
      <div className="tour-feedback" role="dialog" aria-label="Isso ajudou?">
        <div className="tour-balloon-head">
          <span className="tour-count">
            <Check size={13} /> Onboarding concluído
          </span>
          <button type="button" className="icon-btn" aria-label="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <h3 className="tour-balloon-title">{title}</h3>
        {!down ? (
          <>
            <p className="tour-hint">Isso ajudou?</p>
            <div className="tour-feedback-votes">
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void send("up")}>
                <ThumbsUp size={15} /> Ajudou
              </button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setDown(true)}>
                <ThumbsDown size={15} /> Não ajudou
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="tour-hint">O que faltou? (opcional)</p>
            <div className="tour-feedback-reasons" role="group" aria-label="Motivo">
              {VOTE_REASONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`chip ${reason === r.id ? "selected" : ""}`}
                  aria-pressed={reason === r.id}
                  onClick={() => setReason(reason === r.id ? null : r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <textarea
              value={comment}
              maxLength={1000}
              rows={3}
              placeholder="Conte o que ficou confuso ou faltou (opcional)"
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="tour-actions">
              <button type="button" className="btn secondary" onClick={() => setDown(false)} disabled={busy}>
                Voltar
              </button>
              <button type="button" className="btn primary" onClick={() => void send("down")} disabled={busy}>
                Enviar
              </button>
            </div>
          </>
        )}
      </div>
    </TourPortal>
  );
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Crosshair,
  Expand,
  ListOrdered,
  LoaderCircle,
  LogOut,
  MessageSquare,
  Minimize2,
  Pencil,
  Play,
  Send,
  Sparkles,
  Square,
  Timer,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { navigate } from "./router";
import {
  captureTarget,
  describeTarget,
  isTourUi,
  looksCommitting,
  looksDestructive,
  parentPick,
  pickable,
  type TourTarget,
} from "./tour-target";
import {
  Balloon,
  Spotlight,
  TourPlayer,
  TourPortal,
  useBox,
  useStepElement,
} from "./TourPlayer";
import {
  MAX_STEPS,
  PLACEMENTS,
  STEP_KINDS,
  currentScreen,
  newStepId,
  onStepScreen,
  pageLabel,
  pageOfScreen,
  stepHref,
  stepInRecord,
  tourAudienceSummary,
  type Box,
  type TourContent,
  type TourMiss,
  type TourStatus,
  type TourStep,
  type ToursApi,
} from "./tours";
import type { Snapshot } from "./types";
import { draftBody, writerOutline } from "./tutorial-writer";

const RichTextEditor = lazy(() => import("./RichTextEditor"));

export interface EditorStart {
  id: string;
  content: TourContent;
  revision: number;
  status: TourStatus;
  hasDraft: boolean;
  misses: TourMiss[];
}

type Form = {
  /** Null: a new step (goes to the end). */
  index: number | null;
  step: TourStep;
  /** The picked element and the bigger ones around it ("Elemento maior"). */
  chain: HTMLElement[];
  at: number;
  /** Remounts the text editor when the step changes from outside. */
  key: number;
};

const blankStep = (): TourStep => ({
  id: newStepId(),
  page: pageOfScreen(currentScreen()),
  url: currentScreen(),
  target: null,
  title: "",
  body: "",
  kind: "next",
  placement: "auto",
});
const hasBodyText = (body: string) => /"text"|inlineImage/.test(body);

/**
 * The floating editor: a bar at the bottom while the person uses the app
 * normally. "Escolher elemento" turns the next click into a step (the click
 * doesn't reach the app); each step opens in a side panel with its balloon
 * text, kind and position. Every change is saved as a draft right away (a
 * published tour keeps the live version until "Publicar").
 */
export default function TourEditor({
  start,
  api,
  company,
  companyPath,
  data,
  demo,
  notify,
  onExit,
  onSaved,
}: {
  start: EditorStart;
  api: ToursApi;
  company: string;
  companyPath: string;
  data: Snapshot;
  demo: boolean;
  notify: (message: string) => void;
  onExit: () => void;
  /** After each save: what a remount of the editor should start from. */
  onSaved?: (start: EditorStart) => void;
}) {
  const [content, setContent] = useState(start.content);
  const [status, setStatus] = useState(start.status);
  const [hasDraft, setHasDraft] = useState(start.hasDraft);
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [picking, setPicking] = useState(false);
  const [recording, setRecording] = useState(false);
  /** "Escolher em 3 s": seconds left to open a list or menu before choosing. */
  const [countdown, setCountdown] = useState<number | null>(null);
  const [recorded, setRecorded] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [writing, setWriting] = useState(false);
  /** The step as it was before the MAVI's suggestion ("Desfazer"). */
  const [before, setBefore] = useState<TourStep | null>(null);
  // The panel moves to the left when the element is under it.
  const [panelLeft, setPanelLeft] = useState(false);
  const misses = useMemo(() => new Map(start.misses.map((m) => [m.step_id, m])), [start.misses]);

  // ---------------------------------------------------------------- saving
  const contentRef = useRef(content);
  const revision = useRef<number | null>(start.revision);
  const saving = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  /** A change not sent yet (sent when the editor closes, too). */
  const pending = useRef(false);
  const flush = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current);
    pending.current = false;
    if (saving.current) {
      again.current = true;
      return saving.current;
    }
    setSave("saving");
    const run = (async () => {
      try {
        const sent = contentRef.current;
        const r = await api.save(company, start.id, sent, false, revision.current);
        revision.current = r.revision;
        setStatus(r.status);
        setHasDraft(r.mode === "draft");
        setSave("saved");
        onSaved?.({ ...start, content: sent, revision: r.revision, status: r.status, hasDraft: r.mode === "draft" });
      } catch (e) {
        setSave("error");
        notify((e as Error).message || "Não foi possível salvar o onboarding.");
      } finally {
        saving.current = null;
        if (again.current) {
          again.current = false;
          void flush();
        }
      }
    })();
    saving.current = run;
    return run;
  }, [api, company, start, notify, onSaved]);
  const change = (next: TourContent) => {
    contentRef.current = next;
    setContent(next);
    pending.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 500);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current) void flushRef.current();
    },
    [],
  );
  const setSteps = (steps: TourStep[]) => change({ ...contentRef.current, steps });

  async function publish() {
    setConfirmPublish(false);
    window.clearTimeout(timer.current);
    pending.current = false;
    if (saving.current) await saving.current;
    setSave("saving");
    try {
      const sent = contentRef.current;
      const r = await api.save(company, start.id, sent, true, revision.current);
      revision.current = r.revision;
      setStatus(r.status);
      setHasDraft(false);
      onSaved?.({ ...start, content: sent, revision: r.revision, status: r.status, hasDraft: false });
      setSave("saved");
      notify("Onboarding publicado. Quem está no público já pode fazer.");
    } catch (e) {
      setSave("error");
      notify((e as Error).message || "Não foi possível publicar.");
    }
  }
  async function exit() {
    if (pending.current) await flush();
    else if (saving.current) await saving.current;
    onExit();
  }

  // ---------------------------------------------------------------- steps
  const openForm = (index: number | null, step: TourStep, el: HTMLElement | null) =>
    setForm((f) => ({ index, step, chain: el ? [el] : [], at: 0, key: (f?.key ?? 0) + 1 }));
  const onPick = (el: HTMLElement) => {
    setPicking(false);
    const where = { page: pageOfScreen(currentScreen()), url: currentScreen(), target: captureTarget(el) };
    if (form) {
      const step = { ...form.step, ...where, real: !looksCommitting(where.target) };
      if (step.target && looksDestructive(step.target) && step.kind !== "next" && step.kind !== "input")
        step.kind = "next";
      setForm({ ...form, step, chain: [el], at: 0 });
    } else {
      if (content.steps.length >= MAX_STEPS) return notify(`Um onboarding pode ter até ${MAX_STEPS} passos.`);
      openForm(null, { ...blankStep(), ...where, real: !looksCommitting(where.target) }, el);
    }
  };
  // "Gravar": each click on the app becomes a step (and still does what it does).
  const onRecord = (el: HTMLElement, target: TourTarget, url: string) => {
    const steps = contentRef.current.steps;
    if (steps.length >= MAX_STEPS) {
      setRecording(false);
      return notify(`Um onboarding pode ter até ${MAX_STEPS} passos. A gravação parou.`);
    }
    const field = recordKind(el, target);
    const last = steps[steps.length - 1];
    // Clicks again on the field being filled: the same step.
    if (last && last.url === url && last.target?.path === target.path && last.kind === "input") return;
    const name = target.label || target.text;
    const quoted = name ? `“${name.length > 50 ? `${name.slice(0, 50)}…` : name}”` : describeTarget(target);
    const step: TourStep = {
      id: newStepId(),
      page: pageOfScreen(url),
      url,
      target,
      title: field === "input" ? `Preencha ${quoted}` : field === "click" ? `Clique em ${quoted}` : quoted,
      body: "",
      kind: field,
      placement: "auto",
      record: "any",
      real: !looksCommitting(target),
    };
    setSteps([...steps, step]);
    setRecorded((n) => n + 1);
  };
  const addCentered = () => {
    if (content.steps.length >= MAX_STEPS) return notify(`Um onboarding pode ter até ${MAX_STEPS} passos.`);
    setPicking(false);
    openForm(null, blankStep(), null);
  };
  const resize = (dir: 1 | -1) => {
    if (!form) return;
    let { chain, at } = form;
    if (dir === 1) {
      const cur = chain[at];
      if (!cur) return;
      if (at + 1 < chain.length) at += 1;
      else {
        const up = parentPick(cur);
        if (!up) return notify("Não há um elemento maior em volta deste.");
        chain = [...chain, up];
        at += 1;
      }
    } else {
      if (at === 0) return;
      at -= 1;
    }
    const el = chain[at];
    if (!el?.isConnected) return notify("O elemento saiu da tela. Escolha de novo.");
    const target = captureTarget(el);
    const step = { ...form.step, target };
    if (looksDestructive(target) && (step.kind === "click" || step.kind === "auto")) step.kind = "next";
    setForm({ ...form, chain, at, step });
  };
  // A MAVI escreve (ou melhora) o balão; vai para o formulário, não salva sozinho.
  const suggest = async () => {
    if (!form) return;
    const s = form.step;
    const steps = contentRef.current.steps;
    const at = form.index ?? steps.length;
    const filled = !!s.title || hasBodyText(s.body);
    setWriting(true);
    try {
      const r = await api.write(company, {
        mode: filled ? "improve" : "write",
        tour: contentRef.current.title,
        summary: contentRef.current.summary,
        n: at + 1,
        total: Math.max(steps.length, at + 1),
        screen: pageLabel(s.page),
        element: s.target ? describeTarget(s.target) : "",
        context: s.target?.context ?? "",
        kind: s.kind,
        title: s.title,
        text: hasBodyText(s.body) ? writerOutline(s.body).text : "",
        before: steps.slice(Math.max(0, at - 3), at).map((x) => x.title).filter(Boolean),
        after: steps.slice(form.index === null ? at : at + 1, at + 4).map((x) => x.title).filter(Boolean),
      });
      setBefore(s);
      const body = draftBody(r.blocks, []);
      setForm((f) => f && { ...f, step: { ...f.step, title: r.title, body }, key: f.key + 1 });
      if (r.notes) notify(`A MAVI pede para conferir: ${r.notes}`);
    } catch (e) {
      notify((e as Error).message || "A MAVI não conseguiu escrever agora.");
    } finally {
      setWriting(false);
    }
  };
  const undoSuggestion = () => {
    if (!before) return;
    setForm((f) => f && { ...f, step: { ...f.step, title: before.title, body: before.body }, key: f.key + 1 });
    setBefore(null);
  };

  const saveForm = () => {
    if (!form) return;
    const s = { ...form.step, title: form.step.title.replace(/\s+/g, " ").trim() };
    if (!s.target && s.kind !== "next") s.kind = "next";
    if (!s.title && !hasBodyText(s.body) && s.kind !== "auto")
      return notify("Escreva um título ou um texto para o balão.");
    const steps = [...contentRef.current.steps];
    if (form.index === null) steps.push(s);
    else steps[form.index] = s;
    setSteps(steps);
    setForm(null);
    setBefore(null);
    setListOpen(true);
  };
  const removeStep = (i: number) => {
    setSteps(contentRef.current.steps.filter((_, j) => j !== i));
    if (form?.index === i) setForm(null);
  };
  const move = (i: number, d: -1 | 1) => {
    const steps = [...contentRef.current.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setSteps(steps);
  };
  const editStep = (i: number) => {
    const s = contentRef.current.steps[i];
    setPicking(false);
    if (!onStepScreen(currentScreen(), s.url)) navigate(stepHref(s.url, companyPath));
    openForm(i, s, null);
  };

  // "Escolher em 3 s": a contagem não exige clique (a lista aberta não fecha).
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      setPicking(true);
      return;
    }
    const t = window.setTimeout(() => setCountdown((n) => (n === null ? null : n - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  // While testing, the editor steps aside.
  if (testing !== null)
    return (
      <TourPlayer
        title={content.title}
        steps={content.steps}
        start={testing}
        companyPath={companyPath}
        test
        onFinish={() => {
          setTesting(null);
          notify("Teste concluído.");
        }}
        onClose={() => setTesting(null)}
      />
    );

  const steps = content.steps;
  const statusLabel =
    status === "published" ? (hasDraft ? "Publicado · alteração não publicada" : "Publicado") : "Rascunho";
  const canPublish = steps.length > 0 && (status === "draft" || hasDraft);

  return (
    <TourPortal>
      {picking && <Picker onPick={onPick} onCancel={() => setPicking(false)} />}
      {/* Alt (Option) + clique escolhe a qualquer momento, sem clicar na barra. */}
      {!picking && !recording && countdown === null && <Picker requireAlt onPick={onPick} onCancel={() => {}} />}
      {recording && <Recorder onRecord={onRecord} />}
      {form && !picking && (
        <FormHighlight
          form={form}
          onBox={(b) => setPanelLeft(!!b && b.left + b.width > window.innerWidth - 400 && b.left > 420)}
        />
      )}

      {(listOpen || form) && !collapsed && (
        <aside className={`tour-panel ${form && panelLeft ? "left" : ""}`} aria-label="Passos do onboarding">
          {form ? (
            <StepForm
              form={form}
              company={company}
              demo={demo}
              onPatch={(patch) => setForm((f) => f && { ...f, step: { ...f.step, ...patch } })}
              onResize={resize}
              onRepick={() => setPicking(true)}
              onSave={saveForm}
              onCancel={() => {
                setForm(null);
                setBefore(null);
              }}
              onRemove={form.index === null ? undefined : () => removeStep(form.index!)}
              onUploading={setUploading}
              uploading={uploading}
              writing={writing}
              onSuggest={() => void suggest()}
              onUndoSuggestion={before ? undoSuggestion : undefined}
              number={form.index === null ? steps.length + 1 : form.index + 1}
            />
          ) : (
            <StepList
              steps={steps}
              misses={misses}
              onEdit={editStep}
              onMove={move}
              onRemove={removeStep}
              onTest={(i) => setTesting(i)}
            />
          )}
        </aside>
      )}

      <div className={`tour-bar ${collapsed ? "collapsed" : ""}`} role="toolbar" aria-label="Editor do onboarding">
        <div className="tour-bar-title">
          <strong title={content.title}>{content.title}</strong>
          <small>
            {statusLabel} ·{" "}
            {save === "saving" ? (
              <>
                <LoaderCircle size={12} className="spin" /> salvando…
              </>
            ) : save === "error" ? (
              <span className="tour-error">não salvo</span>
            ) : save === "saved" ? (
              "salvo"
            ) : (
              `${steps.length} ${steps.length === 1 ? "passo" : "passos"}`
            )}
          </small>
        </div>
        {countdown !== null ? (
          <div className="tour-bar-picking">
            <Timer size={16} /> Abra a lista ou o menu agora. A escolha começa em <b>{countdown}</b>…
            <button type="button" className="btn secondary" onClick={() => setCountdown(null)}>
              Cancelar
            </button>
          </div>
        ) : recording ? (
          <div className="tour-bar-picking">
            <span className="tour-rec-dot" aria-hidden="true" /> Gravando: use o sistema; cada clique vira um passo.
            <b>{recorded} {recorded === 1 ? "passo" : "passos"}</b>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setRecording(false);
                setListOpen(true);
                if (recorded) notify("Gravação parada. Revise os textos de cada passo na lista.");
              }}
            >
              <Square size={13} /> Parar
            </button>
          </div>
        ) : picking ? (
          <div className="tour-bar-picking">
            <Crosshair size={16} /> Clique no elemento do passo. <kbd>Esc</kbd> cancela.
            <button type="button" className="btn secondary" onClick={() => setPicking(false)}>
              Cancelar
            </button>
          </div>
        ) : confirmPublish ? (
          <div className="tour-bar-confirm">
            <span>
              Publicar para <b>{tourAudienceSummary(content, data)}</b>?
            </span>
            <button type="button" className="btn primary" onClick={() => void publish()}>
              <Send size={15} /> Publicar
            </button>
            <button type="button" className="btn secondary" onClick={() => setConfirmPublish(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          !collapsed && (
            <div className="tour-bar-actions">
              {!form && (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => {
                    setRecorded(0);
                    setListOpen(false);
                    setRecording(true);
                  }}
                  title="Use o sistema normalmente: cada clique vira um passo, com o texto para revisar depois"
                >
                  <Circle size={13} className="tour-rec-icon" /> Gravar
                </button>
              )}
              <button
                type="button"
                className="btn primary"
                onClick={() => setPicking(true)}
                title="Escolha um botão, campo, tabela, ícone… na tela"
              >
                <Crosshair size={15} /> {form ? "Trocar elemento" : "Escolher elemento"}
              </button>
              {!form && (
                <button type="button" className="btn secondary" onClick={addCentered} title="Um balão no meio da tela, sem elemento">
                  <MessageSquare size={15} /> Balão no centro
                </button>
              )}
              <button
                type="button"
                className="btn secondary"
                onClick={() => setCountdown(3)}
                title="Para opções de listas e menus: clique aqui, abra a lista e espere. Ou segure Alt (Option) e clique no elemento."
              >
                <Timer size={15} /> Em 3 s
              </button>
              <button
                type="button"
                className={`btn secondary ${listOpen ? "selected" : ""}`}
                onClick={() => setListOpen((v) => !v)}
                aria-pressed={listOpen}
              >
                <ListOrdered size={15} /> Passos ({steps.length})
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={!steps.length || !!form}
                onClick={() => setTesting(0)}
              >
                <Play size={15} /> Testar
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={!canPublish || save === "saving" || !!form}
                onClick={() => setConfirmPublish(true)}
                title={steps.length ? undefined : "Adicione ao menos um passo"}
              >
                <Send size={15} /> {status === "published" ? "Publicar alteração" : "Publicar"}
              </button>
              <button type="button" className="btn secondary" onClick={() => void exit()}>
                <LogOut size={15} /> Sair
              </button>
            </div>
          )
        )}
        <button
          type="button"
          className="icon-btn tour-bar-toggle"
          aria-label={collapsed ? "Mostrar o editor" : "Recolher o editor"}
          title={collapsed ? "Mostrar o editor" : "Recolher o editor (para usar a tela)"}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>
    </TourPortal>
  );
}

/** What a recorded click means: a field to fill, a click to wait for, or (delete buttons) just a look. */
function recordKind(el: HTMLElement, t: TourTarget): TourStep["kind"] {
  if (looksDestructive(t)) return "next";
  const field =
    /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
    el.getAttribute("role") === "combobox" ||
    el.getAttribute("aria-haspopup") === "listbox" ||
    el.isContentEditable;
  if (!field) return "click";
  const type = (el as HTMLInputElement).type;
  return type === "checkbox" || type === "radio" ? "click" : "input";
}

/**
 * Recording: every click on the app (not on the editor) becomes a step,
 * read before the app reacts (the screen may change right after). The
 * click goes on as usual. Choosing an option in a list is part of filling
 * the field, not a step of its own.
 */
function Recorder({ onRecord }: { onRecord: (el: HTMLElement, target: TourTarget, url: string) => void }) {
  const latest = useRef(onRecord);
  latest.current = onRecord;
  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (e.button !== 0 || isTourUi(e.target as Element)) return;
      const under = e.target instanceof Element ? e.target : null;
      if (under?.closest("[role=option], [role=listbox], [role=gridcell], .rdp, [data-radix-popper-content-wrapper] [role=option]"))
        return;
      const el = pickable(under);
      if (!el) return;
      latest.current(el, captureTarget(el), currentScreen());
    };
    document.addEventListener("click", on, true);
    document.documentElement.classList.add("tour-recording");
    return () => {
      document.removeEventListener("click", on, true);
      document.documentElement.classList.remove("tour-recording");
    };
  }, []);
  return null;
}

/**
 * Choosing an element: the hovered one lights up and the click picks it
 * (the click never reaches the app). Esc cancels. `requireAlt`: always on
 * while the editor is open, but only with Alt (Option) held — the way to
 * pick an option of an open list or menu, which would close if the person
 * clicked the editor's bar.
 */
function Picker({
  onPick,
  onCancel,
  requireAlt = false,
}: {
  onPick: (el: HTMLElement) => void;
  onCancel: () => void;
  requireAlt?: boolean;
}) {
  const [hover, setHover] = useState<HTMLElement | null>(null);
  const box = useBox(hover);
  const latest = useRef({ onPick, onCancel });
  latest.current = { onPick, onCancel };
  useEffect(() => {
    let current: HTMLElement | null = null;
    let pointer: { x: number; y: number } | null = null;
    const on = (e: { altKey: boolean }) => !requireAlt || e.altKey;
    const at = (x: number, y: number) => {
      const under = document.elementFromPoint(x, y);
      return isTourUi(under) ? null : pickable(under);
    };
    const show = (el: HTMLElement | null) => {
      if (el !== current) {
        current = el;
        setHover(el);
      }
    };
    const move = (e: MouseEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      show(on(e) ? at(e.clientX, e.clientY) : null);
    };
    // Nothing reaches the app while choosing (menus open on pointerdown).
    const block = (e: Event) => {
      if (isTourUi(e.target as Element) || !on(e as MouseEvent)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const click = (e: MouseEvent) => {
      if (isTourUi(e.target as Element) || !on(e)) return;
      block(e);
      const el = at(e.clientX, e.clientY);
      if (el) latest.current.onPick(el);
      show(null);
    };
    const key = (e: KeyboardEvent) => {
      if (requireAlt) {
        // Alt pressed or released: light (or not) what is under the pointer.
        if (e.key === "Alt" && pointer) show(e.type === "keydown" ? at(pointer.x, pointer.y) : null);
        return;
      }
      if (e.type !== "keydown" || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onCancel();
    };
    const blur = () => show(null);
    const presses = ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "contextmenu"];
    document.addEventListener("mousemove", move, true);
    for (const t of presses) document.addEventListener(t, block, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    window.addEventListener("blur", blur);
    if (!requireAlt) document.documentElement.classList.add("tour-picking");
    return () => {
      document.removeEventListener("mousemove", move, true);
      for (const t of presses) document.removeEventListener(t, block, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keyup", key, true);
      window.removeEventListener("blur", blur);
      if (!requireAlt) document.documentElement.classList.remove("tour-picking");
    };
  }, [requireAlt]);
  if (!hover || !box) return null;
  const t = captureTarget(hover);
  return (
    <>
      <div className="tour-hover" style={{ left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6 }} />
      <div
        className="tour-hover-label"
        style={{ left: Math.max(8, box.left), top: box.top > 34 ? box.top - 30 : box.top + box.height + 6 }}
      >
        {describeTarget(t)}
      </div>
    </>
  );
}

/** The element of the step being edited, with its balloon's place. */
function FormHighlight({ form, onBox }: { form: Form; onBox: (box: Box | null) => void }) {
  const picked = form.chain[form.at];
  const { el: found } = useStepElement(
    picked?.isConnected ? null : form.step.target,
    !picked?.isConnected && !!form.step.target,
    form.step.target,
    4000,
  );
  const el = picked?.isConnected ? picked : found;
  const box = useBox(el);
  const report = useRef(onBox);
  report.current = onBox;
  useEffect(() => report.current(form.step.target ? box : null), [box, form.step.target]);
  if (!form.step.target) return null;
  return (
    <>
      <Spotlight box={box} block={false} dim={false} />
      {box && (
        <Balloon box={box} placement={form.step.placement} label="Prévia do balão" className="preview">
          <span className="tour-count">Prévia</span>
          <h3 className="tour-balloon-title">{form.step.title || "Título do passo"}</h3>
        </Balloon>
      )}
    </>
  );
}

function StepList({
  steps,
  misses,
  onEdit,
  onMove,
  onRemove,
  onTest,
}: {
  steps: TourStep[];
  misses: Map<string, TourMiss>;
  onEdit: (i: number) => void;
  onMove: (i: number, d: -1 | 1) => void;
  onRemove: (i: number) => void;
  onTest: (i: number) => void;
}) {
  const [confirm, setConfirm] = useState<number | null>(null);
  return (
    <div className="tour-steps">
      <h2>Passos</h2>
      <p className="tour-tip">
        Opção de lista ou menu: clique em <b>Em 3 s</b> e abra a lista, ou segure <kbd>Alt</kbd> (<kbd>Option</kbd>{" "}
        no Mac) e clique nela.
      </p>
      {!steps.length ? (
        <p className="tour-empty">
          Navegue até a tela onde o onboarding começa e clique em <b>Escolher elemento</b>. Use{" "}
          <b>Balão no centro</b> para uma boas-vindas sem elemento.
        </p>
      ) : (
        <ol>
          {steps.map((s, i) => {
            const miss = misses.get(s.id);
            return (
              <li key={s.id}>
                <button type="button" className="tour-step-main" onClick={() => onEdit(i)}>
                  <span className="tour-step-n">{i + 1}</span>
                  <span className="tour-step-text">
                    <strong>{s.title || (s.kind === "auto" ? "Clique automático" : "Sem título")}</strong>
                    <small>
                      {pageLabel(s.page)} · {s.target ? describeTarget(s.target) : "Balão no centro"} ·{" "}
                      {STEP_KINDS.find((k) => k.id === s.kind)?.label}
                    </small>
                    {(s.real === false ||
                      (s.kind === "click" && s.skip === false) ||
                      (s.record === "same" && stepInRecord(s))) && (
                      <span className="tour-step-flags">
                        {s.real === false && <span>só mostrar</span>}
                        {s.kind === "click" && s.skip === false && <span>sem pular</span>}
                        {s.record === "same" && stepInRecord(s) && <span>este registro</span>}
                      </span>
                    )}
                    {miss && (
                      <small className="tour-miss">
                        <TriangleAlert size={12} /> Não encontrado {miss.misses}× ({miss.people}{" "}
                        {miss.people === 1 ? "pessoa" : "pessoas"})
                      </small>
                    )}
                  </span>
                </button>
                {confirm === i ? (
                  <span className="tour-step-tools">
                    <button type="button" className="text-btn danger" onClick={() => (onRemove(i), setConfirm(null))}>
                      Excluir
                    </button>
                    <button type="button" className="text-btn" onClick={() => setConfirm(null)}>
                      Manter
                    </button>
                  </span>
                ) : (
                  <span className="tour-step-tools">
                    <button type="button" className="icon-btn" aria-label="Editar" title="Editar" onClick={() => onEdit(i)}>
                      <Pencil size={14} />
                    </button>
                    <button type="button" className="icon-btn" aria-label="Testar a partir daqui" title="Testar a partir daqui" onClick={() => onTest(i)}>
                      <Play size={14} />
                    </button>
                    <button type="button" className="icon-btn" aria-label="Subir" title="Subir" disabled={i === 0} onClick={() => onMove(i, -1)}>
                      <ArrowUp size={14} />
                    </button>
                    <button type="button" className="icon-btn" aria-label="Descer" title="Descer" disabled={i === steps.length - 1} onClick={() => onMove(i, 1)}>
                      <ArrowDown size={14} />
                    </button>
                    <button type="button" className="icon-btn" aria-label="Excluir passo" title="Excluir passo" onClick={() => setConfirm(i)}>
                      <Trash2 size={14} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function StepForm({
  form,
  number,
  company,
  demo,
  uploading,
  onPatch,
  onResize,
  onRepick,
  onSave,
  onCancel,
  onRemove,
  onUploading,
  writing,
  onSuggest,
  onUndoSuggestion,
}: {
  form: Form;
  number: number;
  company: string;
  demo: boolean;
  uploading: boolean;
  onPatch: (patch: Partial<TourStep>) => void;
  onResize: (dir: 1 | -1) => void;
  onRepick: () => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove?: () => void;
  onUploading: (busy: boolean) => void;
  writing: boolean;
  onSuggest: () => void;
  onUndoSuggestion?: () => void;
}) {
  const s = form.step;
  const set = onPatch;
  const destructive = !!s.target && looksDestructive(s.target);
  return (
    <form
      className="tour-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h2>{form.index === null ? `Novo passo (${number})` : `Passo ${number}`}</h2>
      <div className="tour-field">
        <span className="tour-label">Elemento</span>
        <div className="tour-element">
          <strong>{s.target ? describeTarget(s.target) : "Balão no centro da tela"}</strong>
          <small>{pageLabel(s.page)}</small>
        </div>
        <div className="tour-element-tools">
          {s.target && (
            <>
              <button type="button" className="text-btn" onClick={() => onResize(1)} title="Seleciona o bloco em volta (tabela, painel, cartão)">
                <Expand size={14} /> Elemento maior
              </button>
              <button type="button" className="text-btn" onClick={() => onResize(-1)} disabled={form.at === 0}>
                <Minimize2 size={14} /> Menor
              </button>
            </>
          )}
          <button type="button" className="text-btn" onClick={onRepick}>
            <Crosshair size={14} /> {s.target ? "Trocar" : "Escolher um elemento"}
          </button>
          {s.target && (
            <button type="button" className="text-btn" onClick={() => set({ target: null, kind: "next" })}>
              Sem elemento
            </button>
          )}
        </div>
      </div>
      <div className="tour-mavi">
        <button type="button" className="btn secondary" onClick={onSuggest} disabled={writing || uploading}>
          <Sparkles size={14} />{" "}
          {writing
            ? "A MAVI está escrevendo…"
            : s.title || /"text"/.test(s.body)
              ? "Melhorar com a MAVI"
              : "Escrever com a MAVI"}
        </button>
        {onUndoSuggestion && !writing && (
          <button type="button" className="text-btn" onClick={onUndoSuggestion}>
            Desfazer
          </button>
        )}
      </div>
      <label className="tour-field">
        <span className="tour-label">Título do balão</span>
        <input
          value={s.title}
          maxLength={120}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="Ex.: Crie sua primeira tarefa"
          autoFocus
        />
      </label>
      <div className="tour-field tour-body">
        <Suspense fallback={<div className="tour-editor-loading">Carregando o editor…</div>}>
          <RichTextEditor
            key={`${s.id}-${form.key}`}
            name="tour-step-body"
            label="Texto do balão"
            company={company}
            demo={demo}
            defaultValue={s.body}
            onUploading={onUploading}
            onChange={(v) => onPatch({ body: v })}
          />
        </Suspense>
      </div>
      <fieldset className="tour-field tour-kinds">
        <legend className="tour-label">Como a pessoa avança</legend>
        {STEP_KINDS.map((k) => {
          const off =
            (k.id !== "next" && !s.target) || (destructive && (k.id === "click" || k.id === "auto"));
          return (
            <label key={k.id} className={off ? "off" : ""}>
              <input
                type="radio"
                name="tour-kind"
                checked={s.kind === k.id}
                disabled={off}
                onChange={() => set({ kind: k.id })}
              />
              <span>
                <b>{k.label}</b>
                <small>{k.hint}</small>
              </span>
            </label>
          );
        })}
        {destructive && (
          <p className="tour-note">
            <TriangleAlert size={13} /> Por segurança, o tour não clica nem espera o clique em botões de excluir.
          </p>
        )}
      </fieldset>
      {s.kind === "click" && !destructive && (
        <fieldset className="tour-field tour-kinds">
          <legend className="tour-label">O clique de quem faz o tour</legend>
          <label>
            <input type="radio" name="tour-real" checked={s.real !== false} onChange={() => set({ real: true })} />
            <span>
              <b>Faz de verdade</b>
              <small>O botão funciona normalmente (salva, envia, abre).</small>
            </span>
          </label>
          <label>
            <input type="radio" name="tour-real" checked={s.real === false} onChange={() => set({ real: false })} />
            <span>
              <b>Só mostrar</b>
              <small>O clique não chega ao sistema: nada é salvo nem enviado. O tour segue.</small>
            </span>
          </label>
        </fieldset>
      )}
      {s.kind === "click" && (
        <fieldset className="tour-field tour-kinds">
          <legend className="tour-label">Botão “Pular”</legend>
          <label>
            <input type="checkbox" checked={s.skip !== false} onChange={(e) => set({ skip: e.target.checked })} />
            <span>
              <b>Mostrar o botão “Pular”</b>
              <small>
                {s.skip !== false
                  ? "A pessoa pode seguir sem clicar no destaque."
                  : "Desligado: só avança clicando no destaque (se o elemento não aparecer, o tour mostra “Próximo”)."}
              </small>
            </span>
          </label>
        </fieldset>
      )}
      {stepInRecord(s) && (
        <fieldset className="tour-field tour-kinds">
          <legend className="tour-label">Registro</legend>
          <label>
            <input type="radio" name="tour-record" checked={s.record !== "same"} onChange={() => set({ record: "any" })} />
            <span>
              <b>Qualquer um do mesmo tipo</b>
              <small>Vale o que a pessoa tiver aberto (ou a 1ª linha da lista no lugar da gravada).</small>
            </span>
          </label>
          <label>
            <input type="radio" name="tour-record" checked={s.record === "same"} onChange={() => set({ record: "same" })} />
            <span>
              <b>Este registro</b>
              <small>O tour abre exatamente o que foi gravado (quem não tem acesso a ele não vê o passo).</small>
            </span>
          </label>
        </fieldset>
      )}
      {s.target && (
        <label className="tour-field">
          <span className="tour-label">Posição do balão</span>
          <select value={s.placement} onChange={(e) => set({ placement: e.target.value as TourStep["placement"] })}>
            {PLACEMENTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="tour-form-foot">
        {onRemove && (
          <button type="button" className="text-btn danger" onClick={onRemove}>
            <Trash2 size={14} /> Excluir passo
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="btn primary" disabled={uploading}>
          <Check size={15} /> Salvar passo
        </button>
      </div>
    </form>
  );
}

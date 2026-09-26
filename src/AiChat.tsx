import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Check,
  CheckSquare,
  ChevronRight,
  FileText,
  Loader2,
  Megaphone,
  MessageCircle,
  Rocket,
  Send,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { answerPieces, type ChatTurn } from "./meetings";
import {
  sourceLabel,
  type AiAnswer,
  type AiSource,
  type AiStep,
  type AiStreamHandlers,
} from "./ai";

/**
 * O chat com a IA, igual em todo o sistema: enquanto a IA trabalha, os
 * passos aparecem um a um (buscando…, lendo…, 8 trechos encontrados), com o
 * resumo do raciocínio; a resposta chega digitando e cita as fontes.
 */

export type ChatEntry = {
  role: "user" | "assistant";
  content: string;
  sources?: AiSource[];
  steps?: AiStep[];
  thinking?: string;
  warnings?: string[];
  streaming?: boolean;
};

// ------------------------------------------------------------ resposta
/**
 * Resposta da IA com momentos [12:34] e fontes [S3] clicáveis, e a lista
 * das fontes citadas no fim.
 */
export function AnswerText({
  text,
  onTime,
  sources = [],
  onSource,
  showSources = true,
}: {
  text: string;
  onTime?: (seconds: number) => void;
  sources?: AiSource[];
  onSource?: (source: AiSource) => void;
  showSources?: boolean;
}) {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const render = (line: string) =>
    answerPieces(line).map((p, i) =>
      p.kind === "text" ? (
        p.bold ? (
          <strong key={i}>{p.text}</strong>
        ) : (
          <span key={i}>{p.text}</span>
        )
      ) : p.kind === "time" ? (
        <button
          key={i}
          type="button"
          className="answer-cite"
          onClick={() => onTime?.(p.seconds)}
          disabled={!onTime}
        >
          {p.label}
        </button>
      ) : byRef.has(p.ref) ? (
        <button
          key={i}
          type="button"
          className={`answer-cite ${byRef.get(p.ref)!.type}`}
          title={byRef.get(p.ref)!.title}
          onClick={() => onSource?.(byRef.get(p.ref)!)}
          disabled={!onSource}
        >
          {sourceLabel(byRef.get(p.ref)!)}
        </button>
      ) : null,
    );
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`l${out.length}`}>{list}</ul>);
    list = [];
  };
  text.split("\n").forEach((line, i) => {
    const item = line.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/);
    if (item) list.push(<li key={i}>{render(item[1])}</li>);
    else {
      flush();
      if (line.trim())
        out.push(<p key={i}>{render(line.replace(/^#+\s*/, ""))}</p>);
    }
  });
  flush();
  return (
    <div className="answer-text">
      {out}
      {showSources && sources.length > 0 && (
        <div className="answer-sources">
          <small>Fontes</small>
          <ul>
            {sources.map((s) => (
              <li key={s.ref}>
                <button
                  type="button"
                  onClick={() => onSource?.(s)}
                  disabled={!onSource}
                  title={sourceLabel(s)}
                >
                  <SourceIcon type={s.type} />
                  <span>{s.title}</span>
                  <small>{sourceLabel(s)}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const SOURCE_ICONS = {
  meeting: Video,
  task: CheckSquare,
  file: FileText,
  social: Rocket,
  campaign: Megaphone,
};
function SourceIcon({ type }: { type: AiSource["type"] }) {
  const Icon = SOURCE_ICONS[type] ?? FileText;
  return <Icon size={13} aria-hidden="true" />;
}

/**
 * O texto aparecendo como se fosse digitado: acompanha o que chega do
 * servidor num ritmo constante e acelera quando fica para trás.
 */
export function useTypewriter(target: string, animate: boolean) {
  const [shown, setShown] = useState(animate ? 0 : target.length);
  useEffect(() => {
    if (shown >= target.length) return;
    const raf = requestAnimationFrame(() =>
      setShown((n) =>
        Math.min(
          target.length,
          n + Math.max(2, Math.ceil((target.length - n) / 24)),
        ),
      ),
    );
    return () => cancelAnimationFrame(raf);
  }, [shown, target]);
  return { text: target.slice(0, shown), typing: shown < target.length };
}

/** Esconde o fim ainda incompleto: "[S1" sem fechar, "**" sem par, "*" solto. */
export function hidePartial(text: string) {
  let t = text.replace(/\[[^\]\n]*$/, "");
  if ((t.match(/\*\*/g) ?? []).length % 2) t = t.slice(0, t.lastIndexOf("**"));
  return t.replace(/(^|[^*])\*$/, "$1");
}

function Typed({
  text,
  streaming,
  render,
}: {
  text: string;
  streaming: boolean;
  render: (text: string, typing: boolean) => ReactNode;
}) {
  const typed = useTypewriter(text, streaming);
  const busy = streaming || typed.typing;
  // Uma citação ou negrito pela metade não aparece enquanto digita.
  const visible = busy ? hidePartial(typed.text) : typed.text;
  return (
    <div className={busy ? "answer-typing" : ""}>{render(visible, busy)}</div>
  );
}

// ------------------------------------------------------------ passos
function lastSentence(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  const parts = clean.split(/(?<=[.!?])\s+/);
  const last = parts[parts.length - 1] || parts[parts.length - 2] || "";
  return last.length > 180 ? `…${last.slice(-180)}` : last;
}

function Steps({
  steps,
  thinking,
  streaming,
  writing,
}: {
  steps: AiStep[];
  thinking?: string;
  streaming: boolean;
  writing: boolean;
}) {
  const running = steps.some((s) => s.state === "running");
  const list = (
    <ol className="ai-steps">
      {steps.map((s) => (
        <li key={s.id} className={`ai-step ${s.state}`}>
          <span className="ai-step-icon" aria-hidden="true">
            {s.state === "running" ? (
              <Loader2 size={13} className="spin" />
            ) : s.state === "done" ? (
              <Check size={13} />
            ) : s.state === "error" ? (
              <X size={13} />
            ) : (
              <MessageCircle size={12} />
            )}
          </span>
          <span className="ai-step-label">
            {s.label}
            {s.detail && <small> · {s.detail}</small>}
          </span>
        </li>
      ))}
      {streaming && !running && (
        <li className="ai-step running">
          <span className="ai-step-icon" aria-hidden="true">
            <Loader2 size={13} className="spin" />
          </span>
          <span className="ai-step-label">
            {writing ? "Escrevendo a resposta" : "Pensando"}
          </span>
        </li>
      )}
    </ol>
  );
  if (streaming)
    return (
      <div className="ai-work" aria-live="polite">
        {list}
        {thinking && !writing && (
          <p className="ai-thinking">{lastSentence(thinking)}</p>
        )}
      </div>
    );
  if (!steps.length) return null;
  const tools = steps.filter((s) => s.state !== "note").length;
  return (
    <details className="ai-work done">
      <summary>
        <ChevronRight size={13} aria-hidden="true" /> Como a IA chegou à
        resposta · {tools} {tools === 1 ? "passo" : "passos"}
      </summary>
      {list}
    </details>
  );
}

// ------------------------------------------------------------ chat
export function AiChat({
  intro,
  placeholder,
  suggestions,
  send,
  renderAnswer,
  initial,
  readOnly,
  readOnlyNote,
  onAnswer,
}: {
  intro: ReactNode;
  placeholder: string;
  suggestions: string[];
  /** Faz a pergunta, repassando os eventos do trabalho da IA. */
  send: (
    question: string,
    history: ChatTurn[],
    handlers: AiStreamHandlers,
  ) => Promise<AiAnswer>;
  renderAnswer: (
    text: string,
    sources: AiSource[],
    typing: boolean,
  ) => ReactNode;
  /** Uma conversa salva, aberta de novo. */
  initial?: ChatEntry[];
  readOnly?: boolean;
  readOnlyNote?: ReactNode;
  onAnswer?: (answer: AiAnswer) => void;
}) {
  const [turns, setTurns] = useState<ChatEntry[]>(initial ?? []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Acompanha o fim da conversa enquanto a pessoa não rolar para cima.
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  function patchLast(patch: (e: ChatEntry) => ChatEntry) {
    setTurns((t) =>
      t.length && t[t.length - 1].role === "assistant"
        ? [...t.slice(0, -1), patch(t[t.length - 1])]
        : t,
    );
  }
  async function submit(question: string) {
    const q = question.trim();
    if (!q || busy || readOnly) return;
    setError("");
    setBusy(true);
    setDraft("");
    stick.current = true;
    const history = turns
      .filter((t) => !t.streaming && t.content)
      .map(({ role, content }) => ({ role, content }));
    setTurns([
      ...turns,
      { role: "user", content: q },
      { role: "assistant", content: "", steps: [], streaming: true },
    ]);
    let notes = 0;
    try {
      const result = await send(q, history, {
        onStep: (step) =>
          patchLast((e) => {
            const steps = e.steps ?? [];
            const i = steps.findIndex((s) => s.id === step.id);
            return {
              ...e,
              thinking: "",
              steps:
                i >= 0
                  ? steps.map((s, k) => (k === i ? step : s))
                  : [...steps, step],
            };
          }),
        onThinking: (delta) =>
          patchLast((e) => ({
            ...e,
            thinking: ((e.thinking ?? "") + delta).slice(-600),
          })),
        onText: (delta) =>
          patchLast((e) => ({ ...e, content: e.content + delta })),
        // O texto antes das ferramentas vira uma nota de trabalho.
        onRoundEnd: () =>
          patchLast((e) => {
            const note = e.content.replace(/\s+/g, " ").trim();
            return {
              ...e,
              content: "",
              steps: note
                ? [
                    ...(e.steps ?? []),
                    {
                      id: `note-${++notes}`,
                      label:
                        note.length > 200 ? `${note.slice(0, 200)}…` : note,
                      state: "note",
                    },
                  ]
                : e.steps,
            };
          }),
        onWarning: (text) =>
          patchLast((e) => ({ ...e, warnings: [...(e.warnings ?? []), text] })),
      });
      patchLast((e) => ({
        ...e,
        content: result.answer,
        sources: result.sources,
        streaming: false,
        thinking: "",
      }));
      onAnswer?.(result);
    } catch (e) {
      setError((e as Error).message);
      setTurns(turns);
      setDraft(q);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="meeting-chat">
      <div
        ref={log}
        className="meeting-chat-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!turns.length && (
          <div className="meeting-chat-intro">
            <Sparkles size={18} aria-hidden="true" />
            <div>{intro}</div>
            {!readOnly && (
              <div className="meeting-chat-suggestions">
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => void submit(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <p key={i} className="chat-q">
              {t.content}
            </p>
          ) : (
            <div key={i} className="chat-a">
              <Steps
                steps={t.steps ?? []}
                thinking={t.thinking}
                streaming={!!t.streaming}
                writing={!!t.content}
              />
              {t.warnings?.map((w, k) => (
                <p key={k} className="ai-warning">
                  <AlertTriangle size={13} aria-hidden="true" /> {w}
                </p>
              ))}
              {(t.content || !t.streaming) && (
                <Typed
                  text={t.content}
                  streaming={!!t.streaming}
                  render={(text, typing) =>
                    renderAnswer(text, typing ? [] : (t.sources ?? []), typing)
                  }
                />
              )}
            </div>
          ),
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {readOnly ? (
        readOnlyNote && <div className="ai-readonly">{readOnlyNote}</div>
      ) : (
        <form
          className="meeting-chat-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void submit(draft);
          }}
        >
          <textarea
            rows={2}
            value={draft}
            maxLength={2000}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(draft);
              }
            }}
          />
          <button
            type="submit"
            className="btn primary"
            disabled={busy || draft.trim().length < 2}
            aria-label="Perguntar"
          >
            <Send size={15} />
          </button>
        </form>
      )}
    </div>
  );
}

/** Uma conversa salva no formato do chat. */
export function entriesFrom(
  messages: {
    role: "user" | "assistant";
    content: string;
    sources?: AiSource[];
    steps?: { label: string; detail?: string }[];
  }[],
): ChatEntry[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    sources: m.sources ?? [],
    steps: (m.steps ?? []).map((s, i) => ({
      id: `s${i}`,
      label: s.label,
      detail: s.detail,
      state: "done" as const,
    })),
  }));
}

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
  Globe,
  Loader2,
  Megaphone,
  MessageCircle,
  Paperclip,
  Rocket,
  Send,
  Sparkles,
  Square,
  Video,
  X,
  Trophy,
  Wallet,
} from "lucide-react";
import { answerPieces, type ChatTurn } from "./meetings";
import { ARTIFACT_LINE, type AiArtifact } from "./mavi-artifacts";
import { MaviMarkdown } from "./MaviMarkdown";
import { QuestionCard } from "./MaviQuestions";
import {
  cancelRun,
  sourceLabel,
  type AiAnswer,
  type AiSource,
  type AiStep,
  type AiStreamHandlers,
  type TurnCost,
} from "./ai";

/**
 * O chat com a IA, igual em todo o sistema: enquanto a IA trabalha, os
 * passos aparecem um a um (buscando…, lendo…, 8 trechos encontrados), com o
 * resumo do raciocínio; a resposta chega digitando e cita as fontes.
 */

export type ChatEntry = {
  /** A mensagem gravada (as da conversa salva). */
  id?: number;
  role: "user" | "assistant";
  content: string;
  /** O custo desta resposta, por modelo (a que acabou de chegar). */
  cost?: TurnCost;
  sources?: AiSource[];
  steps?: AiStep[];
  thinking?: string;
  warnings?: string[];
  /** Visualizações, imagens e ações (módulo MAVI). */
  artifacts?: AiArtifact[];
  /** Os arquivos anexados nesta pergunta (módulo MAVI; só para mostrar). */
  files?: { id: string; name: string; kind: string }[];
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
  renderArtifact,
  rich = false,
}: {
  text: string;
  onTime?: (seconds: number) => void;
  sources?: AiSource[];
  onSource?: (source: AiSource) => void;
  showSources?: boolean;
  /**
   * Desenha o anexo de uma linha [[V1]] (módulo MAVI). Sem ele, a linha
   * vira um aviso de que o anexo está no módulo.
   */
  renderArtifact?: (ref: string) => ReactNode;
  /** Markdown completo (títulos, tabelas, código): o módulo MAVI. */
  rich?: boolean;
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
  if (rich)
    return (
      <div className="answer-text rich">
        <MaviMarkdown text={text} inline={render} renderArtifact={renderArtifact} />
        {showSources && sources.length > 0 && (
          <AnswerSources sources={sources} onSource={onSource} />
        )}
      </div>
    );
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`l${out.length}`}>{list}</ul>);
    list = [];
  };
  text.split("\n").forEach((raw, i) => {
    const artifact = raw.match(ARTIFACT_LINE);
    // As perguntas (Q1) a bolinha desenha logo abaixo da resposta.
    if (artifact && !renderArtifact && artifact[1].startsWith("Q")) return;
    if (artifact) {
      flush();
      out.push(
        renderArtifact ? (
          <div key={i} className="answer-artifact">
            {renderArtifact(artifact[1])}
          </div>
        ) : (
          <p key={i} className="answer-artifact-note">
            <Sparkles size={12} aria-hidden="true" /> Há um gráfico, uma
            imagem ou uma ação aqui: abra esta conversa no módulo MAVI.
          </p>
        ),
      );
      return;
    }
    // Uma referência no meio da frase não aparece (o anexo tem o seu lugar).
    const line = raw.replace(/\s?\[\[[VIADQT]\d{1,2}\]\]/g, "");
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
        <AnswerSources sources={sources} onSource={onSource} />
      )}
    </div>
  );
}

/** Com mais fontes que isto, a lista abre recolhida (as primeiras e "Ver todas"). */
export const SOURCES_FOLDED = 6;
const SOURCES_SHOWN = 5;

export function AnswerSources({
  sources,
  onSource,
}: {
  sources: AiSource[];
  onSource?: (source: AiSource) => void;
}) {
  const [open, setOpen] = useState(false);
  const folded = sources.length > SOURCES_FOLDED && !open;
  const shown = folded ? sources.slice(0, SOURCES_SHOWN) : sources;
  return (
    <div className="answer-sources">
      <small>Fontes{sources.length > SOURCES_FOLDED ? ` (${sources.length})` : ""}</small>
      <ul>
        {shown.map((s) => (
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
      {sources.length > SOURCES_FOLDED && (
        <button
          type="button"
          className="answer-sources-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight size={12} aria-hidden="true" className={open ? "open" : undefined} />
          {open ? "Mostrar menos" : `Ver todas as ${sources.length} fontes`}
        </button>
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
  case: Trophy,
  whatsapp: MessageCircle,
  web: Globe,
  attachment: Paperclip,
  media: Wallet,
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

/** Esconde o fim ainda incompleto: "[S1" ou "[[V1]" sem fechar, "**" sem par, "*" solto. */
export function hidePartial(text: string) {
  let t = text.replace(/\[\[[VIADQT]?\d{0,2}\]?$/, "").replace(/\[[^\]\n]*$/, "");
  if ((t.match(/\*\*/g) ?? []).length % 2) t = t.slice(0, t.lastIndexOf("**"));
  return t.replace(/(^|[^*])\*$/, "$1");
}

export function Typed({
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

export function Steps({
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
        <ChevronRight size={13} aria-hidden="true" /> Como a MAVI chegou à
        resposta · {tools} {tools === 1 ? "passo" : "passos"}
      </summary>
      {list}
    </details>
  );
}

// ------------------------------------------------------------ chat
export type AiSend = (
  question: string,
  history: ChatTurn[],
  handlers: AiStreamHandlers,
  /** O que vai junto com a pergunta (ex.: a ação confirmada no card) e o sinal para soltar a conexão. */
  extra?: {
    confirm?: string;
    signal?: AbortSignal;
    /** Os anexos desta pergunta (ids) e como aparecem na mensagem. */
    attachments?: string[];
    files?: { id: string; name: string; kind: string }[];
  },
) => Promise<AiAnswer>;

/**
 * A conversa em andamento: a pergunta, os passos e a resposta chegando.
 * O balão e o módulo MAVI desenham a mesma conversa de jeitos diferentes.
 */
export function useAiTurns({
  initial,
  send,
  readOnly,
  onAnswer,
  onRun,
}: {
  initial?: ChatEntry[];
  send: AiSend;
  readOnly?: boolean;
  onAnswer?: (answer: AiAnswer, question: string) => void;
  /** A resposta começou no servidor (a conversa em que ela fica). */
  onRun?: (run: { id: string; conversation: string }, question: string) => void;
}) {
  const [turns, setTurns] = useState<ChatEntry[]>(initial ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  // A resposta em andamento: a conexão (para soltar) e a execução (para parar).
  const current = useRef<{ controller: AbortController; run: string | null; stop: boolean } | null>(null);
  // Saiu da tela no meio da resposta: solta a conexão; o servidor continua e avisa.
  useEffect(() => () => current.current?.controller.abort(), []);

  /** Parar: pede ao servidor (a conversa fica com o que já chegou) e solta a conexão. */
  async function stop() {
    const c = current.current;
    if (!c || c.stop) return;
    c.stop = true;
    setStopping(true);
    // Sem o id ainda (acabou de perguntar), para quando ele chegar.
    if (!c.run) {
      setTimeout(() => {
        if (current.current === c && !c.run) c.controller.abort();
      }, 2500);
      return;
    }
    await cancelRun(c.run).catch(() => null);
    c.controller.abort();
  }

  function patchLast(patch: (e: ChatEntry) => ChatEntry) {
    setTurns((t) =>
      t.length && t[t.length - 1].role === "assistant"
        ? [...t.slice(0, -1), patch(t[t.length - 1])]
        : t,
    );
  }
  /** Faz a pergunta; false quando não foi (para devolver o texto à caixa). */
  async function submit(question: string, extra?: Omit<NonNullable<Parameters<AiSend>[3]>, "signal">) {
    const q = question.trim();
    if (!q || busy || readOnly) return false;
    setError("");
    setBusy(true);
    const history = turns
      .filter((t) => !t.streaming && t.content)
      .map(({ role, content }) => ({ role, content }));
    setTurns([
      ...turns,
      { role: "user", content: q, ...(extra?.files?.length ? { files: extra.files } : {}) },
      { role: "assistant", content: "", steps: [], streaming: true },
    ]);
    let notes = 0;
    const run: NonNullable<typeof current.current> = { controller: new AbortController(), run: null, stop: false };
    current.current = run;
    try {
      const result = await send(
        q,
        history,
        {
        onRun: (r) => {
          run.run = r.id;
          onRun?.(r, q);
          // Pediu para parar antes de a execução existir.
          if (run.stop) void cancelRun(r.id).catch(() => null).finally(() => run.controller.abort());
        },
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
        onArtifact: (artifact) =>
          patchLast((e) => ({
            ...e,
            artifacts: [...(e.artifacts ?? []), artifact],
          })),
        },
        { ...extra, signal: run.controller.signal },
      );
      patchLast((e) => ({
        ...e,
        content: result.answer,
        sources: result.sources,
        artifacts: result.artifacts?.length ? result.artifacts : e.artifacts,
        ...(result.cost ? { cost: result.cost } : {}),
        ...(result.message ? { id: result.message } : {}),
        streaming: false,
        thinking: "",
      }));
      onAnswer?.(result, q);
      return true;
    } catch (e) {
      // Parou: fica o que já tinha chegado (o servidor guarda igual).
      if (run.stop) {
        patchLast((x) => ({
          ...x,
          content: `${x.content.trim() ? `${x.content.trim()}\n\n` : ""}*(Resposta interrompida por você.)*`,
          streaming: false,
          thinking: "",
        }));
        return true;
      }
      // Saiu da tela: nada a mostrar (a resposta segue no servidor).
      if (run.controller.signal.aborted) return true;
      setError((e as Error).message);
      setTurns(turns);
      return false;
    } finally {
      if (current.current === run) current.current = null;
      setStopping(false);
      setBusy(false);
    }
  }
  return { turns, busy, error, submit, stop, stopping };
}

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
  onRun,
}: {
  intro: ReactNode;
  placeholder: string;
  suggestions: string[];
  /** Faz a pergunta, repassando os eventos do trabalho da IA. */
  send: AiSend;
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
  /** A resposta começou no servidor (a conversa já existe). */
  onRun?: (run: { id: string; conversation: string }) => void;
}) {
  const chat = useAiTurns({ initial, send, readOnly, onAnswer, onRun });
  const { turns, busy, error } = chat;
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Acompanha o fim da conversa enquanto a pessoa não rolar para cima.
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  async function submit(question: string) {
    if (!question.trim() || busy || readOnly) return;
    setDraft("");
    stick.current = true;
    if (!(await chat.submit(question))) setDraft(question.trim());
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
              {t.artifacts?.map((a) =>
                a.type === "question" ? (
                  <QuestionCard
                    key={a.id}
                    artifact={a}
                    answered={i < turns.length - 1}
                    disabled={!!readOnly || busy}
                    onReply={(text) => void submit(text)}
                  />
                ) : null,
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
          {busy ? (
            <button
              type="button"
              className="btn secondary ai-stop"
              disabled={chat.stopping}
              onClick={() => void chat.stop()}
              aria-label="Parar a resposta"
              title="Parar a resposta"
            >
              {chat.stopping ? <Loader2 size={15} className="spin" /> : <Square size={13} fill="currentColor" />}
            </button>
          ) : (
            <button
              type="submit"
              className="btn primary"
              disabled={draft.trim().length < 2}
              aria-label="Perguntar"
            >
              <Send size={15} />
            </button>
          )}
        </form>
      )}
    </div>
  );
}

/** Uma conversa salva no formato do chat. */
export function entriesFrom(
  messages: {
    id?: number;
    role: "user" | "assistant";
    content: string;
    sources?: AiSource[];
    steps?: { label: string; detail?: string }[];
    artifacts?: AiArtifact[];
  }[],
): ChatEntry[] {
  return messages.map((m) => ({
    ...(typeof m.id === "number" ? { id: m.id } : {}),
    role: m.role,
    content: m.content,
    sources: m.sources ?? [],
    artifacts: m.artifacts ?? [],
    steps: (m.steps ?? []).map((s, i) => ({
      id: `s${i}`,
      label: s.label,
      detail: s.detail,
      state: "done" as const,
    })),
  }));
}

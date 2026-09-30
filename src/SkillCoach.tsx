import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { Button, Textarea } from "./ui";
import {
  CHECK_KINDS,
  VERDICTS,
  applyCheck,
  applyCoach,
  coachSkill,
  type CheckItem,
  type CheckUndo,
  type CoachMessage,
  type CoachReply,
  type SkillCheck,
  type SkillDraft,
} from "./mavi-skills";

const TARGETS: Record<CheckItem["target"], string> = {
  name: "Nome",
  description: "Quando usar",
  instructions: "Instruções",
  file: "Arquivo",
};
const SEVERITY: Record<CheckItem["severity"], string> = {
  high: "Importante",
  medium: "Recomendado",
  low: "Acabamento",
};
const clip = (s: string, n = 420) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

// ------------------------------------------------------------ validador
/**
 * O que a MAVI achou da skill: o veredito e os pontos (incluir, corrigir,
 * alterar, melhorar, remover), cada um com o texto pronto e "Aplicar" quando
 * dá. Skill boa aparece como "Muito boa", sem lista. Só orienta: nada trava.
 */
export function SkillCheckPanel({
  check,
  loading,
  error,
  stale,
  draft,
  applied,
  onApply,
  onUndo,
  onRecheck,
  submitting,
  onSendAnyway,
  onClose,
  readOnly = false,
}: {
  check: SkillCheck | null;
  loading: boolean;
  error: string;
  /** A skill mudou depois da revisão. */
  stale: boolean;
  draft: SkillDraft;
  applied: Map<string, CheckUndo>;
  onApply?: (item: CheckItem) => void;
  onUndo?: (id: string) => void;
  onRecheck: () => void;
  /** A revisão veio do "Enviar": a pessoa decide se envia assim mesmo. */
  submitting?: { label: string; busy: boolean } | null;
  onSendAnyway?: () => void;
  onClose?: () => void;
  readOnly?: boolean;
}) {
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  useEffect(() => setIgnored(new Set()), [check]);
  const shown = check?.items.filter((i) => !ignored.has(i.id)) ?? [];
  const ready = shown.filter((i) => !applied.has(i.id) && !!applyCheck(draft, i));
  return (
    <section
      className={`panel skill-check ${check ? `verdict-${check.verdict}` : ""}`}
      aria-label="Revisão da MAVI"
      aria-busy={loading || undefined}
    >
      <header>
        <ShieldCheck size={17} aria-hidden="true" />
        <strong>Revisão da MAVI</strong>
        {check && !loading && <span className="skill-check-verdict">{VERDICTS[check.verdict]}</span>}
        <span className="skill-check-tools">
          <Button className="btn secondary" onClick={onRecheck} loading={loading}>
            <RefreshCw size={14} /> {check ? "Validar de novo" : "Validar"}
          </Button>
          {onClose && (
            <button type="button" className="icon-btn" aria-label="Fechar a revisão" onClick={onClose}>
              <X size={15} />
            </button>
          )}
        </span>
      </header>
      {loading && (
        <p className="skill-check-wait">
          <Sparkles size={15} aria-hidden="true" /> A MAVI está lendo a skill inteira (nome, quando usar,
          instruções e arquivos)…
        </p>
      )}
      {error && !loading && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {check && !loading && (
        <>
          <p className="skill-check-summary">
            {check.verdict === "great" ? (
              <CheckCircle2 size={16} aria-hidden="true" />
            ) : (
              <AlertTriangle size={16} aria-hidden="true" />
            )}
            <span>{check.summary}</span>
          </p>
          {stale && (
            <p className="skill-check-stale">
              A skill mudou depois desta revisão. Valide de novo para ver como ficou.
            </p>
          )}
          {!!shown.length && (
            <ol className="skill-check-items">
              {shown.map((item) => {
                const done = applied.has(item.id);
                const can = !readOnly && !done && !!applyCheck(draft, item);
                return (
                  <li key={item.id} className={`sev-${item.severity}${done ? " applied" : ""}`}>
                    <div className="skill-check-tags">
                      <span className={`skill-check-kind kind-${item.kind}`}>{CHECK_KINDS[item.kind]}</span>
                      <small>
                        {TARGETS[item.target]}
                        {item.file ? ` · ${item.file}` : ""} · {SEVERITY[item.severity]}
                      </small>
                    </div>
                    <strong>{item.title}</strong>
                    {item.why && <p>{item.why}</p>}
                    <CheckPreview item={item} draft={draft} was={applied.get(item.id)} />
                    {!readOnly && (
                      <span className="skill-check-actions">
                        {done ? (
                          <>
                            <span className="skill-check-done">
                              <Check size={14} /> Aplicado
                            </span>
                            <button type="button" className="skill-link" onClick={() => onUndo?.(item.id)}>
                              <Undo2 size={13} /> Desfazer
                            </button>
                          </>
                        ) : can ? (
                          <>
                            <Button className="btn primary" onClick={() => onApply?.(item)}>
                              <Check size={14} /> Aplicar
                            </Button>
                            <button
                              type="button"
                              className="skill-link"
                              onClick={() => setIgnored((s) => new Set(s).add(item.id))}
                            >
                              Ignorar
                            </button>
                          </>
                        ) : (
                          <small className="muted">
                            {item.after || item.before
                              ? "O trecho mudou desde a revisão: ajuste à mão ou valide de novo."
                              : "Este ponto depende de você: ajuste à mão."}
                          </small>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {!readOnly && ready.length > 1 && (
            <Button
              className="btn secondary skill-check-all"
              onClick={() => {
                // Um de cada vez, na ordem: cada um lê a skill já com o anterior.
                for (const item of ready) onApply?.(item);
              }}
            >
              <Check size={14} /> Aplicar os {ready.length} com texto pronto
            </Button>
          )}
          <small className="skill-check-model">Revisado com {check.model}. A MAVI só sugere: você decide.</small>
        </>
      )}
      {submitting && !loading && (
        <footer className="skill-check-send">
          <span>
            {check?.verdict === "great"
              ? "Tudo certo para enviar."
              : "Quer ajustar antes ou enviar assim mesmo? Dá para mudar depois numa versão nova."}
          </span>
          <Button className="btn primary" onClick={onSendAnyway} loading={submitting.busy}>
            <Check size={15} /> {check?.verdict === "great" ? submitting.label : `${submitting.label} assim mesmo`}
          </Button>
        </footer>
      )}
    </section>
  );
}

function CheckPreview({ item, draft, was }: { item: CheckItem; draft: SkillDraft; was?: CheckUndo }) {
  if (item.target === "name" || item.target === "description") {
    if (!item.after) return null;
    // Aplicado: o que saiu é o de antes, não o campo de agora.
    const before = was && was.target === item.target ? was.value : draft[item.target];
    return (
      <div className="skill-check-diff">
        <del>{clip(before || "(vazio)")}</del>
        <ins>{clip(item.after)}</ins>
      </div>
    );
  }
  if (item.target === "file" && item.kind === "remove" && !item.before)
    return <div className="skill-check-diff"><del>Arquivo {item.file}</del></div>;
  if (!item.before && !item.after) return null;
  const isNewFile = item.target === "file" && !draft.files.some((f) => f.name === item.file);
  return (
    <details className="skill-check-diff">
      <summary>{isNewFile ? `Ver o arquivo novo ${item.file}` : item.before ? "Ver a troca" : "Ver o texto que entra"}</summary>
      {item.before && <del>{clip(item.before, 1200)}</del>}
      {item.after ? <ins>{clip(item.after, 2400)}</ins> : item.before ? <small className="muted">(sai o trecho)</small> : null}
    </details>
  );
}

// ------------------------------------------------------------ assistente
type Bubble = {
  role: "user" | "assistant";
  content: string;
  question?: CoachReply["question"];
  /** O que o assistente mudou na skill nesta mensagem. */
  changed?: string[];
};

const START_NEW: Bubble = {
  role: "assistant",
  content:
    "Oi! Eu te ajudo a criar a skill: você me conta como faz o trabalho e eu escrevo tudo nos campos da skill. Pode responder do seu jeito, sem termos técnicos.",
  question: {
    text: "Que trabalho você quer que eu faça sempre do seu jeito?",
    options: [
      "Relatório para o cliente",
      "Post ou arte para redes sociais",
      "Planejamento ou estratégia",
      "Análise de campanhas",
      "Texto, e-mail ou roteiro",
    ],
    multiple: false,
  },
};
const START_EDIT: Bubble = {
  role: "assistant",
  content: "Vamos melhorar esta skill? Me conte o que não está saindo como você queria, ou escolha abaixo.",
  question: {
    text: "O que você quer mudar?",
    options: [
      "Deixar as instruções mais claras",
      "A MAVI não usa quando devia",
      "Mudar o formato do resultado",
      "Ficou longa demais",
    ],
    multiple: false,
  },
};

/** O que mudou, em palavras. */
function changes(before: SkillDraft, after: SkillDraft) {
  const out: string[] = [];
  if (before.name !== after.name) out.push("nome");
  if (before.description !== after.description) out.push("quando usar");
  if (before.instructions !== after.instructions) out.push("instruções");
  const names = (d: SkillDraft) => JSON.stringify(d.files.map((f) => [f.name, f.content]));
  if (names(before) !== names(after)) out.push("arquivos");
  return out;
}

/**
 * O assistente de quem cria: a MAVI entrevista (uma pergunta por vez, com
 * opções) e vai escrevendo a skill nos campos ao lado. Cada mudança dela dá
 * para desfazer; o que a pessoa escreve à mão vale (vai junto em cada
 * mensagem).
 */
export function SkillAssistant({
  company,
  draft,
  isNew,
  autoSlug,
  onDraft,
  onClose,
}: {
  company: string;
  draft: SkillDraft;
  isNew: boolean;
  /** O identificador acompanha o nome (skill nova, sem mexer à mão). */
  autoSlug: boolean;
  onDraft: (next: SkillDraft) => void;
  onClose: () => void;
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>([isNew && !draft.instructions.trim() ? START_NEW : START_EDIT]);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<SkillDraft[]>([]);
  const [ready, setReady] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [bubbles, busy]);

  async function send(content: string) {
    const say = content.trim();
    if (!say || busy) return;
    setError("");
    setText("");
    setPicked([]);
    const next: Bubble[] = [...bubbles, { role: "user", content: say }];
    setBubbles(next);
    setBusy(true);
    try {
      // A pergunta e as opções vão junto: a MAVI sabe o que perguntou.
      const messages: CoachMessage[] = next.map((b) => ({
        role: b.role,
        content: b.question
          ? `${b.content}\n\n${b.question.text}${b.question.options.length ? ` (opções: ${b.question.options.join("; ")})` : ""}`
          : b.content,
      }));
      const r = await coachSkill(company, messages, latest.current);
      const before = latest.current;
      const after = applyCoach(before, r, autoSlug);
      const changed = changes(before, after);
      if (changed.length) {
        setHistory((h) => [...h, before]);
        onDraft(after);
      }
      setReady(r.ready);
      setBubbles((b) => [...b, { role: "assistant", content: r.reply, question: r.question, changed }]);
    } catch (e) {
      setError((e as Error).message);
      setBubbles((b) => b.slice(0, -1));
      setText(say);
    } finally {
      setBusy(false);
    }
  }
  function undo() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    onDraft(prev);
    setBubbles((b) => [...b, { role: "assistant", content: "Desfiz a minha última mudança na skill." }]);
  }
  const last = bubbles[bubbles.length - 1];
  const question = last.role === "assistant" && !busy ? last.question : undefined;
  return (
    <aside className="panel skill-coach" aria-label="Criar com a MAVI">
      <header>
        <Sparkles size={17} aria-hidden="true" />
        <div>
          <strong>Criar com a MAVI</strong>
          <small>Ela pergunta e escreve a skill nos campos.</small>
        </div>
        <button type="button" className="icon-btn" aria-label="Fechar o assistente" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <ol className="skill-coach-list" ref={list} aria-live="polite">
        {bubbles.map((b, i) => (
          <li key={i} className={`skill-coach-msg ${b.role}`}>
            <p>{b.content}</p>
            {b.question && <p className="skill-coach-q">{b.question.text}</p>}
            {!!b.changed?.length && (
              <small className="skill-coach-changed">
                <Check size={12} /> Atualizei: {b.changed.join(", ")}.
              </small>
            )}
          </li>
        ))}
        {busy && (
          <li className="skill-coach-msg assistant typing">
            <span />
            <span />
            <span />
          </li>
        )}
      </ol>
      {question && !!question.options.length && (
        <div className="skill-coach-options" role="group" aria-label={question.text}>
          {question.options.map((o) =>
            question.multiple ? (
              <button
                key={o}
                type="button"
                aria-pressed={picked.includes(o)}
                className={picked.includes(o) ? "on" : ""}
                onClick={() => setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))}
              >
                {o}
              </button>
            ) : (
              <button key={o} type="button" onClick={() => void send(o)}>
                {o}
              </button>
            ),
          )}
          {question.multiple && !!picked.length && (
            <Button className="btn primary" onClick={() => void send(picked.join("; "))}>
              <Send size={13} /> Enviar {picked.length}
            </Button>
          )}
        </div>
      )}
      {ready && !busy && (
        <p className="skill-coach-ready">
          <CheckCircle2 size={15} aria-hidden="true" /> A skill está pronta para usar. Confira os campos e envie
          — a revisão de qualidade roda na hora. Ainda dá para pedir ajustes aqui.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="skill-coach-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <Textarea
          rows={2}
          value={text}
          maxLength={4000}
          placeholder={question ? "Responda aqui, com as suas palavras…" : "Peça um ajuste ou conte mais…"}
          aria-label="Mensagem para a MAVI"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <Button className="btn primary" type="submit" loading={busy} disabled={!text.trim()} aria-label="Enviar">
          <Send size={15} />
        </Button>
      </form>
      {!!history.length && !busy && (
        <button type="button" className="skill-link skill-coach-undo" onClick={undo}>
          <Undo2 size={13} /> Desfazer a última mudança da MAVI
        </button>
      )}
    </aside>
  );
}

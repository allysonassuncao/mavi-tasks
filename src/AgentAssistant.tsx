import { useEffect, useRef, useState } from "react";
import { Check, Paperclip, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { Button, Checkbox, Textarea } from "./ui";
import {
  agentOp,
  askBuilderMavi,
  errorOf,
  fileBase64,
  KIND_LABEL,
  uploadKnowledgeFile,
  type AgentDraft,
  type MaviProposal,
  type MaviQuestion,
} from "./agent-builder";

/**
 * Agentes MAVI › a MAVI monta o agente: a conversa ao lado do construtor.
 * Ela entrevista com perguntas de opções, lê o site, os arquivos enviados e o
 * prompt do n8n, e propõe mudanças com o antes e o depois. Nada muda sem
 * Aplicar; aplicar salva o rascunho e cria os itens da base.
 */

type Turn =
  | { role: "user"; text: string; files?: string[] }
  | {
      role: "assistant";
      text: string;
      questions: MaviQuestion[];
      proposal: MaviProposal | null;
      /** O que aconteceu com a proposta (vai para a MAVI na próxima vez). */
      status?: "applied" | "partial" | "dismissed";
      error?: boolean;
    };

const MAX_TOTAL = 3.2 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.txt,.md,.csv";
const storeKey = (agent: string) => `ab-mavi:${agent}`;

function loadTurns(agent: string): Turn[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(agent)) ?? "[]");
    return Array.isArray(v) ? v.slice(-60) : [];
  } catch {
    return [];
  }
}
function saveTurns(agent: string, turns: Turn[]) {
  try {
    localStorage.setItem(storeKey(agent), JSON.stringify(turns.slice(-60)));
  } catch {
    /* sem armazenamento: a conversa vale só nesta aba */
  }
}

/** O histórico em texto para a MAVI (com o que foi feito das propostas). */
function toMessages(turns: Turn[]) {
  return turns
    .filter((t) => !(t.role === "assistant" && t.error))
    .map((t) =>
      t.role === "user"
        ? { role: "user" as const, content: `${t.text}${t.files?.length ? `\n(anexos: ${t.files.join(", ")})` : ""}` }
        : {
            role: "assistant" as const,
            content: [
              t.text,
              t.questions.length ? `Perguntas: ${t.questions.map((q) => `${q.text} [${q.options.join(" / ")}]`).join(" | ")}` : "",
              t.proposal
                ? `[Proposta: ${t.proposal.summary || "mudanças"} — ${t.proposal.fields.map((f) => f.path).join(", ")}${t.proposal.knowledge.length ? `; ${t.proposal.knowledge.length} itens da base` : ""}. ${
                    t.status === "applied" ? "A pessoa aplicou." : t.status === "partial" ? "A pessoa aplicou parte." : t.status === "dismissed" ? "A pessoa descartou." : "Ainda não aplicada."
                  }]`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
    );
}

export function AgentAssistant({
  company,
  agentId,
  draft,
  applyFields,
  onKnowledgeChanged,
  notify,
  onClose,
}: {
  company: string;
  agentId: string;
  draft: AgentDraft;
  /** Aplica no rascunho e salva. */
  applyFields: (changes: { path: string; value: unknown }[]) => Promise<boolean>;
  onKnowledgeChanged: () => void;
  notify: (m: string) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(agentId));
  const [text, setText] = useState("");
  const [pending, setPending] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const held = useRef(new Map<string, File>());
  const end = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  useEffect(() => saveTurns(agentId, turns), [agentId, turns]);
  // A bolinha da MAVI cobriria o envio desta conversa: some enquanto ela está aberta.
  useEffect(() => {
    document.body.classList.add("ab-assistant-open");
    return () => document.body.classList.remove("ab-assistant-open");
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns, busy]);

  const send = async (message: string, files: File[] = [], base: Turn[] = turns) => {
    if (busy) return;
    const history: Turn[] = message ? [...base, { role: "user", text: message, files: files.map((f) => f.name) }] : base;
    setTurns(history);
    setText("");
    setPending([]);
    setBusy(true);
    try {
      const attachments = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type, data: await fileBase64(f) })));
      files.forEach((f) => held.current.set(f.name, f));
      const r = await askBuilderMavi({
        company,
        agent: agentId,
        messages: toMessages(history),
        draft,
        attachments,
        files: [...held.current.keys()],
      });
      setTurns((t) => [...t, { role: "assistant", text: r.message, questions: r.questions, proposal: r.proposal }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", text: errorOf(e), questions: [], proposal: null, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  // Abriu sem conversa: a MAVI começa a entrevista.
  useEffect(() => {
    if (started.current || turns.length) return;
    started.current = true;
    void send("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setStatus = (i: number, status: "applied" | "partial" | "dismissed") =>
    setTurns((t) => t.map((x, j) => (j === i && x.role === "assistant" ? { ...x, status } : x)));

  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");

  return (
    <aside className="ab-assistant" aria-label="Montar com a MAVI">
      <header className="ab-assistant-head">
        <span className="ab-assistant-title">
          <Sparkles size={16} aria-hidden="true" /> Montar com a MAVI
        </span>
        <span className="ab-assistant-actions">
          <button
            type="button"
            className="agent-link-btn"
            title="Começar de novo"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Começar uma conversa nova com a MAVI? O rascunho não muda.")) return;
              held.current.clear();
              started.current = true;
              void send("", [], []);
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <button type="button" className="agent-link-btn" aria-label="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </span>
      </header>

      <div className="ab-assistant-body" aria-live="polite">
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="ab-msg user">
              {t.text}
              {t.files?.length ? <span className="ab-msg-files">📎 {t.files.join(", ")}</span> : null}
            </div>
          ) : (
            <div key={i} className={`ab-msg mavi ${t.error ? "error" : ""}`}>
              <p>{t.text}</p>
              {t.proposal && (
                <ProposalCard
                  proposal={t.proposal}
                  status={t.status}
                  onDismiss={() => setStatus(i, "dismissed")}
                  onApply={async (fields, items) => {
                    let ok = true;
                    if (fields.length) ok = await applyFields(fields.map((f) => ({ path: f.path, value: f.value })));
                    let added = 0;
                    for (const k of items) {
                      try {
                        if (k.kind === "file") {
                          const file = k.file ? held.current.get(k.file) : undefined;
                          if (!file) throw new Error(`O arquivo "${k.file}" não está mais aqui. Anexe de novo.`);
                          await uploadKnowledgeFile(company, agentId, file, { kind: "document", title: k.title });
                        } else await agentOp(company, agentId, "knowledge-add", { item: k.item });
                        added++;
                      } catch (e) {
                        ok = false;
                        notify(errorOf(e));
                      }
                    }
                    if (added) onKnowledgeChanged();
                    const all = fields.length + items.length === t.proposal!.fields.length + t.proposal!.knowledge.length;
                    setStatus(i, ok && all ? "applied" : "partial");
                    notify(
                      [fields.length ? `${fields.length} ${fields.length === 1 ? "campo" : "campos"} no rascunho` : "", added ? `${added} ${added === 1 ? "item" : "itens"} na base` : ""]
                        .filter(Boolean)
                        .join(" e ") + " — aplicado.",
                    );
                  }}
                />
              )}
              {t === lastAssistant && !busy && t.questions.length > 0 && <Questions questions={t.questions} onAnswer={(a) => void send(a)} />}
            </div>
          ),
        )}
        {busy && (
          <div className="ab-msg mavi typing" aria-label="A MAVI está pensando">
            <span />
            <span />
            <span />
          </div>
        )}
        <div ref={end} />
      </div>

      <form
        className="ab-assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() || pending.length) void send(text.trim() || "Segue o arquivo.", pending);
        }}
      >
        {pending.length > 0 && (
          <div className="ab-suggest">
            {pending.map((f) => (
              <span key={f.name} className="ab-chip on">
                📎 {f.name}
                <button type="button" aria-label={`Tirar ${f.name}`} onClick={() => setPending((p) => p.filter((x) => x !== f))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <Textarea
          value={text}
          rows={2}
          maxLength={6000}
          placeholder="Responda, cole o site do cliente ou peça um ajuste…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="ab-assistant-tools">
          <button type="button" className="agent-link-btn" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Paperclip size={14} aria-hidden="true" /> Anexar
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept={ACCEPT}
            onChange={(e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = "";
              const total = [...pending, ...list].reduce((s, f) => s + f.size, 0);
              if (total > MAX_TOTAL) {
                notify("Até 3 MB por vez na conversa. Para arquivos maiores, use Conhecimento › Arquivo.");
                return;
              }
              setPending((p) => [...p, ...list].slice(0, 5));
            }}
          />
          <Button type="submit" className="btn primary compact" disabled={busy || (!text.trim() && !pending.length)} aria-label="Enviar">
            <Send size={15} aria-hidden="true" />
          </Button>
        </div>
      </form>
    </aside>
  );
}

function Questions({ questions, onAnswer }: { questions: MaviQuestion[]; onAnswer: (text: string) => void }) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const single = questions.length === 1 && !questions[0]!.multiple;
  const toggle = (i: number, o: string, multiple: boolean) =>
    setPicked((p) => {
      const cur = p[i] ?? [];
      return { ...p, [i]: multiple ? (cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]) : [o] };
    });
  const ready = questions.some((_, i) => picked[i]?.length);
  return (
    <div className="ab-questions">
      {questions.map((q, i) => (
        <div key={i} className="ab-question">
          <strong>{q.text}</strong>
          {q.options.length > 0 && (
            <div className="ab-suggest">
              {q.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={`ab-chip ${picked[i]?.includes(o) ? "on" : ""}`}
                  onClick={() => (single ? onAnswer(o) : toggle(i, o, q.multiple))}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {!single && questions.some((q) => q.options.length) && (
        <Button
          type="button"
          className="btn secondary compact"
          disabled={!ready}
          onClick={() =>
            onAnswer(
              questions
                .map((q, i) => (picked[i]?.length ? `${q.text} ${picked[i]!.join(", ")}` : ""))
                .filter(Boolean)
                .join("\n"),
            )
          }
        >
          Responder
        </Button>
      )}
      <small className="ab-hint">Clique numa opção ou escreva do seu jeito abaixo.</small>
    </div>
  );
}

function ProposalCard({
  proposal,
  status,
  onApply,
  onDismiss,
}: {
  proposal: MaviProposal;
  status?: "applied" | "partial" | "dismissed";
  onApply: (fields: MaviProposal["fields"], knowledge: MaviProposal["knowledge"]) => Promise<void>;
  onDismiss: () => void;
}) {
  const [fieldOn, setFieldOn] = useState(() => proposal.fields.map(() => true));
  const [itemOn, setItemOn] = useState(() => proposal.knowledge.map(() => true));
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const done = !!status;
  const count = fieldOn.filter(Boolean).length + itemOn.filter(Boolean).length;
  return (
    <div className={`ab-proposal ${done ? "done" : ""}`}>
      <div className="ab-proposal-head">
        <strong>{proposal.summary || "Proposta"}</strong>
        {status && (
          <span className={`ab-badge ${status === "dismissed" ? "" : "on"}`}>
            {status === "applied" ? "Aplicada" : status === "partial" ? "Aplicada em parte" : "Descartada"}
          </span>
        )}
      </div>
      {proposal.fields.length > 0 && (
        <ul className="ab-proposal-list">
          {proposal.fields.map((f, i) => (
            <li key={f.path}>
              <Checkbox
                checked={fieldOn[i]}
                disabled={done}
                aria-label={f.label}
                onCheckedChange={(c) => setFieldOn((x) => x.map((v, j) => (j === i ? c === true : v)))}
              />
              <div className="ab-proposal-item" onClick={() => setOpen(open === i ? null : i)}>
                <span className="ab-proposal-label">{f.label}</span>
                <span className={`ab-proposal-diff ${open === i ? "open" : ""}`}>
                  {f.before !== "(padrão)" && <del>{f.before}</del>}
                  <ins>{f.after}</ins>
                </span>
                {f.why && <small className="ab-hint">{f.why}</small>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {proposal.knowledge.length > 0 && (
        <>
          <span className="ab-hint">Para a base de conhecimento:</span>
          <ul className="ab-proposal-list">
            {proposal.knowledge.map((k, i) => (
              <li key={i}>
                <Checkbox
                  checked={itemOn[i]}
                  disabled={done}
                  aria-label={k.title}
                  onCheckedChange={(c) => setItemOn((x) => x.map((v, j) => (j === i ? c === true : v)))}
                />
                <div className="ab-proposal-item">
                  <span className="ab-proposal-label">
                    {k.kind === "file" ? "Arquivo" : k.kind === "document" ? "Página" : KIND_LABEL[k.kind]}: {k.title}
                  </span>
                  <span className="ab-proposal-diff">{k.preview}</span>
                  {k.why && <small className="ab-hint">{k.why}</small>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {proposal.skipped.length > 0 && <small className="ab-hint">Deixei de fora: {proposal.skipped.join("; ")}.</small>}
      {!done && (
        <div className="ab-proposal-actions">
          <Button type="button" className="btn secondary compact" disabled={busy} onClick={onDismiss}>
            Descartar
          </Button>
          <Button
            type="button"
            className="btn primary compact"
            loading={busy}
            disabled={!count}
            onClick={() => {
              setBusy(true);
              void onApply(
                proposal.fields.filter((_, i) => fieldOn[i]),
                proposal.knowledge.filter((_, i) => itemOn[i]),
              ).finally(() => setBusy(false));
            }}
          >
            <Check size={14} aria-hidden="true" /> Aplicar {count === proposal.fields.length + proposal.knowledge.length ? "tudo" : `${count}`}
          </Button>
        </div>
      )}
    </div>
  );
}

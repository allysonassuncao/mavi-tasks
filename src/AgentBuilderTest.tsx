import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Send, TriangleAlert } from "lucide-react";
import { Modal } from "./components";
import { Button, Loading, Select, SelectOption, Textarea } from "./ui";
import {
  agentOp,
  errorOf,
  usd,
  when,
  type AgentConversation,
  type ChatMessage,
  type SimulateResult,
  type TurnTrace,
  type UsageDay,
} from "./agent-builder";

/**
 * Testar: conversa com o agente como se fosse um lead, sem enviar nada ao
 * WhatsApp. Cada resposta mostra o que aconteceu por dentro (trechos da base,
 * ferramentas, modelo, custo e tempo). Conversas: as reais, com o mesmo rastro.
 */

type Bubble =
  | { role: "user"; text: string }
  | { role: "assistant"; texts: string[]; trace: TurnTrace | null; handoff?: string; silent?: string; error?: string };

const TOOL_LABEL: Record<string, string> = {
  responder: "Respondeu",
  buscar_conhecimento: "Pesquisou na base",
  registrar_dados_do_contato: "Guardou dados do contato",
  transferir_para_humano: "Passou para a equipe",
};
const KIND: Record<string, string> = {
  faq: "pergunta",
  product: "produto",
  document: "documento",
  media: "mídia",
  example: "exemplo",
  text: "texto",
};
const seconds = (ms?: number) => (ms == null ? "—" : `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`);

export function TraceDetails({ trace }: { trace: TurnTrace }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ab-trace">
      <button type="button" className="ab-trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {usd(trace.cost_usd)} · {seconds(trace.timings.total)} · {trace.retrieved.length} trechos
        {trace.tools.filter((t) => t.name !== "responder").length ? ` · ${trace.tools.filter((t) => t.name !== "responder").length} ações` : ""}
      </button>
      {open && (
        <dl className="ab-trace-body">
          <dt>Modelo</dt>
          <dd>
            {trace.model ?? "—"} · {trace.rounds} {trace.rounds === 1 ? "rodada" : "rodadas"}
          </dd>
          <dt>Tokens</dt>
          <dd>
            {trace.tokens_in.toLocaleString("pt-BR")} de entrada ({trace.tokens_cached.toLocaleString("pt-BR")} em cache) ·{" "}
            {trace.tokens_out.toLocaleString("pt-BR")} de saída
          </dd>
          <dt>Tempo</dt>
          <dd>
            busca {seconds(trace.timings.retrieval)} · mídia {seconds(trace.timings.media)} · IA {seconds(trace.timings.llm)}
            {trace.timings.send ? ` · envio ${seconds(trace.timings.send)}` : ""}
          </dd>
          {trace.retrieved.length > 0 && (
            <>
              <dt>Da base</dt>
              <dd>
                <ul>
                  {trace.retrieved.map((r, i) => (
                    <li key={`${r.ref}-${i}`}>
                      <code>{r.ref}</code> {KIND[r.kind] ?? r.kind}: {r.title || "(sem título)"}
                      {r.via === "tool" ? " — pesquisado pelo agente" : ""}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {trace.tools.filter((t) => t.name !== "responder").length > 0 && (
            <>
              <dt>Ações</dt>
              <dd>
                <ul>
                  {trace.tools
                    .filter((t) => t.name !== "responder")
                    .map((t, i) => (
                      <li key={i}>
                        {TOOL_LABEL[t.name] ?? t.name}
                        {t.args ? `: ${JSON.stringify(t.args)}` : ""}
                      </li>
                    ))}
                </ul>
              </dd>
            </>
          )}
          {trace.error && (
            <>
              <dt>Erro</dt>
              <dd className="ab-error">{trace.error}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

export function SimulatorPanel({
  company,
  agentId,
  dirty,
  saveFirst,
  published,
  valid,
  notify,
}: {
  company: string;
  agentId: string;
  dirty: boolean;
  saveFirst: () => Promise<boolean>;
  published: number | null;
  valid: boolean;
  notify: (m: string) => void;
}) {
  const [use, setUse] = useState<"draft" | "published">("draft");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  // Chamado em bloco: nos navegadores novos o scrollIntoView devolve uma Promise,
  // e o efeito não pode devolver nada além da limpeza.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [bubbles, busy]);

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    if (use === "draft" && dirty && !(await saveFirst())) return;
    setText("");
    setBubbles((b) => [...b, { role: "user", text: message }]);
    setBusy(true);
    try {
      const r = await agentOp<SimulateResult>(company, agentId, "simulate", { message, use, reset, session: use });
      setReset(false);
      setBubbles((b) => [
        ...b,
        {
          role: "assistant",
          texts: r.result.messages.map((m) => m.text),
          trace: r.turn,
          handoff: r.result.handoff,
          silent: r.result.status === "silent" ? (r.result.silentReason ?? "sem motivo") : undefined,
          error: r.result.status === "error" ? (r.result.error ?? "Falhou.") : undefined,
        },
      ]);
    } catch (e) {
      notify(errorOf(e));
      setBubbles((b) => [...b, { role: "assistant", texts: [], trace: null, error: errorOf(e) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ab-sim">
      <div className="ab-toolbar">
        <label className="ab-inline">
          <span className="muted">Testar</span>
          <Select
            value={use}
            onValueChange={(v) => {
              setUse(v as "draft" | "published");
              setBubbles([]);
              setReset(true);
            }}
            aria-label="Qual versão testar"
          >
            <SelectOption value="draft">Rascunho{dirty ? " (salva antes)" : ""}</SelectOption>
            {published ? <SelectOption value="published">Versão publicada (v{published})</SelectOption> : null}
          </Select>
        </label>
        <button
          type="button"
          className="agent-link-btn"
          onClick={() => {
            setBubbles([]);
            setReset(true);
          }}
        >
          <RotateCcw size={14} aria-hidden="true" /> Nova conversa
        </button>
      </div>
      {!valid && use === "draft" && (
        <p className="ab-notice warn">
          <TriangleAlert size={15} aria-hidden="true" /> Preencha o nome, a empresa e o objetivo para testar o rascunho.
        </p>
      )}
      <div className="ab-chat" aria-live="polite">
        {!bubbles.length && (
          <p className="muted ab-chat-empty">
            Escreva como se fosse um lead. Nada é enviado ao WhatsApp; a conversa de teste é só sua.
          </p>
        )}
        {bubbles.map((b, i) =>
          b.role === "user" ? (
            <div key={i} className="ab-bubble user">
              {b.text}
            </div>
          ) : (
            <div key={i} className="ab-turn">
              {b.texts.map((t, j) => (
                <div key={j} className="ab-bubble agent">
                  {t}
                </div>
              ))}
              {b.silent && <div className="ab-bubble note">Ficou em silêncio: {b.silent}</div>}
              {b.handoff && <div className="ab-bubble note">Passou para a equipe: {b.handoff}</div>}
              {b.error && <div className="ab-bubble note error">Erro: {b.error}</div>}
              {b.trace && <TraceDetails trace={b.trace} />}
            </div>
          ),
        )}
        {busy && (
          <div className="ab-bubble agent typing" aria-label="O agente está respondendo">
            <span />
            <span />
            <span />
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="ab-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Textarea
          value={text}
          rows={2}
          maxLength={4000}
          placeholder="Mensagem do lead…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button type="submit" className="btn primary" disabled={!text.trim() || busy || (use === "draft" && !valid)} aria-label="Enviar">
          <Send size={16} aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------ conversas reais
export function ConversationsPanel({ company, agentId }: { company: string; agentId: string }) {
  const [turns, setTurns] = useState<TurnTrace[] | null>(null);
  const [usage, setUsage] = useState<UsageDay[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<TurnTrace | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const load = useCallback(() => {
    Promise.all([
      agentOp<{ turns: TurnTrace[] }>(company, agentId, "turns", { simulation: "false", limit: 100, status: onlyErrors ? "error" : undefined }),
      agentOp<{ usage: UsageDay[] }>(company, agentId, "usage"),
    ])
      .then(([t, u]) => {
        setTurns(t.turns);
        setUsage(u.usage);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, onlyErrors]);
  useEffect(load, [load]);

  const live = (usage ?? []).filter((u) => !u.simulation);
  const total = live.reduce(
    (s, u) => ({ turns: s.turns + u.turns, errors: s.errors + u.errors, cost: s.cost + Number(u.cost_usd) }),
    { turns: 0, errors: 0, cost: 0 },
  );
  const tests = (usage ?? []).filter((u) => u.simulation).reduce((s, u) => s + Number(u.cost_usd), 0);

  return (
    <div className="ab-stack">
      {error && <p className="form-error" role="alert">{error}</p>}
      {usage && (
        <div className="ab-kpis">
          <div>
            <span className="muted">Respostas (30 dias)</span>
            <strong>{total.turns.toLocaleString("pt-BR")}</strong>
          </div>
          <div>
            <span className="muted">Custo (30 dias)</span>
            <strong>{usd(total.cost)}</strong>
          </div>
          <div>
            <span className="muted">Custo por resposta</span>
            <strong>{total.turns ? usd(total.cost / total.turns) : "—"}</strong>
          </div>
          <div>
            <span className="muted">Erros</span>
            <strong>{total.errors}</strong>
          </div>
          <div>
            <span className="muted">Testes (30 dias)</span>
            <strong>{usd(tests)}</strong>
          </div>
        </div>
      )}
      <div className="ab-toolbar">
        <label className="agent-check">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Só as com erro
        </label>
        <button type="button" className="agent-link-btn" onClick={load}>
          Atualizar
        </button>
      </div>
      {!turns && !error && <Loading variant="table" />}
      {turns && !turns.length && <p className="muted">Nenhuma resposta no WhatsApp ainda.</p>}
      <ul className="ab-list">
        {(turns ?? []).map((t) => (
          <li key={t.id} className="ab-row">
            <button type="button" className="ab-row-main ab-row-button" onClick={() => setOpen(t)}>
              <span className="ab-row-title">
                <strong>{t.contact_name || t.phone || "Contato"}</strong>
                <span className="muted">
                  {when(t.created_at)} · v{t.agent_version ?? "?"} · {usd(t.cost_usd)} · {seconds(t.timings?.total)}
                </span>
              </span>
              <span className="muted ab-clamp">
                {t.status === "error" ? `Erro: ${t.error}` : (t.messages ?? []).map((m) => m.text).join(" · ") || "(sem resposta)"}
              </span>
            </button>
            <span className={`ab-badge ${t.status === "done" ? "on" : t.status === "error" ? "danger" : ""}`}>
              {t.status === "done" ? "Respondeu" : t.status === "silent" ? "Silêncio" : t.status === "error" ? "Erro" : "Ignorada"}
            </span>
          </li>
        ))}
      </ul>
      {open && <TurnModal company={company} agentId={agentId} turn={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TurnModal({ company, agentId, turn, onClose }: { company: string; agentId: string; turn: TurnTrace; onClose: () => void }) {
  const [data, setData] = useState<{ turn: TurnTrace & { conversation_id: string }; messages: ChatMessage[] } | null>(null);
  const [conv, setConv] = useState<AgentConversation | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    agentOp<{ turn: TurnTrace & { conversation_id: string }; messages: ChatMessage[] }>(company, agentId, "turn", { turn: turn.id })
      .then(async (r) => {
        setData(r);
        const c = await agentOp<{ conversations: AgentConversation[] }>(company, agentId, "conversations", { limit: 200 });
        setConv(c.conversations.find((x) => x.id === r.turn.conversation_id) ?? null);
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, turn.id]);
  return (
    <Modal title={`Resposta de ${when(turn.created_at)}`} onClose={onClose} wide>
      <div className="ab-stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!data && !error && <Loading variant="list" />}
        {data && (
          <>
            <div className="ab-chat static">
              {data.messages.map((m) => (
                <div key={m.id} className={`ab-bubble ${m.role === "user" ? "user" : m.role === "assistant" ? "agent" : "note"}`}>
                  {m.content}
                </div>
              ))}
            </div>
            <TraceDetails trace={data.turn} />
            {conv && (Object.keys(conv.facts).length > 0 || conv.summary) && (
              <dl className="ab-trace-body">
                {Object.keys(conv.facts).length > 0 && (
                  <>
                    <dt>Dados do contato</dt>
                    <dd>
                      {Object.entries(conv.facts)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                    </dd>
                  </>
                )}
                {conv.summary && (
                  <>
                    <dt>Resumo da conversa</dt>
                    <dd className="ab-pre">{conv.summary}</dd>
                  </>
                )}
              </dl>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

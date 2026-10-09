import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Eraser, RotateCcw, Search, Send, TriangleAlert } from "lucide-react";
import { Modal } from "./components";
import { ConversationInsightModal, ResetMemoryModal } from "./AgentConversationModal";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { ActionDiagnosis } from "./AgentActionDiagnosis";
import {
  ACTION_LABEL,
  OUTCOME_INFO,
  agentOp,
  errorOf,
  usd,
  when,
  type AgentLead,
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

const TOOL_LABEL = ACTION_LABEL;
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
                        {t.debug ? (
                          <>
                            {" "}
                            <span className={`ab-badge ${OUTCOME_INFO[t.debug.outcome]?.tone ?? ""}`}>{OUTCOME_INFO[t.debug.outcome]?.label}</span> {t.debug.summary}
                            <ActionDiagnosis debug={t.debug} />
                          </>
                        ) : t.args ? (
                          `: ${JSON.stringify(t.args)}`
                        ) : (
                          ""
                        )}
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
export function ConversationsPanel({
  company,
  agentId,
  canEdit = false,
  notify = () => {},
}: {
  company: string;
  agentId: string;
  canEdit?: boolean;
  notify?: (m: string) => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [leads, setLeads] = useState<AgentLead[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [usage, setUsage] = useState<UsageDay[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<AgentLead | null>(null);
  const [trace, setTrace] = useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  // Busca enquanto digita, sem uma consulta por letra.
  useEffect(() => {
    const t = setTimeout(() => setSearch(term.trim()), 350);
    return () => clearTimeout(t);
  }, [term]);
  const filters = { limit: 50, q: search || undefined, errors: onlyErrors || undefined };
  const load = useCallback(() => {
    Promise.all([agentOp<LeadPage>(company, agentId, "leads", filters), agentOp<{ usage: UsageDay[] }>(company, agentId, "usage")])
      .then(([l, u]) => {
        setLeads(l.leads);
        setNext(l.next);
        setTotal(l.total);
        setUsage(u.usage);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, agentId, onlyErrors, search]);
  useEffect(load, [load]);
  const loadMore = () => {
    if (!next) return;
    setMore(true);
    agentOp<LeadPage>(company, agentId, "leads", { ...filters, before: next })
      .then((l) => {
        setLeads((cur) => [...(cur ?? []), ...l.leads.filter((x) => !(cur ?? []).some((y) => y.lead_key === x.lead_key))]);
        setNext(l.next);
      })
      .catch((e) => setError(errorOf(e)))
      .finally(() => setMore(false));
  };

  const live = (usage ?? []).filter((u) => !u.simulation);
  const sum = live.reduce(
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
            <span className="muted">Leads</span>
            <strong>{total == null ? "—" : total.toLocaleString("pt-BR")}</strong>
          </div>
          <div>
            <span className="muted">Respostas (30 dias)</span>
            <strong>{sum.turns.toLocaleString("pt-BR")}</strong>
          </div>
          <div>
            <span className="muted">Custo (30 dias)</span>
            <strong>{usd(sum.cost)}</strong>
          </div>
          <div>
            <span className="muted">Custo por resposta</span>
            <strong>{sum.turns ? usd(sum.cost / sum.turns) : "—"}</strong>
          </div>
          <div>
            <span className="muted">Erros</span>
            <strong>{sum.errors}</strong>
          </div>
          <div>
            <span className="muted">Testes (30 dias)</span>
            <strong>{usd(tests)}</strong>
          </div>
        </div>
      )}
      <div className="ab-toolbar">
        <span className="ab-lead-search">
          <Input icon={Search} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Buscar por nome ou telefone" aria-label="Buscar lead" />
        </span>
        <span className="ab-check compact">
          <Checkbox id="ab-only-errors" checked={onlyErrors} onCheckedChange={(c) => setOnlyErrors(c === true)} />
          <label htmlFor="ab-only-errors">Só com erro</label>
        </span>
        <span className="ab-toolbar-right">
          {canEdit && (
            <Button type="button" className="btn secondary" onClick={() => setResetting(true)}>
              <Eraser size={14} aria-hidden="true" /> Zerar memória de um lead
            </Button>
          )}
          <button type="button" className="agent-link-btn" onClick={load}>
            Atualizar
          </button>
        </span>
      </div>
      {resetting && <ResetMemoryModal company={company} agentId={agentId} notify={notify} onClose={() => setResetting(false)} />}
      {!leads && !error && <Loading variant="table" />}
      {leads && !leads.length && <p className="muted">{search || onlyErrors ? "Nenhum lead com esse filtro." : "Nenhuma conversa no WhatsApp ainda."}</p>}
      <ul className="ab-list">
        {(leads ?? []).map((l) => (
          <li key={l.lead_key} className="ab-row">
            <button type="button" className="ab-row-main ab-row-button" onClick={() => setOpen(l)}>
              <span className="ab-row-title">
                <strong>{l.contact_name || l.phone || "Contato"}</strong>
                <span className="muted">
                  {l.contact_name && l.phone ? `${l.phone} · ` : ""}
                  {when(l.last_at)} · {l.messages} mensage{l.messages === 1 ? "m" : "ns"} · {usd(l.cost_usd)}
                  {l.conversations.length > 1 ? ` · ${l.conversations.length} conversas` : ""}
                </span>
              </span>
              <span className="muted ab-clamp">
                {l.last_content ? `${l.last_role === "assistant" ? "Agente: " : ""}${l.last_content}` : "(sem mensagens guardadas)"}
              </span>
            </button>
            {l.errors > 0 ? (
              <span className="ab-badge danger">{l.errors === 1 ? "1 erro" : `${l.errors} erros`}</span>
            ) : l.last_role === "user" ? (
              <span className="ab-badge" title="A última mensagem é do lead">Aguardando</span>
            ) : (
              <span className="ab-badge on">{l.replies === 1 ? "1 resposta" : `${l.replies} respostas`}</span>
            )}
          </li>
        ))}
      </ul>
      {next && (
        <div className="ab-toolbar">
          <Button type="button" className="btn secondary" onClick={loadMore} disabled={more}>
            {more ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}
      {open && (
        <ConversationInsightModal
          company={company}
          agentId={agentId}
          conversationId={open.conversations[0]!.id}
          conversations={open.conversations}
          canReset={canEdit}
          notify={notify}
          onTrace={setTrace}
          onClose={() => {
            setOpen(null);
            load();
          }}
        />
      )}
      {trace && <TraceModal company={company} agentId={agentId} turnId={trace} onClose={() => setTrace(null)} />}
    </div>
  );
}

type LeadPage = { leads: AgentLead[]; next: string | null; total: number | null };

/** O que aconteceu por dentro numa resposta do agente (ferramentas, trechos, modelo, custo, tempo). */
function TraceModal({ company, agentId, turnId, onClose }: { company: string; agentId: string; turnId: string; onClose: () => void }) {
  const [turn, setTurn] = useState<TurnTrace | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    agentOp<{ turn: TurnTrace }>(company, agentId, "turn", { turn: turnId })
      .then((r) => setTurn(r.turn))
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, turnId]);
  return (
    <Modal title={turn ? `Resposta de ${when(turn.created_at)}` : "Resposta"} onClose={onClose} wide>
      <div className="ab-stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!turn && !error && <Loading variant="list" />}
        {turn && <TraceDetails trace={turn} />}
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Eraser, Search } from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading } from "./ui";
import {
  agentOp,
  errorOf,
  ISSUE_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  SENTIMENT_LABEL,
  when,
  type AgentConversation,
  type ChatMessage,
  type ConversationInsight,
  type CostEvent,
  COST_SOURCE_LABEL,
  money,
} from "./agent-builder";

/**
 * Uma conversa real do agente, aberta a partir das Lacunas ou dos Insights:
 * a leitura da MAVI (resultado, motivo, objeções, falhas), as lacunas que ela
 * teve e as mensagens.
 */
export function ConversationInsightModal({
  company,
  agentId,
  conversationId,
  onClose,
  canReset = false,
  notify,
}: {
  company: string;
  agentId: string;
  conversationId: string;
  onClose: () => void;
  /** Quem edita o agente pode zerar a memória dele nesta conversa. */
  canReset?: boolean;
  notify?: (m: string) => void;
}) {
  const [data, setData] = useState<ConversationInsight | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [costs, setCosts] = useState<CostEvent[]>([]);
  const [error, setError] = useState("");
  const [loadKey, setLoadKey] = useState(0);
  useEffect(() => {
    Promise.all([
      agentOp<ConversationInsight>(company, agentId, "conversation-insight", { conversation: conversationId }),
      agentOp<{ messages: ChatMessage[] }>(company, agentId, "conversation-messages", { conversation: conversationId }),
    ])
      .then(([d, m]) => {
        setData(d);
        setMessages(m.messages);
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, conversationId, loadKey]);
  // O custo de cada mensagem (mídia recebida, resposta, modelo aprovado), quando houver.
  useEffect(() => {
    agentOp<{ events: CostEvent[] }>(company, agentId, "conversation-costs", { conversation: conversationId })
      .then((r) => setCosts(r.events))
      .catch(() => setCosts([]));
  }, [company, agentId, conversationId]);
  const costTotal = costs.reduce((s, e) => s + Number(e.cost_usd), 0);
  // Mídia: pela mensagem; resposta: pela vez (vai na última mensagem do agente daquela vez).
  const costOf = (m: ChatMessage, next?: ChatMessage) => {
    const byMessage = costs.filter((e) => e.message_id && String(e.message_id) === String(m.id));
    const byTurn =
      m.role === "assistant" && m.turn_id && (!next || next.turn_id !== m.turn_id || next.role !== "assistant")
        ? costs.filter((e) => !e.message_id && e.turn_id === m.turn_id)
        : [];
    return [...byMessage, ...byTurn];
  };

  const c = data?.conversation;
  const i = data?.insight;
  return (
    <Modal title={c ? `Conversa com ${c.contact_name || c.phone || "o contato"}` : "Conversa"} onClose={onClose} wide>
      <div className="ab-stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!data && !error && <Loading variant="list" />}
        {data && (
          <>
            {canReset && (
              <ResetMemoryBox
                company={company}
                agentId={agentId}
                conversation={data.conversation}
                kept={(messages ?? []).filter((m) => m.role !== "note").length}
                notify={notify}
                onDone={() => setLoadKey((k) => k + 1)}
              />
            )}
            {i ? (
              <section className="ab-section ai-conv-reading">
                <div className="ab-badges">
                  <span className={`ab-badge ${OUTCOME_TONE[i.outcome] === "good" ? "on" : OUTCOME_TONE[i.outcome] === "bad" ? "danger" : ""}`}>
                    {OUTCOME_LABEL[i.outcome]}
                  </span>
                  <span className={`ab-badge ${i.sentiment === "negative" ? "danger" : i.sentiment === "positive" ? "on" : ""}`}>
                    Lead {SENTIMENT_LABEL[i.sentiment]?.toLowerCase()}
                  </span>
                  <span className="muted ai-small">Lida pela MAVI em {when(i.analyzed_at)}</span>
                </div>
                {i.summary && <p className="ai-lead">{i.summary}</p>}
                <dl className="ai-facts">
                  {i.intent && (
                    <>
                      <dt>O que o lead queria</dt>
                      <dd>{i.intent}</dd>
                    </>
                  )}
                  {i.outcome_reason && (
                    <>
                      <dt>Por que terminou assim</dt>
                      <dd>{i.outcome_reason}</dd>
                    </>
                  )}
                  {i.objections.length > 0 && (
                    <>
                      <dt>Objeções</dt>
                      <dd>{i.objections.join(" · ")}</dd>
                    </>
                  )}
                  {i.agent_issues.length > 0 && (
                    <>
                      <dt>Falhas do agente</dt>
                      <dd>
                        <ul className="ai-plain">
                          {i.agent_issues.map((x, k) => (
                            <li key={k}>
                              <strong>{ISSUE_LABEL[x.type] ?? x.type}:</strong> {x.detail}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </>
                  )}
                </dl>
              </section>
            ) : (
              <p className="ab-notice">A MAVI ainda não leu esta conversa (ela lê as conversas da amostra algumas horas depois que esfriam).</p>
            )}
            {data.gaps.length > 0 && (
              <section className="ab-section">
                <h3>Lacunas nesta conversa</h3>
                <ul className="ai-plain">
                  {data.gaps.map((g) => (
                    <li key={g.id}>
                      <span className="ab-badge">{g.kind === "objection" ? "Objeção" : "Pergunta"}</span> {g.text}
                      {g.topic_status === "trained" && <span className="ab-badge on">já no treinamento</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {costTotal > 0 && (
              <p className="muted ai-small">
                Custo desta conversa: <strong>{money(costTotal, "usd")}</strong> ({costs.length} gasto(s)). Passe o mouse no valor embaixo de cada mensagem para
                ver o detalhe.
              </p>
            )}
            <div className="ab-chat static">
              {(messages ?? []).map((m, i, all) => {
                const c = costOf(m, all[i + 1]);
                const sum = c.reduce((s, e) => s + Number(e.cost_usd), 0);
                return (
                  <div key={m.id} className={`ab-bubble ${m.role === "user" ? "user" : m.role === "assistant" ? "agent" : "note"}`} title={when(m.created_at)}>
                    {m.content}
                    {sum > 0 && (
                      <span className="cost-bubble" title={c.map((e) => `${COST_SOURCE_LABEL[e.source] ?? e.source}${e.model ? ` (${e.model})` : ""}: ${money(Number(e.cost_usd), "usd")}`).join("\n")}>
                        {money(sum, "usd")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ zerar a memória
const RESET_HINT =
  "O agente esquece esta conversa: apaga as mensagens que ele guarda, o resumo e os dados coletados do contato, e para o follow-up. " +
  "Na próxima mensagem do lead, ele começa do zero. O histórico no MakeCRM continua; os custos e os rastros ficam. Não dá para desfazer.";

/** O botão (com confirmação) de zerar a memória do agente numa conversa. */
function ResetMemoryBox({
  company,
  agentId,
  conversation,
  kept,
  notify,
  onDone,
}: {
  company: string;
  agentId: string;
  conversation: AgentConversation;
  kept: number;
  notify?: (m: string) => void;
  onDone: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    try {
      const r = await agentOp<{ removed_messages: number }>(company, agentId, "conversation-reset", { conversation: conversation.id });
      notify?.(`Memória zerada: ${r.removed_messages} mensagem(ns) apagada(s). O agente começa do zero com este lead.`);
      setConfirm(false);
      onDone();
    } catch (e) {
      notify?.(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`ab-notice ${confirm ? "warn" : ""} reset-box`}>
      {conversation.memory_reset_at && !confirm && (
        <span className="muted ai-small">
          Memória zerada em {when(conversation.memory_reset_at)}
          {conversation.memory_reset_by ? ` por ${conversation.memory_reset_by}` : ""}.
        </span>
      )}
      {!confirm ? (
        <Button type="button" className="btn secondary" disabled={!kept} onClick={() => setConfirm(true)}>
          <Eraser size={14} aria-hidden="true" /> Zerar memória do agente
        </Button>
      ) : (
        <>
          <span>
            <strong>Zerar a memória com {conversation.contact_name || conversation.phone || "este lead"}?</strong> {RESET_HINT}
          </span>
          <span className="ab-row-actions">
            <Button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirm(false)}>
              Cancelar
            </Button>
            <Button type="button" className="btn danger" loading={busy} onClick={() => void reset()}>
              Zerar {kept} mensagem(ns)
            </Button>
          </span>
        </>
      )}
    </div>
  );
}

/** Achar um lead pelo nome ou telefone e zerar a memória do agente com ele. */
export function ResetMemoryModal({ company, agentId, notify, onClose }: { company: string; agentId: string; notify: (m: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<AgentConversation[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(
    (term: string) =>
      agentOp<{ conversations: AgentConversation[] }>(company, agentId, "conversations", { limit: 30, q: term || undefined })
        .then((r) => {
          setRows(r.conversations);
          setError("");
        })
        .catch((e) => setError(errorOf(e))),
    [company, agentId],
  );
  useEffect(() => {
    const t = window.setTimeout(() => void load(q.trim()), q ? 350 : 0);
    return () => window.clearTimeout(t);
  }, [q, load]);
  return (
    <Modal title="Zerar a memória do agente com um lead" onClose={onClose} wide>
      <div className="ab-stack">
        <p className="muted ai-small">{RESET_HINT}</p>
        <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome ou telefone do lead" aria-label="Buscar lead" autoFocus />
        {error && <p className="form-error" role="alert">{error}</p>}
        {!rows && !error && <Loading variant="list" />}
        {rows && !rows.length && <p className="muted">Nenhuma conversa encontrada.</p>}
        <ul className="ab-list">
          {(rows ?? []).map((c) => (
            <li key={c.id} className="ab-row">
              <button type="button" className="ab-row-main ab-row-button" onClick={() => setOpen(c.id)}>
                <span className="ab-row-title">
                  <strong>{c.contact_name || "Contato"}</strong>
                  <span className="muted">{c.phone}</span>
                </span>
                <span className="muted">
                  {c.messages ?? 0} mensagem(ns) na memória · última em {when(c.last_inbound_at ?? c.created_at)}
                  {c.memory_reset_at ? ` · zerada em ${when(c.memory_reset_at)}` : ""}
                </span>
              </button>
              <Button type="button" className="btn secondary" disabled={!c.messages} onClick={() => setOpen(c.id)}>
                <Eraser size={14} aria-hidden="true" /> Zerar
              </Button>
            </li>
          ))}
        </ul>
      </div>
      {open && (
        <ConversationInsightModal
          company={company}
          agentId={agentId}
          conversationId={open}
          canReset
          notify={notify}
          onClose={() => {
            setOpen(null);
            void load(q.trim());
          }}
        />
      )}
    </Modal>
  );
}

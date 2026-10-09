import { useEffect, useState } from "react";
import { Modal } from "./components";
import { Loading } from "./ui";
import {
  agentOp,
  errorOf,
  ISSUE_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  SENTIMENT_LABEL,
  when,
  type ChatMessage,
  type ConversationInsight,
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
}: {
  company: string;
  agentId: string;
  conversationId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ConversationInsight | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState("");
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
  }, [company, agentId, conversationId]);

  const c = data?.conversation;
  const i = data?.insight;
  return (
    <Modal title={c ? `Conversa com ${c.contact_name || c.phone || "o contato"}` : "Conversa"} onClose={onClose} wide>
      <div className="ab-stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!data && !error && <Loading variant="list" />}
        {data && (
          <>
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
            <div className="ab-chat static">
              {(messages ?? []).map((m) => (
                <div key={m.id} className={`ab-bubble ${m.role === "user" ? "user" : m.role === "assistant" ? "agent" : "note"}`} title={when(m.created_at)}>
                  {m.content}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Lightbulb,
  TriangleAlert,
} from "lucide-react";
import { Loading } from "./ui";
import {
  ACTION_LABEL,
  agentOp,
  OUTCOME_INFO,
  when,
  type ActionDebug,
  type ActionLog,
  type ActionLogEntry,
  type ActionPattern,
} from "./agent-builder";

/**
 * Registro técnico (peças): o diagnóstico de uma ação do agente, a linha do
 * registro (com o detalhe ao abrir), o alerta do que se repete e o registro
 * de uma conversa (dentro do modal da conversa). Sem modais aqui, para o
 * modal da conversa poder usar sem import circular.
 */

/** O porquê (detalhes) e o que ajustar. */
export function ActionDiagnosis({ debug }: { debug: ActionDebug }) {
  if (!debug.details?.length && !debug.hint) return null;
  return (
    <div className="ab-diagnosis">
      {debug.details && debug.details.length > 0 && (
        <ul>
          {debug.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      {debug.hint && (
        <p className="ab-diagnosis-hint">
          <Lightbulb size={13} aria-hidden="true" /> {debug.hint}
        </p>
      )}
    </div>
  );
}

export function OutcomeBadge({ outcome }: { outcome: ActionDebug["outcome"] }) {
  const o = OUTCOME_INFO[outcome] ?? OUTCOME_INFO.ok;
  return <span className={`ab-badge ${o.tone}`}>{o.label}</span>;
}

/** Uma ação no registro: resumo na linha; ao abrir, o diagnóstico, o que o agente pediu e o que o motor respondeu. */
export function ActionEntryRow({
  e,
  showLead = true,
  onOpenConversation,
}: {
  e: ActionLogEntry;
  showLead?: boolean;
  onOpenConversation?: (e: ActionLogEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const args = e.args && Object.keys(e.args).length ? e.args : null;
  return (
    <li className={`ab-log-row is-${e.debug.outcome}`}>
      <button
        type="button"
        className="ab-log-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" />
        )}
        <span className="ab-log-when">{when(e.created_at)}</span>
        {showLead && (
          <strong className="ab-log-lead">
            {e.contact_name || e.phone || "Lead"}
          </strong>
        )}
        <span className="ab-log-tool">{ACTION_LABEL[e.tool] ?? e.tool}</span>
        <OutcomeBadge outcome={e.debug.outcome} />
        <span className="ab-log-summary">{e.debug.summary}</span>
      </button>
      {open && (
        <div className="ab-log-body">
          <ActionDiagnosis debug={e.debug} />
          <dl className="ab-trace-body">
            {args && (
              <>
                <dt>O que o agente pediu</dt>
                <dd>
                  <code className="ab-pre">
                    {JSON.stringify(args, null, 1)}
                  </code>
                </dd>
              </>
            )}
            {e.result && (
              <>
                <dt>O que o motor devolveu ao agente</dt>
                <dd className="ab-pre">{e.result}</dd>
              </>
            )}
            {e.ms != null && (
              <>
                <dt>Tempo</dt>
                <dd>
                  {(e.ms / 1000).toLocaleString("pt-BR", {
                    maximumFractionDigits: 1,
                  })}{" "}
                  s
                </dd>
              </>
            )}
          </dl>
          {onOpenConversation && (
            <button
              type="button"
              className="agent-link-btn"
              onClick={() => onOpenConversation(e)}
            >
              Abrir a conversa
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Os motivos que se repetiram nos últimos 7 dias, com o que ajustar. */
export function PatternsAlert({ patterns }: { patterns: ActionPattern[] }) {
  if (!patterns.length) return null;
  return (
    <section className="ab-notice warn ab-patterns" role="status">
      <strong>
        <TriangleAlert size={14} aria-hidden="true" /> Problemas que se
        repetiram nos últimos 7 dias
      </strong>
      <ul>
        {patterns.map((p) => (
          <li key={`${p.tool}:${p.code}`}>
            <strong>{ACTION_LABEL[p.tool] ?? p.tool}</strong> · {p.leads}{" "}
            {p.leads === 1 ? "lead" : "leads"}, {p.n}{" "}
            {p.n === 1 ? "vez" : "vezes"} (a última em {when(p.last_at)})
            {p.summary ? `: ${p.summary}` : ""}
            {p.hint && (
              <div className="ab-diagnosis-hint">
                <Lightbulb size={13} aria-hidden="true" /> {p.hint}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** O registro técnico de uma conversa (no modal da conversa). */
export function ConversationActionLog({
  company,
  agentId,
  conversationId,
}: {
  company: string;
  agentId: string;
  conversationId: string;
}) {
  const [log, setLog] = useState<ActionLogEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setLog(null);
    agentOp<ActionLog>(company, agentId, "action-log", {
      conversation: conversationId,
      days: 90,
      limit: 100,
    })
      .then((r) => setLog(r.entries))
      .catch(() => setLog([]));
  }, [company, agentId, conversationId]);
  if (log && !log.length) return null;
  const problems = (log ?? []).filter(
    (e) => e.debug.outcome === "error" || e.debug.outcome === "empty",
  ).length;
  return (
    <section className="ab-section">
      <button
        type="button"
        className="ab-trace-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Registro técnico desta conversa
        {log ? ` · ${log.length} ${log.length === 1 ? "ação" : "ações"}` : ""}
        {problems ? ` · ${problems} sem resultado ou com falha` : ""}
      </button>
      {open && !log && <Loading variant="list" />}
      {open && log && (
        <ul className="ab-list ab-log">
          {log.map((e) => (
            <ActionEntryRow
              key={`${e.turn_id}:${e.ord}`}
              e={e}
              showLead={false}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** O alerta do que se repete (sem as falhas, que já aparecem no alerta de falhas), na aba Integrações. */
export function IntegrationPatternsAlert({
  company,
  agentId,
}: {
  company: string;
  agentId: string;
}) {
  const [patterns, setPatterns] = useState<ActionPattern[]>([]);
  useEffect(() => {
    agentOp<ActionLog>(company, agentId, "action-log", { days: 7, limit: 10 })
      .then((r) =>
        setPatterns(
          r.patterns.filter(
            (p) => p.code.startsWith("calendar_") || p.code === "no_deal",
          ),
        ),
      )
      .catch(() => setPatterns([]));
  }, [company, agentId]);
  return <PatternsAlert patterns={patterns} />;
}

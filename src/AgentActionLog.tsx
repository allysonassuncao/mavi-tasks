import { useCallback, useEffect, useState } from "react";
import { Button, Loading } from "./ui";
import { ActionEntryRow, PatternsAlert } from "./AgentActionDiagnosis";
import { ConversationInsightModal } from "./AgentConversationModal";
import { Choice } from "./AgentIntegrations";
import {
  ACTION_GROUPS,
  agentOp,
  errorOf,
  type ActionLog,
  type ActionLogEntry,
  type ActionPattern,
} from "./agent-builder";

/**
 * Agentes MAVI › Registro técnico: cada ação que o agente executou nas
 * conversas reais (agenda, MakeCRM, aviso, cenários, transferência) e as
 * respostas que falharam, com o diagnóstico em português: o que deu, por quê
 * e o que ajustar. No topo, o que se repetiu nos últimos 7 dias.
 */

type Outcome = "" | "ok" | "empty" | "blocked" | "error";

export function ActionLogPanel({
  company,
  agentId,
  canEdit = false,
  notify,
}: {
  company: string;
  agentId: string;
  canEdit?: boolean;
  notify?: (m: string) => void;
}) {
  const [days, setDays] = useState(7);
  const [group, setGroup] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("");
  const [entries, setEntries] = useState<ActionLogEntry[] | null>(null);
  const [patterns, setPatterns] = useState<ActionPattern[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<ActionLogEntry | null>(null);

  const filters = {
    days,
    tools: ACTION_GROUPS.find((g) => g.id === group)?.tools,
    outcome: outcome || undefined,
    limit: 50,
  };
  const load = useCallback(() => {
    setEntries(null);
    agentOp<ActionLog>(company, agentId, "action-log", filters)
      .then((r) => {
        setEntries(r.entries);
        setNext(r.next);
        setPatterns(r.patterns);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, agentId, days, group, outcome]);
  useEffect(load, [load]);
  const loadMore = () => {
    if (!next) return;
    setMore(true);
    agentOp<ActionLog>(company, agentId, "action-log", {
      ...filters,
      before: next,
    })
      .then((r) => {
        setEntries((cur) => [...(cur ?? []), ...r.entries]);
        setNext(r.next);
      })
      .catch((e) => setError(errorOf(e)))
      .finally(() => setMore(false));
  };

  return (
    <div className="ab-stack">
      <p className="ab-hint ab-section-intro">
        Tudo o que o agente fez nas conversas reais, com o porquê de cada
        resultado. Use quando o agente disser ao lead que não conseguiu algo
        (ex.: "não encontrei horários") para ver o motivo e o que ajustar.
      </p>
      <PatternsAlert patterns={patterns} />
      <div className="ab-toolbar">
        <span className="ab-filter">
          <Choice
            label="Período"
            value={days}
            onChange={setDays}
            options={[
              [1, "Últimas 24 horas"],
              [7, "Últimos 7 dias"],
              [30, "Últimos 30 dias"],
              [90, "Últimos 90 dias"],
            ]}
          />
        </span>
        <span className="ab-filter">
          <Choice
            label="Ação"
            value={group}
            onChange={setGroup}
            options={[
              ["", "Todas as ações"],
              ...ACTION_GROUPS.map((g) => [g.id, g.label] as [string, string]),
            ]}
          />
        </span>
        <span className="ab-filter">
          <Choice
            label="Resultado"
            value={outcome}
            onChange={setOutcome}
            options={[
              ["", "Todos os resultados"],
              ["error", "Falhou"],
              ["empty", "Sem resultado"],
              ["blocked", "Segurada (repetição)"],
              ["ok", "Fez"],
            ]}
          />
        </span>
        <span className="ab-toolbar-right">
          <button type="button" className="agent-link-btn" onClick={load}>
            Atualizar
          </button>
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!entries && !error && <Loading variant="table" />}
      {entries && !entries.length && (
        <p className="muted">Nenhuma ação com esses filtros no período.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="ab-list ab-log">
          {entries.map((e) => (
            <ActionEntryRow
              key={`${e.turn_id}:${e.ord}`}
              e={e}
              onOpenConversation={setOpen}
            />
          ))}
        </ul>
      )}
      {next && (
        <div className="ab-toolbar">
          <Button
            type="button"
            className="btn secondary"
            onClick={loadMore}
            disabled={more}
          >
            {more ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}
      {open && (
        <ConversationInsightModal
          company={company}
          agentId={agentId}
          conversationId={open.conversation_id}
          canReset={canEdit}
          notify={notify}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CheckSquare,
  Copy,
  FileText,
  Heart,
  Info,
  Lightbulb,
  Megaphone,
  MessageCircle,
  RefreshCw,
  Rocket,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trophy,
  Video,
  X,
  BookMarked,
  CornerDownLeft,
  Cpu,
} from "lucide-react";
import { sourceLabel, sourceUrl, type AiSource } from "./ai";
import {
  ALERT_LABELS,
  MIN_REVIEW,
  sendCopilotFeedback,
  voteCopilot,
  attachCopilotFeedback,
  DOWN_REASONS,
  type CopilotVote,
  type DownReason,
  type AlertKind,
  type CopilotAction,
  type CopilotAlert,
  type CopilotState,
} from "./copilot";
import { statuses, type Status } from "./types";
import { routeParts, taskUrl, pageUrl } from "./router";

/**
 * Assistente MAVI ao lado do formulário da tarefa: os alertas da análise
 * (com as fontes, que abrem em outra aba para o rascunho não se perder) e
 * os Relacionados (tarefas parecidas do cliente e cases de sucesso).
 * Nunca trava a criação: só avisa.
 */

const KIND_ICONS: Record<AlertKind, typeof Info> = {
  error: AlertTriangle,
  avoids: Ban,
  prefers: Heart,
  duplicate: Copy,
  missing: Info,
  suggestion: Lightbulb,
  case: Trophy,
};
const SOURCE_ICONS = {
  meeting: Video,
  task: CheckSquare,
  file: FileText,
  social: Rocket,
  campaign: Megaphone,
  case: Trophy,
  whatsapp: MessageCircle,
};
const DOSSIER_KINDS: Record<string, string> = {
  prefers: "Prefere",
  avoids: "Não gosta",
  rule: "Regra",
  style: "Tom e identidade",
  context: "Contexto",
  history: "Histórico",
};

const openInNewTab = (url: string) =>
  window.open(url, "_blank", "noopener,noreferrer");
const company = () => routeParts(window.location.pathname).company;

/**
 * O feedback de cada alerta: 👍/👎 (com motivo e comentário) vai ao banco na
 * hora — a MAVI aprende com eles —; o que a pessoa fez (aplicou, dispensou,
 * abriu a fonte, ignorou um alerta grave) vai ao salvar a tarefa.
 */
export function useCopilotFeedback(
  state: CopilotState,
  context: {
    company: string;
    contract: string | null;
    task?: string | null;
    title: string;
    /** Demonstração: nada vai ao banco. */
    demo?: boolean;
  },
) {
  const ctx = useRef(context);
  ctx.current = context;
  const session = useRef(crypto.randomUUID());
  const actions = useRef(
    new Map<string, { alert: CopilotAlert; action: CopilotAction }>(),
  );
  const votes = useRef(
    new Map<
      string,
      { vote: CopilotVote; reason?: DownReason | null; comment?: string }
    >(),
  );
  const seen = useRef(new Map<string, CopilotAlert>());
  const keyOf = (a: CopilotAlert) => `${a.kind}:${a.title}`;
  for (const a of state.alerts) seen.current.set(keyOf(a), a);
  return {
    record(alert: CopilotAlert, action: CopilotAction) {
      actions.current.set(keyOf(alert), { alert, action });
    },
    actionOf: (alert: CopilotAlert) =>
      actions.current.get(keyOf(alert))?.action,
    voteOf: (alert: CopilotAlert) => votes.current.get(keyOf(alert)),
    /** Grava o voto (nulo tira); se falhar, volta ao que era. */
    async vote(
      alert: CopilotAlert,
      vote: CopilotVote | null,
      reason?: DownReason | null,
      comment?: string,
    ) {
      const key = keyOf(alert);
      const before = votes.current.get(key);
      if (vote) votes.current.set(key, { vote, reason, comment });
      else votes.current.delete(key);
      if (ctx.current.demo) return;
      try {
        await voteCopilot({
          company: ctx.current.company,
          contract: ctx.current.contract,
          task: ctx.current.task ?? null,
          session: session.current,
          alert,
          draft: ctx.current.title,
          vote,
          reason,
          comment,
        });
      } catch (e) {
        if (before) votes.current.set(key, before);
        else votes.current.delete(key);
        throw e;
      }
    },
    /** Alertas graves sem nenhuma ação nem voto contam como ignorados. */
    flush(companyId: string, client: string | null, task: string | null) {
      const events = [...seen.current.entries()].flatMap(([key, alert]) => {
        const done = actions.current.get(key);
        if (done)
          return [
            {
              kind: alert.kind,
              severity: alert.severity,
              action: done.action,
              title: alert.title,
            },
          ];
        return alert.severity === "high" && !votes.current.has(key)
          ? [
              {
                kind: alert.kind,
                severity: alert.severity,
                action: "ignored" as const,
                title: alert.title,
              },
            ]
          : [];
      });
      if (task && votes.current.size && !ctx.current.demo)
        void attachCopilotFeedback(companyId, session.current, task).catch(
          () => {},
        );
      seen.current.clear();
      actions.current.clear();
      votes.current.clear();
      // "Criar outra em seguida": outra abertura, outros votos.
      session.current = crypto.randomUUID();
      void sendCopilotFeedback(companyId, client, task, events).catch(() => {});
    },
  };
}
export type CopilotFeedback = ReturnType<typeof useCopilotFeedback>;

export function TaskCopilot({
  state,
  feedback,
  members,
  onApplyFix,
  typedEnough,
}: {
  state: CopilotState;
  feedback: CopilotFeedback;
  members: { user_id: string; name: string }[];
  /** Acrescenta o texto à descrição da tarefa. */
  onApplyFix?: (text: string) => void;
  /** Já há texto suficiente para a MAVI opinar. */
  typedEnough: boolean;
}) {
  const [, redraw] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const act = (a: CopilotAlert, action: CopilotAction) => {
    feedback.record(a, action);
    if (action === "dismissed")
      setHidden((h) => new Set(h).add(`${a.kind}:${a.title}`));
    redraw((v) => v + 1);
  };
  const alerts = state.alerts.filter(
    (a) => !hidden.has(`${a.kind}:${a.title}`),
  );
  const similar = state.related?.similar ?? [];
  const cases = state.related?.cases ?? [];
  const nothing =
    !alerts.length &&
    !similar.length &&
    !cases.length &&
    !state.reviewing &&
    !state.verdict;
  return (
    <aside
      className={`copilot${state.reviewing ? " is-reviewing" : ""}`}
      aria-label="Assistente MAVI"
      aria-live="polite"
    >
      <header className="copilot-head">
        <Sparkles size={16} aria-hidden="true" />
        <strong>Assistente MAVI</strong>
        <button
          type="button"
          className="copilot-refresh"
          onClick={state.reviewNow}
          disabled={state.reviewing || !typedEnough}
          title="Revisar agora"
          aria-label="Revisar agora"
        >
          <RefreshCw
            size={14}
            className={state.reviewing ? "spin" : undefined}
          />
        </button>
      </header>

      <CopilotResult state={state} count={alerts.length} />
      {state.throttled && (
        <p className="copilot-note">
          Muitas análises seguidas. A MAVI volta em instantes.
        </p>
      )}
      {state.error && (
        <p className="copilot-error">
          {state.error}{" "}
          <button type="button" onClick={state.reviewNow}>
            Tentar de novo
          </button>
        </p>
      )}

      {nothing && !state.error && (
        <p className="copilot-empty">
          {typedEnough
            ? "A MAVI confere a tarefa quando você parar de digitar."
            : `Escreva o título e a descrição: a MAVI confere com o histórico do cliente (o que ele gosta, não gosta, já pediu) e avisa se falta algo ou se a tarefa está boa.`}
        </p>
      )}

      {alerts.length > 0 && (
        <ul className="copilot-alerts">
          {alerts.map((a) => (
            <AlertCard
              key={`${a.kind}:${a.title}`}
              alert={a}
              action={feedback.actionOf(a)}
              vote={feedback.voteOf(a)}
              onVote={async (vote, reason, comment) => {
                await feedback.vote(a, vote, reason, comment);
                redraw((v) => v + 1);
              }}
              onAct={(action) => act(a, action)}
              onApplyFix={
                onApplyFix && a.fix
                  ? () => {
                      onApplyFix(a.fix!);
                      act(a, "applied");
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      {(similar.length > 0 || cases.length > 0) && (
        <section className="copilot-related" aria-label="Relacionados">
          {similar.length > 0 && (
            <>
              <h3>
                Tarefas parecidas do cliente
                {state.related?.checked && (
                  <small className="copilot-checked">
                    {" "}
                    · conferidas pela MAVI
                  </small>
                )}
              </h3>
              <ul>
                {similar.map((t) => {
                  const st = statuses[t.status as Status];
                  const who = members.find(
                    (m) => m.user_id === t.assignee,
                  )?.name;
                  const inner = (
                    <>
                      <CheckSquare size={13} aria-hidden="true" />
                      <span className="copilot-related-title">{t.title}</span>
                      {t.duplicate && (
                        <em className="copilot-dup">possível duplicada</em>
                      )}
                      <small>
                        {st && (
                          <span
                            className="copilot-status-pill"
                            style={{ color: st.color }}
                          >
                            {st.label}
                          </span>
                        )}
                        {t.restricted
                          ? " · de um colega"
                          : who
                            ? ` · ${who}`
                            : ""}
                      </small>
                    </>
                  );
                  return (
                    <li key={t.id}>
                      {t.restricted ? (
                        // Tarefa que a pessoa não abre: só título e status.
                        <div
                          className="copilot-related-item"
                          title="Tarefa de um colega da equipe que você não acessa"
                        >
                          {inner}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            openInNewTab(
                              taskUrl({ id: t.id, title: t.title }, company()),
                            )
                          }
                          title="Abrir em outra aba"
                        >
                          {inner}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {cases.length > 0 && (
            <>
              <h3>
                Cases de sucesso
                {state.related?.checked && (
                  <small className="copilot-checked">
                    {" "}
                    · conferidos pela MAVI
                  </small>
                )}
              </h3>
              <ul>
                {cases.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() =>
                        openInNewTab(
                          `${pageUrl("cases", company())}?caso=${c.id}`,
                        )
                      }
                      title="Abrir em outra aba"
                    >
                      <Trophy size={13} aria-hidden="true" />
                      <span className="copilot-related-title">{c.title}</span>
                      {c.snippet && <small>{c.snippet}</small>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {!typedEnough && alerts.length === 0 && (
        <small className="copilot-hint">
          A análise começa com uns {MIN_REVIEW} caracteres.
        </small>
      )}
    </aside>
  );
}

const STEPS = [
  "Lendo a tarefa",
  "Conferindo o histórico do cliente",
  "Escrevendo o que vale apontar",
];

/**
 * O resultado no topo do painel, bem à vista: a análise em curso (com os
 * passos), a tarefa completa, os pontos a revisar ou nada a mudar. Pisca
 * quando um resultado novo chega.
 */
function CopilotResult({
  state,
  count,
}: {
  state: CopilotState;
  count: number;
}) {
  const v = state.verdict;
  const flash = useFlash(
    state.reviewing ? "" : v ? `${v.status}:${count}:${v.text}` : "",
  );
  if (state.reviewing)
    return (
      <div className="copilot-result is-working" role="status">
        <div className="copilot-result-head">
          <Sparkles size={18} className="copilot-sparkle" aria-hidden="true" />
          <strong>A MAVI está conferindo a tarefa</strong>
        </div>
        <ol className="copilot-steps">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={
                i + 1 < state.step
                  ? "done"
                  : i + 1 === state.step
                    ? "current"
                    : undefined
              }
            >
              <span aria-hidden="true" />
              {label}
            </li>
          ))}
        </ol>
        <div className="copilot-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(1, state.step) * 30}%` }} />
        </div>
      </div>
    );
  if (!v) return null;
  const tone = count ? "attention" : v.status;
  const Icon =
    tone === "ok" ? CheckCircle2 : tone === "attention" ? AlertTriangle : Info;
  const heading =
    tone === "ok"
      ? "Tarefa bem completa"
      : tone === "attention"
        ? count === 1
          ? "1 ponto para revisar"
          : `${count} pontos para revisar`
        : "Nada do histórico muda esta tarefa";
  const text =
    v.text ||
    (tone === "ok"
      ? "A MAVI conferiu com o histórico do cliente e não viu nada faltando."
      : tone === "attention"
        ? "Veja abaixo antes de criar."
        : "A MAVI não achou nada no histórico do cliente que precise entrar.");
  return (
    <div
      className={`copilot-result tone-${tone}${flash ? " flash" : ""}`}
      role="status"
    >
      <div className="copilot-result-head">
        <Icon size={20} aria-hidden="true" />
        <strong>{heading}</strong>
      </div>
      <p>{text}</p>
      {state.model && (
        <small
          className="copilot-result-model"
          title={`Esta análise foi feita com ${state.model.label}${
            state.model.provider
              ? ` (${state.model.provider}), pela regra do Painel da MAVI`
              : ", o padrão do servidor"
          }. A escolha fica no Painel da MAVI › Quem usa qual modelo › Por funcionalidade › Assistente MAVI na criação e edição de tarefas.`}
        >
          <Cpu size={11} aria-hidden="true" />
          {state.model.label}
          {state.model.provider && ` · ${state.model.provider}`}
        </small>
      )}
      {state.stale && (
        <small className="copilot-result-stale">
          O texto mudou: a MAVI confere de novo quando você parar de digitar.
        </small>
      )}
    </div>
  );
}

/** Verdadeiro por um instante sempre que `key` muda para um valor não vazio. */
function useFlash(key: string) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!key) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), 1600);
    return () => clearTimeout(t);
  }, [key]);
  return on;
}

/**
 * O selo ao lado do botão de criar/salvar: o que a MAVI achou, sem precisar
 * olhar o painel. Clicar leva ao painel (no celular ele fica embaixo).
 */
export function CopilotBadge({ state }: { state: CopilotState }) {
  const v = state.verdict;
  const count = state.alerts.length;
  if (!state.reviewing && !v) return null;
  const tone = state.reviewing
    ? "working"
    : count
      ? "attention"
      : (v?.status ?? "quiet");
  const label = state.reviewing
    ? "MAVI conferindo…"
    : tone === "ok"
      ? "MAVI: tarefa completa"
      : tone === "attention"
        ? `MAVI: ${count} ${count === 1 ? "ponto" : "pontos"} para revisar`
        : "MAVI: nada a mudar";
  const Icon =
    tone === "working"
      ? Sparkles
      : tone === "ok"
        ? CheckCircle2
        : tone === "attention"
          ? AlertTriangle
          : Info;
  return (
    <button
      type="button"
      className={`copilot-badge tone-${tone}`}
      onClick={(e) =>
        e.currentTarget
          .closest("form")
          ?.parentElement?.querySelector(".copilot")
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
      title="Ver o Assistente MAVI"
    >
      <Icon
        size={14}
        className={tone === "working" ? "copilot-sparkle" : undefined}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}

function AlertCard({
  alert: a,
  action,
  vote,
  onVote,
  onAct,
  onApplyFix,
}: {
  alert: CopilotAlert;
  action?: CopilotAction;
  vote?: { vote: CopilotVote; reason?: DownReason | null; comment?: string };
  onVote: (
    vote: CopilotVote | null,
    reason?: DownReason | null,
    comment?: string,
  ) => Promise<void>;
  onAct: (action: CopilotAction) => void;
  onApplyFix?: () => void;
}) {
  const Icon = KIND_ICONS[a.kind] ?? Info;
  // 👎 grava na hora e abre o "por quê" (motivo e comentário opcionais).
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<DownReason | null>(null);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const send = (
    next: CopilotVote | null,
    why?: DownReason | null,
    text?: string,
  ) => {
    setError("");
    onVote(next, why, text).catch(() =>
      setError("Não foi possível registrar. Tente de novo."),
    );
  };
  return (
    <li className={`copilot-alert kind-${a.kind} sev-${a.severity}`}>
      <div className="copilot-alert-head">
        <Icon size={14} aria-hidden="true" />
        <span className="copilot-kind">{ALERT_LABELS[a.kind]}</span>
        <button
          type="button"
          className="copilot-dismiss"
          onClick={() => onAct("dismissed")}
          aria-label="Dispensar"
          title="Dispensar"
        >
          <X size={13} />
        </button>
      </div>
      <strong>{a.title}</strong>
      {a.text && <p>{a.text}</p>}
      {a.quote && (
        <blockquote className="copilot-quote">“{a.quote}”</blockquote>
      )}
      {(a.sources.length > 0 || a.dossier.length > 0) && (
        <div className="copilot-sources">
          {a.dossier.map((d) => (
            <span key={d.id} className="copilot-chip dossier" title={d.text}>
              <BookMarked size={12} aria-hidden="true" /> Dossiê ·{" "}
              {DOSSIER_KINDS[d.kind] ?? d.kind}
            </span>
          ))}
          {a.sources.map((s) => (
            <SourceChip
              key={`${s.type}:${s.id}:${s.start ?? ""}`}
              source={s}
              onOpen={() => onAct("opened")}
            />
          ))}
        </div>
      )}
      <div className="copilot-actions">
        {onApplyFix &&
          (action === "applied" ? (
            <span className="copilot-applied">Adicionado à descrição</span>
          ) : (
            <button
              type="button"
              className="copilot-apply"
              onClick={onApplyFix}
              title={a.fix}
            >
              <CornerDownLeft size={13} aria-hidden="true" /> Aplicar na
              descrição
            </button>
          ))}
        <span className="copilot-vote">
          <button
            type="button"
            aria-pressed={vote?.vote === "up"}
            onClick={() => {
              setAsking(false);
              send(vote?.vote === "up" ? null : "up");
            }}
            aria-label="Ajudou"
            title="Ajudou"
          >
            <ThumbsUp size={13} />
          </button>
          <button
            type="button"
            aria-pressed={vote?.vote === "down"}
            onClick={() => {
              if (vote?.vote === "down") {
                setAsking(false);
                send(null);
                return;
              }
              setReason(null);
              setComment("");
              setSent(false);
              setAsking(true);
              send("down");
            }}
            aria-label="Não ajudou"
            title="Não ajudou"
          >
            <ThumbsDown size={13} />
          </button>
        </span>
      </div>
      {asking && vote?.vote === "down" && (
        <div className="copilot-why">
          {sent ? (
            <span className="copilot-thanks">
              Obrigado! A MAVI vai aprender com isso.
            </span>
          ) : (
            <>
              <small>Por que não ajudou?</small>
              <div className="copilot-reasons">
                {DOWN_REASONS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={reason === r.id}
                    onClick={() => setReason(r.id)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder="Conte à MAVI o que ela deveria saber (opcional)"
                aria-label="Comentário para a MAVI"
              />
              <div className="copilot-why-actions">
                <button type="button" onClick={() => setAsking(false)}>
                  Agora não
                </button>
                <button
                  type="button"
                  className="copilot-apply"
                  disabled={!reason && !comment.trim()}
                  onClick={() => {
                    send("down", reason, comment.trim());
                    setSent(true);
                  }}
                >
                  Enviar
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {error && <small className="copilot-error">{error}</small>}
    </li>
  );
}

function SourceChip({
  source: s,
  onOpen,
}: {
  source: AiSource;
  onOpen: () => void;
}) {
  const Icon = SOURCE_ICONS[s.type as keyof typeof SOURCE_ICONS] ?? FileText;
  if (s.restricted)
    return (
      <span
        className="copilot-chip locked"
        title={`${s.title} (tarefa de um colega que você não acessa)`}
      >
        <Icon size={12} aria-hidden="true" /> Tarefa de um colega
      </span>
    );
  return (
    <button
      type="button"
      className="copilot-chip"
      onClick={() => {
        onOpen();
        openInNewTab(sourceUrl(s));
      }}
      title={`${s.title} (abre em outra aba)`}
    >
      <Icon size={12} aria-hidden="true" /> {sourceLabel(s)}
    </button>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowRight,
  BadgeCheck,
  Check,
  Clock,
  ListPlus,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  X,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  ExternalLink,
  Copy,
  History,
  Lightbulb,
  Radar,
  RefreshCw,
  Sparkles,
  Star,
  TrendingUp,
  Target,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Empty, Modal } from "./components";
import { navigate, taskUrl, useUrlState } from "./router";
import { appPath } from "./temperature";
import type { FormPreset } from "./forms";
import type { Snapshot } from "./types";
import {
  DISMISS_REASONS,
  KIND_LABELS,
  LEVEL_LABELS,
  PRIORITY_LABELS,
  RUN_STATUS,
  SOURCE_LABELS,
  WINDOW_LABELS,
  basisHint,
  basisLabel,
  dayLabel,
  effectText,
  goalStageText,
  insightTaskPreset,
  negativeLine,
  negativesText,
  formatEvidence,
  localParts,
  money,
  nextScheduled,
  scheduleText,
  usageText,
  waitText,
  whenText,
  type CampaignInsight,
  type CampaignInsightsView,
  type CampaignOwner,
  type CrmGoal,
  type CrmPipeline,
  type GoalStage,
  type InsightNegative,
  type InsightBadge,
  type InsightKind,
  type InsightRun,
  type InsightsBackend,
  type InsightStatus,
} from "./campaign-insights";
import "./campaign-insights.css";

/**
 * Campanhas › Insights da MAVI: o painel ao lado da campanha (os insights
 * abertos da última análise), a aba "Insights" (todos + o histórico das
 * análises, com custo) e o selo da lista. A análise é agendada pelo Painel
 * da MAVI ou pedida em "Analisar agora"; quando fica pronta, o banco avisa
 * (Realtime, evento mavi:campaign-insights) e a tela se recarrega.
 */

const KIND_ICONS: Record<InsightKind, typeof Star> = {
  highlight: Star,
  opportunity: TrendingUp,
  problem: TriangleAlert,
  tracking: Radar,
};

/** Os insights de uma campanha, recarregados quando o banco avisa. */
export function useCampaignInsights(backend: InsightsBackend, company: string, campaign: string) {
  const [view, setView] = useState<CampaignInsightsView | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    backend
      .view(company, campaign)
      .then((v) => {
        if (!live) return;
        setView(v);
        setError("");
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [backend, company, campaign, tick]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ campaign?: string }>).detail;
      if (!d?.campaign || d.campaign === campaign) setTick((t) => t + 1);
    };
    window.addEventListener("mavi:campaign-insights", on);
    return () => window.removeEventListener("mavi:campaign-insights", on);
  }, [campaign]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { view, error, reload };
}
export type InsightsState = ReturnType<typeof useCampaignInsights>;

/** O que as ações precisam: a campanha, os dados (para a tarefa) e o formulário de tarefa. */
export type InsightContext = {
  campaign: { id: string; name: string; contract_id: string };
  data: Snapshot;
  user: string;
  /** Abre o formulário de tarefa (sem ele, não há "Criar tarefa"). */
  onNewTask?: (preset: FormPreset) => void;
};
type Handlers = {
  status: (i: CampaignInsight, status: InsightStatus) => void;
  dismiss: (i: CampaignInsight) => void;
  snooze: (i: CampaignInsight) => void;
  vote: (i: CampaignInsight, vote: "up" | "down") => void;
  task?: (i: CampaignInsight) => void;
  busy: string | null;
};

const at = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
};
const SNOOZE: [string, () => Date][] = [
  ["Amanhã às 9h", () => at(1)],
  ["Em 3 dias", () => at(3)],
  ["Em 1 semana", () => at(7)],
  ["Em 2 semanas", () => at(14)],
];

/** As ações dos insights (com as janelas de motivo e de data) para uma lista. */
function useInsightActions(
  state: InsightsState,
  backend: InsightsBackend,
  company: string,
  ctx: InsightContext,
  notify: (message: string) => void,
): { handlers: Handlers; dialogs: ReactNode } {
  const [busy, setBusy] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<{
    insight: CampaignInsight;
    mode: "dismiss" | "down";
  } | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<CampaignInsight | null>(null);
  const run = async (id: string, job: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await job();
      notify(done);
      state.reload();
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const handlers: Handlers = {
    busy,
    status: (i, status) =>
      void run(
        i.id,
        () => backend.setStatus(company, i.id, status),
        status === "applied"
          ? "Marcado como aplicado: a MAVI mede o efeito nas próximas análises."
          : "Insight reaberto.",
      ),
    dismiss: (i) => setReasonFor({ insight: i, mode: "dismiss" }),
    snooze: (i) => setSnoozeFor(i),
    vote: (i, v) => {
      if (i.my_vote === v) void run(i.id, () => backend.vote(company, i.id, null), "Avaliação retirada.");
      else if (v === "down") setReasonFor({ insight: i, mode: "down" });
      else void run(i.id, () => backend.vote(company, i.id, "up"), "Obrigado! A MAVI aprende com a avaliação.");
    },
    ...(ctx.onNewTask
      ? {
          task: (i: CampaignInsight) => {
            const preset = insightTaskPreset(i, ctx.campaign, ctx.data, ctx.user);
            if (!preset) {
              notify("Você não pode criar tarefas neste cliente.");
              return;
            }
            ctx.onNewTask!({
              ...preset,
              onCreated: (task) =>
                void backend
                  .linkTask(company, i.id, task)
                  .then(() => state.reload())
                  .catch((e) => notify((e as Error).message)),
            });
          },
        }
      : {}),
  };
  const dialogs = (
    <>
      {reasonFor && (
        <ReasonDialog
          insight={reasonFor.insight}
          mode={reasonFor.mode}
          onClose={() => setReasonFor(null)}
          onSave={async (reason, comment) => {
            const i = reasonFor.insight;
            const ok = await run(
              i.id,
              () =>
                reasonFor.mode === "dismiss"
                  ? backend.setStatus(company, i.id, "dismissed", {
                      reason,
                      comment,
                    })
                  : backend.vote(company, i.id, "down", reason || undefined, comment),
              reasonFor.mode === "dismiss"
                ? "Insight descartado. A MAVI aprende com o motivo."
                : "Obrigado! A MAVI aprende com a avaliação.",
            );
            if (ok) setReasonFor(null);
          }}
        />
      )}
      {snoozeFor && (
        <SnoozeDialog
          insight={snoozeFor}
          onClose={() => setSnoozeFor(null)}
          onSave={async (until) => {
            const ok = await run(
              snoozeFor.id,
              () =>
                backend.setStatus(company, snoozeFor.id, "snoozed", {
                  until: until.toISOString(),
                }),
              `Combinado: o insight volta ${until.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}, com aviso na sua caixa de entrada.`,
            );
            if (ok) setSnoozeFor(null);
          }}
        />
      )}
    </>
  );
  return { handlers, dialogs };
}

/** Descartar (motivo obrigatório) ou 👎 (motivo opcional). */
function ReasonDialog({
  insight,
  mode,
  onClose,
  onSave,
}: {
  insight: CampaignInsight;
  mode: "dismiss" | "down";
  onClose: () => void;
  onSave: (reason: string, comment: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "dismiss" && !reason) return setError("Escolha o motivo do descarte.");
    if (reason === "other" && !comment.trim()) return setError("Conte o motivo em poucas palavras.");
    setSaving(true);
    await onSave(reason, comment.trim());
    setSaving(false);
  };
  return (
    <Modal title={mode === "dismiss" ? "Descartar o insight" : "O que não ajudou?"} onClose={onClose} busy={saving}>
      <form className="entity-form insights-reason" onSubmit={(e) => void submit(e)}>
        <p className="campaign-form-context">{insight.title}</p>
        <fieldset className="insights-reasons">
          <legend>{mode === "dismiss" ? "Motivo (obrigatório)" : "Motivo (opcional)"}</legend>
          {DISMISS_REASONS.map((r) => (
            <label key={r.id} className={reason === r.id ? "on" : ""}>
              <input type="radio" name="reason" checked={reason === r.id} onChange={() => setReason(r.id)} />
              {r.label}
            </label>
          ))}
        </fieldset>
        <label>
          Comentário {reason === "other" ? "(obrigatório)" : "(opcional)"}
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 500))}
            rows={3}
            placeholder="Ex.: o cliente não tem margem para frete grátis"
          />
          <small>
            A MAVI aprende com o motivo: aprendizados confirmados por 2 pessoas (ou por um líder) valem nas próximas
            análises.
          </small>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={saving}>
            {mode === "dismiss" ? "Descartar" : "Enviar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Lembrar depois: quando o insight volta. */
function SnoozeDialog({
  insight,
  onClose,
  onSave,
}: {
  insight: CampaignInsight;
  onClose: () => void;
  onSave: (until: Date) => Promise<void>;
}) {
  const [choice, setChoice] = useState(0);
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let until: Date;
    if (choice < SNOOZE.length) until = SNOOZE[choice][1]();
    else {
      if (!date) return setError("Escolha a data.");
      until = new Date(`${date}T09:00:00`);
      if (until.getTime() <= Date.now()) return setError("Escolha uma data a partir de amanhã.");
    }
    setSaving(true);
    await onSave(until);
    setSaving(false);
  };
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return (
    <Modal title="Lembrar depois" onClose={onClose} busy={saving}>
      <form className="entity-form insights-reason" onSubmit={(e) => void submit(e)}>
        <p className="campaign-form-context">{insight.title}</p>
        <fieldset className="insights-reasons">
          <legend>O insight sai dos abertos e volta</legend>
          {[...SNOOZE.map(([label]) => label), "Escolher a data"].map((label, i) => (
            <label key={label} className={choice === i ? "on" : ""}>
              <input type="radio" name="snooze" checked={choice === i} onChange={() => setChoice(i)} />
              {label}
            </label>
          ))}
        </fieldset>
        {choice === SNOOZE.length && (
          <label>
            Data
            <Input type="date" min={tomorrow} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        )}
        <small className="insights-why">Quando voltar, você recebe um lembrete na caixa de entrada.</small>
        {error && <p className="form-error">{error}</p>}
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={saving}>
            Combinar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** "Analisar agora", com o porquê quando não dá (e quando libera). */
function AnalyzeNow({
  state,
  backend,
  company,
  campaign,
  notify,
  compact = false,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const v = state.view;
  if (!v) return null;
  const now = new Date();
  const waiting = v.wait_until && new Date(v.wait_until) > now ? v.wait_until : null;
  const last = v.runs.find((r) => r.status === "done");
  const disabled = !!v.pending || !!v.blocker || !!waiting || v.capped;
  const why = v.pending
    ? "Já há uma análise em andamento."
    : v.blocker
      ? v.blocker
      : v.capped
        ? "O teto do mês dos insights foi atingido."
        : waiting
          ? `A última análise é recente: a próxima libera ${waitText(waiting, now)}.`
          : "";
  const run = async () => {
    setBusy(true);
    setMessage("");
    try {
      const r = await backend.request(company, campaign);
      if (r.ok) notify("A MAVI começou a analisar a campanha. Os insights aparecem aqui quando ficarem prontos.");
      else setMessage(r.reason ?? "Não foi possível pedir a análise agora.");
      state.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`insights-analyze${compact ? " compact" : ""}`}>
      <Button
        className="btn secondary"
        onClick={() => void run()}
        loading={busy}
        disabled={disabled}
        title={why || "Pedir uma análise da MAVI agora (fica no histórico, com o custo)"}
      >
        <RefreshCw size={15} /> Analisar agora
      </Button>
      {(message || (why && !v.pending)) && (
        <small className="insights-why" role="status">
          {message || why}
          {last && (waiting || message) && (
            <>
              {" "}
              Última: {whenText(last.finished_at ?? last.created_at, now, v.timezone)}
              {last.trigger === "manual" && last.requested_by_name ? `, por ${last.requested_by_name}` : ", agendada"}.
            </>
          )}
        </small>
      )}
    </div>
  );
}

/** Quando foi a última e quando é a próxima. */
function statusLine(v: CampaignInsightsView) {
  const now = new Date();
  const last = v.runs.find((r) => r.status === "done");
  const parts: string[] = [];
  if (last) parts.push(`Última análise ${whenText(last.finished_at ?? last.created_at, now, v.timezone)}`);
  const next = nextScheduled(v.schedule, v.last_scheduled_day, now, v.timezone);
  if (next) {
    const today = localParts(now, v.timezone).day;
    parts.push(`próxima ${dayLabel(next.day, today)} a partir das ${next.hour}h`);
  } else parts.push("agendamento desligado");
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A análise em andamento — ou esperando a cota da plataforma liberar. */
function PendingLine({
  pending,
  timezone,
}: {
  pending: NonNullable<CampaignInsightsView["pending"]>;
  timezone: string;
}) {
  const who =
    pending.trigger === "manual" && pending.requested_by_name ? ` Pedida por ${pending.requested_by_name}.` : "";
  if (pending.waiting_until) {
    const at = new Date(pending.waiting_until).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone || undefined,
    });
    return (
      <p className="insights-running waiting" role="status" title={pending.note || undefined}>
        <span className="insights-pulse" aria-hidden="true" />
        Na fila: volta às {at}
        {pending.note ? ` (${pending.note.replace(/: a análise espera.*$/, "")})` : ""}.{who}
      </p>
    );
  }
  return (
    <p className="insights-running" role="status">
      <span className="insights-pulse" aria-hidden="true" />
      {pending.status === "running" ? "Analisando a campanha…" : "Análise na fila…"}
      {who}
    </p>
  );
}

/** Um insight: o que os números mostram, a ação e as evidências. */
export function InsightCard({
  insight,
  compact = false,
  handlers,
  first = false,
}: {
  insight: CampaignInsight;
  compact?: boolean;
  /** As ações (sem elas, só leitura — ex.: o histórico das análises). */
  handlers?: Handlers;
  /** O primeiro aberto da análise: "Comece por aqui". */
  first?: boolean;
}) {
  const Icon = KIND_ICONS[insight.kind];
  const steps = insight.action
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const numbers = (
    <ul className="insight-evidence" aria-label="Os números">
      {insight.evidence.map((e) => (
        <li key={`${e.entity}|${e.window}|${e.metric}`}>
          <span>{e.label}</span>
          <strong>{formatEvidence(e)}</strong>
          <small>
            {e.name} · {WINDOW_LABELS[e.window]}
          </small>
        </li>
      ))}
    </ul>
  );
  return (
    <article
      className={`insight-card kind-${insight.kind} prio-${insight.priority}${compact ? " compact" : ""}${first ? " first" : ""}`}
    >
      {first && (
        <p className="insight-first">
          <Star size={12} aria-hidden="true" /> Comece por aqui
        </p>
      )}
      <header>
        <span className="insight-kind">
          <Icon size={13} aria-hidden="true" /> {KIND_LABELS[insight.kind]}
        </span>
        <span className={`insight-prio prio-${insight.priority}`} title="Prioridade">
          {PRIORITY_LABELS[insight.priority]}
        </span>
        {insight.seen_count > 1 && (
          <span className="insight-seen" title="A MAVI encontrou de novo nas análises seguintes">
            visto {insight.seen_count}x
          </span>
        )}
      </header>
      <h4>{insight.title}</h4>
      {insight.target && (
        <p className="insight-target">
          {LEVEL_LABELS[insight.target.level]}: <strong>{insight.target.name}</strong>
          {insight.target.parent ? <> · em {insight.target.parent}</> : null}
        </p>
      )}
      {insight.body && (
        <div className="insight-section">
          <span className="insight-label">O que está acontecendo</span>
          <p className="insight-body">{insight.body}</p>
        </div>
      )}
      {!!steps.length && (
        <div className="insight-section insight-action">
          <span className="insight-label">
            <ArrowRight size={13} aria-hidden="true" /> O que fazer
          </span>
          {steps.length === 1 ? (
            <p>{steps[0]}</p>
          ) : (
            <ol>
              {steps.map((x, k) => (
                <li key={k}>{x}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      {!!insight.extra?.negatives?.length && <NegativesList list={insight.extra.negatives} compact={compact} />}
      {compact ? (
        <details className="insight-numbers">
          <summary>Ver os números ({insight.evidence.length})</summary>
          {numbers}
        </details>
      ) : (
        <div className="insight-section">
          <span className="insight-label">Os números</span>
          {numbers}
        </div>
      )}
      {insight.status !== "new" && <StatusLine insight={insight} />}
      {!!insight.tasks?.length && (
        <ul className="insight-tasks" aria-label="Tarefas">
          {insight.tasks.map((t) => (
            <li key={t.id}>
              <ListPlus size={12} aria-hidden="true" />
              <a
                href={appPath(taskUrl(t, ""))}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(appPath(taskUrl(t, "")));
                }}
              >
                {t.title}
              </a>
              {t.assignee_name && <small>{t.assignee_name}</small>}
            </li>
          ))}
        </ul>
      )}
      {handlers && <Actions insight={insight} handlers={handlers} compact={compact} />}
      <footer>
        <span className="insight-basis" title={basisHint(insight.money_basis)}>
          Valores {basisLabel(insight.money_basis)}
        </span>
        {insight.source === "watch" ? (
          <span title="A vigia diária confere os números todo dia, sem a MAVI; o aviso sai sozinho quando a situação passa">
            <Radar size={12} aria-hidden="true" /> Vigia diária
          </span>
        ) : insight.source === "rule" ? (
          <span title="Encontrado pelas regras do sistema, sem modelo">Detecção automática</span>
        ) : insight.confidence !== null ? (
          <span title="O Jev conferiu que as evidências sustentam o insight">
            <BadgeCheck size={12} aria-hidden="true" /> Conferido ({Math.round(insight.confidence * 100)}%)
          </span>
        ) : (
          <span>
            <Sparkles size={12} aria-hidden="true" /> MAVI
          </span>
        )}
      </footer>
    </article>
  );
}

/** As negativas do Google: a lista e o botão que copia no formato que o Google Ads entende. */
function NegativesList({ list, compact }: { list: InsightNegative[]; compact: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const value = negativesText(list);
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // Sem a API (ou sem permissão): o jeito antigo, por uma caixa de texto escondida.
      const box = document.createElement("textarea");
      box.value = value;
      box.setAttribute("readonly", "");
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      box.remove();
    }
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };
  const rows = (
    <ul className="insight-negatives">
      {list.map((n) => (
        <li key={`${n.campaign}|${n.term}`}>
          <code>{negativeLine(n)}</code>
          <span>{n.spend.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
          {n.why && <small>{n.why}</small>}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="insight-section">
      <span className="insight-label">
        Negativas ({list.length})
        <button type="button" className="text-btn insight-copy" onClick={() => void copy()}>
          {copied ? (
            <>
              <Check size={12} aria-hidden="true" /> Copiado
            </>
          ) : (
            <>
              <Copy size={12} aria-hidden="true" /> Copiar negativas
            </>
          )}
        </button>
      </span>
      {compact ? (
        <details className="insight-numbers">
          <summary>Ver a lista</summary>
          {rows}
        </details>
      ) : (
        rows
      )}
      <small className="insight-negatives-hint">
        [exata] bloqueia só o termo; "frase" bloqueia qualquer busca que o contenha.
      </small>
    </div>
  );
}

const shortDay = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
      })
    : "";
/** Aplicado (com o efeito), adiado ou descartado — e por quem. */
function StatusLine({ insight: i }: { insight: CampaignInsight }) {
  const who = i.status_by_name ? ` por ${i.status_by_name}` : "";
  if (i.status === "applied")
    return (
      <div className={`insight-status applied${i.effect ? ` ${i.effect.verdict}` : ""}`}>
        <strong>
          <Check size={13} aria-hidden="true" /> Aplicado{who} em {shortDay(i.applied_at)}
        </strong>
        <span>
          {i.effect ? effectText(i.effect) : "A MAVI mede o efeito nas próximas análises (a partir de 3 dias depois)."}
        </span>
      </div>
    );
  if (i.status === "snoozed")
    return (
      <div className="insight-status snoozed">
        <strong>
          <Clock size={13} aria-hidden="true" /> Volta em {shortDay(i.snooze_until)}
        </strong>
        <span>Adiado{who}.</span>
      </div>
    );
  return (
    <div className="insight-status dismissed">
      <strong>
        <X size={13} aria-hidden="true" /> Descartado{who}
      </strong>
      {i.status_reason && <span>{i.status_reason}</span>}
    </div>
  );
}

/** Os botões do insight: aplicar, lembrar depois, descartar, tarefa, 👍/👎 (ou reabrir). */
function Actions({
  insight: i,
  handlers: h,
  compact,
}: {
  insight: CampaignInsight;
  handlers: Handlers;
  compact: boolean;
}) {
  const busy = h.busy === i.id;
  if (i.status !== "new")
    return (
      <div className="insight-actions">
        <button type="button" className="text-btn" disabled={busy} onClick={() => h.status(i, "new")}>
          <RotateCcw size={13} aria-hidden="true" /> Reabrir
        </button>
        {h.task && !compact && (
          <button type="button" className="text-btn" disabled={busy} onClick={() => h.task!(i)}>
            <ListPlus size={13} aria-hidden="true" /> Criar tarefa
          </button>
        )}
      </div>
    );
  return (
    <div className={`insight-actions${compact ? " compact" : ""}`}>
      <button
        type="button"
        className="insight-act apply"
        disabled={busy}
        onClick={() => h.status(i, "applied")}
        title="Marcar como aplicado (a MAVI mede o efeito depois)"
      >
        <Check size={14} aria-hidden="true" />
        {!compact && "Aplicado"}
      </button>
      <button type="button" className="insight-act" disabled={busy} onClick={() => h.snooze(i)} title="Lembrar depois">
        <Clock size={14} aria-hidden="true" />
        {!compact && "Lembrar depois"}
      </button>
      <button
        type="button"
        className="insight-act"
        disabled={busy}
        onClick={() => h.dismiss(i)}
        title="Descartar (com motivo)"
      >
        <X size={14} aria-hidden="true" />
        {!compact && "Descartar"}
      </button>
      {h.task && (
        <button
          type="button"
          className="insight-act"
          disabled={busy}
          onClick={() => h.task!(i)}
          title="Criar tarefa a partir do insight"
        >
          <ListPlus size={14} aria-hidden="true" />
          {!compact && "Criar tarefa"}
        </button>
      )}
      <span className="insight-votes">
        <button
          type="button"
          className={`insight-vote${i.my_vote === "up" ? " on" : ""}`}
          disabled={busy}
          aria-pressed={i.my_vote === "up"}
          onClick={() => h.vote(i, "up")}
          title="Ajudou"
        >
          <ThumbsUp size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`insight-vote${i.my_vote === "down" ? " on" : ""}`}
          disabled={busy}
          aria-pressed={i.my_vote === "down"}
          onClick={() => h.vote(i, "down")}
          title="Não ajudou"
        >
          <ThumbsDown size={13} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}

const COLLAPSED_KEY = "mavi:campanhas:insights-recolhido";
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};

/** O painel ao lado da campanha (em qualquer aba). */
export function CampaignInsightsAside({
  state,
  backend,
  company,
  campaign,
  notify,
  showTab,
  ctx,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
  /** A aba Insights está ligada (o link "Ver tudo"). */
  showTab: boolean;
  ctx: InsightContext;
}) {
  const { handlers, dialogs } = useInsightActions(state, backend, company, ctx, notify);
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const [tab, setTab] = useUrlState<string>("aba", "dia");
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      /* sem armazenamento: só nesta visita */
    }
  };
  const v = state.view;
  // Na aba Insights o painel repetiria o mesmo conteúdo.
  if (!v || !v.enabled || !v.places.panel || (showTab && tab === "insights")) return null;
  const list = v.current;
  const high = list.filter((i) => i.priority === "high").length;
  if (collapsed)
    return (
      <aside className="campaign-insights-aside collapsed" aria-label="Insights da MAVI">
        <button
          type="button"
          className="insights-rail"
          onClick={() => setCollapsed(false)}
          title="Mostrar os insights da MAVI"
        >
          <ChevronsLeft size={15} aria-hidden="true" />
          <Lightbulb size={16} aria-hidden="true" />
          {list.length > 0 && <span className={`insights-count${high ? " high" : ""}`}>{list.length}</span>}
          <span className="insights-rail-label">Insights</span>
        </button>
      </aside>
    );
  return (
    <aside className="panel campaign-insights-aside" aria-label="Insights da MAVI">
      <header>
        <Lightbulb size={17} aria-hidden="true" />
        <div>
          <strong>Insights da MAVI</strong>
          <small>{statusLine(v)}</small>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setCollapsed(true)}
          title="Recolher"
          aria-label="Recolher os insights"
        >
          <ChevronsRight size={16} />
        </button>
      </header>
      {v.pending && <PendingLine pending={v.pending} timezone={v.timezone} />}
      <div className="insights-aside-list">
        {list.slice(0, 4).map((i, k) => (
          <InsightCard key={i.id} insight={i} compact handlers={handlers} first={k === 0 && list.length > 1} />
        ))}
        {!list.length && !v.pending && (
          <p className="insights-empty">
            {v.blocker
              ? v.blocker
              : v.runs.some((r) => r.status === "done")
                ? "Nada que mereça ação na última análise."
                : "A MAVI ainda não analisou esta campanha."}
          </p>
        )}
      </div>
      <footer>
        <AnalyzeNow state={state} backend={backend} company={company} campaign={campaign} notify={notify} compact />
        {showTab && (list.length > 4 || v.runs.length > 0) && (
          <button type="button" className="text-btn" onClick={() => setTab("insights")}>
            {list.length > 4 ? `Ver os ${list.length} insights` : "Ver tudo"} e o histórico
          </button>
        )}
      </footer>
      {dialogs}
    </aside>
  );
}

function RunRow({ run, timezone, expireDays }: { run: InsightRun; timezone: string; expireDays?: number }) {
  const [open, setOpen] = useState(false);
  const now = new Date();
  const who = run.trigger === "manual" ? `Pedida por ${run.requested_by_name ?? "alguém"}` : "Agendada";
  const count =
    run.status === "done"
      ? [
          run.insights_count ? `${run.insights_count} ${run.insights_count === 1 ? "novo" : "novos"}` : "",
          run.repeated_count ? `${run.repeated_count} ${run.repeated_count === 1 ? "confirmado" : "confirmados"}` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "nada novo"
      : "";
  return (
    <li className={`insights-run status-${run.status}`}>
      <button type="button" className="insights-run-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span className="insights-run-when">{whenText(run.created_at, now, timezone)}</span>
        <span className="insights-run-who">{who}</span>
        <span className={`insights-run-status status-${run.status}`}>{RUN_STATUS[run.status]}</span>
        <span className="insights-run-count">{count}</span>
        <span
          className="insights-run-cost"
          title={run.model ? `Modelo: ${run.model}${run.provider_name ? ` (${run.provider_name})` : ""}` : undefined}
        >
          {run.status === "done" || run.cost_usd ? money(run.cost_usd) : ""}
        </span>
      </button>
      {open && (
        <div className="insights-run-body">
          {run.summary && <p className="insights-run-summary">{run.summary}</p>}
          {!!run.expired_count && (
            <p className="insights-run-expired">
              {run.expired_count} {run.expired_count === 1 ? "insight expirou" : "insights expiraram"} sem uso (
              {expireDays ? `${expireDays} dias` : "o prazo do Painel da MAVI"}
              abertos sem ser aplicado, adiado, descartado, avaliado ou virar tarefa) e saiu da tela.
            </p>
          )}
          {run.note && (
            <p className="insights-run-note">
              <CircleAlert size={13} aria-hidden="true" /> {run.note}
            </p>
          )}
          <dl className="insights-run-meta">
            {run.model && (
              <>
                <dt>Modelo</dt>
                <dd>
                  {run.model}
                  {run.provider_name ? ` (${run.provider_name})` : ""}
                </dd>
              </>
            )}
            {run.money_basis && (
              <>
                <dt>Valores</dt>
                <dd title={basisHint(run.money_basis)}>{basisLabel(run.money_basis)}</dd>
              </>
            )}
            {run.windows.cycle && (
              <>
                <dt>Ciclo lido</dt>
                <dd>
                  {run.windows.cycle.since.split("-").reverse().slice(0, 2).join("/")} a{" "}
                  {run.windows.cycle.until.split("-").reverse().slice(0, 2).join("/")}
                </dd>
              </>
            )}
            <dt>Custo</dt>
            <dd>{money(run.cost_usd)}</dd>
            {usageText(run) && (
              <>
                <dt>Uso</dt>
                <dd>{usageText(run)}</dd>
              </>
            )}
          </dl>
          {run.insights.length > 0 && (
            <div className="insights-grid">
              {run.insights.map((i) => (
                <InsightCard key={i.id} insight={i} />
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Os responsáveis pela campanha: recebem os avisos dos insights (quem edita campanhas escolhe). */
function Owners({
  state,
  backend,
  company,
  campaign,
  notify,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
}) {
  const owners = state.view?.owners ?? [];
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<CampaignOwner[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = () => {
    setOpen(true);
    setError("");
    setChosen(owners.map((o) => o.id));
    backend.ownerCandidates(company, campaign).then(setPeople, (e: Error) => setError(e.message));
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await backend.setOwners(company, campaign, chosen);
      setOpen(false);
      notify("Responsáveis salvos.");
      state.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="insights-owners">
      <UserRound size={14} aria-hidden="true" />
      <span>
        <strong>Responsáveis:</strong>{" "}
        {owners.length ? owners.map((o) => o.name).join(", ") : "nenhum (os avisos vão para as equipes do cliente)"}
      </span>
      {state.view?.can_set_owners && (
        <button type="button" className="text-btn" onClick={start}>
          {owners.length ? "Alterar" : "Escolher"}
        </button>
      )}
      {open && (
        <Modal title="Responsáveis pela campanha" onClose={() => setOpen(false)} busy={busy}>
          <form
            className="entity-form insights-reason"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <p className="insights-owners-help">
              Quem responde pela campanha recebe os avisos dos insights da MAVI (caixa de entrada e push). Até 5
              pessoas.
            </p>
            {!people && !error && <Loading variant="list" />}
            {people && (
              <ul className="insights-owners-list">
                {people.map((p) => {
                  const on = chosen.includes(p.id);
                  return (
                    <li key={p.id}>
                      <label className="cins-check">
                        <Checkbox
                          checked={on}
                          disabled={!on && chosen.length >= 5}
                          onCheckedChange={(v) =>
                            setChosen((c) => (v === true ? [...c, p.id] : c.filter((x) => x !== p.id)))
                          }
                        />
                        <span>{p.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-footer">
              <Button type="button" className="btn secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" className="btn primary" loading={busy} disabled={!people}>
                Salvar
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * As etapas do CRM que importam (ex.: Qualificado, Negociação, Ganho), cada
 * uma com a meta de custo por lead: a régua principal da MAVI. Valem para o
 * cliente (todas as campanhas dele) ou só para esta campanha. As etapas vêm
 * do MakeCRM do cliente na hora.
 */
function CrmGoalEditor({
  state,
  backend,
  company,
  campaign,
  notify,
  ctx,
  onClose,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
  ctx: InsightContext;
  onClose: () => void;
}) {
  const goal = state.view?.crm_goal ?? null;
  const basis = state.view?.money_basis ?? "net";
  const contract = ctx.data.contracts.find((c) => c.id === ctx.campaign.contract_id);
  const client = contract?.client_id ?? "";
  const clientName = ctx.data.clients.find((c) => c.id === client)?.name ?? "o cliente";
  const [pipelines, setPipelines] = useState<CrmPipeline[] | null>(null);
  const [linked, setLinked] = useState(true);
  const [scope, setScope] = useState<"client" | "campaign">(goal?.source ?? "client");
  // O padrão do cliente (quando a campanha usa o padrão, são as próprias etapas que valem).
  const clientStages = goal?.client_stages ?? (goal?.source === "client" ? goal.stages : []);
  const initial = (s: "client" | "campaign") =>
    s === "client" ? clientStages : goal?.source === "campaign" ? goal.stages : clientStages;
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initial(goal?.source ?? "client").map((x) => [x.stage_id, x.cost_goal ? String(x.cost_goal) : ""]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    backend.crmPipelines(company, client).then(
      (r) => {
        if (!live) return;
        setLinked(r.linked);
        setPipelines(r.pipelines);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [backend, company, client]);
  const switchScope = (s: "client" | "campaign") => {
    setScope(s);
    setChosen(Object.fromEntries(initial(s).map((x) => [x.stage_id, x.cost_goal ? String(x.cost_goal) : ""])));
  };
  const save = async (clear = false) => {
    setBusy(true);
    setError("");
    try {
      const stages: GoalStage[] = [];
      if (!clear)
        for (const p of pipelines ?? [])
          for (const st of p.stages) {
            if (!(st.id in chosen)) continue;
            const raw = chosen[st.id].trim().replace(",", ".");
            const value = raw ? Number(raw) : null;
            if (value !== null && !(value > 0)) throw Error(`A meta de "${st.name}" precisa ser maior que zero.`);
            stages.push({
              pipeline_id: p.id,
              pipeline_name: p.name,
              stage_id: st.id,
              stage_name: st.name,
              cost_goal: value,
            });
          }
      if (!clear && !stages.length) throw Error("Escolha ao menos uma etapa.");
      await backend.setCrmGoal(company, campaign, { scope, stages });
      onClose();
      notify(
        clear
          ? scope === "campaign"
            ? "A campanha voltou ao padrão do cliente."
            : "Etapas do cliente removidas."
          : "Etapas que importam salvas.",
      );
      state.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const many = (pipelines?.length ?? 0) > 1;
  const count = Object.keys(chosen).length;
  return (
    <Modal title="Etapas que importam no CRM" onClose={onClose} busy={busy}>
      <form
        className="entity-form insights-reason crm-goal-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="insights-owners-help">
          Marque as etapas do funil que mostram que o lead é bom (ex.: Qualificado, Negociação, Ganho) e, se quiser, a
          meta de custo por lead em cada uma. A MAVI mede quanto custa cada lead que chega a elas e mostra onde o funil
          estoura.
        </p>
        <div className="cins-radio crm-goal-scope" role="radiogroup" aria-label="Para quem vale">
          {(
            [
              ["client", `Padrão de ${clientName}`, "Vale para todas as campanhas do cliente."],
              ["campaign", "Só esta campanha", "Ajuste próprio: a campanha ignora o padrão do cliente."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className={scope === value ? "on" : ""}>
              <input type="radio" name="crm-goal-scope" checked={scope === value} onChange={() => switchScope(value)} />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
        {!pipelines && !error && <Loading variant="list" />}
        {pipelines && !linked && <p className="insights-empty">O cliente desta campanha não está ligado ao MakeCRM.</p>}
        {pipelines && linked && (
          <div className="crm-goal-pipelines">
            {pipelines.map((p) => (
              <fieldset key={p.id}>
                {many && <legend>{p.name}</legend>}
                {p.stages.map((st) => {
                  const on = st.id in chosen;
                  return (
                    <div key={st.id} className={`crm-goal-stage${on ? " on" : ""}`}>
                      <label className="cins-check">
                        <Checkbox
                          checked={on}
                          disabled={!on && count >= 6}
                          onCheckedChange={(v) =>
                            setChosen((c) => {
                              const next = { ...c };
                              if (v === true) next[st.id] = "";
                              else delete next[st.id];
                              return next;
                            })
                          }
                        />
                        <span>{st.name}</span>
                      </label>
                      {on && (
                        <Input
                          type="number"
                          min="0.01"
                          step="0.01"
                          inputMode="decimal"
                          value={chosen[st.id]}
                          placeholder={`Meta R$ (${basisLabel(basis)})`}
                          aria-label={`Meta de custo por lead em ${st.name}`}
                          onChange={(e) => setChosen((c) => ({ ...c, [st.id]: e.target.value }))}
                        />
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </div>
        )}
        <small className="crm-goal-note">
          Até 6 etapas. A meta é opcional: acima dela, a MAVI avisa — com calma quando muitos leads ainda são recentes.
        </small>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {((scope === "campaign" && goal?.source === "campaign") ||
            (scope === "client" && clientStages.length > 0)) && (
            <Button type="button" className="btn secondary" onClick={() => void save(true)} disabled={busy}>
              {scope === "campaign" ? "Voltar ao padrão do cliente" : "Remover o padrão"}
            </Button>
          )}
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy} disabled={!pipelines || !linked}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** O resumo das etapas: "Negociação ≤ R$ 45,00 · +1". */
function goalSummary(goal: CrmGoal | null) {
  if (!goal?.stages.length) return { short: "", full: "" };
  const parts = goal.stages.map(goalStageText);
  return {
    short: `${parts[parts.length - 1]}${parts.length > 1 ? ` · +${parts.length - 1}` : ""}`,
    full: `${parts.join(" · ")} (${goal.source === "client" ? "padrão do cliente" : "só desta campanha"})`,
  };
}

/** Na aba Insights: a linha com as etapas e o atalho para mudar. */
function CrmGoalLine({
  state,
  backend,
  company,
  campaign,
  notify,
  ctx,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
  ctx: InsightContext;
}) {
  const v = state.view;
  const [open, setOpen] = useState(false);
  if (!v) return null;
  const goal = v.crm_goal ?? null;
  const sum = goalSummary(goal);
  return (
    <div className="insights-owners insights-goal">
      <Target size={14} aria-hidden="true" />
      <span>
        <strong>Etapas que importam no CRM:</strong>{" "}
        {goal
          ? sum.full
          : "não definidas — com elas, a MAVI compara anúncios e conjuntos pelo custo do lead que avança no funil"}
      </span>
      {v.can_set_owners && (
        <button type="button" className="text-btn" onClick={() => setOpen(true)}>
          {goal ? "Alterar" : "Definir"}
        </button>
      )}
      {open && (
        <CrmGoalEditor
          state={state}
          backend={backend}
          company={company}
          campaign={campaign}
          notify={notify}
          ctx={ctx}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * No topo da campanha: "Abrir no CRM ▾" (o menu abre o CRM ou as etapas que
 * importam) e, ao lado, o selo com as etapas — em destaque quando faltam.
 */
export function CrmGoalControl({
  openCrm,
  state,
  backend,
  company,
  campaign,
  notify,
  ctx,
}: {
  /** Abre o MakeCRM do cliente numa aba nova. */
  openCrm: () => Promise<void>;
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
  ctx: InsightContext;
}) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const v = state.view;
  const goal = v?.crm_goal ?? null;
  const sum = goalSummary(goal);
  const canEdit = !!v?.can_set_owners;
  // As etapas só fazem sentido com os insights ligados.
  const withGoal = !!v?.enabled;
  const open = async () => {
    if (busy) return;
    setBusy(true);
    await openCrm();
    setBusy(false);
  };
  return (
    <div className="crm-control">
      <div className="crm-split" role="group" aria-label="MakeCRM">
        <Button className="btn crm-open crm-split-main" onClick={() => void open()} loading={busy}>
          <ExternalLink size={15} /> Abrir no CRM
        </Button>
        {withGoal && (
          <Popover.Root open={menu} onOpenChange={setMenu}>
            <Popover.Trigger asChild>
              <button type="button" className="btn crm-open crm-split-caret" aria-label="Mais opções do MakeCRM">
                <ChevronDown size={15} aria-hidden="true" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className="crm-split-menu" align="end" sideOffset={6}>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    void open();
                  }}
                >
                  <ExternalLink size={15} aria-hidden="true" />
                  <span>
                    <strong>Abrir no CRM</strong>
                    <small>Numa aba nova, já logado</small>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!canEdit}
                  title={canEdit ? undefined : "Só quem edita campanhas muda as etapas"}
                  onClick={() => {
                    setMenu(false);
                    setEditing(true);
                  }}
                >
                  <Target size={15} aria-hidden="true" />
                  <span>
                    <strong>Etapas que importam…</strong>
                    <small>{goal ? sum.full : "Ainda não definidas"}</small>
                  </span>
                </button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
      {withGoal && (goal || canEdit) && (
        <button
          type="button"
          className={`btn secondary crm-goal-chip${goal ? "" : " empty"}`}
          onClick={() => canEdit && setEditing(true)}
          disabled={!canEdit}
          title={
            goal
              ? `Etapas que importam: ${sum.full}`
              : "A MAVI compara anúncios e conjuntos pelo custo do lead que avança no funil"
          }
        >
          <Target size={15} aria-hidden="true" />
          <span>{goal ? sum.short : "Definir etapas que importam"}</span>
          {!goal && <i className="crm-goal-dot" aria-hidden="true" />}
        </button>
      )}
      {editing && (
        <CrmGoalEditor
          state={state}
          backend={backend}
          company={company}
          campaign={campaign}
          notify={notify}
          ctx={ctx}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** A aba "Insights": os abertos e o histórico das análises (auditoria e custo). */
export function CampaignInsightsTab({
  state,
  backend,
  company,
  campaign,
  notify,
  ctx,
}: {
  state: InsightsState;
  backend: InsightsBackend;
  company: string;
  campaign: string;
  notify: (message: string) => void;
  ctx: InsightContext;
}) {
  const { handlers, dialogs } = useInsightActions(state, backend, company, ctx, notify);
  const [filter, setFilter] = useState<"open" | "applied" | "snoozed" | "dismissed">("open");
  const v = state.view;
  if (state.error && !v)
    return (
      <p className="form-error campaign-tab-body" role="alert">
        Não foi possível carregar os insights: {state.error}
      </p>
    );
  if (!v) return <Loading variant="list" />;
  if (!v.enabled)
    return (
      <div className="campaign-tab-body">
        <Empty
          title="Insights da MAVI desligados"
          body="Administradores e gestores ligam as análises da MAVI em Painel da MAVI › Campanhas."
        />
      </div>
    );
  return (
    <div className="campaign-tab-body campaign-insights-tab">
      <div className="insights-tab-top">
        <div>
          <h3>
            <Lightbulb size={17} aria-hidden="true" /> Insights da MAVI
          </h3>
          <p>
            {scheduleText(v.schedule)} ({SOURCE_LABELS[v.schedule.source]}). {statusLine(v)}. A MAVI cruza a plataforma,
            o MakeCRM (por UTM) e o contexto do cliente; cada número vem das evidências.
          </p>
        </div>
        <AnalyzeNow state={state} backend={backend} company={company} campaign={campaign} notify={notify} />
      </div>
      <Owners state={state} backend={backend} company={company} campaign={campaign} notify={notify} />
      <CrmGoalLine state={state} backend={backend} company={company} campaign={campaign} notify={notify} ctx={ctx} />
      {v.pending && <PendingLine pending={v.pending} timezone={v.timezone} />}
      <section aria-label="Insights">
        <div className="scope-tabs insights-filter" role="tablist" aria-label="Insights por situação">
          {(
            [
              ["open", "Abertos", v.current.length],
              ["applied", "Aplicados", v.applied?.length ?? 0],
              ["snoozed", "Para depois", v.snoozed?.length ?? 0],
              ["dismissed", "Descartados", v.dismissed?.length ?? 0],
            ] as const
          ).map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={filter === id ? "selected" : ""}
              onClick={() => setFilter(id)}
            >
              {label}
              {n > 0 && <span>{n}</span>}
            </button>
          ))}
        </div>
        {(() => {
          const list =
            filter === "open"
              ? v.current
              : filter === "applied"
                ? (v.applied ?? [])
                : filter === "snoozed"
                  ? (v.snoozed ?? [])
                  : (v.dismissed ?? []);
          if (list.length)
            return (
              <div className="insights-grid">
                {list.map((i, k) => (
                  <InsightCard
                    key={i.id}
                    insight={i}
                    handlers={handlers}
                    first={filter === "open" && k === 0 && list.length > 1}
                  />
                ))}
              </div>
            );
          return (
            <p className="insights-empty">
              {filter === "open"
                ? (v.blocker ??
                  (v.runs.some((r) => r.status === "done")
                    ? "Nada aberto: a última análise não trouxe o que mereça ação."
                    : "A MAVI ainda não analisou esta campanha."))
                : filter === "applied"
                  ? "Nenhum insight aplicado ainda. Ao marcar como aplicado, a MAVI mede o antes × depois."
                  : filter === "snoozed"
                    ? "Nada combinado para depois."
                    : "Nenhum descartado nos últimos 90 dias."}
            </p>
          );
        })()}
      </section>
      <section aria-label="Histórico das análises">
        <h4 className="insights-section-title">
          <History size={15} aria-hidden="true" /> Histórico das análises
        </h4>
        {v.runs.length ? (
          <ul className="insights-runs">
            {v.runs.map((r) => (
              <RunRow key={r.id} run={r} timezone={v.timezone} expireDays={v.expire_days} />
            ))}
          </ul>
        ) : (
          <p className="insights-empty">Nenhuma análise ainda.</p>
        )}
      </section>
      {dialogs}
    </div>
  );
}

/** O selo da lista de Campanhas. */
export function InsightsBadgeChip({ badge, onOpen }: { badge: InsightBadge | undefined; onOpen: () => void }) {
  if (!badge) return <span className="cell-note">—</span>;
  if (!badge.open && badge.running)
    return (
      <span className="insights-badge running" title="A MAVI está analisando">
        <span className="insights-pulse" aria-hidden="true" /> Analisando
      </span>
    );
  const label = `${badge.open} ${badge.open === 1 ? "insight" : "insights"}${badge.high ? ` (${badge.high} para fazer hoje)` : ""}`;
  return (
    <button
      type="button"
      className={`insights-badge${badge.high ? " high" : badge.medium ? " medium" : ""}`}
      title={`${label}: abrir`}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <Lightbulb size={13} aria-hidden="true" />
      {badge.open}
      {badge.high > 0 && <span className="insights-badge-high">{badge.high} alta</span>}
    </button>
  );
}

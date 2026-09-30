import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  Circle,
  CircleAlert,
  ListChecks,
  Loader2,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import {
  aiTask,
  confirmAiTask,
  resumeAiTask,
  stopAiTask,
  type AiTask,
  type AiTaskStep,
} from "./ai";
import type { TaskArtifact } from "./mavi-artifacts";
import "./mavi-task.css";

/**
 * O card da tarefa longa (migração 20270111090000): o plano, o custo
 * estimado e o teto; confirmada, o andamento de cada parte ao vivo (pelo
 * aviso da tarefa no tópico da pessoa, sem consultas periódicas) e o botão
 * de parar, que entrega o que já estiver pronto. Pausada (a sessão venceu
 * ou a próxima parte não começou), ela continua sozinha quando a pessoa
 * abre a conversa.
 */

const money = (v: number) => `US$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;
/** Sem aviso da vez há um tempo: a fatia caiu, a tela retoma. */
const STALE_MS = 90_000;

/** O aviso de uma tarefa (App.tsx repassa o do tópico da pessoa). */
export type AiTaskNotice = { id: string; conversation: string; status: AiTask["status"] };

export function stale(t: Pick<AiTask, "status" | "lease_until" | "updated_at">, now = Date.now()) {
  if (t.status === "paused") return true;
  if (t.status !== "running" && t.status !== "stopping") return false;
  const lease = t.lease_until ? Date.parse(t.lease_until) : 0;
  return lease ? lease < now - 30_000 : Date.parse(t.updated_at) < now - STALE_MS;
}

export function TaskCard({
  artifact: a,
  readOnly,
  notify,
}: {
  artifact: TaskArtifact;
  /** Conversa compartilhada: só o plano, sem botões. */
  readOnly: boolean;
  notify: (message: string) => void;
}) {
  const [task, setTask] = useState<AiTask | null | undefined>(undefined);
  const [busy, setBusy] = useState<"" | "confirm" | "stop" | "cancel">("");
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const resumed = useRef(false);

  const load = useCallback(() => {
    aiTask(a.task)
      .then((t) => setTask(t ?? null))
      .catch(() => setTask(null));
  }, [a.task]);
  useEffect(load, [load]);
  // O andamento chega pelo aviso da tarefa (um por etapa); junta os seguidos.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heard = (e: Event) => {
      const n = (e as CustomEvent<AiTaskNotice>).detail;
      if (n?.id !== a.task) return;
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    };
    window.addEventListener("mavi:ai-task", heard);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mavi:ai-task", heard);
    };
  }, [a.task, load]);
  // Pausada ou sem sinal: quem pediu abriu a conversa, a tarefa continua.
  useEffect(() => {
    if (!task || readOnly || resumed.current || !stale(task)) return;
    resumed.current = true;
    void resumeAiTask(task.id).catch(() => null);
  }, [task, readOnly]);

  async function act(kind: "confirm" | "stop" | "cancel") {
    setBusy(kind);
    setError("");
    try {
      const t = kind === "confirm" ? await confirmAiTask(a.task) : await stopAiTask(a.task);
      setTask(t);
      if (kind === "confirm") notify("A MAVI começou a tarefa. Pode sair da página: o aviso chega quando terminar.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const t = task;
  const steps: AiTaskStep[] = t?.steps ?? [];
  const total = t ? steps.length : a.steps;
  const finished = steps.filter((s) => s.status === "done" || s.status === "error" || s.status === "skipped").length;
  const status = t?.status ?? "proposed";
  const cap = t?.cap ?? a.cap;
  const estimate = t?.estimate ?? a.estimate;
  const over = estimate > cap;
  // Muitas partes: a lista curta acompanha onde a MAVI está (duas prontas antes).
  const moving = t?.status === "running" || t?.status === "stopping" || t?.status === "paused";
  const at = moving ? Math.max(steps.findIndex((s) => s.status !== "done"), 0) : 0;
  const from = Math.max(0, Math.min(at - 2, steps.length - 6));
  const shown = all || steps.length <= 8 ? steps : steps.slice(from, from + 6);
  const line = !t
    ? t === null
      ? "Plano de uma tarefa longa da MAVI."
      : "Carregando o plano…"
    : {
        proposed: "Confira o plano. Nada começou ainda: a MAVI só trabalha depois que você confirmar.",
        running: `A MAVI está trabalhando: ${finished} de ${total} ${total === 1 ? "parte" : "partes"}. Pode sair da página: o aviso chega quando terminar.`,
        paused: `${t.pause_reason ?? "A tarefa está pausada."}`,
        stopping: "Parando: a MAVI vai entregar o que já estiver pronto.",
        done: "Pronto: o documento está na resposta abaixo.",
        cancelled: t.message ? "Parada por você: a MAVI entregou o que já estava pronto (na resposta abaixo)." : "Cancelada.",
        error: t.error ?? "A tarefa não terminou.",
      }[status];
  const live = status === "running" || status === "stopping" || status === "paused";

  return (
    <section className={`mavi-task ${status}`} aria-label={`Tarefa longa: ${a.title}`}>
      <header>
        <ListChecks size={16} aria-hidden="true" />
        <span>
          <small>Tarefa longa</small>
          <strong>{a.title}</strong>
        </span>
        <StatusChip status={status} />
      </header>
      <p className="mavi-task-line" role={live ? "status" : undefined}>
        {line}
      </p>
      {live && total > 0 && (
        <div
          className="mavi-task-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={finished}
          aria-label="Partes prontas"
        >
          <span style={{ width: `${Math.round((finished / total) * 100)}%` }} />
        </div>
      )}
      {!!steps.length && (
        <ol className="mavi-task-steps">
          {shown.map((s) => (
            <li key={s.ord} className={s.status}>
              <StepIcon step={s} />
              <span>{s.title}</span>
              {s.status === "error" && s.error && <small>{s.error}</small>}
            </li>
          ))}
          {shown.length < steps.length && (
            <li className="more">
              <button type="button" onClick={() => setAll(true)}>
                Ver todas as {steps.length} partes
              </button>
            </li>
          )}
          {t?.closing && (
            <li className={`closing ${status === "done" || status === "cancelled" ? "done" : "pending"}`}>
              {status === "done" ? <Check size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
              <span>
                Por último: {t.closing.title} <small>(abre o documento)</small>
              </span>
            </li>
          )}
        </ol>
      )}
      <p className="mavi-task-cost">
        {status === "proposed" ? (
          <>
            Custo estimado <strong>{money(estimate)}</strong> · teto por tarefa <strong>{money(cap)}</strong>
            <small>O teto é da empresa (Painel da MAVI › Consumo e limites).</small>
          </>
        ) : (
          <>
            Gasto <strong>{money(t?.spent ?? 0)}</strong> de {money(cap)} (estimado {money(estimate)})
          </>
        )}
      </p>
      {status === "proposed" && over && (
        <p className="mavi-task-warning">
          <CircleAlert size={13} aria-hidden="true" /> A estimativa passa do teto: a MAVI faz o que couber e diz o que
          ficou faltando.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!readOnly && t && (status === "proposed" || live) && (
        <footer>
          {status === "proposed" ? (
            <>
              <button type="button" className="btn secondary" disabled={!!busy} onClick={() => void act("cancel")}>
                {busy === "cancel" ? <Loader2 size={14} className="spin" /> : <X size={14} />} Cancelar
              </button>
              <button type="button" className="btn primary" disabled={!!busy} onClick={() => void act("confirm")}>
                {busy === "confirm" ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Começar
              </button>
            </>
          ) : status !== "stopping" ? (
            <button type="button" className="btn secondary" disabled={!!busy} onClick={() => void act("stop")}>
              {busy === "stop" ? <Loader2 size={14} className="spin" /> : <Square size={11} fill="currentColor" />} Parar e
              entregar o que já tem
            </button>
          ) : null}
        </footer>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: AiTask["status"] }) {
  const [label, Icon] = (
    {
      proposed: ["Aguardando você", Circle],
      running: ["Trabalhando", Loader2],
      paused: ["Pausada", Pause],
      stopping: ["Parando", Loader2],
      done: ["Pronta", Check],
      cancelled: ["Parada", Ban],
      error: ["Não terminou", CircleAlert],
    } as const
  )[status];
  return (
    <span className={`mavi-task-chip ${status}`}>
      <Icon size={12} aria-hidden="true" className={status === "running" || status === "stopping" ? "spin" : undefined} />
      {label}
    </span>
  );
}

function StepIcon({ step }: { step: AiTaskStep }) {
  if (step.status === "done") return <Check size={13} aria-label="Pronta" />;
  if (step.status === "running") return <Loader2 size={13} className="spin" aria-label="Em andamento" />;
  if (step.status === "error" || step.status === "skipped") return <CircleAlert size={13} aria-label="Não ficou pronta" />;
  return <Circle size={13} aria-label={step.attempts ? "Na fila de novo" : "Na fila"} />;
}

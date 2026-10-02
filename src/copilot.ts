import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import type { AiSource } from "./ai";
import type { Snapshot } from "./types";

/**
 * Assistente MAVI nas tarefas, no navegador. Duas camadas, só quando a
 * pessoa para de digitar (nada roda em intervalos):
 * - Relacionados (~1 s parado): tarefas parecidas e cases, sem modelo;
 * - análise da MAVI (~3 s parado e o texto mudou de verdade): os alertas
 *   chegam um a um. O mesmo rascunho nunca é analisado duas vezes (cache
 *   nesta aba) e a análise anterior é cancelada quando outra começa.
 */

export type CopilotDraft = {
  company: string;
  contract: string | null;
  /** Edição: a tarefa (fica de fora das parecidas). */
  task?: string | null;
  title: string;
  /** Descrição em texto (sem HTML). */
  description: string;
  /** O que foi dito nos áudios da descrição (as transcrições). */
  audio?: string;
  due?: string;
  /** Campos do modelo, como "Campo: valor". */
  extra?: string;
  /** Campos do modelo em branco (um por linha). */
  empty?: string;
  /** Nomes dos anexos (um por linha). */
  files?: string;
  /** Tarefa principal e subtarefas. */
  family?: string;
  /** Quem executa: nome e equipes. */
  assignee?: string;
};

/**
 * O resto da tarefa, para a MAVI ler inteira: sem isso ela pedia o que já
 * estava nos campos, nos anexos ou na tarefa principal.
 */
export function copilotExtras(
  data: Pick<Snapshot, "members" | "teams" | "teamMembers" | "tasks">,
  args: {
    /** Quem executa (ou a equipe que vai receber). */
    assignee?: string | null;
    team?: string | null;
    /** A tarefa principal (subtarefa) e a própria tarefa (edição). */
    parent?: string | null;
    task?: string | null;
    files?: string[];
    /** Campos do modelo com o valor (o formulário ou a cópia da tarefa). */
    fields?: { label: string; required?: boolean; value?: unknown }[];
  },
): Pick<CopilotDraft, "extra" | "empty" | "files" | "family" | "assignee"> {
  const teamName = (id: string) => data.teams.find((t) => t.id === id)?.name;
  const person = args.assignee
    ? data.members.find((m) => m.user_id === args.assignee)
    : undefined;
  const teams = person
    ? data.teamMembers
        .filter((t) => t.user_id === person.user_id)
        .flatMap((t) => teamName(t.team_id) ?? [])
    : [];
  const assignee = args.team
    ? `equipe ${teamName(args.team) ?? "?"} (distribuída automaticamente)`
    : person
      ? `${person.name}${teams.length ? ` · equipes: ${teams.join(", ")}` : ""}`
      : "";
  const parent = args.parent
    ? data.tasks.find((t) => t.id === args.parent)
    : undefined;
  const subtasks = args.task
    ? data.tasks.filter((t) => t.parent_id === args.task && !t.archived)
    : [];
  const family = [
    parent ? `Tarefa principal: ${parent.title}` : "",
    subtasks.length
      ? `Subtarefas: ${subtasks
          .slice(0, 12)
          .map((t) => t.title)
          .join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const filled = (v: unknown) =>
    !(v == null || v === "" || v === false || (Array.isArray(v) && !v.length));
  const fields = args.fields ?? [];
  return {
    extra: fields
      .filter((f) => filled(f.value))
      .map(
        (f) =>
          `${f.label}: ${Array.isArray(f.value) ? f.value.join(", ") : f.value === true ? "sim" : String(f.value)}`,
      )
      .join("\n"),
    empty: fields
      .filter((f) => !filled(f.value))
      .map((f) => `${f.label}${f.required ? " (obrigatório)" : ""}`)
      .join("\n"),
    files: (args.files ?? []).slice(0, 20).join("\n"),
    family,
    assignee,
  };
}
export type SimilarTask = {
  id: string;
  title: string;
  status: string | null;
  /** Tarefa de um colega que a pessoa não abre: só título e status. */
  restricted?: boolean;
  assignee?: string | null;
  due?: string | null;
  date?: string | null;
  snippet?: string;
  similarity: number | null;
  duplicate: boolean;
};
export type RelatedCase = {
  id: string;
  title: string;
  date: string | null;
  snippet: string;
  similarity: number | null;
};
export type Related = {
  client: { id: string; name: string } | null;
  similar: SimilarTask[];
  cases: RelatedCase[];
  /** A MAVI conferiu na análise: só o que tem a ver de fato com o pedido. */
  checked?: boolean;
};
export type AlertKind =
  | "error"
  | "avoids"
  | "prefers"
  | "duplicate"
  | "missing"
  | "suggestion"
  | "case";
export type CopilotAlert = {
  id: string;
  kind: AlertKind;
  severity: "high" | "medium" | "low";
  title: string;
  text: string;
  fix?: string;
  /** O trecho literal da fonte que sustenta o alerta. */
  quote?: string;
  sources: AiSource[];
  dossier: { id: string; kind: string; text: string }[];
};
/**
 * O resultado da análise: ok = a tarefa está bem completa; attention = há
 * pontos a revisar; quiet = nada do histórico muda a tarefa.
 */
export type CopilotVerdict = {
  status: "ok" | "attention" | "quiet";
  text: string;
};
/**
 * O tamanho da entrega que a MAVI leu, comparado com o comum: o prazo
 * inteligente tira um dia (simple) ou soma um quarto (complex).
 */
export type CopilotEffort = {
  level: "simple" | "normal" | "complex";
  why: string;
};
/** O modelo que fez a análise (o nome para a tela e o provedor da regra). */
export type CopilotModel = { label: string; provider: string | null };
type ReviewResult = {
  alerts: CopilotAlert[];
  version: number;
  verdict: CopilotVerdict;
  effort?: CopilotEffort | null;
  model?: CopilotModel | null;
};
export type CopilotAction =
  "applied" | "useful" | "not_useful" | "dismissed" | "ignored" | "opened";

export const ALERT_LABELS: Record<AlertKind, string> = {
  error: "Possível erro",
  avoids: "O cliente não gosta",
  prefers: "O cliente prefere",
  duplicate: "Já foi pedido",
  missing: "Falta informação",
  suggestion: "Sugestão",
  case: "Case que ajuda",
};

/** Quanto texto a MAVI precisa para opinar. */
export const MIN_RELATED = 12;
export const MIN_REVIEW = 25;
const RELATED_DELAY = 900;
const REVIEW_DELAY = 3000;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
export const draftKey = (d: CopilotDraft) =>
  [
    d.contract,
    d.task,
    clean(d.title),
    clean(d.description),
    clean(d.audio ?? ""),
    d.due,
    clean(d.extra ?? ""),
    clean(d.empty ?? ""),
    clean(d.files ?? ""),
    clean(d.family ?? ""),
    d.assignee,
  ]
    .map((x) => x ?? "")
    .join("|");
const draftText = (d: CopilotDraft) =>
  clean(`${d.title} ${d.description} ${d.audio ?? ""}`);

/**
 * Mudou o bastante para outra análise? Palavras novas ou removidas somando
 * pelo menos 15% (ou 6 palavras), ou o cliente/prazo mudou.
 */
export function meaningfulChange(
  prev: CopilotDraft | null,
  next: CopilotDraft,
) {
  if (!prev) return true;
  if (
    prev.contract !== next.contract ||
    prev.due !== next.due ||
    prev.files !== next.files ||
    (prev.audio ?? "") !== (next.audio ?? "") ||
    prev.extra !== next.extra
  )
    return true;
  const words = (d: CopilotDraft) =>
    new Set(
      draftText(d)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2),
    );
  const a = words(prev);
  const b = words(next);
  let diff = 0;
  for (const w of a) if (!b.has(w)) diff++;
  for (const w of b) if (!a.has(w)) diff++;
  return diff >= 6 || diff / Math.max(a.size, b.size, 1) >= 0.15;
}

// Cache desta aba (o mesmo rascunho não vai ao servidor de novo).
const relatedCache = new Map<string, Related>();
const reviewCache = new Map<string, ReviewResult>();
function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.set(key, value);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
}

async function token() {
  return supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
}
async function post(body: Record<string, unknown>, signal: AbortSignal) {
  const t = await token();
  return fetch("/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

export async function fetchRelated(d: CopilotDraft, signal: AbortSignal) {
  const res = await post({ action: "ai-copilot", ...d }, signal);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "A MAVI não respondeu.");
  return data as Related;
}

type ReviewHandlers = {
  onRelated: (r: Related) => void;
  onAlert: (a: CopilotAlert) => void;
  onStatus: (text: string, step: number) => void;
};
/** A análise em tempo real (linhas JSON); devolve os alertas e a versão do dossiê. */
export async function streamReview(
  d: CopilotDraft,
  handlers: ReviewHandlers,
  signal: AbortSignal,
): Promise<ReviewResult | "throttled"> {
  const res = await post({ action: "ai-copilot-review", ...d }, signal);
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw Error(data.error ?? "A MAVI não respondeu.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: ReviewResult | "throttled" | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const e = JSON.parse(line);
    if (e.type === "related") handlers.onRelated(e);
    else if (e.type === "alert") handlers.onAlert(e.alert);
    else if (e.type === "status") handlers.onStatus(e.text, e.step ?? 2);
    else if (e.type === "throttled") final = "throttled";
    else if (e.type === "done")
      final = {
        alerts: e.alerts ?? [],
        version: e.version ?? 0,
        verdict: e.verdict ?? {
          status: e.alerts?.length ? "attention" : "quiet",
          text: "",
        },
        effort: e.effort ?? null,
        model: e.model
          ? { label: e.modelLabel || e.model, provider: e.provider ?? null }
          : null,
      };
    else if (e.type === "error")
      throw Error(e.error ?? "A MAVI não respondeu.");
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer);
  if (!final) throw Error("A análise da MAVI foi interrompida.");
  return final;
}

/** O que a pessoa fez com cada alerta (mede a qualidade do copiloto). */
export async function sendCopilotFeedback(
  company: string,
  client: string | null,
  task: string | null,
  events: {
    kind: string;
    severity: string;
    action: CopilotAction;
    title: string;
  }[],
) {
  if (!supabase || !events.length) return;
  await supabase.rpc("task_copilot_feedback", {
    p_company: company,
    p_client: client,
    p_task: task,
    p_events: events.slice(0, 30),
  });
}

export type CopilotVote = "up" | "down";
export type DownReason =
  "not_applicable" | "wrong" | "obvious" | "already" | "other";
export const DOWN_REASONS: { id: DownReason; label: string }[] = [
  { id: "not_applicable", label: "Não se aplica" },
  { id: "wrong", label: "Informação errada" },
  { id: "obvious", label: "Óbvio" },
  { id: "already", label: "Já estava na tarefa" },
  { id: "other", label: "Outro" },
];

/**
 * 👍/👎 num alerta, gravado na hora (a MAVI aprende com eles). Nulo tira o
 * voto. Um voto por pessoa, por alerta, por abertura do formulário.
 */
export async function voteCopilot(args: {
  company: string;
  contract: string | null;
  task: string | null;
  session: string;
  alert: CopilotAlert;
  draft: string;
  vote: CopilotVote | null;
  reason?: DownReason | null;
  comment?: string;
}) {
  if (!supabase) return;
  const { error } = await supabase.rpc("copilot_feedback_vote", {
    p_company: args.company,
    p_contract: args.contract,
    p_task: args.task,
    p_session: args.session,
    p_alert: {
      key: `${args.alert.kind}:${args.alert.title}`.slice(0, 200),
      kind: args.alert.kind,
      severity: args.alert.severity,
      title: args.alert.title,
      text: args.alert.text,
      draft: args.draft.slice(0, 200),
    },
    p_vote: args.vote,
    p_reason: args.reason ?? null,
    p_comment: args.comment ?? null,
  });
  if (error) throw Error(error.message);
}

/** A tarefa foi criada: os votos daquela abertura passam a apontar para ela. */
export async function attachCopilotFeedback(
  company: string,
  session: string,
  task: string,
) {
  if (!supabase) return;
  await supabase.rpc("copilot_feedback_attach", {
    p_company: company,
    p_session: session,
    p_task: task,
  });
}

// ------------------------------------------------------------ demonstração
function demoResult(d: CopilotDraft): {
  related: Related;
  alerts: CopilotAlert[];
  verdict: CopilotVerdict;
  effort: CopilotEffort;
} {
  const src = (
    type: AiSource["type"],
    title: string,
    date: string,
  ): AiSource => ({
    ref: "S1",
    type,
    id: "demo",
    title,
    date,
    client_id: null,
  });
  // Descrição caprichada: a demonstração mostra a tarefa completa.
  const complete = d.description.trim().length >= 80;
  return {
    effort:
      d.description.trim().length >= 400
        ? { level: "complex", why: "A descrição pede várias entregas." }
        : { level: "normal", why: "" },
    related: {
      client: { id: "demo", name: "Cliente demo" },
      similar: [
        {
          id: "demo-task",
          title: "Carrossel com a oferta do mês",
          status: "progress",
          assignee: null,
          due: null,
          date: "2026-09-20",
          snippet: "Carrossel de 5 cards com a oferta de setembro",
          similarity: 0.78,
          duplicate: true,
        },
      ],
      cases: [
        {
          id: "demo-case",
          title:
            "Loja de móveis dobrou os leads com carrossel de antes e depois",
          date: null,
          snippet: "CPL caiu 42% em 30 dias",
          similarity: 0.5,
        },
      ],
    },
    alerts: complete
      ? []
      : [
          {
            id: "a1",
            kind: "avoids",
            severity: "high",
            title: "O cliente pediu para não usar vermelho",
            text: "Na reunião de alinhamento ele disse que vermelho lembra a concorrente.",
            fix: "Evitar vermelho nas artes (pedido do cliente).",
            quote: "vermelho lembra muito a concorrente, prefiro evitar",
            sources: [
              src("meeting", "Alinhamento mensal", "2026-09-10T13:00:00Z"),
            ],
            dossier: [],
          },
          {
            id: "a2",
            kind: "duplicate",
            severity: "medium",
            title: "Há uma tarefa parecida em andamento",
            text: `"Carrossel com a oferta do mês" está em andamento. Confira se "${d.title.slice(0, 40)}" não é o mesmo pedido.`,
            sources: [
              src("task", "Carrossel com a oferta do mês", "2026-09-20"),
            ],
            dossier: [],
          },
        ],
    verdict: complete
      ? {
          status: "ok",
          text: "Formato, oferta e prazo estão claros, e nada vai contra o que o cliente pediu.",
        }
      : {
          status: "attention",
          text: "Revise a cor das artes e confira a tarefa parecida antes de criar.",
        },
  };
}

// ------------------------------------------------------------ hook
export type CopilotState = {
  related: Related | null;
  alerts: CopilotAlert[];
  /** O resultado da última análise (nulo: ainda não houve). */
  verdict: CopilotVerdict | null;
  /** O tamanho da entrega da última análise (para o prazo sugerido). */
  effort: CopilotEffort | null;
  /** O modelo que fez a última análise. */
  model: CopilotModel | null;
  /** A análise está rodando (os alertas ainda podem chegar). */
  reviewing: boolean;
  /** Em que passo a análise está: 1 lendo, 2 histórico, 3 escrevendo. */
  step: number;
  status: string;
  error: string;
  throttled: boolean;
  /** Os alertas vieram de um texto que já mudou. */
  stale: boolean;
  /** Pede a análise agora (sem esperar a pausa nem a mudança mínima). */
  reviewNow: () => void;
};

export function useTaskCopilot(
  draft: CopilotDraft,
  enabled: boolean,
  demo = false,
  /** Edição: o texto que já existe não é analisado, só o que mudar. */
  onlyChanges = false,
): CopilotState {
  const [related, setRelated] = useState<Related | null>(null);
  const [alerts, setAlerts] = useState<CopilotAlert[]>([]);
  const [verdict, setVerdict] = useState<CopilotVerdict | null>(null);
  const [effort, setEffort] = useState<CopilotEffort | null>(null);
  const [model, setModel] = useState<CopilotModel | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [throttled, setThrottled] = useState(false);
  const [reviewedKey, setReviewedKey] = useState("");
  const [force, setForce] = useState(0);
  const lastReviewed = useRef<CopilotDraft | null>(null);
  // Edição: o texto de quando a MAVI foi ligada conta como já conferido.
  const baselined = useRef(false);
  if (!enabled) baselined.current = false;
  else if (onlyChanges && !baselined.current) {
    baselined.current = true;
    lastReviewed.current = draft;
  }
  const reviewAbort = useRef<AbortController | null>(null);
  const key = draftKey(draft);
  const text = draftText(draft);
  const ready = enabled && (!!draft.contract || !!draft.task);
  const current = useRef(draft);
  current.current = draft;

  // Relacionados.
  useEffect(() => {
    if (!enabled || !ready || text.length < MIN_RELATED) return;
    const cached = relatedCache.get(key);
    if (cached) {
      setRelated(cached);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = demo
          ? demoResult(current.current).related
          : await fetchRelated(current.current, abort.signal);
        // A análise já conferiu este rascunho: a lista dela vale.
        if (relatedCache.get(key)?.checked) return;
        remember(relatedCache, key, r);
        setRelated(r);
      } catch {
        // Os Relacionados são um atalho: sem eles, a análise continua.
      }
    }, RELATED_DELAY);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [key, enabled, ready, demo]);

  // Análise da MAVI.
  useEffect(() => {
    if (!enabled || !ready || text.length < MIN_REVIEW) return;
    const forced = force > 0;
    const cached = reviewCache.get(key);
    if (cached) {
      setAlerts(cached.alerts);
      setVerdict(cached.verdict);
      setEffort(cached.effort ?? null);
      setModel(cached.model ?? null);
      setReviewedKey(key);
      return;
    }
    if (!forced && !meaningfulChange(lastReviewed.current, draft)) return;
    const timer = setTimeout(
      async () => {
        reviewAbort.current?.abort();
        const abort = new AbortController();
        reviewAbort.current = abort;
        const snapshot = current.current;
        lastReviewed.current = snapshot;
        setReviewing(true);
        setError("");
        setThrottled(false);
        setStatus("A MAVI está lendo a tarefa");
        setStep(1);
        const incoming: CopilotAlert[] = [];
        try {
          if (demo) {
            const r = demoResult(snapshot);
            const wait = () => new Promise((ok) => setTimeout(ok, 700));
            await wait();
            setStep(2);
            setStatus("A MAVI está conferindo o histórico do cliente");
            await wait();
            setStep(3);
            await wait();
            setRelated(r.related);
            setAlerts(r.alerts);
            setVerdict(r.verdict);
            setEffort(r.effort);
            setModel(null);
            remember(reviewCache, key, {
              alerts: r.alerts,
              version: 0,
              verdict: r.verdict,
              effort: r.effort,
            });
            setReviewedKey(key);
            return;
          }
          const result = await streamReview(
            snapshot,
            {
              onRelated: (r) => {
                remember(relatedCache, key, r);
                setRelated(r);
              },
              onAlert: (a) => {
                incoming.push(a);
                setAlerts([...incoming]);
              },
              onStatus: (text, n) => {
                setStatus(text);
                setStep(n);
              },
            },
            abort.signal,
          );
          if (result === "throttled") {
            setThrottled(true);
            lastReviewed.current = null;
            return;
          }
          remember(reviewCache, key, result);
          setAlerts(result.alerts);
          setVerdict(result.verdict);
          setEffort(result.effort ?? null);
          setModel(result.model ?? null);
          setReviewedKey(key);
        } catch (e) {
          if (abort.signal.aborted) return;
          lastReviewed.current = null;
          setError((e as Error).message);
        } finally {
          if (reviewAbort.current === abort) {
            setReviewing(false);
            setStatus("");
            setStep(0);
          }
        }
      },
      forced ? 0 : REVIEW_DELAY,
    );
    return () => clearTimeout(timer);
  }, [key, enabled, ready, force, demo]);

  // Fechou o formulário: a análise em curso para.
  useEffect(() => () => reviewAbort.current?.abort(), []);
  useEffect(() => {
    if (force) setForce(0);
  }, [key]);

  return useMemo(
    () => ({
      related: text.length >= MIN_RELATED ? related : null,
      alerts,
      verdict,
      effort,
      model,
      reviewing,
      step,
      status,
      error,
      throttled,
      stale: !!reviewedKey && reviewedKey !== key && !reviewing,
      reviewNow: () => {
        lastReviewed.current = null;
        setForce((v) => v + 1);
      },
    }),
    [
      related,
      alerts,
      verdict,
      effort,
      model,
      reviewing,
      step,
      status,
      error,
      throttled,
      reviewedKey,
      key,
      text.length,
    ],
  );
}

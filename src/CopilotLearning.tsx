import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  CheckCircle2,
  GraduationCap,
  Pause,
  Pencil,
  Play,
  Plus,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
} from "lucide-react";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Empty } from "./components";
import { supabase } from "./supabase";
import { dateKey } from "./domain";
import { ALERT_LABELS, DOWN_REASONS, type AlertKind } from "./copilot";
import { routeParts, taskUrl } from "./router";
import type { Snapshot } from "./types";

/**
 * Painel da MAVI › Copiloto (administradores e gestores): como o time avalia
 * os alertas do Assistente MAVI nas tarefas e o que a MAVI aprendeu com
 * isso. Aprendizados entram em uso sozinhos quando têm evidência (2 pessoas
 * ou um líder); aqui os líderes conferem, corrigem, pausam ou excluem — e
 * podem ensinar a MAVI diretamente.
 */

type Scope = "company" | "product" | "client";
type LessonStatus = "active" | "candidate" | "paused" | "dismissed";
export type Lesson = {
  id: string;
  scope: Scope;
  client_id: string | null;
  product_id: string | null;
  kind: AlertKind | null;
  text: string;
  status: LessonStatus;
  origin: "mavi" | "person";
  people: number;
  has_leader: boolean;
  ups: number;
  downs: number;
  feedbacks: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};
type FeedbackRow = {
  id: number;
  user_id: string;
  client_id: string | null;
  product_id: string | null;
  task_id: string | null;
  kind: AlertKind;
  severity: string;
  alert_title: string;
  alert_text: string;
  draft_title: string;
  vote: "up" | "down";
  reason: string | null;
  comment: string;
  at: string;
  learned: boolean;
};
export type LearningReport = {
  kinds: {
    kind: AlertKind;
    up: number;
    down: number;
    applied: number;
    dismissed: number;
    ignored: number;
  }[];
  reasons: Record<string, number>;
  lessons: Lesson[];
  feedback: FeedbackRow[];
  feedback_total: number;
  pending: number;
  learned_at: string | null;
};

const PAGE = 50;
const KINDS = Object.keys(ALERT_LABELS) as AlertKind[];
const REASON_LABELS = Object.fromEntries(
  DOWN_REASONS.map((r) => [r.id, r.label]),
);
const STATUS_LABELS: Record<LessonStatus, string> = {
  active: "Em uso",
  candidate: "Aguardando evidência",
  paused: "Pausado",
  dismissed: "Excluído",
};
type Filter = "new" | LessonStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "new", label: "Novos" },
  { id: "active", label: "Em uso" },
  { id: "candidate", label: "Aguardando evidência" },
  { id: "paused", label: "Pausados" },
  { id: "dismissed", label: "Excluídos" },
];
const isNew = (l: Lesson) => !l.reviewed_at && l.status !== "dismissed";

const count = (v: number) => (Number(v) || 0).toLocaleString("pt-BR");
const pct = (a: number, b: number) =>
  a + b ? `${Math.round((a / (a + b)) * 100)}%` : "—";
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

// ------------------------------------------------------------ dados
async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Sem conexão com o banco.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}
export const learningReport = (
  company: string,
  from: string,
  to: string,
  vote: "up" | "down" | null,
  offset: number,
) =>
  rpc<LearningReport>("copilot_learning_report", {
    p_company: company,
    p_from: from,
    p_to: to,
    p_vote: vote,
    p_limit: PAGE,
    p_offset: offset,
  });
const saveLesson = (
  company: string,
  id: string | null,
  scope: Scope,
  client: string | null,
  product: string | null,
  kind: AlertKind | null,
  text: string,
) =>
  rpc<string>("copilot_lesson_save", {
    p_company: company,
    p_id: id,
    p_scope: scope,
    p_client: client,
    p_product: product,
    p_kind: kind,
    p_text: text,
  });
const setLesson = (
  company: string,
  id: string,
  action: "review" | "pause" | "activate" | "dismiss",
) =>
  rpc<void>("copilot_lesson_set", {
    p_company: company,
    p_id: id,
    p_action: action,
  });

function demoReport(): LearningReport {
  const now = new Date().toISOString();
  const lesson = (over: Partial<Lesson>): Lesson => ({
    id: crypto.randomUUID(),
    scope: "company",
    client_id: null,
    product_id: null,
    kind: null,
    text: "",
    status: "active",
    origin: "mavi",
    people: 2,
    has_leader: false,
    ups: 0,
    downs: 2,
    feedbacks: 2,
    reviewed_by: null,
    reviewed_at: null,
    created_at: now,
    updated_at: now,
    updated_by: null,
    ...over,
  });
  return {
    kinds: [
      { kind: "avoids", up: 14, down: 2, applied: 9, dismissed: 1, ignored: 0 },
      {
        kind: "duplicate",
        up: 8,
        down: 1,
        applied: 0,
        dismissed: 2,
        ignored: 1,
      },
      { kind: "missing", up: 5, down: 9, applied: 4, dismissed: 6, ignored: 0 },
      {
        kind: "suggestion",
        up: 6,
        down: 4,
        applied: 3,
        dismissed: 3,
        ignored: 0,
      },
    ],
    reasons: { obvious: 6, not_applicable: 5, already: 3, wrong: 1 },
    lessons: [
      lesson({
        kind: "missing",
        text: "Não aponte falta de prazo de aprovação em tarefas internas (sem entrega ao cliente): o time considera óbvio.",
        people: 4,
        downs: 6,
        feedbacks: 6,
      }),
      lesson({
        kind: "duplicate",
        text: "Continue apontando duplicadas quando a tarefa parecida está em andamento: o time valoriza.",
        ups: 5,
        downs: 0,
        feedbacks: 5,
        people: 3,
        reviewed_at: now,
      }),
      lesson({
        scope: "client",
        client_id: "demo",
        kind: "avoids",
        text: "O cliente liberou o vermelho em setembro/2026: não aponte mais o uso da cor.",
        status: "candidate",
        people: 1,
        downs: 1,
        feedbacks: 1,
      }),
    ],
    feedback: [
      {
        id: 1,
        user_id: "",
        client_id: null,
        product_id: null,
        task_id: null,
        kind: "missing",
        severity: "low",
        alert_title: "Diga quem aprova e até quando",
        alert_text: "",
        draft_title: "Ajustar banner interno",
        vote: "down",
        reason: "obvious",
        comment: "Tarefa interna, não tem aprovação do cliente.",
        at: now,
        learned: true,
      },
      {
        id: 2,
        user_id: "",
        client_id: null,
        product_id: null,
        task_id: null,
        kind: "avoids",
        severity: "high",
        alert_title: "O cliente pediu para não usar vermelho",
        alert_text: "",
        draft_title: "Carrossel Black Friday",
        vote: "up",
        reason: null,
        comment: "",
        at: now,
        learned: false,
      },
    ],
    feedback_total: 2,
    pending: 1,
    learned_at: now,
  };
}

// ------------------------------------------------------------ tela
export function CopilotLearning({
  company,
  data,
  demo = false,
  notify,
}: {
  company: string;
  data: Snapshot;
  demo?: boolean;
  notify: (message: string) => void;
}) {
  const today = dateKey();
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return dateKey(d);
  });
  const [to, setTo] = useState(today);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const [offset, setOffset] = useState(0);
  const [report, setReport] = useState<LearningReport | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("new");
  const [editing, setEditing] = useState<{
    id: string | null;
    scope: Scope;
    client: string;
    product: string;
    kind: string;
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    setError("");
    (demo
      ? Promise.resolve(demoReport())
      : learningReport(company, from, to, vote, offset)
    )
      .then(setReport)
      .catch((e) => setError((e as Error).message));
  }, [company, from, to, vote, offset, demo]);
  useEffect(load, [load]);

  const lessons = report?.lessons ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      new: 0,
      active: 0,
      candidate: 0,
      paused: 0,
      dismissed: 0,
    };
    for (const l of lessons) {
      c[l.status]++;
      if (isNew(l)) c.new++;
    }
    return c;
  }, [lessons]);
  // Sem novos para conferir, abre nos que estão em uso.
  useEffect(() => {
    if (report && filter === "new" && !counts.new) setFilter("active");
  }, [report]);
  const shown = lessons.filter((l) =>
    filter === "new" ? isNew(l) : l.status === filter,
  );
  const totals = (report?.kinds ?? []).reduce(
    (t, k) => ({
      up: t.up + k.up,
      down: t.down + k.down,
      applied: t.applied + k.applied,
    }),
    { up: 0, down: 0, applied: 0 },
  );

  const clientName = (id: string | null) =>
    data.clients.find((c) => c.id === id)?.name ?? "cliente removido";
  const productName = (id: string | null) =>
    data.products.find((p) => p.id === id)?.name ?? "produto removido";
  const person = (id: string | null) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém do time";
  const scopeLabel = (l: Pick<Lesson, "scope" | "client_id" | "product_id">) =>
    l.scope === "company"
      ? "Toda a empresa"
      : l.scope === "product"
        ? `Produto · ${productName(l.product_id)}`
        : `Cliente · ${clientName(l.client_id)}`;

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    if (demo) {
      notify("No ambiente demonstrativo nada é salvo.");
      return;
    }
    setBusy(key);
    setError("");
    try {
      await fn();
      notify(done);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const ed = editing;
    void run(
      "save",
      async () => {
        await saveLesson(
          company,
          ed.id,
          ed.scope,
          ed.scope === "client" ? ed.client : null,
          ed.scope === "product" ? ed.product : null,
          (ed.kind || null) as AlertKind | null,
          ed.text,
        );
        setEditing(null);
      },
      ed.id ? "Aprendizado corrigido." : "Aprendizado criado e em uso.",
    );
  }

  const editor = editing && (
    <form className="learning-editor" onSubmit={submit}>
      <div className="learning-editor-row">
        <label>
          Onde vale
          <Select
            value={editing.scope}
            onValueChange={(v) => setEditing({ ...editing, scope: v as Scope })}
          >
            <SelectOption value="company">Toda a empresa</SelectOption>
            <SelectOption value="product">Um produto</SelectOption>
            <SelectOption value="client">Um cliente</SelectOption>
          </Select>
        </label>
        {editing.scope === "client" && (
          <label>
            Cliente
            <Select
              value={editing.client}
              onValueChange={(v) => setEditing({ ...editing, client: v })}
            >
              <SelectOption value="">Escolha o cliente</SelectOption>
              {data.clients
                .filter((c) => !c.archived)
                .map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
            </Select>
          </label>
        )}
        {editing.scope === "product" && (
          <label>
            Produto
            <Select
              value={editing.product}
              onValueChange={(v) => setEditing({ ...editing, product: v })}
            >
              <SelectOption value="">Escolha o produto</SelectOption>
              {data.products.map((p) => (
                <SelectOption key={p.id} value={p.id}>
                  {p.name}
                </SelectOption>
              ))}
            </Select>
          </label>
        )}
        <label>
          Tipo de alerta
          <Select
            value={editing.kind || "all"}
            onValueChange={(v) =>
              setEditing({ ...editing, kind: v === "all" ? "" : v })
            }
          >
            <SelectOption value="all">Todos</SelectOption>
            {KINDS.map((k) => (
              <SelectOption key={k} value={k}>
                {ALERT_LABELS[k]}
              </SelectOption>
            ))}
          </Select>
        </label>
      </div>
      <Textarea
        aria-label="O que a MAVI deve fazer"
        value={editing.text}
        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
        maxLength={400}
        rows={3}
        placeholder="Ex.: Não aponte falta de prazo de aprovação em tarefas internas."
        autoFocus
      />
      <div className="learning-editor-actions">
        <small>Aprendizados escritos por líderes entram em uso na hora.</small>
        <Button
          type="button"
          className="btn secondary"
          onClick={() => setEditing(null)}
        >
          Cancelar
        </Button>
        <Button
          className="btn primary"
          loading={busy === "save"}
          disabled={
            editing.text.trim().length < 5 ||
            (editing.scope === "client" && !editing.client) ||
            (editing.scope === "product" && !editing.product)
          }
        >
          Salvar
        </Button>
      </div>
    </form>
  );

  return (
    <div className="learning">
      <div className="ai-usage-toolbar">
        <div className="meetings-period" role="group" aria-label="Período">
          <label>
            De
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(e) => {
                if (!e.target.value) return;
                setOffset(0);
                setFrom(e.target.value);
              }}
            />
          </label>
          <label>
            Até
            <Input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => {
                if (!e.target.value) return;
                setOffset(0);
                setTo(e.target.value);
              }}
            />
          </label>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!report ? (
        <Loading variant="chart" />
      ) : (
        <>
          <section className="stats-grid" aria-label="Resumo do período">
            <article className="stat-card green">
              <div>
                Alertas que ajudaram <ThumbsUp size={17} />
              </div>
              <strong>{count(totals.up)}</strong>
              <footer>{pct(totals.up, totals.down)} dos avaliados</footer>
            </article>
            <article className="stat-card">
              <div>
                Não ajudaram <ThumbsDown size={17} />
              </div>
              <strong>{count(totals.down)}</strong>
              <footer>
                {Object.entries(report.reasons)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 2)
                  .map(([r, n]) => `${REASON_LABELS[r] ?? r} (${n})`)
                  .join(" · ") || "sem motivo informado"}
              </footer>
            </article>
            <article className="stat-card blue">
              <div>
                Aplicados na descrição <CheckCircle2 size={17} />
              </div>
              <strong>{count(totals.applied)}</strong>
              <footer>sugestões aceitas com um clique</footer>
            </article>
            <article className="stat-card purple">
              <div>
                Aprendizados em uso <GraduationCap size={17} />
              </div>
              <strong>{count(counts.active)}</strong>
              <footer>
                {report.pending
                  ? `${count(report.pending)} feedback(s) na fila de aprendizado`
                  : report.learned_at
                    ? `aprendeu por último em ${when(report.learned_at)}`
                    : "a MAVI ainda não aprendeu nada"}
              </footer>
            </article>
          </section>

          <section className="panel learning-kinds">
            <h2>Por tipo de alerta</h2>
            {report.kinds.length ? (
              <table className="stack-mobile stack-3">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>👍</th>
                    <th>👎</th>
                    <th>Ajudou</th>
                    <th>Aplicados</th>
                    <th>Dispensados</th>
                    <th title="Alertas importantes sem nenhuma reação">
                      Ignorados
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.kinds.map((k) => (
                    <tr key={k.kind}>
                      <td>{ALERT_LABELS[k.kind] ?? k.kind}</td>
                      <td data-label="👍">{count(k.up)}</td>
                      <td data-label="👎">{count(k.down)}</td>
                      <td data-label="Ajudou">
                        <span className="learning-rate">
                          <span
                            style={{
                              width: pct(k.up, k.down).replace("—", "0%"),
                            }}
                          />
                        </span>
                        {pct(k.up, k.down)}
                      </td>
                      <td data-label="Aplicados">{count(k.applied)}</td>
                      <td data-label="Dispensados">{count(k.dismissed)}</td>
                      <td data-label="Ignorados">{count(k.ignored)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="learning-empty">
                Ainda não há avaliações neste período.
              </p>
            )}
          </section>

          <section className="panel learning-lessons">
            <header>
              <div>
                <h2>
                  <GraduationCap size={17} aria-hidden="true" /> Aprendizados
                </h2>
                <p>
                  A MAVI segue estas instruções em cada análise. Entram em uso
                  sozinhos quando têm feedback de 2 pessoas ou de um líder.
                </p>
              </div>
              <Button
                className="btn primary"
                onClick={() =>
                  setEditing({
                    id: null,
                    scope: "company",
                    client: "",
                    product: "",
                    kind: "",
                    text: "",
                  })
                }
                disabled={!!editing}
              >
                <Plus size={15} /> Ensinar a MAVI
              </Button>
            </header>
            {editing && !editing.id && editor}
            <div className="drive-view" role="tablist">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  className={filter === f.id ? "selected" : ""}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  {counts[f.id] > 0 && <span> {counts[f.id]}</span>}
                </button>
              ))}
            </div>
            {!shown.length ? (
              <Empty
                title={
                  filter === "new" ? "Nada novo para conferir" : "Nenhum aqui"
                }
                body={
                  filter === "new"
                    ? "Quando a MAVI aprender algo com o feedback do time, aparece aqui para você conferir."
                    : "Os aprendizados deste grupo aparecem aqui."
                }
              />
            ) : (
              <ul className="learning-list">
                {shown.map((l) =>
                  editing?.id === l.id ? (
                    <li key={l.id}>{editor}</li>
                  ) : (
                    <li
                      key={l.id}
                      className={`learning-item status-${l.status}`}
                    >
                      <div className="learning-item-head">
                        <span className="learning-scope">{scopeLabel(l)}</span>
                        {l.kind && (
                          <span className="learning-kind">
                            {ALERT_LABELS[l.kind]}
                          </span>
                        )}
                        <span className={`learning-status ${l.status}`}>
                          {STATUS_LABELS[l.status]}
                        </span>
                        {isNew(l) && <span className="learning-new">Novo</span>}
                      </div>
                      <p>{l.text}</p>
                      <div className="learning-meta">
                        {l.origin === "person" ? (
                          <span>
                            <User size={12} aria-hidden="true" />
                            Escrito por {person(l.updated_by)}
                          </span>
                        ) : (
                          <span>
                            <Sparkles size={12} aria-hidden="true" />
                            Aprendido pela MAVI
                          </span>
                        )}
                        {l.feedbacks > 0 && (
                          <span>
                            {l.feedbacks} feedback(s) de {l.people} pessoa(s)
                            {l.has_leader ? " · inclui líder" : ""} · 👍 {l.ups}{" "}
                            · 👎 {l.downs}
                          </span>
                        )}
                        <span>{when(l.updated_at)}</span>
                        {l.reviewed_at && (
                          <span>Conferido por {person(l.reviewed_by)}</span>
                        )}
                      </div>
                      <div className="learning-actions">
                        {isNew(l) && (
                          <Button
                            className="btn secondary"
                            loading={busy === `r${l.id}`}
                            onClick={() =>
                              run(
                                `r${l.id}`,
                                () => setLesson(company, l.id, "review"),
                                "Aprendizado conferido.",
                              )
                            }
                          >
                            <CheckCircle2 size={14} /> Conferido
                          </Button>
                        )}
                        <button
                          type="button"
                          title="Corrigir"
                          aria-label="Corrigir"
                          onClick={() =>
                            setEditing({
                              id: l.id,
                              scope: l.scope,
                              client: l.client_id ?? "",
                              product: l.product_id ?? "",
                              kind: l.kind ?? "",
                              text: l.text,
                            })
                          }
                        >
                          <Pencil size={14} />
                        </button>
                        {l.status === "paused" ||
                        l.status === "dismissed" ||
                        l.status === "candidate" ? (
                          <button
                            type="button"
                            title={
                              l.status === "candidate"
                                ? "Colocar em uso agora"
                                : "Voltar a usar"
                            }
                            aria-label="Ativar"
                            disabled={busy === `a${l.id}`}
                            onClick={() =>
                              run(
                                `a${l.id}`,
                                () => setLesson(company, l.id, "activate"),
                                "Aprendizado em uso.",
                              )
                            }
                          >
                            <Play size={14} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            title="Pausar (a MAVI deixa de seguir)"
                            aria-label="Pausar"
                            disabled={busy === `p${l.id}`}
                            onClick={() =>
                              run(
                                `p${l.id}`,
                                () => setLesson(company, l.id, "pause"),
                                "Aprendizado pausado.",
                              )
                            }
                          >
                            <Pause size={14} />
                          </button>
                        )}
                        {l.status !== "dismissed" && (
                          <button
                            type="button"
                            title="Excluir (a MAVI não recria)"
                            aria-label="Excluir"
                            disabled={busy === `d${l.id}`}
                            onClick={() =>
                              run(
                                `d${l.id}`,
                                () => setLesson(company, l.id, "dismiss"),
                                "Aprendizado excluído.",
                              )
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>

          <section className="panel learning-feedback">
            <header>
              <h2>Feedbacks do time</h2>
              <div className="drive-view" role="group" aria-label="Filtrar">
                {(
                  [
                    [null, "Todos"],
                    ["up", "👍 Ajudou"],
                    ["down", "👎 Não ajudou"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={label}
                    type="button"
                    className={vote === v ? "selected" : ""}
                    onClick={() => {
                      setOffset(0);
                      setVote(v);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </header>
            {!report.feedback.length ? (
              <p className="learning-empty">Nenhum feedback neste período.</p>
            ) : (
              <ul className="learning-feedback-list">
                {report.feedback.map((f) => (
                  <li key={f.id} className={`vote-${f.vote}`}>
                    <span className="learning-vote" aria-hidden="true">
                      {f.vote === "up" ? (
                        <ThumbsUp size={14} />
                      ) : (
                        <ThumbsDown size={14} />
                      )}
                    </span>
                    <div>
                      <strong>
                        <span className="learning-kind">
                          {ALERT_LABELS[f.kind]}
                        </span>{" "}
                        {f.alert_title}
                      </strong>
                      {f.vote === "down" && (f.reason || f.comment) && (
                        <p>
                          {f.reason && (
                            <em>{REASON_LABELS[f.reason] ?? f.reason}</em>
                          )}
                          {f.reason && f.comment ? " — " : ""}
                          {f.comment && `“${f.comment}”`}
                        </p>
                      )}
                      <small>
                        {person(f.user_id)} · {when(f.at)}
                        {f.client_id
                          ? ` · cliente ${clientName(f.client_id)}`
                          : ""}
                        {f.draft_title ? ` · tarefa “${f.draft_title}”` : ""}
                        {f.learned ? " · já aprendido" : " · na fila"}
                      </small>
                    </div>
                    {f.task_id && (
                      <a
                        href={taskUrl(
                          { id: f.task_id, title: f.draft_title || "tarefa" },
                          routeParts(window.location.pathname).company,
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Abrir tarefa
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {report.feedback_total > PAGE && (
              <div className="learning-pages">
                <Button
                  className="btn secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                >
                  Anteriores
                </Button>
                <small>
                  {offset + 1}–{Math.min(offset + PAGE, report.feedback_total)}{" "}
                  de {count(report.feedback_total)}
                </small>
                <Button
                  className="btn secondary"
                  disabled={offset + PAGE >= report.feedback_total}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  Próximos
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

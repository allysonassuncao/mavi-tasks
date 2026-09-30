import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Bot,
  Brain,
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
import { dateKey } from "./domain";
import type { Snapshot } from "./types";
import {
  MAVI_KIND_LABELS,
  MAVI_PAGE,
  MAVI_REASON_LABELS,
  SIGNAL_LABELS,
  maviLearningReport,
  saveMaviLesson,
  setMaviJudge,
  setMaviLesson,
  type MaviLesson,
  type MaviLearningReport,
  type MaviLessonKind,
} from "./mavi-feedback";
import "./mavi-feedback.css";
import { MaviPersonProfile } from "./MaviPersonProfile";

/**
 * Painel da MAVI › Aprendizado da MAVI (administradores e gestores): como o
 * time avalia as respostas da MAVI (👍/👎 com motivo e comentário) e o que
 * ela aprendeu com isso — igual ao Copiloto das tarefas. Aprendizados entram
 * em uso sozinhos quando têm avaliação de 2 pessoas ou de um líder; aqui os
 * líderes conferem, corrigem, pausam ou excluem, e podem ensinar a MAVI
 * diretamente. Vão em cada pergunta à MAVI (o do cliente vale mais).
 */

type Scope = "company" | "product" | "client";
type LessonStatus = "active" | "candidate" | "paused" | "dismissed";
type Lesson = MaviLesson;
type LearningReport = MaviLearningReport;

const PAGE = MAVI_PAGE;
const KINDS = Object.keys(MAVI_KIND_LABELS) as MaviLessonKind[];
const KIND_LABELS: Record<string, string> = MAVI_KIND_LABELS;
const REASON_LABELS = MAVI_REASON_LABELS;
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
    totals: { up: 42, down: 9, people: 11, answers: 380 },
    judge: {
      checked: 14,
      bad: 5,
      pending: 1,
      signals: { capped: 4, announce: 3, frustration: 2, no_sources: 2 },
      enabled: true,
      daily_limit: 40,
    },
    reasons: { incomplete: 4, format: 3, wrong: 2 },
    lessons: [
      lesson({
        kind: "tasks",
        text: "Em pedidos com mais de 4 clientes (passagem de carteira, relatório de vários clientes), monte uma tarefa longa em vez de responder na hora.",
        people: 3,
        downs: 4,
        feedbacks: 4,
      }),
      lesson({
        kind: "format",
        text: "Listas de clientes vão em tabela, com a temperatura e as pendências de cada um.",
        ups: 3,
        downs: 1,
        feedbacks: 4,
        people: 3,
        reviewed_at: now,
      }),
      lesson({
        scope: "client",
        client_id: "demo",
        kind: "facts",
        text: "O gestor do cliente mudou em setembro/2026: o contato agora é o Pedro.",
        status: "candidate",
        people: 1,
        downs: 1,
        feedbacks: 1,
      }),
    ],
    feedback: [
      {
        id: 3,
        user_id: null,
        origin: "judge",
        signals: ["capped", "announce", "frustration"],
        client_id: null,
        product_id: null,
        module: "assistant",
        vote: "down",
        reason: "incomplete",
        comment: "Com 17 clientes, devia montar uma tarefa longa em vez de responder na hora; parou anunciando que ia puxar as reuniões.",
        question: "Me mande o que te pedi",
        answer: "A busca isolada funcionou. Vou puxar os briefings em lotes menores.",
        at: now,
        learned: false,
      },
      {
        id: 1,
        user_id: "",
        client_id: null,
        product_id: null,
        module: "assistant",
        vote: "down",
        reason: "incomplete",
        comment: "Pedi a passagem dos 17 clientes e ela parou no meio.",
        question: "Monte a passagem dos clientes 5022, 5017, 5052…",
        answer: "O modo simples funcionou. Agora vou puxar as reuniões de cada cliente…",
        at: now,
        learned: true,
      },
      {
        id: 2,
        user_id: "",
        client_id: null,
        product_id: null,
        module: "assistant",
        vote: "up",
        reason: null,
        comment: "",
        question: "Quais clientes estão frios?",
        answer: "Os 4 clientes mais frios da carteira são…",
        at: now,
        learned: false,
      },
    ],
    feedback_total: 3,
    pending: 2,
    learned_at: now,
  };
}

// ------------------------------------------------------------ tela
export function MaviLearning({
  company,
  data,
  demo = false,
  isAdmin = false,
  notify,
}: {
  company: string;
  data: Snapshot;
  demo?: boolean;
  /** Gestores não veem a base de comportamento dos administradores. */
  isAdmin?: boolean;
  notify: (message: string) => void;
}) {
  const [personId, setPersonId] = useState("");
  const people = data.members
    .filter((m) => m.active !== false && (isAdmin || m.role !== "admin"))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const today = dateKey();
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return dateKey(d);
  });
  const [to, setTo] = useState(today);
  const [vote, setVote] = useState<"up" | "down" | "judge" | null>(null);
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
      : maviLearningReport(company, from, to, vote, offset)
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
  const totals = report?.totals ?? { up: 0, down: 0, people: 0, answers: 0 };

  const clientName = (id: string | null) =>
    data.clients.find((c) => c.id === id)?.name ?? "cliente removido";
  const productName = (id: string | null) =>
    data.products.find((p) => p.id === id)?.name ?? "produto removido";
  const person = (id: string | null) =>
    id === null
      ? "Autoavaliação da MAVI"
      : (data.members.find((m) => m.user_id === id)?.name ?? "Alguém do time");
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
        await saveMaviLesson(
          company,
          ed.id,
          ed.scope,
          ed.scope === "client" ? ed.client : null,
          ed.scope === "product" ? ed.product : null,
          (ed.kind || null) as MaviLessonKind | null,
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
          Sobre
          <Select
            value={editing.kind || "all"}
            onValueChange={(v) =>
              setEditing({ ...editing, kind: v === "all" ? "" : v })
            }
          >
            <SelectOption value="all">Geral</SelectOption>
            {KINDS.map((k) => (
              <SelectOption key={k} value={k}>
                {KIND_LABELS[k]}
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
        placeholder="Ex.: Em pedidos com mais de 4 clientes, monte uma tarefa longa em vez de responder na hora."
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
                Respostas que ajudaram <ThumbsUp size={17} />
              </div>
              <strong>{count(totals.up)}</strong>
              <footer>{pct(totals.up, totals.down)} das avaliadas</footer>
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
                Respostas avaliadas <CheckCircle2 size={17} />
              </div>
              <strong>{pct(totals.up + totals.down, Math.max(totals.answers - totals.up - totals.down, 0))}</strong>
              <footer>
                {count(totals.up + totals.down)} de {count(totals.answers)} respostas · {count(totals.people)} pessoa(s)
              </footer>
            </article>
            <article className="stat-card purple">
              <div>
                Aprendizados em uso <GraduationCap size={17} />
              </div>
              <strong>{count(counts.active)}</strong>
              <footer>
                {report.pending
                  ? `${count(report.pending)} avaliação(ões) na fila de aprendizado`
                  : report.learned_at
                    ? `aprendeu por último em ${when(report.learned_at)}`
                    : "a MAVI ainda não aprendeu nada"}
              </footer>
            </article>
          </section>

          {report.judge && (
            <section className="panel mavi-judge-panel">
              <div>
                <h2>
                  <Bot size={17} aria-hidden="true" /> Autoavaliação
                </h2>
                <p>
                  Sem gastar nada, a MAVI marca as respostas com sinal de problema. Só essas vão para o juiz: o Jev
                  responde as perguntas objetivas (entregou tudo? os fatos estão nas fontes?) e um modelo explica o que
                  faltou. Resposta ruim vira uma avaliação da MAVI; sozinha, a lição espera mais uma pessoa ou um líder.
                </p>
                <small>
                  {count(report.judge.checked)} conferida(s) no período · {count(report.judge.bad)} ruim(ns) ·{" "}
                  {count(report.judge.pending)} na fila
                  {Object.keys(report.judge.signals).length > 0 &&
                    ` · ${Object.entries(report.judge.signals)
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, n]) => `${SIGNAL_LABELS[k] ?? k} (${n})`)
                      .join(", ")}`}
                </small>
              </div>
              <div className="mavi-judge-controls">
                <label className="mavi-judge-toggle">
                  <input
                    type="checkbox"
                    checked={report.judge.enabled}
                    disabled={busy === "judge"}
                    onChange={(e) =>
                      void run(
                        "judge",
                        () => setMaviJudge(company, e.target.checked, null),
                        e.target.checked ? "Autoavaliação ligada." : "Autoavaliação desligada.",
                      )
                    }
                  />
                  {report.judge.enabled ? "Ligada" : "Desligada"}
                </label>
                <label>
                  Até
                  <input
                    className="mavi-judge-limit"
                    type="number"
                    min={0}
                    max={500}
                    defaultValue={report.judge.daily_limit}
                    aria-label="Respostas conferidas por dia"
                    onBlur={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isInteger(n) && n >= 0 && n <= 500 && n !== report.judge!.daily_limit)
                        void run("judge", () => setMaviJudge(company, null, n), "Limite por dia salvo.");
                    }}
                  />
                  por dia
                </label>
              </div>
            </section>
          )}

          <section className="panel learning-lessons">
            <header>
              <div>
                <h2>
                  <GraduationCap size={17} aria-hidden="true" /> Aprendizados
                </h2>
                <p>
                  A MAVI segue estas instruções em cada pergunta (as do cliente
                  e do produto da conversa primeiro). Entram em uso sozinhos
                  quando têm avaliação de 2 pessoas ou de um líder.
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
                    ? "Quando a MAVI aprender algo com as avaliações das respostas, aparece aqui para você conferir."
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
                            {KIND_LABELS[l.kind]}
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
                            {l.feedbacks} avaliação(ões) de {l.people} pessoa(s)
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
                                () => setMaviLesson(company, l.id, "review"),
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
                                () => setMaviLesson(company, l.id, "activate"),
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
                                () => setMaviLesson(company, l.id, "pause"),
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
                                () => setMaviLesson(company, l.id, "dismiss"),
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

          {!demo && (
            <>
              <section className="panel mavi-person-picker">
                <h2>
                  <Brain size={17} aria-hidden="true" /> Por pessoa
                </h2>
                <Select value={personId || "none"} onValueChange={(v) => setPersonId(v === "none" ? "" : v)}>
                  <SelectOption value="none">Escolha uma pessoa</SelectOption>
                  {people.map((m) => (
                    <SelectOption key={m.user_id} value={m.user_id}>
                      {m.name}
                    </SelectOption>
                  ))}
                </Select>
                <p>
                  O que a MAVI sabe de cada pessoa para responder do jeito dela: preferências, contexto de trabalho, o
                  que evitar e o histórico das avaliações. A pessoa vê o mesmo em Meu perfil.
                  {!isAdmin && " Gestores não veem os administradores."}
                </p>
              </section>
              {personId && <MaviPersonProfile company={company} user={personId} data={data} notify={notify} />}
            </>
          )}

          <section className="panel learning-feedback">
            <header>
              <h2>Avaliações do time</h2>
              <div className="drive-view" role="group" aria-label="Filtrar">
                {(
                  [
                    [null, "Todos"],
                    ["up", "👍 Ajudou"],
                    ["down", "👎 Não ajudou"],
                    ["judge", "🤖 Autoavaliação"],
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
              <p className="learning-empty">Nenhuma avaliação neste período.</p>
            ) : (
              <ul className="learning-feedback-list">
                {report.feedback.map((f) => (
                  <li key={f.id} className={`vote-${f.vote}${f.origin === "judge" ? " by-mavi" : ""}`}>
                    <span className="learning-vote" aria-hidden="true">
                      {f.vote === "up" ? (
                        <ThumbsUp size={14} />
                      ) : (
                        <ThumbsDown size={14} />
                      )}
                    </span>
                    <div>
                      <strong>{f.question ? `“${f.question}”` : "Resposta da MAVI"}</strong>
                      {f.answer && <p className="learning-answer">{f.answer}</p>}
                      {!!f.signals?.length && (
                        <p className="mavi-judge-signals">
                          {f.signals.map((x) => (
                            <span key={x}>{SIGNAL_LABELS[x] ?? x}</span>
                          ))}
                        </p>
                      )}
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
                        {f.learned ? " · já aprendido" : " · na fila"}
                      </small>
                    </div>
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

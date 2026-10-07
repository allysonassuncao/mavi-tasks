import { useEffect, useMemo, useState } from "react";
import { CircleSlash, Link2, ListChecks, Plus, Radar, Sparkles, X } from "lucide-react";
import { Loading, Select, SelectOption } from "./ui";
import { routeParts, taskUrl } from "./router";
import { statuses, type Snapshot, type Status } from "./types";
import { appPath, openInApp } from "./temperature";
import {
  CHANGED_LABELS,
  PRIORITY_LABELS,
  SEVERITY_LABELS,
  SUGGESTION_REASONS,
  changedLine,
  loadTaskLearning,
  mainPriority,
  presetRate,
  taskRate,
  type LearningGroup,
  type LearningSignal,
  type TaskLearning,
} from "./radar-task-learning";
import { RadarTaskRules } from "./RadarTaskRules";
import { RadarTaskSuggestStats } from "./RadarTaskSuggestStats";
import "./radar-task-learning.css";

const PERIODS = [
  { days: 90, label: "Últimos 90 dias" },
  { days: 180, label: "Últimos 180 dias" },
  { days: 365, label: "Último ano" },
  { days: 730, label: "Últimos 2 anos" },
];
const count = (n: number) => n.toLocaleString("pt-BR");
const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const days = (n: number) => (n === 1 ? "1 dia útil" : `${n} dias úteis`);

/**
 * Painel da MAVI › Tarefas do Radar (administradores e gestores): o que a
 * MAVI está aprendendo com as tarefas abertas a partir dos itens do Radar do
 * cliente — quais tipos de item viram tarefa e quais fecham sem, para qual
 * equipe ou pessoa, com que prazo e prioridade, e o que as pessoas mudam no
 * formulário que veio preenchido. No topo, as regras que a MAVI propõe com
 * esse material (src/RadarTaskRules.tsx).
 */
export function RadarTaskLearning({
  company,
  data,
  notify,
}: {
  company: string;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const [period, setPeriod] = useState(180);
  const [topic, setTopic] = useState("");
  const [product, setProduct] = useState("");
  const [report, setReport] = useState<TaskLearning | null>(null);
  const [error, setError] = useState("");
  // Os tópicos já vistos (o filtro não some quando um tópico é escolhido).
  const [topics, setTopics] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    setError("");
    loadTaskLearning(company, {
      days: period,
      ...(topic ? { topic } : {}),
      ...(product ? { product } : {}),
    })
      .then((r) => {
        if (!alive) return;
        setReport(r);
        setTopics((m) => {
          const next = new Map(m);
          r.groups.forEach((g) => next.set(g.topic_id, g.topic_name));
          return next;
        });
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [company, period, topic, product]);

  const products = useMemo(
    () => [...data.products].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.products],
  );
  const totals = report?.totals;
  const withTask = totals ? totals.created + totals.linked : 0;
  const rate = totals ? taskRate({ items_task: withTask, no_task: totals.no_task }) : null;
  const kept = totals ? presetRate(totals) : null;

  return (
    <div className="learning rtl">
      <section className="panel rtl-intro">
        <h2>
          <ListChecks size={17} aria-hidden="true" /> O que a MAVI aprende com as tarefas do Radar
        </h2>
        <p>
          Cada tarefa criada ou vinculada a partir de um item do Radar › Cliente, e cada item fechado sem tarefa,
          vira material para a MAVI entender <strong>quando</strong> um item pede tarefa, <strong>para quem</strong>{" "}
          e <strong>com que prazo</strong>. No “Criar tarefa” ela também guarda o que vocês mudaram no que veio
          preenchido. Com isso ela propõe regras para vocês aprovarem e, com as regras em uso, sugere a tarefa no
          item; quando acertar bastante, poderá ser liberada para abrir sozinha.
        </p>
      </section>

      <RadarTaskRules company={company} data={data} notify={notify} />
      <RadarTaskSuggestStats company={company} days={period} notify={notify} />

      <div className="ai-usage-toolbar rtl-filters">
        <Select aria-label="Período" value={String(period)} onValueChange={(v) => setPeriod(Number(v))}>
          {PERIODS.map((p) => (
            <SelectOption key={p.days} value={String(p.days)}>
              {p.label}
            </SelectOption>
          ))}
        </Select>
        <Select aria-label="Tópico" value={topic} onValueChange={setTopic}>
          <SelectOption value="">Todos os tópicos</SelectOption>
          {[...topics].map(([id, name]) => (
            <SelectOption key={id} value={id}>
              {name}
            </SelectOption>
          ))}
        </Select>
        <Select aria-label="Produto" value={product} onValueChange={setProduct}>
          <SelectOption value="">Todos os produtos</SelectOption>
          <SelectOption value="general">Geral / Agência</SelectOption>
          {products.map((p) => (
            <SelectOption key={p.id} value={p.id}>
              {p.name}
            </SelectOption>
          ))}
        </Select>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!report || !totals ? (
        !error && <Loading variant="chart" />
      ) : (
        <>
          <section className="stats-grid" aria-label="Resumo do período">
            <article className="stat-card blue">
              <div>
                Viraram tarefa <Plus size={17} />
              </div>
              <strong>{count(withTask)}</strong>
              <footer>
                {count(totals.created)} criadas pelo item · {count(totals.linked)} vinculadas
              </footer>
            </article>
            <article className="stat-card">
              <div>
                Fechados sem tarefa <CircleSlash size={17} />
              </div>
              <strong>{count(totals.no_task)}</strong>
              <footer>ensinam quando não abrir</footer>
            </article>
            <article className="stat-card purple">
              <div>
                Taxa de tarefa <Radar size={17} />
              </div>
              <strong>{rate === null ? "—" : `${rate}%`}</strong>
              <footer>dos itens com decisão no período</footer>
            </article>
            <article className="stat-card green">
              <div>
                Ficaram como vieram <Sparkles size={17} />
              </div>
              <strong>{kept === null ? "—" : `${kept}%`}</strong>
              <footer>
                {totals.with_preset
                  ? `${count(totals.as_preset)} de ${count(totals.with_preset)} criadas sem mudar nada`
                  : "nenhuma criada pelo item ainda"}
              </footer>
            </article>
          </section>

          <section className="panel learning-kinds">
            <h2>Por tópico e produto</h2>
            {report.groups.length ? (
              <table className="stack-mobile stack-3 rtl-groups">
                <thead>
                  <tr>
                    <th>Tópico · produto</th>
                    <th>Viram tarefa</th>
                    <th>Para quem</th>
                    <th title="Mediana, em dias úteis a partir da criação">Prazo típico</th>
                    <th title="Itens com tarefa / itens com decisão, por gravidade">Por gravidade</th>
                    <th title="O que as pessoas mudaram no formulário preenchido">Mudam</th>
                  </tr>
                </thead>
                <tbody>
                  {report.groups.map((g) => (
                    <GroupRow key={`${g.topic_id}:${g.product_id ?? ""}`} g={g} />
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="learning-empty">
                Ainda não há tarefas criadas nem itens fechados neste período. Crie tarefas pelo item do Radar ›
                Cliente e a MAVI começa a aprender.
              </p>
            )}
          </section>

          <section className="panel learning-feedback">
            <h2>Últimos registros</h2>
            {report.recent.length ? (
              <ul className="rtl-signals">
                {report.recent.map((s) => (
                  <SignalRow key={s.id} s={s} />
                ))}
              </ul>
            ) : (
              <p className="learning-empty">Nenhum registro neste período.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function GroupRow({ g }: { g: LearningGroup }) {
  const rate = taskRate(g);
  const priority = mainPriority(g.priorities);
  const severity = g.severity.filter((s) => s.severity !== null && s.task + s.no_task > 0);
  return (
    <tr>
      <td>
        <span className="rtl-topic" style={{ background: g.topic_color }} aria-hidden="true" />
        {g.topic_name}
        <small>{g.product_name ?? "Geral / Agência"}</small>
      </td>
      <td data-label="Viram tarefa">
        <span className="learning-rate">
          <span style={{ width: `${rate ?? 0}%` }} />
        </span>
        {rate === null ? "—" : `${rate}%`}
        <small>
          {count(g.items_task)} de {count(g.items_task + g.no_task)}
          {g.no_task_reopened ? ` · ${g.no_task_reopened} reabriu sem tarefa` : ""}
        </small>
      </td>
      <td data-label="Para quem">
        {g.teams.length ? (
          <span className="rtl-chips">
            {g.teams.map((t) => (
              <span key={t.id}>
                {t.name} <b>{t.n}</b>
              </span>
            ))}
          </span>
        ) : (
          "—"
        )}
        {g.people.length > 0 && <small>{g.people.map((p) => `${p.name} (${p.n})`).join(", ")}</small>}
      </td>
      <td data-label="Prazo típico">
        {g.due_days === null ? "—" : days(g.due_days)}
        {priority && <small>prioridade {priority}</small>}
      </td>
      <td data-label="Por gravidade">
        {severity.length
          ? severity.map((s) => (
              <small key={s.severity}>
                {SEVERITY_LABELS[s.severity!] ?? s.severity}: {s.task}/{s.task + s.no_task}
              </small>
            ))
          : "—"}
      </td>
      <td data-label="Mudam">
        {g.with_preset ? changedLine(g.changed) || "nada" : "—"}
        {g.with_preset > 0 && (
          <small>
            {g.as_preset} de {g.with_preset} como vieram
          </small>
        )}
      </td>
    </tr>
  );
}

function SignalRow({ s }: { s: LearningSignal }) {
  const company = routeParts(window.location.pathname).company;
  const item = `/radar?item=${s.item_id}`;
  const who = s.by_team && s.team_name
    ? `equipe ${s.team_name}${s.assignee_name ? ` (${s.assignee_name})` : ""}`
    : [s.assignee_name, s.team_name && `equipe ${s.team_name}`].filter(Boolean).join(", ");
  const Icon = s.kind === "no_task" ? CircleSlash : s.kind === "dismissed" ? X : s.kind === "linked" ? Link2 : Plus;
  const status = s.task_status ? statuses[s.task_status as Status] : null;
  return (
    <li className={`rtl-signal ${s.kind}${s.removed_reason ? " removed" : ""}`}>
      <Icon size={15} aria-hidden="true" />
      <div>
        <a
          href={appPath(item)}
          onClick={(e) => {
            e.preventDefault();
            openInApp(item);
          }}
        >
          {s.item_title}
        </a>
        <small>
          {s.client_name} · <span style={{ color: s.topic_color }}>{s.topic_name}</span> ·{" "}
          {s.product_name ?? "Geral / Agência"}
          {s.severity !== undefined ? ` · gravidade ${SEVERITY_LABELS[s.severity]?.toLowerCase() ?? s.severity}` : ""}
        </small>
        <p>
          {s.kind === "no_task" ? (
            <>
              {s.user_name ?? "A MAVI"} fechou como <b>{s.status_label ?? "fechado"}</b> sem tarefa
            </>
          ) : s.kind === "dismissed" ? (
            <>
              {s.user_name ?? "Alguém"} recusou a tarefa sugerida
              {s.suggested_title ? <> “{s.suggested_title}”</> : null}:{" "}
              <b>{SUGGESTION_REASONS.find((r) => r.value === s.reason)?.label.toLowerCase() ?? s.reason}</b>
              {s.note && <> — {s.note}</>}
            </>
          ) : (
            <>
              {s.user_name ?? "Alguém"} {s.kind === "created" ? "criou" : "vinculou"}{" "}
              {s.task_id ? (
                <a
                  href={taskUrl({ id: s.task_id, title: s.task_title ?? "tarefa" }, company)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  “{s.task_title ?? "tarefa"}”
                </a>
              ) : (
                "uma tarefa (excluída)"
              )}
              {who && <> para {who}</>}
              {s.due_days !== undefined && <> · prazo {days(s.due_days)}</>}
              {s.priority && s.priority !== "normal" && <> · prioridade {PRIORITY_LABELS[s.priority]}</>}
              {status && (
                <span className="rtl-status" style={{ color: status.color }}>
                  {" "}
                  · {status.label}
                </span>
              )}
            </>
          )}
        </p>
        <span className="rtl-tags">
          {s.from_suggestion && s.kind !== "dismissed" && <span className="ok">pela sugestão da MAVI</span>}
          {s.suggested &&
            (s.changed?.length ? (
              <span>mudou {s.changed.map((c) => CHANGED_LABELS[c] ?? c).join(", ")}</span>
            ) : (
              <span className="ok">como veio preenchida</span>
            ))}
          {s.removed_reason === "unlinked" && <span className="off">desvinculada</span>}
          {s.removed_reason === "task_later" && <span className="off">ganhou tarefa depois</span>}
          {s.reopened && <span className="warn">reabriu depois</span>}
          {s.backfill && <span>histórico</span>}
        </span>
      </div>
      <time dateTime={s.created_at}>{when(s.created_at)}</time>
    </li>
  );
}

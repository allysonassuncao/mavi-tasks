import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  X,
} from "lucide-react";
import { Button, Input, Skeleton } from "./ui";
import { statuses, type Status } from "./types";
import { appPath, openInApp } from "./temperature";
import {
  bucketLabel,
  categoryLabel,
  formatValue,
  metricDef,
  queryName,
  type Display,
  type GroupBy,
  type Panel,
  type PanelRecords,
  type PanelResult,
  type Query,
  type RecordKind,
  type RecordRow,
  type RecordSelection,
  type Unit,
} from "./dashboards";

/**
 * The records behind a panel (migration 20270224090000): the tasks, entries,
 * periods, clients… that make up its figure, one by one, each with its part
 * of the value and its category, from the same query as the panel. A bar
 * clicked narrows the list to it; one tab per query when the panel has more
 * than one (a formula's A, B…); search, sort and a footer that checks the
 * sum (or the average, the rate) against the panel.
 */

/** Loads one query's records of a panel (from the app, a link or the demo). */
export type RecordsLoader = (
  panel: Panel,
  ref: string,
  selection: RecordSelection,
  fresh: boolean,
) => Promise<PanelRecords>;

/** A category picked on the chart (its key and what the chart calls it). */
export type PickedCategory = { key: string; label: string };

/** How many rows show at first, and how many more each click. */
const PAGE = 100;

const groupHeading: Record<GroupBy, string> = {
  none: "Total",
  time: "Período",
  client: "Cliente",
  product: "Produto",
  project: "Projeto",
  team: "Equipe",
  person: "Conta para",
  creator: "Criador",
  status: "Status",
  priority: "Prioridade",
  stage: "Etapa",
  executor: "Executou",
  previous: "Responsável anterior",
  validator: "Validou",
  notice: "Aviso",
  level: "Nível",
  band: "Faixa",
  topic: "Tópico",
  theme: "Tema",
  severity: "Gravidade",
};

/** Metrics that count distinct things (each record is one of them). */
const DISTINCT = new Set([
  "hours.people",
  "hours.tasks",
  "status_history.tasks",
  "due_changes.tasks",
  "notices.notices",
  "temperature.clients",
  "temperature.alert_clients",
  "temperature.flag_clients",
  "radar.clients",
]);
/** Rates: each record is a yes (100) or a no (0) — in words. */
const YES_NO: Record<string, [string, string]> = {
  "tasks.on_time_rate": ["No prazo", "Atrasada"],
  "tasks.on_time_original_rate": ["No prazo original", "Fora do prazo original"],
  "tasks.first_pass_rate": ["Aprovada de primeira", "Teve retrabalho"],
  "tasks.smart_hit_rate": ["No prazo da MAVI", "Fora do prazo da MAVI"],
  "tasks.rule_hit_rate": ["No prazo da regra", "Fora do prazo da regra"],
  "reviews.approval_rate": ["Aprovada", "Reprovada"],
  "reviews.reproval_rate": ["Reprovada", "Aprovada"],
  "notices.seen_rate": ["Visto", "Não visto"],
  "notices.ack_rate": ["Confirmado", "Sem confirmação"],
  "temperature.alert_rate": ["Em alerta", "Fora do alerta"],
  "social_leads.approval_rate": ["Aprovado", "Reprovado"],
  "social_leads.rejection_rate": ["Reprovado", "Aprovado"],
};
/** What one record is, singular and plural. */
const nouns: Record<RecordKind, [string, string]> = {
  task: ["tarefa", "tarefas"],
  entry: ["lançamento de horas", "lançamentos de horas"],
  person: ["pessoa", "pessoas"],
  period: ["período", "períodos"],
  due_change: ["mudança de prazo", "mudanças de prazo"],
  receipt: ["entrega de aviso", "entregas de aviso"],
  notice: ["aviso", "avisos"],
  client: ["cliente", "clientes"],
  sl_event: ["decisão", "decisões"],
  sl_post: ["post", "posts"],
  sl_plan: ["plano", "planos"],
  sl_contract: ["cliente", "clientes"],
  radar_item: ["item", "itens"],
  mention: ["ocorrência", "ocorrências"],
};
const noun = (kind: RecordKind, n: number) =>
  nouns[kind]?.[n === 1 ? 0 : 1] ?? (n === 1 ? "registro" : "registros");
const count = (n: number) => n.toLocaleString("pt-BR");

const statusLabel = (s: string | null | undefined) =>
  s ? (statuses[s as Status]?.label ?? s) : "";
const severityLabel = (s: number | null | undefined) =>
  s === null || s === undefined
    ? ""
    : (["Baixa", "Média", "Alta", "Crítica"][s] ?? String(s));
const levelLabel: Record<string, string> = {
  info: "Informativo",
  important: "Importante",
  critical: "Crítico",
};
const decisionLabel: Record<string, string> = {
  approved: "Aprovado",
  rejected: "Reprovado",
};
const dueSourceLabel: Record<string, string> = {
  task: "Na tarefa",
  edit: "Editar tarefa",
  bulk: "Em massa",
  replan: "Replanejamento",
};
const reviewResult = (r: RecordRow) =>
  r.to_status === "done"
    ? "Aprovada"
    : r.to_status === "rejected" || r.to_status === "correction"
      ? `Reprovada (${statusLabel(r.to_status)})`
      : r.ended_at
        ? `Saiu para ${statusLabel(r.to_status)}`
        : "Em validação";
/** "4 dias", "2h10", "35 min": a duration in hours. */
function duration(hours: number | null) {
  if (hours === null || !Number.isFinite(hours)) return "";
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
  }
  return `${(minutes / 1440).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`;
}
const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

type Col = {
  key: string;
  label: string;
  /** What the cell says (also searched and, without sort, sorted). */
  text: (r: RecordRow) => string;
  sort?: (r: RecordRow) => number | string;
  render?: (r: RecordRow) => ReactNode;
  num?: boolean;
  wide?: boolean;
};

/** The columns of each kind of record. */
function kindColumns(
  kind: RecordKind,
  q: Query,
  fmt: { day: (d?: string | null) => string; time: (d?: string | null) => string },
  link: (r: RecordRow) => ReactNode,
): Col[] {
  const { day, time } = fmt;
  const dateCol = (key: keyof RecordRow, label: string, withTime = false): Col => ({
    key: String(key),
    label,
    text: (r) => (withTime ? time : day)(r[key] as string | null | undefined),
    sort: (r) => String(r[key] ?? ""),
  });
  const textCol = (key: keyof RecordRow, label: string, wide = false): Col => ({
    key: String(key),
    label,
    text: (r) => String(r[key] ?? ""),
    wide,
  });
  const titleCol = (label = "Tarefa"): Col => ({
    key: "title",
    label,
    text: (r) => r.title ?? "",
    render: link,
    wide: true,
  });
  const clientCol: Col = {
    key: "client",
    label: "Cliente",
    text: (r) => [r.client, r.product].filter(Boolean).join(" · "),
    render: (r) => (
      <>
        {r.client ?? "—"}
        {r.product && <small>{r.product}</small>}
      </>
    ),
  };
  switch (kind) {
    case "task": {
      const dateLabel =
        q.dateField === "delivered_at"
          ? "Entregue em"
          : q.dateField === "due_date"
            ? "Prazo"
            : "Criada em";
      return [
        titleCol(),
        clientCol,
        {
          key: "status",
          label: "Status",
          text: (r) => statusLabel(r.status),
          render: (r) => (
            <span
              className="dash-rec-status"
              style={{ ["--status" as string]: statuses[r.status as Status]?.color ?? "#a3acab" }}
            >
              {statusLabel(r.status)}
            </span>
          ),
        },
        {
          key: "people",
          label: "Pessoas",
          text: (r) =>
            [r.assignee, ...(r.executors ?? [])].filter(Boolean).join(", "),
          render: (r) => {
            const others = (r.executors ?? []).filter((x) => x !== r.assignee);
            return (
              <>
                {r.assignee ?? "—"}
                {(r.executors?.length ?? 0) > 0 && (
                  <small>
                    {others.length
                      ? `Executaram: ${(r.executors ?? []).join(", ")}`
                      : "Executou"}
                  </small>
                )}
              </>
            );
          },
        },
        {
          key: "d",
          label: dateLabel,
          text: (r) => day(r.d),
          sort: (r) => r.d ?? "",
        },
        ...(q.dateField === "due_date" ? [] : [dateCol("due_date", "Prazo")]),
        ...(q.dateField === "delivered_at"
          ? []
          : [
              {
                ...dateCol("delivered_at", "Entregue em"),
                text: (r: RecordRow) => day(r.delivered_at) || "—",
              },
            ]),
      ];
    }
    case "entry":
      return [
        dateCol("started_at", "Início", true),
        textCol("person", "Pessoa"),
        titleCol(),
        clientCol,
        {
          key: "source",
          label: "Origem",
          text: (r) => (r.source === "timer" ? "Cronômetro" : "Manual"),
        },
      ];
    case "person":
      return [textCol("person", "Pessoa", true)];
    case "period":
      if (q.source === "reviews")
        return [
          titleCol(),
          clientCol,
          textCol("previous", "Enviou"),
          {
            key: "ended_by",
            label: "Validou",
            text: (r) => r.ended_by ?? r.person ?? "",
          },
          dateCol("started_at", "Enviada em", true),
          {
            ...dateCol("ended_at", "Decidida em", true),
            text: (r) => time(r.ended_at) || "—",
          },
          { key: "result", label: "Resultado", text: reviewResult },
        ];
      return [
        titleCol(),
        clientCol,
        {
          key: "status",
          label: "Status",
          text: (r) => statusLabel(r.status),
          render: (r) => (
            <>
              {statusLabel(r.status)}
              {r.from_status && r.from_status !== r.status && (
                <small>veio de {statusLabel(r.from_status)}</small>
              )}
            </>
          ),
        },
        {
          key: "person",
          label: "Pessoa",
          text: (r) => r.person ?? "",
          render: (r) => (
            <>
              {r.person ?? "—"}
              {r.status === "returned" && r.previous && (
                <small>devolvida por {r.previous}</small>
              )}
            </>
          ),
        },
        dateCol("started_at", "Início", true),
        {
          ...dateCol("ended_at", "Fim", true),
          text: (r) => time(r.ended_at) || "em aberto",
        },
      ];
    case "due_change":
      return [
        titleCol(),
        clientCol,
        textCol("person", "Quem mudou"),
        dateCol("created_at", "Quando", true),
        {
          key: "change",
          label: "Prazo",
          text: (r) => `${day(r.old_due)} → ${day(r.new_due)}`,
          sort: (r) => r.new_due ?? "",
        },
        textCol("reason", "Motivo", true),
        {
          key: "source",
          label: "Onde",
          text: (r) => dueSourceLabel[r.source ?? ""] ?? r.source ?? "",
        },
      ];
    case "receipt":
      return [
        titleCol("Aviso"),
        textCol("person", "Pessoa"),
        dateCol("delivered_at", "Entregue em", true),
        {
          ...dateCol("seen_at", "Visto em", true),
          text: (r) => time(r.seen_at) || "Não viu",
        },
        {
          ...dateCol("acked_at", "Confirmado em", true),
          text: (r) =>
            r.require_ack ? time(r.acked_at) || "Não confirmou" : "Não pede",
        },
      ];
    case "notice":
      return [
        titleCol("Aviso"),
        {
          key: "level",
          label: "Nível",
          text: (r) => levelLabel[r.level ?? ""] ?? r.level ?? "",
        },
        textCol("person", "Autor"),
        dateCol("publish_at", "Publicado em", true),
      ];
    case "client":
      return [
        textCol("client", "Cliente", true),
        ...(q.source === "temperature"
          ? [
              {
                key: "n",
                label: "Dias com nota",
                text: (r: RecordRow) => count(r.n),
                sort: (r: RecordRow) => r.n,
                num: true,
              },
              dateCol("d", "Último dia"),
            ]
          : []),
      ];
    case "sl_event":
      return [
        clientCol,
        {
          key: "post",
          label: "Post",
          text: (r) => [r.plan, r.number ? `post ${r.number}` : ""].filter(Boolean).join(" · "),
        },
        {
          key: "decision",
          label: "Decisão",
          text: (r) => decisionLabel[r.decision ?? ""] ?? r.decision ?? "",
        },
        {
          key: "person",
          label: "Quem",
          text: (r) =>
            `${r.person ?? "—"}${r.via === "link" ? " (pelo link)" : r.via === "ai" ? " (MAVI)" : ""}`,
        },
        dateCol("created_at", "Quando", true),
        textCol("note", "Observação", true),
      ];
    case "sl_post":
      return [
        clientCol,
        textCol("plan", "Plano"),
        {
          key: "number",
          label: "Post",
          text: (r) => (r.number ? `Post ${r.number}` : ""),
          sort: (r) => r.number ?? 0,
        },
      ];
    case "sl_plan":
      return [
        clientCol,
        textCol("plan", "Plano"),
        textCol("person", "Criou"),
        dateCol("created_at", "Criado em"),
        dateCol("d", "Aprovado em"),
      ];
    case "sl_contract":
      return [clientCol, textCol("stage", "Etapa"), textCol("person", "Responsável")];
    case "radar_item":
      return [
        titleCol("Item"),
        clientCol,
        textCol("topic", "Tópico"),
        {
          key: "severity",
          label: "Gravidade",
          text: (r) => severityLabel(r.severity),
          sort: (r) => r.severity ?? -1,
        },
        textCol("state", "Situação"),
        textCol("person", "Responsável"),
        {
          key: "mentions",
          label: "Ocorrências",
          text: (r) => count(r.mentions ?? 0),
          sort: (r) => r.mentions ?? 0,
          num: true,
        },
      ];
    case "mention":
      return [
        titleCol("Item"),
        textCol("client", "Cliente"),
        textCol("quote", "Trecho", true),
        textCol("speaker", "Quem falou"),
        {
          key: "source",
          label: "Onde",
          text: (r) => (r.source === "meeting" ? "Reunião" : "Whatsapp"),
        },
        dateCol("occurred_at", "Quando", true),
      ];
  }
}

/**
 * The panel's own figure for what the list shows, to check against: the
 * category clicked, the total, or (sums only) all categories added up.
 */
function panelFigure(
  result: PanelResult | null,
  q: Query,
  group: GroupBy,
  picked: PickedCategory | null,
  additive: boolean,
): number | null {
  const rows = result?.series[q.ref];
  if (!rows) return null;
  const num = (v: number | null | undefined) =>
    v === null || v === undefined ? null : Number(v);
  if (group === "none") return num(rows[0]?.v);
  if (picked) {
    const row = rows.find((r) => (r.k ?? "__null__") === picked.key);
    return row ? num(row.v) : additive ? 0 : null;
  }
  if (!additive) return null;
  return rows.reduce((s, r) => s + (num(r.v) ?? 0), 0);
}

export function PanelRecordsView({
  panel,
  display,
  result,
  picked,
  onClearPick,
  loader,
  loadKey,
  refresh,
  tz,
  onClose,
}: {
  panel: Panel;
  display: Display | null;
  result: PanelResult | null;
  picked: PickedCategory | null;
  onClearPick: () => void;
  loader: RecordsLoader;
  loadKey: string;
  refresh: number;
  tz: string;
  onClose: () => void;
}) {
  const spec = panel.spec;
  const queries = spec.queries;
  const [ref, setRef] = useState(
    () => (queries.find((q) => !q.hidden) ?? queries[0])?.ref ?? "A",
  );
  const q = queries.find((x) => x.ref === ref) ?? queries[0];
  const [data, setData] = useState<PanelRecords | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [shown, setShown] = useState(PAGE);
  const lastRefresh = useRef(refresh);
  const box = useRef<HTMLElement>(null);

  // "Outros": every category but the ones the chart shows.
  const selection: RecordSelection = useMemo(() => {
    if (!picked) return {};
    if (picked.key === "__other__")
      return { exclude: (display?.keys ?? []).filter((k) => k !== "__other__") };
    return { keys: [picked.key] };
  }, [picked, display]);
  const selectionKey = JSON.stringify(selection);

  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [panel.id]);

  useEffect(() => {
    let current = true;
    const fresh = refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    setLoading(true);
    setError("");
    loader(panel, ref, selection, fresh)
      .then((r) => {
        if (!current) return;
        setData(r);
        setShown(PAGE);
      })
      .catch((e) => current && setError((e as Error).message))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
    // The panel's spec (by value), the query, the category, period and filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(spec), ref, selectionKey, loadKey, refresh]);

  const def = metricDef(q);
  const unit: Unit = def?.unit ?? "number";
  const additive = def?.additive ?? true;
  const metricKey = `${q.source}.${q.metric}`;
  const yesNo = unit === "percent" ? (YES_NO[metricKey] ?? ["Sim", "Não"]) : null;
  const distinct = DISTINCT.has(metricKey);
  const group = spec.groupBy;
  const interval = result?.interval ?? "day";

  const fmt = useMemo(() => {
    const dayFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" });
    const timeFmt = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const dateOnly = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
    const dayOf = (d?: string | null) => {
      if (!d) return "";
      if (dateOnly(d)) return dayFmt.format(new Date(`${d}T12:00:00Z`));
      return new Intl.DateTimeFormat("pt-BR", { timeZone: tz }).format(new Date(d));
    };
    return {
      day: dayOf,
      time: (d?: string | null) =>
        !d ? "" : dateOnly(d) ? dayOf(d) : timeFmt.format(new Date(d)),
    };
  }, [tz]);

  const canOpen = !!data?.can_open;
  const link = (r: RecordRow): ReactNode => {
    const title = r.title || "Sem título";
    const path = r.task
      ? `/tarefas/${r.task}`
      : r.item
        ? `/radar?item=${r.item}`
        : null;
    if (!canOpen || !path) return title;
    return (
      <a
        href={appPath(path)}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          openInApp(path);
        }}
      >
        {title}
      </a>
    );
  };

  const columns: Col[] = useMemo(() => {
    if (!data) return [];
    const cols = kindColumns(data.kind, q, fmt, link);
    // The category of each record, when the panel is split and none is picked.
    if (group !== "none" && !picked)
      cols.push({
        key: "k",
        label: groupHeading[group] ?? "Categoria",
        text: (r) =>
          group === "time" && r.k
            ? bucketLabel(r.k, interval)
            : categoryLabel(group, { k: r.k, l: r.l, v: null }),
        sort: (r) => (group === "time" ? (r.k ?? "") : (r.l ?? r.k ?? "")),
      });
    // A count has 1 per record: nothing to show. Otherwise its part.
    const showValue =
      !distinct && !(additive && unit === "number" && data.rows.every((r) => Number(r.v) === 1));
    if (showValue)
      cols.push({
        key: "v",
        label: def?.label ?? "Valor",
        num: !yesNo,
        text: (r) => {
          const v = r.v === null ? null : Number(r.v);
          if (yesNo && (v === 100 || v === 0)) return yesNo[v === 100 ? 0 : 1];
          if (unit === "hours") return duration(v);
          return formatValue(v, unit, spec.decimals);
        },
        sort: (r) => (r.v === null ? -Infinity : Number(r.v)),
        render: (r) => {
          const v = r.v === null ? null : Number(r.v);
          if (yesNo && (v === 100 || v === 0))
            return (
              <span className={`dash-rec-yesno ${v === 100 ? "yes" : "no"}`}>
                {yesNo[v === 100 ? 0 : 1]}
              </span>
            );
          if (unit === "hours")
            return (
              <>
                {duration(v)}
                {q.source === "hours" && v === 0 && (
                  <small>coberto por outro cronômetro</small>
                )}
              </>
            );
          return formatValue(v, unit, spec.decimals);
        },
      });
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, q, fmt, group, picked, interval, canOpen]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = plain(search.trim());
    let list = needle
      ? data.rows.filter((r) =>
          columns.some((c) => plain(c.text(r)).includes(needle)),
        )
      : data.rows;
    if (sort) {
      const col = columns.find((c) => c.key === sort.col);
      if (col) {
        const by = col.sort ?? col.text;
        list = [...list].sort((a, b) => {
          const x = by(a);
          const y = by(b);
          const cmp =
            typeof x === "number" && typeof y === "number"
              ? x - y
              : String(x).localeCompare(String(y), "pt-BR", { numeric: true });
          return cmp * sort.dir;
        });
      }
    }
    return list;
  }, [data, columns, search, sort]);

  // The footer: what the list adds up to, and whether it is the panel's figure.
  const figure = panelFigure(result, q, group, picked, additive);
  const value = data?.value === null || data?.value === undefined ? null : Number(data.value);
  const same =
    figure !== null &&
    value !== null &&
    Math.abs(figure - value) <= Math.max(0.005, Math.abs(figure) * 1e-6);
  const total = data?.total ?? 0;
  let summary: ReactNode = null;
  if (data) {
    const what = `${count(total)} ${noun(data.kind, total)}`;
    const v = <b>{formatValue(value, unit, spec.decimals)}</b>;
    if (yesNo) {
      const yes = Math.round(((value ?? 0) * total) / 100);
      summary = (
        <>
          {count(yes)} de {what}: {yesNo[0].toLowerCase()} = {v}
        </>
      );
    } else if (distinct) summary = <>{what} distintos = {v}</>;
    else if (!additive)
      summary =
        q.source === "temperature" ? (
          <>
            Média dos {count(data.rows.reduce((s, r) => s + r.n, 0))} dias com
            nota de {what} = {v}
          </>
        ) : (
          <>
            Média de {what} = {v}
          </>
        );
    else if (unit === "number" && data.rows.every((r) => Number(r.v) === 1))
      summary = <>{what}</>;
    else
      summary = (
        <>
          Soma de {what} = {v}
        </>
      );
  }
  const formula = spec.formula?.expr ? spec.formula : null;

  function toggleSort(col: string) {
    setSort((s) =>
      !s || s.col !== col
        ? { col, dir: col === "v" || col === "d" ? -1 : 1 }
        : s.dir === 1
          ? { col, dir: -1 }
          : null,
    );
  }

  return (
    <section
      ref={box}
      className="dash-records"
      aria-label={`Registros de ${panel.title || "painel"}`}
    >
      <header className="dash-records-head">
        <div className="dash-records-title">
          <strong>Registros · {panel.title || "Sem título"}</strong>
          {picked && (
            <span className="dash-records-pick">
              {groupHeading[group] ?? "Categoria"}: {picked.label}
              <button
                type="button"
                aria-label="Mostrar todas as categorias"
                title="Mostrar todas as categorias"
                onClick={onClearPick}
              >
                <X size={12} />
              </button>
            </span>
          )}
          {!picked && group !== "none" && (
            <small className="muted">
              Clique numa barra ou categoria do painel para ver só ela.
            </small>
          )}
        </div>
        <div className="dash-records-tools">
          <label className="dash-records-search">
            <Input
              type="search"
              value={search}
              placeholder="Buscar nos registros"
              aria-label="Buscar nos registros"
              onChange={(e) => {
                setSearch(e.target.value);
                setShown(PAGE);
              }}
            />
          </label>
          <Button
            className="icon-btn"
            aria-label="Fechar os registros"
            title="Fechar os registros"
            onClick={onClose}
          >
            <X size={15} />
          </Button>
        </div>
      </header>
      {queries.length > 1 && (
        <div className="dash-records-tabs" role="tablist">
          {queries.map((x) => (
            <button
              key={x.ref}
              type="button"
              role="tab"
              aria-selected={x.ref === ref}
              className={x.ref === ref ? "active" : ""}
              onClick={() => {
                setRef(x.ref);
                setSort(null);
              }}
            >
              <b>{x.ref}</b> {queryName(x)}
              {x.hidden && <small> (só na fórmula)</small>}
            </button>
          ))}
        </div>
      )}
      <div className="dash-records-body">
        {error ? (
          <p className="dash-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" /> {error}
          </p>
        ) : !data ? (
          <Skeleton className="dash-skeleton" />
        ) : data.rows.length === 0 ? (
          <p className="dash-empty">Nenhum registro compõe este valor.</p>
        ) : (
          <div className={`dash-records-table ${loading ? "loading" : ""}`}>
            <table className="dash-table stack-mobile">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className={`${c.num ? "num" : ""} ${c.wide ? "wide" : ""}`}
                      aria-sort={
                        sort?.col === c.key
                          ? sort.dir === 1
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      <button type="button" onClick={() => toggleSort(c.key)}>
                        {c.label}
                        {sort?.col === c.key &&
                          (sort.dir === 1 ? (
                            <ArrowUp size={12} aria-hidden="true" />
                          ) : (
                            <ArrowDown size={12} aria-hidden="true" />
                          ))}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((r) => (
                  <tr key={`${r.id}|${r.k ?? ""}`}>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        data-label={c.label}
                        className={`${c.num ? "num" : ""} ${c.wide ? "wide" : ""}`}
                      >
                        {c.render ? c.render(r) : c.text(r) || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="dash-empty">Nenhum registro com “{search}”.</p>
            )}
            {rows.length > shown && (
              <Button
                className="text-btn dash-records-more"
                onClick={() => setShown((n) => n + PAGE)}
              >
                Mostrar mais {count(Math.min(PAGE, rows.length - shown))} de{" "}
                {count(rows.length - shown)}
              </Button>
            )}
          </div>
        )}
      </div>
      {data && (
        <footer className="dash-records-foot">
          <span>
            {summary}
            {search.trim() && rows.length !== data.rows.length && (
              <small> · {count(rows.length)} na busca</small>
            )}
          </span>
          {figure !== null &&
            (same ? (
              <span className="dash-records-check ok">
                <CheckCircle2 size={14} aria-hidden="true" /> Confere com o
                painel
              </span>
            ) : (
              <span className="dash-records-check off">
                <AlertCircle size={14} aria-hidden="true" /> O painel mostra{" "}
                {formatValue(figure, unit, spec.decimals)}: os dados mudaram
                desde que ele carregou. Atualize o dashboard.
              </span>
            ))}
          {formula && (
            <small className="muted dash-records-formula">
              Fórmula “{formula.label || formula.expr}” = {formula.expr}: cada
              aba mostra os registros de uma consulta.
            </small>
          )}
          {total > data.rows.length && (
            <small className="muted">
              Mostrando os {count(data.rows.length)} mais recentes de{" "}
              {count(total)}; o valor considera todos. Clique numa categoria ou
              use os filtros para ver menos.
            </small>
          )}
        </footer>
      )}
    </section>
  );
}

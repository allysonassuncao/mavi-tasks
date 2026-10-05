import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckSquare,
  Download,
  ExternalLink,
  ImageOff,
  Loader2,
  Maximize2,
  MessageSquare,
  Minus,
  Pencil,
  Plug,
  Sparkles,
  X,
} from "lucide-react";
import { PanelChart } from "./DashboardCharts";
import {
  formatValue,
  seriesColors,
  type Display,
  type PanelSpec,
} from "./dashboards";
import { Modal } from "./components";
import { imageUrls, setActionState } from "./ai";
import { priorities } from "./types";
import type { FormPreset } from "./forms";
import { CanvasCard } from "./MaviCanvas";
import { QuestionCard } from "./MaviQuestions";
import { TaskCard } from "./MaviTaskCard";
import { SearchCard, TutorialCard } from "./MaviSearchCard";
import { runMcpAction } from "./mavi-mcp";
import { CampaignAlertCard, StateChip } from "./MaviCampaignAlertCard";
import type {
  ActionArtifact,
  ActionProposal,
  AiArtifact,
  CanvasArtifact,
  ChartVisual,
  ImageArtifact,
  KpisVisual,
  TableVisual,
  TimelineVisual,
  Visual,
  VisualUnit,
} from "./mavi-artifacts";
import "./mavi-artifacts.css";

/**
 * O que a MAVI mostra além do texto, no módulo MAVI: a visualização
 * (desenhada com os gráficos dos Dashboards), a imagem gerada e o card da
 * ação proposta, que só acontece quando a pessoa confirma.
 */

export type ArtifactHost = {
  company: string;
  /** A conversa (null enquanto a primeira resposta não foi salva). */
  conversation: string | null;
  /** Conversa compartilhada: só leitura. */
  readOnly: boolean;
  /** A resposta ainda está chegando. */
  streaming: boolean;
  onNewTask: (preset: FormPreset) => void;
  onComment: (task: string, text: string) => Promise<unknown>;
  taskHref: (task: string) => string;
  /** Escreve na caixa de mensagem (ex.: pedir um ajuste da imagem). */
  onDraft: (text: string) => void;
  /** Abre o documento, a apresentação ou a planilha no canvas. */
  onOpenCanvas: (artifact: CanvasArtifact) => void;
  /** Responde às perguntas da MAVI (vira a próxima mensagem). */
  onReply: (text: string) => void;
  /** A conversa já seguiu depois desta resposta. */
  answered?: boolean;
  /**
   * A pessoa confirmou a ação de uma conexão (MCP): vira a próxima mensagem,
   * a ação roda e a MAVI continua dali. false: não deu para enviar.
   */
  onConfirmMcp?: (artifact: ActionArtifact) => Promise<boolean>;
  notify: (message: string) => void;
};

export function ArtifactView({
  artifact,
  host,
}: {
  artifact: AiArtifact;
  host: ArtifactHost;
}) {
  if (artifact.type === "visual")
    return <VisualCard visual={artifact.visual} refName={artifact.ref} />;
  if (artifact.type === "image")
    return <ImageCard image={artifact} host={host} />;
  if (artifact.type === "canvas")
    return <CanvasCard artifact={artifact} onOpen={() => host.onOpenCanvas(artifact)} />;
  if (artifact.type === "question")
    return (
      <QuestionCard
        artifact={artifact}
        answered={!!host.answered}
        disabled={host.readOnly || host.streaming}
        onReply={host.onReply}
      />
    );
  if (artifact.type === "task")
    return <TaskCard artifact={artifact} readOnly={host.readOnly} notify={host.notify} />;
  if (artifact.type === "search")
    return <SearchCard artifact={artifact} />;
  if (artifact.type === "tutorial")
    return <TutorialCard artifact={artifact} />;
  if (artifact.action.kind === "mcp_call")
    return <McpActionCard artifact={artifact} host={host} />;
  if (artifact.action.kind === "campaign_alert")
    return <CampaignAlertCard artifact={artifact} host={host} />;
  return <ActionCard artifact={artifact} host={host} />;
}

// ------------------------------------------------------------ visualizações
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Os dados da visualização em CSV (ponto e vírgula, como o Excel em português). */
export function visualCsv(visual: Visual): string {
  const rows: unknown[][] =
    visual.kind === "chart"
      ? [
          ["", ...visual.series.map((s) => s.name)],
          ...visual.categories.map((c, i) => [
            c,
            ...visual.series.map((s) => s.values[i]),
          ]),
        ]
      : visual.kind === "table"
        ? [visual.columns.map((c) => c.label), ...visual.rows]
        : visual.kind === "kpis"
          ? [
              ["Indicador", "Valor", "Variação (%)"],
              ...visual.items.map((i) => [i.label, i.value, i.delta ?? ""]),
            ]
          : [
              ["Data", "O quê", "Detalhe"],
              ...visual.items.map((i) => [i.date, i.title, i.detail ?? ""]),
            ];
  return rows
    .map((r) =>
      r
        .map((v) =>
          typeof v === "number" ? csvCell(String(v).replace(".", ",")) : csvCell(v),
        )
        .join(";"),
    )
    .join("\n");
}
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileName = (title: string, ext: string) =>
  `${
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "mavi"
  }.${ext}`;

function VisualCard({ visual, refName }: { visual: Visual; refName: string }) {
  const [big, setBig] = useState(false);
  const title = "title" in visual ? (visual.title ?? "") : "";
  const subtitle = "subtitle" in visual ? visual.subtitle : undefined;
  const body = (large: boolean) =>
    visual.kind === "chart" ? (
      <ChartBody visual={visual} large={large} />
    ) : visual.kind === "table" ? (
      <TableBody visual={visual} />
    ) : visual.kind === "kpis" ? (
      <KpisBody visual={visual} />
    ) : (
      <TimelineBody visual={visual} />
    );
  const tools = (
    <span className="mavi-card-tools">
      <button
        type="button"
        className="icon-btn"
        title="Baixar os dados (CSV)"
        aria-label={`Baixar os dados de ${title || refName}`}
        onClick={() =>
          download(
            fileName(title || refName, "csv"),
            new Blob([`﻿${visualCsv(visual)}`], {
              type: "text/csv;charset=utf-8",
            }),
          )
        }
      >
        <Download size={15} />
      </button>
      {visual.kind !== "kpis" && (
        <button
          type="button"
          className="icon-btn"
          title="Ampliar"
          aria-label={`Ampliar ${title || refName}`}
          onClick={() => setBig(true)}
        >
          <Maximize2 size={15} />
        </button>
      )}
    </span>
  );
  return (
    <figure className={`mavi-card mavi-visual ${visual.kind}`}>
      {(title || visual.kind !== "kpis") && (
        <figcaption className="mavi-card-head">
          <span>
            <strong>{title}</strong>
            {subtitle && <small>{subtitle}</small>}
          </span>
          {tools}
        </figcaption>
      )}
      {body(false)}
      {big && (
        <Modal title={title || "Visualização"} onClose={() => setBig(false)}>
          <div className="mavi-visual-big">{body(true)}</div>
        </Modal>
      )}
    </figure>
  );
}

function ChartBody({ visual, large }: { visual: ChartVisual; large: boolean }) {
  const display = useMemo<Display>(
    () => ({
      keys: visual.categories.map((_, i) => String(i)),
      labels: visual.categories,
      series: visual.series.map((s, i) => ({
        id: String(i),
        name: s.name,
        color: seriesColors[i % seriesColors.length],
        unit: visual.unit,
        values: s.values,
      })),
      unit: visual.unit,
      interval: "day",
    }),
    [visual],
  );
  const spec = useMemo<PanelSpec>(
    () => ({
      viz: visual.chart,
      // Linha e área: o gráfico de série (os rótulos são os do eixo).
      groupBy:
        visual.chart === "line" || visual.chart === "area" ? "time" : "client",
      queries: [],
      unit: visual.unit,
    }),
    [visual],
  );
  const tall =
    visual.chart === "hbar"
      ? Math.min(560, Math.max(180, visual.categories.length * 30 + 40))
      : 260;
  return (
    <div
      className="mavi-chart dash-chart-wrap"
      style={{ height: large ? Math.max(tall, 460) : tall }}
    >
      <PanelChart display={display} spec={spec} />
    </div>
  );
}

/** Um número na unidade dele (dinheiro sempre com os centavos). */
const shown = (v: number, unit: VisualUnit) =>
  unit === "money"
    ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : formatValue(v, unit);
const cellText = (v: string | number | null, unit?: VisualUnit | "text") =>
  v === null
    ? "—"
    : typeof v === "number"
      ? shown(v, unit && unit !== "text" ? unit : "number")
      : v;

function TableBody({ visual }: { visual: TableVisual }) {
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return visual.rows;
    const dir = sort.desc ? -1 : 1;
    return [...visual.rows].sort((a, b) => {
      const x = a[sort.col],
        y = b[sort.col];
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return (
        String(x).localeCompare(String(y), "pt-BR", { numeric: true }) * dir
      );
    });
  }, [visual.rows, sort]);
  return (
    <div className="mavi-table-wrap">
      <table className="mavi-table">
        <thead>
          <tr>
            {visual.columns.map((c, i) => {
              const numeric = !!c.unit && c.unit !== "text";
              const active = sort?.col === i;
              return (
                <th
                  key={i}
                  className={numeric ? "num" : ""}
                  aria-sort={
                    active ? (sort!.desc ? "descending" : "ascending") : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort((s) =>
                        s?.col === i
                          ? s.desc
                            ? null
                            : { col: i, desc: true }
                          : { col: i, desc: false },
                      )
                    }
                  >
                    {c.label}
                    {active &&
                      (sort!.desc ? (
                        <ArrowDown size={12} aria-hidden="true" />
                      ) : (
                        <ArrowUp size={12} aria-hidden="true" />
                      ))}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {visual.columns.map((c, k) => (
                <td
                  key={k}
                  className={c.unit && c.unit !== "text" ? "num" : ""}
                >
                  {cellText(r[k], c.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KpisBody({ visual }: { visual: KpisVisual }) {
  return (
    <div className="mavi-kpis">
      {visual.items.map((k, i) => {
        const up = (k.delta ?? 0) > 0;
        const flat = !k.delta;
        const good = flat ? null : up === (k.good !== "down");
        return (
          <div key={i} className="mavi-kpi">
            <span>{k.label}</span>
            <strong>
              {typeof k.value === "number"
                ? shown(k.value, k.unit ?? "number")
                : k.value}
            </strong>
            {k.delta !== undefined && (
              <small
                className={`mavi-kpi-delta ${good === null ? "flat" : good ? "good" : "bad"}`}
              >
                {flat ? (
                  <Minus size={12} aria-hidden="true" />
                ) : up ? (
                  <ArrowUpRight size={12} aria-hidden="true" />
                ) : (
                  <ArrowDownRight size={12} aria-hidden="true" />
                )}
                {`${up ? "+" : ""}${formatValue(k.delta, "percent")}`}
              </small>
            )}
            {k.note && <small className="mavi-kpi-note">{k.note}</small>}
          </div>
        );
      })}
    </div>
  );
}

function TimelineBody({ visual }: { visual: TimelineVisual }) {
  const date = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d)
      ? new Date(`${d}T12:00:00`).toLocaleDateString("pt-BR")
      : d;
  return (
    <ol className="mavi-timeline">
      {visual.items.map((t, i) => (
        <li key={i}>
          <time>{date(t.date)}</time>
          <div>
            <strong>{t.title}</strong>
            {t.detail && <p>{t.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------ imagens
/** O link (ou null) de uma imagem da conversa, fora dos componentes (exportar). */
export async function imageLink(company: string, image: ImageArtifact) {
  if (image.url) return image.url;
  const cached = imageCache.get(image.path);
  if (cached && Date.now() - cached.at < 50 * 60_000) return cached.url;
  const urls = await imageUrls(company, [image.path]);
  const u = urls[image.path];
  if (u) imageCache.set(image.path, { url: u, at: Date.now() });
  return u ?? null;
}
/** Links assinados valem uma hora: guardados por 50 minutos. */
const imageCache = new Map<string, { url: string; at: number }>();
const pending = new Map<string, Promise<Record<string, string>>>();
export function useImageUrl(company: string, image: ImageArtifact) {
  const cached = imageCache.get(image.path);
  const fresh = cached && Date.now() - cached.at < 50 * 60_000;
  const [url, setUrl] = useState(image.url ?? (fresh ? cached!.url : ""));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (image.url) {
      imageCache.set(image.path, { url: image.url, at: Date.now() });
      return;
    }
    if (url) return;
    let alive = true;
    const key = `${company}|${image.path}`;
    const ask =
      pending.get(key) ??
      imageUrls(company, [image.path]).finally(() => pending.delete(key));
    pending.set(key, ask);
    ask
      .then((urls) => {
        if (!alive) return;
        const u = urls[image.path];
        if (u) {
          imageCache.set(image.path, { url: u, at: Date.now() });
          setUrl(u);
        } else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [company, image.path, image.url, url]);
  return { url, failed };
}

function ImageCard({ image, host }: { image: ImageArtifact; host: ArtifactHost }) {
  const { url, failed } = useImageUrl(host.company, image);
  const [big, setBig] = useState(false);
  const [saving, setSaving] = useState(false);
  // A arte por código tem o tamanho exato (ex.: 1080 × 1350).
  const ratio =
    image.width && image.height
      ? `${image.width} / ${image.height}`
      : image.size === "portrait"
        ? "2 / 3"
        : image.size === "landscape"
          ? "3 / 2"
          : "1 / 1";
  async function save() {
    if (!url) return;
    setSaving(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw Error();
      download(fileName(image.prompt.slice(0, 50) || image.ref, "png"), await res.blob());
    } catch {
      host.notify("Não foi possível baixar a imagem.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <figure className="mavi-card mavi-image">
      <div className="mavi-image-frame" style={{ aspectRatio: ratio }}>
        {url ? (
          <button
            type="button"
            className="mavi-image-open"
            onClick={() => setBig(true)}
            aria-label="Ver a imagem em tamanho grande"
          >
            <img src={url} alt={image.prompt} loading="lazy" />
          </button>
        ) : failed ? (
          <span className="mavi-image-empty">
            <ImageOff size={20} aria-hidden="true" /> Imagem indisponível
          </span>
        ) : (
          <span className="mavi-image-empty">
            <Loader2 size={18} className="spin" aria-hidden="true" />
          </span>
        )}
      </div>
      <figcaption className="mavi-image-bar">
        <small title={image.prompt}>
          {image.ref}
          {image.edited_from ? ` · ${image.art ? "ajuste" : "edição"} de ${image.edited_from}` : ""}
          {image.art && image.width ? ` · ${image.width}×${image.height}` : ""}
          {image.model ? ` · ${image.model}` : ""}
        </small>
        <span className="mavi-card-tools">
          {!host.readOnly && (
            <button
              type="button"
              className="icon-btn"
              title="Pedir um ajuste"
              aria-label={`Pedir um ajuste na imagem ${image.ref}`}
              onClick={() => host.onDraft(`Ajuste a imagem ${image.ref}: `)}
            >
              <Pencil size={15} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Baixar"
            aria-label={`Baixar a imagem ${image.ref}`}
            disabled={!url || saving}
            onClick={() => void save()}
          >
            {saving ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
          </button>
        </span>
      </figcaption>
      {big && url && (
        <Modal title={`Imagem ${image.ref}`} onClose={() => setBig(false)}>
          <div className="mavi-image-big">
            <img src={url} alt={image.prompt} />
            <p>{image.prompt}</p>
          </div>
        </Modal>
      )}
    </figure>
  );
}

// ------------------------------------------------------------ ações
function ActionCard({ artifact, host }: { artifact: ActionArtifact; host: ArtifactHost }) {
  const [state, setState] = useState(artifact.state);
  const [result, setResult] = useState(artifact.result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // "Criar e continuar" no formulário: só a primeira tarefa responde à proposta.
  const decided = useRef(false);
  const a = artifact.action as Exclude<ActionProposal, { kind: "mcp_call" | "campaign_alert" }>;
  const waiting = host.streaming || !host.conversation;
  const decide = async (
    next: "confirmed" | "cancelled",
    data: Record<string, unknown> = {},
  ) => {
    if (decided.current) return;
    decided.current = true;
    try {
      await setActionState(host.conversation!, artifact.id, next, data);
    } catch (e) {
      decided.current = false;
      throw e;
    }
    setState(next);
    setResult(data as ActionArtifact["result"]);
  };
  async function confirm() {
    if (!host.conversation) return;
    setError("");
    if (a.kind === "create_task") {
      // A tarefa nasce no formulário de sempre (templates, prazos, copiloto).
      host.onNewTask({
        contract: a.contract_id,
        project: a.project_id,
        title: a.title,
        description: a.description,
        due: a.due,
        assignee: a.assignee_id,
        priority: a.priority,
        onCreated: (task) =>
          void decide("confirmed", { task_id: task }).catch((e) =>
            setError((e as Error).message),
          ),
      });
      return;
    }
    setBusy(true);
    try {
      const comment = (await host.onComment(a.task_id, a.text)) as
        | { id?: string }
        | null;
      await decide("confirmed", comment?.id ? { comment_id: String(comment.id) } : {});
      host.notify("Comentário enviado.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!host.conversation) return;
    setBusy(true);
    setError("");
    try {
      await decide("cancelled");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const fields: [string, ReactNode][] =
    a.kind === "create_task"
      ? [
          ["Cliente", a.client_name],
          ["Produto", a.contract_name],
          ...(a.project_name ? [["Projeto", a.project_name] as [string, ReactNode]] : []),
          ...(a.assignee_name
            ? [["Responsável", a.assignee_name] as [string, ReactNode]]
            : []),
          ...(a.due
            ? [
                [
                  "Prazo",
                  new Date(`${a.due}T12:00:00`).toLocaleDateString("pt-BR"),
                ] as [string, ReactNode],
              ]
            : []),
          ...(a.priority && a.priority !== "normal"
            ? [["Prioridade", priorities[a.priority]] as [string, ReactNode]]
            : []),
        ]
      : [["Tarefa", a.task_title]];
  const task =
    a.kind === "comment_task" ? a.task_id : (result?.task_id ?? null);
  return (
    <section
      className={`mavi-card mavi-action ${state}`}
      aria-label={a.kind === "create_task" ? "Tarefa proposta pela MAVI" : "Comentário proposto pela MAVI"}
    >
      <header className="mavi-action-head">
        <span className="mavi-action-icon" aria-hidden="true">
          {a.kind === "create_task" ? <CheckSquare size={16} /> : <MessageSquare size={16} />}
        </span>
        <span>
          <small>
            <Sparkles size={11} aria-hidden="true" />{" "}
            {a.kind === "create_task" ? "Nova tarefa" : "Comentário na tarefa"} · proposta da MAVI
          </small>
          <strong>{a.kind === "create_task" ? a.title : a.task_title}</strong>
        </span>
        <StateChip state={state} />
      </header>
      <dl className="mavi-action-fields">
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {(a.kind === "comment_task" || a.description) && (
        <p className="mavi-action-text">
          {a.kind === "comment_task" ? a.text : a.description}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer className="mavi-action-foot">
        {state === "pending" ? (
          host.readOnly ? (
            <small>Só quem começou a conversa decide.</small>
          ) : (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={waiting || busy}
                onClick={() => void confirm()}
              >
                {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                {a.kind === "create_task" ? "Revisar e criar" : "Comentar"}
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={waiting || busy}
                onClick={() => void cancel()}
              >
                <X size={15} /> Cancelar
              </button>
              {waiting && <small>Aguardando a MAVI terminar…</small>}
            </>
          )
        ) : (
          state === "confirmed" &&
          task && (
            <a className="mavi-action-link" href={host.taskHref(task)}>
              <ExternalLink size={14} /> Abrir a tarefa
            </a>
          )
        )}
      </footer>
    </section>
  );
}

/** Um valor dos argumentos, em texto curto. */
const argText = (v: unknown) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return (t ?? "").length > 400 ? `${t.slice(0, 400)}…` : t;
};

/**
 * A ação numa conexão (MCP): o que a MAVI vai mandar ao serviço, com os
 * argumentos à vista. Só roda quando a pessoa confirma (uma vez só, no
 * servidor, com o que foi gravado); o que o serviço respondeu fica no card.
 */
function McpActionCard({ artifact, host }: { artifact: ActionArtifact; host: ArtifactHost }) {
  const a = artifact.action as Extract<ActionProposal, { kind: "mcp_call" }>;
  const [state, setState] = useState(artifact.state);
  const [result, setResult] = useState(artifact.result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const waiting = host.streaming || !host.conversation;
  const running = busy || (state === "confirmed" && !!result?.running);
  const args = Object.entries(a.arguments ?? {});
  // Sem os recados do serviço para a IA (as respostas antigas guardaram tudo).
  const said = (result?.text ?? "")
    .replace(/<(system[_-]reminder|system|instructions?)>[\s\S]*?<\/\1>/gi, "")
    .trim();
  async function confirm() {
    if (!host.conversation) return;
    setBusy(true);
    setError("");
    try {
      // No módulo: a confirmação vira a próxima mensagem e a MAVI continua.
      if (host.onConfirmMcp) {
        setState("confirmed");
        setResult({ running: true });
        if (!(await host.onConfirmMcp(artifact))) {
          setState("pending");
          setResult(undefined);
          setError("Não deu para enviar a confirmação. Tente de novo.");
        } else setResult({ text: "" });
        return;
      }
      const r = await runMcpAction(host.conversation, artifact.id);
      setState(r.ok ? "confirmed" : "failed");
      setResult(r.ok ? { text: r.text } : { error: r.error });
      if (r.ok) host.notify(`${a.server_name}: pronto.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!host.conversation) return;
    setBusy(true);
    setError("");
    try {
      await setActionState(host.conversation, artifact.id, "cancelled");
      setState("cancelled");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={`mavi-card mavi-action ${state}`} aria-label={`Ação em ${a.server_name} proposta pela MAVI`}>
      <header className="mavi-action-head">
        <span className="mavi-action-icon" aria-hidden="true">
          <Plug size={16} />
        </span>
        <span>
          <small>
            <Sparkles size={11} aria-hidden="true" /> Ação em {a.server_name} · proposta da MAVI
          </small>
          <strong>{a.tool_title || a.tool}</strong>
        </span>
        <StateChip state={state} />
      </header>
      {args.length ? (
        <dl className="mavi-action-fields">
          {args.slice(0, 12).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{argText(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mavi-action-text">Sem informações adicionais.</p>
      )}
      {args.length > 12 && <p className="mavi-action-text">E mais {args.length - 12} campos.</p>}
      {state === "confirmed" && !running && (
        <p className="mavi-action-done">
          <Check size={13} aria-hidden="true" /> Enviado para {a.server_name}. A MAVI segue a partir do resultado.
        </p>
      )}
      {said && !running && (
        <details className="mavi-action-details">
          <summary>Ver a resposta de {a.server_name}</summary>
          <pre className="mavi-action-result">{said}</pre>
        </details>
      )}
      {(error || result?.error) && (
        <p className="form-error" role="alert">
          {error || result?.error}
        </p>
      )}
      <footer className="mavi-action-foot">
        {state === "pending" ? (
          host.readOnly ? (
            <small>Só quem começou a conversa decide.</small>
          ) : (
            <>
              <button type="button" className="btn primary" disabled={waiting || busy} onClick={() => void confirm()}>
                {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                Confirmar e executar
              </button>
              <button type="button" className="btn secondary" disabled={waiting || busy} onClick={() => void cancel()}>
                <X size={15} /> Cancelar
              </button>
              {waiting && <small>Aguardando a MAVI terminar…</small>}
            </>
          )
        ) : running ? (
          <small>
            <Loader2 size={13} className="spin" aria-hidden="true" />{" "}
            {busy || host.streaming ? `Enviando para ${a.server_name}…` : "Em andamento (ou interrompida). Confira no serviço."}
          </small>
        ) : null}
      </footer>
    </section>
  );
}

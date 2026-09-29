/**
 * MAVI · o que ela mostra além do texto (migração 20261212090000_mavi_powers):
 * visualizações, imagens e ações propostas.
 *
 * A MAVI não escreve código: ela descreve a visualização neste formato
 * fechado e o app desenha com os gráficos dos Dashboards. O mesmo saneamento
 * vale no servidor (antes de mostrar e de gravar) e na tela (antes de
 * desenhar): só entram os campos e valores daqui; texto é sempre texto.
 * Uma ação é só uma proposta: nada muda até a pessoa confirmar.
 */

export type Power = "visuals" | "images" | "actions";
export const POWERS: { id: Power; label: string; description: string }[] = [
  {
    id: "visuals",
    label: "Visualizações",
    description:
      "Gráficos, tabelas, indicadores e linhas do tempo desenhados na conversa, com os dados que a MAVI encontrou.",
  },
  {
    id: "images",
    label: "Imagens",
    description:
      "Gerar e editar imagens pelo modelo escolhido em Quem usa qual modelo › Geração e edição de imagens.",
  },
  {
    id: "actions",
    label: "Ações com confirmação",
    description:
      "A MAVI propõe criar uma tarefa ou comentar numa tarefa. Nada muda até a pessoa confirmar no card.",
  },
];

export type VisualUnit = "number" | "money" | "percent" | "hours" | "days";
export const VISUAL_UNITS: VisualUnit[] = [
  "number",
  "money",
  "percent",
  "hours",
  "days",
];
export type ChartKind = "bar" | "hbar" | "line" | "area" | "donut";
export const CHART_KINDS: ChartKind[] = ["bar", "hbar", "line", "area", "donut"];

export type ChartVisual = {
  kind: "chart";
  chart: ChartKind;
  title: string;
  subtitle?: string;
  unit: VisualUnit;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
};
export type TableColumn = { label: string; unit?: VisualUnit | "text" };
export type TableVisual = {
  kind: "table";
  title: string;
  subtitle?: string;
  columns: TableColumn[];
  rows: (string | number | null)[][];
};
export type KpiItem = {
  label: string;
  value: number | string;
  unit?: VisualUnit;
  /** Variação em relação ao período anterior (em %). */
  delta?: number;
  /** Se subir é bom (padrão) ou ruim (custo, atraso). */
  good?: "up" | "down";
  note?: string;
};
export type KpisVisual = { kind: "kpis"; title?: string; items: KpiItem[] };
export type TimelineVisual = {
  kind: "timeline";
  title: string;
  items: { date: string; title: string; detail?: string }[];
};
export type Visual = ChartVisual | TableVisual | KpisVisual | TimelineVisual;

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type ActionProposal =
  | {
      kind: "create_task";
      title: string;
      description?: string;
      client_id: string;
      client_name: string;
      contract_id: string;
      contract_name: string;
      project_id?: string;
      project_name?: string;
      assignee_id?: string;
      assignee_name?: string;
      due?: string;
      priority?: Priority;
    }
  | {
      kind: "comment_task";
      task_id: string;
      task_title: string;
      text: string;
    };
export type ActionState = "pending" | "confirmed" | "cancelled" | "failed";

type Base = {
  /** Único (a ação é decidida por ele). */
  id: string;
  /** Como a resposta se refere a ele: [[V1]], [[I1]], [[A1]]. */
  ref: string;
};
export type VisualArtifact = Base & { type: "visual"; visual: Visual };
export type ImageArtifact = Base & {
  type: "image";
  /** No GCS: ai-images/<empresa>/<uuid>.png. */
  path: string;
  prompt: string;
  size: ImageSize;
  model?: string;
  /** A imagem de origem, quando é uma edição (ref). */
  edited_from?: string;
  /** Link assinado, só durante a resposta (não é gravado). */
  url?: string;
};
export type ActionArtifact = Base & {
  type: "action";
  action: ActionProposal;
  state: ActionState;
  result?: { task_id?: string; comment_id?: string; error?: string };
  decided_at?: string;
};
export type AiArtifact = VisualArtifact | ImageArtifact | ActionArtifact;

export type ImageSize = "square" | "portrait" | "landscape";
export const IMAGE_SIZES: Record<ImageSize, string> = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
};

/** Uma linha só com [[V1]]: o lugar do anexo na resposta. */
export const ARTIFACT_LINE = /^\s*\[\[([VIA]\d{1,2})\]\]\s*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{4,64}$/;
const REF = /^[VIA]\d{1,2}$/;

const text = (v: unknown, max: number) =>
  typeof v === "string"
    ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max)
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : "";
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n : null;
};
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const list = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) ? v.slice(0, max) : [];
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T) =>
  options.includes(v as T) ? (v as T) : fallback;
const optional = (v: string) => (v ? v : undefined);

/** Uma visualização no formato fechado (null quando não dá para desenhar). */
export function sanitizeVisual(raw: unknown): Visual | null {
  const v = obj(raw);
  if (!v) return null;
  const title = text(v.title, 120);
  const subtitle = optional(text(v.subtitle, 200));
  if (v.kind === "chart") {
    const categories = list(v.categories, 60)
      .map((c) => text(c, 60) || "—");
    if (!categories.length) return null;
    const series = list(v.series, 8)
      .map((s, i) => {
        const o = obj(s);
        return o
          ? {
              name: text(o.name, 60) || `Série ${i + 1}`,
              values: categories.map((_, k) =>
                num(Array.isArray(o.values) ? o.values[k] : null),
              ),
            }
          : null;
      })
      .filter((s): s is ChartVisual["series"][number] => !!s)
      .filter((s) => s.values.some((x) => x !== null));
    if (!series.length) return null;
    const chart = pick(v.chart, CHART_KINDS, "bar");
    return {
      kind: "chart",
      chart,
      title: title || "Gráfico",
      ...(subtitle ? { subtitle } : {}),
      unit: pick(v.unit, VISUAL_UNITS, "number"),
      categories,
      // A rosca mostra uma série só.
      series: chart === "donut" ? series.slice(0, 1) : series,
    };
  }
  if (v.kind === "table") {
    const columns = list(v.columns, 12)
      .map((c) => {
        const o = obj(c);
        const label = o ? text(o.label, 60) : text(c, 60);
        if (!label) return null;
        const unit = o?.unit;
        return {
          label,
          ...(unit === "text" || VISUAL_UNITS.includes(unit as VisualUnit)
            ? { unit: unit as TableColumn["unit"] }
            : {}),
        };
      })
      .filter((c): c is TableColumn => !!c);
    if (!columns.length) return null;
    const rows = list(v.rows, 200)
      .map((r) =>
        Array.isArray(r)
          ? columns.map((c, k) => {
              const cell = r[k];
              if (cell === null || cell === undefined || cell === "") return null;
              if (c.unit && c.unit !== "text") return num(cell) ?? text(cell, 200);
              return typeof cell === "number" && Number.isFinite(cell)
                ? cell
                : text(cell, 200);
            })
          : null,
      )
      .filter((r): r is (string | number | null)[] => !!r);
    if (!rows.length) return null;
    return {
      kind: "table",
      title: title || "Tabela",
      ...(subtitle ? { subtitle } : {}),
      columns,
      rows,
    };
  }
  if (v.kind === "kpis") {
    const items = list(v.items, 8)
      .map((i) => {
        const o = obj(i);
        if (!o) return null;
        const label = text(o.label, 60);
        const n = num(o.value);
        const value = n ?? text(o.value, 40);
        if (!label || value === "") return null;
        const delta = num(o.delta);
        const note = text(o.note, 120);
        const item: KpiItem = { label, value };
        if (n !== null && VISUAL_UNITS.includes(o.unit as VisualUnit))
          item.unit = o.unit as VisualUnit;
        if (delta !== null) item.delta = Math.round(delta * 10) / 10;
        if (o.good === "down") item.good = "down";
        if (note) item.note = note;
        return item;
      })
      .filter((i): i is KpiItem => !!i);
    if (!items.length) return null;
    return { kind: "kpis", ...(title ? { title } : {}), items };
  }
  if (v.kind === "timeline") {
    const items = list(v.items, 40)
      .map((i) => {
        const o = obj(i);
        if (!o) return null;
        const t = text(o.title, 140);
        const date = text(o.date, 40);
        if (!t || !date) return null;
        const detail = text(o.detail, 300);
        return { date, title: t, ...(detail ? { detail } : {}) };
      })
      .filter((i): i is TimelineVisual["items"][number] => !!i);
    if (!items.length) return null;
    return { kind: "timeline", title: title || "Linha do tempo", items };
  }
  return null;
}

function sanitizeAction(raw: unknown): ActionProposal | null {
  const a = obj(raw);
  if (!a) return null;
  if (a.kind === "create_task") {
    const title = text(a.title, 200);
    const client_id = text(a.client_id, 40);
    const contract_id = text(a.contract_id, 40);
    if (title.length < 2 || !UUID.test(client_id) || !UUID.test(contract_id))
      return null;
    const project_id = text(a.project_id, 40);
    const assignee_id = text(a.assignee_id, 40);
    const due = text(a.due, 10);
    const description = text(a.description, 4000);
    return {
      kind: "create_task",
      title,
      client_id,
      client_name: text(a.client_name, 160),
      contract_id,
      contract_name: text(a.contract_name, 160),
      ...(description ? { description } : {}),
      ...(UUID.test(project_id)
        ? { project_id, project_name: text(a.project_name, 160) }
        : {}),
      ...(UUID.test(assignee_id)
        ? { assignee_id, assignee_name: text(a.assignee_name, 160) }
        : {}),
      ...(DATE.test(due) ? { due } : {}),
      ...(PRIORITIES.includes(a.priority as Priority)
        ? { priority: a.priority as Priority }
        : {}),
    };
  }
  if (a.kind === "comment_task") {
    const task_id = text(a.task_id, 40);
    const body = text(a.text, 4000);
    if (!UUID.test(task_id) || body.length < 2) return null;
    return {
      kind: "comment_task",
      task_id,
      task_title: text(a.task_title, 200),
      text: body,
    };
  }
  return null;
}

/** Um anexo gravado ou recebido, pronto para desenhar (null: descarta). */
export function sanitizeArtifact(raw: unknown): AiArtifact | null {
  const a = obj(raw);
  if (!a) return null;
  const id = text(a.id, 64);
  const ref = text(a.ref, 4);
  if (!ID.test(id) || !REF.test(ref)) return null;
  if (a.type === "visual") {
    const visual = sanitizeVisual(a.visual);
    return visual ? { id, ref, type: "visual", visual } : null;
  }
  if (a.type === "image") {
    const path = text(a.path, 200);
    if (!/^ai-images\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|webp|jpg)$/i.test(path))
      return null;
    const url = text(a.url, 4000);
    const edited = text(a.edited_from, 4);
    const model = text(a.model, 80);
    return {
      id,
      ref,
      type: "image",
      path,
      prompt: text(a.prompt, 2000),
      size: pick(a.size, ["square", "portrait", "landscape"] as const, "square"),
      ...(model ? { model } : {}),
      ...(REF.test(edited) ? { edited_from: edited } : {}),
      ...(/^https:\/\//.test(url) ? { url } : {}),
    };
  }
  if (a.type === "action") {
    const action = sanitizeAction(a.action);
    if (!action) return null;
    const r = obj(a.result);
    const result = r
      ? {
          ...(UUID.test(text(r.task_id, 40)) ? { task_id: text(r.task_id, 40) } : {}),
          ...(text(r.comment_id, 40) ? { comment_id: text(r.comment_id, 40) } : {}),
          ...(text(r.error, 300) ? { error: text(r.error, 300) } : {}),
        }
      : undefined;
    const decided = text(a.decided_at, 40);
    return {
      id,
      ref,
      type: "action",
      action,
      state: pick(
        a.state,
        ["pending", "confirmed", "cancelled", "failed"] as const,
        "pending",
      ),
      ...(result && Object.keys(result).length ? { result } : {}),
      ...(decided ? { decided_at: decided } : {}),
    };
  }
  return null;
}

export function sanitizeArtifacts(raw: unknown): AiArtifact[] {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 12)
    .map(sanitizeArtifact)
    .filter((a): a is AiArtifact => !!a);
}

/** Para a resposta falar do anexo e para a conversa antiga. */
export function artifactSummary(a: AiArtifact): string {
  if (a.type === "visual") {
    const names = {
      chart: "gráfico",
      table: "tabela",
      kpis: "indicadores",
      timeline: "linha do tempo",
    };
    const v = a.visual;
    return `${names[v.kind]}${"title" in v && v.title ? ` “${v.title}”` : ""}`;
  }
  if (a.type === "image")
    return `imagem${a.edited_from ? ` (edição de ${a.edited_from})` : ""}: ${a.prompt.slice(0, 120)}`;
  const state = {
    pending: "aguardando a confirmação da pessoa",
    confirmed: "confirmada pela pessoa",
    cancelled: "cancelada pela pessoa",
    failed: "falhou",
  }[a.state];
  const what =
    a.action.kind === "create_task"
      ? `criar a tarefa “${a.action.title}”`
      : `comentar na tarefa “${a.action.task_title}”`;
  return `ação: ${what} — ${state}`;
}

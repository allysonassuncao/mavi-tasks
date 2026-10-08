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

// Com .js: este arquivo também roda no servidor (api/), que não completa a extensão.
import { ruleFromInput, type CampaignAlertRule } from "./campaign-alerts.js";
import { sanitizeLook, sanitizeTokens, type IdentityScope, type IdentityTokens, type Look } from "./visual-identity.js";
import { DESIGN_FORMAT_KEYS, cleanDesignHtml, countPages, type DesignFormat } from "./mavi-design.js";

export type Power =
  | "visuals"
  | "images"
  | "actions"
  | "skills"
  | "canvas"
  | "web"
  | "mcp"
  | "scrape"
  | "attachments";
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
      "Artes com a marca do cliente (posts, cards, banners: montadas como página e conferidas pela MAVI antes de mostrar, com os logos, fontes e cores de Drive › cliente › Marca) e fotos ou ilustrações pelo modelo de Quem usa qual modelo › Geração e edição de imagens.",
  },
  {
    id: "actions",
    label: "Ações com confirmação",
    description:
      "A MAVI propõe criar uma tarefa ou comentar numa tarefa. Nada muda até a pessoa confirmar no card.",
  },
  {
    id: "canvas",
    label: "Documentos, apresentações e planilhas",
    description:
      "A MAVI escreve documentos, monta apresentações e planilhas num canvas ao lado da conversa, que baixam em Word, PowerPoint, Excel ou PDF.",
  },
  {
    id: "attachments",
    label: "Anexos na conversa",
    description:
      "No módulo MAVI, a pessoa anexa documentos (PDF, Word, PowerPoint, Excel, texto), imagens, áudios e vídeos curtos. A MAVI lê uma vez (descreve imagens, transcreve áudio e vídeo), guarda em trechos vetorizados só daquela conversa e usa como contexto, citando o arquivo e a página.",
  },
  {
    id: "web",
    label: "Busca na internet",
    description:
      "A MAVI pesquisa na internet e lê páginas (notícias, concorrentes, dados públicos) e cita os links. Funciona com os modelos da Claude; cada busca custa US$ 0,01.",
  },
  {
    id: "scrape",
    label: "Leitura de páginas (web scraping)",
    description:
      "A MAVI abre links e sites públicos e lê o conteúdo: texto, tabelas, preços e dados de produtos, com as páginas citadas como fontes. Funciona com qualquer modelo e respeita o robots.txt dos sites.",
  },
  {
    id: "skills",
    label: "Skills",
    description:
      "Jeitos de trabalhar que a agência ensina à MAVI (instruções e arquivos de referência). Qualquer pessoa cria; administradores e gestores aprovam em MAVI › Skills.",
  },
  {
    id: "mcp",
    label: "Conexões (MCP)",
    description:
      "A MAVI usa serviços externos conectados por MCP (Notion, Linear, um sistema próprio…): os da empresa, cadastrados em MAVI › Conexões, e os pessoais de cada um. O que altera algo no serviço pede confirmação no card.",
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
    }
  | {
      /** Campanhas › Meus avisos: criar, mudar ou excluir um aviso da pessoa. */
      kind: "campaign_alert";
      op: "create" | "update" | "delete";
      rule: CampaignAlertRule;
    }
  | {
      /**
       * Identidade visual: salvar uma inteira (tema e Guia da marca) ou pôr
       * itens numa seção do guia. Grava só quando a pessoa confirma.
       */
      kind: "identity";
      op: "save" | "guide_add";
      scope: IdentityScope;
      client_id?: string;
      client_name?: string;
      /** A que muda (sem: nasce uma). */
      identity_id?: string;
      identity_name: string;
      description?: string;
      /** save: o tema e o guia inteiros. */
      tokens?: IdentityTokens;
      guide?: string;
      /** guide_add: a seção e os itens. */
      section?: string;
      lines?: string[];
      reason: string;
    }
  | {
      /**
       * Salvar no Drive um documento desta conversa (D#), no formato e na
       * pasta que a MAVI achou; a pessoa confirma na janela do Drive.
       */
      kind: "drive_save";
      ref: string;
      format: DriveSaveFormat;
      file_name: string;
      client_id?: string;
      client_name?: string;
      contract_id?: string;
      contract_name?: string;
      folder_id?: string;
      folder_name?: string;
    }
  | {
      /** Uma ferramenta de uma conexão (MCP) que altera algo no serviço. */
      kind: "mcp_call";
      server_id: string;
      server_name: string;
      tool: string;
      tool_title?: string;
      arguments: Record<string, unknown>;
    };
export type ActionState = "pending" | "confirmed" | "cancelled" | "failed";
export const DRIVE_SAVE_FORMATS = ["pdf", "docx", "pptx", "html", "md", "xlsx", "csv"] as const;
export type DriveSaveFormat = (typeof DRIVE_SAVE_FORMATS)[number];

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
  /** Arte por código (render_art): o tamanho exato e a página que a desenhou. */
  art?: boolean;
  width?: number;
  height?: number;
  html?: string;
  /** O cliente cuja marca a arte usa. */
  client?: string;
};
export type ActionArtifact = Base & {
  type: "action";
  action: ActionProposal;
  state: ActionState;
  result?: {
    task_id?: string;
    comment_id?: string;
    /** O aviso de campanha criado ou mudado. */
    rule_id?: string;
    /** O arquivo salvo no Drive. */
    file_id?: string;
    /** A identidade salva e a versão. */
    identity_id?: string;
    version?: number;
    error?: string;
    /** O que a conexão (MCP) respondeu. */
    text?: string;
    /** A conexão está rodando a ação confirmada. */
    running?: boolean;
  };
  decided_at?: string;
};
// ------------------------------------------------------------ canvas
export type SlideLayout =
  | "title"
  | "section"
  | "bullets"
  | "two_columns"
  | "stats"
  | "quote"
  | "image"
  | "closing";
export const SLIDE_LAYOUTS: SlideLayout[] = [
  "title",
  "section",
  "bullets",
  "two_columns",
  "stats",
  "quote",
  "image",
  "closing",
];
export type Slide = {
  layout: SlideLayout;
  title: string;
  subtitle?: string;
  bullets?: string[];
  left_title?: string;
  left?: string[];
  right_title?: string;
  right?: string[];
  stats?: { value: string; label: string }[];
  quote?: string;
  author?: string;
  /** Uma imagem desta conversa (I1). */
  image?: string;
  /** O que falar neste slide. */
  notes?: string;
};
export type SlideTheme = "claro" | "escuro" | "verde";
export const SLIDE_THEMES: SlideTheme[] = ["claro", "escuro", "verde"];
export type SheetTab = {
  name: string;
  columns: TableColumn[];
  rows: (string | number | null)[][];
};
export type Canvas =
  | { kind: "document"; title: string; markdown: string; look?: Look }
  | { kind: "slides"; title: string; theme: SlideTheme; slides: Slide[]; look?: Look }
  /** Design livre: as páginas em HTML e CSS da MAVI (mavi-design). */
  | { kind: "design"; title: string; format: DesignFormat; html: string; pages: number; look?: Look }
  | { kind: "sheet"; title: string; sheets: SheetTab[] };
export type CanvasArtifact = Base & {
  type: "canvas";
  canvas: Canvas;
  /** A versão anterior (D1), quando é um ajuste. */
  revision_of?: string;
  /** A pessoa editou direto no canvas (não foi a MAVI). */
  edited?: boolean;
};

// ------------------------------------------------------------ perguntas
/** Uma pergunta da MAVI antes de seguir, com respostas prováveis. */
export type QuestionItem = {
  question: string;
  options: string[];
  /** Pode marcar mais de uma. */
  multiple?: boolean;
};
export type QuestionArtifact = Base & {
  type: "question";
  questions: QuestionItem[];
};

// ------------------------------------------------------------ tarefa longa
/**
 * O card de uma tarefa longa (migração 20270111090000): o plano, o custo
 * estimado e o teto no momento do plano. O andamento vem do banco
 * (ai_task_get) e dos avisos da tarefa.
 */
export type TaskArtifact = Base & {
  type: "task";
  task: string;
  title: string;
  steps: number;
  estimate: number;
  cap: number;
};

export type AiArtifact =
  | VisualArtifact
  | ImageArtifact
  | ActionArtifact
  | CanvasArtifact
  | QuestionArtifact
  | TaskArtifact
  | SearchArtifact
  | TutorialArtifact
  | MemoryArtifact
  | DossierCheckArtifact
  | MemoryReviewArtifact;

// ------------------------------------------------------------ busca de tarefas
/**
 * O botão "Ver na Busca avançada" da ferramenta find_tasks: a mesma busca
 * (termos, assunto e filtros) na página da Busca, com a lista inteira.
 */
export type SearchArtifact = Base & {
  type: "search";
  /** ?termo=…&mavi=…&cli=… da Busca avançada (searchLinkQuery). */
  query: string;
  /** O pedido, como aparece no campo da Busca. */
  request: string;
  total: number;
};

// ------------------------------------------------------------ memória
/**
 * O cartão "Anotei" da ferramenta remember_about_me: o item da memória de
 * quem perguntou (migração 20270611090000_mavi_memory_person), com Desfazer.
 */
export type MemoryArtifact = Base & {
  type: "memory";
  op: "add" | "replace" | "forget";
  /** O item (mavi_person_traits). */
  item: string;
  kind: "preference" | "context" | "frustration";
  text: string;
  durability: "stable" | "situation";
  /** No replace: o item e o texto que saíram (Desfazer traz de volta). */
  previous?: string;
  previous_id?: string;
};

/**
 * O cartão "A MAVI notou… Confere?" (migração 20270613090000_mavi_memory_client):
 * uma sugestão de risco alto do dossiê do cliente para quem trabalha com ele
 * confirmar ou recusar.
 */
export type DossierCheckArtifact = Base & {
  type: "dossier_check";
  /** A sugestão (client_dossier_proposals). */
  proposal: string;
  client: string;
  /** review: "Ainda vale?" de um item de histórico antigo (20270614090000). */
  op: "add" | "update" | "remove" | "review";
  kind: "prefers" | "avoids" | "rule" | "style" | "context" | "history";
  text: string;
  previous?: string;
  reasons: string[];
  sources: { type: string; title: string; date: string | null }[];
};

/**
 * "Isso ainda vale?" (migração 20270614090000_mavi_memory_review): um item de
 * situação vencido da memória de quem perguntou, para renovar ou tirar.
 */
export type MemoryReviewArtifact = Base & {
  type: "memory_review";
  item: string;
  kind: "preference" | "context" | "frustration";
  text: string;
  valid_until: string;
};

// ------------------------------------------------------------ tutoriais
/** O cartão "Abrir tutorial" da ferramenta search_tutorials: o tutorial na seção. */
export type TutorialArtifact = Base & {
  type: "tutorial";
  tutorial: string;
  /** A âncora da seção ("" = o começo). */
  anchor: string;
  title: string;
  section: string;
  summary: string;
};

export type ImageSize = "square" | "portrait" | "landscape";
export const IMAGE_SIZES: Record<ImageSize, string> = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
};

/**
 * O detalhe do passo que marca a resposta que parou no limite de passos (a
 * MAVI ainda queria buscar): a tela oferece "Continuar de onde parou".
 */
export const CAPPED_DETAIL = "limite de passos";

/** Uma linha só com [[V1]]: o lugar do anexo na resposta. */
export const ARTIFACT_LINE = /^\s*\[\[([VIADQTB]\d{1,2})\]\]\s*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{4,64}$/;
const REF = /^[VIADQTB]\d{1,2}$/;
const DOSSIER_KINDS = ["prefers", "avoids", "rule", "style", "context", "history"];

// As tags que a MAVI às vezes escreve no Markdown (só nomes de HTML: "<5 dias" fica).
const HTML_TAG =
  /<\/?(span|font|mark|b|strong|i|em|u|s|del|ins|small|big|sup|sub|br|p|div|center|a|code|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|hr|img|section|header|footer|article)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*)\s*\/?>/gi;
const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/**
 * O documento e os slides são Markdown: o HTML que a MAVI escrever (ex.:
 * <span style="color:…">) sairia como texto na tela, no PDF e no Word. Vira
 * Markdown — negrito, itálico e link ficam; cor e destaque viram negrito;
 * <br> quebra a linha (numa tabela, separa com " · "); o resto sai e fica o
 * texto. Os blocos de código ficam como estão.
 */
export function htmlToMarkdown(md: string) {
  if (!/<\/?[a-z][^<>]*>|<!--|&(nbsp|amp|lt|gt|quot|apos|#39);/i.test(md)) return md;
  const lines = md.split("\n");
  let code = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) code = !code;
      if (code || /^\s*```/.test(line)) return line;
      const table = /^\s*\|/.test(line);
      // Cor e destaque: a palavra que a MAVI quis realçar continua realçada.
      const bold = new Set<number>();
      let depth = 0;
      let href = "";
      return line
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(HTML_TAG, (_, tag: string, attrs: string) => {
          const t = tag.toLowerCase();
          const closing = _.startsWith("</");
          if (t === "br") return table ? " · " : "\n";
          if (t === "b" || t === "strong") return "**";
          if (t === "i" || t === "em") return "*";
          if (t === "hr") return table ? "" : "\n\n---\n\n";
          if (t === "li") return closing ? "" : "\n- ";
          if (closing && /^(p|div|center|h[1-6])$/.test(t)) return table ? " " : "\n\n";
          if (t === "a") {
            if (closing) {
              const end = href ? `](${href})` : "";
              href = "";
              return end;
            }
            href = attrs.match(/href\s*=\s*["']?(https?:[^"'\s>]+)/i)?.[1] ?? "";
            return href ? "[" : "";
          }
          if (t === "span" || t === "font" || t === "mark") {
            if (closing) {
              depth = Math.max(0, depth - 1);
              return bold.delete(depth) ? "**" : "";
            }
            const strong = t === "mark" || /color|background/i.test(attrs);
            if (strong) bold.add(depth);
            depth++;
            return strong ? "**" : "";
          }
          return "";
        })
        .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_, e: string) => ENTITIES[e.toLowerCase()])
        // "****" de dois realces encostados, e negrito dentro de negrito.
        .replace(/\*{4,}/g, "")
        .replace(/[ \t]+$/g, "");
    })
    .join("\n");
}

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

const strings = (v: unknown, max: number, len: number) =>
  list(v, max)
    .map((x) => text(x, len))
    .filter(Boolean);

/** Um texto de uma linha (título, tópico do slide): o HTML vira Markdown, as quebras viram espaço. */
const plainLine = (v: unknown, max: number) =>
  text(typeof v === "string" ? htmlToMarkdown(v).replace(/\s*\n+\s*/g, " ") : v, max);
const plainLines = (v: unknown, max: number, len: number) =>
  list(v, max)
    .map((x) => plainLine(x, len))
    .filter(Boolean);

/** Até 3 perguntas, cada uma com 2 a 5 respostas prováveis (null: não dá). */
export function sanitizeQuestions(raw: unknown): QuestionItem[] | null {
  const items = list(raw, 10)
    .map((q) => {
      const o = obj(q);
      if (!o) return null;
      const question = text(o.question, 300);
      const options = [...new Set(strings(o.options, 5, 120))];
      if (question.length < 3) return null;
      return { question, options, ...(o.multiple === true ? { multiple: true } : {}) };
    })
    .filter((q): q is QuestionItem => !!q)
    .slice(0, 3);
  return items.length ? items : null;
}

/**
 * O tamanho máximo de um documento (caracteres): o de uma tarefa longa
 * (um capítulo por cliente) passa bem dos 60 mil de uma resposta.
 */
export const DOCUMENT_MAX = 200_000;

/** Um documento, apresentação ou planilha no formato fechado (null: não dá). */
export function sanitizeCanvas(raw: unknown): Canvas | null {
  const v = obj(raw);
  if (!v) return null;
  const title = plainLine(v.title, 120);
  if (v.kind === "document") {
    const markdown =
      typeof v.markdown === "string"
        ? htmlToMarkdown(v.markdown.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""))
            .trim()
            .slice(0, DOCUMENT_MAX)
        : "";
    const look = sanitizeLook(v.look);
    return markdown.length >= 20
      ? { kind: "document", title: title || "Documento", markdown, ...(look ? { look } : {}) }
      : null;
  }
  if (v.kind === "slides") {
    const slides = list(v.slides, 40)
      .map((x): Slide | null => {
        const o = obj(x);
        if (!o) return null;
        const layout = pick(o.layout, SLIDE_LAYOUTS, "bullets");
        const slide: Slide = { layout, title: plainLine(o.title, 140) };
        const add = <K extends keyof Slide>(k: K, val: Slide[K] | "" | undefined) => {
          if (val !== undefined && val !== "" && !(Array.isArray(val) && !val.length))
            slide[k] = val as Slide[K];
        };
        add("subtitle", plainLine(o.subtitle, 240));
        add("bullets", plainLines(o.bullets, 8, 300));
        add("left_title", plainLine(o.left_title, 80));
        add("left", plainLines(o.left, 6, 240));
        add("right_title", plainLine(o.right_title, 80));
        add("right", plainLines(o.right, 6, 240));
        add(
          "stats",
          list(o.stats, 4)
            .map((st) => {
              const so = obj(st);
              const value = so ? plainLine(so.value, 24) : "";
              return value ? { value, label: plainLine(so!.label, 80) } : null;
            })
            .filter((st): st is { value: string; label: string } => !!st),
        );
        add("quote", plainLine(o.quote, 400));
        add("author", plainLine(o.author, 80));
        const image = text(o.image, 4).toUpperCase();
        add("image", /^I\d{1,2}$/.test(image) ? image : "");
        add("notes", text(typeof o.notes === "string" ? htmlToMarkdown(o.notes) : o.notes, 2000));
        return slide.title || slide.bullets || slide.quote || slide.stats ? slide : null;
      })
      .filter((x): x is Slide => !!x);
    const look = sanitizeLook(v.look);
    return slides.length
      ? {
          kind: "slides",
          title: title || "Apresentação",
          theme: pick(v.theme, SLIDE_THEMES, "claro"),
          slides,
          ...(look ? { look } : {}),
        }
      : null;
  }
  if (v.kind === "design") {
    const html = typeof v.html === "string" ? cleanDesignHtml(v.html) : "";
    const pages = countPages(html);
    const look = sanitizeLook(v.look);
    return html.length >= 30 && pages
      ? {
          kind: "design",
          title: title || "Documento",
          format: pick(v.format, DESIGN_FORMAT_KEYS, "a4"),
          html,
          pages,
          ...(look ? { look } : {}),
        }
      : null;
  }
  if (v.kind === "sheet") {
    const sheets = list(v.sheets, 5)
      .map((x, i): SheetTab | null => {
        const table = sanitizeVisual({ ...(obj(x) ?? {}), kind: "table", title: "x" });
        if (!table || table.kind !== "table") return null;
        return {
          name: text(obj(x)?.name, 31).replace(/[\\/?*[\]:]/g, " ") || `Planilha ${i + 1}`,
          columns: table.columns,
          rows: list(obj(x)?.rows, 1000).length > 200
            ? sheetRows(obj(x)!.rows, table.columns)
            : table.rows,
        };
      })
      .filter((x): x is SheetTab => !!x);
    return sheets.length ? { kind: "sheet", title: title || "Planilha", sheets } : null;
  }
  return null;
}
/** As linhas de uma planilha grande (até 1.000, além das 200 de uma tabela). */
function sheetRows(raw: unknown, columns: TableColumn[]) {
  return list(raw, 1000)
    .filter(Array.isArray)
    .map((r) =>
      columns.map((c, k) => {
        const cell = (r as unknown[])[k];
        if (cell === null || cell === undefined || cell === "") return null;
        if (c.unit && c.unit !== "text") return num(cell) ?? text(cell, 200);
        return typeof cell === "number" && Number.isFinite(cell) ? cell : text(cell, 200);
      }),
    );
}

export function sanitizeAction(raw: unknown): ActionProposal | null {
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
  if (a.kind === "campaign_alert") {
    const op = pick(a.op, ["create", "update", "delete"] as const, "create");
    const { rule, error } = ruleFromInput(a.rule);
    if (op !== "create" && !rule.id) return null;
    if (op !== "delete" && error) return null;
    return { kind: "campaign_alert", op, rule };
  }
  if (a.kind === "drive_save") {
    const ref = text(a.ref, 4).toUpperCase();
    if (!/^D\d{1,2}$/.test(ref)) return null;
    const ids = (["client_id", "contract_id", "folder_id"] as const).filter((k) => UUID.test(text(a[k], 40)));
    const names: Record<string, string> = { client_id: "client_name", contract_id: "contract_name", folder_id: "folder_name" };
    return {
      kind: "drive_save",
      ref,
      format: pick(a.format, DRIVE_SAVE_FORMATS, "pdf"),
      file_name: text(a.file_name, 150).replace(/[\\/:*?"<>|]/g, " ").trim() || "Documento",
      ...Object.fromEntries(ids.flatMap((k) => [[k, text(a[k], 40)], [names[k], text(a[names[k]], 160)]])),
    };
  }
  if (a.kind === "identity") {
    const op = pick(a.op, ["save", "guide_add"] as const, "guide_add");
    const scope = pick(a.scope, ["company", "client", "gallery"] as const, "client");
    const client_id = text(a.client_id, 40);
    const identity_id = text(a.identity_id, 40);
    const name = text(a.identity_name, 80);
    const reason = text(a.reason, 300);
    if (scope === "client" && !UUID.test(client_id)) return null;
    const base = {
      kind: "identity" as const,
      op,
      scope,
      ...(scope === "client" ? { client_id, client_name: text(a.client_name, 160) } : {}),
      ...(UUID.test(identity_id) ? { identity_id } : {}),
      identity_name: name || "Identidade",
      reason,
    };
    if (op === "save") {
      const guide = typeof a.guide === "string" ? a.guide.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 30_000) : "";
      const description = text(a.description, 300);
      return { ...base, tokens: sanitizeTokens(a.tokens), guide, ...(description ? { description } : {}) };
    }
    const section = text(a.section, 60);
    const lines = strings(a.lines, 8, 300);
    if (!section || !lines.length) return null;
    return { ...base, section, lines };
  }
  if (a.kind === "mcp_call") {
    const server_id = text(a.server_id, 40);
    const tool = text(a.tool, 128);
    const args = obj(a.arguments) ?? {};
    if (!UUID.test(server_id) || !/^[A-Za-z0-9_./-]{1,128}$/.test(tool) || JSON.stringify(args).length > 8000)
      return null;
    const title = text(a.tool_title, 120);
    return {
      kind: "mcp_call",
      server_id,
      server_name: text(a.server_name, 60) || "Conexão",
      tool,
      ...(title ? { tool_title: title } : {}),
      arguments: args,
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
    const side = (v: unknown) =>
      typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 4000 ? v : undefined;
    const width = side(a.width);
    const height = side(a.height);
    const html = typeof a.html === "string" ? a.html.slice(0, 200_000) : "";
    const client = text(a.client, 40);
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
      ...(a.art === true ? { art: true } : {}),
      ...(width && height ? { width, height } : {}),
      ...(html ? { html } : {}),
      ...(UUID.test(client) ? { client } : {}),
    };
  }
  if (a.type === "question") {
    const questions = sanitizeQuestions(a.questions);
    return questions ? { id, ref, type: "question", questions } : null;
  }
  if (a.type === "canvas") {
    const canvas = sanitizeCanvas(a.canvas);
    const prev = text(a.revision_of, 4);
    return canvas
      ? {
          id,
          ref,
          type: "canvas",
          canvas,
          ...(REF.test(prev) ? { revision_of: prev } : {}),
          ...(a.edited === true ? { edited: true } : {}),
        }
      : null;
  }
  if (a.type === "task") {
    const task = text(a.task, 40);
    const title = text(a.title, 160);
    const steps = num(a.steps);
    if (!UUID.test(task) || title.length < 3) return null;
    return {
      id,
      ref,
      type: "task",
      task,
      title,
      steps: steps && steps > 0 ? Math.min(Math.round(steps), 40) : 1,
      estimate: Math.max(num(a.estimate) ?? 0, 0),
      cap: Math.max(num(a.cap) ?? 0, 0),
    };
  }
  if (a.type === "search") {
    const query = text(a.query, 3000);
    const params = new URLSearchParams(query);
    if (!params.get("termo") || /[\s#]/.test(query)) return null;
    const total = num(a.total);
    return {
      id,
      ref,
      type: "search",
      query,
      request: text(a.request, 200) || (params.get("termo") ?? ""),
      total: total && total > 0 ? Math.round(total) : 0,
    };
  }
  if (a.type === "tutorial") {
    const tutorial = text(a.tutorial, 40);
    if (!/^[0-9a-f-]{36}$/i.test(tutorial)) return null;
    const anchor = text(a.anchor, 80);
    return {
      id,
      ref,
      type: "tutorial",
      tutorial,
      anchor: /^[a-z0-9-]*$/.test(anchor) ? anchor : "",
      title: text(a.title, 160) || "Tutorial",
      section: text(a.section, 160),
      summary: text(a.summary, 200),
    };
  }
  if (a.type === "memory") {
    const item = text(a.item, 40);
    const kind = text(a.kind, 20);
    const body = text(a.text, 300);
    if (!/^[0-9a-f-]{36}$/i.test(item) || !["preference", "context", "frustration"].includes(kind) || !body)
      return null;
    const op = a.op === "replace" || a.op === "forget" ? a.op : "add";
    const previous = text(a.previous, 300);
    const previousId = text(a.previous_id, 40);
    return {
      id,
      ref,
      type: "memory",
      op,
      item,
      kind: kind as MemoryArtifact["kind"],
      text: body,
      durability: a.durability === "situation" ? "situation" : "stable",
      ...(previous ? { previous } : {}),
      ...(/^[0-9a-f-]{36}$/i.test(previousId) ? { previous_id: previousId } : {}),
    };
  }
  if (a.type === "memory_review") {
    const item = text(a.item, 40);
    const kind = text(a.kind, 20);
    const body = text(a.text, 300);
    if (!/^[0-9a-f-]{36}$/i.test(item) || !["preference", "context", "frustration"].includes(kind) || !body) return null;
    return {
      id,
      ref,
      type: "memory_review",
      item,
      kind: kind as MemoryReviewArtifact["kind"],
      text: body,
      valid_until: text(a.valid_until, 40),
    };
  }
  if (a.type === "dossier_check") {
    const proposal = text(a.proposal, 40);
    const kind = text(a.kind, 20);
    const body = text(a.text, 600);
    if (!/^[0-9a-f-]{36}$/i.test(proposal) || !DOSSIER_KINDS.includes(kind) || !body) return null;
    const previous = text(a.previous, 600);
    return {
      id,
      ref,
      type: "dossier_check",
      proposal,
      client: text(a.client, 120),
      op: a.op === "update" || a.op === "remove" || a.op === "review" ? a.op : "add",
      kind: kind as DossierCheckArtifact["kind"],
      text: body,
      ...(previous ? { previous } : {}),
      reasons: (Array.isArray(a.reasons) ? a.reasons : [])
        .filter((r): r is string => typeof r === "string")
        .map((r) => text(r, 120))
        .filter(Boolean)
        .slice(0, 6),
      sources: (Array.isArray(a.sources) ? a.sources : []).flatMap((x) => {
        const o = obj(x);
        return o && text(o.type, 40)
          ? [{ type: text(o.type, 40), title: text(o.title, 200), date: text(o.date, 40) || null }]
          : [];
      }).slice(0, 5),
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
          ...(UUID.test(text(r.rule_id, 40)) ? { rule_id: text(r.rule_id, 40) } : {}),
          ...(UUID.test(text(r.identity_id, 40)) ? { identity_id: text(r.identity_id, 40) } : {}),
          ...(UUID.test(text(r.file_id, 40)) ? { file_id: text(r.file_id, 40) } : {}),
          ...(num(r.version) !== null ? { version: num(r.version)! } : {}),
          ...(text(r.error, 300) ? { error: text(r.error, 300) } : {}),
          ...(text(r.text, 1600) ? { text: text(r.text, 1600) } : {}),
          ...(r.running === true ? { running: true } : {}),
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
  if (a.type === "image" && a.art)
    return `arte ${a.width ?? "?"}×${a.height ?? "?"}${a.edited_from ? ` (ajuste de ${a.edited_from})` : ""}: ${a.prompt.slice(0, 120)} (para ajustar, leia o HTML com read_art)`;
  if (a.type === "image")
    return `imagem${a.edited_from ? ` (edição de ${a.edited_from})` : ""}: ${a.prompt.slice(0, 120)}`;
  if (a.type === "search")
    return `botão da Busca avançada com “${a.request}” (${a.total} tarefas)`;
  if (a.type === "tutorial")
    return `cartão que abre o tutorial “${a.title}”${a.section ? ` na seção “${a.section}”` : ""}`;
  if (a.type === "memory_review")
    return `cartão perguntando à pessoa se “${a.text}” ainda vale (renovar ou tirar da memória)`;
  if (a.type === "dossier_check")
    return `cartão para a pessoa confirmar uma sugestão do dossiê do cliente: “${a.text}”`;
  if (a.type === "memory")
    return `cartão da memória: ${a.op === "forget" ? "tirou" : "anotou"} “${a.text}” (a pessoa pode desfazer)`;
  if (a.type === "question")
    return `perguntas para a pessoa: ${a.questions.map((q) => `“${q.question}”`).join("; ")}`;
  if (a.type === "task")
    return `plano de tarefa longa “${a.title}” (${a.steps} ${a.steps === 1 ? "etapa" : "etapas"}; a pessoa confirma no card, e o documento chega numa resposta à parte quando terminar)`;
  if (a.type === "canvas") {
    const c = a.canvas;
    const what =
      c.kind === "document"
        ? "documento"
        : c.kind === "slides"
          ? `apresentação de ${c.slides.length} slides`
          : c.kind === "design"
            ? `design livre (${c.pages} ${c.pages === 1 ? "página" : "páginas"}, ${c.format}; para ajustar, leia o HTML com read_canvas)`
            : `planilha (${c.sheets.map((x) => x.name).join(", ")})`;
    return `${what} “${c.title}”${a.revision_of ? ` (${a.edited ? "edição da pessoa" : "ajuste"} de ${a.revision_of})` : ""}`;
  }
  const state = {
    pending: "aguardando a confirmação da pessoa",
    confirmed: "confirmada pela pessoa",
    cancelled: "cancelada pela pessoa",
    failed: "falhou",
  }[a.state];
  const what =
    a.action.kind === "create_task"
      ? `criar a tarefa “${a.action.title}”`
      : a.action.kind === "mcp_call"
        ? `${a.action.server_name} › ${a.action.tool_title || a.action.tool}`
        : a.action.kind === "campaign_alert"
          ? `${{ create: "criar", update: "mudar", delete: "excluir" }[a.action.op]} o aviso de campanha “${a.action.rule.name}”`
          : a.action.kind === "drive_save"
            ? `salvar ${a.action.ref} (${a.action.format}) no Drive${a.action.client_name ? ` em ${[a.action.client_name, a.action.contract_name, a.action.folder_name].filter(Boolean).join(" › ")}` : ""}`
          : a.action.kind === "identity"
            ? a.action.op === "save"
              ? `salvar a identidade visual “${a.action.identity_name}”`
              : `adicionar ao Guia da marca “${a.action.identity_name}” (${a.action.section}): ${(a.action.lines ?? []).join("; ").slice(0, 300)}`
            : `comentar na tarefa “${a.action.task_title}”`;
  const said = a.result?.text
    ? ` (resposta: ${a.result.text.slice(0, 400)})`
    : a.result?.error
      ? ` (erro: ${a.result.error})`
      : "";
  return `ação: ${what} — ${state}${said}`;
}

import { callRpc } from "./_drive.js";
import type { CostTurn } from "./_ai-cost.js";
import { vectorLiteral, type Embedder } from "./_ai-embeddings.js";
import type { ToolSpec } from "./_ai-llm.js";

/**
 * IA do MAVI · ferramentas que o modelo usa para achar informação.
 *
 * Definidas em JSON Schema neutro (servem a qualquer provedor e, depois, ao
 * servidor MCP). Cada execução roda como a pessoa que perguntou (token dela):
 * o banco só devolve o que ela pode ver. Os resultados são curtos e vêm
 * numerados ([S1], [S2]…) para a resposta citar; o painel transforma cada
 * citação num atalho para a reunião (no minuto) ou para a tarefa.
 */

export type AiScope = {
  client?: string;
  contract?: string;
  project?: string;
  /** Onde a pergunta foi feita (ex.: "meetings"): só para o registro de custo. */
  module?: string;
};
export type AiSource = {
  ref: string;
  type:
    | "meeting"
    | "task"
    | "file"
    | "social"
    | "campaign"
    | "case"
    | "whatsapp"
    | "web"
    | "attachment";
  /** Página da internet (busca da Claude). */
  url?: string;
  /** Whatsapp: o id é a mensagem; o grupo abre a conversa. */
  id: string;
  group?: string;
  title: string;
  date: string | null;
  client_id: string | null;
  /** Social Leads: o produto contratado (abre a página dele). */
  contract_id?: string | null;
  /** Reunião: segundo do trecho citado. */
  start?: number;
  /** Arquivo: a página/slide/planilha citada. */
  page?: number;
  label?: string;
  /** Tarefa que quem pergunta não abre (Assistente MAVI: só título e status). */
  restricted?: boolean;
};

/** Os tipos da busca (como a IA pede) e os do banco. */
const SEARCH_TYPES: Record<string, string[]> = {
  meeting: ["meeting"],
  task: ["task"],
  file: ["drive_file"],
  social: ["social_plan", "social_briefing"],
  campaign: ["campaign"],
  case: ["success_case"],
  whatsapp: ["whatsapp"],
};
const SOURCE_KIND: Record<string, AiSource["type"]> = {
  meeting: "meeting",
  task: "task",
  drive_file: "file",
  social_plan: "social",
  social_briefing: "social",
  campaign: "campaign",
  success_case: "case",
  whatsapp: "whatsapp",
};

export const STATUS_LABELS: Record<string, string> = {
  open: "Em delegação",
  progress: "Em andamento",
  returned: "Devolvida",
  review: "Em validação",
  rejected: "Alteração",
  correction: "Correção",
  done: "Entregue",
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const dateField = (description: string) => ({
  type: "string",
  description: `${description} (AAAA-MM-DD).`,
});

/** As partes do dossiê de client_overview, na ordem em que aparecem. */
export const OVERVIEW_SECTIONS = [
  "products",
  "dossier",
  "briefing",
  "meetings",
  "tasks",
  "campaigns",
  "temperature",
  "radar",
  "whatsapp",
] as const;
type OverviewSection = (typeof OVERVIEW_SECTIONS)[number];

export const TOOLS: ToolSpec[] = [
  {
    name: "find_clients",
    description:
      "Acha clientes pelo código ou nome (no sistema, o nome do cliente costuma ser o código dele, ex.: '4282') e mostra os produtos contratados. Use antes de filtrar por cliente quando a pessoa citar um cliente e você não tiver o id. Vários clientes: mande todos os códigos numa chamada só, separados por vírgula (ex.: '5022, 5017, 5052').",
    parameters: obj(
      {
        query: {
          type: "string",
          description: "Código ou parte do nome do cliente; vários, separados por vírgula.",
        },
      },
      ["query"],
    ),
  },
  {
    name: "client_overview",
    description:
      "Dossiê de até 3 clientes numa chamada só: produtos contratados, o dossiê da MAVI (gostos, regras, tom, contexto, histórico), briefing (arquivos do Drive e Social Leads), as últimas reuniões com o resumo, tarefas em aberto e atrasadas, resultados das campanhas dos últimos 30 dias (só líderes), termômetro, Radar em aberto e o que o cliente pediu ou reclamou no WhatsApp. Use para visão geral, situação atual, passagem de carteira ou comparação de clientes, em vez de chamar cada ferramenta cliente por cliente; para mais clientes, faça várias chamadas na mesma rodada. Devolve trechos [S#] para citar; complete com search_knowledge ou read_more quando precisar de mais detalhe.",
    parameters: obj(
      {
        client_ids: {
          type: "array",
          items: { type: "string" },
          description: "Os ids dos clientes (de 1 a 3), de find_clients.",
        },
        sections: {
          type: "array",
          items: { type: "string", enum: [...OVERVIEW_SECTIONS] },
          description:
            "Opcional: só estas partes (padrão: todas). products, dossier, briefing, meetings, tasks, campaigns, temperature, radar, whatsapp.",
        },
        days: {
          type: "integer",
          minimum: 7,
          maximum: 180,
          description: "Opcional: quantos dias para trás nas reuniões (padrão 60).",
        },
      },
      ["client_ids"],
    ),
  },
  {
    name: "search_knowledge",
    description:
      "Busca por significado e por termos em tudo que a pessoa pode ver na MAVI: transcrições e resumos das reuniões gravadas, tarefas (descrição, campos e comentários), arquivos do Drive (PDF, Word, PowerPoint, Excel, textos), briefing e planos do Social Leads, anotações das campanhas e as conversas dos grupos de WhatsApp dos clientes. Use para qualquer pergunta sobre o que foi dito, combinado, pedido ou decidido. Faça várias buscas com formulações diferentes (em paralelo) quando a pergunta for ampla. Devolve trechos numerados [S#] para citar.",
    parameters: obj(
      {
        query: {
          type: "string",
          description:
            "O que procurar, em poucas palavras, com os termos que provavelmente aparecem no texto (ex.: 'orçamento da campanha', 'reclamação sobre atendimento').",
        },
        client_id: {
          type: "string",
          description: "Limitar a um cliente (id). Omita para buscar em todos.",
        },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "meeting",
              "task",
              "file",
              "social",
              "campaign",
              "case",
              "whatsapp",
            ],
          },
          description:
            "Limitar a tipos: meeting (reuniões gravadas), task (tarefas), file (arquivos do Drive), social (briefing e planos do Social Leads), campaign (anotações e ciclos das campanhas; só líderes), case (cases de sucesso aprovados: resultados, nichos, links e contatos; todos veem), whatsapp (conversas dos grupos de WhatsApp com o cliente, com áudios transcritos e o texto dos documentos enviados).",
        },
        from: dateField("Só a partir desta data"),
        to: dateField("Só até esta data"),
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Quantos trechos (padrão 10).",
        },
      },
      ["query"],
    ),
  },
  {
    name: "read_more",
    description:
      "Lê o texto em volta de um trecho já encontrado (o mesmo documento, antes e depois), para entender melhor o contexto de uma citação [S#].",
    parameters: obj(
      {
        ref: { type: "string", description: "A referência, ex.: 'S3'." },
        window: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Quantos trechos antes e depois (padrão 1).",
        },
      },
      ["ref"],
    ),
  },
  {
    name: "list_meetings",
    description:
      "Lista reuniões gravadas (data, título, quem gravou, resumo curto), da mais recente para a mais antiga. Use para perguntas do tipo 'quais/quantas reuniões', 'a última reunião', 'reuniões de agosto'.",
    parameters: obj({
      client_id: { type: "string", description: "Cliente (id)." },
      from: dateField("A partir de"),
      to: dateField("Até"),
      limit: { type: "integer", minimum: 1, maximum: 30 },
    }),
  },
  {
    name: "campaign_results",
    description:
      "Números das campanhas de tráfego pago no período (gasto, resultados, custo por resultado, impressões, cliques, verba e meta de cada ciclo). Com by_day, traz também os números de cada dia de cada campanha e o total do dia somando as campanhas: use para evolução, 'dia a dia', 'por dia', tendência ou gráfico no tempo. Só administradores e gestores veem campanhas. Use para perguntas sobre desempenho, verba ou resultados de anúncios.",
    parameters: obj({
      client_id: { type: "string", description: "Cliente (id)." },
      from: dateField("Início do período (padrão: primeiro dia do mês)"),
      to: dateField("Fim do período (padrão: hoje)"),
      by_day: {
        type: "boolean",
        description:
          "Também os números de cada dia (até 93 dias). Use para evolução no tempo e gráficos dia a dia.",
      },
    }),
  },
  {
    name: "list_tasks",
    description:
      "Lista tarefas com o estado atual (status, responsável, prazo). Use para 'o que está pendente/atrasado', 'tarefas em validação', 'o que a Fulana está fazendo'.",
    parameters: obj({
      client_id: { type: "string", description: "Cliente (id)." },
      status: {
        type: "array",
        items: { type: "string", enum: Object.keys(STATUS_LABELS) },
        description: "Filtrar por status.",
      },
      open_only: {
        type: "boolean",
        description: "Só as não entregues.",
      },
      overdue_only: {
        type: "boolean",
        description: "Só as com prazo vencido e não entregues.",
      },
      assignee: {
        type: "string",
        description: "Nome (ou parte) do responsável.",
      },
      limit: { type: "integer", minimum: 1, maximum: 40 },
    }),
  },
  {
    name: "client_temperature",
    description:
      "Termômetro do cliente: a temperatura da relação com o cliente (0 a 100 e a faixa, como Frio ou Quente), calculada lendo as reuniões gravadas e os grupos de WhatsApp — os indicadores (satisfação com resultados, risco de cancelamento, relação, engajamento e os que a agência criou), os sinais de alerta (ex.: fala em cancelar), os assuntos que mais mexem com o cliente, a tendência em 7 e 30 dias e a explicação da MAVI. Com client_id: o termômetro do cliente e as leituras recentes que mais pesaram, com citação. Sem client_id: a carteira do cliente mais frio ao mais quente. Use para 'como está o cliente', 'ele está satisfeito?', 'tem risco de cancelar?', 'quais clientes estão frios ou em risco'. Para o que exatamente foi dito, complete com search_knowledge.",
    parameters: obj({
      client_id: {
        type: "string",
        description: "Cliente (id). Omita para ver a carteira.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 40,
        description: "Na carteira: quantos clientes (padrão 15, os mais frios primeiro).",
      },
    }),
  },
  {
    name: "client_radar",
    description:
      "Radar do cliente: o que a MAVI anotou lendo as reuniões gravadas e os grupos de WhatsApp — problemas e reclamações dos clientes, promessas do time (com prazo) e os outros tópicos que a agência criou —, com status, gravidade, produto, responsável, quantas vezes o assunto voltou e a fala mais recente (com citação da reunião no momento ou da mensagem). Também os temas (o mesmo assunto em vários clientes do mesmo produto) e, na carteira, o último relatório do Radar. Com client_id: os itens do cliente. Sem client_id: a carteira que a pessoa vê. Use para 'o que o cliente reclamou', 'o que prometemos', 'promessas vencidas', 'problemas em aberto de Make Ads', 'o que mais se repete entre os clientes'. Para o que exatamente foi dito além da última fala, complete com search_knowledge.",
    parameters: obj({
      client_id: {
        type: "string",
        description: "Cliente (id). Omita para ver a carteira.",
      },
      topic: {
        type: "string",
        description: "Tópico (ex.: \"problemas\", \"promessas\" ou o nome de outro tópico). Omita para todos.",
      },
      status: {
        type: "string",
        enum: ["open", "closed", "all"],
        description: "Em aberto (padrão), fechados ou todos.",
      },
      query: {
        type: "string",
        description: "Palavras para filtrar os itens (título, resumo ou cliente).",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Quantos itens (padrão 20)." },
    }),
  },
];

export type ToolContext = {
  supabaseUrl: string;
  supabaseKey: string;
  fetch: typeof fetch;
  auth: string;
  company: string;
  scope: AiScope;
  embed: Embedder;
  /** Nome de cada pessoa da empresa (responsáveis, quem gravou). */
  members: Map<string, { name: string; email: string }>;
  clients: Map<string, string>;
  today: string;
  /** Tokens de embedding gastos nas buscas desta pergunta. */
  usage: { embeddingTokens: number; embeddingModel: string };
  sources: AiSource[];
  /** Trecho do banco de cada referência (para read_more). */
  chunks: Map<string, number>;
  /**
   * Reordenação da busca ("Quem usa qual modelo" › Reordenação): devolve a
   * ordem dos trechos mais úteis (índices), ou null para ficar como veio.
   */
  rerank?: (query: string, texts: string[], keep: number) => Promise<number[] | null>;
  /** O gasto desta resposta, ligado à conversa (custo da conversa por modelo). */
  cost?: CostTurn;
};

/** Os trechos na ordem da reordenação (o que ela não citou fica de fora). */
export async function reranked<T>(
  ctx: Pick<ToolContext, "rerank">,
  query: string,
  rows: T[],
  text: (row: T) => string,
  keep: number,
) {
  if (!ctx.rerank || rows.length <= 2) return rows.slice(0, keep);
  const order = await ctx.rerank(query, rows.map(text), keep).catch(() => null);
  if (!order?.length) return rows.slice(0, keep);
  return order.map((i) => rows[i]).filter((r): r is T => r !== undefined).slice(0, keep);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown, def: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const waTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
const brDate = (iso: string | null) =>
  iso
    ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString(
        "pt-BR",
        { timeZone: "America/Sao_Paulo" },
      )
    : "sem data";
const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** O cliente que vale: o do escopo (módulo aberto) manda sobre o pedido do modelo. */
function clientOf(ctx: ToolContext, input: Record<string, unknown>) {
  if (ctx.scope.client) return ctx.scope.client;
  const c = str(input.client_id);
  return UUID.test(c) ? c : undefined;
}

/** Uma referência nova (ou a mesma, se o trecho já foi citado). */
export function cite(ctx: ToolContext, source: Omit<AiSource, "ref">) {
  const same = ctx.sources.find(
    (x) =>
      x.type === source.type &&
      x.id === source.id &&
      x.start === source.start &&
      x.page === source.page,
  );
  if (same) return same.ref;
  const ref = `S${ctx.sources.length + 1}`;
  ctx.sources.push({ ...source, ref });
  return ref;
}

async function rest<T>(ctx: ToolContext, path: string): Promise<T[]> {
  const res = await ctx.fetch(`${ctx.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: ctx.supabaseKey, Authorization: ctx.auth },
  });
  if (!res.ok) throw new Error("Não foi possível consultar o banco.");
  return (await res.json()) as T[];
}

export type SearchRow = {
  chunk_id: number;
  source_type: string;
  source_id: string;
  title: string;
  content: string;
  meta: {
    start?: number;
    kind?: string;
    page?: number;
    label?: string;
    post?: number;
    /** Whatsapp: o grupo, a primeira mensagem do trecho e o horário dela. */
    group?: string;
    message?: string;
    at?: string;
  };
  client_id: string | null;
  contract_id: string | null;
  occurred_at: string | null;
  task_status: string | null;
  task_assignee: string | null;
  task_due: string | null;
};

/**
 * Um trecho da busca como o modelo lê: a referência nova ([S#], que vira
 * atalho na tela) e o cabeçalho de onde veio, seguido do texto.
 */
export function citeRow(ctx: ToolContext, row: SearchRow) {
  const start = row.meta?.start;
  const kind = SOURCE_KIND[row.source_type] ?? "task";
  // Whatsapp: a citação aponta a primeira mensagem do trecho.
  const wa = kind === "whatsapp";
  const at = wa && typeof row.meta?.at === "string" ? row.meta.at : null;
  const ref = cite(ctx, {
    type: kind,
    id: wa && row.meta?.message ? String(row.meta.message) : row.source_id,
    ...(wa && row.meta?.group ? { group: String(row.meta.group) } : {}),
    title: row.title,
    date: at ?? row.occurred_at,
    client_id: row.client_id,
    ...(kind === "social" ? { contract_id: row.contract_id } : {}),
    ...(typeof start === "number" ? { start } : {}),
    ...(kind === "file" && row.meta?.label
      ? { page: row.meta.page, label: row.meta.label }
      : {}),
  });
  ctx.chunks.set(ref, row.chunk_id);
  const client = row.client_id ? ctx.clients.get(row.client_id) : undefined;
  const where =
    kind === "meeting"
      ? `Reunião "${row.title}" · ${brDate(row.occurred_at)}${typeof start === "number" ? ` · a partir de ${clock(start)}` : row.meta?.kind === "summary" ? " · resumo" : ""}`
      : kind === "file"
        ? `Arquivo "${row.title}"${row.meta?.label ? ` · ${row.meta.label}` : ""}`
        : kind === "social"
          ? `${row.title}${row.meta?.post ? ` · post ${row.meta.post}` : ""}`
          : kind === "campaign"
            ? `Campanha "${row.title}"`
            : kind === "case"
              ? `Case de sucesso "${row.title}"`
              : wa
                ? `${row.title.replace(/ · \d{2}\/\d{2}\/\d{4}$/, "")} · ${brDate(at ?? row.occurred_at)}${at ? ` ${waTime(at)}` : ""}${row.meta?.kind === "whatsapp_document" && row.meta?.label ? ` · documento "${row.meta.label}"` : ""}`
                : `Tarefa "${row.title}" · ${STATUS_LABELS[row.task_status ?? ""] ?? row.task_status ?? ""}${row.task_assignee ? ` · responsável ${ctx.members.get(row.task_assignee)?.name ?? "?"}` : ""}${row.task_due ? ` · prazo ${brDate(row.task_due)}` : ""}`;
  // A primeira linha do trecho é o cabeçalho de contexto; aqui ele vira
  // a linha de referência.
  const body = row.content.split("\n").slice(1).join("\n").trim();
  return `[${ref}] ${where}${client ? ` · cliente ${client}` : ""}\n${body}`;
}

/**
 * O vetor da busca: a mesma frase na mesma resposta (o dossiê de vários
 * clientes busca o briefing de cada um com as mesmas palavras) vira um
 * vetor só, contado uma vez.
 */
const embedded = new WeakMap<ToolContext, Map<string, ReturnType<Embedder>>>();
function embedOnce(ctx: ToolContext, query: string) {
  let cache = embedded.get(ctx);
  if (!cache) embedded.set(ctx, (cache = new Map()));
  let work = cache.get(query);
  if (!work) {
    work = ctx.embed([query]).then((out) => {
      ctx.usage.embeddingTokens += out.tokens;
      ctx.usage.embeddingModel = out.model;
      return out;
    });
    // Uma falha não fica guardada: a próxima busca tenta de novo.
    work.catch(() => cache!.delete(query));
    cache.set(query, work);
  }
  return work;
}

async function searchKnowledge(
  ctx: ToolContext,
  input: Record<string, unknown>,
) {
  const query = str(input.query).slice(0, 400);
  if (query.length < 2) return "Informe o que procurar.";
  const { vectors } = await embedOnce(ctx, query);
  const types = Array.isArray(input.types)
    ? input.types.flatMap((t) =>
        typeof t === "string" ? (SEARCH_TYPES[t] ?? []) : [],
      )
    : [];
  const filters: Record<string, unknown> = {
    client: clientOf(ctx, input),
    contract: ctx.scope.contract,
    project: ctx.scope.project,
    types: types.length ? types : undefined,
    from: DATE.test(str(input.from)) ? str(input.from) : undefined,
    to: DATE.test(str(input.to)) ? str(input.to) : undefined,
  };
  const limit = int(input.limit, 10, 1, 20);
  const r = await callRpc<SearchRow[]>(ctx, ctx.fetch, ctx.auth, "ai_search", {
    p_company: ctx.company,
    p_embedding: vectors[0] ? vectorLiteral(vectors[0]) : null,
    p_query: query,
    p_filters: filters,
    // Com reordenação, a busca traz mais candidatos e o modelo escolhe os melhores.
    p_limit: ctx.rerank ? Math.min(limit * 2 + 4, 30) : limit,
  });
  if (!r.ok) throw new Error(r.error);
  if (!r.data.length) return "Nenhum trecho encontrado para essa busca.";
  const rows = await reranked(ctx, query, r.data, (row) => `${row.title}\n${row.content}`, limit);
  return rows.map((row) => citeRow(ctx, row)).join("\n\n");
}

async function readMore(ctx: ToolContext, input: Record<string, unknown>) {
  const ref = str(input.ref).toUpperCase();
  const chunk = ctx.chunks.get(ref);
  if (!chunk)
    return `Referência ${ref || "?"} desconhecida: use uma devolvida por search_knowledge.`;
  const r = await callRpc<{ ord: number; content: string }[]>(
    ctx,
    ctx.fetch,
    ctx.auth,
    "ai_read",
    { p_chunk: chunk, p_window: int(input.window, 1, 1, 3) },
  );
  if (!r.ok) throw new Error(r.error);
  return `Texto em volta de [${ref}] (cite como [${ref}]):\n\n${r.data
    .map((x) => x.content.split("\n").slice(1).join("\n").trim())
    .join("\n…\n")}`;
}

async function listMeetings(ctx: ToolContext, input: Record<string, unknown>) {
  const client = clientOf(ctx, input);
  const from = str(input.from);
  const to = str(input.to);
  const params = [
    "select=id,client_id,title,recorded_at,recorded_by_email,duration_seconds,topic:summary->>title,overview:summary->>overview",
    `company_id=eq.${ctx.company}`,
    client ? `client_id=eq.${client}` : "",
    DATE.test(from) ? `recorded_at=gte.${from}` : "",
    DATE.test(to) ? `recorded_at=lt.${to}T23:59:59` : "",
    "order=recorded_at.desc",
    `limit=${int(input.limit, 15, 1, 30)}`,
  ].filter(Boolean);
  const rows = await rest<{
    id: string;
    client_id: string;
    title: string;
    recorded_at: string;
    recorded_by_email: string;
    duration_seconds: number | null;
    topic: string | null;
    overview: string | null;
  }>(ctx, `meeting_recordings?${params.join("&")}`);
  if (!rows.length) return "Nenhuma reunião encontrada.";
  return rows
    .map((m) => {
      const title = m.topic || m.title || "Reunião";
      const ref = cite(ctx, {
        type: "meeting",
        id: m.id,
        title,
        date: m.recorded_at,
        client_id: m.client_id,
      });
      const who =
        [...ctx.members.values()].find(
          (p) => p.email === m.recorded_by_email.toLowerCase(),
        )?.name ?? m.recorded_by_email.split("@")[0];
      return `[${ref}] ${brDate(m.recorded_at)} · "${title}"${m.title && m.title !== title ? ` (agenda: ${m.title})` : ""} · gravada por ${who}${m.duration_seconds ? ` · ${Math.round(m.duration_seconds / 60)} min` : ""}${ctx.scope.client ? "" : ` · cliente ${ctx.clients.get(m.client_id) ?? "?"}`}${m.overview ? `\n${m.overview.slice(0, 400)}` : ""}`;
    })
    .join("\n\n");
}

async function listTasks(ctx: ToolContext, input: Record<string, unknown>) {
  const client = clientOf(ctx, input);
  let contracts: string[] | null = null;
  if (ctx.scope.contract) contracts = [ctx.scope.contract];
  else if (client) {
    const rows = await rest<{ id: string }>(
      ctx,
      `contracts?select=id&company_id=eq.${ctx.company}&client_id=eq.${client}`,
    );
    contracts = rows.map((r) => r.id);
    if (!contracts.length) return "Este cliente não tem produtos contratados.";
  }
  const statuses = Array.isArray(input.status)
    ? input.status.filter(
        (s): s is string => typeof s === "string" && s in STATUS_LABELS,
      )
    : [];
  const assignee = str(input.assignee).toLowerCase();
  const assignees = assignee
    ? [...ctx.members]
        .filter(([, p]) => p.name.toLowerCase().includes(assignee))
        .map(([id]) => id)
    : [];
  if (assignee && !assignees.length)
    return `Ninguém da empresa com o nome "${input.assignee}".`;
  const params = [
    "select=id,title,status,due_date,assignee_id,contract_id,created_at",
    `company_id=eq.${ctx.company}`,
    "archived=is.false",
    contracts ? `contract_id=in.(${contracts.join(",")})` : "",
    ctx.scope.project ? `project_id=eq.${ctx.scope.project}` : "",
    statuses.length ? `status=in.(${statuses.join(",")})` : "",
    input.open_only || input.overdue_only ? "status=neq.done" : "",
    input.overdue_only ? `due_date=lt.${ctx.today}` : "",
    assignees.length ? `assignee_id=in.(${assignees.join(",")})` : "",
    "order=due_date.asc",
    `limit=${int(input.limit, 20, 1, 40)}`,
  ].filter(Boolean);
  const rows = await rest<{
    id: string;
    title: string;
    status: string;
    due_date: string;
    assignee_id: string;
    created_at: string;
  }>(ctx, `tasks?${params.join("&")}`);
  if (!rows.length) return "Nenhuma tarefa encontrada com esses filtros.";
  return rows
    .map((t) => {
      const ref = cite(ctx, {
        type: "task",
        id: t.id,
        title: t.title,
        date: t.created_at,
        client_id: client ?? null,
      });
      const late = t.status !== "done" && t.due_date < ctx.today;
      return `[${ref}] "${t.title}" · ${STATUS_LABELS[t.status] ?? t.status} · responsável ${ctx.members.get(t.assignee_id)?.name ?? "?"} · prazo ${brDate(t.due_date)}${late ? " (atrasada)" : ""}`;
    })
    .join("\n");
}

type ClientRow = {
  id: string;
  name: string;
  contracts: {
    name: string;
    archived: boolean;
    products: { name: string } | null;
  }[];
};
const clientLine = (c: ClientRow) => {
  const products = c.contracts
    .filter((k) => !k.archived)
    .map((k) => k.products?.name ?? k.name);
  return `- Cliente ${c.name} (id ${c.id})${products.length ? ` · produtos: ${[...new Set(products)].join(", ")}` : ""}`;
};
const cleanTerm = (t: string) =>
  t
    .replace(/[,()*%"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
/**
 * Os termos da busca: "5022, 5017; 5052" ou "5022 5017 5052" (só códigos)
 * viram um termo por cliente; o resto é um nome só.
 */
export function clientTerms(raw: string) {
  const parts = raw.split(/[,;\n]+/).map(cleanTerm).filter(Boolean);
  const split =
    parts.length === 1 && /^\d{2,}(\s+\d{2,})+$/.test(parts[0]) ? parts[0].split(" ") : parts;
  return [...new Set(split)].slice(0, 40);
}

async function findClients(ctx: ToolContext, input: Record<string, unknown>) {
  const terms = clientTerms(str(input.query).slice(0, 800));
  if (!terms.length && !ctx.scope.client) return "Informe o código ou nome do cliente.";
  const select = "select=id,name,contracts(name,archived,products(name))";
  if (ctx.scope.client || terms.length === 1) {
    const q = terms[0] ?? "";
    const rows = await rest<ClientRow>(
      ctx,
      `clients?${select}&company_id=eq.${ctx.company}&archived=is.false` +
        (ctx.scope.client
          ? `&id=eq.${ctx.scope.client}`
          : `&name=ilike.*${encodeURIComponent(q)}*`) +
        "&order=name&limit=10",
    );
    if (!rows.length)
      return `Nenhum cliente com "${q}" entre os que a pessoa acessa.`;
    return rows.map(clientLine).join("\n");
  }
  // Vários: uma consulta só; para cada termo, o nome igual vale mais que o parecido.
  const or = terms.map((t) => `name.ilike."*${t}*"`).join(",");
  const rows = await rest<ClientRow>(
    ctx,
    `clients?${select}&company_id=eq.${ctx.company}&archived=is.false&or=${encodeURIComponent(`(${or})`)}&order=name&limit=${Math.min(terms.length * 4, 160)}`,
  );
  const fold = (v: string) => v.toLowerCase();
  const found: ClientRow[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const t of terms) {
    const exact = rows.filter((r) => fold(r.name) === fold(t));
    const like = exact.length ? exact : rows.filter((r) => fold(r.name).includes(fold(t)));
    if (!like.length) missing.push(t);
    else {
      if (like.length > 1) ambiguous.push(t);
      for (const r of like.slice(0, 5)) if (!found.some((f) => f.id === r.id)) found.push(r);
    }
  }
  const lines = [
    `${found.length} de ${terms.length} ${terms.length === 1 ? "cliente encontrado" : "clientes encontrados"}:`,
    ...found.map(clientLine),
  ];
  if (ambiguous.length)
    lines.push(`Mais de um cliente parecido com: ${ambiguous.join(", ")} (confira qual é).`);
  if (missing.length)
    lines.push(`Não encontrados entre os que a pessoa acessa: ${missing.join(", ")}.`);
  return lines.join("\n");
}

// ------------------------------------------------------------ dossiê dos clientes
const SECTION_TITLES: Record<OverviewSection, string> = {
  products: "Produtos contratados",
  dossier: "Dossiê da MAVI (gostos, regras, tom, contexto e histórico)",
  briefing: "Briefing (Drive e Social Leads)",
  meetings: "Reuniões recentes",
  tasks: "Tarefas em aberto",
  campaigns: "Campanhas (últimos 30 dias)",
  temperature: "Termômetro",
  radar: "Radar em aberto (problemas, promessas e outros tópicos)",
  whatsapp: "WhatsApp: pedidos, reclamações e combinados recentes",
};
/** Quanto cada parte ocupa (caracteres), para o dossiê caber na conversa. */
const SECTION_CHARS: Record<OverviewSection, number> = {
  products: 800,
  dossier: 2500,
  briefing: 3500,
  meetings: 3500,
  tasks: 2500,
  campaigns: 2500,
  temperature: 2000,
  radar: 2500,
  whatsapp: 2500,
};
const DOSSIER_KINDS: Record<string, string> = {
  prefers: "Gosta / prefere",
  avoids: "Não gosta / não quer",
  rule: "Regra ou combinado",
  style: "Tom e identidade",
  context: "Contexto do negócio",
  history: "Histórico que pesa",
};
/** Corta no fim de uma linha, avisando que continua. */
export function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf("\n");
  return `${at > max * 0.5 ? cut.slice(0, at) : cut}\n(… cortado: há mais; peça a ferramenta específica para ver tudo)`;
}
const daysBefore = (today: string, days: number) =>
  new Date(Date.parse(`${today}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

async function overviewSection(
  ctx: ToolContext,
  client: string,
  section: OverviewSection,
  days: number,
): Promise<string> {
  const input = { client_id: client };
  if (section === "products") {
    const [c] = await rest<ClientRow>(
      ctx,
      `clients?select=id,name,contracts(name,archived,products(name))&company_id=eq.${ctx.company}&id=eq.${client}`,
    );
    const open = (c?.contracts ?? []).filter((k) => !k.archived).map((k) => k.products?.name ?? k.name);
    return open.length ? [...new Set(open)].join(", ") : "Nenhum produto ativo.";
  }
  if (section === "dossier") {
    const r = await callRpc<{ items: { kind: string; text: string; seen_at: string | null }[]; pending: boolean }>(
      ctx,
      ctx.fetch,
      ctx.auth,
      "client_dossier",
      { p_company: ctx.company, p_client: client },
    );
    if (!r.ok) throw new Error(r.error);
    const items = r.data.items ?? [];
    if (!items.length)
      return r.data.pending ? "O dossiê ainda está sendo montado pela MAVI." : "Sem itens no dossiê.";
    return items.map((i) => `- ${DOSSIER_KINDS[i.kind] ?? i.kind}: ${i.text}`).join("\n");
  }
  if (section === "briefing")
    return searchKnowledge(ctx, {
      ...input,
      query: "briefing do cliente: objetivo, público-alvo, produto, oferta, diferenciais e metas",
      types: ["file", "social"],
      limit: 4,
    });
  if (section === "meetings")
    return listMeetings(ctx, { ...input, from: daysBefore(ctx.today, days), limit: 6 });
  if (section === "tasks") return listTasks(ctx, { ...input, open_only: true, limit: 25 });
  if (section === "campaigns")
    return campaignResults(ctx, { ...input, from: daysBefore(ctx.today, 30), to: ctx.today });
  if (section === "temperature") return clientTemperature(ctx, input);
  if (section === "radar") return clientRadar(ctx, { ...input, status: "open", limit: 10 });
  return searchKnowledge(ctx, {
    ...input,
    query: "pedido, reclamação, pendência, combinado, prazo, aprovação ou insatisfação do cliente",
    types: ["whatsapp"],
    from: daysBefore(ctx.today, 45),
    limit: 5,
  });
}

/** Os clientes que o dossiê aceita: os que a pessoa acessa (ou o do escopo). */
function overviewClients(ctx: ToolContext, input: Record<string, unknown>) {
  if (ctx.scope.client) return [ctx.scope.client];
  const ids = Array.isArray(input.client_ids) ? input.client_ids : [input.client_id];
  return [...new Set(ids.map(str).filter((id) => UUID.test(id) && ctx.clients.has(id)))].slice(0, 3);
}

async function clientOverview(ctx: ToolContext, input: Record<string, unknown>) {
  const clients = overviewClients(ctx, input);
  if (!clients.length)
    return "Mande de 1 a 3 client_ids de clientes que a pessoa acessa (ache com find_clients).";
  const asked = Array.isArray(input.sections)
    ? OVERVIEW_SECTIONS.filter((s) => (input.sections as unknown[]).includes(s))
    : [];
  const sections = asked.length ? asked : [...OVERVIEW_SECTIONS];
  const days = int(input.days, 60, 7, 180);
  const parts = await Promise.all(
    clients.map(async (client) => {
      const blocks = await Promise.all(
        sections.map(async (section) => {
          const text = await overviewSection(ctx, client, section, days).catch(
            (e: Error) => `(não deu para ler agora: ${e.message.slice(0, 160)})`,
          );
          return `### ${SECTION_TITLES[section]}\n${clip(text.trim(), SECTION_CHARS[section])}`;
        }),
      );
      return `## Cliente ${ctx.clients.get(client) ?? "?"} (id ${client})\n\n${blocks.join("\n\n")}`;
    }),
  );
  return `${parts.join("\n\n---\n\n")}\n\n(Dossiê de ${ctx.today}. Cite os trechos [S#]; o que estiver cortado, peça à ferramenta específica.)`;
}

/** O passo, em linguagem de gente, enquanto a ferramenta roda. */
export function describeStep(ctx: ToolContext, name: string, raw: unknown) {
  const input =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const client =
    !ctx.scope.client && UUID.test(str(input.client_id))
      ? ctx.clients.get(str(input.client_id))
      : undefined;
  const inClient = client ? ` do cliente ${client}` : "";
  const period =
    DATE.test(str(input.from)) || DATE.test(str(input.to))
      ? ` (${[str(input.from) && `de ${brDate(str(input.from))}`, str(input.to) && `até ${brDate(str(input.to))}`].filter(Boolean).join(" ")})`
      : "";
  if (name === "search_knowledge") {
    const types = Array.isArray(input.types) ? input.types : [];
    const names: Record<string, string> = {
      meeting: "nas reuniões",
      task: "nas tarefas",
      file: "nos arquivos do Drive",
      social: "no Social Leads",
      campaign: "nas campanhas",
      case: "nos cases de sucesso",
    };
    const where =
      types.length === 1 && names[String(types[0])]
        ? names[String(types[0])]
        : "em tudo que você acessa";
    return `Buscando “${str(input.query).slice(0, 80)}” ${where}${inClient}${period}`;
  }
  if (name === "read_more")
    return `Lendo o trecho ${str(input.ref).toUpperCase()} com mais contexto`;
  if (name === "list_meetings")
    return `Listando as reuniões${inClient}${period}`;
  if (name === "list_tasks") {
    const what = input.overdue_only
      ? "as tarefas atrasadas"
      : input.open_only
        ? "as tarefas em aberto"
        : "as tarefas";
    return `Conferindo ${what}${inClient}${str(input.assignee) ? ` de ${str(input.assignee)}` : ""}`;
  }
  if (name === "find_clients") {
    const terms = clientTerms(str(input.query));
    return terms.length > 1
      ? `Procurando ${terms.length} clientes (${terms.slice(0, 6).join(", ")}${terms.length > 6 ? "…" : ""})`
      : `Procurando o cliente “${str(input.query).slice(0, 40)}”`;
  }
  if (name === "client_overview") {
    const ids = overviewClients(ctx, input);
    const names = ids.map((id) => ctx.clients.get(id) ?? "?");
    return names.length > 1
      ? `Montando o dossiê dos clientes ${names.join(", ")}`
      : `Montando o dossiê do cliente ${names[0] ?? ""}`.trim();
  }
  if (name === "campaign_results")
    return `Conferindo os resultados ${input.by_day ? "diários " : ""}das campanhas${inClient}${period}`;
  if (name === "client_temperature")
    return ctx.scope.client || client
      ? `Olhando o termômetro${inClient || " do cliente"}`
      : "Olhando o termômetro da carteira";
  if (name === "client_radar")
    return ctx.scope.client || client
      ? `Olhando o Radar${inClient || " do cliente"}`
      : "Olhando o Radar da carteira";
  return "Consultando o sistema";
}

/** O resultado do passo, curto. */
export function summarizeStep(name: string, output: string) {
  const refs = new Set(output.match(/^\[S\d+\]/gm) ?? []).size;
  if (name === "search_knowledge")
    return refs
      ? `${refs} ${refs === 1 ? "trecho encontrado" : "trechos encontrados"}`
      : "nada encontrado";
  if (name === "list_meetings")
    return refs
      ? `${refs} ${refs === 1 ? "reunião" : "reuniões"}`
      : "nenhuma reunião";
  if (name === "list_tasks")
    return refs
      ? `${refs} ${refs === 1 ? "tarefa" : "tarefas"}`
      : "nenhuma tarefa";
  if (name === "campaign_results")
    return refs
      ? `${refs} ${refs === 1 ? "campanha" : "campanhas"}`
      : "nenhuma campanha";
  if (name === "find_clients") {
    const n = (output.match(/^- Cliente /gm) ?? []).length;
    const missing = /^Não encontrados[^:]*: (.+)\.$/m.exec(output)?.[1];
    return `${n ? `${n} ${n === 1 ? "cliente" : "clientes"}` : "nenhum cliente"}${missing ? ` · faltou: ${missing}` : ""}`;
  }
  if (name === "client_overview") {
    const n = (output.match(/^## Cliente /gm) ?? []).length;
    return n ? `${n} ${n === 1 ? "cliente" : "clientes"} · ${refs || new Set(output.match(/\[S\d+\]/g) ?? []).size} fontes` : "nada encontrado";
  }
  if (name === "client_temperature") {
    const n = (output.match(/^- Cliente /gm) ?? []).length;
    if (n) return `${n} ${n === 1 ? "cliente" : "clientes"}`;
    const m = /: (\d+)\/100 · ([^·\n]+)/.exec(output);
    return m ? `${m[1]}/100 · ${m[2].trim()}` : "sem temperatura";
  }
  if (name === "client_radar") {
    const n = (output.match(/^- \[/gm) ?? []).length;
    return n ? `${n} ${n === 1 ? "item" : "itens"}` : "nenhum item";
  }
  return "";
}

const brl = (v: number) =>
  `R$ ${Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PLATFORM: Record<string, string> = {
  meta: "Meta",
  google: "Google Ads",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  kwai: "Kwai",
};

type CampaignRow = {
  campaign: string;
  name: string;
  platform: string;
  status: string;
  client: string;
  cycles: {
    start: string;
    end: string;
    objective: string;
    goal_results: number;
    budget: number;
    spend: number;
    impressions: number;
    clicks: number;
    results: number;
  }[];
};

async function campaignResults(
  ctx: ToolContext,
  input: Record<string, unknown>,
) {
  const from = DATE.test(str(input.from))
    ? str(input.from)
    : `${ctx.today.slice(0, 7)}-01`;
  const to = DATE.test(str(input.to)) ? str(input.to) : ctx.today;
  const r = await callRpc<CampaignRow[]>(
    ctx,
    ctx.fetch,
    ctx.auth,
    "ai_campaign_results",
    {
      p_company: ctx.company,
      p_client: clientOf(ctx, input) ?? null,
      p_from: from,
      p_to: to,
    },
  );
  if (!r.ok) throw new Error(r.error);
  const withCycles = r.data.filter((c) => c.cycles.length);
  if (!withCycles.length)
    return `Nenhuma campanha com ciclo entre ${brDate(from)} e ${brDate(to)} (campanhas só aparecem para administradores e gestores).`;
  const days = input.by_day ? await dailyResults(ctx, withCycles, from, to) : null;
  const body = withCycles
    .map((c) => {
      const ref = cite(ctx, {
        type: "campaign",
        id: c.campaign,
        title: c.name,
        date: null,
        client_id: c.client,
      });
      const cycles = c.cycles
        .map((y) => {
          const cpr =
            y.results > 0
              ? ` · custo por resultado ${brl(y.spend / y.results)}`
              : "";
          return `  - ciclo ${brDate(y.start)} a ${brDate(y.end)} (${y.objective}): verba ${brl(y.budget)}, meta ${y.goal_results} resultados → gasto ${brl(y.spend)}, ${Number(y.results).toLocaleString("pt-BR")} resultados${cpr}, ${Number(y.impressions).toLocaleString("pt-BR")} impressões, ${Number(y.clicks).toLocaleString("pt-BR")} cliques`;
        })
        .join("\n");
      const daily = days?.byCampaign.get(c.campaign);
      return `[${ref}] Campanha "${c.name}" · ${PLATFORM[c.platform] ?? c.platform} · ${c.status === "active" ? "ativa" : "inativa"}${ctx.scope.client ? "" : ` · cliente ${ctx.clients.get(c.client) ?? "?"}`}\n${cycles}${
        days
          ? `\n  Por dia:\n${daily?.length ? daily.map((d) => `  - ${dayLine(d)}`).join("\n") : "  - sem números por dia no período"}`
          : ""
      }`;
    })
    .join("\n\n");
  const totals =
    days && withCycles.length > 1 && days.totals.length
      ? `\n\nTotal do dia (todas as campanhas acima):\n${days.totals.map((d) => `- ${dayLine(d)}`).join("\n")}`
      : "";
  return `${body}${totals}${days?.note ?? ""}\n(Período: ${brDate(from)} a ${brDate(to)}; números somados dos dias dentro do período.)`;
}

type DayRow = {
  day: string;
  spend: number;
  results: number;
  impressions: number;
  clicks: number;
};
const dayLine = (d: DayRow) =>
  `${brDate(d.day)}: gasto ${brl(d.spend)}, ${Number(d.results).toLocaleString("pt-BR")} resultados${d.results > 0 ? ` (custo por resultado ${brl(d.spend / d.results)})` : ""}, ${Number(d.impressions).toLocaleString("pt-BR")} impressões, ${Number(d.clicks).toLocaleString("pt-BR")} cliques`;

/**
 * Os números de cada dia das campanhas (RLS: só líderes), por campanha e o
 * total do dia. No máximo 93 dias, para caber na conversa.
 */
async function dailyResults(
  ctx: ToolContext,
  campaigns: CampaignRow[],
  from: string,
  to: string,
) {
  const span =
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000;
  const start =
    span > 92
      ? new Date(Date.parse(`${to}T12:00:00Z`) - 92 * 86_400_000).toISOString().slice(0, 10)
      : from;
  const ids = campaigns.map((c) => c.campaign).filter((id) => UUID.test(id));
  const rows = ids.length
    ? await rest<{
        campaign_id: string;
        day: string;
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
      }>(
        ctx,
        `ad_daily_metrics?select=campaign_id,day,spend,impressions,clicks,conversions&company_id=eq.${ctx.company}&campaign_id=in.(${ids.join(",")})&day=gte.${start}&day=lte.${to}&order=day.asc&limit=5000`,
      )
    : [];
  const add = (map: Map<string, DayRow>, r: (typeof rows)[number]) => {
    const d = map.get(r.day) ?? { day: r.day, spend: 0, results: 0, impressions: 0, clicks: 0 };
    d.spend += Number(r.spend) || 0;
    d.results += Number(r.conversions) || 0;
    d.impressions += Number(r.impressions) || 0;
    d.clicks += Number(r.clicks) || 0;
    map.set(r.day, d);
  };
  const perCampaign = new Map<string, Map<string, DayRow>>();
  const total = new Map<string, DayRow>();
  for (const r of rows) {
    const m = perCampaign.get(r.campaign_id) ?? new Map<string, DayRow>();
    add(m, r);
    perCampaign.set(r.campaign_id, m);
    add(total, r);
  }
  const sorted = (m: Map<string, DayRow>) =>
    [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
  return {
    byCampaign: new Map([...perCampaign].map(([id, m]) => [id, sorted(m)])),
    totals: sorted(total),
    note:
      start !== from
        ? `\n(Por dia: só os últimos 93 dias, de ${brDate(start)} a ${brDate(to)}; para antes, peça outro período.)`
        : "",
  };
}

type TemperatureBand = { name: string; min: number; alert: boolean };
type TemperatureCurrent = {
  score: number | null;
  band: number | null;
  score_d7: number | null;
  score_d30: number | null;
  signals: number;
  indicators: { key: string; name: string; value: number | null; d30: number | null }[];
  flags: { key: string; name: string; alert: boolean; at: string | null }[];
  reasons: { key: string; label: string; share: number }[];
};
type TemperatureRow = {
  settings: { bands: TemperatureBand[]; window_days: number } | null;
  indicators: { key: string; name: string; kind: string }[];
  current: TemperatureCurrent | null;
  summary: { text: string; at: string } | null;
  refreshed_at: string | null;
  signals: {
    type: "meeting" | "whatsapp";
    source_id: string;
    group_id: string | null;
    message_id: string | null;
    title: string;
    date: string;
    status: string;
    answers: Record<string, { v: number; e?: number }>;
    flags: Record<string, number>;
    reason: string | null;
    excerpt: string;
  }[];
  pending: number;
  jev: boolean;
};
type PortfolioRow = {
  client_id: string;
  name: string;
  score: number | null;
  band: number | null;
  d7: number | null;
  d30: number | null;
  flags: { name: string; alert: boolean }[];
  reasons: { label: string; share: number }[];
};

const round = (v: number | null | undefined) =>
  v === null || v === undefined ? null : Math.round(Number(v));
const trend = (v: number | null | undefined, days: number) =>
  v === null || v === undefined
    ? ""
    : ` · ${v > 0 ? "+" : ""}${Math.round(v)} em ${days} dias`;
const bandName = (bands: TemperatureBand[] | undefined, i: number | null) =>
  i === null || i === undefined ? "sem nota" : (bands?.[i]?.name ?? "?");

/** Uma linha curta com a temperatura de hoje (o contexto das conversas no cliente). */
export function temperatureLine(t: TemperatureRow | null) {
  if (!t || Array.isArray(t) || !t.current || t.current.score === null) return "";
  const c = t.current;
  return `Termômetro do cliente hoje: ${round(c.score)}/100 (${bandName(t.settings?.bands, c.band)})${trend(c.score_d7, 7)}${c.flags.length ? ` · sinais de alerta: ${c.flags.map((f) => f.name).join(", ")}` : ""}${t.summary ? ` · explicação da MAVI: ${t.summary.text.slice(0, 400)}` : ""}. Para detalhes e fontes, use client_temperature.`;
}

async function clientTemperature(
  ctx: ToolContext,
  input: Record<string, unknown>,
) {
  const client = clientOf(ctx, input);
  if (!client) {
    const r = await callRpc<{
      settings: { bands: TemperatureBand[] } | null;
      jev: boolean;
      clients: PortfolioRow[];
    }>(ctx, ctx.fetch, ctx.auth, "clients_temperature", {
      p_company: ctx.company,
    });
    if (!r.ok) throw new Error(r.error);
    const rows = r.data.clients.filter((c) => c.score !== null);
    if (!rows.length)
      return r.data.jev
        ? "Nenhum cliente com temperatura ainda (o termômetro lê as reuniões e os grupos de WhatsApp aos poucos)."
        : "O termômetro ainda não está ligado: falta o Jev (TypeSafe) do OpenRouter no Painel da MAVI.";
    const bands = r.data.settings?.bands;
    const list = rows
      .slice(0, int(input.limit, 15, 1, 40))
      .map(
        (c) =>
          `- Cliente ${c.name} (id ${c.client_id}): ${round(c.score)}/100 · ${bandName(bands, c.band)}${trend(c.d7, 7)}${trend(c.d30, 30)}${c.flags.length ? ` · sinais: ${c.flags.map((f) => f.name).join(", ")}` : ""}${c.reasons[0] ? ` · assunto: ${c.reasons[0].label}` : ""}`,
      );
    const alertBands = (bands ?? []).filter((b) => b.alert).map((b) => b.name);
    return `Carteira (do mais frio ao mais quente; ${rows.length} clientes com temperatura):\n${list.join("\n")}${alertBands.length ? `\n(Faixas de alerta: ${alertBands.join(", ")}.)` : ""}`;
  }
  const r = await callRpc<TemperatureRow>(
    ctx,
    ctx.fetch,
    ctx.auth,
    "client_temperature",
    { p_company: ctx.company, p_client: client, p_days: 0, p_signals: 12 },
  );
  if (!r.ok) throw new Error(r.error);
  const t = r.data;
  const name = ctx.clients.get(client) ?? "?";
  if (!t.jev && !t.current)
    return "O termômetro ainda não está ligado: falta o Jev (TypeSafe) do OpenRouter no Painel da MAVI.";
  if (!t.current || t.current.score === null)
    return `O cliente ${name} ainda não tem temperatura${t.pending ? ` (${t.pending} leituras na fila)` : " (nenhuma reunião ou conversa de WhatsApp com fala do cliente na janela)"}.`;
  const c = t.current;
  const bands = t.settings?.bands ?? [];
  const names = new Map(t.indicators.map((i) => [i.key, i.name]));
  const lines = [
    `Termômetro do cliente ${name}: ${round(c.score)}/100 · ${bandName(bands, c.band)}${trend(c.score_d7, 7)}${trend(c.score_d30, 30)} · ${c.signals} leituras nos últimos ${t.settings?.window_days ?? 60} dias${t.refreshed_at ? ` · calculado em ${brDate(t.refreshed_at)}` : ""}.`,
    `Indicadores (0 = pior, 100 = melhor): ${c.indicators
      .map((i) => `${i.name} ${i.value === null ? "sem dados" : round(i.value)}${trend(i.d30, 30)}`)
      .join("; ")}.`,
    c.flags.length
      ? `Sinais de alerta recentes: ${c.flags.map((f) => `${f.name} (${brDate(f.at)})`).join("; ")}.`
      : "Sem sinais de alerta recentes.",
    c.reasons.length
      ? `Assuntos que mais mexem com o cliente: ${c.reasons.map((x) => `${x.label} (${x.share}%)`).join("; ")}.`
      : "",
    t.summary ? `Explicação da MAVI (${brDate(t.summary.at)}): ${t.summary.text}` : "",
    `Faixas: ${bands.map((b) => `${b.name} a partir de ${b.min}`).join(", ")}.`,
  ];
  const reads = t.signals
    .filter((g) => Object.keys(g.answers).length)
    .map((g) => {
      const ref =
        g.type === "meeting"
          ? cite(ctx, { type: "meeting", id: g.source_id, title: g.title, date: g.date, client_id: client })
          : g.message_id
            ? cite(ctx, {
                type: "whatsapp",
                id: g.message_id,
                ...(g.group_id ? { group: g.group_id } : {}),
                title: g.title,
                date: g.date,
                client_id: client,
              })
            : null;
      const notes = Object.entries(g.answers)
        .filter(([, a]) => (a.e ?? 1) >= 0.3)
        .map(([k, a]) => `${names.get(k) ?? k} ${round(a.v)}`)
        .join(", ");
      const flags = Object.entries(g.flags)
        .filter(([, p]) => p >= 0.7)
        .map(([k]) => names.get(k) ?? k);
      return `${ref ? `[${ref}] ` : ""}${g.type === "meeting" ? "Reunião" : "WhatsApp"} "${g.title}" · ${brDate(g.date)}${notes ? ` · ${notes}` : ""}${flags.length ? ` · sinais: ${flags.join(", ")}` : ""}${g.excerpt ? `\n${g.excerpt.slice(0, 300)}` : ""}`;
    });
  return `${lines.filter(Boolean).join("\n")}${reads.length ? `\n\nLeituras recentes (do Jev, cada reunião ou dia de grupo):\n${reads.join("\n\n")}` : ""}`;
}

type RadarQuote = {
  text: string;
  speaker: string;
  role: string;
  source_type: "meeting" | "whatsapp";
  source_id: string;
  group_id: string | null;
  message_id: string | null;
  at_seconds: number | null;
  occurred_at: string;
  title: string | null;
};
type RadarAiItem = {
  id: string;
  topic: string;
  client_id: string;
  client: string;
  product: string;
  title: string;
  summary: string;
  status: string;
  closed: boolean;
  severity: string | null;
  due_date: string | null;
  overdue: boolean;
  mentions: number;
  first_seen: string;
  last_seen: string;
  theme: string | null;
  assignee: string | null;
  quote: RadarQuote | null;
};
export type RadarAiRow = {
  scope: "client" | "portfolio";
  leader: boolean;
  today: string;
  started_at: string | null;
  topics: {
    key: string;
    name: string;
    has_due: boolean;
    open: number;
    severe: number;
    overdue: number;
    new_30d: number;
    closed_30d: number;
    clients: number;
  }[];
  items: RadarAiItem[];
  total: number;
  themes: { title: string; topic: string; product: string; clients: number; open: number; client_names: string[] }[];
  report: {
    title: string;
    period_from: string;
    period_to: string;
    finished_at: string;
    headline: string | null;
    summary: string | null;
    actions: { priority: string; text: string; product?: string }[] | null;
  } | null;
};

const topicCounts = (t: RadarAiRow["topics"][number]) =>
  `${t.name}: ${t.open} em aberto${t.severe ? ` (${t.severe} ${t.severe === 1 ? "sério" : "sérios"})` : ""}${t.has_due && t.overdue ? ` · ${t.overdue} com prazo vencido` : ""}`;

/**
 * Uma linha curta com o Radar do cliente (o contexto das conversas no
 * cliente): o que está em aberto em cada tópico e os itens mais sérios.
 */
export function radarLine(r: RadarAiRow | null) {
  if (!r || Array.isArray(r) || !r.topics?.length) return "";
  const open = r.items.filter((i) => !i.closed).slice(0, 4);
  return `Radar do cliente (o que a MAVI anotou nas reuniões e nos grupos): ${r.topics.map(topicCounts).join("; ")}.${open.length ? ` Em aberto: ${open.map((i) => `${i.topic}: ${i.title}${i.severity ? ` (${i.severity})` : ""}${i.overdue ? " (vencida)" : ""}`).join("; ")}.` : ""} Para os detalhes e as falas, use client_radar.`;
}

async function clientRadar(ctx: ToolContext, input: Record<string, unknown>) {
  const client = clientOf(ctx, input);
  const status = ["open", "closed", "all"].includes(str(input.status)) ? str(input.status) : "open";
  const r = await callRpc<RadarAiRow>(ctx, ctx.fetch, ctx.auth, "radar_ai", {
    p_company: ctx.company,
    p_client: client ?? null,
    p_topic: str(input.topic) || null,
    p_status: status,
    p_query: str(input.query) || null,
    p_limit: int(input.limit, 20, 1, 50),
  });
  if (!r.ok) throw new Error(r.error);
  const d = r.data;
  const where = client ? `do cliente ${ctx.clients.get(client) ?? "?"}` : "da carteira que você acessa";
  if (!d.topics.length)
    return `O Radar ainda não anotou nada ${where}${d.started_at ? ` (ele lê as reuniões e os grupos desde ${brDate(d.started_at)}; o histórico anterior pode ser lido no Painel da MAVI › Radar)` : ""}.`;
  const lines = [
    `Radar ${where}${d.started_at ? ` (lendo desde ${brDate(d.started_at)})` : ""}:`,
    ...d.topics.map(
      (t) => `- ${topicCounts(t)} · ${t.new_30d} novos e ${t.closed_30d} fechados em 30 dias${client ? "" : ` · ${t.clients} clientes com itens em aberto`}`,
    ),
  ];
  const items = d.items.map((i) => {
    const q = i.quote;
    const ref = q
      ? q.source_type === "meeting"
        ? cite(ctx, {
            type: "meeting",
            id: q.source_id,
            title: q.title || "Reunião",
            date: q.occurred_at,
            client_id: i.client_id,
            ...(q.at_seconds !== null ? { start: q.at_seconds } : {}),
          })
        : q.message_id
          ? cite(ctx, {
              type: "whatsapp",
              id: q.message_id,
              ...(q.group_id ? { group: q.group_id } : {}),
              title: q.title || "WhatsApp",
              date: q.occurred_at,
              client_id: i.client_id,
            })
          : null
      : null;
    const meta = [
      i.topic,
      client ? null : `cliente ${i.client}`,
      i.product,
      i.status,
      i.severity,
      i.due_date ? `prazo ${brDate(i.due_date)}${i.overdue ? " (vencido)" : ""}` : null,
      i.assignee ? `responsável ${i.assignee}` : "sem responsável",
      `${i.mentions} ${i.mentions === 1 ? "vez" : "vezes"}, desde ${brDate(i.first_seen)}, última em ${brDate(i.last_seen)}`,
      i.theme ? `tema "${i.theme}"` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `- [${ref ?? "sem fonte"}] ${i.title} — ${meta}${i.summary ? `\n  ${i.summary}` : ""}${q ? `\n  Última fala (${q.speaker || "sem nome"}, ${q.role === "client" ? "cliente" : q.role === "team" ? "time" : "não identificado"}, ${brDate(q.occurred_at)}): "${q.text.slice(0, 300)}"` : ""}`;
  });
  lines.push(
    "",
    items.length
      ? `Itens (${items.length} de ${d.total}${status === "open" ? " em aberto" : status === "closed" ? " fechados" : ""}, os mais sérios e recentes primeiro):`
      : "Nenhum item com esses filtros.",
    ...items,
  );
  if (d.themes.length)
    lines.push(
      "",
      client ? "Temas em que este cliente aparece (o mesmo assunto em outros clientes):" : "Temas com mais clientes:",
      ...d.themes.map(
        (t) => `- ${t.title} · ${t.topic} · ${t.product} · ${t.clients} ${t.clients === 1 ? "cliente" : "clientes"} (${t.client_names.join(", ")}) · ${t.open} em aberto`,
      ),
    );
  if (d.report)
    lines.push(
      "",
      `Último relatório do Radar ("${d.report.title}", ${brDate(d.report.period_from)} a ${brDate(d.report.period_to)}, pronto em ${brDate(d.report.finished_at)}): ${d.report.headline ?? ""} ${d.report.summary ?? ""}`.trim(),
      ...(d.report.actions ?? []).slice(0, 8).map((a) => `- Ação (${a.priority}): ${a.text}${a.product ? ` (${a.product})` : ""}`),
    );
  return lines.join("\n");
}

/** Executa uma ferramenta pelo nome (entradas conferidas aqui). */
export async function runTool(ctx: ToolContext, name: string, raw: unknown) {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (name === "search_knowledge") return searchKnowledge(ctx, input);
  if (name === "read_more") return readMore(ctx, input);
  if (name === "list_meetings") return listMeetings(ctx, input);
  if (name === "list_tasks") return listTasks(ctx, input);
  if (name === "find_clients") return findClients(ctx, input);
  if (name === "campaign_results") return campaignResults(ctx, input);
  if (name === "client_temperature") return clientTemperature(ctx, input);
  if (name === "client_radar") return clientRadar(ctx, input);
  if (name === "client_overview") return clientOverview(ctx, input);
  return `Ferramenta desconhecida: ${name}.`;
}

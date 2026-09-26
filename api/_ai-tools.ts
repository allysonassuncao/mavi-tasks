import { callRpc } from "./_drive.js";
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
  type: "meeting" | "task";
  id: string;
  title: string;
  date: string | null;
  client_id: string | null;
  /** Reunião: segundo do trecho citado. */
  start?: number;
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

export const TOOLS: ToolSpec[] = [
  {
    name: "search_knowledge",
    description:
      "Busca por significado e por termos em tudo que a pessoa pode ver no MAVI: transcrições e resumos das reuniões gravadas e tarefas (descrição, campos e comentários). Use para qualquer pergunta sobre o que foi dito, combinado, pedido ou decidido. Faça várias buscas com formulações diferentes (em paralelo) quando a pergunta for ampla. Devolve trechos numerados [S#] para citar.",
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
          items: { type: "string", enum: ["meeting", "task"] },
          description: "Limitar a reuniões e/ou tarefas.",
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
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown, def: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
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
function cite(ctx: ToolContext, source: Omit<AiSource, "ref">) {
  const same = ctx.sources.find(
    (s) =>
      s.type === source.type && s.id === source.id && s.start === source.start,
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

type SearchRow = {
  chunk_id: number;
  source_type: "meeting" | "task";
  source_id: string;
  title: string;
  content: string;
  meta: { start?: number; kind?: string };
  client_id: string | null;
  occurred_at: string | null;
  task_status: string | null;
  task_assignee: string | null;
  task_due: string | null;
};

async function searchKnowledge(
  ctx: ToolContext,
  input: Record<string, unknown>,
) {
  const query = str(input.query).slice(0, 400);
  if (query.length < 2) return "Informe o que procurar.";
  const { vectors, tokens, model } = await ctx.embed([query]);
  ctx.usage.embeddingTokens += tokens;
  ctx.usage.embeddingModel = model;
  const types = Array.isArray(input.types)
    ? input.types.filter((t) => t === "meeting" || t === "task")
    : [];
  const filters: Record<string, unknown> = {
    client: clientOf(ctx, input),
    contract: ctx.scope.contract,
    project: ctx.scope.project,
    types: types.length ? types : undefined,
    from: DATE.test(str(input.from)) ? str(input.from) : undefined,
    to: DATE.test(str(input.to)) ? str(input.to) : undefined,
  };
  const r = await callRpc<SearchRow[]>(ctx, ctx.fetch, ctx.auth, "ai_search", {
    p_company: ctx.company,
    p_embedding: vectors[0] ? vectorLiteral(vectors[0]) : null,
    p_query: query,
    p_filters: filters,
    p_limit: int(input.limit, 10, 1, 20),
  });
  if (!r.ok) throw new Error(r.error);
  if (!r.data.length) return "Nenhum trecho encontrado para essa busca.";
  return r.data
    .map((row) => {
      const start = row.meta?.start;
      const ref = cite(ctx, {
        type: row.source_type,
        id: row.source_id,
        title: row.title,
        date: row.occurred_at,
        client_id: row.client_id,
        ...(typeof start === "number" ? { start } : {}),
      });
      ctx.chunks.set(ref, row.chunk_id);
      const client = row.client_id ? ctx.clients.get(row.client_id) : undefined;
      const where =
        row.source_type === "meeting"
          ? `Reunião "${row.title}" · ${brDate(row.occurred_at)}${typeof start === "number" ? ` · a partir de ${clock(start)}` : row.meta?.kind === "summary" ? " · resumo" : ""}`
          : `Tarefa "${row.title}" · ${STATUS_LABELS[row.task_status ?? ""] ?? row.task_status ?? ""}${row.task_assignee ? ` · responsável ${ctx.members.get(row.task_assignee)?.name ?? "?"}` : ""}${row.task_due ? ` · prazo ${brDate(row.task_due)}` : ""}`;
      // A primeira linha do trecho é o cabeçalho de contexto; aqui ele vira
      // a linha de referência.
      const body = row.content.split("\n").slice(1).join("\n").trim();
      return `[${ref}] ${where}${client ? ` · cliente ${client}` : ""}\n${body}`;
    })
    .join("\n\n");
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
  return `Ferramenta desconhecida: ${name}.`;
}

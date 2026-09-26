import crypto from "node:crypto";
import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import { extractFileText } from "./_ai-extract.js";
import {
  EmbeddingError,
  embeddingCost,
  openAiEmbedder,
  vectorLiteral,
  type Embedder,
} from "./_ai-embeddings.js";
import {
  anthropicAdapter,
  llmFriendlyError,
  type ChatTurn,
  type LlmAdapter,
} from "./_ai-llm.js";
import {
  TOOLS,
  describeStep,
  runTool,
  summarizeStep,
  type AiScope,
  type AiSource,
  type ToolContext,
} from "./_ai-tools.js";

/**
 * IA do MAVI (ações "ai-*" de /api/ai, que é a função api/drive.ts):
 *
 * - "ai-ask": uma pergunta de quem está logado. O modelo recebe o contexto
 *   (quem pergunta, o cliente/produto/projeto aberto, a data) e ferramentas
 *   de busca; lê só os trechos relevantes e responde citando [S#]. A resposta
 *   volta com as fontes citadas (reunião no minuto, tarefa).
 * - "ai-index": o worker, chamado pelo pg_cron (mavi_private.ai_kick) com o
 *   segredo: monta os documentos da fila e gera os vetores em lotes, até o
 *   tempo acabar. Vários ao mesmo tempo não repetem trabalho.
 */

export type AiEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  anthropicKey: string;
  model: string;
  openaiKey: string;
  embeddingModel: string;
  workerSecret: string;
  /** Quanto o worker trabalha por chamada (ms). */
  workerBudgetMs: number;
  /** GCS do Drive: o worker baixa os arquivos para ler o texto. */
  credentials?: GcsCredentials | null;
  bucket?: string;
};
export function aiEnv(
  base: {
    supabaseUrl: string;
    supabaseKey: string;
    credentials?: GcsCredentials | null;
    bucket?: string;
  },
  env: Record<string, string | undefined> = process.env,
): AiEnv {
  return {
    ...base,
    anthropicKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.AI_MODEL || "claude-opus-5",
    openaiKey: env.OPENAI_API_KEY ?? "",
    embeddingModel: env.AI_EMBEDDING_MODEL || "text-embedding-3-small",
    workerSecret: env.AI_WORKER_SECRET ?? "",
    workerBudgetMs: Number(env.AI_WORKER_BUDGET_MS) || 50_000,
  };
}

export type AiDeps = {
  fetch: typeof fetch;
  llm: LlmAdapter;
  embed: Embedder;
  now?: () => number;
  /** Baixa um arquivo do Drive (trocado nos testes). */
  download?: (path: string) => Promise<Uint8Array>;
};
export function aiDeps(env: AiEnv): AiDeps {
  return {
    fetch,
    llm: anthropicAdapter(env),
    embed: openAiEmbedder(env, fetch),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_LABELS: Record<string, string> = {
  admin: "administrador",
  manager: "gestor",
  member: "colaborador",
};

export const INSTRUCTIONS = `Você é a IA do MAVI, o sistema de gestão de uma agência de marketing (clientes, produtos contratados, projetos, tarefas, reuniões gravadas, arquivos do Drive, Social Leads e campanhas de tráfego pago). Você responde perguntas do time sobre os clientes com base no que está registrado no sistema.

Como trabalhar:
- Para qualquer pergunta sobre fatos (o que foi dito, combinado, pedido, prometido, decidido, reclamado), busque antes de responder. Nunca responda de memória nem invente.
- Use search_knowledge com os termos que provavelmente aparecem no texto. Para perguntas amplas, faça 2 a 4 buscas com formulações diferentes na mesma rodada (em paralelo).
- Use list_meetings e list_tasks para perguntas de lista, contagem ou situação atual ("quais", "quantas", "a última", "o que está atrasado"). Status, responsável e prazo das tarefas vêm atualizados dessas ferramentas.
- Para desempenho, verba e resultados de anúncios, use campaign_results (os números vêm dos dias sincronizados; nunca calcule de cabeça o que a ferramenta já traz). Anotações e ciclos das campanhas também aparecem na busca.
- Documentos do cliente (propostas, contratos, briefings, planilhas, apresentações) estão nos arquivos do Drive; o briefing e os planos mensais do Social Leads (com os 8 posts e a decisão do cliente) também entram na busca.
- Use read_more quando um trecho parecer cortado ou precisar de mais contexto.
- Pare de buscar assim que tiver o suficiente. Se nada relevante aparecer, diga claramente que não encontrou no sistema e sugira onde procurar.

Como responder:
- Cite a fonte logo depois de cada informação, com a referência exata entre colchetes, por exemplo [S2] ou [S1][S4]. Use só referências devolvidas pelas ferramentas.
- Transcrições são automáticas: nomes e palavras podem sair errados. Quando algo for ambíguo, avise.
- Quando houver datas, diga quando foi. Se informações se contradizem ao longo do tempo, mostre a mais recente e o que mudou.
- Português do Brasil, direto: frases curtas, listas com "-" quando ajudar, negrito com ** só no essencial. Sem títulos (#) e sem tabelas.`;

type Row = Record<string, unknown>;
async function rest<T = Row>(
  env: AiEnv,
  deps: AiDeps,
  auth: string,
  path: string,
): Promise<T[]> {
  const res = await deps.fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: env.supabaseKey, Authorization: auth },
  });
  if (!res.ok)
    throw new AiError(
      res.status === 401 ? 401 : 502,
      "Não foi possível ler os dados.",
    );
  return (await res.json()) as T[];
}

class AiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** O id de quem pergunta, lido do token (só para o contexto; o banco confere o acesso). */
function userIdFrom(auth: string) {
  try {
    const payload = auth.replace(/^Bearer\s+/, "").split(".")[1];
    const sub = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

const todayKey = (now: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

function conversation(question: unknown, history: unknown): ChatTurn[] {
  const q = typeof question === "string" ? question.trim() : "";
  if (q.length < 2 || q.length > 2000)
    throw new AiError(400, "Escreva uma pergunta de até 2.000 caracteres.");
  const turns = (Array.isArray(history) ? history : [])
    .filter(
      (t): t is ChatTurn =>
        !!t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string" &&
        !!t.content.trim(),
    )
    .slice(-12)
    // As referências das respostas antigas não valem nesta pergunta.
    .map((t) => ({
      role: t.role,
      content: t.content.replace(/\[S\d+\]/g, "").slice(0, 8000),
    }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  const clean: ChatTurn[] = [];
  for (const t of turns)
    if (!clean.length || clean[clean.length - 1].role !== t.role) clean.push(t);
  if (clean.length && clean[clean.length - 1].role === "user") clean.pop();
  return [...clean, { role: "user", content: q }];
}

/** O que o modelo precisa saber sobre quem pergunta e onde. */
async function buildContext(
  env: AiEnv,
  deps: AiDeps,
  auth: string,
  company: string,
  scope: AiScope,
  now: number,
) {
  const userId = userIdFrom(auth);
  const [members, clients, contracts] = await Promise.all([
    rest<{
      user_id: string;
      name: string;
      email: string | null;
      role: string;
      active: boolean;
    }>(
      env,
      deps,
      auth,
      `memberships?select=user_id,name,email,role,active&company_id=eq.${company}`,
    ),
    rest<{ id: string; name: string }>(
      env,
      deps,
      auth,
      `clients?select=id,name&company_id=eq.${company}` +
        (scope.client ? `&id=eq.${scope.client}` : "&archived=is.false"),
    ),
    scope.client
      ? rest<{
          id: string;
          name: string;
          archived: boolean;
          products: { name: string } | null;
        }>(
          env,
          deps,
          auth,
          `contracts?select=id,name,archived,products(name)&company_id=eq.${company}&client_id=eq.${scope.client}`,
        )
      : Promise.resolve([]),
  ]);
  const open = contracts.filter((k) => !k.archived).map((k) => k.id);
  const projects = open.length
    ? await rest<{ id: string; name: string; contract_id: string }>(
        env,
        deps,
        auth,
        `projects?select=id,name,contract_id&company_id=eq.${company}&archived=is.false&contract_id=in.(${open.join(",")})`,
      )
    : [];
  const me = members.find((m) => m.user_id === userId);
  if (!me) throw new AiError(403, "Sem acesso a esta empresa.");
  if (scope.client && !clients.length)
    throw new AiError(403, "Sem acesso a este cliente.");
  const memberMap = new Map(
    members.map((m) => [
      m.user_id,
      { name: m.name, email: (m.email ?? "").toLowerCase() },
    ]),
  );
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));
  const today = todayKey(now);
  const weekday = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(now));
  const lines = [
    `Hoje é ${weekday} (${today}).`,
    `Quem pergunta: ${me.name} (${ROLE_LABELS[me.role] ?? me.role}).`,
  ];
  if (scope.client) {
    const products = contracts
      .filter((k) => !k.archived)
      .map((k) => {
        const own = projects
          .filter((p) => p.contract_id === k.id)
          .map((p) => p.name);
        return `${k.products?.name ?? k.name}${k.products?.name && k.name !== k.products.name ? ` (${k.name})` : ""}${own.length ? ` — projetos: ${own.join(", ")}` : ""}`;
      });
    lines.push(
      `A pergunta foi feita dentro do cliente "${clientMap.get(scope.client)}" (no sistema, o nome do cliente é o código dele): as ferramentas já buscam só nele.`,
      products.length ? `Produtos contratados: ${products.join("; ")}.` : "",
    );
  } else {
    lines.push(
      "A pergunta pode envolver qualquer cliente que a pessoa acessa. Quando ela citar um cliente, use find_clients para achar o id e depois filtre as buscas por ele.",
    );
  }
  if (scope.module === "meetings")
    lines.push(
      "A pessoa está na pasta Gravações da MAVI: reuniões costumam ser o foco, mas use também as tarefas quando ajudar.",
    );
  return {
    context: lines.filter(Boolean).join("\n"),
    members: memberMap,
    clients: clientMap,
    today,
  };
}

/** Só as fontes citadas na resposta, na ordem em que aparecem. */
export function citedSources(answer: string, sources: AiSource[]) {
  const order = [...answer.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`);
  const seen = new Set<string>();
  return order
    .filter((ref) => !seen.has(ref) && seen.add(ref))
    .map((ref) => sources.find((s) => s.ref === ref))
    .filter((s): s is AiSource => !!s);
}

/** O que a tela recebe enquanto a IA trabalha (uma linha JSON por evento). */
export type AiStreamEvent =
  | {
      type: "step";
      id: string;
      label: string;
      state: "running" | "done" | "error";
      detail?: string;
    }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "round_end" }
  | { type: "warning"; text: string }
  | {
      type: "done";
      answer: string;
      sources: AiSource[];
      conversation: string | null;
    }
  | { type: "error"; error: string; status: number };
type Emit = (event: AiStreamEvent) => void;

async function ask(
  body: Row,
  auth: string,
  env: AiEnv,
  deps: AiDeps,
  emit: Emit,
): Promise<Extract<AiStreamEvent, { type: "done" }>> {
  const company = String(body.company ?? "");
  if (!UUID.test(company)) throw new AiError(400, "Empresa inválida.");
  const raw = (body.scope ?? {}) as Row;
  const id = (v: unknown) =>
    typeof v === "string" && UUID.test(v) ? v : undefined;
  const scope: AiScope = {
    client: id(raw.client),
    contract: id(raw.contract),
    project: id(raw.project),
    module:
      typeof raw.module === "string" ? raw.module.slice(0, 40) : undefined,
  };
  const conversationId = id(body.conversation) ?? null;
  const question = typeof body.question === "string" ? body.question : "";
  conversation(question, []); // confere a pergunta antes de gastar qualquer coisa
  emit({
    type: "step",
    id: "ctx",
    label: "Entendendo a pergunta",
    state: "running",
  });
  const now = (deps.now ?? Date.now)();
  const [base, limits, history] = await Promise.all([
    buildContext(env, deps, auth, company, scope, now),
    callRpc<{ blocked: boolean; message: string | null; warnings: string[] }>(
      env,
      deps.fetch,
      auth,
      "ai_check_limits",
      {
        p_company: company,
        p_client: scope.client ?? null,
        p_contract: scope.contract ?? null,
        p_project: scope.project ?? null,
      },
    ),
    conversationId
      ? Promise.all([
          rest<{ owner_id: string }>(
            env,
            deps,
            auth,
            `ai_conversations?select=owner_id&id=eq.${conversationId}`,
          ),
          rest<ChatTurn>(
            env,
            deps,
            auth,
            `ai_messages?select=role,content&conversation_id=eq.${conversationId}&order=id.desc&limit=12`,
          ),
        ])
      : Promise.resolve(null),
  ]);
  if (limits.ok && limits.data.blocked)
    throw new AiError(
      429,
      limits.data.message ?? "Limite de uso da IA atingido.",
    );
  if (limits.ok)
    for (const text of limits.data.warnings ?? [])
      emit({ type: "warning", text });
  if (history) {
    const [owner] = history[0];
    if (!owner) throw new AiError(404, "Conversa não encontrada.");
    if (owner.owner_id !== userIdFrom(auth))
      throw new AiError(403, "Só quem começou a conversa continua nela.");
  }
  const messages = conversation(
    question,
    history ? [...history[1]].reverse() : body.history,
  );
  emit({
    type: "step",
    id: "ctx",
    label: scope.client
      ? `Contexto do cliente ${base.clients.get(scope.client) ?? ""} carregado`
      : "Contexto carregado",
    state: "done",
  });
  const ctx: ToolContext = {
    supabaseUrl: env.supabaseUrl,
    supabaseKey: env.supabaseKey,
    fetch: deps.fetch,
    auth,
    company,
    scope,
    embed: deps.embed,
    members: base.members,
    clients: base.clients,
    today: base.today,
    usage: { embeddingTokens: 0, embeddingModel: env.embeddingModel },
    sources: [],
    chunks: new Map(),
  };
  const steps: { label: string; detail?: string }[] = [];
  let n = 0;
  const execute = async (name: string, input: unknown) => {
    const stepId = `t${++n}`;
    const label = describeStep(ctx, name, input);
    emit({ type: "step", id: stepId, label, state: "running" });
    try {
      const out = await runTool(ctx, name, input);
      const detail = summarizeStep(name, out);
      steps.push({ label, detail });
      emit({ type: "step", id: stepId, label, state: "done", detail });
      return out;
    } catch (e) {
      emit({
        type: "step",
        id: stepId,
        label,
        state: "error",
        detail: "falhou",
      });
      throw e;
    }
  };
  let result: Awaited<ReturnType<LlmAdapter>> | undefined;
  try {
    result = await deps.llm({
      instructions: INSTRUCTIONS,
      context: base.context,
      messages,
      tools: TOOLS,
      execute,
      maxRounds: 6,
      onEvent: (e) =>
        e.type === "round_end" ? emit({ type: "round_end" }) : emit(e),
    });
  } finally {
    // O custo entra mesmo quando a resposta falha no meio.
    const m = result?.meter;
    const embedCost = embeddingCost(
      ctx.usage.embeddingModel,
      ctx.usage.embeddingTokens,
    );
    if (m || ctx.usage.embeddingTokens)
      await callRpc(env, deps.fetch, auth, "ai_log_usage", {
        p_company: company,
        p_module: scope.module ?? "assistant",
        p_kind: "ask",
        p_client: scope.client ?? null,
        p_contract: scope.contract ?? null,
        p_project: scope.project ?? null,
        p_recording: null,
        p_model: m?.model || env.model,
        p_input: m?.input ?? 0,
        p_output: m?.output ?? 0,
        p_cache_read: m?.cacheRead ?? 0,
        p_cache_write: m?.cacheWrite ?? 0,
        p_embedding: ctx.usage.embeddingTokens,
        p_cost: Math.round(((m?.cost ?? 0) + embedCost) * 1e6) / 1e6,
      }).catch(() => {});
  }
  const answer = result!.text;
  const sources = citedSources(answer, ctx.sources);
  // A conversa fica salva; se não der, a resposta chega mesmo assim.
  const saved = await callRpc<string>(env, deps.fetch, auth, "ai_save_turn", {
    p_company: company,
    p_conversation: conversationId,
    p_scope: {
      ...(scope.client ? { client: scope.client } : {}),
      ...(scope.contract ? { contract: scope.contract } : {}),
      ...(scope.project ? { project: scope.project } : {}),
    },
    p_module: scope.module ?? "assistant",
    p_question: question.trim(),
    p_answer: answer,
    p_sources: sources,
    p_steps: steps,
  }).catch(() => null);
  if (!saved?.ok)
    emit({ type: "warning", text: "Não foi possível salvar esta conversa." });
  return {
    type: "done",
    answer,
    sources,
    conversation: saved?.ok ? saved.data : conversationId,
  };
}

function errorEvent(err: unknown): Extract<AiStreamEvent, { type: "error" }> {
  const status =
    err instanceof AiError || err instanceof EmbeddingError
      ? err.status
      : typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500;
  const error =
    err instanceof AiError || err instanceof EmbeddingError
      ? err.message
      : llmFriendlyError(err);
  return { type: "error", error, status };
}

/**
 * A pergunta em tempo real: cada evento vai para `write` assim que acontece
 * (passos, raciocínio, texto), e termina em "done" ou "error".
 */
export async function streamAi(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
  write: Emit,
) {
  if (!authorization?.startsWith("Bearer ")) {
    write({ type: "error", error: "Entre na sua conta.", status: 401 });
    return;
  }
  try {
    write(await ask((body ?? {}) as Row, authorization, env, deps, write));
  } catch (err) {
    write(errorEvent(err));
  }
}

// ------------------------------------------------------------ worker
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function rpcOrThrow<T>(
  env: AiEnv,
  deps: AiDeps,
  name: string,
  args: Row,
) {
  // O worker fala com o banco como anon + segredo (sem service key no servidor).
  const r = await callRpc<T>(env, deps.fetch, null, name, args);
  if (!r.ok) throw new AiError(r.status, r.error);
  return r.data;
}

/** Baixa um arquivo do Drive por um link assinado de 5 minutos. */
function gcsDownload(env: AiEnv, fetchImpl: typeof fetch) {
  return async (path: string) => {
    if (!env.credentials || !env.bucket)
      throw new AiError(500, "Credenciais do GCS não configuradas.");
    const res = await fetchImpl(
      signGcsUrl(env.credentials, env.bucket, path, "GET", {
        expiresInSeconds: 300,
      }),
    );
    if (!res.ok)
      throw new AiError(502, `Download do arquivo falhou (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** Lê o texto de alguns arquivos pendentes do Drive e devolve ao banco. */
async function readFiles(env: AiEnv, deps: AiDeps) {
  const files = await rpcOrThrow<
    {
      file_id: string;
      path: string;
      name: string;
      kind: string | null;
      size_bytes: number;
    }[]
  >(env, deps, "ai_claim_files", { p_secret: env.workerSecret, p_limit: 3 });
  const download = deps.download ?? gcsDownload(env, deps.fetch);
  await Promise.all(
    files.map(async (f) => {
      let status: string;
      let pages: unknown = null;
      let error: string | null = null;
      try {
        const out = await extractFileText(
          f.kind,
          await download(f.path),
          f.name,
        );
        status = out.status;
        pages = out.status === "done" ? out.pages : null;
        error = out.error ?? null;
      } catch (e) {
        status = "error";
        error = (e as Error).message;
      }
      await rpcOrThrow(env, deps, "ai_store_file_text", {
        p_secret: env.workerSecret,
        p_file: f.file_id,
        p_status: status,
        p_pages: pages,
        p_error: error,
      });
    }),
  );
  return files.length;
}

export async function runIndexer(env: AiEnv, deps: AiDeps) {
  const now = deps.now ?? Date.now;
  const deadline = now() + env.workerBudgetMs;
  const stats = { built: 0, embedded: 0, tokens: 0, cost: 0, files: 0 };
  const perCompany = new Map<string, { tokens: number; cost: number }>();
  while (now() < deadline - 5000) {
    const built = await rpcOrThrow<number>(env, deps, "ai_index_step", {
      p_secret: env.workerSecret,
      p_limit: 50,
    });
    stats.built += built;
    // Arquivos do Drive (baixar e ler leva tempo): só com folga no relógio.
    const read = now() < deadline - 20000 ? await readFiles(env, deps) : 0;
    stats.files += read;
    const claimed = await rpcOrThrow<
      { id: number; company_id: string; content: string }[]
    >(env, deps, "ai_claim_chunks", {
      p_secret: env.workerSecret,
      p_limit: 256,
    });
    if (!claimed.length) {
      if (!built && !read) break;
      continue;
    }
    // Lotes de 128 textos, dois de cada vez.
    const batches: (typeof claimed)[] = [];
    for (let i = 0; i < claimed.length; i += 128)
      batches.push(claimed.slice(i, i + 128));
    const done = await Promise.all(
      batches.map(async (batch) => {
        const { vectors, tokens, model } = await deps.embed(
          batch.map((c) => c.content),
        );
        return { batch, vectors, tokens, model };
      }),
    );
    for (const { batch, vectors, tokens, model } of done) {
      const cost = embeddingCost(model, tokens);
      stats.tokens += tokens;
      stats.cost += cost;
      // O custo do lote dividido entre as empresas pelo tamanho dos textos.
      const chars = batch.reduce((n, c) => n + c.content.length, 0) || 1;
      for (const c of batch) {
        const share = c.content.length / chars;
        const e = perCompany.get(c.company_id) ?? { tokens: 0, cost: 0 };
        e.tokens += tokens * share;
        e.cost += cost * share;
        perCompany.set(c.company_id, e);
      }
      for (let i = 0; i < batch.length; i += 64) {
        const items = batch.slice(i, i + 64).map((c, k) => ({
          id: c.id,
          embedding: vectorLiteral(vectors[i + k]),
        }));
        stats.embedded += await rpcOrThrow<number>(
          env,
          deps,
          "ai_store_embeddings",
          {
            p_secret: env.workerSecret,
            p_model: model,
            p_items: items,
          },
        );
      }
    }
  }
  if (perCompany.size)
    await rpcOrThrow(env, deps, "ai_log_indexing", {
      p_secret: env.workerSecret,
      p_model: env.embeddingModel,
      p_items: [...perCompany].map(([company, e]) => ({
        company,
        tokens: Math.round(e.tokens),
        cost: Math.round(e.cost * 1e6) / 1e6,
      })),
    }).catch(() => {});
  return stats;
}

export async function handleAi(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Row }> {
  const req = (body ?? {}) as Row;
  try {
    if (req.action === "ai-index") {
      const token = authorization?.replace(/^Bearer\s+/, "") ?? "";
      if (!env.workerSecret || !token || !sameSecret(token, env.workerSecret))
        return { status: 401, body: { error: "Não autorizado." } };
      return { status: 200, body: await runIndexer(env, deps) };
    }
    if (req.action === "ai-ask") {
      if (!authorization?.startsWith("Bearer "))
        return { status: 401, body: { error: "Entre na sua conta." } };
      const done = await ask(req, authorization, env, deps, () => {});
      return {
        status: 200,
        body: {
          answer: done.answer,
          sources: done.sources,
          conversation: done.conversation,
        },
      };
    }
    return { status: 400, body: { error: "Ação inválida." } };
  } catch (err) {
    const e = errorEvent(err);
    return { status: e.status, body: { error: e.error } };
  }
}

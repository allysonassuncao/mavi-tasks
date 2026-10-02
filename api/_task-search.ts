import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import { embeddingCost, vectorLiteral } from "./_ai-embeddings.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import { listedStatuses, statuses } from "../src/types.js";
import {
  MAVI_FILTER_KEYS,
  cleanTerms,
  readPrepared,
  termKey,
  type MaviSearch,
  type MaviSearchFilters,
} from "../src/task-search-mavi.js";

/**
 * A MAVI na Busca avançada (ação "task-search" de /api/drive, funcionalidade
 * 'task_search' do Painel da MAVI, migração 20270228090000). Toda busca com
 * texto passa por aqui: a MAVI lê o pedido e devolve os filtros que entendeu
 * (cliente, projeto, responsável, quem criou, status, prazo, prioritárias),
 * os termos e variações que provavelmente aparecem no texto e o vetor do
 * assunto. Quem busca é a tela (public.search_task_rows_mavi, com a sessão da
 * pessoa); nada é gravado aqui.
 *
 * Os nomes viram ids só entre o que a pessoa enxerga (as consultas vão com a
 * sessão dela).
 */

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
/** A tela desiste em 25 s; o servidor não passa disso. */
const LLM_TIMEOUT_MS = 20_000;
const FIELDS = ["title", "description", "comments"];
/** Listas maiores que isto vão só com os nomes parecidos com o pedido. */
const FULL_LIST = 150;

export type SearchCatalog = {
  clients: { id: string; name: string }[];
  projects: { id: string; name: string; client: string }[];
  people: { id: string; name: string }[];
};
type Rest = <T>(path: string) => Promise<T[]>;

class SearchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** O que a pessoa enxerga: clientes, projetos e pessoas ativos. */
export async function searchCatalog(rest: Rest, company: string): Promise<SearchCatalog> {
  const [clients, contracts, projects, people] = await Promise.all([
    rest<{ id: string; name: string }>(
      `clients?select=id,name&company_id=eq.${company}&archived=is.false&order=name&limit=2000`,
    ),
    rest<{ id: string; client_id: string }>(
      `contracts?select=id,client_id&company_id=eq.${company}&limit=5000`,
    ),
    rest<{ id: string; name: string; contract_id: string }>(
      `projects?select=id,name,contract_id&company_id=eq.${company}&archived=is.false&order=name&limit=2000`,
    ),
    rest<{ user_id: string; name: string }>(
      `memberships?select=user_id,name&company_id=eq.${company}&active=is.true&order=name&limit=1000`,
    ),
  ]);
  const clientOf = new Map(contracts.map((k) => [k.id, k.client_id]));
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  return {
    clients,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      client: nameOf.get(clientOf.get(p.contract_id) ?? "") ?? "",
    })),
    people: people.map((m) => ({ id: m.user_id, name: m.name })),
  };
}

/** As palavras do pedido (3+ letras), sem acento, para achar nomes parecidos. */
function queryWords(query: string) {
  return termKey(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}
/** O nome tem uma palavra que começa como uma palavra do pedido (4 letras bastam). */
export function nameNear(name: string, words: string[]) {
  const parts = termKey(name)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  return parts.some((p) =>
    words.some((w) => {
      const n = Math.min(4, w.length, p.length);
      return (p.length >= 3 || p === w) && p.slice(0, n) === w.slice(0, n);
    }),
  );
}

/**
 * As listas que vão para o modelo: inteiras quando curtas; longas, só os
 * nomes parecidos com o pedido e os que já estão nos filtros.
 */
export function narrowCatalog(cat: SearchCatalog, query: string, keep: string[]): SearchCatalog {
  const words = queryWords(query);
  const pick = <T extends { id: string; name: string; client?: string }>(list: T[]) =>
    list.length <= FULL_LIST
      ? list
      : list
          .filter(
            (x) =>
              keep.includes(x.id) || nameNear(x.name, words) || (x.client ? nameNear(x.client, words) : false),
          )
          .slice(0, FULL_LIST);
  return { clients: pick(cat.clients), projects: pick(cat.projects), people: pick(cat.people) };
}

const STATUS_LINES = listedStatuses.map((s) => `${s} = ${statuses[s].label}`).join(", ");

export const SEARCH_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de tarefas de uma agência de marketing (no feminino). Na Busca avançada, a pessoa escreve do jeito dela o que procura nas tarefas (inclusive nas entregues), e você transforma o pedido em filtros e termos de busca. Quem busca é o sistema: você só monta a busca.

Responda SÓ com um JSON, sem texto antes ou depois e sem cercas de código:
{"filters": {...}, "terms": [...], "topic": "...", "summary": "..."}

filters — só o que o pedido diz; um filtro que você não mencionar fica como está na tela. Use "" para tirar um filtro que o pedido desfaz (ex.: "de todos os clientes").
- client: id do cliente. project: id do projeto (o cliente dele vem junto).
- assignee: id de quem executa a tarefa (o responsável: "da Ana", "que o João fez/entregou/está fazendo"). "minhas tarefas", "o que eu fiz" = quem pede.
- creator: id de quem criou ou pediu a tarefa ("que a Ana pediu/abriu/criou").
- status: um destes ids: ${STATUS_LINES}. "entregues", "concluídas", "finalizadas" = done; "em aprovação" = review; "reprovadas" = rejected. Quando o pedido abrange vários status (ex.: "pendentes", "abertas"), não use status e diga no summary.
- from, to: o prazo da tarefa (aaaa-mm-dd), só quando o pedido fala de um período ("de setembro", "da semana passada", "deste mês", "vencidas até ontem"). Use a data de hoje que vier na mensagem.
- priority: true quando pedir prioritárias, urgentes ou de alta prioridade.
- fields: só quando a pessoa disser onde procurar os termos: "title" (título), "description" (descrição), "comments" (comentários).
Use só ids das listas da mensagem; nunca invente. Um nome que não está nas listas não é filtro: vira termo. Um nome que serve a mais de uma pessoa ou cliente: não escolha, diga no summary.

terms — de 1 a 8 palavras ou expressões curtas que provavelmente aparecem escritas no título, na descrição ou nos comentários das tarefas: as palavras-chave do assunto e as variações que o time usaria (singular e plural, sinônimos, abreviações, termos em inglês do marketing, erros comuns de digitação). Ex.: "logo da marca" → ["logo", "logotipo", "logomarca", "identidade visual"]; "post de Black Friday" → ["black friday", "blackfriday", "post", "arte"]. Não repita o que já virou filtro (nomes de cliente, pessoa, status, datas) nem palavras genéricas (tarefa, fazer, cliente, coisa). Vazio quando o pedido é só de filtros ("tarefas da Ana entregues em setembro").

topic — o assunto do pedido numa frase curta e descritiva, para a busca por significado (ex.: "criação ou ajuste do logotipo e da identidade visual da marca"). "" quando o pedido é só de filtros.

summary — uma frase em português, sem markdown, dizendo o que você vai procurar (ex.: "Tarefas sobre logotipo e identidade visual da Clínica Sorriso entregues pela Ana em setembro."). Inclua o que não deu para filtrar.`;

/** O contexto do pedido: hoje, quem pede, os filtros da tela e as listas. */
export function searchContext(input: {
  today: string;
  me: { id: string; name: string } | null;
  current: MaviSearchFilters;
  catalog: SearchCatalog;
}) {
  const { catalog: cat, current } = input;
  const day = new Date(`${input.today}T12:00:00Z`);
  const weekday = Number.isNaN(day.getTime())
    ? ""
    : day.toLocaleDateString("pt-BR", { weekday: "long", timeZone: "UTC" });
  const shown = MAVI_FILTER_KEYS.filter((k) => current[k])
    .map((k) => `${k}: ${current[k]}`)
    .concat(current.priority ? ["priority: true"] : [])
    .concat(current.fields?.length ? [`fields: ${current.fields.join(", ")}`] : []);
  return [
    `Hoje: ${input.today}${weekday ? ` (${weekday})` : ""}.`,
    input.me ? `Quem pede: ${input.me.id} | ${input.me.name}` : "",
    `Filtros na tela agora: ${shown.length ? shown.join("; ") : "nenhum"}.`,
    `Clientes (id | nome):\n${cat.clients.map((c) => `${c.id} | ${c.name}`).join("\n") || "(nenhum parecido com o pedido)"}`,
    `Projetos (id | nome | cliente):\n${cat.projects.map((p) => `${p.id} | ${p.name} | ${p.client}`).join("\n") || "(nenhum parecido com o pedido)"}`,
    `Pessoas (id | nome):\n${cat.people.map((p) => `${p.id} | ${p.name}`).join("\n") || "(nenhuma parecida com o pedido)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** O JSON da resposta do modelo (com ou sem cercas). */
export function parseSearch(text: string): Row | null {
  const body = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(body.slice(start, end + 1));
    return data && typeof data === "object" ? (data as Row) : null;
  } catch {
    return null;
  }
}

/** Os filtros da resposta, só com ids que a pessoa enxerga e valores válidos. */
export function keepFilters(raw: unknown, cat: SearchCatalog): MaviSearchFilters {
  const f = (raw && typeof raw === "object" ? raw : {}) as Row;
  const out: MaviSearchFilters = {};
  const ids = {
    client: new Set(cat.clients.map((c) => c.id)),
    project: new Set(cat.projects.map((p) => p.id)),
    assignee: new Set(cat.people.map((p) => p.id)),
    creator: new Set(cat.people.map((p) => p.id)),
  };
  for (const key of ["client", "project", "assignee", "creator"] as const) {
    const v = f[key];
    if (v === "") out[key] = "";
    else if (typeof v === "string" && ids[key].has(v.trim())) out[key] = v.trim();
  }
  if (f.status === "") out.status = "";
  else if (typeof f.status === "string" && (listedStatuses as string[]).includes(f.status))
    out.status = f.status;
  for (const key of ["from", "to"] as const) {
    const v = f[key];
    if (v === "") out[key] = "";
    else if (typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v))) out[key] = v;
  }
  if (out.from && out.to && out.from > out.to) [out.from, out.to] = [out.to, out.from];
  if (typeof f.priority === "boolean") out.priority = f.priority;
  if (Array.isArray(f.fields)) {
    const fields = FIELDS.filter((x) => (f.fields as unknown[]).includes(x));
    if (fields.length) out.fields = fields;
  }
  return out;
}

/** Os filtros que a tela mandou (para a MAVI saber o que já está escolhido). */
function currentFilters(raw: unknown): MaviSearchFilters {
  const f = (raw && typeof raw === "object" ? raw : {}) as Row;
  const out: MaviSearchFilters = {};
  for (const key of MAVI_FILTER_KEYS) {
    const v = str(f[key], 40);
    if (v && (key === "from" || key === "to" ? DATE.test(v) : key === "status" || UUID.test(v)))
      out[key] = v;
  }
  if (f.priority === true) out.priority = true;
  if (Array.isArray(f.fields)) {
    const fields = FIELDS.filter((x) => (f.fields as unknown[]).includes(x));
    if (fields.length && fields.length < FIELDS.length) out.fields = fields;
  }
  return out;
}

export async function handleTaskSearch(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  const query = str(req.query, 600);
  const today = DATE.test(str(req.today, 10)) ? str(req.today, 10) : new Date().toISOString().slice(0, 10);
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  if (query.length < 2) return fail(400, "Escreva o que você procura.");
  const current = currentFilters(req.filters);
  // Montada pela MAVI da conversa ("Ver na Busca avançada"): termos e
  // filtros já vêm prontos; só o vetor do assunto é refeito.
  const prepared = readPrepared(req.prepared);

  let meter: Meter | undefined;
  let embedded = null as { tokens: number; model: string } | null;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const rest: Rest = async <T>(path: string) => {
      const res = await deps.fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
        headers: { apikey: env.supabaseKey, Authorization: authorization },
      });
      if (!res.ok) throw new SearchError(res.status === 401 ? 401 : 502, "Não foi possível ler os dados.");
      return (await res.json()) as T[];
    };
    // O assunto vira um vetor para a busca por significado; sem a chave da
    // OpenAI ou se falhar, a busca segue só com os termos.
    const embedTopic = async (topic: string) => {
      if (topic.length < 3 || !env.openaiKey) return null;
      try {
        const out = await deps.embed([topic]);
        embedded = { tokens: out.tokens, model: out.model };
        return out.vectors[0] ? vectorLiteral(out.vectors[0]) : null;
      } catch {
        return null;
      }
    };
    const user = userIdFrom(authorization);
    const [me, cat, limits, route] = await Promise.all([
      rest<{ active: boolean; name: string }>(
        `memberships?select=active,name&company_id=eq.${company}&user_id=eq.${user}`,
      ),
      prepared ? null : searchCatalog(rest, company),
      callRpc<{ blocked: boolean; message: string | null }>(env, deps.fetch, authorization, "ai_check_limits", {
        p_company: company,
        p_client: null,
        p_contract: null,
        p_project: null,
      }),
      prepared ? null : featureProvider(env, deps.fetch, authorization, company, "task_search", {}),
    ]);
    if (!me[0]?.active) throw new SearchError(403, "Sem acesso a esta empresa.");
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new SearchError(429, limits.data.message ?? "Limite de uso da MAVI atingido.");
    if (prepared) {
      const embedding = await embedTopic(prepared.topic);
      const search: MaviSearch = {
        query,
        terms: prepared.terms,
        embedding,
        summary: prepared.summary,
        filters: {},
      };
      return { status: 200, body: search as unknown as Record<string, unknown> };
    }
    if (!cat) throw new SearchError(502, "Não foi possível ler os dados.");
    if (!provider && !env.anthropicKey)
      throw new SearchError(
        503,
        "A MAVI não está configurada no servidor. Escolha um provedor para a Busca avançada no Painel da MAVI.",
      );
    const llm: LlmAdapter = provider
      ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config)
      : deps.llm;
    const keep = MAVI_FILTER_KEYS.map((k) => current[k] ?? "").filter((v) => UUID.test(v));
    const result = await llm({
      instructions: SEARCH_INSTRUCTIONS,
      context: searchContext({
        today,
        me: { id: user, name: me[0].name ?? "" },
        current,
        catalog: narrowCatalog(cat, query, [user, ...keep]),
      }),
      messages: [{ role: "user", content: `Pedido:\n"""\n${query}\n"""` }],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "low",
      maxTokens: 900,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    meter = result.meter;
    const answer = parseSearch(result.text);
    if (!answer) throw new SearchError(502, "A MAVI não conseguiu montar a busca.");
    const filters = keepFilters(answer.filters, cat);
    const terms = cleanTerms(answer.terms);
    const topic = str(answer.topic, 300);
    const embedding = await embedTopic(topic);
    const search: MaviSearch = {
      query,
      terms,
      embedding,
      summary: str(answer.summary, 400),
      filters,
      model: meter?.model || provider?.config.model || env.model,
    };
    return { status: 200, body: search as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof SearchError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    const log = (line: Record<string, unknown>) =>
      callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "tasks",
        p_kind: "task_search",
        p_client: null,
        p_contract: null,
        p_project: null,
        p_recording: null,
        p_input: 0,
        p_output: 0,
        p_cache_read: 0,
        p_cache_write: 0,
        p_embedding: 0,
        ...line,
      }).catch(() => {});
    await Promise.all([
      meter
        ? log({
            p_model: meter.model || provider?.config.model || env.model,
            p_input: meter.input ?? 0,
            p_output: meter.output ?? 0,
            p_cache_read: meter.cacheRead ?? 0,
            p_cache_write: meter.cacheWrite ?? 0,
            p_cost: Math.round((meter.cost ?? 0) * 1e6) / 1e6,
            ...(provider ? { p_provider: provider.id } : {}),
          })
        : null,
      embedded
        ? log({
            p_model: embedded.model,
            p_embedding: embedded.tokens,
            p_cost: Math.round(embeddingCost(embedded.model, embedded.tokens) * 1e6) / 1e6,
          })
        : null,
    ]);
  }
}

function userIdFrom(auth: string) {
  try {
    const sub = JSON.parse(
      Buffer.from(auth.replace(/^Bearer\s+/, "").split(".")[1], "base64url").toString("utf8"),
    ).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub : "";
  } catch {
    return "";
  }
}

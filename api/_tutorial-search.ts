import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import { routedLlm } from "./_ai-router.js";
import { embeddingCost, vectorLiteral } from "./_ai-embeddings.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";

/**
 * A busca da página Tutoriais (ações de /api/drive, migração
 * 20270420090000_tutorials_mavi):
 * - "tutorial-search": o vetor da pergunta + public.search_tutorials com a
 *   sessão da pessoa (só os tutoriais do público dela). Sem nenhuma seção, a
 *   pergunta vira uma dúvida sem tutorial. Cada busca fica registrada para as
 *   métricas (log_tutorial_search); o id volta para a tela, que o leva junto
 *   ao abrir um resultado.
 * - "tutorial-answer": a resposta curta da MAVI (funcionalidade
 *   'tutorial_search'), só com as seções encontradas e citando cada uma. Se
 *   elas não respondem, a MAVI diz que não achou (sem inventar passos) e a
 *   dúvida é registrada.
 */

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE = /^[a-zA-Z]{2,40}$/;
const VECTOR = /^\[[-+0-9.eE, ]{1,40000}\]$/;
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const LLM_TIMEOUT_MS = 20_000;
/** Quantas seções a MAVI lê para responder. */
const ANSWER_SECTIONS = 6;

export type TutorialHit = {
  chunk_id: number;
  tutorial_id: string;
  title: string;
  summary: string;
  modules: string[];
  category: string;
  anchor: string;
  section: string;
  content: string;
  score: number;
  similarity: number | null;
  words: number;
};
export type TutorialCitation = {
  n: number;
  tutorial_id: string;
  title: string;
  anchor: string;
  section: string;
};

export const ANSWER_INSTRUCTIONS = `Você é a MAVI, a assistente do sistema de gestão da agência. Uma pessoa buscou nos tutoriais do sistema.

Responda à dúvida dela em 2 ou 3 frases curtas, em português do Brasil, usando SÓ os trechos dos tutoriais abaixo.
- Cite cada trecho usado com o número entre colchetes, como [1] ou [2].
- Diga o caminho na tela (menu, botão, aba) quando o trecho disser.
- Se os trechos não respondem à dúvida, não invente passos nem telas: devolva found=false e answer vazio.
- Sem saudação, sem markdown, sem listas.

Responda apenas com JSON: {"answer": "...", "cited": [1], "found": true}`;

class SearchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A resposta da MAVI como veio (JSON, às vezes com texto em volta). */
export function parseAnswer(text: string): { answer: string; cited: number[]; found: boolean } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]) as Row;
    const cited = Array.isArray(v.cited)
      ? [...new Set(v.cited.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    const answer = str(v.answer, 1200);
    return { answer, cited, found: v.found !== false && !!answer };
  } catch {
    return null;
  }
}

/** As seções como a MAVI lê: numeradas, com o tutorial e a seção. */
export function answerContext(hits: TutorialHit[]) {
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] Tutorial “${h.title}”${h.section ? ` › ${h.section}` : ""}\n${h.content.slice(0, 1800)}`,
    )
    .join("\n\n");
}

export async function handleTutorialSearch(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  const query = str(req.query, 300);
  const module = MODULE.test(str(req.module, 40)) ? str(req.module, 40) : null;
  const category = str(req.category, 60) || null;
  const tags = Array.isArray(req.tags)
    ? req.tags.map((t) => str(t, 40)).filter(Boolean).slice(0, 12)
    : [];
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  if (query.length < 2) return fail(400, "Escreva o que você quer aprender.");
  const answering = req.action === "tutorial-answer";

  let meter: Meter | undefined;
  let embedded = null as { tokens: number; model: string } | null;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  const rpc = <T>(name: string, args: Row) => callRpc<T>(env, deps.fetch, authorization, name, args);
  const gap = () =>
    rpc("log_tutorial_gap", { p_company: company, p_question: query, p_source: "search", p_module: module }).catch(
      () => {},
    );
  try {
    // O vetor da pergunta: o da busca volta da tela na resposta (sem pagar de novo).
    let embedding: string | null = answering && VECTOR.test(str(req.embedding, 40000)) ? str(req.embedding, 40000) : null;
    if (!embedding && env.openaiKey && query.length >= 3) {
      try {
        const out = await deps.embed([query]);
        embedded = { tokens: out.tokens, model: out.model };
        embedding = out.vectors[0] ? vectorLiteral(out.vectors[0]) : null;
      } catch {
        embedding = null;
      }
    }
    const found = await rpc<TutorialHit[]>("search_tutorials", {
      p_company: company,
      p_query: query,
      p_embedding: embedding,
      p_module: module,
      p_strict: !!module,
      p_category: category,
      p_tags: tags.length ? tags : null,
      p_limit: answering ? ANSWER_SECTIONS : 30,
    });
    if (!found.ok) throw new SearchError(found.status, found.error);
    const hits = found.data ?? [];

    if (!answering) {
      const [logged] = await Promise.all([
        rpc<number>("log_tutorial_search", {
          p_company: company,
          p_query: query,
          p_module: module,
          p_results: new Set(hits.map((h) => h.tutorial_id)).size,
        }).catch(() => null),
        hits.length ? null : gap(),
      ]);
      return { status: 200, body: { hits, embedding, search_id: logged?.ok ? (logged.data ?? null) : null } };
    }

    if (!hits.length) {
      await gap();
      return { status: 200, body: { answer: "", found: false, citations: [] } };
    }
    const [limits, route] = await Promise.all([
      rpc<{ blocked: boolean; message: string | null }>("ai_check_limits", {
        p_company: company,
        p_client: null,
        p_contract: null,
        p_project: null,
      }),
      featureProvider(env, deps.fetch, authorization, company, "tutorial_search", {}),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new SearchError(429, limits.data.message ?? "Limite de uso da MAVI atingido.");
    if (!provider && !env.anthropicKey)
      throw new SearchError(503, "A MAVI não está configurada no servidor. Escolha um provedor para a busca nos tutoriais no Painel da MAVI.");
    const llm: LlmAdapter = routedLlm(
      provider
        ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config)
        : deps.llm,
      {
        env,
        fetch: deps.fetch,
        auth: authorization,
        where: { company, surface: "tutorials", feature: "tutorial_search" },
        used: { providerId: provider?.id ?? null, model: provider?.config.model || env.model, scope: provider?.scope },
        question: query,
        hasServerKey: !!env.anthropicKey,
      },
    );
    const result = await llm({
      instructions: ANSWER_INSTRUCTIONS,
      context: `Trechos dos tutoriais:\n\n${answerContext(hits)}`,
      messages: [{ role: "user", content: `Dúvida:\n"""\n${query}\n"""` }],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "low",
      maxTokens: 600,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    meter = result.meter;
    const parsed = parseAnswer(result.text);
    if (!parsed) throw new SearchError(502, "A MAVI não conseguiu responder agora.");
    if (!parsed.found) {
      await gap();
      return { status: 200, body: { answer: "", found: false, citations: [] } };
    }
    const citations: TutorialCitation[] = parsed.cited
      .filter((n) => n <= hits.length)
      .map((n) => ({
        n,
        tutorial_id: hits[n - 1].tutorial_id,
        title: hits[n - 1].title,
        anchor: hits[n - 1].anchor,
        section: hits[n - 1].section,
      }));
    return { status: 200, body: { answer: parsed.answer, found: true, citations } };
  } catch (err) {
    if (err instanceof SearchError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    const log = (line: Row) =>
      rpc("ai_log_usage", {
        p_company: company,
        p_module: "tutorials",
        p_kind: "tutorial_search",
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

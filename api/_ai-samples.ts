import { waitUntil } from "@vercel/functions";
import type { AgentRequest, ChatTurn, LlmAdapter, ToolSpec } from "./_ai-llm.js";

/**
 * MAVI · Avaliação dinâmica: o gravador (migração 20270617090000).
 *
 * Cada módulo que chama a MAVI (a conversa, o Radar, o Termômetro, os
 * Insights…) passa o seu modelo por aqui: de tempos em tempos, a chamada é
 * gravada inteira — as instruções, o contexto, a conversa, as ferramentas, o
 * que cada consulta devolveu e a resposta. O banco guarda os 10 registros
 * mais recentes de cada módulo, e o Painel da MAVI › Avaliação repete esses
 * registros com outro modelo (as consultas devolvem o que foi gravado).
 *
 * Nunca atrasa nem derruba a resposta: grava depois (waitUntil) e ignora
 * erros. Fica de fora o que não dá para repetir: imagens na conversa, busca
 * na internet e respostas vazias.
 *
 * Não importa nenhum módulo da MAVI (só tipos), para não criar ciclos.
 */

export type SampleSpot = {
  db: { supabaseUrl: string; supabaseKey: string; workerSecret?: string };
  fetch?: typeof fetch;
  /** O login de quem pediu (nas telas); nos agendamentos, nulo: vai com o segredo do worker. */
  auth: string | null;
  company: string;
  feature: string;
  client?: string | null;
  /**
   * O provedor que respondeu (nulo: a Claude do servidor; o banco acha o
   * nome). Uma função é lida depois da resposta (o roteador pode trocar).
   */
  providerId?: string | null | (() => string | null);
  /** O registro segue depois da resposta (na Vercel, waitUntil). */
  later?: (work: Promise<unknown>) => void;
  /** Para os testes: o relógio. */
  now?: () => number;
};

export type SampleCall = { name: string; input: unknown; output: string };
export type SampleRequest = {
  instructions: string;
  context: string;
  messages: { role: ChatTurn["role"]; content: string }[];
  tools: ToolSpec[];
  max_rounds: number | null;
  effort: string | null;
  max_tokens: number | null;
  calls: SampleCall[];
};

/** Um registro a cada 5 minutos por módulo em cada instância (o banco aceita um por minuto). */
export const SAMPLE_GAP_MS = 5 * 60_000;
/** Registros maiores que isso não são gravados (o banco recusa acima de 900 mil). */
export const SAMPLE_MAX_CHARS = 800_000;
const OUTPUT_MAX = 40_000;

const lastAt = new Map<string, number>();
/** A vez deste módulo (e marca: a próxima só depois do intervalo). */
export function sampleDue(key: string, now: number) {
  const last = lastAt.get(key);
  if (last !== undefined && now - last < SAMPLE_GAP_MS) return false;
  lastAt.set(key, now);
  return true;
}
/** Para os testes: esquece os intervalos. */
export const resetSampleClock = () => lastAt.clear();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [cortado no registro]` : s);

/** O modelo do módulo, com o gravador: devolve a mesma resposta, sem esperar a gravação. */
export function sampledLlm(llm: LlmAdapter, spot: SampleSpot): LlmAdapter {
  return async (request: AgentRequest) => {
    const now = spot.now ?? Date.now;
    if (
      !spot.company ||
      request.webSearch ||
      request.messages.some((m) => m.images?.length) ||
      !sampleDue(`${spot.company}|${spot.feature}`, now())
    )
      return llm(request);
    const calls: SampleCall[] = [];
    const started = now();
    const result = await llm({
      ...request,
      execute: async (name, input) => {
        const out = await request.execute(name, input);
        calls.push({ name, input, output: clip(typeof out === "string" ? out : out.text, OUTPUT_MAX) });
        return out;
      },
    });
    if (!result.text.trim() || result.webSearches) return result;
    const effort = typeof request.effort === "function" ? request.effort() : request.effort;
    const recorded: SampleRequest = {
      instructions: request.instructions,
      context: request.context,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: request.tools,
      max_rounds: request.maxRounds ?? null,
      effort: effort ?? null,
      max_tokens: request.maxTokens ?? null,
      calls,
    };
    const last = [...request.messages].reverse().find((m) => m.role === "user");
    const sample = {
      question: (last?.content ?? "").slice(0, 2000),
      request: recorded,
      answer: result.text,
      provider_id: (typeof spot.providerId === "function" ? spot.providerId() : spot.providerId) ?? null,
      model: result.meter.model,
      cost: Math.round(result.meter.cost * 1e6) / 1e6,
      ms: now() - started,
      rounds: result.rounds,
    };
    const body = JSON.stringify({
      p_secret: spot.auth ? null : (spot.db.workerSecret ?? null),
      p_company: spot.company,
      p_feature: spot.feature,
      p_client: spot.client ?? null,
      p_sample: sample,
    });
    if (body.length > SAMPLE_MAX_CHARS) return result;
    const work = (spot.fetch ?? fetch)(`${spot.db.supabaseUrl}/rest/v1/rpc/ai_sample_save`, {
      method: "POST",
      headers: {
        apikey: spot.db.supabaseKey,
        Authorization: spot.auth ?? `Bearer ${spot.db.supabaseKey}`,
        "Content-Type": "application/json",
      },
      body,
    })
      .then(async (res) => {
        if (!res.ok) console.error("registro da avaliação", spot.feature, res.status, (await res.text()).slice(0, 200));
      })
      .catch((e) => console.error("registro da avaliação", spot.feature, (e as Error).message));
    (spot.later ?? ((w: Promise<unknown>) => waitUntil(w)))(work);
    return result;
  };
}

/** O registro de um agendamento (sem login: vai com o segredo do worker). */
export function workerSpot(
  env: SampleSpot["db"],
  deps: { fetch?: typeof fetch },
  company: string,
  feature: string,
  opts: { client?: string | null; providerId?: string | null } = {},
): SampleSpot {
  return {
    db: env,
    fetch: deps.fetch,
    auth: null,
    company,
    feature,
    client: opts.client ?? null,
    providerId: opts.providerId ?? null,
  };
}

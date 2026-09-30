import crypto from "node:crypto";
import { callRpc } from "./_drive.js";
import type { Meter } from "./_social-leads.js";

/**
 * MAVI · o custo de cada conversa (migração 20261224090000_mavi_conversation_cost).
 *
 * Todo gasto de uma resposta passa por aqui: vira uma linha em ai_usage por
 * modelo que gastou, com a conversa e o id da vez (turn). Depois de salvar a
 * resposta, ai_usage_close_turn liga as linhas da vez à mensagem. A resposta
 * também devolve o resumo da vez (por modelo) para a tela mostrar na hora.
 */

export type CostEntry = {
  /** O que gastou: ask (a resposta), image, canvas, web, skill, rerank, summary… */
  kind: string;
  model: string;
  /** O provedor da biblioteca (null: o padrão do servidor). */
  provider: string | null;
  /** O nome do provedor, para a tela (não vai ao banco: ele acha pelo id). */
  providerName?: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  embedding: number;
  cost: number;
};
/** A vez desta resposta: onde o gasto fica registrado e o que já gastou. */
export type CostTurn = {
  conversation: string | null;
  turn: string;
  entries: CostEntry[];
  /** Os registros ainda a caminho (esperados antes de ligar à mensagem). */
  pending: Promise<unknown>[];
};
/** Uma vez nova (a conversa pode ainda não existir). */
export const newTurn = (conversation: string | null): CostTurn => ({
  conversation,
  turn: crypto.randomUUID(),
  entries: [],
  pending: [],
});
/** Onde o gasto aconteceu (o escopo da pergunta). */
export const whereOf = (ctx: {
  company: string;
  scope: { module?: string; client?: string; contract?: string; project?: string };
}): Where => ({
  company: ctx.company,
  module: ctx.scope.module,
  client: ctx.scope.client ?? null,
  contract: ctx.scope.contract ?? null,
  project: ctx.scope.project ?? null,
});
/**
 * O passo a passo da resposta: cada rodada do modelo, cada ferramenta e de
 * onde veio a entrada da primeira rodada (estimativa pelo tamanho de cada
 * parte, somando o que o provedor contou).
 */
export type TurnDetail = {
  rounds: {
    model: string;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    cost: number;
    tools: string[];
  }[];
  tools: { tool: string; label: string; ok: boolean; ms: number; cost: number }[];
  /** Tokens da 1ª rodada por parte (≈). */
  prompt: { question: number; extras: number; history: number; instructions: number; context: number };
  /** Tokens de saída de todas as rodadas e quanto disso é o texto da resposta (≈). */
  output: number;
  answer: number;
};
/** O resumo da vez por modelo (vai na resposta para a tela). */
export type TurnCost = {
  detail?: TurnDetail;
  /** O gasto por uso (resposta, busca nos vetores, imagem, anexos, resumo…). */
  kinds: { kind: string; cost: number }[];
  cost: number;
  models: {
    model: string;
    /** O nome do provedor (null: o padrão do servidor). */
    provider: string | null;
    kinds: string[];
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    embedding: number;
    cost: number;
  }[];
};

type Env = { supabaseUrl: string; supabaseKey: string };
type Where = {
  company: string;
  module?: string;
  client?: string | null;
  contract?: string | null;
  project?: string | null;
};

/** As linhas de um medidor: uma por modelo que respondeu. */
export function meterEntries(
  kind: string,
  meter: Meter,
  provider: string | null,
  fallbackModel = "",
  providerName: string | null = null,
): CostEntry[] {
  const models = Object.entries(meter.byModel ?? {}).filter(
    ([, u]) => u.input || u.output || u.cacheRead || u.cacheWrite || u.cost,
  );
  // Sem a divisão por modelo (ou sem gasto), uma linha só: a chamada conta.
  if (!models.length)
    return [
          {
            kind,
            model: meter.model || fallbackModel,
            provider,
            input: meter.input,
            output: meter.output,
            cacheRead: meter.cacheRead,
            cacheWrite: meter.cacheWrite,
            embedding: 0,
            cost: meter.cost,
            providerName,
          },
        ];
  return models.map(([model, u]) => ({ kind, model, provider, providerName, embedding: 0, ...u }));
}

/** Registra um gasto (nunca atrapalha a resposta) e guarda na vez. */
export async function logCost(
  env: Env,
  fetchImpl: typeof fetch,
  auth: string,
  where: Where,
  entry: CostEntry,
  turn?: CostTurn | null,
  attachment?: string | null,
) {
  if (turn) turn.entries.push(entry);
  const work = callRpc(env, fetchImpl, auth, "ai_log_usage", {
    p_company: where.company,
    p_module: where.module ?? "assistant",
    p_kind: entry.kind,
    p_client: where.client ?? null,
    p_contract: where.contract ?? null,
    p_project: where.project ?? null,
    p_recording: null,
    p_model: entry.model,
    p_input: Math.round(entry.input),
    p_output: Math.round(entry.output),
    p_cache_read: Math.round(entry.cacheRead),
    p_cache_write: Math.round(entry.cacheWrite),
    p_embedding: Math.round(entry.embedding),
    p_cost: Math.round(entry.cost * 1e6) / 1e6,
    ...(entry.provider ? { p_provider: entry.provider } : {}),
    // Antes da migração 20261224090000 estes não existem: só vão quando há.
    ...(turn?.conversation ? { p_conversation: turn.conversation } : {}),
    ...(turn ? { p_turn: turn.turn } : {}),
    ...(attachment ? { p_attachment: attachment } : {}),
  })
    .then(async (r) => {
      // Banco sem a migração: registra do jeito antigo, sem a conversa.
      if (!r.ok && r.status === 404 && (turn || attachment))
        await callRpc(env, fetchImpl, auth, "ai_log_usage", {
          p_company: where.company,
          p_module: where.module ?? "assistant",
          p_kind: entry.kind,
          p_client: where.client ?? null,
          p_contract: where.contract ?? null,
          p_project: where.project ?? null,
          p_recording: null,
          p_model: entry.model,
          p_input: Math.round(entry.input),
          p_output: Math.round(entry.output),
          p_cache_read: Math.round(entry.cacheRead),
          p_cache_write: Math.round(entry.cacheWrite),
          p_embedding: Math.round(entry.embedding),
          p_cost: Math.round(entry.cost * 1e6) / 1e6,
          ...(entry.provider ? { p_provider: entry.provider } : {}),
        });
    })
    .catch(() => {});
  turn?.pending.push(work);
  await work;
}

/** O resumo da vez por modelo (e pelo provedor, quando o mesmo modelo vem de dois). */
export function turnCost(entries: CostEntry[]): TurnCost {
  const models = new Map<string, TurnCost["models"][number]>();
  for (const e of entries) {
    const key = `${e.provider ?? ""}|${e.model}`;
    const m = models.get(key) ?? {
      model: e.model,
      provider: e.providerName ?? null,
      kinds: [],
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      embedding: 0,
      cost: 0,
    };
    m.input += e.input;
    m.output += e.output;
    m.cacheRead += e.cacheRead;
    m.cacheWrite += e.cacheWrite;
    m.embedding += e.embedding;
    m.cost += e.cost;
    if (!m.kinds.includes(e.kind)) m.kinds.push(e.kind);
    models.set(key, m);
  }
  const list = [...models.values()].sort((a, b) => b.cost - a.cost);
  const kinds = new Map<string, number>();
  for (const e of entries) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + e.cost);
  return {
    kinds: [...kinds.entries()]
      .map(([kind, cost]) => ({ kind, cost: Math.round(cost * 1e6) / 1e6 }))
      .sort((a, b) => b.cost - a.cost),
    cost: Math.round(list.reduce((n, m) => n + m.cost, 0) * 1e6) / 1e6,
    models: list.map((m) => ({ ...m, cost: Math.round(m.cost * 1e6) / 1e6 })),
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** O passo a passo da resposta a partir das rodadas, das ferramentas e do tamanho de cada parte. */
export function turnDetail(input: {
  rounds: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; tools: string[] }[];
  tools: { tool: string; label?: string; ok: boolean; ms: number; cost: number }[];
  /** Caracteres de cada parte da 1ª rodada. */
  parts: TurnDetail["prompt"];
  answerChars: number;
}): TurnDetail {
  const first = input.rounds[0];
  const total = first ? first.input + first.cacheRead + first.cacheWrite : 0;
  const chars = Object.values(input.parts).reduce((n, v) => n + v, 0) || 1;
  const share = (v: number) => Math.round((total * v) / chars);
  const output = input.rounds.reduce((n, r) => n + r.output, 0);
  return {
    rounds: input.rounds.slice(0, 30).map((r) => ({
      model: r.model.slice(0, 80),
      input: r.input,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
      output: r.output,
      cost: round6(r.cost),
      tools: r.tools.slice(0, 12).map((t) => t.slice(0, 80)),
    })),
    tools: input.tools.slice(0, 60).map((t) => ({
      tool: t.tool.slice(0, 80),
      label: (t.label ?? t.tool).slice(0, 140),
      ok: t.ok,
      ms: Math.round(t.ms),
      cost: round6(t.cost),
    })),
    prompt: {
      question: share(input.parts.question),
      extras: share(input.parts.extras),
      history: share(input.parts.history),
      instructions: share(input.parts.instructions),
      context: share(input.parts.context),
    },
    output,
    // Português tem ~3,5 caracteres por token; o resto da saída é raciocínio e pedidos de ferramentas.
    answer: Math.min(output, Math.round(input.answerChars / 3.5)),
  };
}

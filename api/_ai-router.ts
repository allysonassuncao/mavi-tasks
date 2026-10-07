import { waitUntil } from "@vercel/functions";
import { callRpc } from "./_drive.js";
import { CATALOG, type ProviderModel } from "../src/ai-providers.js";
import type { AgentRequest, LlmAdapter } from "./_ai-llm.js";

/**
 * MAVI · roteador de modelos (pedido de 06/10/2026).
 *
 * Antes de responder, o roteador lê o pedido (tipo de tarefa, complexidade,
 * tamanho do contexto, ferramentas, anexos, tela) e escolhe, entre os
 * modelos da biblioteca (e os da Claude do servidor), o que atende com o
 * menor custo e a menor espera para o nível de custo da empresa. Depois de
 * responder, registra a decisão com a latência, o custo e o sucesso das
 * ferramentas (ai_route_decisions); o 👍/👎 e a autoavaliação se ligam pela
 * mensagem e alimentam o ranking interno (ai_route_stats).
 *
 * Fase 1 (modo sombra): o roteador decide e registra o que escolheria, mas
 * quem responde continua sendo a regra de "Quem usa qual modelo" (ou o
 * padrão do servidor). As regras de pessoa, cliente, produto, projeto,
 * funcionalidade e skill são "modelo travado"; a da empresa é só o padrão.
 *
 * Tudo aqui é puro (sem rede), menos candidates e logDecision.
 */

export type TaskType =
  | "conversa"
  | "consulta"
  | "busca"
  | "analise"
  | "redacao"
  | "planejamento"
  | "acao"
  | "visual"
  | "codigo"
  | "utilitario";
export const TASK_TYPES: TaskType[] = [
  "conversa",
  "consulta",
  "busca",
  "analise",
  "redacao",
  "planejamento",
  "acao",
  "visual",
  "codigo",
  "utilitario",
];
export type Complexity = 1 | 2 | 3;
export type Tier = 1 | 2 | 3;
export type CostLevel = "economico" | "equilibrado" | "maxima";
/** O nível sem configuração: modelo forte só no que é complexo (fase 2: o administrador escolhe). */
export const DEFAULT_LEVEL: CostLevel = "equilibrado";
export type LatencyClass = "rapida" | "normal" | "longa";
export type Modality = "text" | "image" | "document" | "audio";

export type RouteInput = {
  question: string;
  /** Onde a pessoa conversa: bubble, page, campaigns, whatsapp, meetings, task_search… */
  surface: string;
  /** A funcionalidade de "Quem usa qual modelo" (assistant, mavi_page, task_search…). */
  feature: string;
  historyChars?: number;
  /** Instruções + contexto que vão junto (para estimar o tamanho). */
  contextChars?: number;
  attachments?: { images?: number; documents?: number; audio?: number };
  /** Ferramentas oferecidas nesta resposta (as das conexões MCP contam também). */
  toolCount?: number;
  mcpTools?: number;
  /** Skills escolhidas na caixa de mensagem. */
  skills?: number;
  /** Resposta estruturada e curta (título, filtros, reordenação): um utilitário. */
  structured?: boolean;
};

export type RouteSignals = {
  taskType: TaskType;
  complexity: Complexity;
  modalities: Modality[];
  contextTokens: number;
  tools: boolean;
  latency: LatencyClass;
  /** O que pesou na classificação (para o painel e os testes). */
  why: string[];
};

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** As famílias de pedido, na ordem de prioridade (a primeira que casa define o tipo). */
const PATTERNS: [TaskType, RegExp][] = [
  ["visual", /\b(imagem|imagens|arte|artes|criativo|criativos|banner|logo|logotipo|desenh\w*|ilustra\w*|grafico|graficos|visualiza\w*|carrossel|thumbnail|mockup|layout)\b/],
  ["codigo", /\b(codigo|sql|regex|script|javascript|typescript|python|html|css|formula|formulas|json|webhook|endpoint|query)\b/],
  [
    "acao",
    /^(por favor,?\s*)?(crie|cria|criar|abra|abre|abrir|agende|agenda|marque|marca|mova|move|mude|muda|altere|altera|atualize|atualiza|envie|envia|mande|manda|exclua|apague|adicione|adiciona|cadastre|registre|publique|agendar|lance|lanca)\b|\b(crie|criar|cria) (uma|um|a|o|as|os) (tarefa|tarefas|evento|lembrete|campanha)\b/,
  ],
  ["planejamento", /\b(plano|planej\w*|estrategi\w*|roadmap|cronograma|passo a passo|proposta|calendario editorial|funil|go.to.market|okr|okrs|metas para)\b/],
  [
    "analise",
    /\b(analis\w*|analise|compar\w*|diagnostic\w*|por que|porque caiu|tendencia\w*|desempenho|performance|roas|cpa|cpl|ctr|cpm|metric\w*|avali\w*|insight\w*|causa\w*|otimiz\w*|melhor (campanha|anuncio|criativo)|pior)\b/,
  ],
  [
    "redacao",
    /\b(escrev\w*|redij\w*|redigir|reescrev\w*|copy|copys|legenda\w*|roteiro\w*|resum\w*|traduz\w*|revis\w*|headline\w*)\b|\b(um|uma|o|a) (e-?mail|texto|mensagem|post|artigo) (para|ao|a|pro|sobre|de)\b/,
  ],
  [
    "busca",
    /\b(combinad\w*|falad\w*|decidid\w*|prometid\w*|reuniao|reunioes|gravac\w*|whatsapp|historico|conversas?|grupo|encontr\w*|procur\w*|busqu\w*|ache)\b/,
  ],
];
const GREETING = /^(oi|ola|opa|bom dia|boa tarde|boa noite|obrigad[ao]|valeu|ok|beleza|show|perfeito|top|certo|entendi|blz|vlw|tudo bem)\b/;
const DEEP = /\b(detalhad\w*|aprofund\w*|minucios\w*|completo|completa|profund\w*|estrategic\w*|critic\w*|exaustiv\w*|cada um|todos os|todas as)\b/;
/** A complexidade de partida de cada tipo. */
const BASE: Record<TaskType, Complexity> = {
  conversa: 1,
  utilitario: 1,
  consulta: 1,
  busca: 2,
  redacao: 2,
  acao: 2,
  visual: 2,
  codigo: 2,
  analise: 2,
  planejamento: 3,
};
/** Telas em que a pessoa espera a resposta em poucos segundos. */
const FAST_SURFACES = new Set(["bubble", "copilot", "task_search", "tutorials", "dashboard", "skill_coach", "personal_radar"]);
/** Cerca de 3,6 caracteres por token em português. */
export const tokensOf = (chars: number) => Math.ceil(Math.max(0, chars) / 3.6);

/** Lê o pedido: tipo, complexidade, tamanho, ferramentas e a espera que a tela aceita. */
export function classify(input: RouteInput): RouteSignals {
  const q = fold(input.question.trim());
  const why: string[] = [];
  const att = input.attachments ?? {};
  const modalities: Modality[] = ["text"];
  if (att.images) modalities.push("image");
  if (att.documents) modalities.push("document");
  if (att.audio) modalities.push("audio");
  const matched = PATTERNS.filter(([, re]) => re.test(q)).map(([t]) => t);
  let taskType: TaskType;
  if (input.structured) taskType = "utilitario";
  else if (q.length <= 40 && GREETING.test(q) && !matched.length) taskType = "conversa";
  else if (matched.length) taskType = matched[0];
  // As conversas das reuniões e do WhatsApp são buscas no histórico.
  else if (["meetings", "meeting", "whatsapp"].includes(input.surface)) taskType = "busca";
  else taskType = "consulta";
  why.push(`tipo: ${taskType}${matched.length > 1 ? ` (também ${matched.slice(1).join(", ")})` : ""}`);

  let c: number = BASE[taskType];
  if (taskType !== "utilitario" && taskType !== "conversa") {
    if (q.length > 700) (c++, why.push("pedido longo"));
    const asks = (q.match(/\?/g) ?? []).length + (q.match(/(^|\n)\s*(\d+[.)]|[-•*])\s+/g) ?? []).length;
    if (matched.length >= 3 || asks >= 3) (c++, why.push("vários pedidos juntos"));
    if (DEEP.test(q)) (c++, why.push("pede profundidade"));
    if ((input.skills ?? 0) > 0 && c < 2) (c = 2, why.push("skill escolhida"));
    if ((att.documents ?? 0) + (att.images ?? 0) > 0 && (taskType === "analise" || taskType === "planejamento"))
      (c++, why.push("anexos para analisar"));
    if (q.length < 60 && !DEEP.test(q) && (taskType === "consulta" || taskType === "busca") && matched.length <= 1)
      (c = Math.min(c, taskType === "busca" ? 2 : 1), why.push("pergunta curta"));
  }
  const complexity = Math.max(1, Math.min(3, c)) as Complexity;
  const contextTokens = tokensOf(input.question.length + (input.historyChars ?? 0) + (input.contextChars ?? 0));
  const tools = (input.toolCount ?? 0) > 0;
  const latency: LatencyClass = FAST_SURFACES.has(input.surface) ? "rapida" : "normal";
  return { taskType, complexity, modalities, contextTokens, tools, latency, why };
}

// ------------------------------------------------------------ modelos
export type ModelProfile = {
  tier: Tier;
  vision: boolean;
  tools: boolean;
  /** Janela de contexto, em milhares de tokens. */
  contextK: number;
  /** Só transcrição/voz: nunca responde conversa. */
  speechOnly: boolean;
};

/**
 * A faixa de cada modelo pelo nome (e, sem pistas, pelo preço de saída):
 * 1 rápido e barato, 2 intermediário, 3 o melhor raciocínio.
 */
export function modelProfile(kind: string, id: string, price?: ProviderModel | null): ModelProfile {
  // No OpenRouter o nome vem com o dono na frente (anthropic/claude-…).
  const m = fold(id).split("/").pop()!.replace(/\./g, "-");
  const speechOnly =
    kind === "deepgram" ||
    kind === "assemblyai" ||
    /(whisper|transcribe|voxtral|tts|embedding|nova-\d|universal|slam-|dall-e|gpt-image|imagen|flux)/.test(m);
  let tier: Tier;
  if (/(haiku|(^|-)mini\b|nano|flash-lite|-lite|small|instant|gemma|\b(1|3|7|8)b\b|-8b|-7b|-3b)/.test(m)) tier = 1;
  else if (/(opus|fable|mythos|gpt-5(-\d+)?(-pro)?$|gpt-5(-\d+)?-pro|^o1$|^o3(-pro)?$|gemini-[\d-]+-pro|ultra|grok-4(?!.*(fast|mini))|reasoner|r1\b|large)/.test(m))
    tier = 3;
  else if (/(sonnet|gpt-4|flash|medium|grok|deepseek|llama|qwen|mistral|command)/.test(m)) tier = 2;
  else tier = !price ? 2 : price.output >= 15 ? 3 : price.output >= 3 ? 2 : 1;
  const vision =
    kind === "anthropic" ||
    /claude|gemini|gpt-4o|gpt-4-1|gpt-5|^o3|grok-4|vision|pixtral|llama-4|qwen.*vl/.test(m);
  const tools = !/(reasoner|^o1-mini|r1\b)/.test(m);
  const contextK = /gemini|gpt-4-1|llama-4/.test(m) ? 1000 : /gpt-5/.test(m) ? 400 : /claude/.test(m) || kind === "anthropic" ? 200 : 128;
  return { tier, vision, tools, contextK, speechOnly };
}

export type Candidate = {
  /** null: a Claude do servidor (ANTHROPIC_API_KEY). */
  providerId: string | null;
  provider: string;
  kind: string;
  model: string;
  price: ProviderModel | null;
};

/** A Claude do servidor oferece os modelos de tabela da Anthropic. */
export function serverCandidates(hasKey: boolean): Candidate[] {
  if (!hasKey) return [];
  const claude = CATALOG.find((c) => c.kind === "anthropic");
  return (claude?.models ?? []).map((m) => ({
    providerId: null,
    provider: "Servidor",
    kind: "anthropic",
    model: m.id,
    price: m,
  }));
}

/** Os provedores ativos da empresa (sem as chaves), para quem conversa. */
export async function candidates(
  env: { supabaseUrl: string; supabaseKey: string },
  fetchImpl: typeof fetch,
  auth: string,
  company: string,
  hasServerKey: boolean,
): Promise<Candidate[]> {
  const r = await callRpc<{ provider_id: string; name: string; kind: string; models: ProviderModel[] }[]>(
    env,
    fetchImpl,
    auth,
    "ai_route_candidates",
    { p_company: company },
  ).catch(() => null);
  const library =
    r?.ok && Array.isArray(r.data)
      ? r.data.flatMap((p) =>
          (Array.isArray(p.models) ? p.models : []).map((m) => ({
            providerId: p.provider_id,
            provider: p.name,
            kind: p.kind,
            model: m.id,
            price: m,
          })),
        )
      : [];
  return [...library, ...serverCandidates(hasServerKey)];
}

// ------------------------------------------------------------ decisão
/** O desempenho real de um modelo num tipo de tarefa, na empresa (fase 4). */
export type RouteStat = {
  model: string;
  taskType: TaskType;
  n: number;
  /** 0 a 1: 👍, autoavaliação aprovada, ferramentas sem erro. */
  quality: number;
};
/** Abaixo disso, vale a nota inicial da faixa. */
export const MIN_STAT_SAMPLES = 20;

/** A faixa mínima: o nível de custo × a complexidade do pedido. */
const NEED: Record<CostLevel, [Tier, Tier, Tier]> = {
  economico: [1, 1, 2],
  equilibrado: [1, 2, 3],
  maxima: [2, 3, 3],
};
/** Respostas típicas (tokens de saída) para estimar o custo. */
const OUTPUT: Record<TaskType, number> = {
  conversa: 150,
  utilitario: 300,
  consulta: 600,
  busca: 900,
  acao: 500,
  redacao: 1200,
  visual: 900,
  codigo: 1500,
  analise: 1800,
  planejamento: 2500,
};
/**
 * Sem amostras da empresa, todo modelo que atende a faixa vale o mesmo; só
 * a Máxima qualidade dá um bônus a cada faixa acima da necessária (no
 * Equilibrado, um bônus pequeno desempata).
 */
const PRIOR = 0.85;
const TIER_BONUS: Record<CostLevel, number> = { economico: 0, equilibrado: 0.02, maxima: 0.08 };
const PRIOR_BELOW = 0.25;
const WEIGHTS: Record<CostLevel, { cost: number; wait: number }> = {
  economico: { cost: 0.5, wait: 0.05 },
  equilibrado: { cost: 0.2, wait: 0.05 },
  maxima: { cost: 0.02, wait: 0.02 },
};

export function needTier(signals: RouteSignals, level: CostLevel): Tier {
  let need = NEED[level][signals.complexity - 1];
  // Muitas ferramentas (conexões, skills): os modelos pequenos erram a chamada.
  if (signals.tools && signals.taskType !== "conversa" && signals.complexity >= 2 && need < 2) need = 2;
  return need as Tier;
}

/** Quanto deve custar a resposta neste modelo (US$), com o contexto e a saída típica. */
export function estimateCost(c: Candidate, signals: RouteSignals) {
  if (!c.price) return 0;
  return (signals.contextTokens * c.price.input + OUTPUT[signals.taskType] * c.price.output) / 1e6;
}

export type Scored = {
  provider: string;
  providerId: string | null;
  model: string;
  tier: Tier;
  est: number;
  score: number;
  /** Por que ficou de fora (quando ficou). */
  out?: string;
};
export type RouteDecision = {
  mode: "auto" | "locked";
  /** O escopo da regra que travou (pessoa, cliente…), quando travou. */
  lockedBy: string | null;
  needTier: Tier;
  /** O que o roteador escolheria. */
  suggested: Candidate | null;
  suggestedTier: Tier | null;
  reason: string;
  scored: Scored[];
};

/** As regras de "Quem usa qual modelo" que travam o modelo (a da empresa é só o padrão). */
export const LOCKING_SCOPES = new Set(["user", "client", "contract", "project", "feature", "skill"]);
const SCOPE_LABEL: Record<string, string> = {
  user: "pessoa",
  client: "cliente",
  contract: "produto",
  project: "projeto",
  feature: "funcionalidade",
  skill: "skill",
};
const usd = (n: number) => `US$ ${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`.replace(".", ",");
const TYPE_LABEL: Record<TaskType, string> = {
  conversa: "Conversa",
  consulta: "Consulta",
  busca: "Busca no histórico",
  analise: "Análise",
  redacao: "Redação",
  planejamento: "Planejamento",
  acao: "Ação",
  visual: "Visual",
  codigo: "Código",
  utilitario: "Utilitário",
};

/**
 * Escolhe o modelo: entre os que cabem (contexto, ferramentas, imagens), o
 * de melhor nota com a faixa necessária; a nota é a qualidade (a real da
 * empresa quando há amostras, senão a da faixa) menos o custo e a espera
 * pelo peso do nível. Nenhum atende a faixa: o de faixa mais alta.
 */
export function decide(input: {
  signals: RouteSignals;
  level: CostLevel;
  candidates: Candidate[];
  /** A regra de "Quem usa qual modelo" que vale agora (com o escopo dela). */
  lockedScope?: string | null;
  stats?: RouteStat[];
  /** As imagens vão direto ao modelo (fase 3): exige um que enxergue. */
  nativeImages?: boolean;
}): RouteDecision {
  const { signals, level } = input;
  const need = needTier(signals, level);
  const w = WEIGHTS[level];
  const seen = new Set<string>();
  const pool = input.candidates.filter((c) => {
    const key = `${c.providerId ?? "server"}|${c.model}`;
    return !seen.has(key) && seen.add(key);
  });
  const rows = pool.map((c) => {
    const p = modelProfile(c.kind, c.model, c.price);
    const est = estimateCost(c, signals);
    let out: string | undefined;
    if (p.speechOnly) out = "não conversa";
    else if (signals.contextTokens > p.contextK * 1000 * 0.8) out = "contexto não cabe";
    else if (signals.tools && !p.tools) out = "sem ferramentas";
    else if (input.nativeImages && signals.modalities.includes("image") && !p.vision) out = "não enxerga imagens";
    const stat = input.stats?.find((s) => s.model === c.model && s.taskType === signals.taskType);
    const quality =
      stat && stat.n >= MIN_STAT_SAMPLES
        ? stat.quality
        : p.tier >= need
          ? PRIOR + TIER_BONUS[level] * (p.tier - need)
          : PRIOR - PRIOR_BELOW * (need - p.tier);
    return { c, p, est, out, quality };
  });
  const fit = rows.filter((r) => !r.out);
  const maxEst = Math.max(1e-9, ...fit.map((r) => r.est));
  const score = (r: (typeof rows)[number]) =>
    r.quality -
    w.cost * (r.est / maxEst) -
    // Espera: na tela rápida, os modelos maiores demoram mais para a primeira palavra.
    w.wait * (signals.latency === "rapida" ? r.p.tier - 1 : 0);
  const meets = fit.filter((r) => r.p.tier >= need);
  const ranked = (meets.length ? meets : fit).map((r) => ({ r, s: score(r) }));
  ranked.sort((a, b) => (meets.length ? b.s - a.s : b.r.p.tier - a.r.p.tier || b.s - a.s) || a.r.est - b.r.est);
  const best = ranked[0]?.r ?? null;
  const scored: Scored[] = rows
    .map((r) => ({
      provider: r.c.provider,
      providerId: r.c.providerId,
      model: r.c.model,
      tier: r.p.tier,
      est: Math.round(r.est * 1e6) / 1e6,
      score: r.out ? -1 : Math.round(score(r) * 1000) / 1000,
      ...(r.out ? { out: r.out } : r.p.tier < need ? { out: "faixa abaixo da necessária" } : {}),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  const lockedBy = input.lockedScope && LOCKING_SCOPES.has(input.lockedScope) ? input.lockedScope : null;
  const head = `${TYPE_LABEL[signals.taskType]}, complexidade ${signals.complexity} → faixa ${need}`;
  const reason = !best
    ? `${head}; nenhum modelo da biblioteca atende`
    : `${head}; ${best.c.model} (${best.c.provider}) ${meets.length ? "tem a melhor nota entre os que atendem" : "é o mais forte disponível"}, ~${usd(best.est)}` +
      (lockedBy ? `; travado pela regra de ${SCOPE_LABEL[lockedBy]}` : "");
  return {
    mode: lockedBy ? "locked" : "auto",
    lockedBy,
    needTier: need,
    suggested: best?.c ?? null,
    suggestedTier: best?.p.tier ?? null,
    reason,
    scored,
  };
}

// ------------------------------------------------------------ registro
/** O que aconteceu na resposta (fica junto da decisão). */
export type RouteOutcome = {
  usedProviderId: string | null;
  usedModel: string;
  firstTokenMs: number | null;
  totalMs: number;
  rounds?: number;
  cost: number;
  toolsOk?: number;
  toolsFailed?: number;
  capped?: boolean;
  error?: string | null;
};

export type RouteWhere = {
  company: string;
  surface: string;
  feature: string;
  client?: string | null;
  conversation?: string | null;
  message?: number | null;
};

/** O registro de uma decisão (nunca atrapalha a resposta). */
export function logDecision(
  env: { supabaseUrl: string; supabaseKey: string },
  fetchImpl: typeof fetch,
  auth: string,
  where: RouteWhere,
  signals: RouteSignals,
  decision: RouteDecision,
  outcome: RouteOutcome,
) {
  return callRpc<number>(env, fetchImpl, auth, "ai_route_log", {
    p_company: where.company,
    p_entry: {
      surface: where.surface,
      feature: where.feature,
      client_id: where.client ?? null,
      conversation_id: where.conversation ?? null,
      message_id: where.message ?? null,
      task_type: signals.taskType,
      complexity: signals.complexity,
      modalities: signals.modalities,
      context_tokens: signals.contextTokens,
      latency_class: signals.latency,
      why: signals.why,
      mode: decision.mode,
      locked_by: decision.lockedBy,
      need_tier: decision.needTier,
      suggested_provider_id: decision.suggested?.providerId ?? null,
      suggested_model: decision.suggested?.model ?? null,
      reason: decision.reason,
      candidates: decision.scored,
      used_provider_id: outcome.usedProviderId,
      used_model: outcome.usedModel,
      first_token_ms: outcome.firstTokenMs,
      total_ms: outcome.totalMs,
      rounds: outcome.rounds ?? null,
      cost_usd: Math.round(Math.max(0, outcome.cost) * 1e6) / 1e6,
      tools_ok: outcome.toolsOk ?? 0,
      tools_failed: outcome.toolsFailed ?? 0,
      capped: !!outcome.capped,
      error: outcome.error ? outcome.error.slice(0, 300) : null,
    },
  }).catch(() => null);
}

/** Quem conversa, onde, e o que responde (para o registro em sombra). */
export type ProbeOptions = {
  env: { supabaseUrl: string; supabaseKey: string };
  fetch: typeof fetch;
  auth: string;
  where: Omit<RouteWhere, "message" | "conversation">;
  /** O provedor e o modelo que respondem (a regra ou o servidor). */
  used: { providerId: string | null; model: string; scope?: string | null };
  /** A pergunta da pessoa (sem as instruções da tela). */
  question: string;
  structured?: boolean;
  level?: CostLevel;
  hasServerKey: boolean;
  /** Para os testes: sem registrar. */
  log?: typeof logDecision;
  /** O registro segue depois da resposta (na Vercel, waitUntil). */
  later?: (work: Promise<unknown>) => void;
};

/**
 * Uma resposta acompanhada pelo roteador (sombra), para quem chama o modelo
 * do seu jeito: classifica na hora, marca a primeira palavra e, no fim,
 * registra a decisão com a espera, o custo e o resultado.
 */
export function routeProbe(
  opts: ProbeOptions,
  size: { historyChars?: number; contextChars?: number; toolCount?: number } = {},
) {
  const started = Date.now();
  let first: number | null = null;
  const later = opts.later ?? ((work: Promise<unknown>) => waitUntil(work.catch(() => {})));
  const pool = candidates(opts.env, opts.fetch, opts.auth, opts.where.company, opts.hasServerKey);
  const signals = classify({
    question: opts.question,
    surface: opts.where.surface,
    feature: opts.where.feature,
    structured: opts.structured,
    ...size,
  });
  let done = false;
  return {
    signals,
    /** Chegou um pedaço do texto da resposta. */
    text() {
      if (first === null) first = Date.now() - started;
    },
    /** Terminou (ou falhou): o registro segue em segundo plano. */
    finish(outcome: { model?: string; cost: number; rounds?: number; toolsOk?: number; toolsFailed?: number; capped?: boolean; error?: string | null }) {
      if (done) return;
      done = true;
      const totalMs = Date.now() - started;
      const firstTokenMs = first;
      later(
        pool.then((list) =>
          (opts.log ?? logDecision)(
            opts.env,
            opts.fetch,
            opts.auth,
            opts.where,
            signals,
            decide({ signals, level: opts.level ?? DEFAULT_LEVEL, candidates: list, lockedScope: opts.used.scope ?? null }),
            {
              usedProviderId: opts.used.providerId,
              usedModel: outcome.model || opts.used.model,
              firstTokenMs,
              totalMs,
              rounds: outcome.rounds,
              cost: outcome.cost,
              toolsOk: outcome.toolsOk,
              toolsFailed: outcome.toolsFailed,
              capped: outcome.capped,
              error: outcome.error ?? null,
            },
          ),
        ),
      );
    },
  };
}

/**
 * Para as telas de uma chamada só (Busca avançada, Dashboards, Tutoriais…):
 * embrulha o adaptador, classifica o pedido, mede a espera e registra a
 * decisão em sombra. A resposta não muda.
 */
export function routedLlm(llm: LlmAdapter, opts: ProbeOptions): LlmAdapter {
  return async (request: AgentRequest) => {
    const probe = routeProbe(opts, {
      historyChars: request.messages.slice(0, -1).reduce((n, m) => n + m.content.length, 0),
      contextChars: request.instructions.length + request.context.length,
      toolCount: request.tools.length,
    });
    try {
      const result = await llm({
        ...request,
        onEvent: (e) => {
          if (e.type === "text") probe.text();
          request.onEvent?.(e);
        },
      });
      probe.finish({ model: result.meter.model, rounds: result.rounds, cost: result.meter.cost, capped: result.capped });
      return result;
    } catch (e) {
      probe.finish({ cost: 0, error: (e as Error).message ?? "falhou" });
      throw e;
    }
  };
}

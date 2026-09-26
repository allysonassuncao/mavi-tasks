import Anthropic from "@anthropic-ai/sdk";
import { callRpc } from "./_drive.js";
import { defaultLookup, gatherBrand, type Lookup } from "./_brand-colors.js";
import {
  briefingAiKeys,
  briefingReadiness,
  briefingSteps,
  campaignObjectives,
  cleanBriefingSuggestion,
  type BriefingFields,
  type BriefingKey,
  type CampaignObjective,
  type PlanContent,
} from "../src/social-leads.js";

/**
 * Onboarding › Social Leads: the plan of the month written by Claude.
 *
 * - "generate" opens a job in the database (one per contracted product),
 *   answers at once and keeps working after the response (waitUntil): Claude
 *   writes the plan in the artifact's contract (structured output), may read
 *   the client's site first (web fetch/search run on Anthropic's side), and
 *   the database checks the structure again when saving. A structure the
 *   database refuses is asked again once, with the reason. The page hears
 *   the result live (Realtime), so closing the tab loses nothing.
 * - "adjust" returns the partial update of the chat importer for one request
 *   of the team ("deixe o post 6 mais leve"); the page shows what changes
 *   and applies it like an import.
 * - "colors" reads the client's site and/or Instagram (api/_brand-colors.ts)
 *   and has Claude pick the brand palette from the real colours and images.
 * - "briefing" reads notes, a transcript (pasted or from a file) or a
 *   meeting of the client in "Gravações da MAVI" and returns the briefing
 *   fields it answers, each with the passage it came from; the page shows
 *   them for the team to choose what goes in.
 *
 * Every call to Claude is metered (tokens and dollars, including failed
 * attempts) and recorded in social_leads_ai_usage, so each plan shows what
 * the AI cost.
 *
 * Every database call runs as the signed-in person (their token), so the
 * database functions decide who may do what.
 */

export type SocialLeadsEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  anthropicKey: string;
  model: string;
  /** How long a generation may take before it is given up (ms). */
  deadlineMs: number;
};
export function socialLeadsEnv(
  env: Record<string, string | undefined> = process.env,
): SocialLeadsEnv {
  return {
    supabaseUrl:
      env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co",
    supabaseKey:
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
    anthropicKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.SOCIAL_LEADS_MODEL || "claude-opus-5",
    // The function may run for 300 s (vercel.json); stop a little before.
    deadlineMs: Number(env.SOCIAL_LEADS_DEADLINE_MS) || 280_000,
  };
}

export class SocialLeadsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
export type Deps = {
  fetch: Fetch;
  /** The model call, replaced in tests. */
  complete: (
    env: SocialLeadsEnv,
    request: ModelRequest,
    signal: AbortSignal,
    meter: Meter,
  ) => Promise<string>;
  /** DNS for the colour search (checks addresses are public). */
  lookup?: Lookup;
  /** Keeps the work going after the response (Vercel's waitUntil). */
  background: (work: Promise<unknown>) => void;
};

async function rpc<T>(
  env: SocialLeadsEnv,
  deps: Deps,
  auth: string | null,
  name: string,
  args: Record<string, unknown>,
) {
  const r = await callRpc<T>(env, deps.fetch, auth, name, args);
  if (!r.ok) throw new SocialLeadsError(r.status, r.error);
  return r.data;
}

// ------------------------------------------------------------ the prompt
export const SYSTEM_PROMPT = `Você é estrategista de conteúdo da agência e monta o plano mensal do produto Social Leads: gestão de Instagram e Facebook com tráfego pago no Meta, para negócios com verba de mídia pequena. A prioridade do cliente é, nesta ordem: leads qualificados, rede social com autoridade, novos seguidores.

Cada mês tem até 8 postagens orgânicas; exatamente uma delas também vira o criativo do anúncio pago. O plano tem: diagnóstico, SWOT, exatamente 4 pilares de conteúdo, público, 8 posts numerados de 1 a 8 e a especificação da campanha.

Regras obrigatórias:
1. Nunca invente depoimento, nome de cliente, número de alunos, citação ou caso como prova social. Sem "socialProof" no briefing, use situações genéricas e verídicas e inclua um alerta pedindo a captação de depoimentos reais.
2. Nunca prometa número de leads, vendas, receita, ganho, faixa de ganho, prazo de resultado ("em 30 dias você…") nem use "garantido". Isso vale também para o texto que for dentro da arte.
3. As restrições do campo "notes" valem em TODAS as peças e entram também nos alertas.
4. Se "igHandle" e "fbHandle" indicarem perfil inexistente ("criar", "não tem", vazio), o PRIMEIRO alerta é o bloqueio operacional, começando com "Bloqueio:".
5. Vertical de alto escrutínio no Meta (afiliados, marketing multinível, oportunidade de renda, investimentos, crédito, seguros, saúde, estética) gera alerta de risco de rejeição ou restrição da conta de anúncios.
6. O tom segue "toneRefs".
7. Sem jargão de tráfego pago (CPL, CTR, conversão, funil, lead) nas peças orgânicas.
8. "campaignObjective" define a campanha e a peça do anúncio: "form_nativo" é formulário instantâneo nativo do Meta (liste as perguntas do formulário); "ctwa" é anúncio que abre conversa no WhatsApp (o CTA do anúncio leva ao WhatsApp e "perguntasFormulario" fica vazio).
9. Identidade visual: havendo canal real (site, Instagram, Facebook), siga o estilo que dá para observar nele; não havendo, use exatamente "brandColors", "brandLogo" e "brandVisualElements". Nunca invente cor, logo ou elemento visual. Quando a direção visual pedir texto dentro da arte, escreva o texto exato entre aspas.
10. Nunca segmente por atributo que presuma situação financeira, saúde ou característica pessoal sensível.

Posts:
- "badge" é o papel do post: "posicionar", "autoridade" ou "oferta". Equilibre os três ao longo do mês.
- "gancho" é a frase curta que abre o post; "direcaoCopy" orienta o redator; "direcaoVisual" orienta o designer; "formato" (ex.: "Carrossel", "Reels", "Imagem única"); "cta" é a chamada.
- Exatamente um post tem "ehAnuncio": true, e ele precisa funcionar como anúncio para o objetivo da campanha.

Se receber o site do cliente, você pode lê-lo com web_fetch para entender o negócio e o estilo visual. Perfis do Instagram e do Facebook costumam exigir login: se não abrirem, siga o briefing e não conclua que o perfil não existe só por isso. Escreva tudo em português do Brasil. Responda somente com o JSON do plano.`;

export type ModelRequest = {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  /** Domains web_fetch may open (none: no web tools). */
  domains: string[];
  /** Images shown before the text (the colour search). */
  images?: { media_type: string; data: string }[];
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
};

// ------------------------------------------------------------ cost
/** US$ per million tokens (input, output), first-party API prices. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5": [2, 10],
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-4-8": [5, 25],
  "claude-haiku-4-5": [1, 5],
};
export type Meter = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};
export const newMeter = (model = ""): Meter => ({
  model,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});
/** Adds one response's usage (cache writes cost 1.25x, reads 0.1x the input). */
export function addUsage(
  meter: Meter,
  model: string,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
) {
  const [inPrice, outPrice] = PRICES[model] ?? PRICES["claude-opus-5"];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  meter.model = model;
  meter.input += input;
  meter.output += output;
  meter.cacheRead += read;
  meter.cacheWrite += write;
  meter.cost +=
    (input * inPrice +
      write * inPrice * 1.25 +
      read * inPrice * 0.1 +
      output * outPrice) /
    1e6;
}
/** Records what the AI cost; never blocks the answer. */
async function logUsage(
  env: SocialLeadsEnv,
  deps: Deps,
  auth: string,
  at: {
    company: string;
    contract: string;
    plan?: string | null;
    job?: string | null;
  },
  kind: "generate" | "adjust" | "colors" | "briefing",
  m: Meter,
) {
  if (!m.input && !m.output && !m.cacheRead && !m.cacheWrite) return;
  await rpc(env, deps, auth, "social_leads_log_usage", {
    p_company: at.company,
    p_contract: at.contract,
    p_plan: at.plan ?? null,
    p_job: at.job ?? null,
    p_kind: kind,
    p_model: m.model || env.model,
    p_input: m.input,
    p_output: m.output,
    p_cache_read: m.cacheRead,
    p_cache_write: m.cacheWrite,
    p_cost: Math.round(m.cost * 1e6) / 1e6,
  }).catch(() => {});
}

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
/** The plan in the artifact's contract (without the decisions). */
export const PLAN_SCHEMA = obj({
  diagnostico: obj({ negocio: str, comoQuerSerVista: str }),
  swot: obj({ forcas: str, fraquezas: str, oportunidades: str, ameacas: str }),
  pilares: {
    type: "array",
    description: "Exatamente 4 pilares.",
    items: obj({ titulo: str, descricao: str }),
  },
  publico: str,
  posts: {
    type: "array",
    description:
      "Exatamente 8 posts, numerados de 1 a 8, e só um com ehAnuncio true.",
    items: obj({
      numero: { type: "integer" },
      badge: { type: "string", enum: ["posicionar", "autoridade", "oferta"] },
      gancho: str,
      direcaoCopy: str,
      direcaoVisual: str,
      formato: str,
      cta: str,
      ehAnuncio: { type: "boolean" },
    }),
  },
  campanha: obj({
    objetivo: str,
    regiao: str,
    idadeGenero: str,
    segmentacao: str,
    posicionamentos: str,
    orcamento: str,
    perguntasFormulario: { type: "array", items: str },
    roteamentoLead: str,
  }),
  alertas: { type: "array", items: str },
});
/** The partial update of the importer (what "Pedir ajuste à IA" returns). */
export const ADJUST_SCHEMA = obj({
  resumo: str,
  alteracoes: obj({
    posts: {
      type: "array",
      description: "Só os posts que mudam, com o número e os campos alterados.",
      items: {
        type: "object",
        properties: {
          numero: { type: "integer" },
          badge: {
            type: "string",
            enum: ["posicionar", "autoridade", "oferta"],
          },
          gancho: str,
          direcaoCopy: str,
          direcaoVisual: str,
          formato: str,
          cta: str,
          ehAnuncio: { type: "boolean" },
        },
        required: ["numero"],
        additionalProperties: false,
      },
    },
    publico: { anyOf: [str, { type: "null" }] },
    alertas: { anyOf: [{ type: "array", items: str }, { type: "null" }] },
  }),
});

const MEDIA_LABELS: Record<string, string> = {
  socialProof: "Prova social",
  brandLogo: "Logo",
  brandVisualElements: "Elementos visuais",
};
type Context = {
  job: string;
  media?: Record<string, { name: string; type: string }[]>;
  client_name: string;
  briefing: BriefingFields;
  campaign_objective: CampaignObjective | null;
  responsible: string | null;
  next_month: number;
  previous: (PlanContent & { label?: string }) | null;
};

/** Hostnames the model may fetch: the client's own site only. */
export function siteDomains(f: BriefingFields) {
  const out: string[] = [];
  const raw = (f.websiteUrl ?? "").trim();
  if (!raw) return out;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.hostname.includes("."))
      out.push(url.hostname.replace(/^www\./, ""));
  } catch {
    // Not an address (e.g. "não tem").
  }
  return out;
}

/** What Claude receives for a new month or a regeneration. */
export function planRequest(
  ctx: Context,
  kind: "new" | "current",
): ModelRequest {
  const briefing = {
    ...ctx.briefing,
    clientName: ctx.briefing.clientName || ctx.client_name,
    campaignObjective: ctx.campaign_objective,
    accountManager: ctx.responsible,
  };
  const media = Object.entries(ctx.media ?? {})
    .filter(([, list]) => list?.length)
    .map(
      ([key, list]) =>
        `${MEDIA_LABELS[key] ?? key}: ${list.map((f) => f.name).join(", ")}`,
    );
  const parts = [
    `Briefing do cliente (JSON):\n${JSON.stringify(briefing, null, 2)}`,
    ...(media.length
      ? [
          `Arquivos anexados ao briefing (a equipe tem esses arquivos; cite-os na direção visual quando fizer sentido):\n${media.join("\n")}`,
        ]
      : []),
    `Objetivo da campanha: ${ctx.campaign_objective ? campaignObjectives[ctx.campaign_objective] : "não definido: escolha o mais adequado ao negócio e explique nos alertas"}.`,
  ];
  if (kind === "current" && ctx.previous) {
    parts.push(
      `Este é um novo plano para o ${ctx.previous.label ?? "mês atual"}, substituindo o anterior. Plano anterior, com o que o cliente aprovou, reprovou e comentou (resolva os pedidos de ajuste):\n${JSON.stringify(summaryOf(ctx.previous), null, 2)}`,
    );
  } else if (ctx.previous) {
    parts.push(
      `Plano do mês anterior (${ctx.previous.label ?? ""}), com as decisões do cliente. Não repita ganchos; aproveite o que foi aprovado e evite o que foi reprovado:\n${JSON.stringify(summaryOf(ctx.previous), null, 2)}`,
    );
  }
  parts.push(
    kind === "current" && ctx.previous
      ? `Monte de novo o plano do ${ctx.previous.label ?? "mês"}.`
      : `Monte o plano do Mês ${ctx.next_month}.`,
  );
  const domains = siteDomains(ctx.briefing);
  if (domains.length)
    parts.push(`Site do cliente para consultar: ${ctx.briefing.websiteUrl}`);
  return {
    system: SYSTEM_PROMPT,
    user: parts.join("\n\n"),
    schema: PLAN_SCHEMA,
    domains,
  };
}
function summaryOf(p: PlanContent) {
  return {
    pilares: p.pilares,
    alertas: p.alertas,
    posts: p.posts.map((x) => ({
      numero: x.numero,
      badge: x.badge,
      gancho: x.gancho,
      ehAnuncio: x.ehAnuncio,
      status: x.status,
      observacao: x.observacao || undefined,
    })),
  };
}

// ------------------------------------------------------------ Claude
/** One structured answer from Claude, reading the client's site if needed. */
export async function claudeComplete(
  env: SocialLeadsEnv,
  request: ModelRequest,
  signal: AbortSignal,
  meter: Meter,
): Promise<string> {
  const client = new Anthropic({ apiKey: env.anthropicKey, maxRetries: 2 });
  const tools: Anthropic.Beta.BetaToolUnion[] = request.domains.length
    ? [
        {
          type: "web_fetch_20260209",
          name: "web_fetch",
          max_uses: 4,
          allowed_domains: request.domains,
          max_content_tokens: 20000,
        },
      ]
    : [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        ...(request.images ?? []).map(
          (i): Anthropic.Beta.BetaImageBlockParam => ({
            type: "image",
            source: {
              type: "base64",
              media_type: i.media_type as "image/png",
              data: i.data,
            },
          }),
        ),
        { type: "text", text: request.user },
      ],
    },
  ];
  // Server tools may pause a long turn: send it back to continue.
  for (let round = 0; round < 4; round++) {
    const message = await client.beta.messages
      .stream(
        {
          model: env.model,
          max_tokens: request.maxTokens ?? 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: {
            effort: request.effort ?? "high",
            format: { type: "json_schema", schema: request.schema },
          },
          system: [
            {
              type: "text",
              text: request.system,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools,
          messages,
        },
        { signal },
      )
      .finalMessage();
    addUsage(meter, message.model, message.usage);
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    if (message.stop_reason === "refusal")
      throw new SocialLeadsError(
        422,
        "A IA se recusou a escrever este plano. Revise o briefing (principalmente as observações e a oferta) e tente de novo.",
      );
    if (message.stop_reason === "max_tokens")
      throw new SocialLeadsError(
        502,
        "A resposta da IA ficou incompleta. Tente de novo.",
      );
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text)
      throw new SocialLeadsError(
        502,
        "A IA não devolveu o plano. Tente de novo.",
      );
    return text;
  }
  throw new SocialLeadsError(
    502,
    "A IA demorou demais lendo o site. Tente de novo.",
  );
}

/** A message fit for the screen, whatever failed. */
export function friendlyError(err: unknown): string {
  if (err instanceof SocialLeadsError) return err.message;
  if (err instanceof Anthropic.AuthenticationError)
    return "A chave da API da Claude (ANTHROPIC_API_KEY) foi recusada. Confira a variável na Vercel.";
  if (err instanceof Anthropic.RateLimitError)
    return "Limite de uso da API da Claude atingido. Tente de novo em alguns minutos.";
  if (err instanceof Anthropic.APIUserAbortError)
    return "A geração demorou demais e foi interrompida. Tente de novo.";
  if (err instanceof Anthropic.APIError)
    return `A API da Claude respondeu com erro (${err.status ?? "sem status"}). Tente de novo.`;
  return "Não foi possível gerar o plano. Tente de novo.";
}

// ------------------------------------------------------------ actions
export type SocialLeadsRequest =
  | {
      action: "colors";
      company: string;
      contract: string;
      website?: string | null;
      instagram?: string | null;
    }
  | {
      action: "generate";
      company: string;
      contract: string;
      plan?: string | null;
      mode: "new" | "current";
    }
  | {
      action: "adjust";
      company: string;
      contract: string;
      plan: string;
      instruction: string;
    }
  | {
      action: "briefing";
      company: string;
      contract: string;
      /** Notes or a transcript; or the meeting to read (not both). */
      text?: string | null;
      recording?: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleSocialLeads(
  body: SocialLeadsRequest,
  authorization: string | null,
  env: SocialLeadsEnv,
  deps: Deps,
): Promise<{ status: number; body: unknown }> {
  if (!authorization)
    return { status: 401, body: { error: "Entre na sua conta." } };
  if (!env.anthropicKey)
    return {
      status: 503,
      body: {
        error:
          "A IA não está configurada no servidor. Falta na Vercel: ANTHROPIC_API_KEY. Depois de salvar, faça um Redeploy.",
      },
    };
  if (!UUID.test(body?.company ?? "") || !UUID.test(body?.contract ?? ""))
    return { status: 400, body: { error: "Pedido inválido." } };
  try {
    if (body.action === "generate")
      return await generate(body, authorization, env, deps);
    if (body.action === "adjust")
      return await adjust(body, authorization, env, deps);
    if (body.action === "colors")
      return await colors(body, authorization, env, deps);
    if (body.action === "briefing")
      return await briefing(body, authorization, env, deps);
    return { status: 400, body: { error: "Ação desconhecida." } };
  } catch (err) {
    return {
      status: err instanceof SocialLeadsError ? err.status : 500,
      body: { error: friendlyError(err) },
    };
  }
}

async function generate(
  body: Extract<SocialLeadsRequest, { action: "generate" }>,
  auth: string,
  env: SocialLeadsEnv,
  deps: Deps,
) {
  if (body.mode !== "new" && body.mode !== "current")
    return { status: 400, body: { error: "Pedido inválido." } };
  if (body.mode === "current" && !UUID.test(body.plan ?? ""))
    return { status: 400, body: { error: "Plano não informado." } };
  const ctx = await rpc<Context>(env, deps, auth, "social_leads_start_job", {
    p_company: body.company,
    p_contract: body.contract,
    p_plan: body.mode === "current" ? body.plan : null,
    p_kind: body.mode,
  });
  // Same rule as the page: no channel and no colours, no plan.
  const blockers = briefingReadiness(
    ctx.briefing,
    ctx.campaign_objective,
    ctx.client_name,
  ).blockers;
  if (blockers.length) {
    await finish(env, deps, auth, ctx.job, null, blockers.join(" "));
    return { status: 422, body: { error: blockers.join(" ") } };
  }
  deps.background(run(body, ctx, auth, env, deps));
  return { status: 202, body: { job: ctx.job } };
}

async function finish(
  env: SocialLeadsEnv,
  deps: Deps,
  auth: string,
  job: string,
  plan: string | null,
  error: string | null,
) {
  await rpc(env, deps, auth, "social_leads_finish_job", {
    p_job: job,
    p_plan: plan,
    p_error: error,
  }).catch(() => {});
}

/** Writes the plan; a structure the database refuses is asked again once. */
async function run(
  body: Extract<SocialLeadsRequest, { action: "generate" }>,
  ctx: Context,
  auth: string,
  env: SocialLeadsEnv,
  deps: Deps,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.deadlineMs);
  const request = planRequest(ctx, body.mode);
  const meter = newMeter(env.model);
  const at = { company: body.company, contract: body.contract, job: ctx.job };
  try {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const ask = attempt
        ? {
            ...request,
            user: `${request.user}\n\nA resposta anterior foi recusada pela validação: ${lastError} Corrija e devolva o plano completo.`,
          }
        : request;
      const text = await deps.complete(env, ask, controller.signal, meter);
      let content: unknown;
      try {
        content = JSON.parse(text);
      } catch {
        lastError = "a resposta não era um JSON válido.";
        continue;
      }
      const saved = await callRpc<{ id: string }>(
        env,
        deps.fetch,
        auth,
        "social_leads_write_plan",
        {
          p_company: body.company,
          p_contract: body.contract,
          p_plan: body.mode === "current" ? body.plan : null,
          p_content: content,
          p_reason: "regeneração do mês",
          p_version: null,
          p_source: "ai",
          p_summary:
            body.mode === "current"
              ? "Mês regenerado pela IA"
              : "Gerado pela IA",
        },
      );
      if (saved.ok) {
        await logUsage(
          env,
          deps,
          auth,
          { ...at, plan: saved.data.id },
          "generate",
          meter,
        );
        await finish(env, deps, auth, ctx.job, saved.data.id, null);
        return;
      }
      // Permission or conflicts won't improve by asking again.
      if (saved.status !== 400)
        throw new SocialLeadsError(saved.status, saved.error);
      lastError = saved.error;
    }
    throw new SocialLeadsError(
      422,
      `O plano da IA não passou na validação: ${lastError}`,
    );
  } catch (err) {
    // What the failed attempts cost still counts (on the plan being redone).
    await logUsage(
      env,
      deps,
      auth,
      { ...at, plan: body.mode === "current" ? body.plan : null },
      "generate",
      meter,
    );
    await finish(env, deps, auth, ctx.job, null, friendlyError(err));
  } finally {
    clearTimeout(timer);
  }
}

async function adjust(
  body: Extract<SocialLeadsRequest, { action: "adjust" }>,
  auth: string,
  env: SocialLeadsEnv,
  deps: Deps,
) {
  const instruction = String(body.instruction ?? "").trim();
  if (!instruction)
    return { status: 400, body: { error: "Diga o que ajustar." } };
  if (instruction.length > 2000)
    return {
      status: 400,
      body: { error: "O pedido passou de 2.000 caracteres." },
    };
  if (!UUID.test(body.plan ?? ""))
    return { status: 400, body: { error: "Plano não informado." } };
  const ctx = await rpc<{
    client_name: string;
    briefing: BriefingFields;
    campaign_objective: CampaignObjective | null;
    plan: PlanContent & { label: string };
  }>(env, deps, auth, "social_leads_adjust_context", {
    p_company: body.company,
    p_contract: body.contract,
    p_plan: body.plan,
  });
  const request: ModelRequest = {
    system: SYSTEM_PROMPT,
    user: [
      `Briefing do cliente (JSON):\n${JSON.stringify({ ...ctx.briefing, campaignObjective: ctx.campaign_objective }, null, 2)}`,
      `Plano atual (${ctx.plan.label}):\n${JSON.stringify(ctx.plan, null, 2)}`,
      `Pedido da equipe: ${instruction}`,
      `Devolva SOMENTE o que muda, no formato de atualização parcial: em "alteracoes.posts" só os posts alterados (com "numero" e os campos que mudam); "publico" e "alertas" como null quando não mudam. Mantenha exatamente um post com ehAnuncio true no plano final. Em "resumo", uma frase dizendo o que mudou.`,
    ].join("\n\n"),
    schema: ADJUST_SCHEMA,
    domains: [],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.deadlineMs);
  const meter = newMeter(env.model);
  try {
    const text = await deps.complete(env, request, controller.signal, meter);
    const parsed = JSON.parse(text) as {
      resumo: string;
      alteracoes: Record<string, unknown>;
    };
    // Nulls mean "no change" in the importer's contract.
    const alteracoes = Object.fromEntries(
      Object.entries(parsed.alteracoes ?? {}).filter(([, v]) => v != null),
    );
    return {
      status: 200,
      body: {
        update: {
          tipo: "social-leads-atualizacao",
          cliente: ctx.briefing.clientName || ctx.client_name,
          plano: body.plan,
          resumo: parsed.resumo,
          alteracoes,
        },
        cost_usd: meter.cost,
      },
    };
  } finally {
    clearTimeout(timer);
    await logUsage(
      env,
      deps,
      auth,
      { company: body.company, contract: body.contract, plan: body.plan },
      "adjust",
      meter,
    );
  }
}

// ------------------------------------------------------------ brand colours
export const COLORS_SCHEMA = obj({
  colors: {
    type: "array",
    description: "De 1 a 6 cores da marca, da principal para a de apoio.",
    items: obj({ hex: str, name: str }),
  },
  note: str,
});

async function colors(
  body: Extract<SocialLeadsRequest, { action: "colors" }>,
  auth: string,
  env: SocialLeadsEnv,
  deps: Deps,
) {
  if (!body.website?.trim() && !body.instagram?.trim())
    return { status: 400, body: { error: "Informe o site ou o Instagram." } };
  await rpc(env, deps, auth, "social_leads_check_write", {
    p_company: body.company,
    p_contract: body.contract,
  });
  const found = await gatherBrand(
    { website: body.website, instagram: body.instagram },
    { fetch: deps.fetch, lookup: deps.lookup ?? defaultLookup },
  );
  if (!found.colors.length && !found.images.length)
    return {
      status: 422,
      body: {
        error:
          `Não consegui ler as cores. ${found.notes.join(" ")} Adicione as cores à mão.`.trim(),
      },
    };
  const request: ModelRequest = {
    system:
      "Você identifica a identidade visual de uma marca para a equipe de social media. Use só o que foi lido do site e das imagens: nunca invente cor. Escreva em português do Brasil.",
    user: [
      found.title ? `Título do site: ${found.title}` : "",
      found.sources.length ? `Lido de: ${found.sources.join(", ")}` : "",
      found.colors.length
        ? `Cores encontradas no código do site (hex: quantas vezes aparece; theme-color vem primeiro):\n${found.colors.map((c) => `${c.hex}: ${c.count}`).join("\n")}`
        : "Nenhuma cor no código; use só as imagens.",
      found.images.length
        ? `As imagens acima são o logo, o ícone ou a foto de perfil da marca.`
        : "",
      `Escolha de 1 a 6 cores que formam a paleta da marca (ignore cinzas de texto, brancos e pretos de fundo, a não ser que sejam claramente parte da identidade). Para cada uma, o hex (#rrggbb) e um nome curto em português (ex.: "Azul-marinho"). Em "note", uma frase dizendo de onde tirou as cores.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    schema: COLORS_SCHEMA,
    domains: [],
    images: found.images,
    effort: "low",
    maxTokens: 4000,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const meter = newMeter(env.model);
  try {
    const text = await deps.complete(env, request, controller.signal, meter);
    const parsed = JSON.parse(text) as {
      colors: { hex: string; name: string }[];
      note: string;
    };
    const seen = new Set<string>();
    const palette = (parsed.colors ?? [])
      .map((c) => ({
        hex: String(c.hex).trim().toLowerCase(),
        name: String(c.name ?? "").trim(),
      }))
      .filter(
        (c) =>
          /^#[0-9a-f]{6}$/.test(c.hex) && !seen.has(c.hex) && seen.add(c.hex),
      )
      .slice(0, 6);
    if (!palette.length)
      return {
        status: 422,
        body: { error: "A IA não encontrou cores de marca. Adicione à mão." },
      };
    return {
      status: 200,
      body: {
        colors: palette,
        note: parsed.note,
        warnings: found.notes,
        cost_usd: meter.cost,
      },
    };
  } finally {
    clearTimeout(timer);
    await logUsage(
      env,
      deps,
      auth,
      { company: body.company, contract: body.contract },
      "colors",
      meter,
    );
  }
}

// ------------------------------------------------------------ briefing by AI
/** About 50 thousand tokens: a long meeting fits; a whole book doesn't. */
export const BRIEFING_MAX_CHARS = 200_000;
const briefingLabels = Object.fromEntries(
  briefingSteps.flatMap((s) => s.fields).map((f) => [f.key, f.label]),
) as Record<BriefingKey, string>;
export const BRIEFING_SCHEMA = obj({
  fields: obj(Object.fromEntries(briefingAiKeys.map((k) => [k, str]))),
  campaignObjective: { type: "string", enum: ["ctwa", "form_nativo", ""] },
  evidence: {
    type: "array",
    description:
      "De onde veio cada campo preenchido: um trecho curto do material.",
    items: obj({ field: { type: "string", enum: briefingAiKeys }, quote: str }),
  },
  missing: {
    type: "array",
    description: "Campos importantes que o material não responde.",
    items: { type: "string", enum: briefingAiKeys },
  },
  resumo: str,
});

const clockOf = (s: number) => {
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(s % 60)).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
/** A meeting transcript as lines "[mm:ss] Nome: fala" (same speaker joined). */
export function meetingText(
  speakers: string[],
  segments: [number | null, number | null, number | null, string][],
) {
  const lines: string[] = [];
  let at: number | null = null;
  let who: number | null = null;
  let said: string[] = [];
  const name = (i: number | null) =>
    i != null && speakers[i] ? speakers[i] : `Falante ${(i ?? 0) + 1}`;
  const flush = () => {
    if (said.length)
      lines.push(
        `${at != null ? `[${clockOf(at)}] ` : ""}${name(who)}: ${said.join(" ")}`,
      );
    said = [];
  };
  for (const [start, , speaker, text] of segments) {
    if (
      !said.length ||
      speaker !== who ||
      (start != null && at != null && start - at >= 45)
    ) {
      flush();
      at = start;
      who = speaker;
    }
    said.push(String(text ?? "").trim());
  }
  flush();
  return lines.join("\n");
}

async function briefing(
  body: Extract<SocialLeadsRequest, { action: "briefing" }>,
  auth: string,
  env: SocialLeadsEnv,
  deps: Deps,
) {
  let material = String(body.text ?? "").trim();
  let source = "Texto colado";
  let meetingDate: string | null = null;
  if (body.recording) {
    if (!UUID.test(body.recording))
      return { status: 400, body: { error: "Reunião inválida." } };
    const m = await rpc<{
      title: string;
      recorded_at: string;
      speakers: string[];
      segments: [number | null, number | null, number | null, string][];
      summary: Record<string, unknown>;
    }>(env, deps, auth, "social_leads_meeting_text", {
      p_company: body.company,
      p_contract: body.contract,
      p_recording: body.recording,
    });
    meetingDate = m.recorded_at.slice(0, 10);
    const when = new Date(m.recorded_at).toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    source = `${m.title || "Reunião"} · ${when}`;
    material = [
      `Reunião "${m.title || "sem título"}", gravada em ${when}.`,
      m.summary && Object.keys(m.summary).length
        ? `Resumo automático da reunião (JSON):\n${JSON.stringify(m.summary)}`
        : "",
      `Transcrição:\n${meetingText(m.speakers ?? [], m.segments ?? [])}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  } else {
    if (!material)
      return {
        status: 400,
        body: {
          error: "Cole as notas ou a transcrição, ou escolha uma reunião.",
        },
      };
    await rpc(env, deps, auth, "social_leads_check_write", {
      p_company: body.company,
      p_contract: body.contract,
    });
  }
  if (material.length > BRIEFING_MAX_CHARS)
    return {
      status: 400,
      body: {
        error: `O material passou de ${BRIEFING_MAX_CHARS.toLocaleString("pt-BR")} caracteres. Envie só a parte da reunião sobre o cliente.`,
      },
    };
  const request: ModelRequest = {
    system:
      "Você preenche o briefing de onboarding do produto Social Leads (gestão de Instagram e Facebook com tráfego pago no Meta) a partir do que o cliente disse. Use só o que está no material: nunca invente nome, número, depoimento, concorrente ou promessa. Escreva em português do Brasil, em frases curtas e objetivas, como a equipe preencheria.",
    user: [
      `Campos do briefing (chave: rótulo):\n${briefingAiKeys.map((k) => `${k}: ${briefingLabels[k]}`).join("\n")}`,
      `Regras de formato: campo sem resposta no material fica "" (vazio). Dinheiro (averageTicket, mediaBudget): só o número em reais com ponto decimal, ex.: 1500.00. WhatsApp: só os dígitos com DDD. briefingDate: AAAA-MM-DD${meetingDate ? ` (a reunião foi em ${meetingDate})` : ""}. igHandle: @perfil. websiteUrl: o endereço. As forças, fraquezas, oportunidades e ameaças podem resumir o que foi dito, sem inventar. campaignObjective: "ctwa" se o cliente quer conversas no WhatsApp, "form_nativo" se quer cadastros por formulário, "" se não ficou claro. Em evidence, um trecho curto (até 200 caracteres) do material para cada campo preenchido. Em missing, os campos importantes que faltam. Em resumo, uma frase sobre o que foi aproveitado.`,
      `Material (${source}):\n${material}`,
    ].join("\n\n"),
    schema: BRIEFING_SCHEMA,
    domains: [],
    effort: "low",
    maxTokens: 12000,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const meter = newMeter(env.model);
  try {
    const text = await deps.complete(env, request, controller.signal, meter);
    const parsed = JSON.parse(text) as {
      fields: Record<string, string>;
      campaignObjective: string;
      evidence: { field: BriefingKey; quote: string }[];
      missing: BriefingKey[];
      resumo: string;
    };
    const fields = cleanBriefingSuggestion(parsed.fields ?? {});
    if (meetingDate && !fields.briefingDate) fields.briefingDate = meetingDate;
    const evidence: Partial<Record<BriefingKey, string>> = {};
    for (const e of parsed.evidence ?? [])
      if (fields[e.field] && e.quote?.trim())
        evidence[e.field] = e.quote.trim().slice(0, 300);
    return {
      status: 200,
      body: {
        fields,
        objective:
          parsed.campaignObjective in campaignObjectives
            ? parsed.campaignObjective
            : null,
        evidence,
        missing: (parsed.missing ?? []).filter(
          (k) => briefingAiKeys.includes(k) && !fields[k],
        ),
        summary: String(parsed.resumo ?? ""),
        source,
        cost_usd: meter.cost,
      },
    };
  } finally {
    clearTimeout(timer);
    await logUsage(
      env,
      deps,
      auth,
      { company: body.company, contract: body.contract },
      "briefing",
      meter,
    );
  }
}

// ------------------------------------------------------------ client link arts
/**
 * GET /api/social-leads?arte=<file>&link=<token>: an art of a post, for the
 * client link (an <img>/<video> source). The database checks the token and
 * that the file is an art of that plan; the answer is a redirect to a
 * signed address valid for 10 minutes. The file itself stays private.
 */
export async function publicArt(
  query: URLSearchParams,
  env: SocialLeadsEnv,
  deps: {
    fetch: Fetch;
    sign: (file: {
      path: string;
      name: string;
      content_type: string;
    }) => string | null;
  },
): Promise<{ status: number; location?: string; error?: string }> {
  const token = query.get("link") ?? "";
  const file = query.get("arte") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token) || !UUID.test(file))
    return { status: 404, error: "Arte não encontrada." };
  const found = await callRpc<
    { path: string; name: string; content_type: string }[]
  >(env, deps.fetch, null, "social_leads_public_art", {
    p_token: token,
    p_file: file,
  });
  const target = found.ok ? found.data[0] : undefined;
  if (!target) return { status: 404, error: "Arte não encontrada." };
  const url = deps.sign(target);
  if (!url) return { status: 500, error: "Armazenamento não configurado." };
  return { status: 302, location: url };
}

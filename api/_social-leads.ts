import Anthropic from "@anthropic-ai/sdk";
import { callRpc } from "./_drive.js";
import {
  briefingReadiness,
  campaignObjectives,
  type BriefingFields,
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
  ) => Promise<string>;
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
};

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

type Context = {
  job: string;
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
  const parts = [
    `Briefing do cliente (JSON):\n${JSON.stringify(briefing, null, 2)}`,
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
    { role: "user", content: request.user },
  ];
  // Server tools may pause a long turn: send it back to continue.
  for (let round = 0; round < 4; round++) {
    const message = await client.beta.messages
      .stream(
        {
          model: env.model,
          max_tokens: 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: {
            effort: "high",
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
  try {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const ask = attempt
        ? {
            ...request,
            user: `${request.user}\n\nA resposta anterior foi recusada pela validação: ${lastError} Corrija e devolva o plano completo.`,
          }
        : request;
      const text = await deps.complete(env, ask, controller.signal);
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
  try {
    const text = await deps.complete(env, request, controller.signal);
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
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

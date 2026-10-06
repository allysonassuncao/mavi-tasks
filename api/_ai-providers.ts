import Anthropic from "@anthropic-ai/sdk";
import { callRpc } from "./_drive.js";
import { seal, unseal } from "./_google.js";
import { meterAdd, newMeter, type Meter } from "./_social-leads.js";
import {
  ANSWER_NUDGE,
  LIMIT_NOTE,
  LlmError,
  anthropicAdapter,
  effortFor,
  meterSnapshot,
  outputText,
  roundDelta,
  usableImages,
  type LlmAdapter,
  type ToolImage,
} from "./_ai-llm.js";
import {
  CATALOG,
  FEATURES,
  catalogEntry,
  embeddingModel,
  keyHint,
  providerBaseUrl,
  safeBaseUrl,
  serverModel,
  type AiFeature,
  type ProviderModel,
} from "../src/ai-providers.js";

/**
 * IA do MAVI · biblioteca de provedores (migration 20261025090000_ai_providers).
 *
 * - Qual IA responde: ai_resolve_route devolve a regra mais específica para
 *   quem pede, onde e em qual funcionalidade (nas conversas: projeto ›
 *   produto › cliente › pessoa › funcionalidade › empresa; nas demais:
 *   funcionalidade › empresa), com a API Key selada; aqui ela é aberta com
 *   AI_PROVIDER_KEY e vira um adaptador (a mesma interface neutra de
 *   _ai-llm.ts). Sem regra, fica o padrão do servidor (ANTHROPIC_API_KEY e
 *   o modelo da variável de cada funcionalidade, serverModel).
 * - Administração (ações "ai-provider-*" de /api/ai): salvar um provedor
 *   (a chave é selada aqui, nunca vai em texto ao banco), buscar os modelos
 *   na API do provedor e testar a conexão. O banco confere que quem chama é
 *   administrador.
 */

export type ProviderEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  /** 32 bytes (AI_PROVIDER_KEY, base64); null quando falta ou é inválida. */
  providerKey: Buffer | null;
};

export function providerKeyFrom(value: string | undefined) {
  if (!value) return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

const MISSING_KEY =
  "Falta na Vercel: AI_PROVIDER_KEY (32 bytes em base64 — gere com openssl rand -base64 32). Depois de salvar, faça um Redeploy.";

/** O que ai_resolve_route devolve. */
export type ResolvedRoute = {
  scope: string;
  provider_id: string;
  provider: string;
  kind: string;
  base_url: string | null;
  key_cipher: string;
  model: string;
  /** O esforço da regra (só nas de pessoa, cliente, produto e projeto). */
  effort?: string | null;
  price: ProviderModel | null;
};

export type ProviderConfig = {
  kind: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  price: ProviderModel | null;
};

type Fetch = typeof fetch;

// ------------------------------------------------------------ custo
/** Custo de uma resposta pelos preços cadastrados (US$ por milhão). */
export function priceCost(
  price: ProviderModel | null,
  tokens: { input: number; output: number; cached: number },
) {
  if (!price) return 0;
  return (
    (tokens.input * price.input +
      tokens.cached * (price.cached ?? price.input) +
      tokens.output * price.output) /
    1e6
  );
}

// ------------------------------------------------------------ OpenAI (chat)
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "user";
      content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatChunk = {
  choices?: {
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
      /** OpenRouter com o plugin web: as páginas citadas. */
      annotations?: {
        type?: string;
        url_citation?: { url?: string; title?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    /** OpenRouter: o custo de verdade (inclui o plugin web). */
    cost?: number;
  } | null;
  error?: { message?: string };
};

/** As linhas "data: {...}" de uma resposta em SSE. */
async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith("data:")) yield rest.slice(5).trim();
}

/** Uma mensagem de erro clara a partir da resposta do provedor. */
async function providerError(res: Response, name: string) {
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    const body = JSON.parse(text);
    detail = String(
      body?.error?.message ?? body?.message ?? body?.error ?? "",
    ).slice(0, 300);
  } catch {
    detail = text.slice(0, 200);
  }
  if (res.status === 401 || res.status === 403)
    return new LlmError(
      502,
      `A API Key do provedor "${name}" foi recusada. Confira em Painel da MAVI › Provedores e modelos.`,
    );
  if (res.status === 404)
    return new LlmError(
      502,
      `O provedor "${name}" não encontrou o modelo ou o endereço da API${detail ? `: ${detail}` : "."}`,
    );
  if (res.status === 429)
    return new LlmError(
      429,
      `Limite de uso do provedor "${name}" atingido. Tente de novo em alguns minutos.`,
    );
  if (res.status === 402)
    return new LlmError(
      402,
      `Os créditos do provedor "${name}" acabaram ou a API Key chegou ao limite de gasto. Adicione créditos ou aumente o limite da chave no site do provedor.`,
    );
  return new LlmError(
    502,
    `O provedor "${name}" respondeu com erro (${res.status})${detail ? `: ${detail}` : "."}`,
  );
}

/** O uso de uma resposta de chat no medidor, pelos preços cadastrados. */
function addChatUsage(
  meter: Meter,
  config: ProviderConfig,
  usage: NonNullable<ChatChunk["usage"]>,
) {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const input = Math.max((usage.prompt_tokens ?? 0) - cached, 0);
  const output = usage.completion_tokens ?? 0;
  // O OpenRouter diz quanto cobrou (tokens e plugins); os outros, pelos preços.
  meterAdd(meter, config.model, {
    input,
    cacheRead: cached,
    output,
    cost:
      config.kind === "openrouter" && typeof usage.cost === "number" && usage.cost >= 0
        ? usage.cost
        : priceCost(config.price, { input, output, cached }),
  });
}

/** O teto da resposta no OpenRouter (sem ele, reserva o máximo do modelo nos créditos). */
export const ROUTER_MAX_TOKENS = 32_000;

/**
 * O OpenRouter recusa (402) quando os créditos não cobrem o teto pedido e diz
 * quanto cabe: devolve um teto menor que caiba, ou 0 se não der para seguir.
 */
export async function affordableTokens(res: Response, current: number) {
  if (res.status !== 402) return 0;
  const text = await res.clone().text().catch(() => "");
  const n = Number(text.match(/can only afford (\d+)/i)?.[1]);
  return n >= 2000 && n < current ? Math.floor(n * 0.95) : 0;
}

const authHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
});

/**
 * A API de chat da OpenAI (e das compatíveis): ferramentas em paralelo,
 * texto e raciocínio em tempo real quando o provedor manda, e o custo pelos
 * preços cadastrados.
 */
export function openAiChatAdapter(
  config: ProviderConfig,
  fetchImpl: Fetch = fetch,
): LlmAdapter {
  return async (request) => {
    const meter: Meter = newMeter(config.model);
    const tools = request.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    // A Claude pelo OpenRouter: pontos de cache nas instruções e no contexto
    // (as outras fazem cache sozinhas de prompts longos).
    const routerClaude = config.kind === "openrouter" && /^anthropic\//.test(config.model);
    const messages: ChatMessage[] = [
      routerClaude
        ? ({
            role: "system",
            content: [
              { type: "text", text: request.instructions, cache_control: { type: "ephemeral" } },
              { type: "text", text: request.context, cache_control: { type: "ephemeral" } },
            ],
          } as unknown as ChatMessage)
        : {
            role: "system",
            content: `${request.instructions}\n\n${request.context}`,
          },
      ...request.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    ];
    const maxRounds = request.maxRounds ?? 6;
    let nudged = false;
    // As rodadas acabaram com o modelo ainda buscando (o aviso vai uma vez).
    let capped = false;
    // Nem todo provedor aceita stream_options: sem ele, o uso vem se vier.
    let usageOption = true;
    const router = config.kind === "openrouter";
    // Busca na internet pelo plugin web do OpenRouter; as páginas viram fontes.
    const web = !!request.webSearch && router;
    const cited = new Map<string, string>();
    let maxTokens = request.maxTokens ?? ROUTER_MAX_TOKENS;
    // O esforço vai só quando pedido; o modelo que não raciocina recusa e segue sem.
    let reasoningOption = request.effort !== undefined;
    for (let round = 0; ; round++) {
      const last = round >= maxRounds;
      if (last && !capped && !nudged && maxRounds > 0 && messages[messages.length - 1]?.role === "tool") {
        capped = true;
        messages.push({ role: "user", content: LIMIT_NOTE });
      }
      const effort = reasoningOption ? effortFor(config.model, request.effort) : null;
      // Os provedores fora da Claude vão até "high".
      const level = effort === "xhigh" || effort === "max" ? "high" : effort;
      const body = {
        model: config.model,
        messages,
        ...(tools.length
          ? { tools, tool_choice: last ? "none" : "auto" }
          : {}),
        stream: true,
        ...(usageOption ? { stream_options: { include_usage: true } } : {}),
        ...(router ? { max_tokens: maxTokens, usage: { include: true } } : {}),
        // A OpenAI junta no mesmo cache os pedidos com a mesma chave.
        ...(config.kind === "openai" && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
        ...(web ? { plugins: [{ id: "web", max_results: 5 }] } : {}),
        ...(level ? (router ? { reasoning: { effort: level } } : { reasoning_effort: level }) : {}),
      };
      const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: authHeaders(config.apiKey),
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (!res.ok || !res.body) {
        if (res.status === 400 && usageOption) {
          const text = await res.clone().text().catch(() => "");
          if (/stream_options/i.test(text)) {
            usageOption = false;
            round--;
            continue;
          }
        }
        if (res.status === 400 && reasoningOption) {
          const text = await res.clone().text().catch(() => "");
          if (/reasoning/i.test(text)) {
            reasoningOption = false;
            round--;
            continue;
          }
        }
        const fits = router ? await affordableTokens(res, maxTokens) : 0;
        if (fits) {
          maxTokens = fits;
          round--;
          continue;
        }
        throw await providerError(res, config.name);
      }
      let text = "";
      let finish = "";
      const before = meterSnapshot(meter);
      const calls: { id: string; name: string; args: string }[] = [];
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error)
          throw new LlmError(
            502,
            `O provedor "${config.name}" interrompeu a resposta: ${chunk.error.message ?? "erro"}`,
          );
        if (chunk.usage) addChatUsage(meter, config, chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (thought) request.onEvent?.({ type: "thinking", text: thought });
        if (delta.content) {
          text += delta.content;
          request.onEvent?.({ type: "text", text: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          // Sem índice: pelo id; sem id, é a continuação da última chamada.
          let i = tc.index ?? -1;
          if (i < 0 && tc.id) i = calls.findIndex((c) => c?.id === tc.id);
          if (i < 0) i = tc.id ? calls.length : Math.max(calls.length - 1, 0);
          calls[i] ??= { id: tc.id ?? `call_${round}_${i}`, name: "", args: "" };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
        for (const a of delta.annotations ?? []) {
          const url = a.url_citation?.url;
          if (web && url && /^https?:\/\//.test(url) && request.onCitation && !cited.has(url))
            cited.set(url, request.onCitation({ url, title: a.url_citation?.title || url }));
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const used = calls.filter((c) => c && c.name);
      request.onRound?.(roundDelta(before, meter, used.map((c) => c.name)));
      if (used.length && !last) {
        request.onEvent?.({ type: "round_end", tools: used.length });
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: used.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args || "{}" },
          })),
        });
        const seen: ToolImage[] = [];
        const results = await Promise.all(
          used.map(async (c) => {
            let content: string;
            try {
              const input = c.args.trim() ? JSON.parse(c.args) : {};
              const out = await request.execute(c.name, input);
              content = outputText(out);
              if (typeof out !== "string") seen.push(...out.images);
            } catch (e) {
              content = `Erro: ${(e as Error).message}`;
            }
            return { role: "tool" as const, tool_call_id: c.id, content };
          }),
        );
        messages.push(...results);
        // A API de chat não aceita imagens no resultado: vão logo depois, como mensagem.
        const images = usableImages(seen);
        if (images.length)
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Imagens que as ferramentas acima devolveram:" },
              ...images.map((i) => ({
                type: "image_url" as const,
                image_url: { url: `data:${i.mediaType};base64,${i.data}` },
              })),
            ],
          });
        continue;
      }
      // As páginas que o OpenRouter citou, no fim (quando o texto não citou).
      const refs = [...cited.values()].filter((r) => !text.includes(`[${r}]`));
      const answer = `${text.trim()}${refs.length ? ` ${refs.map((r) => `[${r}]`).join("")}` : ""}`.trim();
      if (!text.trim()) {
        if (!nudged) {
          nudged = true;
          request.onEvent?.({ type: "round_end", tools: 0 });
          messages.push({ role: "user", content: ANSWER_NUDGE });
          round = Math.max(round, maxRounds - 1);
          continue;
        }
        throw new LlmError(
          502,
          `O provedor "${config.name}" não devolveu resposta (motivo: ${finish || "desconhecido"}). Tente de novo.`,
        );
      }
      if (finish === "content_filter")
        throw new LlmError(
          422,
          "A MAVI não respondeu a esta pergunta. Tente reformular.",
        );
      return {
        text:
          finish === "length"
            ? `${answer}\n\n(A resposta foi cortada por ser longa demais.)`
            : answer,
        meter,
        rounds: round,
        ...(capped ? { capped } : {}),
      };
    }
  };
}

/**
 * Uma resposta em JSON pela API de chat da OpenAI (e das compatíveis), para
 * as funcionalidades que pedem um objeto estruturado (Social Leads). Tenta o
 * JSON Schema; o provedor que não aceita cai para JSON simples e, por fim,
 * para texto — o schema vai também nas instruções. Imagens vão como data
 * URL (o modelo precisa aceitar imagens).
 */
export async function openAiJsonComplete(
  config: ProviderConfig,
  request: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    images?: { media_type: string; data: string }[];
  },
  signal: AbortSignal | undefined,
  meter: Meter,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const content = request.images?.length
    ? [
        ...request.images.map((i) => ({
          type: "image_url" as const,
          image_url: { url: `data:${i.media_type};base64,${i.data}` },
        })),
        { type: "text" as const, text: request.user },
      ]
    : request.user;
  const system = `${request.system}\n\nResponda somente com um objeto JSON válido que siga este JSON Schema, sem texto antes ou depois e sem cercas de código:\n${JSON.stringify(request.schema)}`;
  const formats = [
    {
      type: "json_schema",
      json_schema: { name: "resposta", schema: request.schema, strict: false },
    },
    { type: "json_object" },
    null,
  ];
  const router = config.kind === "openrouter";
  let maxTokens = ROUTER_MAX_TOKENS;
  for (let i = 0; ; i++) {
    const format = formats[i];
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: authHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
        ...(format ? { response_format: format } : {}),
        ...(router ? { max_tokens: maxTokens } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      const fits = router ? await affordableTokens(res, maxTokens) : 0;
      if (fits) {
        maxTokens = fits;
        i--;
        continue;
      }
      if (res.status === 400 && i < formats.length - 1) {
        const text = await res.clone().text().catch(() => "");
        if (/response_format|json_schema|json_object|structured/i.test(text))
          continue;
      }
      throw await providerError(res, config.name);
    }
    const body = (await res.json().catch(() => ({}))) as {
      choices?: {
        message?: { content?: string | null; refusal?: string | null };
        finish_reason?: string | null;
      }[];
      usage?: ChatChunk["usage"];
    };
    if (body.usage) addChatUsage(meter, config, body.usage);
    const choice = body.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter")
      throw new LlmError(
        422,
        "A MAVI não respondeu a este pedido. Revise o texto e tente de novo.",
      );
    if (choice?.finish_reason === "length")
      throw new LlmError(
        502,
        "A resposta da MAVI ficou incompleta. Tente de novo.",
      );
    const text = (choice?.message?.content ?? "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
      throw new LlmError(
        502,
        `O provedor "${config.name}" não devolveu um JSON. Tente de novo ou escolha outro modelo.`,
      );
    return text.slice(start, end + 1);
  }
}

// ------------------------------------------------------------ Claude
/** A Claude com a chave e o modelo da biblioteca; erros com o nome do provedor. */
export function anthropicProviderAdapter(
  config: ProviderConfig,
  client?: Pick<Anthropic, "beta">,
): LlmAdapter {
  const inner = anthropicAdapter(
    {
      anthropicKey: config.apiKey,
      model: config.model,
      price: config.price,
      baseUrl: config.baseUrl,
    },
    client,
  );
  return async (request) => {
    try {
      return await inner(request);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError)
        throw new LlmError(
          502,
          `A API Key do provedor "${config.name}" foi recusada. Confira em Painel da MAVI › Provedores e modelos.`,
        );
      if (e instanceof Anthropic.NotFoundError)
        throw new LlmError(
          502,
          `O provedor "${config.name}" não encontrou o modelo ${config.model}.`,
        );
      if (e instanceof Anthropic.RateLimitError)
        throw new LlmError(
          429,
          `Limite de uso do provedor "${config.name}" atingido. Tente de novo em alguns minutos.`,
        );
      throw e;
    }
  };
}

export const isClaude = (config: Pick<ProviderConfig, "kind">) =>
  catalogEntry(config.kind)?.api === "anthropic";

export function adapterFor(config: ProviderConfig, fetchImpl: Fetch = fetch) {
  return isClaude(config)
    ? anthropicProviderAdapter(config)
    : openAiChatAdapter(config, fetchImpl);
}

/** Abre a regra devolvida pelo banco (a chave selada) numa configuração. */
export function routeConfig(
  env: Pick<ProviderEnv, "providerKey">,
  route: ResolvedRoute,
): ProviderConfig {
  if (!env.providerKey)
    throw new LlmError(
      503,
      `O provedor de IA "${route.provider}" está configurado, mas o servidor não consegue abrir a chave. ${MISSING_KEY}`,
    );
  let apiKey: string;
  try {
    apiKey = unseal(env.providerKey, route.key_cipher);
  } catch {
    throw new LlmError(
      503,
      `Não foi possível abrir a API Key do provedor "${route.provider}" (a AI_PROVIDER_KEY mudou?). Salve a chave de novo em Painel da MAVI › Provedores e modelos.`,
    );
  }
  return {
    kind: route.kind,
    name: route.provider,
    baseUrl: providerBaseUrl(route.kind, route.base_url),
    apiKey,
    model: route.model,
    price: route.price,
  };
}

/**
 * A regra de pessoa, cliente, produto ou projeto que escolheu o modelo pode
 * ter o seu esforço: vale no lugar do da funcionalidade.
 */
export function withRouteEffort(
  efforts: Record<string, string>,
  route: { effort?: string | null } | null,
  feature: string,
): Record<string, string> {
  return route?.effort ? { ...efforts, [feature]: route.effort } : efforts;
}

/**
 * Qual IA responde nesta funcionalidade (null: o padrão do servidor). Se o
 * banco ainda não tem a biblioteca (migration não aplicada), segue no padrão.
 */
export async function resolveRoute(
  env: Pick<ProviderEnv, "supabaseUrl" | "supabaseKey">,
  fetchImpl: Fetch,
  auth: string,
  company: string,
  scope: { client?: string; contract?: string; project?: string },
  feature: AiFeature = "assistant",
): Promise<ResolvedRoute | null> {
  const r = await callRpc<ResolvedRoute | null>(
    env,
    fetchImpl,
    auth,
    "ai_resolve_route",
    {
      p_company: company,
      p_client: scope.client ?? null,
      p_contract: scope.contract ?? null,
      p_project: scope.project ?? null,
      p_feature: feature,
    },
  );
  if (!r.ok) {
    if (r.status !== 404) console.error("ai_resolve_route", r.status, r.error);
    return null;
  }
  return r.data && r.data.key_cipher ? r.data : null;
}

/**
 * O provedor da biblioteca que responde nesta funcionalidade, com a chave
 * aberta (null: o padrão do servidor). Para as funcionalidades fora do
 * /api/ai (Gravações, WhatsApp, Social Leads).
 */
export async function featureProvider(
  env: Pick<ProviderEnv, "supabaseUrl" | "supabaseKey" | "providerKey">,
  fetchImpl: Fetch,
  auth: string,
  company: string,
  feature: AiFeature,
  scope: { client?: string; contract?: string; project?: string } = {},
): Promise<{ id: string; config: ProviderConfig } | null> {
  const route = await resolveRoute(env, fetchImpl, auth, company, scope, feature);
  return route ? { id: route.provider_id, config: routeConfig(env, route) } : null;
}

// ------------------------------------------------------------ administração
class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

async function rpc<T>(
  env: ProviderEnv,
  fetchImpl: Fetch,
  auth: string,
  name: string,
  args: Row,
) {
  const r = await callRpc<T>(env, fetchImpl, auth, name, args);
  if (!r.ok)
    throw new ProviderError(
      r.status === 401 ? 401 : r.status >= 500 ? 502 : 400,
      r.error,
    );
  return r.data;
}

/** Tipo, endereço e chave: os do pedido ou os salvos no provedor. */
async function connection(
  env: ProviderEnv,
  fetchImpl: Fetch,
  auth: string,
  req: Row,
) {
  const company = str(req.company, 40);
  if (!UUID.test(company)) throw new ProviderError(400, "Empresa inválida.");
  const id = typeof req.id === "string" && UUID.test(req.id) ? req.id : null;
  let kind = str(req.kind, 20);
  let baseUrl = str(req.base_url, 300);
  let apiKey = str(req.api_key, 400);
  let models: ProviderModel[] = [];
  if (id) {
    const [saved] = await rpc<
      {
        kind: string;
        base_url: string | null;
        key_cipher: string;
        models: ProviderModel[];
      }[]
    >(env, fetchImpl, auth, "ai_provider_secret", {
      p_company: company,
      p_id: id,
    });
    if (!saved) throw new ProviderError(404, "Provedor não encontrado.");
    kind ||= saved.kind;
    baseUrl ||= saved.base_url ?? "";
    models = saved.models ?? [];
    if (!apiKey) {
      if (!env.providerKey) throw new ProviderError(503, MISSING_KEY);
      try {
        apiKey = unseal(env.providerKey, saved.key_cipher);
      } catch {
        throw new ProviderError(
          409,
          "A chave salva não abre mais (a AI_PROVIDER_KEY mudou?). Informe a API Key de novo.",
        );
      }
    }
  } else {
    // Só administradores seguem (a lista confere).
    await rpc(env, fetchImpl, auth, "ai_provider_list", { p_company: company });
  }
  const entry = catalogEntry(kind);
  if (!entry) throw new ProviderError(400, "Escolha o provedor.");
  if (!apiKey) throw new ProviderError(400, "Informe a API Key.");
  if (entry.kind === "custom" || baseUrl) {
    const problem = safeBaseUrl(baseUrl || entry.baseUrl);
    if (problem) throw new ProviderError(400, problem);
  }
  return {
    company,
    id,
    entry,
    apiKey,
    baseUrl: providerBaseUrl(kind, baseUrl),
    models,
  };
}

/** Salva o provedor: a chave nova é selada aqui. */
async function saveProvider(
  env: ProviderEnv,
  fetchImpl: Fetch,
  auth: string,
  req: Row,
) {
  const company = str(req.company, 40);
  if (!UUID.test(company)) throw new ProviderError(400, "Empresa inválida.");
  const id = typeof req.id === "string" && UUID.test(req.id) ? req.id : null;
  const entry = catalogEntry(str(req.kind, 20));
  if (!entry) throw new ProviderError(400, "Escolha o provedor.");
  const baseUrl = str(req.base_url, 300);
  if (entry.kind === "custom" && !baseUrl)
    throw new ProviderError(400, "Informe o endereço da API.");
  if (baseUrl) {
    const problem = safeBaseUrl(baseUrl);
    if (problem) throw new ProviderError(400, problem);
  }
  const apiKey = str(req.api_key, 400);
  if (!id && !apiKey) throw new ProviderError(400, "Informe a API Key.");
  if (apiKey && !env.providerKey) throw new ProviderError(503, MISSING_KEY);
  const models = Array.isArray(req.models) ? req.models : [];
  const saved = await rpc<string>(env, fetchImpl, auth, "ai_save_provider", {
    p_company: company,
    p_id: id,
    p_name: str(req.name, 80),
    p_kind: entry.kind,
    p_base_url:
      baseUrl && baseUrl.replace(/\/+$/, "") !== entry.baseUrl
        ? baseUrl.replace(/\/+$/, "")
        : null,
    p_models: models,
    p_key_cipher: apiKey ? seal(env.providerKey!, apiKey) : null,
    p_key_hint: apiKey ? keyHint(apiKey) : null,
    p_active: req.active === undefined ? true : req.active === true,
  });
  return { id: saved };
}

type ListedModel = {
  id: string;
  label?: string;
  input?: number;
  output?: number;
};

/** Os modelos que a chave enxerga, com os preços quando o provedor informa. */
async function listModels(
  env: ProviderEnv,
  fetchImpl: Fetch,
  auth: string,
  req: Row,
  anthropicClient?: (apiKey: string, baseUrl: string) => Pick<Anthropic, "models">,
) {
  const c = await connection(env, fetchImpl, auth, req);
  const known = new Map(
    [...c.entry.models, ...c.models].map((m) => [m.id, m] as const),
  );
  let listed: ListedModel[] = [];
  // Os que só transcrevem não listam modelos: valem os do catálogo.
  if (c.entry.api === "transcribe") {
    await checkTranscriber(fetchImpl, c);
    return { models: c.entry.models.map((m) => ({ ...m })) };
  }
  if (c.entry.api === "anthropic") {
    const client =
      anthropicClient?.(c.apiKey, c.baseUrl) ??
      new Anthropic({ apiKey: c.apiKey, baseURL: c.baseUrl, maxRetries: 1 });
    try {
      for await (const m of client.models.list())
        listed.push({ id: m.id, label: m.display_name });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError)
        throw new ProviderError(400, "A API Key foi recusada pela Anthropic.");
      throw new ProviderError(
        502,
        `A Anthropic respondeu com erro: ${(e as Error).message}`,
      );
    }
  } else {
    const res = await fetchImpl(`${c.baseUrl}/models`, {
      headers: authHeaders(c.apiKey),
    });
    if (!res.ok) {
      const e = await providerError(res, c.entry.label);
      throw new ProviderError(res.status === 401 ? 400 : 502, e.message);
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: {
        id?: string;
        name?: string;
        pricing?: { prompt?: string; completion?: string };
      }[];
      models?: {
        id?: string;
        name?: string;
        pricing?: { prompt?: string; completion?: string };
      }[];
    };
    const perMillion = (v?: string) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined;
    };
    listed = (body.data ?? body.models ?? [])
      .filter((m) => typeof m.id === "string" && m.id)
      .map((m) => ({
        // O Gemini devolve "models/gemini-…"; a API de chat usa sem o prefixo.
        id: m.id!.replace(/^models\//, ""),
        label: m.name && m.name !== m.id ? m.name : undefined,
        input: perMillion(m.pricing?.prompt),
        output: perMillion(m.pricing?.completion),
      }));
  }
  const models = listed
    .slice(0, 500)
    .map((m) => {
      const k = known.get(m.id);
      return {
        ...m,
        label: m.label ?? k?.label,
        input: m.input ?? k?.input,
        output: m.output ?? k?.output,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

/**
 * Deepgram e AssemblyAI: uma leitura que só passa com a chave certa (sem
 * transcrever nada).
 */
async function checkTranscriber(
  fetchImpl: Fetch,
  c: { entry: { kind: string; label: string }; baseUrl: string; apiKey: string },
) {
  const res =
    c.entry.kind === "deepgram"
      ? await fetchImpl(`${c.baseUrl}/projects`, {
          headers: { Authorization: `Token ${c.apiKey}` },
        })
      : await fetchImpl(`${c.baseUrl}/transcript?limit=1`, {
          headers: { Authorization: c.apiKey },
        });
  if (!res.ok)
    throw new ProviderError(
      400,
      res.status === 401 || res.status === 403
        ? `A API Key foi recusada pelo ${c.entry.label}.`
        : `O ${c.entry.label} respondeu com erro ${res.status}.`,
    );
}

/** Uma pergunta curtinha ao modelo, para saber se chave, endereço e modelo funcionam. */
async function testProvider(
  env: ProviderEnv,
  fetchImpl: Fetch,
  auth: string,
  req: Row,
  now: () => number,
  anthropicClient?: (apiKey: string, baseUrl: string) => Pick<Anthropic, "messages">,
) {
  const c = await connection(env, fetchImpl, auth, req);
  const model = str(req.model, 120);
  if (!model) throw new ProviderError(400, "Escolha o modelo para testar.");
  const started = now();
  let reply = "";
  if (c.entry.api === "transcribe") {
    await checkTranscriber(fetchImpl, c);
    return { ok: true, ms: now() - started, reply: "chave aceita" };
  }
  if (c.entry.api === "anthropic") {
    const client =
      anthropicClient?.(c.apiKey, c.baseUrl) ??
      new Anthropic({ apiKey: c.apiKey, baseURL: c.baseUrl, maxRetries: 0 });
    try {
      const message = await client.messages.create({
        model,
        max_tokens: 256,
        messages: [{ role: "user", content: "Responda apenas: ok" }],
      });
      reply = message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new ProviderError(
        400,
        status === 401
          ? "A API Key foi recusada pela Anthropic."
          : status === 404
            ? `A Anthropic não encontrou o modelo ${model}.`
            : `A Anthropic respondeu com erro: ${(e as Error).message}`,
      );
    }
  } else {
    const res = await fetchImpl(`${c.baseUrl}/chat/completions`, {
      method: "POST",
      headers: authHeaders(c.apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Responda apenas: ok" }],
        ...(c.entry.kind === "openrouter" ? { max_tokens: 256 } : {}),
      }),
    });
    if (!res.ok) {
      const e = await providerError(res, c.entry.label);
      throw new ProviderError(400, e.message);
    }
    const body = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string | null } }[];
    };
    reply = (body.choices?.[0]?.message?.content ?? "").trim();
  }
  return { ok: true, ms: now() - started, reply: reply.slice(0, 120) };
}

/**
 * O padrão do servidor de cada funcionalidade, para a tela mostrar: só o
 * nome do modelo e se a chave da Vercel existe (nunca a chave).
 */
export function serverDefaults(env: Record<string, string | undefined>) {
  return {
    claudeKey: !!env.ANTHROPIC_API_KEY,
    /** A transcrição e os vetores sem regra usam esta chave. */
    openaiKey: !!env.OPENAI_API_KEY,
    features: Object.fromEntries(
      FEATURES.map((f) => [f.id, { model: serverModel(f.id, env), env: f.env }]),
    ),
    /** Os vetores da MAVI (busca e RAG): fixos, só para leitura. */
    embedding: { model: embeddingModel(env), env: "AI_EMBEDDING_MODEL" },
  };
}

export type ProviderDeps = {
  fetch: Fetch;
  now?: () => number;
  /** Trocado nos testes. */
  anthropic?: (apiKey: string, baseUrl: string) => Pick<Anthropic, "models" | "messages">;
  /** As variáveis da Vercel (o padrão do servidor); trocadas nos testes. */
  serverEnv?: Record<string, string | undefined>;
};

export async function handleProviders(
  body: unknown,
  authorization: string | null,
  env: ProviderEnv,
  deps: ProviderDeps,
): Promise<{ status: number; body: Row }> {
  const req = (body ?? {}) as Row;
  if (!authorization?.startsWith("Bearer "))
    return { status: 401, body: { error: "Entre na sua conta." } };
  try {
    if (req.action === "ai-provider-save")
      return {
        status: 200,
        body: await saveProvider(env, deps.fetch, authorization, req),
      };
    if (req.action === "ai-provider-models")
      return {
        status: 200,
        body: await listModels(env, deps.fetch, authorization, req, deps.anthropic),
      };
    if (req.action === "ai-provider-defaults")
      return {
        status: 200,
        body: serverDefaults(deps.serverEnv ?? process.env),
      };
    if (req.action === "ai-provider-test")
      return {
        status: 200,
        body: await testProvider(
          env,
          deps.fetch,
          authorization,
          req,
          deps.now ?? Date.now,
          deps.anthropic,
        ),
      };
    return { status: 400, body: { error: "Ação inválida." } };
  } catch (err) {
    if (err instanceof ProviderError || err instanceof LlmError)
      return { status: err.status, body: { error: err.message } };
    return {
      status: 502,
      body: { error: "Não foi possível falar com o provedor. Tente de novo." },
    };
  }
}

export { CATALOG };

import Anthropic from "@anthropic-ai/sdk";
import { addUsage, newMeter, type Meter } from "./_social-leads.js";
import type { ProviderModel } from "../src/ai-providers.js";

/**
 * IA do MAVI · adaptador de modelo de linguagem.
 *
 * O resto do código fala só esta interface neutra: instruções, contexto,
 * conversa, ferramentas (JSON Schema) e uma função que executa cada
 * ferramenta. O laço de ferramentas fica no adaptador, no formato nativo do
 * provedor. Trocar de provedor (OpenAI, Gemini…) é escrever outro adaptador
 * com a mesma assinatura.
 */

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema do objeto de entrada. */
  parameters: Record<string, unknown>;
};
export type ChatTurn = { role: "user" | "assistant"; content: string };
/**
 * O que o modelo está fazendo, em tempo real (para a tela mostrar):
 * - thinking: um pedaço do resumo do raciocínio;
 * - text: um pedaço do texto desta rodada;
 * - round_end: a rodada terminou chamando ferramentas — o texto dela era
 *   um comentário de trabalho, não a resposta.
 */
export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "round_end"; tools: number }
  /** A Claude buscou na internet ou leu uma página (ferramenta do servidor dela). */
  | { type: "server_tool"; name: string; input: unknown };
export type AgentRequest = {
  /** Instruções fixas (ficam em cache). */
  instructions: string;
  /** Contexto desta pergunta: quem pergunta, escopo, data… */
  context: string;
  messages: ChatTurn[];
  tools: ToolSpec[];
  /** Executa uma ferramenta; devolve o texto do resultado. */
  execute: (name: string, input: unknown) => Promise<string>;
  /** Rodadas de ferramentas antes de exigir a resposta. */
  maxRounds?: number;
  /** O contexto é longo e se repete (a transcrição de uma reunião): fica em cache. */
  cacheContext?: boolean;
  /** Quanto raciocinar (padrão "medium"); o copiloto usa "low" para responder rápido. */
  effort?: "low" | "medium" | "high";
  /** Teto da resposta (padrão 32.000). */
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Busca na internet e leitura de páginas (só na Claude). */
  webSearch?: boolean;
  /** Uma página citada vira uma fonte: devolve a referência (ex.: "S7"). */
  onCitation?: (page: { url: string; title: string }) => string;
};
export type AgentResult = {
  text: string;
  meter: Meter;
  rounds: number;
  /** Buscas feitas na internet (US$ 0,01 cada, já no custo). */
  webSearches?: number;
};

/** Preço da busca na internet da Claude (US$ 10 por mil). */
export const WEB_SEARCH_PRICE = 0.01;

type Block = { type: string; text?: string; citations?: unknown };
/**
 * O texto final: depois da última busca (antes dela é comentário de
 * trabalho) e com cada página citada virando uma fonte [S#].
 */
export function answerText(
  content: Block[],
  cite?: (page: { url: string; title: string }) => string,
) {
  const lastTool = content.reduce(
    (at, b, i) => (/_tool_result$/.test(b.type) ? i : at),
    -1,
  );
  const after = content.slice(lastTool + 1).filter((b) => b.type === "text");
  const blocks = after.some((b) => b.text?.trim())
    ? after
    : content.filter((b) => b.type === "text");
  return blocks
    .map((b) => {
      const list = Array.isArray(b.citations) ? b.citations : [];
      const refs = cite
        ? [
            ...new Set(
              list
                .map((c) => c as { url?: unknown; title?: unknown })
                .filter((c) => typeof c.url === "string" && /^https?:\/\//.test(c.url))
                .map((c) => cite({ url: c.url as string, title: String(c.title ?? c.url) })),
            ),
          ]
        : [];
      return (b.text ?? "") + refs.map((r) => `[${r}]`).join("");
    })
    .join("")
    .trim();
}
export type LlmAdapter = (request: AgentRequest) => Promise<AgentResult>;

export class LlmError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AnthropicEnv = {
  anthropicKey: string;
  model: string;
  /** Preços cadastrados na biblioteca (senão, os de tabela da Claude). */
  price?: ProviderModel | null;
  baseUrl?: string;
};

/**
 * O que cada modelo aceita: raciocínio adaptativo e "effort" só nos Claude
 * 4.6 em diante (o Haiku 4.5 não aceita); o fallback no servidor, nos Opus 5
 * e Fable.
 */
export function claudeFeatures(model: string) {
  const adaptive =
    /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/.test(model);
  const fallbacks = /^claude-(opus-5|fable-5)/.test(model);
  return { adaptive, fallbacks };
}

/** O pedido quando a IA termina a vez sem escrever a resposta. */
export const ANSWER_NUDGE =
  "Escreva agora a resposta final à minha pergunta, com base no que você já encontrou (cite as fontes [S#]). Se não encontrou nada relevante, diga isso.";

type Client = Pick<Anthropic, "beta">;

/**
 * Claude, com cache das instruções e ferramentas executadas em paralelo.
 * `client` só é passado nos testes.
 */
export function anthropicAdapter(
  env: AnthropicEnv,
  client?: Client,
): LlmAdapter {
  return async (request) => {
    if (!env.anthropicKey && !client)
      throw new LlmError(
        503,
        "A MAVI não está configurada no servidor. Falta na Vercel: ANTHROPIC_API_KEY.",
      );
    const api: Client =
      client ??
      new Anthropic({
        apiKey: env.anthropicKey,
        maxRetries: 2,
        ...(env.baseUrl ? { baseURL: env.baseUrl } : {}),
      });
    const meter = newMeter(env.model);
    const features = claudeFeatures(env.model);
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      ...request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
        // As entradas chegam em streaming; cada executor confere os campos.
        eager_input_streaming: true,
      })),
      // Busca e leitura de páginas: rodam no servidor da Claude.
      ...(request.webSearch
        ? [
            {
              type: "web_search_20260209",
              name: "web_search",
              max_uses: 6,
            } satisfies Anthropic.Beta.BetaWebSearchTool20260209,
            {
              type: "web_fetch_20260209",
              name: "web_fetch",
              max_uses: 4,
            } satisfies Anthropic.Beta.BetaWebFetchTool20260209,
          ]
        : []),
    ];
    let webSearches = 0;
    const messages: Anthropic.Beta.BetaMessageParam[] = request.messages.map(
      (m) => ({ role: m.role, content: m.content }),
    );
    const maxRounds = request.maxRounds ?? 6;
    // Uma resposta sem texto ganha uma segunda chance (uma só).
    let nudged = false;
    for (let round = 0; ; round++) {
      const last = round >= maxRounds;
      const stream = api.beta.messages.stream(
        {
          model: env.model,
          // Espaço para raciocinar sobre muitos trechos e ainda responder.
          max_tokens: request.maxTokens ?? 32000,
          ...(features.fallbacks
            ? {
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default" as const,
              }
            : {}),
          // O resumo do raciocínio aparece para a pessoa enquanto a IA trabalha.
          ...(features.adaptive
            ? {
                thinking: {
                  type: "adaptive" as const,
                  display: "summarized" as const,
                },
                output_config: { effort: request.effort ?? "medium" },
              }
            : {}),
          system: [
            {
              type: "text",
              text: request.instructions,
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text",
              text: request.context,
              ...(request.cacheContext
                ? { cache_control: { type: "ephemeral" as const } }
                : {}),
            },
          ],
          ...(tools.length ? { tools } : {}),
          // Depois do limite de rodadas, só a resposta.
          ...(last && tools.length
            ? { tool_choice: { type: "none" as const } }
            : {}),
          messages,
        },
        { signal: request.signal },
      );
      if (request.onEvent) {
        const emit = request.onEvent;
        stream.on("thinking", (delta) =>
          emit({ type: "thinking", text: delta }),
        );
        stream.on("text", (delta) => emit({ type: "text", text: delta }));
        stream.on("contentBlock", (block) => {
          if (block.type === "server_tool_use")
            emit({ type: "server_tool", name: block.name, input: block.input });
        });
      }
      const message = await stream.finalMessage();
      addUsage(meter, message.model, message.usage, env.price);
      const searches =
        Number(
          (message.usage as { server_tool_use?: { web_search_requests?: number } })
            .server_tool_use?.web_search_requests,
        ) || 0;
      webSearches += searches;
      meter.cost += searches * WEB_SEARCH_PRICE;
      if (message.stop_reason === "refusal")
        throw new LlmError(
          422,
          "A MAVI não respondeu a esta pergunta. Tente reformular.",
        );
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      const calls = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (message.stop_reason === "tool_use" && calls.length && !last) {
        request.onEvent?.({ type: "round_end", tools: calls.length });
        messages.push({ role: "assistant", content: message.content });
        const results = await Promise.all(
          calls.map(async (call) => {
            try {
              return {
                type: "tool_result" as const,
                tool_use_id: call.id,
                content: await request.execute(call.name, call.input),
              };
            } catch (e) {
              return {
                type: "tool_result" as const,
                tool_use_id: call.id,
                content: `Erro: ${(e as Error).message}`,
                is_error: true,
              };
            }
          }),
        );
        messages.push({ role: "user", content: results });
        continue;
      }
      const text = answerText(message.content as Block[], request.onCitation);
      if (!text) {
        // Terminou só raciocinando (ou sem espaço): pede a resposta com o
        // que já encontrou, sem novas ferramentas.
        if (!nudged && message.stop_reason !== "stop_sequence") {
          nudged = true;
          request.onEvent?.({ type: "round_end", tools: 0 });
          // A vez sem texto não volta (só raciocínio): vai só o pedido.
          messages.push({ role: "user", content: ANSWER_NUDGE });
          round = Math.max(round, maxRounds - 1);
          continue;
        }
        const kinds = message.content.map((b) => b.type).join(", ") || "nada";
        console.error("IA sem resposta", {
          model: message.model,
          stop_reason: message.stop_reason,
          blocks: kinds,
          round,
          usage: message.usage,
        });
        throw new LlmError(
          502,
          `A MAVI não devolveu resposta (motivo: ${message.stop_reason ?? "desconhecido"}; veio: ${kinds}). Tente de novo.`,
        );
      }
      return {
        text:
          message.stop_reason === "max_tokens"
            ? `${text}\n\n(A resposta foi cortada por ser longa demais.)`
            : text,
        meter,
        rounds: round,
        webSearches,
      };
    }
  };
}

/** Uma mensagem de erro para a tela, qualquer que tenha sido a falha. */
export function llmFriendlyError(err: unknown): string {
  if (err instanceof LlmError) return err.message;
  if (err instanceof Anthropic.AuthenticationError)
    return "A chave da API da Claude (ANTHROPIC_API_KEY) foi recusada. Confira a variável na Vercel.";
  if (err instanceof Anthropic.RateLimitError)
    return "Limite de uso da API da Claude atingido. Tente de novo em alguns minutos.";
  if (err instanceof Anthropic.APIError)
    return `A API da Claude respondeu com erro (${err.status ?? "sem status"}). Tente de novo.`;
  return "Não foi possível responder agora. Tente de novo.";
}

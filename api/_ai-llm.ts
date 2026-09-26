import Anthropic from "@anthropic-ai/sdk";
import { addUsage, newMeter, type Meter } from "./_social-leads.js";

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
  | { type: "round_end"; tools: number };
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
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
};
export type AgentResult = { text: string; meter: Meter; rounds: number };
export type LlmAdapter = (request: AgentRequest) => Promise<AgentResult>;

export class LlmError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AnthropicEnv = { anthropicKey: string; model: string };

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
        "A IA não está configurada no servidor. Falta na Vercel: ANTHROPIC_API_KEY.",
      );
    const api: Client =
      client ?? new Anthropic({ apiKey: env.anthropicKey, maxRetries: 2 });
    const meter = newMeter(env.model);
    const tools: Anthropic.Beta.BetaToolUnion[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
      // As entradas chegam em streaming; cada executor confere os campos.
      eager_input_streaming: true,
    }));
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
          max_tokens: 32000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          // O resumo do raciocínio aparece para a pessoa enquanto a IA trabalha.
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "medium" },
          system: [
            {
              type: "text",
              text: request.instructions,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: request.context },
          ],
          tools,
          // Depois do limite de rodadas, só a resposta.
          ...(last ? { tool_choice: { type: "none" as const } } : {}),
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
      }
      const message = await stream.finalMessage();
      addUsage(meter, message.model, message.usage);
      if (message.stop_reason === "refusal")
        throw new LlmError(
          422,
          "A IA não respondeu a esta pergunta. Tente reformular.",
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
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
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
          `A IA não devolveu resposta (motivo: ${message.stop_reason ?? "desconhecido"}; veio: ${kinds}). Tente de novo.`,
        );
      }
      return {
        text:
          message.stop_reason === "max_tokens"
            ? `${text}\n\n(A resposta foi cortada por ser longa demais.)`
            : text,
        meter,
        rounds: round,
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

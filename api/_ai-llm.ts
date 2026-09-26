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

/** Claude, com cache das instruções e ferramentas executadas em paralelo. */
export function anthropicAdapter(env: AnthropicEnv): LlmAdapter {
  return async (request) => {
    if (!env.anthropicKey)
      throw new LlmError(
        503,
        "A IA não está configurada no servidor. Falta na Vercel: ANTHROPIC_API_KEY.",
      );
    const client = new Anthropic({ apiKey: env.anthropicKey, maxRetries: 2 });
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
    for (let round = 0; ; round++) {
      const last = round >= maxRounds;
      const message = await client.beta.messages
        .stream(
          {
            model: env.model,
            max_tokens: 16000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            thinking: { type: "adaptive" },
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
        )
        .finalMessage();
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
      if (!text)
        throw new LlmError(502, "A IA não devolveu resposta. Tente de novo.");
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

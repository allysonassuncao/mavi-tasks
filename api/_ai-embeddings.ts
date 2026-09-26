/**
 * IA do MAVI · vetores de significado (embeddings) pela API da OpenAI.
 *
 * Um só lugar conhece o provedor: trocar de modelo ou de fornecedor é mudar
 * este arquivo e reindexar (cada trecho guarda o modelo que gerou o vetor).
 * O tamanho do vetor é fixo em 1536 (coluna halfvec(1536) do banco); os
 * modelos text-embedding-3-* aceitam o parâmetro "dimensions".
 */

export const EMBEDDING_DIMENSIONS = 1536;
/** US$ por milhão de tokens. */
const PRICES: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
};
export const embeddingCost = (model: string, tokens: number) =>
  ((PRICES[model] ?? PRICES["text-embedding-3-small"]) * tokens) / 1e6;

export type EmbeddingEnv = { openaiKey: string; embeddingModel: string };
export type Embedder = (
  texts: string[],
) => Promise<{ vectors: number[][]; tokens: number; model: string }>;

export class EmbeddingError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Um lote de textos (até 2048 por chamada, ~300 mil tokens). Tenta de novo em
 * 429 e 5xx, respeitando o retry-after.
 */
export function openAiEmbedder(
  env: EmbeddingEnv,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  return async (texts) => {
    if (!env.openaiKey)
      throw new EmbeddingError(
        503,
        "A busca da IA não está configurada no servidor. Falta na Vercel: OPENAI_API_KEY.",
      );
    if (!texts.length)
      return { vectors: [], tokens: 0, model: env.embeddingModel };
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.embeddingModel,
          input: texts.map((t) => t.slice(0, 24000) || " "),
          dimensions: EMBEDDING_DIMENSIONS,
          encoding_format: "float",
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          data: { index: number; embedding: number[] }[];
          usage?: { total_tokens?: number };
          model?: string;
        };
        const vectors: number[][] = new Array(texts.length);
        for (const d of body.data) vectors[d.index] = d.embedding;
        return {
          vectors,
          tokens: body.usage?.total_tokens ?? 0,
          model: env.embeddingModel,
        };
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 4) {
        const detail = await res.text().catch(() => "");
        throw new EmbeddingError(
          res.status === 401 ? 503 : 502,
          res.status === 401
            ? "A chave da OpenAI (OPENAI_API_KEY) foi recusada. Confira a variável na Vercel."
            : `A OpenAI respondeu com erro (${res.status}). ${detail.slice(0, 200)}`,
        );
      }
      const after = Number(res.headers.get("retry-after"));
      await sleep(
        Number.isFinite(after) && after > 0
          ? Math.min(after * 1000, 20000)
          : 500 * 2 ** attempt,
      );
    }
  };
}

/** O vetor no formato do pgvector ("[0.1,0.2,…]"), com a precisão do halfvec. */
export const vectorLiteral = (v: number[]) =>
  `[${v.map((x) => Number(x.toPrecision(5))).join(",")}]`;

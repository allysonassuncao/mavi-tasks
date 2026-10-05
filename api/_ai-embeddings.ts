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
 * O limite da OpenAI é de 8192 tokens por texto. Os trechos têm ~1500
 * caracteres; um texto sem pontuação nem parágrafos (lista, tabela, links)
 * pode passar disso, e com números e códigos são ~2 caracteres por token.
 */
const MAX_CHARS = 8000;

/**
 * Um lote de textos (até 2048 por chamada, ~300 mil tokens). Tenta de novo em
 * 429 e 5xx, respeitando o retry-after. O texto que ainda passar do limite de
 * tokens é cortado pela metade até caber: um trecho grande não trava o lote.
 */
export function openAiEmbedder(
  env: EmbeddingEnv,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  return async (texts) => {
    if (!env.openaiKey)
      throw new EmbeddingError(
        503,
        "A busca da MAVI não está configurada no servidor. Falta na Vercel: OPENAI_API_KEY.",
      );
    if (!texts.length)
      return { vectors: [], tokens: 0, model: env.embeddingModel };
    const input = texts.map((t) => t.slice(0, MAX_CHARS) || " ");
    for (let attempt = 0, cuts = 0; ; attempt++) {
      const res = await fetchImpl("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.embeddingModel,
          input,
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
      const detail =
        !retryable || attempt >= 4 ? await res.text().catch(() => "") : "";
      // "Invalid 'input[54]': maximum input length is 8192 tokens."
      const long = /input\[(\d+)\]'?: maximum input length/i.exec(detail);
      const at = long ? Number(long[1]) : -1;
      if (res.status === 400 && at >= 0 && at < input.length && cuts < 8) {
        cuts++;
        attempt--;
        input[at] = input[at].slice(0, Math.ceil(input[at].length / 2));
        continue;
      }
      if (!retryable || attempt >= 4) {
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

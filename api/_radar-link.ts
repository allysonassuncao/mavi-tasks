import { callRpc } from "./_drive.js";
import { embeddingCost, vectorLiteral } from "./_ai-embeddings.js";
import type { AiDeps, AiEnv } from "./_ai.js";

/**
 * Radar do cliente › "Vincular tarefa": as tarefas parecidas com o item
 * (ação "radar-task-suggest" de /api/drive, migração 20270321090000). A tela
 * pede public.radar_task_suggestions direto ao banco; só quando o item ainda
 * não tem vetor (ou o título/resumo mudou) ela chama esta ação, que gera o
 * vetor do texto que o banco devolve, guarda e responde com as parecidas.
 * Tudo com a sessão da pessoa: o banco confere quem edita o item e só traz
 * as tarefas que ela vê.
 */

type Suggestions = { embed?: boolean; text?: string; tasks?: { id: string; similarity: number }[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 40) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function handleRadarSuggest(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: Pick<AiDeps, "fetch" | "embed">,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Record<string, unknown>;
  const company = str(req.company);
  const item = str(req.item);
  if (!UUID.test(company) || !UUID.test(item)) return fail(400, "Item inválido.");
  const ask = (embedding: string | null) =>
    callRpc<Suggestions>(env, deps.fetch, authorization, "radar_task_suggestions", {
      p_company: company,
      p_item: item,
      p_embedding: embedding,
    });

  const first = await ask(null);
  if (!first.ok) return fail(first.status, first.error);
  if (!first.data?.embed) return { status: 200, body: { tasks: first.data?.tasks ?? [] } };
  // Sem a chave da OpenAI ou acima do limite de uso, só não há sugestões.
  if (!env.openaiKey) return { status: 200, body: { tasks: [] } };
  const limits = await callRpc<{ blocked: boolean }>(env, deps.fetch, authorization, "ai_check_limits", {
    p_company: company,
    p_client: null,
    p_contract: null,
    p_project: null,
  });
  if (limits.ok && limits.data?.blocked) return { status: 200, body: { tasks: [] } };

  let out: Awaited<ReturnType<AiDeps["embed"]>>;
  try {
    out = await deps.embed([str(first.data.text, 2000)]);
  } catch {
    return { status: 200, body: { tasks: [] } };
  }
  if (!out.vectors[0]) return { status: 200, body: { tasks: [] } };
  const [second] = await Promise.all([
    ask(vectorLiteral(out.vectors[0])),
    callRpc(env, deps.fetch, authorization, "ai_log_usage", {
      p_company: company,
      p_module: "radar",
      p_kind: "radar_task_link",
      p_client: null,
      p_contract: null,
      p_project: null,
      p_recording: null,
      p_model: out.model,
      p_input: 0,
      p_output: 0,
      p_cache_read: 0,
      p_cache_write: 0,
      p_embedding: out.tokens,
      p_cost: Math.round(embeddingCost(out.model, out.tokens) * 1e6) / 1e6,
    }).catch(() => null),
  ]);
  if (!second.ok) return fail(second.status, second.error);
  return { status: 200, body: { tasks: second.data?.tasks ?? [] } };
}

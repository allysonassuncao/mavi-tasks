import { callRpc } from "./_drive.js";
import { adapterFor, routeConfig, type ResolvedRoute } from "./_ai-providers.js";
import { workerAuthorized } from "./_copilot.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import {
  HS_INSTRUCTIONS,
  evidenceIndex,
  hsPrompt,
  hsScore,
  meetingCriterion,
  parseHsAnswer,
  paymentCriterion,
  type HsCriteria,
  type HsPack,
} from "../src/cs-hs.js";
import type { CsRules } from "../src/cs-engine.js";

/**
 * Customer Success · sugestão de Health Score (ação "cs-hs" de /api/ai,
 * migração 20270524090000). O pg_cron acorda o worker quando há sugestão
 * pendente (do dia 25 ao dia 5, ou quando um líder pede): ele pega alguns
 * clientes, decide Pagamento em dia e Reunião pelos dados, pergunta à MAVI
 * (funcionalidade 'cs_health_score') Meta batida, Percepção de valor e
 * Aprovação de criativos com a evidência, e grava com o custo.
 */

type Row = Record<string, unknown>;
type Job = { company_id: string; cs_client_id: string; month: string; today: string; rules: Partial<CsRules>; pack: HsPack };
export type CsHsEnv = AiEnv & { csHsBudgetMs?: number };

async function workerRpc<T>(env: CsHsEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
  if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status });
  return r.data;
}

/** Um cliente: os dois critérios pelos dados e os três pela MAVI. */
export async function suggestOne(env: CsHsEnv, deps: AiDeps, job: Job) {
  const p = job.pack;
  const { refs } = evidenceIndex(p);
  const route = await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
    p_company: job.company_id,
    p_feature: "cs_health_score",
  }).catch(() => null);
  const config = route && route.key_cipher ? routeConfig(env, route) : null;
  if (!config && !env.anthropicKey) throw new Error("Sem provedor de IA para a sugestão de Health Score.");
  const llm = config ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(config) : deps.llm;
  const result = await llm({
    instructions: HS_INSTRUCTIONS,
    context: "",
    messages: [{ role: "user", content: hsPrompt(p, job.month) }],
    tools: [],
    execute: async () => "",
    maxRounds: 0,
    effort: "low",
    maxTokens: 1500,
  });
  const ai = parseHsAnswer(result.text, refs);
  const criteria: HsCriteria = {
    ...ai,
    payment: paymentCriterion(p, job.today),
    meeting: meetingCriterion(p),
  };
  const { score, band } = hsScore(criteria, job.rules);
  return {
    company_id: job.company_id,
    cs_client_id: job.cs_client_id,
    month: job.month,
    criteria,
    score,
    band,
    model: result.meter.model || config?.model || env.model,
    usage: {
      model: result.meter.model || config?.model || env.model,
      input: result.meter.input,
      output: result.meter.output,
      cache_read: result.meter.cacheRead,
      cache_write: result.meter.cacheWrite,
      cost: Math.round(result.meter.cost * 1e6) / 1e6,
      ...(route ? { provider_id: route.provider_id, provider: route.provider } : {}),
    },
  };
}

export async function handleCsHsWorker(
  authorization: string | null,
  env: CsHsEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Row }> {
  if (!workerAuthorized(authorization, env)) return { status: 401, body: { error: "Não autorizado." } };
  const started = Date.now();
  const budget = env.csHsBudgetMs ?? 50_000;
  const stats = { done: 0, failed: 0 };
  try {
    while (Date.now() - started < budget - 15_000) {
      const jobs = await workerRpc<Job[]>(env, deps, "cs_hs_claim", { p_limit: 6 });
      if (!jobs.length) break;
      const items: Row[] = [];
      // Três clientes ao mesmo tempo.
      for (let i = 0; i < jobs.length; i += 3)
        await Promise.all(
          jobs.slice(i, i + 3).map(async (job) => {
            try {
              items.push(await suggestOne(env, deps, job));
              stats.done++;
            } catch (e) {
              stats.failed++;
              console.error("cs-hs", job.cs_client_id, (e as Error).message);
              items.push({ company_id: job.company_id, cs_client_id: job.cs_client_id, month: job.month, error: (e as Error).message });
            }
          }),
        );
      await workerRpc<number>(env, deps, "cs_hs_store", { p_items: items });
    }
    return { status: 200, body: stats };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return { status: typeof e.status === "number" ? e.status : 500, body: { error: e.message ?? "Erro na sugestão de HS.", ...stats } };
  }
}

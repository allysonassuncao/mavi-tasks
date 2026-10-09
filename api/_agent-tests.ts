import crypto from "node:crypto";
import { engine, type BuilderEnv, type EngineAgent } from "./_agent-builder.js";
import { planRun, type TestLimits } from "./_agent-test-plan.js";

/**
 * Agentes MAVI › Testes com leads simulados (migração 20270707090000). Os
 * tetos do Painel da MAVI valem para toda bateria: conversas e trocas por
 * bateria, US$ por bateria e por agente no mês. De hora em hora o pg_cron
 * acorda o /api/ai ("agent-tests"): começa a bateria periódica dos agentes
 * vencidos e avisa na Caixa de entrada as que acharam problemas.
 */

type Fetch = typeof fetch;

type RunSummary = { score?: number | null; issues?: Record<string, { n: number }>; gaps?: number; severe?: number; conclusion?: string };

const fmtScore = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("pt-BR", { maximumFractionDigits: 1 }));

/** O aviso de uma periódica (só quando achou problema ou lacuna). */
export function testNotice(run: { id: string; agent_id: string; agent_name: string; summary: RunSummary | null }) {
  const s = run.summary ?? {};
  const problems = Object.values(s.issues ?? {}).reduce((n, x) => n + x.n, 0);
  if (!problems && !s.gaps) return null;
  const parts = [`nota ${fmtScore(s.score)}`, `${problems} problema(s)`, ...(s.gaps ? [`${s.gaps} lacuna(s)`] : [])];
  return {
    title: `Teste periódico de ${run.agent_name}: ${parts.join(" · ")}`,
    body: (s.conclusion || "Os leads simulados acharam pontos a melhorar no agente.").slice(0, 300),
    link: `/agente-conversacional?agente=${run.agent_id}&aba=testes&bateria=${run.id}`,
  };
}

export type TestsWorkerEnv = BuilderEnv & { workerSecret: string };
export const testsWorkerEnv = (builder: BuilderEnv, env: Record<string, string | undefined> = process.env): TestsWorkerEnv => ({
  ...builder,
  workerSecret: env.AI_WORKER_SECRET ?? "",
});

function authorized(authorization: string | null, secret: string) {
  const token = Buffer.from(authorization?.replace(/^Bearer\s+/, "") ?? "");
  const s = Buffer.from(secret);
  return s.length > 0 && token.length === s.length && crypto.timingSafeEqual(token, s);
}

async function workerRpc<T>(env: TestsWorkerEnv, f: Fetch, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await f(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: env.supabaseKey, Authorization: `Bearer ${env.supabaseKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_secret: env.workerSecret, ...args }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Agent = EngineAgent & { bindings?: number; draft_updated_by?: string | null };

export async function handleAgentTests(
  authorization: string | null,
  env: TestsWorkerEnv,
  deps: { fetch: Fetch },
): Promise<{ status: number; body: unknown }> {
  if (!authorized(authorization, env.workerSecret)) return { status: 401, body: { error: "Não autorizado." } };
  if (!env.engineUrl || !env.engineKey) return { status: 200, body: { skipped: "motor não configurado" } };
  const f = deps.fetch;
  const out = { started: 0, capped: 0, notified: 0, failed: 0 };
  const { agents } = await engine<{ agents: Agent[] }>(env, f, "GET", "/v1/agents");
  const live = agents.filter((a) => a.published_version && (a.bindings ?? 0) > 0 && a.status === "active" && a.external_ref?.mavi_company_id);
  const byId = new Map(agents.map((a) => [a.id, a]));

  // 1. Periódicas vencidas (até 5 por hora, para espalhar o custo e o motor).
  const due = await workerRpc<{ agent_id: string; limits: TestLimits }[]>(env, f, "agent_test_due", {
    p_agents: live.map((a) => ({ agent_id: a.id, company_id: a.external_ref.mavi_company_id })),
  });
  for (const d of due.slice(0, 5)) {
    const a = byId.get(d.agent_id)!;
    try {
      const { month_cost_usd } = await engine<{ month_cost_usd: number }>(env, f, "GET", `/v1/agents/${a.id}/test-runs?limit=1`);
      let runId: string | null = null;
      const p = planRun(d.limits, month_cost_usd, { kind: "scheduled" });
      if (p.ok) {
        const r = await engine<{ runs: string[] }>(env, f, "POST", `/v1/agents/${a.id}/test-runs`, {
          kind: "scheduled",
          use: "published",
          ...p.plan,
          created_by: "MAVI (teste periódico)",
        });
        runId = r.runs[0] ?? null;
        out.started++;
      } else out.capped++;
      // Marca mesmo sem rodar (teto do mês): a próxima tentativa é no próximo ciclo.
      await workerRpc(env, f, "agent_test_scheduled", { p_agent: a.id, p_company: a.external_ref.mavi_company_id, p_run: runId });
    } catch (e) {
      out.failed++;
      console.error("teste periódico", a.id, (e as Error).message);
    }
  }

  // 2. Avisos das periódicas terminadas.
  const since = await workerRpc<string>(env, f, "agent_test_since", {});
  const { runs } = await engine<{ runs: { id: string; agent_id: string; agent_name: string; status: string; summary: RunSummary | null }[] }>(
    env,
    f,
    "POST",
    "/v1/test-runs/finished",
    { since, kind: "scheduled" },
  );
  for (const run of runs) {
    const a = byId.get(run.agent_id);
    const n = testNotice(run);
    if (!a?.external_ref?.mavi_company_id || !n) continue;
    try {
      await workerRpc(env, f, "agent_test_notify", {
        p_run: run.id,
        p_agent: run.agent_id,
        p_company: a.external_ref.mavi_company_id,
        p_client: a.external_ref.mavi_client_id ?? null,
        p_creator: a.draft_updated_by ?? "",
        p_title: n.title,
        p_body: n.body,
        p_link: n.link,
      });
      out.notified++;
    } catch (e) {
      out.failed++;
      console.error("aviso de teste", run.id, (e as Error).message);
    }
  }
  return { status: 200, body: out };
}

import crypto from "node:crypto";
import { engine, type BuilderEnv, type EngineAgent } from "./_agent-builder.js";

/**
 * Agentes MAVI › Insights: o resumo semanal na Caixa de entrada
 * (migração 20270705090000_agent_weekly_report). O pg_cron acorda o /api/ai
 * ("agent-weekly") nas manhãs de segunda; para cada agente com o resumo
 * ligado, o motor monta o relatório da semana anterior e a Leitura da MAVI, e
 * o aviso vai para quem o agente tem configurado. Uma vez por agente e semana:
 * o que não couber numa rodada vai na próxima.
 */

type Fetch = typeof fetch;
type Agent = EngineAgent & { bindings?: number; draft_updated_by?: string | null };
type Report = { metrics: { conversations: number; meetings: number; handoffs: number }; gaps: { coverage: number | null } };
/** O motor devolve a linha guardada: { reading: { reading: {summary, points}, model, … } }. */
type Reading = { reading: { reading: { summary: string } } };

export type WeeklyEnv = BuilderEnv & { workerSecret: string; budgetMs: number };

export function weeklyEnv(builder: BuilderEnv, env: Record<string, string | undefined> = process.env): WeeklyEnv {
  return { ...builder, workerSecret: env.AI_WORKER_SECRET ?? "", budgetMs: Number(env.AGENT_WEEKLY_BUDGET_MS) || 240_000 };
}

function authorized(authorization: string | null, secret: string) {
  const token = Buffer.from(authorization?.replace(/^Bearer\s+/, "") ?? "");
  const s = Buffer.from(secret);
  return s.length > 0 && token.length === s.length && crypto.timingSafeEqual(token, s);
}

/** A semana anterior (segunda a domingo), no horário de Brasília. */
export function lastWeek(now = new Date()): { from: string; to: string } {
  const sp = new Date(now.getTime() - 3 * 3600_000);
  const day = sp.getUTCDay() || 7; // segunda = 1 … domingo = 7
  const monday = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate()) - (day - 1) * 86_400_000;
  const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: ymd(monday - 7 * 86_400_000), to: ymd(monday - 86_400_000) };
}

const dm = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;

/** O texto do aviso: os números da semana e o começo da Leitura da MAVI. */
export function weeklyNotice(a: { id: string; name: string }, week: { from: string; to: string }, r: Report, reading: string) {
  const m = r.metrics;
  const numbers = [
    plural(m.conversations, "conversa", "conversas"),
    plural(m.meetings, "reunião marcada", "reuniões marcadas"),
    plural(m.handoffs, "passada para a equipe", "passadas para a equipe"),
    ...(r.gaps.coverage != null ? [`cobertura do treinamento ${Math.round(r.gaps.coverage * 100)}%`] : []),
  ].join(" · ");
  return {
    title: `${a.name}: a semana de ${dm(week.from)} a ${dm(week.to)}`,
    body: `${numbers}. ${reading}`.slice(0, 300),
    link: `/agente-conversacional?agente=${a.id}&aba=insights&de=${week.from}&ate=${week.to}`,
  };
}

async function workerRpc<T>(env: WeeklyEnv, f: Fetch, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await f(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: env.supabaseKey, Authorization: `Bearer ${env.supabaseKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_secret: env.workerSecret, ...args }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function handleAgentWeekly(
  authorization: string | null,
  env: WeeklyEnv,
  deps: { fetch: Fetch; now?: () => number },
): Promise<{ status: number; body: unknown }> {
  if (!authorized(authorization, env.workerSecret)) return { status: 401, body: { error: "Não autorizado." } };
  if (!env.engineUrl || !env.engineKey) return { status: 200, body: { skipped: "motor não configurado" } };
  const f = deps.fetch;
  const now = deps.now ?? Date.now;
  const deadline = now() + env.budgetMs;
  const week = lastWeek(new Date(now()));

  const { agents } = await engine<{ agents: Agent[] }>(env, f, "GET", "/v1/agents");
  const live = agents.filter((a) => a.published_version && (a.bindings ?? 0) > 0 && a.external_ref?.mavi_company_id && a.external_ref?.mavi_client_id);
  const targets = await workerRpc<{ agent_id: string; recipients: string[] }[]>(env, f, "agent_report_targets", {
    p_week: week.from,
    p_agents: live.map((a) => ({
      agent_id: a.id,
      company_id: a.external_ref.mavi_company_id,
      client_id: a.external_ref.mavi_client_id,
      creator: a.draft_updated_by ?? "",
    })),
  });
  const byId = new Map(live.map((a) => [a.id, a]));
  const stats = { agents: targets.length, sent: 0, quiet: 0, failed: 0, left: 0 };

  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      if (now() > deadline - 30_000) {
        stats.left = targets.length - next;
        return;
      }
      const t = targets[next++]!;
      const a = byId.get(t.agent_id);
      if (!a) continue;
      try {
        const { report } = await engine<{ report: Report }>(env, f, "GET", `/v1/agents/${a.id}/report?from=${week.from}&to=${week.to}`);
        // Semana sem conversa: nada a contar (e não gasta a Leitura).
        if (!report.metrics.conversations) {
          stats.quiet++;
          continue;
        }
        const r = await engine<Reading>(env, f, "POST", `/v1/agents/${a.id}/reading`, { from: week.from, to: week.to, by: "MAVI (resumo semanal)" });
        const n = weeklyNotice(a, week, report, r.reading.reading.summary);
        await workerRpc(env, f, "agent_report_send", {
          p_agent: a.id,
          p_company: a.external_ref.mavi_company_id,
          p_week: week.from,
          p_users: t.recipients,
          p_title: n.title,
          p_body: n.body,
          p_link: n.link,
        });
        stats.sent++;
      } catch (e) {
        stats.failed++;
        console.error("resumo semanal do agente", a.id, (e as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { status: 200, body: { week, ...stats } };
}

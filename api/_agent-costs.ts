import crypto from "node:crypto";
import { engine, type BuilderEnv, type EngineAgent } from "./_agent-builder.js";

/**
 * Agentes MAVI › Custos (migração 20270706090000_agent_costs). De hora em
 * hora o pg_cron acorda o /api/ai ("agent-costs-sync"): a PTAX dos últimos
 * dias vem do Banco Central e as somas por dia dos gastos vêm do motor (a
 * cópia que os Dashboards leem). A tela lê o motor direto, com a PTAX daqui.
 */

type Fetch = typeof fetch;
export type CostsSyncEnv = BuilderEnv & { workerSecret: string };

export function costsSyncEnv(builder: BuilderEnv, env: Record<string, string | undefined> = process.env): CostsSyncEnv {
  return { ...builder, workerSecret: env.AI_WORKER_SECRET ?? "" };
}

/** O grupo de cada tipo de gasto (o mesmo do motor). */
export function costGroup(source: string): string {
  if (source === "reply" || source === "followup") return "ia";
  if (source.startsWith("media_")) return "midias";
  if (source === "retrieval" || source === "knowledge") return "conhecimento";
  if (["summary", "gaps", "insight", "reading"].includes(source)) return "analises";
  if (source === "waba_template") return "whatsapp";
  return "testes";
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const mdy = (d: string) => `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(0, 4)}`;

/** PTAX de venda do fechamento de cada dia útil do período (Banco Central, Olinda). */
export async function fetchPtax(f: Fetch, from: string, to: string): Promise<{ day: string; usd_brl: number }[]> {
  const url =
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)" +
    `?@dataInicial='${mdy(from)}'&@dataFinalCotacao='${mdy(to)}'&$format=json&$select=cotacaoVenda,dataHoraCotacao`;
  const res = await f(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`PTAX ${res.status}`);
  const j = (await res.json()) as { value?: { cotacaoVenda?: number; dataHoraCotacao?: string }[] };
  // Um valor por dia (o último publicado no dia).
  const byDay = new Map<string, number>();
  for (const v of j.value ?? []) if (v.dataHoraCotacao && v.cotacaoVenda) byDay.set(v.dataHoraCotacao.slice(0, 10), v.cotacaoVenda);
  return [...byDay].map(([day, usd_brl]) => ({ day, usd_brl }));
}

function authorized(authorization: string | null, secret: string) {
  const token = Buffer.from(authorization?.replace(/^Bearer\s+/, "") ?? "");
  const s = Buffer.from(secret);
  return s.length > 0 && token.length === s.length && crypto.timingSafeEqual(token, s);
}

async function workerRpc<T>(env: CostsSyncEnv, f: Fetch, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await f(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: env.supabaseKey, Authorization: `Bearer ${env.supabaseKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_secret: env.workerSecret, ...args }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type DailyRow = {
  day: string;
  agent_id: string;
  company_id: string;
  inbox_id: string;
  source: string;
  model: string;
  simulation: boolean;
  events: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  units: number;
};

/** As somas do motor com o cliente/produto do MAVI Tasks de cada agente. */
export function mapDailyRows(
  rows: DailyRow[],
  agents: Pick<EngineAgent, "id" | "name" | "external_ref">[],
  inboxes: { inbox_id: string; inbox_name: string }[],
) {
  const byAgent = new Map(agents.map((a) => [a.id, a]));
  const inboxName = new Map(inboxes.map((i) => [i.inbox_id, i.inbox_name]));
  return rows.flatMap((r) => {
    const a = byAgent.get(r.agent_id);
    const ref = a?.external_ref ?? {};
    if (!ref.mavi_company_id) return [];
    return [
      {
        day: r.day,
        agent_id: r.agent_id,
        agent_name: a?.name ?? "",
        company_id: ref.mavi_company_id,
        client_id: ref.mavi_client_id ?? "",
        contract_id: ref.mavi_contract_id ?? "",
        inbox_id: r.inbox_id,
        inbox_name: inboxName.get(r.inbox_id) ?? "",
        source: r.source,
        cost_group: costGroup(r.source),
        model: r.model,
        simulation: r.simulation,
        events: r.events,
        cost_usd: r.cost_usd,
        tokens_in: Number(r.tokens_in),
        tokens_out: Number(r.tokens_out),
        units: r.units,
      },
    ];
  });
}

export async function handleAgentCostsSync(
  authorization: string | null,
  env: CostsSyncEnv,
  deps: { fetch: Fetch; now?: () => number },
): Promise<{ status: number; body: unknown }> {
  if (!authorized(authorization, env.workerSecret)) return { status: 401, body: { error: "Não autorizado." } };
  const f = deps.fetch;
  const now = (deps.now ?? Date.now)() - 3 * 3600_000; // Brasília
  const out: Record<string, unknown> = {};

  // PTAX dos últimos 10 dias (refaz os que mudaram; fim de semana não tem).
  try {
    const rates = await fetchPtax(f, ymd(now - 10 * 86_400_000), ymd(now));
    out.ptax = await workerRpc<number>(env, f, "fx_ptax_store", { p_rows: rates });
  } catch (e) {
    out.ptax_error = (e as Error).message;
  }

  // Somas dos últimos 3 dias (hoje ainda mudando; ontem fecha de madrugada).
  if (env.engineUrl && env.engineKey) {
    const from = ymd(now - 2 * 86_400_000);
    const to = ymd(now);
    const d = await engine<{ rows: DailyRow[]; agents: EngineAgent[]; inboxes: { inbox_id: string; inbox_name: string }[] }>(
      env,
      f,
      "POST",
      "/v1/costs/daily",
      { from, to },
    );
    out.rows = await workerRpc<number>(env, f, "agent_costs_store", { p_from: from, p_to: to, p_rows: mapDailyRows(d.rows, d.agents, d.inboxes) });
  }
  return { status: 200, body: out };
}

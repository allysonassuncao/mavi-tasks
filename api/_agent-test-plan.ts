/**
 * Agentes MAVI › Testes: a bateria dentro dos tetos do Painel da MAVI
 * (migração 20270707090000). Sem dependências: o construtor e o worker usam.
 */

export type TestLimits = {
  max_conversations: number;
  max_turns: number;
  run_cap_usd: number;
  monthly_cap_usd: number;
  publish_conversations: number;
  scheduled_enabled: boolean;
  scheduled_every_days: number;
  scheduled_conversations: number;
};

export type RunPlan = { conversations: number; max_turns: number; cost_cap_usd: number };

/** Quantas conversas, trocas e quanto a bateria pode gastar; ou por que não pode rodar. */
export function planRun(
  limits: TestLimits,
  monthSpent: number,
  wanted: { kind: "manual" | "publish" | "scheduled"; conversations?: number },
): { ok: true; plan: RunPlan } | { ok: false; message: string } {
  const left = Number(limits.monthly_cap_usd) - monthSpent;
  if (left <= 0.01)
    return { ok: false, message: `O teto de testes do mês deste agente (US$ ${Number(limits.monthly_cap_usd).toFixed(2)}) já foi usado.` };
  const base =
    wanted.kind === "publish" ? limits.publish_conversations : wanted.kind === "scheduled" ? limits.scheduled_conversations : (wanted.conversations ?? limits.max_conversations);
  const conversations = Math.max(1, Math.min(Math.round(Number(base) || 1), limits.max_conversations));
  // Antes de publicar roda duas (rascunho e publicada): o que sobra do mês se divide entre elas.
  const runs = wanted.kind === "publish" ? 2 : 1;
  return { ok: true, plan: { conversations, max_turns: limits.max_turns, cost_cap_usd: Math.max(0.01, Math.min(Number(limits.run_cap_usd), left / runs)) } };
}

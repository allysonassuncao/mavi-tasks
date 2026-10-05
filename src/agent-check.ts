/**
 * A conferência de um caso do Radar com a base do Agente Conversacional do
 * cliente (o prompt do robô de WhatsApp) e a exclusão de casos — usadas pelo
 * Radar do cliente e pelo Radar pessoal (migration
 * 20270512090000_radar_agents_learning).
 */

export type AgentCheckStatus = "covered" | "missing" | "conflict" | "unrelated";
export type AgentCheck = {
  status: AgentCheckStatus;
  note?: string;
  evidence?: { prompt_id: string; workflow: string; node: string; excerpt: string }[];
  suggestion?: {
    prompt_id: string;
    workflow: string;
    node: string;
    /** O trecho a trocar; vazio: acrescentar no fim. */
    before: string;
    after: string;
    why: string;
  };
  done?: boolean;
  checked_at?: string;
};

export const AGENT_STATUS_LABEL: Record<AgentCheckStatus, string> = {
  covered: "O robô já tem essa informação",
  missing: "Falta no robô",
  conflict: "O robô tem outra informação",
  unrelated: "Não tem a ver com o robô",
};

/**
 * O prompt com a sugestão aplicada: troca o trecho (exato ou com outros
 * espaços) ou, sem trecho, acrescenta no fim. Nulo: o trecho não está mais
 * no prompt (mudou depois da conferência).
 */
export function applySuggestion(prompt: string, s: { before: string; after: string }) {
  const after = s.after.trim();
  if (!s.before.trim()) return `${prompt.replace(/\s+$/, "")}\n\n${after}`;
  const at = prompt.indexOf(s.before);
  if (at >= 0) return prompt.slice(0, at) + after + prompt.slice(at + s.before.length);
  // O mesmo trecho com outra quebra de linha ou espaço.
  const words = s.before.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const m = new RegExp(words.join("\\s+")).exec(prompt);
  if (!m) return null;
  return prompt.slice(0, m.index) + after + prompt.slice(m.index + m[0].length);
}

export type RemoveReason = "mavi_error" | "not_client" | "duplicate" | "other";
export const REMOVE_LABEL: Record<RemoveReason, string> = {
  mavi_error: "Erro da MAVI (não aconteceu ou leu errado)",
  not_client: "Não foi o cliente que falou",
  duplicate: "Repetido (já existe outro caso)",
  other: "Outro motivo",
};
/** Os motivos que desfazem o Termômetro (as falas do caso deixam de contar). */
export const REMOVE_UNDOES_TEMPERATURE: RemoveReason[] = ["mavi_error", "not_client"];

/** A mensagem depois de excluir (quantas leituras do Termômetro voltam). */
export function removedMessage(r: { temperature: number }) {
  return r.temperature > 0
    ? `Caso excluído. O Termômetro vai ler de novo ${r.temperature === 1 ? "a conversa" : `${r.temperature} conversas`} sem essas falas.`
    : "Caso excluído.";
}

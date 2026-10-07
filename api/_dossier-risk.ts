/**
 * MAVI · memória por cliente, Fase 2 (migração 20270613090000_mavi_memory_client):
 * a rota de cada mudança que a rotina do dossiê propõe, pelo risco.
 *
 * - apply: entra direto (risco baixo/médio; a tela mostra "novo" por 7 dias).
 * - suggest: risco alto — quem trabalha com o cliente confirma (14 dias).
 * - refuse: o Jev recusou — fica registrada, não chega a ninguém.
 *
 * Tudo aqui é puro (sem rede): a conferência do Jev fica em _dossier-check.ts.
 */

export type DossierRoute = "apply" | "suggest" | "refuse";
export type DossierVerdict = {
  route: DossierRoute;
  reasons: string[];
  note?: string;
  checks: Record<string, number>;
};
type Op = { op: string; id?: string; kind?: string; text?: string };
type Item = { id: string; kind: string; text: string };

/** Preço, contrato, pagamento, verba: o que custa caro errar. */
export const COMMERCIAL =
  /(pre[çc]os?\b|valor(es)?\b|r\$|\bcontrato|\bmulta|\bdesconto|\bpagamento|\bboleto|\bpix\b|\bfatura|\breembolso|\bcobran[çc]a|\bmensalidade|\bfee\b|\bor[çc]amento|\bverba|\bcancel)/i;

/** O risco pela regra, sem modelo: regra ou combinado e condição comercial. */
export function ruleRisk(op: Op, items: Item[]): string[] {
  const target = op.id ? items.find((i) => i.id === op.id) : undefined;
  const kinds = [op.kind, target?.kind];
  const texts = [op.text, target?.text].filter((t): t is string => !!t);
  const out: string[] = [];
  if (kinds.includes("rule")) out.push(op.op === "remove" ? "tira uma regra ou combinado" : "regra ou combinado");
  if (texts.some((t) => COMMERCIAL.test(t))) out.push("condição comercial");
  return out;
}

/** As respostas do Jev (0 a 1) para cada mudança. */
export type DossierAnswers = { supported?: number; contradicts?: number; elsewhere?: number; useful?: number };

/**
 * A rota: answers null = sem o Jev cadastrado (só a regra); checked false =
 * o Jev não conferiu esta (falhou ou passou do teto): vai para confirmação.
 */
export function decideDossierOp(op: Op, rule: string[], answers: DossierAnswers | null, checked = true): DossierVerdict {
  const checks: Record<string, number> = {};
  for (const [k, v] of Object.entries(answers ?? {})) if (typeof v === "number") checks[k] = Math.round(v * 1000) / 1000;
  if (op.op === "remove" || !answers) return { route: rule.length ? "suggest" : "apply", reasons: rule, checks };
  if (!checked) return { route: "suggest", reasons: [...rule, "sem conferência do Jev"], checks };
  const { supported: s, contradicts: c, elsewhere: e, useful: u } = answers;
  const refuse = [
    typeof s === "number" && s < 0.5 ? "o material citado não sustenta" : "",
    typeof e === "number" && e >= 0.6 ? "é assunto do Termômetro ou do Radar" : "",
    typeof u === "number" && u < 0.4 ? "genérico ou sem uso nas entregas" : "",
  ].filter(Boolean);
  if (refuse.length) return { route: "refuse", reasons: refuse, note: `O Jev recusou: ${refuse.join("; ")}.`, checks };
  const reasons = [
    ...rule,
    typeof c === "number" && c >= 0.5 ? "contradiz o dossiê" : "",
    typeof s === "number" && s < 0.75 ? "pouca evidência" : "",
  ].filter(Boolean);
  return { route: reasons.length ? "suggest" : "apply", reasons, checks };
}

import { CS_DEFAULT_RULES, addDays, type CsRules } from "./cs-engine.js";

/**
 * Sugestão de Health Score pela MAVI (fase 4b, migração 20270524090000).
 * Pagamento em dia e Reunião de alinhamento saem dos dados (ciclo do mês e
 * reuniões gravadas); Meta batida, Percepção de valor e Aprovação de
 * criativos a MAVI decide lendo o material do mês (campanhas, Termômetro,
 * Social Leads, WhatsApp, Radar). Cada critério leva a evidência, para o time
 * conferir antes de lançar. Puro: o worker (api/_cs-hs.ts) e a tela usam.
 */

export type HsKey = "goal" | "perception" | "payment" | "meeting" | "creatives";
export const HS_CRITERIA: { key: HsKey; label: string }[] = [
  { key: "goal", label: "Meta batida" },
  { key: "perception", label: "Percepção de valor" },
  { key: "payment", label: "Pagamento em dia" },
  { key: "meeting", label: "Reunião de alinhamento" },
  { key: "creatives", label: "Aprovação de criativos" },
];
export type HsEvidence = {
  type: "meeting" | "whatsapp" | "temperature" | "campaign" | "radar" | "social" | "cycle";
  id: string;
  title: string;
  date: string | null;
  group?: string | null;
};
export type HsCriterion = {
  /** null: sem evidência para decidir (não soma na nota sugerida). */
  value: boolean | null;
  confidence: "alta" | "media" | "baixa";
  why: string;
  evidence: HsEvidence[];
};
export type HsCriteria = Record<HsKey, HsCriterion>;

export type HsPack = {
  client: { name: string; external_id: string; kind: string; trial_month: number | null; linked: boolean; squad: string | null };
  cycle: { status: string; adimplencia: string; billing_date: string | null; paid_date: string | null; paid: number; probable: number;
    probability: string } | null;
  registered: Record<string, unknown> | null;
  meetings: { id: string; title: string; date: string; minutes: number; overview: string }[];
  temperature: { days: number; score: number | null; satisfacao: number | null; permanencia: number | null; flags: string[] } | null;
  temperature_readings: { id: string; source: string; source_id: string | null; group: string | null; message: string | null;
    title: string; date: string; reason: string; excerpt: string }[];
  campaigns: { id: string; campaign: string; platform: string; goal_results: number; budget: number; multiplier: number;
    start: string; end: string; last: { taken_on: string; spend: number; results: number; goal_status: "good" | "bad" | null } | null }[];
  social_leads: { approved: number; rejected: number; notes: { kind: string; date: string; post: number; note: string }[] } | null;
  whatsapp: { id: string; group: string; at: string; from_team: boolean; sender: string; text: string }[];
  radar: { id: string; topic: string; title: string; summary: string; status: string; severity: number; last_seen: string }[];
};

const brMoney = (v: number) => `R$ ${Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`;
const brDate = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "—");

/** Pagamento em dia: pelo ciclo do mês (até 3 dias depois da cobrança conta como em dia). */
export function paymentCriterion(p: HsPack, today: string): HsCriterion {
  const y = p.cycle;
  if (!y) return { value: null, confidence: "baixa", why: "Sem ciclo de cobrança no mês.", evidence: [] };
  const ev: HsEvidence[] = [{ type: "cycle", id: "cycle", title: `Ciclo do mês: ${y.status}, ${y.adimplencia}`, date: y.billing_date }];
  if (y.adimplencia === "INADIMPLENTE" || y.adimplencia === "PERDA")
    return { value: false, confidence: "alta", why: `O ciclo do mês está ${y.adimplencia === "PERDA" ? "em PERDA" : "inadimplente"}.`, evidence: ev };
  if (y.status === "PAGO" || y.status === "ISENTO") {
    if (y.paid_date && y.billing_date && y.paid_date > addDays(y.billing_date, 3))
      return { value: false, confidence: "alta", why: `Pagou em ${brDate(y.paid_date)}, depois da cobrança de ${brDate(y.billing_date)}.`, evidence: ev };
    return { value: true, confidence: "alta", why: y.status === "ISENTO" ? "Ciclo isento no mês." : `Pagou ${brMoney(y.paid)} em ${brDate(y.paid_date)} (cobrança ${brDate(y.billing_date)}).`, evidence: ev };
  }
  if (y.billing_date && y.billing_date >= today)
    return { value: null, confidence: "baixa", why: `A cobrança de ${brDate(y.billing_date)} ainda não venceu.`, evidence: ev };
  if (y.status === "PARCIAL")
    return { value: true, confidence: "media", why: `Pagamento parcial (${brMoney(y.paid)} de ${brMoney(y.probable)}) e adimplente.`, evidence: ev };
  return { value: false, confidence: "media", why: `A cobrança de ${brDate(y.billing_date)} venceu e não foi paga.`, evidence: ev };
}

/** Reunião de alinhamento: alguma reunião gravada com o cliente no mês. */
export function meetingCriterion(p: HsPack): HsCriterion {
  if (!p.client.linked)
    return { value: null, confidence: "baixa", why: "O cliente de CS não está ligado a um cliente do MAVI: sem reuniões para conferir.", evidence: [] };
  if (!p.meetings.length)
    return { value: false, confidence: "media", why: "Nenhuma reunião gravada com o cliente no mês (se houve reunião sem gravação, marque à mão).", evidence: [] };
  return {
    value: true, confidence: "alta",
    why: `${p.meetings.length} ${p.meetings.length === 1 ? "reunião gravada" : "reuniões gravadas"} no mês.`,
    evidence: p.meetings.map((m) => ({ type: "meeting", id: m.id, title: m.title || "Reunião", date: m.date })),
  };
}

/** O material numerado (cada item com uma referência para a MAVI citar). */
export function evidenceIndex(p: HsPack) {
  const refs = new Map<string, HsEvidence>();
  const lines: string[] = [];
  const add = (ref: string, ev: HsEvidence, text: string) => {
    refs.set(ref, ev);
    lines.push(`[${ref}] ${text}`);
  };
  if (p.campaigns.length) {
    lines.push("CAMPANHAS (ciclos com competência no mês; goal_status = Bom/Ruim do custo por resultado contra a meta do ciclo):");
    p.campaigns.forEach((c, i) =>
      add(`C${i + 1}`, { type: "campaign", id: c.id, title: c.campaign, date: c.last?.taken_on ?? c.end },
        `${c.campaign} (${c.platform}) · meta ${c.goal_results} resultados, verba ${brMoney(c.budget)} · ${c.last ? `até ${brDate(c.last.taken_on)}: ${brMoney(c.last.spend)} gastos, ${c.last.results} resultados, status ${c.last.goal_status === "good" ? "BOM" : c.last.goal_status === "bad" ? "RUIM" : "sem meta"}` : "sem números ainda"}`));
  }
  if (p.temperature) {
    const t = p.temperature;
    lines.push(`TERMÔMETRO NO MÊS (0 a 100): média ${t.score ?? "—"} em ${t.days} dias · satisfação com resultados ${t.satisfacao ?? "—"} · risco de cancelamento (permanência) ${t.permanencia ?? "—"}${t.flags.length ? ` · sinais: ${t.flags.join(", ")}` : ""}`);
  }
  if (p.temperature_readings.length) {
    lines.push("LEITURAS DO TERMÔMETRO (o que pesou):");
    p.temperature_readings.forEach((r, i) =>
      add(`T${i + 1}`, r.source === "meeting" && r.source_id
        ? { type: "meeting", id: r.source_id, title: r.title || "Reunião", date: r.date }
        : r.group && r.message
          ? { type: "whatsapp", id: r.message, group: r.group, title: r.title || "WhatsApp", date: r.date }
          : { type: "temperature", id: r.id, title: r.title || "Leitura do Termômetro", date: r.date },
      `${brDate(r.date)} ${r.title}: ${r.reason} ${r.excerpt ? `— “${r.excerpt}”` : ""}`.trim()));
  }
  if (p.social_leads) {
    const s = p.social_leads;
    add("S1", { type: "social", id: "social", title: `Social Leads: ${s.approved} aprovados, ${s.rejected} com ajuste`, date: null },
      `SOCIAL LEADS no mês: ${s.approved} posts aprovados, ${s.rejected} pedidos de ajuste${s.notes.length ? `. Observações: ${s.notes.map((n) => `${brDate(n.date)} post ${n.post} ${n.kind === "approved" ? "aprovado" : "ajuste"}: ${n.note}`).join(" | ")}` : ""}`);
  }
  if (p.radar.length) {
    lines.push("RADAR (problemas, promessas e outros tópicos que apareceram no mês):");
    p.radar.forEach((r, i) =>
      add(`R${i + 1}`, { type: "radar", id: r.id, title: r.title, date: r.last_seen },
        `${r.topic} · ${r.title} (${r.status}, gravidade ${r.severity}): ${r.summary}`));
  }
  if (p.meetings.length) {
    lines.push("REUNIÕES GRAVADAS NO MÊS:");
    p.meetings.forEach((m, i) =>
      add(`M${i + 1}`, { type: "meeting", id: m.id, title: m.title || "Reunião", date: m.date },
        `${brDate(m.date)} ${m.title} (${m.minutes} min)${m.overview ? `: ${m.overview}` : ""}`));
  }
  if (p.whatsapp.length) {
    lines.push("WHATSAPP DO MÊS (mensagens sobre aprovação, criativos, resultados e satisfação):");
    p.whatsapp.forEach((w, i) =>
      add(`W${i + 1}`, { type: "whatsapp", id: w.id, group: w.group, title: `${w.from_team ? "Time" : w.sender || "Cliente"}: ${w.text.slice(0, 80)}`, date: w.at.slice(0, 10) },
        `${brDate(w.at.slice(0, 10))} ${w.from_team ? "TIME" : `CLIENTE (${w.sender || "?"})`}: ${w.text}`));
  }
  return { refs, text: lines.join("\n") };
}

export const HS_INSTRUCTIONS = `Você é a MAVI, a inteligência de uma agência de marketing. O time de Customer Success avalia cada cliente todo mês com o Health Score: 5 critérios sim/não. Sua tarefa: sugerir três deles a partir do material do mês, com a evidência, para o time conferir antes de lançar. Seja conservadora: sem evidência, a resposta é null (o time decide), nunca um chute.

- goal (Meta batida): as campanhas do mês bateram a meta? Use o status BOM/RUIM dos ciclos (todos BOM = sim; algum RUIM = não, diga qual). Sem campanhas com status, use o que o cliente disse sobre resultados (vendas, leads, faturamento) no WhatsApp ou nas reuniões; sem nada claro, null.
- perception (Percepção de valor): o cliente percebe valor no trabalho? Use a satisfação com resultados do Termômetro (70 ou mais, em geral sim; abaixo de 40, em geral não), os sinais de alerta (cancelamento, financeiro), o tom das mensagens e reuniões e os problemas do Radar.
- creatives (Aprovação de criativos): o cliente aprovou os criativos (artes, posts, vídeos, anúncios) sem atrito? Use o Social Leads (aprovações x pedidos de ajuste) e o WhatsApp sobre artes e criativos. Muitos ajustes, reclamação ou demora = não. Sem material sobre criativos, null.

Responda SÓ com JSON, sem texto fora dele:
{"goal": {"value": true|false|null, "confidence": "alta"|"media"|"baixa", "why": "uma frase em português", "evidence": ["C1", "W3"]}, "perception": {...}, "creatives": {...}}
Em evidence, só as referências entre colchetes do material (ex.: C1, T2, S1, R1, M1, W4) que sustentam a resposta.`;

/** A pergunta de um cliente: o material numerado. */
export function hsPrompt(p: HsPack, month: string) {
  const { text } = evidenceIndex(p);
  return `Cliente: ${p.client.name} (#${p.client.external_id}), ${p.client.kind === "TRIAL" ? "em trial" : "Base"}${p.client.squad ? `, squad ${p.client.squad}` : ""}.
Mês avaliado: ${month.slice(5, 7)}/${month.slice(0, 4)}.

${text || "Não há material do cliente neste mês (sem campanhas, Termômetro, Social Leads, Radar, reuniões nem WhatsApp)."}`;
}

const CONF = new Set(["alta", "media", "baixa"]);
/** Lê a resposta da MAVI (JSON, talvez entre ```), só com as referências que existem. */
export function parseHsAnswer(text: string, refs: Map<string, HsEvidence>): Pick<HsCriteria, "goal" | "perception" | "creatives"> {
  const raw = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("A MAVI não devolveu o JSON da sugestão.");
  }
  const one = (k: string): HsCriterion => {
    const c = (obj[k] ?? {}) as Record<string, unknown>;
    const value = c.value === true ? true : c.value === false ? false : null;
    const confidence = (CONF.has(String(c.confidence)) ? String(c.confidence) : "baixa") as HsCriterion["confidence"];
    const evidence = (Array.isArray(c.evidence) ? c.evidence : [])
      .map((r) => refs.get(String(r).replace(/[[\]\s]/g, "").toUpperCase()))
      .filter((e): e is HsEvidence => !!e)
      .filter((e, i, all) => all.findIndex((x) => x.type === e.type && x.id === e.id) === i)
      .slice(0, 6);
    const why = String(c.why ?? "").replace(/\s+/g, " ").trim().slice(0, 400) || (value === null ? "Sem evidência no mês." : "");
    return { value, confidence: value === null ? "baixa" : confidence, why, evidence };
  };
  return { goal: one("goal"), perception: one("perception"), creatives: one("creatives") };
}

/** A nota sugerida: a soma dos pesos dos critérios marcados (os sem evidência não somam). */
export function hsScore(criteria: HsCriteria, rules: Partial<CsRules> | null | undefined) {
  const w = { ...CS_DEFAULT_RULES.hs_weights, ...(rules?.hs_weights ?? {}) };
  const b = { ...CS_DEFAULT_RULES.hs_bands, ...(rules?.hs_bands ?? {}) };
  const score = Math.min(100, HS_CRITERIA.reduce((s, c) => s + (criteria[c.key].value === true ? Number(w[c.key]) : 0), 0));
  const band = score >= b.satisfied ? "SATISFEITO" : score >= b.alert ? "ALERTA" : "CRITICO";
  return { score, band } as const;
}

/** O link (no MAVI) de uma evidência. */
export function evidenceLink(e: HsEvidence): string | null {
  if (e.type === "meeting") return `/drive?gravacao=${encodeURIComponent(e.id)}`;
  if (e.type === "whatsapp" && e.group) return `/drive?whatsapp=${encodeURIComponent(e.group)}&msg=${encodeURIComponent(e.id)}`;
  if (e.type === "campaign") return `/campanhas/${encodeURIComponent(e.id)}`;
  if (e.type === "radar") return `/radar?item=${encodeURIComponent(e.id)}`;
  return null;
}

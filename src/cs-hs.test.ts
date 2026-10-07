import { describe, expect, it } from "vitest";
import {
  evidenceIndex,
  evidenceLink,
  hsPrompt,
  hsScore,
  meetingCriterion,
  parseHsAnswer,
  paymentCriterion,
  type HsCriteria,
  type HsPack,
} from "./cs-hs";

const pack = (over: Partial<HsPack> = {}): HsPack => ({
  client: { name: "Loja Boa", external_id: "4282", kind: "BASE", trial_month: null, linked: true, squad: "Primogênito" },
  cycle: { status: "PAGO", adimplencia: "ADIMPLENTE", billing_date: "2026-09-10", paid_date: "2026-09-11", paid: 5000, probable: 5000, probability: "ALTA" },
  registered: null,
  meetings: [{ id: "m1", title: "Alinhamento mensal", date: "2026-09-15", minutes: 40, overview: "Resultados acima da meta." }],
  temperature: { days: 20, score: 78, satisfacao: 82, permanencia: 75, flags: [] },
  temperature_readings: [{ id: "t1", source: "whatsapp", source_id: null, group: "g1", message: "w9", title: "Grupo Loja Boa", date: "2026-09-12", reason: "Elogiou as vendas", excerpt: "vendemos muito" }],
  campaigns: [{ id: "c1", campaign: "Leads Setembro", platform: "meta", goal_results: 100, budget: 3000, multiplier: 1, start: "2026-09-01", end: "2026-09-30",
    last: { taken_on: "2026-09-29", spend: 2900, results: 130, goal_status: "good" } }],
  social_leads: { approved: 8, rejected: 1, notes: [] },
  whatsapp: [{ id: "w1", group: "g1", at: "2026-09-05T13:00:00Z", from_team: false, sender: "Ana", text: "Aprovado, pode publicar!" }],
  radar: [],
  ...over,
});

describe("Pagamento em dia e Reunião: pelos dados", () => {
  it("pago até 3 dias depois da cobrança conta como em dia", () => {
    expect(paymentCriterion(pack(), "2026-09-30").value).toBe(true);
    const late = pack({ cycle: { ...pack().cycle!, paid_date: "2026-09-20" } });
    expect(paymentCriterion(late, "2026-09-30")).toMatchObject({ value: false, confidence: "alta" });
    const open = pack({ cycle: { ...pack().cycle!, status: "PENDENTE", paid: 0, paid_date: null, billing_date: "2026-10-05" } });
    expect(paymentCriterion(open, "2026-09-30").value).toBeNull();
    const overdue = pack({ cycle: { ...pack().cycle!, status: "PENDENTE", adimplencia: "INADIMPLENTE", paid: 0, paid_date: null } });
    expect(paymentCriterion(overdue, "2026-09-30").value).toBe(false);
    expect(paymentCriterion(pack({ cycle: null }), "2026-09-30").value).toBeNull();
  });
  it("reunião gravada no mês = sim; sem ligação com o cliente do MAVI = sem evidência", () => {
    expect(meetingCriterion(pack())).toMatchObject({ value: true, evidence: [{ type: "meeting", id: "m1" }] });
    expect(meetingCriterion(pack({ meetings: [] })).value).toBe(false);
    expect(meetingCriterion(pack({ client: { ...pack().client, linked: false } })).value).toBeNull();
  });
});

describe("a resposta da MAVI", () => {
  const { refs, text } = evidenceIndex(pack());
  it("o material é numerado para citar", () => {
    expect(text).toContain("[C1] Leads Setembro");
    expect(text).toContain("[S1] SOCIAL LEADS");
    expect(text).toContain("[W1]");
    expect(hsPrompt(pack(), "2026-09-01")).toContain("Mês avaliado: 09/2026");
  });
  it("lê o JSON (mesmo entre ```), guarda só as referências que existem e ignora o resto", () => {
    const answer = '```json\n{"goal":{"value":true,"confidence":"alta","why":"Campanha BOM.","evidence":["C1","X9"]},' +
      '"perception":{"value":true,"confidence":"media","why":"Satisfação 82.","evidence":["T1"]},' +
      '"creatives":{"value":"talvez","confidence":"alta","evidence":["S1"]}}\n```';
    const r = parseHsAnswer(answer, refs);
    expect(r.goal).toMatchObject({ value: true, confidence: "alta", evidence: [{ type: "campaign", id: "c1" }] });
    expect(r.perception.evidence).toEqual([{ type: "whatsapp", id: "w9", group: "g1", title: "Grupo Loja Boa", date: "2026-09-12" }]);
    expect(r.creatives).toMatchObject({ value: null, confidence: "baixa", why: "Sem evidência no mês." });
    expect(() => parseHsAnswer("não sei", refs)).toThrow(/JSON/);
  });
  it("a nota soma só os critérios marcados, com os pesos e faixas da regra", () => {
    const c = (v: boolean | null) => ({ value: v, confidence: "alta" as const, why: "", evidence: [] });
    const all: HsCriteria = { goal: c(true), perception: c(true), payment: c(true), meeting: c(null), creatives: c(false) };
    expect(hsScore(all, null)).toEqual({ score: 75, band: "ALERTA" });
    expect(hsScore(all, { hs_bands: { satisfied: 70, alert: 40 } })).toEqual({ score: 75, band: "SATISFEITO" });
  });
  it("os links abrem a reunião, a mensagem, a campanha e o item do Radar", () => {
    expect(evidenceLink({ type: "whatsapp", id: "w1", group: "g1", title: "", date: null })).toBe("/drive?whatsapp=g1&msg=w1");
    expect(evidenceLink({ type: "meeting", id: "m1", title: "", date: null })).toBe("/drive?gravacao=m1");
    expect(evidenceLink({ type: "social", id: "social", title: "", date: null })).toBeNull();
  });
});

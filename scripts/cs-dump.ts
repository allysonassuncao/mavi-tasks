// Customer Success: o dump do MySQL do dash antigo (convertido por
// parseSqlDump) no formato que o motor recebe do banco (CsData). Usado pela
// conferência de paridade (scripts/cs-parity.ts).
import type { CsData } from "../src/cs-engine";

export function dumpToData(d: Record<string, Record<string, string | null>[]>, today: string): CsData {
  const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? 0 : Number(v));
  const numOrNull = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));
  const origin = { "1": "comercial", "2": "reativacao", "3": "troca" } as const;
  const reason = { "1": "performance", "2": "financeiro", "3": "fechou", "4": "estrategia" } as const;
  const cycleKey = new Map<string, string>();
  for (const y of d.ciclos_pagamento) cycleKey.set(`${y.cliente_id}|${y.mes_competencia}`, String(y.id));
  return {
    today,
    squads: d.squads.map((s) => ({ id: String(s.id), name: s.nome!, color: (s.cor_hex ?? "#8576cf").toLowerCase(),
      sort: Number(s.ordem), archived: false })),
    clients: d.clientes.map((c) => ({
      id: String(c.id), external_id: c.id_externo!, name: c.nome!, squad_id: String(c.squad_id), vertical: c.vertical,
      origin: origin[c.origem_id as "1"], kind: c.tipo_id as "BASE", trial_month: numOrNull(c.mes_de_trial),
      status: c.status_id as "ATIVO", entry_date: c.data_entrada!, churn_date: c.data_churn, reactivation_date: c.data_reativacao,
      churn_reason: c.motivo_churn_id ? reason[c.motivo_churn_id as "1"] : null, notes: c.observacoes,
    })),
    cycles: d.ciclos_pagamento.map((y) => ({
      id: String(y.id), client: String(y.cliente_id), month: y.mes_competencia!, squad_id: y.squad_id ? String(y.squad_id) : null,
      start_date: y.data_inicio_ciclo, end_date: y.data_fim_ciclo, billing_date: y.data_cobranca,
      best: num(y.valor_planejado_melhor), probable: num(y.valor_planejado_provavel), probability: y.probabilidade as "ALTA",
      paid: num(y.valor_pago), paid_date: y.data_pagamento, status: y.status_pagamento as "PAGO",
      adimplencia: y.adimplencia as "ADIMPLENTE", acl: y.eh_acl === "1", acl_value: numOrNull(y.valor_acl),
      fee_planned: numOrNull(y.valor_mensalidade_prevista), fee_paid: numOrNull(y.valor_mensalidade),
      m1_discounted: y.m1_ja_descontado === "1",
    })),
    payments: d.pagamentos_parcelas.map((p) => ({ cycle: cycleKey.get(`${p.cliente_id}|${p.mes_competencia}`) ?? "?",
      ord: Number(p.ordem), date: p.data_pagamento!, amount: num(p.valor) })),
    hs: d.health_score_mensal.map((h) => ({ client: String(h.cliente_id), month: h.mes_ref!, creatives: h.c_aprovacao_criat === "1",
      meeting: h.c_reuniao_align === "1", payment: h.c_pagamento_dia === "1", perception: h.c_percepcao_valor === "1",
      goal: h.c_meta_batida === "1", score: num(h.score_pct), band: h.faixa as "ALERTA" })),
    goals: d.metas_squad.map((g) => ({ squad_id: String(g.squad_id), month: g.mes_ref!, revenue: num(g.meta_faturamento),
      retention_pct: numOrNull(g.meta_retencao_pct), ticket: numOrNull(g.meta_ticket) })),
    events: d.eventos_cliente.map((e) => ({ client: String(e.cliente_id), kind: e.tipo as "CHURN", date: e.data!,
      churn_reason: e.motivo_churn_id ? reason[e.motivo_churn_id as "1"] : null })),
    history: [...d.ciclos_historico].sort((a, b) => Number(a.id) - Number(b.id)).map((h) => ({ client: String(h.cliente_id),
      month: h.mes_competencia!, end_date: h.data_fim_ciclo, billing_date: h.data_cobranca, probable: numOrNull(h.valor_planejado_provavel),
      recorded_at: h.registrado_em! })),
    official_revenue: (d.faturamento_real_squad_mes ?? []).map((r) => ({ squad_id: String(r.squad_id), month: r.mes_ref!,
      achieved: num(r.atingido) })),
    multipliers: (d.multiplicador_mensal ?? []).map((m) => ({ client: String(m.cliente_id), month: m.mes_ref!, value: num(m.valor_m) })),
    rules: [],
  };
}


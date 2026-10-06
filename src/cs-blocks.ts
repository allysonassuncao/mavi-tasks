import {
  CHURN_REASONS,
  addDays,
  addMonths,
  between,
  byName,
  countsAsNew,
  dateDiff,
  esc,
  f0,
  f1,
  fmtMoney,
  labelMes,
  labelMesFull,
  lastDay,
  monthStart,
  monthsBetween,
  numberFormat,
  phpRound,
  weekday,
  type CsDataClient,
  type CsDataCycle,
  type CsEngine,
  type CsFilter,
  type CsKind,
} from "./cs-engine";
import { recPlanejamento } from "./cs-receiving";

/**
 * Os blocos do painel de CS: cada função é a de mesmo nome em
 * cs-make-dashboard/dash/lib/calculos.php (e insights.php), com os mesmos
 * campos. Ver cs-engine.ts.
 */

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const avgOr = (xs: number[], fallback: number) => (xs.length ? sum(xs) / xs.length : fallback);
const distinct = <T,>(xs: T[]) => new Set(xs).size;

export const mesAnterior = (m: string) => addMonths(monthStart(m), -1);
export const momPct = (atual: number | null, anterior: number | null) =>
  anterior === null || anterior === 0 || atual === null ? null : ((atual - anterior) / anterior) * 100;

/** Ciclos de um mês que passam no filtro de squad (do ciclo) e de dimensão. */
const cyclesF = (e: CsEngine, m: string, f: { squad_id: string | null; dim: CsFilter["dim"] }) =>
  e.cyclesOfMonth(m).filter((y) => e.cycleOk(y, f));
const cyclesIn = (e: CsEngine, meses: string[], f: { squad_id: string | null; dim: CsFilter["dim"] }) =>
  meses.flatMap((m) => cyclesF(e, m, f));
/** Faturamento efetivo dos ciclos pagos. */
const fatOf = (e: CsEngine, ys: CsDataCycle[]) => sum(ys.filter((y) => y.paid > 0).map(e.vef));
/** fat_real_mes() com o cálculo pelos ciclos quando não há valor oficial. */
function fatMes(e: CsEngine, m: string, squad: string | null, dim: CsFilter["dim"]) {
  const real = e.officialRevenue(m, squad);
  return real !== 0 ? real : fatOf(e, cyclesF(e, m, { squad_id: squad, dim }));
}

// ------------------------------------------------------------ trocas de squad
export function trocasSquadMes(e: CsEngine, mes: string, squad: string | null) {
  const ant = mesAnterior(mes);
  const rows = e.clients
    .filter((c) => e.cycleAt(c.id, ant) && e.cycleAt(c.id, mes))
    .map((c) => ({ c, antes: e.squadInMonth(c, ant), depois: e.squadInMonth(c, mes) }))
    .filter((r) => r.antes !== r.depois)
    .sort((a, b) => byName(a.c.name, b.c.name));
  const entrada: TrocaItem[] = [];
  const saida: TrocaItem[] = [];
  for (const r of rows) {
    const item = {
      cliente_id: r.c.id, id_externo: r.c.external_id, nome: r.c.name,
      squad_antes: r.antes, squad_depois: r.depois, de: e.squadName(r.antes), para: e.squadName(r.depois),
    };
    if (squad === null) entrada.push(item);
    else {
      if (r.depois === squad) entrada.push(item);
      if (r.antes === squad) saida.push(item);
    }
  }
  return { entrada, saida };
}
export type TrocaItem = {
  cliente_id: string; id_externo: string; nome: string; squad_antes: string; squad_depois: string; de: string; para: string;
};

// ------------------------------------------------------------ mensalidades
export function mensalidadesResumo(e: CsEngine, meses: string[], squad: string | null) {
  const ys = meses.flatMap((m) => e.cyclesOfMonth(m))
    .filter((y) => ((y.fee_paid ?? 0) > 0 || (y.fee_planned ?? 0) > 0) && (squad === null || e.cycleSquad(y) === squad));
  const recebido = sum(ys.map((y) => y.fee_paid ?? 0));
  const pagando = distinct(ys.filter((y) => (y.fee_paid ?? 0) > 0).map((y) => y.client));
  return {
    recebido,
    previsto: sum(ys.map((y) => y.fee_planned ?? 0)),
    a_receber: sum(ys.map((y) => Math.max(0, (y.fee_planned ?? 0) - (y.fee_paid ?? 0)))),
    clientes_pagando: pagando,
    clientes_pendentes: distinct(ys.filter((y) => (y.fee_planned ?? 0) > (y.fee_paid ?? 0)).map((y) => y.client)),
    media: pagando > 0 ? recebido / pagando : 0,
    total: recebido,
    clientes: pagando,
  };
}

// ------------------------------------------------------------ Bloco 1
export function forecast3Cenarios(e: CsEngine, f: CsFilter) {
  const ys = cyclesF(e, f.mes_ref, f);
  const realizado = sum(ys.filter((y) => y.paid > 0 && y.paid_date !== null && y.paid_date <= e.today).map((y) => y.paid));
  const aberto = ys.filter((y) => y.status === "PENDENTE" || y.status === "PARCIAL");
  const resto = (y: CsDataCycle) => Math.max(0, y.probable - y.paid);
  const pend_provavel = sum(aberto.filter((y) => y.probability === "PROVAVEL" || y.probability === "ALTA").map(resto));
  const pend_baixa = sum(aberto.filter((y) => y.probability === "BAIXA").map(resto));
  const pend_melhor = sum(aberto.map((y) => Math.max(0, y.best - y.paid)));
  return {
    realizado,
    pessimista: realizado + pend_provavel * 0.5,
    provavel: realizado + pend_provavel + pend_baixa * 0.3,
    melhor: realizado + pend_melhor,
    pend_provavel,
    pend_baixa,
    pend_melhor,
  };
}

export function kpiStripData(e: CsEngine, f: CsFilter) {
  const mes = f.mes_ref;
  const ant = mesAnterior(mes);
  const fat_mes = fatMes(e, mes, f.squad_id, f.dim);
  const fat_mes_ant = fatMes(e, ant, f.squad_id, f.dim);
  const meta = e.goal(f.squad_id, mes);
  const ys = cyclesF(e, mes, f);
  const planejado = sum(ys.map((y) => y.probable));
  const ativos = e.clients.filter((c) => e.activeIn(c, mes) && e.squadOk(c, f.squad_id, mes) && e.dimOk(c, f.dim));
  const ativos_total = ativos.length;
  const ativos_trial = ativos.filter((c) => c.kind === "TRIAL").length;
  const pagantes = ys.filter(e.isPayer).length;
  const total_no_mes = distinct(ys.map((y) => y.client));
  const fat_trial = sum(ys.filter((y) => y.paid > 0 && e.phase(y) === "TRIAL").map((y) => e.vef(y) - e.aclEf(y)));
  // Fluxos pelo squad do mês de referência; dimensão pelo tipo atual.
  const fluxo = (c: CsDataClient) => e.dimOk(c, f.dim) && e.squadOk(c, f.squad_id, mes);
  const inMonth = (d: string | null) => between(d, mes, lastDay(mes));
  const entradas_novos = e.clients.filter((c) => countsAsNew(c) && inMonth(c.entry_date) && fluxo(c)).length;
  const reativacoes = e.reactivations.filter((r) => inMonth(r.date) && fluxo(r.client)).length;
  const trocas = e.clients.filter((c) => !countsAsNew(c) && inMonth(c.entry_date) && fluxo(c)).length;
  const tr_sq = trocasSquadMes(e, mes, f.squad_id);
  const saidas = e.churns.filter((r) => inMonth(r.date) && fluxo(r.client)).length;
  const make_in_lista = ativos
    .filter((c) => c.status === "MAKE_IN")
    .sort((a, b) => byName(a.name, b.name))
    .map((c) => ({ id_externo: c.external_id, nome: c.name, faturamento: e.cycleAt(c.id, mes)?.probable ?? 0 }));
  const entradas = entradas_novos + reativacoes;
  return {
    mes_ref: mes, mes_ant: ant, fat_mes, fat_mes_ant, fat_mom_pct: momPct(fat_mes, fat_mes_ant),
    meta, atingimento_pct: meta > 0 ? (fat_mes / meta) * 100 : 0,
    planejado, ciclos_count: ys.length,
    ativos_total, ativos_trial, ativos_base: ativos_total - ativos_trial,
    pagantes, total_no_mes,
    pct_trial: fat_mes > 0 ? (fat_trial / fat_mes) * 100 : 0, fat_trial,
    make_in: { qtd: make_in_lista.length, faturamento: sum(make_in_lista.map((x) => x.faturamento)), lista: make_in_lista },
    mensalidades: mensalidadesResumo(e, [mes], f.squad_id),
    net_entradas: entradas, net_novos: entradas_novos, net_reativacoes: reativacoes, net_trocas: trocas,
    net_troca_squad_in: tr_sq.entrada.length, net_troca_squad_out: tr_sq.saida.length, net_troca_squad: tr_sq,
    net_saidas: saidas, net_churn: entradas - saidas,
    forecast: forecast3Cenarios(e, f),
  };
}

// ------------------------------------------------------------ Bloco 2
export function financeiroData(e: CsEngine, f: CsFilter, mesesIn?: string[] | null) {
  const meses = mesesIn?.length ? mesesIn : [f.mes_ref];
  const dimOnly = { squad_id: null, dim: f.dim };
  const por_squad = e.squads.map((s) => {
    const fat = sum(meses.map((m) => fatMes(e, m, s.id, f.dim)));
    const meta = sum(meses.map((m) => e.goal(s.id, m)));
    return { squad_id: s.id, nome: s.name, fat, meta, atingimento: meta > 0 ? (fat / meta) * 100 : 0 };
  });
  const cFat = sum(por_squad.map((x) => x.fat));
  const cMeta = sum(por_squad.map((x) => x.meta));
  const ticketSquads = e.squads.map((s) => {
    const ys = cyclesIn(e, meses, { squad_id: s.id, dim: f.dim });
    const pag = ys.filter(e.isEffectivePayer).length;
    return { squad_id: s.id, nome: s.name, tm: pag > 0 ? fatOf(e, ys) / pag : 0 };
  });
  const all = cyclesIn(e, meses, dimOnly);
  const pagTotal = all.filter(e.isEffectivePayer).length;
  const ys = cyclesIn(e, meses, f).filter((y) => y.paid > 0);
  const fat_trial = sum(ys.filter((y) => e.phase(y) === "TRIAL").map((y) => e.vef(y) - e.aclEf(y)));
  const fat_base = sum(ys.filter((y) => e.phase(y) !== "TRIAL").map((y) => e.vef(y) - e.aclEf(y)));
  const fat_acl = sum(ys.filter((y) => y.acl).map((y) => e.aclEf(y)));
  const tot = fat_trial + fat_base + fat_acl;
  return {
    mes_ref: f.mes_ref,
    por_squad,
    consolidado: { fat: cFat, meta: cMeta, atingimento: cMeta > 0 ? (cFat / cMeta) * 100 : 0 },
    ticket: { squads: ticketSquads, consolidado: pagTotal > 0 ? fatOf(e, all) / pagTotal : 0 },
    composicao: {
      trial: fat_trial, base: fat_base, acl: fat_acl, total: tot,
      pct_trial: tot > 0 ? (fat_trial / tot) * 100 : 0,
      pct_base: tot > 0 ? (fat_base / tot) * 100 : 0,
      pct_acl: tot > 0 ? (fat_acl / tot) * 100 : 0,
    },
    mensalidades: mensalidadesResumo(e, meses, f.squad_id),
  };
}

export type ProvRecRow = {
  cycle: CsDataCycle; id_externo: string; nome: string; tipo_id: CsKind; squad_id: string; mes: string;
  provavel: number; recebido: number; diff: number; status_pagamento: string; eh_acl: boolean; pendente: boolean;
};
export function provavelRecebidoData(e: CsEngine, f: CsFilter, mesesIn?: string[] | null) {
  const meses = mesesIn?.length ? mesesIn : [f.mes_ref];
  const rows: ProvRecRow[] = cyclesIn(e, meses, f)
    .map((y) => {
      const c = e.clientOf(y.client);
      const provavel = e.provEf(y);
      const recebido = e.vef(y);
      return {
        cycle: y, id_externo: c.external_id, nome: c.name, tipo_id: c.kind, squad_id: e.cycleSquad(y), mes: y.month,
        provavel, recebido, diff: recebido - provavel, status_pagamento: y.status, eh_acl: y.acl,
        pendente: y.status === "PENDENTE" && recebido === 0,
      };
    })
    .filter((r) => r.provavel > 0 || r.recebido > 0)
    .sort((a, b) => a.diff - b.diff || byName(a.nome, b.nome));
  let saldo = 0, menos = 0, mais = 0, pend = 0, n_menos = 0, n_mais = 0, n_pend = 0;
  for (const r of rows) {
    if (r.pendente) {
      pend += r.provavel;
      n_pend++;
    } else {
      saldo += r.diff;
      if (r.diff < 0) { menos += r.diff; n_menos++; }
      else if (r.diff > 0) { mais += r.diff; n_mais++; }
    }
  }
  return {
    meses, rows,
    provavel_total: sum(rows.map((r) => r.provavel)), recebido_total: sum(rows.map((r) => r.recebido)),
    saldo, menos_total: menos, mais_total: mais, pend_provavel: pend, n_menos, n_mais, n_pend,
  };
}

export function kpiStripPeriodoData(e: CsEngine, f: CsFilter, meses: string[]) {
  const ini = meses[0];
  const fim = meses[meses.length - 1];
  const fat_por_mes: Record<string, number> = {};
  for (const m of meses) fat_por_mes[m] = fatOf(e, cyclesF(e, m, f));
  const vals = Object.values(fat_por_mes);
  const fat_total = sum(vals);
  const meta_total = sum(meses.map((m) => e.goal(f.squad_id, m)));
  const ys = cyclesIn(e, monthsInclusive(ini, fim), f);
  const ativos_fim = e.clients.filter((c) => e.activeIn(c, fim) && e.squadOk(c, f.squad_id, fim) && e.dimOk(c, f.dim)).length;
  const fat_trial = sum(ys.filter((y) => y.paid > 0 && e.phase(y) === "TRIAL").map((y) => e.vef(y) - e.aclEf(y)));
  const fat_ciclos = fatOf(e, ys);
  const range = (d: string | null) => between(d, ini, lastDay(fim));
  const ok = (c: CsDataClient, d: string) => e.dimOk(c, f.dim) && e.squadOk(c, f.squad_id, monthStart(d));
  const entradas_novos = e.clients.filter((c) => countsAsNew(c) && range(c.entry_date) && ok(c, c.entry_date)).length;
  const reativacoes = e.reactivations.filter((r) => range(r.date) && ok(r.client, r.date)).length;
  const trocas = e.clients.filter((c) => !countsAsNew(c) && range(c.entry_date) && ok(c, c.entry_date)).length;
  const saidas = e.churns.filter((r) => range(r.date) && ok(r.client, r.date)).length;
  return {
    meses, qtd_meses: meses.length, fat_total,
    fat_medio_mes: meses.length ? fat_total / meses.length : 0,
    fat_max_mes: vals.length ? Math.max(...vals) : 0, fat_min_mes: vals.length ? Math.min(...vals) : 0,
    fat_por_mes, meta_total, atingimento_pct: meta_total > 0 ? (fat_total / meta_total) * 100 : 0,
    planejado_total: sum(ys.map((y) => y.probable)), ativos_fim,
    clientes_no_periodo: distinct(ys.map((y) => y.client)),
    pagantes_unicos: distinct(ys.filter(e.isPayer).map((y) => y.client)),
    fat_trial, pct_trial: fat_ciclos > 0 ? (fat_trial / fat_ciclos) * 100 : 0,
    net_entradas: entradas_novos + reativacoes, net_novos: entradas_novos, net_reativacoes: reativacoes,
    net_trocas: trocas, net_saidas: saidas, net_churn: entradas_novos + reativacoes - saidas,
  };
}
const monthsInclusive = (ini: string, fim: string) => {
  const out: string[] = [];
  for (let m = ini; m <= fim; m = addMonths(m, 1)) out.push(m);
  return out;
};

export function evolucaoMensalData(e: CsEngine, f: CsFilter, meses: string[]) {
  return {
    linhas: meses.map((m) => {
      const squads: Record<string, number> = {};
      for (const s of e.squads) squads[s.id] = fatMes(e, m, s.id, f.dim);
      return {
        mes: m, label: labelMes(m), consolidado: sum(Object.values(squads)), squads,
        meta_consolidada: e.goal(null, m),
      };
    }),
    squads: e.squads.map((s) => ({ id: s.id, nome: s.name })),
  };
}

export function tendenciaHsData(e: CsEngine, f: CsFilter, meses: string[]) {
  return meses.map((m) => {
    const hs = e.hsOfMonth(m).filter((h) => {
      const c = e.clientOf(h.client);
      return e.dimOk(c, f.dim) && e.squadOk(c, f.squad_id, m);
    });
    const mp = e.multipliersIn(m).filter((x) => {
      const c = e.clientOf(x.client);
      return e.dimOk(c, f.dim) && e.squadOk(c, f.squad_id, m);
    });
    return {
      mes: m, label: labelMes(m),
      hs_medio: avgOr(hs.map((h) => h.score), 0),
      m_medio: avgOr(mp.map((x) => x.value), 0),
    };
  });
}

export function melhorSquadPorMesData(e: CsEngine, f: CsFilter, meses: string[]) {
  return meses.map((m) => {
    let vencedor: string | null = null;
    let best = -1;
    for (const s of e.squads) {
      const fat = fatOf(e, cyclesF(e, m, { squad_id: s.id, dim: f.dim }));
      if (fat > best) { best = fat; vencedor = s.id; }
    }
    return { mes: m, label: labelMes(m), squad_id: vencedor, fat: best > 0 ? best : 0 };
  });
}

// ------------------------------------------------------------ Bloco 3
const HS_CRITERIA = [
  { col: "payment", php: "c_pagamento_dia", label: "Pagamento em dia", w: "payment" },
  { col: "goal", php: "c_meta_batida", label: "Meta batida", w: "goal" },
  { col: "perception", php: "c_percepcao_valor", label: "Percepção de valor", w: "perception" },
  { col: "meeting", php: "c_reuniao_align", label: "Reunião alinhamento", w: "meeting" },
  { col: "creatives", php: "c_aprovacao_criat", label: "Aprovação criativos", w: "creatives" },
] as const;

export function saudeData(e: CsEngine, f: CsFilter, mesesIn?: string[] | null) {
  const mes = f.mes_ref;
  const ant = mesAnterior(mes);
  const meses = mesesIn?.length ? mesesIn : [mes];
  const bands = e.rules(mes).hs_bands;
  // 3.1 Faixas: cada cliente conta 1× pela média do período (squad atual).
  const scoresBy = new Map<string, number[]>();
  for (const m of meses)
    for (const h of e.hsOfMonth(m)) {
      if (!e.dimOk(e.clientOf(h.client), f.dim)) continue;
      const l = scoresBy.get(h.client) ?? [];
      l.push(h.score);
      scoresBy.set(h.client, l);
    }
  const clientesAvg = [...scoresBy].map(([id, xs]) => ({ id, squad_id: e.clientOf(id).squad_id, avg: sum(xs) / xs.length }));
  const faixas_por_squad = e.squads.map((s) => {
    const sc = clientesAvg.filter((c) => c.squad_id === s.id).map((c) => c.avg);
    const satisfeito = sc.filter((x) => x >= bands.satisfied).length;
    const alerta = sc.filter((x) => x < bands.satisfied && x >= bands.alert).length;
    const critico = sc.filter((x) => x < bands.alert).length;
    return { squad_id: s.id, nome: s.name, satisfeito, alerta, critico, total: sc.length, hs_medio: avgOr(sc, 0) };
  });
  const faixas_consolidado = {
    satisfeito: sum(faixas_por_squad.map((x) => x.satisfeito)),
    alerta: sum(faixas_por_squad.map((x) => x.alerta)),
    critico: sum(faixas_por_squad.map((x) => x.critico)),
    total: sum(faixas_por_squad.map((x) => x.total)),
    hs_medio: avgOr(clientesAvg.map((c) => c.avg), 0),
  };
  // 3.2 Ofensores (squad do mês de referência + dimensão).
  const hsRows = meses.flatMap((m) => e.hsOfMonth(m)).filter((h) => {
    const c = e.clientOf(h.client);
    return e.dimOk(c, f.dim) && e.squadOk(c, f.squad_id, mes);
  });
  const w = e.rules(mes).hs_weights;
  const ofensores = HS_CRITERIA.map((k) => {
    const falharam = hsRows.filter((h) => !h[k.col]).length;
    const peso = w[k.w];
    return {
      criterio: k.php, label: k.label, peso, falharam,
      pct_falha: hsRows.length > 0 ? (falharam / hsRows.length) * 100 : 0,
      impacto: hsRows.length > 0 ? -(falharam / hsRows.length) * peso : 0,
    };
  }).sort((a, b) => a.impacto - b.impacto);
  // 3.3 Contas em risco
  const ancora = minDate(lastDay(mes), e.today);
  const riscoAll = e.clients
    .filter((c) => (c.status === "ATIVO" || c.status === "MAKE_IN") && e.activeIn(c, mes) && e.dimOk(c, f.dim) &&
      e.squadOk(c, f.squad_id, mes))
    .map((c) => ({ c, hs: e.hsAtMonth(c.id, mes), y: e.cycleAt(c.id, mes) }))
    .filter((r) => r.hs !== null && r.hs.score < 70)
    .sort((a, b) => a.hs!.score * 0.5 - b.hs!.score * 0.5 || nullsLastDesc(a.y?.probable ?? null, b.y?.probable ?? null));
  const em_risco = riscoAll.slice(0, 10).map(({ c, hs, y }) => {
    const anterior = e.hsAtMonth(c.id, ant);
    return {
      id: c.id, nome: c.name, id_externo: c.external_id, tipo_id: c.kind, mes_de_trial: c.trial_month,
      trial_mes_atual: Math.max(1, monthsBetween(c.entry_date, ancora) + 1),
      squad_nome: e.squadName(c.squad_id), squad_id: c.squad_id,
      investimento: y?.probable ?? null, adimplencia: y?.adimplencia ?? null, status_pagamento: y?.status ?? null,
      hs_atual: hs!.score, hs_faixa: hs!.band, hs_anterior: anterior?.score ?? null,
      delta_hs: anterior ? hs!.score - anterior.score : null,
    };
  });
  // 3.5 Adimplência
  const adimplencia_squads = e.squads.map((s) => {
    const ys = cyclesIn(e, meses, { squad_id: s.id, dim: f.dim });
    const n = (a: string) => ys.filter((y) => y.adimplencia === a).length;
    return {
      squad_id: s.id, nome: s.name, adimplente: n("ADIMPLENTE"), inadimplente: n("INADIMPLENTE"),
      perda: n("PERDA"), total: ys.length,
    };
  });
  return {
    mes_ref: mes, faixas_por_squad, faixas_consolidado, ofensores, em_risco,
    em_risco_total: sum(em_risco.map((r) => r.investimento ?? 0)),
    adimplencia_squads,
    adimplencia_total: {
      adimplente: sum(adimplencia_squads.map((x) => x.adimplente)),
      inadimplente: sum(adimplencia_squads.map((x) => x.inadimplente)),
      perda: sum(adimplencia_squads.map((x) => x.perda)),
      total: sum(adimplencia_squads.map((x) => x.total)),
    },
  };
}
const minDate = (a: string, b: string) => (a < b ? a : b);
/** ORDER BY x DESC do MySQL: nulos por último. */
const nullsLastDesc = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a;
/** ORDER BY x ASC do MySQL: nulos primeiro. */
const nullsFirstAsc = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : -1) : b === null ? 1 : a - b;

// ------------------------------------------------------------ Bloco 4
/** Fase do trial ancorada no aniversário da entrada: 0 = M1 … ≥3 = M4+. */
const fase = (n: number) => (n === 0 ? "m1" : n === 1 ? "m2" : n === 2 ? "m3" : "m4plus");
function churnFase(c: CsDataClient): "M1" | "M2" | "M3" | "M4plus" | "PosTrial" {
  const n = monthsBetween(c.entry_date, c.churn_date!);
  if (n === 0) return "M1";
  if (n === 1) return "M2";
  if (n === 2) return "M3";
  return c.kind === "TRIAL" ? "M4plus" : "PosTrial";
}
const isBase = (c: CsDataClient) => c.kind === "BASE" || c.kind === "BASE_RA";

export function trialDataMensal(e: CsEngine, f: CsFilter) {
  const mes = f.mes_ref;
  const fim = lastDay(mes);
  const ancora = minDate(fim, e.today);
  const sqOk = (c: CsDataClient) => e.squadOk(c, f.squad_id, mes);
  const funil = { m1: 0, m2: 0, m3: 0, m4plus: 0 };
  for (const c of e.clients)
    if (c.kind === "TRIAL" && c.entry_date <= ancora && (c.churn_date === null || c.churn_date > fim) && sqOk(c))
      funil[fase(Math.max(0, monthsBetween(c.entry_date, ancora)))]++;
  const graduados = e.clients.filter((c) => isBase(c) && e.gradMonth(c) === mes && sqOk(c)).length;
  const origem = addMonths(mes, -3);
  const entradas_origem = e.clients.filter((c) => between(c.entry_date, origem, lastDay(origem)) && e.passouTrial(c) &&
    sqOk(c)).length;
  const churns_fase = { M1: 0, M2: 0, M3: 0, M4plus: 0, PosTrial: 0 };
  for (const c of e.clients)
    if (between(c.churn_date, mes, fim) && e.passouTrial(c) && sqOk(c)) churns_fase[churnFase(c)]++;
  const cohort = e.clients.filter((c) => between(c.entry_date, mes, fim) && e.passouTrial(c) && sqOk(c));
  const cGrad = cohort.filter((c) => isBase(c) && c.trial_month !== null && c.churn_date === null).length;
  const por_squad = e.squads.map((s) => {
    const em_trial = e.clients.filter((c) => c.kind === "TRIAL" && c.entry_date <= fim &&
      (c.churn_date === null || c.churn_date > fim) && e.squadInMonth(c, mes) === s.id).length;
    const entradas = e.clients.filter((c) => between(c.entry_date, mes, fim) && e.passouTrial(c) &&
      e.squadInMonth(c, mes) === s.id).length;
    const grad = e.clients.filter((c) => isBase(c) && e.gradMonth(c) === mes && e.squadInMonth(c, mes) === s.id).length;
    const orig = e.clients.filter((c) => between(c.entry_date, origem, lastDay(origem)) && e.passouTrial(c) &&
      e.squadInMonth(c, origem) === s.id).length;
    return {
      squad_id: s.id, nome: s.name, em_trial, entradas, graduados: grad,
      taxa_grad: orig > 0 ? (grad / orig) * 100 : 0,
      fat_trial_avg: avgOr(e.cyclesOfMonth(mes).filter((y) => e.clientOf(y.client).kind === "TRIAL" &&
        e.cycleSquad(y) === s.id && y.paid !== 0).map((y) => y.paid), 0),
    };
  });
  const tg = sum(por_squad.map((x) => x.graduados));
  return {
    mes_ref: mes, modo: "mensal", periodo_label: labelMesFull(mes),
    funil: { ...funil, graduados, entradas: entradas_origem,
      taxa_graduacao: entradas_origem > 0 ? (graduados / entradas_origem) * 100 : 0 },
    churns_fase,
    cohorts_grad: [{ mes, label: labelMes(mes), total: cohort.length, graduados: cGrad,
      taxa: cohort.length > 0 ? (cGrad / cohort.length) * 100 : 0 }],
    tempo_medio_dias: null as number | null,
    por_squad,
    total_squad: {
      em_trial: sum(por_squad.map((x) => x.em_trial)), entradas: sum(por_squad.map((x) => x.entradas)),
      graduados: tg, taxa_grad: entradas_origem > 0 ? (tg / entradas_origem) * 100 : 0,
      fat_trial_avg: avgOr(e.cyclesOfMonth(mes).filter((y) => e.clientOf(y.client).kind === "TRIAL" && y.paid !== 0)
        .map((y) => y.paid), 0),
    },
  };
}

export function trialDataAnual(e: CsEngine, f: CsFilter, mesesIn?: string[] | null) {
  const mes = f.mes_ref;
  const meses = mesesIn?.length ? mesesIn : Array.from({ length: 12 }, (_, i) => addMonths(mes, i - 11));
  const ini = meses[0];
  const fim = meses[meses.length - 1];
  const sqOk = (c: CsDataClient) => e.squadOk(c, f.squad_id, mes);
  const funil = { m1: 0, m2: 0, m3: 0, m4plus: 0 };
  for (const c of e.clients)
    if (c.kind === "TRIAL" && c.churn_date === null && sqOk(c)) {
      const n = monthsBetween(c.entry_date, e.today);
      if (n >= 0) funil[fase(n)]++;
    }
  const gradIn = (c: CsDataClient) => {
    const g = e.gradMonth(c);
    return g !== null && g >= ini && g <= lastDay(fim);
  };
  const graduados = e.clients.filter((c) => isBase(c) && gradIn(c) && sqOk(c)).length;
  const denomIni = addMonths(ini, -3);
  const entradas = e.clients.filter((c) => between(c.entry_date, denomIni, lastDay(fim)) && e.passouTrial(c) &&
    sqOk(c)).length;
  const churns_fase = { M1: 0, M2: 0, M3: 0, M4plus: 0, PosTrial: 0 };
  for (const c of e.clients)
    if (between(c.churn_date, ini, lastDay(fim)) && e.passouTrial(c) && sqOk(c)) churns_fase[churnFase(c)]++;
  const cohorts_grad = meses.map((m) => {
    const co = e.clients.filter((c) => between(c.entry_date, m, lastDay(m)) && e.passouTrial(c) && sqOk(c));
    const g = co.filter((c) => isBase(c) && c.trial_month !== null && c.churn_date === null).length;
    return { mes: m, label: labelMes(m), total: co.length, graduados: g, taxa: co.length > 0 ? (g / co.length) * 100 : 0 };
  });
  const tempos = e.clients
    .filter((c) => isBase(c) && between(c.entry_date, ini, lastDay(fim)) && sqOk(c))
    .map((c) => Math.max(60, Math.min(120, dateDiff(lastDay(addMonths(c.entry_date, 3)), c.entry_date))));
  const por_squad = e.squads.map((s) => {
    const em_trial = e.clients.filter((c) => c.kind === "TRIAL" && c.churn_date === null && c.squad_id === s.id).length;
    const ent = e.clients.filter((c) => between(c.entry_date, denomIni, lastDay(fim)) && e.passouTrial(c) &&
      e.squadInMonth(c, monthStart(c.entry_date)) === s.id).length;
    const grad = e.clients.filter((c) => isBase(c) && gradIn(c) && e.squadInMonth(c, e.gradMonth(c)!) === s.id).length;
    return {
      squad_id: s.id, nome: s.name, em_trial, entradas: ent, graduados: grad,
      taxa_grad: ent > 0 ? (grad / ent) * 100 : 0,
      fat_trial_avg: avgOr(meses.flatMap((m) => e.cyclesOfMonth(m)).filter((y) => e.clientOf(y.client).kind === "TRIAL" &&
        e.cycleSquad(y) === s.id && y.paid !== 0).map((y) => y.paid), 0),
    };
  });
  const te = sum(por_squad.map((x) => x.entradas));
  const tg = sum(por_squad.map((x) => x.graduados));
  return {
    mes_ref: mes, modo: "anual",
    periodo_label: meses.length === 12 ? `12 meses até ${labelMesFull(mes)}`
      : `${meses.length} meses · ${labelMes(ini)} → ${labelMes(fim)}`,
    funil: { ...funil, graduados, entradas, taxa_graduacao: entradas > 0 ? (graduados / entradas) * 100 : 0 },
    churns_fase, cohorts_grad,
    tempo_medio_dias: Math.trunc(tempos.length ? sum(tempos) / tempos.length : 90) as number | null,
    por_squad,
    total_squad: {
      em_trial: sum(por_squad.map((x) => x.em_trial)), entradas: te, graduados: tg,
      taxa_grad: te > 0 ? (tg / te) * 100 : 0,
      fat_trial_avg: avgOr(meses.flatMap((m) => e.cyclesOfMonth(m)).filter((y) => e.clientOf(y.client).kind === "TRIAL" &&
        y.paid !== 0).map((y) => y.paid), 0),
    },
  };
}

// ------------------------------------------------------------ Bloco 5
type Cancelamento = {
  id: string; nome: string; id_externo: string; data_churn: string; tipo_id: CsKind; squad_nome: string; squad_id: string;
  motivo: string | null; evitavel: boolean | null; investimento_medio: number;
};
function cancelamentos(e: CsEngine, f: CsFilter, ini: string, fim: string, invFrom: (date: string) => string) {
  return e.churns
    .filter((r) => between(r.date, ini, lastDay(fim)) && e.squadOk(r.client, f.squad_id, f.mes_ref))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((r): Cancelamento => ({
      id: r.client.id, nome: r.client.name, id_externo: r.client.external_id, data_churn: r.date, tipo_id: r.client.kind,
      squad_nome: e.squadName(r.client.squad_id), squad_id: r.client.squad_id,
      motivo: r.reason ? CHURN_REASONS[r.reason].label : null, evitavel: r.reason ? CHURN_REASONS[r.reason].avoidable : null,
      investimento_medio: e.avgVefSince(r.client.id, invFrom(r.date)) ?? 0,
    }));
}
function motivos(rows: Cancelamento[]) {
  const map = new Map<string, { label: string | null; evitavel: boolean | null; n: number }>();
  for (const r of rows) {
    const k = r.motivo ?? "";
    const g = map.get(k) ?? { label: r.motivo, evitavel: r.evitavel, n: 0 };
    g.n++;
    map.set(k, g);
  }
  const tot = Math.max(1, rows.length);
  return [...map.values()].sort((a, b) => b.n - a.n).map((g) => ({ ...g, pct: (g.n / tot) * 100 }));
}
function squadsChurn(e: CsEngine, ini: string, fim: string) {
  const rows = e.churns.filter((r) => between(r.date, ini, lastDay(fim)));
  return e.squads
    .map((s) => {
      const mine = rows.filter((r) => r.client.squad_id === s.id);
      return {
        id: s.id, nome: s.name, n_churns: mine.length,
        perda_anual: sum(mine.map((r) => (e.avgVefSince(r.client.id, addMonths(r.date, -3)) ?? 0) * 12)),
      };
    })
    .filter((x) => x.n_churns > 0);
}
function retencao(e: CsEngine, f: CsFilter, cohortMonth: string, limit: string) {
  const sqOk = (c: CsDataClient) => e.squadOk(c, f.squad_id, f.mes_ref);
  const co = e.clients.filter((c) => between(c.entry_date, cohortMonth, lastDay(cohortMonth)) && sqOk(c));
  const serie: (number | null)[] = [];
  for (let n = 0; n <= 6; n++) {
    const fimP = lastDay(addMonths(cohortMonth, n));
    if (fimP > limit) break;
    const vivos = co.filter((c) => c.churn_date === null || c.churn_date > fimP).length;
    serie.push(co.length > 0 ? phpRound((vivos / co.length) * 100, 1) : null);
  }
  return { cohort: cohortMonth, label: labelMes(cohortMonth), inicial: co.length, serie };
}

export function churnDataMensal(e: CsEngine, f: CsFilter) {
  const mes = f.mes_ref;
  const canc = cancelamentos(e, f, mes, mes, () => addMonths(mes, -3));
  return {
    mes_ref: mes, modo: "mensal", periodo_label: labelMesFull(mes),
    cancelamentos: canc,
    perda_potencial: sum(canc.map((c) => c.investimento_medio * 12)),
    perda_evitavel: sum(canc.filter((c) => c.evitavel).map((c) => c.investimento_medio * 12)),
    motivos: motivos(canc),
    retencao: [retencao(e, f, mes, lastDay(e.today))],
    ltv_consolidado: null as null | { ltv_reais: number | null; ltv_meses: number | null },
    ltv_squads: [] as { id: string; nome: string; ltv_reais: number; ltv_meses: number }[],
    squads_churn: squadsChurn(e, mes, mes),
  };
}

export function churnDataAnual(e: CsEngine, f: CsFilter, mesesIn?: string[] | null) {
  const mes = f.mes_ref;
  const meses = mesesIn?.length ? mesesIn : Array.from({ length: 12 }, (_, i) => addMonths(mes, i - 11));
  const ini = meses[0];
  const fim = meses[meses.length - 1];
  const canc = cancelamentos(e, f, ini, fim, (d) => addMonths(d, -3));
  const ltvOf = (c: CsDataClient) => ({
    gasto: sum(e.cyclesOfClient(c.id).filter((y) => y.paid > 0).map(e.vef)),
    meses: Math.max(1, monthsBetween(c.entry_date, c.churn_date ?? mes)),
  });
  const cons = e.clients.filter((c) => e.squadOk(c, f.squad_id, mes)).map(ltvOf);
  return {
    mes_ref: mes, modo: "anual",
    periodo_label: meses.length === 12 ? `12 meses até ${labelMesFull(mes)}`
      : `${meses.length} meses · ${labelMes(ini)} → ${labelMes(fim)}`,
    cancelamentos: canc,
    perda_potencial: sum(canc.map((c) => c.investimento_medio * 12)),
    perda_evitavel: sum(canc.filter((c) => c.evitavel).map((c) => c.investimento_medio * 12)),
    motivos: motivos(canc),
    retencao: meses.map((m) => retencao(e, f, m, lastDay(mes))),
    ltv_consolidado: {
      ltv_reais: cons.length ? sum(cons.map((x) => x.gasto)) / cons.length : null,
      ltv_meses: cons.length ? sum(cons.map((x) => x.meses)) / cons.length : null,
    },
    ltv_squads: e.squads
      .map((s) => {
        const xs = e.clients.filter((c) => c.squad_id === s.id).map(ltvOf);
        return xs.length ? { id: s.id, nome: s.name, ltv_reais: sum(xs.map((x) => x.gasto)) / xs.length,
          ltv_meses: sum(xs.map((x) => x.meses)) / xs.length } : null;
      })
      .filter((x): x is { id: string; nome: string; ltv_reais: number; ltv_meses: number } => x !== null),
    squads_churn: squadsChurn(e, ini, fim),
  };
}

// ------------------------------------------------------------ Bloco 6
/** Domingo → sábado da semana da data, presa ao mês da data. */
export function semanaDe(d: string): [string, string] {
  let ini = addDays(d, -weekday(d));
  let fim = addDays(ini, 6);
  if (ini < monthStart(d)) ini = monthStart(d);
  if (fim > lastDay(d)) fim = lastDay(d);
  return [ini, fim];
}

export type SemanaLinha = {
  cycle: CsDataCycle; cliente_id: string; nome: string; id_externo: string; squad_nome: string; mes_competencia: string;
  data_cobranca: string | null; data_pagamento: string | null; valor_planejado_melhor: number;
  valor_planejado_provavel: number; valor_pago: number; probabilidade: string; status_pagamento: string;
  adimplencia: string; a_receber: number;
};

export function previsibilidadeData(e: CsEngine, f: CsFilter, semanaDia?: string | null) {
  const mes = f.mes_ref;
  const sqOk = (c: CsDataClient) => e.squadOk(c, f.squad_id, mes);
  const fc = forecast3Cenarios(e, f);
  const meta = e.goal(f.squad_id, mes);
  const forecast = {
    ...fc, meta,
    pct_pessimista: meta > 0 ? (fc.pessimista / meta) * 100 : 0,
    pct_provavel: meta > 0 ? (fc.provavel / meta) * 100 : 0,
    pct_melhor: meta > 0 ? (fc.melhor / meta) * 100 : 0,
  };
  // 6.2 Semana
  const [sIni, sFim] = semanaDe(semanaDia || e.today);
  const linhas: SemanaLinha[] = e.cycles
    .filter((y) => between(y.billing_date, sIni, sFim) && sqOk(e.clientOf(y.client)))
    .map((y) => {
      const c = e.clientOf(y.client);
      const a_receber = y.status === "PENDENTE" ? y.probable : y.status === "PARCIAL" ? Math.max(0, y.probable - y.paid) : 0;
      return {
        cycle: y, cliente_id: c.id, nome: c.name, id_externo: c.external_id, squad_nome: e.squadName(c.squad_id),
        mes_competencia: y.month, data_cobranca: y.billing_date, data_pagamento: y.paid_date,
        valor_planejado_melhor: y.best, valor_planejado_provavel: y.probable, valor_pago: y.paid,
        probabilidade: y.probability, status_pagamento: y.status, adimplencia: y.adimplencia, a_receber,
      };
    })
    .sort((a, b) => (a.data_cobranca! < b.data_cobranca! ? -1 : a.data_cobranca! > b.data_cobranca! ? 1 : byName(a.nome, b.nome)));
  const naoPlanejado = e.cycles
    .filter((y) => between(y.paid_date, sIni, sFim) && !between(y.billing_date, sIni, sFim) && y.paid > 0 &&
      sqOk(e.clientOf(y.client)))
    .map((y) => {
      const c = e.clientOf(y.client);
      return { nome: c.name, id_externo: c.external_id, squad_nome: e.squadName(c.squad_id), data_cobranca: y.billing_date,
        data_pagamento: y.paid_date, valor_pago: y.paid, status_pagamento: y.status };
    })
    .sort((a, b) => (a.data_pagamento! < b.data_pagamento! ? -1 : a.data_pagamento! > b.data_pagamento! ? 1 : byName(a.nome, b.nome)));
  const recPlan = sum(linhas.filter((l) => between(l.data_pagamento, sIni, sFim)).map((l) => l.valor_pago));
  const recNao = sum(naoPlanejado.map((l) => l.valor_pago));
  const perdas = linhas.filter((l) => l.status_pagamento === "PERDA");
  const mesScore = monthStart(sFim);
  const fimAcum = minDate(sFim, lastDay(mesScore));
  const acumYs = e.cycles.filter((y) => (between(y.billing_date, mesScore, fimAcum) || between(y.paid_date, mesScore, fimAcum)) &&
    sqOk(e.clientOf(y.client)));
  const planejadoAcum = sum(acumYs.filter((y) => between(y.billing_date, mesScore, fimAcum)).map((y) => y.probable));
  const recebidoAcum = sum(acumYs.filter((y) => between(y.paid_date, mesScore, fimAcum) && y.paid > 0).map((y) => y.paid));
  const totProv = sum(linhas.map((l) => l.valor_planejado_provavel));
  const semana = {
    inicio: sIni, fim: sFim, linhas, nao_planejado_linhas: naoPlanejado,
    tot_planejado_provavel: totProv, tot_planejado_melhor: sum(linhas.map((l) => l.valor_planejado_melhor)),
    tot_recebido_planejado: recPlan, tot_nao_planejado: recNao, tot_recebido: recPlan + recNao,
    forecast_gap: totProv - (recPlan + recNao),
    tot_a_receber: sum(linhas.map((l) => l.a_receber)), n_a_receber: linhas.filter((l) => l.a_receber > 0).length,
    tot_perda: sum(perdas.map((l) => l.valor_planejado_provavel)), n_perda: perdas.length,
    mes_score: mesScore, fim_acum: fimAcum, planejado_acum: planejadoAcum, recebido_acum: recebidoAcum,
    score_acum: recebidoAcum - planejadoAcum,
  };
  // 6.3 Pipeline de churn
  const invFrom = addMonths(mes, -3);
  const pipeChurn = e.clients
    .filter((c) => (c.status === "ATIVO" || c.status === "MAKE_IN") && e.activeIn(c, mes) && sqOk(c))
    .map((c) => {
      const hs = e.hsAtMonth(c.id, mes);
      const y = e.cycleAt(c.id, mes);
      const inv = avgOr(e.cyclesOfClient(c.id).filter((x) => x.month >= invFrom && x.paid > 0).map((x) => x.paid), 0);
      return { c, hs, y, inv };
    })
    .filter((r) => (r.hs !== null && r.hs.score < 70) || (r.y !== null && (r.y.adimplencia === "INADIMPLENTE" ||
      r.y.adimplencia === "PERDA")))
    .sort((a, b) => nullsFirstAsc(a.hs?.score ?? null, b.hs?.score ?? null) || b.inv - a.inv)
    .slice(0, 15)
    .map(({ c, hs, y, inv }) => {
      let motivo = "Risco geral", acao = "Acompanhamento próximo";
      if (y && (y.adimplencia === "INADIMPLENTE" || y.adimplencia === "PERDA")) {
        motivo = "Financeiro"; acao = "Renegociar / cobrança ativa";
      } else if (hs && !hs.payment) {
        motivo = "Financeiro"; acao = "Renegociar / cobrança ativa";
      } else if (c.kind === "TRIAL" && (c.trial_month ?? 0) < 3) {
        motivo = "Performance Trial"; acao = "Reunião de alinhamento";
      } else if (hs && (!hs.perception || !hs.goal)) {
        motivo = "Performance"; acao = "Reunião de resgate";
      }
      return {
        id: c.id, nome: c.name, id_externo: c.external_id, tipo_id: c.kind, mes_de_trial: c.trial_month,
        squad_nome: e.squadName(c.squad_id), hs: hs?.score ?? null, faixa: hs?.band ?? null,
        c_pagamento_dia: hs ? hs.payment : null, c_percepcao_valor: hs ? hs.perception : null,
        c_meta_batida: hs ? hs.goal : null, adimplencia: y?.adimplencia ?? null, status_pagamento: y?.status ?? null,
        investimento_medio: inv, motivo_provavel: motivo, acao,
      };
    });
  // 6.4 Pipeline de graduação (M3 e M4+)
  const ancora = minDate(lastDay(mes), e.today);
  const pipeGrad = e.clients
    .filter((c) => c.kind === "TRIAL" && monthsBetween(c.entry_date, ancora) >= 2 && c.churn_date === null && sqOk(c))
    .map((c) => {
      const hs = e.hsAtMonth(c.id, mes);
      const y = e.cycleAt(c.id, mes);
      const ate = e.cyclesOfClient(c.id).filter((x) => x.month <= mes);
      const fase_num = monthsBetween(c.entry_date, ancora) + 1;
      const cond_hs = (hs?.score ?? 0) >= 70;
      const cond_adimp = ate.length > 0 && ate.every((x) => x.adimplencia === "ADIMPLENTE");
      const cond_prob = y?.probability === "PROVAVEL" || y?.probability === "ALTA";
      const score = Number(cond_hs) + Number(cond_adimp) + Number(cond_prob);
      return {
        id: c.id, nome: c.name, id_externo: c.external_id, mes_de_trial: c.trial_month, squad_nome: e.squadName(c.squad_id),
        hs: hs?.score ?? null, investimento: y?.probable ?? null, prob_atual: y?.probability ?? null, fase_num,
        ciclos_adimplentes: ate.filter((x) => x.adimplencia === "ADIMPLENTE").length, ciclos_total: ate.length,
        probabilidade_grad: score === 3 ? "ALTA" : score === 2 ? "MEDIA" : "BAIXA",
        cond_hs, cond_adimp, cond_prob,
        fase: `M${fase_num}${fase_num >= 4 ? " (estendido)" : ""}`,
      };
    })
    .sort((a, b) => b.fase_num - a.fase_num || nullsLastDesc(a.hs, b.hs));
  return {
    mes_ref: mes, forecast, semana,
    pipeline_churn: pipeChurn, pipeline_churn_total: sum(pipeChurn.map((r) => r.investimento_medio)),
    pipeline_grad: pipeGrad, pipeline_grad_total: sum(pipeGrad.map((r) => r.investimento ?? 0)),
    anomalias: detectorAnomalias(e, f),
  };
}

export type Alerta = {
  severidade: "alta" | "media"; regra: string; mensagem: string; cliente_id?: string | null; squad_id?: string;
};

export function detectorAnomalias(e: CsEngine, f: CsFilter): Alerta[] {
  const mes = f.mes_ref;
  const ant = mesAnterior(mes);
  const sqOk = (c: CsDataClient) => e.squadOk(c, f.squad_id, mes);
  const alertas: Alerta[] = [];
  // Na ordem dos registros de HS do mês (a do índice que o MySQL usa).
  for (const h of e.hsOfMonth(mes)) {
    const c = e.clientOf(h.client);
    if (c.churn_date !== null || !sqOk(c)) continue;
    const a = e.hsAtMonth(c.id, ant);
    if (!a) continue;
    const delta = h.score - a.score;
    if (delta <= -20)
      alertas.push({ severidade: "alta", regra: "queda_hs", cliente_id: c.id,
        mensagem: `<strong>${esc(c.name)}</strong> caiu de HS ${f0(a.score)}% → ${f0(h.score)}% em 1 mês (Δ ${f0(delta)} pts).` });
    if (!h.payment && a.payment)
      alertas.push({ severidade: "media", regra: "queda_pagamento", cliente_id: c.id,
        mensagem: `<strong>${esc(c.name)}</strong> deixou de estar com pagamento em dia este mês.` });
    if (!h.goal && a.goal)
      alertas.push({ severidade: "alta", regra: "queda_meta", cliente_id: c.id,
        mensagem: `<strong>${esc(c.name)}</strong> não bateu meta este mês (batia no anterior).` });
  }
  for (const c of e.clients) {
    const y = e.cycleAt(c.id, mes);
    const p = e.cycleAt(c.id, ant);
    if (!y || !p || !sqOk(c)) continue;
    if (y.probability === "BAIXA" && p.probability === "BAIXA")
      alertas.push({ severidade: "alta", regra: "prob_baixa_2", cliente_id: c.id,
        mensagem: `<strong>${esc(c.name)}</strong> com Probabilidade=BAIXA por 2 ciclos seguidos · ${fmtMoney(y.probable)} em risco.` });
  }
  for (const c of e.clients) {
    const y = e.cycleAt(c.id, mes);
    const p = e.cycleAt(c.id, ant);
    if (y && p && sqOk(c) && y.status === "PERDA" && p.status === "PERDA")
      alertas.push({ severidade: "alta", regra: "perda_recorrente", cliente_id: c.id,
        mensagem: `<strong>${esc(c.name)}</strong> com PERDA por 2 meses seguidos.` });
  }
  for (const s of e.squads) {
    if (f.squad_id !== null && s.id !== f.squad_id) continue;
    const atual = fatOf(e, e.cyclesOfMonth(mes).filter((y) => e.cycleSquad(y) === s.id));
    const prev = [addMonths(mes, -3), addMonths(mes, -2), addMonths(mes, -1)]
      .map((m) => e.cyclesOfMonth(m).filter((y) => e.cycleSquad(y) === s.id && y.paid > 0))
      .filter((ys) => ys.length > 0)
      .map((ys) => sum(ys.map(e.vef)));
    const avg3 = avgOr(prev, 0);
    if (avg3 > 0 && atual / avg3 < 0.85)
      alertas.push({ severidade: "alta", regra: "queda_squad", squad_id: s.id,
        mensagem: `Squad <strong>${esc(s.name)}</strong> caiu ${f0((1 - atual / avg3) * 100)}% vs run-rate dos últimos 3 meses.` });
  }
  const churnsAtual = e.clients.filter((c) => between(c.churn_date, mes, lastDay(mes))).length;
  const porMes = new Map<string, number>();
  for (const c of e.clients)
    if (between(c.churn_date, addMonths(mes, -6), addMonths(mes, -1)))
      porMes.set(monthStart(c.churn_date!), (porMes.get(monthStart(c.churn_date!)) ?? 0) + 1);
  const media6 = avgOr([...porMes.values()], 0);
  if (media6 > 0 && churnsAtual > 1.5 * media6)
    alertas.push({ severidade: "alta", regra: "pico_churn",
      mensagem: `Pico de churn: <strong>${churnsAtual}</strong> saídas no mês (média 6m: ${f1(media6)}).` });
  for (const c of e.clients) {
    if (c.kind !== "TRIAL" || c.trial_month !== 3 || c.churn_date !== null || !sqOk(c)) continue;
    const hs = e.hsAtMonth(c.id, mes)?.score ?? 0;
    if (hs < 50)
      alertas.push({ severidade: "alta", regra: "m3_hs_baixo", cliente_id: c.id,
        mensagem: `<strong>${esc(c.name)}</strong> em Trial M3 com HS=${f0(hs)}% — risco alto de não graduar.` });
  }
  const sorted = [...alertas.filter((a) => a.severidade === "alta"), ...alertas.filter((a) => a.severidade !== "alta")];
  const rec = recPlanejamento(e, { mes_ref: mes, squad_id: f.squad_id });
  for (const ra of rec.alertas)
    if (ra.regra !== "ciclo_sem_fim")
      sorted.push({ severidade: ra.severidade, regra: ra.regra, cliente_id: ra.cliente_id ?? null, mensagem: ra.mensagem });
  return sorted;
}

// ------------------------------------------------------------ Bloco 7
export type SquadMetricas = {
  nome: string; fat: number; ticket: number; ativos_trial: number; ativos_base: number; hs_medio: number; m_medio: number;
  net_churn: number; entradas: number; saidas: number; taxa_grad: number; taxa_adimp: number;
};
export function squadsData(e: CsEngine, f: CsFilter, mesesIn?: string[] | null) {
  const mes = f.mes_ref;
  const meses = mesesIn?.length ? mesesIn : [mes];
  const ini = meses[0];
  const fim = meses[meses.length - 1];
  const metricas = (sid: string, nome: string): SquadMetricas => {
    const ys = meses.flatMap((m) => e.cyclesOfMonth(m)).filter((y) => e.cycleSquad(y) === sid);
    const fat = sum(ys.map(e.vef));
    const pag = ys.filter(e.isEffectivePayer).length;
    const naFoto = e.clients.filter((c) => e.squadInMonth(c, fim) === sid && e.activeIn(c, fim));
    const hs = meses.flatMap((m) => e.hsOfMonth(m)).filter((h) => e.squadInMonth(e.clientOf(h.client), h.month) === sid);
    const mp = meses.flatMap((m) => e.multipliersIn(m)).filter((x) => e.squadInMonth(e.clientOf(x.client), x.month) === sid);
    const rng = (d: string | null) => between(d, ini, lastDay(fim));
    const sqAt = (c: CsDataClient, d: string) => e.squadInMonth(c, monthStart(d)) === sid;
    const novos = e.clients.filter((c) => countsAsNew(c) && sqAt(c, c.entry_date) && rng(c.entry_date)).length;
    const reat = e.reactivations.filter((r) => sqAt(r.client, r.date) && rng(r.date)).length;
    const saidas = e.churns.filter((r) => sqAt(r.client, r.date) && rng(r.date)).length;
    const coorte = e.clients.filter((c) => sqAt(c, c.entry_date) && between(c.entry_date, addMonths(fim, -3), fim));
    const grad3 = coorte.filter((c) => isBase(c) && c.trial_month !== null && c.churn_date === null).length;
    const adimp = ys.filter((y) => y.adimplencia === "ADIMPLENTE").length;
    return {
      nome, fat, ticket: pag > 0 ? fat / pag : 0,
      ativos_trial: naFoto.filter((c) => c.kind === "TRIAL").length,
      ativos_base: naFoto.filter(isBase).length,
      hs_medio: avgOr(hs.map((h) => h.score), 0), m_medio: avgOr(mp.map((x) => x.value), 0),
      net_churn: novos + reat - saidas, entradas: novos + reat, saidas,
      taxa_grad: coorte.length > 0 ? (grad3 / coorte.length) * 100 : 0,
      taxa_adimp: ys.length > 0 ? (adimp / ys.length) * 100 : 0,
    };
  };
  const por_squad: Record<string, SquadMetricas> = {};
  for (const s of e.squads) por_squad[s.id] = metricas(s.id, s.name);
  const sids = e.squads.map((s) => s.id);
  const keys = ["fat", "ticket", "ativos_trial", "ativos_base", "hs_medio", "m_medio", "net_churn", "entradas", "taxa_grad",
    "taxa_adimp"] as const;
  const lideres: Record<string, string | null> = {};
  for (const k of keys) {
    let best: string | null = null;
    let bv: number | null = null;
    for (const sid of sids) if (bv === null || por_squad[sid][k] > bv) { bv = por_squad[sid][k]; best = sid; }
    lideres[k] = best;
  }
  const insights: string[] = [];
  if (sids.length >= 2) {
    const extremos = (k: (typeof keys)[number], soPositivos: boolean) => {
      const cands = sids.filter((sid) => !soPositivos || por_squad[sid][k] > 0);
      if (cands.length < 2) return null;
      const vals = cands.map((sid) => por_squad[sid][k]);
      const maxSid = cands[vals.indexOf(Math.max(...vals))];
      const minSid = cands[vals.indexOf(Math.min(...vals))];
      return maxSid === minSid ? null : [por_squad[maxSid], por_squad[minSid]] as const;
    };
    let ext = extremos("ticket", true);
    if (ext) {
      const [maior, menor] = ext;
      const razao = menor.ticket > 0 ? ((maior.ticket - menor.ticket) / menor.ticket) * 100 : 0;
      if (razao >= 20)
        insights.push(`<strong>${esc(maior.nome)}</strong> tem ticket médio ${numberFormat(razao, 0)}% maior que ${esc(menor.nome)}.`);
    }
    const fatTotal = sum(sids.map((sid) => por_squad[sid].fat));
    const cliTotal = sum(sids.map((sid) => por_squad[sid].ativos_trial + por_squad[sid].ativos_base));
    ext = extremos("fat", true);
    if (ext && fatTotal > 0 && cliTotal > 0) {
      const [maior] = ext;
      const pf = (maior.fat / fatTotal) * 100;
      const pc = ((maior.ativos_trial + maior.ativos_base) / cliTotal) * 100;
      if (Math.abs(pf - pc) >= 10)
        insights.push(`<strong>${esc(maior.nome)}</strong> concentra ${numberFormat(pf, 0)}% do faturamento com apenas ${numberFormat(pc, 0)}% da carteira.`);
    }
    ext = extremos("hs_medio", true);
    if (ext) {
      const [v, p] = ext;
      const d = v.hs_medio - p.hs_medio;
      if (d >= 3)
        insights.push(`<strong>${esc(v.nome)}</strong> tem HS médio ${numberFormat(d, 0)} pts acima de ${esc(p.nome)} (${numberFormat(v.hs_medio, 0)}% vs ${numberFormat(p.hs_medio, 0)}%).`);
    }
    ext = extremos("taxa_adimp", true);
    if (ext) {
      const [v, p] = ext;
      if (v.taxa_adimp - p.taxa_adimp >= 5)
        insights.push(`<strong>${esc(v.nome)}</strong> tem maior taxa de adimplência (${numberFormat(v.taxa_adimp, 0)}%).`);
    }
  }
  const churnados = e.clients.filter((c) => between(c.churn_date, mes, lastDay(mes)));
  if (churnados.length > 0) {
    const perda = sum(churnados.map((c) => (e.avgVefSince(c.id, addMonths(mes, -3)) ?? 0) * 12));
    insights.push(`Os <strong>${churnados.length}</strong> cancelamento${churnados.length === 1 ? "" : "s"} do mês representam <strong>${fmtMoney(perda)}</strong> em receita anual potencial.`);
  }
  return { mes_ref: mes, por_squad, lideres, melhor_por_mes: [], insights };
}

// ------------------------------------------------------------ Ranking
export const RANKING_CRITERIA = [
  { key: "atingimento", rule: "goal", label: "Atingimento da meta", hint: "Faturamento efetivo ÷ meta do squad" },
  { key: "hs", rule: "hs", label: "HS médio", hint: "Saúde média da carteira no mês" },
  { key: "adimplencia", rule: "adimplencia", label: "Adimplência", hint: "% de ciclos adimplentes" },
  { key: "retencao", rule: "retention", label: "Retenção", hint: "100 − churn rate (saídas ÷ base do mês)" },
  { key: "graduacao", rule: "graduation", label: "Taxa de graduação", hint: "Graduados ÷ entradas do cohort de 3 meses" },
  { key: "realizacao", rule: "realization", label: "Provável realizado", hint: "Faturamento ÷ planejado provável (cap 120%)" },
] as const;
export type RankingKey = (typeof RANKING_CRITERIA)[number]["key"];

export function rankingSquadsData(e: CsEngine, mes: string) {
  const r = e.rules(mes);
  const criterios = Object.fromEntries(RANKING_CRITERIA.map((c) => [c.key, { label: c.label, peso: r.ranking_weights[c.rule],
    hint: c.hint }])) as Record<RankingKey, { label: string; peso: number; hint: string }>;
  const fimMes = lastDay(mes);
  const vals: { sid: string; nome: string; crits: Record<RankingKey, number | null> }[] = [];
  for (const s of e.squads) {
    let op = e.cyclesOfMonth(mes).filter((y) => e.cycleSquad(y) === s.id).length;
    if (op === 0) op = e.clients.filter((c) => e.squadInMonth(c, mes) === s.id && e.activeIn(c, mes)).length;
    if (op === 0) continue;
    const fat = fatMes(e, mes, s.id, "tudo");
    const meta = e.goal(s.id, mes);
    const hs = e.hsOfMonth(mes).filter((h) => e.squadInMonth(e.clientOf(h.client), mes) === s.id);
    const ys = e.cyclesOfMonth(mes).filter((y) => e.cycleSquad(y) === s.id);
    const carteira = e.clients.filter((c) => e.squadInMonth(c, mes) === s.id && e.activeIn(c, mes)).length;
    const saidas = e.churns.filter((x) => e.squadInMonth(x.client, monthStart(x.date)) === s.id &&
      between(x.date, mes, fimMes)).length;
    const base = carteira + saidas;
    const coorte = e.clients.filter((c) => e.squadInMonth(c, monthStart(c.entry_date)) === s.id &&
      between(c.entry_date, addMonths(fimMes, -3), fimMes));
    const grad = coorte.filter((c) => isBase(c) && c.trial_month !== null && c.churn_date === null).length;
    const planejado = sum(ys.map((y) => y.probable));
    vals.push({
      sid: s.id, nome: s.name,
      crits: {
        atingimento: meta > 0 ? (fat / meta) * 100 : null,
        hs: hs.length ? sum(hs.map((h) => h.score)) / hs.length : null,
        adimplencia: ys.length ? (ys.filter((y) => y.adimplencia === "ADIMPLENTE").length / ys.length) * 100 : null,
        retencao: base > 0 ? (1 - saidas / base) * 100 : null,
        graduacao: coorte.length > 0 ? (grad / coorte.length) * 100 : null,
        realizacao: planejado > 0 ? Math.min(r.ranking_realization_cap * 100, (fat / planejado) * 100) : null,
      },
    });
  }
  const melhores = {} as Record<RankingKey, number | null>;
  for (const c of RANKING_CRITERIA) {
    let m: number | null = null;
    for (const v of vals) {
      const x = v.crits[c.key];
      if (x !== null && (m === null || x > m)) m = x;
    }
    melhores[c.key] = m;
  }
  const squads = vals.map((v) => {
    let pontos = 0, pesos = 0;
    const cats = {} as Record<RankingKey, { valor: number | null; pontos: number | null; peso: number; lider: boolean }>;
    for (const c of RANKING_CRITERIA) {
      const x = v.crits[c.key];
      const melhor = melhores[c.key];
      const peso = criterios[c.key].peso;
      if (x === null || melhor === null || melhor <= 0) {
        cats[c.key] = { valor: x, pontos: null, peso, lider: false };
        continue;
      }
      const pts = Math.max(0, Math.min(1, x / melhor)) * peso;
      cats[c.key] = { valor: x, pontos: pts, peso, lider: Math.abs(x - melhor) < 0.0001 };
      pontos += pts;
      pesos += peso;
    }
    return { squad_id: v.sid, nome: v.nome, score: pesos > 0 ? (pontos / pesos) * 100 : 0, cats, pesos_aplicaveis: pesos, pos: 0 };
  });
  squads.sort((a, b) => b.score - a.score);
  squads.forEach((s, i) => (s.pos = i + 1));
  return { mes_ref: mes, criterios, squads, vencedor: squads[0]?.squad_id ?? null };
}

// ------------------------------------------------------------ Bloco 8
export function gerarInsights(e: CsEngine, f: CsFilter) {
  const mes = f.mes_ref;
  const ant = mesAnterior(mes);
  const alertas: string[] = [], atencoes: string[] = [], conquistas: string[] = [], recomendacoes: string[] = [];
  for (const a of detectorAnomalias(e, f)) (a.severidade === "alta" ? alertas : atencoes).push(a.mensagem);
  const satToCrit = e.clients.filter((c) => e.hsAtMonth(c.id, mes)?.band === "CRITICO" &&
    e.hsAtMonth(c.id, ant)?.band === "SATISFEITO").length;
  if (satToCrit > 0)
    alertas.push(`<strong>${satToCrit}</strong> cliente${satToCrit === 1 ? "" : "s"} saíram de Satisfeito direto para Crítico no HS.`);
  const pagoBruto = (m: string, sid: string) =>
    sum(e.cyclesOfMonth(m).filter((y) => e.cycleSquad(y) === sid && y.paid > 0).map((y) => y.paid));
  for (const s of e.squads) {
    const at = pagoBruto(mes, s.id);
    const an = pagoBruto(ant, s.id);
    if (an > 0 && at < 0.85 * an)
      alertas.push(`Faturamento de <strong>${esc(s.name)}</strong> caiu ${fmtMoney(an - at)} vs mês anterior (−${f0(((an - at) / an) * 100)}%).`);
  }
  const fc = forecast3Cenarios(e, f);
  const metaTotal = e.goal(null, mes);
  if (metaTotal > 0 && fc.provavel > 0) {
    const d = ((fc.provavel - metaTotal) / metaTotal) * 100;
    if (d < -10)
      atencoes.push(`Forecast Provável aponta fechamento em <strong>${fmtMoney(fc.provavel)}</strong> vs meta <strong>${fmtMoney(metaTotal)}</strong> (${f0(d)}%).`);
  }
  const ticket = (m: string) => {
    const ys = e.cyclesOfMonth(m).filter((y) => y.paid > 0);
    const n = distinct(ys.map((y) => y.client));
    return n > 0 ? sum(ys.map((y) => y.paid)) / n : 0;
  };
  const tmA = ticket(mes), tmP = ticket(ant);
  if (tmP > 0 && tmA < 0.95 * tmP)
    atencoes.push(`Ticket médio caiu de <strong>${fmtMoney(tmP)}</strong> para <strong>${fmtMoney(tmA)}</strong>.`);
  const [si, sf] = semanaDe(e.today);
  const pend = e.cycles.filter((y) => between(y.billing_date, si, sf) && y.status === "PENDENTE");
  if (pend.length > 0)
    atencoes.push(`<strong>${pend.length}</strong> cobrança${pend.length === 1 ? "" : "s"} da semana ainda pendente${pend.length === 1 ? "" : "s"} — <strong>${fmtMoney(sum(pend.map((y) => y.probable)))}</strong> em aberto.`);
  const ativos = (m: string) => e.clients.filter((c) => e.activeIn(c, m));
  const totA = ativos(mes), totP = ativos(ant);
  if (totA.length > 0 && totP.length > 0) {
    const pa = (totA.filter((c) => c.kind === "TRIAL").length / totA.length) * 100;
    const pp = (totP.filter((c) => c.kind === "TRIAL").length / totP.length) * 100;
    if (pa - pp >= 5) atencoes.push(`% Trial subiu de <strong>${f0(pp)}%</strong> para <strong>${f0(pa)}%</strong> da carteira.`);
  }
  const makeIn = totA.filter((c) => c.status === "MAKE_IN");
  const totPlan = sum(e.cyclesOfMonth(mes).map((y) => y.probable));
  if (makeIn.length > 0 && totPlan > 0) {
    const fatMi = sum(makeIn.map((c) => e.cycleAt(c.id, mes)?.probable ?? 0));
    const pct = (fatMi / totPlan) * 100;
    if (pct >= 10)
      atencoes.push(`<strong>${makeIn.length}</strong> cliente${makeIn.length === 1 ? "" : "s"} em <strong>Make IN</strong> concentram <strong>${f0(pct)}%</strong> do faturamento previsto (${fmtMoney(fatMi)}) — graduar pra ATIVO o quanto antes.`);
  }
  const hsAvg = (m: string) => avgOr(e.hsOfMonth(m).map((h) => h.score), 0);
  const hA = hsAvg(mes), hP = hsAvg(ant);
  if (hA > hP && hA - hP >= 1)
    conquistas.push(`Health Score médio subiu <strong>+${f1(hA - hP)} pts</strong> vs mês anterior (${f0(hP)}% → ${f0(hA)}%).`);
  const recuperados = e.clients
    .map((c) => ({ c, h: e.hsAtMonth(c.id, mes), a: e.hsAtMonth(c.id, ant) }))
    .filter((r) => r.h && r.a && r.h.score - r.a.score >= 10)
    .sort((x, y) => (y.h!.score - y.a!.score) - (x.h!.score - x.a!.score))
    .slice(0, 3);
  for (const r of recuperados)
    conquistas.push(`<strong>${esc(r.c.name)}</strong> recuperou-se: HS subiu de ${f0(r.a!.score)}% para ${f0(r.h!.score)}%.`);
  const sm = previsibilidadeData(e, f).semana;
  if (sm.tot_recebido > sm.tot_planejado_provavel && sm.tot_planejado_provavel > 0)
    conquistas.push(`Total Recebido da semana superou em <strong>${fmtMoney(sm.tot_recebido - sm.tot_planejado_provavel)}</strong> o Total Planejado (${fmtMoney(sm.tot_recebido)} vs ${fmtMoney(sm.tot_planejado_provavel)}).`);
  for (const s of e.squads) {
    const ys = e.cyclesOfMonth(mes).filter((y) => e.cycleSquad(y) === s.id);
    if (ys.length > 0) {
      const t = (ys.filter((y) => y.adimplencia === "ADIMPLENTE").length / ys.length) * 100;
      if (t >= 90) conquistas.push(`Squad <strong>${esc(s.name)}</strong> com <strong>${f0(t)}%</strong> de adimplência este mês.`);
    }
  }
  const sd = saudeData(e, f);
  if (sd.em_risco.length > 0)
    recomendacoes.push(`Priorizar contato com <strong>${sd.em_risco.length}</strong> conta${sd.em_risco.length === 1 ? "" : "s"} em risco — perda potencial de <strong>${fmtMoney(sd.em_risco_total)}</strong>.`);
  for (const s of e.squads) {
    const fat = pagoBruto(mes, s.id);
    const meta = e.goal(s.id, mes);
    if (meta > 0 && fat < meta) {
      const gap = ((meta - fat) / meta) * 100;
      if (gap >= 10) {
        const base = e.clients.filter((c) => e.squadInMonth(c, mes) === s.id && isBase(c) &&
          (c.churn_date === null || c.churn_date > lastDay(mes))).length;
        recomendacoes.push(`Squad <strong>${esc(s.name)}</strong> com gap de <strong>${f0(gap)}%</strong> na meta — explorar upsell em <strong>${base}</strong> contas Base.`);
      }
    }
  }
  const m3 = e.clients.filter((c) => c.kind === "TRIAL" && c.trial_month === 3 && c.churn_date === null).length;
  if (m3 > 0)
    recomendacoes.push(`<strong>${m3}</strong> cliente${m3 === 1 ? "" : "s"} em Trial M3 — touch decisivo nesta semana para graduação.`);
  if (pend.length > 0)
    recomendacoes.push(`<strong>${pend.length}</strong> cobrança${pend.length === 1 ? "" : "s"} desta semana sem confirmação — alinhar com o financeiro.`);
  const rec = recPlanejamento(e, { mes_ref: mes, squad_id: f.squad_id });
  if (rec.total_vencido > 0.01)
    alertas.push(`<strong>${fmtMoney(rec.total_vencido)}</strong> em ${rec.n_vencido} cobrança${rec.n_vencido === 1 ? "" : "s"} já venceu e não entrou — é o dinheiro do mês que dá pra destravar hoje.`);
  const eleg = rec.sugestoes.filter((s) => s.sugestao!.classe !== "cautela");
  if (eleg.length)
    recomendacoes.push(`<strong>${eleg.length}</strong> cliente${eleg.length === 1 ? "" : "s"} com cobrança do dia ${rec.regras.zona_vermelha_dia} em diante podem ser antecipados (HS ok, pagam em dia) — tira <strong>${fmtMoney(rec.impacto_sugestoes)}</strong> da última semana. Ver Planejamento de Recebimento.`);
  if (rec.fora_alcance.length)
    atencoes.push(`<strong>${rec.fora_alcance.length}</strong> cliente${rec.fora_alcance.length === 1 ? "" : "s"} cobrando no fim do mês com HS crítico ou inadimplência — NÃO mexer na data, foco em recuperar.`);
  return {
    alertas: alertas.slice(0, 6), atencoes: atencoes.slice(0, 6),
    conquistas: conquistas.slice(0, 6), recomendacoes: recomendacoes.slice(0, 6),
  };
}

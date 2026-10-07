import {
  CHURN_REASONS,
  addMonths,
  between,
  byName,
  countsAsNew,
  daysInMonth,
  dateDiff,
  fmtDateBr,
  fmtMoney,
  f0,
  f1,
  labelMes,
  labelMesFull,
  lastDay,
  monthStart,
  monthsBetween,
  numberFormat,
  phpRound,
  type CsDataClient,
  type CsDataCycle,
  type CsDim,
  type CsEngine,
  type CsFilter,
} from "./cs-engine.js";
import {
  detectorAnomalias,
  gerarInsights,
  previsibilidadeData,
  rankingSquadsData,
  squadsData,
  trocasSquadMes,
} from "./cs-blocks.js";
import { recPlanejamento, type RecHist } from "./cs-receiving.js";

/**
 * As janelas de detalhe ("ver", "explorar") do painel de CS. Porta de
 * cs-make-dashboard/dash/lib/drilldowns.php: cada métrica devolve título,
 * números de resumo (os clicáveis filtram a tabela), quebras, filtros,
 * colunas e linhas. A tela (CsDrillModal) é genérica.
 */

export type DdColType =
  | "string" | "money" | "int" | "pct" | "date" | "mes" | "tipo" | "squad" | "check" | "m1" | "hs_faixa" | "adimp"
  | "trial_fase" | "trial_status";
export type DdCol = { key: string; label: string; type: DdColType; align: "left" | "right" | "center" };
export type DdStat = {
  label: string; value: number | string | null; type: "money" | "int" | "pct" | "string"; hint: string | null;
  highlight: boolean; filter: { key: string; value: string | number } | null;
};
export type DdFilter = { key: string; label: string; type: "select"; options: { value: string; label: string }[] };
export type DdBreakdown = { title: string; columns: DdCol[]; rows: Record<string, unknown>[] };
export type DdRow = Record<string, unknown>;
export type DdMonthly = {
  mes: string; label: string; count: number; total: number; meta?: number; atingimento?: number | null; delta_pct?: number | null;
};
export type DdResult = {
  title: string; stats: DdStat[]; breakdown: DdBreakdown[]; filters: DdFilter[]; columns: DdCol[]; rows: DdRow[];
  total: number | null; count: number; summary_field: string | null; monthly_summary: DdMonthly[];
  simulador?: { meta: number; realizado: number };
};
export type DdParams = {
  mes?: string; mes_ini?: string; mes_fim?: string; squad?: string | null; dim?: CsDim; faixa?: string;
  categoria?: string; metrica?: string; dia?: number; data?: string;
};

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const stat = (label: string, value: DdStat["value"], type: DdStat["type"] = "string", hint: string | null = null,
  highlight = false, filter: DdStat["filter"] = null): DdStat => ({ label, value, type, hint, highlight, filter });
const col = (key: string, label: string, type: DdColType = "string", align: DdCol["align"] = "left"): DdCol =>
  ({ key, label, type, align });
const MES_COL = col("mes", "Mês", "mes");

function groupSum(rows: DdRow[], key: string, field: string) {
  const g = new Map<unknown, { key: unknown; count: number; sum: number }>();
  for (const r of rows) {
    const k = r[key] ?? "NULL";
    const x = g.get(k) ?? { key: k, count: 0, sum: 0 };
    x.count++;
    x.sum += Number(r[field] ?? 0) || 0;
    g.set(k, x);
  }
  return [...g.values()];
}

/** Os meses do detalhe: mes_ini→mes_fim ou um mês só. */
export function ddMeses(p: DdParams, today: string) {
  const norm = (s?: string) => (s ? (s.length === 7 ? `${s}-01` : monthStart(s)) : null);
  const ini = norm(p.mes_ini), fim = norm(p.mes_fim);
  if (ini && fim) {
    const out: string[] = [];
    for (let m = ini, g = 0; m <= fim && g < 60; m = addMonths(m, 1), g++) out.push(m);
    return out;
  }
  return [norm(p.mes) ?? monthStart(today)];
}

type Ctx = { e: CsEngine; meses: string[]; sq: string | null; dim: CsDim; multi: boolean; p: DdParams };

function subtitle(c: Ctx) {
  const parts: string[] = [];
  if (c.sq !== null) parts.push(c.e.squadName(c.sq));
  if (c.dim === "trial") parts.push("Trial");
  else if (c.dim === "base") parts.push("Base");
  parts.push(c.meses.length === 1 ? labelMes(c.meses[0]) : `${labelMes(c.meses[0])} → ${labelMes(c.meses[c.meses.length - 1])}`);
  return parts.join(" · ");
}
const squadOptions = (e: CsEngine) => [{ value: "all", label: "Todas" }, ...e.squads.map((s) => ({ value: s.id, label: s.name }))];
const TIPO_OPTIONS = [
  { value: "all", label: "Todos" }, { value: "TRIAL", label: "Trial" }, { value: "BASE", label: "Base" },
  { value: "BASE_RA", label: "Base RA" },
];
const tipoFilter: DdFilter = { key: "tipo_id", label: "Tipo", type: "select", options: TIPO_OPTIONS };

/** Ciclos do mês no squad do ciclo + dimensão. */
const cyc = (c: Ctx, m: string) => c.e.cyclesOfMonth(m).filter((y) => c.e.cycleOk(y, { squad_id: c.sq, dim: c.dim }));
/** Cliente no squad do mês + dimensão. */
const cliOk = (c: Ctx, cl: CsDataClient, m: string) => c.e.squadOk(cl, c.sq, m) && c.e.dimOk(cl, c.dim);

function monthlySummary(rows: DdRow[], field: string | null): DdMonthly[] {
  const by = new Map<string, DdMonthly>();
  for (const r of rows) {
    const m = r.mes as string | undefined;
    if (!m) continue;
    const x = by.get(m) ?? { mes: m, label: labelMes(m), count: 0, total: 0 };
    x.count++;
    if (field) x.total += Number(r[field] ?? 0) || 0;
    by.set(m, x);
  }
  return [...by.values()].sort((a, b) => (a.mes < b.mes ? -1 : 1));
}
function monthlyMeta(c: Ctx, rows: DdRow[], field: string): DdMonthly[] {
  let prev: number | null = null;
  return c.meses.map((m) => {
    const mine = rows.filter((r) => r.mes === m);
    const total = sum(mine.map((r) => Number(r[field] ?? 0)));
    const meta = c.e.goal(c.sq, m);
    const out = { mes: m, label: labelMes(m), count: mine.length, total, meta,
      atingimento: meta > 0 ? (total / meta) * 100 : null,
      delta_pct: prev !== null && prev > 0 ? ((total - prev) / prev) * 100 : null };
    prev = total;
    return out;
  });
}
function tendencia(ms: DdMonthly[]): DdStat | null {
  if (ms.length < 2) return null;
  const first = ms[0].total, last = ms[ms.length - 1].total;
  if (first <= 0) return null;
  const pct = ((last - first) / first) * 100;
  const dir = pct > 5 ? "▲ subindo" : pct < -5 ? "▼ caindo" : "→ estável";
  return stat("Tendência", `${dir} (${pct >= 0 ? "+" : ""}${f1(pct)}%)`, "string",
    `${ms[0].label} (${fmtMoney(first)}) → ${ms[ms.length - 1].label} (${fmtMoney(last)})`);
}

// ------------------------------------------------------------ métricas
function ddAtivos(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses) {
    const from = addMonths(m, -2);
    for (const cl of e.clients.filter((x) => e.activeIn(x, m) && cliOk(c, x, m)).sort((a, b) => byName(a.name, b.name))) {
      const ys = e.cyclesOfClient(cl.id).filter((y) => y.month >= from && y.month <= lastDay(m) && y.paid > 0);
      const vals = ys.map(e.vef);
      const nz = vals.filter((v) => v !== 0);
      rows.push({ id: cl.id, id_externo: cl.external_id, nome: cl.name, tipo_id: cl.kind, squad_id: cl.squad_id,
        data_entrada: cl.entry_date, inv_medio: nz.length ? sum(nz) / nz.length : 0, inv_total_3m: sum(vals), mes: m });
    }
  }
  const invs = rows.map((r) => r.inv_medio as number).filter((v) => v > 0);
  const total3m = sum(rows.map((r) => r.inv_total_3m as number));
  const porSq = c.sq === null ? groupSum(rows, "squad_id", "inv_medio").map((g) => {
    const xs = rows.filter((r) => r.squad_id === g.key).map((r) => r.inv_medio as number).filter((v) => v > 0);
    return { key: g.key, count: g.count, inv_medio: xs.length ? sum(xs) / xs.length : 0, inv_total: g.sum };
  }) : [];
  const n = (k: string) => rows.filter((r) => r.tipo_id === k).length;
  return {
    title: `Clientes ativos · ${subtitle(c)}`,
    stats: [
      stat("Total de ativos", rows.length, "int", null, true),
      stat("Inv. médio/cliente", invs.length ? sum(invs) / invs.length : 0, "money",
        `Média entre os ${invs.length} que pagaram nos últimos 3m (regra M1 aplicada)`),
      stat("Inv. total carteira (3m)", total3m, "money", "Soma de tudo que a carteira ativa investiu nos últimos 3 meses"),
      stat("Trial", n("TRIAL"), "int", null, false, { key: "tipo_id", value: "TRIAL" }),
      stat("Base", n("BASE"), "int", null, false, { key: "tipo_id", value: "BASE" }),
      stat("Base RA (reativados)", n("BASE_RA"), "int", null, false, { key: "tipo_id", value: "BASE_RA" }),
      stat("Sem pagamento (3m)", rows.filter((r) => r.inv_medio === 0).length, "int",
        "Ativos que não pagaram nada nos últimos 3 meses — sinal de alerta"),
    ],
    breakdown: c.sq === null && porSq.length ? [{ title: "Ativos por squad", columns: [col("key", "Squad", "squad"),
      col("count", "Ativos", "int", "right"), col("inv_medio", "Inv. médio", "money", "right"),
      col("inv_total", "Inv. total (3m)", "money", "right")], rows: porSq }] : [],
    filters: [tipoFilter],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("data_entrada", "Entrada", "date"),
      col("inv_medio", "Inv. médio (3m)", "money", "right"), col("inv_total_3m", "Inv. total (3m)", "money", "right")],
    rows, total: total3m, summary_field: "inv_medio",
  };
}

function pagantesRows(c: Ctx) {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses) {
    const ys = cyc(c, m).map((y) => ({ y, cl: e.clientOf(y.client), pag: e.isPayer(y) ? 1 : 0, vef: e.vef(y), m1: e.isM1(y) }));
    ys.sort((a, b) => b.pag - a.pag || b.vef - a.vef || byName(a.cl.name, b.cl.name));
    for (const r of ys)
      rows.push({ mes: m, id_externo: r.cl.external_id, nome: r.cl.name, squad_id: e.cycleSquad(r.y), tipo_id: r.cl.kind,
        valor_pago: r.y.paid, valor_efetivo: r.vef, eh_pagante: r.pag, eh_m1: r.m1 ? 1 : 0,
        status_pagamento: r.y.status, adimplencia: r.y.adimplencia,
        motivo: r.pag ? (r.m1 ? `M1 (−R$ ${numberFormat(e.m1(r.y) / 1000, 0)}k comissão)` : "") : r.y.status });
  }
  return rows;
}
function ddPagantes(c: Ctx): Partial<DdResult> {
  const rows = pagantesRows(c);
  const pag = rows.filter((r) => r.eh_pagante === 1);
  const total = sum(pag.map((r) => r.valor_efetivo as number));
  const ef = pag.filter((r) => (r.status_pagamento === "PAGO" || r.status_pagamento === "PARCIAL") && (r.valor_efetivo as number) > 0);
  const vals = ef.map((r) => r.valor_efetivo as number).sort((a, b) => a - b);
  const n = vals.length;
  const mediana = n ? (n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2) : 0;
  return {
    title: `Pagantes · ${subtitle(c)}`,
    stats: [
      stat("Pagantes", pag.length, "int", "Quem pagou algo conta — M1 conta mesmo se pagou ≤ R$ 3k (o desconto afeta só o faturamento)",
        true, { key: "eh_pagante", value: 1 }),
      stat("Não contam", rows.length - pag.length, "int", "Pendentes, perdas e isentos (não pagaram)", false,
        { key: "eh_pagante", value: 0 }),
      stat("Total no mês", rows.length, "int", "Todos os ciclos registrados no mês (denominador do card)"),
      stat("Faturamento gerado", total, "money"),
      stat("Ticket médio", n ? total / n : 0, "money",
        `Faturamento ÷ ${n} pagantes EFETIVOS (pendentes e M1 ≤ 3k fora do denominador)`),
      stat("Mediana", mediana, "money", "Pagante efetivo do meio (50% acima, 50% abaixo)"),
      stat("Maior ticket", n ? vals[n - 1] : 0, "money"),
      stat("Menor ticket", n ? vals[0] : 0, "money"),
      stat("Status", `${pag.filter((r) => r.status_pagamento === "PAGO").length} cheios · ${pag.filter((r) =>
        r.status_pagamento === "PARCIAL").length} parciais`),
    ],
    filters: [{ key: "eh_pagante", label: "Pagante?", type: "select", options: [{ value: "all", label: "Todos" },
      { value: "1", label: "Só pagantes" }, { value: "0", label: "Só quem não conta" }] }],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("valor_pago", "Pago", "money", "right"), col("valor_efetivo", "Efetivo", "money", "right"),
      col("eh_pagante", "Conta?", "check"), col("motivo", "Motivo"), col("status_pagamento", "Status")],
    rows, total, summary_field: "valor_efetivo",
  };
}

function faturamentoRows(c: Ctx) {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const y of cyc(c, m).filter((x) => x.paid > 0).sort((a, b) => e.vef(b) - e.vef(a) ||
      byName(e.clientOf(a.client).name, e.clientOf(b.client).name))) {
      const cl = e.clientOf(y.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(y), tipo_id: cl.kind,
        eh_acl: y.acl ? 1 : 0, valor_pago: y.paid, valor_efetivo: e.vef(y), categoria: e.category(y),
        valor_acl_efetivo: e.aclEf(y), eh_m1: e.isM1(y) ? 1 : 0, status_pagamento: y.status });
    }
  const cat = (c.p.categoria ?? "").toUpperCase();
  if (["TRIAL", "BASE", "BASE_RA", "ACL"].includes(cat))
    return rows.filter((r) => cat === "ACL" ? (r.valor_acl_efetivo as number) > 0
      : cat === "BASE" ? r.categoria === "BASE" || r.categoria === "BASE_RA" : r.categoria === cat);
  return rows;
}
function porTipo(rows: DdRow[]) {
  const map = new Map<string, { key: string; count: number; sum: number }>();
  const add = (k: string, v: number) => {
    const x = map.get(k) ?? { key: k, count: 0, sum: 0 };
    x.count++;
    x.sum += v;
    map.set(k, x);
  };
  for (const r of rows) {
    const acl = r.valor_acl_efetivo as number;
    const resto = (r.valor_efetivo as number) - acl;
    if (acl > 0) add("ACL", acl);
    if (acl === 0 || resto > 0.009) add(r.categoria === "ACL" ? (r.tipo_id as string) || "BASE" : (r.categoria as string), Math.max(0, resto));
  }
  return [...map.values()].sort((a, b) => b.sum - a.sum);
}
function ddFaturamento(c: Ctx): Partial<DdResult> {
  const rows = faturamentoRows(c);
  const bruto = sum(rows.map((r) => r.valor_pago as number));
  const total = sum(rows.map((r) => r.valor_efetivo as number));
  const acl = rows.filter((r) => (r.valor_acl_efetivo as number) > 0);
  const breakdown: DdBreakdown[] = [];
  if (c.sq === null)
    breakdown.push({ title: "Por squad", columns: [col("key", "Squad", "squad"), col("count", "Ciclos", "int", "right"),
      col("sum", "Faturamento", "money", "right")],
      rows: groupSum(rows, "squad_id", "valor_efetivo").sort((a, b) => b.sum - a.sum) });
  breakdown.push({ title: "Por tipo (ACL parcial divide entre as fatias)", columns: [col("key", "Tipo", "tipo"),
    col("count", "Ciclos", "int", "right"), col("sum", "Faturamento", "money", "right")], rows: porTipo(rows) });
  const stats = [
    stat("Faturamento (efetivo)", total, "money", null, true),
    stat("Bruto pago", bruto, "money"),
    stat("Descontado em M1", bruto - total, "money", `${rows.filter((r) => r.eh_m1 === 1).length} ciclo(s) com R$ 3k descontado pra comissão`),
    stat("Ciclos", rows.length, "int"),
  ];
  if (acl.length)
    stats.push(stat("Faturamento ACL", sum(acl.map((r) => r.valor_acl_efetivo as number)), "money",
      `${acl.length} ciclo(s) com parcela ACL — parciais contam só a parte ACL (coluna "ACL R$")`, false,
      { key: "categoria", value: "ACL" }));
  let monthly: DdMonthly[] = [];
  if (c.multi) {
    monthly = monthlyMeta(c, rows, "valor_efetivo");
    stats.push(stat("Média/mês", c.meses.length ? total / c.meses.length : 0, "money"));
    const t = tendencia(monthly);
    if (t) stats.push(t);
  }
  return {
    title: `Faturamento · ${subtitle(c)}`, stats,
    filters: [{ key: "categoria", label: "Categoria", type: "select", options: [{ value: "all", label: "Todas" },
      { value: "TRIAL", label: "Trial" }, { value: "BASE", label: "Base" }, { value: "BASE_RA", label: "Base RA" },
      { value: "ACL", label: "ACL" }] }],
    breakdown,
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("categoria", "Tipo", "tipo"), col("valor_pago", "Pago", "money", "right"), col("valor_efetivo", "Efetivo", "money", "right"),
      ...(acl.length ? [col("valor_acl_efetivo", "ACL R$", "money", "right")] : []), col("eh_m1", "M1?", "m1"),
      col("status_pagamento", "Status")],
    rows, total, monthly_summary: monthly, summary_field: "valor_efetivo",
  };
}

function entradasRows(c: Ctx) {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const cl of e.clients.filter((x) => between(x.entry_date, m, lastDay(m)) && cliOk(c, x, m))
      .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : byName(a.name, b.name))))
      rows.push({ id_externo: cl.external_id, nome: cl.name, squad_id: cl.squad_id, tipo_id: cl.kind, data_entrada: cl.entry_date,
        origem_label: { comercial: "Comercial", reativacao: "Reativação", troca: "Troca" }[cl.origin],
        conta_novo: countsAsNew(cl) ? 1 : 0, entrada_tipo: countsAsNew(cl) ? "Novo" : "Troca", mes: m });
  return rows;
}
function ddEntradas(c: Ctx): Partial<DdResult> {
  const rows = entradasRows(c);
  const nT = rows.filter((r) => r.tipo_id === "TRIAL").length;
  const nB = rows.length - nT;
  const nNovos = rows.filter((r) => r.conta_novo === 1).length;
  const nTrocas = rows.length - nNovos;
  return {
    title: `Entradas · ${subtitle(c)}`,
    stats: [
      stat("Total de entradas", rows.length, "int", "Todo mundo que entrou no período, inclusive trocas", true),
      stat("Contam como novos", nNovos, "int", "É este número que aparece no card Net churn (origem Comercial ou Reativação)",
        false, { key: "entrada_tipo", value: "Novo" }),
      stat("Trocas (não contam)", nTrocas, "int",
        "Origem Troca: o cliente entrou no lugar de outro, não é aquisição nova — fica fora do net churn", false,
        { key: "entrada_tipo", value: "Troca" }),
      stat("Trial", nT, "int", null, false, { key: "tipo_id", value: "TRIAL" }),
      stat("Base", nB, "int"),
    ],
    filters: [
      ...(nTrocas > 0 ? [{ key: "entrada_tipo", label: "Conta como", type: "select" as const, options: [
        { value: "all", label: "Todas as entradas" }, { value: "Novo", label: "Contam como novos" },
        { value: "Troca", label: "Trocas (não contam)" }] }] : []),
      ...(nT > 0 && nB > 0 ? [tipoFilter] : []),
    ],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("data_entrada", "Entrada", "date"), col("origem_label", "Origem"),
      col("entrada_tipo", "Conta como")],
    rows, total: null,
  };
}

function ddChurns(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const r of e.churns.filter((x) => between(x.date, m, lastDay(m)) && cliOk(c, x.client, m))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byName(a.client.name, b.client.name)))) {
      const inv = e.avgVefSince(r.client.id, addMonths(m, -3)) ?? 0;
      rows.push({ id_externo: r.client.external_id, nome: r.client.name, squad_id: r.client.squad_id, tipo_id: r.client.kind,
        data_entrada: r.client.entry_date, data_churn: r.date, motivo: r.reason ? CHURN_REASONS[r.reason].label : null,
        evitavel: r.reason ? Number(CHURN_REASONS[r.reason].avoidable) : null, inv_medio: inv, mes: m, perda_anual: inv * 12 });
    }
  const perda = sum(rows.map((r) => r.perda_anual as number));
  const evit = rows.filter((r) => r.evitavel === 1);
  const porMotivo = groupSum(rows, "motivo", "perda_anual")
    .map((g) => ({ ...g, key: g.key === null || g.key === "" || g.key === "NULL" ? "— sem motivo —" : g.key }))
    .sort((a, b) => b.count - a.count);
  return {
    title: `Churns · ${subtitle(c)}`,
    stats: [
      stat("Total de saídas", rows.length, "int", null, true),
      stat("Perda anual potencial", perda, "money", "Investimento médio (últimos 3 ciclos) × 12"),
      stat("Perda evitável", sum(evit.map((r) => r.perda_anual as number)), "money", `${evit.length} churn(s) marcados como evitáveis`),
      stat("Investimento médio", rows.length ? perda / 12 / rows.length : 0, "money", "média mensal de quem churnou"),
    ],
    breakdown: [{ title: "Por motivo de churn", columns: [col("key", "Motivo"), col("count", "Churns", "int", "right"),
      col("sum", "Perda anual", "money", "right")], rows: porMotivo }],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("motivo", "Motivo"), col("inv_medio", "Inv. médio", "money", "right"),
      col("perda_anual", "Perda anual", "money", "right"), col("data_churn", "Data churn", "date")],
    rows, total: perda, summary_field: "perda_anual",
  };
}

function ddReativacoes(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const r of e.reactivations.filter((x) => between(x.date, m, lastDay(m)) && cliOk(c, x.client, m))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byName(a.client.name, b.client.name)))) {
      const prev = e.churns.filter((x) => x.client.id === r.client.id && x.date < r.date).map((x) => x.date).sort();
      rows.push({ id_externo: r.client.external_id, nome: r.client.name, squad_id: r.client.squad_id, tipo_id: r.client.kind,
        data_entrada: r.client.entry_date, data_churn: prev[prev.length - 1] ?? null, data_reativacao: r.date, mes: m });
    }
  return {
    title: `Reativações · ${subtitle(c)}`,
    stats: [stat("Total de reativações", rows.length, "int", null, true)],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("data_churn", "Churn", "date"), col("data_reativacao", "Reativação", "date")],
    rows, total: null,
  };
}

function ddPlanejado(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const y of cyc(c, m).sort((a, b) => b.probable - a.probable || byName(e.clientOf(a.client).name, e.clientOf(b.client).name))) {
      const cl = e.clientOf(y.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(y), tipo_id: cl.kind,
        melhor: y.best, provavel: y.probable, probabilidade: y.probability, status_pagamento: y.status, valor_pago: y.paid });
    }
  const total = sum(rows.map((r) => r.provavel as number));
  const pago = sum(rows.map((r) => r.valor_pago as number));
  const nPagos = rows.filter((r) => (r.valor_pago as number) > 0).length;
  return {
    title: `Total Planejado · ${subtitle(c)}`,
    stats: [
      stat("Total Provável", total, "money", null, true),
      stat("Total Melhor (cap)", sum(rows.map((r) => r.melhor as number)), "money"),
      stat("Já pago", pago, "money", `${nPagos} ciclo(s) com valor pago`),
      stat("Pendente", Math.max(0, total - pago), "money", `${rows.length - nPagos} ciclo(s) sem pagamento ainda`),
      stat("Ciclos", rows.length, "int"),
    ],
    breakdown: [{ title: "Por probabilidade", columns: [col("key", "Probabilidade"), col("count", "Ciclos", "int", "right"),
      col("sum", "Provável", "money", "right")], rows: groupSum(rows, "probabilidade", "provavel").sort((a, b) => b.sum - a.sum) }],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("melhor", "Melhor", "money", "right"), col("provavel", "Provável", "money", "right"),
      col("probabilidade", "Prob"), col("valor_pago", "Pago", "money", "right"), col("status_pagamento", "Status")],
    rows, total, summary_field: "provavel",
  };
}

function ddPendentes(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses) {
    const ys = cyc(c, m).filter((y) => (y.status === "PENDENTE" || y.status === "PARCIAL") &&
      (y.probable - y.paid > 0 || y.best - y.paid > 0));
    ys.sort((a, b) => Math.max(0, b.probable - b.paid) - Math.max(0, a.probable - a.paid) ||
      byName(e.clientOf(a.client).name, e.clientOf(b.client).name));
    for (const y of ys) {
      const cl = e.clientOf(y.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(y), tipo_id: cl.kind,
        melhor: y.best, provavel: y.probable, valor_pago: y.paid, resto_provavel: Math.max(0, y.probable - y.paid),
        resto_melhor: Math.max(0, y.best - y.paid), probabilidade: y.probability, data_cobranca: y.billing_date,
        status_pagamento: y.status });
    }
  }
  const by = (p: string) => sum(rows.filter((r) => r.probabilidade === p).map((r) => r.resto_provavel as number));
  const parciais = rows.filter((r) => r.status_pagamento === "PARCIAL").length;
  return {
    title: `Em aberto (pendentes + parciais) · ${subtitle(c)}`,
    stats: [
      stat("Cenário Pessimista", by("ALTA") + 0.5 * by("PROVAVEL"), "money", "50% do Provável (rule-of-thumb)"),
      stat("Cenário Provável", by("ALTA") + by("PROVAVEL") + 0.3 * by("BAIXA"), "money",
        "Alta + Provável + 30% do Baixa — sobre o resto a receber", true),
      stat("Cenário Melhor", sum(rows.map((r) => r.resto_melhor as number)), "money", "Soma do Melhor − já pago de todos em aberto"),
      stat("Ciclos em aberto", rows.length, "int", parciais > 0 ? `${parciais} parcial(is) ainda pagando — só o resto conta` : null),
    ],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("melhor", "Melhor", "money", "right"), col("provavel", "Provável", "money", "right"),
      col("valor_pago", "Já pago", "money", "right"), col("resto_provavel", "A receber", "money", "right"),
      col("probabilidade", "Prob"), col("data_cobranca", "Cobrança", "date"), col("status_pagamento", "Status")],
    rows, total: sum(rows.map((r) => r.resto_provavel as number)), summary_field: "provavel",
  };
}

function ddTicketMedio(c: Ctx): Partial<DdResult> {
  const base = ddPagantes(c);
  const rows = (base.rows ?? []).filter((r) => (r.status_pagamento === "PAGO" || r.status_pagamento === "PARCIAL") &&
    (r.valor_efetivo as number) > 0);
  const total = sum(rows.map((r) => r.valor_efetivo as number));
  const n = rows.length;
  const bins = [["< R$ 1k", 0, 1000], ["R$ 1k–3k", 1000, 3000], ["R$ 3k–5k", 3000, 5000], ["R$ 5k–10k", 5000, 10000],
    ["R$ 10k–20k", 10000, 20000], ["≥ R$ 20k", 20000, 1e12]] as const;
  const binRows = bins.map(([label, min, max]) => ({ key: label, count: rows.filter((r) => (r.valor_efetivo as number) >= min &&
    (r.valor_efetivo as number) < max).length })).filter((b) => b.count > 0);
  const porSq = groupSum(rows, "squad_id", "valor_efetivo").map((g) => ({ ...g, ticket: g.count ? g.sum / g.count : 0 }))
    .sort((a, b) => b.ticket - a.ticket);
  const vals = rows.map((r) => r.valor_efetivo as number);
  return {
    ...base,
    title: `Ticket Médio · ${subtitle(c)}`,
    rows, filters: [], total,
    stats: [
      stat("Ticket médio (ARPU)", n ? total / n : 0, "money",
        `R$ ${numberFormat(total, 2)} ÷ ${n} pagantes efetivos (pendentes e M1 ≤ 3k fora)`, true),
      stat("Faturamento", total, "money"),
      stat("Pagantes efetivos", n, "int", "Status pago/parcial com valor efetivo > 0"),
      stat("Maior", n ? Math.max(...vals) : 0, "money"),
      stat("Menor", n ? Math.min(...vals) : 0, "money"),
    ],
    breakdown: [
      { title: "Ticket médio por squad", columns: [col("key", "Squad", "squad"), col("count", "Pagantes", "int", "right"),
        col("sum", "Faturamento", "money", "right"), col("ticket", "Ticket médio", "money", "right")], rows: porSq },
      { title: "Distribuição por faixa de ticket", columns: [col("key", "Faixa"), col("count", "Pagantes", "int", "right")],
        rows: binRows },
    ],
  };
}

function ddFatTrial(c: Ctx): Partial<DdResult> {
  const r = ddFaturamento({ ...c, dim: "tudo" });
  const rows = r.rows ?? [];
  const fase = (x: DdRow) => (x.valor_efetivo as number) - ((x.valor_acl_efetivo as number) ?? 0);
  const trial = sum(rows.filter((x) => x.categoria === "TRIAL").map(fase));
  const base = sum(rows.filter((x) => x.categoria !== "TRIAL" && x.categoria !== "ACL").map(fase));
  const acl = sum(rows.map((x) => (x.valor_acl_efetivo as number) ?? 0));
  const tot = trial + base + acl;
  const nT = rows.filter((x) => x.categoria === "TRIAL").length;
  const nA = rows.filter((x) => ((x.valor_acl_efetivo as number) ?? 0) > 0).length;
  const nB = rows.filter((x) => x.categoria !== "TRIAL" && x.categoria !== "ACL").length;
  return {
    ...r,
    title: `% Faturamento Trial · ${subtitle({ ...c, dim: "tudo" })}`,
    stats: [
      stat("% Trial", tot > 0 ? (trial / tot) * 100 : 0, "pct", "Trial ÷ (Trial + Base + ACL)", true),
      stat("Faturamento Trial", trial, "money", `${nT} ciclo(s) Trial`),
      stat("Faturamento Base", base, "money", `${nB} ciclo(s) Base`),
      ...(nA > 0 ? [stat("Faturamento ACL", acl, "money", `${nA} ciclo(s) com parcela ACL`)] : []),
      stat("Total", tot, "money"),
    ],
    breakdown: [{ title: "Trial vs Base vs ACL (ACL parcial divide entre as fatias)", columns: [col("key", "Tipo", "tipo"),
      col("count", "Ciclos", "int", "right"), col("sum", "Faturamento", "money", "right")],
      rows: [{ key: "TRIAL", count: nT, sum: trial }, { key: "BASE", count: nB, sum: base }, { key: "ACL", count: nA, sum: acl }]
        .filter((g) => g.count > 0 || g.sum > 0).sort((a, b) => b.sum - a.sum) }],
  };
}

function ddFatAcl(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const y of cyc(c, m).filter((x) => x.acl).sort((a, b) => e.aclEf(b) - e.aclEf(a) ||
      byName(e.clientOf(a.client).name, e.clientOf(b.client).name))) {
      const cl = e.clientOf(y.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(y), tipo_id: cl.kind,
        provavel: y.probable, valor_pago: y.paid, valor_efetivo: e.vef(y), valor_acl: y.acl_value,
        valor_acl_efetivo: e.aclEf(y), acl_integral: y.acl_value === null ? 1 : 0, eh_m1: e.isM1(y) ? 1 : 0,
        status_pagamento: y.status });
    }
  const m1 = rows.filter((r) => r.eh_m1 === 1).length;
  const parciais = rows.filter((r) => r.acl_integral === 0).length;
  const total = sum(rows.map((r) => r.valor_acl_efetivo as number));
  return {
    title: `Faturamento ACL · ${subtitle(c)}`,
    stats: [
      stat("Recebido ACL (parcela efetiva)", total, "money",
        "Só a PARTE ACL de cada ciclo (parcial conta o valor da coluna ACL; x = ciclo inteiro). Regra M1 aplica se o cliente for M1 de trial.", true),
      stat("Bruto pago (ciclos c/ ACL)", sum(rows.map((r) => r.valor_pago as number)), "money",
        m1 > 0 ? `${m1} ciclo(s) M1 com R$ 3k descontado` : "Total pago dos ciclos marcados — inclui a parte não-ACL dos parciais"),
      stat("Provável (ciclos c/ ACL)", sum(rows.map((r) => r.provavel as number)), "money"),
      stat("Ciclos", rows.length, "int", parciais > 0 ? `${parciais} parcial(is) — resto do valor fica na categoria normal` : null),
      stat("Clientes", new Set(rows.map((r) => r.id_externo)).size, "int"),
    ],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo atual", "tipo"), col("provavel", "Provável", "money", "right"), col("valor_pago", "Pago", "money", "right"),
      col("valor_efetivo", "Efetivo", "money", "right"), col("valor_acl_efetivo", "ACL R$", "money", "right"),
      col("eh_m1", "M1?", "m1"), col("status_pagamento", "Status")],
    rows, total, summary_field: "valor_acl_efetivo",
  };
}

function ddMensalidades(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses) {
    const ys = cyc(c, m).filter((y) => (y.fee_paid ?? 0) > 0 || (y.fee_planned ?? 0) > 0).map((y) => {
      const prev = y.fee_planned ?? 0, rec = y.fee_paid ?? 0;
      return { y, prev, rec, ar: Math.max(0, prev - rec) };
    });
    ys.sort((a, b) => b.ar - a.ar || b.rec - a.rec || byName(e.clientOf(a.y.client).name, e.clientOf(b.y.client).name));
    for (const r of ys) {
      const cl = e.clientOf(r.y.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(r.y), tipo_id: cl.kind,
        prevista: r.prev, recebida: r.rec, a_receber: r.ar, investimento_ciclo: r.y.paid,
        situacao: r.rec <= 0.009 ? "PENDENTE" : r.prev > 0 && r.rec < r.prev ? "PARCIAL" : "RECEBIDA" });
    }
  }
  const recebido = sum(rows.map((r) => r.recebida as number));
  return {
    title: `Mensalidades (à parte da meta) · ${subtitle(c)}`,
    stats: [
      stat("A receber", sum(rows.map((r) => r.a_receber as number)), "money",
        `Previsto − recebido, por cliente · ${rows.filter((r) => r.situacao !== "RECEBIDA").length} pendente(s)`, true,
        { key: "situacao", value: "PENDENTE" }),
      stat("Recebido", recebido, "money", `${rows.filter((r) => (r.recebida as number) > 0).length} cliente(s) já pagaram`, false,
        { key: "situacao", value: "RECEBIDA" }),
      stat("Previsto total", sum(rows.map((r) => r.prevista as number)), "money",
        "Valor combinado do mês — registrado POR MÊS (renegociação não altera meses antigos)"),
      stat("⚠️ Fora da meta", "Mensalidade NÃO soma no faturamento da meta"),
    ],
    filters: [{ key: "situacao", label: "Situação", type: "select", options: [{ value: "all", label: "Todas" },
      { value: "PENDENTE", label: "Pendente" }, { value: "PARCIAL", label: "Parcial" }, { value: "RECEBIDA", label: "Recebida" }] }],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("prevista", "Prevista", "money", "right"), col("recebida", "Recebida", "money", "right"),
      col("a_receber", "A receber", "money", "right"), col("situacao", "Situação"),
      col("investimento_ciclo", "Investimento do ciclo", "money", "right")],
    rows, total: recebido, summary_field: "recebida",
  };
}

function ddProvavelRecebido(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses) {
    const ys = cyc(c, m).map((y) => ({ y, prov: e.provEf(y), rec: e.vef(y) })).filter((r) => r.prov > 0 || r.rec > 0);
    ys.sort((a, b) => (a.rec - a.prov) - (b.rec - b.prov) || byName(e.clientOf(a.y.client).name, e.clientOf(b.y.client).name));
    for (const r of ys) {
      const cl = e.clientOf(r.y.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(r.y), tipo_id: cl.kind,
        provavel: r.prov, recebido: r.rec, diff: r.rec - r.prov, status_pagamento: r.y.status });
    }
  }
  let saldo = 0, menos = 0, mais = 0, pend = 0, nm = 0, nM = 0, np = 0;
  for (const r of rows) {
    const d = r.diff as number;
    if (r.status_pagamento === "PENDENTE" && r.recebido === 0) { pend += r.provavel as number; np++; }
    else {
      saldo += d;
      if (d < 0) { menos += d; nm++; }
      else if (d > 0) { mais += d; nM++; }
    }
  }
  return {
    title: `Provável vs Recebido · ${subtitle(c)}`,
    stats: [
      stat("Saldo (só resolvidos)", saldo, "money",
        "Recebido − provável APENAS de ciclos pagos/parciais/perda. Pendentes ficam fora (ainda podem pagar). Valores efetivos: M1 de trial tem R$ 3k descontados dos dois lados.", true),
      stat("Provável total (efetivo)", sum(rows.map((r) => r.provavel as number)), "money"),
      stat("Recebido total (efetivo)", sum(rows.map((r) => r.recebido as number)), "money"),
      stat("Recebendo a menos", menos, "money", `${nm} ciclo(s) pagos abaixo do provável`, false, { key: "status_pagamento", value: "PAGO" }),
      stat("Recebendo a mais", mais, "money", `${nM} ciclo(s) pagos acima do provável`),
      stat("Pendente (pode entrar)", pend, "money", `${np} ciclo(s) ainda sem pagamento — fora do saldo`, false,
        { key: "status_pagamento", value: "PENDENTE" }),
    ],
    filters: [{ key: "status_pagamento", label: "Status", type: "select", options: [{ value: "all", label: "Todos" },
      ...["PAGO", "PARCIAL", "PENDENTE", "PERDA", "ISENTO"].map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }))] }],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("provavel", "Provável", "money", "right"), col("recebido", "Recebido", "money", "right"),
      col("diff", "Diferença", "money", "right"), col("status_pagamento", "Status")],
    rows, total: saldo, summary_field: "diff",
  };
}

function hsRows(c: Ctx, faixa?: string) {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const h of e.hsOfMonth(m).filter((x) => (!faixa || x.band === faixa) && cliOk(c, e.clientOf(x.client), m))) {
      const cl = e.clientOf(h.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: cl.squad_id, tipo_id: cl.kind,
        score_pct: h.score, faixa: h.band, c_aprovacao_criat: Number(h.creatives), c_reuniao_align: Number(h.meeting),
        c_pagamento_dia: Number(h.payment), c_percepcao_valor: Number(h.perception), c_meta_batida: Number(h.goal),
        n_falharam: 5 - [h.creatives, h.meeting, h.payment, h.perception, h.goal].filter(Boolean).length });
    }
  return rows;
}
function ddHsFaixa(c: Ctx): Partial<DdResult> {
  const faixa = (c.p.faixa ?? "").toUpperCase();
  if (!["SATISFEITO", "ALERTA", "CRITICO"].includes(faixa)) throw new Error(`Faixa inválida: ${faixa}`);
  const rows = hsRows(c, faixa).sort((a, b) => (b.score_pct as number) - (a.score_pct as number) || byName(a.nome as string, b.nome as string));
  const sc = rows.map((r) => r.score_pct as number);
  const label = { SATISFEITO: "Satisfeitos", ALERTA: "Alerta", CRITICO: "Crítico" }[faixa]!;
  const porSq = groupSum(rows, "squad_id", "score_pct").map((g) => ({ ...g, avg: g.count ? g.sum / g.count : 0 }));
  return {
    title: `HS ${label} · ${subtitle(c)}`,
    stats: [
      stat(`Clientes na faixa ${label}`, rows.length, "int", null, true),
      stat("Score médio", sc.length ? sum(sc) / sc.length : 0, "pct", "Média de score% dos clientes nessa faixa"),
      stat("Maior score", sc.length ? Math.max(...sc) : 0, "pct"),
      stat("Menor score", sc.length ? Math.min(...sc) : 0, "pct"),
    ],
    breakdown: c.sq === null ? [{ title: "Por squad", columns: [col("key", "Squad", "squad"), col("count", "Clientes", "int", "right"),
      col("avg", "Score médio", "pct", "right")], rows: porSq }] : [],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("score_pct", "Score", "pct", "right"), col("faixa", "Faixa")],
    rows, total: null,
  };
}
function ddHsGeral(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows = hsRows(c).sort((a, b) => (a.score_pct as number) - (b.score_pct as number) || byName(a.nome as string, b.nome as string));
  const w = e.rules(c.meses[c.meses.length - 1]).hs_weights;
  const crits = [["c_aprovacao_criat", "Aprovação Criativos", w.creatives], ["c_reuniao_align", "Reunião Alinhamento", w.meeting],
    ["c_pagamento_dia", "Pagamento em dia", w.payment], ["c_percepcao_valor", "Percepção de Valor", w.perception],
    ["c_meta_batida", "Meta Batida", w.goal]] as const;
  const critRows = crits.map(([k, l, p]) => ({ criterio: `${l} (${p}%)`, falharam: rows.filter((r) => !r[k]).length, peso: p }))
    .sort((a, b) => b.falharam - a.falharam);
  const porSq = groupSum(rows, "squad_id", "score_pct").map((g) => ({ ...g, avg: g.count ? g.sum / g.count : 0 }));
  const n = (f: string) => rows.filter((r) => r.faixa === f).length;
  return {
    title: `Health Score · ${subtitle(c)}`,
    stats: [
      stat("Total clientes com HS", rows.length, "int", null, true),
      stat("🟢 Satisfeito", n("SATISFEITO"), "int", "≥ 80%", false, { key: "faixa", value: "SATISFEITO" }),
      stat("🟡 Alerta", n("ALERTA"), "int", "50–79%", false, { key: "faixa", value: "ALERTA" }),
      stat("🔴 Crítico", n("CRITICO"), "int", "< 50%", false, { key: "faixa", value: "CRITICO" }),
      stat("Score médio", rows.length ? sum(rows.map((r) => r.score_pct as number)) / rows.length : 0, "pct"),
    ],
    breakdown: [
      ...(c.sq === null && porSq.length > 1 ? [{ title: "Score médio por squad", columns: [col("key", "Squad", "squad"),
        col("count", "Clientes", "int", "right"), col("avg", "Score médio", "pct", "right")], rows: porSq }] : []),
      { title: "Top critérios falhando (ofensores)", columns: [col("criterio", "Critério"), col("falharam", "Falharam", "int", "right")],
        rows: critRows },
    ],
    filters: [
      { key: "faixa", label: "Faixa HS", type: "select", options: [{ value: "all", label: "Todas as faixas" },
        { value: "SATISFEITO", label: "🟢 Satisfeito (≥80%)" }, { value: "ALERTA", label: "🟡 Alerta (50–79%)" },
        { value: "CRITICO", label: "🔴 Crítico (<50%)" }] },
      ...(c.sq === null ? [{ key: "squad_id", label: "Squad", type: "select" as const, options: squadOptions(e) }] : []),
      tipoFilter,
    ],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("score_pct", "Score", "pct", "right"), col("faixa", "Faixa", "hs_faixa"),
      col("c_aprovacao_criat", "Aprov", "check", "center"), col("c_reuniao_align", "Reunião", "check", "center"),
      col("c_pagamento_dia", "Pgto", "check", "center"), col("c_percepcao_valor", "Percep", "check", "center"),
      col("c_meta_batida", "Meta", "check", "center")],
    rows, total: null,
  };
}

const ADIMP_ORDER = { PERDA: 0, INADIMPLENTE: 1, ADIMPLENTE: 2 } as Record<string, number>;
function ddAdimplenciaGeral(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const y of cyc(c, m).sort((a, b) => ADIMP_ORDER[a.adimplencia] - ADIMP_ORDER[b.adimplencia] || b.probable - a.probable)) {
      const cl = e.clientOf(y.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(y), tipo_id: cl.kind,
        valor_pago: y.paid, provavel: y.probable, adimplencia: y.adimplencia, status_pagamento: y.status,
        data_cobranca: y.billing_date, data_pagamento: y.paid_date });
    }
  const n = (a: string) => rows.filter((r) => r.adimplencia === a).length;
  const saldo = (a: string) => sum(rows.filter((r) => r.adimplencia === a).map((r) => Math.max(0, (r.provavel as number) - (r.valor_pago as number))));
  const porStatus = groupSum(rows, "adimplencia", "valor_pago");
  const porSq = groupSum(rows, "squad_id", "valor_pago");
  const pago = sum(rows.map((r) => r.valor_pago as number));
  return {
    title: `Mix de Adimplência · ${subtitle(c)}`,
    stats: [
      stat("Total ciclos", rows.length, "int", null, true),
      stat("🟢 ADIMPLENTE", n("ADIMPLENTE"), "int", "Pagou em dia", false, { key: "adimplencia", value: "ADIMPLENTE" }),
      stat("🟡 INADIMPLENTE", n("INADIMPLENTE"), "int", "Atrasou mas pode pagar", false, { key: "adimplencia", value: "INADIMPLENTE" }),
      stat("🔴 PERDA", n("PERDA"), "int", "Não vai pagar", false, { key: "adimplencia", value: "PERDA" }),
      stat("Já recebido", pago, "money"),
      stat("Em risco (inadim)", saldo("INADIMPLENTE"), "money", "Saldo a receber dos inadimplentes"),
      stat("Perdido", saldo("PERDA"), "money", "Saldo dos clientes em PERDA"),
    ],
    breakdown: [
      ...(porStatus.length > 1 ? [{ title: "Por status", columns: [col("key", "Status", "adimp"), col("count", "Ciclos", "int", "right"),
        col("sum", "Pago", "money", "right")], rows: porStatus }] : []),
      ...(c.sq === null && porSq.length > 1 ? [{ title: "Por squad", columns: [col("key", "Squad", "squad"),
        col("count", "Ciclos", "int", "right"), col("sum", "Pago", "money", "right")], rows: porSq }] : []),
    ],
    filters: [
      { key: "adimplencia", label: "Adimplência", type: "select", options: [{ value: "all", label: "Todos" },
        { value: "ADIMPLENTE", label: "🟢 ADIMPLENTE" }, { value: "INADIMPLENTE", label: "🟡 INADIMPLENTE" },
        { value: "PERDA", label: "🔴 PERDA" }] },
      ...(c.sq === null ? [{ key: "squad_id", label: "Squad", type: "select" as const, options: squadOptions(e) }] : []),
      tipoFilter,
    ],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("provavel", "Provável", "money", "right"), col("valor_pago", "Pago", "money", "right"),
      col("adimplencia", "Adimplência", "adimp"), col("status_pagamento", "Status pgto"), col("data_cobranca", "Cobrança", "date"),
      col("data_pagamento", "Pago em", "date")],
    rows, total: pago, summary_field: "valor_pago",
  };
}

function ddHsPendentes(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const cl of e.clients.filter((x) => e.activeIn(x, m) && !e.hsAtMonth(x.id, m) && cliOk(c, x, m))
      .sort((a, b) => byName(a.name, b.name)))
      rows.push({ id_externo: cl.external_id, nome: cl.name, squad_id: cl.squad_id, tipo_id: cl.kind, mes: m });
  return {
    title: `HS pendentes · ${subtitle(c)}`,
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo")],
    rows, total: null,
  };
}

function ddInadimplentes(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const y of cyc(c, m).filter((x) => x.adimplencia !== "ADIMPLENTE")
      .sort((a, b) => b.probable - a.probable || byName(e.clientOf(a.client).name, e.clientOf(b.client).name))) {
      const cl = e.clientOf(y.client);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(y), tipo_id: cl.kind,
        valor_pago: y.paid, provavel: y.probable, adimplencia: y.adimplencia, status_pagamento: y.status,
        data_cobranca: y.billing_date });
    }
  const prov = sum(rows.map((r) => r.provavel as number));
  const pago = sum(rows.map((r) => r.valor_pago as number));
  const nI = rows.filter((r) => r.adimplencia === "INADIMPLENTE").length;
  const nP = rows.length - nI;
  return {
    title: `Inadimplentes · ${subtitle(c)}`,
    stats: [
      stat("Ciclos em risco", rows.length, "int", null, true),
      stat("INADIMPLENTE", nI, "int", "Atrasou pagamento mas ainda pode pagar", false, { key: "adimplencia", value: "INADIMPLENTE" }),
      stat("PERDA", nP, "int", "Já não vai mais pagar", false, { key: "adimplencia", value: "PERDA" }),
      stat("Valor planejado", prov, "money"),
      stat("Já recebido (parcial)", pago, "money"),
      stat("Saldo a perder", Math.max(0, prov - pago), "money"),
    ],
    filters: nI + nP > 1 ? [{ key: "adimplencia", label: "Status", type: "select", options: [{ value: "all", label: "Todos" },
      { value: "INADIMPLENTE", label: "INADIMPLENTE" }, { value: "PERDA", label: "PERDA" }] }] : [],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("provavel", "Provável", "money", "right"), col("valor_pago", "Pago", "money", "right"),
      col("adimplencia", "Adimplência"), col("data_cobranca", "Cobrança", "date")],
    rows, total: Math.max(0, prov - pago), summary_field: "provavel",
  };
}

/** Taxas de realização de VALOR por faixa de HS (R$ pago ÷ R$ provável). */
function hsPaymentRates(e: CsEngine, mes: string, windowMonths: number, minAmostras: number) {
  const defaults = { SATISFEITO: 0.95, ALERTA: 0.75, CRITICO: 0.5 } as Record<string, number>;
  const CAP = 1.2;
  const from = addMonths(mes, -windowMonths);
  const acc: Record<string, { n: number; prov: number; pago: number }> = {
    SATISFEITO: { n: 0, prov: 0, pago: 0 }, ALERTA: { n: 0, prov: 0, pago: 0 }, CRITICO: { n: 0, prov: 0, pago: 0 } };
  for (const y of e.cycles)
    if (y.month >= from && y.month < mes && y.probable > 0) {
      const h = e.hsAtMonth(y.client, y.month);
      if (!h) continue;
      acc[h.band].n++;
      acc[h.band].prov += y.probable;
      acc[h.band].pago += y.paid;
    }
  const out: Record<string, { prob: number; n_total: number; sum_prov: number; sum_pago: number; source: string }> = {};
  let tp = 0, tg = 0, tn = 0;
  for (const k of ["SATISFEITO", "ALERTA", "CRITICO"]) {
    const a = acc[k];
    tp += a.prov; tg += a.pago; tn += a.n;
    out[k] = a.n >= minAmostras && a.prov > 0
      ? { prob: Math.min(CAP, a.pago / a.prov), n_total: a.n, sum_prov: a.prov, sum_pago: a.pago, source: "historic" }
      : { prob: defaults[k], n_total: a.n, sum_prov: a.prov, sum_pago: a.pago, source: "default" };
  }
  return {
    rates: out,
    global: tn >= minAmostras && tp > 0 ? Math.min(CAP, tg / tp) : 0.75,
    janela_ini: addMonths(mes, -windowMonths), janela_fim: addMonths(mes, -1),
  };
}

function ddMeta(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const meta = sum(c.meses.map((m) => e.goal(c.sq, m)));
  const ORDER = { PENDENTE: 0, PARCIAL: 1, PAGO: 2, PERDA: 3, ISENTO: 4 } as Record<string, number>;
  const rows: DdRow[] = [];
  for (const m of c.meses)
    for (const y of cyc(c, m).sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.probable - a.probable)) {
      const cl = e.clientOf(y.client);
      const h = e.hsLatest(cl.id, y.month);
      rows.push({ mes: m, id_externo: cl.external_id, nome: cl.name, squad_id: e.cycleSquad(y), tipo_id: cl.kind,
        melhor: y.best, provavel: y.probable, valor_pago: y.paid, valor_efetivo: e.vef(y), probabilidade: y.probability,
        status_pagamento: y.status, data_cobranca: y.billing_date, data_pagamento: y.paid_date,
        faltam: Math.max(0, y.probable - y.paid), hs_faixa: h?.band ?? "SEM_HS", hs_score: h?.score ?? null });
    }
  const realizado = sum(rows.map((r) => r.valor_efetivo as number));
  const faltam = Math.max(0, meta - realizado);
  const abertos = rows.filter((r) => (r.status_pagamento === "PENDENTE" || r.status_pagamento === "PARCIAL") &&
    ((r.faltam as number) > 0.009 || Math.max(0, (r.melhor as number) - (r.valor_pago as number)) > 0.009));
  const nParc = abertos.filter((r) => r.status_pagamento === "PARCIAL").length;
  const perdidos = rows.filter((r) => r.status_pagamento === "PERDA");
  const pendProv = sum(abertos.map((r) => r.faltam as number));
  const pendMelhor = sum(abertos.map((r) => Math.max(0, (r.melhor as number) - (r.valor_pago as number))));
  const rates = hsPaymentRates(e, c.meses[0], 3, 3);
  const porHs: Record<string, { n: number; sum: number }> = { SATISFEITO: { n: 0, sum: 0 }, ALERTA: { n: 0, sum: 0 },
    CRITICO: { n: 0, sum: 0 }, SEM_HS: { n: 0, sum: 0 } };
  let add = 0, nSem = 0, valSem = 0;
  for (const p of abertos) {
    const fx = p.hs_faixa as string;
    const v = p.faltam as number;
    const w = fx === "SEM_HS" ? rates.global : rates.rates[fx]?.prob ?? 0.5;
    if (fx === "SEM_HS") { nSem++; valSem += v; }
    add += v * w;
    porHs[fx].n++;
    porHs[fx].sum += v;
  }
  const cenHs = realizado + add;
  const pct = (v: number) => (meta > 0 ? (v / meta) * 100 : 0);
  const hsRowsOut = ["SATISFEITO", "ALERTA", "CRITICO", "SEM_HS"].filter((k) => porHs[k].n > 0).map((k) => {
    if (k === "SEM_HS")
      return { key: k, count: porHs[k].n, sum: porHs[k].sum, peso: `${phpRound(rates.global * 100, 1)}% (média global)`,
        esperado: porHs[k].sum * rates.global, amostras: "sem HS — usa média de todas as faixas" };
    const r = rates.rates[k];
    return { key: k, count: porHs[k].n, sum: porHs[k].sum, peso: `${phpRound(r.prob * 100, 1)}%`, esperado: porHs[k].sum * r.prob,
      amostras: `R$ ${numberFormat(r.sum_pago, 0)} pagos / R$ ${numberFormat(r.sum_prov, 0)} prováveis (${r.source === "historic" ? "hist" : "default"})` };
  });
  const hint = `Sat ${f0(rates.rates.SATISFEITO.prob * 100)}% · Alt ${f0(rates.rates.ALERTA.prob * 100)}% · Crit ${f0(rates.rates.CRITICO.prob * 100)}% · sem-HS ${f0(rates.global * 100)}% — R$ pago ÷ R$ provável de ${labelMes(rates.janela_ini)} → ${labelMes(rates.janela_fim)}`;
  const porProb = groupSum(abertos, "probabilidade", "faltam").sort((a, b) => b.sum - a.sum);
  const porSq = c.sq === null ? groupSum(rows, "squad_id", "valor_efetivo") : [];
  let monthly: DdMonthly[] = [];
  const extra: DdStat[] = [];
  if (c.multi) {
    monthly = monthlyMeta(c, rows, "valor_efetivo");
    extra.push(stat("Média/mês (realizado)", c.meses.length ? realizado / c.meses.length : 0, "money"));
    const t = tendencia(monthly);
    if (t) extra.push(t);
    const com = monthly.filter((m) => m.atingimento !== null).sort((a, b) => b.atingimento! - a.atingimento!);
    if (com.length >= 2) {
      const best = com[0], worst = com[com.length - 1];
      extra.push(stat("Melhor mês", `${best.label} — ${f1(best.atingimento!)}%`, "string", `${fmtMoney(best.total)} de ${fmtMoney(best.meta!)}`));
      extra.push(stat("Pior mês", `${worst.label} — ${f1(worst.atingimento!)}%`, "string", `${fmtMoney(worst.total)} de ${fmtMoney(worst.meta!)}`));
    }
  }
  return {
    title: `Meta vs Realizado · ${subtitle(c)}`,
    monthly_summary: monthly,
    simulador: { meta, realizado },
    stats: [
      stat("Meta", meta, "money"),
      stat("Realizado", realizado, "money", `${f1(meta > 0 ? (realizado / meta) * 100 : 0)}% atingido`, true),
      ...extra,
      stat("Faltam pra meta", faltam, "money", faltam > 0 ? "Gap a fechar" : "Meta batida ✓"),
      stat("Em aberto — Provável (R$)", pendProv, "money",
        `${abertos.length} ciclo(s): ${abertos.length - nParc} pendente(s) + ${nParc} parcial(is) com resto a receber (provável − pago)`,
        false, { key: "status_pagamento", value: "PENDENTE" }),
      stat("Em aberto — Melhor (R$)", pendMelhor, "money", "Cap otimista do que ainda pode entrar (inclui resto dos parciais)"),
      stat("Forecast HS-ponderado", cenHs, "money",
        `${f1(pct(cenHs))}% da meta · ${hint}. Taxa de realização de valor por faixa de HS, últimos 3 meses.`, true),
      stat("Sem HS (na taxa média)", valSem, "money", nSem > 0
        ? `${nSem} pendente(s) sem HS — entram pela taxa média global (${f0(rates.global * 100)}%). Preencher o HS refina a previsão.`
        : "Todos pendentes têm HS preenchido ✓"),
      stat("Cenário Provável (cru)", realizado + pendProv, "money", `${f1(pct(realizado + pendProv))}% da meta — sem ponderar HS`),
      stat("Cenário Melhor", realizado + pendMelhor, "money", `${f1(pct(realizado + pendMelhor))}% da meta — se vier todo Melhor`),
      stat("Já perdido (PERDA)", sum(perdidos.map((r) => r.provavel as number)), "money",
        `${perdidos.length} ciclo(s) PERDA — não vão pagar`, false, { key: "status_pagamento", value: "PERDA" }),
    ],
    breakdown: [
      ...(hsRowsOut.length ? [{ title: "Em aberto (pendentes + resto dos parciais) ponderados pela saúde (HS)", columns: [
        col("key", "Faixa HS", "hs_faixa"), col("count", "Ciclos", "int", "right"), col("sum", "A receber", "money", "right"),
        col("peso", "Prob. pgto", "string", "right"), col("amostras", "Base hist.", "string", "right"),
        col("esperado", "Esperado", "money", "right")], rows: hsRowsOut }] : []),
      ...(porProb.length ? [{ title: "Em aberto por probabilidade (planilha)", columns: [col("key", "Probabilidade"),
        col("count", "Ciclos", "int", "right"), col("sum", "A receber", "money", "right")], rows: porProb }] : []),
      ...(c.sq === null && porSq.length > 1 ? [{ title: "Realizado por squad", columns: [col("key", "Squad", "squad"),
        col("count", "Ciclos", "int", "right"), col("sum", "Realizado", "money", "right")], rows: porSq }] : []),
    ],
    filters: [
      { key: "status_pagamento", label: "Status", type: "select", options: [{ value: "all", label: "Todos" },
        { value: "PAGO", label: "PAGO" }, { value: "PARCIAL", label: "PARCIAL" }, { value: "PENDENTE", label: "PENDENTE (gap)" },
        { value: "PERDA", label: "PERDA" }, { value: "ISENTO", label: "ISENTO" }] },
      { key: "hs_faixa", label: "Faixa HS", type: "select", options: [{ value: "all", label: "Todas" },
        { value: "SATISFEITO", label: "🟢 Satisfeito" }, { value: "ALERTA", label: "🟡 Alerta" },
        { value: "CRITICO", label: "🔴 Crítico" }, { value: "SEM_HS", label: "— sem HS —" }] },
      { key: "probabilidade", label: "Probabilidade", type: "select", options: [{ value: "all", label: "Todas" },
        { value: "ALTA", label: "ALTA" }, { value: "PROVAVEL", label: "PROVÁVEL" }, { value: "BAIXA", label: "BAIXA" }] },
      ...(c.sq === null ? [{ key: "squad_id", label: "Squad", type: "select" as const, options: squadOptions(e) }] : []),
      tipoFilter,
    ],
    columns: [...(c.multi ? [MES_COL] : []), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("tipo_id", "Tipo", "tipo"), col("hs_faixa", "HS", "hs_faixa"), col("melhor", "Melhor", "money", "right"),
      col("provavel", "Provável", "money", "right"), col("valor_pago", "Pago", "money", "right"),
      col("faltam", "Faltam", "money", "right"), col("probabilidade", "Prob"), col("status_pagamento", "Status"),
      col("data_cobranca", "Cobrança", "date"), col("data_pagamento", "Pagamento", "date")],
    rows, total: faltam, summary_field: "valor_efetivo",
  };
}

// ------------------------------------------------------------ Bloco 4 (trial)
function trialEnriched(e: CsEngine, cl: CsDataClient) {
  const ys = e.cyclesOfClient(cl.id);
  const status = cl.churn_date !== null && (cl.reactivation_date === null || cl.reactivation_date <= cl.churn_date) ? "CHURN"
    : cl.kind === "BASE" || cl.kind === "BASE_RA" ? "GRADUOU" : "TRIAL";
  return {
    id: cl.id, id_externo: cl.external_id, nome: cl.name, squad_id: cl.squad_id, tipo_id: cl.kind, data_entrada: cl.entry_date,
    data_churn: cl.churn_date, data_reativacao: cl.reactivation_date, mes_de_trial: cl.trial_month,
    pago_m1: ys[0]?.paid ?? null, pago_m2: ys[1]?.paid ?? null, pago_m3: ys[2]?.paid ?? null,
    total_pago: sum(ys.filter((y) => y.paid > 0).map((y) => y.paid)), status_atual: status,
  };
}
const TRIAL_COLS = [col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
  col("data_entrada", "Entrada", "date"), col("pago_m1", "Pago M1", "money", "right"), col("pago_m2", "Pago M2", "money", "right"),
  col("pago_m3", "Pago M3", "money", "right"), col("total_pago", "Total trial", "money", "right"),
  col("status_atual", "Status hoje", "trial_status")];
const byEntryDesc = (a: DdRow, b: DdRow) =>
  (a.data_entrada as string) > (b.data_entrada as string) ? -1 : (a.data_entrada as string) < (b.data_entrada as string) ? 1
    : byName(a.nome as string, b.nome as string);

export function trialFunilContagem(e: CsEngine, mes: string, sq: string | null) {
  const fim = lastDay(mes);
  const ancora = fim < e.today ? fim : e.today;
  const origem = addMonths(mes, -3);
  const out = { m1: 0, m2: 0, m3: 0, m4plus: 0, graduados: 0, m1_origem: 0 };
  for (const c of e.clients) {
    if (!e.squadOk(c, sq, mes)) continue;
    if (c.kind === "TRIAL" && (c.churn_date === null || c.churn_date > fim)) {
      const n = monthsBetween(c.entry_date, ancora);
      if (n === 0) out.m1++;
      else if (n === 1) out.m2++;
      else if (n === 2) out.m3++;
      else if (n >= 3) out.m4plus++;
    }
    if ((c.kind === "BASE" || c.kind === "BASE_RA") && e.gradMonth(c) === mes) out.graduados++;
    if (between(c.entry_date, origem, lastDay(origem)) && e.passouTrial(c)) out.m1_origem++;
  }
  return out;
}

function ddTrialFunil(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const mes = c.meses[0];
  const fim = lastDay(mes);
  const ancora = fim < e.today ? fim : e.today;
  const rows: DdRow[] = [];
  const add = (fase: string, list: CsDataClient[]) => {
    for (const cl of list) rows.push({ ...trialEnriched(e, cl), fase });
  };
  const em = (n: (x: number) => boolean) => e.clients.filter((cl) => cl.kind === "TRIAL" && e.squadOk(cl, c.sq, mes) &&
    (cl.churn_date === null || cl.churn_date > fim) && n(monthsBetween(cl.entry_date, ancora)));
  add("M1", em((n) => n === 0));
  add("M2", em((n) => n === 1));
  add("M3", em((n) => n === 2));
  add("M4plus", em((n) => n >= 3));
  add("GRADUADO", e.clients.filter((cl) => (cl.kind === "BASE" || cl.kind === "BASE_RA") && e.gradMonth(cl) === mes &&
    e.squadOk(cl, c.sq, mes)));
  rows.sort((a, b) => ((a.fase as string) < (b.fase as string) ? -1 : (a.fase as string) > (b.fase as string) ? 1 : byEntryDesc(a, b)));
  const fu = trialFunilContagem(e, mes, c.sq);
  const taxa = fu.m1_origem > 0 ? phpRound((fu.graduados / fu.m1_origem) * 100, 1) : 0;
  const porStatus = groupSum(rows, "status_atual", "total_pago");
  const porSq = groupSum(rows, "squad_id", "total_pago");
  return {
    title: `Funil do Trial · ${labelMesFull(mes)}${c.sq ? ` · ${e.squadName(c.sq)}` : ""}`,
    stats: [
      stat("Em M1", fu.m1, "int", "Ainda não completaram 1 mês desde a entrada (fase vira no ANIVERSÁRIO da data de entrada, não na virada do mês)", true, { key: "fase", value: "M1" }),
      stat("Em M2", fu.m2, "int", "Entre 1 e 2 meses desde a entrada", false, { key: "fase", value: "M2" }),
      stat("Em M3", fu.m3, "int", "Entre 2 e 3 meses desde a entrada", false, { key: "fase", value: "M3" }),
      stat("M4+ (estendido)", fu.m4plus, "int", "Ainda em trial passado do prazo de 3 meses — decida graduar ou churnar", false, { key: "fase", value: "M4plus" }),
      stat("Graduados (→ Base)", fu.graduados, "int", `Graduaram em ${labelMes(mes)} (data_entrada + MesDeTrial − 1)`, false, { key: "fase", value: "GRADUADO" }),
      stat("Taxa de graduação", taxa, "pct", `${fu.graduados} graduados ÷ ${fu.m1_origem} entradas no cohort de 3m atrás`),
      stat("Total já pago no Trial", sum(rows.map((r) => r.total_pago as number)), "money"),
    ],
    breakdown: [
      { title: "Por fase do funil", columns: [col("key", "Fase", "trial_fase"), col("count", "Clientes", "int", "right"),
        col("sum", "Total pago", "money", "right")], rows: groupSum(rows, "fase", "total_pago") },
      ...(porStatus.length > 1 ? [{ title: "Por status atual", columns: [col("key", "Status hoje", "trial_status"),
        col("count", "Clientes", "int", "right"), col("sum", "Total pago", "money", "right")], rows: porStatus }] : []),
      ...(c.sq === null && porSq.length > 1 ? [{ title: "Por squad", columns: [col("key", "Squad", "squad"),
        col("count", "Clientes", "int", "right"), col("sum", "Total pago", "money", "right")], rows: porSq }] : []),
    ],
    filters: [
      { key: "fase", label: "Fase do funil", type: "select", options: [{ value: "all", label: "Todas as fases" },
        { value: "M1", label: "Em M1 (entraram no mês)" }, { value: "M2", label: "Em M2" }, { value: "M3", label: "Em M3" },
        { value: "M4plus", label: "M4+ (trial estendido)" }, { value: "GRADUADO", label: "Graduados (→ Base)" }] },
      { key: "status_atual", label: "Status hoje", type: "select", options: [{ value: "all", label: "Todos" },
        { value: "TRIAL", label: "🟡 Em trial" }, { value: "GRADUOU", label: "🟢 Graduou (Base)" }, { value: "CHURN", label: "🔴 Churn" }] },
      ...(c.sq === null ? [{ key: "squad_id", label: "Squad", type: "select" as const, options: squadOptions(e) }] : []),
    ],
    columns: [col("fase", "Fase", "trial_fase"), ...TRIAL_COLS],
    rows, total: null,
  };
}

function ddTrialChurnFase(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const mes = c.meses[0];
  const rows: DdRow[] = e.clients
    .filter((cl) => between(cl.churn_date, mes, lastDay(mes)) && e.passouTrial(cl) && e.squadOk(cl, c.sq, mes))
    .sort((a, b) => (a.churn_date! < b.churn_date! ? -1 : a.churn_date! > b.churn_date! ? 1 : byName(a.name, b.name)))
    .map((cl) => {
      const ys = e.cyclesOfClient(cl.id);
      const n = monthsBetween(cl.entry_date, cl.churn_date!);
      return {
        id: cl.id, id_externo: cl.external_id, nome: cl.name, squad_id: cl.squad_id, tipo_id: cl.kind,
        data_entrada: cl.entry_date, data_churn: cl.churn_date, dias_no_trial: dateDiff(cl.churn_date!, cl.entry_date),
        motivo: cl.churn_reason ? CHURN_REASONS[cl.churn_reason].label : "— sem motivo —",
        evitavel: cl.churn_reason ? Number(CHURN_REASONS[cl.churn_reason].avoidable) : null,
        total_pago: sum(ys.filter((y) => y.paid > 0).map((y) => y.paid)),
        pago_m1: ys[0]?.paid ?? null, pago_m2: ys[1]?.paid ?? null, pago_m3: ys[2]?.paid ?? null,
        fase: n === 0 ? "M1" : n === 1 ? "M2" : n === 2 ? "M3" : cl.kind === "TRIAL" ? "M4plus" : "PosTrial",
      };
    });
  const dist = { M1: 0, M2: 0, M3: 0, M4plus: 0, PosTrial: 0 } as Record<string, number>;
  for (const r of rows) dist[r.fase as string]++;
  const total = sum(rows.map((r) => r.total_pago as number));
  const porMotivo = groupSum(rows, "motivo", "total_pago").sort((a, b) => b.count - a.count);
  return {
    title: `Cancelamento por mês de trial · ${labelMesFull(mes)}${c.sq ? ` · ${e.squadName(c.sq)}` : ""}`,
    stats: [
      stat("Total de churns", rows.length, "int", null, true),
      stat("M1 — onboarding", dist.M1, "int", "Saiu no mesmo mês que entrou", false, { key: "fase", value: "M1" }),
      stat("M2 — performance", dist.M2, "int", "Saiu no 2º mês", false, { key: "fase", value: "M2" }),
      stat("M3 — retenção", dist.M3, "int", "Saiu no 3º mês", false, { key: "fase", value: "M3" }),
      stat("M4+ (estendido)", dist.M4plus, "int", "Saiu durante trial estendido (passou de 3 meses sem virar Base)", false, { key: "fase", value: "M4plus" }),
      stat("Pós-trial (Base)", dist.PosTrial, "int", "Já era Base quando saiu", false, { key: "fase", value: "PosTrial" }),
      stat("Já pago antes do churn", total, "money"),
      stat("Tempo médio no trial", `${Math.round(rows.length ? sum(rows.map((r) => r.dias_no_trial as number)) / rows.length : 0)} dias`),
    ],
    breakdown: [
      { title: "Por fase do trial", columns: [col("key", "Fase", "trial_fase"), col("count", "Churns", "int", "right"),
        col("sum", "Pago antes", "money", "right")], rows: groupSum(rows, "fase", "total_pago") },
      ...(porMotivo.length > 1 ? [{ title: "Por motivo", columns: [col("key", "Motivo"), col("count", "Churns", "int", "right"),
        col("sum", "Pago antes", "money", "right")], rows: porMotivo }] : []),
    ],
    filters: [
      { key: "fase", label: "Fase do trial", type: "select", options: [{ value: "all", label: "Todas as fases" },
        { value: "M1", label: "M1 — onboarding" }, { value: "M2", label: "M2 — performance" }, { value: "M3", label: "M3 — retenção" },
        { value: "M4plus", label: "M4+ (estendido)" }, { value: "PosTrial", label: "Pós-trial (Base)" }] },
      ...(porMotivo.length > 1 ? [{ key: "motivo", label: "Motivo do churn", type: "select" as const,
        options: [{ value: "all", label: "Todos os motivos" }, ...porMotivo.map((m) => ({ value: String(m.key), label: String(m.key) }))] }] : []),
      ...(c.sq === null ? [{ key: "squad_id", label: "Squad", type: "select" as const, options: squadOptions(e) }] : []),
    ],
    columns: [col("fase", "Fase", "trial_fase"), col("id_externo", "ID"), col("nome", "Cliente"), col("squad_id", "Squad", "squad"),
      col("data_entrada", "Entrada", "date"), col("data_churn", "Churn", "date"), col("dias_no_trial", "Dias", "int", "right"),
      col("pago_m1", "Pago M1", "money", "right"), col("pago_m2", "Pago M2", "money", "right"),
      col("pago_m3", "Pago M3", "money", "right"), col("total_pago", "Total pago", "money", "right"), col("motivo", "Motivo")],
    rows, total,
  };
}

function ddTrialCohort(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const mes = c.meses[0];
  const rows: DdRow[] = e.clients
    .filter((cl) => between(cl.entry_date, mes, lastDay(mes)) && e.passouTrial(cl) && e.squadOk(cl, c.sq, mes))
    .map((cl) => trialEnriched(e, cl)).sort(byEntryDesc);
  const n = (s: string) => rows.filter((r) => r.status_atual === s).length;
  const total = sum(rows.map((r) => r.total_pago as number));
  const porStatus = groupSum(rows, "status_atual", "total_pago").sort((a, b) => b.count - a.count);
  const porSq = groupSum(rows, "squad_id", "total_pago");
  const tg = rows.length ? phpRound((n("GRADUOU") / rows.length) * 100, 1) : 0;
  const tc = rows.length ? phpRound((n("CHURN") / rows.length) * 100, 1) : 0;
  return {
    title: `Cohort de entrada · ${labelMesFull(mes)}${c.sq ? ` · ${e.squadName(c.sq)}` : ""}`,
    stats: [
      stat("Entraram", rows.length, "int", null, true),
      stat("Graduaram (hoje BASE)", n("GRADUOU"), "int", `${tg}% do cohort`, false, { key: "status_atual", value: "GRADUOU" }),
      stat("Em trial ainda", n("TRIAL"), "int", null, false, { key: "status_atual", value: "TRIAL" }),
      stat("Churnaram", n("CHURN"), "int", `${tc}% do cohort`, false, { key: "status_atual", value: "CHURN" }),
      stat("Faturamento gerado", total, "money", "Soma de tudo que o cohort já pagou"),
      stat("Ticket médio", rows.length ? total / rows.length : 0, "money", "Faturamento ÷ entradas"),
    ],
    breakdown: [
      ...(porStatus.length > 1 ? [{ title: "Status atual", columns: [col("key", "Status", "trial_status"),
        col("count", "Clientes", "int", "right"), col("sum", "Faturamento", "money", "right")], rows: porStatus }] : []),
      ...(c.sq === null && porSq.length > 1 ? [{ title: "Por squad", columns: [col("key", "Squad", "squad"),
        col("count", "Clientes", "int", "right"), col("sum", "Faturamento", "money", "right")], rows: porSq }] : []),
    ],
    filters: [
      ...(porStatus.length > 1 ? [{ key: "status_atual", label: "Status hoje", type: "select" as const, options: [
        { value: "all", label: "Todos" }, { value: "TRIAL", label: "🟡 Em trial" }, { value: "GRADUOU", label: "🟢 Graduou (Base)" },
        { value: "CHURN", label: "🔴 Churn" }] }] : []),
      ...(c.sq === null && porSq.length > 1 ? [{ key: "squad_id", label: "Squad", type: "select" as const, options: squadOptions(e) }] : []),
    ],
    columns: TRIAL_COLS, rows, total,
  };
}

function ddTrialSquad(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const metrica = (c.p.metrica ?? "em_trial").toLowerCase();
  if (metrica === "entradas") return ddEntradas({ ...c, dim: "trial" });
  if (metrica === "graduados") return ddTrialFunil(c);
  if (metrica === "fat_avg") return ddPagantes({ ...c, dim: "trial" });
  if (metrica !== "em_trial") throw new Error(`Métrica inválida: ${metrica}`);
  const mes = c.meses[0];
  const fim = lastDay(mes);
  const rows: DdRow[] = e.clients
    .filter((cl) => cl.kind === "TRIAL" && cl.entry_date <= fim && (cl.churn_date === null || cl.churn_date > fim) &&
      e.squadOk(cl, c.sq, mes))
    .map((cl) => {
      const r = trialEnriched(e, cl) as DdRow;
      const em = cl.entry_date.slice(0, 7);
      r.fase = em === mes.slice(0, 7) ? "M1" : em === addMonths(mes, -1).slice(0, 7) ? "M2"
        : em === addMonths(mes, -2).slice(0, 7) ? "M3" : "M4plus";
      return r;
    })
    .sort(byEntryDesc);
  return {
    title: `Em trial agora · ${labelMesFull(mes)}${c.sq ? ` · ${e.squadName(c.sq)}` : ""}`,
    stats: [
      stat("Em trial (total)", rows.length, "int", "Todos com tipo TRIAL ativo no fim do mês", true),
      stat("M4+ (estendido)", rows.filter((r) => r.fase === "M4plus").length, "int", "Passou de 3 meses e ainda em trial — atenção",
        false, { key: "fase", value: "M4plus" }),
      stat("Total já pago", sum(rows.map((r) => r.total_pago as number)), "money"),
    ],
    filters: [{ key: "fase", label: "Fase do funil", type: "select", options: [{ value: "all", label: "Todas" },
      { value: "M1", label: "M1" }, { value: "M2", label: "M2" }, { value: "M3", label: "M3" }, { value: "M4plus", label: "M4+ (estendido)" }] }],
    columns: [col("fase", "Fase", "trial_fase"), ...TRIAL_COLS], rows, total: null,
  };
}

// ------------------------------------------------------------ Blocos 6/7/8
function fStruct(c: Ctx): CsFilter {
  return { mes_ref: c.meses[c.meses.length - 1], squad_id: c.sq, dim: c.dim, modo: c.meses.length > 1 ? "anual" : "mensal" };
}
const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#039;/g, "'");

function ddSquadsComparativo(c: Ctx): Partial<DdResult> {
  const sd = squadsData(c.e, { ...fStruct(c), squad_id: null }, c.meses.length > 1 ? c.meses : null);
  const rows = Object.entries(sd.por_squad).map(([sid, m]) => ({ squad_id: sid, ...m }));
  return {
    title: `Comparativo Squads · ${subtitle({ ...c, sq: null, dim: "tudo" })}`,
    stats: sd.insights.map((s, i) => stat(`Insight ${i + 1}`, strip(s))),
    columns: [col("nome", "Squad"), col("fat", "Faturamento", "money", "right"), col("ticket", "Ticket médio", "money", "right"),
      col("ativos_trial", "Trial", "int", "right"), col("ativos_base", "Base", "int", "right"), col("hs_medio", "HS médio", "pct", "right"),
      col("entradas", "Entradas", "int", "right"), col("saidas", "Saídas", "int", "right"), col("net_churn", "Net churn", "int", "right"),
      col("taxa_grad", "Taxa grad.", "pct", "right"), col("taxa_adimp", "Adimplência", "pct", "right")],
    rows, total: null,
  };
}

function ddRitmoMes(c: Ctx): Partial<DdResult> {
  const { e } = c;
  let meses = c.meses;
  if (meses.length === 1) meses = [addMonths(meses[0], -1), meses[0]];
  let dia = Number(c.p.dia ?? 0);
  if (!(dia >= 1 && dia <= 31)) {
    const ult = meses[meses.length - 1];
    dia = ult.slice(0, 7) === e.today.slice(0, 7) ? Number(e.today.slice(8, 10)) : 31;
  }
  let prev: number | null = null;
  let semDataTotal = 0;
  const rows = meses.map((m) => {
    const cap = Math.min(dia, daysInMonth(Number(m.slice(0, 4)), Number(m.slice(5, 7))));
    const corte = `${m.slice(0, 8)}${String(cap).padStart(2, "0")}`;
    const ys = cyc(c, m).filter((y) => y.paid > 0);
    const dentro = ys.filter((y) => y.paid_date !== null && y.paid_date <= corte);
    const semData = ys.filter((y) => y.paid_date === null).length;
    semDataTotal += semData;
    const realizado = sum(dentro.map(e.vef));
    const r: DdRow = { mes: m, corte, realizado, bruto: sum(dentro.map((y) => y.paid)), pagamentos: dentro.length,
      delta_pct: prev !== null && prev > 0 ? ((realizado - prev) / prev) * 100 : null, sem_data_pagamento: semData };
    for (const s of e.squads) r[`squad_${s.id}`] = sum(dentro.filter((y) => e.cycleSquad(y) === s.id).map(e.vef));
    prev = realizado;
    return r;
  });
  const a = rows[0], b = rows[rows.length - 1];
  const delta = (a.realizado as number) > 0 ? (((b.realizado as number) - (a.realizado as number)) / (a.realizado as number)) * 100 : null;
  const stats = [
    stat("Corte", `até o dia ${dia} de cada mês (por data de PAGAMENTO)`, "string", "Ciclos da competência do mês pagos até o dia de corte", true),
    stat(`${labelMes(b.mes as string)} até dia ${dia}`, b.realizado as number, "money", `${b.pagamentos} pagamento(s), efetivo`),
    stat(`${labelMes(a.mes as string)} até dia ${dia}`, a.realizado as number, "money", `${a.pagamentos} pagamento(s), efetivo`),
  ];
  if (delta !== null)
    stats.push(stat("Variação no mesmo corte", `${delta >= 0 ? "+" : ""}${f1(delta)}%`, "string",
      delta < 0 ? "Ritmo ABAIXO do período anterior" : "Ritmo acima do período anterior"));
  if (semDataTotal > 0)
    stats.push(stat("⚠️ Pagos sem data de pagamento", semDataTotal, "int",
      "Ficam FORA do corte — preencha DataPagamento na planilha pra comparação ficar exata"));
  return {
    title: `Ritmo do mês (até dia ${dia}, por data de pagamento) · ${subtitle({ ...c, meses })}`,
    stats,
    columns: [MES_COL, col("corte", "Corte", "date"), col("realizado", "Realizado (efetivo)", "money", "right"),
      col("bruto", "Bruto pago", "money", "right"), ...e.squads.map((s) => col(`squad_${s.id}`, s.name, "money", "right")),
      col("pagamentos", "Pagamentos", "int", "right"), col("delta_pct", "Δ vs anterior", "pct", "right")],
    rows, total: b.realizado as number, summary_field: null,
  };
}

function ddAnomalias(c: Ctx): Partial<DdResult> {
  const rows = detectorAnomalias(c.e, fStruct(c)).map((a) => ({ severidade: a.severidade.toUpperCase(), regra: a.regra,
    mensagem: strip(a.mensagem) }));
  return {
    title: `Anomalias · ${subtitle(c)}`,
    stats: [stat("Total de alertas", rows.length, "int", null, true),
      stat("Severidade alta", rows.filter((r) => r.severidade === "ALTA").length, "int", null, false, { key: "severidade", value: "ALTA" })],
    filters: [{ key: "severidade", label: "Severidade", type: "select", options: [{ value: "all", label: "Todas" },
      { value: "ALTA", label: "Alta" }, { value: "MEDIA", label: "Média" }] }],
    columns: [col("severidade", "Severidade"), col("regra", "Regra"), col("mensagem", "Alerta")], rows, total: null,
  };
}

function ddSemana(c: Ctx): Partial<DdResult> {
  const data = c.p.data && /^\d{4}-\d{2}-\d{2}$/.test(c.p.data) ? c.p.data : null;
  const sem = previsibilidadeData(c.e, fStruct(c), data).semana;
  const rows = [...sem.linhas].sort((a, b) => Number(a.a_receber <= 0) - Number(b.a_receber <= 0) ||
    String(a.data_cobranca).localeCompare(String(b.data_cobranca)));
  return {
    title: `Realizado × Planejado · semana ${sem.inicio} → ${sem.fim}`,
    stats: [
      stat("A receber na semana", sem.tot_a_receber, "money",
        `${sem.n_a_receber} ciclo(s) em aberto: pendentes (provável cheio) + resto dos parciais (provável − pago). Perda fica fora.`, true),
      stat("Planejado (Provável)", sem.tot_planejado_provavel, "money"),
      stat("Recebido na semana", sem.tot_recebido, "money", "Planejados + não planejados"),
      stat("Não planejado", sem.tot_nao_planejado, "money", "Pagamentos cuja cobrança era de outra semana"),
      stat("Perdas da semana", sem.tot_perda, "money", `${sem.n_perda} ciclo(s) com status PERDA — não vem mais`),
      stat("Score acumulado do mês", sem.score_acum, "money", "Recebido − planejado, do dia 1 até o fim desta semana. Negativo = atrasado."),
    ],
    columns: [col("nome", "Cliente"), col("squad_nome", "Squad"), col("mes_competencia", "Ciclo", "mes"),
      col("data_cobranca", "Cobrança", "date"), col("valor_planejado_provavel", "Provável", "money", "right"),
      col("valor_planejado_melhor", "Melhor", "money", "right"), col("valor_pago", "Pago", "money", "right"),
      col("a_receber", "A receber", "money", "right"), col("data_pagamento", "Pagamento", "date"), col("status_pagamento", "Status")],
    rows: rows.map(({ cycle: _c, ...r }) => r), total: sem.tot_recebido, summary_field: "valor_pago",
  };
}

function ddPipelineChurn(c: Ctx): Partial<DdResult> {
  const pv = previsibilidadeData(c.e, fStruct(c));
  return {
    title: `Pipeline de churn (próx. 30 dias) · ${subtitle(c)}`,
    stats: [stat("Clientes em risco", pv.pipeline_churn.length, "int", "HS < 70 ou inadimplente", true),
      stat("Investimento mensal em risco", pv.pipeline_churn_total, "money")],
    columns: [col("id_externo", "ID"), col("nome", "Cliente"), col("squad_nome", "Squad"), col("tipo_id", "Tipo", "tipo"),
      col("hs", "HS", "pct", "right"), col("adimplencia", "Adimplência", "adimp"),
      col("investimento_medio", "Investimento", "money", "right"), col("motivo_provavel", "Motivo provável"), col("acao", "Ação sugerida")],
    rows: pv.pipeline_churn, total: pv.pipeline_churn_total, summary_field: "investimento_medio",
  };
}

function ddPipelineGraduacao(c: Ctx): Partial<DdResult> {
  const pv = previsibilidadeData(c.e, fStruct(c));
  const rows = pv.pipeline_grad.map((r) => ({ ...r, criterios: [r.cond_hs ? "HS >= 70: sim" : "HS >= 70: não",
    r.cond_adimp ? "sempre adimplente: sim" : "sempre adimplente: não",
    r.cond_prob ? "prob. alta/provável: sim" : "prob. alta/provável: não"].join(" · ") }));
  return {
    title: `Pipeline de graduação (M3 e M4+) · ${subtitle(c)}`,
    stats: [
      stat("Trials em M3+", rows.length, "int", "Fase ancorada no aniversário da entrada", true),
      stat("Em M4+ (estendido)", rows.filter((r) => r.fase_num >= 4).length, "int", "Trial além do prazo normal — decisão de graduação atrasada"),
      stat("Com probabilidade ALTA", rows.filter((r) => r.probabilidade_grad === "ALTA").length, "int", "3 de 3 critérios", false,
        { key: "probabilidade_grad", value: "ALTA" }),
      stat("Investimento do grupo", pv.pipeline_grad_total, "money"),
    ],
    filters: [{ key: "probabilidade_grad", label: "Probabilidade", type: "select", options: [{ value: "all", label: "Todas" },
      { value: "ALTA", label: "Alta" }, { value: "MEDIA", label: "Média" }, { value: "BAIXA", label: "Baixa" }] }],
    columns: [col("id_externo", "ID"), col("nome", "Cliente"), col("squad_nome", "Squad"), col("fase", "Fase"),
      col("hs", "HS", "pct", "right"), col("investimento", "Investimento", "money", "right"),
      col("probabilidade_grad", "Prob. graduação"), col("criterios", "Critérios")],
    rows, total: pv.pipeline_grad_total, summary_field: "investimento",
  };
}

function ddInsights(c: Ctx): Partial<DdResult> {
  const ins = gerarInsights(c.e, fStruct(c));
  const labels = { alertas: "ALERTA", atencoes: "ATENÇÃO", conquistas: "CONQUISTA", recomendacoes: "RECOMENDAÇÃO" } as const;
  const rows = (Object.keys(labels) as (keyof typeof labels)[]).flatMap((k) => ins[k].map((s) => ({ categoria: labels[k], insight: strip(s) })));
  return {
    title: `Insights automáticos · ${subtitle(c)}`,
    stats: (Object.keys(labels) as (keyof typeof labels)[]).map((k, i) =>
      stat({ alertas: "Alertas", atencoes: "Atenções", conquistas: "Conquistas", recomendacoes: "Recomendações" }[k],
        ins[k].length, "int", null, i === 0, { key: "categoria", value: labels[k] })),
    columns: [col("categoria", "Categoria"), col("insight", "Insight")], rows, total: null,
  };
}

function ddRankingSquads(c: Ctx): Partial<DdResult> {
  const mes = c.meses[0];
  const rk = rankingSquadsData(c.e, mes);
  const corrente = mes.slice(0, 7) === c.e.today.slice(0, 7);
  const rows = rk.squads.map((s) => {
    const r: DdRow = { pos: s.pos, nome: `${s.pos === 1 ? "🥇 " : s.pos === 2 ? "🥈 " : s.pos === 3 ? "🥉 " : ""}${s.nome}`,
      score: numberFormat(s.score, 1) };
    for (const k of Object.keys(rk.criterios)) {
      const v = s.cats[k as keyof typeof s.cats].valor;
      r[k] = v !== null ? phpRound(v, 1) : null;
    }
    return r;
  });
  const venc = rk.squads[0];
  const pesos = Object.values(rk.criterios).map((x) => `${x.label} ${x.peso}`).join(" · ");
  return {
    title: `🏆 Ranking dos Squads · ${labelMes(mes)}`,
    stats: [
      stat("Líder do mês", venc ? venc.nome : "—", "string", corrente ? "Mês em andamento — placar parcial, muda até o fechamento" : "Mês fechado", true),
      stat("Como pontua", "só taxas relativas; líder do critério leva o peso cheio, demais proporcional", "string",
        `Pesos: ${pesos}. Critério sem dado (ex: squad novo sem cohort) sai da conta e o score é renormalizado — sempre comparável de 0 a 100. Critério em que NINGUÉM pontuou (melhor = 0) também sai da conta de todos no mês.`),
    ],
    columns: [col("pos", "#", "int"), col("nome", "Squad"), col("score", "Score (0–100)", "string", "right"),
      ...Object.entries(rk.criterios).map(([k, x]) => col(k, `${x.label} (${x.peso})`, "pct", "right"))],
    rows, total: null,
  };
}

function ddTrocasSquad(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const mes = c.meses[0];
  const t = trocasSquadMes(e, mes, c.sq);
  const rows = [
    ...t.entrada.map((x) => ({ id_externo: x.id_externo, nome: x.nome, de: x.de, para: x.para, sentido: c.sq === null ? "Trocou" : "Entrou" })),
    ...t.saida.map((x) => ({ id_externo: x.id_externo, nome: x.nome, de: x.de, para: x.para, sentido: "Saiu" })),
  ].sort((a, b) => byName(a.nome, b.nome));
  const stats = c.sq === null
    ? [stat("Clientes que trocaram de squad", t.entrada.length, "int",
      "Comparação do squad do ciclo deste mês com o do mês anterior. NÃO afeta o net churn da Make — o cliente continua na casa, só mudou de time.", true)]
    : [stat("Vieram de outro squad", t.entrada.length, "int", `Entraram em ${e.squadName(c.sq)} vindos de outro squad`, true,
      { key: "sentido", value: "Entrou" }),
    stat("Foram pra outro squad", t.saida.length, "int", `Saíram de ${e.squadName(c.sq)} pra outro squad`, false,
      { key: "sentido", value: "Saiu" }),
    stat("Saldo de carteira", t.entrada.length - t.saida.length, "int",
      "Só a movimentação entre squads — fora do net churn, que mede entrada/saída da Make")];
  return {
    title: `↔ Trocas de squad · ${labelMes(mes)}${c.sq ? ` · ${e.squadName(c.sq)}` : ""}`,
    stats,
    filters: c.sq !== null && t.entrada.length && t.saida.length ? [{ key: "sentido", label: "Sentido", type: "select",
      options: [{ value: "all", label: "Todas" }, { value: "Entrou", label: "Vieram pra cá" }, { value: "Saiu", label: "Foram embora" }] }] : [],
    columns: [col("id_externo", "ID"), col("nome", "Cliente"), col("de", "Estava em"), col("para", "Foi para"), col("sentido", "Sentido")],
    rows, total: null,
  };
}

// ------------------------------------------------------------ recebimento
export function padraoTxt(h: RecHist | null) {
  if (!h || h.n_ciclos === 0) return "sem histórico";
  const p: string[] = [];
  if (h.pontualidade_pct !== null) p.push(`${numberFormat(h.pontualidade_pct, 0)}% em dia`);
  if (h.atraso_medio !== null) p.push(h.atraso_medio < 0 ? `antecipa ${f0(-h.atraso_medio)}d` : `atraso médio ${f0(h.atraso_medio)}d`);
  if (h.n_parcial > 0) p.push(`${h.n_parcial} parcial`);
  if (h.n_ciclos_picados > 0) p.push("paga picado");
  return p.join(" · ") || "sem datas";
}

function ddRecebimentoDistribuicao(c: Ctx): Partial<DdResult> {
  const { e } = c;
  const r = recPlanejamento(e, { mes_ref: c.meses[0], squad_id: c.sq });
  const RED = r.regras.zona_vermelha_dia, YEL = r.regras.zona_amarela_dia;
  const rows = r.linhas.map((l) => ({
    id_externo: l.id_externo, nome: l.nome, squad_nome: l.squad_nome, hs: l.hs, data_inicio_ciclo: l.data_inicio_ciclo,
    data_fim_ciclo: l.data_fim_ciclo, data_cobranca: l.data_cobranca, dia_cobranca: l.dia_ref, zona: l.zona, semana: l.semana,
    situacao: l.situacao, dias_atraso: l.dias_atraso, esperado: l.esperado, pago: l.pago, a_receber: l.a_receber,
    pago_bruto: l.pago_bruto, eh_m1: l.eh_m1 ? 1 : 0,
    entradas: l.parcelas.length ? l.parcelas.map((p) => `${fmtDateBr(p.data)} ${fmtMoney(p.valor)}`).join(" + ")
      : l.data_pagamento ? fmtDateBr(l.data_pagamento) : "",
    status: l.status, padrao_historico: padraoTxt(l.hist),
    acao: l.sugestao ? `antecipar cobranca -> dia ${l.sugestao.novo_dia} (${l.sugestao.classe})`
      : l.bloqueio ? `NAO mexer (${l.bloqueio})` : l.situacao === "vencido" ? `COBRAR — venceu há ${l.dias_atraso} dia(s)`
        : l.zona === "amarela" ? "monitorar" : "ok",
  })).sort((a, b) => (a.dia_cobranca ?? 99) - (b.dia_cobranca ?? 99) || b.esperado - a.esperado);
  const stats = [
    stat("Esperado no mês", r.total_esperado, "money", `${r.n_ciclos} ciclos. Esperado = já recebido + o que ainda vem (PERDA fora). Todos os valores são EFETIVOS (regra M1: primeiros R$ 3.000 do 1º mês de trial são comissão, descontados uma vez por ciclo no pago E no provável). Eixo do calendário: DATA DE COBRANÇA (o fim do ciclo é a causa que se ajusta).`, true),
    stat("Já entrou", r.total_recebido, "money", `${r.n_recebidos} cliente(s) pagaram. Valor EFETIVO (regra M1 aplicada) — bate com o Faturamento do mês.${r.total_comissao_m1 > 0.01 ? ` Caiu na conta ${fmtMoney(r.total_recebido_bruto)}; ${fmtMoney(r.total_comissao_m1)} foi comissão M1 de ${r.n_m1} cliente(s).` : ""}`),
    stat("Venceu e não entrou", r.total_vencido, "money", `${r.n_vencido} cobrança(s) com data já passada — é o que dá pra destravar hoje`, false, { key: "situacao", value: "vencido" }),
    stat("Ainda vai vencer", r.total_a_vencer, "money", `${r.n_a_vencer} cobrança(s) até o fim do mês`, false, { key: "situacao", value: "a_vencer" }),
    stat(`Concentração dia ${RED}+`, `${f0(r.zonas.vermelha.pct)}%`, "string", `${fmtMoney(r.zonas.vermelha.esperado)} em ${r.zonas.vermelha.n} cobrança(s). Regra do CEO: nada depois do dia ${RED - 1}. Alerta acima de ${r.regras.concentracao_alta_pct}%.`, false, { key: "zona", value: "vermelha" }),
    ...r.por_semana.map((w) => stat(`Semana ${w.semana} (dias ${w.label})`, w.esperado, "money",
      `${f0(w.pct)}% do mês (ideal ~${f0(w.pct_ideal)}%) · já entrou ${fmtMoney(w.recebido)} · falta ${fmtMoney(w.a_receber)} · ${w.n} cobrança(s)`)),
  ];
  if (r.maior_dia)
    stats.push(stat("Maior dia", `dia ${r.maior_dia.dia}`, "string", `${fmtMoney(r.maior_dia.esperado)} (${f0(r.maior_dia.pct)}% do mês) em ${r.maior_dia.n} cobrança(s): ${r.maior_dia.clientes.join(", ")}`));
  if (r.hoje_dia > 0)
    stats.push(stat(`Ritmo até o dia ${r.hoje_dia}`, `${f0(r.progresso.mes_decorrido_pct)}% do mês passou, ${f0(r.progresso.recebido_pct)}% do dinheiro entrou`,
      "string", `${r.progresso.delta_pp >= 0 ? "+" : ""}${f0(r.progresso.delta_pp)} pp vs ritmo linear`));
  if (r.agenda.length)
    stats.push(stat("Agenda do que falta", r.agenda.map((d) => `dia ${d.dia}: ${fmtMoney(d.valor)}`).join(" · "), "string",
      "Por data de cobrança, de hoje até o fim do mês"));
  if (r.sem_data_no_mes.length)
    stats.push(stat("⚠️ Fora do calendário", r.sem_data_no_mes.length, "int", `Ciclos sem data de cobrança dentro do mês (somam ${fmtMoney(sum(r.sem_data_no_mes.map((x) => x.esperado)))}): ${r.sem_data_no_mes.slice(0, 8).map((x) => x.nome).join(", ")}`));
  if (r.n_sem_fim > 0)
    stats.push(stat("⚠️ Ciclos sem FimCiclo", r.n_sem_fim, "int", `Sem essa data não dá pra planejar a renovação: ${r.sem_fim.slice(0, 8).join(", ")}`));
  r.alertas.forEach((a, i) => stats.push(stat(`${a.severidade === "alta" ? "🔴 " : "🟡 "}Alerta ${i + 1}`, strip(a.mensagem))));
  return {
    title: `📅 Recebimento do mês · ${labelMes(r.mes_ref)}${c.sq ? ` · ${e.squadName(c.sq)}` : ""}`,
    stats,
    filters: [
      { key: "situacao", label: "Situação", type: "select", options: [{ value: "all", label: "Todas" },
        { value: "vencido", label: "Venceu e não entrou" }, { value: "a_vencer", label: "Ainda vai vencer" },
        { value: "resolvido", label: "Pago" }, { value: "perda", label: "Perda" }] },
      { key: "zona", label: "Zona do mês", type: "select", options: [{ value: "all", label: "Todas" },
        { value: "vermelha", label: `Vermelha (dia ${RED}+)` }, { value: "amarela", label: `Amarela (${YEL}-${RED - 1})` },
        { value: "verde", label: `Verde (até ${YEL - 1})` }] },
    ],
    columns: [col("nome", "Cliente"), col("squad_nome", "Squad"), col("hs", "HS", "pct", "right"),
      col("data_inicio_ciclo", "Início ciclo", "date"), col("data_fim_ciclo", "Fim ciclo", "date"), col("data_cobranca", "Cobrança", "date"),
      col("dia_cobranca", "Dia", "int", "right"), col("zona", "Zona"), col("esperado", "Esperado", "money", "right"),
      col("pago", "Entrou (efetivo)", "money", "right"), col("pago_bruto", "Entrou (bruto)", "money", "right"), col("eh_m1", "M1?", "check"),
      col("a_receber", "Falta", "money", "right"), col("entradas", "Quando entrou"), col("situacao", "Situação"),
      col("dias_atraso", "Atraso (d)", "int", "right"), col("padrao_historico", "Padrão histórico"), col("acao", "Ação")],
    rows, total: r.total_esperado, summary_field: "esperado",
  };
}

function ddRecebimentoSugestoes(c: Ctx): Partial<DdResult> {
  const r = recPlanejamento(c.e, { mes_ref: c.meses[0], squad_id: c.sq });
  const rows = [
    ...r.sugestoes.map((s) => ({ id_externo: s.id_externo, nome: s.nome, squad_nome: s.squad_nome, classe: s.sugestao!.classe, hs: s.hs,
      dia_atual: s.sugestao!.dia_atual, novo_dia: s.sugestao!.novo_dia, data_fim_ciclo: s.data_fim_ciclo, esperado: s.esperado,
      sugestao: s.sugestao!.texto + (s.sugestao!.proximo_passo ? ` · ${s.sugestao!.proximo_passo}` : ""),
      motivos: s.sugestao!.motivos.join("; "), padrao_historico: padraoTxt(s.hist) })),
    ...r.fora_alcance.map((s) => ({ id_externo: s.id_externo, nome: s.nome, squad_nome: s.squad_nome, classe: "NAO MEXER", hs: s.hs,
      dia_atual: s.dia_ref, novo_dia: null, data_fim_ciclo: s.data_fim_ciclo, esperado: s.esperado, sugestao: `Manter — ${s.bloqueio}`,
      motivos: s.bloqueio, padrao_historico: padraoTxt(s.hist) })),
  ];
  const RED = r.regras.zona_vermelha_dia;
  return {
    title: `💡 Antecipar cobranças do fim do mês · ${labelMes(r.mes_ref)}`,
    stats: [
      stat(`Cobranças no dia ${RED}+`, r.zonas.vermelha.n, "int", `${fmtMoney(r.zonas.vermelha.esperado)} · ${f0(r.zonas.vermelha.pct)}% do mês`, true),
      stat("Sugestões elegíveis", r.sugestoes.length, "int", `${r.sugestoes.filter((s) => s.sugestao!.classe === "forte").length} forte(s). Regra: antecipar até ${r.regras.passo_max_dias} dias por mês, piso dia ${r.regras.dia_alvo}; HS crítico e inadimplente ficam fora. O ajuste se faz no FIM DO CICLO — é ele que move a cobrança.`),
      stat("Impacto (fortes + possíveis)", r.impacto_sugestoes, "money", "Sai do fim do mês se os ajustes forem aceitos"),
      stat("Fora de alcance", r.fora_alcance.length, "int", "No fim do mês mas NAO mexer (HS crítico / inadimplente)", false, { key: "classe", value: "NAO MEXER" }),
      stat("Semana mais leve", `semana ${r.semana_mais_leve}`, "string", "Destino natural dos ajustes"),
    ],
    filters: [{ key: "classe", label: "Classe", type: "select", options: [{ value: "all", label: "Todas" },
      { value: "forte", label: "Forte candidato" }, { value: "possivel", label: "Possível" }, { value: "cautela", label: "Com cautela" },
      { value: "NAO MEXER", label: "Não mexer" }] }],
    columns: [col("nome", "Cliente"), col("squad_nome", "Squad"), col("classe", "Classe"), col("hs", "HS", "pct", "right"),
      col("dia_atual", "Cobra dia", "int", "right"), col("novo_dia", "Sugerido", "int", "right"),
      col("data_fim_ciclo", "Fim ciclo (o que mudar)", "date"), col("esperado", "Esperado", "money", "right"), col("sugestao", "Sugestão"),
      col("motivos", "Por quê"), col("padrao_historico", "Padrão histórico")],
    rows, total: r.impacto_sugestoes, summary_field: "esperado",
  };
}

function ddReplanejamentos(c: Ctx): Partial<DdResult> {
  const r = recPlanejamento(c.e, { mes_ref: c.meses[0], squad_id: c.sq });
  const rows = r.replanejados.map((s) => ({ id_externo: s.id_externo, nome: s.nome, squad_nome: s.squad_nome,
    primeira_data: s.replan!.primeira_data, data_atual: s.replan!.data_atual, n_mudancas: s.replan!.n_mudancas,
    dias_deslize: s.replan!.dias_deslize, trajeto: s.replan!.datas.map(fmtDateBr).join(" → "), esperado: s.esperado,
    status: s.status, hs: s.hs }));
  return {
    title: `🔁 Replanejamentos de ciclo · ${labelMes(r.mes_ref)}`,
    stats: [
      stat("Ciclos replanejados", rows.length, "int", "Data de COBRANÇA mudou entre syncs (histórico gravado a cada sync)", true),
      stat("Graves", rows.filter((x) => x.n_mudancas >= 2 || Math.abs(x.dias_deslize) >= 7).length, "int",
        "≥ 2 mudanças ou ≥ 7 dias de deslize (ex.: 3 semanas de atraso)"),
      stat("Valor envolvido", sum(rows.map((x) => x.esperado)), "money"),
    ],
    columns: [col("nome", "Cliente"), col("squad_nome", "Squad"), col("primeira_data", "Planejado 1ª vez", "date"),
      col("data_atual", "Atual", "date"), col("n_mudancas", "Mudanças", "int", "right"), col("dias_deslize", "Deslize (dias)", "int", "right"),
      col("trajeto", "Trajeto"), col("esperado", "Esperado", "money", "right"), col("status", "Status")],
    rows, total: sum(rows.map((x) => x.esperado)), summary_field: "esperado",
  };
}

// ------------------------------------------------------------ registro
const REGISTRY: Record<string, (c: Ctx) => Partial<DdResult>> = {
  ativos: ddAtivos, pagantes: ddPagantes, faturamento: ddFaturamento, entradas: ddEntradas, churns: ddChurns,
  reativacoes: ddReativacoes, planejado: ddPlanejado, forecast: ddPendentes, pendentes: ddPendentes, ticket_medio: ddTicketMedio,
  fat_trial: ddFatTrial, fat_acl: ddFatAcl, mensalidades: ddMensalidades, provavel_recebido: ddProvavelRecebido,
  hs_faixa: ddHsFaixa, hs_geral: ddHsGeral, hs_pendentes: ddHsPendentes, inadimplentes: ddInadimplentes,
  adimplencia_geral: ddAdimplenciaGeral, meta: ddMeta, novos_acumulado: ddEntradas, trial_funil: ddTrialFunil,
  trial_churn_fase: ddTrialChurnFase, trial_cohort: ddTrialCohort, trial_squad: ddTrialSquad,
  squads_comparativo: ddSquadsComparativo, ritmo_mes: ddRitmoMes, anomalias: ddAnomalias, semana: ddSemana,
  pipeline_churn: ddPipelineChurn, pipeline_graduacao: ddPipelineGraduacao, insights: ddInsights,
  ranking_squads: ddRankingSquads, trocas_squad: ddTrocasSquad, recebimento_distribuicao: ddRecebimentoDistribuicao,
  recebimento_sugestoes: ddRecebimentoSugestoes, replanejamentos: ddReplanejamentos,
};
export const DD_METRICS = Object.keys(REGISTRY);

/** drilldown_run() */
export function drilldownRun(e: CsEngine, metrica: string, p: DdParams): DdResult {
  const fn = REGISTRY[metrica];
  if (!fn) throw new Error(`Métrica desconhecida: ${metrica}`);
  const meses = ddMeses(p, e.today);
  const sq = p.squad === undefined || p.squad === null || p.squad === "" || p.squad === "todos" ? null : p.squad;
  const dim = p.dim === "trial" || p.dim === "base" ? p.dim : "tudo";
  const r = fn({ e, meses, sq, dim, multi: meses.length > 1, p });
  const out: DdResult = {
    title: r.title ?? metrica, stats: r.stats ?? [], breakdown: (r.breakdown ?? []).filter(Boolean),
    filters: (r.filters ?? []).filter(Boolean), columns: r.columns ?? [], rows: r.rows ?? [], total: r.total ?? null,
    count: (r.rows ?? []).length, summary_field: r.summary_field ?? null, monthly_summary: r.monthly_summary ?? [],
    ...(r.simulador ? { simulador: r.simulador } : {}),
  };
  if (!out.monthly_summary.length && out.rows.length && out.rows[0].mes !== undefined)
    out.monthly_summary = monthlySummary(out.rows, out.summary_field);
  return out;
}

export type { CsDataCycle };

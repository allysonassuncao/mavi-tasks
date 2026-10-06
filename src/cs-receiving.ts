import {
  addMonths,
  byName,
  dateDiff,
  dayOf,
  daysInMonth,
  esc,
  f0,
  fmtDateBr,
  fmtMoney,
  labelMes,
  monthStart,
  weekday,
  ym,
  type CsDataCycle,
  type CsEngine,
  type CsKind,
} from "./cs-engine";

/**
 * Planejamento de Recebimento: quando o dinheiro do mês entra e o que
 * ajustar. Porta de cs-make-dashboard/dash/lib/recebimento.php.
 *
 * O eixo do calendário é a DATA DE COBRANÇA (o fim do ciclo é a causa que se
 * ajusta). Data fora do mês não entra no calendário (nada de "dia 30"
 * artificial). Tudo é EFETIVO (regra M1 descontada uma vez por ciclo, no pago
 * e no provável); o bruto continua em total_recebido_bruto / pago_bruto.
 * As zonas, o passo e o piso vêm das regras do mês (cs_rules.receiving).
 */

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export type RecHist = {
  n_ciclos: number; n_pagos: number; n_parcial: number; n_inadimp: number; n_em_dia: number; n_antecipado: number;
  n_com_datas: number; pontualidade_pct: number | null; atraso_medio: number | null; dia_cobranca_medio: number | null;
  ticket_medio: number | null; n_ciclos_picados: number; max_parcelas: number;
};
export type RecReplan = {
  n_mudancas: number; primeira_data: string | null; data_atual: string | null; dias_deslize: number; datas: string[];
  provavel_delta: number;
};
export type RecSugestao = {
  dia_atual: number; novo_dia: number; classe: "forte" | "possivel" | "cautela"; score: number; motivos: string[];
  impacto: number; proximo_passo: string | null; texto: string;
};
export type RecLinha = {
  cycle: CsDataCycle; cliente_id: string; id_externo: string; nome: string; tipo_id: CsKind; squad_id: string;
  squad_nome: string; data_inicio_ciclo: string | null; data_fim_ciclo: string | null; data_cobranca: string | null;
  data_pagamento: string | null; dia_ref: number | null; origem_dia: "cobranca" | "fim_ciclo" | null; data_ref: string | null;
  zona: "verde" | "amarela" | "vermelha" | null; semana: number | null;
  situacao: "resolvido" | "vencido" | "a_vencer" | "perda"; dias_atraso: number | null;
  esperado: number; provavel: number; melhor: number; pago: number; a_receber: number; pago_bruto: number; eh_m1: boolean;
  comissao_m1: number; status: string; adimplencia: string; probabilidade: string; hs: number | null;
  hs_faixa: "SATISFEITO" | "ALERTA" | "CRITICO" | null; hist: RecHist | null; replan: RecReplan | null;
  parcelas: { ordem: number; data: string; valor: number }[]; sugestao: RecSugestao | null; bloqueio: string | null;
};
export type RecAlerta = { severidade: "alta" | "media"; regra: string; mensagem: string; cliente_id?: string };

export function recSemanaDoMes(dia: number) {
  return dia <= 7 ? 1 : dia <= 14 ? 2 : dia <= 21 ? 3 : 4;
}

/** O padrão do cliente nos últimos N meses FECHADOS antes do mês. */
function historico(e: CsEngine, clients: string[], mes: string, n: number) {
  const from = addMonths(mes, -n);
  const out = new Map<string, RecHist>();
  for (const id of new Set(clients)) {
    const ys = e.cyclesOfClient(id).filter((y) => y.month >= from && y.month < mes);
    if (!ys.length) continue;
    const comDatas = ys.filter((y) => y.paid_date !== null && y.billing_date !== null);
    const emDia = comDatas.filter((y) => y.paid_date! <= y.billing_date!).length;
    const atrasos = comDatas.map((y) => dateDiff(y.paid_date!, y.billing_date!));
    const dias = ys.filter((y) => y.billing_date !== null).map((y) => dayOf(y.billing_date!));
    const tickets = ys.filter((y) => y.paid !== 0).map((y) => y.paid);
    const picados = ys.map((y) => e.paymentsOfCycle(y.id).length).filter((n2) => n2 >= 2);
    out.set(id, {
      n_ciclos: ys.length,
      n_pagos: ys.filter((y) => y.paid > 0).length,
      n_parcial: ys.filter((y) => y.status === "PARCIAL").length,
      n_inadimp: ys.filter((y) => y.adimplencia !== "ADIMPLENTE").length,
      n_em_dia: emDia,
      n_antecipado: comDatas.filter((y) => y.paid_date! < y.billing_date!).length,
      n_com_datas: comDatas.length,
      pontualidade_pct: comDatas.length > 0 ? (emDia / comDatas.length) * 100 : null,
      atraso_medio: atrasos.length ? sum(atrasos) / atrasos.length : null,
      dia_cobranca_medio: dias.length ? sum(dias) / dias.length : null,
      ticket_medio: tickets.length ? sum(tickets) / tickets.length : null,
      n_ciclos_picados: picados.length,
      max_parcelas: picados.length ? Math.max(...picados) : 0,
    });
  }
  return out;
}

/** Replanejamentos do mês: quantas vezes a cobrança mudou e quanto deslizou. */
function replanejamentos(e: CsEngine, mes: string) {
  const por = new Map<string, { primeira: string | null; atual: string | null; datas: string[]; p0: number; p1: number }>();
  const rows = e.history.filter((h) => h.month === mes)
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h.client < b.h.client ? -1 : a.h.client > b.h.client ? 1 : 0) ||
      (a.h.recorded_at < b.h.recorded_at ? -1 : a.h.recorded_at > b.h.recorded_at ? 1 : 0) || a.i - b.i);
  for (const { h } of rows) {
    const data = h.billing_date || h.end_date;
    let p = por.get(h.client);
    if (!p) {
      p = { primeira: data, atual: data, datas: [], p0: Number(h.probable ?? 0), p1: Number(h.probable ?? 0) };
      por.set(h.client, p);
    }
    p.atual = data;
    p.p1 = Number(h.probable ?? 0);
    if (data && (!p.datas.length || p.datas[p.datas.length - 1] !== data)) p.datas.push(data);
  }
  const out = new Map<string, RecReplan>();
  for (const [id, p] of por)
    out.set(id, {
      n_mudancas: Math.max(0, p.datas.length - 1), primeira_data: p.primeira, data_atual: p.atual,
      dias_deslize: p.primeira && p.atual ? dateDiff(p.atual, p.primeira) : 0, datas: p.datas,
      provavel_delta: p.p1 - p.p0,
    });
  return out;
}

const cache = new WeakMap<CsEngine, Map<string, ReturnType<typeof calc>>>();
/** rec_planejamento(): f = { mes_ref, squad_id }. Guardado por motor (o painel, as anomalias e os insights chamam igual). */
export function recPlanejamento(e: CsEngine, f: { mes_ref: string; squad_id: string | null }) {
  let m = cache.get(e);
  if (!m) cache.set(e, (m = new Map()));
  const key = `${f.mes_ref}|${f.squad_id ?? ""}`;
  let r = m.get(key);
  if (!r) m.set(key, (r = calc(e, f)));
  return r;
}

function calc(e: CsEngine, f: { mes_ref: string; squad_id: string | null }) {
  const mes = monthStart(f.mes_ref);
  const R = e.rules(mes).receiving;
  const RED = R.red_day, YELLOW = R.yellow_day, STEP = R.max_shift_days, FLOOR = R.floor_day;
  const zona = (d: number) => (d >= RED ? "vermelha" : d >= YELLOW ? "amarela" : "verde") as "vermelha" | "amarela" | "verde";
  const faixa = (s: number | null) => (s === null ? null : s >= 80 ? "SATISFEITO" : s >= 50 ? "ALERTA" : "CRITICO") as RecLinha["hs_faixa"];
  const month = ym(mes);
  const [y, mo] = [Number(mes.slice(0, 4)), Number(mes.slice(5, 7))];
  const diasMes = daysInMonth(y, mo);
  const corrente = month === ym(e.today);
  const passado = mes < monthStart(e.today);
  const hojeDia = corrente ? dayOf(e.today) : passado ? diasMes : 0;

  const linhasRaw = e.cyclesOfMonth(mes)
    .filter((c) => f.squad_id === null || e.cycleSquad(c) === f.squad_id)
    .sort((a, b) => byName(e.clientOf(a.client).name, e.clientOf(b.client).name));
  const hist = historico(e, linhasRaw.map((l) => l.client), mes, R.history_months);
  const replan = replanejamentos(e, mes);

  const porSemana = [1, 2, 3, 4].map((w) => {
    const ini = (w - 1) * 7 + 1;
    const fim = w === 4 ? diasMes : w * 7;
    return { semana: w, label: `${ini} a ${fim}`, ini, fim, n: 0, esperado: 0, recebido: 0, a_receber: 0, pct: 0,
      pct_ideal: ((fim - ini + 1) / diasMes) * 100 };
  });
  const porDia = Array.from({ length: diasMes }, (_, i) => {
    const dow = weekday(`${month}-${String(i + 1).padStart(2, "0")}`);
    return { dia: i + 1, dow, fds: dow === 0 || dow === 6, n: 0, esperado: 0, a_receber: 0, recebido_cobranca: 0, entrou: 0,
      clientes_aberto: [] as { nome: string; valor: number }[], clientes: [] as string[] };
  });
  const zonas = {
    verde: { n: 0, esperado: 0, a_receber: 0, pct: 0 },
    amarela: { n: 0, esperado: 0, a_receber: 0, pct: 0 },
    vermelha: { n: 0, esperado: 0, a_receber: 0, pct: 0 },
  };
  const entrouPorDia = Array(diasMes + 1).fill(0) as number[];
  let entrouAntes = 0;
  let totEsp = 0, totRec = 0, totAR = 0, totPerda = 0, totBruto = 0, totM1 = 0, nM1 = 0;
  let totVenc = 0, nVenc = 0, totAV = 0, nAV = 0, nRecebidos = 0, nSemFim = 0;
  const semFim: string[] = [];
  const linhas: RecLinha[] = [], sugestoes: RecLinha[] = [], fora: RecLinha[] = [], monitorar: RecLinha[] = [],
    replanejados: RecLinha[] = [], semData: RecLinha[] = [], vencidos: RecLinha[] = [], aVencer: RecLinha[] = [];

  for (const l of linhasRaw) {
    const c = e.clientOf(l.client);
    const st = l.status;
    const ehM1 = e.isM1(l);
    const desc = e.m1(l);
    const prov = Math.max(0, l.probable - desc);
    const pago = Math.max(0, l.paid - desc);
    const comissao = l.paid - pago;
    const aReceber = st === "PENDENTE" ? prov : st === "PARCIAL" ? Math.max(0, prov - pago) : 0;
    const esperado = pago + aReceber;
    let dataRef: string | null = null, origem: RecLinha["origem_dia"] = null;
    if (l.billing_date && ym(l.billing_date) === month) { dataRef = l.billing_date; origem = "cobranca"; }
    else if (l.end_date && ym(l.end_date) === month) { dataRef = l.end_date; origem = "fim_ciclo"; }
    const diaRef = dataRef ? dayOf(dataRef) : null;
    const hsMes = e.hsAtMonth(c.id, mes)?.score ?? null;
    const hsScore = hsMes ?? e.hsLatest(c.id, mes)?.score ?? null;
    const hsFaixa = faixa(hsScore);
    const h = hist.get(c.id) ?? null;
    const rp = replan.get(c.id) ?? null;
    const pc = e.paymentsOfCycle(l.id).map((p) => ({ ordem: p.ord, data: p.date, valor: p.amount }));
    if (!l.end_date) { nSemFim++; semFim.push(c.name); }

    let situacao: RecLinha["situacao"] = "resolvido";
    if (aReceber > 0.01) situacao = diaRef !== null && hojeDia > 0 && diaRef < hojeDia ? "vencido" : "a_vencer";
    else if (st === "PERDA") situacao = "perda";

    let z: RecLinha["zona"] = null, sem: number | null = null;
    if (diaRef !== null) {
      z = zona(diaRef);
      sem = recSemanaDoMes(diaRef);
      const w = porSemana[sem - 1];
      w.n++; w.esperado += esperado; w.recebido += pago; w.a_receber += aReceber;
      const d = porDia[diaRef - 1];
      d.n++; d.esperado += esperado; d.a_receber += aReceber; d.recebido_cobranca += pago; d.clientes.push(c.name);
      if (aReceber > 0.01) d.clientes_aberto.push({ nome: c.name, valor: aReceber });
      zonas[z].n++; zonas[z].esperado += esperado; zonas[z].a_receber += aReceber;
    }
    totEsp += esperado; totRec += pago; totAR += aReceber; totBruto += l.paid; totM1 += comissao;
    if (ehM1) nM1++;
    if (l.paid > 0) nRecebidos++;
    if (st === "PERDA") totPerda += prov;

    const entradas = pc.length ? pc : l.paid > 0 && l.paid_date ? [{ ordem: 1, data: l.paid_date, valor: l.paid }] : [];
    for (const en of entradas) {
      const eym = ym(en.data);
      if (eym === month) {
        const dpg = dayOf(en.data);
        entrouPorDia[dpg] += en.valor;
        porDia[dpg - 1].entrou += en.valor;
      } else if (eym < month) entrouAntes += en.valor;
    }

    let sug: RecSugestao | null = null, bloqueio: string | null = null;
    if (z === "vermelha" && diaRef !== null) {
      const motivos: string[] = [];
      let score = 0;
      if (hsFaixa === "CRITICO")
        bloqueio = `HS crítico (${f0(hsScore!)}%) — NÃO mexer no ciclo; prioridade é recuperar o cliente.`;
      else if (l.adimplencia === "INADIMPLENTE" || l.adimplencia === "PERDA")
        bloqueio = "Inadimplente/perda neste ciclo — resolver a cobrança atual antes de renegociar datas.";
      else {
        if (hsFaixa === "SATISFEITO") { score += 40; motivos.push(`HS ${f0(hsScore!)}% (satisfeito)`); }
        else if (hsFaixa === "ALERTA") { score += 15; motivos.push(`HS ${f0(hsScore!)}% (alerta) — conversar antes, com cuidado`); }
        else { score += 10; motivos.push("sem HS registrado — validar relação antes"); }
        if (h && h.n_com_datas >= 2) {
          if ((h.pontualidade_pct ?? 0) >= 80) { score += 25; motivos.push(`pagou em dia em ${h.n_em_dia} de ${h.n_com_datas} ciclos`); }
          else if (h.atraso_medio !== null && h.atraso_medio > 5) {
            score -= 20;
            motivos.push(`atrasa em média ${f0(h.atraso_medio)} dias — antecipar a data tende a piorar`);
          }
          if (h.n_antecipado > 0 && h.n_antecipado / Math.max(1, h.n_com_datas) >= 0.5) {
            score += 15;
            motivos.push("costuma pagar ANTES da cobrança — antecipar só formaliza o que já faz");
          }
        }
        if (h && (h.n_parcial >= 2 || h.n_ciclos_picados >= 2)) {
          score -= 15;
          motivos.push("paga picado/parcial com frequência — combinar parcelas com datas fixas mais cedo");
        }
        if (l.probability === "BAIXA") { score -= 15; motivos.push("probabilidade BAIXA neste ciclo"); }
        if (esperado > 0) score += Math.trunc(Math.min(20, esperado / 1000));
        if (rp && rp.n_mudancas >= 2) { score += 10; motivos.push(`replanejado ${rp.n_mudancas}× este mês — precisa de data firme`); }
        const novo = Math.max(FLOOR, diaRef - STEP);
        sug = {
          dia_atual: diaRef, novo_dia: novo, classe: score >= 60 ? "forte" : score >= 30 ? "possivel" : "cautela", score,
          motivos, impacto: esperado,
          proximo_passo: novo >= RED ? `1º passo; no mês seguinte ${novo}→${Math.max(FLOOR, novo - STEP)}` : null,
          texto: `Antecipar cobrança do dia ${diaRef} → dia ${novo} (${fmtMoney(esperado)})`,
        };
      }
    }
    const row: RecLinha = {
      cycle: l, cliente_id: c.id, id_externo: c.external_id, nome: c.name, tipo_id: c.kind, squad_id: e.cycleSquad(l),
      squad_nome: e.squadName(e.cycleSquad(l)), data_inicio_ciclo: l.start_date, data_fim_ciclo: l.end_date,
      data_cobranca: l.billing_date, data_pagamento: l.paid_date, dia_ref: diaRef, origem_dia: origem, data_ref: dataRef,
      zona: z, semana: sem, situacao, dias_atraso: situacao === "vencido" ? hojeDia - diaRef! : null,
      esperado, provavel: prov, melhor: l.best, pago, a_receber: aReceber, pago_bruto: l.paid, eh_m1: ehM1,
      comissao_m1: comissao, status: st, adimplencia: l.adimplencia, probabilidade: l.probability, hs: hsScore,
      hs_faixa: hsFaixa, hist: h, replan: rp, parcelas: pc, sugestao: sug, bloqueio,
    };
    linhas.push(row);
    if (diaRef === null && (esperado > 0 || st === "PERDA")) semData.push(row);
    if (situacao === "vencido") { vencidos.push(row); totVenc += aReceber; nVenc++; }
    if (situacao === "a_vencer") { aVencer.push(row); totAV += aReceber; nAV++; }
    if (sug) sugestoes.push(row);
    if (bloqueio) fora.push(row);
    if (z === "amarela" && aReceber > 0.01) monitorar.push(row);
    if (rp && rp.n_mudancas >= 1) replanejados.push(row);
  }

  for (const w of porSemana) w.pct = totEsp > 0 ? (w.esperado / totEsp) * 100 : 0;
  for (const z of Object.values(zonas)) z.pct = totEsp > 0 ? (z.esperado / totEsp) * 100 : 0;
  let maiorDia: { dia: number; esperado: number; a_receber: number; n: number; pct: number; clientes: string[] } | null = null;
  for (const d of porDia)
    if (d.esperado > 0 && (maiorDia === null || d.esperado > maiorDia.esperado))
      maiorDia = { dia: d.dia, esperado: d.esperado, a_receber: d.a_receber, n: d.n,
        pct: totEsp > 0 ? (d.esperado / totEsp) * 100 : 0, clientes: d.clientes };
  let leve = 1;
  for (const w of [1, 2, 3]) if (porSemana[w - 1].esperado < porSemana[leve - 1].esperado) leve = w;
  const fds = { n: 0, esperado: 0, a_receber: 0, dias: [] as number[], pct: 0 };
  for (const d of porDia)
    if (d.fds && d.esperado > 0) { fds.n += d.n; fds.esperado += d.esperado; fds.a_receber += d.a_receber; fds.dias.push(d.dia); }
  fds.pct = totEsp > 0 ? (fds.esperado / totEsp) * 100 : 0;
  const agenda: { dia: number; zona: string; valor: number; clientes: { nome: string; valor: number }[] }[] = [];
  for (let d = Math.max(1, hojeDia); d <= diasMes; d++)
    if (porDia[d - 1].a_receber > 0.01)
      agenda.push({ dia: d, zona: zona(d), valor: porDia[d - 1].a_receber, clientes: porDia[d - 1].clientes_aberto });
  const progresso = {
    dia: hojeDia, recebido: totRec, recebido_pct: totEsp > 0 ? (totRec / totEsp) * 100 : 0,
    mes_decorrido_pct: diasMes > 0 ? (Math.min(hojeDia, diasMes) / diasMes) * 100 : 0, entrou_antes: entrouAntes, delta_pp: 0,
  };
  progresso.delta_pp = progresso.recebido_pct - progresso.mes_decorrido_pct;

  const peso = { forte: 0, possivel: 1, cautela: 2 };
  sugestoes.sort((a, b) => peso[a.sugestao!.classe] - peso[b.sugestao!.classe] || b.esperado - a.esperado);
  vencidos.sort((a, b) => b.a_receber - a.a_receber);
  monitorar.sort((a, b) => b.a_receber - a.a_receber);
  replanejados.sort((a, b) => b.replan!.n_mudancas - a.replan!.n_mudancas ||
    Math.abs(b.replan!.dias_deslize) - Math.abs(a.replan!.dias_deslize));

  const alertas: RecAlerta[] = [];
  const pv = zonas.vermelha.pct;
  if (totEsp > 0 && pv >= R.red_share_high)
    alertas.push({ severidade: "alta", regra: "concentracao_fim_mes",
      mensagem: `${f0(pv)}% do esperado do mês (${fmtMoney(zonas.vermelha.esperado)}) é cobrado do dia ${RED} em diante — meta do CEO: nada depois do dia ${RED - 1}.` });
  else if (totEsp > 0 && pv >= R.red_share_medium)
    alertas.push({ severidade: "media", regra: "concentracao_fim_mes",
      mensagem: `${f0(pv)}% do esperado do mês é cobrado do dia ${RED} em diante — acima do confortável.` });
  if (maiorDia && maiorDia.pct >= 20)
    alertas.push({ severidade: "media", regra: "pico_dia",
      mensagem: `Dia ${maiorDia.dia} concentra ${f0(maiorDia.pct)}% do mês (${fmtMoney(maiorDia.esperado)} em ${maiorDia.n} cobrança${maiorDia.n === 1 ? "" : "s"}).` });
  if (fds.a_receber > 0.01 && fds.pct >= 10)
    alertas.push({ severidade: "media", regra: "cobranca_fim_de_semana",
      mensagem: `${fmtMoney(fds.esperado)} em ${fds.n} cobrança${fds.n === 1 ? "" : "s"} cai em sábado/domingo (dias ${fds.dias.join(", ")}) — na prática o dinheiro só entra na segunda.` });
  if (totVenc > 0.01)
    alertas.push({ severidade: totVenc >= totEsp * 0.15 ? "alta" : "media", regra: "vencido_nao_pago",
      mensagem: `${fmtMoney(totVenc)} em ${nVenc} cobrança${nVenc === 1 ? "" : "s"} já venceu e não entrou — é o que dá pra destravar hoje.` });
  for (const r of replanejados) {
    const rp = r.replan!;
    if (rp.n_mudancas >= 2 || Math.abs(rp.dias_deslize) >= 7)
      alertas.push({ severidade: "alta", regra: "replanejamento", cliente_id: r.cliente_id,
        mensagem: `<strong>${esc(r.nome)}</strong> replanejado ${rp.n_mudancas}× este mês: ${fmtDateBr(rp.primeira_data)} → ${fmtDateBr(rp.data_atual)} (${rp.dias_deslize >= 0 ? "+" : ""}${rp.dias_deslize} dias, ${fmtMoney(r.esperado)}).` });
  }
  if (progresso.delta_pp <= -15 && corrente && hojeDia >= 10)
    alertas.push({ severidade: "alta", regra: "progressao_recebimento",
      mensagem: `Dia ${hojeDia}: ${f0(progresso.mes_decorrido_pct)}% do mês passou e só ${f0(progresso.recebido_pct)}% do dinheiro entrou (${f0(progresso.delta_pp)} pp atrás) — o mês está empurrando receita pro fim.` });
  if (semData.length)
    alertas.push({ severidade: "media", regra: "sem_data_no_mes",
      mensagem: `${semData.length} ciclo${semData.length === 1 ? "" : "s"} sem data de cobrança dentro de ${labelMes(mes)} — ${semData.length === 1 ? "ficou" : "ficaram"} fora do calendário (soma ${fmtMoney(sum(semData.map((r) => r.esperado)))}).` });
  if (nSemFim > 0)
    alertas.push({ severidade: "media", regra: "ciclo_sem_fim",
      mensagem: `${nSemFim} ciclo${nSemFim === 1 ? "" : "s"} sem FimCiclo na planilha — sem essa data não dá pra planejar a renovação.` });

  return {
    mes_ref: mes, dias_mes: diasMes, hoje_dia: hojeDia, eh_corrente: corrente, eh_passado: passado, n_ciclos: linhas.length,
    total_esperado: totEsp, total_recebido: totRec, total_recebido_bruto: totBruto, total_comissao_m1: totM1, n_m1: nM1,
    total_a_receber: totAR, total_vencido: totVenc, n_vencido: nVenc, total_a_vencer: totAV, n_a_vencer: nAV,
    total_perda: totPerda, n_recebidos: nRecebidos, progresso, por_semana: porSemana, por_dia: porDia, zonas,
    maior_dia: maiorDia, semana_mais_leve: leve, fim_de_semana: fds, entrou_por_dia: entrouPorDia, agenda, linhas,
    vencidos, a_vencer: aVencer, sugestoes, fora_alcance: fora, monitorar, replanejados, sem_data_no_mes: semData,
    n_sem_fim: nSemFim, sem_fim: semFim, alertas,
    impacto_sugestoes: sum(sugestoes.filter((s) => s.sugestao!.classe !== "cautela").map((s) => s.esperado)),
    regras: { eixo: "data_cobranca", zona_vermelha_dia: RED, zona_amarela_dia: YELLOW, passo_max_dias: STEP, dia_alvo: FLOOR,
      concentracao_alta_pct: R.red_share_high },
  };
}
export type RecPlanejamento = ReturnType<typeof calc>;

import {
  CHURN_REASONS,
  ORIGIN_LABEL,
  addMonths,
  labelMes,
  monthStart,
  monthsBetween,
  type CsData,
  type CsDataClient,
  type CsDim,
  type CsEngine,
} from "./cs-engine.js";
import { kpiStripData, kpiStripPeriodoData } from "./cs-blocks.js";
import { DD_METRICS, drilldownRun, type DdParams, type DdResult } from "./cs-drilldowns.js";
import { engineFor } from "./cs-sources.js";

/**
 * Customer Success na MAVI e no MCP do MAVI (fase 4a, migração
 * 20270524090000): as 20 ferramentas do conector antigo (Cloudflare,
 * mcp/src/tools.ts), com os mesmos nomes e parâmetros para as instruções do
 * projeto "📊 Dados CS Make" e os prompts do time continuarem valendo. As
 * respostas saem do motor do painel CS Make (os mesmos números), com os
 * dados que a pessoa pode ver (cs_ai_data: tudo, ou só o squad dela).
 */

export type CsAiData = CsData & {
  access: { scope: "all" | "squads"; squads?: string[] };
  sync?: { finished_at: string | null; status: string; warnings: number } | null;
};
type Schema = Record<string, unknown>;
export type CsToolDef = { name: string; description: string; inputSchema: Schema };

// ------------------------------------------------------------ parâmetros
const mes = { type: "string", pattern: "^\\d{4}-\\d{2}(-\\d{2})?$", description: "Mês no formato AAAA-MM." };
const squad = {
  type: ["string", "integer"],
  description:
    "Squad pelo nome (ex.: Primogênito), apelido ou o número antigo (1, 2, 3). Omita para o consolidado (quem é de um squad só vê o dele).",
};
const dim = { type: "string", enum: ["tudo", "trial", "base"], description: 'Recorte: "tudo" (padrão), "trial" ou "base".' };
const periodo = {
  mes,
  mes_ini: { ...mes, description: "Início do período (vários meses)." },
  mes_fim: { ...mes, description: "Fim do período (vários meses)." },
  squad,
  dim,
};
const obj = (properties: Schema, required: string[] = []): Schema => ({ type: "object", properties, required });

/** As ferramentas, como o conector antigo (descrições ajustadas aos squads do MAVI). */
export const CS_TOOLS: CsToolDef[] = [
  {
    name: "cs_listar",
    description:
      'Customer Success · descoberta: métricas do detalhamento, squads, tipos de cliente, motivos de churn, meses com dados, informações gerais ou as REGRAS DE NEGÓCIO. Use o_que="info" para a visão geral e o_que="regras" para as regras de cálculo.',
    inputSchema: obj({
      o_que: { type: "string", enum: ["metricas", "squads", "tipos", "motivos_churn", "meses", "info", "regras"] },
    }, ["o_que"]),
  },
  {
    name: "cs_regras",
    description:
      "Customer Success · REGRAS DE NEGÓCIO da Make — LEIA ANTES de explicar qualquer número: regra M1 (comissão do 1º mês de trial), por que Pago ≠ Efetivo, os dois conceitos de pagante, categoria histórica Trial/Base/ACL, ACL parcial, graduação, reativações no net churn, forecast, recebimento e o que NUNCA usar (MRR/ARR).",
    inputSchema: obj({}),
  },
  {
    name: "cs_kpi",
    description:
      "Customer Success · os 8 KPIs do painel (Faturamento, Atingimento, Planejado, Ativos, Pagantes, % Trial, Net churn, Forecast). Use para 'como está' um mês ou período; com mes_ini/mes_fim, os KPIs acumulados.",
    inputSchema: obj(periodo),
  },
  {
    name: "cs_drilldown",
    description: `Customer Success · detalhamento de uma métrica: estatísticas, quebras, resumo por mês (vários meses) e a lista de clientes ou ciclos. Métricas: ${DD_METRICS.join(", ")}. Veja cs_listar({o_que:"metricas"}).`,
    inputSchema: obj({
      metrica: { type: "string", enum: DD_METRICS },
      ...periodo,
      faixa: { type: "string", enum: ["SATISFEITO", "ALERTA", "CRITICO"], description: "Para hs_faixa." },
      categoria: { type: "string", enum: ["TRIAL", "BASE", "BASE_RA", "ACL"], description: "Para faturamento." },
      dia: { type: "integer", minimum: 1, maximum: 31, description: "Para ritmo_mes: o dia de corte." },
      data: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Para semana: qualquer dia da semana." },
    }, ["metrica"]),
  },
  {
    name: "cs_cliente",
    description:
      "Customer Success · perfil completo de UM cliente: cadastro, métricas históricas, ciclos de pagamento (24 meses), Health Score (12 meses) e movimentações. Pelo id_externo (código da planilha) ou pelo nome (busca aproximada).",
    inputSchema: obj({
      id: { type: "string", description: "O id do cliente de CS no MAVI." },
      id_externo: { type: "string", description: "O código da planilha." },
      nome: { type: "string", description: "Nome (busca aproximada)." },
    }),
  },
  {
    name: "cs_search",
    description: "Customer Success · busca clientes por nome ou código da planilha. Use antes de cs_cliente quando não souber o código.",
    inputSchema: obj({
      q: { type: "string", minLength: 2 },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Máximo de resultados (padrão 20)." },
    }, ["q"]),
  },
  {
    name: "cs_gap_recebimento",
    description:
      "Customer Success · Provável vs Recebido, cliente a cliente: saldo, quem paga A MENOS, quem paga A MAIS e o que ainda está pendente. Para 'estamos recebendo o que planejamos?' ou 'de quem recebemos menos?'.",
    inputSchema: obj(periodo),
  },
  {
    name: "cs_meta_gap",
    description:
      "Customer Success · a meta: meta vs realizado, quanto falta, forecast ponderado pelo Health Score, cenários Provável/Melhor e pendentes por faixa de HS. Para 'quanto falta para a meta?' ou 'vamos bater?'.",
    inputSchema: obj(periodo),
  },
  {
    name: "cs_funil_trial",
    description: "Customer Success · funil do trial: M1, M2, M3, M4+ (estendido) e graduados, com a situação atual e os valores pagos.",
    inputSchema: obj({ mes, squad }),
  },
  {
    name: "cs_churns",
    description: "Customer Success · cancelamentos do mês ou período: motivo, investimento médio, perda anual potencial e a fase do trial em que saíram.",
    inputSchema: obj(periodo),
  },
  {
    name: "cs_health_score",
    description: "Customer Success · Health Score de cada cliente no mês: nota, faixa e os 5 critérios. Para quem está em risco ou saudável.",
    inputSchema: obj({ mes, squad, dim }),
  },
  {
    name: "cs_adimplencia",
    description: "Customer Success · adimplência (Adimplente/Inadimplente/Perda) de todos os ciclos do mês ou período, com valores.",
    inputSchema: obj(periodo),
  },
  {
    name: "cs_ativos",
    description: "Customer Success · clientes ativos no mês, com investimento médio dos últimos 3 meses e por squad.",
    inputSchema: obj({ mes, squad, dim }),
  },
  {
    name: "cs_pendentes",
    description: "Customer Success · ciclos pendentes do mês (não pagos) com cenários Pessimista/Provável/Melhor: o que ainda pode entrar até o fim do mês.",
    inputSchema: obj({ mes, squad, dim }),
  },
  {
    name: "cs_ritmo",
    description:
      "Customer Success · 'MESMO PONTO DO MÊS': faturamento efetivo por DATA DE PAGAMENTO até o dia N de cada mês, lado a lado, por squad. USE para 'como estamos vs o mesmo período do mês passado?' — nunca reconstrua por data de cobrança.",
    inputSchema: obj({
      mes: { ...mes, description: "Mês principal (compara com o anterior)." },
      mes_ini: { ...mes, description: "Início dos meses a comparar." },
      mes_fim: { ...mes, description: "Fim dos meses a comparar." },
      dia: { type: "integer", minimum: 1, maximum: 31, description: "Dia de corte (padrão: hoje no mês atual)." },
      squad,
    }),
  },
  {
    name: "cs_squads",
    description:
      "Customer Success · comparativo entre os squads: faturamento, ticket, ativos, HS, entradas e saídas, net churn, graduação e adimplência, com insights. Para a COMPETIÇÃO (pódio 0–100), use cs_drilldown('ranking_squads').",
    inputSchema: obj({ mes, mes_ini: periodo.mes_ini, mes_fim: periodo.mes_fim }),
  },
  {
    name: "cs_anomalias",
    description:
      "Customer Success · detector de anomalias do mês: quedas de HS, probabilidade BAIXA por 2 ciclos, PERDA recorrente, squad abaixo da média, pico de churn, trial M3 com HS crítico, recebimento concentrado no fim do mês, ciclo replanejado. Para 'tem algo estranho?'.",
    inputSchema: obj({ mes, squad }),
  },
  {
    name: "cs_semana",
    description:
      "Customer Success · Realizado × Planejado da SEMANA: a receber (pendentes + resto dos parciais), cobranças previstas vs pagas, recebimentos não planejados, perdas e o score do mês. Para 'quanto falta receber essa semana?'.",
    inputSchema: obj({
      data: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Qualquer dia da semana (padrão: hoje)." },
      squad,
    }),
  },
  {
    name: "cs_recebimento",
    description:
      "Customer Success · PLANEJAMENTO DE RECEBIMENTO por DATA DE COBRANÇA: o que já entrou, venceu e não entrou, ainda vai vencer, por semana e dia, zona vermelha, agenda e quem antecipar (HS crítico não se mexe). visao: distribuicao (padrão) | sugestoes | replanejamentos.",
    inputSchema: obj({ mes, squad, visao: { type: "string", enum: ["distribuicao", "sugestoes", "replanejamentos"] } }),
  },
  {
    name: "cs_insights",
    description:
      "Customer Success · insights do mês em 4 categorias (alertas, atenções, conquistas, recomendações): frases prontas para abrir reunião. Complementos: cs_drilldown('pipeline_churn') e cs_drilldown('pipeline_graduacao').",
    inputSchema: obj({ mes, squad }),
  },
];
export const CS_TOOL_NAMES = new Set(CS_TOOLS.map((t) => t.name));

/** As instruções do conector antigo, para o MCP e para a MAVI. */
export const CS_INSTRUCTIONS = `Customer Success (ferramentas cs_*): os dados do painel CS Make da Make. Regras essenciais:
1. NUNCA use nem calcule MRR, ARR, NRR ou GRR: a receita é variável por ciclo mensal. O substituto é o "Total Planejado do mês".
2. REGRA M1: no 1º mês de trial, os primeiros R$ da comissão (padrão R$ 3.000) vão para a comissão comercial e NÃO contam como faturamento. Quando "Pago" ≠ "Efetivo", a diferença é essa. Forecasts e Total Planejado usam valores cheios.
3. Dois conceitos de pagante: a CONTAGEM (X/Y) conta quem pagou qualquer valor; o TICKET MÉDIO divide só pelos pagantes EFETIVOS.
4. Trial: M1→M2→M3 (M4+ = estendido), depois gradua para Base. Trial vs Base usa a fase do cliente NAQUELE mês (histórica).
5. ACL: o pagamento do mês de conclusão entra na categoria ACL (pode ser parcial).
6. Net churn = entradas (novos + reativações) − saídas. Mensalidade pós-graduação é receita À PARTE: nunca some com o faturamento da meta.
7. O mês corrente está SEMPRE em aberto (números parciais). Toda resposta traz contexto_dados com a última leitura da planilha e os avisos: cite quando importar.
8. SQUAD É ATRIBUTO DO MÊS: o recorte por squad num mês passado usa o squad que o cliente tinha naquele mês. Um squad que operava aparecer zerado é erro: avise.
9. CICLO ≠ COBRANÇA: o calendário de recebimento usa a data de cobrança; o fim do ciclo é o que se ajusta para mover a cobrança (use cs_recebimento).
Fluxo: cs_regras (regras completas) → cs_listar (meses, métricas) → as ferramentas específicas. "Vamos bater a meta?" → cs_meta_gap; "de quem recebemos menos?" → cs_gap_recebimento; "vs o mesmo período do mês passado" → cs_ritmo; "recebimento concentrado / quem antecipar" → cs_recebimento.`;

// ------------------------------------------------------------ execução
type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const toMonth = (v: unknown) => {
  const s = str(v);
  return /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? `${s.slice(0, 7)}-01` : null;
};
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** O squad pelo id, nome, apelido ou número antigo — dentro do que a pessoa vê. */
function resolveSquad(e: CsEngine, data: CsAiData, raw: unknown): { id: string | null } | { error: string } {
  const own = data.access.scope === "squads" ? data.access.squads ?? [] : null;
  const s = fold(str(raw));
  if (!s) {
    if (!own) return { id: null };
    if (own.length === 1) return { id: own[0] };
    return { error: `Você é de mais de um squad (${own.map((id) => e.squadName(id)).join(", ")}): diga qual em "squad".` };
  }
  const hit = e.squads.find((q) => q.id === str(raw) || fold(q.name) === s || (q.aliases ?? []).some((a) => fold(a) === s)) ??
    e.squads.find((q) => fold(q.name).startsWith(s) || (q.aliases ?? []).some((a) => s.startsWith(fold(a)) && a.length > 1));
  if (!hit) return { error: `Squad "${str(raw)}" não encontrado. Squads: ${e.squads.map((q) => q.name).join(", ")}.` };
  if (own && !own.includes(hit.id)) return { error: `Você só vê os dados do seu squad (${own.map((id) => e.squadName(id)).join(", ")}).` };
  return { id: hit.id };
}

function contextoDados(data: CsAiData, e: CsEngine, now: number) {
  const s = data.sync;
  const ctx: Record<string, unknown> = {
    ultima_leitura_da_planilha: s?.finished_at ?? null,
    status_da_leitura: s?.status ?? "nunca lida",
    mes_corrente: `${e.today.slice(0, 7)} está EM ABERTO — números do mês corrente são parciais`,
  };
  if (s?.warnings) ctx.avisos_da_leitura = `${s.warnings} aviso(s) na última leitura (veja Equipe e configurações › Customer Success).`;
  if (s?.finished_at && now - new Date(s.finished_at).getTime() > 2 * 3600_000)
    ctx.alerta = "A última leitura da planilha foi há mais de 2 horas: os dados podem estar desatualizados.";
  if (data.access.scope === "squads")
    ctx.escopo = `Você vê só o seu squad: ${(data.access.squads ?? []).map((id) => e.squadName(id)).join(", ")}.`;
  return ctx;
}

/** O detalhamento, enxuto para a IA: os números, as quebras e até 80 linhas. */
function compactDd(e: CsEngine, r: DdResult, maxRows = 80) {
  const squadCols = new Set(r.columns.filter((c) => c.type === "squad").map((c) => c.key));
  const keys = r.columns.map((c) => c.key);
  const row = (x: Record<string, unknown>) =>
    Object.fromEntries(keys.map((k) => [k, squadCols.has(k) && x[k] ? e.squadName(String(x[k])) : x[k]]));
  return {
    titulo: r.title,
    estatisticas: r.stats.map((s) => ({ nome: s.label, valor: s.value, ...(s.hint ? { como: s.hint } : {}) })),
    ...(r.breakdown.length ? { quebras: r.breakdown.map((b) => ({ titulo: b.title, linhas: b.rows.map(row) })) } : {}),
    ...(r.monthly_summary.length > 1 ? { por_mes: r.monthly_summary } : {}),
    ...(r.total !== null ? { total: r.total } : {}),
    colunas: r.columns.map((c) => `${c.key} (${c.label})`),
    linhas: r.rows.slice(0, maxRows).map(row),
    ...(r.rows.length > maxRows ? { aviso: `Mostrando ${maxRows} de ${r.rows.length} linhas (as primeiras da lista).` } : {}),
  };
}

function ddParams(e: CsEngine, data: CsAiData, a: Args): DdParams | { error: string } {
  const sq = resolveSquad(e, data, a.squad);
  if ("error" in sq) return sq;
  const p: DdParams = { squad: sq.id };
  const m = toMonth(a.mes), ini = toMonth(a.mes_ini), fim = toMonth(a.mes_fim);
  if (ini && fim) {
    p.mes_ini = ini.slice(0, 7);
    p.mes_fim = fim.slice(0, 7);
  } else p.mes = (m ?? monthStart(e.today)).slice(0, 7);
  const d = str(a.dim);
  if (d === "trial" || d === "base") p.dim = d as CsDim;
  if (str(a.faixa)) p.faixa = str(a.faixa);
  if (str(a.categoria)) p.categoria = str(a.categoria);
  if (Number(a.dia) >= 1 && Number(a.dia) <= 31) p.dia = Math.trunc(Number(a.dia));
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(a.data))) p.data = str(a.data);
  return p;
}

const ALIAS: Record<string, string> = {
  cs_gap_recebimento: "provavel_recebido",
  cs_meta_gap: "meta",
  cs_funil_trial: "trial_funil",
  cs_churns: "churns",
  cs_health_score: "hs_geral",
  cs_adimplencia: "adimplencia_geral",
  cs_ativos: "ativos",
  cs_pendentes: "pendentes",
  cs_ritmo: "ritmo_mes",
  cs_squads: "squads_comparativo",
  cs_anomalias: "anomalias",
  cs_semana: "semana",
  cs_insights: "insights",
};

/** Roda uma ferramenta de CS: o texto (JSON) que volta para a IA. */
export function runCsTool(data: CsAiData, name: string, a: Args, now = Date.now()): string {
  const e = engineFor(data);
  const answer = (payload: unknown) => JSON.stringify({ data: payload, contexto_dados: contextoDados(data, e, now) });
  const fail = (msg: string) => JSON.stringify({ erro: msg });
  try {
    if (name === "cs_regras") return answer(regras(e, data));
    if (name === "cs_listar") return answer(listar(e, data, str(a.o_que)));
    if (name === "cs_search") return answer(search(e, str(a.q), Number(a.limit) || 20));
    if (name === "cs_cliente") {
      const r = cliente(e, a);
      return typeof r === "string" ? fail(r) : answer(r);
    }
    if (name === "cs_kpi") {
      const sq = resolveSquad(e, data, a.squad);
      if ("error" in sq) return fail(sq.error);
      const d = (["trial", "base"].includes(str(a.dim)) ? str(a.dim) : "tudo") as CsDim;
      const ini = toMonth(a.mes_ini), fim = toMonth(a.mes_fim);
      if (ini && fim) {
        const [i, f] = ini <= fim ? [ini, fim] : [fim, ini];
        const meses: string[] = [];
        for (let m = i; m <= f && meses.length < 60; m = addMonths(m, 1)) meses.push(m);
        return answer({
          modo: "periodo", mes_ini: i, mes_fim: f, qtd_meses: meses.length, squad: sq.id ? e.squadName(sq.id) : "consolidado", dim: d,
          kpi: kpiStripPeriodoData(e, { mes_ref: f, squad_id: sq.id, dim: d, modo: "anual" }, meses),
        });
      }
      const m = toMonth(a.mes) ?? monthStart(e.today);
      const k = kpiStripData(e, { mes_ref: m, squad_id: sq.id, dim: d, modo: "mensal" });
      return answer({ modo: "mensal", mes: m, squad: sq.id ? e.squadName(sq.id) : "consolidado", dim: d, kpi: k });
    }
    let metric = ALIAS[name];
    if (name === "cs_drilldown") metric = str(a.metrica);
    if (name === "cs_recebimento")
      metric = str(a.visao) === "sugestoes" ? "recebimento_sugestoes"
        : str(a.visao) === "replanejamentos" ? "replanejamentos" : "recebimento_distribuicao";
    if (!metric) return fail(`Ferramenta desconhecida: ${name}.`);
    if (!DD_METRICS.includes(metric)) return fail(`Métrica desconhecida: ${metric}. Use cs_listar({o_que:"metricas"}).`);
    const p = ddParams(e, data, a);
    if ("error" in p) return fail(p.error);
    return answer(compactDd(e, drilldownRun(e, metric, p)));
  } catch (err) {
    return fail((err as Error).message || "Não foi possível consultar os dados de CS.");
  }
}

// ------------------------------------------------------------ cada consulta
function regras(e: CsEngine, data: CsAiData) {
  const r = e.rules(e.today);
  const m1 = r.m1_commission.toLocaleString("pt-BR");
  const w = r.hs_weights;
  const rk = r.ranking_weights;
  const rc = r.receiving;
  return {
    contexto_empresa: `Make: assessoria de marketing. Clientes investem valores VARIÁVEIS por ciclo mensal. Squads de CS: ${e.squads.map((s) => `${s.name}${s.aliases?.length ? ` (apelidos: ${s.aliases.join(", ")})` : ""}${s.archived ? " — arquivado" : ""}`).join("; ")}. A planilha mestre de CS é a fonte da verdade; o MAVI lê a planilha a cada 10 minutos.`,
    nunca_usar: "MRR, ARR, NRR, GRR — não existem aqui. A receita é variável por ciclo. KPI substituto: Total Planejado do mês (soma do Provável). Faturamento = soma do pago com a regra M1.",
    regra_m1: {
      resumo: `Cliente no PRIMEIRO mês de trial: os primeiros R$ ${m1} pagos vão para a comissão comercial e NÃO contam como faturamento. Só o excedente conta.`,
      detalhes: [
        "É fato HISTÓRICO do mês de entrada — não muda quando o cliente gradua para Base.",
        "Aplica também aos ciclos ACL.",
        "EXCEÇÃO: Forecast e Total Planejado usam valores CHEIOS.",
        "Quando Pago ≠ Efetivo, a diferença é essa regra.",
      ],
    },
    pagantes_dois_conceitos: {
      contagem: "Pagantes X/Y: X = quem pagou QUALQUER valor no mês; Y = todos os ciclos do mês.",
      efetivo: "O ticket médio divide pelos PAGANTES EFETIVOS: pago/parcial e acima do limiar M1. Pendente nunca entra.",
    },
    trial_e_graduacao: {
      fases: "Trial: M1 (mês de entrada), M2, M3; M4+ = estendido. Depois gradua para Base.",
      mes_de_trial: "O campo MesTrial = em qual mês do trial o cliente GRADUOU. Mês da graduação = entrada + (MesTrial − 1) meses.",
      fase_atual: "A fase de quem está em trial vem da data de entrada, ancorada no aniversário (entrou dia 29 só completa o mês no dia 29 do seguinte).",
      categoria_historica: "Trial vs Base usa a fase do cliente NAQUELE mês — nunca retroativo.",
    },
    acl: "ACL é um programa da Make: o pagamento do mês de conclusão entra na categoria ACL; pode ser parcial (só a parte informada).",
    mensalidade: "Depois da graduação o cliente paga MENSALIDADE: receita À PARTE, fora da meta, da composição, do ticket e do forecast. Prevista (por mês) e recebida.",
    recebimento: {
      ciclo_vs_cobranca: "CICLO ≠ COBRANÇA. O calendário de recebimento usa a DATA DE COBRANÇA (quando o dinheiro é esperado); o FIM DO CICLO é o que se ajusta para mover a cobrança.",
      regra: `Zona vermelha a partir do dia ${rc.red_day}, amarela do dia ${rc.yellow_day}. Antecipar no máximo ${rc.max_shift_days} dias por mês, até o dia ${rc.floor_day}. Cliente com HS crítico ou inadimplente não se mexe.`,
      situacoes: "Cada ciclo do mês: JÁ ENTROU · VENCEU E NÃO ENTROU (o acionável de hoje) · AINDA VAI VENCER · PERDA (fora do esperado).",
    },
    churn_e_reativacao: {
      net_churn: "Net churn = entradas (novos + reativações no mês) − saídas. Trocas internas não contam como novo.",
      perda_anual: "Perda anual potencial de um churn = investimento médio dos 3 ciclos anteriores × 12.",
    },
    provavel_vs_recebido: "Provável vs pago, ambos efetivos (M1 dos dois lados). O SALDO usa só ciclos resolvidos; pendentes ficam como 'ainda pode entrar'.",
    health_score: {
      criterios: `5 critérios com pesos: Meta batida ${w.goal} · Percepção de valor ${w.perception} · Pagamento em dia ${w.payment} · Reunião de alinhamento ${w.meeting} · Aprovação de criativos ${w.creatives}.`,
      faixas: `SATISFEITO ≥ ${r.hs_bands.satisfied} · ALERTA ${r.hs_bands.alert}–${r.hs_bands.satisfied - 1} · CRÍTICO < ${r.hs_bands.alert}.`,
    },
    ranking: `Score 0–100 por taxas relativas: atingimento ${rk.goal}, HS ${rk.hs}, adimplência ${rk.adimplencia}, retenção ${rk.retention}, graduação ${rk.graduation}, provável realizado ${rk.realization} (teto ${Math.round(r.ranking_realization_cap * 100)}%).`,
    forecast_cenarios: "Pessimista = realizado + 50% do Provável em aberto · Provável = realizado + Provável + 30% dos Baixa · Melhor = realizado + Melhor em aberto. Valores cheios; em aberto = pendentes + resto dos parciais.",
    squad_historico: "SQUAD É ATRIBUTO DO MÊS: o recorte por squad num mês passado usa o squad do ciclo daquele mês. Trocar o cliente de squad ou fundir squads não muda o passado.",
    vigencia: data.rules.length
      ? `As regras mudaram com vigência (Equipe e configurações › Customer Success › Regras): ${data.rules.map((v) => `a partir de ${labelMes(v.valid_from)}`).join(", ")}. Meses anteriores seguem as regras de antes.`
      : "Valem os padrões do dash antigo (nenhuma mudança de regra registrada).",
    dicas_de_uso: [
      'Sem saber os meses com dados, chame cs_listar({o_que:"meses"}).',
      "O mês corrente está sempre em aberto: deixe claro que é parcial.",
      "Quanto falta para a meta → cs_meta_gap; de quem recebemos menos → cs_gap_recebimento; vs o mesmo período do mês passado → cs_ritmo.",
      "Valores em BRL.",
    ],
  };
}

function listar(e: CsEngine, data: CsAiData, what: string) {
  switch (what) {
    case "metricas": return { count: DD_METRICS.length, metricas: DD_METRICS };
    case "squads": return { squads: e.squads.map((s) => ({ id: s.id, nome: s.name, apelidos: s.aliases ?? [], arquivado: s.archived })) };
    case "tipos":
      return {
        tipos_cliente: ["TRIAL", "BASE", "BASE_RA"], categorias_faturamento: ["TRIAL", "BASE", "ACL"],
        status_pagamento: ["PAGO", "PARCIAL", "PENDENTE", "PERDA", "ISENTO"], adimplencia: ["ADIMPLENTE", "INADIMPLENTE", "PERDA"],
        hs_faixa: ["SATISFEITO", "ALERTA", "CRITICO"], probabilidade: ["ALTA", "PROVAVEL", "BAIXA"],
      };
    case "motivos_churn":
      return { motivos: Object.values(CHURN_REASONS).map((m) => ({ label: m.label, evitavel: m.avoidable })) };
    case "meses": {
      const by = new Map<string, { n_ciclos: number; n_pagos: number }>();
      for (const y of e.cycles) {
        const g = by.get(y.month) ?? { n_ciclos: 0, n_pagos: 0 };
        g.n_ciclos++;
        if (y.paid > 0) g.n_pagos++;
        by.set(y.month, g);
      }
      const meses = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([m, g]) => ({ mes: m.slice(0, 7), ...g }));
      return { meses_com_dados: meses, count: meses.length };
    }
    case "info":
      return {
        hoje: e.today, ultima_leitura: data.sync ?? null,
        totais: {
          clientes: e.clients.length, clientes_sem_churn: e.clients.filter((c) => !c.churn_date).length,
          ciclos: e.cycles.length, notas_hs: e.hs.length,
        },
      };
    case "regras": return regras(e, data);
    default: return { erro: "o_que inválido. Use: metricas | squads | tipos | motivos_churn | meses | info | regras" };
  }
}

function search(e: CsEngine, q: string, limit: number) {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const t = fold(q);
  const rows = /^\d+$/.test(q)
    ? e.clients.filter((c) => c.external_id.startsWith(q)).sort((a, b) => Number(b.external_id === q) - Number(a.external_id === q))
    : e.clients.filter((c) => fold(c.name).includes(t))
      .sort((a, b) => Number(fold(b.name) === t) - Number(fold(a.name) === t) ||
        Number(fold(b.name).startsWith(t)) - Number(fold(a.name).startsWith(t)) || a.name.localeCompare(b.name, "pt-BR"));
  const out = rows.slice(0, n).map((c) => ({
    id: c.id, id_externo: c.external_id, nome: c.name, tipo: c.kind, status: c.status, squad: e.squadName(c.squad_id),
    data_entrada: c.entry_date, data_churn: c.churn_date, situacao: c.churn_date && !(c.reactivation_date && c.reactivation_date > c.churn_date) ? "CHURN" : "ATIVO",
  }));
  return { query: q, count: out.length, results: out };
}

function cliente(e: CsEngine, a: Args) {
  let c: CsDataClient | undefined;
  if (str(a.id)) c = e.clients.find((x) => x.id === str(a.id));
  if (!c && str(a.id_externo)) c = e.clients.find((x) => x.external_id === str(a.id_externo));
  if (!c && str(a.nome)) {
    const t = fold(str(a.nome));
    c = e.clients.find((x) => fold(x.name) === t) ?? e.clients.find((x) => fold(x.name).includes(t));
  }
  if (!c) return str(a.id) || str(a.id_externo) || str(a.nome) ? "Cliente não encontrado (ou fora do seu squad)." : "Informe id_externo ou nome.";
  const desde = addMonths(monthStart(e.today), -24);
  const ys = e.cyclesOfClient(c.id);
  const pagos = ys.filter((y) => y.paid > 0);
  const total = pagos.reduce((s, y) => s + y.paid, 0);
  const tres = addMonths(monthStart(e.today), -3);
  const recentes = pagos.filter((y) => y.month >= tres);
  const hs = e.hs.filter((h) => h.client === c!.id).sort((x, y) => y.month.localeCompare(x.month)).slice(0, 12);
  const n = monthsBetween(c.entry_date, e.today) + 1;
  return {
    cliente: {
      id: c.id, id_externo: c.external_id, nome: c.name, squad: e.squadName(c.squad_id), tipo: c.kind,
      ...(c.kind === "TRIAL" ? { fase_trial_hoje: n >= 4 ? "M4+" : `M${Math.max(1, n)}` } : {}),
      mes_de_trial: c.trial_month, status: c.status, vertical: c.vertical, origem: ORIGIN_LABEL[c.origin],
      data_entrada: c.entry_date, data_churn: c.churn_date, data_reativacao: c.reactivation_date,
      motivo_churn: c.churn_reason ? CHURN_REASONS[c.churn_reason].label : null, observacoes: c.notes,
      cliente_mavi_id: c.client_id ?? null,
    },
    metricas: {
      total_pago_historico: total, n_ciclos_pagos: pagos.length, ticket_medio_historico: pagos.length ? total / pagos.length : 0,
      investimento_medio_3m: recentes.length ? recentes.reduce((s, y) => s + y.paid, 0) / recentes.length : 0,
      primeiro_ciclo: ys[0]?.month ?? null,
      ultimo_pagamento: pagos.map((y) => y.paid_date).filter(Boolean).sort().pop() ?? null,
      hs_atual: hs[0] ? { mes: hs[0].month, nota: hs[0].score, faixa: hs[0].band } : null,
    },
    ciclos: [...ys].filter((y) => y.month >= desde).reverse().map((y) => ({
      mes: y.month, squad: e.squadName(e.cycleSquad(y)), inicio_ciclo: y.start_date, fim_ciclo: y.end_date, cobranca: y.billing_date,
      pagamento: y.paid_date, melhor: y.best, provavel: y.probable, pago: y.paid, efetivo: y.paid > 0 ? e.vef(y) : 0, m1: e.isM1(y),
      categoria: e.category(y), probabilidade: y.probability, status: y.status, adimplencia: y.adimplencia,
      mensalidade_prevista: y.fee_planned, mensalidade_paga: y.fee_paid,
      parcelas: e.paymentsOfCycle(y.id).map((p) => ({ data: p.date, valor: p.amount })),
    })),
    health_score: hs.map((h) => ({
      mes: h.month, nota: h.score, faixa: h.band,
      criterios: { meta_batida: h.goal, percepcao_valor: h.perception, pagamento_em_dia: h.payment, reuniao: h.meeting, criativos: h.creatives },
    })),
    movimentacoes: [
      { data: c.entry_date, tipo: "ENTRADA", origem: ORIGIN_LABEL[c.origin] },
      ...e.churns.filter((x) => x.client.id === c!.id).map((x) => ({ data: x.date, tipo: "CHURN", motivo: x.reason ? CHURN_REASONS[x.reason].label : null })),
      ...e.reactivations.filter((x) => x.client.id === c!.id).map((x) => ({ data: x.date, tipo: "REATIVACAO" })),
    ].sort((x, y) => y.data.localeCompare(x.data)),
  };
}

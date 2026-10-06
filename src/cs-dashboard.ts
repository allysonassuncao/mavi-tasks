import { rpc } from "./api";
import {
  CS_DEFAULT_RULES,
  addDays,
  addMonths,
  daysInMonth,
  labelMesFull,
  monthStart,
  ymd,
  type CsAdimp,
  type CsBand,
  type CsData,
  type CsDataClient,
  type CsDataCycle,
  type CsDataHistory,
  type CsDataHs,
  type CsPayStatus,
  type CsProb,
  type CsReason,
} from "./cs-engine";

/**
 * O painel "CS Make" (Dashboards › tipo 'cs', migração 20270522090000): os
 * dados vêm inteiros de cs_dashboard_data e o motor (cs-engine.ts) calcula
 * tudo na tela. Aqui ficam a carga dos dados, o período (porta de
 * dash/lib/periodo.php) e os dados da demonstração.
 */

export type CsSync = { finished_at: string | null; status: "ok" | "warning" | "error" | "running"; warnings: number } | null;
export type CsLoaded = CsData & { access: "editor" | "viewer"; sync: CsSync };
/** De onde vêm os dados: o dashboard no app, o link (público/senha) ou a demonstração. */
export type CsSource =
  | { kind: "app"; dashboard: string }
  | { kind: "link"; token: string; password?: string }
  | { kind: "demo" };

export async function loadCsData(source: CsSource): Promise<CsLoaded> {
  if (source.kind === "demo") return demoCsData();
  const data = (await rpc("cs_dashboard_data", source.kind === "app"
    ? { p_dashboard: source.dashboard }
    : { p_dashboard: null, p_token: source.token, p_password: source.password ?? null })) as CsLoaded & { error?: string };
  if (data.error) throw new Error(data.error);
  return data;
}

export async function createCsDashboard(company: string, name: string, description: string) {
  return rpc("create_cs_dashboard", { p_company: company, p_name: name, p_description: description });
}

// ------------------------------------------------------------ período (parse_periodo)
export type CsWindow = "mes" | "3m" | "6m" | "12m";
export type CsPeriodSetting =
  | { tipo: CsWindow; mes: string }
  | { tipo: "custom"; ini: string; fim: string }
  | { tipo: "compare"; janela: CsWindow; a_fim: string; b_fim: string };
export type CsSimplePeriod = {
  tipo: CsWindow | "custom"; mes_ref: string; inicio: string; fim: string; meses: string[]; qtd_meses: number; label: string;
  is_single: boolean;
};
export type CsPeriod = CsSimplePeriod & {
  is_compare: boolean;
  compare: null | { janela: CsWindow; a: CsSimplePeriod; b: CsSimplePeriod };
};

const N: Record<CsWindow, number> = { mes: 1, "3m": 3, "6m": 6, "12m": 12 };
const months = (ini: string, fim: string) => {
  const out: string[] = [];
  for (let m = ini; m <= fim; m = addMonths(m, 1)) out.push(m);
  return out;
};
const diffMonths = (a: string, b: string) =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

function simple(tipo: CsWindow, fim: string): CsSimplePeriod {
  const ini = addMonths(fim, -(N[tipo] - 1));
  const label = tipo === "mes" ? labelMesFull(fim) : `${N[tipo]} meses até ${labelMesFull(fim)}`;
  return { tipo, mes_ref: fim, inicio: ini, fim, meses: months(ini, fim), qtd_meses: N[tipo], label, is_single: tipo === "mes" };
}

/** O período escolhido, preso ao mês corrente (não existe mês futuro). */
export function resolvePeriod(p: CsPeriodSetting, today: string): CsPeriod {
  const atual = monthStart(today);
  const cap = (m: string) => (monthStart(m) > atual ? atual : monthStart(m));
  if (p.tipo === "compare") {
    const back = (m: string) => addMonths(m, -N[p.janela]);
    const a_fim = cap(p.a_fim);
    let b_fim = cap(p.b_fim);
    if (a_fim === b_fim) b_fim = back(a_fim);
    const a = simple(p.janela, a_fim);
    const b = simple(p.janela, b_fim);
    return { ...a, label: `${a.label}  vs  ${b.label}`, is_single: false, is_compare: true, compare: { janela: p.janela, a, b } };
  }
  if (p.tipo === "custom") {
    let ini = monthStart(p.ini), fim = cap(p.fim);
    if (ini > fim) [ini, fim] = [fim, ini];
    if (diffMonths(ini, fim) > 24) ini = addMonths(fim, -24);
    const meses = months(ini, fim);
    return {
      tipo: "custom", mes_ref: fim, inicio: ini, fim, meses, qtd_meses: meses.length,
      label: `${labelMesFull(ini)} → ${labelMesFull(fim)}`, is_single: meses.length === 1, is_compare: false, compare: null,
    };
  }
  return { ...simple(p.tipo, cap(p.mes)), is_compare: false, compare: null };
}

/** O mês de referência ao trocar de mês (◀ ▶): o período anda junto. */
export function shiftPeriod(p: CsPeriodSetting, n: number, today: string): CsPeriodSetting {
  const r = resolvePeriod(p, today);
  const mes = addMonths(r.mes_ref, n);
  if (p.tipo === "custom") return { tipo: "custom", ini: addMonths(r.inicio, n), fim: mes };
  if (p.tipo === "compare") return { ...p, a_fim: mes };
  return { tipo: p.tipo, mes };
}

// ------------------------------------------------------------ demonstração
// Uma carteira inventada, com o mesmo formato do banco: dá para ver todos os
// blocos funcionando sem dados de cliente de verdade.
let demoCache: CsLoaded | null = null;
export function demoCsData(): CsLoaded {
  // A conferência local com a base real injeta os dados aqui (nunca no ar).
  const injected = (globalThis as { __csDemoData?: CsLoaded }).__csDemoData;
  if (injected) return injected;
  if (!demoCache) demoCache = buildDemo(isoToday());
  return demoCache;
}
const isoToday = () => {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NEGOCIOS = ["Clínica", "Ótica", "Academia", "Imobiliária", "Escola", "Pet Shop", "Restaurante", "Construtora", "Studio",
  "Auto Center", "Odonto", "Farmácia"];
const NOMES = ["Aurora", "Horizonte", "Vitória", "Central", "Bela Vista", "Primavera", "Atlântico", "Serra Azul", "Ipê",
  "Jardins", "Litoral", "Planalto"];

function buildDemo(today: string): CsLoaded {
  const r = rng(20261006);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const atual = monthStart(today);
  const squads = [
    { id: "sq-p", name: "Primogênito", color: "#e0782a", sort: 1, archived: false },
    { id: "sq-t", name: "Tão Tão Perto", color: "#3f79c4", sort: 2, archived: false },
  ];
  const clients: CsDataClient[] = [];
  const cycles: CsDataCycle[] = [];
  const hs: CsDataHs[] = [];
  const history: CsDataHistory[] = [];
  const reasons: CsReason[] = ["performance", "financeiro", "fechou", "estrategia"];
  const usados = new Set<string>();
  for (let i = 0; i < 72; i++) {
    let name = "";
    do name = `${pick(NEGOCIOS)} ${pick(NOMES)}`;
    while (usados.has(name));
    usados.add(name);
    const idade = Math.floor(r() * 20); // meses desde a entrada
    const entry = addDays(addMonths(atual, -idade), Math.floor(r() * 27));
    const squad = squads[i % 2].id;
    const saude = 0.45 + r() * 0.55;
    let churn: string | null = null;
    if (idade >= 2 && r() < 0.18) churn = addDays(addMonths(entry, 1 + Math.floor(r() * Math.max(1, idade - 1))), Math.floor(r() * 20));
    if (churn && churn > today) churn = null;
    const trialMeses = 3 + (r() < 0.15 ? 1 : 0);
    const emTrial = idade < trialMeses && !churn;
    const veioDoTrial = r() < 0.75;
    const id = `cs-${i + 1}`;
    clients.push({
      id, external_id: String(1000 + i), name, squad_id: squad, vertical: pick(["Saúde", "Varejo", "Serviços", "Educação"]),
      origin: r() < 0.85 ? "comercial" : "reativacao", kind: emTrial ? "TRIAL" : "BASE",
      trial_month: emTrial ? null : veioDoTrial ? trialMeses : null,
      status: churn ? "INATIVO" : r() < 0.06 ? "MAKE_IN" : "ATIVO", entry_date: entry, churn_date: churn, reactivation_date: null,
      churn_reason: churn ? pick(reasons) : null, notes: null,
    });
    const investimento = Math.round((4000 + r() * 26000) / 100) * 100;
    // A nota muda pouco de um mês para o outro (como na vida real).
    const crit = { creatives: r() < saude, meeting: r() < saude, payment: r() < saude, perception: r() < saude, goal: r() < saude };
    for (let m = monthStart(entry); m <= atual && (!churn || m <= monthStart(churn)); m = addMonths(m, 1)) {
      const probable = Math.round((investimento * (0.8 + r() * 0.4)) / 50) * 50;
      const dia = 3 + Math.floor(r() * 26);
      const billing = ymd(Number(m.slice(0, 4)), Number(m.slice(5, 7)), Math.min(dia, daysInMonth(Number(m.slice(0, 4)), Number(m.slice(5, 7)))));
      const vencido = billing < today;
      let status: CsPayStatus = "PENDENTE", paid = 0, paidDate: string | null = null, adimp: CsAdimp = "ADIMPLENTE";
      if (vencido) {
        const x = r();
        if (x < saude * 0.95) { status = "PAGO"; paid = Math.round(probable * (0.92 + r() * 0.16)); }
        else if (x < saude * 0.95 + 0.12) { status = "PARCIAL"; paid = Math.round(probable * (0.4 + r() * 0.4)); adimp = "INADIMPLENTE"; }
        else if (m < atual && r() < 0.35) { status = "PERDA"; adimp = "PERDA"; }
        else adimp = "INADIMPLENTE";
        if (paid > 0) paidDate = addDays(billing, Math.floor(r() * 7) - 2);
        if (paidDate && paidDate > today) paidDate = today;
      }
      const probability: CsProb = saude > 0.8 ? "ALTA" : saude > 0.6 ? "PROVAVEL" : r() < 0.5 ? "BAIXA" : "PROVAVEL";
      cycles.push({
        id: `${id}-${m}`, client: id, month: m, squad_id: squad, start_date: addMonths(billing, -1), end_date: addDays(billing, -2),
        billing_date: billing, best: Math.round(probable * 1.2), probable, probability, paid, paid_date: paidDate, status,
        adimplencia: adimp, acl: false, acl_value: null, fee_planned: null, fee_paid: null, m1_discounted: false,
      });
      if (m === atual && dia >= 26 && r() < 0.3)
        history.push({ client: id, month: m, end_date: addDays(billing, -9), billing_date: addDays(billing, -7), probable,
          recorded_at: `${monthStart(today)}T10:00:00Z` });
      if (m >= addMonths(atual, -5)) {
        for (const key of Object.keys(crit) as (keyof typeof crit)[]) if (r() < 0.08) crit[key] = !crit[key];
        const h = { ...crit, payment: status !== "PERDA" && crit.payment };
        const w = CS_DEFAULT_RULES.hs_weights;
        const score = (h.creatives ? w.creatives : 0) + (h.meeting ? w.meeting : 0) + (h.payment ? w.payment : 0) +
          (h.perception ? w.perception : 0) + (h.goal ? w.goal : 0);
        const band: CsBand = score >= 80 ? "SATISFEITO" : score >= 50 ? "ALERTA" : "CRITICO";
        hs.push({ client: id, month: m, ...h, score, band });
      }
    }
  }
  const goals = squads.flatMap((s) =>
    months(addMonths(atual, -19), atual).map((m) => {
      const prov = cycles.filter((y) => y.month === m && y.squad_id === s.id).reduce((t, y) => t + y.probable, 0);
      return { squad_id: s.id, month: m, revenue: Math.round((prov * 1.05) / 10000) * 10000, retention_pct: null, ticket: null };
    }));
  return {
    today, squads, clients, cycles, payments: [], hs, goals, events: [], history, official_revenue: [], multipliers: [],
    rules: [], access: "editor",
    sync: { finished_at: new Date(Date.now() - 4 * 60000).toISOString(), status: "ok", warnings: 0 },
  };
}

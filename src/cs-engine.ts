/**
 * Customer Success: o motor de cálculo do painel "CS Make" (fase 2).
 *
 * Porta fiel do dash antigo (cs-make-dashboard/dash/lib/calculos.php,
 * insights.php e recebimento.php). Cada função aqui tem a mesma regra e o
 * mesmo nome de campo da função PHP correspondente, para a conferência de
 * paridade (scripts/cs-parity.ts) comparar número por número.
 *
 * Os dados vêm inteiros do banco (cs_dashboard_data): a base de CS é pequena
 * (centenas de clientes, ~600 ciclos por ano) e as regras são intrincadas
 * demais para SQL genérico. O mesmo motor serve ao painel, ao link público e,
 * na fase 4, à MAVI e ao MCP.
 *
 * Regras de ouro (CLAUDE.md do projeto antigo):
 *  - nunca MRR: faturamento = valor pago EFETIVO (regra M1 aplicada);
 *  - M1 é fato histórico do mês de entrada (passou pelo trial, 1º ciclo,
 *    entrada no mesmo mês) — não depende do tipo atual;
 *  - categoria histórica do ciclo (trial antes da graduação) e ACL por parcela;
 *  - squad é atributo do MÊS (ciclo daquele mês → anterior → posterior → atual);
 *  - fase do trial ancorada no aniversário da entrada, capada em hoje.
 */

// ------------------------------------------------------------ dados
export type CsKind = "TRIAL" | "BASE" | "BASE_RA";
export type CsStatus = "ATIVO" | "MAKE_IN" | "INATIVO";
export type CsPayStatus = "PAGO" | "PARCIAL" | "PENDENTE" | "PERDA" | "ISENTO";
export type CsAdimp = "ADIMPLENTE" | "INADIMPLENTE" | "PERDA";
export type CsProb = "ALTA" | "PROVAVEL" | "BAIXA";
export type CsBand = "SATISFEITO" | "ALERTA" | "CRITICO";
export type CsReason = "performance" | "financeiro" | "fechou" | "estrategia";

export type CsDataSquad = { id: string; name: string; color: string; sort: number; archived: boolean };
export type CsDataClient = {
  id: string;
  external_id: string;
  name: string;
  squad_id: string;
  vertical: string | null;
  origin: "comercial" | "reativacao" | "troca";
  kind: CsKind;
  trial_month: number | null;
  status: CsStatus;
  entry_date: string;
  churn_date: string | null;
  reactivation_date: string | null;
  churn_reason: CsReason | null;
  notes: string | null;
  client_id?: string | null;
};
export type CsDataCycle = {
  id: string;
  client: string;
  month: string;
  squad_id: string | null;
  start_date: string | null;
  end_date: string | null;
  billing_date: string | null;
  best: number;
  probable: number;
  probability: CsProb;
  paid: number;
  paid_date: string | null;
  status: CsPayStatus;
  adimplencia: CsAdimp;
  acl: boolean;
  acl_value: number | null;
  fee_planned: number | null;
  fee_paid: number | null;
  m1_discounted: boolean;
};
export type CsDataPayment = { cycle: string; ord: number; date: string; amount: number };
export type CsDataHs = {
  client: string;
  month: string;
  creatives: boolean;
  meeting: boolean;
  payment: boolean;
  perception: boolean;
  goal: boolean;
  score: number;
  band: CsBand;
};
export type CsDataGoal = { squad_id: string; month: string; revenue: number; retention_pct: number | null; ticket: number | null };
export type CsDataEvent = { client: string; kind: "CHURN" | "REATIVACAO"; date: string; churn_reason: CsReason | null };
export type CsDataHistory = {
  client: string;
  month: string;
  end_date: string | null;
  billing_date: string | null;
  probable: number | null;
  recorded_at: string;
};
export type CsDataRevenue = { squad_id: string; month: string; achieved: number };
export type CsDataMultiplier = { client: string; month: string; value: number };
export type CsRulesVersion = { valid_from: string; rules: Partial<CsRules> };

export type CsData = {
  /** Hoje no fuso da empresa (AAAA-MM-DD). */
  today: string;
  squads: CsDataSquad[];
  clients: CsDataClient[];
  cycles: CsDataCycle[];
  payments: CsDataPayment[];
  hs: CsDataHs[];
  goals: CsDataGoal[];
  events: CsDataEvent[];
  history: CsDataHistory[];
  official_revenue?: CsDataRevenue[];
  multipliers?: CsDataMultiplier[];
  rules: CsRulesVersion[];
};

export type CsRules = {
  m1_commission: number;
  hs_weights: { goal: number; perception: number; payment: number; meeting: number; creatives: number };
  hs_bands: { satisfied: number; alert: number };
  ranking_weights: { goal: number; hs: number; adimplencia: number; retention: number; graduation: number; realization: number };
  ranking_realization_cap: number;
  receiving: {
    red_day: number;
    yellow_day: number;
    max_shift_days: number;
    floor_day: number;
    red_share_high: number;
    red_share_medium: number;
    history_months: number;
  };
};

/** Os valores do dash antigo (iguais a mavi_private.cs_default_rules()). */
export const CS_DEFAULT_RULES: CsRules = {
  m1_commission: 3000,
  hs_weights: { goal: 30, perception: 25, payment: 20, meeting: 15, creatives: 10 },
  hs_bands: { satisfied: 80, alert: 50 },
  ranking_weights: { goal: 35, hs: 20, adimplencia: 15, retention: 15, graduation: 10, realization: 5 },
  ranking_realization_cap: 1.2,
  receiving: {
    red_day: 26,
    yellow_day: 22,
    max_shift_days: 5,
    floor_day: 20,
    red_share_high: 35,
    red_share_medium: 25,
    history_months: 6,
  },
};

export const CHURN_REASONS: Record<CsReason, { label: string; avoidable: boolean; sort: number }> = {
  performance: { label: "Performance abaixo da expectativa", avoidable: true, sort: 1 },
  financeiro: { label: "Financeiro / inadimplência", avoidable: true, sort: 2 },
  fechou: { label: "Empresa fechou ou pivotou", avoidable: false, sort: 3 },
  estrategia: { label: "Mudança de estratégia interna", avoidable: false, sort: 4 },
};
export const ORIGIN_LABEL = { comercial: "Comercial", reativacao: "Reativação", troca: "Troca" } as const;
/** Troca (cliente que entra no lugar de outro) não é aquisição nova. */
export const countsAsNew = (c: CsDataClient) => c.origin !== "troca";

// ------------------------------------------------------------ datas (semântica do MySQL)
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const ymd = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const parts = (d: string) => [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))] as const;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
export const ym = (d: string) => d.slice(0, 7);
export function lastDay(d: string) {
  const [y, m] = parts(d);
  return ymd(y, m, daysInMonth(y, m));
}
/** DATE_ADD(d, INTERVAL n MONTH): o dia é preso ao fim do mês de destino. */
export function addMonths(d: string, n: number) {
  const [y, m, day] = parts(d);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12);
  const nm = (t % 12 + 12) % 12 + 1;
  return ymd(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}
export const addDays = (d: string, n: number) => {
  const [y, m, day] = parts(d);
  const t = new Date(Date.UTC(y, m - 1, day + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
const epochDay = (d: string) => {
  const [y, m, day] = parts(d);
  return Date.UTC(y, m - 1, day) / 86400000;
};
/** DATEDIFF(a, b) em dias. */
export const dateDiff = (a: string, b: string) => epochDay(a) - epochDay(b);
/** TIMESTAMPDIFF(MONTH, a, b) com datas: meses completos de a até b. */
export function monthsBetween(a: string, b: string) {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  let n = (by - ay) * 12 + (bm - am);
  if (n > 0 && bd < ad) n--;
  else if (n < 0 && bd > ad) n++;
  return n;
}
export const dayOf = (d: string) => Number(d.slice(8, 10));
/** 0 = domingo … 6 = sábado. */
export const weekday = (d: string) => {
  const [y, m, day] = parts(d);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
};
export const between = (d: string | null, a: string, b: string) => d !== null && d >= a && d <= b;
/** Os meses de ini a fim (inclusive), AAAA-MM-01. */
export function monthsRange(ini: string, fim: string) {
  const out: string[] = [];
  for (let m = monthStart(ini); m <= fim; m = addMonths(m, 1)) out.push(m);
  return out;
}

// ------------------------------------------------------------ formatação (como o PHP)
/** round() do PHP: metade para longe do zero. */
export function phpRound(v: number, places = 0) {
  const f = 10 ** places;
  const x = Math.abs(v) * f;
  const r = Math.round(x + 1e-9 * Math.max(1, x));
  return (Math.sign(v) * r) / f;
}
/** number_format($v, $dec, ',', '.') */
export function numberFormat(v: number, dec = 0) {
  const r = phpRound(v, dec);
  const [i, f] = Math.abs(r).toFixed(dec).split(".");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${r < 0 && Number(r.toFixed(dec)) !== 0 ? "-" : ""}${int}${dec ? `,${f}` : ""}`;
}
/** fmt_money(): "R$ 1.234,56" */
export const fmtMoney = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(v) ? "R$ —" : `R$ ${numberFormat(v, 2)}`;
/**
 * sprintf('%.Nf') do PHP: o valor binário exato, com empate exato para o par
 * (14,5 → "14"; 0,5 → "0") e "-0" quando um negativo arredonda para zero.
 */
export function sprintfFixed(v: number, d: number) {
  const x = Math.abs(v) * 10 ** d;
  let s: string;
  if (x % 1 === 0.5) {
    const fl = Math.floor(x);
    s = ((fl % 2 === 0 ? fl : fl + 1) / 10 ** d).toFixed(d);
  } else s = Math.abs(v).toFixed(d);
  return v < 0 || Object.is(v, -0) ? `-${s}` : s;
}
export const f0 = (v: number) => sprintfFixed(v, 0);
export const f1 = (v: number) => sprintfFixed(v, 1);
/** fmt_date_br(): "dd/mm/aaaa" */
export const fmtDateBr = (d: string | null | undefined) =>
  d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—";
const MESES_ABREV = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const MESES_FULL = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro",
  "Outubro", "Novembro", "Dezembro"];
/** label_mes_br(): "Mai/26" */
export const labelMes = (d: string) => `${MESES_ABREV[Number(d.slice(5, 7)) - 1]}/${d.slice(2, 4)}`;
/** label_mes_full_br(): "Maio 2026" */
export const labelMesFull = (d: string) => `${MESES_FULL[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
/** e() — o texto entra entre <strong>; o painel só interpreta essa marcação. */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
/** Ordenação como o utf8mb4_unicode_ci do MySQL (sem caixa nem acento). */
export const byName = (a: string, b: string) => a.localeCompare(b, "pt-BR", { sensitivity: "base" });

// ------------------------------------------------------------ filtros
export type CsDim = "tudo" | "trial" | "base";
/** O struct $f do PHP. squad_id nulo = consolidado. */
export type CsFilter = { mes_ref: string; squad_id: string | null; dim: CsDim; modo?: "mensal" | "anual" };

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

// ------------------------------------------------------------ o motor
export class CsEngine {
  readonly today: string;
  readonly squads: CsDataSquad[];
  readonly clients: CsDataClient[];
  readonly cycles: CsDataCycle[];
  readonly hs: CsDataHs[];
  readonly goals: CsDataGoal[];
  readonly history: CsDataHistory[];
  private client = new Map<string, CsDataClient>();
  private squad = new Map<string, CsDataSquad>();
  /** Ciclos de cada cliente em ordem de mês. */
  private cyclesOf = new Map<string, CsDataCycle[]>();
  private cyclesIn = new Map<string, CsDataCycle[]>();
  private hsAt = new Map<string, CsDataHs>();
  private hsIn = new Map<string, CsDataHs[]>();
  private hsOf = new Map<string, CsDataHs[]>();
  private paymentsOf = new Map<string, CsDataPayment[]>();
  private firstMonth = new Map<string, string>();
  private goalAt = new Map<string, number>();
  private revenueAt = new Map<string, number>();
  private multipliers: CsDataMultiplier[];
  private eventsOf = new Map<string, CsDataEvent[]>();
  private rulesVersions: CsRulesVersion[];
  private rulesCache = new Map<string, CsRules>();
  private squadMonthCache = new Map<string, string>();
  /** Churns de todos os tempos: o atual (cadastro) + os antigos (aba EVENTOS). */
  readonly churns: { client: CsDataClient; date: string; reason: CsReason | null }[];
  /** Reativações de todos os tempos (v_reativacoes_all). */
  readonly reactivations: { client: CsDataClient; date: string }[];

  constructor(data: CsData) {
    this.today = data.today;
    this.squads = [...data.squads].sort((a, b) => a.sort - b.sort || byName(a.name, b.name));
    for (const s of this.squads) this.squad.set(s.id, s);
    this.clients = data.clients;
    for (const c of data.clients) this.client.set(c.id, c);
    this.cycles = data.cycles.filter((y) => this.client.has(y.client));
    for (const y of this.cycles) {
      push(this.cyclesOf, y.client, y);
      push(this.cyclesIn, y.month, y);
    }
    for (const list of this.cyclesOf.values()) list.sort((a, b) => (a.month < b.month ? -1 : 1));
    for (const [id, list] of this.cyclesOf) this.firstMonth.set(id, list[0].month);
    this.hs = data.hs.filter((h) => this.client.has(h.client));
    for (const h of this.hs) {
      this.hsAt.set(`${h.client}|${h.month}`, h);
      push(this.hsIn, h.month, h);
      push(this.hsOf, h.client, h);
    }
    for (const list of this.hsOf.values()) list.sort((a, b) => (a.month < b.month ? -1 : 1));
    for (const p of data.payments) push(this.paymentsOf, p.cycle, p);
    for (const list of this.paymentsOf.values()) list.sort((a, b) => a.ord - b.ord);
    this.goals = data.goals;
    for (const g of data.goals) this.goalAt.set(`${g.squad_id}|${g.month}`, Number(g.revenue) || 0);
    for (const r of data.official_revenue ?? []) this.revenueAt.set(`${r.squad_id}|${r.month}`, Number(r.achieved) || 0);
    this.multipliers = (data.multipliers ?? []).filter((m) => this.client.has(m.client));
    for (const e of data.events) if (this.client.has(e.client)) push(this.eventsOf, e.client, e);
    this.history = data.history.filter((h) => this.client.has(h.client));
    this.rulesVersions = [...data.rules].sort((a, b) => (a.valid_from < b.valid_from ? -1 : 1));

    // v_churns_all e v_reativacoes_all
    this.churns = [];
    this.reactivations = [];
    for (const c of this.clients) {
      if (c.churn_date) this.churns.push({ client: c, date: c.churn_date, reason: c.churn_reason });
      if (c.reactivation_date && c.churn_date && c.reactivation_date > c.churn_date)
        this.reactivations.push({ client: c, date: c.reactivation_date });
      for (const e of this.eventsOf.get(c.id) ?? []) {
        if (e.kind === "CHURN" && (c.churn_date === null || c.churn_date !== e.date))
          this.churns.push({ client: c, date: e.date, reason: e.churn_reason });
        if (e.kind === "REATIVACAO" && !(c.reactivation_date !== null && c.reactivation_date === e.date &&
          (c.churn_date === null || c.reactivation_date > c.churn_date)))
          this.reactivations.push({ client: c, date: e.date });
      }
    }
  }

  // ---------------------------------------------------------- consultas básicas
  clientOf = (id: string) => this.client.get(id)!;
  squadOf = (id: string | null) => (id ? this.squad.get(id) ?? null : null);
  squadName = (id: string | null) => (id ? this.squad.get(id)?.name ?? "—" : "—");
  cyclesOfMonth = (m: string) => this.cyclesIn.get(m) ?? [];
  cyclesOfClient = (id: string) => this.cyclesOf.get(id) ?? [];
  cycleAt = (client: string, m: string) => this.cyclesOfClient(client).find((y) => y.month === m) ?? null;
  hsOfMonth = (m: string) => this.hsIn.get(m) ?? [];
  hsAtMonth = (client: string, m: string) => this.hsAt.get(`${client}|${m}`) ?? null;
  hsLatest = (client: string, m: string) => {
    const list = this.hsOf.get(client) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].month <= m) return list[i];
    return null;
  };
  paymentsOfCycle = (cycle: string) => this.paymentsOf.get(cycle) ?? [];
  multipliersIn = (m: string) => this.multipliers.filter((x) => x.month === m);
  goal = (squad: string | null, m: string) =>
    squad !== null
      ? this.goalAt.get(`${squad}|${m}`) ?? 0
      : sum(this.goals.filter((g) => g.month === m).map((g) => Number(g.revenue) || 0));
  /** fat_real_mes(): o faturamento oficial lançado à mão (0 = não há). */
  officialRevenue = (m: string, squad: string | null) =>
    squad !== null
      ? this.revenueAt.get(`${squad}|${m}`) ?? 0
      : sum([...this.revenueAt.entries()].filter(([k]) => k.endsWith(`|${m}`)).map(([, v]) => v));

  /** As regras que valem no mês (padrão + mudanças com vigência). */
  rules(m: string): CsRules {
    const key = monthStart(m);
    let r = this.rulesCache.get(key);
    if (!r) {
      r = { ...CS_DEFAULT_RULES };
      for (const v of this.rulesVersions) if (v.valid_from <= key) r = { ...r, ...v.rules } as CsRules;
      this.rulesCache.set(key, r);
    }
    return r;
  }

  // ---------------------------------------------------------- regras do ciclo
  /** sql_passou_trial(): em trial agora ou graduou com o mês de trial preenchido. */
  passouTrial = (c: CsDataClient) => c.kind === "TRIAL" || c.trial_month !== null;
  /** O mês em que o cliente graduou: entrada + (MesTrial − 1) meses. */
  gradMonth = (c: CsDataClient) =>
    c.trial_month === null ? null : monthStart(addMonths(c.entry_date, c.trial_month - 1));
  /** sql_eh_m1() */
  isM1(y: CsDataCycle) {
    const c = this.clientOf(y.client);
    return !y.m1_discounted && this.passouTrial(c) && y.month === this.firstMonth.get(c.id) &&
      ym(c.entry_date) === ym(y.month);
  }
  /** O desconto da comissão M1 deste ciclo (0 se não for M1). */
  m1(y: CsDataCycle) {
    return this.isM1(y) ? this.rules(y.month).m1_commission : 0;
  }
  /** sql_valor_efetivo() */
  vef = (y: CsDataCycle) => Math.max(0, y.paid - this.m1(y));
  /** Provável efetivo (M1 dos dois lados — provavel_recebido_data). */
  provEf = (y: CsDataCycle) => Math.max(0, y.probable - this.m1(y));
  /** sql_eh_pagante(): pagou algo. */
  isPayer = (y: CsDataCycle) => y.paid > 0;
  /** sql_eh_pagante_efetivo(): denominador do ticket. */
  isEffectivePayer = (y: CsDataCycle) => (y.status === "PAGO" || y.status === "PARCIAL") && y.paid > this.m1(y);
  /** sql_fase_ciclo(): fase histórica, ignorando ACL. */
  phase(y: CsDataCycle): CsKind {
    const c = this.clientOf(y.client);
    if (c.kind === "TRIAL") return "TRIAL";
    const g = this.gradMonth(c);
    if (g !== null && y.month < g) return "TRIAL";
    return c.kind;
  }
  /** sql_categoria_ciclo() */
  category(y: CsDataCycle): CsKind | "ACL" {
    const v = this.vef(y);
    if (y.acl && (y.acl_value === null || y.acl_value >= v)) return "ACL";
    return this.phase(y);
  }
  /** sql_valor_acl_efetivo() */
  aclEf(y: CsDataCycle) {
    if (!y.acl) return 0;
    const v = this.vef(y);
    return Math.min(v, y.acl_value ?? v);
  }
  /** sql_squad(): o squad do ciclo (nulo = o atual do cliente). */
  cycleSquad = (y: CsDataCycle) => y.squad_id ?? this.clientOf(y.client).squad_id;

  /** sql_squad_no_mes(): o squad do cliente NAQUELE mês. */
  squadInMonth(c: CsDataClient, m: string) {
    const month = monthStart(m);
    const key = `${c.id}|${month}`;
    const hit = this.squadMonthCache.get(key);
    if (hit) return hit;
    const list = this.cyclesOfClient(c.id);
    let pick = list.find((y) => y.month === month);
    if (!pick) for (let i = list.length - 1; i >= 0; i--) if (list[i].month < month) { pick = list[i]; break; }
    if (!pick) pick = list.find((y) => y.month > month);
    const s = pick ? pick.squad_id ?? c.squad_id : c.squad_id;
    this.squadMonthCache.set(key, s);
    return s;
  }

  /** sql_ativo_no_mes(): na carteira no fim do mês, só pelas datas. */
  activeIn(c: CsDataClient, m: string) {
    const ld = lastDay(m);
    return c.entry_date <= ld && (c.churn_date === null || c.churn_date > ld ||
      (c.reactivation_date !== null && c.reactivation_date > c.churn_date && c.reactivation_date <= ld));
  }

  dimOk = (c: CsDataClient, dim: CsDim) =>
    dim === "tudo" || (dim === "trial" ? c.kind === "TRIAL" : c.kind === "BASE" || c.kind === "BASE_RA");
  /** filtros_where_compose($f, 'c', true): squad do ciclo + dimensão. */
  cycleOk = (y: CsDataCycle, f: { squad_id: string | null; dim: CsDim }) =>
    (f.squad_id === null || this.cycleSquad(y) === f.squad_id) && this.dimOk(this.clientOf(y.client), f.dim);
  /** filtros_where_squad($f,'c'): squad do cliente no mês de referência. */
  squadOk = (c: CsDataClient, squad: string | null, m: string) => squad === null || this.squadInMonth(c, m) === squad;

  /** Média do valor efetivo não nulo dos ciclos pagos a partir de `from` (AVG(NULLIF(vef,0))). */
  avgVefSince(client: string, from: string) {
    return avg(this.cyclesOfClient(client).filter((y) => y.month >= from && y.paid > 0).map(this.vef).filter((v) => v !== 0));
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

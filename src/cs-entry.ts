import { rpc } from "./api";
import {
  addMonths,
  monthStart,
  type CsAdimp,
  type CsBand,
  type CsDataClient,
  type CsPayStatus,
  type CsProb,
  type CsRules,
} from "./cs-engine";
import { demoCsData } from "./cs-dashboard";
import { rulesAt } from "./cs";

/**
 * O lançamento de CS no MAVI (fase 5, migração 20270525090000): a grade do
 * mês (ciclos, Health Score), o cadastro, as metas, o "Abrir mês", o
 * histórico e a chave "Fonte: MAVI". Enquanto a fonte é a planilha, a tela
 * é só prévia.
 */

export type CsEntryAccess = {
  source: "sheet" | "mavi";
  source_changed_at: string | null;
  source_changed_by: string | null;
  has_sheet: boolean;
  can_switch: boolean;
  is_leader: boolean;
  scope: { scope: "all" } | { scope: "squads"; squads: string[] };
  today: string;
};
export type EntryPayment = { ord: number; date: string; amount: number };
export type EntryCycle = {
  id: string;
  cs_client_id: string;
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
  notes: string | null;
  source: "sheet" | "import" | "app";
  updated_at: string;
  payments: EntryPayment[];
};
export type HsKey = "goal" | "perception" | "payment" | "meeting" | "creatives";
export type EntryHs = Record<HsKey, boolean> & {
  cs_client_id: string;
  month: string;
  manual_score: number | null;
  score: number;
  band: CsBand;
  notes: string | null;
  source: "sheet" | "import" | "app";
};
export type EntryClient = CsDataClient & { client_name: string | null; active: boolean };
export type EntryGoal = { squad_id: string; month: string; revenue: number; retention_pct: number | null; ticket: number | null };
export type EntrySquad = { id: string; name: string; color: string; archived: boolean };
export type EntryMonth = {
  month: string;
  access: CsEntryAccess;
  squads: EntrySquad[];
  clients: EntryClient[];
  cycles: EntryCycle[];
  previous: { cs_client_id: string; probable: number; paid: number; status: CsPayStatus }[];
  hs: EntryHs[];
  goals: EntryGoal[];
  rules: CsRules;
};
export type CsEditLog = {
  id: number;
  entity: "source" | "client" | "cycle" | "hs" | "goal" | "month";
  action: "insert" | "update" | "delete";
  cs_client_id: string | null;
  client_name: string | null;
  month: string | null;
  squad_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  at: string;
  by_name: string | null;
};
export type OpenMonthItem = {
  cs_client_id: string;
  external_id: string;
  name: string;
  squad_id: string | null;
  kind: string;
  from_previous: boolean;
  best: number;
  probable: number;
  probability: CsProb;
  start_date: string | null;
  end_date: string | null;
  billing_date: string | null;
  fee_planned: number | null;
};
export type OpenMonth = { month: string; items: OpenMonthItem[]; created: number };
/** O que pode vir num lançamento de ciclo (só os campos que mudaram). */
export type CycleFields = Partial<Omit<EntryCycle, "id" | "cs_client_id" | "month" | "source" | "updated_at" | "payments">> & {
  payments?: { date: string; amount: number }[];
};
export type ClientFields = Partial<Omit<CsDataClient, "id">>;

export type CsEntryBackend = {
  access: (company: string) => Promise<CsEntryAccess>;
  month: (company: string, month: string) => Promise<EntryMonth>;
  saveCycle: (company: string, client: string, month: string, fields: CycleFields) => Promise<EntryCycle>;
  deleteCycle: (company: string, client: string, month: string, reason: string) => Promise<void>;
  saveHs: (company: string, client: string, month: string, fields: Partial<EntryHs>) => Promise<EntryHs>;
  saveClient: (company: string, id: string | null, fields: ClientFields) => Promise<CsDataClient>;
  deleteClient: (company: string, id: string, reason: string) => Promise<void>;
  saveGoal: (company: string, squad: string, month: string, revenue: number | null, retention: number | null,
    ticket: number | null) => Promise<EntryGoal | null>;
  openMonth: (company: string, month: string, confirm: boolean) => Promise<OpenMonth>;
  log: (company: string, client: string | null, limit?: number) => Promise<CsEditLog[]>;
  setSource: (company: string, source: "sheet" | "mavi", reason: string) => Promise<CsEntryAccess>;
};

export const realEntry: CsEntryBackend = {
  access: (c) => rpc("cs_entry_access", { p_company: c }) as Promise<CsEntryAccess>,
  month: (c, m) => rpc("cs_entry_month", { p_company: c, p_month: m }) as Promise<EntryMonth>,
  saveCycle: (c, k, m, f) => rpc("save_cs_cycle", { p_company: c, p_client: k, p_month: m, p_fields: f }) as Promise<EntryCycle>,
  deleteCycle: async (c, k, m, reason) => {
    await rpc("delete_cs_cycle", { p_company: c, p_client: k, p_month: m, p_reason: reason });
  },
  saveHs: (c, k, m, f) => rpc("save_cs_hs", { p_company: c, p_client: k, p_month: m, p_fields: f }) as Promise<EntryHs>,
  saveClient: (c, id, f) => rpc("save_cs_client", { p_company: c, p_id: id, p_fields: f }) as Promise<CsDataClient>,
  deleteClient: async (c, id, reason) => {
    await rpc("delete_cs_client", { p_company: c, p_id: id, p_reason: reason });
  },
  saveGoal: (c, s, m, revenue, retention, ticket) =>
    rpc("save_cs_goal", { p_company: c, p_squad: s, p_month: m, p_revenue: revenue, p_retention: retention, p_ticket: ticket }) as
      Promise<EntryGoal | null>,
  openMonth: (c, m, confirm) => rpc("cs_open_month", { p_company: c, p_month: m, p_confirm: confirm }) as Promise<OpenMonth>,
  log: (c, k, limit = 100) => rpc("cs_edit_log_list", { p_company: c, p_client: k, p_limit: limit }) as Promise<CsEditLog[]>,
  setSource: (c, source, reason) => rpc("set_cs_source", { p_company: c, p_source: source, p_reason: reason }) as Promise<CsEntryAccess>,
};

// ------------------------------------------------------------ regras da grade
/** Pode lançar para o squad? (fonte MAVI; líder, ou o squad é da pessoa). */
export function canEdit(access: CsEntryAccess, squad: string | null | undefined) {
  if (access.source !== "mavi") return false;
  if (access.scope.scope === "all") return true;
  return !!squad && access.scope.squads.includes(squad);
}

/** Um valor em reais digitado ("1.234,56", "R$ 1234", "1234.5"): nulo se vazio, NaN se não é número. */
export function parseMoney(text: string): number | null {
  const t = text.replace(/R\$|\s/g, "");
  if (!t) return null;
  if (/^-?\d+(,\d{1,2})?$/.test(t) || /^-?\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t))
    return Number(t.replace(/\./g, "").replace(",", "."));
  if (/^-?\d+\.\d{1,2}$/.test(t) || /^-?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) return Number(t.replace(/,/g, ""));
  return NaN;
}

/** Uma data digitada (dd/mm/aaaa, dd/mm — no ano do mês — ou AAAA-MM-DD): nulo se vazio, undefined se inválida. */
export function parseDate(text: string, month: string): string | null | undefined {
  const t = text.trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (br) {
    d = Number(br[1]);
    m = Number(br[2]);
    y = br[3] ? Number(br[3].length === 2 ? `20${br[3]}` : br[3]) : Number(month.slice(0, 4));
  } else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

/** O cliente está na carteira no mês? (mavi_private.cs_active_in) */
export function activeIn(k: Pick<CsDataClient, "entry_date" | "churn_date" | "reactivation_date">, month: string) {
  const end = addMonths(month, 1).slice(0, 8) + "01";
  const last = new Date(Date.parse(end) - 86_400_000).toISOString().slice(0, 10);
  return k.entry_date <= last && (!k.churn_date || k.churn_date > last ||
    (!!k.reactivation_date && k.reactivation_date > k.churn_date && k.reactivation_date <= last));
}

export type GridRow = {
  client: EntryClient;
  cycle: EntryCycle | null;
  hs: EntryHs | null;
  previous: EntryMonth["previous"][number] | null;
  /** O squad do mês: o do ciclo, ou o atual do cliente. */
  squad: string;
};
/** As linhas da grade: quem está na carteira no mês ou tem ciclo nele, por squad e nome. */
export function gridRows(m: EntryMonth, squad: string | null, query = ""): GridRow[] {
  const cycles = new Map(m.cycles.map((y) => [y.cs_client_id, y]));
  const hs = new Map(m.hs.map((h) => [h.cs_client_id, h]));
  const prev = new Map(m.previous.map((p) => [p.cs_client_id, p]));
  const order = new Map(m.squads.map((s, i) => [s.id, i]));
  const q = query.trim().toLocaleLowerCase("pt-BR");
  return m.clients
    .filter((c) => c.active || cycles.has(c.id))
    .map((c) => {
      const cycle = cycles.get(c.id) ?? null;
      return { client: c, cycle, hs: hs.get(c.id) ?? null, previous: prev.get(c.id) ?? null, squad: cycle?.squad_id ?? c.squad_id };
    })
    .filter((r) => (!squad || r.squad === squad) &&
      (!q || r.client.name.toLocaleLowerCase("pt-BR").includes(q) || r.client.external_id.includes(q)))
    .sort((a, b) => (order.get(a.squad) ?? 99) - (order.get(b.squad) ?? 99) ||
      a.client.name.localeCompare(b.client.name, "pt-BR", { sensitivity: "base" }));
}

/** A nota de HS com as regras do mês (mavi_private.cs_health_score_calc). */
export function hsScore(h: Partial<Record<HsKey, boolean>> & { manual_score?: number | null }, rules: CsRules) {
  const keys: HsKey[] = ["goal", "perception", "payment", "meeting", "creatives"];
  const any = keys.some((k) => h[k]);
  const score = !any && (h.manual_score ?? 0) > 0 ? h.manual_score! :
    Math.min(100, keys.reduce((s, k) => s + (h[k] ? rules.hs_weights[k] : 0), 0));
  const band: CsBand = score >= rules.hs_bands.satisfied ? "SATISFEITO" : score >= rules.hs_bands.alert ? "ALERTA" : "CRITICO";
  return { score, band };
}

const FIELD_LABEL: Record<string, string> = {
  squad_id: "squad", start_date: "início", end_date: "fim", billing_date: "cobrança", best: "melhor", probable: "provável",
  probability: "probabilidade", paid: "pago", paid_date: "data do pagamento", status: "status", adimplencia: "adimplência",
  acl: "ACL", acl_value: "valor ACL", fee_planned: "mensalidade prevista", fee_paid: "mensalidade paga", notes: "observações",
  goal: "meta batida", perception: "percepção de valor", payment: "pagamento em dia", meeting: "reunião", creatives: "criativos",
  manual_score: "nota digitada", score: "nota", band: "faixa", external_id: "ID", name: "nome", vertical: "vertical",
  origin: "origem", kind: "tipo", trial_month: "mês de trial", entry_date: "entrada", churn_date: "churn",
  reactivation_date: "reativação", churn_reason: "motivo do churn", revenue: "meta", retention_pct: "retenção", ticket: "ticket",
};
const SKIP = new Set(["id", "company_id", "cs_client_id", "month", "source", "updated_at", "created_at", "client_id", "link_mode",
  "link_rule", "linked_by", "linked_at", "m1_discounted"]);
const shown = (v: unknown) =>
  v === null || v === undefined || v === "" ? "—" : v === true ? "sim" : v === false ? "não"
    : typeof v === "number" ? v.toLocaleString("pt-BR", { maximumFractionDigits: 2 })
      : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${String(v).slice(8, 10)}/${String(v).slice(5, 7)}/${String(v).slice(0, 4)}` : String(v);
/** O que mudou num lançamento do histórico ("provável: 5.000 → 4.000"). */
export function logChanges(before: unknown, after: unknown, squadName: (id: string) => string = (id) => id): string[] {
  const a = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const b = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  const fmt = (k: string, v: unknown) => (k === "squad_id" && typeof v === "string" ? squadName(v) : shown(v));
  const num = (v: unknown) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !SKIP.has(k) && JSON.stringify(num(a[k]) ?? null) !== JSON.stringify(num(b[k]) ?? null))
    .filter((k) => before || (b[k] !== null && b[k] !== false && b[k] !== 0 && b[k] !== ""))
    .map((k) => (before && after ? `${FIELD_LABEL[k] ?? k}: ${fmt(k, num(a[k]))} → ${fmt(k, num(b[k]))}` : `${FIELD_LABEL[k] ?? k}: ${fmt(k, num(before ? a[k] : b[k]))}`));
}

// ------------------------------------------------------------ demonstração
let demoState: {
  source: "sheet" | "mavi";
  changed: { at: string; by: string } | null;
  clients: CsDataClient[];
  cycles: EntryCycle[];
  hs: EntryHs[];
  goals: EntryGoal[];
  log: CsEditLog[];
} | null = null;

/** A demonstração: a carteira de exemplo do painel CS Make, na memória do navegador. */
export function demoEntry(): CsEntryBackend {
  const base = demoCsData();
  if (!demoState) {
    const pays = new Map<string, EntryPayment[]>();
    for (const p of base.payments) (pays.get(p.cycle) ?? pays.set(p.cycle, []).get(p.cycle)!).push({ ord: p.ord, date: p.date, amount: p.amount });
    demoState = {
      source: "sheet",
      changed: null,
      clients: structuredClone(base.clients),
      cycles: base.cycles.map((y) => ({ ...y, cs_client_id: y.client, notes: null, source: "sheet", updated_at: base.today,
        payments: pays.get(y.id) ?? [] })),
      hs: base.hs.map((h) => ({ ...h, cs_client_id: h.client, manual_score: null, notes: null, source: "sheet" })),
      goals: base.goals.map((g) => ({ ...g })),
      log: [],
    };
  }
  const st = demoState;
  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 120));
  const fail = (msg: string) => Promise.reject(new Error(msg));
  const access = (): CsEntryAccess => ({
    source: st.source, source_changed_at: st.changed?.at ?? null, source_changed_by: st.changed?.by ?? null, has_sheet: true,
    can_switch: true, is_leader: true, scope: { scope: "all" }, today: base.today,
  });
  const rules = (m: string) => rulesAt(base.rules, m);
  const log = (e: Omit<CsEditLog, "id" | "at" | "by_name" | "client_name">) =>
    st.log.unshift({ ...e, id: st.log.length + 1, at: new Date().toISOString(), by_name: "Você",
      client_name: st.clients.find((c) => c.id === e.cs_client_id)?.name ?? null });
  const guard = () => (st.source !== "mavi" ? "A fonte de CS ainda é a planilha: lance lá." : null);
  const changed = () => {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("mavi:cs", { detail: { scope: "entry" } }));
  };
  return {
    access: () => later(access()),
    month: (_c, month) => {
      const m = monthStart(month);
      const prev = addMonths(m, -1);
      return later<EntryMonth>({
        month: m,
        access: access(),
        squads: base.squads.map((s) => ({ id: s.id, name: s.name, color: s.color, archived: s.archived })),
        clients: st.clients.map((c) => ({ ...c, client_name: null, active: activeIn(c, m) })),
        cycles: st.cycles.filter((y) => y.month === m),
        previous: st.cycles.filter((y) => y.month === prev).map((y) => ({ cs_client_id: y.cs_client_id, probable: y.probable, paid: y.paid,
          status: y.status })),
        hs: st.hs.filter((h) => h.month === m),
        goals: st.goals.filter((g) => g.month === m),
        rules: rules(m),
      });
    },
    saveCycle: (_c, client, month, f) => {
      const g = guard();
      if (g) return fail(g);
      const m = monthStart(month);
      const k = st.clients.find((c) => c.id === client)!;
      let y = st.cycles.find((x) => x.cs_client_id === client && x.month === m);
      const before = y ? structuredClone(y) : null;
      if (!y) {
        y = { id: `y${Date.now()}`, cs_client_id: client, month: m, squad_id: k.squad_id, start_date: null, end_date: null,
          billing_date: null, best: 0, probable: 0, probability: "PROVAVEL", paid: 0, paid_date: null, status: "PENDENTE",
          adimplencia: "ADIMPLENTE", acl: false, acl_value: null, fee_planned: null, fee_paid: null, m1_discounted: false, notes: null,
          source: "app", updated_at: "", payments: [] };
        st.cycles.push(y);
      }
      const { payments, ...rest } = f;
      Object.assign(y, rest, { source: "app", updated_at: new Date().toISOString() });
      if (!y.acl) y.acl_value = null;
      if (!payments && ("paid" in f || "paid_date" in f)) y.payments = [];
      if (payments) {
        const ok = payments.filter((p) => p.amount > 0 && p.date).sort((a, b) => a.date.localeCompare(b.date));
        y.payments = ok.map((p, i) => ({ ord: i + 1, date: p.date, amount: p.amount }));
        if (ok.length) {
          y.paid = ok.reduce((s, p) => s + p.amount, 0);
          y.paid_date = ok[0].date;
        }
      }
      log({ entity: "cycle", action: before ? "update" : "insert", cs_client_id: client, month: m, squad_id: y.squad_id, before,
        after: structuredClone(y), reason: null });
      changed();
      return later(y);
    },
    deleteCycle: (_c, client, month, reason) => {
      const g = guard();
      if (g) return fail(g);
      const y = st.cycles.find((x) => x.cs_client_id === client && x.month === monthStart(month));
      st.cycles = st.cycles.filter((x) => x !== y);
      log({ entity: "cycle", action: "delete", cs_client_id: client, month: monthStart(month), squad_id: y?.squad_id ?? null,
        before: y, after: null, reason });
      changed();
      return later(undefined);
    },
    saveHs: (_c, client, month, f) => {
      const g = guard();
      if (g) return fail(g);
      const m = monthStart(month);
      let h = st.hs.find((x) => x.cs_client_id === client && x.month === m);
      const before = h ? structuredClone(h) : null;
      if (!h) {
        h = { cs_client_id: client, month: m, goal: false, perception: false, payment: false, meeting: false, creatives: false,
          manual_score: null, score: 0, band: "CRITICO", notes: null, source: "app" };
        st.hs.push(h);
      }
      Object.assign(h, f, { source: "app" }, hsScore({ ...h, ...f }, rules(m)));
      log({ entity: "hs", action: before ? "update" : "insert", cs_client_id: client, month: m, squad_id: null, before,
        after: structuredClone(h), reason: null });
      changed();
      return later(h);
    },
    saveClient: (_c, id, f) => {
      const g = guard();
      if (g) return fail(g);
      if (f.external_id && st.clients.some((c) => c.id !== id && c.external_id === f.external_id))
        return fail("Já existe um cliente de CS com esse ID.");
      let k = id ? st.clients.find((c) => c.id === id) : undefined;
      const before = k ? structuredClone(k) : null;
      if (!k) {
        if (!f.external_id || !f.name || !f.squad_id || !f.entry_date) return fail("Informe o ID, o nome, o squad e a entrada.");
        k = { id: `cs-n${Date.now()}`, external_id: "", name: "", squad_id: "", vertical: null, origin: "comercial", kind: "BASE",
          trial_month: null, status: "ATIVO", entry_date: "", churn_date: null, reactivation_date: null, churn_reason: null, notes: null };
        st.clients.push(k);
      }
      Object.assign(k, f);
      log({ entity: "client", action: before ? "update" : "insert", cs_client_id: k.id, month: null, squad_id: k.squad_id, before,
        after: structuredClone(k), reason: null });
      changed();
      return later(k);
    },
    deleteClient: (_c, id, reason) => {
      const g = guard();
      if (g) return fail(g);
      const k = st.clients.find((c) => c.id === id);
      st.clients = st.clients.filter((c) => c.id !== id);
      st.cycles = st.cycles.filter((y) => y.cs_client_id !== id);
      st.hs = st.hs.filter((h) => h.cs_client_id !== id);
      log({ entity: "client", action: "delete", cs_client_id: null, month: null, squad_id: k?.squad_id ?? null, before: k, after: null,
        reason });
      changed();
      return later(undefined);
    },
    saveGoal: (_c, squad, month, revenue, retention, ticket) => {
      const g = guard();
      if (g) return fail(g);
      const m = monthStart(month);
      const before = st.goals.find((x) => x.squad_id === squad && x.month === m) ?? null;
      st.goals = st.goals.filter((x) => x !== before);
      const goal = revenue === null ? null : { squad_id: squad, month: m, revenue, retention_pct: retention, ticket };
      if (goal) st.goals.push(goal);
      log({ entity: "goal", action: !before ? "insert" : goal ? "update" : "delete", cs_client_id: null, month: m, squad_id: squad,
        before, after: goal, reason: null });
      changed();
      return later(goal);
    },
    openMonth: (_c, month, confirm) => {
      const g = guard();
      if (g) return fail(g);
      const m = monthStart(month);
      const prev = addMonths(m, -1);
      const shift = (d: string | null) => (d ? addMonths(d, 1) : null);
      const items: OpenMonthItem[] = st.clients
        .filter((k) => activeIn(k, m) && !st.cycles.some((y) => y.cs_client_id === k.id && y.month === m))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
        .map((k) => {
          const p = st.cycles.find((y) => y.cs_client_id === k.id && y.month === prev);
          return { cs_client_id: k.id, external_id: k.external_id, name: k.name, squad_id: p?.squad_id ?? k.squad_id, kind: k.kind,
            from_previous: !!p, best: p?.best ?? 0, probable: p?.probable ?? 0, probability: p?.probability ?? "PROVAVEL",
            start_date: shift(p?.start_date ?? null), end_date: shift(p?.end_date ?? null), billing_date: shift(p?.billing_date ?? null),
            fee_planned: p?.fee_planned ?? null };
        });
      if (!confirm) return later({ month: m, items, created: 0 });
      for (const it of items)
        st.cycles.push({ id: `y${it.cs_client_id}${m}`, cs_client_id: it.cs_client_id, month: m, squad_id: it.squad_id,
          start_date: it.start_date, end_date: it.end_date, billing_date: it.billing_date, best: it.best, probable: it.probable,
          probability: it.probability, paid: 0, paid_date: null, status: "PENDENTE", adimplencia: "ADIMPLENTE", acl: false,
          acl_value: null, fee_planned: it.fee_planned, fee_paid: null, m1_discounted: false, notes: null, source: "app",
          updated_at: new Date().toISOString(), payments: [] });
      if (items.length)
        log({ entity: "month", action: "insert", cs_client_id: null, month: m, squad_id: null, before: null,
          after: { created: items.length }, reason: null });
      changed();
      return later({ month: m, items, created: items.length });
    },
    log: (_c, client, limit = 100) => later(st.log.filter((l) => !client || l.cs_client_id === client).slice(0, limit)),
    setSource: (_c, source, reason) => {
      if (reason.trim().length < 3) return fail("Diga o motivo da troca.");
      log({ entity: "source", action: "update", cs_client_id: null, month: null, squad_id: null, before: st.source, after: source,
        reason });
      st.source = source;
      st.changed = { at: new Date().toISOString(), by: "Você" };
      changed();
      return later(access());
    },
  };
}

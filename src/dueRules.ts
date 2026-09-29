import type { CalendarDay, Snapshot, TaskDueRule } from "./types";

/**
 * Default due dates, as the database computes them (migration
 * 20261126120000_task_due_rules): the form shows them right away and the
 * database, which has the last word, does the same math.
 *
 * Days are "YYYY-MM-DD". Saturdays, Sundays and national holidays are not
 * business days; the company adds its own days off and marks the national
 * holidays it works.
 */

const DAY = 86_400_000;
const toTime = (day: string) => Date.parse(`${day}T12:00:00Z`);
const fromTime = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => fromTime(toTime(day) + n * DAY);

/** Easter Sunday (Meeus/Jones/Butcher), as mavi_private.easter. */
export function easter(y: number) {
  const a = y % 19,
    b = Math.floor(y / 100),
    c = y % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const FIXED: Record<string, string> = {
  "01-01": "Confraternização Universal",
  "04-21": "Tiradentes",
  "05-01": "Dia do Trabalho",
  "09-07": "Independência do Brasil",
  "10-12": "Nossa Senhora Aparecida",
  "11-02": "Finados",
  "11-15": "Proclamação da República",
  "11-20": "Dia da Consciência Negra",
  "12-25": "Natal",
};

/** The national holiday on `day`, or null (as mavi_private.national_holiday). */
export function nationalHoliday(day: string): string | null {
  const md = day.slice(5);
  if (FIXED[md] && (md !== "11-20" || day >= "2024-01-01")) return FIXED[md];
  const e = easter(Number(day.slice(0, 4)));
  if (day === addDays(e, -48) || day === addDays(e, -47)) return "Carnaval";
  if (day === addDays(e, -2)) return "Sexta-feira Santa";
  if (day === addDays(e, 60)) return "Corpus Christi";
  return null;
}

/** The year's national holidays, in order. */
export function nationalHolidays(year: number) {
  const out: { day: string; name: string }[] = [];
  for (let d = `${year}-01-01`; d.startsWith(String(year)); d = addDays(d, 1)) {
    const name = nationalHoliday(d);
    if (name) out.push({ day: d, name });
  }
  return out;
}

/** The company's entry for `day` of this kind (a yearly one repeats). */
export function calendarEntry(
  calendar: CalendarDay[] | undefined,
  day: string,
  kind: CalendarDay["kind"],
) {
  return (calendar ?? []).find(
    (c) =>
      c.kind === kind &&
      (c.day === day || (c.yearly && c.day <= day && c.day.slice(5) === day.slice(5))),
  );
}

export function isBusinessDay(calendar: CalendarDay[] | undefined, day: string) {
  const weekday = new Date(toTime(day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (calendarEntry(calendar, day, "off")) return false;
  return !nationalHoliday(day) || !!calendarEntry(calendar, day, "workday");
}

/** `day` when it is a business day; otherwise the next one. */
export function nextBusinessDay(calendar: CalendarDay[] | undefined, day: string) {
  let d = day;
  while (!isBusinessDay(calendar, d)) d = addDays(d, 1);
  return d;
}

/** N business days after (or before, with N < 0). */
export function addBusinessDays(
  calendar: CalendarDay[] | undefined,
  day: string,
  n: number,
) {
  let d = day;
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) {
    d = addDays(d, step);
    if (isBusinessDay(calendar, d)) left--;
  }
  return d;
}

/** Business days from `from` to `to` (negative when `to` comes first). */
export function businessDaysBetween(
  calendar: CalendarDay[] | undefined,
  from: string,
  to: string,
) {
  if (from === to) return 0;
  const step = to > from ? 1 : -1;
  let n = 0;
  for (let d = from; d !== to; ) {
    d = addDays(d, step);
    if (isBusinessDay(calendar, d)) n += step;
  }
  return n;
}

/** Projeto › Cliente › Produto › Equipe › Pessoa (as mavi_private.due_rule_weight). */
export function ruleWeight(r: TaskDueRule) {
  return (
    (r.project_id ? 16 : 0) +
    (r.client_id ? 8 : 0) +
    (r.product_id ? 4 : 0) +
    (r.team_id ? 2 : 0) +
    (r.user_id ? 1 : 0)
  );
}

export interface DueTarget {
  contract: string;
  project?: string | null;
  /** The team the task is sent to (the person is picked by the database). */
  team?: string | null;
  /** Whoever executes it (unknown when sent to a team). */
  assignee?: string | null;
}

type RuleData = Pick<
  Snapshot,
  "contracts" | "teamMembers" | "clientTeams" | "dueRules" | "calendarDays"
>;

/**
 * The rule that applies (as mavi_private.due_rule_for). The team is the
 * task's or, without one, a team of the assignee's that serves the client;
 * a tie (two of their teams) goes to the longer rule.
 */
export function dueRuleFor(data: RuleData, target: DueTarget) {
  const k = data.contracts.find((c) => c.id === target.contract);
  if (!k) return null;
  const matches = (data.dueRules ?? []).filter(
    (r) =>
      r.active &&
      (!r.project_id || r.project_id === target.project) &&
      (!r.client_id || r.client_id === k.client_id) &&
      (!r.product_id || r.product_id === k.product_id) &&
      (!r.team_id ||
        r.team_id === target.team ||
        (!target.team &&
          data.teamMembers.some(
            (tm) => tm.team_id === r.team_id && tm.user_id === target.assignee,
          ) &&
          data.clientTeams.some(
            (ct) => ct.client_id === k.client_id && ct.team_id === r.team_id,
          ))) &&
      (!r.user_id || r.user_id === target.assignee),
  );
  matches.sort(
    (a, b) =>
      ruleWeight(b) - ruleWeight(a) ||
      b.business_days - a.business_days ||
      (a.id < b.id ? -1 : 1),
  );
  return matches[0] ?? null;
}

export interface DueSuggestion {
  rule: TaskDueRule;
  due: string;
  /** Earlier than this only with a reason. */
  min: string | null;
  /** Business days counted (the rule's plus the client approval's). */
  days: number;
}

/** What a rule gives, counting from `base` (a day off counts as the next business day). */
export function ruleDue(
  calendar: CalendarDay[] | undefined,
  rule: TaskDueRule,
  base: string,
  approval: boolean,
): DueSuggestion {
  const start = nextBusinessDay(calendar, base);
  const extra = approval ? rule.approval_days : 0;
  return {
    rule,
    due: addBusinessDays(calendar, start, rule.business_days + extra),
    min:
      rule.min_days == null
        ? null
        : addBusinessDays(calendar, start, rule.min_days + extra),
    days: rule.business_days + extra,
  };
}

/** The suggested due date for a task, or null when no rule applies. */
export function suggestDue(
  data: RuleData,
  target: DueTarget & { base: string; approval?: boolean },
): DueSuggestion | null {
  const rule = dueRuleFor(data, target);
  return rule
    ? ruleDue(data.calendarDays, rule, target.base, !!target.approval)
    : null;
}

type NameData = Pick<
  Snapshot,
  "projects" | "clients" | "products" | "teams" | "members"
>;

/** Where a rule applies, in words ("Cliente Clínica · Produto Make Ads"). */
export function ruleScope(data: NameData, r: TaskDueRule) {
  const name = (list: { id?: string; user_id?: string; name: string }[], id: string) =>
    list.find((x) => (x.id ?? x.user_id) === id)?.name ?? "—";
  const parts = [
    r.project_id && `Projeto ${name(data.projects, r.project_id)}`,
    r.client_id && `Cliente ${name(data.clients, r.client_id)}`,
    r.product_id && `Produto ${name(data.products, r.product_id)}`,
    r.team_id && `Equipe ${name(data.teams, r.team_id)}`,
    r.user_id && `Pessoa ${name(data.members, r.user_id)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Padrão da empresa";
}

export const businessDaysLabel = (n: number) =>
  n === 0 ? "no mesmo dia útil" : n === 1 ? "1 dia útil" : `${n} dias úteis`;

/**
 * Whether this person may set up a rule with this scope (as
 * mavi_private.can_manage_due_scope): admins any; managers only rules of
 * their teams, the clients those teams serve (and their projects) and the
 * people in them — and at least one of those.
 */
export function canManageDueScope(
  data: Pick<Snapshot, "members" | "teamMembers" | "clientTeams" | "projects" | "contracts">,
  user: string,
  scope: Pick<TaskDueRule, "project_id" | "client_id" | "team_id" | "user_id">,
) {
  const role = data.members.find((m) => m.user_id === user && m.active)?.role;
  if (role === "admin") return true;
  if (role !== "manager") return false;
  const myTeams = new Set(
    data.teamMembers.filter((tm) => tm.user_id === user).map((tm) => tm.team_id),
  );
  let scoped = false;
  if (scope.team_id) {
    if (!myTeams.has(scope.team_id)) return false;
    scoped = true;
  }
  const projectClient = scope.project_id
    ? data.contracts.find(
        (k) => k.id === data.projects.find((p) => p.id === scope.project_id)?.contract_id,
      )?.client_id
    : null;
  const client = scope.client_id ?? projectClient;
  if (client) {
    if (!data.clientTeams.some((ct) => ct.client_id === client && myTeams.has(ct.team_id)))
      return false;
    scoped = true;
  }
  if (scope.user_id) {
    if (
      !data.teamMembers.some(
        (tm) => tm.user_id === scope.user_id && myTeams.has(tm.team_id),
      )
    )
      return false;
    scoped = true;
  }
  return scoped;
}

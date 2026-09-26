import { supabase } from "./supabase";
import * as cache from "./cache";
import { fold, type TaskScope } from "./domain";
import {
  emptySnapshot,
  type Snapshot,
  type Task,
  type Comment,
  type Attachment,
  type TaskEvent,
  type Company,
  type Member,
  type Client,
  type Product,
  type Contract,
  type Project,
  type Team,
  type TimeEntry,
  type AppNotification,
  type TaskTemplate,
  type SuggestionSettings,
} from "./types";

export interface Filters {
  search: string;
  status: string;
  /** Leave delivered tasks out (the task list without a status filter). */
  hideDone?: boolean;
  product: string;
  mine: boolean;
  user: string;
  page: number;
  late: boolean;
  client: string;
  project: string;
  schedule?: { view: "calendar" | "gantt"; start: string; end: string };
  onlyMineOrCreated?: boolean;
  /** Leaders' list tabs: for them, created by them, their teams, others. */
  scope?: TaskScope;
}

export interface Summary {
  by_project: { id: string; total: number; done: number }[];
  total: number;
  late: number;
  review: number;
  done: number;
  minutes: number;
  by_client: { id: string; name: string; minutes: number }[];
  by_person: { id: string; name: string; tasks: number; estimated: number }[];
}

export interface CompanyLookups {
  members: Member[];
  clients: Client[];
  products: Product[];
  contracts: Contract[];
  projects: Project[];
  teams: Team[];
  teamMembers: {
    company_id: string;
    team_id: string;
    user_id: string;
    /** Validates the team's tasks in projects set to "Supervisor da equipe". */
    supervisor?: boolean;
  }[];
  clientTeams: { company_id: string; client_id: string; team_id: string }[];
  taskTemplates: TaskTemplate[];
  suggestionSettings: SuggestionSettings[];
}

/**
 * Task data changes with every move of anyone on the team, so it is kept in
 * memory only and kept current by the live notices (subscribeToCompanyChanges);
 * a copy persisted from an earlier visit would come back stale. Catalogs
 * (lookups, companies) stay in localStorage: large, rarely changed, and
 * revalidated in the background.
 */
cache.setMemoryOnly([
  "tasks:",
  "task:",
  "task_extras:",
  "task_scopes:",
  "hours:",
  "summary:",
]);

/** The most rows Supabase (PostgREST max-rows) returns per request. */
export const PAGE_ROWS = 1000;

type PagedQuery<T> = PromiseLike<{
  data: T[] | null;
  error: unknown;
  count?: number | null;
}> & { range: (from: number, to: number) => PagedQuery<T> };

/**
 * Every row of a query, read in pages: a request is silently cut at the
 * project's max-rows (1000 by default, but it can be set lower), so a single
 * call never sees past it. The first page brings the exact count and shows
 * the real page size — never assumed to be PAGE_ROWS, or a lower max-rows
 * would stop the reading at its first page. The other pages then go out a
 * few at a time. `build` must return a fresh query ordered by a unique key,
 * so pages neither overlap nor skip rows. `count` is only requested on the
 * first call.
 */
export async function fetchAllRows<T>(
  build: (count?: "exact") => PagedQuery<T>,
  concurrency = 4,
): Promise<T[]> {
  const first = await build("exact").range(0, PAGE_ROWS - 1);
  if (first.error) throw first.error;
  const rows = [...(first.data ?? [])];
  const size = rows.length;
  if (!size) return rows;
  if (first.count == null) {
    // No count: keep reading until a page comes back short.
    for (let page = first.data ?? []; page.length === size;) {
      const next = await build().range(rows.length, rows.length + size - 1);
      if (next.error) throw next.error;
      page = next.data ?? [];
      rows.push(...page);
    }
    return rows;
  }
  const starts: number[] = [];
  for (let from = size; from < first.count; from += size) starts.push(from);
  const pages: T[][] = new Array(starts.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, starts.length) }, async () => {
      while (next < starts.length) {
        const i = next++;
        const page = await build().range(starts[i], starts[i] + size - 1);
        if (page.error) throw page.error;
        pages[i] = page.data ?? [];
      }
    }),
  );
  return rows.concat(...pages);
}
const SCHEDULE_CAP = 2000;

// TTL configurations in milliseconds
export const CACHE_TTL = {
  COMPANIES: 15 * 60 * 1000, // 15 minutes
  LOOKUPS: 10 * 60 * 1000, // 10 minutes (catalogs)
  TASKS: 3 * 60 * 1000, // 3 minutes
  HOURS: 3 * 60 * 1000, // 3 minutes
  SUMMARY: 5 * 60 * 1000, // 5 minutes
  TASK_DETAIL: 5 * 60 * 1000, // 5 minutes
  TASK_EXTRAS: 2 * 60 * 1000, // 2 minutes
};

export async function rpc(name: string, args: Record<string, unknown> = {}) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

export async function companies(forceRefresh = false): Promise<Company[]> {
  if (!supabase) return [];
  return cache.fetchWithCache(
    "companies",
    async () => {
      const { data, error } = await supabase!
        .from("companies")
        .select("*")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Company[];
    },
    { ttlMs: CACHE_TTL.COMPANIES, forceRefresh },
  );
}

export async function companyLookups(
  company: string,
  forceRefresh = false,
): Promise<CompanyLookups> {
  if (!supabase) throw Error("Supabase não configurado");
  // v5: suggestion settings, and lists no longer cut at a lower max-rows;
  // bumped whenever the cached shape (or what it may hold) changes.
  const cacheKey = `lookups:v5:${company}`;

  return cache.fetchWithCache(
    cacheKey,
    async () => {
      const result: CompanyLookups = {
        members: [],
        clients: [],
        products: [],
        contracts: [],
        projects: [],
        teams: [],
        teamMembers: [],
        clientTeams: [],
        taskTemplates: [],
        suggestionSettings: [],
      };

      // Order for stable paging: by name where there is one (the order the
      // screens show), always ending in the primary key so no two rows tie.
      const tables = [
        ["members", "memberships", ["name", "user_id"]],
        ["clients", "clients", ["name", "id"]],
        ["products", "products", ["name", "id"]],
        ["contracts", "contracts", ["name", "id"]],
        ["projects", "projects", ["name", "id"]],
        ["teams", "teams", ["name", "id"]],
        ["teamMembers", "team_members", ["team_id", "user_id"]],
        ["clientTeams", "client_teams", ["client_id", "team_id"]],
        ["taskTemplates", "task_templates", ["name", "id"]],
        ["suggestionSettings", "suggestion_settings", ["company_id"]],
      ] as const;

      await Promise.all(
        tables.map(async ([key, table, keyColumns]) => {
          const rows = fetchAllRows((count) => {
            let query = supabase!
              .from(table)
              .select("*", count ? { count } : undefined)
              .eq("company_id", company);
            for (const column of keyColumns) query = query.order(column);
            return query;
          });
          // Templates and suggestions are optional: until their migrations
          // run (or if they can't be read) the app works without them.
          (result[key] as unknown) =
            key === "taskTemplates" || key === "suggestionSettings"
              ? await rows.catch(() => [])
              : await rows;
        }),
      );

      return result;
    },
    { ttlMs: CACHE_TTL.LOOKUPS, forceRefresh },
  );
}

function hashFilters(filters: Filters): string {
  return JSON.stringify({
    s: filters.search,
    st: filters.status,
    hd: filters.hideDone,
    p: filters.product,
    m: filters.mine,
    u: filters.user,
    pg: filters.page,
    l: filters.late,
    c: filters.client,
    pr: filters.project,
    sch: filters.schedule,
    mc: filters.onlyMineOrCreated,
    sc: filters.scope,
  });
}

/**
 * PostgREST `or` filter for the task search: the title, or any task whose
 * client or project name matches (resolved from the already loaded lookups,
 * ignoring case and accents).
 */
export function taskSearchFilter(
  search: string,
  lookups: Pick<CompanyLookups, "contracts" | "clients" | "projects">,
) {
  const q = fold(search);
  // Escape LIKE wildcards, then quote for PostgREST so commas and
  // parentheses typed by the user can't break the filter syntax.
  const pattern = `%${search.trim().replace(/[%_\\]/g, "\\$&")}%`;
  const parts = [`title.ilike."${pattern.replace(/["\\]/g, "\\$&")}"`];
  const clients = new Set(
    lookups.clients.filter((c) => fold(c.name).includes(q)).map((c) => c.id),
  );
  const contracts = lookups.contracts
    .filter((c) => clients.has(c.client_id))
    .map((c) => c.id);
  const projects = lookups.projects
    .filter((p) => fold(p.name).includes(q))
    .map((p) => p.id);
  if (contracts.length) parts.push(`contract_id.in.(${contracts.join(",")})`);
  if (projects.length) parts.push(`project_id.in.(${projects.join(",")})`);
  return parts.join(",");
}

type TaskLookups = Pick<
  CompanyLookups,
  "contracts" | "clients" | "projects" | "teamMembers" | "clientTeams"
>;
const emptyTaskLookups: TaskLookups = {
  contracts: [],
  clients: [],
  projects: [],
  teamMembers: [],
  clientTeams: [],
};

/** The list's filters (everything but scope, order and paging). */
function filteredTasks(
  company: string,
  filters: Filters,
  lookups: TaskLookups,
  companyTz: string,
  head = false,
) {
  let query = supabase!
    .from("tasks")
    .select(head ? "id" : "*", { count: "exact", head })
    .eq("company_id", company)
    .eq("archived", false);

  // Collaborators: RLS (tasks_read) already limits the rows to their own
  // tasks plus the ones their teams' supervision covers.

  if (filters.search.trim())
    query = query.or(taskSearchFilter(filters.search, lookups));
  if (filters.status) query = query.eq("status", filters.status);
  else if (filters.hideDone) query = query.neq("status", "done");
  if (filters.client)
    query = query.in(
      "contract_id",
      lookups.contracts
        .filter((c) => c.client_id === filters.client)
        .map((c) => c.id),
    );
  if (filters.project) query = query.eq("project_id", filters.project);
  if (filters.mine) query = query.eq("assignee_id", filters.user);
  if (filters.product) {
    const ids = lookups.contracts
      .filter((c) => c.product_id === filters.product)
      .map((c) => c.id);
    query = query.in("contract_id", ids);
  }
  if (filters.late) {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: companyTz,
    }).format(new Date());
    query = query.lt("due_date", today).neq("status", "done");
  }
  if (filters.schedule) {
    const { view, start, end } = filters.schedule;
    query = query.gte("due_date", start);
    if (view === "calendar") query = query.lte("due_date", end);
    else
      query = query.or(
        `start_date.lte.${end},and(start_date.is.null,created_at.lte.${end}T23:59:59.999Z),and(start_date.is.null,due_date.lte.${end})`,
      );
  }
  return query;
}

/**
 * Mirrors domain.taskScope on the server: assigned to the person, created by
 * them for someone else, in their teams (the task's team, or the client's
 * teams when it has none), or everything else.
 */
export function applyScope<
  Q extends {
    eq: (c: string, v: string) => Q;
    neq: (c: string, v: string) => Q;
    or: (f: string) => Q;
    contains: (c: string, v: string[]) => Q;
    not: (c: string, op: string, v: string) => Q;
  },
>(query: Q, scope: TaskScope, user: string, lookups: TaskLookups): Q {
  if (scope === "mine") return query.eq("assignee_id", user);
  if (scope === "created")
    return query.eq("creator_id", user).neq("assignee_id", user);
  const teams = [
    ...new Set(
      lookups.teamMembers
        .filter((tm) => tm.user_id === user)
        .map((tm) => tm.team_id),
    ),
  ];
  const clients = new Set(
    lookups.clientTeams
      .filter((ct) => teams.includes(ct.team_id))
      .map((ct) => ct.client_id),
  );
  const contracts = lookups.contracts
    .filter((k) => clients.has(k.client_id))
    .map((k) => k.id);
  const rest = query.neq("assignee_id", user).neq("creator_id", user);
  if (scope === "participating")
    return rest.contains("participant_ids", [user]);
  // Tasks the person takes part in have their own tab.
  const others = rest.not("participant_ids", "cs", `{${user}}`);
  if (scope === "teams") {
    const parts = [
      ...(teams.length ? [`team_id.in.(${teams.join(",")})`] : []),
      ...(contracts.length
        ? [`and(team_id.is.null,contract_id.in.(${contracts.join(",")}))`]
        : []),
    ];
    // No team at all: nothing can match.
    return parts.length
      ? others.or(parts.join(","))
      : others.eq("id", "00000000-0000-0000-0000-000000000000");
  }
  const withTeam = teams.length
    ? `and(team_id.not.is.null,team_id.not.in.(${teams.join(",")}))`
    : "team_id.not.is.null";
  const withoutTeam = contracts.length
    ? `and(team_id.is.null,contract_id.not.in.(${contracts.join(",")}))`
    : "team_id.is.null";
  return others.or(`${withTeam},${withoutTeam}`);
}

export async function tasksQuery(
  company: string,
  filters: Filters,
  lookups: TaskLookups = emptyTaskLookups,
  companyTz = "America/Sao_Paulo",
  forceRefresh = false,
): Promise<{ tasks: Task[]; count: number }> {
  if (!supabase) throw Error("Supabase não configurado");
  const cacheKey = `tasks:${company}:${hashFilters(filters)}`;

  return cache.fetchWithCache(
    cacheKey,
    async () => {
      let query = filteredTasks(company, filters, lookups, companyTz)
        .order("due_date")
        .order("id");
      if (filters.scope)
        query = applyScope(query, filters.scope, filters.user, lookups);

      const result = await query.range(
        filters.schedule ? 0 : filters.page * 50,
        filters.schedule ? SCHEDULE_CAP - 1 : filters.page * 50 + 49,
      );

      if (result.error) throw result.error;
      const tasks = (result.data ?? []) as unknown as Task[];

      if (filters.schedule && tasks.length >= SCHEDULE_CAP)
        throw Error(
          `Este período tem mais de ${SCHEDULE_CAP} tarefas e não pôde ser exibido por completo. Reduza o intervalo.`,
        );

      return { tasks, count: result.count ?? 0 };
    },
    { ttlMs: CACHE_TTL.TASKS, forceRefresh },
  );
}

/** How many tasks each scope tab holds under the current filters. */
export async function taskScopeCounts(
  company: string,
  filters: Filters,
  forceRefresh = false,
): Promise<Record<TaskScope, number>> {
  if (!supabase) throw Error("Supabase não configurado");
  const lookups = await companyLookups(company, forceRefresh);
  const base = { ...filters, scope: undefined, page: 0 };
  const cacheKey = `task_scopes:${company}:${hashFilters(base)}`;
  return cache.fetchWithCache(
    cacheKey,
    async () => {
      const companyTz =
        (await companies()).find((c) => c.id === company)?.timezone ??
        "America/Sao_Paulo";
      const scopes: TaskScope[] = [
        "mine",
        "created",
        "participating",
        "teams",
        "others",
      ];
      const counts = await Promise.all(
        scopes.map(async (scope) => {
          const { count, error } = await applyScope(
            filteredTasks(company, base, lookups, companyTz, true),
            scope,
            filters.user,
            lookups,
          );
          if (error) throw error;
          return count ?? 0;
        }),
      );
      return Object.fromEntries(
        scopes.map((scope, i) => [scope, counts[i]]),
      ) as Record<TaskScope, number>;
    },
    { ttlMs: CACHE_TTL.TASKS, forceRefresh },
  );
}

export async function companyHours(
  company: string,
  forceRefresh = false,
): Promise<TimeEntry[]> {
  if (!supabase) throw Error("Supabase não configurado");
  const cacheKey = `hours:${company}`;

  return cache.fetchWithCache(
    cacheKey,
    async () => {
      const { data, error } = await supabase!
        .from("time_entries")
        .select("*")
        .eq("company_id", company)
        .order("started_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as TimeEntry[];
    },
    { ttlMs: CACHE_TTL.HOURS, forceRefresh },
  );
}

/**
 * Seconds already tracked on a task (finished entries only), from every entry
 * the person may see — not just the company's latest entries kept in the
 * snapshot, which would undercount tasks with older work.
 */
export async function taskPastSeconds(
  company: string,
  taskId: string,
): Promise<number> {
  if (!supabase) throw Error("Supabase não configurado");
  const data = await fetchAllRows<{ started_at: string; ended_at: string }>(
    (count) =>
      supabase!
        .from("time_entries")
        .select("started_at,ended_at", count ? { count } : undefined)
        .eq("company_id", company)
        .eq("task_id", taskId)
        .not("ended_at", "is", null)
        .order("id"),
  );
  return data.reduce((sum, h) => {
    const start = Date.parse(h.started_at),
      end = Date.parse(h.ended_at!);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? sum + Math.floor((end - start) / 1000)
      : sum;
  }, 0);
}

export async function reportSummary(
  company: string,
  period: string,
  forceRefresh = false,
): Promise<Summary> {
  const cacheKey = `summary:${company}:${period}`;
  return cache.fetchWithCache(
    cacheKey,
    async () => {
      return (await rpc("report_summary", {
        p_company: company,
        p_start: new Date(period + "-01T00:00:00").toISOString(),
        p_end: new Date(
          Number(period.slice(0, 4)),
          Number(period.slice(5, 7)),
          1,
        ).toISOString(),
      })) as Summary;
    },
    { ttlMs: CACHE_TTL.SUMMARY, forceRefresh },
  );
}

/**
 * Orchestrates company lookups, tasks, and hours with dual-layer local caching.
 */
export async function snapshot(
  company: string,
  filters: Filters,
  forceRefresh = false,
): Promise<{ data: Snapshot; count: number }> {
  if (!supabase) throw Error("Supabase não configurado");

  const [companyList, lookups] = await Promise.all([
    companies(forceRefresh),
    companyLookups(company, forceRefresh),
  ]);

  const activeCompany = companyList.find((c) => c.id === company);
  const companyTz = activeCompany?.timezone ?? "America/Sao_Paulo";

  const [taskQueryResult, hours] = await Promise.all([
    tasksQuery(company, filters, lookups, companyTz, forceRefresh),
    companyHours(company, forceRefresh),
  ]);

  const data: Snapshot = {
    companies: companyList,
    members: lookups.members,
    clients: lookups.clients,
    products: lookups.products,
    contracts: lookups.contracts,
    projects: lookups.projects,
    teams: lookups.teams,
    teamMembers: lookups.teamMembers,
    clientTeams: lookups.clientTeams,
    taskTemplates: lookups.taskTemplates ?? [],
    suggestionSettings: lookups.suggestionSettings ?? [],
    tasks: taskQueryResult.tasks,
    hours,
  };

  return { data, count: taskQueryResult.count };
}

/**
 * Returns immediately cached snapshot data if available in local cache.
 * Useful for cold-start initial render without waiting for network.
 */
export function getCachedSnapshot(company: string): Snapshot | null {
  const companyList = cache.get<Company[]>("companies");
  const lookups = cache.get<CompanyLookups>(`lookups:v5:${company}`);
  if (!lookups) return null;

  const hours = cache.get<TimeEntry[]>(`hours:${company}`) ?? [];

  return {
    companies: companyList ?? [],
    members: lookups.members,
    clients: lookups.clients,
    products: lookups.products,
    contracts: lookups.contracts,
    projects: lookups.projects,
    teams: lookups.teams,
    teamMembers: lookups.teamMembers,
    clientTeams: lookups.clientTeams,
    taskTemplates: lookups.taskTemplates ?? [],
    suggestionSettings: lookups.suggestionSettings ?? [],
    tasks: [],
    hours,
  };
}

export async function taskExtras(
  id: string,
  forceRefresh = false,
): Promise<{
  comments: Comment[];
  attachments: Attachment[];
  events: TaskEvent[];
}> {
  const cacheKey = `task_extras:${id}`;
  return cache.fetchWithCache(
    cacheKey,
    async () => {
      return rpc("task_extras", { p_task: id });
    },
    { ttlMs: CACHE_TTL.TASK_EXTRAS, forceRefresh },
  );
}

export async function taskById(
  company: string,
  id: string,
  forceRefresh = false,
): Promise<Task | null> {
  const cacheKey = `task:${company}:${id}`;
  return cache.fetchWithCache(
    cacheKey,
    async () => {
      const { data, error } = await supabase!
        .from("tasks")
        .select("*")
        .eq("company_id", company)
        .eq("id", id)
        .eq("archived", false)
        .maybeSingle();
      if (error) throw error;
      return data as Task | null;
    },
    { ttlMs: CACHE_TTL.TASK_DETAIL, forceRefresh },
  );
}

export async function currentTimer(): Promise<TimeEntry | null> {
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) return null;
  const { data, error } = await supabase
    .from("time_entries")
    .select("*")
    .eq("user_id", session.session.user.id)
    .is("ended_at", null)
    .maybeSingle();
  if (error) throw error;
  return data as TimeEntry | null;
}

class SessionExpiredError extends Error {
  constructor() {
    super("Sua sessão expirou. Entre novamente para continuar.");
  }
}

/**
 * POSTs to an admin endpoint with the current access token. A token whose
 * session was ended elsewhere still passes the gateway until it expires, so a
 * 401 renews the session once and retries; a failed renewal means the person
 * must sign in again.
 */
async function postWithSession(path: string, body: unknown): Promise<Response> {
  const send = (token?: string) =>
    fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const session = await supabase?.auth.getSession();
  const res = await send(session?.data?.session?.access_token);
  if (res.status !== 401 || !supabase) return res;
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) throw new SessionExpiredError();
  return send(data.session.access_token);
}

async function parseFunctionError(
  error: unknown,
  fallback: string,
): Promise<string> {
  if (!error) return fallback;
  const err = error as { message?: string; context?: unknown };
  try {
    if (
      err.context &&
      typeof (err.context as { json?: () => Promise<{ error?: string }> })
        .json === "function"
    ) {
      const body = await (
        err.context as { json: () => Promise<{ error?: string }> }
      ).json();
      if (body?.error) return body.error;
    } else if (
      err.context &&
      typeof (err.context as { error?: string }).error === "string"
    ) {
      return (err.context as { error: string }).error;
    }
  } catch {
    /* fallback to err.message */
  }
  return err.message || fallback;
}

export async function inviteUser(
  company: string,
  email: string,
  name: string,
  role: "admin" | "manager" | "member",
  teams?: string[],
): Promise<{ user_id: string }> {
  let result: { user_id: string } | null = null;
  let apiError: Error | null = null;

  // 1. Try local dev server / Vercel API endpoint
  try {
    const res = await postWithSession("/api/invite-user", {
      company_id: company,
      email,
      name,
      role,
    });
    if (res.ok) {
      result = await res.json();
    } else if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      apiError = new Error(
        err.error || `Erro ao convidar usuário (${res.status})`,
      );
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) throw e;
    // Network or server unreachable; will fallback to direct invoke if no explicit API error
  }

  if (apiError) throw apiError;

  // 2. Direct Supabase Edge Function invoke
  if (!result) {
    if (!supabase) throw new Error("Conecte o Supabase para enviar convites.");
    const { data, error } = await supabase.functions.invoke("invite-user", {
      body: { company_id: company, email, name, role },
    });
    if (error) {
      const msg = await parseFunctionError(error, "Erro ao convidar usuário.");
      throw new Error(msg);
    }
    result = data as { user_id: string };
  }

  // 3. Assign teams if specified
  if (result?.user_id && teams && teams.length > 0) {
    try {
      await rpc("assign_user_teams", {
        p_company: company,
        p_user: result.user_id,
        p_teams: teams,
      });
    } catch {
      /* User membership was created; teams can be adjusted in settings */
    }
  }

  // 4. Invalidate lookups cache so members list updates
  invalidateLookupsCache(company);

  return result;
}

export async function resetUserPassword(
  company: string,
  userId: string,
  mode: "send_link" | "set_password" = "send_link",
  newPassword?: string,
): Promise<{ success: boolean; link?: string; message?: string }> {
  let result: { success: boolean; link?: string; message?: string } | null =
    null;
  let apiError: Error | null = null;

  try {
    const res = await postWithSession("/api/user-admin", {
      company_id: company,
      target_user_id: userId,
      action: "reset_password",
      mode,
      new_password: newPassword,
    });
    if (res.ok) {
      result = await res.json();
    } else if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      apiError = new Error(
        err.error || `Erro ao redefinir senha (${res.status})`,
      );
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) throw e;
    // Network or server unreachable; will fallback to direct invoke if no explicit API error
  }

  if (apiError) throw apiError;

  if (!result) {
    if (!supabase) throw new Error("Conecte o Supabase para gerenciar senhas.");
    const { data, error } = await supabase.functions.invoke("user-admin", {
      body: {
        company_id: company,
        target_user_id: userId,
        action: "reset_password",
        mode,
        new_password: newPassword,
      },
    });
    if (error) {
      const msg = await parseFunctionError(error, "Erro ao redefinir senha.");
      throw new Error(msg);
    }
    result = data as { success: boolean; link?: string; message?: string };
  }

  return result;
}

export async function updateUserEmail(
  company: string,
  userId: string,
  newEmail: string,
): Promise<{ success: boolean; email: string }> {
  let result: { success: boolean; email: string } | null = null;
  let apiError: Error | null = null;

  try {
    const res = await postWithSession("/api/user-admin", {
      company_id: company,
      target_user_id: userId,
      action: "update_email",
      new_email: newEmail,
    });
    if (res.ok) {
      result = await res.json();
    } else if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      apiError = new Error(
        err.error || `Erro ao atualizar e-mail (${res.status})`,
      );
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) throw e;
    // Network or server unreachable; will fallback to direct invoke if no explicit API error
  }

  if (apiError) throw apiError;

  if (!result) {
    if (!supabase)
      throw new Error("Conecte o Supabase para atualizar e-mails.");
    const { data, error } = await supabase.functions.invoke("user-admin", {
      body: {
        company_id: company,
        target_user_id: userId,
        action: "update_email",
        new_email: newEmail,
      },
    });
    if (error) {
      const msg = await parseFunctionError(error, "Erro ao atualizar e-mail.");
      throw new Error(msg);
    }
    result = data as { success: boolean; email: string };
  }

  // Invalidate lookups cache so members list updates with new email
  invalidateLookupsCache(company);

  return result;
}

/** Bans or unbans the person's Auth account to match their memberships. */
export async function syncUserAccess(
  company: string,
  userId: string,
): Promise<{ success: boolean; active: boolean }> {
  const body = {
    company_id: company,
    target_user_id: userId,
    action: "sync_access",
  };
  try {
    const res = await postWithSession("/api/user-admin", body);
    if (res.ok) return await res.json();
    if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        err.error || `Erro ao atualizar o acesso (${res.status})`,
      );
    }
  } catch (e) {
    // Only an unreachable proxy falls back to invoking the function directly.
    if (!(e instanceof TypeError)) throw e;
  }
  if (!supabase) throw new Error("Conecte o Supabase para gerenciar acessos.");
  const { data, error } = await supabase.functions.invoke("user-admin", {
    body,
  });
  if (error)
    throw new Error(
      await parseFunctionError(error, "Erro ao atualizar o acesso."),
    );
  return data as { success: boolean; active: boolean };
}

/** 'inactive' when every membership of the signed-in person was deactivated. */
export function myAccess(): Promise<"active" | "inactive" | "none"> {
  return rpc("my_access", {});
}

// Invalidation and intelligent cache update helpers
export function patchCachedTask(company: string, updatedTask: Task): void {
  // 1. Direct task cache
  cache.set(
    `task:${company}:${updatedTask.id}`,
    updatedTask,
    CACHE_TTL.TASK_DETAIL,
  );

  // 2. Update task in all cached task queries for this company
  cache.updateMatching<{ tasks: Task[]; count: number }>(
    `tasks:${company}:`,
    (_key, cached) => {
      let found = false;
      const tasks = cached.tasks.map((t) => {
        if (t.id === updatedTask.id) {
          found = true;
          return updatedTask;
        }
        return t;
      });
      return found ? { ...cached, tasks } : cached;
    },
  );

  // 3. Invalidate summary cache so stats recalculate (and the tab counts)
  invalidateSummaryCache(company);
  cache.invalidate(`task_scopes:${company}:`);
}

export function patchCachedLookups(
  company: string,
  updater: (current: CompanyLookups) => CompanyLookups,
): void {
  cache.update<CompanyLookups>(
    `lookups:v5:${company}`,
    (current) => (current ? updater(current) : null),
    CACHE_TTL.LOOKUPS,
  );
}

export function patchCachedHours(company: string, entry: TimeEntry): void {
  cache.update<TimeEntry[]>(
    `hours:${company}`,
    (current) => {
      if (!current) return [entry];
      const index = current.findIndex((h) => h.id === entry.id);
      if (index === -1) return [entry, ...current];
      const next = current.slice();
      next[index] = entry;
      return next;
    },
    CACHE_TTL.HOURS,
  );
  invalidateSummaryCache(company);
}

export function invalidateCompanyCache(company: string): void {
  cache.invalidate(`lookups:v5:${company}`);
  cache.invalidate(`tasks:${company}:`);
  cache.invalidate(`task_scopes:${company}:`);
  cache.invalidate(`hours:${company}`);
  cache.invalidate(`summary:${company}:`);
  cache.invalidate(`task:${company}:`);
}

export function invalidateLookupsCache(company: string): void {
  cache.invalidate(`lookups:v5:${company}`);
}

export function invalidateTasksCache(company: string): void {
  cache.invalidate(`tasks:${company}:`);
  cache.invalidate(`task_scopes:${company}:`);
  cache.invalidate(`hours:${company}`);
  cache.invalidate(`summary:${company}:`);
  cache.invalidate(`task:${company}:`);
}

export function invalidateHoursCache(company: string): void {
  cache.invalidate(`hours:${company}`);
  cache.invalidate(`summary:${company}:`);
}

export function invalidateSummaryCache(company: string): void {
  cache.invalidate(`summary:${company}:`);
}

export function invalidateTaskExtras(id: string): void {
  cache.remove(`task_extras:${id}`);
}

/**
 * Drops one task from every cache after it changed (here or by someone
 * else): its detail and extras, and the lists, tab counts and report
 * figures it may appear in — lists are refetched rather than patched, since
 * a changed task may now belong in different ones (another status,
 * assignee or tab).
 */
export function forgetTask(company: string, taskId: string): void {
  cache.remove(`task:${company}:${taskId}`);
  cache.remove(`task_extras:${taskId}`);
  cache.invalidate(`tasks:${company}:`);
  cache.invalidate(`task_scopes:${company}:`);
  invalidateSummaryCache(company);
}

/** Every task-related cache of the company (e.g. after missed notices). */
export function forgetTaskData(company: string): void {
  invalidateTasksCache(company);
  cache.invalidate("task_extras:");
}

/**
 * Everything cached for the company, in memory and in localStorage (lists,
 * details, comments, hours, catalogs and the companies list), so the next
 * reads come from the database ("Atualizar" on the Tarefas page).
 */
export function clearCompanyCaches(company: string): void {
  cache.invalidate(
    (key) =>
      key.includes(company) ||
      key.startsWith("task_extras:") ||
      key === "companies",
  );
}

export function clearAllCaches(): void {
  cache.clear();
}

/**
 * A notice from the database (migration live_task_sync) on the company's
 * private topic: ids only — what changed, and who is involved.
 */
export type LiveChange =
  | {
      kind: "task" | "extras" | "hours";
      op: "insert" | "update" | "delete";
      task: string;
      /** Creator, assignee and participants (before and after). */
      users: string[];
    }
  | { kind: "lookup"; table: string }
  /** Onboarding › Social Leads: something of this contracted product changed. */
  | { kind: "social_leads"; contract: string; table: string }
  /** Drive › Gravações da MAVI: a comment on a recording, or new recordings of a client. */
  | { kind: "meeting"; table: string; recording?: string; client?: string };

/**
 * Whether a task notice concerns the person: always for leaders (they see
 * every task) and team supervisors (their teams' tasks); otherwise when
 * they are among its creator, assignee and participants — before or after
 * the change — or the task is on their screen.
 */
export function liveChangeConcerns(
  change: Extract<LiveChange, { task: string }>,
  who: {
    user: string;
    isLeader: boolean;
    supervisesTeam: boolean;
    onScreen: (taskId: string) => boolean;
  },
) {
  return (
    who.isLeader ||
    who.supervisesTeam ||
    change.users.includes(who.user) ||
    who.onScreen(change.task)
  );
}

export interface RealtimeCallbacks {
  /** Whose notifications to listen to (the signed-in person). */
  user?: string;
  /** A new notification for `user` (e.g. they were mentioned). */
  onNotification?: (row: { id: string; task_id: string }) => void;
  onChange?: (change: LiveChange) => void;
  /** Back online after a drop: notices sent meanwhile were missed. */
  onResync?: () => void;
  /** Whether live notices are arriving (false: fall back to refetching). */
  onStatus?: (live: boolean) => void;
}

/**
 * Live updates for a company. The database broadcasts one small notice per
 * change on "mavi:company:<id>" (a private topic: Realtime checks that the
 * person is an active member once, when joining), so every open app hears
 * about changes without polling and without per-row policy checks per
 * subscriber. Notifications arrive the same way on the person's own topic,
 * "mavi:inbox:<company>:<user>". Nothing uses postgres_changes: while one
 * subscription is open, Realtime polls the database non-stop for it.
 */
export function subscribeToCompanyChanges(
  company: string,
  callbacks: RealtimeCallbacks = {},
): () => void {
  if (!supabase) return () => {};
  const client = supabase;
  let joined = false,
    dropped = false,
    closed = false;
  const live = client
    .channel(`mavi:company:${company}`, { config: { private: true } })
    .on("broadcast", { event: "change" }, ({ payload }) =>
      callbacks.onChange?.(payload as LiveChange),
    );
  const inbox = callbacks.user
    ? client
        .channel(`mavi:inbox:${company}:${callbacks.user}`, {
          config: { private: true },
        })
        .on("broadcast", { event: "notification" }, ({ payload }) => {
          const row = payload as {
            id: string;
            task_id: string;
            company_id: string;
          };
          if (row.company_id === company) callbacks.onNotification?.(row);
        })
    : null;
  // Private topics are authorised with the person's session token.
  void client.realtime
    .setAuth()
    .catch(() => {})
    .finally(() => {
      if (closed) return;
      inbox?.subscribe();
      live.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (joined && dropped) callbacks.onResync?.();
          joined = true;
          dropped = false;
          callbacks.onStatus?.(true);
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          dropped = true;
          if (!closed) callbacks.onStatus?.(false);
        }
      });
    });

  return () => {
    closed = true;
    void client.removeChannel(live);
    if (inbox) void client.removeChannel(inbox);
  };
}

/** The person's latest notifications, newest first. */
export async function myNotifications(
  company: string,
): Promise<AppNotification[]> {
  return ((await rpc("my_notifications", {
    p_company: company,
    p_limit: 30,
  })) ?? []) as AppNotification[];
}

/** Marks notifications as read (all of them when no ids are given). */
export async function readNotifications(company: string, ids?: string[]) {
  await rpc("read_notifications", { p_company: company, p_ids: ids ?? null });
}

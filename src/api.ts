import { supabase } from "./supabase";
import * as cache from "./cache";
import { fold } from "./domain";
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
}

const LOOKUP_CAP = 1000;
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
  // v3: team supervisors; bumped whenever the cached shape changes.
  const cacheKey = `lookups:v3:${company}`;

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
      };

      const tables = [
        ["members", "memberships"],
        ["clients", "clients"],
        ["products", "products"],
        ["contracts", "contracts"],
        ["projects", "projects"],
        ["teams", "teams"],
        ["teamMembers", "team_members"],
        ["clientTeams", "client_teams"],
      ] as const;

      await Promise.all(
        tables.map(async ([key, table]) => {
          const { data: rows, error } = await supabase!
            .from(table)
            .select("*")
            .eq("company_id", company)
            .limit(LOOKUP_CAP);
          if (error) throw error;
          if ((rows ?? []).length >= LOOKUP_CAP)
            throw Error(
              `A lista de "${table}" tem mais de ${LOOKUP_CAP} registros e não pôde ser carregada por completo. Fale com o suporte.`,
            );
          (result[key] as unknown) = rows ?? [];
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

export async function tasksQuery(
  company: string,
  filters: Filters,
  lookups: Pick<CompanyLookups, "contracts" | "clients" | "projects"> = {
    contracts: [],
    clients: [],
    projects: [],
  },
  companyTz = "America/Sao_Paulo",
  forceRefresh = false,
): Promise<{ tasks: Task[]; count: number }> {
  if (!supabase) throw Error("Supabase não configurado");
  const cacheKey = `tasks:${company}:${hashFilters(filters)}`;

  return cache.fetchWithCache(
    cacheKey,
    async () => {
      let query = supabase!
        .from("tasks")
        .select("*", { count: "exact" })
        .eq("company_id", company)
        .eq("archived", false)
        .order("due_date")
        .order("id");

      if (filters.onlyMineOrCreated && filters.user) {
        query = query.or(
          `assignee_id.eq.${filters.user},creator_id.eq.${filters.user}`,
        );
      }

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

      const result = await query.range(
        filters.schedule ? 0 : filters.page * 50,
        filters.schedule ? SCHEDULE_CAP - 1 : filters.page * 50 + 49,
      );

      if (result.error) throw result.error;
      const tasks = (result.data ?? []) as Task[];

      if (filters.schedule && tasks.length >= SCHEDULE_CAP)
        throw Error(
          `Este período tem mais de ${SCHEDULE_CAP} tarefas e não pôde ser exibido por completo. Reduza o intervalo.`,
        );

      return { tasks, count: result.count ?? 0 };
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
  const lookups = cache.get<CompanyLookups>(`lookups:v3:${company}`);
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
    const session = await supabase?.auth.getSession();
    const token = session?.data?.session?.access_token;
    const res = await fetch("/api/invite-user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ company_id: company, email, name, role }),
    });
    if (res.ok) {
      result = await res.json();
    } else if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      apiError = new Error(
        err.error || `Erro ao convidar usuário (${res.status})`,
      );
    }
  } catch {
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
    const session = await supabase?.auth.getSession();
    const token = session?.data?.session?.access_token;
    const res = await fetch("/api/user-admin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        company_id: company,
        target_user_id: userId,
        action: "reset_password",
        mode,
        new_password: newPassword,
      }),
    });
    if (res.ok) {
      result = await res.json();
    } else if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      apiError = new Error(
        err.error || `Erro ao redefinir senha (${res.status})`,
      );
    }
  } catch {
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
    const session = await supabase?.auth.getSession();
    const token = session?.data?.session?.access_token;
    const res = await fetch("/api/user-admin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        company_id: company,
        target_user_id: userId,
        action: "update_email",
        new_email: newEmail,
      }),
    });
    if (res.ok) {
      result = await res.json();
    } else if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      apiError = new Error(
        err.error || `Erro ao atualizar e-mail (${res.status})`,
      );
    }
  } catch {
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
    const session = await supabase?.auth.getSession();
    const token = session?.data?.session?.access_token;
    const res = await fetch("/api/user-admin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
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

  // 3. Invalidate summary cache so stats recalculate
  invalidateSummaryCache(company);
}

export function addCachedTask(company: string, newTask: Task): void {
  // 1. Direct task cache
  cache.set(`task:${company}:${newTask.id}`, newTask, CACHE_TTL.TASK_DETAIL);

  // 2. Prepend task to cached task queries for this company
  cache.updateMatching<{ tasks: Task[]; count: number }>(
    `tasks:${company}:`,
    (_key, cached) => {
      if (cached.tasks.some((t) => t.id === newTask.id)) return cached;
      return {
        tasks: [newTask, ...cached.tasks],
        count: cached.count + 1,
      };
    },
  );

  // 3. Invalidate summary cache
  invalidateSummaryCache(company);
}

export function removeCachedTask(company: string, taskId: string): void {
  cache.remove(`task:${company}:${taskId}`);
  cache.updateMatching<{ tasks: Task[]; count: number }>(
    `tasks:${company}:`,
    (_key, cached) => {
      const filtered = cached.tasks.filter((t) => t.id !== taskId);
      if (filtered.length === cached.tasks.length) return cached;
      return {
        tasks: filtered,
        count: Math.max(0, cached.count - 1),
      };
    },
  );
  invalidateSummaryCache(company);
}

export function patchCachedLookups(
  company: string,
  updater: (current: CompanyLookups) => CompanyLookups,
): void {
  cache.update<CompanyLookups>(
    `lookups:v3:${company}`,
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
  cache.invalidate(`lookups:v3:${company}`);
  cache.invalidate(`tasks:${company}:`);
  cache.invalidate(`hours:${company}`);
  cache.invalidate(`summary:${company}:`);
  cache.invalidate(`task:${company}:`);
}

export function invalidateLookupsCache(company: string): void {
  cache.invalidate(`lookups:v3:${company}`);
}

export function invalidateTasksCache(company: string): void {
  cache.invalidate(`tasks:${company}:`);
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

export function clearAllCaches(): void {
  cache.clear();
}

export interface RealtimeCallbacks {
  onTaskChange?: (
    task: Task,
    eventType: "INSERT" | "UPDATE" | "DELETE",
  ) => void;
  onLookupChange?: (
    table: string,
    row: unknown,
    eventType: "INSERT" | "UPDATE" | "DELETE",
  ) => void;
  onHoursChange?: (
    entry: TimeEntry,
    eventType: "INSERT" | "UPDATE" | "DELETE",
  ) => void;
  onTaskExtrasChange?: (taskId: string) => void;
}

/**
 * Subscribes to Supabase Realtime for automatic detection of new records or actions.
 * Automatically updates or invalidates the local cache and notifies listener callbacks.
 */
export function subscribeToCompanyChanges(
  company: string,
  callbacks: RealtimeCallbacks = {},
): () => void {
  if (!supabase) return () => {};

  const channelName = `mavi:realtime:${company}:${Date.now()}`;
  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "tasks",
        filter: `company_id=eq.${company}`,
      },
      (payload) => {
        const eventType = payload.eventType as "INSERT" | "UPDATE" | "DELETE";
        const task = (
          eventType === "DELETE" ? payload.old : payload.new
        ) as Task;
        if (eventType === "INSERT") {
          addCachedTask(company, task);
        } else if (eventType === "UPDATE") {
          patchCachedTask(company, task);
        } else if (eventType === "DELETE") {
          removeCachedTask(company, task.id);
        }
        callbacks.onTaskChange?.(task, eventType);
      },
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "time_entries",
        filter: `company_id=eq.${company}`,
      },
      (payload) => {
        const eventType = payload.eventType as "INSERT" | "UPDATE" | "DELETE";
        const entry = (
          eventType === "DELETE" ? payload.old : payload.new
        ) as TimeEntry;
        if (eventType !== "DELETE") {
          patchCachedHours(company, entry);
        } else {
          invalidateHoursCache(company);
        }
        callbacks.onHoursChange?.(entry, eventType);
      },
    );

  // Task extras tables: comments, attachments, task_events (histórico)
  const extrasTables = ["comments", "attachments", "task_events"];
  for (const table of extrasTables) {
    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table,
        filter: `company_id=eq.${company}`,
      },
      (payload) => {
        const row = (payload.new || payload.old) as { task_id?: string };
        if (row?.task_id) {
          invalidateTaskExtras(row.task_id);
          callbacks.onTaskExtrasChange?.(row.task_id);
        }
      },
    );
  }

  const lookupTables = [
    "clients",
    "products",
    "contracts",
    "projects",
    "teams",
    "team_members",
    "client_teams",
    "memberships",
  ];

  for (const table of lookupTables) {
    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table,
        filter: `company_id=eq.${company}`,
      },
      (payload) => {
        const eventType = payload.eventType as "INSERT" | "UPDATE" | "DELETE";
        const row = eventType === "DELETE" ? payload.old : payload.new;
        invalidateLookupsCache(company);
        callbacks.onLookupChange?.(table, row, eventType);
      },
    );
  }

  channel.subscribe();

  return () => {
    void supabase?.removeChannel(channel);
  };
}

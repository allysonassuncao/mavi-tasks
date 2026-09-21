import { supabase } from "./supabase";
import {
  emptySnapshot,
  type Snapshot,
  type Task,
  type Comment,
  type Attachment,
  type TaskEvent,
} from "./types";
export interface Filters {
  search: string;
  status: string;
  product: string;
  mine: boolean;
  user: string;
  page: number;
  late: boolean;
  client: string;
  project: string;
  schedule?: { view: "calendar" | "gantt"; start: string; end: string };
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
export async function rpc(name: string, args: Record<string, unknown> = {}) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}
export async function companies() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .order("name");
  if (error) throw error;
  return data;
}
export async function snapshot(
  company: string,
  filters: Filters,
): Promise<{ data: Snapshot; count: number }> {
  if (!supabase) throw Error("Supabase não configurado");
  const data: Snapshot = { ...emptySnapshot, companies: await companies() };
  const tables = [
    ["members", "memberships"],
    ["clients", "clients"],
    ["products", "products"],
    ["contracts", "contracts"],
    ["projects", "projects"],
    ["teams", "teams"],
    ["teamMembers", "team_members"],
    ["contractTeams", "contract_teams"],
  ] as const;
  const LOOKUP_CAP = 1000;
  await Promise.all(
    tables.map(async ([key, table]) => {
      const { data: rows, error } = await supabase!
        .from(table)
        .select("*")
        .eq("company_id", company)
        .limit(LOOKUP_CAP);
      if (error) throw error;
      // Surface truncation loudly instead of silently dropping rows past the cap.
      if ((rows ?? []).length >= LOOKUP_CAP)
        throw Error(
          `A lista de "${table}" tem mais de ${LOOKUP_CAP} registros e não pôde ser carregada por completo. Fale com o suporte.`,
        );
      (data[key] as unknown) = rows ?? [];
    }),
  );
  let query = supabase
    .from("tasks")
    .select("*", { count: "exact" })
    .eq("company_id", company)
    .eq("archived", false)
    .order("due_date")
    .order("id");
  if (filters.search)
    query = query.ilike(
      "title",
      `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`,
    );
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.client)
    query = query.in(
      "contract_id",
      data.contracts
        .filter((c) => c.client_id === filters.client)
        .map((c) => c.id),
    );
  if (filters.project) query = query.eq("project_id", filters.project);
  if (filters.mine) query = query.eq("assignee_id", filters.user);
  if (filters.product) {
    const ids = data.contracts
      .filter((c) => c.product_id === filters.product)
      .map((c) => c.id);
    query = query.in("contract_id", ids);
  }
  if (filters.late) {
    const tz =
      data.companies.find((c) => c.id === company)?.timezone ??
      "America/Sao_Paulo";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(
      new Date(),
    );
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
  const SCHEDULE_CAP = 2000;
  const [result, hours] = await Promise.all([
    query.range(
      filters.schedule ? 0 : filters.page * 50,
      filters.schedule ? SCHEDULE_CAP - 1 : filters.page * 50 + 49,
    ),
    supabase
      .from("time_entries")
      .select("*")
      .eq("company_id", company)
      .order("started_at", { ascending: false })
      .limit(100),
  ]);
  if (result.error) throw result.error;
  if (hours.error) throw hours.error;
  data.tasks = result.data as Task[];
  if (filters.schedule && data.tasks.length >= SCHEDULE_CAP)
    throw Error(
      `Este período tem mais de ${SCHEDULE_CAP} tarefas e não pôde ser exibido por completo. Reduza o intervalo.`,
    );
  data.hours = hours.data;
  return { data, count: result.count ?? 0 };
}
export async function taskExtras(id: string): Promise<{
  comments: Comment[];
  attachments: Attachment[];
  events: TaskEvent[];
}> {
  return rpc("task_extras", { p_task: id });
}

export async function taskById(
  company: string,
  id: string,
): Promise<Task | null> {
  const { data, error } = await supabase!
    .from("tasks")
    .select("*")
    .eq("company_id", company)
    .eq("id", id)
    .eq("archived", false)
    .maybeSingle();
  if (error) throw error;
  return data;
}
export async function currentTimer() {
  const { data: session } = await supabase!.auth.getSession();
  if (!session.session) return null;
  const { data, error } = await supabase!
    .from("time_entries")
    .select("*")
    .eq("user_id", session.session.user.id)
    .is("ended_at", null)
    .maybeSingle();
  if (error) throw error;
  return data as import("./types").TimeEntry | null;
}

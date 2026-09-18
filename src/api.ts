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
  await Promise.all(
    tables.map(async ([key, table]) => {
      const { data: rows, error } = await supabase!
        .from(table)
        .select("*")
        .eq("company_id", company)
        .limit(1000);
      if (error) throw error;
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
  const result = await query.range(filters.page * 50, filters.page * 50 + 49);
  if (result.error) throw result.error;
  data.tasks = result.data as Task[];
  const hours = await supabase
    .from("time_entries")
    .select("*")
    .eq("company_id", company)
    .order("started_at", { ascending: false })
    .limit(100);
  if (hours.error) throw hours.error;
  data.hours = hours.data;
  return { data, count: result.count ?? 0 };
}
export async function taskExtras(
  id: string,
): Promise<{
  comments: Comment[];
  attachments: Attachment[];
  events: TaskEvent[];
}> {
  const values = await Promise.all(
    ["comments", "attachments", "task_events"].map((t) =>
      supabase!
        .from(t)
        .select("*")
        .eq("task_id", id)
        .order("created_at", { ascending: false })
        .limit(100),
    ),
  );
  for (const value of values) if (value.error) throw value.error;
  return {
    comments: values[0].data ?? [],
    attachments: values[1].data ?? [],
    events: values[2].data ?? [],
  };
}

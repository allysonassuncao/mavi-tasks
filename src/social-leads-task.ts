import { supabase } from "./supabase";

/**
 * The Social Leads post an art task was created for ("Liberar produção"),
 * so the task can open it. Kept apart from social-leads-api so the task
 * detail doesn't load the whole module.
 */
export type TaskPost = { contract: string; month: number; post: number };

export async function postOfTask(task: string): Promise<TaskPost | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("social_leads_posts")
    .select("number, contract_id, social_leads_plans(month_number)")
    .eq("task_id", task)
    .maybeSingle();
  if (error || !data) return null;
  const plan = data.social_leads_plans as unknown as {
    month_number: number;
  } | null;
  return plan
    ? {
        contract: data.contract_id,
        month: plan.month_number,
        post: data.number,
      }
    : null;
}

/** Onboarding › Social Leads, on the client, month and post (opened). */
export function taskPostPath(p: TaskPost) {
  return `/onboarding/social-leads?${new URLSearchParams({
    contrato: p.contract,
    mes: String(p.month),
    post: String(p.post),
  })}`;
}

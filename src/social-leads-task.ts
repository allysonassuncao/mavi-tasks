import { pagePaths } from "./router";
import { SL_MODULES, type SlModule } from "./social-leads-module";
import { supabase } from "./supabase";

/**
 * The Social Leads (or Social Media) post an art task was created for
 * ("Liberar produção"), so the task can open it. Kept apart from
 * social-leads-api so the task detail doesn't load the whole module.
 */
export type TaskPost = {
  contract: string;
  month: number;
  post: number;
  module: SlModule;
};

/** The Planejamento module of a contracted product (by its product). */
export async function moduleOfContract(
  company: string,
  contract: string,
): Promise<SlModule | null> {
  if (!supabase) return null;
  const k = await supabase
    .from("contracts")
    .select("product_id")
    .eq("company_id", company)
    .eq("id", contract)
    .maybeSingle();
  if (k.error || !k.data) return null;
  const s = await supabase
    .from("social_leads_settings")
    .select("module")
    .eq("company_id", company)
    .eq("product_id", k.data.product_id)
    .maybeSingle();
  return s.error || !s.data ? null : (s.data.module as SlModule);
}

export async function postOfTask(task: string): Promise<TaskPost | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("social_leads_posts")
    .select("number, company_id, contract_id, social_leads_plans(month_number)")
    .eq("task_id", task)
    .maybeSingle();
  if (error || !data) return null;
  const plan = data.social_leads_plans as unknown as {
    month_number: number;
  } | null;
  if (!plan) return null;
  return {
    contract: data.contract_id,
    month: plan.month_number,
    post: data.number,
    module:
      (await moduleOfContract(data.company_id, data.contract_id)) ??
      "social_leads",
  };
}

/** Planejamento › Social Leads (or Social Media), on the client, month and post (opened). */
export function taskPostPath(p: TaskPost) {
  return `${pagePaths[SL_MODULES[p.module].page]}?${new URLSearchParams({
    contrato: p.contract,
    mes: String(p.month),
    post: String(p.post),
  })}`;
}

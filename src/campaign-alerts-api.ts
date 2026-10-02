import { supabase } from "./supabase";
import { driveServer } from "./drive";
import { describeRule, normalizeRule, ruleFromInput, type CampaignAlertRule } from "./campaign-alerts";

/** O que "Conferir agora" devolve: as campanhas que a regra pega, com o valor de hoje. */
export type AlertPreview = {
  checked: number;
  met: number;
  campaigns: {
    id: string;
    name: string;
    client: string;
    product: string;
    platform: string;
    ok: boolean;
    met: boolean;
    value: number | null;
    text: string;
  }[];
};
export type AlertHit = {
  id: number;
  rule_id: string;
  rule: string;
  campaign_id: string;
  campaign: string;
  client: string;
  day: string;
  detail: string;
  channel: "now" | "digest";
  created_at: string;
};
/** O que a MAVI devolve do "Descreva o aviso": a regra para revisar e um recado. */
export type AlertDraft = { rule: CampaignAlertRule; note: string };

const offline = (company: string) => !supabase || !/^[0-9a-f-]{36}$/i.test(company);
async function rpc<T>(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase!.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}
/** O que vai ao banco: só a regra (sem os rótulos e contagens da lista). */
const payload = (r: CampaignAlertRule) => {
  const { labels: _l, last_hit: _h, hits_30d: _n, applies: _a, ...rule } = normalizeRule(r);
  return rule;
};

// A demonstração guarda na memória do navegador.
let demoRules: CampaignAlertRule[] = [];

export async function loadCampaignAlerts(company: string, campaign: string | null = null) {
  if (offline(company))
    return structuredClone(demoRules).map((r) => ({
      ...r,
      ...(campaign ? { applies: !r.campaign_id || r.campaign_id === campaign } : {}),
    }));
  return rpc<CampaignAlertRule[]>("campaign_alert_rules", { p_company: company, p_campaign: campaign });
}
export async function saveCampaignAlert(company: string, rule: CampaignAlertRule) {
  if (offline(company)) {
    const saved = { ...normalizeRule(rule), id: rule.id ?? `demo-alert-${Date.now()}`, hits_30d: 0, last_hit: null };
    demoRules = [...demoRules.filter((r) => r.id !== saved.id), saved];
    return structuredClone(saved);
  }
  return rpc<CampaignAlertRule>("save_campaign_alert_rule", { p_company: company, p_rule: payload(rule) });
}
export async function deleteCampaignAlert(company: string, id: string) {
  if (offline(company)) {
    demoRules = demoRules.filter((r) => r.id !== id);
    return;
  }
  await rpc("delete_campaign_alert_rule", { p_company: company, p_rule: id });
}
export async function previewCampaignAlert(company: string, rule: CampaignAlertRule): Promise<AlertPreview> {
  if (offline(company)) return { checked: 0, met: 0, campaigns: [] };
  return rpc<AlertPreview>("campaign_alert_preview", { p_company: company, p_rule: payload(rule), p_limit: 100 });
}
export async function loadAlertHistory(company: string, rule: string | null = null) {
  if (offline(company)) return [] as AlertHit[];
  return rpc<AlertHit[]>("campaign_alert_history", { p_company: company, p_rule: rule, p_limit: 100 });
}

/**
 * "Descreva o aviso": a MAVI transforma o texto numa regra para a pessoa
 * revisar (ação "campaign-alert-mavi" de /api/drive). Nada é gravado.
 */
export async function draftCampaignAlert(
  company: string,
  input: { text: string; campaign: string | null; current: CampaignAlertRule | null },
): Promise<AlertDraft> {
  if (offline(company)) throw Error("A MAVI não está disponível na demonstração.");
  const data = await driveServer<{ rule?: unknown; note?: string }>({
    action: "campaign-alert-mavi",
    company,
    text: input.text,
    campaign: input.campaign,
    current: input.current ? payload(input.current) : null,
  });
  const { rule } = ruleFromInput(data.rule);
  return { rule, note: typeof data.note === "string" ? data.note : describeRule(rule) };
}

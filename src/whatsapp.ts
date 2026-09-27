import { supabase } from "./supabase";
import { fetchAllRows, rpc } from "./api";
import { fold } from "./domain";

/**
 * Drive › cliente › "Whatsapp": os grupos de WhatsApp dos clientes, trazidos
 * da Uazapi a cada 2 horas (migration 20261027150000_whatsapp_groups,
 * api/_whatsapp.ts). Aqui, a tela de ajuste de Configurações: qual cliente
 * (e quais produtos) cada grupo atende, ou se ele é ignorado.
 */

export interface WhatsappGroup {
  id: string;
  jid: string;
  title: string;
  client_id: string | null;
  product_ids: string[];
  linked_by: "auto" | "manual";
  ignored: boolean;
  last_message_at: string | null;
  synced_until: string | null;
  synced_at: string | null;
  sync_error: string | null;
  message_count: number;
}
export interface WhatsappStatus {
  configured: boolean;
  last_sweep_at: string | null;
  last_sweep_error: string | null;
  sweep_hours: number;
  backfill_days: number;
  groups_pending: number;
  groups_with_error: number;
  messages: number;
  media_pending: number;
  media_lost: number;
}

const COLUMNS =
  "id,jid,title,client_id,product_ids,linked_by,ignored,last_message_at,synced_until,synced_at,sync_error,message_count";

export async function listWhatsappGroups(
  company: string,
): Promise<WhatsappGroup[]> {
  if (!supabase) throw Error("Supabase não configurado");
  return fetchAllRows<WhatsappGroup>((count) =>
    supabase!
      .from("whatsapp_groups")
      .select(COLUMNS, count ? { count } : undefined)
      .eq("company_id", company)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id"),
  );
}

export async function whatsappGroup(company: string, id: string) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase
    .from("whatsapp_groups")
    .select(COLUMNS)
    .eq("company_id", company)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as WhatsappGroup | null;
}

export async function whatsappStatus(company: string) {
  return (await rpc("whatsapp_status", {
    p_company: company,
  })) as WhatsappStatus;
}

/** Ligar a um cliente (e produtos), ignorar ou voltar ao automático. */
export async function setWhatsappGroup(
  company: string,
  group: string,
  change:
    | { client: string | null; products: string[]; ignored: boolean }
    | { auto: true },
) {
  await rpc(
    "whatsapp_set_group",
    "auto" in change
      ? { p_company: company, p_group: group, p_auto: true }
      : {
          p_company: company,
          p_group: group,
          p_client: change.client,
          p_products: change.products,
          p_ignored: change.ignored,
          p_auto: false,
        },
  );
}

export type GroupFilter = "linked" | "unlinked" | "ignored";

export function groupFilter(g: WhatsappGroup): GroupFilter {
  if (g.ignored) return "ignored";
  return g.client_id ? "linked" : "unlinked";
}

/**
 * Os grupos de uma aba, pela busca (título, código ou nome do cliente, ou o
 * JID). Na aba "Sem cliente", os com mensagem recente primeiro — são os que
 * vale ligar antes.
 */
export function filterGroups(
  groups: WhatsappGroup[],
  filter: GroupFilter,
  query: string,
  clientName: (id: string) => string,
) {
  const q = fold(query.trim());
  return groups.filter(
    (g) =>
      groupFilter(g) === filter &&
      (!q ||
        fold(g.title).includes(q) ||
        g.jid.includes(q) ||
        (g.client_id && fold(clientName(g.client_id)).includes(q))),
  );
}

/** "Lido há 20 min", "há 3 h", "há 2 dias" (vazio sem data). */
export function ago(value: string | null, now = Date.now()) {
  if (!value) return "";
  const minutes = Math.max(
    0,
    Math.round((now - new Date(value).getTime()) / 60_000),
  );
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "há 1 dia" : `há ${days} dias`;
}

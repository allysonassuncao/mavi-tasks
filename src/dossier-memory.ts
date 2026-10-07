import { supabase } from "./supabase";

/**
 * MAVI · memória por cliente, Fase 2 (migração 20270613090000_mavi_memory_client):
 * as sugestões do dossiê que quem trabalha com o cliente confirma, contestar
 * um item (sai na hora; os líderes decidem) e os itens que uma resposta leu.
 */

export type DossierProposal = {
  id: string;
  op: "add" | "update" | "remove" | "contest" | "review";
  item_id: string | null;
  kind: "prefers" | "avoids" | "rule" | "style" | "context" | "history";
  text: string;
  previous: string | null;
  sources: { type: string; title: string; date: string | null }[];
  seen_at: string | null;
  reasons: string[];
  note: string | null;
  status: string;
  contest_reason: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
};
export type DossierLookup = {
  id: string;
  client: string;
  kind: DossierProposal["kind"];
  text: string;
  origin: "mavi" | "person";
  pinned: boolean;
  dismissed: boolean;
};

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Sem conexão com o banco.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

/** Confirmar (a mudança vale) ou recusar (não volta). */
export const decideProposal = (company: string, id: string, decision: "confirm" | "refuse") =>
  rpc<{ id: string; status: string }>("client_dossier_decide", { p_company: company, p_proposal: id, p_decision: decision });
export const proposalState = (company: string, ids: string[]) =>
  ids.length
    ? rpc<{ id: string; status: string }[]>("client_dossier_proposal_state", { p_company: company, p_ids: ids })
    : Promise.resolve([]);
/** O item está errado: sai na hora e fica com os líderes. */
export const contestItem = (company: string, item: string, reason: string) =>
  rpc<string>("client_dossier_contest", { p_company: company, p_item: item, p_reason: reason });
/** O líder decide o contestado: volta como era ou sai. */
export const resolveContest = (company: string, id: string, action: "restore" | "discard") =>
  rpc<void>("client_dossier_resolve", { p_company: company, p_proposal: id, p_action: action });
export const lookupDossier = (company: string, ids: string[]) =>
  ids.length ? rpc<DossierLookup[]>("client_dossier_lookup", { p_company: company, p_ids: ids }) : Promise.resolve([]);

/** "Novo" por 7 dias: o que a MAVI pôs sozinha (risco baixo ou médio). */
export const isNew = (i: { origin: string; created_at?: string | null }, now = Date.now()) =>
  i.origin === "mavi" && !!i.created_at && now - new Date(i.created_at).getTime() < 7 * 86400000;

export const PROPOSAL_OP: Record<string, string> = {
  add: "Novo item",
  update: "Mudar o item",
  remove: "Tirar o item",
  review: "Ainda vale?",
};

// ------------------------------------------------------------ Fase 3
/** Painel da MAVI › Memória (migração 20270614090000_mavi_memory_review). */
export type MemorySettings = {
  dossier_autonomy: boolean;
  autonomy_window: number;
  autonomy_rate: number;
  contest_limit: number;
  history_days: number;
  summary_leaders: boolean;
  updated_by: string | null;
  updated_at: string | null;
};
export type AnswerSide = { answers: number; up: number; down: number; judged: number; judged_ok: number };
export type KindAutonomy = {
  kind: DossierProposal["kind"];
  decided: number;
  confirmed: number;
  window: number;
  rate: number | null;
  contests: number;
  auto: boolean;
};
export type MemoryStats = {
  days: number;
  answers: { with?: AnswerSide; without?: AnswerSide } | null;
  person: { noted: number; undone: number; learned: number; expired: number; people: number };
  proposals: Record<string, number>;
  applied: number;
  autonomy: KindAutonomy[];
  contested: {
    id: string;
    client: string;
    client_id: string;
    kind: DossierProposal["kind"];
    text: string;
    reason: string | null;
    status: string;
    origin: string | null;
    by: string | null;
    at: string;
  }[];
  cost: Record<string, number>;
  settings: MemorySettings;
};
export const memoryStats = (company: string, days: number) =>
  rpc<MemoryStats>("mavi_memory_stats", { p_company: company, p_days: days });
export const saveMemorySettings = (company: string, settings: Partial<MemorySettings>) =>
  rpc<MemorySettings>("save_mavi_memory_settings", { p_company: company, p_settings: settings });

/** "62%" (sem base: "—"). */
export const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

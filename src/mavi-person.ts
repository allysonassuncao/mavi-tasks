import { supabase } from "./supabase";
import type { MaviReason } from "./mavi-feedback";

/**
 * MAVI · base de comportamento por pessoa (migração 20270117090000_mavi_person):
 * o que a MAVI sabe de cada pessoa para responder do jeito dela. A pessoa
 * (Meu perfil) e os administradores e gestores (Painel da MAVI › Aprendizado
 * da MAVI) veem e editam; gestor não vê administradores.
 */

export type TraitKind = "preference" | "context" | "frustration";
export const TRAIT_KINDS: { id: TraitKind; label: string; hint: string; example: string }[] = [
  {
    id: "preference",
    label: "Como prefere as respostas",
    hint: "Formato, tamanho, tom e o que sempre quer junto.",
    example: "Ex.: Responda listas de clientes em tabela, com a temperatura.",
  },
  {
    id: "context",
    label: "Contexto de trabalho",
    hint: "Clientes, produtos e assuntos em que atua; o que costuma pedir.",
    example: "Ex.: Cuida do atendimento dos clientes do Squad Primogênito.",
  },
  {
    id: "frustration",
    label: "O que evitar",
    hint: "O que frustra nas respostas.",
    example: "Ex.: Não pare no meio de pedidos longos: entregue o resultado completo.",
  },
];
export type Trait = {
  id: string;
  kind: TraitKind;
  text: string;
  origin: "mavi" | "person" | "leader";
  pinned: boolean;
  dismissed: boolean;
  updated_at: string;
  updated_by: string | null;
  /** Situação: vale 60 dias (migração 20270611090000_mavi_memory_person). */
  durability?: TraitDurability;
  valid_until?: string | null;
  expired?: boolean;
  /** De onde veio: avaliações, conferências, perguntas ou a conversa. */
  sources?: TraitSource[];
};
export type TraitDurability = "stable" | "situation";
export type TraitSource =
  | { type: "chat"; conversation?: string; said?: string; at?: string }
  | { type: "feedback"; id: number }
  | { type: "check" | "question"; message: number };
export type TraitLog = {
  action: "add" | "edit" | "retire" | "dismiss" | "restore" | "pin" | "unpin" | "renew";
  kind: TraitKind;
  before: string | null;
  after: string | null;
  actor: "mavi" | "person" | "leader";
  by: string | null;
  at: string;
};
/** Um item pelo id (o chip da resposta e o cartão "Anotei"). */
export type TraitLookup = Pick<Trait, "id" | "kind" | "text" | "origin" | "pinned" | "dismissed" | "durability" | "valid_until" | "expired"> & {
  user: string;
};
export type PersonProfile = {
  user: string;
  self: boolean;
  items: Trait[];
  facts: { role: string | null; teams: string[]; clients: { id: string; name: string; n: number }[] };
  history: {
    up: number;
    down: number;
    reasons: Record<string, number>;
    recent: { vote: "up" | "down"; reason: MaviReason | null; comment: string; question: string; at: string }[];
  };
  /** O histórico de mudanças (os mais novos primeiro). */
  log?: TraitLog[];
  /** Quantos dias vale um item de situação. */
  valid_days?: number;
  built_at: string | null;
  pending: boolean;
};

/** Anotado pela MAVI numa conversa (a fonte é a conversa). */
export const fromChat = (t: Pick<Trait, "sources">) => (t.sources ?? []).some((s) => s.type === "chat");
/** "situação até 05/12" ou "situação vencida". */
export function validityLabel(t: Pick<Trait, "durability" | "valid_until" | "expired">) {
  if (t.durability !== "situation") return "";
  if (t.expired) return "Situação vencida";
  return t.valid_until
    ? `Situação · vale até ${new Date(t.valid_until).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })}`
    : "Situação";
}
/** As evidências, em uma frase ("de 2 avaliações e 1 pergunta"). */
export function sourcesLabel(t: Pick<Trait, "sources">) {
  const s = t.sources ?? [];
  if (!s.length) return "";
  const n = (type: TraitSource["type"]) => s.filter((x) => x.type === type).length;
  const parts = [
    n("chat") ? "dito na conversa" : "",
    n("feedback") ? `${n("feedback")} ${n("feedback") === 1 ? "avaliação" : "avaliações"}` : "",
    n("check") ? `${n("check")} ${n("check") === 1 ? "reclamação" : "reclamações"}` : "",
    n("question") ? `${n("question")} ${n("question") === 1 ? "pergunta" : "perguntas"}` : "",
  ].filter(Boolean);
  return parts.length ? `De: ${parts.join(", ")}` : "";
}

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Sem conexão com o banco.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

/** A base de uma pessoa (null: a de quem está logado). */
export const personProfile = (company: string, user: string | null) =>
  rpc<PersonProfile>("mavi_person_profile", { p_company: company, p_user: user });
export const saveTrait = (
  company: string,
  user: string | null,
  id: string | null,
  kind: TraitKind,
  text: string,
  durability?: TraitDurability,
) =>
  rpc<string>("mavi_person_trait_save", {
    p_company: company,
    p_user: user,
    p_id: id,
    p_kind: kind,
    p_text: text,
    ...(durability ? { p_durability: durability } : {}),
  });
export const setTrait = (company: string, id: string, action: "pin" | "unpin" | "dismiss" | "restore" | "renew") =>
  rpc<void>("mavi_person_trait_set", { p_company: company, p_id: id, p_action: action });
/** Os itens pelos ids (só os de quem pode ver a base da pessoa). */
export const lookupTraits = (company: string, ids: string[]) =>
  ids.length ? rpc<TraitLookup[]>("mavi_person_lookup", { p_company: company, p_ids: ids }) : Promise.resolve([]);

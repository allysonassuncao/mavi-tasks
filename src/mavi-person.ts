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
  built_at: string | null;
  pending: boolean;
};

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Sem conexão com o banco.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

/** A base de uma pessoa (null: a de quem está logado). */
export const personProfile = (company: string, user: string | null) =>
  rpc<PersonProfile>("mavi_person_profile", { p_company: company, p_user: user });
export const saveTrait = (company: string, user: string | null, id: string | null, kind: TraitKind, text: string) =>
  rpc<string>("mavi_person_trait_save", { p_company: company, p_user: user, p_id: id, p_kind: kind, p_text: text });
export const setTrait = (company: string, id: string, action: "pin" | "unpin" | "dismiss" | "restore") =>
  rpc<void>("mavi_person_trait_set", { p_company: company, p_id: id, p_action: action });

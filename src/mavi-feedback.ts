import { supabase } from "./supabase";

/**
 * MAVI · avaliação das respostas (migração 20270112090000_mavi_feedback):
 * 👍/👎 em cada resposta, com motivo e comentário no 👎. O time avalia e a
 * MAVI aprende (igual ao Copiloto das tarefas); líderes revisam em Painel da
 * MAVI › Aprendizado da MAVI.
 */

export type MaviVote = "up" | "down";
export type MaviReason = "incomplete" | "wrong" | "ignored" | "invented" | "format" | "other";
export const MAVI_REASONS: { id: MaviReason; label: string }[] = [
  { id: "incomplete", label: "Não terminou o pedido" },
  { id: "wrong", label: "Informação errada" },
  { id: "ignored", label: "Não seguiu o que pedi" },
  { id: "invented", label: "Inventou ou sem fonte" },
  { id: "format", label: "Formato ruim" },
  { id: "other", label: "Outro" },
];
export const MAVI_REASON_LABELS: Record<string, string> = Object.fromEntries(
  MAVI_REASONS.map((r) => [r.id, r.label]),
);
/** O assunto de um aprendizado (nulo: geral). */
export type MaviLessonKind = "research" | "answer" | "format" | "facts" | "tasks";
export const MAVI_KIND_LABELS: Record<MaviLessonKind, string> = {
  research: "Como buscar",
  answer: "O que responder",
  format: "Formato",
  facts: "Fatos e correções",
  tasks: "Tarefas longas",
};

export type MyVote = { message: number; vote: MaviVote; reason: MaviReason | null; comment: string };

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Sem conexão com o banco.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

/** Avalia uma resposta (null tira o voto). */
export const voteAnswer = (
  message: number,
  vote: MaviVote | null,
  reason: MaviReason | null = null,
  comment = "",
) =>
  rpc<MyVote | null>("mavi_feedback_vote", {
    p_message: message,
    p_vote: vote,
    p_reason: reason,
    p_comment: comment || null,
  });

/** Os meus votos numa conversa (antes da migração, nenhum). */
export const myVotes = (conversation: string) =>
  rpc<MyVote[]>("mavi_feedback_mine", { p_conversation: conversation })
    .then((l) => (Array.isArray(l) ? l : []))
    .catch(() => [] as MyVote[]);

// ------------------------------------------------------------ Painel
type Scope = "company" | "product" | "client";
type LessonStatus = "active" | "candidate" | "paused" | "dismissed";
export type MaviLesson = {
  id: string;
  scope: Scope;
  client_id: string | null;
  product_id: string | null;
  kind: MaviLessonKind | null;
  text: string;
  status: LessonStatus;
  origin: "mavi" | "person";
  people: number;
  has_leader: boolean;
  ups: number;
  downs: number;
  feedbacks: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};
export type MaviFeedbackRow = {
  id: number;
  /** Nulo: a autoavaliação da própria MAVI. */
  user_id: string | null;
  origin?: "person" | "judge";
  signals?: string[];
  client_id: string | null;
  product_id: string | null;
  module: string;
  vote: MaviVote;
  reason: MaviReason | null;
  comment: string;
  question: string;
  answer: string;
  at: string;
  learned: boolean;
};
/** A autoavaliação no período: conferidas, ruins, na fila, sinais e a configuração. */
export type MaviJudgeReport = {
  checked: number;
  bad: number;
  pending: number;
  signals: Record<string, number>;
  enabled: boolean;
  daily_limit: number;
};
export const SIGNAL_LABELS: Record<string, string> = {
  capped: "Parou no limite de passos",
  tool_errors: "Ferramentas com erro",
  no_sources: "Sem fonte citada",
  announce: "Anunciou em vez de entregar",
  frustration: "A pessoa reclamou depois",
  repeated: "A pessoa repetiu o pedido",
  down_unexplained: "👎 sem motivo",
  sample: "Sorteada para a amostra",
};
export type MaviLearningReport = {
  totals: { up: number; down: number; people: number; answers: number };
  judge?: MaviJudgeReport;
  reasons: Record<string, number>;
  lessons: MaviLesson[];
  feedback: MaviFeedbackRow[];
  feedback_total: number;
  pending: number;
  learned_at: string | null;
};
export const MAVI_PAGE = 50;
export const maviLearningReport = (
  company: string,
  from: string,
  to: string,
  vote: MaviVote | "judge" | null,
  offset: number,
) =>
  rpc<MaviLearningReport>("mavi_learning_report", {
    p_company: company,
    p_from: from,
    p_to: to,
    p_vote: vote,
    p_limit: MAVI_PAGE,
    p_offset: offset,
  });
export const saveMaviLesson = (
  company: string,
  id: string | null,
  scope: Scope,
  client: string | null,
  product: string | null,
  kind: MaviLessonKind | null,
  text: string,
) =>
  rpc<string>("mavi_lesson_save", {
    p_company: company,
    p_id: id,
    p_scope: scope,
    p_client: client,
    p_product: product,
    p_kind: kind,
    p_text: text,
  });
export const setMaviLesson = (company: string, id: string, action: "review" | "pause" | "activate" | "dismiss") =>
  rpc<void>("mavi_lesson_set", { p_company: company, p_id: id, p_action: action });

/** Liga ou desliga a autoavaliação e muda o limite por dia (líderes). */
export const setMaviJudge = (company: string, enabled: boolean | null, limit: number | null) =>
  rpc<{ enabled: boolean; daily_limit: number }>("mavi_judge_set", {
    p_company: company,
    p_enabled: enabled,
    p_limit: limit,
  });

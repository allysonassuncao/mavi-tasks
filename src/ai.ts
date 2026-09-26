import { supabase } from "./supabase";
import { navigate, routeParts, taskUrl } from "./router";

/**
 * IA do MAVI no navegador: a mesma pergunta serve a qualquer módulo — o
 * escopo diz onde a pessoa está (cliente, produto, projeto, módulo) e a IA
 * busca só ali. As respostas citam fontes [S#] que viram atalhos.
 */

export type AiScope = {
  client?: string;
  contract?: string;
  project?: string;
  module?: string;
};
export type AiSource = {
  ref: string;
  type: "meeting" | "task";
  id: string;
  title: string;
  date: string | null;
  client_id: string | null;
  start?: number;
};
export type AiTurn = { role: "user" | "assistant"; content: string };

export async function askAi(
  company: string,
  scope: AiScope,
  question: string,
  history: AiTurn[],
): Promise<{ answer: string; sources: AiSource[] }> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      action: "ai-ask",
      company,
      scope,
      question,
      history,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "Não foi possível falar com a IA.");
  return { answer: data.answer ?? "", sources: data.sources ?? [] };
}

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "America/Sao_Paulo",
      })
    : "";

/** O rótulo curto de uma citação: "Reunião 16/09 · 12:34", "Tarefa". */
export function sourceLabel(s: AiSource) {
  if (s.type === "meeting")
    return [
      `Reunião ${shortDate(s.date)}`,
      s.start != null ? clock(s.start) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return "Tarefa";
}

/** Abre uma tarefa citada (a reunião, quem mostra a resposta decide como abrir). */
export function openTaskSource(s: AiSource) {
  const company = routeParts(window.location.pathname).company;
  navigate(taskUrl({ id: s.id, title: s.title }, company));
}

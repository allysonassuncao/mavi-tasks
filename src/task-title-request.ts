import { supabase } from "./supabase";

/**
 * Pede à MAVI o título de uma tarefa nova (ação "task-title" de /api/drive).
 * Desiste depois de `timeoutMs`: quem chama salva com o título de reserva.
 */
export async function requestTaskTitle(
  input: {
    company: string;
    contract: string;
    project: string | null;
    description: string;
    audio: string;
    hint: string;
  },
  timeoutMs: number,
): Promise<string> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token) throw Error("Entre novamente para continuar.");
  const res = await fetch("/api/drive", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: "task-title", ...input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.title !== "string")
    throw Error(data.error ?? "A MAVI não criou o título.");
  return data.title;
}

import { supabase } from "./supabase";
import { dateKey, isLate } from "./domain";
import type { MemberAbsence, Snapshot, Task } from "./types";

/**
 * O balão de uma pessoa: qualquer elemento com `data-person="<user_id>"`
 * (a foto, o nome) — ou uma menção no texto (`.mention[data-user]`) — abre,
 * ao passar o mouse, um balão só para a página toda (PersonHoverCards).
 */
export const PERSON_SELECTOR = "[data-person], .mention[data-user]";
export function personOf(el: Element) {
  return el.getAttribute("data-person") || el.getAttribute("data-user") || "";
}

/** As equipes da pessoa, em ordem de nome, com quem as supervisiona. */
export function personTeams(data: Snapshot, user: string) {
  const supervised = new Map(
    data.teamMembers
      .filter((tm) => tm.user_id === user)
      .map((tm) => [tm.team_id, !!tm.supervisor]),
  );
  return data.teams
    .filter((t) => supervised.has(t.id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      supervisor: !!supervised.get(t.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** A ausência de hoje, ou a próxima nos próximos 14 dias. */
export function personAbsence(
  absences: MemberAbsence[] | undefined,
  user: string,
  today = dateKey(),
): { absence: MemberAbsence; now: boolean } | null {
  const soon = dateKey(new Date(Date.parse(`${today}T12:00:00Z`) + 14 * 864e5));
  const mine = (absences ?? [])
    .filter(
      (a) => a.user_id === user && a.ends_on >= today && a.starts_on <= soon,
    )
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const current = mine.find((a) => a.starts_on <= today);
  if (current) return { absence: current, now: true };
  return mine[0] ? { absence: mine[0], now: false } : null;
}

/** "12/10" (a data do banco, sem fuso). */
export function shortDate(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

/** Os dias da jornada (1 = segunda … 5 = sexta; vazio: os cinco). */
const WEEKDAYS = ["", "seg", "ter", "qua", "qui", "sex"];
export function workDaysLabel(days: number[] | null | undefined) {
  const sorted = days?.length ? [...days].sort() : [1, 2, 3, 4, 5];
  if (sorted.join() === "1,2,3,4,5") return "seg a sex";
  return sorted
    .map((d) => WEEKDAYS[d] ?? "")
    .filter(Boolean)
    .join(", ");
}
export function workHoursLabel(minutes: number | null | undefined) {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export type PersonTaskSummary = {
  open: number;
  late: number;
  review: number;
  done_30d: number;
};
const offline = (company: string) =>
  !supabase || !/^[0-9a-f-]{36}$/i.test(company);
const summaries = new Map<
  string,
  { at: number; value: Promise<PersonTaskSummary | null> }
>();
/**
 * Quantas tarefas a pessoa tem como responsável (public.person_task_summary,
 * só as que quem pergunta vê). Guardado por um minuto: passar o mouse de novo
 * não consulta o banco outra vez. Sem a função no banco, null (o balão só
 * não mostra os números).
 */
export function personTaskSummary(
  company: string,
  user: string,
  data: Snapshot,
): Promise<PersonTaskSummary | null> {
  if (offline(company)) {
    const today = dateKey();
    const mine = data.tasks.filter(
      (t) => t.assignee_id === user && !t.archived,
    );
    const since = Date.now() - 30 * 864e5;
    return Promise.resolve({
      open: mine.filter((t) => t.status !== "done").length,
      late: mine.filter((t) => isLate(t, today)).length,
      review: mine.filter((t) => t.status === "review").length,
      done_30d: mine.filter(
        (t) =>
          t.status === "done" &&
          !!t.delivered_at &&
          Date.parse(t.delivered_at) >= since,
      ).length,
    });
  }
  const key = `${company}:${user}`;
  const hit = summaries.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = Promise.resolve(
    supabase!.rpc("person_task_summary", { p_company: company, p_user: user }),
  ).then(({ data, error }) => {
    if (error) {
      summaries.delete(key);
      return null;
    }
    const row = (data as Record<string, number | string>[] | null)?.[0];
    return row
      ? {
          open: Number(row.open),
          late: Number(row.late),
          review: Number(row.review),
          done_30d: Number(row.done_30d),
        }
      : null;
  });
  summaries.set(key, { at: Date.now(), value });
  return value;
}

/** O link do WhatsApp para os dígitos guardados (com o país). */
export function whatsappUrl(digits: string) {
  return `https://wa.me/${digits.replace(/\D/g, "")}`;
}

export type PersonNextTask = {
  id: string;
  title: string;
  status: Task["status"];
  priority: Task["priority"];
  due_date: string;
};
/**
 * As próximas entregas da pessoa (public.person_next_tasks): em aberto, da
 * mais atrasada à mais distante, só as que quem pergunta vê.
 */
export async function personNextTasks(
  company: string,
  user: string,
  data: Snapshot,
  limit = 8,
): Promise<PersonNextTask[]> {
  if (offline(company))
    return data.tasks
      .filter(
        (t) => t.assignee_id === user && !t.archived && t.status !== "done",
      )
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .slice(0, limit)
      .map(({ id, title, status, priority, due_date }) => ({
        id,
        title,
        status,
        priority,
        due_date,
      }));
  const { data: rows, error } = await supabase!.rpc("person_next_tasks", {
    p_company: company,
    p_user: user,
    p_limit: limit,
  });
  if (error) throw Error(error.message);
  return (rows ?? []) as PersonNextTask[];
}

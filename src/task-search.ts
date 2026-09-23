import { rpc } from "./api";
import { canSeeTask } from "./domain";
import { richTextPlain } from "./rich-text";
import type { Comment, Snapshot, Status, Task } from "./types";

export type SearchField = "title" | "description" | "comments";
export const SEARCH_FIELDS: { id: SearchField; label: string }[] = [
  { id: "title", label: "Título" },
  { id: "description", label: "Descrição" },
  { id: "comments", label: "Comentários" },
];
export const SEARCH_PAGE = 30;

export type TaskSearchParams = {
  query: string;
  fields: SearchField[];
  client?: string;
  project?: string;
  assignee?: string;
  creator?: string;
  status?: string;
  /** Due date range (yyyy-mm-dd). */
  from?: string;
  to?: string;
  offset?: number;
};
export type TaskSearchHit = {
  task_id: string;
  title: string;
  status: Status;
  due_date: string;
  contract_id: string;
  project_id: string | null;
  assignee_id: string;
  creator_id: string;
  created_at: string;
  match_in: "title" | "description" | "comment" | "filters";
  snippet: string;
  comment_id: string | null;
  total: number;
};

/** Mirrors mavi_private.fold: lowercase, accents removed one char for one. */
const FROM = "áàâãäåéèêëíìîïóòôõöúùûüçñý";
const TO = "aaaaaaeeeeiiiiooooouuuucny";
export function fold(text: string) {
  let out = "";
  for (const ch of text.toLowerCase()) {
    const i = FROM.indexOf(ch);
    out += i >= 0 ? TO[i] : ch;
  }
  return out;
}

/** Mirrors mavi_private.search_snippet: ~160 characters around the match. */
export function searchSnippet(text: string, term: string) {
  const txt = text.replace(/\s+/g, " ");
  const pos = fold(txt).indexOf(term) + 1;
  if (pos === 0) return txt.slice(0, 160);
  const start = Math.max(pos - 60, 1);
  return (
    (pos > 61 ? "…" : "") +
    txt.slice(start - 1, start - 1 + 160) +
    (txt.length > start + 159 ? "…" : "")
  );
}

/** Splits `text` into plain and matched parts, ignoring case and accents. */
export function highlightParts(text: string, query: string) {
  const term = fold(query.trim());
  if (!term) return [{ text, match: false }];
  const folded = fold(text);
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (let i = folded.indexOf(term); i >= 0; i = folded.indexOf(term, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), match: false });
    parts.push({ text: text.slice(i, i + term.length), match: true });
    at = i + term.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

export function hasCriteria(p: TaskSearchParams) {
  return !!(
    p.query.trim() ||
    p.client ||
    p.project ||
    p.assignee ||
    p.creator ||
    p.status ||
    p.from ||
    p.to
  );
}

/** Runs public.search_tasks (as the person: only tasks they may see). */
export async function searchTasks(
  company: string,
  p: TaskSearchParams,
): Promise<TaskSearchHit[]> {
  const rows = (await rpc("search_tasks", {
    p_company: company,
    p_query: p.query.trim(),
    p_in: p.fields,
    p_client: p.client || null,
    p_project: p.project || null,
    p_assignee: p.assignee || null,
    p_creator: p.creator || null,
    p_status: p.status || null,
    p_from: p.from || null,
    p_to: p.to || null,
    p_limit: SEARCH_PAGE,
    p_offset: p.offset ?? 0,
  })) as TaskSearchHit[] | null;
  return (rows ?? []).map((r) => ({ ...r, total: Number(r.total) }));
}

/** The same search over the demo's data (public.search_tasks mirrored). */
export function searchTasksLocal(
  data: Snapshot,
  comments: Comment[],
  user: string,
  p: TaskSearchParams,
): TaskSearchHit[] {
  const term = fold(p.query.trim());
  const client = (t: Task) =>
    data.contracts.find((k) => k.id === t.contract_id)?.client_id;
  const base = data.tasks.filter(
    (t) =>
      !t.archived &&
      canSeeTask(data, t, user) &&
      (!p.client || client(t) === p.client) &&
      (!p.project || t.project_id === p.project) &&
      (!p.assignee || t.assignee_id === p.assignee) &&
      (!p.creator || t.creator_id === p.creator) &&
      (!p.status || t.status === p.status) &&
      (!p.from || t.due_date >= p.from) &&
      (!p.to || t.due_date <= p.to),
  );
  type Hit = Omit<TaskSearchHit, "total"> & { rank: number };
  const hits: Hit[] = [];
  const hit = (
    t: Task,
    match_in: Hit["match_in"],
    text: string,
    rank: number,
    comment_id: string | null = null,
  ) =>
    hits.push({
      task_id: t.id,
      title: t.title,
      status: t.status,
      due_date: t.due_date,
      contract_id: t.contract_id,
      project_id: t.project_id,
      assignee_id: t.assignee_id,
      creator_id: t.creator_id,
      created_at: t.created_at,
      match_in,
      snippet: match_in === "filters" ? "" : searchSnippet(text, term),
      comment_id,
      rank,
    });
  for (const t of base) {
    if (!term) {
      hit(t, "filters", "", 0);
      continue;
    }
    if (p.fields.includes("title") && fold(t.title).includes(term))
      hit(t, "title", t.title, 1);
    else if (p.fields.includes("description")) {
      const text = richTextPlain(t.description);
      if (fold(text).includes(term)) hit(t, "description", text, 2);
    }
    if (!hits.some((h) => h.task_id === t.id) && p.fields.includes("comments"))
      for (const c of comments) {
        if (c.task_id !== t.id) continue;
        const text = richTextPlain(c.body);
        if (fold(text).includes(term)) {
          hit(t, "comment", text, 3, c.id);
          break;
        }
      }
  }
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.created_at.localeCompare(a.created_at) ||
      a.task_id.localeCompare(b.task_id),
  );
  const offset = p.offset ?? 0;
  return hits
    .slice(offset, offset + SEARCH_PAGE)
    .map(({ rank: _rank, ...h }) => ({ ...h, total: hits.length }));
}

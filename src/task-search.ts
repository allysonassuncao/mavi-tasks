import { rpc } from "./api";
import { canSeeTask } from "./domain";
import { richTextPlain } from "./rich-text";
import { supabase } from "./supabase";
import {
  MAVI_FILTER_KEYS,
  MAVI_SEARCH_WAIT_MS,
  cleanTerms,
  type MaviSearch,
} from "./task-search-mavi";
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
  /** Only Alta and Urgente ("Prioritárias"; search_task_rows only). */
  priority?: boolean;
  offset?: number;
  /** Page size (the database caps it at 100). */
  limit?: number;
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
  /** "meaning": found by the MAVI's search by meaning, not by a term. */
  match_in: "title" | "description" | "comment" | "meaning" | "filters";
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
  return highlightTerms(text, [query]);
}

/**
 * The same with several terms (the MAVI's): any of them is marked, the
 * longest first where two start at the same place.
 */
export function highlightTerms(text: string, terms: string[]) {
  const list = [...new Set(terms.map((t) => fold(t.trim())).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (!list.length) return [{ text, match: false }];
  const folded = fold(text);
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (;;) {
    let start = -1;
    let size = 0;
    for (const term of list) {
      const i = folded.indexOf(term, at);
      if (i >= 0 && (start < 0 || i < start)) {
        start = i;
        size = term.length;
      }
    }
    if (start < 0) break;
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, start + size), match: true });
    at = start + size;
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
    p.to ||
    p.priority
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
    p_limit: p.limit ?? SEARCH_PAGE,
    p_offset: p.offset ?? 0,
  })) as TaskSearchHit[] | null;
  return (rows ?? []).map((r) => ({ ...r, total: Number(r.total) }));
}

/** Where the search found a task, shown under it in the list. */
export type SearchMatch = Pick<TaskSearchHit, "match_in" | "snippet" | "comment_id">;
/** The tasks found, whole, for the same table as the task list's. */
export type TaskSearchRows = {
  /** In the order found (title first, then description, then comments). */
  tasks: Task[];
  matches: Map<string, SearchMatch>;
  /** How many there are in all (more than `tasks` past SEARCH_CAP). */
  total: number;
};
/** The most tasks the search brings at once (public.search_task_rows). */
export const SEARCH_CAP = 2000;

/**
 * Runs public.search_task_rows (as the person): every task found, up to
 * SEARCH_CAP, without description and template fields (the task's page reads
 * its own). A reply cut by the API's row limit is read on from where it
 * stopped.
 */
export async function searchTaskRows(
  company: string,
  p: TaskSearchParams,
): Promise<TaskSearchRows> {
  return readRows("search_task_rows", {
    p_company: company,
    p_query: p.query.trim(),
    ...filterArgs(p),
  });
}

/**
 * The search with what the MAVI understood (public.search_task_rows_mavi):
 * any of her terms, and the tasks close in meaning to the subject, under the
 * screen's filters. Changing a filter afterwards runs only this.
 */
export async function searchTaskRowsMavi(
  company: string,
  mavi: Pick<MaviSearch, "terms" | "embedding">,
  p: TaskSearchParams,
): Promise<TaskSearchRows> {
  const args = {
    p_company: company,
    p_terms: mavi.terms,
    p_embedding: mavi.embedding,
    ...filterArgs(p),
  };
  try {
    return await readRows("search_task_rows_mavi", args);
  } catch (e) {
    // The database gave up on time (statement timeout) with the search by
    // meaning: the terms alone still find what was written.
    if ((e as { code?: string })?.code !== "57014" || !mavi.embedding || !mavi.terms.length)
      throw e;
    return readRows("search_task_rows_mavi", { ...args, p_embedding: null });
  }
}

function filterArgs(p: TaskSearchParams) {
  return {
    p_in: p.fields,
    p_client: p.client || null,
    p_project: p.project || null,
    p_assignee: p.assignee || null,
    p_creator: p.creator || null,
    p_status: p.status || null,
    p_from: p.from || null,
    p_to: p.to || null,
    p_priority: !!p.priority,
  };
}

async function readRows(
  name: string,
  args: Record<string, unknown>,
): Promise<TaskSearchRows> {
  type Row = SearchMatch & { task: Task; total: number };
  const rows: Row[] = [];
  let total = 0;
  for (;;) {
    const page = ((await rpc(name, {
      ...args,
      p_limit: SEARCH_CAP - rows.length,
      p_offset: rows.length,
    })) ?? []) as Row[];
    rows.push(...page);
    if (page.length) total = Number(page[0].total);
    if (!page.length || rows.length >= Math.min(total, SEARCH_CAP)) break;
  }
  const matches = new Map<string, SearchMatch>();
  for (const r of rows)
    matches.set(r.task.id, {
      match_in: r.match_in,
      snippet: r.snippet,
      comment_id: r.comment_id,
    });
  return { tasks: rows.map((r) => r.task), matches, total };
}

/** searchTaskRows over the demo's data. */
export function searchTaskRowsLocal(
  data: Snapshot,
  comments: Comment[],
  user: string,
  p: TaskSearchParams,
): TaskSearchRows {
  const hits = searchTasksLocal(data, comments, user, {
    ...p,
    offset: 0,
    limit: SEARCH_CAP,
  });
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const matches = new Map<string, SearchMatch>();
  const tasks: Task[] = [];
  for (const h of hits) {
    const t = byId.get(h.task_id);
    if (!t) continue;
    tasks.push(t);
    matches.set(t.id, {
      match_in: h.match_in,
      snippet: h.snippet,
      comment_id: h.comment_id,
    });
  }
  return { tasks, matches, total: hits[0]?.total ?? 0 };
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
    .slice(offset, offset + (p.limit ?? SEARCH_PAGE))
    .map(({ rank: _rank, ...h }) => ({ ...h, total: hits.length }));
}

// ------------------------------------------------------------ a MAVI
/**
 * Asks the MAVI what a request means (action "task-search" of /api/drive):
 * the filters she understood, her terms and the subject's vector. Gives up
 * after MAVI_SEARCH_WAIT_MS: the screen then searches the exact words.
 */
export async function requestMaviSearch(input: {
  company: string;
  query: string;
  today: string;
  filters: Partial<Record<(typeof MAVI_FILTER_KEYS)[number], string>> & {
    priority?: boolean;
    fields?: string[];
  };
}): Promise<MaviSearch> {
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
    body: JSON.stringify({ action: "task-search", ...input }),
    signal: AbortSignal.timeout(MAVI_SEARCH_WAIT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data.terms))
    throw Error(data.error ?? "A MAVI não respondeu.");
  return {
    query: input.query,
    terms: cleanTerms(data.terms),
    embedding: typeof data.embedding === "string" ? data.embedding : null,
    summary: typeof data.summary === "string" ? data.summary : "",
    filters: data.filters && typeof data.filters === "object" ? data.filters : {},
    model: typeof data.model === "string" ? data.model : undefined,
  };
}

/**
 * What the MAVI understood of the last requests, kept in this tab: opening a
 * task and coming back, or changing a filter, doesn't ask her again.
 */
const MAVI_CACHE = "mavi:task-search:v1";
const MAVI_CACHE_SIZE = 8;
type CachedSearch = MaviSearch & { key: string };

export function readMaviSearch(key: string): MaviSearch | null {
  try {
    const list = JSON.parse(sessionStorage.getItem(MAVI_CACHE) ?? "[]");
    const hit = Array.isArray(list)
      ? (list as CachedSearch[]).find((x) => x?.key === key)
      : undefined;
    if (!hit || !Array.isArray(hit.terms)) return null;
    const { key: _key, ...search } = hit;
    return search;
  } catch {
    // Blocked storage or a broken value: ask the MAVI again.
    return null;
  }
}

export function writeMaviSearch(key: string, search: MaviSearch) {
  try {
    const list = JSON.parse(sessionStorage.getItem(MAVI_CACHE) ?? "[]");
    const kept = (Array.isArray(list) ? (list as CachedSearch[]) : []).filter(
      (x) => x?.key !== key,
    );
    sessionStorage.setItem(
      MAVI_CACHE,
      JSON.stringify([{ ...search, key }, ...kept].slice(0, MAVI_CACHE_SIZE)),
    );
  } catch {
    // Blocked or full storage: the next visit just asks the MAVI again.
  }
}

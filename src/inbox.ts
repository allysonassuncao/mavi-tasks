import type { InboxFilters } from "./api";
import { fold } from "./domain";
import { routeParts } from "./router";
import type { AppNotification } from "./types";

/** The top bar's panel shows this many at a time ("Carregar mais"). */
export const INBOX_PANEL_PAGE = 10;
/** The "Caixa de entrada" page loads this many at a time. */
export const INBOX_PAGE = 30;

/** The kinds, grouped as the page's "Tipo" filter shows them. */
export const INBOX_KINDS: { id: string; label: string; kinds: AppNotification["kind"][] }[] = [
  { id: "mention", label: "Menções", kinds: ["mention"] },
  { id: "reply", label: "Respostas a comentários", kinds: ["reply"] },
  { id: "assigned", label: "Tarefas para você", kinds: ["assigned", "tasks_assigned"] },
  { id: "status", label: "Mudanças de status", kinds: ["status"] },
  { id: "review", label: "Validações", kinds: ["review"] },
  { id: "priority", label: "Prioridades", kinds: ["priority", "tasks_priority"] },
  { id: "due_risk", label: "Prazos em risco", kinds: ["due_risk"] },
  { id: "notice", label: "Mural de avisos", kinds: ["notice"] },
  { id: "temperature", label: "Termômetro", kinds: ["temperature"] },
  { id: "radar", label: "Radar do cliente", kinds: ["radar_report", "radar_alert", "radar_task_auto"] },
  { id: "campaign_alert", label: "Avisos de campanhas", kinds: ["campaign_alert"] },
  { id: "campaign_insight", label: "Insights das campanhas", kinds: ["campaign_insight"] },
  { id: "media_balance", label: "Financeiro › Mídia", kinds: ["media_balance"] },
  { id: "rq_closing", label: "Financeiro › Make Ads RQ", kinds: ["rq_closing"] },
  { id: "success_case", label: "Cases de Sucesso", kinds: ["success_case"] },
  { id: "social_leads", label: "Social Leads", kinds: ["social_leads"] },
  { id: "mavi", label: "MAVI", kinds: ["ai_share", "ai_answer", "ai_skill"] },
  { id: "lessons", label: "Aprendizados da MAVI", kinds: ["copilot_lessons", "mavi_lessons"] },
  { id: "memory", label: "Memória da MAVI", kinds: ["memory_week"] },
  { id: "job_alert", label: "Falhas nas rotinas", kinds: ["job_alert"] },
  { id: "tutorial_trail", label: "Tutoriais e trilhas", kinds: ["tutorial", "tutorial_trail"] },
];

/** The database kinds of the groups picked in the "Tipo" filter. */
export function kindsOf(groups: string[]) {
  return INBOX_KINDS.filter((g) => groups.includes(g.id)).flatMap((g) => g.kinds);
}

export type InboxPeriod = "all" | "today" | "7d" | "30d" | "custom";

/**
 * The instants of a period ("to" exclusive), in the person's time zone.
 * Custom dates are "YYYY-MM-DD", both days included.
 */
export function periodRange(
  period: InboxPeriod,
  custom: { from: string; to: string },
  now = new Date(),
): { from: string | null; to: string | null } {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const at = (date: string, plusDays = 0) => {
    const [y, m, d] = date.split("-").map(Number);
    return y && m && d ? new Date(y, m - 1, d + plusDays).toISOString() : null;
  };
  if (period === "today") return { from: day(now).toISOString(), to: null };
  if (period === "7d" || period === "30d") {
    const start = day(now);
    start.setDate(start.getDate() - (period === "7d" ? 6 : 29));
    return { from: start.toISOString(), to: null };
  }
  if (period === "custom")
    return {
      from: custom.from ? at(custom.from) : null,
      to: custom.to ? at(custom.to, 1) : null,
    };
  return { from: null, to: null };
}

/** Newest first, as the database orders them (created_at, then id). */
export function newestFirst(
  a: Pick<AppNotification, "id" | "created_at">,
  b: Pick<AppNotification, "id" | "created_at">,
) {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return cmp(b.created_at, a.created_at) || cmp(b.id, a.id);
}

/**
 * A fresh first page merged into what is already loaded: the page replaces
 * what it covers (new notices come in, read ones update) and the older ones
 * loaded with "Carregar mais" stay. `more`: whether there may be older ones.
 */
export function mergeHead(
  head: AppNotification[],
  loaded: AppNotification[],
  pageSize: number,
  loadedMore: boolean,
): { items: AppNotification[]; more: boolean } {
  if (head.length < pageSize) return { items: head, more: false };
  const last = head[head.length - 1];
  const ids = new Set(head.map((n) => n.id));
  const older = loaded.filter(
    (n) => !ids.has(n.id) && newestFirst(last, n) < 0,
  );
  return {
    items: [...head, ...older],
    more: older.length ? loadedMore : true,
  };
}

/** The filters applied in memory (the demo, which has no database). */
export function matchesInbox(n: AppNotification, f: InboxFilters) {
  if (f.unread && n.read_at) return false;
  if (f.kinds?.length && !f.kinds.includes(n.kind)) return false;
  if (f.actors?.length || f.system) {
    const byPerson = !!n.actor_id && !!f.actors?.includes(n.actor_id);
    if (!byPerson && !(f.system && !n.actor_id)) return false;
  }
  if (f.clients?.length && !(n.client_id && f.clients.includes(n.client_id)))
    return false;
  if (f.from && n.created_at < f.from) return false;
  if (f.to && n.created_at >= f.to) return false;
  const term = fold(f.search?.trim() ?? "");
  if (
    term &&
    !fold(
      [n.task_title, n.actor_name, n.excerpt].filter(Boolean).join(" "),
    ).includes(term)
  )
    return false;
  return true;
}

/** A page of the demo's inbox, as my_inbox would return it. */
export function pageOf(
  all: AppNotification[],
  limit: number,
  after: Pick<AppNotification, "id" | "created_at"> | null | undefined,
  filters: InboxFilters = {},
) {
  return all
    .filter((n) => matchesInbox(n, filters))
    .sort(newestFirst)
    .filter((n) => !after || newestFirst(after, n) < 0)
    .slice(0, limit);
}

/**
 * The Radar item a notice is about (its link is `/radar?item=<id>`, with or
 * without the company in front): it opens over the current page, like a
 * task, instead of taking the person to the Radar.
 */
export function radarItemOf(link: string | null | undefined) {
  if (!link) return null;
  const [path, query = ""] = link.split("?");
  if (routeParts(path).path !== "/radar") return null;
  return new URLSearchParams(query).get("item") || null;
}

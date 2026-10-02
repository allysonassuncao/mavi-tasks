import type {
  ChecklistItem,
  ChecklistLogEntry,
  ChecklistTemplate,
  ChecklistTemplateItem,
  Snapshot,
  TaskChecklist,
} from "./types";

/**
 * Checklist nas tarefas (migration 20270220090000_task_checklists): what the
 * panel, the Nova tarefa and the demo share. The database has the final
 * word; these mirror it for rendering and for the demo.
 */

/** The items of a checklist as a tree: each item with its subitems, in order. */
export function checklistTree(items: ChecklistItem[]) {
  const byOrder = (a: ChecklistItem, b: ChecklistItem) =>
    a.position - b.position || a.created_at.localeCompare(b.created_at);
  return items
    .filter((i) => !i.parent_id)
    .sort(byOrder)
    .map((item) => ({
      item,
      children: items.filter((c) => c.parent_id === item.id).sort(byOrder),
    }));
}

/** Items done and in all, counting subitems (what the progress bar shows). */
export function checklistProgress(list: Pick<TaskChecklist, "items">) {
  const total = list.items.length;
  const done = list.items.filter((i) => i.done).length;
  return { total, done, open: total - done };
}

/** Open items across the task's checklists (what holds back delivery). */
export const openChecklistItems = (lists: TaskChecklist[] | undefined) =>
  (lists ?? []).reduce((n, l) => n + checklistProgress(l).open, 0);

/** The message the database gives when the checklist holds the delivery. */
export const checklistGateMessage = (open: number) =>
  `Conclua o checklist antes de entregar: ${open === 1 ? "1 item" : `${open} itens`} em aberto.`;

/**
 * Marks or unmarks an item the way public.set_checklist_item_done does: an
 * item takes its subitems along, an item with subitems follows them, and the
 * checklist is completed (or reopened) with its items. Returns a new list.
 */
export function withItemDone(
  list: TaskChecklist,
  itemId: string,
  done: boolean,
  user: string,
  now = new Date().toISOString(),
): TaskChecklist {
  const mark = (i: ChecklistItem): ChecklistItem =>
    i.done === done
      ? i
      : {
          ...i,
          done,
          done_by: done ? user : null,
          done_at: done ? now : null,
        };
  const items = list.items.map((i) =>
    i.id === itemId || i.parent_id === itemId ? mark(i) : i,
  );
  return settleChecklist({ ...list, items }, user, now);
}

/** Parents follow their subitems; the checklist follows its items. */
export function settleChecklist(
  list: TaskChecklist,
  user: string,
  now = new Date().toISOString(),
): TaskChecklist {
  const items = list.items.map((i) => {
    const kids = list.items.filter((c) => c.parent_id === i.id);
    if (!kids.length) return i;
    const all = kids.every((c) => c.done);
    return all === i.done
      ? i
      : {
          ...i,
          done: all,
          done_by: all ? user : null,
          done_at: all ? now : null,
        };
  });
  const finished = items.length > 0 && items.every((i) => i.done);
  return {
    ...list,
    items,
    completed_by: finished ? (list.completed_by ?? user) : null,
    completed_at: finished ? (list.completed_at ?? now) : null,
  };
}

/**
 * The quick editor of models (and of "Colar lista"): one line per item; a
 * line starting with "-", "•" or indented is a subitem of the line above.
 */
export function parseChecklistText(text: string): ChecklistTemplateItem[] {
  const items: ChecklistTemplateItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const sub = /^(\s+|\s*[-–•*]\s+)/.test(raw);
    const title = raw
      .replace(/^\s*[-–•*]\s+/, "")
      .trim()
      .slice(0, 500);
    if (!title) continue;
    const last = items[items.length - 1];
    if (sub && last) (last.children ??= []).push({ title });
    else items.push({ title });
  }
  return items;
}

/** The opposite of parseChecklistText. */
export const checklistText = (items: ChecklistTemplateItem[]) =>
  items
    .flatMap((i) => [i.title, ...(i.children ?? []).map((c) => `- ${c.title}`)])
    .join("\n");

/** A task's checklist as a model's items ("Salvar como modelo"). */
export const checklistAsItems = (
  list: TaskChecklist,
): ChecklistTemplateItem[] =>
  checklistTree(list.items).map(({ item, children }) => ({
    title: item.title,
    ...(children.length
      ? { children: children.map((c) => ({ title: c.title })) }
      : {}),
  }));

/** Items of a model, counting subitems. */
export const templateItemCount = (items: ChecklistTemplateItem[]) =>
  items.reduce((n, i) => n + 1 + (i.children?.length ?? 0), 0);

/**
 * The active models a new task comes with: those of its product and/or of
 * the assignee's teams (or of the team it is sent to). A model with neither
 * is only applied by hand.
 */
export function suggestedChecklistTemplates(
  data: Pick<Snapshot, "checklistTemplates" | "contracts" | "teamMembers">,
  contractId: string,
  who: { assignee: string } | { team: string },
): ChecklistTemplate[] {
  const product = data.contracts.find((c) => c.id === contractId)?.product_id;
  const teams =
    "team" in who
      ? new Set([who.team])
      : new Set(
          data.teamMembers
            .filter((tm) => tm.user_id === who.assignee)
            .map((tm) => tm.team_id),
        );
  return (data.checklistTemplates ?? []).filter(
    (t) =>
      t.active &&
      (t.product_id || t.team_id) &&
      (!t.product_id || t.product_id === product) &&
      (!t.team_id || teams.has(t.team_id)),
  );
}

/** How the record (and the task's Histórico) names each checklist action. */
export function checklistLogLabel(
  e: Pick<ChecklistLogEntry, "action" | "detail">,
): string {
  const d = e.detail;
  const list = String(d.list ?? d.title ?? "");
  const title = `“${String(d.title ?? "")}”`;
  const sub = Number(d.subitems ?? 0);
  const withSubs = sub
    ? ` e ${sub === 1 ? "1 subitem" : `${sub} subitens`}`
    : "";
  switch (e.action) {
    case "checklist_added":
      return d.template
        ? `Checklist “${list}” adicionado (modelo)`
        : `Checklist “${list}” criado`;
    case "checklist_renamed":
      return `Checklist renomeado · “${String(d.from ?? "")}” → “${list}”`;
    case "checklist_deleted":
      return `Checklist “${list}” excluído${d.items ? ` (${String(d.items)} ${Number(d.items) === 1 ? "item" : "itens"})` : ""}`;
    case "checklist_completed":
      return `Checklist “${list}” concluído`;
    case "checklist_reopened":
      return `Checklist “${list}” reaberto`;
    case "item_added":
      return d.parent
        ? `Subitem ${title} adicionado em “${String(d.parent)}” · ${list}`
        : `Item ${title} adicionado · ${list}`;
    case "item_edited":
      return `Item alterado · “${String(d.from ?? "")}” → ${title} · ${list}`;
    case "item_deleted":
      return `Item ${title}${withSubs} excluído · ${list}`;
    case "item_checked":
      return `Marcou ${title}${withSubs} · ${list}`;
    case "item_unchecked":
      return `Desmarcou ${title}${withSubs} · ${list}`;
    case "required_on":
      return "Checklist passou a ser exigido para entregar";
    case "required_off":
      return "Checklist deixou de ser exigido para entregar";
    default:
      return e.action;
  }
}

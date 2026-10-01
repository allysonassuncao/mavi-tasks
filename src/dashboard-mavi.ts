import { supabase } from "./supabase";
import {
  compact,
  freeSpot,
  newPanelId,
  type DashboardFilters,
  type Panel,
  type PanelSpec,
  type RangePreset,
} from "./dashboards";

/**
 * MAVI nos Dashboards (ação "dashboard-mavi" de /api/drive,
 * api/_dashboard-mavi.ts): a conversa ao lado do dashboard. A MAVI pergunta,
 * confere os dados e devolve uma proposta; nada é gravado até a pessoa
 * aplicar e salvar.
 */

export type DashMessage = { role: "user" | "assistant"; content: string };
export type DashQuestion = { text: string; options: string[]; multiple: boolean };
export type ProposedPanel = {
  id?: string;
  title: string;
  w: number;
  h: number;
  spec: PanelSpec;
  why: string;
};
export type DashProposal = {
  name?: string;
  description?: string;
  range?: RangePreset;
  add: ProposedPanel[];
  update: ProposedPanel[];
  remove: string[];
};
export type DashReply = {
  reply: string;
  question?: DashQuestion;
  proposal?: DashProposal;
  dropped?: string[];
  ready: boolean;
  model: string;
};
export type DashContext = {
  name: string;
  description: string;
  panels: Panel[];
  range: { from: string; to: string; preset: string };
  filters: DashboardFilters;
  focus: string | null;
  isNew: boolean;
};

export async function askDashboardMavi(
  company: string,
  messages: DashMessage[],
  dashboard: DashContext,
): Promise<DashReply> {
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  const res = await fetch("/api/drive", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: "dashboard-mavi", company, messages, dashboard }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "A MAVI não conseguiu responder agora.");
  return data as DashReply;
}

/** Cada item da proposta, para a pessoa escolher o que aplica. */
export type ProposalItem =
  | { key: string; kind: "add"; panel: ProposedPanel }
  | { key: string; kind: "update"; panel: ProposedPanel; before: Panel }
  | { key: string; kind: "remove"; before: Panel }
  | { key: string; kind: "name"; value: string }
  | { key: string; kind: "description"; value: string }
  | { key: string; kind: "range"; value: RangePreset };

export function proposalItems(p: DashProposal, panels: Panel[]): ProposalItem[] {
  const byId = new Map(panels.map((x) => [x.id, x]));
  const items: ProposalItem[] = [];
  if (p.name) items.push({ key: "name", kind: "name", value: p.name });
  if (p.description) items.push({ key: "description", kind: "description", value: p.description });
  if (p.range) items.push({ key: "range", kind: "range", value: p.range });
  p.add.forEach((panel, i) => items.push({ key: `add-${i}`, kind: "add", panel }));
  for (const panel of p.update) {
    const before = byId.get(panel.id!);
    if (before) items.push({ key: `update-${panel.id}`, kind: "update", panel, before });
  }
  for (const id of p.remove) {
    const before = byId.get(id);
    if (before) items.push({ key: `remove-${id}`, kind: "remove", before });
  }
  return items;
}

/**
 * Aplica os itens escolhidos ao rascunho do dashboard: painéis novos no
 * primeiro espaço livre (na ordem da proposta), alterados no mesmo lugar
 * (com o tamanho novo) e a grade compactada.
 */
export function applyProposal(
  draft: { name: string; description: string; panels: Panel[] },
  items: ProposalItem[],
): { name: string; description: string; panels: Panel[]; range?: RangePreset } {
  let panels = [...draft.panels];
  let { name, description } = draft;
  let range: RangePreset | undefined;
  for (const item of items) {
    if (item.kind === "name") name = item.value;
    else if (item.kind === "description") description = item.value;
    else if (item.kind === "range") range = item.value;
    else if (item.kind === "remove") panels = panels.filter((p) => p.id !== item.before.id);
    else if (item.kind === "update")
      panels = panels.map((p) =>
        p.id === item.before.id
          ? { ...p, title: item.panel.title, spec: item.panel.spec, w: Math.min(item.panel.w, 12 - p.x), h: item.panel.h }
          : p,
      );
  }
  panels = compact(panels);
  for (const item of items) {
    if (item.kind !== "add") continue;
    const spot = freeSpot(panels, item.panel.w, item.panel.h);
    panels = [...panels, { id: newPanelId(), title: item.panel.title, ...spot, spec: item.panel.spec }];
  }
  return { name, description, panels: compact(panels), ...(range ? { range } : {}) };
}

import { supabase } from "./supabase";

/**
 * Radar do cliente › o que a MAVI aprende com as tarefas (migration
 * 20270605090000_radar_task_learning): cada tarefa criada a partir de um
 * item (com o que veio preenchido e o que a pessoa mudou), cada tarefa
 * vinculada e cada item fechado sem tarefa. É o material para a MAVI depois
 * sugerir — e, liberada, abrir sozinha — as tarefas do Radar.
 */

export type SignalKind = "created" | "linked" | "no_task";
/** O que a pessoa pode mudar no formulário preenchido. */
export type ChangedField = "title" | "description" | "product" | "due" | "assignee" | "team" | "priority";
export const CHANGED_LABELS: Record<ChangedField, string> = {
  title: "título",
  description: "descrição",
  product: "produto",
  due: "prazo",
  assignee: "responsável",
  team: "equipe",
  priority: "prioridade",
};
export const PRIORITY_LABELS: Record<string, string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};
export const SEVERITY_LABELS = ["Baixa", "Média", "Alta", "Crítica"];

export type LearningGroup = {
  topic_id: string;
  topic_name: string;
  topic_color: string;
  product_id: string | null;
  product_name: string | null;
  created: number;
  linked: number;
  /** Itens com pelo menos uma tarefa (criada ou vinculada). */
  items_task: number;
  no_task: number;
  /** Dos fechados sem tarefa: fechados pela MAVI e os que reabriram depois. */
  no_task_mavi: number;
  no_task_reopened: number;
  with_preset: number;
  as_preset: number;
  /** Prazo típico (mediana), em dias úteis a partir da criação. */
  due_days: number | null;
  teams: { id: string; name: string; n: number }[];
  people: { id: string; name: string; n: number }[];
  priorities: Record<string, number>;
  changed: Partial<Record<ChangedField, number>>;
  severity: { severity: number | null; task: number; no_task: number }[];
};
export type LearningSignal = {
  id: string;
  kind: SignalKind;
  created_at: string;
  item_id: string;
  item_title: string;
  client_name: string;
  topic_name: string;
  topic_color: string;
  product_name?: string;
  severity?: number;
  user_name?: string;
  task_id?: string;
  task_title?: string;
  task_status?: string;
  changed?: ChangedField[];
  /** Criada pelo "Criar tarefa" do item (o formulário veio preenchido). */
  suggested?: boolean;
  team_name?: string;
  by_team?: boolean;
  assignee_name?: string;
  due_days?: number;
  priority?: string;
  status_label?: string;
  backfill?: boolean;
  removed_reason?: "unlinked" | "task_later";
  reopened?: boolean;
};
export type TaskLearning = {
  since: string;
  days: number;
  totals: { created: number; linked: number; no_task: number; with_preset: number; as_preset: number };
  groups: LearningGroup[];
  recent: LearningSignal[];
};
export type LearningFilters = { days: number; topic?: string; product?: string };

/** Quantos dos itens fechados viraram tarefa ("—" sem nenhum). */
export function taskRate(g: Pick<LearningGroup, "items_task" | "no_task">) {
  const total = g.items_task + g.no_task;
  return total ? Math.round((g.items_task / total) * 100) : null;
}
/** Das criadas pelo item, quantas ficaram como vieram preenchidas. */
export function presetRate(g: Pick<LearningGroup, "with_preset" | "as_preset">) {
  return g.with_preset ? Math.round((g.as_preset / g.with_preset) * 100) : null;
}
/** O que mais mudam, em ordem ("prazo 3 · título 1"). */
export function changedLine(changed: LearningGroup["changed"]) {
  return (Object.entries(changed) as [ChangedField, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${CHANGED_LABELS[k] ?? k} ${n}`)
    .join(" · ");
}
/** A prioridade mais usada (só quando não é a normal). */
export function mainPriority(p: Record<string, number>) {
  const [top] = Object.entries(p).sort((a, b) => b[1] - a[1]);
  return top && top[0] !== "normal" ? PRIORITY_LABELS[top[0]] ?? top[0] : null;
}

const offline = (company: string) => !supabase || !/^[0-9a-f-]{36}$/i.test(company);

export async function loadTaskLearning(company: string, filters: LearningFilters): Promise<TaskLearning> {
  if (offline(company)) return demoLearning(filters);
  const { data, error } = await supabase!.rpc("radar_task_learning", { p_company: company, p_filters: filters });
  if (error) throw Error(error.message);
  return data as TaskLearning;
}

/** "Criar tarefa" no item: liga a tarefa e guarda o que veio preenchido. */
export async function recordTaskCreated(
  company: string,
  item: string,
  task: string,
  preset: Record<string, unknown>,
) {
  if (offline(company)) return;
  const fields = Object.fromEntries(
    Object.entries(preset).filter(
      ([k, v]) => ["title", "description", "contract", "due", "assignee", "team", "priority"].includes(k) && typeof v === "string",
    ),
  );
  const { error } = await supabase!.rpc("radar_task_created", {
    p_company: company,
    p_item: item,
    p_task: task,
    p_preset: fields,
  });
  if (error) throw Error(error.message);
}

// ------------------------------------------------------------ demonstração
function demoLearning(filters: LearningFilters): TaskLearning {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const all: LearningGroup[] = [
    {
      topic_id: "rt-1",
      topic_name: "Problemas/reclamações",
      topic_color: "#d64545",
      product_id: "pd-1",
      product_name: "Make Ads",
      created: 9,
      linked: 2,
      items_task: 10,
      no_task: 4,
      no_task_mavi: 1,
      no_task_reopened: 1,
      with_preset: 9,
      as_preset: 5,
      due_days: 2,
      teams: [
        { id: "tm-1", name: "Tráfego", n: 8 },
        { id: "tm-2", name: "Design", n: 3 },
      ],
      people: [
        { id: "u-2", name: "Bruno", n: 5 },
        { id: "u-3", name: "Carla", n: 3 },
      ],
      priorities: { normal: 4, high: 6, urgent: 1 },
      changed: { due: 3, title: 2, priority: 2 },
      severity: [
        { severity: 0, task: 0, no_task: 2 },
        { severity: 1, task: 2, no_task: 2 },
        { severity: 2, task: 5, no_task: 0 },
        { severity: 3, task: 3, no_task: 0 },
      ],
    },
    {
      topic_id: "rt-2",
      topic_name: "Promessas da Make",
      topic_color: "#2a78d6",
      product_id: "pd-3",
      product_name: "Social Media",
      created: 3,
      linked: 0,
      items_task: 3,
      no_task: 6,
      no_task_mavi: 0,
      no_task_reopened: 0,
      with_preset: 3,
      as_preset: 3,
      due_days: 5,
      teams: [{ id: "tm-3", name: "Conteúdo", n: 3 }],
      people: [{ id: "u-4", name: "Duda", n: 3 }],
      priorities: { normal: 3 },
      changed: {},
      severity: [{ severity: null, task: 3, no_task: 6 }],
    },
  ];
  const groups = all.filter((g) => !filters.topic || g.topic_id === filters.topic);
  const recent: LearningSignal[] = [
    {
      id: "rs-1",
      kind: "created",
      created_at: ago(0.2),
      item_id: "ri-1",
      item_title: "Leads chegando sem telefone",
      client_name: "Clínica Sorriso",
      topic_name: "Problemas/reclamações",
      topic_color: "#d64545",
      product_name: "Make Ads",
      severity: 2,
      user_name: "Ana",
      task_id: "t-1",
      task_title: "Corrigir o formulário de leads",
      task_status: "progress",
      changed: ["title", "priority"],
      suggested: true,
      team_name: "Tráfego",
      by_team: true,
      assignee_name: "Bruno",
      due_days: 2,
      priority: "high",
    },
    {
      id: "rs-2",
      kind: "no_task",
      created_at: ago(1),
      item_id: "ri-2",
      item_title: "Dúvida sobre o boleto",
      client_name: "Padaria Pão Quente",
      topic_name: "Problemas/reclamações",
      topic_color: "#d64545",
      product_name: "Make Ads",
      severity: 0,
      user_name: "Ana",
      status_label: "Descartado",
    },
    {
      id: "rs-3",
      kind: "linked",
      created_at: ago(3),
      item_id: "ri-3",
      item_title: "Pixel fora do ar",
      client_name: "Clínica Sorriso",
      topic_name: "Problemas/reclamações",
      topic_color: "#d64545",
      product_name: "Make Ads",
      severity: 3,
      user_name: "Gabi",
      task_id: "t-2",
      task_title: "Auditoria de pixel",
      task_status: "open",
      team_name: "Tráfego",
      assignee_name: "Carla",
      due_days: 1,
      priority: "urgent",
    },
  ];
  const sum = (k: "created" | "linked" | "no_task" | "with_preset" | "as_preset") =>
    groups.reduce((n, g) => n + g[k], 0);
  return {
    since: ago(filters.days),
    days: filters.days,
    totals: {
      created: sum("created"),
      linked: sum("linked"),
      no_task: sum("no_task"),
      with_preset: sum("with_preset"),
      as_preset: sum("as_preset"),
    },
    groups,
    recent,
  };
}

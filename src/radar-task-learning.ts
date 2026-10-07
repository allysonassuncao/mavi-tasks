import { supabase } from "./supabase";

/**
 * Radar do cliente › o que a MAVI aprende com as tarefas (migration
 * 20270605090000_radar_task_learning): cada tarefa criada a partir de um
 * item (com o que veio preenchido e o que a pessoa mudou), cada tarefa
 * vinculada e cada item fechado sem tarefa. É o material para a MAVI depois
 * sugerir — e, liberada, abrir sozinha — as tarefas do Radar.
 */

export type SignalKind = "created" | "linked" | "no_task" | "dismissed";
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
  /** Veio da tarefa sugerida pela MAVI (Fase 3). */
  from_suggestion?: boolean;
  /** Sugestão recusada: o motivo, o comentário e o título sugerido. */
  reason?: string;
  note?: string;
  suggested_title?: string;
  reopened?: boolean;
};
export type TaskLearning = {
  since: string;
  days: number;
  totals: {
    created: number;
    linked: number;
    no_task: number;
    with_preset: number;
    as_preset: number;
    /** Desde a migração 20270608090000. */
    dismissed?: number;
    from_suggestion?: number;
  };
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
  /** Criada pela tarefa sugerida da MAVI (Fase 3). */
  fromSuggestion = false,
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
    p_preset: fromSuggestion ? { ...fields, suggestion: "1" } : fields,
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
      id: "rs-4",
      kind: "dismissed",
      created_at: ago(2),
      item_id: "ri-4",
      item_title: "Página lenta no celular",
      client_name: "Norte Coffee",
      topic_name: "Problemas/reclamações",
      topic_color: "#d64545",
      product_name: "Make Ads",
      severity: 1,
      user_name: "Gabi",
      from_suggestion: true,
      reason: "wrong_due",
      note: "Depende do fornecedor do site; 5 dias úteis.",
      suggested_title: "Acelerar a landing — Norte Coffee",
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

// ------------------------------------------------------------ as regras (Fase 2)
/**
 * As regras das tarefas do Radar (migration 20270606090000_radar_task_rules):
 * a MAVI propõe com os registros acima, o Jev confere e um administrador ou
 * gestor aprova; líderes também escrevem as suas. O aprendizado começa
 * desligado.
 */
export type RuleStatus = "checking" | "suggested" | "active" | "paused" | "refused" | "dismissed";
export type TaskRule = {
  id: string;
  topic_id: string;
  topic_name: string;
  topic_color: string;
  product_id?: string;
  product_name?: string;
  all_products?: boolean;
  action: "task" | "no_task";
  condition: string;
  min_severity?: number;
  team_id?: string;
  team_name?: string;
  assignee_id?: string;
  assignee_name?: string;
  due_days?: number;
  priority?: string;
  title_hint?: string;
  why?: string;
  support: number;
  status: RuleStatus;
  origin: "mavi" | "leader";
  check_note?: string;
  replaces?: string;
  replaces_condition?: string;
  approved_by_name?: string;
  approved_at?: string;
  updated_by_name?: string;
  created_at: string;
  updated_at: string;
};
export type RulesData = {
  settings: { learning: boolean; learning_at?: string; learning_by_name?: string };
  topics: { id: string; name: string; color: string }[];
  rules: TaskRule[];
  queue: { due: number; learned_at: string | null; error: string | null };
};
export type RuleDraft = {
  topic_id: string;
  /** "" = Geral / Agência; "all" = todos os produtos. */
  product: string;
  action: "task" | "no_task";
  condition: string;
  min_severity: string;
  team_id: string;
  assignee_id: string;
  due_days: string;
  priority: string;
  title_hint: string;
};
export type RulesEstimate = {
  groups: number;
  signals: number;
  chars: number;
  avg_cost: number | null;
  samples: number;
  price: { input?: number; output?: number } | null;
};

export const RULE_FILTERS = [
  { id: "new", label: "Sugestões", statuses: ["suggested", "checking"] },
  { id: "active", label: "Em uso", statuses: ["active"] },
  { id: "paused", label: "Pausadas", statuses: ["paused"] },
  { id: "refused", label: "Recusadas", statuses: ["refused", "dismissed"] },
] as const;
export type RuleFilter = (typeof RULE_FILTERS)[number]["id"];

/** "Abrir tarefa para a equipe Tráfego (Bruno) · prazo 2 dias úteis · prioridade Alta". */
export function ruleOutcome(r: Pick<TaskRule, "action" | "team_name" | "assignee_name" | "due_days" | "priority">) {
  if (r.action === "no_task") return "Não abrir tarefa";
  const who = r.assignee_name
    ? `para ${r.assignee_name}${r.team_name ? ` (equipe ${r.team_name})` : ""}`
    : r.team_name
      ? `para a equipe ${r.team_name}`
      : "";
  return [
    ["Abrir tarefa", who].filter(Boolean).join(" "),
    r.due_days !== undefined && r.due_days !== null ? `prazo ${r.due_days === 1 ? "1 dia útil" : `${r.due_days} dias úteis`}` : "",
    r.priority && r.priority !== "normal" ? `prioridade ${PRIORITY_LABELS[r.priority] ?? r.priority}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export function ruleScope(r: Pick<TaskRule, "all_products" | "product_name">) {
  return r.all_products ? "Todos os produtos" : (r.product_name ?? "Geral / Agência");
}
export function ruleDraft(r?: TaskRule, topic = ""): RuleDraft {
  return {
    topic_id: r?.topic_id ?? topic,
    product: r?.all_products ? "all" : (r?.product_id ?? ""),
    action: r?.action ?? "task",
    condition: r?.condition ?? "",
    min_severity: r?.min_severity !== undefined && r?.min_severity !== null ? String(r.min_severity) : "",
    team_id: r?.team_id ?? "",
    assignee_id: r?.assignee_id ?? "",
    due_days: r?.due_days !== undefined && r?.due_days !== null ? String(r.due_days) : "",
    priority: r?.priority ?? "",
    title_hint: r?.title_hint ?? "",
  };
}
/** O formato que o banco recebe (save_radar_task_rule). */
export function draftPayload(d: RuleDraft) {
  const task = d.action === "task";
  return {
    topic_id: d.topic_id,
    all_products: d.product === "all",
    product_id: d.product && d.product !== "all" ? d.product : null,
    action: d.action,
    condition: d.condition.trim(),
    min_severity: d.min_severity === "" ? null : Number(d.min_severity),
    team_id: task && d.team_id ? d.team_id : null,
    assignee_id: task && d.assignee_id ? d.assignee_id : null,
    due_days: task && d.due_days !== "" ? Number(d.due_days) : null,
    priority: task && d.priority ? d.priority : null,
    title_hint: task && d.title_hint.trim() ? d.title_hint.trim() : null,
  };
}
/**
 * O custo da primeira rodada (o histórico): pela média já medida quando há
 * 3+ rodadas; senão, pelos caracteres do material e o preço do modelo
 * (US$ por milhão de tokens), mais ~10% do Jev.
 */
export function rulesCost(e: RulesEstimate, fallback = { input: 4, output: 20 }) {
  let base: number;
  const measured = e.samples >= 3 && e.avg_cost !== null && e.avg_cost !== undefined;
  if (measured) base = e.groups * Number(e.avg_cost);
  else {
    const price = { input: e.price?.input ?? fallback.input, output: e.price?.output ?? fallback.output };
    const input = Number(e.chars) / 3.5 + e.groups * 3500;
    const output = e.groups * 1500;
    base = (input / 1e6) * price.input + (output / 1e6) * price.output;
  }
  const total = base * 1.1;
  return { low: total * 0.7, high: total * 1.3, measured };
}

async function call<T>(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase!.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}
export async function loadRules(company: string): Promise<RulesData> {
  if (offline(company)) return structuredClone(demoRules);
  return call<RulesData>("radar_task_rules", { p_company: company });
}
export async function estimateRules(company: string): Promise<RulesEstimate> {
  if (offline(company)) return { groups: 2, signals: 23, chars: 23 * 520, avg_cost: null, samples: 0, price: null };
  return call<RulesEstimate>("radar_task_rules_estimate", { p_company: company });
}
export async function setLearning(company: string, on: boolean): Promise<RulesData["settings"]> {
  if (offline(company)) {
    demoRules.settings = on
      ? { learning: true, learning_at: new Date().toISOString(), learning_by_name: "Você" }
      : { learning: false, learning_at: new Date().toISOString(), learning_by_name: "Você" };
    return demoRules.settings;
  }
  return call("set_radar_task_learning", { p_company: company, p_on: on });
}
export async function saveRule(company: string, id: string | null, d: RuleDraft): Promise<TaskRule> {
  if (offline(company)) {
    const topic = demoRules.topics.find((t) => t.id === d.topic_id)!;
    const p = draftPayload(d);
    const old = demoRules.rules.find((r) => r.id === id);
    const rule: TaskRule = {
      ...(old ?? { id: `demo-rule-${Date.now()}`, support: 0, origin: "leader", created_at: new Date().toISOString() }),
      topic_id: topic.id,
      topic_name: topic.name,
      topic_color: topic.color,
      product_id: p.product_id ?? undefined,
      product_name: p.product_id ? "Make Ads" : undefined,
      all_products: p.all_products,
      action: p.action,
      condition: p.condition,
      min_severity: p.min_severity ?? undefined,
      team_id: p.team_id ?? undefined,
      assignee_id: p.assignee_id ?? undefined,
      due_days: p.due_days ?? undefined,
      priority: p.priority ?? undefined,
      title_hint: p.title_hint ?? undefined,
      status: old ? (old.status === "refused" ? "suggested" : old.status) : "active",
      updated_at: new Date().toISOString(),
    } as TaskRule;
    demoRules.rules = old ? demoRules.rules.map((r) => (r.id === id ? rule : r)) : [rule, ...demoRules.rules];
    return rule;
  }
  return call<TaskRule>("save_radar_task_rule", { p_company: company, p_id: id, p_rule: draftPayload(d) });
}
export async function setRuleStatus(company: string, id: string, status: "active" | "paused" | "dismissed"): Promise<TaskRule> {
  if (offline(company)) {
    const r = demoRules.rules.find((x) => x.id === id)!;
    if (status === "active" && r.replaces) {
      const old = demoRules.rules.find((x) => x.id === r.replaces);
      if (old?.status === "active") old.status = "paused";
    }
    if (status === "active" && r.status !== "paused") {
      r.approved_by_name = "Você";
      r.approved_at = new Date().toISOString();
    }
    r.status = status;
    return { ...r };
  }
  return call<TaskRule>("set_radar_task_rule", { p_company: company, p_id: id, p_status: status });
}

const demoAt = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
let demoRules: RulesData = {
  settings: { learning: true, learning_at: demoAt(6), learning_by_name: "Ana" },
  topics: [
    { id: "rt-1", name: "Problemas/reclamações", color: "#d64545" },
    { id: "rt-2", name: "Promessas da Make", color: "#2a78d6" },
  ],
  queue: { due: 1, learned_at: demoAt(0.3), error: null },
  rules: [
    {
      id: "demo-rule-1",
      topic_id: "rt-1",
      topic_name: "Problemas/reclamações",
      topic_color: "#d64545",
      product_id: "pd-1",
      product_name: "Make Ads",
      action: "task",
      condition: "Problema que trava a entrada de leads: formulário, pixel ou página fora do ar",
      min_severity: 2,
      team_id: "tm-1",
      team_name: "Tráfego",
      due_days: 2,
      priority: "high",
      title_hint: "Corrigir <o que quebrou> — <cliente>",
      why: "8 de 9 itens de gravidade alta ou crítica viraram tarefa para Tráfego, com prazo de 2 dias úteis.",
      support: 8,
      status: "suggested",
      origin: "mavi",
      created_at: demoAt(0.3),
      updated_at: demoAt(0.3),
    },
    {
      id: "demo-rule-2",
      topic_id: "rt-1",
      topic_name: "Problemas/reclamações",
      topic_color: "#d64545",
      product_id: "pd-1",
      product_name: "Make Ads",
      action: "no_task",
      condition: "Dúvida simples de cobrança ou boleto, de gravidade baixa",
      why: "4 de 4 dúvidas de boleto foram fechadas sem tarefa.",
      support: 4,
      status: "checking",
      origin: "mavi",
      created_at: demoAt(0.3),
      updated_at: demoAt(0.3),
    },
    {
      id: "demo-rule-3",
      topic_id: "rt-2",
      topic_name: "Promessas da Make",
      topic_color: "#2a78d6",
      all_products: true,
      action: "task",
      condition: "Promessa de entrega com data combinada com o cliente",
      team_name: "Conteúdo",
      team_id: "tm-3",
      due_days: 5,
      support: 0,
      status: "active",
      origin: "leader",
      approved_by_name: "Ana",
      approved_at: demoAt(10),
      created_at: demoAt(10),
      updated_at: demoAt(10),
    },
  ],
};

// ------------------------------------------------------------ a tarefa sugerida (Fase 3)
/**
 * A tarefa sugerida no item (migration 20270608090000_radar_task_suggestions):
 * com as regras em uso, a MAVI sugere a tarefa (ou vincular uma aberta do
 * cliente). A pessoa cria pelo formulário preenchido ou recusa com um motivo.
 */
export type SuggestionReason = "not_needed" | "exists" | "wrong_person" | "wrong_due" | "other";
export const SUGGESTION_REASONS: { value: SuggestionReason; label: string }[] = [
  { value: "not_needed", label: "Não precisa de tarefa" },
  { value: "exists", label: "Já existe tarefa para isso" },
  { value: "wrong_person", label: "Equipe ou pessoa errada" },
  { value: "wrong_due", label: "Prazo errado" },
  { value: "other", label: "Outro motivo" },
];
export type TaskSuggestion = {
  item_id: string;
  status: "pending" | "open" | "none" | "created" | "replaced" | "dismissed" | "expired" | "failed";
  decision?: "task" | "link" | "no_task" | "unsure";
  rule_id?: string;
  rule_condition?: string;
  title?: string;
  description?: string;
  team_id?: string;
  team_name?: string;
  assignee_id?: string;
  assignee_name?: string;
  due_days?: number;
  due_date?: string;
  priority?: string;
  why?: string;
  link_task_id?: string;
  link_task_title?: string;
  link_task_status?: string;
  reason?: SuggestionReason;
  note?: string;
  decided_by_name?: string;
  decided_at?: string;
  updated_at: string;
};
export type SuggestionGroup = {
  topic_id: string;
  topic_name: string;
  topic_color: string;
  product_id: string | null;
  product_name: string | null;
  open: number;
  accepted: number;
  as_is: number;
  dismissed: number;
  replaced: number;
  expired: number;
  quiet: number;
  reasons: Partial<Record<SuggestionReason, number>>;
};
export type SuggestionStats = {
  settings: { suggest: boolean; suggest_at?: string; suggest_by_name?: string };
  pending: number;
  groups: SuggestionGroup[];
};
export type SuggestEstimate = {
  items: number;
  per_month: number;
  avg_cost: number | null;
  samples: number;
  price: { input?: number; output?: number } | null;
};

/** "Para a equipe Tráfego (Bruno) · prazo 09/10 (2 dias úteis) · prioridade Alta". */
export function suggestionLine(s: TaskSuggestion) {
  const who = s.assignee_name
    ? `Para ${s.assignee_name}${s.team_name ? ` (equipe ${s.team_name})` : ""}`
    : s.team_name
      ? `Para a equipe ${s.team_name}, quem tiver menos tarefas`
      : "Para quem atende o cliente";
  const due = s.due_date
    ? `prazo ${s.due_date.slice(8, 10)}/${s.due_date.slice(5, 7)}${
        s.due_days !== undefined ? ` (${s.due_days === 1 ? "1 dia útil" : `${s.due_days} dias úteis`})` : ""
      }`
    : "";
  return [who, due, s.priority && s.priority !== "normal" ? `prioridade ${PRIORITY_LABELS[s.priority] ?? s.priority}` : ""]
    .filter(Boolean)
    .join(" · ");
}
/** Das sugestões decididas, quantas foram aceitas como vieram ("—" sem nenhuma). */
export function suggestionHitRate(g: Pick<SuggestionGroup, "as_is" | "accepted" | "dismissed" | "replaced" | "expired">) {
  const decided = g.accepted + g.dismissed + g.replaced + g.expired;
  return decided ? Math.round((g.as_is / decided) * 100) : null;
}
/** Custo de ligar: os itens que entram agora e um mês de itens novos. */
export function suggestCost(e: SuggestEstimate, fallback = { input: 4, output: 20 }) {
  const measured = e.samples >= 5 && e.avg_cost !== null && e.avg_cost !== undefined;
  const each = measured
    ? Number(e.avg_cost)
    : (4500 / 1e6) * (e.price?.input ?? fallback.input) + (400 / 1e6) * (e.price?.output ?? fallback.output);
  return { now: e.items * each, month: e.per_month * each, each, measured };
}

export async function loadSuggestion(company: string, item: string): Promise<TaskSuggestion | null> {
  if (offline(company)) return demoSuggestions.get(item) ?? null;
  return call<TaskSuggestion | null>("radar_task_suggestion", { p_company: company, p_item: item });
}
export async function dismissSuggestion(company: string, item: string, reason: SuggestionReason, note: string) {
  if (offline(company)) {
    const s = demoSuggestions.get(item);
    if (s) Object.assign(s, { status: "dismissed", reason, note, decided_by_name: "Você" });
    return s ?? null;
  }
  return call<TaskSuggestion>("radar_task_suggestion_dismiss", {
    p_company: company,
    p_item: item,
    p_reason: reason,
    p_note: note,
  });
}
/** Os itens com sugestão em aberto (o selo na lista do Radar). */
export async function suggestionItems(company: string): Promise<string[]> {
  if (offline(company)) return [...demoSuggestions.values()].filter((s) => s.status === "open").map((s) => s.item_id);
  return (await call<string[] | null>("radar_task_suggestion_items", { p_company: company })) ?? [];
}
export async function loadSuggestionStats(company: string, days: number): Promise<SuggestionStats> {
  if (offline(company)) return structuredClone(demoSuggestionStats);
  return call<SuggestionStats>("radar_task_suggestion_stats", { p_company: company, p_filters: { days } });
}
export async function estimateSuggest(company: string): Promise<SuggestEstimate> {
  if (offline(company)) return { items: 14, per_month: 60, avg_cost: null, samples: 0, price: null };
  return call<SuggestEstimate>("radar_task_suggest_estimate", { p_company: company });
}
export async function setSuggest(company: string, on: boolean): Promise<{ suggest: boolean; queued: number }> {
  if (offline(company)) {
    demoSuggestionStats.settings = { suggest: on, suggest_at: new Date().toISOString(), suggest_by_name: "Você" };
    return { suggest: on, queued: on ? 14 : 0 };
  }
  return call("set_radar_task_suggest", { p_company: company, p_on: on });
}

// Demonstração: o item demo-1 do Radar de exemplo tem uma sugestão em aberto.
const demoSuggestions = new Map<string, TaskSuggestion>([
  [
    "demo-1",
    {
      item_id: "demo-1",
      status: "open",
      decision: "task",
      rule_id: "demo-rule-1",
      rule_condition: "Problema que trava a entrada de leads: formulário, pixel ou página fora do ar",
      title: "Revisar a captação de leads — Aurora Studio",
      description:
        "Os leads caíram em setembro e a cliente cobrou na reunião.\nConferir formulário, pixel e públicos das campanhas ativas.\nPronto quando a causa estiver achada e corrigida, com o volume voltando ao de agosto.",
      team_id: "team-1",
      team_name: "Estratégia & Performance",
      due_days: 2,
      due_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      priority: "high",
      why: "A cliente disse que os leads caíram desde setembro: é um problema que trava a captação.",
      updated_at: new Date().toISOString(),
    },
  ],
]);
let demoSuggestionStats: SuggestionStats = {
  settings: { suggest: true, suggest_at: demoAt(5), suggest_by_name: "Ana" },
  pending: 2,
  groups: [
    {
      topic_id: "rt-1",
      topic_name: "Problemas/reclamações",
      topic_color: "#d64545",
      product_id: "pd-1",
      product_name: "Make Ads",
      open: 1,
      accepted: 9,
      as_is: 7,
      dismissed: 2,
      replaced: 1,
      expired: 0,
      quiet: 6,
      reasons: { wrong_due: 1, not_needed: 1 },
    },
  ],
};

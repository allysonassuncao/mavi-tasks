/**
 * The catalog of the Dashboards (migration 20260930140000_dashboards and
 * later): sources, metrics, filters, groupings, who each figure counts for,
 * the formulas and the panel types. Pure (no browser, no Supabase client):
 * the editor, the demo engine and the MAVI on the server (api/_dashboard-mavi)
 * read the same lists, which the database accepts exactly
 * (mavi_private.dashboard_sql / dashboard_check).
 */
export type Source =
  | "tasks"
  | "hours"
  | "social_leads"
  | "status_history"
  | "reviews"
  | "notices"
  | "temperature"
  | "radar"
  | "due_changes"
  // Migration 20270523090000: Customer Success (computed by src/cs-sources.ts).
  | "cs_finance"
  | "cs_portfolio"
  | "cs_health"
  | "cs_trial";
export type Viz = "stat" | "line" | "area" | "bar" | "hbar" | "donut" | "table";
export type GroupBy =
  | "none"
  | "time"
  | "client"
  | "product"
  | "project"
  | "team"
  | "person"
  | "creator"
  | "status"
  | "priority"
  | "stage"
  | "executor"
  | "previous"
  | "validator"
  | "notice"
  | "level"
  | "band"
  | "topic"
  | "theme"
  | "severity"
  | "squad"
  | "cs_category"
  | "cs_adimplencia"
  | "cs_reason"
  | "cs_band"
  | "cs_phase";
export type Interval = "auto" | "day" | "week" | "month";
/** "money" (R$) is only drawn by Campanhas' charts, not a dashboard metric. */
export type Unit = "number" | "hours" | "days" | "percent" | "money";
export type FilterField =
  | "client"
  | "product"
  | "project"
  | "team"
  | "person"
  | "creator"
  | "status"
  | "priority"
  | "late"
  | "entry_source"
  | "executor"
  | "previous"
  | "validator"
  | "level"
  | "topic"
  | "theme"
  | "severity"
  | "state"
  | "squad"
  | "cs_kind";

/**
 * Tarefas (migration 20270131090000): who each task counts for when the
 * panel shows people. "roles" (the default, also for panels saved before
 * the choice existed): each one their part; "executor": everyone who
 * executed it; "assignee": who has it now.
 */
export type Attribution = "roles" | "executor" | "assignee";

export type QueryFilter = {
  field: FilterField;
  op?: "in" | "not_in";
  values: string[];
};
export type Query = {
  ref: string;
  source: Source;
  metric: string;
  dateField?: string;
  filters: QueryFilter[];
  /** Used only by the formula, not drawn on its own. */
  hidden?: boolean;
  /** Termômetro, metric "indicator": which indicator (its key). */
  indicator?: string;
  label?: string;
  /** Tarefas: who each task counts for (absent = "roles"). */
  attribution?: Attribution;
};
export type PanelSpec = {
  viz: Viz;
  groupBy: GroupBy;
  interval?: Interval;
  /** Categories shown (the rest folds into "Outros"). */
  limit?: number;
  queries: Query[];
  formula?: { expr: string; label: string } | null;
  unit?: Unit;
  decimals?: number;
  /** Stat: compare with the previous period of the same length (when the
   *  dashboard compares with nothing). */
  compare?: boolean;
};
export type Panel = {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  spec: PanelSpec;
};
export type RangePreset =
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "month"
  | "last_month"
  | "quarter"
  | "year"
  | "12m";
export type DashboardRange =
  { preset: RangePreset } | { from: string; to: string };
/** What the period is compared with: the previous period of the same
 *  length, the same days of the month before, or dates of one's own. */
export type ComparePreset = "previous" | "last_month";
export type DashboardCompare =
  { preset: ComparePreset } | { from: string; to: string };
export type DashboardFilters = {
  clients?: string[];
  products?: string[];
  teams?: string[];
  people?: string[];
};
export type DashboardVariables = {
  range?: DashboardRange;
  filters?: DashboardFilters;
  /** The comparison (absent = none). */
  compare?: DashboardCompare | null;
  /** Who views (app and link) can change the comparison. */
  compareOpen?: boolean;
};
export type LinkAccess = "none" | "password" | "public";
export type Dashboard = {
  id: string;
  company_id: string;
  name: string;
  description: string;
  panels: Panel[];
  variables: DashboardVariables;
  link_access: LinkAccess;
  share_token: string;
  has_password: boolean;
  /** Migration 20270224090000: the link also shows each panel's records. */
  link_records?: boolean;
  /** Migration 20270522090000: 'cs' = the ready Customer Success panel (no panels). */
  kind?: "grid" | "cs";
  version: number;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};
export type SeriesRow = {
  k: string | null;
  l?: string | null;
  v: number | null;
};
export type PanelResult = {
  series: Record<string, SeriesRow[]>;
  previous: Record<string, SeriesRow[]>;
  /** The same queries over the comparison period: every group (no top N)
   *  and the period's own interval, so they line up with the series. */
  compare?: Record<string, SeriesRow[]>;
  compare_range?: { from: string; to: string };
  interval: Exclude<Interval, "auto">;
  computed_at: string;
};

// ------------------------------------------------------------ catalog
type MetricDef = { key: string; label: string; unit: Unit; additive: boolean };
export const sources: Record<
  Source,
  {
    label: string;
    metrics: MetricDef[];
    dateFields: { key: string; label: string }[];
    filters: FilterField[];
  }
> = {
  tasks: {
    label: "Tarefas",
    metrics: [
      {
        key: "count",
        label: "Quantidade de tarefas",
        unit: "number",
        additive: true,
      },
      {
        key: "late",
        label: "Tarefas atrasadas",
        unit: "number",
        additive: true,
      },
      {
        key: "estimated_hours",
        label: "Horas estimadas",
        unit: "hours",
        additive: true,
      },
      {
        key: "lead_time_days",
        label: "Prazo médio de entrega (dias)",
        unit: "days",
        additive: false,
      },
      // Migration 20261104090000: delivery quality (delivered tasks only).
      {
        key: "on_time_rate",
        label: "Entregas no prazo (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "on_time_original_rate",
        label: "Entregas no prazo original (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "delay_days",
        label: "Atraso médio das entregas atrasadas (dias)",
        unit: "days",
        additive: false,
      },
      {
        key: "first_pass_rate",
        label: "Aprovadas de primeira (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "rework_per_task",
        label: "Retrabalhos por tarefa entregue",
        unit: "number",
        additive: false,
      },
      {
        key: "rescheduled",
        label: "Tarefas com prazo alterado",
        unit: "number",
        additive: true,
      },
      // Migration 20261201120000: how the suggested due dates did.
      {
        key: "smart_hit_rate",
        label: "Entregas até a data da MAVI (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "rule_hit_rate",
        label: "Entregas até a data da regra (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "smart_error_days",
        label: "Erro médio da MAVI (dias)",
        unit: "days",
        additive: false,
      },
      {
        key: "tight_due",
        label: "Prazos apertados (antes do mínimo)",
        unit: "number",
        additive: true,
      },
      {
        key: "shorter_than_smart",
        label: "Prazos mais curtos que a MAVI sugeriu",
        unit: "number",
        additive: true,
      },
    ],
    dateFields: [
      { key: "created_at", label: "Criação" },
      { key: "due_date", label: "Prazo" },
      { key: "delivered_at", label: "Entrega" },
    ],
    filters: [
      "status",
      "priority",
      "late",
      "client",
      "product",
      "project",
      "team",
      "person",
      "creator",
      "executor",
    ],
  },
  hours: {
    label: "Horas",
    metrics: [
      {
        key: "hours",
        label: "Horas registradas",
        unit: "hours",
        additive: true,
      },
      {
        key: "entries",
        label: "Quantidade de apontamentos",
        unit: "number",
        additive: true,
      },
      {
        key: "people",
        label: "Pessoas que registraram",
        unit: "number",
        additive: false,
      },
      {
        key: "tasks",
        label: "Tarefas com horas",
        unit: "number",
        additive: false,
      },
    ],
    dateFields: [{ key: "started_at", label: "Início do apontamento" }],
    filters: ["client", "product", "project", "team", "person", "entry_source"],
  },
  // Migration 20261020120000: the posts' history, the plans and the clients.
  social_leads: {
    label: "Social Leads",
    metrics: [
      {
        key: "approvals",
        label: "Aprovações de posts",
        unit: "number",
        additive: true,
      },
      {
        key: "rejections",
        label: "Pedidos de ajuste (reprovas)",
        unit: "number",
        additive: true,
      },
      {
        key: "approval_rate",
        label: "Taxa de aprovação (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "rejection_rate",
        label: "Taxa de reprova (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "adjust_per_post",
        label: "Ajustes por post avaliado",
        unit: "number",
        additive: false,
      },
      {
        key: "approval_days",
        label: "Tempo até a aprovação do plano (dias)",
        unit: "days",
        additive: false,
      },
      {
        key: "clients",
        label: "Clientes (situação de hoje, por etapa)",
        unit: "number",
        additive: true,
      },
    ],
    // Each metric has its own date: the decision, the plan's approval.
    dateFields: [{ key: "event", label: "Data da decisão ou aprovação" }],
    filters: ["client", "product", "team", "person"],
  },
  // Migration 20261104090000: each period a task spent in a status with a
  // responsible. "Pessoa" is who held it; "Responsável anterior", who had it
  // before it entered the status (who returned it, who asked for changes).
  status_history: {
    label: "Status das tarefas",
    metrics: [
      {
        key: "entries",
        label: "Vezes no status",
        unit: "number",
        additive: true,
      },
      {
        key: "hours",
        label: "Tempo com a tarefa no status (horas, não é cronômetro)",
        unit: "hours",
        additive: true,
      },
      {
        key: "avg_hours",
        label: "Tempo médio por vez (horas)",
        unit: "hours",
        additive: false,
      },
      {
        key: "tasks",
        label: "Tarefas que passaram pelo status",
        unit: "number",
        additive: false,
      },
      {
        key: "reopens",
        label: "Reaberturas após a entrega",
        unit: "number",
        additive: true,
      },
    ],
    dateFields: [
      { key: "started_at", label: "Entrada no status" },
      { key: "ended_at", label: "Saída do status" },
    ],
    filters: [
      "status",
      "priority",
      "client",
      "product",
      "project",
      "team",
      "person",
      "previous",
      "creator",
    ],
  },
  // Same history, validation only. "Pessoa" is who sent it to validation.
  reviews: {
    label: "Validações",
    metrics: [
      {
        key: "sent",
        label: "Envios para validação",
        unit: "number",
        additive: true,
      },
      {
        key: "approved",
        label: "Aprovadas",
        unit: "number",
        additive: true,
      },
      {
        key: "reproved",
        label: "Reprovadas (voltaram para Alteração ou Correção)",
        unit: "number",
        additive: true,
      },
      {
        key: "approval_rate",
        label: "Taxa de aprovação (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "reproval_rate",
        label: "Taxa de reprovação (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "avg_hours",
        label: "Tempo médio em validação (horas)",
        unit: "hours",
        additive: false,
      },
    ],
    // Each metric has its own date: the sending or the decision.
    dateFields: [{ key: "event", label: "Data do envio ou da decisão" }],
    filters: [
      "priority",
      "client",
      "product",
      "project",
      "team",
      "person",
      "validator",
      "creator",
    ],
  },
  // Mural de avisos (migration 20261107090000): one row per person reached
  // by a notice (its current round). "Pessoa" is who received it; the
  // dashboard's client and product filters don't apply to notices.
  notices: {
    label: "Avisos do Mural",
    metrics: [
      {
        key: "notices",
        label: "Avisos enviados",
        unit: "number",
        additive: false,
      },
      {
        key: "delivered",
        label: "Entregas (pessoas alcançadas)",
        unit: "number",
        additive: true,
      },
      { key: "seen", label: "Vistos", unit: "number", additive: true },
      {
        key: "pending",
        label: "Pendentes (sem ver ou sem confirmar)",
        unit: "number",
        additive: true,
      },
      {
        key: "seen_rate",
        label: "Taxa de visto (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "acked",
        label: "Confirmações (Li e entendi)",
        unit: "number",
        additive: true,
      },
      {
        key: "ack_rate",
        label: "Taxa de confirmação (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "hours_to_see",
        label: "Tempo até ver (horas)",
        unit: "hours",
        additive: false,
      },
      {
        key: "hours_to_ack",
        label: "Tempo até confirmar (horas)",
        unit: "hours",
        additive: false,
      },
    ],
    dateFields: [{ key: "delivered_at", label: "Entrega do aviso" }],
    filters: ["level", "person", "team", "creator"],
  },
  // Termômetro do cliente (migration 20261110090000): one row per client
  // and day with the day's temperature (0–100). Averages over the
  // client-days of the period; counts are distinct clients. "Pessoa" and
  // "Equipe" are the teams that serve the client.
  temperature: {
    label: "Temperatura dos clientes",
    metrics: [
      {
        key: "score",
        label: "Temperatura média (0–100)",
        unit: "number",
        additive: false,
      },
      {
        key: "indicator",
        label: "Um indicador do termômetro (0–100)",
        unit: "number",
        additive: false,
      },
      {
        key: "clients",
        label: "Clientes com temperatura",
        unit: "number",
        additive: false,
      },
      {
        key: "alert_clients",
        label: "Clientes em faixa de alerta",
        unit: "number",
        additive: false,
      },
      {
        key: "alert_rate",
        label: "Clientes em faixa de alerta (%)",
        unit: "percent",
        additive: false,
      },
      {
        key: "flag_clients",
        label: "Clientes com sinal de alerta",
        unit: "number",
        additive: false,
      },
    ],
    dateFields: [{ key: "day", label: "Dia da temperatura" }],
    filters: ["client", "product", "team", "person"],
  },
  // Radar do cliente (migration 20261230090000): one row per item (a
  // subject of a client in a topic). "Pessoa" is the item's responsible;
  // "Ocorrências" counts each time a subject came up, by its date.
  radar: {
    label: "Radar do cliente",
    metrics: [
      { key: "items", label: "Itens", unit: "number", additive: true },
      { key: "open_items", label: "Itens em aberto", unit: "number", additive: true },
      { key: "closed_items", label: "Itens fechados", unit: "number", additive: true },
      { key: "severe", label: "Itens sérios (gravidade alta ou crítica)", unit: "number", additive: true },
      { key: "overdue", label: "Com prazo vencido (em aberto)", unit: "number", additive: true },
      { key: "recurring", label: "Que voltaram a aparecer", unit: "number", additive: true },
      { key: "mentions", label: "Ocorrências (vezes que apareceram)", unit: "number", additive: true },
      { key: "clients", label: "Clientes com itens", unit: "number", additive: false },
      { key: "avg_severity", label: "Gravidade média (0 baixa a 3 crítica)", unit: "number", additive: false },
      { key: "days_to_close", label: "Tempo médio até fechar (dias)", unit: "days", additive: false },
    ],
    dateFields: [
      { key: "created_at", label: "Primeira vez que apareceu" },
      { key: "last_seen_at", label: "Última vez que apareceu" },
      { key: "status_at", label: "Última mudança de status" },
    ],
    filters: ["topic", "theme", "state", "severity", "client", "product", "team", "person"],
  },
  // Mudanças de prazo (migration 20270110090000): each change of a task's
  // due date after its creation, with its reason. "Pessoa" is who changed it.
  due_changes: {
    label: "Mudanças de prazo",
    metrics: [
      { key: "changes", label: "Mudanças de prazo", unit: "number", additive: true },
      { key: "tasks", label: "Tarefas com prazo mudado", unit: "number", additive: false },
      { key: "later", label: "Prazos adiados", unit: "number", additive: true },
      { key: "earlier", label: "Prazos antecipados", unit: "number", additive: true },
      { key: "avg_days", label: "Dias movidos em média", unit: "days", additive: false },
    ],
    dateFields: [{ key: "created_at", label: "Data da mudança" }],
    filters: ["priority", "client", "product", "project", "team", "person", "creator"],
  },
  // Customer Success (migration 20270523090000): the CS Make panel's engine
  // (src/cs-engine.ts) computes these on the screen, by month. "Cliente" is
  // the CS client; the dashboard's client filter uses its MAVI client.
  cs_finance: {
    label: "Customer Success · Financeiro",
    metrics: [
      { key: "revenue", label: "Faturamento efetivo (regra M1)", unit: "money", additive: true },
      { key: "planned", label: "Planejado (provável)", unit: "money", additive: true },
      { key: "best", label: "Planejado (melhor)", unit: "money", additive: true },
      { key: "received", label: "Recebido (valor pago, sem a regra M1)", unit: "money", additive: true },
      { key: "open", label: "Em aberto (a receber)", unit: "money", additive: true },
      { key: "ticket", label: "Ticket médio (faturamento ÷ pagantes efetivos)", unit: "money", additive: false },
      { key: "fees", label: "Mensalidades recebidas (fora da meta)", unit: "money", additive: true },
      { key: "goal", label: "Meta de faturamento", unit: "money", additive: true },
      { key: "attainment", label: "Atingimento da meta (%)", unit: "percent", additive: false },
    ],
    dateFields: [{ key: "month", label: "Mês do ciclo (competência)" }],
    filters: ["client", "squad", "cs_kind"],
  },
  cs_portfolio: {
    label: "Customer Success · Carteira",
    metrics: [
      { key: "active", label: "Clientes ativos (no fim do mês)", unit: "number", additive: false },
      { key: "payers", label: "Pagantes (pagaram algo no mês)", unit: "number", additive: false },
      { key: "new", label: "Entradas (clientes novos)", unit: "number", additive: true },
      { key: "reactivations", label: "Reativações", unit: "number", additive: true },
      { key: "churns", label: "Churns (saídas)", unit: "number", additive: true },
      { key: "net", label: "Net churn (entradas − saídas)", unit: "number", additive: true },
    ],
    dateFields: [{ key: "event", label: "Mês (ativos e pagantes) ou data da entrada e da saída" }],
    filters: ["client", "squad", "cs_kind"],
  },
  cs_health: {
    label: "Customer Success · Saúde",
    metrics: [
      { key: "hs_avg", label: "Health Score médio (%)", unit: "percent", additive: false },
      { key: "hs_clients", label: "Clientes com Health Score (no fim do período)", unit: "number", additive: false },
      { key: "hs_critical", label: "Clientes em Crítico (no fim do período)", unit: "number", additive: false },
      { key: "adimp_rate", label: "Taxa de adimplência dos ciclos (%)", unit: "percent", additive: false },
      { key: "cycles", label: "Ciclos (agrupe por adimplência)", unit: "number", additive: true },
    ],
    dateFields: [{ key: "month", label: "Mês da nota e do ciclo" }],
    filters: ["client", "squad", "cs_kind"],
  },
  cs_trial: {
    label: "Customer Success · Trial",
    metrics: [
      { key: "in_trial", label: "Clientes em trial (no fim do período)", unit: "number", additive: false },
      { key: "graduated", label: "Graduados para Base", unit: "number", additive: true },
      { key: "grad_rate", label: "Taxa de graduação (graduados ÷ entradas de 3 meses antes) (%)", unit: "percent", additive: false },
      { key: "trial_churns", label: "Churns por mês de trial", unit: "number", additive: true },
    ],
    dateFields: [{ key: "event", label: "Mês" }],
    filters: ["client", "squad", "cs_kind"],
  },
};
/** The Customer Success sources (computed on the screen, not by the database's SQL). */
export const CS_SOURCES: Source[] = ["cs_finance", "cs_portfolio", "cs_health", "cs_trial"];
export const isCsSource = (s: Source | string) => s.startsWith("cs_");
export const isCsSpec = (spec: Pick<PanelSpec, "queries">) => spec.queries.some((q) => isCsSource(q.source));
export const metricDef = (q: Pick<Query, "source" | "metric">) =>
  sources[q.source]?.metrics.find((m) => m.key === q.metric);

export const filterLabels: Record<FilterField, string> = {
  client: "Cliente",
  product: "Produto",
  project: "Projeto",
  team: "Equipe",
  person: "Pessoa",
  creator: "Criador",
  status: "Status",
  priority: "Prioridade",
  late: "Atraso",
  entry_source: "Origem do apontamento",
  executor: "Quem executou (todos)",
  previous: "Responsável anterior",
  validator: "Quem validou",
  level: "Nível do aviso",
  topic: "Tópico do Radar",
  theme: "Tema do Radar",
  severity: "Gravidade",
  state: "Situação (aberto, em andamento, fechado)",
  squad: "Squad",
  cs_kind: "Tipo de cliente (Trial ou Base)",
};

export const groupOptions: {
  key: GroupBy;
  label: string;
  sources: Source[];
}[] = [
  {
    key: "none",
    label: "Total (sem agrupar)",
    sources: [
      "tasks",
      "hours",
      "social_leads",
      "status_history",
      "reviews",
      "notices",
      "temperature",
      "radar",
      "due_changes",
      ...CS_SOURCES,
    ],
  },
  {
    key: "time",
    label: "Tempo (dia, semana, mês)",
    sources: [
      "tasks",
      "hours",
      "social_leads",
      "status_history",
      "reviews",
      "notices",
      "temperature",
      "radar",
      "due_changes",
      ...CS_SOURCES,
    ],
  },
  {
    key: "client",
    label: "Cliente",
    sources: [
      "tasks",
      "hours",
      "social_leads",
      "status_history",
      "reviews",
      "temperature",
      "radar",
      "due_changes",
      ...CS_SOURCES,
    ],
  },
  {
    key: "product",
    label: "Produto",
    sources: [
      "tasks",
      "hours",
      "social_leads",
      "status_history",
      "reviews",
      "temperature",
      "radar",
      "due_changes",
    ],
  },
  {
    key: "project",
    label: "Projeto",
    sources: ["tasks", "hours", "status_history", "reviews", "due_changes"],
  },
  {
    key: "team",
    label: "Equipe",
    sources: [
      "tasks",
      "hours",
      "status_history",
      "reviews",
      "notices",
      "temperature",
      "radar",
      "due_changes",
    ],
  },
  {
    key: "person",
    label: "Pessoa (veja no ⓘ do painel o que cada dado conta)",
    sources: [
      "tasks",
      "hours",
      "social_leads",
      "status_history",
      "reviews",
      "notices",
      "radar",
      "due_changes",
    ],
  },
  {
    key: "executor",
    label: "Quem executou a tarefa (todos que executaram)",
    sources: ["tasks"],
  },
  {
    key: "previous",
    label: "Responsável anterior",
    sources: ["status_history"],
  },
  { key: "validator", label: "Quem validou", sources: ["reviews"] },
  { key: "notice", label: "Aviso", sources: ["notices"] },
  { key: "level", label: "Nível do aviso", sources: ["notices"] },
  { key: "band", label: "Faixa do termômetro", sources: ["temperature"] },
  {
    key: "creator",
    label: "Criador da tarefa (ou autor do aviso)",
    sources: ["tasks", "status_history", "reviews", "notices", "due_changes"],
  },
  {
    key: "status",
    label: "Status (no Radar: aberto, em andamento, fechado)",
    sources: ["tasks", "status_history", "radar"],
  },
  { key: "topic", label: "Tópico do Radar", sources: ["radar"] },
  { key: "theme", label: "Tema do Radar", sources: ["radar"] },
  { key: "severity", label: "Gravidade", sources: ["radar"] },
  {
    key: "priority",
    label: "Prioridade",
    sources: ["tasks", "status_history", "reviews", "due_changes"],
  },
  {
    key: "stage",
    label: "Etapa (clientes do Social Leads)",
    sources: ["social_leads"],
  },
  // Customer Success (migration 20270523090000).
  { key: "squad", label: "Squad (o do mês)", sources: CS_SOURCES },
  { key: "cs_category", label: "Fase do ciclo (Trial, Base, ACL)", sources: ["cs_finance", "cs_health"] },
  { key: "cs_adimplencia", label: "Adimplência do ciclo", sources: ["cs_finance", "cs_health"] },
  { key: "cs_reason", label: "Motivo do churn", sources: ["cs_portfolio"] },
  { key: "cs_band", label: "Faixa do Health Score", sources: ["cs_health"] },
  { key: "cs_phase", label: "Mês do trial (M1, M2, M3, M4+)", sources: ["cs_trial"] },
];
/** Groupings every query of the panel supports. */
export const groupsFor = (queries: Pick<Query, "source">[]) =>
  groupOptions.filter((g) =>
    queries.every((q) => g.sources.includes(q.source)),
  );

// ------------------------------------------------------------ people
export const attributionOptions: {
  key: Attribution;
  label: string;
  hint: string;
}[] = [
  {
    key: "roles",
    label: "Cada um a sua parte",
    hint: "A tarefa conta para todos que a executaram; a atrasada, para quem estava com ela quando o prazo venceu; o prazo apertado, para quem criou.",
  },
  {
    key: "executor",
    label: "Todos que executaram",
    hint: "Tudo da tarefa conta para quem esteve com ela em Em andamento, Alteração ou Correção.",
  },
  {
    key: "assignee",
    label: "Responsável atual",
    hint: "Conta para quem está com a tarefa agora. Em validação, é quem valida, não quem executou.",
  },
];
export const attributionOf = (q: Pick<Query, "attribution">): Attribution =>
  q.attribution ?? "roles";

const PEOPLE_GROUPS: GroupBy[] = ["person", "executor", "previous", "validator"];
const EXECUTORS =
  "Conta para todos que executaram a tarefa (Em andamento, Alteração ou Correção), não para quem a valida. Feita por duas pessoas, aparece nas duas; o total conta a tarefa uma vez.";
// Migration 20270209090000: on tasks and hours, a team is its people.
const TEAM_BY_PEOPLE: Query["source"][] = ["tasks", "hours", "status_history", "reviews", "due_changes"];
const TEAM_PEOPLE =
  "Cada equipe conta o que as pessoas dela contariam no filtro Pessoa, mesmo nas tarefas entregues direto a alguém. Quem está em duas equipes aparece nas duas; quem não está em nenhuma, em Sem equipe.";
const HELD_TIME =
  "É o tempo em que a tarefa ficou com a pessoa nesse status, não horas trabalhadas (essas vêm do cronômetro). Em validação, o tempo é de quem valida; em Devolvida, de quem precisa responder.";

/** What one query counts for each person, in words (null: nothing to say). */
export function personNote(q: Query, group: GroupBy): string | null {
  const people = PEOPLE_GROUPS.includes(group);
  if (q.source === "status_history" && (q.metric === "hours" || q.metric === "avg_hours"))
    return HELD_TIME;
  if (group === "team" && TEAM_BY_PEOPLE.includes(q.source)) return TEAM_PEOPLE;
  if (!people) return null;
  switch (q.source) {
    case "tasks": {
      const mode = group === "executor" ? "executor" : attributionOf(q);
      if (mode === "assignee")
        return "Conta para quem está com a tarefa agora. Em validação, é quem valida, não quem executou.";
      if (q.metric === "estimated_hours")
        return "Horas estimadas de quem executou, divididas entre as pessoas quando mais de uma executou. Não são horas do cronômetro.";
      if (mode === "executor") return EXECUTORS;
      if (q.metric === "late")
        return "Conta para quem estava com a tarefa quando o prazo venceu: se ela já estava em validação, o atraso é de quem validava; se foi enviada depois do prazo, é de quem executou.";
      if (q.metric === "tight_due" || q.metric === "shorter_than_smart")
        return "Conta para quem criou a tarefa (quem definiu o prazo).";
      return EXECUTORS;
    }
    case "hours":
      return "Horas do cronômetro e dos apontamentos, de quem registrou.";
    case "status_history":
      return group === "previous"
        ? "Conta para quem estava com a tarefa antes de ela entrar no status."
        : q.metric === "entries"
          ? "Vezes em que a tarefa entrou no status com a pessoa. Devolvida conta para quem devolveu."
          : "Conta para quem estava com a tarefa no status.";
    case "reviews":
      return group === "validator"
        ? "Conta para quem validou (ou está validando)."
        : "Conta para quem enviou para validação.";
    case "due_changes":
      return "Conta para quem mudou o prazo.";
    case "notices":
      return "Conta para quem recebeu o aviso.";
    case "radar":
      return "Conta para o responsável pelo item do Radar.";
    case "social_leads":
      return "Conta para quem decidiu (ou para o responsável pelo cliente).";
    default:
      return null;
  }
}

/** The panel's ⓘ: what each visible query counts, without repeating. */
export function panelNotes(spec: PanelSpec): string[] {
  const notes = spec.queries
    .filter((q) => !q.hidden || spec.formula)
    .map((q) => ({ name: queryName(q), text: personNote(q, spec.groupBy) }))
    .filter((n): n is { name: string; text: string } => !!n.text);
  const texts = [...new Set(notes.map((n) => n.text))];
  if (texts.length <= 1) return texts;
  return texts.map((text) => {
    const names = notes.filter((n) => n.text === text).map((n) => n.name);
    return `${names.join(", ")}: ${text}`;
  });
}

export const vizOptions: { key: Viz; label: string }[] = [
  { key: "stat", label: "Número" },
  { key: "line", label: "Linha" },
  { key: "area", label: "Área" },
  { key: "bar", label: "Colunas" },
  { key: "hbar", label: "Barras horizontais" },
  { key: "donut", label: "Rosca" },
  { key: "table", label: "Tabela" },
];

export const rangeOptions: { key: RangePreset; label: string }[] = [
  { key: "today", label: "Hoje" },
  { key: "7d", label: "Últimos 7 dias" },
  { key: "30d", label: "Últimos 30 dias" },
  { key: "90d", label: "Últimos 90 dias" },
  { key: "month", label: "Este mês" },
  { key: "last_month", label: "Mês passado" },
  { key: "quarter", label: "Este trimestre" },
  { key: "year", label: "Este ano" },
  { key: "12m", label: "Últimos 12 meses" },
];

export const compareOptions: { key: ComparePreset; label: string }[] = [
  { key: "previous", label: "Período anterior" },
  { key: "last_month", label: "Mesmo período do mês passado" },
];

export function queryName(q: Query) {
  return q.label?.trim() || metricDef(q)?.label || q.ref;
}

// ------------------------------------------------------------ formulas
type Node =
  | { t: "num"; v: number }
  | { t: "ref"; v: string }
  | { t: "neg"; a: Node }
  | { t: "op"; op: "+" | "-" | "*" | "/"; a: Node; b: Node };

/**
 * Parses "A / B * 100": references A–E, numbers, + - * / and parentheses.
 * Never evaluates code. Returns the tree or an error in words.
 */
export function parseFormula(
  expr: string,
): { ok: true; node: Node; refs: string[] } | { ok: false; error: string } {
  const tokens = expr.match(/\s*([A-E]|\d+(?:[.,]\d+)?|[()+\-*/])\s*/g);
  const joined = (tokens ?? []).join("").replace(/\s+/g, "");
  if (!tokens || joined !== expr.replace(/\s+/g, ""))
    return {
      ok: false,
      error: "Use apenas A a E, números, + - * / e parênteses.",
    };
  const list = tokens.map((t) => t.trim());
  let i = 0;
  const refs = new Set<string>();
  function primary(): Node {
    const t = list[i++];
    if (t === undefined) throw Error("A fórmula terminou antes do esperado.");
    if (t === "(") {
      const n = sum();
      if (list[i++] !== ")") throw Error("Falta fechar um parêntese.");
      return n;
    }
    if (t === "-") return { t: "neg", a: primary() };
    if (/^[A-E]$/.test(t)) {
      refs.add(t);
      return { t: "ref", v: t };
    }
    if (/^\d/.test(t)) return { t: "num", v: Number(t.replace(",", ".")) };
    throw Error(`Não esperava "${t}" aqui.`);
  }
  function product(): Node {
    let n = primary();
    while (list[i] === "*" || list[i] === "/") {
      const op = list[i++] as "*" | "/";
      n = { t: "op", op, a: n, b: primary() };
    }
    return n;
  }
  function sum(): Node {
    let n = product();
    while (list[i] === "+" || list[i] === "-") {
      const op = list[i++] as "+" | "-";
      n = { t: "op", op, a: n, b: product() };
    }
    return n;
  }
  try {
    if (!list.length)
      throw Error("Escreva uma fórmula, por exemplo A / B * 100.");
    const node = sum();
    if (i < list.length) throw Error(`Não esperava "${list[i]}" aqui.`);
    return { ok: true, node, refs: [...refs] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Evaluates a parsed formula; a missing value or division by zero gives null. */
export function evaluate(
  node: Node,
  values: Record<string, number | null>,
): number | null {
  switch (node.t) {
    case "num":
      return node.v;
    case "ref":
      return values[node.v] ?? null;
    case "neg": {
      const a = evaluate(node.a, values);
      return a === null ? null : -a;
    }
    case "op": {
      const a = evaluate(node.a, values);
      const b = evaluate(node.b, values);
      if (a === null || b === null) return null;
      if (node.op === "/") return b === 0 ? null : a / b;
      return node.op === "+" ? a + b : node.op === "-" ? a - b : a * b;
    }
  }
}

// ------------------------------------------------------------ checking
const ATTRIBUTIONS: Attribution[] = ["roles", "executor", "assignee"];
const LIMITS = [5, 10, 15, 20, 30, 50];
const REF_KEYS = ["A", "B", "C", "D", "E"];
const UNITS: Unit[] = ["number", "hours", "days", "percent"];
type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {};
const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** The size a panel of this kind starts with on the grid. */
export function defaultSize(viz: Viz): { w: number; h: number } {
  if (viz === "stat") return { w: 3, h: 3 };
  if (viz === "table") return { w: 12, h: 6 };
  if (viz === "donut" || viz === "hbar") return { w: 6, h: 6 };
  return { w: 12, h: 5 };
}

/**
 * A panel described from outside (the MAVI), checked against the catalog:
 * the panel with only what the module knows, or what is wrong in words (for
 * the MAVI to fix). The database checks it again on save.
 */
export function checkSpec(
  input: unknown,
  allowed: Source[] = Object.keys(sources) as Source[],
): { ok: true; spec: PanelSpec } | { ok: false; error: string } {
  const s = obj(input);
  const viz = s.viz as Viz;
  if (!vizOptions.some((v) => v.key === viz))
    return { ok: false, error: `viz inválida: use ${vizOptions.map((v) => v.key).join(", ")}.` };
  const list = Array.isArray(s.queries) ? s.queries : [];
  if (!list.length || list.length > 5)
    return { ok: false, error: "Cada painel tem de 1 a 5 consultas." };
  const queries: Query[] = [];
  for (const [i, raw] of list.entries()) {
    const q = obj(raw);
    const source = q.source as Source;
    if (!allowed.includes(source))
      return { ok: false, error: `Consulta ${i + 1}: fonte "${String(q.source)}" não existe ou não está disponível.` };
    const def = sources[source];
    const metric = String(q.metric ?? "");
    if (!def.metrics.some((m) => m.key === metric))
      return {
        ok: false,
        error: `Consulta ${i + 1}: a fonte ${source} não tem a métrica "${metric}" (use ${def.metrics.map((m) => m.key).join(", ")}).`,
      };
    const ref = REF_KEYS.includes(String(q.ref)) && !queries.some((x) => x.ref === q.ref)
      ? String(q.ref)
      : REF_KEYS.find((r) => !queries.some((x) => x.ref === r) && !list.some((o) => obj(o).ref === r)) ??
        REF_KEYS[i];
    const dateField = def.dateFields.some((d) => d.key === q.dateField)
      ? String(q.dateField)
      : def.dateFields[0].key;
    const filters: QueryFilter[] = [];
    for (const rawFilter of (Array.isArray(q.filters) ? q.filters : []).slice(0, 8)) {
      const f = obj(rawFilter);
      const field = f.field as FilterField;
      if (!def.filters.includes(field))
        return {
          ok: false,
          error: `Consulta ${i + 1}: a fonte ${source} não filtra por "${String(f.field)}" (use ${def.filters.join(", ")}).`,
        };
      const values = (Array.isArray(f.values) ? f.values : [])
        .map((v) => text(v, 80))
        .filter(Boolean)
        .slice(0, 50);
      if (field === "late" && !["true", "false"].includes(values[0] ?? ""))
        return { ok: false, error: `Consulta ${i + 1}: o filtro late usa ["true"] ou ["false"].` };
      if (!values.length) continue;
      filters.push({ field, op: f.op === "not_in" ? "not_in" : "in", values: field === "late" ? [values[0]] : values });
    }
    const query: Query = { ref, source, metric, dateField, filters };
    const label = text(q.label, 60);
    if (label) query.label = label;
    if (q.hidden === true) query.hidden = true;
    if (source === "tasks" && ATTRIBUTIONS.includes(q.attribution as Attribution) && q.attribution !== "roles")
      query.attribution = q.attribution as Attribution;
    if (source === "temperature" && metric === "indicator") {
      const indicator = text(q.indicator, 40);
      if (!/^[a-z][a-z0-9_]{1,39}$/.test(indicator))
        return { ok: false, error: `Consulta ${i + 1}: diga qual indicador do termômetro (indicator).` };
      query.indicator = indicator;
    }
    queries.push(query);
  }
  const groupBy = (viz === "stat" ? "none" : s.groupBy ?? "none") as GroupBy;
  const groups = groupsFor(queries).map((g) => g.key);
  if (!groups.includes(groupBy))
    return {
      ok: false,
      error: `Agrupamento "${String(s.groupBy)}" não serve para estas consultas (use ${groups.join(", ")}).`,
    };
  const spec: PanelSpec = { viz, groupBy, queries };
  if (groupBy === "time")
    spec.interval = ["day", "week", "month"].includes(String(s.interval)) ? (s.interval as Interval) : "auto";
  if (!["none", "time"].includes(groupBy)) {
    const n = Number(s.limit) || 10;
    spec.limit = LIMITS.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), 10);
  }
  const f = obj(s.formula);
  const expr = text(f.expr, 200);
  if (expr) {
    const parsed = parseFormula(expr);
    if (!parsed.ok) return { ok: false, error: `Fórmula: ${parsed.error}` };
    const missing = parsed.refs.filter((r) => !queries.some((q) => q.ref === r));
    if (missing.length) return { ok: false, error: `Fórmula usa ${missing.join(", ")}, que não existe.` };
    spec.formula = { expr, label: text(f.label, 80) };
  } else if (queries.some((q) => q.hidden)) {
    for (const q of queries) delete q.hidden;
  }
  if (UNITS.includes(s.unit as Unit)) spec.unit = s.unit as Unit;
  if ([0, 1, 2].includes(s.decimals as number)) spec.decimals = s.decimals as number;
  if (viz === "stat") spec.compare = s.compare !== false;
  return { ok: true, spec };
}

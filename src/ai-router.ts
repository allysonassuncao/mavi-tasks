import { supabase } from "./supabase";

/**
 * Painel da MAVI › Roteamento (migrações 20270528090000 e 20270529090000):
 * a configuração do roteador de modelos, as exceções por pessoa, cliente e
 * produto, o "Automático" das regras e o desempenho real por tipo de pedido
 * e modelo.
 */

export type CostLevel = "economico" | "equilibrado" | "maxima";
export type RouterMode = "shadow" | "active";
export type RouterScopeType = "user" | "client" | "contract";

/** O id do Servidor (a Claude da Vercel) nas listas de provedores permitidos. */
export const SERVER_PROVIDER = "00000000-0000-0000-0000-000000000000";

export const LEVELS: { id: CostLevel; label: string; hint: string }[] = [
  { id: "economico", label: "Econômico", hint: "Modelos rápidos e baratos; o forte só no que é muito complexo." },
  { id: "equilibrado", label: "Equilibrado", hint: "Modelo forte só nos pedidos complexos; os simples vão para os rápidos." },
  { id: "maxima", label: "Máxima qualidade", hint: "Sempre o melhor modelo que atende; economiza só no trivial." },
];
export const levelLabel = (l: string | null | undefined) => LEVELS.find((x) => x.id === l)?.label ?? "—";

/** As telas em que se conversa com a MAVI. */
export const SURFACES: { id: string; label: string }[] = [
  { id: "bubble", label: "Bolinha" },
  { id: "page", label: "Módulo MAVI" },
  { id: "campaigns", label: "Conversa das Campanhas" },
  { id: "whatsapp", label: "Perguntar ao histórico (WhatsApp)" },
  { id: "meetings", label: "Histórico das reuniões" },
  { id: "meeting", label: "Pergunta a uma gravação" },
  { id: "task_search", label: "Busca avançada" },
  { id: "copilot", label: "Copiloto das tarefas" },
  { id: "dashboard", label: "MAVI nos Dashboards" },
  { id: "tutorials", label: "Busca nos tutoriais" },
  { id: "skill_coach", label: "Assistente de skills" },
  { id: "personal_radar", label: "Radar pessoal" },
];
export const surfaceLabel = (s: string) => SURFACES.find((x) => x.id === s)?.label ?? s;

export const TASK_TYPES: Record<string, string> = {
  conversa: "Conversa",
  consulta: "Consulta",
  busca: "Busca no histórico",
  analise: "Análise",
  redacao: "Redação",
  planejamento: "Planejamento",
  acao: "Ação",
  visual: "Visual",
  codigo: "Código",
  utilitario: "Utilitário",
};

export type RouterScope = {
  type: RouterScopeType;
  scope_id: string;
  level: CostLevel | null;
  providers: string[] | null;
  sigiloso: boolean;
  updated_at?: string;
};
export type RouterSettings = {
  mode: RouterMode;
  level: CostLevel;
  surface_levels: Record<string, CostLevel>;
  escalate: boolean;
  escalate_cap: number;
  /** null: todos os provedores. */
  providers: string[] | null;
  /** null: os mesmos permitidos. */
  secret_providers: string[] | null;
  /** Fase 4: a parte das respostas sem sinal que vai para a autoavaliação. */
  judge_sample: number;
  /** Testes fora do ar: ligados, a parte das respostas testadas e o teto por dia. */
  eval_enabled: boolean;
  eval_rate: number;
  eval_daily_cap: number;
  /** Fase 5: no automático, só modelos aprovados no conjunto de avaliação (nota mínima de 0 a 1). */
  gate_enabled: boolean;
  gate_min: number;
  updated_at?: string | null;
  scopes: RouterScope[];
};

/** O ranking interno e os testes fora do ar (Painel da MAVI › Roteamento). */
export type RouteLearning = {
  refreshed_at: string | null;
  rank: { task_type: string; model: string; live_n: number; live_good: number; eval_n: number; eval_ok: number; quality: number }[];
  evals: {
    id: number;
    at: string;
    task_type: string;
    complexity: number;
    base_model: string;
    candidate_model: string;
    status: "pending" | "done" | "error";
    verdict: "better" | "same" | "worse" | null;
    confidence: number | null;
    explanation: string | null;
    cost_usd: number;
    question: string | null;
  }[];
  spent_today: number;
  samples_today: number;
};

export type RouteStatRow = {
  task_type: string;
  model: string;
  n: number;
  cost_avg: number;
  total_ms_p50: number | null;
  total_ms_p95: number | null;
  first_token_ms_p50: number | null;
  tool_fail_rate: number | null;
  up: number;
  down: number;
  judged: number;
  judged_bad: number;
  quality: number;
  complexity_avg: number;
};
export type RouteStats = {
  total: number;
  by_type_model: RouteStatRow[];
  shadow: {
    agree: number;
    differ: number;
    locked: number;
    est_ratio: number | null;
    by_suggestion: { task_type: string; complexity: number; used_model: string; suggested_model: string | null; n: number }[];
  };
};
export type RouteRecent = {
  id: number;
  at: string;
  user_id: string | null;
  surface: string;
  task_type: string;
  complexity: number;
  mode: "shadow" | "locked" | "auto";
  locked_by: string | null;
  suggested_model: string | null;
  used_model: string;
  reason: string;
  first_token_ms: number | null;
  total_ms: number;
  cost_usd: number;
  tools_failed: number;
  escalated: boolean;
  error: string | null;
};

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

/** O que a tela faz (no banco ou, na demonstração, em memória). */
export type RouterApi = {
  get: () => Promise<RouterSettings>;
  save: (patch: Partial<Omit<RouterSettings, "scopes" | "updated_at">>) => Promise<unknown>;
  saveScope: (type: RouterScopeType, id: string, level: CostLevel | null, providers: string[] | null, sigiloso: boolean) => Promise<unknown>;
  stats: (days: number) => Promise<RouteStats>;
  recent: (limit: number) => Promise<RouteRecent[]>;
  learning: () => Promise<RouteLearning>;
  /** Atualiza o ranking agora (sem esperar a hora cheia). */
  rankNow: () => Promise<unknown>;
};

export const serverRouter = (company: string): RouterApi => ({
  get: () => rpc<RouterSettings>("ai_router_get", { p_company: company }),
  save: (patch) => rpc("ai_router_save", { p_company: company, p_settings: patch }),
  saveScope: (type, id, level, providers, sigiloso) =>
    rpc("ai_router_scope_save", {
      p_company: company,
      p_type: type,
      p_id: id,
      p_level: level,
      p_providers: providers,
      p_sigiloso: sigiloso,
    }),
  stats: (days) => rpc<RouteStats>("ai_route_stats", { p_company: company, p_days: days }),
  recent: (limit) => rpc<RouteRecent[]>("ai_route_recent", { p_company: company, p_limit: limit }),
  learning: () => rpc<RouteLearning>("ai_route_learning", { p_company: company }),
  rankNow: () => rpc("ai_route_rank_now", { p_company: company }),
});

/** "Automático" numa regra de Quem usa qual modelo. */
export const setRouteAuto = (company: string, type: string, id: string | null, feature: string | null, auto: boolean) =>
  rpc("ai_set_route_auto", { p_company: company, p_type: type, p_id: id, p_feature: feature, p_auto: auto });

/** Na demonstração: tudo em memória, com números de exemplo. */
export function demoRouter(): RouterApi {
  let s: RouterSettings = {
    mode: "shadow",
    level: "equilibrado",
    surface_levels: {},
    escalate: true,
    escalate_cap: 0.5,
    providers: null,
    secret_providers: null,
    judge_sample: 0.1,
    eval_enabled: true,
    eval_rate: 0.2,
    eval_daily_cap: 0.5,
    gate_enabled: false,
    gate_min: 0.8,
    scopes: [],
  };
  return {
    get: async () => s,
    save: async (patch) => {
      s = { ...s, ...patch };
    },
    saveScope: async (type, id, level, providers, sigiloso) => {
      const others = s.scopes.filter((x) => !(x.type === type && x.scope_id === id));
      s = {
        ...s,
        scopes: level || providers || sigiloso ? [...others, { type, scope_id: id, level, providers, sigiloso }] : others,
      };
    },
    stats: async () => ({
      total: 412,
      by_type_model: [
        { task_type: "consulta", model: "claude-opus-5-5", n: 180, cost_avg: 0.031, total_ms_p50: 6100, total_ms_p95: 14800, first_token_ms_p50: 2300, tool_fail_rate: 0.02, up: 21, down: 2, judged: 30, judged_bad: 1, quality: 0.94, complexity_avg: 1.2 },
        { task_type: "analise", model: "claude-opus-5-5", n: 96, cost_avg: 0.092, total_ms_p50: 18400, total_ms_p95: 41000, first_token_ms_p50: 3900, tool_fail_rate: 0.05, up: 14, down: 3, judged: 22, judged_bad: 2, quality: 0.86, complexity_avg: 2.4 },
        { task_type: "redacao", model: "claude-opus-5-5", n: 71, cost_avg: 0.044, total_ms_p50: 9200, total_ms_p95: 21000, first_token_ms_p50: 2800, tool_fail_rate: 0, up: 12, down: 1, judged: 15, judged_bad: 0, quality: 0.97, complexity_avg: 2 },
      ],
      shadow: {
        agree: 120,
        differ: 270,
        locked: 22,
        est_ratio: 0.38,
        by_suggestion: [
          { task_type: "consulta", complexity: 1, used_model: "claude-opus-5-5", suggested_model: "claude-haiku-4-5", n: 150 },
          { task_type: "redacao", complexity: 2, used_model: "claude-opus-5-5", suggested_model: "claude-sonnet-5", n: 60 },
        ],
      },
    }),
    recent: async () => [],
    learning: async () => ({
      refreshed_at: new Date().toISOString(),
      rank: [
        { task_type: "consulta", model: "claude-haiku-4-5", live_n: 4, live_good: 4, eval_n: 26, eval_ok: 25, quality: 0.94 },
        { task_type: "consulta", model: "claude-opus-5-5", live_n: 180, live_good: 169, eval_n: 0, eval_ok: 0, quality: 0.93 },
        { task_type: "analise", model: "claude-opus-5-5", live_n: 96, live_good: 83, eval_n: 0, eval_ok: 0, quality: 0.86 },
        { task_type: "analise", model: "claude-sonnet-5", live_n: 0, live_good: 0, eval_n: 12, eval_ok: 7, quality: 0.66 },
      ],
      evals: [
        {
          id: 2,
          at: new Date().toISOString(),
          task_type: "consulta",
          complexity: 1,
          base_model: "claude-opus-5-5",
          candidate_model: "claude-haiku-4-5",
          status: "done",
          verdict: "same",
          confidence: 0.8,
          explanation: "As duas trazem o contato certo, com a fonte.",
          cost_usd: 0.004,
          question: "Qual o e-mail do financeiro da ACME?",
        },
      ],
      spent_today: 0.12,
      samples_today: 6,
    }),
    rankNow: async () => 4,
  };
}

export const ms = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v < 1000 ? `${v} ms` : `${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
export const usd = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : `US$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: Number(v) < 0.1 ? 4 : 2 })}`;
export const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(Number(v) * 100)}%`;

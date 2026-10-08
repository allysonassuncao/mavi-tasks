import { supabase } from "./supabase";
import { FEATURES } from "./ai-providers";

/**
 * Painel da MAVI › Avaliação (migração 20270617090000): a avaliação
 * dinâmica. Cada módulo que usa a MAVI grava os 10 registros mais recentes
 * (a entrada inteira, as consultas e a resposta); um teste repete esses
 * registros com outro modelo e o juiz compara às cegas com a resposta
 * original. A liberação (só modelos aprovados no automático) fica nas
 * configurações do roteador.
 */

export type EvalSample = {
  id: number;
  feature: string;
  question: string;
  model: string;
  provider: string;
  client_id: string | null;
  sigiloso: boolean;
  /** Quantas consultas ao sistema a resposta original fez. */
  tools: number;
  cost_usd: number;
  ms: number | null;
  created_at: string;
};
export type EvalRun = {
  id: string;
  provider_id: string | null;
  provider: string;
  model: string;
  status: "running" | "done" | "cancelled";
  features: string[] | null;
  /** Do teste semanal. */
  auto: boolean;
  cases_total: number;
  cases_done: number;
  cases_failed: number;
  /** A parte dos registros em que o modelo foi igual ou melhor que a original (0 a 1). */
  score: number | null;
  wins: number;
  ties: number;
  losses: number;
  cost_usd: number;
  cap_usd: number;
  avg_ms: number | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
  /** O gasto só das respostas do modelo testado (sem o juiz) e o das originais, nos mesmos registros. */
  answer_cost: number | null;
  base_cost: number | null;
  /** A espera média das respostas originais, nos mesmos registros. */
  base_ms: number | null;
};
export type EvalOverview = {
  samples: EvalSample[];
  runs: EvalRun[];
  latest: { provider_id: string | null; model: string; score: number; run_id: string; finished_at: string }[];
  settings: { weekly: boolean; weekly_cap: number };
};
export type EvalResult = {
  id: number;
  sample_id: number | null;
  feature: string | null;
  question: string | null;
  /** A resposta original. */
  reference: string | null;
  base_model: string | null;
  base_cost: number | null;
  base_ms: number | null;
  status: "pending" | "done" | "error" | "skipped";
  answer: string | null;
  /** O gasto só da resposta do modelo testado (sem o juiz). */
  answer_cost: number | null;
  outcome: "win" | "tie" | "loss" | null;
  explanation: string | null;
  ms: number | null;
  cost_usd: number;
  error: string | null;
};

/** Os registros que não são uma funcionalidade de "Quem usa qual modelo" (usam a regra de outra). */
const EXTRA_LABELS: Record<string, string> = {
  campaign_insights_learning: "Aprendizado dos Insights com o feedback do time",
  client_temperature_lessons: "Regras do Termômetro a partir das correções",
  client_radar_task_rules: "Regras das tarefas do Radar",
  mavi_person: "Base de comportamento das pessoas",
};
/** O nome do módulo (as funcionalidades de "Quem usa qual modelo"). */
export const featureLabel = (id: string) => FEATURES.find((f) => f.id === id)?.label ?? EXTRA_LABELS[id] ?? id;

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export type EvalApi = {
  overview: () => Promise<EvalOverview>;
  start: (provider: string | null, model: string, cap: number, features: string[]) => Promise<unknown>;
  cancel: (run: string) => Promise<unknown>;
  detail: (run: string) => Promise<EvalResult[]>;
  saveSettings: (weekly: boolean, cap: number) => Promise<unknown>;
};

export const serverEval = (company: string): EvalApi => ({
  overview: () => rpc<EvalOverview>("ai_eval_overview", { p_company: company }),
  start: (provider, model, cap, features) =>
    rpc("ai_eval_run_start", { p_company: company, p_provider: provider, p_model: model, p_cap: cap, p_features: features }),
  cancel: (run) => rpc("ai_eval_run_cancel", { p_company: company, p_run: run }),
  detail: (run) => rpc<EvalResult[]>("ai_eval_run_detail", { p_company: company, p_run: run }),
  saveSettings: (weekly, cap) => rpc("ai_eval_settings_save", { p_company: company, p_weekly: weekly, p_cap: cap }),
});

/** Na demonstração: em memória, com registros e um teste de exemplo. */
export function demoEval(): EvalApi {
  const now = new Date().toISOString();
  const sample = (id: number, feature: string, question: string, model: string, tools: number): EvalSample => ({
    id,
    feature,
    question,
    model,
    provider: "Servidor",
    client_id: null,
    sigiloso: false,
    tools,
    cost_usd: 0.02,
    ms: 8000,
    created_at: now,
  });
  const samples: EvalSample[] = [
    sample(1, "assistant", "Quais tarefas da Aurora estão atrasadas?", "claude-sonnet-5", 2),
    sample(2, "assistant", "Monte o resumo da última reunião com a Forma Living.", "claude-sonnet-5", 3),
    sample(3, "client_radar", "Reunião de 06/10 com a Norte Coffee (transcrição)", "claude-sonnet-5", 0),
    sample(4, "client_temperature_text", "Mensagens do grupo da Aurora em 06/10", "claude-haiku-4-5", 0),
    sample(5, "campaign_insights", "Campanha Black Friday · Forma Living", "claude-opus-5", 4),
  ];
  let settings = { weekly: true, weekly_cap: 1 };
  let runs: EvalRun[] = [
    {
      id: "demo-r1",
      provider_id: null,
      provider: "Servidor",
      model: "claude-haiku-4-5",
      status: "done",
      features: ["assistant", "client_radar"],
      auto: false,
      cases_total: 3,
      cases_done: 3,
      cases_failed: 0,
      score: 0.667,
      wins: 1,
      ties: 1,
      losses: 1,
      cost_usd: 0.031,
      cap_usd: 1,
      avg_ms: 4200,
      created_by: null,
      created_at: now,
      finished_at: now,
      answer_cost: 0.018,
      base_cost: 0.09,
      base_ms: 9300,
    },
  ];
  return {
    overview: async () => ({
      samples,
      runs,
      latest: runs
        .filter((r) => r.score !== null)
        .map((r) => ({ provider_id: r.provider_id, model: r.model, score: r.score!, run_id: r.id, finished_at: r.finished_at! })),
      settings,
    }),
    start: async (provider, model, cap, features) => {
      runs = [
        {
          id: `demo-${Date.now()}`,
          provider_id: provider,
          provider: provider ? "Biblioteca" : "Servidor",
          model,
          status: "running",
          features,
          auto: false,
          cases_total: samples.filter((s) => features.includes(s.feature)).length,
          cases_done: 0,
          cases_failed: 0,
          score: null,
          wins: 0,
          ties: 0,
          losses: 0,
          cost_usd: 0,
          cap_usd: cap,
          avg_ms: null,
          created_by: null,
          created_at: new Date().toISOString(),
          finished_at: null,
          answer_cost: null,
          base_cost: null,
          base_ms: null,
        },
        ...runs,
      ];
    },
    cancel: async (run) => {
      runs = runs.map((r) => (r.id === run ? { ...r, status: "cancelled" } : r));
    },
    detail: async () => [
      {
        id: 1,
        sample_id: 1,
        feature: "assistant",
        question: samples[0].question,
        reference: "São 3: o relatório mensal (venceu ontem), a arte do carrossel e o ajuste do site. [S1]",
        base_model: "claude-sonnet-5",
        base_cost: 0.02,
        base_ms: 7000,
        status: "done",
        answer_cost: 0.004,
        answer: "A Aurora tem 2 tarefas atrasadas: o relatório mensal e a arte do carrossel. [S1]",
        outcome: "loss",
        explanation: "Faltou o ajuste do site, que aparece no resultado da consulta.",
        ms: 3100,
        cost_usd: 0.006,
        error: null,
      },
      {
        id: 2,
        sample_id: 2,
        feature: "assistant",
        question: samples[1].question,
        reference: "Combinados: novo calendário até sexta; a Bia aprova as artes.",
        base_model: "claude-sonnet-5",
        base_cost: 0.03,
        base_ms: 9000,
        status: "done",
        answer_cost: 0.005,
        answer: "Ficou combinado o novo calendário até sexta e que a Bia aprova as artes.",
        outcome: "tie",
        explanation: "As duas trazem os mesmos combinados.",
        ms: 4000,
        cost_usd: 0.007,
        error: null,
      },
      {
        id: 3,
        sample_id: 3,
        feature: "client_radar",
        question: samples[2].question,
        reference: '{"items":[{"kind":"promessa","text":"Enviar o relatório até sexta"}]}',
        base_model: "claude-sonnet-5",
        base_cost: 0.04,
        base_ms: 12000,
        status: "done",
        answer_cost: 0.007,
        answer: '{"items":[{"kind":"promessa","text":"Enviar o relatório até sexta"},{"kind":"problema","text":"Leads sem qualificação"}]}',
        outcome: "win",
        explanation: "Achou também a reclamação sobre a qualidade dos leads, que está na transcrição.",
        ms: 5600,
        cost_usd: 0.009,
        error: null,
      },
    ],
    saveSettings: async (weekly, cap) => {
      settings = { weekly, weekly_cap: cap };
    },
  };
}

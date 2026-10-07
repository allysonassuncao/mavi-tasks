import { supabase } from "./supabase";

/**
 * Painel da MAVI › Avaliação (migração 20270601090000): o conjunto de
 * avaliação da empresa. Casos (pergunta + resposta de referência, com o
 * material congelado ou colado), testes de um modelo e o resultado caso a
 * caso. A liberação (só modelos aprovados no automático) fica nas
 * configurações do roteador.
 */

export type EvalCase = {
  id: string;
  question: string;
  reference: string;
  context: string | null;
  client_id: string | null;
  task_type: string | null;
  origin: "manual" | "answer";
  active: boolean;
  /** Quantos trechos de fontes o material congelado tem. */
  sources: number;
  updated_at: string;
};
export type EvalRun = {
  id: string;
  provider_id: string | null;
  provider: string;
  model: string;
  status: "running" | "done" | "cancelled";
  cases_total: number;
  cases_done: number;
  cases_failed: number;
  score: number | null;
  passed: number;
  cost_usd: number;
  cap_usd: number;
  avg_ms: number | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
};
export type EvalOverview = {
  cases: EvalCase[];
  suggestions: { message: number; question: string; answer: string; at: string }[];
  runs: EvalRun[];
  latest: { provider_id: string | null; model: string; score: number; run_id: string; finished_at: string }[];
};
export type EvalResult = {
  id: number;
  case_id: string | null;
  question: string | null;
  reference: string | null;
  task_type: string | null;
  status: "pending" | "done" | "error" | "skipped";
  answer: string | null;
  score: number | null;
  passed: boolean | null;
  explanation: string | null;
  ms: number | null;
  cost_usd: number;
  error: string | null;
};
export type CaseDraft = {
  id?: string;
  question: string;
  reference: string;
  client_id: string | null;
  context: string;
  active: boolean;
};

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export type EvalApi = {
  overview: () => Promise<EvalOverview>;
  saveCase: (d: CaseDraft) => Promise<unknown>;
  fromMessage: (message: number) => Promise<unknown>;
  deleteCase: (id: string) => Promise<unknown>;
  start: (provider: string | null, model: string, cap: number) => Promise<unknown>;
  cancel: (run: string) => Promise<unknown>;
  detail: (run: string) => Promise<EvalResult[]>;
};

export const serverEval = (company: string): EvalApi => ({
  overview: () => rpc<EvalOverview>("ai_eval_overview", { p_company: company }),
  saveCase: (d) =>
    rpc("ai_eval_case_save", {
      p_company: company,
      p_id: d.id ?? null,
      p_question: d.question,
      p_reference: d.reference,
      p_client: d.client_id,
      p_context: d.context,
      p_active: d.active,
    }),
  fromMessage: (message) => rpc("ai_eval_case_from_message", { p_company: company, p_message: message }),
  deleteCase: (id) => rpc("ai_eval_case_delete", { p_company: company, p_id: id }),
  start: (provider, model, cap) =>
    rpc("ai_eval_run_start", { p_company: company, p_provider: provider, p_model: model, p_cap: cap }),
  cancel: (run) => rpc("ai_eval_run_cancel", { p_company: company, p_run: run }),
  detail: (run) => rpc<EvalResult[]>("ai_eval_run_detail", { p_company: company, p_run: run }),
});

/** Na demonstração: em memória, com um teste de exemplo. */
export function demoEval(): EvalApi {
  const now = new Date().toISOString();
  let cases: EvalCase[] = [
    {
      id: "demo-c1",
      question: "Qual o prazo de entrega do relatório mensal da Aurora?",
      reference: "Todo dia 5, até as 18h, por e-mail para a Marina.",
      context: null,
      client_id: null,
      task_type: "consulta",
      origin: "answer",
      active: true,
      sources: 2,
      updated_at: now,
    },
    {
      id: "demo-c2",
      question: "Monte o plano de conteúdo de novembro para a Forma Living.",
      reference: "Precisa ter: 12 posts, 2 por semana de Reels, datas comemorativas (Black Friday), o tom informal da marca.",
      context: "Briefing: decoração, público 25-40, tom informal.",
      client_id: null,
      task_type: "planejamento",
      origin: "manual",
      active: true,
      sources: 0,
      updated_at: now,
    },
  ];
  let runs: EvalRun[] = [
    {
      id: "demo-r1",
      provider_id: null,
      provider: "Servidor",
      model: "claude-haiku-4-5",
      status: "done",
      cases_total: 2,
      cases_done: 2,
      cases_failed: 0,
      score: 0.71,
      passed: 1,
      cost_usd: 0.012,
      cap_usd: 1,
      avg_ms: 4200,
      created_by: null,
      created_at: now,
      finished_at: now,
    },
  ];
  return {
    overview: async () => ({
      cases,
      suggestions: [{ message: 1, question: "Quem aprova as artes da Norte Coffee?", answer: "A Bia aprova, até quarta.", at: now }],
      runs,
      latest: runs.filter((r) => r.score !== null).map((r) => ({ provider_id: r.provider_id, model: r.model, score: r.score!, run_id: r.id, finished_at: r.finished_at! })),
    }),
    saveCase: async (d) => {
      const next: EvalCase = {
        id: d.id ?? `demo-${Date.now()}`,
        question: d.question,
        reference: d.reference,
        context: d.context || null,
        client_id: d.client_id,
        task_type: null,
        origin: "manual",
        active: d.active,
        sources: 0,
        updated_at: new Date().toISOString(),
      };
      cases = d.id ? cases.map((c) => (c.id === d.id ? { ...c, ...next, origin: c.origin } : c)) : [next, ...cases];
    },
    fromMessage: async () => {
      cases = [
        { id: `demo-${Date.now()}`, question: "Quem aprova as artes da Norte Coffee?", reference: "A Bia aprova, até quarta.", context: null, client_id: null, task_type: null, origin: "answer", active: true, sources: 1, updated_at: new Date().toISOString() },
        ...cases,
      ];
    },
    deleteCase: async (id) => {
      cases = cases.filter((c) => c.id !== id);
    },
    start: async (provider, model, cap) => {
      runs = [
        { id: `demo-${Date.now()}`, provider_id: provider, provider: provider ? "Biblioteca" : "Servidor", model, status: "running", cases_total: cases.filter((c) => c.active).length, cases_done: 0, cases_failed: 0, score: null, passed: 0, cost_usd: 0, cap_usd: cap, avg_ms: null, created_by: null, created_at: new Date().toISOString(), finished_at: null },
        ...runs,
      ];
    },
    cancel: async (run) => {
      runs = runs.map((r) => (r.id === run ? { ...r, status: "cancelled" } : r));
    },
    detail: async () => [
      {
        id: 2,
        case_id: "demo-c2",
        question: cases[1]?.question ?? "",
        reference: cases[1]?.reference ?? "",
        task_type: "planejamento",
        status: "done",
        answer: "Plano com 8 posts…",
        score: 0.45,
        passed: false,
        explanation: "Faltaram a Black Friday e a frequência de Reels.",
        ms: 6100,
        cost_usd: 0.008,
        error: null,
      },
      {
        id: 1,
        case_id: "demo-c1",
        question: cases[0]?.question ?? "",
        reference: cases[0]?.reference ?? "",
        task_type: "consulta",
        status: "done",
        answer: "Dia 5, até 18h, por e-mail para a Marina.",
        score: 0.97,
        passed: true,
        explanation: "Completa.",
        ms: 2300,
        cost_usd: 0.004,
        error: null,
      },
    ],
  };
}

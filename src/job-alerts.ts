import { rpc } from "./api";

/**
 * Equipe e configurações › Avisos de falhas (migração 20270406090000_job_alerts):
 * as rotinas que rodam sozinhas e o que o admin escolheu para cada uma. A
 * rodada do banco (a cada 2 minutos) manda os avisos 'job_alert'.
 */
export type JobAlertSettings = {
  active: boolean;
  /** Avisar ao falhar N vezes seguidas; null: não avisa por falhas. */
  fail_after: number | null;
  /** Avisar quando ficar X horas sem nenhum sucesso; null: não avisa. */
  stale_hours: number | null;
  notify_recovery: boolean;
  /** Lembrar a cada X horas enquanto continuar; null: avisa uma vez só. */
  remind_hours: number | null;
  /** null: todos os administradores. */
  recipients: string[] | null;
};

export type JobFailure = {
  label: string;
  streak: number;
  since: string;
  error: string;
  alerted: boolean;
};

export type JobAlert = {
  job: string;
  label: string;
  /** O item de cada falha ("campanha"); null quando a rotina é uma só. */
  noun: string | null;
  nouns: string | null;
  /** Registra falhas (os Leads da Make só dizem quando chegaram). */
  fails: boolean;
  /** "Parada" faz sentido para esta rotina. */
  stale_ok: boolean;
  link: string;
  defaults: { fail_after: number | null; stale_hours: number | null };
  /** O admin já mexeu (senão vale o padrão). */
  custom: boolean;
  settings: JobAlertSettings;
  health: {
    /** A rotina já rodou desde que os avisos existem. */
    seen: boolean;
    last_ok_at: string | null;
    last_fail_at: string | null;
    last_error: string | null;
    stale: boolean;
    failing_count: number;
    failing: JobFailure[];
  };
};

export const jobAlertsApi = {
  list: (company: string) =>
    rpc("job_alerts", { p_company: company }) as Promise<JobAlert[]>,
  save: (company: string, job: string, settings: JobAlertSettings | null) =>
    rpc("save_job_alert", {
      p_company: company,
      p_job: job,
      p_settings: settings,
    }) as Promise<JobAlert[]>,
  test: (company: string, job: string) =>
    rpc("test_job_alert", {
      p_company: company,
      p_job: job,
    }) as Promise<number>,
};

/** O que a rotina explica na tela: o que faz e onde aparece. */
export const JOB_ABOUT: Record<string, string> = {
  whatsapp_sweep:
    "Busca na Uazapi a lista de grupos do WhatsApp da empresa e liga cada um ao cliente. Roda a cada poucas horas.",
  whatsapp_groups:
    "Lê as mensagens novas de cada grupo ligado a um cliente. A falha é de um grupo específico.",
  ads_sync:
    "Traz do Meta e do Google os números do dia anterior de cada campanha ativa, toda manhã.",
  ads_today:
    "Lê os resultados de hoje das campanhas a cada 15 minutos, a partir das 7h (lista de Campanhas).",
  campaign_insights:
    "A análise da MAVI que gera os Insights das campanhas, no agendamento ou no “Analisar agora”.",
  campaign_daily:
    "A frase diária da MAVI na coluna MAVI da lista de Campanhas.",
  make_leads:
    "A Make envia os cadastros da página de captura. Aqui não há erro para ler: o aviso é quando os envios param de chegar.",
  agent_sync:
    "Lê os fluxos e prompts de cada servidor do n8n a cada hora (Agente Conversacional).",
  social_media:
    "Publica no Facebook e no Instagram os posts agendados no Social Media.",
  radar:
    "Lê reuniões e conversas do WhatsApp para achar problemas e promessas (Radar do cliente).",
  temperature:
    "Lê reuniões e conversas do WhatsApp para medir a temperatura de cada cliente.",
  task_recurrences:
    "Abre as cópias das tarefas que se repetem. A falha é de uma repetição específica.",
};

export type JobHealth = "ok" | "failing" | "stale" | "idle";

/** Como a rotina está agora: falhando, parada, funcionando ou sem dados ainda. */
export function jobHealth(j: JobAlert): JobHealth {
  if (j.health.failing_count > 0) return "failing";
  if (j.health.stale) return "stale";
  if (j.health.last_ok_at) return "ok";
  return "idle";
}

export const HEALTH_LABEL: Record<JobHealth, string> = {
  ok: "Funcionando",
  failing: "Com falha",
  stale: "Parada",
  idle: "Sem execuções ainda",
};

/** "3 campanhas", "1 grupo", ou "" quando a rotina é uma só. */
export function countNoun(j: Pick<JobAlert, "noun" | "nouns">, n: number) {
  if (!j.noun) return "";
  return `${n} ${n === 1 ? j.noun : j.nouns}`;
}

/** O resumo do que está ligado, para a linha fechada. */
export function settingsSummary(j: JobAlert, adminCount: number) {
  const s = j.settings;
  if (!s.active) return "Avisos desligados";
  const parts: string[] = [];
  if (j.fails && s.fail_after)
    parts.push(
      s.fail_after === 1
        ? "na 1ª falha"
        : `após ${s.fail_after} falhas seguidas`,
    );
  if (j.stale_ok && s.stale_hours) parts.push(`parada há ${s.stale_hours} h`);
  if (s.notify_recovery && parts.length) parts.push("quando voltar");
  if (s.remind_hours && parts.length)
    parts.push(`lembra a cada ${hoursLabel(s.remind_hours)}`);
  if (!parts.length) return "Nenhum aviso escolhido";
  const who = s.recipients
    ? `${s.recipients.length} ${s.recipients.length === 1 ? "pessoa" : "pessoas"}`
    : `${adminCount === 1 ? "o administrador" : "os administradores"}`;
  return `Avisa ${who}: ${parts.join(", ")}`;
}

export function hoursLabel(h: number) {
  if (h % 24 === 0) return h === 24 ? "1 dia" : `${h / 24} dias`;
  return `${h} h`;
}

/** Os números do formulário: inteiro dentro dos limites, ou null (vazio). */
export function clampInt(value: string, min: number, max: number) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

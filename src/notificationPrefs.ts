/**
 * What each person chooses to receive (Meu perfil › Notificações). The
 * database keeps only what they changed and fills in the defaults
 * (migration 20261208090000_notification_prefs); a type turned off doesn't
 * arrive at all, and a pause holds only the browser notifications.
 */
export type NotificationPrefs = {
  prefs: Record<string, boolean>;
  /** Until when the browser notifications are paused (ISO); null when not. */
  paused_until: string | null;
};

export const NOTICE_TYPES: {
  key: string;
  label: string;
  hint: string;
}[] = [
  {
    key: "assigned",
    label: "Tarefa nova para você",
    hint: "Quando alguém cria uma tarefa para você ou passa tarefas para você em massa.",
  },
  {
    key: "mention",
    label: "Menções",
    hint: "Quando mencionam você com @ em um comentário.",
  },
  {
    key: "reply",
    label: "Respostas",
    hint: "Quando respondem a um comentário seu.",
  },
  {
    key: "priority",
    label: "Tarefa prioritária",
    hint: "Quando uma tarefa sua é marcada como prioridade Alta ou Urgente.",
  },
  {
    key: "review",
    label: "Tarefa para validar",
    hint: "Quando uma tarefa que você valida entra em Em validação.",
  },
  {
    key: "due_risk",
    label: "Risco de atraso",
    hint: "Quando a MAVI acha que uma tarefa sua pode atrasar.",
  },
  {
    key: "temperature",
    label: "Termômetro do cliente",
    hint: "Quando um cliente seu esfria ou dá um sinal de alerta.",
  },
  {
    key: "radar_alert",
    label: "Avisos do Radar",
    hint: "Os avisos que você criou no Radar do cliente (Meus avisos), na hora ou no resumo das 8h.",
  },
  {
    key: "radar_report",
    label: "Relatório do Radar",
    hint: "Quando um relatório do Radar que você pediu ou agendou fica pronto.",
  },
  {
    key: "campaign_alert",
    label: "Meus avisos de campanhas",
    hint: "Os avisos que você criou em Campanhas › Meus avisos, na hora ou no resumo das 11h.",
  },
  {
    key: "campaign_insight",
    label: "Insights da MAVI nas campanhas",
    hint: "Quando a MAVI analisa uma campanha de um cliente seu e encontra insights novos (pela prioridade escolhida no Painel da MAVI), ou quando a análise que você pediu fica pronta.",
  },
  {
    key: "job_alert",
    label: "Falhas nas rotinas",
    hint: "Quando uma rotina automática (varredura do WhatsApp, sincronização das campanhas…) falha, para ou volta a funcionar — se um administrador escolheu você no Painel da MAVI › Avisos de falhas.",
  },
  {
    key: "media_balance",
    label: "Saldo de mídia",
    hint: "Quando a conta de mídia de um cliente seu (Financeiro › Mídia) fica abaixo do saldo mínimo ou negativa.",
  },
  {
    key: "success_case",
    label: "Cases de Sucesso",
    hint: "Um case para aprovar, ou o seu aprovado ou devolvido.",
  },
  {
    key: "social_leads",
    label: "Social Leads",
    hint: "Quando a MAVI termina (ou não consegue terminar) um plano que você pediu.",
  },
  {
    key: "ai_share",
    label: "Conversas da MAVI",
    hint: "Quando compartilham com você uma conversa com a MAVI.",
  },
  {
    key: "ai_skill",
    label: "Skills da MAVI",
    hint: "Uma skill para aprovar, ou a sua aprovada ou devolvida.",
  },
  {
    key: "ai_answer",
    label: "Respostas da MAVI",
    hint: "Quando a MAVI termina uma resposta depois que você saiu da conversa.",
  },
];

export const STATUS_ROWS: { status: string; label: string }[] = [
  { status: "progress", label: "Em andamento" },
  { status: "returned", label: "Devolvida" },
  { status: "review", label: "Em validação" },
  { status: "rejected", label: "Alteração" },
  { status: "correction", label: "Correção" },
  { status: "done", label: "Entregue" },
];

export const STATUS_ROLES: { role: string; label: string; hint: string }[] = [
  { role: "creator", label: "Criei", hint: "Tarefas que você criou" },
  {
    role: "assignee",
    label: "Sou responsável",
    hint: "Tarefas em que você é o responsável",
  },
  {
    role: "participant",
    label: "Participo",
    hint: "Tarefas em que você participa (foi mencionado ou já foi responsável)",
  },
];

export const statusKey = (status: string, role: string) =>
  `status.${status}.${role}`;

/** Mirrors mavi_private.notification_default (used in the demo). */
export function defaultPrefs(): NotificationPrefs {
  const prefs: Record<string, boolean> = {};
  for (const t of NOTICE_TYPES) prefs[t.key] = true;
  for (const s of STATUS_ROWS)
    for (const r of STATUS_ROLES)
      prefs[statusKey(s.status, r.role)] =
        r.role === "assignee" &&
        (s.status === "rejected" || s.status === "correction");
  return { prefs, paused_until: null };
}

export function isPaused(p: NotificationPrefs | null, now = Date.now()) {
  if (!p?.paused_until) return false;
  const until = p.paused_until === "infinity" ? Infinity : Date.parse(p.paused_until);
  return until > now;
}

export type PauseChoice = "hour" | "tomorrow" | "forever";

/** When a pause ends: in 1 hour, tomorrow at 8:00 (local time) or never. */
export function pauseUntil(choice: PauseChoice, now = new Date()): string {
  if (choice === "forever") return "infinity";
  if (choice === "hour") return new Date(now.getTime() + 3600e3).toISOString();
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

/** "até 14:30", "até amanhã às 08:00", "até você retomar". */
export function pauseLabel(until: string, now = new Date()): string {
  if (until === "infinity") return "até você retomar";
  const d = new Date(until);
  if (Number.isNaN(d.getTime()) || d.getFullYear() > 9000)
    return "até você retomar";
  const time = d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (d.toDateString() === now.toDateString()) return `até ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString())
    return `até amanhã às ${time}`;
  return `até ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${time}`;
}

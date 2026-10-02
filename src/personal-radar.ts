import { supabase } from "./supabase";
import type { AiSource } from "./ai";
import { saveMeetingShare, publicRecordingUrl } from "./meetings";
import { setDriveVisibility } from "./drive";
import { defaultConfig, reportUrl, supabaseReports } from "./campaign-reports";
import type { AdObjective } from "./campaigns";

/**
 * Radar pessoal (Radar › Pessoal): a MAVI Assistente Pessoal lê os grupos de
 * WhatsApp dos clientes em que a pessoa está e lista as situações que cabem a
 * ela. Só leitura: nada é enviado ao grupo (migration
 * 20270304090000_personal_radar).
 */

export type PersonalKind =
  | "question"
  | "request"
  | "complaint"
  | "material"
  | "approval"
  | "deadline";
export const KIND_LABEL: Record<PersonalKind, string> = {
  question: "Dúvida",
  request: "Solicitação",
  complaint: "Reclamação",
  material: "Material enviado",
  approval: "Aprovação",
  deadline: "Cobrança de prazo",
};
export const URGENCY_LABEL = ["Baixa", "Normal", "Alta", "Urgente"] as const;
export type OwnerReason = "mention" | "reply" | "role" | "general";
export const REASON_LABEL: Record<OwnerReason, string> = {
  mention: "Te marcaram",
  reply: "Responderam a você",
  role: "Pelo assunto",
  general: "Assunto geral",
};
export type DismissReason = "not_mine" | "not_situation" | "already_resolved" | "other";
export const DISMISS_LABEL: Record<DismissReason, string> = {
  not_mine: "Não é comigo",
  not_situation: "Não é uma situação",
  already_resolved: "Já estava resolvido",
  other: "Outro motivo",
};
export type PersonalAction = DismissReason | "resolved" | "reopened";

/** O que a MAVI criaria para a resposta (a pessoa cria na tela, se quiser). */
export type ReplyAction =
  | { key: string; kind: "recording" | "file"; id: string; label: string }
  | {
      key: string;
      kind: "report";
      id: string;
      label: string;
      platform: string;
      start: string;
      end: string;
      objective: string | null;
    };
export type PersonalReply = {
  status: "pending" | "running" | "done" | "failed" | "rejected";
  text?: string;
  evidence: { title: string; detail: string; source?: AiSource }[];
  actions: ReplyAction[];
  checks: string[];
  confidence?: "high" | "medium" | "low";
  model?: string;
  version: number;
  error?: string;
  updated_at: string;
  approved_at?: string;
  approved_text?: string;
  stale?: boolean;
  guidance?: string;
};
export const CONFIDENCE_LABEL = { high: "Tudo nas fontes", medium: "Falta algum detalhe", low: "Depende de você" } as const;
export type RejectReason = "wrong_info" | "wrong_tone" | "incomplete" | "should_not_reply" | "other";
export const REJECT_LABEL: Record<RejectReason, string> = {
  wrong_info: "Informação errada",
  wrong_tone: "Tom errado",
  incomplete: "Incompleta",
  should_not_reply: "Não deveria responder",
  other: "Outro motivo",
};

export type PersonalMention = {
  message_id: string;
  role: "client" | "team";
  speaker: string;
  quote: string;
  at: string;
};
export type PersonalItem = {
  id: string;
  kind: PersonalKind;
  title: string;
  summary: string;
  urgency: number;
  status: "open" | "resolved";
  asks: number;
  first_at: string;
  last_at: string;
  resolved_at?: string;
  resolved_how?: "auto" | "person";
  resolved_by_name?: string;
  reopened_at?: string;
  client: { id: string; name: string };
  group: { id: string; title: string };
  reason: OwnerReason;
  why?: string;
  state: "open" | "dismissed";
  dismissed_reason?: DismissReason;
  others?: string[];
  mentions?: PersonalMention[];
  mention_count: number;
  task?: { id: string; title: string; status: string };
  radar?: { id: string; title: string };
  reply?: PersonalReply;
};
export type PersonalStatus = "open" | "resolved" | "dismissed" | "all";
export type PersonalFilters = {
  status?: PersonalStatus;
  kind?: PersonalKind | "";
  client?: string;
  q?: string;
  limit?: number;
  offset?: number;
};
export type PersonalList = {
  total: number;
  counts: { open: number; resolved: number; dismissed: number };
  clients: { id: string; name: string }[];
  items: PersonalItem[];
};
export type PersonalState = {
  allowed: boolean;
  active: boolean;
  started_at: string | null;
  about: string;
  spent: number;
  cap: number;
  groups: number;
  phones: number;
  whatsapp: boolean;
  settings: { interval_minutes: number; history_days: number; monthly_cap_usd: number };
  can_interval: boolean;
  can_configure: boolean;
  viewable: { id: string; name: string }[];
};
export type PersonalPerson = {
  id: string;
  name: string;
  role: "admin" | "manager" | "member";
  allowed: boolean;
  active: boolean;
  started_at: string | null;
  cap_usd: number | null;
  cap: number;
  spent: number;
  groups: number;
  phones: number;
};

/** "há 5 min", "há 2 h", "ontem 14:10", "28/09 09:12". */
export function whenBr(iso: string, now = Date.now()) {
  const t = new Date(iso).getTime();
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  if (min < 6 * 60) return `há ${Math.round(min / 60)} h`;
  const fmt = (x: number, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", ...o }).format(x);
  const day = (x: number) => fmt(x, { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = fmt(t, { hour: "2-digit", minute: "2-digit" });
  if (day(t) === day(now)) return `hoje ${time}`;
  if (day(t) === day(now - 86_400_000)) return `ontem ${time}`;
  return `${fmt(t, { day: "2-digit", month: "2-digit" })} ${time}`;
}

/** "Resolvido por Bruno às 14:10" / "Resolvido por você". */
export function resolvedLine(i: PersonalItem, me?: string) {
  if (i.status !== "resolved") return "";
  const who = i.resolved_by_name && i.resolved_by_name !== me ? i.resolved_by_name : "você";
  const at = i.resolved_at
    ? new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(i.resolved_at))
    : "";
  return i.resolved_how === "auto"
    ? `Resolvido por ${i.resolved_by_name ?? "alguém do time"} no grupo${at ? ` às ${at}` : ""}`
    : `Resolvido por ${who}${at ? ` às ${at}` : ""}`;
}

export const usd = (n: number) =>
  `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Onde a fala abre: a pasta Whatsapp do cliente no Drive, na mensagem. */
export const messagePath = (group: string, message?: string) =>
  `/drive?whatsapp=${group}${message ? `&msg=${message}` : ""}`;

// ------------------------------------------------------------ banco
/** Sem banco ou na demonstração (empresa "demo-agency"): dados de exemplo. */
const offline = (company: string) => !supabase || !/^[0-9a-f-]{36}$/i.test(company);
async function rpc<T>(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase!.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

export async function loadState(company: string) {
  if (offline(company)) return demoState();
  return rpc<PersonalState>("personal_radar_state", { p_company: company });
}
export async function saveState(company: string, active: boolean, about: string | null) {
  if (offline(company)) {
    demo.state = { ...demo.state, active, about: about ?? demo.state.about, started_at: demo.state.started_at ?? new Date().toISOString() };
    return demoState();
  }
  return rpc<PersonalState>("set_personal_radar", { p_company: company, p_active: active, p_about: about });
}
export async function saveSettings(
  company: string,
  interval: number,
  history: number | null,
  cap: number | null,
) {
  if (offline(company)) {
    demo.state.settings = {
      interval_minutes: interval,
      history_days: history ?? demo.state.settings.history_days,
      monthly_cap_usd: cap ?? demo.state.settings.monthly_cap_usd,
    };
    return demoState();
  }
  return rpc<PersonalState>("set_personal_radar_settings", {
    p_company: company,
    p_interval: interval,
    p_history: history,
    p_cap: cap,
  });
}
export async function loadPeople(company: string) {
  if (offline(company)) return demo.people;
  return rpc<PersonalPerson[]>("personal_radar_people", { p_company: company });
}
export async function savePersonCap(company: string, user: string, cap: number | null) {
  if (offline(company)) {
    const p = demo.people.find((x) => x.id === user);
    if (p) {
      p.cap_usd = cap;
      p.cap = cap ?? demo.state.settings.monthly_cap_usd;
    }
    return;
  }
  await rpc("set_personal_radar_cap", { p_company: company, p_user: user, p_cap: cap });
}
export async function loadList(company: string, user: string | null, filters: PersonalFilters) {
  if (offline(company)) return demoList(filters);
  return rpc<PersonalList>("personal_radar_items", {
    p_company: company,
    p_user: user,
    p_filters: filters,
  });
}
export async function act(company: string, item: string, action: PersonalAction, note = "") {
  if (offline(company)) return demoAct(item, action);
  return rpc<PersonalItem>("personal_radar_act", {
    p_company: company,
    p_item: item,
    p_action: action,
    p_note: note,
  });
}

/** O texto com os links criados no lugar dos marcadores ({{A1}}…). */
export function fillLinks(text: string, links: Record<string, string>) {
  return text.replace(/\{\{(A\d{1,2})\}\}/g, (m, key: string) => links[key] ?? m);
}
/** Os marcadores que ainda faltam no texto. */
export const pendingKeys = (text: string) => [...new Set([...text.matchAll(/\{\{(A\d{1,2})\}\}/g)].map((m) => m[1]))];

/**
 * Pede à MAVI a resposta de um item (ou, sem item, a próxima da fila).
 * Devolve o item atualizado, ou o estado ("running", "done", "none").
 */
export async function requestDraft(
  company: string,
  item: string | null,
  opts: { force?: boolean; guidance?: string } = {},
): Promise<{ item?: PersonalItem; status?: string }> {
  if (offline(company)) return demoDraft(item, opts.guidance);
  const token = (await supabase!.auth.getSession()).data.session?.access_token;
  const res = await fetch("/api/drive", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: "personal-radar-draft", company, item, ...opts }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "A MAVI não conseguiu escrever a resposta.");
  return "id" in data ? { item: data as PersonalItem } : (data as { status?: string });
}

/** Copiou (approved), copiou editada (edited), reprovou (rejected) ou ensinou (training). */
export async function replyFeedback(
  company: string,
  item: string,
  action: "approved" | "edited" | "rejected" | "training",
  text = "",
  reason: RejectReason | null = null,
) {
  if (offline(company)) return demoFeedback(item, action, text);
  return rpc<PersonalItem>("personal_radar_reply_feedback", {
    p_company: company,
    p_item: item,
    p_action: action,
    p_text: text,
    p_reason: reason,
  });
}

/**
 * Cria o link de uma ação, com o login da pessoa (as regras de cada módulo
 * valem): a gravação (vídeo e resumo, sem download, por 30 dias), o arquivo
 * do Drive (público) ou o relatório da campanha no período.
 */
export async function createLink(company: string, a: ReplyAction): Promise<string> {
  if (offline(company)) return `${window.location.origin}/${a.kind === "report" ? "relatorio" : a.kind === "file" ? "arquivo" : "gravacao"}/demo-${a.key.toLowerCase()}`;
  if (a.kind === "recording") {
    const share = await saveMeetingShare(a.id, {
      video: true,
      transcript: false,
      summary: true,
      download: false,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    return publicRecordingUrl(share.token);
  }
  if (a.kind === "file") {
    await setDriveVisibility(a.id, "public");
    const { data, error } = await supabase!.from("drive_files").select("share_token").eq("id", a.id).single();
    if (error || !data) throw Error(error?.message ?? "Não foi possível ler o link do arquivo.");
    return `${window.location.origin}/arquivo/${(data as { share_token: string }).share_token}`;
  }
  if (a.kind !== "report") throw Error("Link desconhecido.");
  const google = a.platform === "google";
  const report = await supabaseReports.create(company, {
    campaign: a.id,
    title: a.label.slice(0, 160),
    start: a.start,
    end: a.end,
    config: defaultConfig((a.objective as AdObjective | null) ?? null, google ? "google" : "meta"),
    link: true,
    provider: google ? "google" : "meta",
  });
  if (!report.link?.token) throw Error("O relatório foi criado, mas sem link.");
  return reportUrl(report.link.token);
}

/** As situações em aberto da pessoa (o número no menu lateral). */
export async function openCount(company: string) {
  if (offline(company)) return demo.items.filter((i) => i.status === "open" && i.state === "open").length;
  return Number(await rpc<number>("personal_radar_open_count", { p_company: company })) || 0;
}

/** "Juntar com…": as situações escolhidas entram nesta (do mesmo grupo). */
export async function joinItems(company: string, target: string, sources: string[]) {
  if (offline(company)) {
    const t = demo.items.find((x) => x.id === target)!;
    for (const id of sources) {
      const i = demo.items.findIndex((x) => x.id === id);
      if (i < 0) continue;
      const src = demo.items[i];
      t.mentions = [...(t.mentions ?? []), ...(src.mentions ?? [])].sort((a, b) => a.at.localeCompare(b.at)).slice(-4);
      t.mention_count += src.mention_count;
      t.asks += src.asks;
      t.urgency = Math.max(t.urgency, src.urgency);
      demo.items.splice(i, 1);
    }
    t.reply = undefined;
    return { ...t };
  }
  return rpc<PersonalItem>("personal_radar_join", { p_company: company, p_target: target, p_sources: sources, p_title: null });
}

// ------------------------------------------------------------ aprendizado
export type LessonKind = "detection" | "reply";
export const LESSON_KIND_LABEL: Record<LessonKind, string> = {
  detection: "O que é comigo",
  reply: "Como responder",
};
export type LessonStatus = "active" | "paused" | "dismissed" | "checking" | "refused";
export const LESSON_STATUS_LABEL: Record<LessonStatus, string> = {
  active: "Em uso",
  paused: "Pausada",
  dismissed: "Excluída",
  checking: "O Jev está conferindo",
  refused: "Recusada pelo Jev",
};
export type Lesson = {
  id: string;
  scope: "person" | "team" | "client";
  kind: LessonKind;
  text: string;
  status: LessonStatus;
  origin: "mavi" | "person" | "leader";
  check_note?: string;
  checked_at?: string;
  updated_at: string;
  evidence: number;
  user?: { id: string; name: string };
  team?: { id: string; name: string };
  client?: { id: string; name: string };
  promoted?: { scope: "team" | "client"; status: LessonStatus }[];
};
export type LessonsView = {
  mine: Lesson[];
  shared: Lesson[];
  can_edit: boolean;
  can_promote: boolean;
  teams: { id: string; name: string }[];
  clients: { id: string; name: string }[];
};
export type AutonomyRow = {
  kind: PersonalKind;
  enabled: boolean;
  days: number;
  min_rate: number;
  min_count: number;
  decided: number;
  approved: number;
  edited: number;
  rejected: number;
  rate: number | null;
  ready: boolean;
};

export async function loadLessons(company: string, user: string | null) {
  if (offline(company)) return demoLessons();
  return rpc<LessonsView>("personal_radar_lessons", { p_company: company, p_user: user });
}
export async function saveLesson(company: string, id: string | null, kind: LessonKind, text: string) {
  if (offline(company)) {
    const l = id ? demo.lessons.find((x) => x.id === id) : undefined;
    if (l) Object.assign(l, { text, kind, origin: l.scope === "person" ? "person" : "leader", updated_at: new Date().toISOString() });
    else
      demo.lessons.unshift({ id: `demo-l${Date.now()}`, scope: "person", kind, text, status: "active", origin: "person", updated_at: new Date().toISOString(), evidence: 0 });
    return;
  }
  await rpc("save_personal_radar_lesson", { p_company: company, p_id: id, p_kind: kind, p_text: text });
}
export async function setLessonStatus(company: string, id: string, status: "active" | "paused" | "dismissed") {
  if (offline(company)) {
    const l = demo.lessons.find((x) => x.id === id);
    if (l) l.status = status;
    return;
  }
  await rpc("set_personal_radar_lesson_status", { p_company: company, p_id: id, p_status: status });
}
export async function promoteLesson(company: string, id: string, scope: "team" | "client", target: string) {
  if (offline(company)) {
    const l = demo.lessons.find((x) => x.id === id)!;
    const where = (scope === "team" ? demoLessons().teams : demoLessons().clients).find((x) => x.id === target);
    demo.lessons.push({ ...l, id: `demo-p${Date.now()}`, scope, origin: "leader", status: "active", check_note: "Conferida pelo Jev.", promoted: undefined, ...(scope === "team" ? { team: where } : { client: where }) });
    l.promoted = [...(l.promoted ?? []), { scope, status: "active" }];
    return;
  }
  await rpc("promote_personal_radar_lesson", { p_company: company, p_id: id, p_scope: scope, p_target: target });
}
export async function loadAutonomy(company: string, user: string | null) {
  if (offline(company)) return demo.autonomy;
  return rpc<AutonomyRow[]>("personal_radar_autonomy", { p_company: company, p_user: user });
}
export async function saveAutonomy(company: string, row: Pick<AutonomyRow, "kind" | "enabled" | "days" | "min_rate" | "min_count">) {
  if (offline(company)) {
    const r = demo.autonomy.find((x) => x.kind === row.kind)!;
    Object.assign(r, row);
    r.ready = r.enabled && r.decided >= r.min_count && (r.rate ?? 0) >= r.min_rate;
    return demo.autonomy;
  }
  return rpc<AutonomyRow[]>("set_personal_radar_autonomy", {
    p_company: company,
    p_kind: row.kind,
    p_enabled: row.enabled,
    p_days: row.days,
    p_min_rate: row.min_rate,
    p_min_count: row.min_count,
  });
}

/**
 * Escreve as respostas que faltam, uma por vez (a fila fica no banco): ao
 * abrir a página e quando chega uma situação nova pelo Realtime, com o app
 * aberto em qualquer página. Uma fila só por aba; o banco reserva cada
 * resposta, então outra aba não escreve a mesma.
 */
let draining: Promise<void> | null = null;
export function drainDrafts(company: string, max = 5) {
  if (draining) return draining;
  draining = (async () => {
    for (let n = 0; n < max; n++) {
      const r: { item?: PersonalItem } = await requestDraft(company, null).catch(() => ({}));
      if (!r.item) break;
    }
  })().finally(() => {
    draining = null;
  });
  return draining;
}

// ------------------------------------------------------------ demonstração
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const demo = {
  state: {
    allowed: true,
    active: true,
    started_at: ago(60 * 24 * 12),
    about: "Cuido das campanhas de tráfego, da verba e dos relatórios.",
    spent: 1.84,
    cap: 10,
    groups: 7,
    phones: 1,
    whatsapp: true,
    settings: { interval_minutes: 15, history_days: 30, monthly_cap_usd: 10 },
    can_interval: true,
    can_configure: true,
    viewable: [
      { id: "demo-u2", name: "Duda Design" },
      { id: "demo-u3", name: "Rafa Atendimento" },
    ],
  } as PersonalState,
  lessons: [
    { id: "demo-l1", scope: "person", kind: "detection", text: "Pedidos de arte e criativo são da Duda, não seus: só marque-a no item.", status: "active", origin: "mavi", updated_at: ago(60 * 20), evidence: 3 },
    { id: "demo-l2", scope: "person", kind: "reply", text: "Ao falar de CPL, traga o valor, o período e a meta do ciclo.", status: "active", origin: "mavi", updated_at: ago(60 * 5), evidence: 2, promoted: [{ scope: "team", status: "active" }] },
    { id: "demo-l3", scope: "person", kind: "reply", text: "Chame o cliente pelo primeiro nome e use no máximo um emoji.", status: "active", origin: "person", updated_at: ago(60 * 48), evidence: 0 },
    { id: "demo-l4", scope: "team", kind: "reply", text: "Ao falar de CPL, traga o valor, o período e a meta do ciclo.", status: "active", origin: "leader", check_note: "Conferida pelo Jev.", updated_at: ago(60 * 4), evidence: 2, team: { id: "demo-team", name: "Tráfego" } },
    { id: "demo-l5", scope: "client", kind: "detection", text: "Na Facilita, o Carlos manda prints de leads: confirme o recebimento, não é reclamação.", status: "refused", origin: "leader", check_note: "O Jev recusou: parece valer só para uma pessoa, ou não está clara.", updated_at: ago(90), evidence: 1, client: { id: "demo-c1", name: "4282 · Facilita" } },
  ] as Lesson[],
  autonomy: [
    { kind: "question", enabled: true, days: 30, min_rate: 0.9, min_count: 10, decided: 14, approved: 13, edited: 1, rejected: 0, rate: 0.929, ready: true },
    { kind: "request", enabled: true, days: 30, min_rate: 0.9, min_count: 10, decided: 9, approved: 6, edited: 2, rejected: 1, rate: 0.667, ready: false },
    { kind: "complaint", enabled: true, days: 30, min_rate: 0.9, min_count: 10, decided: 5, approved: 2, edited: 3, rejected: 0, rate: 0.4, ready: false },
    { kind: "material", enabled: true, days: 30, min_rate: 0.9, min_count: 10, decided: 11, approved: 11, edited: 0, rejected: 0, rate: 1, ready: true },
    { kind: "approval", enabled: true, days: 30, min_rate: 0.9, min_count: 10, decided: 2, approved: 2, edited: 0, rejected: 0, rate: 1, ready: false },
    { kind: "deadline", enabled: false, days: 30, min_rate: 0.9, min_count: 10, decided: 0, approved: 0, edited: 0, rejected: 0, rate: null, ready: false },
  ] as AutonomyRow[],
  people: [
    { id: "demo-u1", name: "Você", role: "admin", allowed: true, active: true, started_at: ago(60 * 24 * 12), cap_usd: null, cap: 10, spent: 1.84, groups: 7, phones: 1 },
    { id: "demo-u2", name: "Duda Design", role: "member", allowed: true, active: true, started_at: ago(60 * 24 * 5), cap_usd: 5, cap: 5, spent: 0.71, groups: 4, phones: 1 },
    { id: "demo-u3", name: "Rafa Atendimento", role: "member", allowed: true, active: false, started_at: null, cap_usd: null, cap: 10, spent: 0, groups: 9, phones: 2 },
    { id: "demo-u4", name: "Lia Social", role: "member", allowed: false, active: false, started_at: null, cap_usd: null, cap: 10, spent: 0, groups: 3, phones: 0 },
  ] as PersonalPerson[],
  items: [
    {
      id: "demo-p1", kind: "complaint", title: "CPL subiu na última semana", urgency: 3, status: "open", asks: 3,
      summary: "O cliente cobrou três vezes por que o custo por lead subiu desde segunda e quer saber o que será feito hoje.",
      first_at: ago(60 * 26), last_at: ago(18), client: { id: "demo-c1", name: "4282 · Facilita" },
      group: { id: "demo-g1", title: "4282 - Facilita & Make" }, reason: "mention", why: "Te marcaram", state: "open",
      mention_count: 4,
      mentions: [
        { message_id: "m1", role: "client", speaker: "Carlos", quote: "Pessoal, o CPL subiu muito essa semana, o que houve?", at: ago(60 * 26) },
        { message_id: "m2", role: "client", speaker: "Carlos", quote: "@Você consegue olhar hoje? Estamos perdendo verba.", at: ago(18) },
      ],
      task: { id: "demo-t1", title: "Revisar públicos da campanha de setembro", status: "progress" },
      reply: {
        status: "done",
        version: 1,
        updated_at: ago(15),
        confidence: "high",
        model: "claude-opus-5-5",
        text: "Oi Carlos! Já olhei: o CPL subiu porque o público de interesse saturou na segunda. Ontem troquei para um público semelhante aos leads de agosto e hoje ele já caiu de R$ 19,40 para R$ 13,10. Te mando o relatório da semana aqui: {{A1}}. Sigo acompanhando e te aviso amanhã cedo.",
        evidence: [
          { title: "Campanha Leads Setembro", detail: "CPL de R$ 19,40 (seg) para R$ 13,10 (hoje), investimento estável em R$ 310/dia." },
          { title: "Tarefa em andamento", detail: "Revisar públicos da campanha de setembro, com você, prazo amanhã." },
          { title: "Reunião de 25/09", detail: "O cliente pediu para manter o CPL abaixo de R$ 15 até o fim do mês." },
        ],
        actions: [
          { key: "A1", kind: "report", id: "demo-camp", label: "Relatório da semana", platform: "meta", start: "2026-09-26", end: "2026-10-02", objective: "lead" },
        ],
        checks: ["Confira o CPL de hoje antes de mandar: ele muda ao longo do dia."],
      },
    },
    {
      id: "demo-p2", kind: "request", title: "Relatório de setembro com os leads por dia", urgency: 1, status: "open", asks: 1,
      summary: "Pediu o relatório do mês com leads por dia para a reunião de sexta com a diretoria.",
      first_at: ago(95), last_at: ago(95), client: { id: "demo-c2", name: "3110 · Clínica Vida" },
      group: { id: "demo-g2", title: "3110 - Clínica Vida" }, reason: "role", why: "Você cuida dos relatórios", state: "open",
      mention_count: 1,
      mentions: [{ message_id: "m3", role: "client", speaker: "Fernanda", quote: "Consegue me mandar o relatório de setembro com os leads por dia? É pra reunião de sexta.", at: ago(95) }],
    },
    {
      id: "demo-p3", kind: "material", title: "Logo novo em alta enviado", urgency: 1, status: "open", asks: 1,
      summary: "Mandou o logo novo em PNG e pediu para usar a partir dos próximos anúncios.",
      first_at: ago(240), last_at: ago(240), client: { id: "demo-c1", name: "4282 · Facilita" },
      group: { id: "demo-g1", title: "4282 - Facilita & Make" }, reason: "reply", why: "Responderam a você", state: "open",
      others: ["Duda Design"], mention_count: 1,
      mentions: [{ message_id: "m4", role: "client", speaker: "Carlos", quote: "Segue o logo novo em alta. Usem a partir dos próximos anúncios, por favor.", at: ago(240) }],
    },
    {
      id: "demo-p4", kind: "question", title: "Quando a campanha de Black Friday começa", urgency: 0, status: "resolved", asks: 1,
      summary: "Perguntou a data de início da campanha de Black Friday.", resolved_how: "auto", resolved_by_name: "Rafa Atendimento",
      resolved_at: ago(50), first_at: ago(70), last_at: ago(70), client: { id: "demo-c3", name: "5021 · Loja Bela" },
      group: { id: "demo-g3", title: "5021 - Loja Bela" }, reason: "general", why: "Assunto geral do cliente", state: "open",
      mention_count: 2,
      mentions: [
        { message_id: "m5", role: "client", speaker: "Bia", quote: "A campanha de Black Friday começa quando?", at: ago(70) },
        { message_id: "m6", role: "team", speaker: "Rafa Atendimento", quote: "Oi Bia! Começa dia 10/11, já está tudo aprovado.", at: ago(50) },
      ],
    },
  ] as PersonalItem[],
};
function demoDraft(item: string | null, guidance?: string): Promise<{ item?: PersonalItem; status?: string }> {
  const i = demo.items.find((x) => x.id === item) ?? demo.items.find((x) => x.status === "open" && !x.reply);
  if (!i) return Promise.resolve({ status: "none" });
  return new Promise((done) =>
    setTimeout(() => {
      i.reply = {
        status: "done",
        version: (i.reply?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
        confidence: "medium",
        model: "claude-opus-5-5",
        text: `Oi ${i.mentions?.[0]?.speaker ?? ""}! ${guidance ? "Combinado: " : ""}Já estou vendo isso e te retorno ainda hoje com tudo certinho.`.replace("Oi !", "Oi!"),
        evidence: [{ title: i.title, detail: i.summary }],
        actions: [],
        checks: ["A MAVI não achou o número exato: confirme antes de mandar."],
        guidance,
      };
      done({ item: { ...i } });
    }, 900),
  );
}
function demoFeedback(id: string, action: string, text: string): PersonalItem {
  const i = demo.items.find((x) => x.id === id)!;
  if (i.reply) {
    if (action === "approved" || action === "edited")
      Object.assign(i.reply, { approved_at: new Date().toISOString(), approved_text: action === "edited" ? text : i.reply.text });
    if (action === "rejected") Object.assign(i.reply, { status: "rejected", approved_at: undefined });
  }
  return { ...i };
}
function demoLessons(): LessonsView {
  return {
    mine: demo.lessons.filter((l) => l.scope === "person"),
    shared: demo.lessons.filter((l) => l.scope !== "person"),
    can_edit: true,
    can_promote: true,
    teams: [{ id: "demo-team", name: "Tráfego" }, { id: "demo-team2", name: "Criação" }],
    clients: [{ id: "demo-c1", name: "4282 · Facilita" }, { id: "demo-c2", name: "3110 · Clínica Vida" }],
  };
}
function demoState(): PersonalState {
  return { ...demo.state, settings: { ...demo.state.settings } };
}
function demoList(f: PersonalFilters): PersonalList {
  const status = f.status ?? "open";
  const mine = demo.items;
  const q = (f.q ?? "").toLowerCase();
  // Por ordem de chegada: a última fala do cliente, da mais recente para a mais antiga.
  const items = [...mine].sort((a, b) => b.last_at.localeCompare(a.last_at)).filter(
    (i) =>
      (status === "all" ||
        (status === "open" && i.status === "open" && i.state === "open") ||
        (status === "resolved" && i.status === "resolved" && i.state === "open") ||
        (status === "dismissed" && i.state === "dismissed")) &&
      (!f.kind || i.kind === f.kind) &&
      (!f.client || i.client.id === f.client) &&
      (!q || `${i.title} ${i.summary} ${i.client.name}`.toLowerCase().includes(q)),
  );
  return {
    total: items.length,
    counts: {
      open: mine.filter((i) => i.status === "open" && i.state === "open").length,
      resolved: mine.filter((i) => i.status === "resolved" && i.state === "open").length,
      dismissed: mine.filter((i) => i.state === "dismissed").length,
    },
    clients: [...new Map(mine.map((i) => [i.client.id, i.client])).values()],
    items: items.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 50)),
  };
}
function demoAct(id: string, action: PersonalAction): PersonalItem {
  const i = demo.items.find((x) => x.id === id)!;
  if (action === "resolved") Object.assign(i, { status: "resolved", resolved_how: "person", resolved_by_name: "Você", resolved_at: new Date().toISOString() });
  else if (action === "reopened") Object.assign(i, { status: "open", state: "open", resolved_at: undefined, resolved_how: undefined, resolved_by_name: undefined, dismissed_reason: undefined });
  else {
    Object.assign(i, { state: "dismissed", dismissed_reason: action });
    if (action === "already_resolved") Object.assign(i, { status: "resolved", resolved_how: "person", resolved_by_name: "Você", resolved_at: new Date().toISOString() });
  }
  return { ...i };
}

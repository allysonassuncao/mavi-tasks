import { supabase } from "./supabase";

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
function demoState(): PersonalState {
  return { ...demo.state, settings: { ...demo.state.settings } };
}
function demoList(f: PersonalFilters): PersonalList {
  const status = f.status ?? "open";
  const mine = demo.items;
  const q = (f.q ?? "").toLowerCase();
  const items = mine.filter(
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

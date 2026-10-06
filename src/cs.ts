import { rpc } from "./api";
import { supabase } from "./supabase";

/**
 * Customer Success (migração 20270520090000): os Squads, a planilha mestre
 * de CS e a ligação de cada cliente de CS ao cliente do MAVI. O painel em
 * Dashboards vem na fase 2.
 */
export type CsSquad = {
  id: string;
  name: string;
  color: string;
  aliases: string[];
  sort: number;
  archived: boolean;
  members: { user_id: string; leader: boolean }[];
  /** Clientes de CS ativos hoje no squad. */
  clients: number;
  /** Já tem clientes, ciclos ou metas: arquiva em vez de excluir. */
  used: boolean;
};

export type CsRun = {
  id: string;
  trigger: "schedule" | "manual";
  started_at: string;
  finished_at: string;
  status: "ok" | "warning" | "error";
  stats: Record<string, number>;
  tabs: { gid: string; name: string; kind: string; month: string | null; rows: number; duplicate?: boolean }[];
  warnings: string[];
  blocked:
    | { kind: "clients" | "cycles" | "hs"; month?: string; items: { external_id: string; name: string }[] }[]
    | null;
  error: string | null;
  by_name: string | null;
};

export type CsSettings = {
  sheet_id: string | null;
  enabled: boolean;
  can_edit: boolean;
  running: boolean;
  last_run: CsRun | null;
  last_ok_at: string | null;
  totals: {
    clients: number;
    active: number;
    linked: number;
    cycles: number;
    months: { month: string; cycles: number }[];
    hs_months: string[];
    goals: number;
  };
};

export type CsClient = {
  id: string;
  external_id: string;
  name: string;
  squad_id: string;
  kind: "TRIAL" | "BASE" | "BASE_RA";
  status: "ATIVO" | "MAKE_IN" | "INATIVO";
  trial_month: number | null;
  origin: "comercial" | "reativacao" | "troca";
  entry_date: string;
  churn_date: string | null;
  reactivation_date: string | null;
  client_id: string | null;
  client_name: string | null;
  client_archived: boolean | null;
  link_mode: "auto" | "manual";
  link_rule: "code" | "name" | "manual" | null;
  linked_at: string | null;
  linked_by_name: string | null;
  /** Clientes do MAVI com esse código (mais de um: escolher à mão). */
  code_matches: number;
  cycles: number;
  last_month: string | null;
};

export type CsLinkLog = {
  at: string;
  mode: "auto" | "manual";
  rule: string | null;
  client_name: string | null;
  previous_name: string | null;
  by_name: string | null;
};

export const csApi = {
  squads: (company: string) => rpc("cs_squads", { p_company: company }) as Promise<CsSquad[]>,
  saveSquad: (
    company: string,
    squad: { id?: string; name: string; color: string; aliases: string[]; users: string[]; leaders: string[]; archived: boolean },
  ) =>
    rpc("save_cs_squad", {
      p_company: company,
      p_id: squad.id ?? null,
      p_name: squad.name,
      p_color: squad.color,
      p_aliases: squad.aliases,
      p_users: squad.users,
      p_leaders: squad.leaders,
      p_archived: squad.archived,
    }) as Promise<CsSquad[]>,
  deleteSquad: (id: string) => rpc("delete_cs_squad", { p_squad: id }) as Promise<CsSquad[]>,
  settings: (company: string) => rpc("cs_settings", { p_company: company }) as Promise<CsSettings>,
  saveSettings: (company: string, sheet: string, enabled: boolean) =>
    rpc("save_cs_settings", { p_company: company, p_sheet: sheet, p_enabled: enabled }) as Promise<CsSettings>,
  runs: (company: string, limit = 20) =>
    rpc("cs_sync_runs", { p_company: company, p_limit: limit }) as Promise<CsRun[]>,
  clients: (company: string) => rpc("cs_clients", { p_company: company }) as Promise<CsClient[]>,
  setLink: (csClient: string, client: string | null, auto: boolean) =>
    rpc("set_cs_client_link", { p_cs_client: csClient, p_client: client, p_auto: auto }) as Promise<CsClient>,
  linkLog: (csClient: string) => rpc("cs_client_link_log", { p_cs_client: csClient }) as Promise<CsLinkLog[]>,
};

/** "Sincronizar agora": o servidor baixa a planilha e grava (api/_cs-sync.ts). */
export async function syncCsNow(company: string, allowRemovals = false) {
  if (!supabase) throw Error("Supabase não configurado");
  const call = async () => {
    const token = (await supabase!.auth.getSession()).data.session?.access_token;
    return fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action: "cs-sync", company, allow_removals: allowRemovals }),
    });
  };
  let res = await call();
  if (res.status === 401) {
    await supabase.auth.refreshSession();
    res = await call();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Não foi possível falar com o servidor.");
  const result = (data.results ?? [])[0] as { ok: boolean; run?: CsRun; error?: string } | undefined;
  if (!result) throw new Error("Configure o link da planilha de CS antes de sincronizar.");
  if (!result.run) throw new Error(result.error ?? "A leitura falhou.");
  return result.run;
}

// ------------------------------------------------------------ rótulos
export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

export const STATUS_LABEL: Record<CsClient["status"], string> = {
  ATIVO: "Ativo",
  MAKE_IN: "Make In",
  INATIVO: "Inativo",
};
export const KIND_LABEL: Record<CsClient["kind"], string> = {
  TRIAL: "Trial",
  BASE: "Base",
  BASE_RA: "Base reativação",
};
export const RULE_LABEL: Record<NonNullable<CsClient["link_rule"]>, string> = {
  code: "pelo código",
  name: "pelo nome",
  manual: "escolhido à mão",
};
export const RUN_LABEL: Record<CsRun["status"], string> = {
  ok: "Tudo certo",
  warning: "Lida com avisos",
  error: "Falhou",
};
export const TAB_LABEL: Record<string, string> = {
  clients: "Clientes",
  cycles: "Ciclos",
  hs: "Health Score",
  goals: "Metas",
  events: "Eventos",
  template: "Modelo (ignorada)",
  history: "Histórico (ignorada)",
  instructions: "Instruções (ignorada)",
  empty: "Vazia",
  unknown: "Não reconhecida",
};

export const monthName = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  const m = d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "");
  return `${m.charAt(0).toUpperCase()}${m.slice(1)}/${String(d.getFullYear()).slice(2)}`;
};
export const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** O resumo de uma leitura: o que entrou, mudou e saiu. */
export function runSummary(run: CsRun) {
  const s = run.stats ?? {};
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, many: string) => {
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(s.clients_created, "cliente novo", "clientes novos");
  add(s.clients_updated, "cliente alterado", "clientes alterados");
  add(s.clients_removed, "cliente removido", "clientes removidos");
  add(s.cycles_upserted, "ciclo gravado", "ciclos gravados");
  add(s.cycles_removed, "ciclo removido", "ciclos removidos");
  add(s.hs_upserted, "nota de HS", "notas de HS");
  add(s.goals_upserted, "meta", "metas");
  add(s.events_upserted, "evento", "eventos");
  add(s.replans, "replanejamento", "replanejamentos");
  add(s.links_changed, "ligação nova", "ligações novas");
  return parts.length ? parts.join(" · ") : "Nada mudou na planilha.";
}

/** Os avisos que pedem ação vêm primeiro (⚠️), depois o resto. */
export function sortedWarnings(list: string[]) {
  return [...list].sort((a, b) => Number(b.startsWith("⚠️")) - Number(a.startsWith("⚠️")));
}

// ------------------------------------------------------------ demonstração
export type CsBackend = typeof csApi & {
  sync: (company: string, allowRemovals?: boolean) => Promise<CsRun>;
};

let demoState: {
  squads: CsSquad[];
  settings: CsSettings;
  clients: CsClient[];
  runs: CsRun[];
  logs: Record<string, CsLinkLog[]>;
} | null = null;

/** A demonstração: uma planilha de exemplo, na memória do navegador. */
export function demoCs(data: { clients: { id: string; name: string; archived: boolean }[]; members: { user_id: string }[] }): CsBackend {
  if (!demoState) {
    const people = data.members.map((m) => m.user_id);
    const squads: CsSquad[] = [
      { id: "sq1", name: "Primogênito", color: "#d09b61", aliases: ["Primog", "1"], sort: 1, archived: false, members: people.slice(0, 2).map((u, i) => ({ user_id: u, leader: i === 0 })), clients: 0, used: true },
      { id: "sq2", name: "Tão Tão Perto", color: "#d9b44a", aliases: ["Tão", "2"], sort: 2, archived: false, members: people.slice(2, 4).map((u, i) => ({ user_id: u, leader: i === 0 })), clients: 0, used: true },
      { id: "sq3", name: "Eu Resolvo LTDA", color: "#aa87d2", aliases: ["Squad 3", "3"], sort: 3, archived: true, members: [], clients: 0, used: true },
    ];
    const names = ["MaqFlex", "Boteco em Casa", "Grupo CR", "Biomist", "Vittalum", "Nexus", "Coraldent", "Unifisa Seguros"];
    const mavi = data.clients.filter((c) => !c.archived);
    const clients: CsClient[] = names.map((name, i) => {
      const linked = i < 5 && mavi[i];
      return {
        id: `cs${i}`, external_id: String(4800 + i * 7), name, squad_id: i % 2 ? "sq2" : "sq1",
        kind: i === 0 ? "TRIAL" : "BASE", status: i === 5 ? "INATIVO" : "ATIVO", trial_month: i === 0 ? 2 : null,
        origin: "comercial", entry_date: "2025-03-01", churn_date: i === 5 ? "2026-08-30" : null, reactivation_date: null,
        client_id: linked ? linked.id : null, client_name: linked ? linked.name : null, client_archived: linked ? false : null,
        link_mode: "auto", link_rule: linked ? (i % 2 ? "name" : "code") : null, linked_at: null, linked_by_name: null,
        code_matches: i === 6 ? 2 : 0, cycles: 3, last_month: "2026-10-01",
      };
    });
    for (const s of squads) s.clients = clients.filter((c) => c.squad_id === s.id && c.status !== "INATIVO").length;
    const now = new Date().toISOString();
    const run: CsRun = {
      id: "run1", trigger: "schedule", started_at: now, finished_at: now, status: "warning",
      stats: { clients_created: 0, clients_updated: 1, cycles_upserted: 4, hs_upserted: 2, replans: 1 },
      tabs: [
        { gid: "1", name: "INSTRUÇÕES", kind: "instructions", month: null, rows: 118 },
        { gid: "2", name: "Clientes", kind: "clients", month: null, rows: 149 },
        { gid: "3", name: "Ciclos · Out 2026", kind: "cycles", month: "2026-10-01", rows: 59 },
        { gid: "4", name: "Ciclos · Set 2026", kind: "cycles", month: "2026-09-01", rows: 69 },
        { gid: "5", name: "HS · Out 2026", kind: "hs", month: "2026-10-01", rows: 59 },
        { gid: "6", name: "Metas", kind: "goals", month: null, rows: 55 },
        { gid: "7", name: "Eventos", kind: "events", month: null, rows: 7 },
        { gid: "8", name: "📋 Novo Mês Ciclos", kind: "template", month: null, rows: 3 },
      ],
      warnings: [
        "Ciclo 10/2026 ID 4807: FimCiclo vazio — fica fora do calendário de recebimento. Preencha o fim do ciclo.",
        "⚠️ Nexus (#4835) reativou em 16/07/2026 e churnou de novo em 30/08/2026, mas a aba EVENTOS não tem a linha \"REATIVACAO 16/07/2026\" — essa reativação SUMIU do net churn de 07/2026. Corrija adicionando em EVENTOS: 4835 | REATIVACAO | 16/07/2026",
      ],
      blocked: null, error: null, by_name: null,
    };
    demoState = {
      squads,
      clients,
      runs: [run],
      logs: {},
      settings: {
        sheet_id: "1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc", enabled: true, can_edit: true, running: false,
        last_run: run, last_ok_at: now,
        totals: { clients: clients.length, active: clients.filter((c) => c.status !== "INATIVO").length,
          linked: clients.filter((c) => c.client_id).length, cycles: 24,
          months: [{ month: "2026-10-01", cycles: 8 }, { month: "2026-09-01", cycles: 8 }, { month: "2026-08-01", cycles: 8 }],
          hs_months: ["2026-10-01", "2026-09-01"], goals: 6 },
      },
    };
  }
  const st = demoState;
  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 150));
  return {
    squads: () => later(st.squads),
    saveSquad: (_c, s) => {
      if (st.squads.some((x) => x.id !== s.id && x.name.toLowerCase() === s.name.trim().toLowerCase()))
        return Promise.reject(new Error("Já existe um squad com esse nome."));
      const members = s.users.map((u) => ({ user_id: u, leader: s.leaders.includes(u) }));
      const row = st.squads.find((x) => x.id === s.id);
      if (row) Object.assign(row, { name: s.name.trim(), color: s.color, aliases: s.aliases, members, archived: s.archived });
      else st.squads.push({ id: `sq${Date.now()}`, name: s.name.trim(), color: s.color, aliases: s.aliases, sort: st.squads.length + 1, archived: false, members, clients: 0, used: false });
      st.squads.sort((a, b) => Number(a.archived) - Number(b.archived) || a.sort - b.sort);
      return later(st.squads);
    },
    deleteSquad: (id) => {
      st.squads = st.squads.filter((s) => s.id !== id);
      return later(st.squads);
    },
    settings: () => later(st.settings),
    saveSettings: (_c, sheet, enabled) => {
      const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(sheet)?.[1] ?? sheet.trim();
      if (id && !/^[A-Za-z0-9_-]{20,100}$/.test(id))
        return Promise.reject(new Error("Cole o link da planilha do Google (docs.google.com/spreadsheets/d/...)."));
      st.settings = { ...st.settings, sheet_id: id || null, enabled };
      return later(st.settings);
    },
    runs: () => later(st.runs),
    clients: () => later(st.clients),
    setLink: (id, client, auto) => {
      const row = st.clients.find((c) => c.id === id)!;
      const target = data.clients.find((c) => c.id === client);
      Object.assign(row, auto
        ? { link_mode: "auto", link_rule: row.client_id ? row.link_rule : null }
        : { link_mode: "manual", link_rule: "manual", client_id: target?.id ?? null, client_name: target?.name ?? null, client_archived: target ? target.archived : null, linked_by_name: "Você" });
      (st.logs[id] ??= []).unshift({ at: new Date().toISOString(), mode: auto ? "auto" : "manual", rule: row.link_rule, client_name: row.client_name, previous_name: null, by_name: auto ? null : "Você" });
      st.settings.totals.linked = st.clients.filter((c) => c.client_id).length;
      return later(row);
    },
    linkLog: (id) => later(st.logs[id] ?? []),
    sync: () => {
      const now = new Date().toISOString();
      const run: CsRun = { ...st.runs[0], id: `run${Date.now()}`, trigger: "manual", started_at: now, finished_at: now, stats: {}, by_name: "Você" };
      st.runs.unshift(run);
      st.settings = { ...st.settings, last_run: run, last_ok_at: now };
      return later(run);
    },
  };
}

export const realCs: CsBackend = { ...csApi, sync: syncCsNow };

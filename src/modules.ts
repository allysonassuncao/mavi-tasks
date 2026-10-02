import { pagePaths, type Page } from "./router";
import type { Role } from "./types";

/**
 * Who opens each module. Two layers:
 *  - the fixed rules of the access profile: collaborators see the modules
 *    scoped to them, managers and administrators everything, and some
 *    modules are exclusive to administrators;
 *  - on top of them, the modules an administrator hid from the person
 *    (memberships.hidden_pages, migration 20261007090000_member_modules).
 *    It only restricts: "Meu perfil" and "Equipe e configurações" never hide;
 *  - for collaborators, the opt-in modules (MEMBER_OPT_IN) stay off until an
 *    administrator turns them on (memberships.shown_pages, migration
 *    20270105090000_member_opt_in_modules).
 */

/**
 * Modules a collaborator only sees when an administrator turns them on for
 * the person: off by default; on, they use everything the module has, but
 * only on the clients of their teams (Visão geral with their own numbers;
 * Radar and Campanhas configuration of the agency stays with leaders;
 * Dashboards they create show only their clients; Financeiro › Mídia
 * launches and reverses only on their clients' accounts; Radar pessoal
 * reads only the groups of their clients). Migrations 20270105090000,
 * 20270107090000, 20270114090000 and 20270304090000.
 */
export const MEMBER_OPT_IN = [
  "overview",
  "campaigns",
  "radar",
  "dashboards",
  "financeMedia",
  "personalRadar",
] as const satisfies readonly Page[];

// Collaborators see these modules scoped to them: clients/projects they serve
// (read-only, plus creating tasks) and only their own hours and reports.
export const MEMBER_PAGES: readonly Page[] = [
  "tasks",
  "agenda",
  "onboarding",
  "socialMedia",
  "cases",
  "temperature",
  "notices",
  "search",
  "clients",
  "projects",
  "hours",
  "reports",
  "drive",
  "mavi",
  "skills",
  "connections",
  "profile",
  "person",
  "inbox",
  ...MEMBER_OPT_IN,
];
/**
 * Modules that aren't pages: the AI assistant, the bubble over every page
 * (and its full page, MAVI in the menu). Everyone has it by profile; an
 * administrator turns it off per person.
 */
export const WIDGET_MODULES = ["assistant"] as const;
export type WidgetModule = (typeof WIDGET_MODULES)[number];
// Modules exclusive to the company's administrators (not even managers).
// Campanhas was one until migration 20261009090000_ad_campaigns_leaders.
export const ADMIN_PAGES: readonly (Page | WidgetModule)[] = [];

/** The modules of the menu an administrator can hide, in the menu's order. */
export const MODULES = [
  { id: "overview", label: "Visão geral" },
  { id: "notices", label: "Mural de avisos" },
  { id: "tasks", label: "Tarefas" },
  { id: "agenda", label: "Agenda" },
  { id: "campaigns", label: "Campanhas" },
  { id: "financeMedia", label: "Financeiro › Mídia" },
  { id: "onboarding", label: "Planejamento › Social Leads" },
  { id: "socialMedia", label: "Planejamento › Social Media" },
  { id: "cases", label: "Cases de Sucesso" },
  { id: "temperature", label: "Termômetro dos clientes" },
  { id: "radar", label: "Radar do cliente" },
  { id: "personalRadar", label: "Radar pessoal" },
  { id: "drive", label: "Drive" },
  { id: "reports", label: "Relatórios" },
  { id: "dashboards", label: "Dashboards" },
  { id: "clients", label: "Clientes" },
  { id: "products", label: "Produtos" },
  { id: "projects", label: "Projetos" },
  { id: "hours", label: "Controle de horas" },
  { id: "storage", label: "Armazenamento" },
  { id: "aiUsage", label: "Painel da MAVI" },
  { id: "assistant", label: "MAVI (conversas e bolinha)" },
] as const satisfies readonly { id: Page | WidgetModule; label: string }[];
export type ModuleId = (typeof MODULES)[number]["id"];

/**
 * The modules off for the person: the ones an administrator hid plus, for a
 * collaborator, the opt-in ones not turned on. What every screen checks.
 */
export function hiddenModules(
  member:
    | {
        role?: Role;
        hidden_pages?: readonly string[] | null;
        shown_pages?: readonly string[] | null;
      }
    | null
    | undefined,
): string[] {
  const hidden = [...(member?.hidden_pages ?? [])];
  if (member?.role !== "member") return hidden;
  const shown = member.shown_pages ?? [];
  for (const id of MEMBER_OPT_IN)
    if (!shown.includes(id) && !hidden.includes(id)) hidden.push(id);
  return hidden;
}

/** Whether the module is one a collaborator only sees when turned on. */
export const optInFor = (module: string, role: Role | undefined) =>
  role === "member" && (MEMBER_OPT_IN as readonly string[]).includes(module);

/** The module a page belongs to (the task search is Tarefas…), if any. */
export function moduleOf(page: Page): ModuleId | null {
  if (page === "search") return "tasks";
  if (page === "contracts") return "products";
  if (page === "mavi" || page === "skills" || page === "connections") return "assistant";
  return MODULES.some((m) => m.id === page) ? (page as ModuleId) : null;
}

/** Whether the module (a page or the assistant) is on for the person. */
export function moduleOn(
  module: ModuleId,
  role: Role | undefined,
  hidden: readonly string[] = [],
) {
  return !hidden.includes(module) && roleAllows(module, role);
}

/** The access profile's rule alone. */
export function roleAllows(page: Page | WidgetModule, role: Role | undefined) {
  if ((WIDGET_MODULES as readonly string[]).includes(page)) return !!role;
  if (ADMIN_PAGES.includes(page as Page)) return role === "admin";
  return (
    role === "admin" ||
    role === "manager" ||
    MEMBER_PAGES.includes(page as Page)
  );
}

export function canOpenPage(
  page: Page,
  role: Role | undefined,
  hidden: readonly string[] = [],
) {
  const module = moduleOf(page);
  if (module && hidden.includes(module)) return false;
  return roleAllows(page, role);
}

/** Where to land when the page asked for can't be opened. */
export function firstPage(role: Role | undefined, hidden: readonly string[]) {
  // O Mural fica por último: é destino só quando nada mais abre.
  const pages = MODULES.map((m) => m.id).filter(
    (id): id is Extract<ModuleId, Page> => id in pagePaths && id !== "notices",
  );
  pages.push("notices");
  const order: Page[] =
    role === "admin" || role === "manager"
      ? ["overview", "tasks", ...pages]
      : ["tasks", ...pages];
  return order.find((p) => canOpenPage(p, role, hidden)) ?? "profile";
}

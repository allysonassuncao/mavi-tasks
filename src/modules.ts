import type { Page } from "./router";
import type { Role } from "./types";

/**
 * Who opens each module. Two layers:
 *  - the fixed rules of the access profile: collaborators see the modules
 *    scoped to them, managers and administrators everything, and some
 *    modules are exclusive to administrators;
 *  - on top of them, the modules an administrator hid from the person
 *    (memberships.hidden_pages, migration 20261007090000_member_modules).
 *    It only restricts: "Meu perfil" and "Equipe e configurações" never hide.
 */

// Collaborators see these modules scoped to them: clients/projects they serve
// (read-only, plus creating tasks) and only their own hours and reports.
export const MEMBER_PAGES: readonly Page[] = [
  "tasks",
  "agenda",
  "onboarding",
  "search",
  "clients",
  "projects",
  "hours",
  "reports",
  "drive",
  "profile",
];
// Modules exclusive to the company's administrators (not even managers).
// Campanhas was one until migration 20261009090000_ad_campaigns_leaders.
export const ADMIN_PAGES: readonly Page[] = [];

/** The modules of the menu an administrator can hide, in the menu's order. */
export const MODULES = [
  { id: "overview", label: "Visão geral" },
  { id: "tasks", label: "Tarefas" },
  { id: "agenda", label: "Agenda" },
  { id: "campaigns", label: "Campanhas" },
  { id: "onboarding", label: "Onboarding" },
  { id: "drive", label: "Drive" },
  { id: "reports", label: "Relatórios" },
  { id: "dashboards", label: "Dashboards" },
  { id: "clients", label: "Clientes" },
  { id: "products", label: "Produtos" },
  { id: "projects", label: "Projetos" },
  { id: "hours", label: "Controle de horas" },
  { id: "storage", label: "Armazenamento" },
] as const satisfies readonly { id: Page; label: string }[];
export type ModuleId = (typeof MODULES)[number]["id"];

/** The module a page belongs to (the task search is Tarefas…), if any. */
export function moduleOf(page: Page): ModuleId | null {
  if (page === "search") return "tasks";
  if (page === "contracts") return "products";
  return MODULES.some((m) => m.id === page) ? (page as ModuleId) : null;
}

/** The access profile's rule alone. */
export function roleAllows(page: Page, role: Role | undefined) {
  if (ADMIN_PAGES.includes(page)) return role === "admin";
  return role === "admin" || role === "manager" || MEMBER_PAGES.includes(page);
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
  const order: Page[] =
    role === "admin" || role === "manager"
      ? ["overview", "tasks", ...MODULES.map((m) => m.id)]
      : ["tasks", ...MODULES.map((m) => m.id)];
  return order.find((p) => canOpenPage(p, role, hidden)) ?? "profile";
}

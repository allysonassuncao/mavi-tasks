import { useCallback, useSyncExternalStore, type SetStateAction } from "react";

export const pagePaths = {
  overview: "/visao-geral",
  tasks: "/tarefas",
  agenda: "/agenda",
  search: "/tarefas/busca",
  clients: "/clientes",
  products: "/produtos",
  contracts: "/produtos-contratados",
  projects: "/projetos",
  campaigns: "/campanhas",
  onboarding: "/onboarding/social-leads",
  hours: "/horas",
  reports: "/relatorios",
  drive: "/drive",
  storage: "/armazenamento",
  dashboards: "/dashboards",
  profile: "/perfil",
  settings: "/configuracoes",
} as const;
export type Page = keyof typeof pagePaths;
const routeEvent = "mavi:navigation";
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(routeEvent, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(routeEvent, listener);
  };
}
function snapshot() {
  return window.location.pathname + window.location.search;
}
export function useLocation() {
  return useSyncExternalStore(subscribe, snapshot);
}
function subscribeHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  const stop = subscribe(listener);
  return () => {
    window.removeEventListener("hashchange", listener);
    stop();
  };
}
/** The part after "#", without it (the settings page's tab). */
export function useHash() {
  return useSyncExternalStore(subscribeHash, () =>
    window.location.hash.slice(1),
  );
}

/** Tabs of "Equipe e configurações", addressed by the URL's hash. */
export const SETTINGS_TABS = [
  "config-pessoas",
  "config-equipes",
  "config-produtos",
  "config-templates",
  "config-sugestoes",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export function settingsTab(hash: string): SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(hash)
    ? (hash as SettingsTab)
    : "config-pessoas";
}
export function routeParts(path: string) {
  const normalized = path.replace(/\/+$/, "") || "/";
  const match = normalized.match(/^\/agencias\/([a-z0-9-]+)(\/.*)?$/);
  return {
    company: match?.[1] ?? "",
    path: match ? match[2] || "/visao-geral" : normalized,
  };
}
export function companySlug(
  company: { id: string; name: string },
  companies: { id: string; name: string }[],
) {
  const slug = (name: string) =>
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agencia";
  const base = slug(company.name);
  return companies.filter((c) => slug(c.name) === base).length > 1
    ? `${base}-${company.id}`
    : base;
}
export function safeReturnPath(value: string | null) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value)
  )
    return pagePaths.overview;
  const url = new URL(value, "https://mavi.invalid");
  if (url.origin !== "https://mavi.invalid" || !resolvePage(url.pathname))
    return pagePaths.overview;
  // Never persist auth tokens or arbitrary parameters in the login destination.
  const allowed = new Set([
    "empresa",
    "busca",
    "status",
    "produto",
    "minhas",
    "atrasadas",
    "cliente",
    "projeto",
    "pagina",
    "periodo",
    "visualizacao",
    "mes",
    "termo",
    "em",
    "cli",
    "proj",
    "resp",
    "criador",
    "situacao",
    "de",
    "ate",
    "campanha",
    "plataforma",
    "atencao",
    "contrato",
    "aba",
    "mes",
  ]);
  for (const key of [...url.searchParams.keys()])
    if (!allowed.has(key)) url.searchParams.delete(key);
  return url.pathname + url.search;
}
export function loginDestination(current: string) {
  const next = safeReturnPath(current);
  return next === "/" || next === pagePaths.overview
    ? "/login"
    : `/login?retorno=${encodeURIComponent(next)}`;
}
export function resolvePage(path: string): Page | null {
  const normalized = routeParts(path).path;
  if (normalized === "/") return "overview";
  if (normalized === "/onboarding") return "onboarding";
  if (taskIdFromPath(path)) return "tasks";
  if (dashboardIdFromPath(path)) return "dashboards";
  return (
    (Object.keys(pagePaths) as Page[]).find(
      (page) => pagePaths[page] === normalized,
    ) ?? null
  );
}
export function navigate(url: string, replace = false) {
  // The hash counts: it picks the settings page's tab.
  if (url === snapshot() + window.location.hash) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", url);
  window.dispatchEvent(new Event(routeEvent));
}
export function pageUrl(page: Page, company = "") {
  return (
    (company ? `/agencias/${encodeURIComponent(company)}` : "") +
    pagePaths[page]
  );
}
export function usePage() {
  const url = useSyncExternalStore(subscribe, snapshot);
  return resolvePage(url.split("?")[0]);
}
export function readParam<T extends string | number | boolean>(
  params: URLSearchParams,
  key: string,
  fallback: T,
): T {
  const raw = params.get(key);
  if (raw === null) return fallback;
  if (typeof fallback === "boolean") return (raw === "1") as T;
  if (typeof fallback === "number") {
    const value = Number(raw);
    return (Number.isSafeInteger(value) && value >= 0 ? value : fallback) as T;
  }
  return raw as T;
}
// The URL is the source of truth, including on reload and browser Back/Forward.
export function useUrlState<T extends string | number | boolean>(
  key: string,
  fallback: T,
): [T, (next: SetStateAction<T>) => void] {
  const url = useSyncExternalStore(subscribe, snapshot);
  const value = readParam(paramsForUrl(url), key, fallback);
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      const current = new URL(window.location.href);
      const previous = readParam(
        paramsForUrl(current.pathname + current.search),
        key,
        fallback,
      );
      const value = typeof next === "function" ? next(previous) : next;
      if (key === "empresa") {
        const path = routeParts(current.pathname).path;
        current.pathname = value
          ? `/agencias/${encodeURIComponent(String(value))}${path === "/" ? "/visao-geral" : path}`
          : path;
        current.searchParams.delete("empresa");
        navigate(current.pathname + current.search + current.hash, true);
        return;
      }
      if (value === fallback || value === "") current.searchParams.delete(key);
      else
        current.searchParams.set(
          key,
          typeof value === "boolean" ? (value ? "1" : "0") : String(value),
        );
      navigate(current.pathname + current.search + current.hash, true);
    },
    [key, fallback],
  );
  return [value, setValue];
}
function paramsForUrl(url: string) {
  const [path, search] = url.split("?");
  const params = new URLSearchParams(search);
  const company = routeParts(path).company;
  if (company) params.set("empresa", company);
  return params;
}

export function taskIdFromPath(path: string) {
  return (
    routeParts(path).path.match(
      /^\/tarefas\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/[a-z0-9-]+)?$/i,
    )?.[1] ?? null
  );
}
export function taskUrl(task: { id: string; title: string }, company: string) {
  const slug =
    task.title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100) || "tarefa";
  return `${pageUrl("tasks", company)}/${task.id}/${slug}`;
}

/** The dashboard in /dashboards/<id> (ids are uuids; the demo's start with "demo-"). */
export function dashboardIdFromPath(path: string) {
  return (
    routeParts(path).path.match(
      /^\/dashboards\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|demo-[0-9a-z-]{1,60})$/i,
    )?.[1] ?? null
  );
}

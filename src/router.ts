import { useCallback, useSyncExternalStore, type SetStateAction } from "react";

export const pagePaths = {
  overview: "/visao-geral",
  tasks: "/tarefas",
  clients: "/clientes",
  products: "/produtos",
  contracts: "/produtos-contratados",
  projects: "/projetos",
  hours: "/horas",
  reports: "/relatorios",
  drive: "/drive",
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
  if (taskIdFromPath(path)) return "tasks";
  return (
    (Object.keys(pagePaths) as Page[]).find(
      (page) => pagePaths[page] === normalized,
    ) ?? null
  );
}
export function navigate(url: string, replace = false) {
  if (url === snapshot()) return;
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

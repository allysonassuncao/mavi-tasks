import { useCallback, useSyncExternalStore, type SetStateAction } from "react";

export const pagePaths = {
  overview: "/visao-geral",
  tasks: "/tarefas",
  clients: "/clientes",
  projects: "/projetos",
  hours: "/horas",
  reports: "/relatorios",
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
export function resolvePage(path: string): Page | null {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "/") return "overview";
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
    pagePaths[page] + (company ? `?empresa=${encodeURIComponent(company)}` : "")
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
  const value = readParam(
    new URLSearchParams(url.split("?")[1]),
    key,
    fallback,
  );
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      const current = new URL(window.location.href);
      const previous = readParam(current.searchParams, key, fallback);
      const value = typeof next === "function" ? next(previous) : next;
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

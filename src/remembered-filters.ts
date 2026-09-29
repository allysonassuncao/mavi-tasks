/**
 * The last filters a person used on a page, kept in this browser (per
 * company and person), so coming back to the page opens it as they left it.
 */
const PREFIX = "mavi:filters:v1";

function storageKey(page: string, company: string, user: string) {
  return `${PREFIX}:${page}:${company}:${user}`;
}

export function readFilters<T extends object>(
  page: string,
  company: string,
  user: string,
): T | null {
  if (!company || !user) return null;
  try {
    const raw = localStorage.getItem(storageKey(page, company, user));
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" ? (value as T) : null;
  } catch {
    // Blocked storage or a broken value: start without filters.
    return null;
  }
}

export function writeFilters(
  page: string,
  company: string,
  user: string,
  filters: object,
) {
  if (!company || !user) return;
  try {
    localStorage.setItem(
      storageKey(page, company, user),
      JSON.stringify(filters),
    );
  } catch {
    // Blocked storage: the filters just won't be remembered.
  }
}

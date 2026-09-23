import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui";

/**
 * Page numbers to show: always the first and last, the current one with a
 * neighbour on each side, and "…" for the gaps — e.g. 1 … 4 5 6 … 54.
 * Pages are zero-based; the labels are one-based.
 */
export function pageWindow(page: number, pageCount: number) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);
  const around = [page - 1, page, page + 1].filter(
    (p) => p > 0 && p < pageCount - 1,
  );
  // Near an edge, show a few more pages instead of a lone "…".
  if (page <= 3) around.push(1, 2, 3, 4);
  if (page >= pageCount - 4)
    around.push(pageCount - 5, pageCount - 4, pageCount - 3, pageCount - 2);
  const pages = [...new Set([0, ...around, pageCount - 1])]
    .filter((p) => p >= 0 && p < pageCount)
    .sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  pages.forEach((p, i) => {
    if (i && p - pages[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

/**
 * Splits a list already in memory into pages. The page goes back to the
 * first whenever `resetKey` changes (a new search or filter), and is pulled
 * back when the list shrinks below it (an item removed on the last page).
 */
export function usePagination<T>(
  items: T[],
  pageSize: number,
  resetKey?: unknown,
) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => setPage(0), [resetKey]);
  const current = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => items.slice(current * pageSize, (current + 1) * pageSize),
    [items, current, pageSize],
  );
  return { page: current, pageCount, pageItems, setPage, pageSize };
}

const number = new Intl.NumberFormat("pt-BR");

/**
 * Pager under a list: "26–50 de 1.340 clientes", numbered pages and
 * previous/next. Hidden when everything fits in one page, unless `always`.
 */
export function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  noun,
  onPage,
  disabled = false,
  always = false,
  className = "",
  anchor,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  /** Plural shown after the count, e.g. "clientes". */
  noun: string;
  onPage: (page: number) => void;
  disabled?: boolean;
  always?: boolean;
  className?: string;
  /** Scrolled into view on a page change, so the new page starts at the top. */
  anchor?: RefObject<HTMLElement | null>;
}) {
  if (pageCount <= 1 && !always) return null;
  const go = (p: number) => {
    onPage(p);
    const el = anchor?.current;
    if (el && el.getBoundingClientRect().top < 0)
      el.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const first = total ? page * pageSize + 1 : 0,
    last = Math.min(total, (page + 1) * pageSize);
  return (
    <nav
      className={`pagination ${className}`}
      aria-label={`Páginas de ${noun}`}
    >
      <span>
        {pageCount > 1
          ? `${number.format(first)}–${number.format(last)} de ${number.format(total)} ${noun}`
          : `${number.format(total)} ${noun}`}
      </span>
      {pageCount > 1 && (
        <div>
          <Button
            className="icon-btn"
            disabled={disabled || page === 0}
            aria-label="Página anterior"
            onClick={() => go(page - 1)}
          >
            <ChevronLeft size={18} />
          </Button>
          {pageWindow(page, pageCount).map((p, i) =>
            p === "gap" ? (
              <span key={`gap-${i}`} className="page-gap" aria-hidden="true">
                …
              </span>
            ) : (
              <Button
                key={p}
                className={`page-number${p === page ? " selected" : ""}`}
                aria-label={`Página ${p + 1}`}
                aria-current={p === page ? "page" : undefined}
                disabled={disabled}
                onClick={() => go(p)}
              >
                {p + 1}
              </Button>
            ),
          )}
          <Button
            className="icon-btn"
            disabled={disabled || page >= pageCount - 1}
            aria-label="Próxima página"
            onClick={() => go(page + 1)}
          >
            <ChevronRight size={18} />
          </Button>
        </div>
      )}
    </nav>
  );
}

/**
 * A list shown a page at a time, for places that render lists from plain
 * functions (where the hook can't be called): `children` draws the page.
 */
export function Paged<T>({
  items,
  pageSize,
  noun,
  resetKey,
  className = "grid-pagination",
  children,
}: {
  items: T[];
  pageSize: number;
  noun: string;
  resetKey?: unknown;
  className?: string;
  children: (pageItems: T[]) => ReactNode;
}) {
  const pages = usePagination(items, pageSize, resetKey);
  const top = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={top} className="paged-anchor" aria-hidden="true" />
      {children(pages.pageItems)}
      <Pagination
        className={className}
        page={pages.page}
        pageCount={pages.pageCount}
        pageSize={pageSize}
        total={items.length}
        noun={noun}
        onPage={pages.setPage}
        anchor={top}
      />
    </>
  );
}

/**
 * A short preview of a long list (e.g. the clients that bought a product):
 * the first `initial` items, then "+N" reveals `step` more at a time.
 */
export function Expandable<T>({
  items,
  initial = 12,
  step = 60,
  noun,
  children,
}: {
  items: T[];
  initial?: number;
  step?: number;
  noun: string;
  children: (shown: T[]) => ReactNode;
}) {
  const [shown, setShown] = useState(initial);
  const rest = items.length - shown;
  return (
    <>
      {children(items.slice(0, shown))}
      {rest > 0 ? (
        <button
          type="button"
          className="expand-more"
          onClick={() => setShown((n) => n + step)}
        >
          +{number.format(rest)} {noun}
        </button>
      ) : (
        shown > initial && (
          <button
            type="button"
            className="expand-more"
            onClick={() => setShown(initial)}
          >
            Mostrar menos
          </button>
        )
      )}
    </>
  );
}

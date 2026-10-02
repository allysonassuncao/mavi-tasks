import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  AlertCircle,
  Copy,
  GripVertical,
  Info,
  List,
  Pencil,
  Sparkles,
  Table2,
  Trash2,
} from "lucide-react";
import { Button, Skeleton } from "./ui";
import { PanelChart } from "./DashboardCharts";
import {
  PanelRecordsView,
  type PickedCategory,
  type RecordsLoader,
} from "./DashboardRecords";
import {
  GRID_COLUMNS,
  buildDisplay,
  compact,
  panelNotes,
  placePanel,
  type Panel,
  type PanelResult,
} from "./dashboards";

/** Height of one grid row, in pixels. */
export const ROW_HEIGHT = 64;
const GAP = 12;
/** Grid rows the records of a panel take, below it (migration 20270224090000). */
const RECORD_ROWS = 8;

/**
 * Where the records of a panel go: the first grid line below it that no
 * panel crosses (a taller neighbour pushes it further down), so they take
 * the full width without covering anything; the panels from there on move
 * down by RECORD_ROWS.
 */
export function recordsLine(panels: Panel[], id: string): number | null {
  const panel = panels.find((p) => p.id === id);
  if (!panel) return null;
  let line = panel.y + panel.h;
  for (;;) {
    const across = panels.find((p) => p.y < line && p.y + p.h > line);
    if (!across) return line;
    line = across.y + across.h;
  }
}

/**
 * At most this many panel requests at once: a dashboard of 40 panels asks
 * the database a few at a time instead of all together.
 */
const MAX_CONCURRENT = 6;
let active = 0;
const waiting: (() => void)[] = [];
function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          active--;
          waiting.shift()?.();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else waiting.push(run);
  });
}

/** Loads one panel's data (from the app, a shared link or the demo). */
export type PanelLoader = (
  panel: Panel,
  fresh: boolean,
) => Promise<PanelResult>;

/** The panel's ⓘ: who each figure counts for (migration 20270131090000). */
function PanelNotes({ notes }: { notes: string[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          className="icon-btn"
          aria-label="O que este painel conta"
          title="O que este painel conta"
        >
          <Info size={14} />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="dash-notes-pop"
          align="end"
          sideOffset={6}
          collisionPadding={12}
        >
          <strong>O que este painel conta</strong>
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PanelCard({
  panel,
  loader,
  loadKey,
  refresh,
  editing,
  dragging,
  onDragStart,
  onEdit,
  onDuplicate,
  onDelete,
  onAsk,
  records,
  shift,
}: {
  panel: Panel;
  loader: PanelLoader;
  /** Changes when the period or filters change: the panel reloads. */
  loadKey: string;
  /** Bumped by "Atualizar": reloads skipping the cache. */
  refresh: number;
  editing: boolean;
  dragging: boolean;
  onDragStart?: (e: ReactPointerEvent, mode: "move" | "resize") => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  /** Conversar com a MAVI sobre este painel. */
  onAsk?: () => void;
  /** The records behind the figure (absent: not offered here). */
  records?: {
    loader: RecordsLoader;
    tz: string;
    /** Open below this panel, at this grid line. */
    line: number | null;
    picked: PickedCategory | null;
    /** Opens (or closes, with false) the records, with a category or not. */
    onOpen: (open: boolean, picked?: PickedCategory | null) => void;
  };
  /** Grid rows the panel moves down (records open above it). */
  shift: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<PanelResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const lastRefresh = useRef(refresh);
  const specKey = JSON.stringify(panel.spec);

  // Panels load when they come near the screen (long dashboards stay light).
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setVisible(true),
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    const fresh = refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    setLoading(true);
    setError("");
    limited(() => loader(panel, fresh))
      .then((r) => current && setResult(r))
      .catch((e) => current && setError((e as Error).message))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
    // The spec (by value), the period and filters decide the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, specKey, loadKey, refresh]);

  const display = useMemo(
    () => (result ? buildDisplay(panel.spec, result) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, specKey],
  );
  const notes = useMemo(
    () => panelNotes(panel.spec),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [specKey],
  );
  const canTable = panel.spec.viz !== "stat" && panel.spec.viz !== "table";
  const spec =
    asTable && canTable ? { ...panel.spec, viz: "table" as const } : panel.spec;
  const offer = !!records && !editing;
  const open = offer && records!.line !== null;
  // Clicking a category opens its records; clicking it again shows them all.
  const select = (key: string) => {
    if (!records || !display) return;
    const i = display.keys.indexOf(key);
    const same = open && records.picked?.key === key;
    records.onOpen(
      true,
      same ? null : { key, label: display.labels[i] ?? key },
    );
  };
  return (
    <>
    <article
      ref={ref}
      className={`dash-panel ${editing ? "editing" : ""} ${dragging ? "dragging" : ""} ${offer ? "with-records" : ""} ${open ? "records-open" : ""}`}
      data-viz={panel.spec.viz}
      style={{
        gridColumn: `${panel.x + 1} / span ${panel.w}`,
        gridRow: `${panel.y + shift + 1} / span ${panel.h}`,
        ["--panel-rows" as string]: panel.h,
      }}
      aria-label={panel.title || "Painel"}
    >
      <header
        className="dash-panel-head"
        onPointerDown={editing ? (e) => onDragStart?.(e, "move") : undefined}
      >
        {editing && (
          <GripVertical size={14} className="dash-grip" aria-hidden="true" />
        )}
        <h3 title={panel.title}>{panel.title || "Sem título"}</h3>
        {loading && result && (
          <span className="dash-refreshing" aria-label="Atualizando" />
        )}
        <span
          className="dash-panel-actions"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {notes.length > 0 && <PanelNotes notes={notes} />}
          {onAsk && (
            <Button
              className="icon-btn"
              aria-label={`Perguntar à MAVI sobre ${panel.title}`}
              title="Explicar ou mudar com a MAVI"
              onClick={onAsk}
            >
              <Sparkles size={14} />
            </Button>
          )}
          {canTable && !editing && (
            <Button
              className={`icon-btn ${asTable ? "active" : ""}`}
              aria-label={asTable ? "Ver gráfico" : "Ver como tabela"}
              aria-pressed={asTable}
              title={asTable ? "Ver gráfico" : "Ver como tabela"}
              onClick={() => setAsTable((v) => !v)}
            >
              <Table2 size={14} />
            </Button>
          )}
          {editing && (
            <>
              <Button
                className="icon-btn"
                aria-label={`Editar ${panel.title}`}
                title="Editar painel"
                onClick={onEdit}
              >
                <Pencil size={14} />
              </Button>
              <Button
                className="icon-btn"
                aria-label={`Duplicar ${panel.title}`}
                title="Duplicar painel"
                onClick={onDuplicate}
              >
                <Copy size={14} />
              </Button>
              <Button
                className="icon-btn danger"
                aria-label={`Remover ${panel.title}`}
                title="Remover painel"
                onClick={onDelete}
              >
                <Trash2 size={14} />
              </Button>
            </>
          )}
        </span>
      </header>
      <div className="dash-panel-body">
        {error ? (
          <p className="dash-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" /> {error}
          </p>
        ) : display ? (
          <PanelChart
            display={display}
            spec={spec}
            onSelect={offer ? select : undefined}
            selected={open ? (records!.picked?.key ?? null) : null}
          />
        ) : (
          <Skeleton className="dash-skeleton" />
        )}
      </div>
      {offer && (
        <footer className="dash-panel-foot">
          <button
            type="button"
            className={`dash-records-toggle ${open ? "active" : ""}`}
            aria-expanded={open}
            onClick={() => records!.onOpen(!open)}
          >
            <List size={13} aria-hidden="true" />
            {open ? "Fechar os registros" : "Ver os registros"}
          </button>
        </footer>
      )}
      {editing && (
        <span
          className="dash-resize"
          role="presentation"
          title="Arraste para redimensionar"
          onPointerDown={(e) => onDragStart?.(e, "resize")}
        />
      )}
    </article>
    {open && (
      <div
        className="dash-records-slot"
        style={{
          gridColumn: "1 / -1",
          gridRow: `${records!.line! + 1} / span ${RECORD_ROWS}`,
        }}
      >
        <PanelRecordsView
          panel={panel}
          display={display}
          result={result}
          picked={records!.picked}
          onClearPick={() => records!.onOpen(true, null)}
          loader={records!.loader}
          loadKey={loadKey}
          refresh={refresh}
          tz={records!.tz}
          onClose={() => records!.onOpen(false)}
        />
      </div>
    )}
    </>
  );
}

/**
 * The dashboard grid: 12 columns, rows of ROW_HEIGHT. While editing, panels
 * move by their header and resize by the corner; the others reflow. On
 * phones the panels stack in reading order.
 */
export function DashboardCanvas({
  panels,
  loader,
  loadKey,
  refresh,
  editing = false,
  onLayout,
  onEditPanel,
  onAskPanel,
  onDuplicatePanel,
  onDeletePanel,
  recordsLoader,
  tz = "America/Sao_Paulo",
}: {
  panels: Panel[];
  loader: PanelLoader;
  loadKey: string;
  refresh: number;
  editing?: boolean;
  /** The records below each panel (absent: none, e.g. a link that hides them). */
  recordsLoader?: RecordsLoader;
  /** The company's time zone, for the records' dates. */
  tz?: string;
  onLayout?: (panels: Panel[]) => void;
  onEditPanel?: (panel: Panel) => void;
  onAskPanel?: (panel: Panel) => void;
  onDuplicatePanel?: (panel: Panel) => void;
  onDeletePanel?: (panel: Panel) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  // One panel's records open at a time, with the category picked on it.
  const [records, setRecords] = useState<{
    panel: string;
    picked: PickedCategory | null;
  } | null>(null);
  const layout = useRef(panels);
  layout.current = panels;

  function startDrag(
    e: ReactPointerEvent,
    panel: Panel,
    mode: "move" | "resize",
  ) {
    if (!onLayout || !grid.current || e.button !== 0) return;
    if (window.matchMedia("(max-width: 720px)").matches) return;
    e.preventDefault();
    const box = grid.current.getBoundingClientRect();
    const col = (box.width - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS + GAP;
    const row = ROW_HEIGHT + GAP;
    const origin = {
      x: e.clientX,
      y: e.clientY,
      rect: { x: panel.x, y: panel.y, w: panel.w, h: panel.h },
    };
    let last = "";
    // Every step starts from the layout before the drag (no drift).
    const before = layout.current;
    setDrag(panel.id);
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - origin.x) / col);
      const dy = Math.round((ev.clientY - origin.y) / row);
      const r = origin.rect;
      const rect =
        mode === "move"
          ? { ...r, x: r.x + dx, y: r.y + dy }
          : { ...r, w: r.w + dx, h: r.h + dy };
      const key = `${rect.x},${rect.y},${rect.w},${rect.h}`;
      if (key === last) return;
      last = key;
      onLayout(placePanel(before, panel.id, rect));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      // Dropped: everything packs upwards, the moved panel included.
      onLayout(compact(layout.current));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const ordered = useMemo(
    () => [...panels].sort((a, b) => a.y - b.y || a.x - b.x),
    [panels],
  );
  const shown = records && recordsLoader && !editing ? records : null;
  const line = shown ? recordsLine(panels, shown.panel) : null;
  return (
    <div
      ref={grid}
      className={`dash-grid ${editing ? "editing" : ""}`}
      style={{
        ["--row-height" as string]: `${ROW_HEIGHT}px`,
        ["--gap" as string]: `${GAP}px`,
      }}
    >
      {ordered.map((panel) => (
        <PanelCard
          key={panel.id}
          panel={panel}
          loader={loader}
          loadKey={loadKey}
          refresh={refresh}
          editing={editing}
          dragging={drag === panel.id}
          onDragStart={(e, mode) => startDrag(e, panel, mode)}
          onEdit={() => onEditPanel?.(panel)}
          onDuplicate={() => onDuplicatePanel?.(panel)}
          onDelete={() => onDeletePanel?.(panel)}
          onAsk={onAskPanel ? () => onAskPanel(panel) : undefined}
          shift={line !== null && panel.y >= line ? RECORD_ROWS : 0}
          records={
            recordsLoader
              ? {
                  loader: recordsLoader,
                  tz,
                  line: shown?.panel === panel.id ? line : null,
                  picked: shown?.panel === panel.id ? shown.picked : null,
                  onOpen: (open, picked = null) =>
                    setRecords(open ? { panel: panel.id, picked } : null),
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}

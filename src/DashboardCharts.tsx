import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import {
  OTHER_COLOR,
  formatTick,
  formatValue,
  type Display,
  type PanelSpec,
} from "./dashboards";

/**
 * The panel visualizations, drawn as plain SVG (no chart library): number,
 * time series (line, area, columns), categories (columns, horizontal bars),
 * donut and table. Every chart has a hover tooltip and, with two or more
 * series, a legend; values are always written out (the table view and the
 * tooltips), so colour is never the only way to tell series apart.
 */

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) =>
        Math.abs(s.width - width) < 1 && Math.abs(s.height - height) < 1
          ? s
          : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** 0 and 4–6 round steps covering the values (negatives included). */
export function niceTicks(min: number, max: number, count = 4) {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [0, 1];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step)
    ticks.push(Math.round(v / step) * step);
  if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

type Tip = {
  x: number;
  y: number;
  title: string;
  /** [key, color, name, value] */
  rows: [string, string, string, string][];
};
function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x + 12, 0), Math.max(0, width - 200));
  return (
    <div
      className="dash-tip"
      style={{ left, top: Math.max(0, tip.y - 10) }}
      role="tooltip"
    >
      <strong>{tip.title}</strong>
      {tip.rows.map(([key, color, name, value]) => (
        <span key={key}>
          <i style={{ background: color }} aria-hidden="true" />
          {name}
          <b>{value}</b>
        </span>
      ))}
    </div>
  );
}

function Legend({
  items,
}: {
  items: { id: string; name: string; color: string; value?: string }[];
}) {
  if (items.length < 2) return null;
  return (
    <ul className="dash-legend">
      {items.map((s) => (
        <li key={s.id}>
          <i style={{ background: s.color }} aria-hidden="true" />
          {s.name}
          {s.value && <b>{s.value}</b>}
        </li>
      ))}
    </ul>
  );
}

const Empty = () => <p className="dash-empty">Sem dados no período.</p>;
const hasData = (d: Display) =>
  d.keys.length > 0 &&
  d.series.some((s) => s.values.some((v) => v !== null && v !== 0));

// ------------------------------------------------------------ number
function StatView({ display, spec }: { display: Display; spec: PanelSpec }) {
  return (
    <div className={`dash-stat ${display.series.length > 1 ? "multi" : ""}`}>
      {display.series.map((s) => {
        const value = s.values[0] ?? null;
        const prev = s.previous;
        const delta =
          prev !== undefined && prev !== null && value !== null && prev !== 0
            ? ((value - prev) / Math.abs(prev)) * 100
            : null;
        return (
          <div key={s.id} className="dash-stat-item">
            {display.series.length > 1 && <small>{s.name}</small>}
            <strong>{formatValue(value, s.unit, spec.decimals)}</strong>
            {spec.compare && (
              <span
                className={`dash-delta ${delta === null ? "" : delta > 0 ? "up" : delta < 0 ? "down" : ""}`}
                title="Comparado ao período anterior de mesma duração"
              >
                {delta === null ? (
                  <Minus size={13} aria-hidden="true" />
                ) : delta > 0 ? (
                  <ArrowUpRight size={13} aria-hidden="true" />
                ) : delta < 0 ? (
                  <ArrowDownRight size={13} aria-hidden="true" />
                ) : (
                  <Minus size={13} aria-hidden="true" />
                )}
                {delta === null
                  ? prev === null || prev === undefined
                    ? "sem base anterior"
                    : `antes: ${formatValue(prev, s.unit, spec.decimals)}`
                  : `${delta > 0 ? "+" : ""}${delta.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% vs. período anterior`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ time series
const PAD = { top: 10, right: 12, bottom: 24, left: 44 };

function TimeChart({
  display,
  kind,
}: {
  display: Display;
  kind: "line" | "area" | "bar";
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = display.keys.length;
  const all = display.series.flatMap((s) =>
    s.values.filter((v): v is number => v !== null),
  );
  const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0));
  const lo = ticks[0],
    hi = ticks[ticks.length - 1];
  const w = Math.max(0, width - PAD.left - PAD.right);
  const h = Math.max(0, height - PAD.top - PAD.bottom);
  const band = n ? w / n : 0;
  const x = (i: number) =>
    PAD.left +
    (kind === "bar" ? band * i + band / 2 : n > 1 ? (w * i) / (n - 1) : w / 2);
  const y = (v: number) => PAD.top + h - ((v - lo) / (hi - lo || 1)) * h;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(w / 56))));
  const groupW = Math.max(1, band - Math.max(2, band * 0.2));
  const barW = Math.max(1, groupW / display.series.length - 2);

  function move(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i =
      kind === "bar"
        ? Math.floor(px / (band || 1))
        : Math.round((px / (w || 1)) * (n - 1));
    setHover(Math.min(Math.max(i, 0), n - 1));
  }
  const tip: Tip | null =
    hover === null
      ? null
      : {
          x: x(hover),
          y: PAD.top,
          title: display.labels[hover],
          rows: display.series.map((s) => [
            s.id,
            s.color,
            s.name,
            formatValue(s.values[hover], s.unit),
          ]),
        };
  const path = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  return (
    <div className="dash-chart-wrap">
      <div className="dash-chart" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Gráfico ao longo do tempo"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(t)}
                  y2={y(t)}
                  className={t === 0 ? "dash-axis" : "dash-gridline"}
                />
                <text
                  x={PAD.left - 6}
                  y={y(t)}
                  className="dash-tick"
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {formatTick(t, display.unit)}
                </text>
              </g>
            ))}
            {display.labels.map((l, i) =>
              i % every === 0 ? (
                <text
                  key={i}
                  x={x(i)}
                  y={height - 6}
                  className="dash-tick"
                  textAnchor="middle"
                >
                  {l}
                </text>
              ) : null,
            )}
            {kind === "bar"
              ? display.series.map((s, si) =>
                  s.values.map((v, i) => {
                    if (v === null || v === 0) return null;
                    const top = y(Math.max(v, 0));
                    const bottom = y(Math.min(v, 0));
                    return (
                      <rect
                        key={`${si}-${i}`}
                        x={x(i) - groupW / 2 + si * (barW + 2) + 1}
                        y={top}
                        width={barW}
                        height={Math.max(1, bottom - top)}
                        rx={Math.min(4, barW / 2)}
                        fill={s.color}
                        opacity={hover === null || hover === i ? 1 : 0.55}
                      />
                    );
                  }),
                )
              : display.series.map((s) => (
                  <g key={s.id}>
                    {kind === "area" && (
                      <path
                        d={`${path(s.values)}L${x(n - 1)},${y(Math.max(lo, 0))}L${x(0)},${y(Math.max(lo, 0))}Z`}
                        fill={s.color}
                        opacity={0.12}
                      />
                    )}
                    <path
                      d={path(s.values)}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    {hover !== null && s.values[hover] !== null && (
                      <circle
                        cx={x(hover)}
                        cy={y(s.values[hover]!)}
                        r={4}
                        fill={s.color}
                        stroke="#fff"
                        strokeWidth={2}
                      />
                    )}
                  </g>
                ))}
            {hover !== null && kind !== "bar" && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={PAD.top + h}
                className="dash-crosshair"
              />
            )}
            <rect
              x={PAD.left}
              y={PAD.top}
              width={w}
              height={h}
              fill="transparent"
              onPointerMove={move}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
      <Legend items={display.series} />
    </div>
  );
}

// ------------------------------------------------------------ categories
function CategoryChart({
  display,
  horizontal,
}: {
  display: Display;
  horizontal: boolean;
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = display.keys.length;
  const count = display.series.length;
  const all = display.series.flatMap((s) =>
    s.values.filter((v): v is number => v !== null),
  );
  const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0));
  const lo = ticks[0],
    hi = ticks[ticks.length - 1];
  const colorOf = (key: string, base: string) =>
    key === "__other__" ? OTHER_COLOR : base;
  const tipAt = (i: number, px: number, py: number): Tip => ({
    x: px,
    y: py,
    title: display.labels[i],
    rows: display.series.map((s) => [
      s.id,
      colorOf(display.keys[i], s.color),
      s.name,
      formatValue(s.values[i], s.unit),
    ]),
  });

  if (horizontal) {
    // One row per category: its name above a thin bar, the value at the end.
    const labelW = 0;
    const valueW = 72;
    const w = Math.max(0, width - labelW - valueW);
    const scale = (v: number) => ((v - lo) / (hi - lo || 1)) * w;
    return (
      <div className="dash-chart-wrap">
        <div className="dash-hbars" ref={ref}>
          {display.keys.map((key, i) => (
            <div
              key={key}
              className={`dash-hbar ${hover === i ? "hover" : ""}`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            >
              <span className="dash-hbar-label" title={display.labels[i]}>
                {display.labels[i]}
              </span>
              {display.series.map((s) => {
                const v = s.values[s.values === undefined ? 0 : i];
                return (
                  <span key={s.id} className="dash-hbar-row">
                    <span className="dash-hbar-track" style={{ width: w }}>
                      <i
                        style={{
                          left: scale(Math.min(v ?? 0, 0)),
                          width: Math.max(
                            v ? 2 : 0,
                            Math.abs(scale(v ?? 0) - scale(0)),
                          ),
                          background: colorOf(key, s.color),
                        }}
                      />
                    </span>
                    <b>{formatValue(v, s.unit)}</b>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        <Legend items={display.series} />
      </div>
    );
  }

  const w = Math.max(0, width - PAD.left - PAD.right);
  const h = Math.max(0, height - PAD.top - PAD.bottom);
  const band = n ? w / n : 0;
  const groupW = Math.max(1, band - Math.max(4, band * 0.25));
  const barW = Math.max(1, groupW / count - 2);
  const y = (v: number) => PAD.top + h - ((v - lo) / (hi - lo || 1)) * h;
  const x = (i: number) => PAD.left + band * i + band / 2;
  const maxChars = Math.max(3, Math.floor(band / 6.5));
  const short = (s: string) =>
    s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
  return (
    <div className="dash-chart-wrap">
      <div className="dash-chart" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Gráfico por categoria"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(t)}
                  y2={y(t)}
                  className={t === 0 ? "dash-axis" : "dash-gridline"}
                />
                <text
                  x={PAD.left - 6}
                  y={y(t)}
                  className="dash-tick"
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {formatTick(t, display.unit)}
                </text>
              </g>
            ))}
            {display.keys.map((key, i) => (
              <g key={key}>
                {display.series.map((s, si) => {
                  const v = s.values[i];
                  if (v === null || v === 0) return null;
                  const top = y(Math.max(v, 0));
                  const bottom = y(Math.min(v, 0));
                  return (
                    <rect
                      key={s.id}
                      x={x(i) - groupW / 2 + si * (barW + 2) + 1}
                      y={top}
                      width={barW}
                      height={Math.max(1, bottom - top)}
                      rx={Math.min(4, barW / 2)}
                      fill={colorOf(key, s.color)}
                      opacity={hover === null || hover === i ? 1 : 0.55}
                    />
                  );
                })}
                <text
                  x={x(i)}
                  y={height - 6}
                  className="dash-tick"
                  textAnchor="middle"
                >
                  {short(display.labels[i])}
                </text>
                <rect
                  x={x(i) - band / 2}
                  y={PAD.top}
                  width={band}
                  height={h}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                />
              </g>
            ))}
          </svg>
        )}
        <Tooltip
          tip={hover === null ? null : tipAt(hover, x(hover), PAD.top)}
          width={width}
        />
      </div>
      <Legend items={display.series} />
    </div>
  );
}

// ------------------------------------------------------------ donut
function DonutChart({ display }: { display: Display }) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const s = display.series[0];
  const slices = display.keys
    .map((key, i) => ({
      key,
      label: display.labels[i],
      v: Math.max(0, s?.values[i] ?? 0),
    }))
    .filter((x) => x.v > 0);
  const total = slices.reduce((sum, x) => sum + x.v, 0);
  const size = Math.max(0, Math.min(width, height));
  const r = size / 2 - 4;
  const inner = r * 0.62;
  const colorAt = (i: number, key: string) =>
    key === "__other__"
      ? OTHER_COLOR
      : [
          "#2a78d6",
          "#eb6834",
          "#1baf7a",
          "#eda100",
          "#e87ba4",
          "#008300",
          "#4a3aa7",
          "#e34948",
        ][i % 8];
  let angle = -Math.PI / 2;
  const arcs = slices.map((sl, i) => {
    const sweep = (sl.v / (total || 1)) * Math.PI * 2;
    const a0 = angle,
      a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) =>
      `${size / 2 + rad * Math.cos(a)},${size / 2 + rad * Math.sin(a)}`;
    const d =
      sweep >= Math.PI * 2 - 1e-6
        ? `M${p(0, r)}A${r},${r} 0 1 1 ${p(Math.PI, r)}A${r},${r} 0 1 1 ${p(0, r)}M${p(0, inner)}A${inner},${inner} 0 1 0 ${p(Math.PI, inner)}A${inner},${inner} 0 1 0 ${p(0, inner)}Z`
        : `M${p(a0, r)}A${r},${r} 0 ${large} 1 ${p(a1, r)}L${p(a1, inner)}A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}Z`;
    return { ...sl, d, color: colorAt(i, sl.key) };
  });
  const focus = hover === null ? null : arcs[hover];
  return (
    <div className="dash-donut">
      <div className="dash-donut-chart" ref={ref}>
        {size > 0 && (
          <svg
            width={size}
            height={size}
            role="img"
            aria-label="Gráfico de rosca"
          >
            {arcs.map((a, i) => (
              <path
                key={a.key}
                d={a.d}
                fill={a.color}
                stroke="#fff"
                strokeWidth={2}
                fillRule="evenodd"
                opacity={hover === null || hover === i ? 1 : 0.5}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              />
            ))}
            <text
              x={size / 2}
              y={size / 2 - 6}
              textAnchor="middle"
              className="dash-donut-value"
            >
              {formatValue(focus ? focus.v : total, s?.unit ?? display.unit)}
            </text>
            <text
              x={size / 2}
              y={size / 2 + 14}
              textAnchor="middle"
              className="dash-donut-caption"
            >
              {focus ? focus.label : "Total"}
            </text>
          </svg>
        )}
      </div>
      <ul className="dash-legend vertical">
        {arcs.map((a, i) => (
          <li
            key={a.key}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
          >
            <i style={{ background: a.color }} aria-hidden="true" />
            <span>{a.label}</span>
            <b>
              {formatValue(a.v, s?.unit ?? display.unit)}{" "}
              <small>
                {((a.v / (total || 1)) * 100).toLocaleString("pt-BR", {
                  maximumFractionDigits: 1,
                })}
                %
              </small>
            </b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------ table
function TableView({ display, group }: { display: Display; group: string }) {
  return (
    <div className="dash-table-wrap">
      <table className="dash-table">
        <thead>
          <tr>
            <th>{group}</th>
            {display.series.map((s) => (
              <th key={s.id} className="num">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.keys.map((key, i) => (
            <tr key={key}>
              <td>{display.labels[i]}</td>
              {display.series.map((s) => (
                <td key={s.id} className="num">
                  {formatValue(s.values[i], s.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const groupHeading: Record<string, string> = {
  none: "Total",
  time: "Período",
  client: "Cliente",
  product: "Produto",
  project: "Projeto",
  team: "Equipe",
  person: "Pessoa",
  creator: "Criador",
  status: "Status",
  priority: "Prioridade",
};

/** Draws a panel's display with its visualization. */
export const PanelChart = memo(function PanelChart({
  display,
  spec,
}: {
  display: Display;
  spec: PanelSpec;
}): ReactNode {
  if (spec.viz === "stat") return <StatView display={display} spec={spec} />;
  if (!hasData(display)) return <Empty />;
  if (spec.viz === "table")
    return (
      <TableView display={display} group={groupHeading[spec.groupBy] ?? ""} />
    );
  if (spec.viz === "donut") return <DonutChart display={display} />;
  if (spec.groupBy === "time")
    return (
      <TimeChart
        display={display}
        kind={
          spec.viz === "hbar" ? "bar" : (spec.viz as "line" | "area" | "bar")
        }
      />
    );
  if (spec.viz === "line" || spec.viz === "area")
    return <CategoryChart display={display} horizontal={false} />;
  return <CategoryChart display={display} horizontal={spec.viz === "hbar"} />;
});

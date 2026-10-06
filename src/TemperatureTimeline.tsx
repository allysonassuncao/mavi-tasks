import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Flag,
  MessageCircle,
  Video,
} from "lucide-react";
import { Loading } from "./ui";
import {
  appPath,
  bandOf,
  dateBr,
  loadTemperatureTimeline,
  openInApp,
  scoreLabel,
  signalPath,
  signalTitle,
  type ClientTemperature,
  type TemperatureBand,
  type TemperatureTimeline as Timeline,
  type TimelineEvent,
  type TimelineSignal,
} from "./temperature";

type Tone = "up" | "down" | "flat";
type Item = TimelineEvent & {
  /** A nota do dia menos a do dia anterior (nulo sem as duas notas). */
  delta: number | null;
  tone: Tone;
  /** first: o primeiro contato; gained/back: a nota apareceu (de novo); lost: ficou sem nota. */
  kind: "first" | "gained" | "back" | "lost" | "move";
  /** Mudou de faixa (as duas notas existem). */
  turn: boolean;
  month: string;
};
type Filter = "all" | "up" | "down" | "turns";

const DAY = 86400000;
const dayNum = (day: string) => Math.round(Date.parse(`${day}T12:00:00Z`) / DAY);
const toneOf = (d: number | null): Tone =>
  d === null ? "flat" : d >= 0.5 ? "up" : d <= -0.5 ? "down" : "flat";
/** "+6 pts", "−8 pts" ou "sem efeito". */
function pts(d: number | null) {
  if (d === null) return "";
  const n = Math.round(d);
  if (n === 0) return "sem efeito";
  return `${n > 0 ? "+" : "−"}${Math.abs(n)} ${Math.abs(n) === 1 ? "pt" : "pts"}`;
}
const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
const monthLabel = (month: string) => {
  const text = new Date(`${month}-15T12:00:00Z`).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
};
/** "há 3 meses", "há 12 dias", "hoje". */
function ago(from: string, to: string) {
  const days = dayNum(to) - dayNum(from);
  if (days <= 0) return "hoje";
  if (days < 45) return `há ${days} ${days === 1 ? "dia" : "dias"}`;
  const months = Math.round(days / 30.4);
  if (months < 18) return `há ${months} meses`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `há ${years} ${years === 1 ? "ano" : "anos"}${rest ? ` e ${rest} ${rest === 1 ? "mês" : "meses"}` : ""}`;
}

/**
 * Termômetro › Linha do tempo: do primeiro contato até hoje, cada dia em que
 * a temperatura mexeu — as reuniões e os dias de grupo que entraram, as
 * leituras que saíram da janela, quantos pontos o dia somou ou tirou, as
 * viradas de faixa e os sinais de alerta. Em cima, o pulso do período todo
 * (clicar num dia leva até ele); embaixo, os meses, com os dois mais recentes
 * abertos.
 */
export function TemperatureTimeline({
  company,
  client,
  data,
}: {
  company: string;
  client: string;
  data: ClientTemperature;
}) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [newestFirst, setNewestFirst] = useState(true);
  // Os meses que a pessoa abriu ou fechou (o contrário do padrão do filtro).
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Recarrega quando a temperatura é recalculada (uma correção, por exemplo).
  useEffect(() => {
    let alive = true;
    setError("");
    loadTemperatureTimeline(company, client)
      .then((t) => alive && setTimeline(t))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [company, client, data.refreshed_at]);

  const bands = data.settings.bands;
  const names = useMemo(() => new Map(data.indicators.map((i) => [i.key, i])), [data.indicators]);
  const reasonLabel = useMemo(
    () => new Map(data.settings.reasons.map((r) => [r.key, r.label.split(" (")[0]])),
    [data.settings.reasons],
  );

  const items = useMemo<Item[]>(() => {
    let hadScore = false;
    return (timeline?.events ?? []).map((e) => {
      const delta =
        e.score !== null && e.prev !== null ? Math.round((e.score - e.prev) * 10) / 10 : null;
      const kind: Item["kind"] = e.first
        ? "first"
        : e.prev === null && e.score !== null
          ? hadScore
            ? "back"
            : "gained"
          : e.prev !== null && e.score === null
            ? "lost"
            : "move";
      if (e.score !== null) hadScore = true;
      return {
        ...e,
        delta,
        tone: toneOf(delta),
        kind,
        turn: e.band !== null && e.prev_band !== null && e.band !== e.prev_band,
        month: e.day.slice(0, 7),
      };
    });
  }, [timeline]);

  const stats = useMemo(() => {
    if (!items.length) return null;
    const scored = items.filter((i) => i.score !== null);
    const firstScore = scored[0] ?? null;
    const last = items[items.length - 1];
    const now = data.current?.score ?? last.score;
    let up: Item | null = null;
    let down: Item | null = null;
    let meetings = 0;
    let whatsapp = 0;
    for (const i of items) {
      if (i.delta !== null && i.tone === "up" && (!up || i.delta > up.delta!)) up = i;
      if (i.delta !== null && i.tone === "down" && (!down || i.delta < down.delta!)) down = i;
      for (const s of i.signals) s.type === "meeting" ? meetings++ : whatsapp++;
    }
    return { first: items[0], firstScore, now, up, down, meetings, whatsapp };
  }, [items, data.current?.score]);

  const isTurn = (i: Item) =>
    i.turn || i.flags_added.length > 0 || i.kind !== "move";
  const matches = (i: Item, f: Filter) =>
    f === "all" || (f === "up" ? i.tone === "up" : f === "down" ? i.tone === "down" : isTurn(i));
  const counts: Record<Filter, number> = {
    all: items.length,
    up: items.filter((i) => i.tone === "up").length,
    down: items.filter((i) => i.tone === "down").length,
    turns: items.filter(isTurn).length,
  };

  // Os meses: o saldo e como terminou contam todos os dias do mês.
  const months = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const i of items) {
      const list = map.get(i.month) ?? [];
      list.push(i);
      map.set(i.month, list);
    }
    return [...map.entries()].map(([key, all]) => {
      const end = [...all].reverse().find((i) => i.score !== null) ?? null;
      return {
        key,
        all,
        net: all.reduce((sum, i) => sum + (i.delta ?? 0), 0),
        end,
        contacts: all.reduce((sum, i) => sum + i.signals.length, 0),
      };
    });
  }, [items]);
  const recent = new Set(months.slice(-2).map((m) => m.key));
  const isOpen = (key: string) => (filter !== "all" || recent.has(key)) !== toggled.has(key);
  const toggleMonth = (key: string) =>
    setToggled((t) => {
      const next = new Set(t);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const changeFilter = (f: Filter) => {
    setFilter(f);
    setToggled(new Set());
  };

  // Ir até um dia (pelo pulso ou pelos destaques): abre o mês e pisca o dia.
  const anchor = (day: string) => `thermo-tl-${client}-${day}`;
  function jump(i: Item) {
    const f = matches(i, filter) ? filter : "all";
    const openByDefault = f !== "all" || recent.has(i.month);
    setFilter(f);
    setToggled((t) => {
      const next = new Set(f === filter ? t : []);
      if (openByDefault) next.delete(i.month);
      else next.add(i.month);
      return next;
    });
    setFlash(i.day);
  }
  useEffect(() => {
    if (!flash) return;
    const el = document.getElementById(anchor(flash));
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);

  if (error)
    return (
      <section className="thermo-block" aria-label="Linha do tempo">
        <h3>Linha do tempo</h3>
        <p className="form-error" role="alert">
          {error}
        </p>
      </section>
    );
  if (!timeline)
    return (
      <section className="thermo-block" aria-label="Linha do tempo">
        <h3>Linha do tempo</h3>
        <Loading variant="list" />
      </section>
    );
  if (!items.length || !stats) return null;

  const today = timeline.today;
  const shownMonths = (newestFirst ? [...months].reverse() : months)
    .map((m) => {
      const list = m.all.filter((i) => matches(i, filter));
      return { ...m, list: newestFirst ? [...list].reverse() : list };
    })
    .filter((m) => m.list.length > 0);
  const nowBand = bandOf(bands, data.current?.band ?? items[items.length - 1].band);
  const total = stats.firstScore && stats.now !== null ? stats.now - stats.firstScore.score! : null;

  const tabs: { id: Filter; label: string }[] = [
    { id: "all", label: "Tudo" },
    { id: "up", label: "Subiu" },
    { id: "down", label: "Desceu" },
    { id: "turns", label: "Viradas" },
  ];

  const nowRow = (
    <li className="thermo-tl-mark" style={{ "--band": nowBand?.color ?? "#a3acab" } as CSSProperties}>
      <span className="thermo-tl-dot" aria-hidden="true" />
      <div>
        <strong>Hoje</strong> · {dateBr(today)}
        {stats.now !== null && (
          <>
            {" · "}
            <strong>{scoreLabel(stats.now)}</strong>
            {nowBand && <span className="thermo-tl-band">{nowBand.name}</span>}
          </>
        )}
      </div>
    </li>
  );
  const startRow = (
    <li className="thermo-tl-mark start">
      <span className="thermo-tl-dot" aria-hidden="true" />
      <div>
        <strong>Primeiro contato lido</strong> · {dateBr(stats.first.day)}
      </div>
    </li>
  );

  return (
    <section className="thermo-block thermo-tl" aria-label="Linha do tempo">
      <div className="thermo-signals-head">
        <h3>
          Linha do tempo{" "}
          <small>do primeiro contato até hoje: o que esquentou e o que esfriou o cliente</small>
        </h3>
      </div>

      <div className="thermo-tl-stats">
        <div>
          <span>Desde</span>
          <strong>{dateBr(stats.first.day)}</strong>
          <small>{ago(stats.first.day, today)}</small>
        </div>
        {total !== null && (
          <div>
            <span>Saldo</span>
            <strong className={`thermo-tl-num ${toneOf(total)}`}>{pts(total)}</strong>
            <small>
              de {scoreLabel(stats.firstScore!.score)} para {scoreLabel(stats.now)}
            </small>
          </div>
        )}
        <div>
          <span>Contatos</span>
          <strong>{stats.meetings + stats.whatsapp}</strong>
          <small>
            {[
              stats.meetings && `${stats.meetings} ${stats.meetings === 1 ? "reunião" : "reuniões"}`,
              stats.whatsapp &&
                `${stats.whatsapp} ${stats.whatsapp === 1 ? "dia" : "dias"} de WhatsApp`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </div>
        {stats.up && (
          <button type="button" onClick={() => jump(stats.up!)} title="Ir até o dia">
            <span>Maior alta</span>
            <strong className="thermo-tl-num up">{pts(stats.up.delta)}</strong>
            <small>{dateBr(stats.up.day)}</small>
          </button>
        )}
        {stats.down && (
          <button type="button" onClick={() => jump(stats.down!)} title="Ir até o dia">
            <span>Maior queda</span>
            <strong className="thermo-tl-num down">{pts(stats.down.delta)}</strong>
            <small>{dateBr(stats.down.day)}</small>
          </button>
        )}
      </div>

      <Pulse
        items={items}
        today={today}
        bands={bands}
        hover={hover}
        setHover={setHover}
        onPick={jump}
      />

      <div className="thermo-tl-tools">
        <div className="drive-view" role="tablist" aria-label="O que mostrar">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={filter === t.id}
              className={filter === t.id ? "selected" : ""}
              onClick={() => changeFilter(t.id)}
              title={
                t.id === "turns"
                  ? "Mudanças de faixa, sinais de alerta e quando a nota apareceu ou sumiu"
                  : undefined
              }
            >
              {t.label} <small>{counts[t.id]}</small>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="thermo-tl-order"
          onClick={() => setNewestFirst((v) => !v)}
          title="Inverter a ordem"
        >
          <ArrowDownUp size={13} aria-hidden="true" />
          {newestFirst ? "Mais recentes primeiro" : "Do começo até hoje"}
        </button>
      </div>

      {shownMonths.length === 0 ? (
        <p className="thermo-source-note">Nenhum dia neste filtro.</p>
      ) : (
        <ol className="thermo-tl-list">
          {filter === "all" && (newestFirst ? nowRow : startRow)}
          {shownMonths.map((m) => {
            const open = isOpen(m.key);
            const endBand = bandOf(bands, m.end?.band ?? null);
            return (
              <li key={m.key} className="thermo-tl-month">
                <button
                  type="button"
                  className="thermo-tl-month-head"
                  aria-expanded={open}
                  onClick={() => toggleMonth(m.key)}
                >
                  {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <strong>{monthLabel(m.key)}</strong>
                  <span className={`thermo-tl-delta ${toneOf(m.net)}`} title="Saldo do mês">
                    {pts(m.net) === "sem efeito" ? "estável" : pts(m.net)}
                  </span>
                  <small>
                    {[
                      m.end &&
                        `terminou em ${scoreLabel(m.end.score)}${endBand ? ` · ${endBand.name}` : ""}`,
                      `${m.contacts} ${m.contacts === 1 ? "contato" : "contatos"}`,
                      filter !== "all" && `${m.list.length} ${m.list.length === 1 ? "dia" : "dias"} no filtro`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  {!open && <MonthStrip list={m.all} bands={bands} />}
                </button>
                {open && (
                  <ol>
                    {m.list.map((i) => (
                      <EventRow
                        key={i.day}
                        id={anchor(i.day)}
                        item={i}
                        bands={bands}
                        names={names}
                        reasonLabel={reasonLabel}
                        windowDays={timeline.window_days}
                        flagDays={data.settings.flag_days}
                        highlight={
                          i === stats.up ? "Maior alta" : i === stats.down ? "Maior queda" : null
                        }
                        flash={flash === i.day}
                        expanded={expanded.has(i.day)}
                        onExpand={() =>
                          setExpanded((s) => {
                            const next = new Set(s);
                            if (next.has(i.day)) next.delete(i.day);
                            else next.add(i.day);
                            return next;
                          })
                        }
                      />
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
          {filter === "all" && (newestFirst ? startRow : nowRow)}
        </ol>
      )}
    </section>
  );
}

/**
 * O pulso do período todo: uma barra por dia que mexeu (verde para cima,
 * vermelha para baixo, do tamanho dos pontos), a faixa da escala embaixo e um
 * risco âmbar quando apareceu sinal de alerta. Clicar leva até o dia.
 */
function Pulse({
  items,
  today,
  bands,
  hover,
  setHover,
  onPick,
}: {
  items: Item[];
  today: string;
  bands: TemperatureBand[];
  hover: number | null;
  setHover: (i: number | null) => void;
  onPick: (i: Item) => void;
}) {
  const W = 1000;
  const H = 72;
  const MID = 32;
  const start = dayNum(items[0].day);
  const span = Math.max(1, dayNum(today) - start);
  const x = (day: string) => ((dayNum(day) - start) / span) * W;
  const scale = Math.max(5, ...items.map((i) => Math.abs(i.delta ?? 0)));
  const shown = hover !== null ? items[hover] : null;
  const nearest = (clientX: number, rect: DOMRect) => {
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    items.forEach((i, n) => {
      if (Math.abs(x(i.day) - px) < Math.abs(x(items[best].day) - px)) best = n;
    });
    return best;
  };
  return (
    <div className="thermo-tl-pulse">
      <div className="thermo-history-hover" aria-live="polite">
        {shown ? (
          <>
            <strong className={`thermo-tl-num ${shown.tone}`}>
              {shown.delta !== null ? pts(shown.delta) : kindLabel(shown)}
            </strong>
            {shown.score !== null && <span>nota {scoreLabel(shown.score)}</span>}
            <small>
              {dateBr(shown.day)} ·{" "}
              {shown.signals.length
                ? `${shown.signals.length} ${shown.signals.length === 1 ? "contato" : "contatos"}`
                : "leitura antiga saiu da conta"}
            </small>
          </>
        ) : (
          <small>Cada barra é um dia que mexeu na temperatura. Clique para ir até ele.</small>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Dias que mexeram na temperatura de ${dateBr(items[0].day)} a ${dateBr(today)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
        onClick={(e) => onPick(items[nearest(e.clientX, e.currentTarget.getBoundingClientRect())])}
      >
        {items.map((i, n) => {
          const from = x(i.day);
          const to = n + 1 < items.length ? x(items[n + 1].day) : W;
          const b = bandOf(bands, i.band);
          return (
            <rect
              key={`b${i.day}`}
              x={from}
              y={H - 8}
              width={Math.max(0.5, to - from)}
              height="8"
              fill={b?.color ?? "#d5dcdc"}
              opacity={b ? 0.75 : 0.5}
            />
          );
        })}
        <line x1="0" x2={W} y1={MID} y2={MID} stroke="#d5dcdc" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {items.map((i, n) => {
          const cx = x(i.day);
          const h = i.delta === null ? 0 : Math.max(3, (Math.abs(i.delta) / scale) * 26);
          const color = i.tone === "up" ? "#3f9a4a" : i.tone === "down" ? "#d0504a" : "#a3acab";
          return (
            <g key={i.day} opacity={hover === null || hover === n ? 1 : 0.45}>
              {i.flags_added.length > 0 && (
                <line x1={cx} x2={cx} y1="0" y2="5" stroke="#d99a1e" strokeWidth="3" vectorEffect="non-scaling-stroke" />
              )}
              {i.tone === "flat" ? (
                <line x1={cx} x2={cx} y1={MID - 2} y2={MID + 2} stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" />
              ) : (
                <line
                  x1={cx}
                  x2={cx}
                  y1={MID}
                  y2={i.tone === "up" ? MID - h : MID + h}
                  stroke={color}
                  strokeWidth={hover === n ? 5 : 3}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="thermo-history-axis" aria-hidden="true">
        <span>{dateBr(items[0].day)}</span>
        <span>{dateBr(today)}</span>
      </div>
    </div>
  );
}

/** Num mês fechado: as faixas por onde a nota passou, num risco fino. */
function MonthStrip({ list, bands }: { list: Item[]; bands: TemperatureBand[] }) {
  const ups = list.filter((i) => i.tone === "up").length;
  const downs = list.filter((i) => i.tone === "down").length;
  return (
    <span className="thermo-tl-month-mini" aria-label={`${ups} subidas e ${downs} quedas`}>
      {list.map((i) => (
        <i
          key={i.day}
          className={i.tone}
          style={{ "--band": bandOf(bands, i.band)?.color ?? "#d5dcdc" } as CSSProperties}
        />
      ))}
    </span>
  );
}

function kindLabel(i: Item) {
  if (i.kind === "first") return i.score !== null ? "Primeira nota" : "Primeiro contato";
  if (i.kind === "gained") return "Primeira nota";
  if (i.kind === "back") return "Voltou a ter nota";
  if (i.kind === "lost") return "Ficou sem nota";
  return "";
}

/** Os indicadores que mais andaram no dia (ou que entraram/saíram da conta). */
function indicatorMoves(i: Item, names: Map<string, { name: string; kind: string }>) {
  if (!i.prev_indicators) return [];
  const keys = new Set([...Object.keys(i.indicators ?? {}), ...Object.keys(i.prev_indicators)]);
  const out: { key: string; name: string; d: number | null; text: string }[] = [];
  for (const k of keys) {
    const ind = names.get(k);
    if (ind && ind.kind !== "score") continue;
    const a = i.prev_indicators[k] ?? null;
    const b = i.indicators?.[k] ?? null;
    const name = ind?.name ?? k;
    if (a !== null && b !== null) {
      const d = Number(b) - Number(a);
      if (Math.abs(d) >= 1) out.push({ key: k, name, d, text: pts(d) });
    } else if (a !== null) out.push({ key: k, name, d: null, text: "sem leituras recentes" });
    else if (b !== null) out.push({ key: k, name, d: null, text: `entrou com ${scoreLabel(b)}` });
  }
  return out.sort((x, y) => Math.abs(y.d ?? 0.5) - Math.abs(x.d ?? 0.5));
}

function EventRow({
  id,
  item: i,
  bands,
  names,
  reasonLabel,
  windowDays,
  flagDays,
  highlight,
  flash,
  expanded,
  onExpand,
}: {
  id: string;
  item: Item;
  bands: TemperatureBand[];
  names: Map<string, { name: string; kind: string; alert: boolean }>;
  reasonLabel: Map<string, string>;
  windowDays: number;
  flagDays: number;
  highlight: string | null;
  flash: boolean;
  expanded: boolean;
  onExpand: () => void;
}) {
  const band = bandOf(bands, i.band);
  const prevBand = bandOf(bands, i.prev_band);
  const moves = indicatorMoves(i, names);
  const shownMoves = expanded ? moves : moves.slice(0, 3);
  const big = i.delta !== null && Math.abs(i.delta) >= 5;
  const hasExcerpts = i.signals.some((s) => s.excerpt);
  // Por que a nota mudou num dia sem contato nem leitura saindo da janela.
  const quiet = i.signals.length === 0 && i.expired.length === 0;
  const quietCause = !quiet
    ? null
    : i.kind === "lost"
      ? "As leituras ficaram antigas demais para sustentar uma nota."
      : moves.some((m) => m.d === null)
        ? "Um indicador ficou sem leituras recentes e saiu da conta."
        : i.flags_removed.length > 0 && i.tone === "flat"
          ? `O sinal de alerta passou de ${flagDays} dias sem se repetir e deixou de valer.`
          : i.tone !== "flat"
            ? "As leituras antigas perderam força e a nota se ajustou."
            : null;
  return (
    <li
      id={id}
      className={`thermo-tl-event ${i.tone}${big ? " big" : ""}${flash ? " flash" : ""}`}
      style={{ "--band": band?.color ?? "#a3acab" } as CSSProperties}
    >
      <span className="thermo-tl-dot" aria-hidden="true" />
      <div className="thermo-tl-main">
        <div className="thermo-tl-line">
          <time dateTime={i.day}>{dayLabel(i.day)}</time>
          {i.delta !== null ? (
            <span
              className={`thermo-tl-delta ${i.tone}`}
              title={
                i.signals.length > 1
                  ? "O quanto a temperatura andou no dia, com todos os contatos do dia"
                  : "O quanto a temperatura andou no dia"
              }
            >
              {pts(i.delta)}
            </span>
          ) : (
            kindLabel(i) && <span className="thermo-tl-delta milestone">{kindLabel(i)}</span>
          )}
          {i.score !== null && (
            <span className="thermo-tl-score" title="A nota no fim do dia">
              {i.prev !== null && i.delta !== null && <>{scoreLabel(i.prev)} → </>}
              <strong>{scoreLabel(i.score)}</strong>
            </span>
          )}
          {highlight && <span className={`thermo-tl-highlight ${i.tone}`}>{highlight}</span>}
        </div>

        {(i.turn || i.flags_added.length > 0 || i.flags_removed.length > 0) && (
          <div className="thermo-chips">
            {i.turn && prevBand && band && (
              <span className={`thermo-tl-turn ${i.tone}`}>
                <Flag size={11} aria-hidden="true" />
                {i.tone === "down" ? "Esfriou" : "Esquentou"}: {prevBand.name} → {band.name}
              </span>
            )}
            {i.flags_added.map((k) => (
              <span key={k} className={`thermo-chip flag${names.get(k)?.alert ? " alert" : ""}`}>
                <AlertTriangle size={11} aria-hidden="true" /> {names.get(k)?.name ?? k}
              </span>
            ))}
            {i.flags_removed.map((k) => (
              <span key={k} className="thermo-chip flag removed" title="O sinal deixou de valer neste dia">
                <AlertTriangle size={11} aria-hidden="true" /> {names.get(k)?.name ?? k}
              </span>
            ))}
          </div>
        )}

        {i.signals.length > 0 && (
          <ul className="thermo-tl-touch">
            {i.signals.map((s) => (
              <Touch key={s.id} s={s} reasonLabel={reasonLabel} expanded={expanded} />
            ))}
          </ul>
        )}

        {i.expired.length > 0 && (
          <p className="thermo-tl-note">
            <Clock size={12} aria-hidden="true" />
            {i.expired.length === 1
              ? `Saiu da conta (passou de ${windowDays} dias): ${touchName(i.expired[0])} de ${dateBr(i.expired[0].day)}.`
              : `Saíram da conta ${i.expired.length} leituras de ${dateBr(i.expired[0].day)} (passaram de ${windowDays} dias).`}
          </p>
        )}
        {quietCause && (
          <p className="thermo-tl-note">
            <Clock size={12} aria-hidden="true" />
            {quietCause}
          </p>
        )}

        {shownMoves.length > 0 && (
          <div className="thermo-tl-moves">
            {shownMoves.map((m) => (
              <span key={m.key} className={toneOf(m.d)}>
                {m.name} <strong>{m.text}</strong>
              </span>
            ))}
          </div>
        )}
        {(moves.length > 3 || hasExcerpts) && (
          <button type="button" className="thermo-messages-toggle" onClick={onExpand}>
            {expanded ? "Ver menos" : hasExcerpts ? "Ver o que o cliente disse" : `Ver os ${moves.length} indicadores`}
          </button>
        )}
      </div>
    </li>
  );
}

const touchName = (s: TimelineSignal) =>
  s.type === "whatsapp" && s.group ? s.group : signalTitle(s);

function Touch({
  s,
  reasonLabel,
  expanded,
}: {
  s: TimelineSignal;
  reasonLabel: Map<string, string>;
  expanded: boolean;
}) {
  const path = signalPath(s);
  const whatsapp = s.type === "whatsapp";
  return (
    <li>
      <span className={`thermo-signal-icon ${s.type}`} aria-hidden="true">
        {whatsapp ? <MessageCircle size={13} /> : <Video size={13} />}
      </span>
      <div>
        <span className="thermo-tl-touch-head">
          <strong>{touchName(s)}</strong>
          {s.reason && reasonLabel.get(s.reason) && (
            <span className="thermo-chip reason">{reasonLabel.get(s.reason)}</span>
          )}
          {path && (
            <a
              className="thermo-open"
              href={appPath(path)}
              onClick={(e) => {
                e.preventDefault();
                openInApp(path);
              }}
            >
              Abrir <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </span>
        {expanded && s.excerpt && <p className="thermo-tl-excerpt">“{s.excerpt}”</p>}
      </div>
    </li>
  );
}

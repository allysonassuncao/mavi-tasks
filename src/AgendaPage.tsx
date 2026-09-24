import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  HelpCircle,
  LogOut,
  MapPin,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";
import {
  Button,
  Checkbox,
  Input,
  Loading,
  Select,
  SelectOption,
  Textarea,
} from "./ui";
import { Empty, Modal } from "./components";
import type { Snapshot } from "./types";
import { fold } from "./domain";
import {
  AgendaError,
  addDays,
  browserTimeZone,
  dayKey,
  demoAgenda,
  eventRange,
  fromDayKey,
  fromRecurrence,
  gmtLabel,
  googleAgenda,
  googleEventColors,
  inputDateTime,
  layoutDay,
  localIso,
  onDay,
  repeatLabel,
  sameDay,
  startOfDay,
  startOfWeek,
  stepCursor,
  timeLabel,
  toRecurrence,
  viewRange,
  viewTitle,
  type AgendaApi,
  type AgendaCalendar,
  type AgendaEvent,
  type Connection,
  type Repeat,
  type RepeatPreset,
  type View,
} from "./calendar";

type Notify = (message: string) => void;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const HOUR = 48;
const HIDDEN_KEY = "mavi:agenda-hidden";
const VIEW_KEY = "mavi:agenda-view";
const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A remembered view is a convenience; ignore blocked storage.
  }
};
/** Google descriptions may carry HTML: shown as plain text. */
export function plainText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const resultMessages: Record<string, string> = {
  conectado: "Google Agenda conectado.",
  cancelado: "A conexão com o Google foi cancelada.",
  "sem-permissao":
    "O Google não liberou o acesso à agenda. Marque a permissão da agenda ao conectar.",
  expirado: "A conexão demorou demais. Tente conectar de novo.",
  erro: "Não foi possível conectar ao Google. Tente de novo.",
};

/**
 * Agenda: the signed-in person's Google Calendar, live. Each person
 * connects their own account; nobody sees anyone else's calendar here.
 */
export function AgendaPage({
  data,
  demo,
  email,
  notify,
}: {
  data: Snapshot;
  demo: boolean;
  email: string;
  notify: Notify;
}) {
  const api = useMemo<AgendaApi>(
    () => (demo ? demoAgenda(email) : googleAgenda),
    [demo, email],
  );
  const [connection, setConnection] = useState<Connection | "loading">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [connecting, setConnecting] = useState(false);
  const disconnected = useCallback((reason?: string) => {
    setConnection(null);
    if (reason) setMessage(reason);
  }, []);

  useEffect(() => {
    // Back from Google's consent screen: say how it went, clean the URL.
    const url = new URL(window.location.href);
    const result = url.searchParams.get("google");
    if (result) {
      if (result === "conectado") notify(resultMessages.conectado);
      else setMessage(resultMessages[result] ?? resultMessages.erro);
      url.searchParams.delete("google");
      window.history.replaceState(null, "", url.pathname + url.search);
    }
    api
      .connection()
      .then(setConnection)
      .catch((e) => {
        setConnection(null);
        setMessage((e as Error).message);
      });
  }, [api, notify]);

  async function connect() {
    setConnecting(true);
    setMessage("");
    try {
      window.location.assign(await api.connectUrl());
    } catch (e) {
      setMessage(
        e instanceof AgendaError && e.code === "not_configured"
          ? "A integração com o Google ainda não foi configurada no servidor. Peça ao administrador do sistema."
          : (e as Error).message,
      );
      setConnecting(false);
    }
  }

  if (connection === "loading") return <Loading compact />;
  if (!connection)
    return (
      <div className="panel agenda-connect">
        <span className="agenda-connect-icon" aria-hidden="true">
          <CalendarDays size={28} />
        </span>
        <h2>Conecte seu Google Agenda</h2>
        <p>
          Veja todos os seus eventos aqui e crie ou edite compromissos sem sair
          do workspace. Tudo fica sincronizado com o Google: o que muda aqui
          aparece lá, e vice-versa.
        </p>
        <ul>
          <li>Só você vê a sua agenda; cada pessoa conecta a própria conta.</li>
          <li>
            Você pode desconectar quando quiser, aqui ou na sua conta Google.
          </li>
        </ul>
        {message && (
          <p className="form-error" role="alert">
            {message}
          </p>
        )}
        <Button
          className="btn primary"
          onClick={() => void connect()}
          loading={connecting}
        >
          <CalendarDays size={16} /> Conectar Google Agenda
        </Button>
      </div>
    );
  return (
    <AgendaView
      api={api}
      data={data}
      demo={demo}
      account={connection.account_email}
      notify={notify}
      onDisconnected={disconnected}
    />
  );
}

type Dialog =
  | { mode: "view"; event: AgendaEvent }
  | { mode: "edit"; event?: AgendaEvent; start?: Date; allDay?: boolean };
const ASIDE_KEY = "mavi:agenda-aside";
const SECTIONS_KEY = "mavi:agenda-sections";
const viewLabels: Record<View, string> = {
  day: "Dia",
  week: "Semana",
  month: "Mês",
  list: "Lista",
};

/**
 * How an event looks, as in Google: solid when ahead, lighter once past,
 * only outlined while the invitation has no answer, struck through when
 * declined.
 */
type Look = "solid" | "past" | "pending" | "declined";
function lookOf(e: AgendaEvent, now: Date): Look {
  const self = e.attendees.find((a) => a.self)?.response;
  if (self === "declined") return "declined";
  if (self === "needsAction") return "pending";
  return eventRange(e).end.getTime() <= now.getTime() ? "past" : "solid";
}

function AgendaView({
  api,
  data,
  demo,
  account,
  notify,
  onDisconnected,
}: {
  api: AgendaApi;
  data: Snapshot;
  demo: boolean;
  account: string;
  notify: Notify;
  onDisconnected: (reason?: string) => void;
}) {
  const [calendars, setCalendars] = useState<AgendaCalendar[] | null>(null);
  const [hidden, setHidden] = useState<string[]>(() =>
    read(HIDDEN_KEY, [] as string[]),
  );
  const [view, setView] = useState<View>(() =>
    read(VIEW_KEY, window.innerWidth < 720 ? "list" : "week"),
  );
  const [cursor, setCursor] = useState(() => new Date());
  const [events, setEvents] = useState<AgendaEvent[] | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tick, setTick] = useState(0);
  // The side panel: open by default on wide screens, a drawer on phones.
  const [aside, setAside] = useState(
    () =>
      window.innerWidth >= 900 && read(ASIDE_KEY, window.innerWidth >= 1200),
  );
  const cache = useRef(new Map<string, AgendaEvent[]>());
  const request = useRef(0);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof AgendaError && e.code === "not_connected")
        onDisconnected(e.message);
      else setError((e as Error).message);
    },
    [onDisconnected],
  );

  useEffect(() => {
    api.calendars().then(setCalendars).catch(handle);
  }, [api, handle]);

  const visible = useMemo(
    () =>
      (calendars ?? []).filter((c) =>
        hidden.length ? !hidden.includes(c.id) : c.selected,
      ),
    [calendars, hidden],
  );
  const range = useMemo(() => viewRange(view, cursor), [view, cursor]);
  const key = `${range.from.getTime()}|${range.to.getTime()}|${visible.map((c) => c.id).join(",")}`;

  useEffect(() => {
    if (!calendars) return;
    const n = ++request.current;
    const cached = cache.current.get(key);
    setEvents(cached ?? null);
    if (!visible.length) {
      setEvents([]);
      return;
    }
    setLoading(true);
    setError("");
    api
      .events(visible, range.from, range.to)
      .then((res) => {
        cache.current.set(key, res.events);
        if (n !== request.current) return;
        setEvents(res.events);
        setFailed(res.failed);
      })
      .catch((e) => n === request.current && handle(e))
      .finally(() => n === request.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, calendars]);

  const byId = useMemo(
    () => new Map((calendars ?? []).map((c) => [c.id, c])),
    [calendars],
  );
  const paint = useCallback(
    (e: AgendaEvent) => {
      const own = e.colorId && googleEventColors[e.colorId];
      const cal = byId.get(e.calendarId);
      return {
        color: own || cal?.color || "#039be5",
        text: own ? "#fff" : cal?.textColor || "#fff",
      };
    },
    [byId],
  );
  const reload = () => {
    cache.current.clear();
    setTick((v) => v + 1);
  };
  function changeView(v: View) {
    setView(v);
    write(VIEW_KEY, v);
  }
  function toggleAside() {
    setAside((open) => {
      // Only the desktop panel is remembered; the phone drawer starts closed.
      if (window.innerWidth >= 900) write(ASIDE_KEY, !open);
      return !open;
    });
  }
  function setShown(ids: string[]) {
    const hide = (calendars ?? [])
      .map((x) => x.id)
      .filter((id) => !ids.includes(id));
    // Keep at least one entry so the "hidden" list is used over defaults.
    const value = hide.length ? hide : ["__none__"];
    setHidden(value);
    write(HIDDEN_KEY, value);
  }
  async function disconnect() {
    if (
      !window.confirm(
        "Desconectar o Google Agenda? Seus eventos continuam no Google; só deixam de aparecer aqui.",
      )
    )
      return;
    try {
      await api.disconnect();
      notify("Google Agenda desconectado.");
      onDisconnected();
    } catch (e) {
      handle(e);
    }
  }
  const open = (event: AgendaEvent) => setDialog({ mode: "view", event });
  const create = (start: Date, allDay = false) =>
    setDialog({ mode: "edit", start, allDay });
  const writable = (calendars ?? []).filter((c) => c.writable);
  const phone = () => window.innerWidth < 900;

  if (!calendars)
    return error ? <p className="form-error">{error}</p> : <Loading compact />;
  return (
    <div className={`agenda ${aside ? "with-aside" : ""}`}>
      {aside && phone() && (
        <button
          type="button"
          className="agenda-backdrop"
          aria-label="Fechar painel"
          onClick={toggleAside}
        />
      )}
      <aside className="agenda-side" aria-label="Agendas" hidden={!aside}>
        <Button
          className="agenda-create"
          onClick={() => {
            if (phone()) toggleAside();
            create(defaultStart(cursor));
          }}
          disabled={!writable.length}
        >
          <Plus size={20} /> Criar
        </Button>
        <MiniMonth
          cursor={cursor}
          view={view}
          onPick={(d) => {
            setCursor(d);
            if (phone()) toggleAside();
          }}
        />
        <CalendarList
          calendars={calendars}
          shown={visible.map((c) => c.id)}
          onChange={setShown}
        />
        <div className="agenda-account">
          <small>Conectado como</small>
          <strong title={account}>{account || "Google"}</strong>
          <Button className="text-btn" onClick={() => void disconnect()}>
            <LogOut size={14} /> Desconectar
          </Button>
          {demo && (
            <small className="muted">
              Demonstração: nada é enviado ao Google.
            </small>
          )}
        </div>
      </aside>
      <section className="agenda-main">
        <div className="agenda-toolbar">
          <Button
            className="icon-btn"
            aria-label={aside ? "Esconder agendas" : "Mostrar agendas"}
            title={aside ? "Esconder agendas" : "Mostrar agendas"}
            aria-expanded={aside}
            onClick={toggleAside}
          >
            <Menu size={20} />
          </Button>
          <Button
            className="agenda-today"
            onClick={() => setCursor(new Date())}
          >
            Hoje
          </Button>
          <Button
            className="icon-btn"
            aria-label="Anterior"
            title="Anterior"
            onClick={() => setCursor((c) => stepCursor(view, c, -1))}
          >
            <ChevronLeft size={20} />
          </Button>
          <Button
            className="icon-btn"
            aria-label="Próximo"
            title="Próximo"
            onClick={() => setCursor((c) => stepCursor(view, c, 1))}
          >
            <ChevronRight size={20} />
          </Button>
          <h2>{viewTitle(view, cursor)}</h2>
          {loading && events && (
            <span className="dash-refreshing" aria-label="Atualizando" />
          )}
          <span className="agenda-toolbar-end">
            <Button
              className="icon-btn"
              aria-label="Atualizar"
              title="Atualizar"
              onClick={reload}
            >
              <RefreshCw size={16} />
            </Button>
            <Select
              aria-label="Visualização"
              className="agenda-view-select"
              value={view}
              onValueChange={(v) => changeView(v as View)}
            >
              {(Object.keys(viewLabels) as View[]).map((v) => (
                <SelectOption key={v} value={v}>
                  {viewLabels[v]}
                </SelectOption>
              ))}
            </Select>
            <Button
              className="icon-btn agenda-create-small"
              aria-label="Criar evento"
              title="Criar evento"
              onClick={() => create(defaultStart(cursor))}
              disabled={!writable.length}
            >
              <Plus size={20} />
            </Button>
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {failed.length > 0 && (
          <p className="muted agenda-warning">
            Não foi possível ler{" "}
            {failed.length === 1 ? "uma agenda" : `${failed.length} agendas`}:{" "}
            {failed.map((id) => byId.get(id)?.name ?? id).join(", ")}.
          </p>
        )}
        <div className="panel agenda-surface">
          {events === null ? (
            <Loading compact />
          ) : view === "month" ? (
            <MonthView
              cursor={cursor}
              events={events}
              paint={paint}
              onOpen={open}
              onCreate={(d) => create(atNine(d))}
              onDay={(d) => {
                setCursor(d);
                changeView("day");
              }}
            />
          ) : view === "list" ? (
            <ListView
              from={range.from}
              events={events}
              colorOf={(e) => paint(e).color}
              onOpen={open}
            />
          ) : (
            <TimeGrid
              days={view === "week" ? 7 : 1}
              from={range.from}
              events={events}
              paint={paint}
              onOpen={open}
              onCreate={create}
              onDay={(d) => {
                setCursor(d);
                changeView("day");
              }}
            />
          )}
        </div>
      </section>
      {dialog?.mode === "view" && (
        <EventDetails
          event={dialog.event}
          calendar={byId.get(dialog.event.calendarId)}
          color={paint(dialog.event).color}
          onClose={() => setDialog(null)}
          onEdit={() => setDialog({ mode: "edit", event: dialog.event })}
          onDelete={async (scope) => {
            const e = dialog.event;
            try {
              await api.remove({
                calendarId: e.calendarId,
                eventId: e.id,
                recurringEventId: e.recurringEventId,
                scope,
                instanceStart: e.start,
              });
              notify(
                demo
                  ? "Evento excluído (demonstração)."
                  : "Evento excluído do Google Agenda.",
              );
              setDialog(null);
              reload();
            } catch (err) {
              handle(err);
            }
          }}
        />
      )}
      {dialog?.mode === "edit" && (
        <EventForm
          api={api}
          data={data}
          account={account}
          calendars={writable}
          event={dialog.event}
          start={dialog.start}
          allDay={dialog.allDay}
          onClose={() => setDialog(null)}
          onSaved={() => {
            notify(
              demo
                ? "Evento salvo (demonstração)."
                : "Evento salvo no Google Agenda.",
            );
            setDialog(null);
            reload();
          }}
          onError={handle}
        />
      )}
    </div>
  );
}

/** The next round hour on the cursor's day. */
function defaultStart(cursor: Date) {
  const now = new Date();
  const today = sameDay(cursor, now);
  return new Date(
    cursor.getFullYear(),
    cursor.getMonth(),
    cursor.getDate(),
    today ? now.getHours() + 1 : 9,
    0,
  );
}
const atNine = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0);

// ------------------------------------------------------------ side panel
/** A month to jump around (like Google's), marking today and what is shown. */
function MiniMonth({
  cursor,
  view,
  onPick,
}: {
  cursor: Date;
  view: View;
  onPick: (d: Date) => void;
}) {
  const [month, setMonth] = useState(
    () => new Date(cursor.getFullYear(), cursor.getMonth(), 1),
  );
  useEffect(() => {
    setMonth(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  }, [cursor]);
  const from = startOfWeek(month);
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const shown = viewRange(view === "list" ? "day" : view, cursor);
  const today = new Date();
  return (
    <div className="agenda-mini">
      <div className="agenda-mini-head">
        <strong>
          {capital(
            month.toLocaleDateString("pt-BR", {
              month: "long",
              year: "numeric",
            }),
          )}
        </strong>
        <Button
          className="icon-btn"
          aria-label="Mês anterior"
          onClick={() =>
            setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))
          }
        >
          <ChevronLeft size={16} />
        </Button>
        <Button
          className="icon-btn"
          aria-label="Próximo mês"
          onClick={() =>
            setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))
          }
        >
          <ChevronRight size={16} />
        </Button>
      </div>
      <div className="agenda-mini-grid" role="grid">
        {["D", "S", "T", "Q", "Q", "S", "S"].map((d, i) => (
          <span key={i} className="agenda-mini-weekday">
            {d}
          </span>
        ))}
        {days.map((d) => {
          const inShown = view !== "month" && d >= shown.from && d < shown.to;
          return (
            <button
              key={dayKey(d)}
              type="button"
              className={[
                d.getMonth() !== month.getMonth() ? "outside" : "",
                sameDay(d, today) ? "today" : "",
                sameDay(d, cursor) ? "selected" : "",
                inShown ? "shown" : "",
              ].join(" ")}
              onClick={() => onPick(d)}
              aria-label={d.toLocaleDateString("pt-BR", { dateStyle: "full" })}
              aria-current={sameDay(d, today) ? "date" : undefined}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The calendars, grouped as in Google ("Minhas agendas", "Outras agendas"),
 * each group collapsible and scrolling on its own; with many calendars a
 * search narrows the list.
 */
function CalendarList({
  calendars,
  shown,
  onChange,
}: {
  calendars: AgendaCalendar[];
  shown: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>(() =>
    read(SECTIONS_KEY, {}),
  );
  const q = fold(query.trim());
  const sorted = [...calendars].sort(
    (a, b) =>
      Number(b.primary) - Number(a.primary) ||
      a.name.localeCompare(b.name, "pt-BR"),
  );
  const groups = [
    {
      key: "mine",
      label: "Minhas agendas",
      items: sorted.filter((c) => c.owner),
    },
    {
      key: "other",
      label: "Outras agendas",
      items: sorted.filter((c) => !c.owner),
    },
  ].filter((g) => g.items.length);
  const toggle = (id: string) =>
    onChange(
      shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id],
    );
  return (
    <div className="agenda-lists">
      {calendars.length > 8 && (
        <label className="agenda-list-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="Buscar agenda"
            placeholder="Buscar agenda"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => setQuery("")}
            >
              <X size={13} />
            </button>
          )}
        </label>
      )}
      {groups.map((g) => {
        const items = g.items.filter((c) => fold(c.name).includes(q));
        const isClosed = closed[g.key] && !q;
        const count = g.items.filter((c) => shown.includes(c.id)).length;
        return (
          <section key={g.key} className="agenda-list-group">
            <button
              type="button"
              className="agenda-list-toggle"
              aria-expanded={!isClosed}
              onClick={() => {
                const next = { ...closed, [g.key]: !closed[g.key] };
                setClosed(next);
                write(SECTIONS_KEY, next);
              }}
            >
              <span>{g.label}</span>
              <small>
                {count}/{g.items.length}
              </small>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            {!isClosed && (
              <ul>
                {items.map((c) => (
                  <li key={c.id}>
                    <label className="agenda-calendar" title={c.name}>
                      <input
                        type="checkbox"
                        checked={shown.includes(c.id)}
                        onChange={() => toggle(c.id)}
                        style={{ ["--cal-color" as string]: c.color }}
                      />
                      <span>{c.name}</span>
                    </label>
                  </li>
                ))}
                {!items.length && (
                  <li className="agenda-list-empty">
                    Nenhuma agenda encontrada.
                  </li>
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ events
type Paint = (e: AgendaEvent) => { color: string; text: string };

function EventChip({
  event,
  paint,
  onOpen,
  now,
}: {
  event: AgendaEvent;
  paint: Paint;
  onOpen: (e: AgendaEvent) => void;
  now: Date;
}) {
  const { start } = eventRange(event);
  const { color, text } = paint(event);
  const look = lookOf(event, now);
  return (
    <button
      type="button"
      className={`agenda-chip ${event.allDay ? "all-day" : "timed"} ${look}`}
      style={{
        ["--event-color" as string]: color,
        ["--event-text" as string]: text,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(event);
      }}
      title={event.title}
    >
      {!event.allDay && <time>{timeLabel(start)}</time>}
      <span>{event.title}</span>
    </button>
  );
}

// ------------------------------------------------------------ month
function MonthView({
  cursor,
  events,
  paint,
  onOpen,
  onCreate,
  onDay: openDay,
}: {
  cursor: Date;
  events: AgendaEvent[];
  paint: Paint;
  onOpen: (e: AgendaEvent) => void;
  onCreate: (d: Date) => void;
  onDay: (d: Date) => void;
}) {
  const { from } = viewRange("month", cursor);
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const now = new Date();
  const byDay = useMemo(() => {
    const map = new Map<string, AgendaEvent[]>();
    for (const d of days)
      map.set(
        dayKey(d),
        events
          .filter((e) => onDay(e, d))
          .sort(
            (a, b) =>
              Number(b.allDay) - Number(a.allDay) ||
              eventRange(a).start.getTime() - eventRange(b).start.getTime(),
          ),
      );
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, from.getTime()]);
  return (
    <div className="agenda-month">
      {days.map((d, i) => {
        const list = byDay.get(dayKey(d)) ?? [];
        return (
          <div
            key={dayKey(d)}
            className={`agenda-cell ${d.getMonth() !== cursor.getMonth() ? "outside" : ""} ${sameDay(d, now) ? "today" : ""}`}
            onClick={() => onCreate(d)}
          >
            {i < 7 && (
              <span className="agenda-weekday">
                {d
                  .toLocaleDateString("pt-BR", { weekday: "short" })
                  .replace(".", "")
                  .toUpperCase()}
                .
              </span>
            )}
            <button
              type="button"
              className="agenda-cell-day"
              onClick={(e) => {
                e.stopPropagation();
                openDay(d);
              }}
              aria-label={d.toLocaleDateString("pt-BR", { dateStyle: "full" })}
            >
              {d.getDate() === 1
                ? `${d.getDate()} de ${d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "")}`
                : d.getDate()}
            </button>
            {list.slice(0, 3).map((e) => (
              <EventChip
                key={`${e.calendarId}:${e.id}`}
                event={e}
                paint={paint}
                onOpen={onOpen}
                now={now}
              />
            ))}
            {list.length > 3 && (
              <button
                type="button"
                className="agenda-more"
                onClick={(e) => {
                  e.stopPropagation();
                  openDay(d);
                }}
              >
                Mais {list.length - 3}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ week / day
function TimeGrid({
  days: count,
  from,
  events,
  paint,
  onOpen,
  onCreate,
  onDay: openDay,
}: {
  days: number;
  from: Date;
  events: AgendaEvent[];
  paint: Paint;
  onOpen: (e: AgendaEvent) => void;
  onCreate: (start: Date, allDay?: boolean) => void;
  onDay: (d: Date) => void;
}) {
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);
  // Like Google: open around the current time when today is shown, else 7:00.
  useLayoutEffect(() => {
    if (!scroller.current) return;
    const today = days.some((d) => sameDay(d, new Date()));
    const hour = today ? Math.max(0, new Date().getHours() - 2) : 7;
    scroller.current.scrollTop = hour * HOUR;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.getTime(), count]);
  const allDay = days.map((d) => events.filter((e) => e.allDay && onDay(e, d)));
  return (
    <div
      className="agenda-grid"
      style={{ ["--days" as string]: count, ["--hour" as string]: `${HOUR}px` }}
    >
      <div className="agenda-grid-scroll" ref={scroller}>
        <div className="agenda-grid-sticky">
          <div className="agenda-grid-head">
            <span className="agenda-tz">{gmtLabel()}</span>
            {days.map((d) => (
              <div
                key={dayKey(d)}
                className={`agenda-grid-day ${sameDay(d, now) ? "today" : ""}`}
              >
                <small>
                  {d
                    .toLocaleDateString("pt-BR", { weekday: "short" })
                    .replace(".", "")
                    .toUpperCase()}
                  .
                </small>
                <button
                  type="button"
                  onClick={() => openDay(d)}
                  aria-label={d.toLocaleDateString("pt-BR", {
                    dateStyle: "full",
                  })}
                  disabled={count === 1}
                >
                  {d.getDate()}
                </button>
              </div>
            ))}
          </div>
          <div className="agenda-allday">
            <span />
            {allDay.map((list, i) => (
              <div key={i} onClick={() => onCreate(days[i], true)}>
                {list.map((e) => (
                  <EventChip
                    key={`${e.calendarId}:${e.id}`}
                    event={e}
                    paint={paint}
                    onOpen={onOpen}
                    now={now}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="agenda-grid-body">
          <div className="agenda-hours" aria-hidden="true">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} style={{ top: h * HOUR }}>
                {h ? `${String(h).padStart(2, "0")}:00` : ""}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <div
              key={dayKey(d)}
              className="agenda-column"
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                const minutes =
                  Math.floor(((e.clientY - box.top) / HOUR) * 2) * 30;
                onCreate(
                  new Date(
                    d.getFullYear(),
                    d.getMonth(),
                    d.getDate(),
                    0,
                    minutes,
                  ),
                );
              }}
            >
              {layoutDay(events, d).map(({ event, top, height, col, cols }) => {
                const { start, end } = eventRange(event);
                const { color, text } = paint(event);
                const short = height < 45;
                return (
                  <button
                    key={`${event.calendarId}:${event.id}`}
                    type="button"
                    className={`agenda-block ${lookOf(event, now)} ${short ? "short" : ""}`}
                    style={{
                      top: (top / 60) * HOUR,
                      height: Math.max(18, (height / 60) * HOUR - 2),
                      left: `calc(${(col / cols) * 100}% + 1px)`,
                      width: `calc(${100 / cols}% - ${cols > 1 ? 3 : 10}px)`,
                      ["--event-color" as string]: color,
                      ["--event-text" as string]: text,
                    }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onOpen(event);
                    }}
                    title={`${event.title} · ${timeLabel(start)} – ${timeLabel(end)}`}
                  >
                    {short ? (
                      <span className="agenda-block-line">
                        <strong>{event.title}</strong>, {timeLabel(start)}
                      </span>
                    ) : (
                      <>
                        <strong>{event.title}</strong>
                        <small>
                          {timeLabel(start)} – {timeLabel(end)}
                        </small>
                        {event.location && height >= 75 && (
                          <small>{event.location}</small>
                        )}
                      </>
                    )}
                  </button>
                );
              })}
              {sameDay(d, now) && (
                <span
                  className="agenda-now"
                  style={{
                    top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR,
                  }}
                  aria-hidden="true"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ list
function ListView({
  from,
  events,
  colorOf,
  onOpen,
}: {
  from: Date;
  events: AgendaEvent[];
  colorOf: (e: AgendaEvent) => string;
  onOpen: (e: AgendaEvent) => void;
}) {
  const days = Array.from({ length: 30 }, (_, i) => addDays(from, i))
    .map((d) => ({
      d,
      list: events
        .filter((e) => onDay(e, d))
        .sort(
          (a, b) =>
            Number(b.allDay) - Number(a.allDay) ||
            eventRange(a).start.getTime() - eventRange(b).start.getTime(),
        ),
    }))
    .filter((x) => x.list.length);
  if (!days.length)
    return (
      <Empty
        title="Nenhum evento"
        body="Não há eventos nas suas agendas visíveis nos próximos 30 dias."
      />
    );
  const today = new Date();
  return (
    <div className="agenda-list">
      {days.map(({ d, list }) => (
        <section key={dayKey(d)}>
          <h3 className={sameDay(d, today) ? "today" : ""}>
            <strong>{d.getDate()}</strong>
            <span>
              {d.toLocaleDateString("pt-BR", { weekday: "long" })} ·{" "}
              {d
                .toLocaleDateString("pt-BR", { month: "short" })
                .replace(".", "")}
            </span>
          </h3>
          <ul>
            {list.map((e) => {
              const { start, end } = eventRange(e);
              return (
                <li key={`${e.calendarId}:${e.id}`}>
                  <button type="button" onClick={() => onOpen(e)}>
                    <i style={{ background: colorOf(e) }} aria-hidden="true" />
                    <time>
                      {e.allDay
                        ? "Dia todo"
                        : `${timeLabel(start)} – ${timeLabel(end)}`}
                    </time>
                    <span>
                      <strong>{e.title}</strong>
                      {e.location && <small>{e.location}</small>}
                    </span>
                    {e.meetUrl && (
                      <Video size={15} aria-label="Com Google Meet" />
                    )}
                    {e.recurringEventId && (
                      <Repeat2 size={14} aria-label="Evento recorrente" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ details
function whenText(e: AgendaEvent) {
  return capital(whenTextLower(e));
}
function whenTextLower(e: AgendaEvent) {
  const { start, end } = eventRange(e);
  const date = (d: Date) =>
    d.toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  if (e.allDay) {
    const last = addDays(end, -1);
    return sameDay(start, last) || last < start
      ? `${date(start)} · dia todo`
      : `${date(start)} – ${date(last)}`;
  }
  return sameDay(start, end)
    ? `${date(start)} · ${timeLabel(start)} – ${timeLabel(end)}`
    : `${date(start)}, ${timeLabel(start)} – ${date(end)}, ${timeLabel(end)}`;
}
const responses: Record<string, [string, typeof Check]> = {
  accepted: ["Confirmou", Check],
  declined: ["Recusou", X],
  tentative: ["Talvez", HelpCircle],
  needsAction: ["Sem resposta", Clock],
};

function ScopeChoice({
  verb,
  onPick,
  onCancel,
}: {
  verb: string;
  onPick: (scope: "this" | "following") => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={`${verb} evento recorrente`} onClose={onCancel}>
      <div className="entity-form agenda-scope">
        <p>Este evento se repete. O que deseja {verb.toLowerCase()}?</p>
        <Button className="btn secondary" onClick={() => onPick("this")}>
          Só este evento
        </Button>
        <Button className="btn secondary" onClick={() => onPick("following")}>
          Este e os próximos
        </Button>
        <Button className="text-btn" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </Modal>
  );
}

function EventDetails({
  event,
  calendar,
  color,
  onClose,
  onEdit,
  onDelete,
}: {
  event: AgendaEvent;
  calendar?: AgendaCalendar;
  color: string;
  onClose: () => void;
  onEdit: () => void;
  onDelete: (scope?: "this" | "following") => Promise<void>;
}) {
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const description = plainText(event.description);
  async function remove(scope?: "this" | "following") {
    setChoosing(false);
    setBusy(true);
    await onDelete(scope);
    setBusy(false);
  }
  return (
    <Modal title={event.title} onClose={onClose} busy={busy}>
      <div className="agenda-details">
        <p className="agenda-details-when">
          <i style={{ background: color }} aria-hidden="true" />
          <span>
            {whenText(event)}
            {event.recurringEventId && (
              <small>
                <Repeat2 size={13} aria-hidden="true" /> Evento recorrente
              </small>
            )}
          </span>
        </p>
        {calendar && (
          <p>
            <CalendarDays size={15} aria-hidden="true" /> {calendar.name}
          </p>
        )}
        {event.meetUrl && (
          <a
            className="btn primary agenda-meet"
            href={event.meetUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Video size={16} /> Entrar com Google Meet
          </a>
        )}
        {event.location && (
          <p>
            <MapPin size={15} aria-hidden="true" /> {event.location}
          </p>
        )}
        {event.attendees.length > 0 && (
          <div className="agenda-attendees">
            <span>
              <Users size={15} aria-hidden="true" /> {event.attendees.length}{" "}
              {event.attendees.length === 1 ? "convidado" : "convidados"}
            </span>
            <ul>
              {event.attendees.map((a) => {
                const [label, Icon] =
                  responses[a.response ?? "needsAction"] ??
                  responses.needsAction;
                return (
                  <li key={a.email} className={a.response ?? "needsAction"}>
                    <Icon size={13} aria-label={label} />
                    <span>
                      {a.name || a.email}
                      {a.organizer && <small> · organizador</small>}
                      {a.self && <small> · você</small>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {description && <p className="agenda-description">{description}</p>}
        <div className="agenda-details-actions">
          {event.htmlLink && (
            <a
              className="text-btn"
              href={event.htmlLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={14} /> Abrir no Google Agenda
            </a>
          )}
          {event.canEdit && (
            <>
              <Button
                className="btn secondary danger"
                disabled={busy}
                onClick={() => {
                  if (event.recurringEventId) setChoosing(true);
                  else if (
                    window.confirm(
                      `Excluir "${event.title}"? Os convidados são avisados pelo Google.`,
                    )
                  )
                    void remove();
                }}
              >
                <Trash2 size={15} /> Excluir
              </Button>
              <Button className="btn primary" onClick={onEdit} disabled={busy}>
                <Pencil size={15} /> Editar
              </Button>
            </>
          )}
          {!event.canEdit && (
            <small className="muted">
              {event.organizerSelf
                ? "Agenda somente leitura."
                : "Só quem organizou pode editar este evento."}
            </small>
          )}
        </div>
      </div>
      {choosing && (
        <ScopeChoice
          verb="Excluir"
          onPick={(s) => void remove(s)}
          onCancel={() => setChoosing(false)}
        />
      )}
    </Modal>
  );
}

// ------------------------------------------------------------ editor
function EventForm({
  api,
  data,
  account,
  calendars,
  event,
  start: initialStart,
  allDay: initialAllDay,
  onClose,
  onSaved,
  onError,
}: {
  api: AgendaApi;
  data: Snapshot;
  account: string;
  calendars: AgendaCalendar[];
  event?: AgendaEvent;
  start?: Date;
  allDay?: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const initial = event
    ? eventRange(event)
    : {
        start: initialStart ?? new Date(),
        end: new Date((initialStart ?? new Date()).getTime() + 3600000),
      };
  const [title, setTitle] = useState(event?.title ?? "");
  const [calendarId, setCalendarId] = useState(
    event?.calendarId ??
      (calendars.find((c) => c.primary) ?? calendars[0])?.id ??
      "",
  );
  const [allDay, setAllDay] = useState(event?.allDay ?? !!initialAllDay);
  const [start, setStart] = useState(initial.start);
  // All-day ends are shown inclusive (Google keeps them exclusive).
  const [end, setEnd] = useState(
    event?.allDay
      ? addDays(initial.end, -1)
      : initialAllDay
        ? initial.start
        : initial.end,
  );
  const [repeat, setRepeat] = useState<Repeat>({
    preset: "none",
    end: { type: "never" },
  });
  const [repeatLoaded, setRepeatLoaded] = useState(!event?.recurringEventId);
  const [scope, setScope] = useState<"this" | "following">("this");
  const [location, setLocation] = useState(event?.location ?? "");
  const [description, setDescription] = useState(
    event ? plainText(event.description) : "",
  );
  const [guests, setGuests] = useState<string[]>(
    event?.attendees.filter((a) => !a.self).map((a) => a.email) ?? [],
  );
  const [guestInput, setGuestInput] = useState("");
  const [meet, setMeet] = useState(!!event?.meetUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recurring = !!event?.recurringEventId;
  const suggestions = useMemo(
    () =>
      [
        ...new Set(
          data.members
            .map((m) => m.email?.toLowerCase())
            .filter((e): e is string => !!e && e !== account.toLowerCase()),
        ),
      ].sort(),
    [data.members, account],
  );

  // The series' rule, to show and keep (or change for "this and following").
  useEffect(() => {
    if (!event?.recurringEventId) return;
    api
      .series(event.calendarId, event.recurringEventId)
      .then((s) =>
        setRepeat(fromRecurrence(s.recurrence, eventRange(event).start)),
      )
      .catch(() => undefined)
      .finally(() => setRepeatLoaded(true));
  }, [api, event]);

  function addGuest(value = guestInput) {
    const list = value
      .split(/[,;\s]+/)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
    if (list.length) setGuests((g) => [...new Set([...g, ...list])]);
    setGuestInput("");
  }
  function moveStart(next: Date) {
    // Keep the duration when the start moves.
    const duration = end.getTime() - start.getTime();
    setStart(next);
    setEnd(
      new Date(next.getTime() + Math.max(duration, allDay ? 0 : 30 * 60000)),
    );
  }
  async function save() {
    setError("");
    if (!title.trim()) return setError("Informe o título do evento.");
    if (allDay ? dayKey(end) < dayKey(start) : end <= start)
      return setError("O fim precisa ser depois do início.");
    if (guestInput.trim()) addGuest();
    setBusy(true);
    try {
      await api.save({
        calendarId,
        eventId: event?.id,
        recurringEventId: event?.recurringEventId,
        scope: recurring ? scope : undefined,
        instanceStart: event?.start,
        hadMeet: !!event?.meetUrl,
        event: {
          title: title.trim(),
          description,
          location,
          allDay,
          start: allDay ? dayKey(start) : localIso(start),
          end: allDay ? dayKey(addDays(end, 1)) : localIso(end),
          timeZone: browserTimeZone(),
          recurrence:
            recurring && scope === "this" ? null : toRecurrence(repeat, start),
          attendees: guestInput.trim()
            ? [...guests, ...guestInput.split(/[,;\s]+/).filter(Boolean)]
            : guests,
          meet,
        },
      });
      onSaved();
    } catch (e) {
      if (e instanceof AgendaError && e.code === "not_connected") onError(e);
      else setError((e as Error).message);
      setBusy(false);
    }
  }
  const presets: RepeatPreset[] = [
    "none",
    "daily",
    "weekdays",
    "weekly",
    "monthly",
    "yearly",
    ...(repeat.preset === "custom" ? (["custom"] as const) : []),
  ];
  const repeatEnabled = !recurring || scope === "following";
  return (
    <Modal
      title={event ? "Editar evento" : "Novo evento"}
      onClose={() => !busy && onClose()}
      busy={busy}
    >
      <form
        className="entity-form agenda-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          Título
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={1024}
            required
            autoFocus
            placeholder="Adicionar título"
          />
        </label>
        {recurring && (
          <fieldset className="agenda-scope-inline">
            <legend>Aplicar as mudanças em</legend>
            <div className="drive-view" role="radiogroup">
              {(
                [
                  ["this", "Só este evento"],
                  ["following", "Este e os próximos"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={scope === v}
                  className={scope === v ? "selected" : ""}
                  onClick={() => setScope(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <div className="form-columns">
          <label>
            Agenda
            <Select
              value={calendarId}
              onValueChange={setCalendarId}
              disabled={!!event}
            >
              {calendars.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.name}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label className="checkbox-label agenda-allday-toggle">
            <Checkbox
              checked={allDay}
              onCheckedChange={(on) => {
                setAllDay(on === true);
                if (on === true) setEnd(startOfDay(end < start ? start : end));
                else {
                  setStart(
                    new Date(
                      start.getFullYear(),
                      start.getMonth(),
                      start.getDate(),
                      9,
                      0,
                    ),
                  );
                  setEnd(
                    new Date(
                      start.getFullYear(),
                      start.getMonth(),
                      start.getDate(),
                      10,
                      0,
                    ),
                  );
                }
              }}
            />
            Dia inteiro
          </label>
        </div>
        <div className="form-columns">
          <label>
            Início
            {allDay ? (
              <Input
                type="date"
                value={dayKey(start)}
                onChange={(e) =>
                  e.target.value && moveStart(fromDayKey(e.target.value))
                }
              />
            ) : (
              <Input
                type="datetime-local"
                value={inputDateTime(start)}
                onChange={(e) =>
                  e.target.value && moveStart(new Date(e.target.value))
                }
              />
            )}
          </label>
          <label>
            Fim
            {allDay ? (
              <Input
                type="date"
                value={dayKey(end)}
                min={dayKey(start)}
                onChange={(e) =>
                  e.target.value && setEnd(fromDayKey(e.target.value))
                }
              />
            ) : (
              <Input
                type="datetime-local"
                value={inputDateTime(end)}
                onChange={(e) =>
                  e.target.value && setEnd(new Date(e.target.value))
                }
              />
            )}
          </label>
        </div>
        <div className="form-columns">
          <label>
            Repetição
            <Select
              value={repeat.preset}
              disabled={!repeatEnabled || !repeatLoaded}
              onValueChange={(v) =>
                setRepeat((r) => ({ ...r, preset: v as RepeatPreset }))
              }
            >
              {presets.map((p) => (
                <SelectOption key={p} value={p}>
                  {repeatLabel(p, start)}
                </SelectOption>
              ))}
            </Select>
          </label>
          {repeat.preset !== "none" &&
            repeat.preset !== "custom" &&
            repeatEnabled && (
              <label>
                Termina
                <Select
                  value={repeat.end.type}
                  onValueChange={(v) =>
                    setRepeat((r) => ({
                      ...r,
                      end:
                        v === "until"
                          ? { type: "until", until: dayKey(addDays(start, 90)) }
                          : v === "count"
                            ? { type: "count", count: 10 }
                            : { type: "never" },
                    }))
                  }
                >
                  <SelectOption value="never">Nunca</SelectOption>
                  <SelectOption value="until">Em uma data</SelectOption>
                  <SelectOption value="count">
                    Após um número de vezes
                  </SelectOption>
                </Select>
              </label>
            )}
        </div>
        {repeatEnabled &&
          repeat.end.type === "until" &&
          repeat.preset !== "none" &&
          repeat.preset !== "custom" && (
            <label>
              Última data
              <Input
                type="date"
                value={repeat.end.until}
                min={dayKey(start)}
                onChange={(e) =>
                  e.target.value &&
                  setRepeat((r) => ({
                    ...r,
                    end: { type: "until", until: e.target.value },
                  }))
                }
              />
            </label>
          )}
        {repeatEnabled &&
          repeat.end.type === "count" &&
          repeat.preset !== "none" &&
          repeat.preset !== "custom" && (
            <label>
              Número de vezes
              <Input
                type="number"
                min={1}
                max={730}
                value={repeat.end.count}
                onChange={(e) =>
                  setRepeat((r) => ({
                    ...r,
                    end: { type: "count", count: Number(e.target.value) || 1 },
                  }))
                }
              />
            </label>
          )}
        {recurring && scope === "this" && (
          <small className="muted">
            Para mudar a repetição, escolha "Este e os próximos".
          </small>
        )}
        <label className="checkbox-label">
          <Checkbox
            checked={meet}
            onCheckedChange={(on) => setMeet(on === true)}
          />
          <Video size={15} aria-hidden="true" /> Adicionar videoconferência do
          Google Meet
        </label>
        <div className="agenda-guests">
          <span>Convidados</span>
          {guests.length > 0 && (
            <ul>
              {guests.map((g) => (
                <li key={g}>
                  {data.members.find((m) => m.email?.toLowerCase() === g)
                    ?.name ?? g}
                  <button
                    type="button"
                    aria-label={`Remover ${g}`}
                    onClick={() =>
                      setGuests((list) => list.filter((x) => x !== g))
                    }
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Input
            type="email"
            list="agenda-guest-suggestions"
            placeholder="E-mail e Enter (membros da empresa aparecem como sugestão)"
            value={guestInput}
            onChange={(e) => setGuestInput(e.target.value)}
            onBlur={() => guestInput.trim() && addGuest()}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter" || e.key === "," || e.key === ";") {
                e.preventDefault();
                addGuest();
              }
            }}
          />
          <datalist id="agenda-guest-suggestions">
            {suggestions
              .filter((s) => !guests.includes(s))
              .map((s) => (
                <option key={s} value={s}>
                  {data.members.find((m) => m.email?.toLowerCase() === s)?.name}
                </option>
              ))}
          </datalist>
          {guests.length > 0 && (
            <small className="muted">
              O Google envia o convite (e as atualizações) por e-mail.
            </small>
          )}
        </div>
        <label>
          Local
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={1024}
            icon={MapPin}
          />
        </label>
        <label>
          Descrição
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={8000}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="agenda-form-actions">
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button className="btn primary" type="submit" loading={busy}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

import { supabase } from "./supabase";

/**
 * Agenda: the person's Google Calendar through /api/google (api/_google.ts).
 * This module holds the types, the API client (and an in-memory calendar
 * for the demonstration), date helpers, the layout of overlapping events
 * and the recurrence presets the editor offers.
 */

export type AgendaCalendar = {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  writable: boolean;
  /** Owned by the person ("Minhas agendas"); the rest are "Outras agendas". */
  owner: boolean;
  /** Text color Google uses on this calendar's color. */
  textColor: string;
  /** Shown by default (as in Google). */
  selected: boolean;
  timeZone?: string;
};
export type Attendee = {
  email: string;
  name?: string;
  response?: string;
  organizer?: boolean;
  self?: boolean;
};
export type AgendaEvent = {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** "YYYY-MM-DD" (all day; end exclusive) or an ISO date-time. */
  start: string;
  end: string;
  timeZone?: string;
  recurringEventId?: string;
  attendees: Attendee[];
  meetUrl?: string;
  htmlLink?: string;
  colorId?: string;
  organizerSelf: boolean;
  canEdit: boolean;
};
export type EventInput = {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  recurrence: string[] | null;
  attendees: string[];
  meet: boolean;
};
export type SaveRequest = {
  calendarId: string;
  eventId?: string;
  scope?: "this" | "following";
  recurringEventId?: string;
  instanceStart?: string;
  hadMeet?: boolean;
  event: EventInput;
};
export type DeleteRequest = Omit<SaveRequest, "event" | "hadMeet"> & {
  eventId: string;
};
export type Connection = { account_email: string; connected_at: string } | null;

export interface AgendaApi {
  connection(): Promise<Connection>;
  connectUrl(): Promise<string>;
  disconnect(): Promise<void>;
  calendars(): Promise<AgendaCalendar[]>;
  events(
    calendars: AgendaCalendar[],
    from: Date,
    to: Date,
  ): Promise<{ events: AgendaEvent[]; failed: string[] }>;
  series(
    calendarId: string,
    eventId: string,
  ): Promise<{ recurrence: string[] }>;
  save(req: SaveRequest): Promise<AgendaEvent>;
  remove(req: DeleteRequest): Promise<void>;
}

/** An error from /api/google; `code` tells "not_connected"/"not_configured". */
export class AgendaError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function server<T>(body: Record<string, unknown>): Promise<T> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token) throw new AgendaError("Entre novamente para usar a Agenda.");
  const res = await fetch("/api/google", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new AgendaError(
      data.error ?? "Não foi possível falar com o Google Agenda.",
      data.code,
    );
  return data as T;
}

export const googleAgenda: AgendaApi = {
  async connection() {
    if (!supabase) return null;
    const { data, error } = await supabase.rpc("google_connection");
    if (error) throw error;
    return ((data ?? []) as Connection[])[0] ?? null;
  },
  async connectUrl() {
    return (await server<{ url: string }>({ action: "connect" })).url;
  },
  async disconnect() {
    await server({ action: "disconnect" });
  },
  async calendars() {
    return (
      await server<{ calendars: AgendaCalendar[] }>({ action: "calendars" })
    ).calendars;
  },
  events(calendars, from, to) {
    return server({
      action: "events",
      calendars: calendars.map((c) => ({ id: c.id, writable: c.writable })),
      from: from.toISOString(),
      to: to.toISOString(),
    });
  },
  series(calendarId, eventId) {
    return server({ action: "series", calendarId, eventId });
  },
  async save(req) {
    return (await server<{ event: AgendaEvent }>({ action: "save", ...req }))
      .event;
  },
  async remove(req) {
    await server({ action: "delete", ...req });
  },
};

// ------------------------------------------------------------ dates
export const browserTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
const pad = (n: number) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD". */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A local date from "YYYY-MM-DD". */
export const fromDayKey = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (d: Date, n: number) =>
  new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + n,
    d.getHours(),
    d.getMinutes(),
  );
export const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Weeks start on Sunday, as in Google Calendar in Portuguese. */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -d.getDay());
export const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);
/** "2026-10-01T12:00:00-03:00": local time with its offset. */
export function localIso(d: Date) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
/** "YYYY-MM-DDTHH:mm" for datetime inputs. */
export const inputDateTime = (d: Date) =>
  `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Where an event starts and ends, as local dates (all-day end exclusive). */
export function eventRange(e: Pick<AgendaEvent, "allDay" | "start" | "end">) {
  if (e.allDay)
    return { start: fromDayKey(e.start), end: fromDayKey(e.end || e.start) };
  return { start: new Date(e.start), end: new Date(e.end || e.start) };
}
/** Whether an event touches a given day. */
export function onDay(e: AgendaEvent, day: Date) {
  const { start, end } = eventRange(e);
  const d0 = startOfDay(day).getTime();
  const d1 = addDays(startOfDay(day), 1).getTime();
  return (
    start.getTime() < d1 &&
    (end.getTime() > d0 ||
      (end.getTime() === start.getTime() && start.getTime() >= d0))
  );
}

export type View = "month" | "week" | "day" | "list";
/** The dates a view shows around a day (end exclusive). */
export function viewRange(view: View, cursor: Date) {
  if (view === "day")
    return { from: startOfDay(cursor), to: addDays(startOfDay(cursor), 1) };
  if (view === "week") {
    const from = startOfWeek(cursor);
    return { from, to: addDays(from, 7) };
  }
  if (view === "list")
    return { from: startOfDay(cursor), to: addDays(startOfDay(cursor), 30) };
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const from = startOfWeek(first);
  return { from, to: addDays(from, 42) };
}
/** The cursor after "next"/"previous" in a view. */
export function stepCursor(view: View, cursor: Date, dir: 1 | -1) {
  if (view === "month")
    return new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  return addDays(
    cursor,
    dir * (view === "week" ? 7 : view === "list" ? 30 : 1),
  );
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * The toolbar title, as Google shows it: the month ("Setembro de 2026"),
 * both months when a week spans two ("Set – out de 2026"), or the day.
 */
export function viewTitle(view: View, cursor: Date) {
  if (view === "day")
    return capital(
      cursor.toLocaleDateString("pt-BR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    );
  const { from, to } =
    view === "month"
      ? {
          from: new Date(cursor.getFullYear(), cursor.getMonth(), 1),
          to: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1),
        }
      : viewRange(view, cursor);
  const last = addDays(to, -1);
  const month = (d: Date) =>
    d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "");
  if (
    from.getMonth() === last.getMonth() &&
    from.getFullYear() === last.getFullYear()
  )
    return capital(
      from.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }),
    );
  if (from.getFullYear() === last.getFullYear())
    return `${capital(month(from))} – ${month(last)} de ${last.getFullYear()}`;
  return `${capital(month(from))} de ${from.getFullYear()} – ${month(last)} de ${last.getFullYear()}`;
}
/** "GMT-03", for the time grid's corner. */
export function gmtLabel(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `GMT${off >= 0 ? "+" : "-"}${pad(h)}${m ? `:${pad(m)}` : ""}`;
}
export const timeLabel = (d: Date) =>
  d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

// ------------------------------------------------------------ layout
export type Placed = {
  event: AgendaEvent;
  top: number;
  height: number;
  col: number;
  cols: number;
};
/**
 * Timed events of one day in a time grid: minutes from midnight (clipped to
 * the day), side by side when they overlap (each cluster shares columns).
 */
export function layoutDay(events: AgendaEvent[], day: Date): Placed[] {
  const d0 = startOfDay(day).getTime();
  const items = events
    .filter((e) => !e.allDay && onDay(e, day))
    .map((event) => {
      const { start, end } = eventRange(event);
      const top = Math.max(0, (start.getTime() - d0) / 60000);
      const bottom = Math.min(1440, (end.getTime() - d0) / 60000);
      return {
        event,
        top,
        height: Math.max(20, bottom - top),
        col: 0,
        cols: 1,
      };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);
  let cluster: typeof items = [];
  let clusterEnd = -1;
  const columns: number[] = [];
  const close = () => {
    const cols = Math.max(1, ...cluster.map((i) => i.col + 1));
    cluster.forEach((i) => (i.cols = cols));
    cluster = [];
    columns.length = 0;
  };
  for (const item of items) {
    if (item.top >= clusterEnd) close();
    let col = columns.findIndex((end) => end <= item.top);
    if (col < 0) col = columns.length;
    columns[col] = item.top + item.height;
    item.col = col;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.top + item.height);
  }
  close();
  return items;
}

// ------------------------------------------------------------ recurrence
export type RepeatPreset =
  "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly" | "custom";
export type RepeatEnd =
  | { type: "never" }
  | { type: "until"; until: string }
  | { type: "count"; count: number };
export type Repeat = {
  preset: RepeatPreset;
  end: RepeatEnd;
  /** Kept as is when "custom". */ rules?: string[];
};
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** RRULE lines for a preset, anchored at the event's start. */
export function toRecurrence(repeat: Repeat, start: Date): string[] | null {
  if (repeat.preset === "none") return null;
  if (repeat.preset === "custom") return repeat.rules ?? null;
  const parts =
    repeat.preset === "daily"
      ? ["FREQ=DAILY"]
      : repeat.preset === "weekdays"
        ? ["FREQ=WEEKLY", "BYDAY=MO,TU,WE,TH,FR"]
        : repeat.preset === "weekly"
          ? ["FREQ=WEEKLY", `BYDAY=${BYDAY[start.getDay()]}`]
          : repeat.preset === "monthly"
            ? ["FREQ=MONTHLY", `BYMONTHDAY=${start.getDate()}`]
            : ["FREQ=YEARLY"];
  if (repeat.end.type === "until")
    parts.push(`UNTIL=${repeat.end.until.replace(/-/g, "")}`);
  if (repeat.end.type === "count")
    parts.push(`COUNT=${Math.max(1, Math.min(730, repeat.end.count))}`);
  return [`RRULE:${parts.join(";")}`];
}

/** The preset a series matches (anything else stays "custom", untouched). */
export function fromRecurrence(
  rules: string[] | undefined,
  start: Date,
): Repeat {
  const rrules = (rules ?? []).filter((r) => r.startsWith("RRULE:"));
  if (!rrules.length) return { preset: "none", end: { type: "never" } };
  const custom: Repeat = { preset: "custom", end: { type: "never" }, rules };
  if (rrules.length !== 1 || rules!.length !== 1) return custom;
  const map = Object.fromEntries(
    rrules[0]
      .slice(6)
      .split(";")
      .map((p) => p.split("=")),
  );
  const end: RepeatEnd = map.UNTIL
    ? {
        type: "until",
        until: `${map.UNTIL.slice(0, 4)}-${map.UNTIL.slice(4, 6)}-${map.UNTIL.slice(6, 8)}`,
      }
    : map.COUNT
      ? { type: "count", count: Number(map.COUNT) }
      : { type: "never" };
  const known = new Set([
    "FREQ",
    "BYDAY",
    "BYMONTHDAY",
    "UNTIL",
    "COUNT",
    "WKST",
  ]);
  if (
    Object.keys(map).some((k) => !known.has(k)) ||
    (map.INTERVAL && map.INTERVAL !== "1")
  )
    return custom;
  if (map.FREQ === "DAILY" && !map.BYDAY) return { preset: "daily", end };
  if (map.FREQ === "WEEKLY" && map.BYDAY === "MO,TU,WE,TH,FR")
    return { preset: "weekdays", end };
  if (
    map.FREQ === "WEEKLY" &&
    (!map.BYDAY || map.BYDAY === BYDAY[start.getDay()])
  )
    return { preset: "weekly", end };
  if (
    map.FREQ === "MONTHLY" &&
    (!map.BYMONTHDAY || Number(map.BYMONTHDAY) === start.getDate()) &&
    !map.BYDAY
  )
    return { preset: "monthly", end };
  if (map.FREQ === "YEARLY" && !map.BYDAY && !map.BYMONTHDAY)
    return { preset: "yearly", end };
  return custom;
}

export function repeatLabel(preset: RepeatPreset, start: Date) {
  const weekday = start.toLocaleDateString("pt-BR", { weekday: "long" });
  return {
    none: "Não se repete",
    daily: "Todos os dias",
    weekdays: "Dias úteis (segunda a sexta)",
    weekly: `Semanal: toda ${weekday}`,
    monthly: `Mensal: todo dia ${start.getDate()}`,
    yearly: `Anual: em ${start.toLocaleDateString("pt-BR", { day: "numeric", month: "long" })}`,
    custom: "Personalizada (mantida como está no Google)",
  }[preset];
}

// Google's event colors (colorId → hex).
export const googleEventColors: Record<string, string> = {
  "1": "#7986cb",
  "2": "#33b679",
  "3": "#8e24aa",
  "4": "#e67c73",
  "5": "#f6bf26",
  "6": "#f4511e",
  "7": "#039be5",
  "8": "#616161",
  "9": "#3f51b5",
  "10": "#0b8043",
  "11": "#d50000",
};

// ------------------------------------------------------------ demo
type DemoSeries = AgendaEvent & { rules?: string[] };
/** Occurrences of a demo series within [from, to) (DAILY/WEEKLY/MONTHLY/YEARLY, UNTIL/COUNT). */
function expand(
  series: DemoSeries,
  from: Date,
  to: Date,
  removed: Set<string>,
  overrides: Map<string, AgendaEvent>,
) {
  const rule = series.rules?.find((r) => r.startsWith("RRULE:"));
  if (!rule) return onRange(series, from, to) ? [series] : [];
  const map = Object.fromEntries(
    rule
      .slice(6)
      .split(";")
      .map((p) => p.split("=")),
  );
  const { start, end } = eventRange(series);
  const duration = end.getTime() - start.getTime();
  const until = map.UNTIL
    ? fromDayKey(
        `${map.UNTIL.slice(0, 4)}-${map.UNTIL.slice(4, 6)}-${map.UNTIL.slice(6, 8)}`,
      )
    : null;
  const days = map.BYDAY
    ? map.BYDAY.split(",").map((d: string) => BYDAY.indexOf(d))
    : [start.getDay()];
  const out: AgendaEvent[] = [];
  let count = 0;
  for (let d = startOfDay(start); d < to && count < 1000; d = addDays(d, 1)) {
    if (until && d > until) break;
    const hit =
      map.FREQ === "DAILY" ||
      (map.FREQ === "WEEKLY" && days.includes(d.getDay())) ||
      (map.FREQ === "MONTHLY" && d.getDate() === start.getDate()) ||
      (map.FREQ === "YEARLY" &&
        d.getDate() === start.getDate() &&
        d.getMonth() === start.getMonth());
    if (!hit) continue;
    count++;
    if (map.COUNT && count > Number(map.COUNT)) break;
    const s = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      start.getHours(),
      start.getMinutes(),
    );
    const e = new Date(s.getTime() + duration);
    const id = `${series.id}_${dayKey(s).replace(/-/g, "")}`;
    if (removed.has(id)) continue;
    const occurrence: AgendaEvent = overrides.get(id) ?? {
      ...series,
      id,
      recurringEventId: series.id,
      start: series.allDay ? dayKey(s) : s.toISOString(),
      end: series.allDay ? dayKey(e) : e.toISOString(),
    };
    if (onRange(occurrence, from, to)) out.push(occurrence);
  }
  return out;
}
const onRange = (e: AgendaEvent, from: Date, to: Date) => {
  const { start, end } = eventRange(e);
  return start < to && (end > from || start >= from);
};

/** An in-memory Google Calendar for the demonstration (nothing is sent). */
export function demoAgenda(email: string): AgendaApi {
  const today = startOfDay(new Date());
  const at = (dayOffset: number, h: number, m = 0) =>
    new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + dayOffset,
      h,
      m,
    );
  const calendars: AgendaCalendar[] = [
    {
      id: "primary",
      name: email || "Minha agenda",
      color: "#f4511e",
      textColor: "#fff",
      primary: true,
      writable: true,
      owner: true,
      selected: true,
    },
    {
      id: "comercial",
      name: "Comercial",
      color: "#039be5",
      textColor: "#fff",
      primary: false,
      writable: true,
      owner: true,
      selected: true,
    },
    {
      id: "alinhamentos",
      name: "Alinhamentos/Feedbacks",
      color: "#7986cb",
      textColor: "#fff",
      primary: false,
      writable: true,
      owner: true,
      selected: false,
    },
    ...Array.from({ length: 14 }, (_, i): AgendaCalendar => ({
      id: `transferido-${i}`,
      name: `Transferido de pessoa${i + 1}@makevendas.com.br`,
      color: "#616161",
      textColor: "#fff",
      primary: false,
      writable: true,
      owner: true,
      selected: false,
    })),
    {
      id: "feriados",
      name: "Feriados no Brasil",
      color: "#0b8043",
      textColor: "#fff",
      primary: false,
      writable: false,
      owner: false,
      selected: true,
    },
    {
      id: "aniversarios",
      name: "Aniversários",
      color: "#33b679",
      textColor: "#fff",
      primary: false,
      writable: false,
      owner: false,
      selected: false,
    },
  ];
  const base = (
    id: string,
    calendarId: string,
    title: string,
    s: Date,
    e: Date,
    extra: Partial<DemoSeries> = {},
  ): DemoSeries => ({
    id,
    calendarId,
    title,
    description: "",
    location: "",
    allDay: false,
    start: s.toISOString(),
    end: e.toISOString(),
    attendees: [],
    organizerSelf: true,
    canEdit: calendarId !== "feriados",
    ...extra,
  });
  let series: DemoSeries[] = [
    base("daily", "primary", "Daily da equipe", at(-14, 9), at(-14, 9, 15), {
      rules: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
      meetUrl: "https://meet.google.com/demo-daily",
      attendees: [{ email: "equipe@makevendas.com.br" }],
    }),
    base(
      "planejamento",
      "primary",
      "Planejamento de campanhas",
      at(1, 14),
      at(1, 15, 30),
      {
        location: "Sala 2",
        description: "Revisar verbas e criativos do próximo ciclo.",
        meetUrl: "https://meet.google.com/demo-plan",
        attendees: [
          { email: email, self: true, organizer: true, response: "accepted" },
          {
            email: "marina@makevendas.com.br",
            name: "Marina Costa",
            response: "accepted",
          },
          { email: "cliente@aurora.example", response: "needsAction" },
        ],
      },
    ),
    base("almoco", "primary", "Almoço com cliente", at(0, 12), at(0, 13, 30), {
      location: "Restaurante Aurora",
    }),
    base(
      "proposta",
      "comercial",
      "Apresentação de proposta",
      at(2, 10),
      at(2, 11),
      {
        meetUrl: "https://meet.google.com/demo-prop",
        organizerSelf: false,
        canEdit: false,
        attendees: [
          {
            email: "cliente@aurora.example",
            organizer: true,
            response: "accepted",
          },
          { email: email, self: true, response: "needsAction" },
        ],
      },
    ),
    base(
      "overlap",
      "comercial",
      "Ligação de follow-up",
      at(1, 14, 30),
      at(1, 15),
    ),
    base("evento", "primary", "Workshop de tráfego pago", at(3, 0), at(5, 0), {
      allDay: true,
      start: dayKey(at(3, 0)),
      end: dayKey(at(5, 0)),
    }),
    base("feriado", "feriados", "Feriado", at(8, 0), at(9, 0), {
      allDay: true,
      start: dayKey(at(8, 0)),
      end: dayKey(at(9, 0)),
      canEdit: false,
    }),
  ];
  const removed = new Set<string>();
  const overrides = new Map<string, AgendaEvent>();
  const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120));
  const apply = (target: AgendaEvent, input: EventInput): AgendaEvent => ({
    ...target,
    title: input.title,
    description: input.description,
    location: input.location,
    allDay: input.allDay,
    start: input.start,
    end: input.end,
    attendees: input.attendees.map(
      (e) =>
        target.attendees.find((a) => a.email === e) ?? {
          email: e,
          response: "needsAction",
        },
    ),
    meetUrl: input.meet
      ? (target.meetUrl ??
        `https://meet.google.com/demo-${Math.random().toString(36).slice(2, 6)}`)
      : undefined,
  });
  const truncate = (s: DemoSeries, before: string) => {
    const day = dayKey(addDays(startOfDay(new Date(before)), -1)).replace(
      /-/g,
      "",
    );
    s.rules = s.rules?.map((r) =>
      r.startsWith("RRULE:")
        ? `RRULE:${r
            .slice(6)
            .split(";")
            .filter((p) => !/^(COUNT|UNTIL)=/.test(p))
            .concat(`UNTIL=${day}`)
            .join(";")}`
        : r,
    );
  };
  return {
    connection: () =>
      delay({ account_email: email, connected_at: new Date().toISOString() }),
    connectUrl: () => Promise.resolve("#"),
    disconnect: () => delay(undefined),
    calendars: () => delay(calendars),
    events: (cals, from, to) =>
      delay({
        events: series
          .filter((s) => cals.some((c) => c.id === s.calendarId))
          .flatMap((s) => expand(s, from, to, removed, overrides)),
        failed: [],
      }),
    series: (_c, id) =>
      delay({ recurrence: series.find((s) => s.id === id)?.rules ?? [] }),
    async save(req) {
      if (!req.eventId) {
        const created: DemoSeries = {
          ...apply(
            base(
              `demo-${Date.now()}`,
              req.calendarId,
              "",
              new Date(),
              new Date(),
            ),
            req.event,
          ),
          rules: req.event.recurrence ?? undefined,
        };
        series = [...series, created];
        return delay(created);
      }
      if (req.recurringEventId) {
        const master = series.find((s) => s.id === req.recurringEventId)!;
        if (req.scope === "following") {
          const first =
            master.start === req.instanceStart ||
            dayKey(new Date(master.start)) ===
              dayKey(new Date(req.instanceStart!));
          if (first) {
            Object.assign(master, apply(master, req.event), {
              rules: req.event.recurrence ?? undefined,
            });
            return delay(master);
          }
          truncate(master, req.instanceStart!);
          const created: DemoSeries = {
            ...apply(master, req.event),
            id: `demo-${Date.now()}`,
            rules: req.event.recurrence ?? undefined,
          };
          series = [...series, created];
          return delay(created);
        }
        const occurrence = expand(
          master,
          new Date(0),
          new Date(8.64e15),
          new Set(),
          overrides,
        ).find((o) => o.id === req.eventId);
        const updated = apply(occurrence ?? master, req.event);
        overrides.set(req.eventId, {
          ...updated,
          id: req.eventId,
          recurringEventId: master.id,
        });
        return delay(updated);
      }
      const target = series.find((s) => s.id === req.eventId)!;
      Object.assign(target, apply(target, req.event), {
        rules: req.event.recurrence ?? undefined,
      });
      return delay(target);
    },
    async remove(req) {
      if (req.recurringEventId) {
        const master = series.find((s) => s.id === req.recurringEventId);
        if (master && req.scope === "following") {
          if (
            dayKey(new Date(master.start)) ===
            dayKey(new Date(req.instanceStart!))
          )
            series = series.filter((s) => s !== master);
          else truncate(master, req.instanceStart!);
        } else removed.add(req.eventId);
      } else series = series.filter((s) => s.id !== req.eventId);
      return delay(undefined);
    },
  };
}

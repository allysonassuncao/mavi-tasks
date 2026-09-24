import { describe, expect, it } from "vitest";
import {
  demoAgenda,
  eventRange,
  fromRecurrence,
  layoutDay,
  localIso,
  onDay,
  stepCursor,
  toRecurrence,
  viewRange,
  type AgendaEvent,
} from "./calendar";
import { plainText } from "./AgendaPage";

const ev = (
  id: string,
  start: string,
  end: string,
  allDay = false,
): AgendaEvent => ({
  id,
  calendarId: "primary",
  title: id,
  description: "",
  location: "",
  allDay,
  start,
  end,
  attendees: [],
  organizerSelf: true,
  canEdit: true,
});
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe("Datas da agenda", () => {
  it("semana começa no domingo; mês mostra 6 semanas", () => {
    const thu = new Date(2026, 8, 24, 15);
    const week = viewRange("week", thu);
    expect(week.from).toEqual(new Date(2026, 8, 20));
    expect(week.to).toEqual(new Date(2026, 8, 27));
    const month = viewRange("month", thu);
    expect(month.from).toEqual(new Date(2026, 7, 30));
    expect((month.to.getTime() - month.from.getTime()) / 86400000).toBeCloseTo(
      42,
      0,
    );
    expect(stepCursor("month", new Date(2026, 0, 31), 1)).toEqual(
      new Date(2026, 1, 1),
    );
  });
  it("evento de dia inteiro vale até a véspera do fim (exclusivo)", () => {
    const e = ev("w", "2026-09-27", "2026-09-29", true);
    expect(onDay(e, new Date(2026, 8, 27))).toBe(true);
    expect(onDay(e, new Date(2026, 8, 28))).toBe(true);
    expect(onDay(e, new Date(2026, 8, 29))).toBe(false);
    expect(eventRange(e).start).toEqual(new Date(2026, 8, 27));
  });
  it("hora local com o deslocamento do fuso", () => {
    expect(localIso(new Date(2026, 9, 1, 12, 30))).toMatch(
      /^2026-10-01T12:30:00[+-]\d{2}:\d{2}$/,
    );
  });
});

describe("Eventos sobrepostos", () => {
  it("dividem colunas só dentro do mesmo grupo", () => {
    const day = new Date(2026, 8, 24);
    const placed = layoutDay(
      [
        ev("a", local(2026, 9, 24, 14), local(2026, 9, 24, 15, 30)),
        ev("b", local(2026, 9, 24, 14, 30), local(2026, 9, 24, 15)),
        ev("c", local(2026, 9, 24, 16), local(2026, 9, 24, 17)),
        ev("dia", "2026-09-24", "2026-09-25", true),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((p) => [p.event.id, p]));
    expect(Object.keys(by)).toEqual(["a", "b", "c"]);
    expect([by.a.col, by.a.cols, by.b.col, by.b.cols]).toEqual([0, 2, 1, 2]);
    expect([by.c.col, by.c.cols]).toEqual([0, 1]);
    expect(by.a.top).toBe(14 * 60);
    expect(by.a.height).toBe(90);
  });
  it("evento que atravessa a meia-noite é cortado no dia", () => {
    const [p] = layoutDay(
      [ev("n", local(2026, 9, 24, 23), local(2026, 9, 25, 1))],
      new Date(2026, 8, 25),
    );
    expect([p.top, p.height]).toEqual([0, 60]);
  });
});

describe("Recorrência", () => {
  const thu = new Date(2026, 8, 24, 9);
  it("gera as regras dos modelos", () => {
    expect(
      toRecurrence({ preset: "none", end: { type: "never" } }, thu),
    ).toBeNull();
    expect(
      toRecurrence({ preset: "weekly", end: { type: "never" } }, thu),
    ).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TH"]);
    expect(
      toRecurrence(
        { preset: "weekdays", end: { type: "count", count: 5 } },
        thu,
      ),
    ).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=5"]);
    expect(
      toRecurrence(
        { preset: "monthly", end: { type: "until", until: "2026-12-31" } },
        thu,
      ),
    ).toEqual(["RRULE:FREQ=MONTHLY;BYMONTHDAY=24;UNTIL=20261231"]);
  });
  it("reconhece o modelo de volta e mantém o que não conhece", () => {
    for (const preset of [
      "daily",
      "weekdays",
      "weekly",
      "monthly",
      "yearly",
    ] as const) {
      const rules = toRecurrence({ preset, end: { type: "never" } }, thu)!;
      expect(fromRecurrence(rules, thu).preset).toBe(preset);
    }
    expect(
      fromRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH"], thu),
    ).toMatchObject({ preset: "custom" });
    expect(
      fromRecurrence(["RRULE:FREQ=DAILY", "EXDATE:20260925T120000Z"], thu)
        .preset,
    ).toBe("custom");
    expect(
      fromRecurrence(["RRULE:FREQ=DAILY;UNTIL=20261031T235959Z"], thu).end,
    ).toEqual({ type: "until", until: "2026-10-31" });
  });
});

describe("Descrição do Google", () => {
  it("vira texto simples, sem marcação", () => {
    expect(
      plainText(
        'Pauta:<br>1. Verba<br/><b>2.</b> Criativos &amp; <a href="x">link</a>',
      ),
    ).toBe("Pauta:\n1. Verba\n2. Criativos & link");
    expect(plainText("<script>alert(1)</script>ok")).toBe("alert(1)ok");
  });
});

describe("Agenda de demonstração", () => {
  it("edita esta e as próximas: encerra a série e cria outra", async () => {
    const api = demoAgenda("ana@empresa.com");
    const cals = await api.calendars();
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14);
    const before = (await api.events(cals, from, to)).events.filter(
      (e) => e.recurringEventId === "daily",
    );
    const target = before[Math.floor(before.length / 2)];
    const later = before.filter((e) => e.start >= target.start).length;
    await api.save({
      calendarId: "primary",
      eventId: target.id,
      recurringEventId: "daily",
      scope: "following",
      instanceStart: target.start,
      event: {
        title: "Daily nova",
        description: "",
        location: "",
        allDay: false,
        start: target.start,
        end: target.end,
        timeZone: "America/Sao_Paulo",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
        attendees: [],
        meet: false,
      },
    });
    const after = (await api.events(cals, from, to)).events;
    expect(
      after.filter(
        (e) => e.title === "Daily da equipe" && e.start >= target.start,
      ),
    ).toHaveLength(0);
    expect(after.filter((e) => e.title === "Daily nova")).toHaveLength(later);
  });
});

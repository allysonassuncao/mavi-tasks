import { describe, expect, it } from "vitest";
import {
  defaultPrefs,
  isPaused,
  pauseLabel,
  pauseUntil,
  statusKey,
} from "./notificationPrefs";

describe("Preferências de notificação", () => {
  it("o padrão da demonstração é o mesmo do banco", () => {
    const { prefs } = defaultPrefs();
    expect(prefs.assigned).toBe(true);
    expect(prefs.review).toBe(true);
    expect(prefs[statusKey("correction", "assignee")]).toBe(true);
    expect(prefs[statusKey("rejected", "assignee")]).toBe(true);
    expect(prefs[statusKey("correction", "creator")]).toBe(false);
    expect(prefs[statusKey("done", "creator")]).toBe(false);
  });
  it("pausa por 1 hora, até amanhã às 8h ou até retomar", () => {
    const now = new Date(2026, 8, 29, 14, 30);
    expect(Date.parse(pauseUntil("hour", now)) - now.getTime()).toBe(3600e3);
    const tomorrow = new Date(pauseUntil("tomorrow", now));
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([30, 8]);
    expect(pauseUntil("forever", now)).toBe("infinity");
    expect(pauseLabel(pauseUntil("hour", now), now)).toBe("até 15:30");
    expect(pauseLabel(pauseUntil("tomorrow", now), now)).toBe(
      "até amanhã às 08:00",
    );
    expect(pauseLabel("infinity", now)).toBe("até você retomar");
  });
  it("sabe se está em pausa", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(isPaused(null, now)).toBe(false);
    expect(isPaused({ prefs: {}, paused_until: "infinity" }, now)).toBe(true);
    expect(
      isPaused({ prefs: {}, paused_until: "2026-09-29T11:00:00Z" }, now),
    ).toBe(false);
  });
});

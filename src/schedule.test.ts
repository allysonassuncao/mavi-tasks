import { describe, it, expect } from "vitest";
import {
  calendarDays,
  ganttPlacement,
  monthRange,
  overlaps,
  taskStart,
} from "./schedule";
import type { Task } from "./types";
describe("calendário e Gantt", () => {
  it("monta semanas completas e respeita fevereiro bissexto", () => {
    const days = calendarDays("2028-02");
    expect(days).toContain("2028-02-29");
    expect(days.length % 7).toBe(0);
    expect(days[0]).toBe("2028-01-30");
    expect(monthRange("2028-02").end).toBe("2028-02-29");
  });
  it("recorta barras de tarefas que atravessam o mês", () => {
    const t = {
      start_date: "2026-08-20",
      due_date: "2026-09-03",
      created_at: "2026-08-01T12:00:00Z",
    } as Task;
    expect(overlaps(t, "2026-09-01", "2026-09-30")).toBe(true);
    expect(
      ganttPlacement(t, [
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
      ]),
    ).toEqual({ start: 1, span: 3 });
    expect(overlaps(t, "2026-10-01", "2026-10-31")).toBe(false);
  });
  it("mantém uma barra válida quando o prazo histórico precede a criação", () => {
    expect(
      taskStart({
        created_at: "2026-09-20T12:00:00Z",
        due_date: "2026-09-10",
      } as Task),
    ).toBe("2026-09-10");
  });
});

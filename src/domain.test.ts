import { describe, it, expect } from "vitest";
import {
  dateKey,
  isLate,
  minutes,
  duration,
  taskTimerSeconds,
  formatClock,
} from "./domain";
import { demoSnapshot } from "./demo";
import type { TimeEntry } from "./types";

describe("Datas e horas operacionais", () => {
  it("calcula o dia usando o fuso da empresa", () =>
    expect(dateKey(new Date("2026-09-19T01:00:00Z"), "America/Sao_Paulo")).toBe(
      "2026-09-18",
    ));
  it("validação pendente continua atrasada após o prazo", () => {
    const t = {
      ...demoSnapshot().tasks[0],
      status: "review" as const,
      due_date: "2026-09-17",
    };
    expect(isLate(t, "2026-09-18")).toBe(true);
    expect(isLate({ ...t, status: "done" }, "2026-09-18")).toBe(false);
  });
  it("mantém cronômetro a partir do horário persistido", () =>
    expect(
      minutes(
        {
          id: "1",
          company_id: "1",
          task_id: "1",
          user_id: "1",
          started_at: "2026-09-18T12:00:00Z",
          ended_at: null,
          note: "",
          source: "timer",
        },
        Date.parse("2026-09-18T13:30:00Z"),
      ),
    ).toBe(90));
  it("apresenta horas sem perder os minutos", () =>
    expect(duration(125)).toBe("2h 05m"));

  it("calcula o tempo acumulado da tarefa e não zera o cronômetro", () => {
    const hours: TimeEntry[] = [
      {
        id: "e1",
        company_id: "c1",
        task_id: "t1",
        user_id: "u1",
        started_at: "2026-09-18T10:00:00Z",
        ended_at: "2026-09-18T10:15:30Z", // 15m 30s = 930s
        note: "",
        source: "timer",
      },
      {
        id: "e2",
        company_id: "c1",
        task_id: "t1",
        user_id: "u1",
        started_at: "2026-09-18T11:00:00Z",
        ended_at: "2026-09-18T11:05:00Z", // 5m = 300s
        note: "",
        source: "manual",
      },
      {
        id: "e3",
        company_id: "c1",
        task_id: "t2", // outra tarefa
        user_id: "u1",
        started_at: "2026-09-18T09:00:00Z",
        ended_at: "2026-09-18T09:30:00Z",
        note: "",
        source: "timer",
      },
    ];

    // Quando parado, mantém o total acumulado das entradas passadas (930s + 300s = 1230s = 20m 30s)
    const stoppedSeconds = taskTimerSeconds(hours, "t1", null);
    expect(stoppedSeconds).toBe(1230);
    expect(formatClock(stoppedSeconds)).toBe("00:20:30");

    // Quando uma nova sessão inicia, continua a partir do valor acumulado (não inicia do zero)
    const runningEntry: TimeEntry = {
      id: "e4",
      company_id: "c1",
      task_id: "t1",
      user_id: "u1",
      started_at: "2026-09-18T14:00:00Z",
      ended_at: null,
      note: "",
      source: "timer",
    };

    // 10 segundos após o início da nova sessão:
    const now10s = Date.parse("2026-09-18T14:00:10Z");
    const runningSeconds10s = taskTimerSeconds(
      hours,
      "t1",
      runningEntry,
      now10s,
    );
    expect(runningSeconds10s).toBe(1240); // 1230s acumulados + 10s atuais
    expect(formatClock(runningSeconds10s)).toBe("00:20:40");

    // Para uma tarefa nova sem histórico:
    expect(taskTimerSeconds(hours, "t3", null)).toBe(0);
    expect(formatClock(0)).toBe("00:00:00");
  });

  it("formata o relógio corretamente no padrão HH:MM:SS", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(59)).toBe("00:00:59");
    expect(formatClock(60)).toBe("00:01:00");
    expect(formatClock(3599)).toBe("00:59:59");
    expect(formatClock(3600)).toBe("01:00:00");
    expect(formatClock(3665)).toBe("01:01:05");
  });
});

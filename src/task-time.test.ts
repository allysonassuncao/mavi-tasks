import { describe, it, expect, vi } from "vitest";
vi.mock("./api", () => ({ taskPastSeconds: vi.fn() }));
const { trackedTotal } = await import("./useTaskTime");
import type { TimeEntry } from "./types";

const t0 = Date.parse("2026-09-23T10:00:00Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const entry = (id: string, start: number, end?: number): TimeEntry => ({
  id,
  company_id: "c",
  task_id: "task",
  user_id: "u",
  started_at: at(start),
  ended_at: end === undefined ? null : at(end),
  note: "",
  source: "timer",
});

describe("Tempo total da tarefa em execução", () => {
  it("soma o tempo já trabalhado (do banco) com a sessão atual", () => {
    // 2h já registradas, sessão atual há 90s.
    const running = entry("r", 0);
    const past = { task: "task", seconds: 7200, session: "r" };
    expect(trackedTotal(past, [running], running, "task", t0 + 90_000)).toBe(
      7290,
    );
  });
  it("não conta só a última sessão, mesmo sem os registros antigos na tela", () => {
    const running = entry("r", 0);
    // O snapshot só tem a sessão atual (registros antigos ficaram de fora).
    const past = { task: "task", seconds: 3600, session: "r" };
    expect(
      trackedTotal(past, [running], running, "task", t0 + 60_000),
    ).toBeGreaterThan(60);
  });
  it("ao parar, soma a sessão encerrada enquanto o total é atualizado", () => {
    const stopped = entry("r", 0, 120);
    const past = { task: "task", seconds: 7200, session: "r" };
    expect(trackedTotal(past, [stopped], null, "task", t0 + 500_000)).toBe(
      7320,
    );
  });
  it("sem o total do banco, usa os registros carregados", () => {
    const hours = [entry("a", -600, -300), entry("r", 0)];
    expect(trackedTotal(null, hours, hours[1], "task", t0 + 30_000)).toBe(330);
  });
  it("ignora um total buscado para outra tarefa", () => {
    const hours = [entry("r", 0)];
    const past = { task: "outra", seconds: 9999 };
    expect(trackedTotal(past, hours, hours[0], "task", t0 + 10_000)).toBe(10);
  });
});

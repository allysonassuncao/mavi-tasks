import { describe, it, expect } from "vitest";
import { dateKey, isLate, minutes, duration } from "./domain";
import { demoSnapshot } from "./demo";
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
});

import { describe, expect, it } from "vitest";
import { smartReasons, type SmartDue } from "./smartDue";
import type { Snapshot } from "./types";

const data = {
  members: [{ user_id: "ana", name: "Ana Souza", role: "member", active: true }],
} as unknown as Pick<Snapshot, "members">;
const base: SmartDue = {
  available: true,
  due: "2026-11-24",
  days: 3,
  assignee: "ana",
  level: 1,
  level_label: "quem executa, neste cliente e produto",
  sample: 7,
  median_days: 3,
  approval_days: 0,
  rework_days: 0,
  load_minutes: 0,
  own_minutes: 0,
  daily_minutes: 480,
  busy_minutes: 0,
  load_days: 0,
  unestimated_tasks: 0,
};

describe("smartReasons", () => {
  it("explica o histórico, e nada mais quando é só ele", () => {
    expect(smartReasons(base, data)).toEqual([
      "Tarefas parecidas (quem executa, neste cliente e produto) levaram 3 dias úteis até a primeira entrega — mediana de 7 entregas.",
    ]);
    expect(smartReasons({ available: false, reason: "history" }, data)).toEqual([]);
  });

  it("diz quando a carga, com as reuniões, empurra o prazo", () => {
    const r = smartReasons(
      { ...base, days: 5, load_minutes: 2400, own_minutes: 240, busy_minutes: 90, load_days: 5 },
      data,
    );
    expect(r[1]).toBe(
      "Ana tem 40 h em aberto vencendo antes e esta tarefa estima 4 h, com 8 h por dia, menos 1,5 h de reuniões na agenda: só cabe em 5 dias úteis.",
    );
    const fits = smartReasons({ ...base, load_minutes: 480, load_days: 1 }, data);
    expect(fits[1]).toMatch(/cabe no prazo\.$/);
  });

  it("diz quando a descrição mexeu no prazo, e por quê", () => {
    const r = smartReasons(
      { ...base, days: 4, effort: "complex", effort_days: 1 },
      data,
      "normal",
      "Três formatos e um roteiro novo.",
    );
    expect(r[1]).toBe(
      "+1 dia útil: pela descrição, a entrega é mais trabalhosa que o comum (Três formatos e um roteiro novo).",
    );
    expect(smartReasons({ ...base, days: 2, effort_days: -1 }, data)[1]).toBe(
      "−1 dia útil: pela descrição, a entrega é mais simples que o comum.",
    );
  });

  it("lista aprovação, retrabalho, prioridade e o que ficou de fora", () => {
    const r = smartReasons(
      { ...base, days: 6, approval_days: 2, rework_days: 1, unestimated_tasks: 2 },
      data,
      "urgent",
    );
    expect(r).toEqual([
      expect.stringContaining("mediana de 7 entregas"),
      "+2 dias úteis pela aprovação do cliente, que as parecidas em geral não tinham.",
      "+1 dia útil: este cliente pede mais ajustes que a média.",
      "Urgente: só as tarefas urgentes de quem executa passam na frente.",
      "2 tarefas em aberto sem estimativa não entraram na conta.",
    ]);
  });
});

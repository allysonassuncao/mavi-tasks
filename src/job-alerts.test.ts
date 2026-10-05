import { describe, expect, it } from "vitest";
import {
  clampInt,
  countNoun,
  hoursLabel,
  jobHealth,
  settingsSummary,
  type JobAlert,
} from "./job-alerts";

const job = (
  patch: Partial<JobAlert> = {},
  health: Partial<JobAlert["health"]> = {},
): JobAlert => ({
  job: "ads_sync",
  label: "Sincronização diária das campanhas",
  noun: "campanha",
  nouns: "campanhas",
  fails: true,
  stale_ok: true,
  link: "/campanhas",
  defaults: { fail_after: 1, stale_hours: 30 },
  custom: false,
  settings: {
    active: true,
    fail_after: 1,
    stale_hours: 30,
    notify_recovery: true,
    remind_hours: 24,
    recipients: null,
  },
  ...patch,
  health: {
    seen: true,
    last_ok_at: "2026-10-04T09:00:00Z",
    last_fail_at: null,
    last_error: null,
    stale: false,
    failing_count: 0,
    failing: [],
    ...health,
  },
});

describe("avisos de falhas", () => {
  it("diz como a rotina está: falha antes de parada, e sem dados", () => {
    expect(jobHealth(job())).toBe("ok");
    expect(jobHealth(job({}, { stale: true }))).toBe("stale");
    expect(jobHealth(job({}, { stale: true, failing_count: 2 }))).toBe(
      "failing",
    );
    expect(jobHealth(job({}, { last_ok_at: null, seen: false }))).toBe("idle");
  });

  it("resume o que está ligado e quem recebe", () => {
    expect(settingsSummary(job(), 2)).toBe(
      "Avisa os administradores: na 1ª falha, parada há 30 h, quando voltar, lembra a cada 1 dia",
    );
    const s = job().settings;
    expect(
      settingsSummary(
        job({
          settings: {
            ...s,
            fail_after: 3,
            stale_hours: null,
            notify_recovery: false,
            remind_hours: null,
            recipients: ["a"],
          },
        }),
        2,
      ),
    ).toBe("Avisa 1 pessoa: após 3 falhas seguidas");
    expect(settingsSummary(job({ settings: { ...s, active: false } }), 2)).toBe(
      "Avisos desligados",
    );
    expect(
      settingsSummary(
        job({ settings: { ...s, fail_after: null, stale_hours: null } }),
        2,
      ),
    ).toBe("Nenhum aviso escolhido");
  });

  it("formata os itens, as horas e os números do formulário", () => {
    expect(countNoun(job(), 1)).toBe("1 campanha");
    expect(countNoun(job(), 3)).toBe("3 campanhas");
    expect(countNoun(job({ noun: null, nouns: null }), 3)).toBe("");
    expect(hoursLabel(6)).toBe("6 h");
    expect(hoursLabel(48)).toBe("2 dias");
    expect(clampInt("0", 1, 50)).toBe(1);
    expect(clampInt("99", 1, 50)).toBe(50);
    expect(clampInt("", 1, 50)).toBeNull();
  });
});

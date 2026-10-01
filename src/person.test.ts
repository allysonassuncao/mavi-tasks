import { describe, expect, it } from "vitest";
import {
  personAbsence,
  personTeams,
  shortDate,
  whatsappUrl,
  workDaysLabel,
  workHoursLabel,
} from "./person";
import {
  personMeetingUrl,
  personTasksUrl,
  personUrl,
  summaryText,
} from "./PersonCard";
import { personIdFromPath, resolvePage, safeReturnPath } from "./router";
import { canOpenPage } from "./modules";
import { emptySnapshot, type MemberAbsence, type Snapshot } from "./types";

const absence = (
  starts_on: string,
  ends_on: string,
  kind: MemberAbsence["kind"] = "vacation",
  user_id = "bia",
): MemberAbsence =>
  ({
    id: `${user_id}-${starts_on}`,
    company_id: "c",
    user_id,
    starts_on,
    ends_on,
    kind,
  }) as MemberAbsence;

describe("perfil da pessoa: endereço", () => {
  it("/pessoas/<id> abre a página da pessoa, com e sem agência", () => {
    const id = "0b6c3a5e-1f2d-4c3b-9a8e-7d6c5b4a3f2e";
    expect(personIdFromPath(`/pessoas/${id}`)).toBe(id);
    expect(personIdFromPath(`/agencias/make/pessoas/${id}`)).toBe(id);
    expect(personIdFromPath("/pessoas/user-ana")).toBe("user-ana");
    expect(personIdFromPath("/pessoas/a/b")).toBeNull();
    expect(resolvePage(`/agencias/make/pessoas/${id}`)).toBe("person");
    expect(personUrl("user-ana", "make")).toBe(
      "/agencias/make/pessoas/user-ana",
    );
  });
  it("todo mundo abre o perfil de quem trabalha com ele", () => {
    expect(canOpenPage("person", "member")).toBe(true);
    expect(canOpenPage("person", "manager", ["tasks", "agenda"])).toBe(true);
  });
  it("os atalhos: tarefas pela Busca avançada e reunião pela Agenda", () => {
    expect(personTasksUrl("u1", "make")).toBe(
      "/agencias/make/tarefas/busca?resp=u1",
    );
    expect(personTasksUrl("u1", "", "review")).toBe(
      "/tarefas/busca?resp=u1&situacao=review",
    );
    expect(personMeetingUrl("u1", "")).toBe("/agenda?convidar=u1");
    // Sobrevive ao login.
    expect(safeReturnPath("/agenda?convidar=u1")).toBe("/agenda?convidar=u1");
  });
});

describe("perfil da pessoa: dados", () => {
  it("equipes em ordem, com quem supervisiona", () => {
    const data = {
      ...emptySnapshot,
      teams: [
        { id: "t2", company_id: "c", name: "Vendas" },
        { id: "t1", company_id: "c", name: "Design" },
        { id: "t3", company_id: "c", name: "Outra" },
      ],
      teamMembers: [
        { company_id: "c", team_id: "t2", user_id: "bia", supervisor: true },
        { company_id: "c", team_id: "t1", user_id: "bia" },
        { company_id: "c", team_id: "t3", user_id: "caio" },
      ],
    } as Snapshot;
    expect(personTeams(data, "bia")).toEqual([
      { id: "t1", name: "Design", supervisor: false },
      { id: "t2", name: "Vendas", supervisor: true },
    ]);
  });
  it("ausência: a de hoje primeiro; senão a próxima em até 14 dias", () => {
    const list = [
      absence("2026-10-20", "2026-10-24"),
      absence("2026-09-28", "2026-10-03", "day_off"),
      absence("2026-10-01", "2026-10-02", "vacation", "caio"),
    ];
    expect(personAbsence(list, "bia", "2026-10-01")).toEqual({
      absence: list[1],
      now: true,
    });
    expect(personAbsence(list, "bia", "2026-10-10")).toEqual({
      absence: list[0],
      now: false,
    });
    expect(personAbsence(list, "bia", "2026-10-04")).toBeNull();
    expect(personAbsence(undefined, "bia")).toBeNull();
  });
  it("jornada, datas, WhatsApp e o resumo das tarefas", () => {
    expect(workDaysLabel(null)).toBe("seg a sex");
    expect(workDaysLabel([5, 1, 3])).toBe("seg, qua, sex");
    expect(workHoursLabel(480)).toBe("8h");
    expect(workHoursLabel(390)).toBe("6h30");
    expect(shortDate("2026-10-12")).toBe("12/10");
    expect(whatsappUrl("5511987654321")).toBe("https://wa.me/5511987654321");
    expect(summaryText({ open: 3, late: 0, review: 0, done_30d: 4 })).toBe(
      "3 em aberto",
    );
    expect(summaryText({ open: 5, late: 2, review: 1, done_30d: 0 })).toBe(
      "5 em aberto · 2 atrasadas · 1 em validação",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  dueLabel,
  emptyTrail,
  hasRequired,
  itemStates,
  nextInTrail,
  percent,
  requiredSummary,
  trailContentOf,
  type TrailDetail,
  type TrailItem,
} from "./tutorial-trails";

const item = (id: string, extra: Partial<TrailItem> = {}): TrailItem => ({
  tutorial_id: id,
  title: id,
  summary: "",
  modules: [],
  status: "published",
  version: 1,
  aud_all: true,
  visible: true,
  completed_at: null,
  completed_version: null,
  video_count: 0,
  ...extra,
});
const done = (id: string, extra: Partial<TrailItem> = {}) =>
  item(id, { completed_at: "2026-10-05T12:00:00Z", completed_version: 1, ...extra });

describe("itemStates", () => {
  it("ordem livre: o primeiro pendente é o próximo, os outros abertos", () => {
    expect(itemStates({ sequential: false }, [done("a"), item("b"), item("c")])).toEqual([
      "done",
      "next",
      "open",
    ]);
  });
  it("em sequência: depois do próximo, tudo travado (mesmo o que já foi concluído vale)", () => {
    expect(itemStates({ sequential: true }, [done("a"), item("b"), item("c"), done("d")])).toEqual([
      "done",
      "next",
      "locked",
      "done",
    ]);
  });
  it("versão nova depois de concluir: atualizado (continua concluído para liberar)", () => {
    expect(
      itemStates({ sequential: true }, [done("a", { version: 2 }), item("b")]),
    ).toEqual(["updated", "next"]);
  });
  it("o que a pessoa não tem fica de fora da sequência", () => {
    expect(
      itemStates({ sequential: true }, [item("x", { visible: false }), item("a"), item("b")]),
    ).toEqual(["hidden", "next", "locked"]);
  });
});

describe("nextInTrail", () => {
  it("pula os tutoriais que a pessoa não tem", () => {
    const items = [item("a"), item("x", { visible: false }), item("b")];
    expect(nextInTrail(items, "a")?.tutorial_id).toBe("b");
    expect(nextInTrail(items, "b")).toBeNull();
    expect(nextInTrail(items, "fora")).toBeNull();
  });
});

describe("dueLabel", () => {
  const now = new Date("2026-10-05T15:00:00Z"); // 12h em São Paulo
  it("sem prazo", () => expect(dueLabel(null, now)).toBeNull());
  it("em dias corridos, no fuso de São Paulo", () => {
    expect(dueLabel("2026-10-05T23:00:00Z", now)).toEqual({ late: false, text: "vence hoje" });
    expect(dueLabel("2026-10-06T15:00:00Z", now)).toEqual({ late: false, text: "vence amanhã" });
    expect(dueLabel("2026-10-09T15:00:00Z", now)).toEqual({ late: false, text: "vence em 4 dias" });
  });
  it("vencido", () => {
    expect(dueLabel("2026-10-05T14:00:00Z", now)).toEqual({ late: true, text: "atrasada" });
    expect(dueLabel("2026-10-04T14:00:00Z", now)).toEqual({ late: true, text: "atrasada há 1 dia" });
    expect(dueLabel("2026-10-01T14:00:00Z", now)).toEqual({ late: true, text: "atrasada há 4 dias" });
  });
});

describe("obrigatória", () => {
  it("hasRequired: quem entra, todos, papéis, equipes ou pessoas", () => {
    expect(hasRequired(emptyTrail())).toBe(false);
    expect(hasRequired({ ...emptyTrail(), req_newcomers: true })).toBe(true);
    expect(hasRequired({ ...emptyTrail(), req_teams: ["t"] })).toBe(true);
  });
  it("requiredSummary em poucas palavras", () => {
    const data = {
      teams: [{ id: "t", name: "Tráfego" }],
      members: [{ user_id: "u", name: "Ana" }],
    } as Parameters<typeof requiredSummary>[1];
    expect(
      requiredSummary({ ...emptyTrail(), req_newcomers: true, req_teams: ["t"], req_roles: ["member"] }, data),
    ).toBe("quem entrar a partir de agora, colaboradores, equipe Tráfego");
    expect(
      requiredSummary(
        { ...emptyTrail(), req_newcomers: true, req_all: true, req_roles: ["admin"], req_users: ["u"] },
        data,
      ),
    ).toBe("quem entrar a partir de agora, todos da agência, administradores e mais 1");
  });
});

describe("trailContentOf", () => {
  it("leva os tutoriais na ordem e a configuração", () => {
    const d = {
      title: "T",
      summary: "",
      sequential: true,
      due_days: 5,
      items: [item("b"), item("a")],
      config: {
        aud_all: false,
        aud_roles: ["member"],
        aud_teams: [],
        aud_users: [],
        aud_exclude: ["x"],
        req_newcomers: true,
        req_since: "2026-10-05T00:00:00Z",
        req_all: false,
        req_roles: [],
        req_teams: [],
        req_users: [],
      },
    } as unknown as TrailDetail;
    const c = trailContentOf(d);
    expect(c.tutorials).toEqual(["b", "a"]);
    expect(c.sequential).toBe(true);
    expect(c.aud_exclude).toEqual(["x"]);
    expect(c.req_newcomers).toBe(true);
    expect(c.due_days).toBe(5);
  });
  it("percent", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBe(0);
  });
});

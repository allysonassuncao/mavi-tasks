import { describe, expect, it } from "vitest";
import {
  audienceEstimate,
  bannerNotices,
  fromLocalInput,
  fromTemplate,
  matchAudience,
  noticeKey,
  noticePlain,
  plainToRich,
  nextPopup,
  noticeScope,
  toLocalInput,
  unseenCount,
  type LiveNotice,
} from "./notices";
import type { Snapshot } from "./types";

const notice = (over: Partial<LiveNotice>): LiveNotice => ({
  id: "n",
  title: "Aviso",
  body: "",
  level: "info",
  popup: true,
  banner: false,
  pinned: false,
  require_ack: false,
  round: 1,
  publish_at: "2026-09-27T12:00:00Z",
  expires_at: null,
  author_name: "Ana",
  delivered_at: "2026-09-27T12:00:00Z",
  seen_at: null,
  acked_at: null,
  snoozed_until: null,
  banner_closed_at: null,
  attachments: 0,
  ...over,
});

describe("Mural: o que aparece sobre a tela", () => {
  const now = new Date("2026-09-27T15:00:00Z").getTime();

  it("mostra primeiro o popup mais urgente, e só os que faltam", () => {
    const list = [
      notice({ id: "info", delivered_at: "2026-09-27T14:00:00Z" }),
      notice({
        id: "critico",
        level: "critical",
        delivered_at: "2026-09-27T10:00:00Z",
      }),
      notice({
        id: "visto",
        level: "critical",
        seen_at: "2026-09-27T11:00:00Z",
      }),
      notice({ id: "sem-popup", level: "critical", popup: false }),
    ];
    expect(nextPopup(list, now)?.id).toBe("critico");
    expect(nextPopup(list, now, new Set(["critico:1:"]))?.id).toBe("info");
  });

  it("pedindo confirmação: volta até confirmar, respeitando o adiamento", () => {
    const ack = notice({ require_ack: true, seen_at: "2026-09-27T11:00:00Z" });
    expect(nextPopup([ack], now)?.id).toBe("n");
    expect(
      nextPopup([{ ...ack, snoozed_until: "2026-09-28T03:00:00Z" }], now),
    ).toBeNull();
    expect(
      nextPopup([{ ...ack, snoozed_until: "2026-09-27T03:00:00Z" }], now)?.id,
    ).toBe("n");
    expect(
      nextPopup([{ ...ack, acked_at: "2026-09-27T12:00:00Z" }], now),
    ).toBeNull();
  });

  it("faixas: as não fechadas, as urgentes primeiro, até três", () => {
    const list = ["a", "b", "c", "d"].map((id, i) =>
      notice({ id, banner: true, level: i === 3 ? "critical" : "info" }),
    );
    list.push(notice({ id: "fechada", banner: true, banner_closed_at: "x" }));
    const shown = bannerNotices(list);
    expect(shown.map((n) => n.id)).toEqual(["d", "a", "b"]);
    expect(unseenCount(list)).toBe(5);
  });
});

const data = {
  members: [
    { user_id: "adm", name: "Adm", role: "admin", active: true },
    { user_id: "ges", name: "Gestora", role: "manager", active: true },
    { user_id: "ana", name: "Ana", role: "member", active: true },
    { user_id: "caio", name: "Caio", role: "member", active: true },
    { user_id: "velho", name: "Inativo", role: "member", active: false },
  ],
  teams: [
    { id: "criacao", name: "Criação" },
    { id: "midia", name: "Mídia" },
  ],
  teamMembers: [
    { team_id: "criacao", user_id: "ges" },
    { team_id: "criacao", user_id: "ana" },
    { team_id: "criacao", user_id: "velho" },
    { team_id: "midia", user_id: "caio" },
  ],
  clients: [
    { id: "sorriso", name: "Sorriso", archived: false },
    { id: "luz", name: "Luz", archived: false },
  ],
  clientTeams: [
    { client_id: "sorriso", team_id: "criacao" },
    { client_id: "luz", team_id: "midia" },
  ],
  contracts: [
    { id: "k1", client_id: "sorriso" },
    { id: "k2", client_id: "luz" },
  ],
  projects: [
    { id: "p1", contract_id: "k1", name: "Verão", archived: false },
    { id: "p2", contract_id: "k2", name: "Coleção", archived: false },
  ],
} as unknown as Snapshot;

describe("Mural: público", () => {
  it("o gestor escolhe só dentro das equipes dele; o administrador, tudo", () => {
    const g = noticeScope(data, "ges");
    expect(g.everyone).toBe(false);
    expect(g.teams).toEqual(["criacao"]);
    expect(g.users.sort()).toEqual(["ana", "ges"]);
    expect(g.clients).toEqual(["sorriso"]);
    expect(g.projects).toEqual(["p1"]);
    const a = noticeScope(data, "adm");
    expect(a.everyone).toBe(true);
    expect(a.users).not.toContain("velho");
    expect(a.projects).toEqual(["p1", "p2"]);
  });

  it("estima quantas pessoas recebem, sem quem cria, excluídos e inativos", () => {
    expect(
      audienceEstimate(
        { targets: [{ kind: "everyone" }], exclude: ["caio"] },
        data,
        "adm",
      ),
    ).toEqual({ people: 2, assignees: false });
    expect(
      audienceEstimate(
        { targets: [{ kind: "project", id: "p1", mode: "both" }], exclude: [] },
        data,
        "adm",
      ),
    ).toEqual({ people: 2, assignees: true });
    expect(
      audienceEstimate(
        {
          targets: [{ kind: "client", id: "luz", mode: "assignees" }],
          exclude: [],
        },
        data,
        "adm",
      ),
    ).toEqual({ people: 0, assignees: true });
  });

  it("a data do campo vai e volta no fuso de quem está usando", () => {
    const iso = fromLocalInput("2026-10-02T09:30");
    expect(toLocalInput(iso)).toBe("2026-10-02T09:30");
    expect(fromLocalInput("")).toBe("");
    expect(toLocalInput("")).toBe("");
  });
});

describe("Mural: fase 2", () => {
  it("uma cobrança faz o popup dispensado voltar", () => {
    const n = notice({
      id: "x",
      require_ack: true,
      seen_at: "2026-09-27T11:00:00Z",
    });
    const dismissed = new Set([noticeKey(n)]);
    expect(nextPopup([n], Date.now(), dismissed)).toBeNull();
    expect(
      nextPopup(
        [{ ...n, reminded_at: "2026-09-27T16:00:00Z" }],
        Date.now(),
        dismissed,
      )?.id,
    ).toBe("x");
  });

  it("o texto da MAVI vira texto rico e volta igual (parágrafos e listas)", () => {
    const text =
      "Sexta não teremos expediente.\n\n- Voltamos na segunda\n- Plantão por WhatsApp\n\n1. Salve o trabalho\n2. Desligue o computador";
    const rich = plainToRich(text);
    expect(rich.startsWith("mavi:richtext:v1:")).toBe(true);
    expect(noticePlain(rich)).toBe(
      "Sexta não teremos expediente.\n- Voltamos na segunda\n- Plantão por WhatsApp\n1. Salve o trabalho\n2. Desligue o computador",
    );
    expect(plainToRich("   ")).toBe("");
  });

  it("o público citado pela MAVI vira alvos só dentro do escopo, sem acento", () => {
    const scope = noticeScope(data, "ges");
    const { targets, missing } = matchAudience(
      [
        { kind: "client", name: "sorriso", mode: "teams" },
        { kind: "team", name: "Criacao" },
        { kind: "client", name: "Luz" },
        { kind: "everyone", name: "" },
        { kind: "user", name: "Caio" },
      ],
      data,
      scope,
    );
    expect(targets).toEqual([
      { kind: "client", id: "sorriso", mode: "teams" },
      { kind: "team", id: "criacao" },
    ]);
    expect(missing).toEqual(["Luz", "todos da agência", "Caio"]);
  });

  it("um modelo incompleto abre com os formatos do nível", () => {
    const c = fromTemplate({ title: "Novidades", level: "critical" });
    expect(c.popup && c.push && c.inbox).toBe(true);
    expect(c.publish_at).toBe("");
    expect(fromTemplate({ repeat: "hourly" as never }).repeat).toBe("");
  });
});

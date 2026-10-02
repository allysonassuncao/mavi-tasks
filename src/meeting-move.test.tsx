import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingMoveDialog, driveReadableClients } from "./MeetingMoveDialog";
import { emptySnapshot, type Snapshot } from "./types";

const A = "empresa";
const client = (id: string, name: string, archived = false) => ({
  id,
  company_id: A,
  name,
  email: "",
  color: "",
  archived,
});
const data: Snapshot = {
  ...emptySnapshot,
  clients: [
    client("errado", "4282"),
    client("certo", "9001"),
    client("outro", "1234"),
    client("antigo", "7777", true),
  ],
  teamMembers: [
    { company_id: A, team_id: "t1", user_id: "bruno" },
    { company_id: A, team_id: "t2", user_id: "bruno" },
  ],
  clientTeams: [
    { company_id: A, client_id: "errado", team_id: "t1" },
    { company_id: A, client_id: "certo", team_id: "t2" },
    { company_id: A, client_id: "antigo", team_id: "t2" },
  ],
};

describe("mover gravações para outro cliente", () => {
  it("só os clientes que a pessoa vê no Drive (líderes veem todos)", () => {
    const ids = (user: string, leader: boolean) =>
      driveReadableClients(data, user, leader).map((c) => c.id);
    expect(ids("bruno", false)).toEqual(["errado", "certo", "antigo"]);
    expect(ids("davi", false)).toEqual([]);
    expect(ids("davi", true)).toEqual(["errado", "certo", "outro", "antigo"]);
  });

  it("a escolha lista os outros clientes ativos que a pessoa atende", () => {
    const html = renderToStaticMarkup(
      <MeetingMoveDialog
        company={A}
        data={data}
        user="bruno"
        isLeader={false}
        from="errado"
        recordings={["r1", "r2"]}
        label="2 gravações"
        onClose={() => {}}
        onMoved={() => {}}
      />,
    );
    expect(html).toContain("Mover 2 gravações");
    const names = [...html.matchAll(/role="option"[^>]*>.*?<\/svg><span>([^<]+)</g)].map(
      (m) => m[1],
    );
    // Nem o de origem, nem o arquivado, nem o que ele não atende.
    expect(names).toEqual(["9001"]);
    expect(html).toContain("Escolha o cliente certo");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Mover para o cliente/);
  });

  it("sem outro cliente, explica por que não há para onde mover", () => {
    const html = renderToStaticMarkup(
      <MeetingMoveDialog
        company={A}
        data={data}
        user="bruno"
        isLeader={false}
        from="certo"
        recordings={["r1"]}
        label="“Alinhamento”"
        onClose={() => {}}
        onMoved={() => {}}
      />,
    );
    const names = [...html.matchAll(/role="option"[^>]*>.*?<\/svg><span>([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(names).toEqual(["4282"]);
  });
});

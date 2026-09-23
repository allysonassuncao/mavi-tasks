import { describe, it, expect, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: null }));
const { applyScope } = await import("./api");
const { taskScope, myTeams } = await import("./domain");
const { demoSnapshot } = await import("./demo");
import type { Snapshot, Task } from "./types";

const ME = "me";
function world(): Snapshot {
  const data = demoSnapshot();
  data.teamMembers = [
    { company_id: "c", team_id: "t-mine", user_id: ME, supervisor: false },
    { company_id: "c", team_id: "t-other", user_id: "x", supervisor: false },
  ];
  data.clientTeams = [
    { company_id: "c", client_id: data.clients[0].id, team_id: "t-mine" },
  ];
  return data;
}
const task = (data: Snapshot, over: Partial<Task>): Task => ({
  ...data.tasks[0],
  creator_id: "x",
  assignee_id: "y",
  team_id: null,
  ...over,
});

describe("De quem é a tarefa (abas da lista)", () => {
  const data = world();
  const mine = myTeams(data, ME);
  const clientOf = (i: number) =>
    data.contracts.find((k) => k.client_id === data.clients[i].id)!.id;
  it("classifica cada tarefa em uma única aba", () => {
    expect(
      taskScope(
        data,
        task(data, { assignee_id: ME, creator_id: ME }),
        ME,
        mine,
      ),
    ).toBe("mine");
    expect(taskScope(data, task(data, { creator_id: ME }), ME, mine)).toBe(
      "created",
    );
    expect(taskScope(data, task(data, { team_id: "t-mine" }), ME, mine)).toBe(
      "teams",
    );
    // Sem equipe na tarefa: vale a equipe do cliente.
    expect(
      taskScope(data, task(data, { contract_id: clientOf(0) }), ME, mine),
    ).toBe("teams");
    expect(taskScope(data, task(data, { team_id: "t-other" }), ME, mine)).toBe(
      "others",
    );
    expect(
      taskScope(data, task(data, { contract_id: clientOf(1) }), ME, mine),
    ).toBe("others");
    // Quem já foi responsável ou foi mencionado: "Participando".
    expect(
      taskScope(
        data,
        task(data, { team_id: "t-mine", participant_ids: ["y", ME] }),
        ME,
        mine,
      ),
    ).toBe("participating");
    expect(
      taskScope(
        data,
        task(data, { creator_id: ME, participant_ids: [ME] }),
        ME,
        mine,
      ),
    ).toBe("created");
  });

  // A tiny query builder that records the PostgREST filters.
  function recorder() {
    const calls: string[] = [];
    const q = {
      eq: (c: string, v: string) => (calls.push(`${c}=eq.${v}`), q),
      neq: (c: string, v: string) => (calls.push(`${c}=neq.${v}`), q),
      or: (f: string) => (calls.push(`or=(${f})`), q),
      contains: (c: string, v: string[]) => (
        calls.push(`${c}=cs.{${v.join(",")}}`),
        q
      ),
      not: (c: string, op: string, v: string) => (
        calls.push(`${c}=not.${op}.${v}`),
        q
      ),
    };
    return { q, calls };
  }
  const lookups = {
    contracts: data.contracts,
    clients: data.clients,
    projects: data.projects,
    teamMembers: data.teamMembers,
    clientTeams: data.clientTeams,
  };
  const contractsOfMyClient = data.contracts
    .filter((k) => k.client_id === data.clients[0].id)
    .map((k) => k.id)
    .join(",");
  it("monta no servidor os mesmos critérios", () => {
    const f = (scope: Parameters<typeof applyScope>[1]) => {
      const r = recorder();
      applyScope(r.q, scope, ME, lookups);
      return r.calls;
    };
    expect(f("mine")).toEqual(["assignee_id=eq.me"]);
    expect(f("created")).toEqual(["creator_id=eq.me", "assignee_id=neq.me"]);
    expect(f("participating")).toEqual([
      "assignee_id=neq.me",
      "creator_id=neq.me",
      "participant_ids=cs.{me}",
    ]);
    expect(f("teams")).toEqual([
      "assignee_id=neq.me",
      "creator_id=neq.me",
      "participant_ids=not.cs.{me}",
      `or=(team_id.in.(t-mine),and(team_id.is.null,contract_id.in.(${contractsOfMyClient})))`,
    ]);
    expect(f("others")).toEqual([
      "assignee_id=neq.me",
      "creator_id=neq.me",
      "participant_ids=not.cs.{me}",
      `or=(and(team_id.not.is.null,team_id.not.in.(t-mine)),and(team_id.is.null,contract_id.not.in.(${contractsOfMyClient})))`,
    ]);
  });
  it("sem equipe, 'Suas equipes' fica vazia e 'Outras' é todo o resto", () => {
    const r = recorder();
    applyScope(r.q, "teams", "sem-equipe", lookups);
    expect(r.calls.at(-1)).toBe("id=eq.00000000-0000-0000-0000-000000000000");
    const o = recorder();
    applyScope(o.q, "others", "sem-equipe", lookups);
    expect(o.calls.at(-1)).toBe("or=(team_id.not.is.null,team_id.is.null)");
  });
});

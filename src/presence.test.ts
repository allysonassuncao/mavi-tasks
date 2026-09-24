import { describe, it, expect } from "vitest";
import { presentMembers, summarizePresence } from "./presence";
import type { Member } from "./types";

const member = (user_id: string, name: string, active = true): Member => ({
  company_id: "c1",
  user_id,
  name,
  role: "member",
  active,
});

describe("Quem está online", () => {
  it("junta as abas da mesma pessoa: online se alguma está em uso", () => {
    const p = summarizePresence({
      u1: [
        { state: "away", online_at: "2026-09-24T10:00:00Z" },
        { state: "online", online_at: "2026-09-24T09:30:00Z" },
      ],
      u2: [{ state: "away", online_at: "2026-09-24T11:00:00Z" }],
      u3: [],
    });
    expect(p.get("u1")).toEqual({
      state: "online",
      since: "2026-09-24T09:30:00Z",
    });
    expect(p.get("u2")?.state).toBe("away");
    expect(p.has("u3")).toBe(false);
  });

  it("lista só membros ativos, online primeiro e por nome", () => {
    const members = [
      member("u1", "Carla"),
      member("u2", "Bruno"),
      member("u3", "Ana"),
      member("u4", "Davi", false),
      member("u5", "Elis"),
    ];
    const presence = summarizePresence({
      u1: [{ state: "online" }],
      u2: [{ state: "away" }],
      u3: [{ state: "online" }],
      u4: [{ state: "online" }],
      // Someone not (or no longer) in the company.
      x9: [{ state: "online" }],
    });
    expect(presentMembers(members, presence).map((p) => p.member.name)).toEqual(
      ["Ana", "Carla", "Bruno"],
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSupabase = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
  },
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  functions: {
    invoke: vi
      .fn()
      .mockResolvedValue({ data: { user_id: "usr_fallback" }, error: null }),
  },
}));

vi.mock("./supabase", () => ({
  supabase: mockSupabase,
}));

import { DemoStore } from "./demo-store";
import { inviteUser } from "./api";
import * as cache from "./cache";

describe("Inclusão de novos usuários", () => {
  describe("Modo Demonstração (DemoStore)", () => {
    it("inclui novo usuário como colaborador e vincula equipes", () => {
      const store = new DemoStore();
      const initialCount = store.data.members.length;

      const userId = store.mutate("invite_user", {
        p_name: "Mariana Souza",
        p_role: "member",
        p_company: "1",
        p_teams: ["team-1", "team-2"],
      });

      expect(typeof userId).toBe("string");
      expect(store.data.members.length).toBe(initialCount + 1);

      const created = store.data.members.find(
        (m) => m.name === "Mariana Souza",
      );
      expect(created).toBeDefined();
      expect(created?.role).toBe("member");
      expect(created?.active).toBe(true);

      const userTeams = store.data.teamMembers.filter(
        (tm) => tm.user_id === created?.user_id,
      );
      expect(userTeams.length).toBe(2);
      expect(userTeams.map((t) => t.team_id)).toEqual(["team-1", "team-2"]);
    });

    it("inclui novo usuário sem equipes vinculadas quando a lista for vazia", () => {
      const store = new DemoStore();
      const initialTeamMembers = store.data.teamMembers.length;

      const userId = store.mutate("invite_user", {
        p_name: "Carlos Gestor",
        p_role: "manager",
        p_company: "1",
        p_teams: [],
      });

      expect(typeof userId).toBe("string");
      const created = store.data.members.find(
        (m) => m.name === "Carlos Gestor",
      );
      expect(created).toBeDefined();
      expect(created?.role).toBe("manager");
      expect(store.data.teamMembers.length).toBe(initialTeamMembers);
    });
  });

  describe("API Client (inviteUser)", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.clearAllMocks();
      mockSupabase.rpc.mockResolvedValue({ data: null, error: null });
      mockSupabase.auth.getSession.mockResolvedValue({
        data: { session: null },
      });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("chama o endpoint /api/invite-user e atribui equipes via RPC", async () => {
      const invalidateSpy = vi.spyOn(cache, "invalidate");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ user_id: "usr_abc123" }),
      } as unknown as Response);

      const res = await inviteUser(
        "comp-1",
        "novo@empresa.com",
        "Novo Colaborador",
        "member",
        ["team-a"],
      );

      expect(res.user_id).toBe("usr_abc123");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/invite-user",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            company_id: "comp-1",
            email: "novo@empresa.com",
            name: "Novo Colaborador",
            role: "member",
          }),
        }),
      );

      expect(mockSupabase.rpc).toHaveBeenCalledWith("assign_user_teams", {
        p_company: "comp-1",
        p_user: "usr_abc123",
        p_teams: ["team-a"],
      });

      expect(invalidateSpy).toHaveBeenCalled();
    });

    it("não executa assign_user_teams se nenhuma equipe for selecionada", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ user_id: "usr_abc123" }),
      } as unknown as Response);

      await inviteUser(
        "comp-1",
        "novo@empresa.com",
        "Novo Colaborador",
        "member",
        [],
      );

      expect(mockSupabase.rpc).not.toHaveBeenCalled();
    });

    it("recorre ao Supabase Edge Function se o endpoint local retornar 404", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response);

      mockSupabase.functions.invoke.mockResolvedValue({
        data: { user_id: "usr_edge_fallback" },
        error: null,
      });

      const res = await inviteUser(
        "comp-1",
        "novo@empresa.com",
        "Fallback User",
        "admin",
      );

      expect(res.user_id).toBe("usr_edge_fallback");
      expect(mockSupabase.functions.invoke).toHaveBeenCalledWith(
        "invite-user",
        {
          body: {
            company_id: "comp-1",
            email: "novo@empresa.com",
            name: "Fallback User",
            role: "admin",
          },
        },
      );
    });

    it("lança erro amigável se a requisição falhar com limite ou permissão", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: "Limite de 10 convites por hora atingido.",
        }),
      } as unknown as Response);

      await expect(
        inviteUser("comp-1", "novo@empresa.com", "Novo Colaborador", "member"),
      ).rejects.toThrow("Limite de 10 convites por hora atingido.");
    });
  });
});

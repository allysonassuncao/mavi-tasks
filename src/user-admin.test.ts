import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSupabase = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
  },
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  functions: {
    invoke: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
  },
}));

vi.mock("./supabase", () => ({
  supabase: mockSupabase,
}));

import { DemoStore } from "./demo-store";
import { resetUserPassword, updateUserEmail } from "./api";
import * as cache from "./cache";

describe("Gerenciamento Administrativo de Usuários (Reset de Senha e E-mail)", () => {
  describe("Modo Demonstração (DemoStore)", () => {
    it("simula envio de link de recuperação de senha", () => {
      const store = new DemoStore();
      const member = store.data.members[0];

      const res = store.mutate("reset_password", {
        p_user: member.user_id,
        p_mode: "send_link",
      }) as { success: boolean; link?: string };

      expect(res.success).toBe(true);
      expect(res.link).toBeDefined();
    });

    it("simula redefinição de senha manual diretamente", () => {
      const store = new DemoStore();
      const member = store.data.members[0];

      const res = store.mutate("reset_password", {
        p_user: member.user_id,
        p_mode: "set_password",
        p_new_password: "minhaNovaSenhaForte",
      }) as { success: boolean };

      expect(res.success).toBe(true);
    });

    it("rejeita senha curta no DemoStore", () => {
      const store = new DemoStore();
      const member = store.data.members[0];

      expect(() =>
        store.mutate("reset_password", {
          p_user: member.user_id,
          p_mode: "set_password",
          p_new_password: "123",
        }),
      ).toThrow("mínimo 8 caracteres");
    });

    it("atualiza o e-mail do colaborador em memória", () => {
      const store = new DemoStore();
      const member = store.data.members[1];

      store.mutate("update_user_email", {
        p_user: member.user_id,
        p_new_email: "marina.nova@empresa.com",
      });

      const updated = store.data.members.find(
        (m) => m.user_id === member.user_id,
      );
      expect(updated?.email).toBe("marina.nova@empresa.com");
    });

    it("rejeita e-mail inválido no DemoStore", () => {
      const store = new DemoStore();
      const member = store.data.members[0];

      expect(() =>
        store.mutate("update_user_email", {
          p_user: member.user_id,
          p_new_email: "invalido",
        }),
      ).toThrow("e-mail válido");
    });
  });

  describe("API Client (resetUserPassword & updateUserEmail)", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.clearAllMocks();
      mockSupabase.auth.getSession.mockResolvedValue({
        data: { session: null },
      });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("chama /api/user-admin para resetar senha", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          link: "https://auth.example.com/recuperar",
        }),
      } as unknown as Response);

      const res = await resetUserPassword("comp-1", "user-1", "send_link");

      expect(res.success).toBe(true);
      expect(res.link).toBe("https://auth.example.com/recuperar");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/user-admin",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            company_id: "comp-1",
            target_user_id: "user-1",
            action: "reset_password",
            mode: "send_link",
          }),
        }),
      );
    });

    it("chama /api/user-admin para atualizar e-mail e invalida o cache", async () => {
      const invalidateSpy = vi.spyOn(cache, "invalidate");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          email: "novo@empresa.com",
        }),
      } as unknown as Response);

      const res = await updateUserEmail("comp-1", "user-1", "novo@empresa.com");

      expect(res.success).toBe(true);
      expect(res.email).toBe("novo@empresa.com");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/user-admin",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            company_id: "comp-1",
            target_user_id: "user-1",
            action: "update_email",
            new_email: "novo@empresa.com",
          }),
        }),
      );
      expect(invalidateSpy).toHaveBeenCalled();
    });

    it("recorre ao Supabase Edge Function se o proxy retornar 404", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response);

      mockSupabase.functions.invoke.mockResolvedValue({
        data: { success: true, email: "fallback@empresa.com" },
        error: null,
      });

      const res = await updateUserEmail(
        "comp-1",
        "user-1",
        "fallback@empresa.com",
      );

      expect(res.success).toBe(true);
      expect(mockSupabase.functions.invoke).toHaveBeenCalledWith("user-admin", {
        body: {
          company_id: "comp-1",
          target_user_id: "user-1",
          action: "update_email",
          new_email: "fallback@empresa.com",
        },
      });
    });

    it("propaga mensagem de erro caso ocorra falha na requisição", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "E-mail já está em uso por outra conta." }),
      } as unknown as Response);

      await expect(
        updateUserEmail("comp-1", "user-1", "existente@empresa.com"),
      ).rejects.toThrow("E-mail já está em uso");
    });
  });
});

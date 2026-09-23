import { describe, expect, it, vi } from "vitest";
import { createInviteHandler } from "./invite-user/handler";
import { createReconcileHandler } from "./storage-reconcile/handler";
import { createUserAdminHandler } from "./user-admin/handler";
import { createGcsStorageHandler } from "./gcs-storage/handler";

const origin = "https://app.example.com";
const payload = {
  company_id: "00000000-0000-4000-8000-000000000001",
  email: "person@example.com",
  name: "Pessoa",
  role: "member",
};
function inviteRequest(
  options: {
    origin?: string | null;
    token?: string | null;
    method?: string;
    body?: string;
  } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.origin !== null) headers.set("Origin", options.origin ?? origin);
  if (options.token !== null)
    headers.set("Authorization", options.token ?? "Bearer user-token");
  const method = options.method ?? "POST";
  return new Request(origin, {
    method,
    headers,
    ...(method === "POST"
      ? { body: options.body ?? JSON.stringify(payload) }
      : {}),
  });
}
function inviteFixture() {
  const single = vi
    .fn()
    .mockResolvedValue({ data: { role: "admin", active: true }, error: null });
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single,
    insert: vi.fn().mockResolvedValue({ error: null }),
  };
  const admin = {
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "admin" } }, error: null }),
      admin: {
        inviteUserByEmail: vi.fn().mockResolvedValue({
          data: { user: { id: "invited" } },
          error: null,
        }),
      },
    },
    from: vi.fn().mockReturnValue(chain),
    rpc: vi.fn().mockResolvedValue({
      data: { allowed: true, retry_after: 0 },
      error: null,
    }),
  };
  const handler = createInviteHandler(origin, () => admin as never);
  return { admin, handler, single, chain };
}
describe("invite-user", () => {
  it.each([null, "https://evil.example.com", "null"])(
    "rejects absent or unauthorized Origin: %s",
    async (requestOrigin) => {
      const { handler, admin } = inviteFixture();
      expect(
        (await handler(inviteRequest({ origin: requestOrigin }))).status,
      ).toBe(403);
      expect(admin.auth.getUser).not.toHaveBeenCalled();
    },
  );
  it("accepts only matching preflight and never sends an invite", async () => {
    const { handler, admin } = inviteFixture();
    const response = await handler(
      inviteRequest({ method: "OPTIONS", token: null }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
  it("accepts an explicit second origin, reflects it and keeps the redirect on that origin", async () => {
    const { admin } = inviteFixture();
    const second = "https://second.example.com";
    const handler = createInviteHandler(origin, () => admin as never, [second]);
    const response = await handler(inviteRequest({ origin: second }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(second);
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledWith(
      payload.email,
      {
        redirectTo: second + "/?setup=1",
        data: { name: payload.name },
      },
    );
    expect(
      (
        await handler(
          inviteRequest({ origin: "https://second.example.com.evil.test" }),
        )
      ).status,
    ).toBe(403);
  });
  it("fails closed without configuration", async () => {
    expect(
      (
        await createInviteHandler("", () => {
          throw Error();
        })(inviteRequest())
      ).status,
    ).toBe(503);
  });
  it("requires JWT even with a forged matching origin", async () => {
    const { handler, admin } = inviteFixture();
    expect((await handler(inviteRequest({ token: null }))).status).toBe(401);
    admin.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: {},
    } as never);
    expect((await handler(inviteRequest())).status).toBe(401);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
  it("rejects malformed body and non-admin before quota/send", async () => {
    const { handler, admin, single } = inviteFixture();
    expect((await handler(inviteRequest({ body: "{" }))).status).toBe(400);
    expect((await handler(inviteRequest({ body: "null" }))).status).toBe(400);
    single.mockResolvedValue({
      data: { role: "member", active: true },
      error: null,
    });
    expect((await handler(inviteRequest())).status).toBe(403);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
  it("explains why the invite email was not sent", async () => {
    const { handler, admin, chain } = inviteFixture();
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: {
        status: 400,
        code: "email_address_not_authorized",
        message: "Email address not authorized",
      },
    });
    const response = await handler(inviteRequest());
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("SMTP próprio");
    expect(chain.insert).not.toHaveBeenCalled();
  });
  it("allows managers to invite users", async () => {
    const { handler, admin, single } = inviteFixture();
    single.mockResolvedValue({
      data: { role: "manager", active: true },
      error: null,
    });
    const response = await handler(inviteRequest());
    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalled();
  });
  it("blocks send on quota exhaustion and exposes Retry-After", async () => {
    const { handler, admin } = inviteFixture();
    admin.rpc.mockResolvedValue({
      data: { allowed: false, retry_after: 123 },
      error: null,
    });
    const response = await handler(inviteRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("123");
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("fails closed if quota database fails", async () => {
    const { handler, admin } = inviteFixture();
    admin.rpc.mockResolvedValue({ data: null, error: {} } as never);
    expect((await handler(inviteRequest())).status).toBe(503);
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("consumes quota before inviting and reports partial membership failure", async () => {
    const { handler, admin, chain } = inviteFixture();
    chain.insert.mockResolvedValue({ error: {} } as never);
    expect((await handler(inviteRequest())).status).toBe(409);
    expect(admin.rpc).toHaveBeenCalledWith("consume_invite_limit", {
      p_company: payload.company_id,
      p_actor: "admin",
    });
    expect(admin.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      admin.auth.admin.inviteUserByEmail.mock.invocationCallOrder[0],
    );
  });
});

describe("storage-reconcile", () => {
  const secret = "a-secret-for-tests-with-at-least-32-characters";
  function fixture() {
    const remove = vi.fn().mockResolvedValue({ error: null });
    const admin = {
      rpc: vi.fn().mockImplementation(async (name: string) =>
        name === "claim_storage_cleanup"
          ? {
              data: [{ bucket_id: "mavi-inline-images", path: "old/image" }],
              error: null,
            }
          : { data: null, error: null },
      ),
      storage: { from: vi.fn().mockReturnValue({ remove }) },
    };
    return {
      admin,
      remove,
      handler: createReconcileHandler(secret, () => admin as never),
    };
  }
  const request = (token = secret) =>
    new Request(origin, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  it("requires the dedicated scheduler secret", async () => {
    const { handler, admin } = fixture();
    expect((await handler(request("user-jwt"))).status).toBe(401);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
  it("removes through Storage API before completing queue entries", async () => {
    const { handler, admin, remove } = fixture();
    expect((await handler(request())).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(["old/image"]);
    expect(admin.rpc).toHaveBeenLastCalledWith("complete_storage_cleanup", {
      p_bucket: "mavi-inline-images",
      p_paths: ["old/image"],
    });
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      admin.rpc.mock.invocationCallOrder[1],
    );
  });
  it("preserves pending queue entries on Storage failure", async () => {
    const { handler, admin, remove } = fixture();
    remove.mockResolvedValue({ error: {} } as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await handler(request())).status).toBe(500);
      expect(admin.rpc).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});

describe("user-admin", () => {
  const companyId = "00000000-0000-4000-8000-000000000001";
  const targetUserId = "00000000-0000-4000-8000-000000000002";

  function userAdminFixture(
    options: {
      callerRole?: string;
      callerActive?: boolean;
      targetFound?: boolean;
    } = {},
  ) {
    const {
      callerRole = "admin",
      callerActive = true,
      targetFound = true,
    } = options;

    const callerMembership = { role: callerRole, active: callerActive };
    const targetMembership = targetFound
      ? {
          user_id: targetUserId,
          name: "Colaborador Alvo",
          email: "target@example.com",
          role: "member",
          active: true,
        }
      : null;

    let eqCount = 0;
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockImplementation(() => {
        eqCount++;
        return chain;
      }),
      single: vi.fn().mockImplementation(() => {
        // First single call is for caller membership, second is for target
        if (eqCount <= 2) {
          return Promise.resolve({ data: callerMembership, error: null });
        }
        return Promise.resolve({
          data: targetMembership,
          error: targetMembership ? null : { message: "Not found" },
        });
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }),
    };

    const admin = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "caller-admin" } },
          error: null,
        }),
        resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
        admin: {
          updateUserById: vi.fn().mockResolvedValue({ data: {}, error: null }),
          generateLink: vi.fn().mockResolvedValue({
            data: {
              properties: { action_link: "https://auth.example.com/link" },
            },
            error: null,
          }),
          getUserById: vi.fn().mockResolvedValue({
            data: { user: { email: "target@example.com" } },
            error: null,
          }),
        },
      },
      from: vi.fn().mockReturnValue(chain),
    };

    const handler = createUserAdminHandler(origin, () => admin as never);
    return { admin, handler, chain };
  }

  function userAdminRequest(
    body: Record<string, unknown>,
    token = "Bearer admin-token",
  ) {
    return new Request(origin, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("bloqueia chamadas de não-administradores", async () => {
    const { handler } = userAdminFixture({ callerRole: "member" });
    const res = await handler(
      userAdminRequest({
        company_id: companyId,
        target_user_id: targetUserId,
        action: "reset_password",
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Somente administradores");
  });

  it("permite gestores resetarem senha", async () => {
    const { handler } = userAdminFixture({ callerRole: "manager" });
    const res = await handler(
      userAdminRequest({
        company_id: companyId,
        target_user_id: targetUserId,
        action: "reset_password",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("retorna 404 se o usuário alvo não pertencer à empresa", async () => {
    const { handler } = userAdminFixture({ targetFound: false });
    const res = await handler(
      userAdminRequest({
        company_id: companyId,
        target_user_id: targetUserId,
        action: "reset_password",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("envia o e-mail de recuperação no modo send_link, sem gerar link antes", async () => {
    const { handler, admin } = userAdminFixture();
    const res = await handler(
      userAdminRequest({
        company_id: companyId,
        target_user_id: targetUserId,
        action: "reset_password",
        mode: "send_link",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("target@example.com");
    expect(admin.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      "target@example.com",
      expect.objectContaining({ redirectTo: `${origin}/?reset=1` }),
    );
    // Generating a link first made Supabase refuse the email for 60s.
    expect(admin.auth.admin.generateLink).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        status: 429,
        code: "over_email_send_rate_limit",
        message: "email rate limit exceeded",
      },
      429,
      "limite de envio",
    ],
    [
      {
        status: 400,
        code: "email_address_not_authorized",
        message: "Email address not authorized",
      },
      422,
      "SMTP próprio",
    ],
    [
      { status: 500, message: "Error sending recovery email" },
      502,
      "SMTP configurado",
    ],
  ])(
    "não diz que enviou quando o e-mail falha: %o",
    async (error, status, text) => {
      const { handler, admin } = userAdminFixture();
      admin.auth.resetPasswordForEmail.mockResolvedValue({ error });
      const res = await handler(
        userAdminRequest({
          company_id: companyId,
          target_user_id: targetUserId,
          action: "reset_password",
          mode: "send_link",
        }),
      );
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.success).toBeUndefined();
      expect(body.error).toContain(text);
    },
  );

  it("atualiza a senha diretamente no modo set_password", async () => {
    const { handler, admin } = userAdminFixture();
    const res = await handler(
      userAdminRequest({
        company_id: companyId,
        target_user_id: targetUserId,
        action: "reset_password",
        mode: "set_password",
        new_password: "novaSenhaSegura123",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(targetUserId, {
      password: "novaSenhaSegura123",
    });
  });

  it("rejeita senha com menos de 8 caracteres no modo set_password", async () => {
    const { handler } = userAdminFixture();
    const res = await handler(
      userAdminRequest({
        company_id: companyId,
        target_user_id: targetUserId,
        action: "reset_password",
        mode: "set_password",
        new_password: "123",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mínimo 8 caracteres");
  });

  it("atualiza o e-mail no auth e na tabela memberships", async () => {
    const { handler, admin, chain } = userAdminFixture();
    const res = await handler(
      userAdminRequest({
        company_id: companyId,
        target_user_id: targetUserId,
        action: "update_email",
        new_email: "novo.email@example.com",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.email).toBe("novo.email@example.com");
    expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(targetUserId, {
      email: "novo.email@example.com",
      email_confirm: true,
    });
    expect(chain.update).toHaveBeenCalledWith({
      email: "novo.email@example.com",
    });
  });

  it("rejeita e-mail em formato inválido", async () => {
    const { handler } = userAdminFixture();
    const res = await handler(
      userAdminRequest({
        company_id: companyId,
        target_user_id: targetUserId,
        action: "update_email",
        new_email: "email-invalido",
      }),
    );
    expect(res.status).toBe(400);
  });

  describe("sync_access", () => {
    async function sync(
      memberships: { active: boolean }[],
      callerRole = "admin",
    ) {
      const fixture = userAdminFixture({ callerRole });
      // The memberships list query is awaited directly (no .single()).
      Object.assign(fixture.chain, {
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: memberships, error: null }),
      });
      const res = await fixture.handler(
        userAdminRequest({
          company_id: companyId,
          target_user_id: targetUserId,
          action: "sync_access",
        }),
      );
      return { ...fixture, res };
    }
    it("bloqueia o login de quem ficou sem nenhum vínculo ativo", async () => {
      const { admin, res } = await sync([{ active: false }]);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ active: false });
      expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(
        targetUserId,
        { ban_duration: "876000h" },
      );
    });
    it("libera o login quando ainda há um vínculo ativo", async () => {
      const { admin, res } = await sync([{ active: false }, { active: true }]);
      expect(await res.json()).toMatchObject({ active: true });
      expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(
        targetUserId,
        { ban_duration: "none" },
      );
    });
    it("gestores também sincronizam, colaboradores não", async () => {
      expect((await sync([{ active: false }], "manager")).res.status).toBe(200);
      const member = await sync([{ active: false }], "member");
      expect(member.res.status).toBe(403);
      expect(member.admin.auth.admin.updateUserById).not.toHaveBeenCalled();
    });
  });
});

describe("gcs-storage (desativada)", () => {
  it("recusa assinar uploads, mesmo com sessão", async () => {
    const res = await createGcsStorageHandler(origin)(
      new Request(origin, {
        method: "POST",
        headers: { Authorization: "Bearer user-token", Origin: origin },
        body: JSON.stringify({
          path: "empresa/tarefa/arquivo",
          contentType: "text/html",
        }),
      }),
    );
    expect(res.status).toBe(410);
    expect(await res.json()).not.toHaveProperty("url");
  });
});

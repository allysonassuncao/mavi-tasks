import { describe, expect, it, vi } from "vitest";
import { createInviteHandler } from "./invite-user/handler";
import { createReconcileHandler } from "./storage-reconcile/handler";

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

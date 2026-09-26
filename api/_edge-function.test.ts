import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "./edge-function";

function call(url: string, method = "POST", body: unknown = { a: 1 }) {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    text: "",
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    end(t: string) {
      this.text = t;
    },
  };
  const req = { url, method, body, headers: { authorization: "Bearer t" } };
  return handler(req as any, res as any).then(() => res);
}

describe("funções do Supabase (/api/invite-user e /api/user-admin)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("repassa para a função pedida com o token e a origem oficial", async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"ok":true}', { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    for (const fn of ["invite-user", "user-admin"]) {
      const res = await call(`/api/edge-function?fn=${fn}`);
      expect(res.statusCode).toBe(201);
      expect(res.text).toBe('{"ok":true}');
      const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toMatch(new RegExp(`/functions/v1/${fn}$`));
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer t",
      );
      expect((init.headers as Record<string, string>).Origin).toMatch(
        /^https:\/\//,
      );
      expect(init.body).toBe('{"a":1}');
    }
  });
  it("recusa outra função e outro método", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(
      (await call("/api/edge-function?fn=storage-reconcile")).statusCode,
    ).toBe(404);
    expect((await call("/api/edge-function")).statusCode).toBe(404);
    expect(
      (await call("/api/edge-function?fn=invite-user", "GET")).statusCode,
    ).toBe(405);
  });
});

import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleNotices } from "./_notices";
import type { DriveEnv } from "./_drive";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const env: DriveEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  bucket: "drive-bucket",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
};
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

describe("handleNotices", () => {
  it("falha fechado sem credenciais e sem login", async () => {
    const req = { action: "notice-files", attachments: [id(1)] };
    expect(
      (await handleNotices(req, "Bearer t", { ...env, credentials: null }))
        .status,
    ).toBe(500);
    expect((await handleNotices(req, null, env)).status).toBe(401);
  });

  it("assina o envio com o tipo e o tamanho que o banco guardou", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json([
          {
            path: "notices/c/n/a",
            content_type: "application/pdf",
            size_bytes: 900,
          },
        ]),
      ) as unknown as typeof globalThis.fetch;
    const res = await handleNotices(
      { action: "notice-sign-upload", attachment: id(1) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.status).toBe(200);
    expect(new URL(res.body.url as string).pathname).toBe(
      "/drive-bucket/notices/c/n/a",
    );
    expect(res.body.headers).toEqual({
      "Content-Type": "application/pdf",
      "x-goog-content-length-range": "0,900",
    });
    const [call, init] = (fetch as any).mock.calls[0];
    expect(call).toBe(
      "https://db.example.com/rest/v1/rpc/notice_upload_target",
    );
    expect(init.headers.Authorization).toBe("Bearer t");
  });

  it("recusa envio que o banco não autoriza", async () => {
    const fetch = vi.fn().mockResolvedValue(json([])) as any;
    const res = await handleNotices(
      { action: "notice-sign-upload", attachment: id(1) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.status).toBe(403);
  });

  it("devolve links só dos anexos que o banco liberou", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json([
          {
            id: id(1),
            path: "drive/logo",
            name: "logo.png",
            content_type: "image/png",
          },
        ]),
      ) as any;
    const res = await handleNotices(
      {
        action: "notice-files",
        attachments: [id(1), id(2), "../x"],
        inline: true,
      },
      "Bearer t",
      env,
      fetch,
    );
    const urls = res.body.urls as Record<string, string>;
    expect(Object.keys(urls)).toEqual([id(1)]);
    expect(
      new URL(urls[id(1)]).searchParams.get("response-content-disposition"),
    ).toMatch(/^inline; filename="logo.png"/);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      p_ids: [id(1), id(2)],
    });
  });

  it("apagar o aviso remove do bucket só os arquivos enviados que o banco devolveu", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(["notices/c/n/a"]))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as any;
    const res = await handleNotices(
      { action: "notice-delete", notice: id(3) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.body).toEqual({ ok: true, storage: true, removed: 1 });
    expect(fetch.mock.calls[1][1].method).toBe("DELETE");
    expect(new URL(fetch.mock.calls[1][0]).pathname).toBe(
      "/drive-bucket/notices/c/n/a",
    );
  });

  it("tirar um anexo do Drive não apaga nada do bucket", async () => {
    const fetch = vi.fn().mockResolvedValue(json(null)) as any;
    const res = await handleNotices(
      { action: "notice-delete-file", attachment: id(4) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.body).toEqual({ deleted: true, storage: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

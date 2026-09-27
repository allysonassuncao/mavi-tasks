import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleCases } from "./_cases";
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

describe("handleCases", () => {
  it("falha fechado sem credenciais e sem login", async () => {
    expect(
      (
        await handleCases(
          { action: "case-media", media: [id(1)] },
          "Bearer t",
          {
            ...env,
            credentials: null,
          },
        )
      ).status,
    ).toBe(500);
    expect(
      (await handleCases({ action: "case-media", media: [id(1)] }, null, env))
        .status,
    ).toBe(401);
  });

  it("assina o envio com o tipo e o tamanho que o banco guardou", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json([
          { path: "cases/c/k/m", content_type: "video/mp4", size_bytes: 900 },
        ]),
      ) as unknown as typeof globalThis.fetch;
    const res = await handleCases(
      { action: "case-sign-upload", media: id(1) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.status).toBe(200);
    const url = new URL(res.body.url as string);
    expect(url.pathname).toBe("/drive-bucket/cases/c/k/m");
    expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe(
      "content-type;host;x-goog-content-length-range",
    );
    expect(res.body.headers).toEqual({
      "Content-Type": "video/mp4",
      "x-goog-content-length-range": "0,900",
    });
    const [call, init] = (fetch as any).mock.calls[0];
    expect(call).toBe(
      "https://db.example.com/rest/v1/rpc/success_case_upload_target",
    );
    expect(init.headers.Authorization).toBe("Bearer t");
  });

  it("recusa envio que o banco não autoriza", async () => {
    const fetch = vi.fn().mockResolvedValue(json([])) as any;
    const res = await handleCases(
      { action: "case-sign-upload", media: id(1) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.status).toBe(403);
  });

  it("devolve links só das mídias que o banco liberou", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json([
          {
            id: id(1),
            path: "cases/a",
            name: "foto 1.jpg",
            content_type: "image/jpeg",
          },
        ]),
      ) as any;
    const res = await handleCases(
      { action: "case-media", media: [id(1), id(2), "../x"], inline: true },
      "Bearer t",
      env,
      fetch,
    );
    const urls = res.body.urls as Record<string, string>;
    expect(Object.keys(urls)).toEqual([id(1)]);
    expect(
      new URL(urls[id(1)]).searchParams.get("response-content-disposition"),
    ).toMatch(/^inline; filename="foto 1.jpg"/);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      p_ids: [id(1), id(2)],
    });
  });

  it("link público: confere o token no banco, sem o login da pessoa", async () => {
    expect(
      (
        await handleCases(
          { action: "case-public-media", token: "abc", media: [id(1)] },
          null,
          env,
        )
      ).status,
    ).toBe(404);
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json([
          {
            id: id(1),
            path: "cases/a",
            name: "a.pdf",
            content_type: "application/pdf",
          },
        ]),
      ) as any;
    const token = "a".repeat(64);
    const res = await handleCases(
      { action: "case-public-media", token, media: [id(1)] },
      null,
      env,
      fetch,
    );
    expect(Object.keys(res.body.urls as object)).toEqual([id(1)]);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer publishable",
    );
  });

  it("aprovar remove do bucket as mídias que a alteração tirou", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(["cases/a", "cases/b"]))
      .mockResolvedValue(new Response(null, { status: 204 })) as any;
    const res = await handleCases(
      { action: "case-review", case: id(9), approve: true },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.body).toEqual({ ok: true, storage: true, removed: 2 });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      p_case: id(9),
      p_approve: true,
      p_note: null,
    });
    const deletes = fetch.mock.calls
      .slice(1)
      .map((c: any[]) => [new URL(c[0]).pathname, c[1].method]);
    expect(deletes).toEqual([
      ["/drive-bucket/cases/a", "DELETE"],
      ["/drive-bucket/cases/b", "DELETE"],
    ]);
  });

  it("tirar mídia de um case aprovado só marca a remoção (nada sai do bucket)", async () => {
    const fetch = vi.fn().mockResolvedValue(json(null)) as any;
    const res = await handleCases(
      { action: "case-delete-media", media: id(3) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.body).toEqual({ deleted: false, storage: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("repassa a mensagem do banco quando a pessoa não pode", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({ message: "Só administradores e gestores aprovam cases." }, 403),
      ) as any;
    const res = await handleCases(
      { action: "case-review", case: id(9), approve: false, note: "x" },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Só administradores e gestores aprovam cases.");
  });
});

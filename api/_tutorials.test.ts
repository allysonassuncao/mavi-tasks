import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleTutorials } from "./_tutorials";
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

describe("handleTutorials", () => {
  it("falha fechado sem credenciais e sem login", async () => {
    expect(
      (
        await handleTutorials(
          { action: "tutorial-media", media: [id(1)] },
          "Bearer t",
          { ...env, credentials: null },
        )
      ).status,
    ).toBe(500);
    expect(
      (
        await handleTutorials(
          { action: "tutorial-media", media: [id(1)] },
          null,
          env,
        )
      ).status,
    ).toBe(401);
  });

  it("assina o envio com o tipo e o tamanho que o banco guardou", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json([
          { path: "tutorials/c/t/m", content_type: "video/mp4", size_bytes: 900 },
        ]),
      ) as unknown as typeof globalThis.fetch;
    const res = await handleTutorials(
      { action: "tutorial-sign-upload", media: id(1) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.status).toBe(200);
    expect(new URL(res.body.url as string).pathname).toBe(
      "/drive-bucket/tutorials/c/t/m",
    );
    expect(res.body.headers).toEqual({
      "Content-Type": "video/mp4",
      "x-goog-content-length-range": "0,900",
    });
  });

  it("recusa o envio que o banco não autorizou", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json([])) as unknown as typeof globalThis.fetch;
    const res = await handleTutorials(
      { action: "tutorial-sign-upload", media: id(1) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.status).toBe(403);
  });

  it("só assina a leitura dos vídeos que o banco devolveu, por 4 horas", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json([
        {
          id: id(1),
          path: "tutorials/c/t/1",
          name: "passo.mp4",
          content_type: "video/mp4",
        },
      ]),
    ) as unknown as typeof globalThis.fetch;
    const res = await handleTutorials(
      { action: "tutorial-media", media: [id(1), id(2), "x"] },
      "Bearer t",
      env,
      fetch,
    );
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ p_ids: [id(1), id(2)] });
    const urls = res.body.urls as Record<string, string>;
    expect(Object.keys(urls)).toEqual([id(1)]);
    expect(new URL(urls[id(1)]).searchParams.get("X-Goog-Expires")).toBe(
      "14400",
    );
  });

  it("apaga o tutorial e remove os vídeos do bucket", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(["tutorials/c/t/1", "tutorials/c/t/2"]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      ) as unknown as typeof globalThis.fetch;
    const res = await handleTutorials(
      { action: "tutorial-delete", tutorial: id(5) },
      "Bearer t",
      env,
      fetch,
    );
    expect(res.body).toEqual({ ok: true, storage: true, removed: 2 });
    expect(
      vi.mocked(fetch).mock.calls.slice(1).map((c) => (c[1] as RequestInit).method),
    ).toEqual(["DELETE", "DELETE"]);
  });
});

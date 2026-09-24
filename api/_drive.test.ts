import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleDrive, signGcsUrl, type DriveEnv } from "./_drive";

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
const fileId = "00000000-0000-4000-8000-000000000001";
const rpcReply = (data: unknown, status = 200) =>
  vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(data), { status }),
    ) as unknown as typeof fetch;

describe("signGcsUrl", () => {
  it("assina GET com nome de arquivo codificado e prazo curto", () => {
    const url = new URL(
      signGcsUrl(env.credentials!, "b", "drive/c/f", "GET", {
        expiresInSeconds: 300,
        query: {
          "response-content-disposition": 'attachment; filename="a b.pdf"',
        },
      }),
    );
    expect(url.pathname).toBe("/b/drive/c/f");
    expect(url.searchParams.get("X-Goog-Expires")).toBe("300");
    expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="a b.pdf"',
    );
    expect(url.searchParams.get("X-Goog-Signature")).toMatch(/^[0-9a-f]+$/);
  });
  it("inclui content-type nos cabeçalhos assinados do upload", () => {
    const url = new URL(
      signGcsUrl(env.credentials!, "b", "p", "PUT", {
        contentType: "image/png",
      }),
    );
    expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe(
      "content-type;host",
    );
  });
});

describe("handleDrive", () => {
  it("falha fechado sem credenciais do GCS", async () => {
    const res = await handleDrive(
      { action: "download", file: fileId },
      "Bearer t",
      { ...env, credentials: null },
    );
    expect(res.status).toBe(500);
  });
  it("exige login para arquivos privados", async () => {
    const fetchMock = rpcReply([]);
    const res = await handleDrive(
      { action: "download", file: fileId },
      null,
      env,
      fetchMock,
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("consulta a permissão como o usuário e devolve link assinado", async () => {
    const fetchMock = rpcReply([
      {
        path: `drive/c/${fileId}`,
        name: "Relatório.pdf",
        content_type: "application/pdf",
      },
    ]);
    const res = await handleDrive(
      { action: "download", file: fileId },
      "Bearer user-token",
      env,
      fetchMock,
      { ip: "203.0.113.9", user_agent: "Teste/1.0" },
    );
    expect(res.status).toBe(200);
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe(
      "https://db.example.com/rest/v1/rpc/drive_download_target",
    );
    expect(init.headers.Authorization).toBe("Bearer user-token");
    // The database writes the audit entry with the browser's origin.
    expect(JSON.parse(init.body)).toEqual({
      p_file: fileId,
      p_inline: false,
      p_origin: { ip: "203.0.113.9", user_agent: "Teste/1.0" },
    });
    const signed = new URL(res.body.url as string);
    expect(signed.pathname).toBe(`/drive-bucket/drive/c/${fileId}`);
    expect(signed.searchParams.get("response-content-disposition")).toContain(
      "filename*=UTF-8''Relat%C3%B3rio.pdf",
    );
  });
  it("nega quando o banco não autoriza", async () => {
    const res = await handleDrive(
      { action: "download", file: fileId },
      "Bearer user-token",
      env,
      rpcReply([]),
    );
    expect(res.status).toBe(403);
  });
  it("link público é resolvido anonimamente e rejeita tokens malformados", async () => {
    const bad = await handleDrive(
      { action: "public", token: "x" },
      null,
      env,
      rpcReply([]),
    );
    expect(bad.status).toBe(404);
    const fetchMock = rpcReply([
      {
        path: "drive/c/f",
        name: "a.png",
        content_type: "image/png",
        size_bytes: 10,
      },
    ]);
    const ok = await handleDrive(
      { action: "public", token: "a".repeat(64) },
      null,
      env,
      fetchMock,
    );
    expect(ok.status).toBe(200);
    expect((fetchMock as any).mock.calls[0][1].headers.Authorization).toBe(
      "Bearer publishable",
    );
  });
  it("arquivo de pasta pública passa pelo banco com token e arquivo", async () => {
    const bad = await handleDrive(
      { action: "public-folder-file", token: "a".repeat(64), file: "x" },
      null,
      env,
      rpcReply([]),
    );
    expect(bad.status).toBe(404);
    const fetchMock = rpcReply([
      {
        path: "drive/c/f",
        name: "a.png",
        content_type: "image/png",
        size_bytes: 10,
      },
    ]);
    const file = "00000000-0000-4000-8000-000000000009";
    const ok = await handleDrive(
      {
        action: "public-folder-file",
        token: "b".repeat(64),
        file,
        inline: true,
      },
      null,
      env,
      fetchMock,
    );
    expect(ok.status).toBe(200);
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toContain("/rpc/drive_public_folder_file");
    expect(JSON.parse(init.body)).toMatchObject({
      p_token: "b".repeat(64),
      p_file: file,
      p_inline: true,
    });
    expect(init.headers.Authorization).toBe("Bearer publishable");
  });
  it("exclui o registro e depois o objeto no GCS", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify("drive/c/f")))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await handleDrive(
      { action: "delete", file: fileId },
      "Bearer user-token",
      env,
      fetchMock as unknown as typeof fetch,
    );
    expect(res.body).toEqual({ deleted: true, storage: true });
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
    expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe(
      "/drive-bucket/drive/c/f",
    );
  });
});

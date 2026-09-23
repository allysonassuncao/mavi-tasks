import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AVATAR_MAX_BYTES, handleProfile } from "./_profile";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  bucket: "private-drive",
  publicBucket: "public-bucket",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
};
const path =
  "avatars/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.webp";

describe("handleProfile", () => {
  it("exige login antes de consultar o banco", async () => {
    const fetchMock = vi.fn();
    const res = await handleProfile(
      { action: "avatar-upload" },
      null,
      env,
      fetchMock as unknown as typeof fetch,
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("assina só WebP pequeno no caminho escolhido pelo banco, no bucket público", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(path)));
    const res = await handleProfile(
      { action: "avatar-upload" },
      "Bearer user-token",
      env,
      fetchMock as unknown as typeof fetch,
    );
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://db.example.com/rest/v1/rpc/avatar_upload_path",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      p_format: "webp",
    });
    const url = new URL(res.body.url as string);
    expect(url.pathname).toBe(`/public-bucket/${path}`);
    expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe(
      "content-type;host;x-goog-content-length-range",
    );
    expect(res.body.headers).toEqual({
      "Content-Type": "image/webp",
      "x-goog-content-length-range": `0,${AVATAR_MAX_BYTES}`,
    });
    expect(res.body.public_url).toBe(
      `https://storage.googleapis.com/public-bucket/${path}`,
    );
  });
  it("usa JPEG quando o navegador não gera WebP", async () => {
    const jpg = path.replace(/\.webp$/, ".jpg");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(jpg)));
    const res = await handleProfile(
      { action: "avatar-upload", format: "jpg" },
      "Bearer user-token",
      env,
      fetchMock as unknown as typeof fetch,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      p_format: "jpg",
    });
    expect((res.body.headers as Record<string, string>)["Content-Type"]).toBe(
      "image/jpeg",
    );
  });
});

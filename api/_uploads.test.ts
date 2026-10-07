import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleUpload } from "./_uploads";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  bucket: "public-bucket",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
};
const id = "00000000-0000-4000-8000-000000000001";
const reply = (rows: unknown) =>
  vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(rows)),
    ) as unknown as typeof fetch;

describe("handleUpload", () => {
  it("exige login e não assina caminhos enviados pelo cliente", async () => {
    const fetchMock = reply([]);
    expect(
      (await handleUpload({ kind: "attachment", id }, null, env, fetchMock))
        .status,
    ).toBe(401);
    expect(
      (
        await handleUpload(
          { path: "empresa/tarefa/arquivo", contentType: "text/html" },
          "Bearer t",
          env,
          fetchMock,
        )
      ).status,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("nega quando o banco não libera o registro (alheio ou expirado)", async () => {
    const res = await handleUpload(
      { kind: "attachment", id },
      "Bearer user-token",
      env,
      reply([]),
    );
    expect(res.status).toBe(403);
  });
  it("anexo: tipo pelo nome do registro e tamanho limitado ao declarado", async () => {
    const fetchMock = reply([
      { path: `c/t/${id}`, name: "briefing.pdf", size_bytes: 1234 },
    ]);
    const res = await handleUpload(
      { kind: "attachment", id, contentType: "text/html" },
      "Bearer user-token",
      env,
      fetchMock,
    );
    expect(res.status).toBe(200);
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe(
      "https://db.example.com/rest/v1/rpc/attachment_upload_target",
    );
    expect(init.headers.Authorization).toBe("Bearer user-token");
    expect(JSON.parse(init.body)).toEqual({ p_attachment: id });
    expect(res.body.headers).toEqual({
      "Content-Type": "application/pdf",
      "x-goog-content-length-range": "0,1234",
    });
    const signed = new URL(res.body.url as string);
    expect(signed.pathname).toBe(`/public-bucket/c/t/${id}`);
    expect(signed.searchParams.get("X-Goog-SignedHeaders")).toBe(
      "content-type;host;x-goog-content-length-range",
    );
  });
  it("comprovante da conta de mídia: pelo registro preparado, com a regra dos anexos", async () => {
    const fetchMock = reply([
      { path: `c/media/k/${id}`, name: "pix.png", size_bytes: 99 },
    ]);
    const res = await handleUpload(
      { kind: "media-receipt", id },
      "Bearer user-token",
      env,
      fetchMock,
    );
    expect(res.status).toBe(200);
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe(
      "https://db.example.com/rest/v1/rpc/media_receipt_upload_target",
    );
    expect(JSON.parse(init.body)).toEqual({ p_receipt: id });
    expect(res.body.headers).toEqual({
      "Content-Type": "image/png",
      "x-goog-content-length-range": "0,99",
    });
    expect(new URL(res.body.url as string).pathname).toBe(
      `/public-bucket/c/media/k/${id}`,
    );
  });
  it("anexo da devolução de skill: pelo registro preparado, com a regra dos anexos", async () => {
    const fetchMock = reply([
      { path: `c/skills/s/2/${id}`, name: "ajuste.pdf", size_bytes: 50 },
    ]);
    const res = await handleUpload(
      { kind: "skill-review-file", id },
      "Bearer user-token",
      env,
      fetchMock,
    );
    expect(res.status).toBe(200);
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe(
      "https://db.example.com/rest/v1/rpc/skill_review_file_upload_target",
    );
    expect(JSON.parse(init.body)).toEqual({ p_file: id });
    expect(res.body.headers).toEqual({
      "Content-Type": "application/pdf",
      "x-goog-content-length-range": "0,50",
    });
  });
  it("imagem da descrição: só JPG, PNG ou WebP", async () => {
    const rows = [{ path: `c/u/${id}`, name: "print", size_bytes: 10 }];
    const svg = await handleUpload(
      { kind: "inline-image", id, contentType: "image/svg+xml" },
      "Bearer user-token",
      env,
      reply(rows),
    );
    expect(svg.status).toBe(400);
    const fetchMock = reply(rows);
    const png = await handleUpload(
      { kind: "inline-image", id, contentType: "image/png" },
      "Bearer user-token",
      env,
      fetchMock,
    );
    expect(png.status).toBe(200);
    expect((fetchMock as any).mock.calls[0][0]).toBe(
      "https://db.example.com/rest/v1/rpc/inline_image_upload_target",
    );
  });
  it("exclui anexo: o banco decide e o objeto sai do bucket", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(`c/t/${id}`)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await handleUpload(
      { action: "delete-attachment", id },
      "Bearer user-token",
      env,
      fetchMock as unknown as typeof fetch,
    );
    expect(res).toEqual({
      status: 200,
      body: { deleted: true, storage: true },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://db.example.com/rest/v1/rpc/delete_attachment",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      p_attachment: id,
    });
    const removal = new URL(fetchMock.mock.calls[1][0]);
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
    expect(removal.pathname).toBe(`/public-bucket/c/t/${id}`);
  });
  it("anexo de qualquer tipo: executável recusado, o resto baixa como arquivo", async () => {
    const exe = await handleUpload(
      { kind: "attachment", id },
      "Bearer user-token",
      env,
      reply([{ path: `c/t/${id}`, name: "setup.exe", size_bytes: 10 }]),
    );
    expect(exe.status).toBe(400);
    const psd = await handleUpload(
      { kind: "attachment", id, contentType: "text/html" },
      "Bearer user-token",
      env,
      reply([{ path: `c/t/${id}`, name: "arte.psd", size_bytes: 10 }]),
    );
    expect(psd.status).toBe(200);
    expect(psd.body.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
    });
  });
  it("áudio gravado: o tipo que o rascunho declarou, nunca o do pedido", async () => {
    const fetchMock = reply([
      { path: `c/audio/${id}`, mime: "audio/webm", size_bytes: 5000 },
    ]);
    const res = await handleUpload(
      { kind: "audio", id, contentType: "text/html" },
      "Bearer user-token",
      env,
      fetchMock,
    );
    expect(res.status).toBe(200);
    expect((fetchMock as any).mock.calls[0][0]).toBe(
      "https://db.example.com/rest/v1/rpc/task_audio_upload_target",
    );
    expect(JSON.parse((fetchMock as any).mock.calls[0][1].body)).toEqual({
      p_audio: id,
    });
    expect(res.body.headers).toEqual({
      "Content-Type": "audio/webm",
      "x-goog-content-length-range": "0,5000",
    });
  });
  it("exclui áudio: o arquivo fica enquanto uma cópia da tarefa ainda o usa", async () => {
    const shared = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(null)));
    const kept = await handleUpload(
      { action: "delete-audio", id },
      "Bearer user-token",
      env,
      shared as unknown as typeof fetch,
    );
    expect(kept).toEqual({ status: 200, body: { deleted: true, storage: true } });
    expect(shared).toHaveBeenCalledTimes(1);
    expect(shared.mock.calls[0][0]).toBe(
      "https://db.example.com/rest/v1/rpc/delete_task_audio",
    );
    const last = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(`c/audio/${id}`)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await handleUpload(
      { action: "delete-audio", id },
      "Bearer user-token",
      env,
      last as unknown as typeof fetch,
    );
    expect(new URL(last.mock.calls[1][0]).pathname).toBe(
      `/public-bucket/c/audio/${id}`,
    );
  });
  it("exclusão negada pelo banco não toca no bucket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Sem permissão" }), {
        status: 403,
      }),
    );
    const res = await handleUpload(
      { action: "delete-attachment", id },
      "Bearer user-token",
      env,
      fetchMock as unknown as typeof fetch,
    );
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

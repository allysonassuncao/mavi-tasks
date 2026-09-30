import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleDrive, type DriveEnv } from "./_drive";
import {
  DRIVE_UPLOAD_FORMATS,
  contentMatches,
  uploadAccept,
  uploadFormat,
  uploadKindsSentence,
} from "../src/drive-upload-types";

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
  workerSecret: "s".repeat(40),
};
const token = "a".repeat(64);
const fileId = "00000000-0000-4000-8000-000000000001";
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((p) =>
      typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p,
    ),
  );
/** A ZIP whose first entry is `name` (just the local header). */
const zip = (name: string) => {
  const head = new Uint8Array(30 + name.length);
  head.set([0x50, 0x4b, 3, 4]);
  head[26] = name.length;
  head.set(bytes(name), 30);
  return head;
};

describe("formatos aceitos pelo link", () => {
  it("a lista do banco é a mesma da tela", () => {
    const sql = fs.readFileSync(
      new URL(
        "../supabase/migrations/20270118090000_drive_public_upload_rules.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const body = sql.slice(
      sql.indexOf("mavi_private.drive_upload_format"),
      sql.indexOf(") k(ext, kind, content_type)"),
    );
    const fromSql = Object.fromEntries(
      [...body.matchAll(/\('([^']+)', '([^']+)', '([^']+)'\)/g)].map((m) => [
        m[1],
        { kind: m[2], type: m[3] },
      ]),
    );
    expect(fromSql).toEqual(DRIVE_UPLOAD_FORMATS);
  });
  it("o tipo vem da extensão, sem formatos que carregam código", () => {
    expect(uploadFormat("Foto.JPG")).toEqual({
      kind: "image",
      type: "image/jpeg",
    });
    for (const name of [
      "logo.svg",
      "pagina.html",
      "planilha.xlsm",
      "pacote.zip",
      "setup.exe",
      "foto.jpg.exe",
      "sem-extensao",
    ])
      expect(uploadFormat(name)).toBeNull();
    expect(uploadAccept(["pdf"])).toBe(".pdf");
    expect(uploadKindsSentence(["image", "video", "pdf"])).toBe(
      "fotos, vídeos ou PDFs",
    );
  });
  it("confere os primeiros bytes com o formato do nome", () => {
    expect(contentMatches("a.jpg", bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(
      contentMatches("a.png", bytes([0x89], "PNG\r\n", [0x1a], "\n")),
    ).toBe(true);
    expect(contentMatches("a.webp", bytes("RIFF", [0, 0, 0, 0], "WEBP"))).toBe(
      true,
    );
    expect(contentMatches("a.mov", bytes([0, 0, 0, 20], "ftypqt  "))).toBe(
      true,
    );
    expect(contentMatches("a.heic", bytes([0, 0, 0, 24], "ftypheic"))).toBe(
      true,
    );
    expect(contentMatches("a.mp3", bytes("ID3", [4, 0]))).toBe(true);
    expect(contentMatches("a.opus", bytes("OggS", [0]))).toBe(true);
    expect(contentMatches("a.pdf", bytes("\n\n%PDF-1.7"))).toBe(true);
    expect(contentMatches("a.docx", zip("[Content_Types].xml"))).toBe(true);
    expect(contentMatches("a.odt", zip("mimetype"))).toBe(true);
    expect(contentMatches("a.csv", bytes("nome;valor\nAna;1"))).toBe(true);
    // A program, an archive or a page under another name.
    expect(contentMatches("a.jpg", bytes("MZ", [0x90, 0]))).toBe(false);
    expect(contentMatches("a.docx", zip("setup.exe"))).toBe(false);
    expect(contentMatches("a.pdf", bytes("<html><script>"))).toBe(false);
    expect(contentMatches("a.txt", bytes("MZ", [0x90, 0, 3]))).toBe(false);
    expect(contentMatches("a.txt", bytes("abc", [0], "def"))).toBe(false);
    expect(contentMatches("a.jpg", new Uint8Array())).toBe(false);
  });
});

describe("envio pelo link público", () => {
  const pending = {
    path: `drive/c/${fileId}`,
    name: "foto.jpg",
    content_type: "image/jpeg",
    size_bytes: 4,
  };
  const server = (content: Uint8Array) => {
    const calls: { url: string; body?: any; method?: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("/rpc/drive_public_upload_pending"))
        return new Response(JSON.stringify([pending]));
      if (url.includes("/rpc/drive_public_upload_done"))
        return new Response("null");
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(content, {
        status: 206,
        headers: { "content-range": `bytes 0-3/${pending.size_bytes}` },
      });
    }) as unknown as typeof fetch;
    return { fetchMock, calls };
  };

  it("o upload assinado só aceita o tamanho declarado", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { id: fileId, path: pending.path, content_type: "image/jpeg" },
          ]),
        ),
    ) as unknown as typeof fetch;
    const res = await handleDrive(
      {
        action: "public-upload",
        token,
        name: "foto.jpg",
        size: 1234,
        content_type: "text/html",
      },
      null,
      env,
      fetchMock,
    );
    expect(res.status).toBe(200);
    expect(res.body.headers).toEqual({
      "Content-Type": "image/jpeg",
      "x-goog-content-length-range": "1234,1234",
    });
    const url = new URL(String(res.body.url));
    expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe(
      "content-type;host;x-goog-content-length-range",
    );
  });

  it("conteúdo que confere: o arquivo aparece na pasta", async () => {
    const { fetchMock, calls } = server(bytes([0xff, 0xd8, 0xff, 0xe0]));
    const res = await handleDrive(
      { action: "public-upload-done", token, file: fileId },
      null,
      env,
      fetchMock,
    );
    expect(res).toEqual({ status: 200, body: { file: fileId } });
    const done = calls.find((c) => c.url.includes("drive_public_upload_done"));
    expect(done?.body).toEqual({
      p_secret: env.workerSecret,
      p_token: token,
      p_file: fileId,
      p_rejected: null,
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("conteúdo de outro tipo: descartado e apagado do armazenamento", async () => {
    const { fetchMock, calls } = server(bytes("MZ", [0x90, 0]));
    const res = await handleDrive(
      { action: "public-upload-done", token, file: fileId },
      null,
      env,
      fetchMock,
    );
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/descartado/);
    const done = calls.find((c) => c.url.includes("drive_public_upload_done"));
    expect(done?.body.p_rejected).toBe("content");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("sem o segredo do servidor, nada é concluído", async () => {
    const { fetchMock } = server(bytes([0xff, 0xd8, 0xff]));
    const res = await handleDrive(
      { action: "public-upload-done", token, file: fileId },
      null,
      { ...env, workerSecret: undefined },
      fetchMock,
    );
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

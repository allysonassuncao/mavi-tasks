import { describe, expect, it, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({ token: "user-token" as string | null }));
vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: {
          session: session.token ? { access_token: session.token } : null,
        },
      }),
    },
  },
}));
import { getGcsPublicUrl, uploadToGcs } from "./gcs";

const signed = {
  url: "https://storage.googleapis.com/maso_storage_main/signed-put-url",
  headers: {
    "Content-Type": "application/pdf",
    "x-goog-content-length-range": "0,13",
  },
};
const target = { kind: "attachment" as const, id: "attachment-id" };
const file = () =>
  new File(["dummy content"], "doc.pdf", { type: "application/pdf" });

describe("Google Cloud Storage helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    session.token = "user-token";
  });

  it("builds the correct public URL for objects in maso_storage_main", () => {
    expect(getGcsPublicUrl("company/task/file.pdf")).toBe(
      "https://storage.googleapis.com/maso_storage_main/company/task/file.pdf",
    );
    expect(getGcsPublicUrl("/company/task/file with spaces.png")).toBe(
      "https://storage.googleapis.com/maso_storage_main/company/task/file%20with%20spaces.png",
    );
  });

  it("asks for a signature for the prepared record, with the session token", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => signed })
      .mockResolvedValueOnce({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", mockFetch);
    const upload = file();
    await uploadToGcs(target, upload, "application/pdf");
    expect(mockFetch).toHaveBeenNthCalledWith(1, "/api/gcs/sign-upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        kind: "attachment",
        id: "attachment-id",
        contentType: "application/pdf",
      }),
    });
    expect(mockFetch).toHaveBeenLastCalledWith(signed.url, {
      method: "PUT",
      headers: signed.headers,
      body: upload,
    });
  });

  it("does not upload without a session", async () => {
    session.token = null;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    await expect(uploadToGcs(target, file())).rejects.toThrow(
      /Entre novamente/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("surfaces a refused signature", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Envio não autorizado ou expirado." }),
      }),
    );
    await expect(uploadToGcs(target, file())).rejects.toThrow(
      "Envio não autorizado ou expirado.",
    );
  });

  it("throws error if PUT upload fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => signed })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          text: async () => "Access denied",
        }),
    );
    await expect(uploadToGcs(target, file())).rejects.toThrow(
      /Falha no upload para o Google Cloud Storage/,
    );
  });
});

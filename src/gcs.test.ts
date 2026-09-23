import { describe, expect, it, vi, beforeEach } from "vitest";
import { getGcsPublicUrl, getSignedUploadUrl, uploadToGcs } from "./gcs";

describe("Google Cloud Storage helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the correct public URL for objects in maso_storage_main", () => {
    expect(getGcsPublicUrl("company/task/file.pdf")).toBe(
      "https://storage.googleapis.com/maso_storage_main/company/task/file.pdf",
    );
    expect(getGcsPublicUrl("/company/task/file with spaces.png")).toBe(
      "https://storage.googleapis.com/maso_storage_main/company/task/file%20with%20spaces.png",
    );
  });

  it("fetches signed upload URL from /api/gcs/sign-upload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://storage.googleapis.com/maso_storage_main/signed-put-url",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const url = await getSignedUploadUrl("test/path.pdf", "application/pdf");
    expect(url).toBe(
      "https://storage.googleapis.com/maso_storage_main/signed-put-url",
    );
    expect(mockFetch).toHaveBeenCalledWith("/api/gcs/sign-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "test/path.pdf",
        contentType: "application/pdf",
      }),
    });
  });

  it("uploads file to signed URL via PUT", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://storage.googleapis.com/maso_storage_main/signed-put-url",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "",
      });
    vi.stubGlobal("fetch", mockFetch);

    const file = new File(["dummy content"], "doc.pdf", {
      type: "application/pdf",
    });
    await uploadToGcs("tasks/1/doc.pdf", file);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      "https://storage.googleapis.com/maso_storage_main/signed-put-url",
      {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      },
    );
  });

  it("throws error if PUT upload fails", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://storage.googleapis.com/maso_storage_main/signed-put-url",
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "Access denied",
      });
    vi.stubGlobal("fetch", mockFetch);

    const file = new File(["dummy content"], "doc.pdf", {
      type: "application/pdf",
    });
    await expect(uploadToGcs("tasks/1/doc.pdf", file)).rejects.toThrow(
      /Falha no upload para o Google Cloud Storage/,
    );
  });
});

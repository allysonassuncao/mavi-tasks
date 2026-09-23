import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  uploadToGcs: vi.fn(),
  invalidateTaskExtras: vi.fn(),
}));
vi.mock("./api", () => ({
  rpc: mocks.rpc,
  invalidateTaskExtras: mocks.invalidateTaskExtras,
}));
vi.mock("./gcs", () => ({
  uploadToGcs: mocks.uploadToGcs,
}));
vi.mock("./supabase", () => ({
  supabase: {},
}));
import {
  validateAttachment,
  uploadAttachment,
  saveTaskWithAttachments,
  type TaskUploadState,
} from "./attachments";
const file = (name: string, size = 100) =>
  ({ name, size, lastModified: 1 }) as File;
beforeEach(() => vi.clearAllMocks());
describe("task creation attachments", () => {
  it("rejects empty, oversized and unsupported files before creating records", async () => {
    for (const f of [file("a.pdf", 0), file("a.pdf", 20971521), file("a.exe")])
      expect(() => validateAttachment(f)).toThrow();
    expect(validateAttachment(file("REPORT.PDF", 20971520))).toBe(
      "application/pdf",
    );
    await expect(uploadAttachment("t", file("a.exe"))).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("uploads the prepared record (never a client path) and cleans up rejected uploads", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ id: "a", path: "company/task/file.pdf" })
      .mockResolvedValueOnce(null);
    mocks.uploadToGcs.mockRejectedValue(new Error("Upload negado"));
    await expect(uploadAttachment("t", file("file.pdf"))).rejects.toThrow(
      "Upload negado",
    );
    expect(mocks.uploadToGcs).toHaveBeenCalledWith(
      { kind: "attachment", id: "a" },
      expect.anything(),
      "application/pdf",
    );
    expect(mocks.rpc).toHaveBeenLastCalledWith("discard_pending_attachment", {
      p_attachment: "a",
    });
  });
  it("invalidates task extras cache on successful upload", async () => {
    mocks.rpc.mockResolvedValueOnce({ id: "a", path: "company/task/file.pdf" });
    mocks.uploadToGcs.mockResolvedValueOnce(undefined);
    await uploadAttachment("t", file("file.pdf"));
    expect(mocks.uploadToGcs).toHaveBeenCalledWith(
      { kind: "attachment", id: "a" },
      expect.anything(),
      "application/pdf",
    );
    expect(mocks.invalidateTaskExtras).toHaveBeenCalledWith("t");
  });
  it("retries only pending files without recreating the task or completed files", async () => {
    const first = file("a.pdf"),
      second = file("b.pdf");
    const state: TaskUploadState = { pending: [first, second] };
    const create = vi.fn().mockResolvedValue("task-1");
    const upload = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({});
    await expect(
      saveTaskWithAttachments(state, create, upload, () => {}),
    ).rejects.toThrow("offline");
    expect(state).toEqual({ taskId: "task-1", pending: [second] });
    await saveTaskWithAttachments(state, create, upload, () => {});
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls.map((c) => c[1].name)).toEqual([
      "a.pdf",
      "b.pdf",
      "b.pdf",
    ]);
    expect(state.pending).toEqual([]);
  });
  it("does not upload if task creation fails", async () => {
    const state: TaskUploadState = { pending: [file("a.pdf")] };
    const upload = vi.fn();
    await expect(
      saveTaskWithAttachments(
        state,
        () => Promise.reject(new Error("Sem permissão")),
        upload,
        () => {},
      ),
    ).rejects.toThrow("Sem permissão");
    expect(upload).not.toHaveBeenCalled();
    expect(state.taskId).toBeUndefined();
  });
});

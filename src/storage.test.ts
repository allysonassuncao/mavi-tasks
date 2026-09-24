import { describe, expect, it } from "vitest";
import {
  NO_CLIENT,
  summarizeClients,
  summarizeStorage,
  type StorageUsageRow,
} from "./storage";

describe("Uso de armazenamento", () => {
  it("soma a agência e cada pessoa, da que mais usa para a que menos usa", () => {
    const rows: StorageUsageRow[] = [
      {
        user_id: "ana",
        kind: "drive",
        files: 2,
        bytes: 3000,
        last_upload_at: "2026-09-20T10:00:00Z",
      },
      {
        user_id: "ana",
        kind: "attachment",
        files: 1,
        bytes: 500,
        last_upload_at: "2026-09-22T10:00:00Z",
      },
      {
        user_id: "bia",
        kind: "inline_image",
        files: 4,
        bytes: 8000,
        last_upload_at: "2026-09-21T10:00:00Z",
      },
      // PostgREST may send bigint sums as strings.
      {
        user_id: "bia",
        kind: "avatar",
        files: "1" as unknown as number,
        bytes: "20" as unknown as number,
        last_upload_at: null,
      },
    ];
    const { company, people } = summarizeStorage(rows);
    expect(company.bytes).toBe(11520);
    expect(company.files).toBe(8);
    expect(company.drive).toBe(3000);
    expect(company.inline_image).toBe(8000);
    expect(company.avatar).toBe(20);
    expect(people.map((p) => p.user_id)).toEqual(["bia", "ana"]);
    expect(people[1]).toMatchObject({
      bytes: 3500,
      files: 3,
      attachment: 500,
      last_upload_at: "2026-09-22T10:00:00Z",
    });
  });
  it("sem envios, tudo zerado", () => {
    const { company, people } = summarizeStorage([]);
    expect(company.bytes).toBe(0);
    expect(people).toEqual([]);
  });
  it("agrupa por cliente e junta o que não tem cliente", () => {
    const clients = summarizeClients([
      {
        client_id: "aurora",
        kind: "drive",
        files: 2,
        bytes: 900,
        last_upload_at: "2026-09-20T10:00:00Z",
      },
      {
        client_id: "aurora",
        kind: "attachment",
        files: 1,
        bytes: 100,
        last_upload_at: "2026-09-21T10:00:00Z",
      },
      {
        client_id: null,
        kind: "drive",
        files: 1,
        bytes: 50,
        last_upload_at: null,
      },
      {
        client_id: null,
        kind: "avatar",
        files: 3,
        bytes: 30,
        last_upload_at: null,
      },
    ]);
    expect(clients.get("aurora")).toMatchObject({
      bytes: 1000,
      files: 3,
      drive: 900,
      attachment: 100,
      last_upload_at: "2026-09-21T10:00:00Z",
    });
    expect(clients.get(NO_CLIENT)).toMatchObject({ bytes: 80, avatar: 30 });
  });
});

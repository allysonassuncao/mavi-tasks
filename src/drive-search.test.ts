import { describe, it, expect } from "vitest";
import { matchDriveFolders } from "./drive";
import { demoSnapshot } from "./demo";
import { contractProductLabel } from "./domain";
import type { DriveFolder } from "./types";

describe("Busca do Drive por pastas", () => {
  const data = demoSnapshot();
  const client = data.clients.find((c) => !c.archived)!;
  const contract = data.contracts.find(
    (k) => k.client_id === client.id && !k.archived,
  )!;
  const folder = (over: Partial<DriveFolder>): DriveFolder => ({
    id: "f1",
    company_id: data.companies[0].id,
    client_id: client.id,
    contract_id: contract.id,
    parent_id: null,
    name: "Campanha 774",
    created_by: data.members[0].user_id,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  });

  it("encontra pastas pelo trecho do nome, mesmo em subpastas", () => {
    const folders = [
      folder({}),
      folder({ id: "f2", parent_id: "f1", name: "Peças 774-B" }),
      folder({ id: "f3", name: "Outra" }),
    ];
    const found = matchDriveFolders(data, folders, "774");
    expect(found.map((m) => m.name)).toEqual(["Campanha 774", "Peças 774-B"]);
    expect(found[1].at).toEqual({
      client: client.id,
      contract: contract.id,
      folder: "f2",
    });
  });

  it("ignora acentos e maiúsculas e inclui clientes e produtos", () => {
    const found = matchDriveFolders(
      data,
      [folder({ name: "Relatórios" })],
      "RELATORIO",
    );
    expect(found.map((m) => m.kind)).toEqual(["folder"]);
    expect(
      matchDriveFolders(data, [], client.name.toUpperCase()).some(
        (m) => m.kind === "client" && m.at.client === client.id,
      ),
    ).toBe(true);
    const label = contractProductLabel(data, contract.id);
    expect(
      matchDriveFolders(data, [], label).some(
        (m) => m.kind === "product" && m.at.contract === contract.id,
      ),
    ).toBe(true);
  });

  it("não repete pastas e respeita o cliente da tarefa", () => {
    const f = folder({});
    expect(matchDriveFolders(data, [f, f], "774")).toHaveLength(1);
    const other = data.clients.find((c) => c.id !== client.id)!;
    const found = matchDriveFolders(data, [f], "774", other.id);
    expect(found).toHaveLength(0);
    expect(
      matchDriveFolders(data, [], client.name, client.id).some(
        (m) => m.kind === "client",
      ),
    ).toBe(false);
  });

  it("busca vazia não traz nada", () => {
    expect(matchDriveFolders(data, [folder({})], "   ")).toEqual([]);
  });
});

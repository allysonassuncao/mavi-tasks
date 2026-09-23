import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./drive", async (original) => ({
  ...(await original<typeof import("./drive")>()),
  listDriveFiles: vi.fn(() => new Promise(() => {})),
  listDriveFolders: vi.fn(() => new Promise(() => {})),
}));
const { TaskDrive } = await import("./DrivePage");
const { demoSnapshot } = await import("./demo");

describe("Drive na tarefa", () => {
  const data = demoSnapshot();
  const client = data.clients[0];
  const other = data.clients[1];
  const html = renderToStaticMarkup(
    <TaskDrive
      root={{ client: client.id }}
      demo={false}
      data={data}
      company={data.companies[0].id}
      user={data.members[0].user_id}
      isLeader
      notify={() => {}}
    />,
  );
  it("começa na pasta do cliente da tarefa, sem acesso à raiz do Drive", () => {
    expect(html).toContain(client.name);
    expect(html).not.toContain(`>${other.name}<`);
    expect(html).not.toMatch(/>Drive<\/button>/);
    expect(html).toContain("Buscar arquivo nas pastas deste cliente");
  });
  it("mostra os produtos contratados por esse cliente", () => {
    const products = data.contracts.filter(
      (k) => k.client_id === client.id && !k.archived,
    );
    expect(products.length).toBeGreaterThan(0);
    expect(html.match(/>Produto</g)?.length).toBe(products.length);
  });
});

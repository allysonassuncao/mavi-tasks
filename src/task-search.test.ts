import { describe, it, expect, vi } from "vitest";
vi.mock("./api", () => ({ rpc: vi.fn() }));
const { fold, highlightParts, searchSnippet, searchTasksLocal } =
  await import("./task-search");
const { demoSnapshot, demoUser } = await import("./demo");
const { serializeDescription } = await import("./rich-text");

describe("Busca avançada", () => {
  it("ignora maiúsculas e acentos sem mudar o tamanho do texto", () => {
    expect(fold("Reunião de CONDOMÍNIO")).toBe("reuniao de condominio");
    expect(fold("Ação").length).toBe(4);
  });
  it("destaca o termo mesmo com acento diferente", () => {
    expect(highlightParts("Nova reunião hoje", "REUNIAO")).toEqual([
      { text: "Nova ", match: false },
      { text: "reunião", match: true },
      { text: " hoje", match: false },
    ]);
  });
  it("mostra o trecho ao redor do termo", () => {
    const text = "a ".repeat(100) + "logotipo azul" + " b".repeat(100);
    const snippet = searchSnippet(text, "logotipo");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("logotipo azul");
    expect(snippet.endsWith("…")).toBe(true);
  });
  it("encontra na descrição (rich text) e nos comentários, com entregues", () => {
    const data = demoSnapshot();
    const done = data.tasks.find((t) => t.status === "done")!;
    done.description = serializeDescription({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Paleta da campanha de primavera" }],
        },
      ],
    });
    const other = data.tasks.find((t) => t.id !== done.id)!;
    const comments = [
      {
        id: "c1",
        company_id: other.company_id,
        task_id: other.id,
        author_id: demoUser,
        body: "Cliente aprovou o LOGOTIPO",
        created_at: new Date().toISOString(),
      },
    ];
    const all = ["title", "description", "comments"] as const;
    const byDescription = searchTasksLocal(data, comments, demoUser, {
      query: "PALETA",
      fields: [...all],
    });
    expect(byDescription.map((h) => [h.task_id, h.match_in])).toEqual([
      [done.id, "description"],
    ]);
    const byComment = searchTasksLocal(data, comments, demoUser, {
      query: "logotipo",
      fields: [...all],
    });
    expect(byComment[0]).toMatchObject({
      task_id: other.id,
      match_in: "comment",
    });
    expect(
      searchTasksLocal(data, comments, demoUser, {
        query: "logotipo",
        fields: ["title", "description"],
      }),
    ).toEqual([]);
  });
  it("sem termo, lista pelos filtros", () => {
    const data = demoSnapshot();
    const hits = searchTasksLocal(data, [], demoUser, {
      query: "",
      fields: ["title"],
      status: "done",
    });
    expect(hits.length).toBe(
      data.tasks.filter((t) => t.status === "done").length,
    );
    expect(hits.every((h) => h.status === "done")).toBe(true);
  });
});

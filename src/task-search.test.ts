import { describe, it, expect, vi } from "vitest";
vi.mock("./api", () => ({ rpc: vi.fn() }));
const { rpc } = await import("./api");
const { fold, highlightParts, highlightTerms, searchSnippet, searchTasksLocal } =
  await import("./task-search");
const { cleanTerms, filterValues, withoutFilterWords } = await import("./task-search-mavi");
const { searchTaskRowsMavi } = await import("./task-search");
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
  it("destaca qualquer um dos termos da MAVI, o mais longo primeiro", () => {
    expect(
      highlightTerms("Novo Logotipo e logo da identidade visual", [
        "logo",
        "logotipo",
        "IDENTIDADE VISUAL",
      ]),
    ).toEqual([
      { text: "Novo ", match: false },
      { text: "Logotipo", match: true },
      { text: " e ", match: false },
      { text: "logo", match: true },
      { text: " da ", match: false },
      { text: "identidade visual", match: true },
    ]);
    expect(highlightTerms("sem nada", [])).toEqual([{ text: "sem nada", match: false }]);
  });
  it("limpa os termos da MAVI: sem repetidos, curtos demais ou aspas", () => {
    expect(
      cleanTerms(["Logo", "logo", "“logotipo”", "a", 3, "  identidade   visual ", "x".repeat(41)]),
    ).toEqual(["Logo", "logotipo", "identidade visual"]);
    expect(cleanTerms("logo")).toEqual([]);
    expect(cleanTerms(Array.from({ length: 20 }, (_, i) => `termo ${i}`))).toHaveLength(10);
  });
  it("se o banco desiste pelo tempo com o sentido, busca só pelos termos", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.mocked(rpc).mockImplementation(async (_name, args) => {
      calls.push(args as Record<string, unknown>);
      if ((args as { p_embedding?: unknown }).p_embedding)
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      return [];
    });
    const found = await searchTaskRowsMavi(
      "c",
      { terms: ["logo"], embedding: "[0.1]" },
      { query: "logo", fields: ["title"] },
    );
    expect(found.total).toBe(0);
    expect(calls.map((c) => c.p_embedding)).toEqual(["[0.1]", null]);
    vi.mocked(rpc).mockRejectedValueOnce(Object.assign(new Error("outro"), { code: "42501" }));
    await expect(
      searchTaskRowsMavi("c", { terms: ["logo"], embedding: "[0.1]" }, { query: "logo", fields: ["title"] }),
    ).rejects.toThrow("outro");
  });
  it("vários itens por filtro: qualquer um deles; e vai em listas para o banco", async () => {
    const data = demoSnapshot();
    const statuses = [...new Set(data.tasks.filter((t) => !t.archived).map((t) => t.status))].slice(0, 2);
    const all = ["title", "description", "comments"] as const;
    const one = searchTasksLocal(data, [], demoUser, { query: "", fields: [...all], status: statuses[0], limit: 500 });
    const two = searchTasksLocal(data, [], demoUser, {
      query: "",
      fields: [...all],
      status: statuses.join(","),
      limit: 500,
    });
    expect(one.length).toBeGreaterThan(0);
    expect(two.length).toBeGreaterThan(one.length);
    expect(two.every((h) => statuses.includes(h.status))).toBe(true);
    const calls: Record<string, unknown>[] = [];
    vi.mocked(rpc).mockImplementation(async (_name, args) => {
      calls.push(args as Record<string, unknown>);
      return [];
    });
    await searchTaskRowsMavi("c", { terms: [], embedding: null }, {
      query: "x",
      fields: [...all],
      status: "progress,review",
      assignee: "a,b,a",
    });
    expect(calls[0]).toMatchObject({
      p_statuses: ["progress", "review"],
      p_assignees: ["a", "b"],
      p_clients: null,
    });
    expect(filterValues(" a, ,b ")).toEqual(["a", "b"]);
  });
  it("termos que só repetem um filtro saem (\"andamento\" não vira palavra a procurar)", () => {
    expect(
      withoutFilterWords(
        ["andamento", "Em andamento", "entregues", "tarefas", "Ana Souza", "logo", "arte do feed", "cliente oculto"],
        ["Ana Souza"],
      ),
    ).toEqual(["logo", "arte do feed", "cliente oculto"]);
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

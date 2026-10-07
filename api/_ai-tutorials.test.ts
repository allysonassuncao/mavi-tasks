import { describe, expect, it, vi } from "vitest";
import { TOOLS, describeStep, runTool, searchTutorials, summarizeStep, type ToolContext } from "./_ai-tools";
import { INSTRUCTIONS } from "./_ai";
import { mcpTools, sourceLink } from "./_mcp";

const company = "00000000-0000-4000-8000-000000000001";
const tutorial = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const row = (over: Record<string, unknown> = {}) => ({
  tutorial_id: tutorial,
  title: "Como criar uma tarefa",
  summary: "O básico de Tarefas",
  modules: ["tasks"],
  category: "Primeiros passos",
  anchor: "prazo",
  section: "Prazo",
  content: "Seção: Prazo\nO prazo muda com um motivo.",
  ...over,
});

function ctx(rows: unknown[], screen?: string) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    if (url.endsWith("/rpc/search_tutorials")) return json(rows);
    return json(null);
  });
  const c: ToolContext = {
    supabaseUrl: "https://db.example.com",
    supabaseKey: "k",
    fetch: fetch as unknown as typeof globalThis.fetch,
    auth: "Bearer t",
    company,
    scope: { module: "assistant", ...(screen ? { screen } : {}) },
    embed: async () => ({ vectors: [[0.1]], tokens: 3, model: "text-embedding-3-small" }),
    members: new Map(),
    clients: new Map(),
    today: "2026-10-05",
    usage: { embeddingTokens: 0, embeddingModel: "" },
    sources: [],
    chunks: new Map(),
  };
  return { c, calls };
}

describe("a MAVI e os tutoriais", () => {
  it("busca primeiro na tela da pessoa, cita a seção e oferece o cartão", async () => {
    const { c, calls } = ctx(
      [row(), row({ anchor: "criar", section: "Criar" }), row({ tutorial_id: other, title: "Busca avançada", anchor: "", section: "" })],
      "tasks",
    );
    const cards: unknown[] = [];
    const out = await searchTutorials(c, { query: "mudar prazo" }, (card) => {
      cards.push(card);
      return `B${cards.length}`;
    });
    expect(calls[0].body).toMatchObject({ p_module: "tasks", p_strict: false, p_embedding: "[0.1]", p_limit: 6 });
    expect(out).toContain("[S1] Tutorial “Como criar uma tarefa” › Prazo · Tarefas\nSeção: Prazo");
    expect(out).toContain("[S3] Tutorial “Busca avançada” · Tarefas");
    expect(out).toContain("Escreva [[B#]] só do tutorial que responde à dúvida");
    expect(out).toContain("se nenhum responde, não escreva [[B#]]");
    // Um cartão por tutorial, a melhor seção de cada um.
    expect(cards).toEqual([
      { tutorial, anchor: "prazo", title: "Como criar uma tarefa", section: "Prazo", summary: "O básico de Tarefas" },
      { tutorial: other, anchor: "", title: "Busca avançada", section: "", summary: "O básico de Tarefas" },
    ]);
    expect(c.sources[0]).toMatchObject({ ref: "S1", type: "tutorial", id: tutorial, anchor: "prazo", label: "Prazo" });
    expect(c.usage.embeddingTokens).toBe(3);
    expect(summarizeStep("search_tutorials", out)).toBe("3 seções de tutoriais");
  });

  it("o módulo pedido vence a tela; módulo inventado não", async () => {
    const a = ctx([row()], "tasks");
    await runTool(a.c, "search_tutorials", { query: "saldo", module: "financeMedia" });
    expect(a.calls[0].body.p_module).toBe("financeMedia");
    const b = ctx([row()], "tasks");
    await runTool(b.c, "search_tutorials", { query: "saldo", module: "inventado" });
    expect(b.calls[0].body.p_module).toBe("tasks");
  });

  it("sem tutorial: não inventa e pede para registrar a dúvida", async () => {
    const { c } = ctx([]);
    const out = await runTool(c, "search_tutorials", { query: "exportar PDF" });
    expect(out).toMatch(/sem inventar/);
    expect(out).toMatch(/report_missing_tutorial/);
    expect(summarizeStep("search_tutorials", out)).toBe("nenhum tutorial");
  });

  it("registra a dúvida sem tutorial com a tela da pessoa", async () => {
    const { c, calls } = ctx([], "campaigns");
    const out = await runTool(c, "report_missing_tutorial", { question: "Como duplico um ciclo?" });
    expect(calls[0].url).toMatch(/\/rpc\/log_tutorial_gap$/);
    expect(calls[0].body).toEqual({
      p_company: company,
      p_question: "Como duplico um ciclo?",
      p_source: "mavi",
      p_module: "campaigns",
    });
    expect(out).toMatch(/Dúvida registrada/);
    expect(describeStep(c, "report_missing_tutorial", {})).toBe("Registrando a dúvida sem tutorial");
  });

  it("está nas instruções e no MCP (sem registrar dúvidas por lá)", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["search_tutorials", "report_missing_tutorial"]));
    expect(INSTRUCTIONS).toMatch(/search_tutorials/);
    expect(INSTRUCTIONS).toMatch(/report_missing_tutorial/);
    const names = mcpTools().map((t) => t.name);
    expect(names).toContain("search_tutorials");
    expect(names).not.toContain("report_missing_tutorial");
    expect(
      sourceLink("https://app.example", {
        ref: "S1",
        type: "tutorial",
        id: tutorial,
        title: "x",
        date: null,
        client_id: null,
        anchor: "prazo",
      }),
    ).toBe(`https://app.example/tutoriais?tutorial=${tutorial}#prazo`);
  });
});

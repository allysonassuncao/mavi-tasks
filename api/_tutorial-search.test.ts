import { describe, expect, it, vi } from "vitest";
import { answerContext, handleTutorialSearch, parseAnswer, type TutorialHit } from "./_tutorial-search";
import type { AiDeps, AiEnv } from "./_ai";

const company = "00000000-0000-4000-8000-000000000001";
const tutorial = "00000000-0000-4000-8000-000000000002";
const token = "Bearer x.y.z";
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  anthropicKey: "sk",
  openaiKey: "ok",
  model: "claude-haiku-4-5",
  providerKey: null,
} as unknown as AiEnv;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const hit = (over: Partial<TutorialHit> = {}): TutorialHit => ({
  chunk_id: 1,
  tutorial_id: tutorial,
  title: "Como criar uma tarefa",
  summary: "",
  modules: ["tasks"],
  category: "Primeiros passos",
  anchor: "prazo",
  section: "Prazo",
  content: "Seção: Prazo\nO prazo muda com um motivo.",
  score: 0.03,
  similarity: 0.8,
  words: 2,
  ...over,
});

function deps(hits: TutorialHit[], answer = '{"answer":"Mude o prazo e escreva o motivo [1].","cited":[1,5],"found":true}') {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/search_tutorials")) return json(hits);
    if (url.endsWith("/ai_check_limits")) return json({ blocked: false, message: null });
    return json(null);
  });
  const llm = vi.fn(async () => ({
    text: answer,
    rounds: 1,
    meter: { model: "claude-haiku-4-5", input: 500, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.0007 },
  }));
  const embed = vi.fn(async () => ({ vectors: [[0.5, 0.25]], tokens: 6, model: "text-embedding-3-small" }));
  return { d: { fetch, llm, embed } as unknown as AiDeps, calls, llm, embed };
}
const rpc = (calls: { url: string; body?: Record<string, unknown> }[], name: string) =>
  calls.filter((c) => c.url.endsWith(`/rpc/${name}`)).map((c) => c.body!);

describe("busca nos tutoriais", () => {
  it("lê a resposta da MAVI, mesmo com texto em volta", () => {
    expect(parseAnswer('Claro! {"answer":"Vá em Tarefas [2].","cited":[2,2,"x",-1],"found":true} fim')).toEqual({
      answer: "Vá em Tarefas [2].",
      cited: [2],
      found: true,
    });
    expect(parseAnswer('{"answer":"","cited":[],"found":true}')?.found).toBe(false);
    expect(parseAnswer("sem json")).toBeNull();
  });

  it("numera as seções para a MAVI", () => {
    expect(answerContext([hit(), hit({ section: "", title: "Outro" })])).toBe(
      "[1] Tutorial “Como criar uma tarefa” › Prazo\nSeção: Prazo\nO prazo muda com um motivo.\n\n[2] Tutorial “Outro”\nSeção: Prazo\nO prazo muda com um motivo.",
    );
  });

  it("busca com o vetor da pergunta, só no módulo escolhido, e devolve o vetor", async () => {
    const { d, calls, embed } = deps([hit()]);
    const res = await handleTutorialSearch(
      { action: "tutorial-search", company, query: "como mudo o prazo", module: "tasks", tags: ["Tarefas"] },
      token,
      env,
      d,
    );
    expect(res.status).toBe(200);
    expect(res.body.embedding).toBe("[0.5,0.25]");
    expect(embed).toHaveBeenCalledWith(["como mudo o prazo"]);
    expect(rpc(calls, "search_tutorials")[0]).toMatchObject({
      p_company: company,
      p_module: "tasks",
      p_strict: true,
      p_tags: ["Tarefas"],
      p_limit: 30,
    });
    expect(rpc(calls, "log_tutorial_gap")).toEqual([]);
    // O vetor custa e fica no consumo.
    expect(rpc(calls, "ai_log_usage")[0]).toMatchObject({ p_module: "tutorials", p_embedding: 6 });
  });

  it("sem nenhuma seção, a dúvida fica registrada", async () => {
    const { d, calls } = deps([]);
    const res = await handleTutorialSearch({ action: "tutorial-search", company, query: "exportar relatório" }, token, env, d);
    expect(res.body.hits).toEqual([]);
    expect(rpc(calls, "log_tutorial_gap")).toEqual([
      { p_company: company, p_question: "exportar relatório", p_source: "search", p_module: null },
    ]);
  });

  it("responde citando só as seções que existem, reaproveitando o vetor", async () => {
    const { d, calls, embed, llm } = deps([hit()]);
    const res = await handleTutorialSearch(
      { action: "tutorial-answer", company, query: "como mudo o prazo", embedding: "[0.5,0.25]" },
      token,
      env,
      d,
    );
    expect(embed).not.toHaveBeenCalled();
    expect(rpc(calls, "search_tutorials")[0]).toMatchObject({ p_embedding: "[0.5,0.25]", p_limit: 6 });
    expect(res.body).toEqual({
      answer: "Mude o prazo e escreva o motivo [1].",
      found: true,
      citations: [{ n: 1, tutorial_id: tutorial, title: "Como criar uma tarefa", anchor: "prazo", section: "Prazo" }],
    });
    const [call] = llm.mock.calls[0] as unknown as [{ context: string; messages: { content: string }[] }];
    expect(call.context).toContain("[1] Tutorial “Como criar uma tarefa” › Prazo");
    expect(rpc(calls, "ai_log_usage")[0]).toMatchObject({ p_kind: "tutorial_search", p_input: 500, p_cost: 0.0007 });
  });

  it("quando as seções não respondem, não inventa e registra a dúvida", async () => {
    const { d, calls } = deps([hit()], '{"answer":"","cited":[],"found":false}');
    const res = await handleTutorialSearch({ action: "tutorial-answer", company, query: "como exporto em PDF" }, token, env, d);
    expect(res.body).toEqual({ answer: "", found: false, citations: [] });
    expect(rpc(calls, "log_tutorial_gap")).toHaveLength(1);
  });

  it("pede login e empresa válida", async () => {
    const { d } = deps([]);
    expect((await handleTutorialSearch({ company, query: "x y" }, null, env, d)).status).toBe(401);
    expect((await handleTutorialSearch({ company: "x", query: "prazo" }, token, env, d)).status).toBe(400);
    expect((await handleTutorialSearch({ company, query: "a" }, token, env, d)).status).toBe(400);
  });
});

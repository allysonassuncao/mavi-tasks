import { describe, expect, it, vi } from "vitest";
import { handleTutorialWriter, parseDraft, writerMessage } from "./_tutorial-writer";
import type { AiDeps, AiEnv } from "./_ai";

const company = "00000000-0000-4000-8000-000000000001";
const token = "Bearer x.y.z";
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  anthropicKey: "sk",
  openaiKey: "ok",
  model: "claude-opus-5-5",
  providerKey: null,
} as unknown as AiEnv;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const DRAFT = JSON.stringify({
  title: "Como mudar o prazo de uma tarefa",
  summary: "Mude o prazo com um motivo.",
  blocks: [
    { type: "paragraph", text: "O prazo muda com um motivo." },
    { type: "heading", level: 2, text: "Mudar o prazo" },
    { type: "steps", items: ["Abra a tarefa.", "Clique em **Prazo**."] },
    { type: "media", n: 1 },
  ],
  notes: "Confira o nome do botão.",
});

function deps({ allowed = true, answer = DRAFT, refs = [{ title: "Prazos", section: "Regras", content: "Seção: Regras\nA regra mais específica vale." }] } = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/tutorial_can_write")) return json(allowed);
    if (url.endsWith("/ai_check_limits")) return json({ blocked: false, message: null });
    if (url.endsWith("/search_tutorials")) return json(refs);
    return json(null);
  });
  const llm = vi.fn(async () => ({
    text: answer,
    rounds: 1,
    meter: { model: "claude-opus-5-5", input: 1500, output: 900, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
  }));
  const embed = vi.fn(async () => ({ vectors: [[0.5, 0.25]], tokens: 8, model: "text-embedding-3-small" }));
  return { d: { fetch, llm, embed } as unknown as AiDeps, calls, llm };
}
const rpc = (calls: { url: string; body?: Record<string, unknown> }[], name: string) =>
  calls.filter((c) => c.url.endsWith(`/rpc/${name}`)).map((c) => c.body!);

describe("a MAVI escreve o tutorial", () => {
  it("confere a resposta: blocos válidos, mídias existentes e uma vez só", () => {
    const d = parseDraft(
      `Aqui está: ${JSON.stringify({
        title: "  Título   com espaços ",
        summary: "Resumo",
        blocks: [
          { type: "heading", level: 4, text: "Seção" },
          { type: "steps", items: ["Um", "", 3] },
          { type: "media", n: 2 },
          { type: "media", n: 2 },
          { type: "media", n: 9 },
          { type: "image", src: "x" },
          { type: "paragraph", text: "" },
        ],
      })}`,
      2,
    );
    expect(d).toEqual({
      title: "Título com espaços",
      summary: "Resumo",
      blocks: [
        { type: "heading", level: 2, text: "Seção" },
        { type: "steps", items: ["Um"] },
        { type: "media", n: 2 },
      ],
      notes: "",
    });
    expect(parseDraft("sem json", 0)).toBeNull();
    expect(parseDraft(JSON.stringify({ title: "Só mídia", blocks: [{ type: "media", n: 1 }] }), 1)).toBeNull();
  });

  it("monta o pedido conforme o modo", () => {
    const base = { idea: "", title: "", summary: "", source: "", modules: [], media: 0 };
    expect(writerMessage("idea", { ...base, idea: "Como mudar o prazo", modules: ["Tarefas"] })).toContain(
      "Escreva um tutorial novo a partir desta ideia",
    );
    const video = writerMessage("video", { ...base, source: "transcrição do vídeo", media: 1 });
    expect(video).toContain("Transcrição:");
    expect(video).toContain("[[MIDIA 1]]");
    expect(video).not.toContain("Texto atual do tutorial");
    expect(writerMessage("improve", { ...base, source: "texto", title: "T" })).toContain("Texto atual do tutorial");
  });

  it("escreve com as referências dos tutoriais e registra o custo", async () => {
    const { d, calls, llm } = deps();
    const res = await handleTutorialWriter(
      { company, mode: "idea", idea: "Como mudar o prazo de uma tarefa", modules: ["Tarefas"], module_ids: ["tasks"], media: 1 },
      token,
      env,
      d,
    );
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Como mudar o prazo de uma tarefa");
    expect(res.body.blocks).toHaveLength(4);
    expect(res.body.references).toBe(1);
    expect(rpc(calls, "search_tutorials")[0]).toMatchObject({ p_module: "tasks", p_strict: false, p_limit: 6 });
    const call = (llm.mock.calls[0] as unknown as [{ context: string }])[0];
    expect(call.context).toContain("“Prazos” › Regras");
    const usage = rpc(calls, "ai_log_usage");
    expect(usage.map((u) => [u.p_module, u.p_kind])).toEqual([
      ["tutorials", "tutorial_writer_idea"],
      ["tutorials", "tutorial_writer_idea"],
    ]);
  });

  it("recusa quem não pode, pedido vazio e vídeo sem transcrição", async () => {
    const { d, llm } = deps({ allowed: false });
    const denied = await handleTutorialWriter({ company, mode: "idea", idea: "Algo novo aqui" }, token, env, d);
    expect(denied.status).toBe(403);
    expect(llm).not.toHaveBeenCalled();
    const ok = deps();
    expect((await handleTutorialWriter({ company, mode: "idea", idea: "x" }, token, env, ok.d)).status).toBe(400);
    expect((await handleTutorialWriter({ company, mode: "video", source: "curta" }, token, env, ok.d)).status).toBe(400);
    expect((await handleTutorialWriter({ company, mode: "outro" }, token, env, ok.d)).status).toBe(400);
    expect((await handleTutorialWriter({ company, mode: "idea", idea: "Algo novo aqui" }, null, env, ok.d)).status).toBe(401);
  });

  it("resposta sem tutorial vira erro amigável", async () => {
    const { d } = deps({ answer: "não sei" });
    const res = await handleTutorialWriter({ company, mode: "improve", source: "Um texto de tutorial qualquer aqui." }, token, env, d);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/não conseguiu escrever/);
  });
});

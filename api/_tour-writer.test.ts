import { describe, expect, it, vi } from "vitest";
import { handleTourWriter, tourWriterMessage } from "./_tour-writer";
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
const ANSWER = JSON.stringify({
  title: "Crie sua primeira tarefa",
  blocks: [
    { type: "paragraph", text: "Clique em **Nova tarefa** para continuar." },
    { type: "heading", level: 2, text: "Não cabe num balão" },
  ],
  notes: "",
});

function deps({ allowed = true, answer = ANSWER } = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/tutorial_can_write")) return json(allowed);
    if (url.endsWith("/ai_check_limits")) return json({ blocked: false, message: null });
    if (url.endsWith("/search_tutorials")) return json([{ title: "Tarefas", section: "Criar", content: "Use **Nova tarefa**." }]);
    return json(null);
  });
  const llm = vi.fn(async () => ({
    text: answer,
    rounds: 1,
    meter: { model: "claude-opus-5-5", input: 900, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.004 },
  }));
  return { d: { fetch, llm, embed: vi.fn() } as unknown as AiDeps, calls, llm };
}
const request = {
  company,
  mode: "write",
  tour: "Primeiros passos nas Tarefas",
  n: 2,
  total: 5,
  screen: "Tarefas",
  element: "Botão “Nova tarefa”",
  kind: "click",
  before: ["Bem-vindo às Tarefas"],
  after: ["Escolha o cliente"],
};

describe("a MAVI sugere o balão do passo", () => {
  it("o pedido leva a tela, o elemento, o tipo e os passos em volta", () => {
    const m = tourWriterMessage({
      mode: "improve",
      idea: "mais curto",
      tour: "Tour",
      summary: "",
      n: 2,
      total: 3,
      screen: "Tarefas",
      element: "Botão “Nova tarefa”",
      context: "Tarefas",
      kind: "input",
      title: "Antes",
      text: "Texto antigo",
      before: ["Um"],
      after: ["Três"],
    });
    expect(m).toContain("Melhore o balão");
    expect(m).toContain("Passo 2 de 3, na tela Tarefas.");
    expect(m).toContain("Esperar preencher");
    expect(m).toContain("Passos antes: “Um”");
    expect(m).toContain("Texto: Texto antigo");
    expect(m).toContain("mais curto");
  });

  it("devolve título e texto (só parágrafos e listas) e registra o uso", async () => {
    const { d, calls, llm } = deps();
    const r = await handleTourWriter(request, token, env, d);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("Crie sua primeira tarefa");
    expect(r.body.blocks).toEqual([{ type: "paragraph", text: "Clique em **Nova tarefa** para continuar." }]);
    expect(llm).toHaveBeenCalledOnce();
    const usage = calls.find((c) => c.url.endsWith("/rpc/ai_log_usage"))!.body!;
    expect(usage.p_kind).toBe("tour_writer");
    expect(usage.p_module).toBe("tutorials");
  });

  it("recusa quem não pode escrever e resposta sem JSON", async () => {
    const no = deps({ allowed: false });
    expect((await handleTourWriter(request, token, env, no.d)).status).toBe(403);
    expect(no.llm).not.toHaveBeenCalled();
    const bad = deps({ answer: "não sei" });
    expect((await handleTourWriter(request, token, env, bad.d)).status).toBe(502);
    expect((await handleTourWriter({ ...request, tour: "" }, token, env, deps().d)).status).toBe(400);
    expect((await handleTourWriter(request, null, env, deps().d)).status).toBe(401);
  });
});

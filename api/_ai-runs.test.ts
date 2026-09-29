import { describe, expect, it, vi } from "vitest";
import { handleAi, streamAi, type AiEnv, type AiStreamEvent, type Live } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const run = "00000000-0000-4000-8000-0000000000r1".replace("r1", "e1");
const conversation = "00000000-0000-4000-8000-0000000000c9";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
};
const lookup = async () => [{ address: "93.184.216.34" }];

type Call = { url: string; body: any };
function world(routes: Record<string, (c: Call) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    let body: any = init?.body;
    try {
      body = JSON.parse(String(init?.body));
    } catch {
      /* não é JSON */
    }
    const call = { url, body };
    calls.push(call);
    const k = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((x) => url.includes(x));
    if (!k) return new Response("[]", { status: 200 });
    const data = routes[k](call);
    return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const base = (detach: boolean, powers: string[] = []) => ({
  "memberships?": () => [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
  "rpc/ai_check_limits": () => ({ blocked: false, message: null, warnings: [] }),
  "rpc/ai_resolve_route": () => null,
  "rpc/ai_my_powers": () => powers,
  "rpc/ai_run_start": () => ({ id: run, conversation, created: true }),
  "rpc/ai_run_detach": () => detach,
  "rpc/ai_run_should_stop": () => false,
  "rpc/ai_run_finish": () => null,
  "rpc/ai_save_turn": () => conversation,
  "rpc/ai_log_usage": () => null,
  "rpc/ai_log_tool_calls": () => null,
});
/** A conexão que cai quando o teste manda. */
function connection() {
  const listeners: (() => void)[] = [];
  const live: Live = { onClose: (l) => listeners.push(l) };
  return { live, drop: () => listeners.splice(0).forEach((l) => l()) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("sair no meio: a resposta continua e avisa", () => {
  it("a conversa nasce no começo; a conexão cai; termina, salva e avisa (o banco)", async () => {
    const { fetchImpl, calls } = world({
      ...base(false, ["scrape"]),
      "https://concorrente.com.br/robots.txt": () => new Response("", { status: 404 }),
      "https://concorrente.com.br/planos": () =>
        new Response("<html><head><title>Planos</title></head><body><main><p>Pro: R$ 199</p></main></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    const { live, drop } = connection();
    let request: AgentRequest | undefined;
    let read = "";
    const llm: LlmAdapter = async (r) => {
      request = r;
      drop();
      await tick();
      read = await r.execute("scrape_pages", { urls: ["https://concorrente.com.br/planos"] });
      return { text: "O Pro custa R$ 199 [S1].", meter: newMeter("claude-opus-5"), rounds: 2 };
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Quanto custa o Pro?", surface: "page" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn(), lookup },
      (e) => events.push(e),
      live,
    );
    expect(events.find((e) => e.type === "run")).toEqual({ type: "run", id: run, conversation });
    const start = calls.find((c) => c.url.includes("ai_run_start"))!.body;
    expect(start).toMatchObject({ p_company: company, p_conversation: null, p_question: "Quanto custa o Pro?" });
    expect(calls.some((c) => c.url.includes("ai_run_detach"))).toBe(true);
    // Em segundo plano, confere se é para parar antes de cada ferramenta.
    expect(calls.some((c) => c.url.includes("ai_run_should_stop"))).toBe(true);
    // Leitura de páginas: entrou pelo poder, e a página virou fonte.
    expect(request!.tools.map((t) => t.name)).toContain("scrape_pages");
    expect(read).toContain("[S1] Planos");
    expect(read).toContain("Pro: R$ 199");
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done).toMatchObject({ type: "done", conversation });
    expect(done.sources[0]).toMatchObject({ ref: "S1", type: "web", url: "https://concorrente.com.br/planos" });
    const steps = events.filter((e) => e.type === "step").map((e: any) => e.label);
    expect(steps).toContain("Lendo concorrente.com.br");
    expect(calls.find((c) => c.url.includes("ai_save_turn"))!.body.p_conversation).toBe(conversation);
    expect(calls.find((c) => c.url.includes("ai_run_finish"))!.body).toEqual({ p_run: run, p_status: "done", p_error: null });
  });

  it("parar: o que já tinha chegado fica na conversa, marcado; sem aviso", async () => {
    const { fetchImpl, calls } = world(base(true));
    const { live, drop } = connection();
    const llm: LlmAdapter = (r) =>
      new Promise((_, reject) => {
        r.onEvent?.({ type: "text", text: "Começando a resposta" });
        r.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(drop, 1);
      });
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Pergunta longa", surface: "page" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn(), lookup },
      (e) => events.push(e),
      live,
    );
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.answer).toBe("Começando a resposta\n\n*(Resposta interrompida por você.)*");
    expect(calls.find((c) => c.url.includes("ai_save_turn"))!.body.p_answer).toBe(done.answer);
    expect(calls.find((c) => c.url.includes("ai_run_finish"))!.body.p_status).toBe("cancelled");
  });

  it("falhou: a execução termina com erro (o banco avisa quem saiu)", async () => {
    const { fetchImpl, calls } = world(base(false));
    const { live } = connection();
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Oi", surface: "page" },
      token,
      env,
      {
        fetch: fetchImpl,
        llm: async () => {
          throw Object.assign(new Error("caiu"), { status: 529 });
        },
        embed: vi.fn(),
      },
      (e) => events.push(e),
      live,
    );
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(calls.find((c) => c.url.includes("ai_run_finish"))!.body).toMatchObject({ p_run: run, p_status: "error" });
    expect(calls.some((c) => c.url.includes("ai_save_turn"))).toBe(false);
  });

  it("sem tempo real (a pergunta em uma chamada): sem execução", async () => {
    const { fetchImpl, calls } = world(base(false));
    const r = await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Oi" },
      token,
      env,
      {
        fetch: fetchImpl,
        llm: async () => ({ text: "Olá", meter: newMeter("x"), rounds: 1 }),
        embed: vi.fn(),
      },
    );
    expect(r.status).toBe(200);
    expect(calls.some((c) => c.url.includes("ai_run_"))).toBe(false);
  });
});

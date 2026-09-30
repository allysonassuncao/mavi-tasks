import { describe, expect, it, vi } from "vitest";
import { streamAi, handleAi, type AiEnv, type AiStreamEvent } from "./_ai";
import { LIMIT_NOTE, anthropicAdapter, type AgentRequest, type LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import { clientTerms, clip, runTool, type ToolContext } from "./_ai-tools";
import {
  assembleDocument,
  chapter,
  estimateTask,
  mergeSources,
  parsePlan,
  runSlice,
  selfOrigin,
  type TaskHost,
  type TaskState,
} from "./_ai-tasks";
import { sanitizeArtifact } from "../src/mavi-artifacts";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const c1 = "00000000-0000-4000-8000-0000000000a1";
const c2 = "00000000-0000-4000-8000-0000000000a2";
const conversation = "00000000-0000-4000-8000-0000000000c9";
const task = "00000000-0000-4000-8000-0000000000f1";
const turn = "00000000-0000-4000-8000-0000000000f2";
const run = "00000000-0000-4000-8000-0000000000e1";
const future = Math.floor(Date.now() / 1000) + 3600;
const token = (exp = future) =>
  `Bearer x.${Buffer.from(JSON.stringify({ sub: me, exp })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
};

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
const rpcs = (calls: Call[], name: string) => calls.filter((c) => c.url.endsWith(`/rpc/${name}`));

describe("vários clientes de uma vez", () => {
  it("os códigos viram um termo por cliente", () => {
    expect(clientTerms("5022, 5017, 5052")).toEqual(["5022", "5017", "5052"]);
    expect(clientTerms("5022 5017 5052")).toEqual(["5022", "5017", "5052"]);
    expect(clientTerms("5022;5017\n5022")).toEqual(["5022", "5017"]);
    // Um nome com espaço continua um nome só.
    expect(clientTerms("Padaria Pão Quente")).toEqual(["Padaria Pão Quente"]);
    expect(clientTerms("(4282)*")).toEqual(["4282"]);
  });

  it("find_clients: uma consulta, o nome igual primeiro e os que faltaram", async () => {
    const { fetchImpl, calls } = world({
      "/rest/v1/clients?": () => [
        { id: c1, name: "5022", contracts: [{ name: "Make Ads", archived: false, products: { name: "Make Ads" } }] },
        { id: c2, name: "15022", contracts: [] },
        { id: "00000000-0000-4000-8000-0000000000a3", name: "5017", contracts: [] },
      ],
    });
    const ctx = toolCtx(fetchImpl);
    const out = await runTool(ctx, "find_clients", { query: "5022, 5017, 9999" });
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0].url)).toContain('or=(name.ilike."*5022*",name.ilike."*5017*",name.ilike."*9999*")');
    expect(out).toContain(`- Cliente 5022 (id ${c1}) · produtos: Make Ads`);
    // O 15022 também contém 5022, mas o nome igual vale.
    expect(out).not.toContain("15022");
    expect(out).toContain("Não encontrados entre os que a pessoa acessa: 9999.");
    expect(out.startsWith("2 de 3 clientes encontrados")).toBe(true);
  });

  it("client_overview: todas as partes de cada cliente, cortadas, com fontes e sem travar", async () => {
    const { fetchImpl, calls } = world({
      "/rest/v1/clients?": () => [
        { id: c1, name: "5022", contracts: [{ name: "Make Ads", archived: false, products: { name: "Make Ads" } }] },
      ],
      "rpc/client_dossier": () => ({ items: [{ kind: "prefers", text: "Prefere vídeos curtos" }], pending: false }),
      "rpc/ai_search": (c) => [
        {
          chunk_id: 1,
          source_type: c.body.p_filters.types.includes("whatsapp") ? "whatsapp" : "drive_file",
          source_id: "f1",
          title: "Briefing 5022",
          content: "cabeçalho\nObjetivo: vender mais",
          meta: {},
          client_id: c1,
          contract_id: null,
          occurred_at: "2026-09-10",
          task_status: null,
          task_assignee: null,
          task_due: null,
        },
      ],
      "/rest/v1/meeting_recordings?": () => [
        {
          id: "m1",
          client_id: c1,
          title: "Alinhamento",
          recorded_at: "2026-09-20T15:00:00Z",
          recorded_by_email: "ana@x.com",
          duration_seconds: 1800,
          topic: "Alinhamento de setembro",
          overview: "Combinamos nova campanha. ".repeat(40),
        },
      ],
      "/rest/v1/contracts?": () => [{ id: "k1" }],
      "/rest/v1/tasks?": () => [
        { id: "t1", title: "Criar artes", status: "progress", due_date: "2026-09-01", assignee_id: me, created_at: "2026-08-01" },
      ],
      "rpc/ai_campaign_results": () => Response.json({ message: "Sem permissão." }, { status: 403 }),
      "rpc/client_temperature": () => ({
        settings: { bands: [{ name: "Frio", min: 0, alert: true }, { name: "Morno", min: 40, alert: false }], window_days: 60 },
        indicators: [],
        current: { score: 55, band: 1, score_d7: -3, score_d30: null, signals: 4, indicators: [], flags: [], reasons: [] },
        summary: null,
        refreshed_at: null,
        signals: [],
        pending: 0,
        jev: true,
      }),
      "rpc/radar_ai": () => ({ scope: "client", leader: true, today: "2026-09-30", started_at: null, topics: [], items: [], total: 0, themes: [], report: null }),
    });
    const ctx = toolCtx(fetchImpl);
    const out = await runTool(ctx, "client_overview", { client_ids: [c1, "nope", c2] });
    expect(out).toContain(`## Cliente 5022 (id ${c1})`);
    // O c2 não está entre os clientes da pessoa: fica de fora.
    expect(out).not.toContain(c2);
    for (const t of ["Produtos contratados", "Dossiê da MAVI", "Briefing", "Reuniões recentes", "Tarefas em aberto", "Campanhas", "Termômetro", "Radar", "WhatsApp"])
      expect(out).toContain(t);
    expect(out).toContain("- Gosta / prefere: Prefere vídeos curtos");
    expect(out).toContain("Make Ads");
    // Uma parte que falha não derruba as outras.
    expect(out).toContain("(não deu para ler agora: Sem permissão.)");
    expect(out).toMatch(/\[S\d+\] Arquivo "Briefing 5022"/);
    expect(out).toContain("55/100");
    // A mesma frase de busca não gera dois vetores.
    expect(ctx.embed).toHaveBeenCalledTimes(2);
    expect(rpcs(calls, "ai_search")).toHaveLength(2);
  });

  it("clip corta no fim da linha e avisa", () => {
    const text = "linha um\nlinha dois\nlinha três";
    expect(clip(text, 100)).toBe(text);
    expect(clip(text, 22)).toBe("linha um\nlinha dois\n(… cortado: há mais; peça a ferramenta específica para ver tudo)");
  });
});

function toolCtx(fetchImpl: typeof fetch): ToolContext {
  return {
    supabaseUrl: env.supabaseUrl,
    supabaseKey: env.supabaseKey,
    fetch: fetchImpl,
    auth: token(),
    company,
    scope: {},
    embed: vi.fn(async () => ({ vectors: [[0.1]], tokens: 3, model: "text-embedding-3-small" })),
    members: new Map([[me, { name: "Ana", email: "ana@x.com" }]]),
    clients: new Map([[c1, "5022"]]),
    today: "2026-09-30",
    usage: { embeddingTokens: 0, embeddingModel: "text-embedding-3-small" },
    sources: [],
    chunks: new Map(),
  };
}

describe("limite de passos", () => {
  it("na última rodada, a MAVI é avisada e a resposta sai marcada", async () => {
    const requests: any[] = [];
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "a", name: "search_knowledge", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Achei a verba [S1]. Faltou o briefing." }] },
    ];
    const client = {
      beta: {
        messages: {
          stream: (params: any) => {
            requests.push(JSON.parse(JSON.stringify(params)));
            const reply = replies[requests.length - 1];
            return {
              on: () => undefined,
              finalMessage: async () => ({ model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 }, ...reply }),
            };
          },
        },
      },
    };
    const out = await anthropicAdapter({ anthropicKey: "", model: "claude-opus-5-5" }, client as never)({
      instructions: "i",
      context: "c",
      messages: [{ role: "user", content: "Tudo dos clientes" }],
      tools: [{ name: "search_knowledge", description: "", parameters: {} }],
      execute: async () => "[S1] trecho",
      maxRounds: 1,
    });
    expect(out.capped).toBe(true);
    expect(requests[1].tool_choice).toEqual({ type: "none" });
    expect(requests[1].messages.at(-1).content.at(-1)).toEqual({ type: "text", text: LIMIT_NOTE });
  });

  it("terminou antes do limite: sem aviso nem marca", async () => {
    const client = {
      beta: {
        messages: {
          stream: () => ({
            on: () => undefined,
            finalMessage: async () => ({
              model: "claude-opus-5-5",
              usage: { input_tokens: 1, output_tokens: 1 },
              stop_reason: "end_turn",
              content: [{ type: "text", text: "Pronto." }],
            }),
          }),
        },
      },
    };
    const out = await anthropicAdapter({ anthropicKey: "", model: "claude-opus-5-5" }, client as never)({
      instructions: "i",
      context: "c",
      messages: [{ role: "user", content: "Oi" }],
      tools: [],
      execute: async () => "",
      maxRounds: 1,
    });
    expect(out.capped).toBeUndefined();
  });
});

describe("o plano", () => {
  const clients = new Map([
    [c1, "5022"],
    [c2, "5017"],
  ]);
  it("confere título, pedido, etapas e só os clientes que a pessoa acessa", () => {
    expect(parsePlan({ title: "x" }, clients)).toBe("Dê um título ao documento.");
    expect(parsePlan({ title: "Passagem", goal: "curto" }, clients)).toMatch(/goal/);
    expect(parsePlan({ title: "Passagem", goal: "O pedido completo da pessoa", steps: [] }, clients)).toMatch(/pelo menos uma etapa/);
    const plan = parsePlan(
      {
        title: "Passagem de clientes",
        goal: "O pedido completo da pessoa",
        steps: [
          { title: "Cliente 5022", instructions: "Tudo", client_ids: [c1, "outro", c1] },
          { title: "", instructions: "sem título" },
        ],
        closing: { title: "Resumo da carteira", instructions: "Tabela" },
      },
      clients,
    );
    expect(plan).toEqual({
      title: "Passagem de clientes",
      goal: "O pedido completo da pessoa",
      steps: [{ title: "Cliente 5022", instructions: "Tudo", client_ids: [c1] }],
      closing: { title: "Resumo da carteira", instructions: "Tabela" },
    });
  });

  it("a estimativa: a conta de tokens, ou a média das últimas tarefas", () => {
    const plan = { steps: Array.from({ length: 17 }, () => ({ title: "x", instructions: "", client_ids: [] })), closing: { title: "R", instructions: "" } };
    const byTokens = estimateTask(plan, "claude-opus-5-5");
    // Entre US$ 3 e US$ 10 para a passagem de 17 clientes.
    expect(byTokens.total).toBeGreaterThan(3);
    expect(byTokens.total).toBeLessThan(10);
    const byBasis = estimateTask(plan, "claude-opus-5-5", null, { step: 0.2, steps: 30 });
    expect(byBasis.perStep).toBeCloseTo(0.22);
    // Pouca história: fica a conta de tokens.
    expect(estimateTask(plan, "claude-opus-5-5", null, { step: 0.2, steps: 2 }).perStep).toBe(byTokens.perStep);
  });

  it("na conversa: monta o plano, mostra o card e para", async () => {
    const { fetchImpl, calls } = world({
      "memberships?": () => [{ user_id: me, name: "Ana", email: "", role: "admin", active: true }],
      "/rest/v1/clients?": () => [
        { id: c1, name: "5022" },
        { id: c2, name: "5017" },
      ],
      "rpc/ai_check_limits": () => ({ blocked: false, message: null, warnings: [] }),
      "rpc/ai_resolve_route": () => null,
      "rpc/ai_my_powers": () => [],
      "rpc/ai_run_start": () => ({ id: run, conversation, created: true }),
      "rpc/ai_run_finish": () => null,
      "rpc/ai_save_turn": () => conversation,
      "rpc/ai_task_basis": () => ({ step: null, steps: 0 }),
      "rpc/ai_task_create": () => ({ id: task, cap: 10 }),
    });
    let request: AgentRequest | undefined;
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      request = r;
      outputs.push(
        String(
          await r.execute("plan_long_task", {
            title: "Passagem de clientes",
            goal: "Briefing, reuniões, performance, pendências e temperatura de cada cliente",
            steps: [
              { title: "Cliente 5022", instructions: "Tudo", client_ids: [c1] },
              { title: "Cliente 5017", instructions: "Tudo", client_ids: [c2] },
            ],
            closing: { title: "Resumo da carteira", instructions: "Tabela" },
          }),
        ),
      );
      outputs.push(String(await r.execute("client_overview", { client_ids: [c1] })));
      return { text: "Montei o plano: confira e confirme.\n\n[[T1]]", meter: newMeter("claude-opus-5-5"), rounds: 1 };
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, question: "Monte a passagem dos clientes 5022 e 5017", surface: "page" },
      token(),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
      { onClose: () => {} },
    );
    expect(request!.tools.map((t) => t.name)).toContain("plan_long_task");
    expect(request!.instructions).toContain("Tarefas longas (plan_long_task)");
    expect(outputs[0]).toMatch(/^Plano montado \[\[T1\]\]: 2 etapas e a parte final "Resumo da carteira", custo estimado de US\$ \d+,\d{2} \(teto por tarefa: US\$ 10,00\)/);
    // Depois do plano, nada mais roda nesta resposta.
    expect(outputs[1]).toMatch(/já está no card/);
    const [create] = rpcs(calls, "ai_task_create");
    expect(create.body.p_conversation).toBe(conversation);
    expect(create.body.p_steps).toHaveLength(2);
    expect(create.body.p_estimate).toBeGreaterThan(0);
    const done = events.find((e) => e.type === "done") as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.artifacts).toHaveLength(1);
    const card = sanitizeArtifact(done.artifacts[0]);
    expect(card).toMatchObject({ type: "task", ref: "T1", task, title: "Passagem de clientes", steps: 2, cap: 10 });
    const [save] = rpcs(calls, "ai_save_turn");
    expect(save.body.p_artifacts[0].task).toBe(task);
  });
});

describe("fontes e documento", () => {
  it("as fontes da etapa passam a ser da tarefa", () => {
    const all = [{ ref: "S1", type: "meeting" as const, id: "m1", title: "Reunião", date: null, client_id: null }];
    const local = [
      { ref: "S1", type: "task" as const, id: "t1", title: "Tarefa", date: null, client_id: null },
      { ref: "S2", type: "meeting" as const, id: "m1", title: "Reunião", date: null, client_id: null },
    ];
    const out = mergeSources(all, local, "A tarefa [S1] e a reunião [S2]; inventada [S9].");
    expect(out.text).toBe("A tarefa [S2] e a reunião [S1]; inventada .");
    expect(out.added).toEqual([{ ...local[0], ref: "S2" }]);
  });

  it("o capítulo começa pelo título e o documento lista só as fontes citadas", () => {
    expect(chapter("Cliente 5022", "Texto")).toBe("## Cliente 5022\n\nTexto");
    expect(chapter("Cliente 5022", "## 5022 · Make Ads\nTexto")).toBe("## 5022 · Make Ads\nTexto");
    const doc = assembleDocument(
      {
        title: "Passagem",
        closing: { title: "Resumo", instructions: "" },
        sources: [
          { ref: "S1", type: "meeting", id: "m1", title: "Alinhamento", date: "2026-09-20T15:00:00Z", client_id: null },
          { ref: "S2", type: "task", id: "t1", title: "Não citada", date: null, client_id: null },
        ],
        steps: [
          { ord: 1, title: "Cliente 5022", instructions: "", client_ids: [], status: "done", result: "Combinado [S1].", cost: 0, attempts: 1 },
          { ord: 2, title: "Cliente 5017", instructions: "", client_ids: [], status: "pending", error: "caiu", cost: 0, attempts: 3 },
        ],
      },
      { today: "2026-09-30", who: "Ana", closingText: "Tudo certo [S1].", missing: "Faltou o 5017." },
    );
    expect(doc.done).toBe(1);
    expect(doc.markdown).toContain("# Passagem\n\n_Preparado pela MAVI em 30/09/2026 para Ana. 1 de 2 partes prontas._");
    expect(doc.markdown).toContain("> Faltou o 5017.");
    expect(doc.markdown.indexOf("## Resumo")).toBeLessThan(doc.markdown.indexOf("## Cliente 5022"));
    expect(doc.markdown).toContain("## Cliente 5017\n\n_Esta parte não ficou pronta (caiu)._");
    expect(doc.markdown).toContain("## Fontes\n\n- [S1] Reunião “Alinhamento” · 20/09/2026");
    expect(doc.markdown).not.toContain("Não citada");
    expect(doc.cited.map((s) => s.ref)).toEqual(["S1"]);
  });

  it("a próxima fatia vai para o app ou para a Vercel, nunca para outro lugar", () => {
    const app = "https://workspace.maso.app.br";
    expect(selfOrigin("workspace.maso.app.br", app)).toBe(app);
    expect(selfOrigin("mavi-git-main-make.vercel.app", app)).toBe("https://mavi-git-main-make.vercel.app");
    expect(selfOrigin("evil.example.com", app)).toBe(app);
    expect(selfOrigin(undefined, app, "https://outro.maso.app.br/")).toBe("https://outro.maso.app.br");
  });
});

// ------------------------------------------------------------ as fatias
const host: TaskHost = {
  instructions: "Você é a MAVI.",
  buildContext: async () => ({
    context: "Hoje é 30/09/2026.",
    members: new Map([[me, { name: "Ana Souza", email: "ana@x.com" }]]),
    clients: new Map([
      [c1, "5022"],
      [c2, "5017"],
    ]),
    today: "2026-09-30",
  }),
  effort: () => undefined,
};
const taskEnv = { ...env, sliceMs: 250_000 };
function state(steps: number, extra: Partial<TaskState> = {}): TaskState {
  return {
    id: task,
    company_id: company,
    conversation,
    module: "assistant",
    title: "Passagem de clientes",
    goal: "Briefing e pendências de cada cliente",
    closing: { title: "Resumo da carteira", instructions: "Uma tabela" },
    status: "running",
    cap: 10,
    spent: 0,
    estimate: 4,
    turn,
    slices: 1,
    sources: [],
    steps: Array.from({ length: steps }, (_, i) => ({
      ord: i + 1,
      title: `Cliente ${i + 1}`,
      instructions: "Tudo",
      client_ids: [i % 2 ? c2 : c1],
      status: "pending" as const,
      cost: 0,
      attempts: 0,
    })),
    ...extra,
  };
}
function taskWorld(t: TaskState | null, extra: Record<string, (c: Call) => unknown> = {}) {
  let spent = 0;
  return world({
    "rpc/ai_task_claim": () => t,
    "rpc/ai_efforts": () => ({}),
    "rpc/ai_resolve_route": () => null,
    "rpc/ai_check_limits": () => ({ blocked: false, message: null, warnings: [] }),
    "rpc/ai_task_step_start": () => ({ status: "running", spent, cap: 10, run: true }),
    "rpc/ai_task_step_save": (c) => {
      spent += c.body.p_cost;
      return { status: "running", spent, cap: 10 };
    },
    "rpc/ai_task_release": () => null,
    "rpc/ai_task_finish": () => 42,
    "rpc/ai_usage_close_turn": () => 42,
    "rpc/ai_log_usage": () => null,
    "rpc/ai_log_tool_calls": () => null,
    "/rest/v1/ai_messages?": () => [{ artifacts: [{ ref: "D1" }, { ref: "T1" }] }],
    ...extra,
  });
}
/** A MAVI da etapa: busca uma vez e escreve o capítulo citando. */
const stepLlm = (): LlmAdapter => async (r) => {
  if (!r.tools.length) {
    const meter = newMeter("claude-opus-5-5");
    meter.cost = 0.05;
    return { text: "## Resumo da carteira\n\n| Cliente | Situação |\n|---|---|\n| 5022 | ok [S1] |", meter, rounds: 0 };
  }
  const out = String(await r.execute("list_tasks", { open_only: true }));
  const ref = /\[(S\d+)\]/.exec(out)?.[1] ?? "S1";
  r.onRound?.({ model: "claude-opus-5-5", input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.3, tools: ["list_tasks"] });
  const meter = newMeter("claude-opus-5-5");
  meter.cost = 0.3;
  meter.input = 100;
  meter.output = 50;
  return { text: `## ${/"([^"]+)"/.exec(r.messages[0].content)?.[1]}\n\nTarefa em andamento [${ref}]. Tudo o que importa sobre o cliente.`, meter, rounds: 1 };
};

describe("tarefa longa no servidor", () => {
  it("faz as etapas, escreve a parte final, entrega o documento e liga o custo", async () => {
    const { fetchImpl, calls } = taskWorld(state(2), {
      "/rest/v1/contracts?": () => [{ id: "k1" }],
      "/rest/v1/tasks?": () => [
        { id: "t1", title: "Criar artes", status: "progress", due_date: "2026-10-10", assignee_id: me, created_at: "2026-09-01" },
      ],
    });
    const out = await runSlice(token(), task, taskEnv, { fetch: fetchImpl, llm: stepLlm(), embed: vi.fn() }, host);
    expect(out).toBe("finished");
    const saves = rpcs(calls, "ai_task_step_save");
    expect(saves.map((s) => [s.body.p_ord, s.body.p_status])).toEqual([
      [1, "done"],
      [2, "done"],
    ]);
    expect(saves[0].body.p_result).toMatch(/^## Cliente 1\n\nTarefa em andamento \[S1\]/);
    // A mesma tarefa na segunda etapa: a mesma fonte da tarefa, sem repetir.
    expect(saves[1].body.p_result).toContain("[S1]");
    expect(saves[1].body.p_sources).toEqual([]);
    expect(saves[0].body.p_cost).toBeCloseTo(0.3);
    const [finish] = rpcs(calls, "ai_task_finish");
    expect(finish.body.p_status).toBe("done");
    const doc = finish.body.p_artifacts[0];
    expect(doc.ref).toBe("D2");
    expect(doc.canvas.markdown).toContain("# Passagem de clientes");
    expect(doc.canvas.markdown).toContain("## Resumo da carteira");
    expect(doc.canvas.markdown).toContain("## Cliente 2");
    expect(doc.canvas.markdown).toContain("## Fontes");
    expect(doc.canvas.markdown).toContain("para Ana Souza");
    expect(finish.body.p_answer).toContain("[[D2]]");
    expect(sanitizeArtifact(doc)).not.toBeNull();
    // O gasto das etapas e da parte final fica na vez da tarefa, com o cliente.
    const usage = rpcs(calls, "ai_log_usage");
    expect(usage.every((u) => u.body.p_turn === turn && u.body.p_conversation === conversation)).toBe(true);
    expect(usage.filter((u) => u.body.p_kind === "task").map((u) => u.body.p_client)).toEqual([c1, c2, null]);
    const [close] = rpcs(calls, "ai_usage_close_turn");
    expect(close.body).toEqual({ p_conversation: conversation, p_turn: turn });
    // A tarefa roda como a pessoa: o token dela em tudo.
    expect(calls.filter((c) => c.url.includes("/rpc/")).length).toBeGreaterThan(5);
  });

  it("sem tempo para todas: solta a vez e chama a próxima fatia", async () => {
    let clock = 0;
    const { fetchImpl, calls } = taskWorld(state(5));
    const llm: LlmAdapter = async (r) => {
      clock += 60_000;
      return stepLlm()(r);
    };
    const next = vi.fn(async () => true);
    const out = await runSlice(token(), task, taskEnv, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => clock, next }, host);
    expect(out).toBe("next");
    expect(next).toHaveBeenCalledWith(token(), task);
    // 3 ao mesmo tempo; depois de 60 s ainda cabe mais uma leva? Não: faltam só 190 s.
    expect(rpcs(calls, "ai_task_step_save").length).toBeLessThan(5);
    expect(rpcs(calls, "ai_task_release").map((c) => c.body.p_status)).toEqual(["running"]);
    expect(rpcs(calls, "ai_task_finish")).toHaveLength(0);
  });

  it("a próxima fatia não começou: pausa com o motivo", async () => {
    let clock = 0;
    const { fetchImpl, calls } = taskWorld(state(5));
    const llm: LlmAdapter = async (r) => {
      clock += 60_000;
      return stepLlm()(r);
    };
    const out = await runSlice(token(), task, taskEnv, { fetch: fetchImpl, llm, embed: vi.fn(), now: () => clock }, host);
    expect(out).toBe("paused");
    const releases = rpcs(calls, "ai_task_release");
    expect(releases.at(-1)!.body.p_status).toBe("paused");
    expect(releases.at(-1)!.body.p_reason).toMatch(/continua quando você abrir/);
  });

  it("perto do teto: entrega o que tem e diz o que faltou", async () => {
    const { fetchImpl, calls } = taskWorld(state(3, { spent: 9.7, cap: 10 }));
    const out = await runSlice(token(), task, taskEnv, { fetch: fetchImpl, llm: stepLlm(), embed: vi.fn() }, host);
    expect(out).toBe("finished");
    expect(rpcs(calls, "ai_task_step_start")).toHaveLength(0);
    const [finish] = rpcs(calls, "ai_task_finish");
    // Nada pronto: termina com erro e o motivo.
    expect(finish.body.p_status).toBe("error");
    expect(finish.body.p_answer).toMatch(/perto do teto de US\$ 10,00: 3 partes ficaram de fora/);
  });

  it("parada pela pessoa: não começa etapas e entrega o que já tinha", async () => {
    const t = state(2, { status: "stopping" });
    t.steps[0].status = "done";
    t.steps[0].result = "## Cliente 1\n\nPronto.";
    const { fetchImpl, calls } = taskWorld(t);
    const out = await runSlice(token(), task, taskEnv, { fetch: fetchImpl, llm: stepLlm(), embed: vi.fn() }, host);
    expect(out).toBe("finished");
    expect(rpcs(calls, "ai_task_step_start")).toHaveLength(0);
    const [finish] = rpcs(calls, "ai_task_finish");
    expect(finish.body.p_status).toBe("done");
    expect(finish.body.p_answer).toMatch(/Tarefa parada por você: 1 parte ficou de fora \(Cliente 2\)/);
  });

  it("o token vence antes da fatia acabar: pausa sem gastar", async () => {
    const { fetchImpl, calls } = taskWorld(state(2));
    const soon = Math.floor(Date.now() / 1000) + 120;
    const out = await runSlice(token(soon), task, taskEnv, { fetch: fetchImpl, llm: stepLlm(), embed: vi.fn() }, host);
    expect(out).toBe("paused");
    expect(rpcs(calls, "ai_task_step_start")).toHaveLength(0);
    expect(rpcs(calls, "ai_task_release")[0].body.p_reason).toMatch(/acesso da sua sessão venceu/);
  });

  it("outra fatia está rodando: não faz nada", async () => {
    const { fetchImpl, calls } = taskWorld(null);
    const out = await runSlice(token(), task, taskEnv, { fetch: fetchImpl, llm: stepLlm(), embed: vi.fn() }, host);
    expect(out).toBe("busy");
    expect(calls).toHaveLength(1);
  });

  it("a etapa falhou: volta para a fila com o erro e o gasto", async () => {
    const t = state(1, { closing: null });
    const { fetchImpl, calls } = taskWorld(t);
    const llm: LlmAdapter = async (r) => {
      r.onRound?.({ model: "claude-opus-5-5", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1, tools: [] });
      throw Error("A API da Claude respondeu com erro (529).");
    };
    const next = vi.fn(async () => true);
    const out = await runSlice(token(), task, taskEnv, { fetch: fetchImpl, llm, embed: vi.fn(), next }, host);
    const [save] = rpcs(calls, "ai_task_step_save");
    expect(save.body).toMatchObject({ p_status: "pending", p_error: "A API da Claude respondeu com erro (529)." });
    expect(save.body.p_cost).toBeCloseTo(0.1);
    // Continua na próxima fatia (o banco tira a etapa depois de 3 tentativas).
    expect(out).toBe("next");
  });
});

describe("as ações da tarefa", () => {
  it("confirmar começa a primeira fatia em segundo plano", async () => {
    const { fetchImpl, calls } = taskWorld(null, {
      "rpc/ai_task_confirm": () => ({ id: task, status: "running" }),
    });
    const background: Promise<unknown>[] = [];
    const res = await handleAi({ action: "ai-task-confirm", task }, token(), env, {
      fetch: fetchImpl,
      llm: stepLlm(),
      embed: vi.fn(),
      background: (w) => background.push(w),
    });
    expect(res.status).toBe(200);
    expect(res.body.task).toEqual({ id: task, status: "running" });
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(rpcs(calls, "ai_task_claim")).toHaveLength(1);
  });

  it("sem conta ou sem tarefa: recusa", async () => {
    const { fetchImpl } = world({});
    const deps = { fetch: fetchImpl, llm: stepLlm(), embed: vi.fn() };
    expect((await handleAi({ action: "ai-task-resume", task }, null, env, deps)).status).toBe(401);
    expect((await handleAi({ action: "ai-task-resume", task: "x" }, token(), env, deps)).status).toBe(400);
  });

  it("o erro do banco volta com a mensagem", async () => {
    const { fetchImpl } = world({
      "rpc/ai_task_confirm": () => Response.json({ message: "Esta tarefa já foi decidida." }, { status: 400 }),
    });
    const res = await handleAi({ action: "ai-task-confirm", task }, token(), env, { fetch: fetchImpl, llm: stepLlm(), embed: vi.fn() });
    expect(res).toEqual({ status: 400, body: { error: "Esta tarefa já foi decidida." } });
  });
});

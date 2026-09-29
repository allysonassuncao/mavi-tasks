import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleAi, streamAi, type AiEnv, type AiStreamEvent } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import {
  POWER_TOOLS,
  imageCost,
  imageSizeFor,
  powerInstructions,
  toolsFor,
} from "./_ai-powers";
import { TOOLS } from "./_ai-tools";
import { newMeter } from "./_social-leads";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const me = "00000000-0000-4000-8000-000000000003";
const contract = "00000000-0000-4000-8000-000000000005";
const task = "00000000-0000-4000-8000-000000000006";
const conversation = "00000000-0000-4000-8000-0000000000c1";
const oldImage = `ai-images/${company}/11111111-1111-4111-8111-111111111111.png`;
const token = (sub: string) =>
  `Bearer x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
  bucket: "drive-bucket",
};

type Call = { url: string; method: string; body: any; raw: unknown };
/** Banco, OpenAI e GCS falsos: respostas pelo trecho da URL. */
function world(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const raw = init?.body;
    let body: any = null;
    if (typeof raw === "string")
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    const call = { url, method: init?.method ?? "GET", body, raw };
    calls.push(call);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    if (!key) return new Response("[]", { status: 200 });
    const value = routes[key];
    const data = typeof value === "function" ? (value as (c: Call) => unknown)(call) : value;
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const base = (powers: string[]) => ({
  "memberships?": [
    { user_id: me, name: "Ana Admin", email: "ana@x.com", role: "admin", active: true },
    { user_id: "00000000-0000-4000-8000-000000000009", name: "Bia Lima", email: "", role: "member", active: true },
  ],
  "clients?": [{ id: client, name: "4282" }],
  "contracts?select=id,name,archived,products": [],
  "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
  "rpc/ai_resolve_route": null,
  "rpc/ai_my_powers": powers,
  "rpc/ai_save_turn": conversation,
  "rpc/ai_log_usage": null,
  "rpc/ai_log_tool_calls": null,
});
const answer = (text: string) => ({
  text,
  meter: newMeter("claude-opus-5"),
  rounds: 1,
});

describe("registro de ferramentas", () => {
  it("sem poderes, só as de consulta; cada poder abre as suas", () => {
    expect(toolsFor(new Set()).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const visuals = toolsFor(new Set(["visuals"])).map((t) => t.name);
    expect(visuals).toEqual([
      ...TOOLS.map((t) => t.name),
      "show_chart",
      "show_table",
      "show_kpis",
      "show_timeline",
    ]);
    expect(toolsFor(new Set(["visuals", "images", "actions"]))).toHaveLength(
      TOOLS.length + POWER_TOOLS.length,
    );
    expect(powerInstructions(new Set())).toBe("");
    expect(powerInstructions(new Set(["actions"]))).toContain("Nunca diga que a tarefa foi criada");
  });

  it("o custo da imagem: pelos tokens quando vêm, senão pela tabela", () => {
    expect(imageCost("gpt-image-1", null, { input_tokens: 50, output_tokens: 1056 })).toBeCloseTo(
      (50 * 5 + 1056 * 40) / 1e6,
    );
    expect(imageCost("imagen-4.0-fast-generate-001", null, null)).toBe(0.02);
    expect(imageCost("modelo-novo", null, null)).toBe(0.04);
    expect(imageSizeFor("dall-e-3", "portrait")).toBe("1024x1792");
    expect(imageSizeFor("gpt-image-1", "landscape")).toBe("1536x1024");
  });
});

describe("poderes no módulo MAVI", () => {
  it("visualização e tarefa proposta: mostra, grava e registra as chamadas", async () => {
    const { fetchImpl, calls } = world({
      ...base(["actions", "visuals"]),
      "contracts(id,name,archived,products(name),projects": [
        {
          id: client,
          name: "4282",
          contracts: [
            {
              id: contract,
              name: "Tráfego",
              archived: false,
              products: { name: "Tráfego pago" },
              projects: [],
            },
          ],
        },
      ],
    });
    let request: AgentRequest | undefined;
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      request = r;
      outputs.push(
        await r.execute("show_chart", {
          title: "Leads por semana",
          chart: "line",
          unit: "number",
          categories: ["S1", "S2"],
          series: [{ name: "Leads", values: [10, 14] }],
        }),
      );
      outputs.push(
        await r.execute("propose_task", {
          title: "Revisar criativos",
          client_id: client,
          assignee: "bia",
          due_date: "2000-01-01",
        }),
      );
      return answer("Veja:\n[[V1]]\nPreparei a tarefa:\n[[A1]]");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Como foram os leads?", surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    const names = request!.tools.map((t) => t.name);
    expect(names).toContain("show_chart");
    expect(names).toContain("propose_task");
    expect(names).not.toContain("generate_image");
    expect(request!.maxRounds).toBe(8);
    expect(outputs[0]).toMatch(/^Mostrado para a pessoa como V1/);
    expect(outputs[1]).toMatch(/^Proposta pronta como A1/);
    expect(outputs[1]).toContain("o prazo sugerido já passou");
    const artifacts = events.filter((e) => e.type === "artifact");
    expect(artifacts).toHaveLength(2);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.artifacts.map((a) => a.ref)).toEqual(["V1", "A1"]);
    const action = done.artifacts[1];
    expect(action).toMatchObject({
      type: "action",
      state: "pending",
      action: {
        kind: "create_task",
        contract_id: contract,
        contract_name: "Tráfego pago",
        assignee_name: "Bia Lima",
      },
    });
    expect((action as any).action.due).toBeUndefined();
    const save = calls.find((c) => c.url.includes("ai_save_turn"))!;
    expect(save.body.p_artifacts).toHaveLength(2);
    const log = calls.find((c) => c.url.includes("ai_log_tool_calls"))!;
    expect(log.body.p_conversation).toBe(conversation);
    expect(log.body.p_calls.map((c: any) => [c.tool, c.power, c.ok])).toEqual([
      ["show_chart", "visuals", true],
      ["propose_task", "actions", true],
    ]);
  });

  it("fora do módulo (a bolinha), nenhum poder: nem pergunta ao banco", async () => {
    const { fetchImpl, calls } = world(base(["visuals"]));
    let failed = "";
    const llm: LlmAdapter = async (r) => {
      expect(r.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
      await r.execute("show_chart", {}).catch((e) => (failed = e.message));
      return answer("Ok.");
    };
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Um gráfico?" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(failed).toBe("Ferramenta indisponível: show_chart.");
    expect(calls.some((c) => c.url.includes("ai_my_powers"))).toBe(false);
    const log = calls.find((c) => c.url.includes("ai_log_tool_calls"))!;
    expect(log.body.p_calls[0]).toMatchObject({ tool: "show_chart", ok: false });
  });

  it("gera a imagem, guarda no GCS e cobra; edita a imagem anterior da conversa", async () => {
    const png = Buffer.from("fake-png").toString("base64");
    const { fetchImpl, calls } = world({
      ...base(["images"]),
      "ai_conversations?": [{ owner_id: me }],
      "ai_messages?": [
        {
          role: "assistant",
          content: "Pronto:\n[[I1]]",
          artifacts: [
            {
              id: "old-image-1",
              ref: "I1",
              type: "image",
              path: oldImage,
              prompt: "um cachorro",
              size: "square",
            },
          ],
        },
        { role: "user", content: "Gere um cachorro" },
      ],
      "api.openai.com/v1/images/generations": {
        data: [{ b64_json: png }],
        usage: { input_tokens: 50, output_tokens: 1056 },
      },
      "api.openai.com/v1/images/edits": { data: [{ b64_json: png }] },
      "storage.googleapis.com": (c: Call) =>
        c.method === "GET" ? new Response("old-bytes") : new Response("", { status: 200 }),
    });
    let history: AgentRequest["messages"] = [];
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      history = r.messages;
      outputs.push(await r.execute("generate_image", { prompt: "um gato laranja", size: "portrait" }));
      outputs.push(await r.execute("generate_image", { prompt: "agora de chapéu", edit_ref: "I1" }));
      outputs.push(await r.execute("generate_image", { prompt: "mais escuro", edit_ref: "I9" }));
      return answer("[[I2]]\n[[I3]]");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "E um gato?", conversation, surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    // A resposta antiga chega à MAVI com o que ela mostrou.
    expect(history[1].content).toContain("(Anexos desta resposta: I1 — imagem: um cachorro.)");
    expect(outputs[0]).toMatch(/^Imagem pronta, mostrada para a pessoa como I2/);
    expect(outputs[1]).toMatch(/como I3/);
    expect(outputs[2]).toBe("Não achei a imagem I9 nesta conversa. Gere uma nova com o prompt completo.");
    const gen = calls.find((c) => c.url.includes("images/generations"))!;
    expect(gen.body).toEqual({ model: "gpt-image-1", prompt: "um gato laranja", n: 1, size: "1024x1536" });
    const edit = calls.find((c) => c.url.includes("images/edits"))!;
    expect(edit.raw).toBeInstanceOf(FormData);
    expect((edit.raw as FormData).get("prompt")).toBe("agora de chapéu");
    const puts = calls.filter((c) => c.url.includes("storage.googleapis.com") && c.method === "PUT");
    expect(puts).toHaveLength(2);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    const [first, second] = done.artifacts as any[];
    expect(first.path).toMatch(new RegExp(`^ai-images/${company}/[0-9a-f-]{36}\\.png$`));
    expect(first.url).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    expect(second.edited_from).toBe("I1");
    // O link assinado não é gravado.
    const save = calls.find((c) => c.url.includes("ai_save_turn"))!;
    expect(save.body.p_artifacts.every((a: any) => !("url" in a) || a.url === undefined)).toBe(true);
    const usage = calls.filter((c) => c.url.includes("ai_log_usage") && c.body.p_kind === "image");
    expect(usage).toHaveLength(2);
    expect(usage[0].body.p_cost).toBeCloseTo((50 * 5 + 1056 * 40) / 1e6, 6);
    expect(usage[1].body.p_cost).toBe(0.042);
  });

  it("sem modelo de imagem e sem a chave da OpenAI: explica onde configurar", async () => {
    const { fetchImpl, calls } = world(base(["images"]));
    const llm: LlmAdapter = async (r) => {
      await r.execute("generate_image", { prompt: "um gato" }).catch(() => {});
      return answer("Não deu.");
    };
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Um gato?", surface: "page" },
      token(me),
      { ...env, openaiKey: "" },
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    const log = calls.find((c) => c.url.includes("ai_log_tool_calls"))!;
    expect(log.body.p_calls[0].error).toContain("Quem usa qual modelo");
  });

  it("comentário proposto só numa tarefa que a pessoa abre", async () => {
    const { fetchImpl } = world({
      ...base(["actions"]),
      "tasks?select=id,title": (c: Call) =>
        c.url.includes(task) ? [{ id: task, title: "Relatório de setembro" }] : [],
    });
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      outputs.push(await r.execute("propose_comment", { task_ref: task, text: "Cliente aprovou." }));
      outputs.push(
        await r.execute("propose_comment", {
          task_ref: "00000000-0000-4000-8000-0000000000ff",
          text: "Oi",
        }),
      );
      return answer("[[A1]]");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Comente", surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    expect(outputs[0]).toMatch(/^Proposta pronta como A1/);
    expect(outputs[1]).toBe("A pessoa não abre esta tarefa: não dá para comentar nela.");
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.artifacts[0]).toMatchObject({
      action: { kind: "comment_task", task_title: "Relatório de setembro", text: "Cliente aprovou." },
    });
  });
});

describe("links das imagens", () => {
  it("só para as imagens de respostas que a pessoa vê", async () => {
    const visible = `ai-images/${company}/22222222-2222-4222-8222-222222222222.png`;
    const hidden = `ai-images/${company}/33333333-3333-4333-8333-333333333333.png`;
    const { fetchImpl, calls } = world({
      "ai_messages?select=id": (c: Call) =>
        decodeURIComponent(c.url).includes(visible) ? [{ id: 1 }] : [],
    });
    const res = await handleAi(
      {
        action: "ai-image-urls",
        company,
        paths: [visible, hidden, "ai-images/outra-empresa/x.png", visible],
      },
      token(me),
      env,
      { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn() },
    );
    expect(res.status).toBe(200);
    const urls = (res.body as { urls: Record<string, string> }).urls;
    expect(Object.keys(urls)).toEqual([visible]);
    expect(urls[visible]).toMatch(/^https:\/\/storage\.googleapis\.com\/drive-bucket\//);
    expect(calls.filter((c) => c.url.includes("ai_messages"))).toHaveLength(2);
  });
});

describe("campanhas dia a dia", () => {
  it("com by_day, cada dia de cada campanha e o total do dia", async () => {
    const c1 = "00000000-0000-4000-8000-0000000000a1";
    const c2 = "00000000-0000-4000-8000-0000000000a2";
    const cycle = (spend: number, results: number) => ({
      start: "2026-09-23",
      end: "2026-09-29",
      objective: "lead",
      goal_results: 100,
      budget: 3000,
      spend,
      impressions: 1000,
      clicks: 50,
      results,
    });
    const { fetchImpl, calls } = world({
      ...base(["visuals"]),
      "rpc/ai_campaign_results": [
        { campaign: c1, name: "Lead (Faceforms)", platform: "meta", status: "active", client, cycles: [cycle(300, 15)] },
        { campaign: c2, name: "Mensagem (WhatsApp)", platform: "meta", status: "active", client, cycles: [cycle(200, 10)] },
      ],
      "ad_daily_metrics?": [
        { campaign_id: c1, day: "2026-09-23", spend: 100, impressions: 400, clicks: 20, conversions: 5 },
        { campaign_id: c1, day: "2026-09-24", spend: 200, impressions: 600, clicks: 30, conversions: 10 },
        { campaign_id: c2, day: "2026-09-23", spend: 120, impressions: 500, clicks: 25, conversions: 6 },
        { campaign_id: c2, day: "2026-09-24", spend: 80, impressions: 500, clicks: 25, conversions: 4 },
      ],
    });
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      outputs.push(await r.execute("campaign_results", { from: "2026-09-23", to: "2026-09-29", by_day: true }));
      outputs.push(await r.execute("campaign_results", { from: "2026-09-23", to: "2026-09-29" }));
      return answer("Ok.");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: { client }, question: "Gráfico dia a dia?", surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    const daily = calls.find((c) => c.url.includes("ad_daily_metrics"))!;
    expect(daily.url).toContain(`campaign_id=in.(${c1},${c2})`);
    expect(daily.url).toContain("day=gte.2026-09-23&day=lte.2026-09-29");
    expect(outputs[0]).toContain(
      "  Por dia:\n  - 23/09/2026: gasto R$ 100,00, 5 resultados (custo por resultado R$ 20,00), 400 impressões, 20 cliques",
    );
    expect(outputs[0]).toContain(
      "Total do dia (todas as campanhas acima):\n- 23/09/2026: gasto R$ 220,00, 11 resultados (custo por resultado R$ 20,00), 900 impressões, 45 cliques\n- 24/09/2026: gasto R$ 280,00, 14 resultados (custo por resultado R$ 20,00)",
    );
    // Sem by_day, como antes: só a soma do período, sem consultar os dias.
    expect(outputs[1]).not.toContain("Por dia");
    expect(calls.filter((c) => c.url.includes("ad_daily_metrics"))).toHaveLength(1);
    const step = events.find((e) => e.type === "step" && e.id === "t1") as { label: string };
    expect(step.label).toBe("Conferindo os resultados diários das campanhas (de 23/09/2026 até 29/09/2026)");
  });
});

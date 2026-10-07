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
import { outputText } from "./_ai-llm.js";

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
    // Perguntar antes de seguir vale sempre (bolinha e módulo).
    expect(toolsFor(new Set()).map((t) => t.name)).toEqual([...TOOLS.map((t) => t.name), "ask_user"]);
    const visuals = toolsFor(new Set(["visuals"])).map((t) => t.name);
    expect(visuals).toEqual([
      ...TOOLS.map((t) => t.name),
      "ask_user",
      "show_chart",
      "show_table",
      "show_kpis",
      "show_timeline",
    ]);
    // 4 visualizações, 4 de imagem (gerar e as 3 da arte por código), 2 ações; o canvas tem as suas 4
    // e as identidades visuais, o design livre, a proposta de identidade e salvar no Drive.
    expect(toolsFor(new Set(["visuals", "images", "actions"]))).toHaveLength(TOOLS.length + 11);
    expect(toolsFor(new Set(["visuals", "images", "actions", "canvas"]))).toHaveLength(
      TOOLS.length + POWER_TOOLS.length + 1 + 3 + 4,
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
    // No módulo MAVI, 10 rodadas (o pedido grande vira tarefa longa).
    expect(request!.maxRounds).toBe(10);
    expect(names).toContain("plan_long_task");
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
      // Sem poderes; os avisos de campanhas entram para quem usa Campanhas (sem poder).
      expect(r.tools.map((t) => t.name)).toEqual([
        ...TOOLS.map((t) => t.name),
        "ask_user",
        "campaign_alerts",
        "propose_campaign_alert",
      ]);
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
      outputs.push(outputText(await r.execute("generate_image", { prompt: "um gato laranja", size: "portrait" })));
      outputs.push(outputText(await r.execute("generate_image", { prompt: "agora de chapéu", edit_ref: "I1" })));
      outputs.push(outputText(await r.execute("generate_image", { prompt: "mais escuro", edit_ref: "I9" })));
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
      outputs.push(outputText(await r.execute("propose_comment", { task_ref: task, text: "Cliente aprovou." })));
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
      outputs.push(outputText(await r.execute("campaign_results", { from: "2026-09-23", to: "2026-09-29", by_day: true })));
      outputs.push(outputText(await r.execute("campaign_results", { from: "2026-09-23", to: "2026-09-29" })));
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

import { answerText } from "./_ai-llm";
import { seal } from "./_google";

describe("canvas: documentos, apresentações e planilhas", () => {
  it("cria no canvas, lê o anterior da conversa e registra o ajuste", async () => {
    const { fetchImpl, calls } = world({
      ...base(["canvas"]),
      "ai_conversations?": [{ owner_id: me }],
      "ai_messages?": [
        {
          role: "assistant",
          content: "[[D1]]",
          artifacts: [
            {
              id: "canvas-0001",
              ref: "D1",
              type: "canvas",
              canvas: { kind: "document", title: "Proposta", markdown: "# Proposta\nTexto antigo da proposta." },
            },
          ],
        },
        { role: "user", content: "Faz a proposta" },
      ],
    });
    const outputs: string[] = [];
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      outputs.push(outputText(await r.execute("read_canvas", { ref: "d1" })));
      outputs.push(
        await r.execute("create_document", {
          title: "Proposta v2",
          markdown: "# Proposta\nTexto novo da proposta, com o preço.",
          revises: "D1",
        }),
      );
      outputs.push(
        await r.execute("create_presentation", {
          title: "Pitch",
          slides: [
            { layout: "title", title: "Pitch da Make" },
            { layout: "image", title: "Arte", image: "I4" },
          ],
        }),
      );
      outputs.push(
        await r.execute("create_spreadsheet", {
          title: "Leads",
          sheets: [{ name: "Setembro", columns: [{ label: "Dia" }, { label: "Leads", unit: "number" }], rows: [["01/09", 12]] }],
        }),
      );
      return answer("[[D2]]\n[[D3]]");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Ajusta?", conversation, surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    expect(request!.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["create_document", "create_presentation", "create_spreadsheet", "read_canvas"]),
    );
    expect(outputs[0]).toContain('documento “Proposta” (D1)');
    expect(outputs[0]).toContain("Texto antigo da proposta.");
    expect(outputs[1]).toMatch(/^Pronto no canvas como D2 \(documento “Proposta v2” \(ajuste de D1\)\)/);
    expect(outputs[2]).toBe("As imagens I4 não existem nesta conversa: gere antes com generate_image ou tire dos slides.");
    expect(outputs[3]).toMatch(/^Pronto no canvas como D3 \(planilha \(Setembro\) “Leads”\)/);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.artifacts.map((a) => [a.ref, a.type])).toEqual([
      ["D2", "canvas"],
      ["D3", "canvas"],
    ]);
    expect((done.artifacts[0] as any).revision_of).toBe("D1");
    const save = calls.find((c) => c.url.includes("ai_save_turn"))!;
    expect(save.body.p_artifacts).toHaveLength(2);
  });
});

describe("busca na internet", () => {
  it("cada busca vira um passo e custa; as páginas citadas viram fontes", async () => {
    const { fetchImpl, calls } = world(base(["web"]));
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      r.onEvent?.({ type: "server_tool", name: "web_search", input: { query: "tendências tráfego pago 2026" } });
      r.onEvent?.({ type: "server_tool", name: "web_fetch", input: { url: "https://exemplo.com/artigo" } });
      const s1 = r.onCitation!({ url: "https://exemplo.com/artigo", title: "Artigo" });
      const again = r.onCitation!({ url: "https://exemplo.com/artigo", title: "Artigo" });
      expect(again).toBe(s1);
      return answer(`O CPM caiu [${s1}].`);
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Tendências?", surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    expect(request!.webSearch).toBe(true);
    expect(request!.instructions).toContain("Busca na internet (web_search e web_fetch)");
    expect(events).toContainEqual({ type: "step", id: "w1", label: "Pesquisando na internet “tendências tráfego pago 2026”", state: "done" });
    expect(events).toContainEqual({ type: "step", id: "w2", label: "Lendo https://exemplo.com/artigo", state: "done" });
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.sources).toEqual([
      { ref: "S1", type: "web", id: "https://exemplo.com/artigo", url: "https://exemplo.com/artigo", title: "Artigo", date: null, client_id: null },
    ]);
    const log = calls.find((c) => c.url.includes("ai_log_tool_calls"))!;
    expect(log.body.p_calls.map((c: any) => [c.tool, c.power, c.cost])).toEqual([
      ["web_search", "web", 0.01],
      ["web_fetch", "web", 0],
    ]);
  });

  it("sem o poder, nada de busca; a MAVI sabe o que está desligado", async () => {
    const { fetchImpl } = world(base([]));
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      return answer("Ok.");
    };
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Notícias?", surface: "page" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(request!.webSearch).toBe(false);
    expect(request!.instructions).toContain("Poderes desligados para esta pessoa:");
    expect(request!.instructions).toContain("busca na internet");
  });

  it("o texto final: depois da última busca, com as citações como fontes", () => {
    const cite = (p: { url: string }) => (p.url.includes("a.com") ? "S1" : "S2");
    expect(
      answerText(
        [
          { type: "text", text: "Vou pesquisar." },
          { type: "server_tool_use" },
          { type: "web_search_tool_result" },
          { type: "text", text: "O mercado cresceu", citations: [{ url: "https://a.com/x", title: "A" }, { url: "https://a.com/x", title: "A" }] },
          { type: "text", text: " e segue.", citations: [{ url: "https://b.com", title: "B" }] },
        ],
        cite,
      ),
    ).toBe("O mercado cresceu[S1] e segue.[S2]");
    expect(answerText([{ type: "text", text: " Só texto. " }])).toBe("Só texto.");
  });
});

describe("imagens pelo OpenRouter", () => {
  it("gera pelo chat com modalities e usa o custo que o OpenRouter informa", async () => {
    const key = crypto.randomBytes(32);
    const png = Buffer.from("fake-png").toString("base64");
    const { fetchImpl, calls } = world({
      ...base(["images"]),
      "rpc/ai_resolve_route": (c: Call) =>
        c.body.p_feature === "image_generation"
          ? {
              scope: "feature",
              provider_id: "00000000-0000-4000-8000-0000000000b1",
              provider: "OpenRouter",
              kind: "openrouter",
              base_url: null,
              key_cipher: seal(key, "sk-or"),
              model: "google/gemini-2.5-flash-image",
              price: null,
            }
          : null,
      "openrouter.ai/api/v1/chat/completions": {
        choices: [{ message: { content: "", images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 1290, cost: 0.039 },
      },
      "storage.googleapis.com": new Response("", { status: 200 }),
    });
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      outputs.push(outputText(await r.execute("generate_image", { prompt: "um banner verde", size: "landscape" })));
      return answer("[[I1]]");
    };
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Banner?", surface: "page" },
      token(me),
      { ...env, providerKey: key },
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(outputs[0]).toMatch(/^Imagem pronta, mostrada para a pessoa como I1/);
    const req = calls.find((c) => c.url.includes("openrouter.ai"))!;
    expect(req.body).toMatchObject({
      model: "google/gemini-2.5-flash-image",
      modalities: ["image", "text"],
      image_config: { aspect_ratio: "3:2" },
      messages: [{ role: "user", content: [{ type: "text", text: "um banner verde" }] }],
    });
    const usage = calls.find((c) => c.url.includes("ai_log_usage") && c.body.p_kind === "image")!;
    expect(usage.body.p_cost).toBe(0.039);
    expect(usage.body.p_model).toBe("google/gemini-2.5-flash-image");
  });
});

describe("um modelo para cada parte", () => {
  const key = crypto.randomBytes(32);
  const route = (model: string, kind = "openrouter") => ({
    scope: "feature",
    provider_id: `00000000-0000-4000-8000-${model.length.toString().padStart(12, "0")}`,
    provider: "Provedor",
    kind,
    base_url: null,
    key_cipher: seal(key, "sk-x"),
    model,
    price: null,
  });
  /** Cada modelo escolhido vira um adaptador falso que diz quem é. */
  function models(behavior: Record<string, LlmAdapter>) {
    const used: string[] = [];
    const providerLlm = (c: { model: string }) => {
      used.push(c.model);
      return behavior[c.model] ?? (async () => answer(`feito por ${c.model}`));
    };
    return { used, providerLlm };
  }

  it("a bolinha e o módulo pedem regras diferentes; o módulo sem regra segue a bolinha no banco", async () => {
    const page = world(base([]));
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Oi?", surface: "page" },
      token(me),
      env,
      { fetch: page.fetchImpl, llm: async () => answer("Oi."), embed: vi.fn() },
    );
    const bubble = world(base([]));
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Oi?" },
      token(me),
      env,
      { fetch: bubble.fetchImpl, llm: async () => answer("Oi."), embed: vi.fn() },
    );
    const feature = (calls: Call[]) => calls.find((c) => c.url.includes("ai_resolve_route"))!.body.p_feature;
    expect(feature(page.calls)).toBe("mavi_page");
    expect(feature(bubble.calls)).toBe("assistant");
  });

  it("o escritor do canvas faz o conteúdo a partir do pedido e do material", async () => {
    const { fetchImpl, calls } = world({
      ...base(["canvas"]),
      "rpc/ai_resolve_route": (c: Call) => (c.body.p_feature === "canvas_writer" ? route("writer-model") : null),
    });
    const { used, providerLlm } = models({
      "writer-model": async (r) => {
        expect(r.messages[0].content).toContain("Material:\nLeads 612 [S1]");
        expect(r.instructions).toContain('{"slides": [...]}');
        return answer('```json\n{"slides":[{"layout":"title","title":"Setembro"},{"layout":"stats","title":"Números","stats":[{"value":"612","label":"leads"}]}]}\n```');
      },
    });
    let tools: string[] = [];
    let schema: any;
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      tools = r.tools.map((t) => t.name);
      schema = r.tools.find((t) => t.name === "create_presentation")!.parameters;
      outputs.push(outputText(await r.execute("create_presentation", { title: "Pitch", brief: "6 slides para o cliente", material: "Leads 612 [S1]" })));
      return answer("[[D1]]");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Apresentação?", surface: "page" },
      token(me),
      { ...env, providerKey: key },
      { fetch: fetchImpl, llm, embed: vi.fn(), providerLlm: providerLlm as any },
      (e) => events.push(e),
    );
    expect(tools).toContain("create_presentation");
    expect(schema.required).toEqual(["title", "brief", "material"]);
    expect(used).toContain("writer-model");
    expect(outputs[0]).toMatch(/^Pronto no canvas como D1 \(apresentação de 2 slides “Pitch”\)/);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect((done.artifacts[0] as any).canvas.slides[1].stats[0].value).toBe("612");
    expect(calls.some((c) => c.url.includes("ai_log_usage") && c.body.p_kind === "canvas")).toBe(true);
  });

  it("com um modelo para a busca, ela vira web_research; as páginas viram fontes", async () => {
    const { fetchImpl, calls } = world({
      ...base(["web"]),
      "rpc/ai_resolve_route": (c: Call) => (c.body.p_feature === "web_search" ? route("perplexity/sonar") : null),
    });
    const { providerLlm } = models({
      "perplexity/sonar": async (r) => {
        expect(r.webSearch).toBe(true);
        r.onEvent?.({ type: "server_tool", name: "web_search", input: { query: "cpm meta 2026" } });
        const ref = r.onCitation!({ url: "https://news.com/cpm", title: "CPM sobe" });
        return answer(`O CPM subiu 12% [${ref}].`);
      },
    });
    let request: AgentRequest | undefined;
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      request = r;
      outputs.push(outputText(await r.execute("web_research", { question: "Como está o CPM da Meta em 2026?" })));
      return answer("Subiu [S1].");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "CPM?", surface: "page" },
      token(me),
      { ...env, providerKey: key },
      { fetch: fetchImpl, llm, embed: vi.fn(), providerLlm: providerLlm as any },
      (e) => events.push(e),
    );
    expect(request!.webSearch).toBe(false);
    expect(request!.tools.map((t) => t.name)).toContain("web_research");
    expect(outputs[0]).toContain("feita com perplexity/sonar");
    expect(outputs[0]).toContain("O CPM subiu 12% [S1].");
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.sources[0]).toMatchObject({ type: "web", url: "https://news.com/cpm" });
    expect(calls.some((c) => c.url.includes("ai_log_usage") && c.body.p_kind === "web")).toBe(true);
  });

  it("a skill escolhida com modelo próprio responde a pergunta nele", async () => {
    const skillId = "00000000-0000-4000-8000-0000000000e1";
    const { fetchImpl } = world({
      ...base(["skills"]),
      "rpc/ai_skill_catalog": [],
      "rpc/ai_skill_load": { id: skillId, slug: "relatorio", version: 2, name: "Relatório", description: "x", instructions: "Siga o modelo de relatório mensal.", test: false, files: [] },
      "rpc/ai_skill_route": route("skill-model"),
    });
    const { used, providerLlm } = models({});
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Relatório?", surface: "page", skills: ["relatorio"] },
      token(me),
      { ...env, providerKey: key },
      { fetch: fetchImpl, llm: async () => answer("não devia"), embed: vi.fn(), providerLlm: providerLlm as any },
      (e) => events.push(e),
    );
    expect(used).toEqual(["skill-model"]);
    expect(events).toContainEqual({ type: "step", id: "skill-model-relatorio", label: "A skill “Relatório” responde com skill-model", state: "done" });
    expect((events.at(-1) as any).answer).toBe("feito por skill-model");
  });

  it("a skill com modelo próprio que a MAVI carrega roda nele como ajudante, com as ferramentas da vez", async () => {
    const skillId = "00000000-0000-4000-8000-0000000000e1";
    const { fetchImpl } = world({
      ...base(["skills"]),
      "rpc/ai_skill_catalog": [{ slug: "relatorio", version: 2, name: "Relatório", description: "Relatório mensal do cliente." }],
      "rpc/ai_skill_load": { id: skillId, slug: "relatorio", version: 2, name: "Relatório", description: "x", instructions: "Siga o modelo.", test: false, files: [] },
      "rpc/ai_skill_route": route("skill-model"),
    });
    const { providerLlm } = models({
      "skill-model": async (r) => {
        expect(r.messages.at(-1)!.content).toContain("<skill>\nSiga o modelo.\n</skill>");
        // As da vez (a skill lê os próprios arquivos), menos carregar outra skill.
        const names = r.tools.map((t) => t.name);
        expect(names).toContain("read_skill_file");
        expect(names).toContain("ask_user");
        expect(names).not.toContain("use_skill");
        expect(r.effort).toBe("high");
        await expect(r.execute("show_chart", {})).rejects.toThrow("Ferramenta indisponível: show_chart.");
        return answer("Relatório pronto pelo ajudante.");
      },
    });
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      outputs.push(outputText(await r.execute("use_skill", { skill: "relatorio" })));
      return answer("Aqui está.");
    };
    await handleAi(
      { action: "ai-ask", company, scope: {}, question: "Relatório?", surface: "page" },
      token(me),
      { ...env, providerKey: key },
      { fetch: fetchImpl, llm, embed: vi.fn(), providerLlm: providerLlm as any },
    );
    expect(outputs[0]).toContain("Resultado da skill “Relatório” (feito com skill-model");
    expect(outputs[0]).toContain("Relatório pronto pelo ajudante.");
  });
});

describe("perguntas antes de seguir", () => {
  it("na bolinha também: mostra as perguntas, grava e não deixa mais nada rodar", async () => {
    const { fetchImpl, calls } = world(base([]));
    let request: AgentRequest | undefined;
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      request = r;
      outputs.push(
        await r.execute("ask_user", {
          questions: [
            { question: "Para qual cliente?", options: ["4282", "4283", "4282"] },
            { question: "Quais canais?", options: ["Meta", "Google"], multiple: true },
          ],
        }),
      );
      outputs.push(outputText(await r.execute("list_tasks", {})));
      return answer("Assim que responder, eu monto.\n[[Q1]]");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Monta um relatório" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    expect(request!.instructions).toContain("Perguntar antes de seguir (ask_user)");
    expect(outputs[0]).toMatch(/^As perguntas \(Q1\) estão na tela/);
    expect(outputs[1]).toMatch(/^Você fez perguntas à pessoa: espere as respostas/);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.artifacts[0]).toMatchObject({
      type: "question",
      ref: "Q1",
      questions: [
        { question: "Para qual cliente?", options: ["4282", "4283"] },
        { question: "Quais canais?", options: ["Meta", "Google"], multiple: true },
      ],
    });
    expect(calls.find((c) => c.url.includes("ai_save_turn"))!.body.p_artifacts).toHaveLength(1);
    // A tarefa não foi consultada depois das perguntas.
    expect(calls.some((c) => c.url.includes("tasks?"))).toBe(false);
  });
});

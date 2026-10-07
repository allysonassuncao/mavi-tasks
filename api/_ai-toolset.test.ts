import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { byRelevance, findTools, selectTools, terms } from "./_ai-toolset";
import { anthropicAdapter, type AgentRequest, type LlmAdapter, type ToolSpec } from "./_ai-llm";
import { openAiChatAdapter } from "./_ai-providers";
import { streamAi, type AiEnv, type AiStreamEvent } from "./_ai";
import { seal } from "./_google";
import { newMeter } from "./_social-leads";

const spec = (name: string, description: string): ToolSpec => ({ name, description, parameters: { type: "object", properties: {} } });
const core = [spec("search_knowledge", "Busca na base"), spec("list_tasks", "Lista tarefas")];
const many = Array.from({ length: 30 }, (_, i) => spec(`mcp_crm_tool_${i}`, `[CRM] Ferramenta genérica ${i}`));
const leads = spec("mcp_forms_leads", "[Formulários] Lista os leads recebidos no formulário do site");
const canva = spec("mcp_canva_design", "[Canva] Cria um design");
const deferrable = (n: string) => n.startsWith("mcp_");

describe("ferramentas por intenção", () => {
  it("palavras sem acento, sem as vazias, com o radical das longas", () => {
    expect([...terms("Quais campanhas do Cliente tiveram mais leads?")]).toEqual(
      expect.arrayContaining(["campanhas", "campa", "cliente", "clien", "tiveram", "leads"]),
    );
    expect(terms("me mostre o que é isso").size).toBe(0);
  });

  it("poucas conexões: vão todas", () => {
    const r = selectTools({ tools: [...core, leads, canva], deferrable, text: "oi" });
    expect(r.deferred).toEqual([]);
    expect(r.offered).toHaveLength(4);
  });

  it("muitas: as da MAVI sempre; das conexões, as que combinam, o serviço citado e as usadas há pouco", () => {
    const tools = [...core, ...many, leads, canva];
    const r = selectTools({
      tools,
      deferrable,
      text: "Me traga os leads do formulário de ontem e abra no Canva",
      recent: new Set(["mcp_crm_tool_7"]),
    });
    const names = r.offered.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_knowledge", "list_tasks", "mcp_forms_leads", "mcp_canva_design", "mcp_crm_tool_7"]));
    expect(names).not.toContain("mcp_crm_tool_3");
    expect(r.deferred.length).toBe(tools.length - names.length);
    expect(r.why).toMatch(/^3 de 32 ferramentas/);
  });

  it("find_tools acha entre as que ficaram de fora e entre as skills", () => {
    const out = findTools("quero criar um design", [canva, ...many], [
      { slug: "post-instagram", name: "Post para Instagram", description: "Cria o design de um post" },
    ]);
    expect(out).toContain("mcp_canva_design");
    expect(out).toContain("parâmetros:");
    expect(out).toContain("post-instagram");
    expect(findTools("xyzw", [canva])).toMatch(/^Nada encontrado/);
  });

  it("skills do catálogo: as que combinam primeiro, as outras na ordem", () => {
    const list = [
      { slug: "a", d: "Relatório mensal" },
      { slug: "b", d: "Legenda para Instagram" },
      { slug: "c", d: "Briefing" },
    ];
    expect(byRelevance(list, "faça uma legenda", (x) => x.d).map((x) => x.slug)).toEqual(["b", "a", "c"]);
  });
});

const image = { mediaType: "image/png" as const, data: "aGVsbG8=" };

describe("imagens anexadas direto ao modelo", () => {
  it("Claude: a imagem vai antes do texto na mensagem da pessoa", async () => {
    const requests: any[] = [];
    const client = {
      beta: {
        messages: {
          stream: (params: any) => {
            requests.push(JSON.parse(JSON.stringify(params)));
            return {
              on: () => undefined,
              finalMessage: async () => ({
                model: "claude-opus-5",
                usage: { input_tokens: 10, output_tokens: 5 },
                stop_reason: "end_turn",
                content: [{ type: "text", text: "Um gráfico de vendas." }],
              }),
            };
          },
        },
      },
    };
    await anthropicAdapter({ anthropicKey: "k", model: "claude-opus-5" }, client as any)({
      instructions: "i",
      context: "c",
      messages: [{ role: "user", content: "O que tem na imagem?", images: [image] }],
      tools: [],
      execute: async () => "",
    });
    expect(requests[0].messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      { type: "text", text: "O que tem na imagem?" },
    ]);
  });

  it("compatíveis com OpenAI: image_url com data URL", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    await openAiChatAdapter(
      { kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5", price: null },
      fetchImpl,
    )({
      instructions: "i",
      context: "c",
      messages: [{ role: "user", content: "Descreva", images: [image] }],
      tools: [],
      execute: async () => "",
    });
    expect(bodies[0].messages[1].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      { type: "text", text: "Descreva" },
    ]);
  });
});

// ------------------------------------------------------------ na MAVI
const key = crypto.randomBytes(32);
const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const conversation = "00000000-0000-4000-8000-0000000000c1";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const aiEnv: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: key,
};
const mcpTools = [
  ...Array.from({ length: 28 }, (_, i) => ({ name: `tool_${i}`, description: `Ferramenta genérica ${i}`, read_only: true, enabled: true })),
  { name: "list_leads", description: "Lista os leads recebidos no formulário", read_only: true, enabled: true },
  { name: "invoice", description: "Emite cobrança do contrato", read_only: true, enabled: true },
];
function world(recent: string[] = []) {
  const calls: { url: string; body: any }[] = [];
  const mcpCalls: any[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.startsWith("https://mcp.example.com")) {
      if (body.method === "initialize")
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "s1" },
        });
      if (body.method === "tools/call") mcpCalls.push(body.params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "3 leads" }] } }), {
        status: body.id === undefined ? 202 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    const routes: Record<string, unknown> = {
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "admin", active: true }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_my_powers": ["mcp"],
      "rpc/ai_recent_tools": recent,
      "rpc/ai_mcp_catalog": {
        servers: [
          {
            id: "00000000-0000-4000-8000-0000000000aa",
            slug: "crm",
            name: "CRM",
            url: "https://mcp.example.com/mcp",
            auth: "header",
            header_name: "Authorization",
            header_cipher: seal(key, "Bearer sk-crm"),
            oauth: {},
            token: null,
            tools: mcpTools,
          },
        ],
        missing: [],
      },
      "rpc/ai_save_turn": conversation,
      "ai_conversations?": [{ owner_id: me, summary: null, summary_upto: null }],
      "ai_messages?": [],
    };
    const k = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((x) => url.includes(x));
    return new Response(JSON.stringify(k ? routes[k] : []), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, mcpCalls };
}

describe("ferramentas por intenção na MAVI", () => {
  it("muitas ferramentas da conexão: vão as que combinam; as outras, por find_tools e use_tool", async () => {
    const { fetchImpl, calls, mcpCalls } = world(["mcp:crm/tool_5"]);
    let request: AgentRequest | undefined;
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      request = r;
      outputs.push(String(await r.execute("find_tools", { query: "emitir cobrança" })));
      outputs.push(String(await r.execute("use_tool", { name: "mcp_crm_invoice", input: {} })));
      return { text: "Feito.", meter: newMeter("claude-opus-5"), rounds: 2 };
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Quais leads chegaram pelo formulário?", surface: "page", conversation },
      token,
      aiEnv,
      { fetch: fetchImpl, llm, embed: vi.fn(), lookup: async () => [{ address: "93.184.216.34" }] } as any,
      (e) => events.push(e),
    );
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const names = request!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["mcp_crm_list_leads", "mcp_crm_tool_5", "find_tools", "use_tool", "search_knowledge"]));
    expect(names).not.toContain("mcp_crm_invoice");
    expect(request!.instructions).toContain("Ferramentas sob demanda");
    expect(outputs[0]).toContain("mcp_crm_invoice");
    expect(outputs[1]).toContain("3 leads");
    expect(mcpCalls.at(-1)).toMatchObject({ name: "invoice" });
    const log = calls.find((c) => c.url.includes("ai_log_tool_calls"))!.body.p_calls;
    expect(log.map((c: any) => c.tool)).toEqual(["find_tools", "mcp:crm/invoice"]);
    const route = calls.find((c) => c.url.includes("ai_route_log"))!.body.p_entry;
    expect(route.why.join(" ")).toMatch(/ferramentas de conexões e anúncios pelo pedido/);
  });
});

describe("imagem anexada na MAVI", () => {
  it("o modelo que enxerga recebe a imagem junto da pergunta (e a descrição continua no texto)", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const attachment = "00000000-0000-4000-8000-0000000000f1";
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://storage.googleapis.com")) return new Response(png, { status: 200 });
      const routes: Record<string, unknown> = {
        "memberships?": [{ user_id: me, name: "Ana", email: "", role: "admin", active: true }],
        "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
        "rpc/ai_resolve_route": null,
        "rpc/ai_my_powers": ["attachments"],
        "rpc/ai_attachments_list": [{ id: attachment, name: "print.png", kind: "image", status: "ready", error: null, pages: null, chars: 40, preview: "" }],
        "rpc/ai_attachment_read": { parts: [{ text: "## Descrição\nUm gráfico de vendas." }], more: false },
        "ai_attachments?select=id,path,mime": [{ id: attachment, path: `ai-files/${company}/${me}/print.png`, mime: "image/png" }],
        "rpc/ai_save_turn": conversation,
        "ai_conversations?": [{ owner_id: me, summary: null, summary_upto: null }],
        "ai_messages?": [],
      };
      const k = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((x) => url.includes(x));
      return new Response(JSON.stringify(k ? routes[k] : []), { status: 200 });
    }) as unknown as typeof fetch;
    let request: AgentRequest | undefined;
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "O que mostra este print?", surface: "page", conversation, attachments: [attachment] },
      token,
      { ...aiEnv, credentials: { client_email: "svc@example.iam", private_key: privateKey }, bucket: "drive-bucket" } as AiEnv,
      { fetch: fetchImpl, llm: async (r) => ((request = r), { text: "Vendas.", meter: newMeter("claude-opus-5"), rounds: 1 }), embed: vi.fn() },
      (e) => events.push(e),
    );
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const last = request!.messages.at(-1)!;
    expect(last.images).toEqual([{ mediaType: "image/png", data: png.toString("base64") }]);
    expect(last.content).toContain("Um gráfico de vendas.");
    expect(events).toContainEqual({ type: "step", id: "images", label: "Vendo a imagem anexada", state: "done" });
  });
});

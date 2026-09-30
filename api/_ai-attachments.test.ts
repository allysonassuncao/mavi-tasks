import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { attachmentKind, findAttachment, handleAttachments, type AttachEnv } from "./_ai-attachments";
import { streamAi, type AiEnv, type AiStreamEvent } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import { outputText } from "./_ai-llm.js";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const att = "00000000-0000-4000-8000-0000000000a1";
const conversation = "00000000-0000-4000-8000-0000000000c1";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const env: AttachEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  providerKey: null,
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
  bucket: "drive-bucket",
};
const path = `ai-files/${company}/${att}/Proposta.txt`;

type Call = { url: string; method: string; body: any };
function world(routes: Record<string, (c: Call) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    let body: any = init?.body;
    try {
      body = JSON.parse(String(init?.body));
    } catch {
      /* não é JSON */
    }
    const call = { url, method: init?.method ?? "GET", body };
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
const embed = vi.fn(async (texts: string[]) => ({
  vectors: texts.map(() => Array.from({ length: 1536 }, () => 0.01)),
  tokens: texts.length * 10,
  model: "text-embedding-3-small",
}));

describe("anexos: tipo e envio", () => {
  it("o tipo pelo nome; o que não é aceito fica de fora", () => {
    expect(attachmentKind("Proposta.PDF")).toMatchObject({ kind: "document", text: "pdf" });
    expect(attachmentKind("print.webp")).toMatchObject({ kind: "image" });
    expect(attachmentKind("reuniao.m4a")).toMatchObject({ kind: "audio" });
    expect(attachmentKind("video.mov")).toMatchObject({ kind: "video" });
    expect(attachmentKind("setup.exe")).toBeNull();
    expect(findAttachment([{ id: att, name: "Proposta Comercial.pdf" } as never], "proposta")?.id).toBe(att);
  });

  it("assina o envio direto para o GCS com o tamanho travado; o mesmo arquivo não sobe", async () => {
    const { fetchImpl, calls } = world({
      "rpc/ai_attachment_create": (c) =>
        c.body.p_sha256 === "b".repeat(64)
          ? { id: att, status: "ready", reused: true, path }
          : { id: att, status: "uploading", reused: false, path },
    });
    const r = await handleAttachments(
      { action: "ai-attach-sign", company, name: "Proposta.txt", size: 1200, sha256: "a".repeat(64) },
      token,
      env,
      { fetch: fetchImpl, embed },
    );
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/storage\.googleapis\.com\/drive-bucket\/ai-files\//);
    expect(r.body.headers).toEqual({ "Content-Type": "text/plain" });
    expect((r.body.attachment as any).path).toBeUndefined();
    expect(calls[0].body).toMatchObject({ p_kind: "document", p_mime: "text/plain", p_size: 1200, p_conversation: null });
    const again = await handleAttachments(
      { action: "ai-attach-sign", company, name: "Proposta.txt", size: 1200, sha256: "b".repeat(64) },
      token,
      env,
      { fetch: fetchImpl, embed },
    );
    expect(again.body.url).toBeUndefined();
    expect(again.body.attachment).toMatchObject({ status: "ready", reused: true });
    const bad = await handleAttachments({ action: "ai-attach-sign", company, name: "virus.exe", size: 10 }, token, env, {
      fetch: fetchImpl,
      embed,
    });
    expect(bad.status).toBe(415);
    const big = await handleAttachments({ action: "ai-attach-sign", company, name: "a.mp3", size: 30_000_000 }, token, env, {
      fetch: fetchImpl,
      embed,
    });
    expect(big.status).toBe(413);
  });
});

describe("anexos: leitura", () => {
  it("documento: extrai, guarda os trechos e vetoriza na hora", async () => {
    const { fetchImpl, calls } = world({
      "rpc/ai_attachment_begin": () => ({ id: att, company, name: "Proposta.txt", kind: "document", mime: "text/plain", path, status: "processing" }),
      "storage.googleapis.com": () => new Response("Proposta comercial.\n\nInvestimento de R$ 12.000 por mês."),
      "rpc/ai_attachment_finish": () => [{ id: 1, content: "Anexo “Proposta.txt”\nProposta comercial." }, { id: 2, content: "x" }],
      "rpc/ai_attachment_store_embeddings": () => 2,
      "rpc/ai_attachment_get": () => ({ id: att, status: "ready", pages: 1 }),
      "rpc/ai_log_usage": () => null,
    });
    const background = vi.fn();
    const r = await handleAttachments({ action: "ai-attach-process", id: att }, token, env, { fetch: fetchImpl, embed, background });
    expect(r.body.attachment).toMatchObject({ status: "ready" });
    expect(background).toHaveBeenCalledOnce();
    const finish = calls.find((c) => c.url.includes("ai_attachment_finish"))!.body;
    expect(finish.p_status).toBe("ready");
    expect(finish.p_pages[0].text).toContain("Investimento de R$ 12.000");
    const stored = calls.find((c) => c.url.includes("ai_attachment_store_embeddings"))!.body;
    expect(stored.p_items.map((i: any) => i.id)).toEqual([1, 2]);
    expect(stored.p_items[0].embedding).toMatch(/^\[0\.01/);
    const usage = calls.filter((c) => c.url.includes("ai_log_usage")).map((c) => c.body.p_kind);
    expect(usage).toEqual(["attachment_index"]);
  });

  it("imagem: a descrição e o texto dela pela Claude (com o custo)", async () => {
    const { fetchImpl, calls } = world({
      "rpc/ai_attachment_begin": () => ({ id: att, company, name: "print.png", kind: "image", mime: "image/png", path, status: "processing" }),
      "storage.googleapis.com": () => new Response(new Uint8Array(200)),
      "rpc/ai_resolve_route": () => null,
      "rpc/ai_attachment_finish": () => [],
      "rpc/ai_attachment_get": () => ({ id: att, status: "ready" }),
      "rpc/ai_log_usage": () => null,
    });
    const create = vi.fn(async () => ({
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "## Descrição\nPainel de campanhas.\n## Texto na imagem\nCPL R$ 12,40" }],
      usage: { input_tokens: 1500, output_tokens: 200 },
    }));
    await handleAttachments({ action: "ai-attach-process", id: att }, token, env, {
      fetch: fetchImpl,
      embed,
      anthropic: () => ({ messages: { create } }) as never,
    });
    const req = (create.mock.calls[0] as any)[0];
    expect(req.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    const finish = calls.find((c) => c.url.includes("ai_attachment_finish"))!.body;
    expect(finish.p_pages).toEqual([{ label: "Imagem", text: "## Descrição\nPainel de campanhas.\n## Texto na imagem\nCPL R$ 12,40" }]);
    const usage = calls.find((c) => c.url.includes("ai_log_usage"))!.body;
    expect(usage).toMatchObject({ p_kind: "attachment_image", p_input: 1500, p_output: 200 });
    expect(usage.p_cost).toBeGreaterThan(0);
  });

  it("maior que o declarado: recusado e apagado", async () => {
    const { fetchImpl, calls } = world({
      "rpc/ai_attachment_begin": () => ({ id: att, company, name: "a.txt", kind: "document", mime: "text/plain", path, size: 10, status: "processing" }),
      "storage.googleapis.com": (c) => (c.method === "DELETE" ? new Response(null, { status: 204 }) : new Response("x".repeat(500))),
      "rpc/ai_attachment_finish": () => [],
      "rpc/ai_attachment_get": () => ({ id: att, status: "error" }),
    });
    await handleAttachments({ action: "ai-attach-process", id: att }, token, env, { fetch: fetchImpl, embed });
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("storage.googleapis.com"))).toBe(true);
    expect(calls.find((c) => c.url.includes("ai_attachment_finish"))!.body.p_error).toContain("maior que o declarado");
  });

  it("não leu: fica com o erro para a pessoa ver", async () => {
    const { fetchImpl, calls } = world({
      "rpc/ai_attachment_begin": () => ({ id: att, company, name: "a.pdf", kind: "document", mime: "application/pdf", path, status: "processing" }),
      "storage.googleapis.com": () => new Response("", { status: 404 }),
      "rpc/ai_attachment_finish": () => [],
      "rpc/ai_attachment_get": () => ({ id: att, status: "error" }),
    });
    await handleAttachments({ action: "ai-attach-process", id: att }, token, env, { fetch: fetchImpl, embed });
    const finish = calls.find((c) => c.url.includes("ai_attachment_finish"))!.body;
    expect(finish).toMatchObject({ p_status: "error", p_pages: null });
    expect(finish.p_error).toContain("Envie de novo");
  });
});

describe("anexos na conversa da MAVI", () => {
  it("os desta mensagem vão inteiros na pergunta (com a fonte); os outros por busca", async () => {
    const aiEnv: AiEnv = {
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
    const other = "00000000-0000-4000-8000-0000000000a2";
    const { fetchImpl, calls } = world({
      "memberships?": () => [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "ai_conversations?select=owner_id": () => [{ owner_id: me }],
      "rpc/ai_check_limits": () => ({ blocked: false, message: null, warnings: [] }),
      "rpc/ai_resolve_route": () => null,
      "rpc/ai_my_powers": () => ["attachments"],
      "rpc/ai_attachments_link": () => 1,
      "rpc/ai_attachments_list": () => [
        { id: att, name: "Proposta.pdf", kind: "document", status: "ready", error: null, pages: 2, chars: 120, preview: "" },
        { id: other, name: "Contrato antigo.pdf", kind: "document", status: "ready", error: null, pages: 40, chars: 90000, preview: "" },
      ],
      "rpc/ai_attachment_read": () => ({ name: "Proposta.pdf", parts: [{ ord: 0, label: "Página 1", text: "Página 1: Investimento de R$ 12.000." }], more: false }),
      "rpc/ai_attachment_search": () => [
        { chunk_id: 9, attachment_id: other, name: "Contrato antigo.pdf", content: "Anexo “Contrato antigo.pdf”\nPágina 7: multa de 20%", meta: { label: "Página 7", page: 7 } },
      ],
      "rpc/ai_save_turn": () => conversation,
      "rpc/ai_log_usage": () => null,
      "rpc/ai_log_tool_calls": () => null,
    });
    let request: AgentRequest | undefined;
    let found = "";
    const llm: LlmAdapter = async (r) => {
      request = r;
      found = outputText(await r.execute("search_attachments", { query: "multa rescisão", attachment: "contrato" }));
      return { text: "O investimento é R$ 12.000 [S1] e a multa, 20% [S2].", meter: newMeter("claude-opus-5"), rounds: 2 };
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Compare a proposta com o contrato", conversation, surface: "page", attachments: [att] },
      token,
      aiEnv,
      { fetch: fetchImpl, llm, embed },
      (e) => events.push(e),
    );
    expect(calls.find((c) => c.url.includes("ai_attachments_link"))!.body).toEqual({ p_conversation: conversation, p_ids: [att] });
    const last = request!.messages.at(-1)!.content;
    expect(last).toContain("[Anexos desta mensagem]");
    expect(last).toContain("[S1] Anexo “Proposta.pdf”:\nPágina 1: Investimento de R$ 12.000.");
    expect(request!.context).toContain("“Contrato antigo.pdf” (documento, 40 partes): lido");
    expect(request!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["search_attachments", "read_attachment"]));
    expect(found).toBe("[S2] Anexo “Contrato antigo.pdf” · Página 7\nPágina 7: multa de 20%");
    expect(calls.find((c) => c.url.includes("ai_attachment_search"))!.body).toMatchObject({ p_conversation: conversation, p_ids: [other] });
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.sources.map((s) => [s.ref, s.type, s.title, s.label])).toEqual([
      ["S1", "attachment", "Proposta.pdf", undefined],
      ["S2", "attachment", "Contrato antigo.pdf", "Página 7"],
    ]);
    const log = calls.find((c) => c.url.includes("ai_log_tool_calls"))!.body.p_calls;
    expect(log[0]).toMatchObject({ tool: "search_attachments", power: "attachments", ok: true });
  });
});

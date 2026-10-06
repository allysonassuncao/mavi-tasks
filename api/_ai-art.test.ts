import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runArtTool, resolveClient } from "./_ai-art";
import { anthropicAdapter, outputText, type ToolOutput } from "./_ai-llm";
import { openAiChatAdapter, withRouteEffort, type ProviderConfig } from "./_ai-providers";
import { runPowerTool, type PowerKit } from "./_ai-powers";
import { turnEffort, effortOf } from "./_ai";
import { artDocument, checkRenderInput } from "./_art-render";
import type { AiArtifact, ImageArtifact } from "../src/mavi-artifacts";
import { sanitizeArtifact } from "../src/mavi-artifacts";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000009";
const font = "00000000-0000-4000-8000-0000000000f1";
const logo = "00000000-0000-4000-8000-0000000000f2";
const bg = `ai-images/${company}/22222222-2222-4222-8222-222222222222.png`;

function kitWith(rpc: Record<string, unknown>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const name = Object.keys(rpc).find((k) => url.includes(`/rpc/${k}`));
    return new Response(JSON.stringify(name ? rpc[name] : null), { status: 200 });
  }) as unknown as typeof fetch;
  const artifacts: AiArtifact[] = [];
  const rendered: { html: string; width: number; height: number; tokens: string[] }[] = [];
  const kit: PowerKit = {
    ctx: {
      supabaseUrl: "https://db.example.com",
      supabaseKey: "k",
      fetch: fetchImpl,
      auth: "Bearer x",
      company,
      scope: {},
      members: new Map(),
      clients: new Map([
        [client, "MakeCRM"],
        [other, "Make Vendas"],
      ]),
      today: "2026-09-29",
      usage: { embeddingTokens: 0, embeddingModel: "" },
      sources: [],
      chunks: new Map(),
    } as never,
    env: {
      supabaseUrl: "https://db.example.com",
      supabaseKey: "k",
      providerKey: null,
      openaiKey: "",
      imageModel: "gpt-image-1",
      credentials: { client_email: "svc@example.iam", private_key: privateKey },
      bucket: "drive-bucket",
      renderArt: async (input, put) => {
        rendered.push({ ...input, tokens: input.assets.map((a) => a.token) });
        expect(put).toMatch(/^https:\/\/storage\.googleapis\.com\/drive-bucket\/ai-images\//);
        return { preview: "SlBFRw==", report: input.html.includes("sobreposto") ? ["Textos um sobre o outro: “a” e “b”."] : [] };
      },
    },
    artifacts,
    priorImages: new Map([["I1", bg]]),
    priorArts: new Map(),
    next: { V: 1, I: 2, A: 1, D: 1, Q: 1 },
    priorCanvas: new Map(),
    emit: () => {},
    imageCost: { usd: 0, model: "", provider: null },
  };
  return { kit, calls, rendered };
}
const brand = {
  client,
  client_name: "MakeCRM",
  folder: "x",
  colors: [{ name: "Navy", hex: "#001119" }, { name: "Laranja", hex: "#FF8900" }],
  fonts: [{ file: font, family: "Tomato Grotesk", weight: 700, style: "normal", role: "Títulos" }],
  notes: "Laranja só em destaque.",
  files: [
    { id: font, name: "TomatoGrotesk-Bold.otf", content_type: "font/otf", size: 9000 },
    { id: logo, name: "logo makecrm.svg", content_type: "image/svg+xml", size: 900 },
  ],
};
const targets = [
  { id: font, name: "TomatoGrotesk-Bold.otf", content_type: "font/otf", path: `drive/${company}/${font}`, size: 9000 },
  { id: logo, name: "logo makecrm.svg", content_type: "image/svg+xml", path: `drive/${company}/${logo}`, size: 900 },
];

describe("arte por código", () => {
  it("acha o cliente pelo nome, pelo id ou o da conversa", () => {
    const { kit } = kitWith({});
    expect(resolveClient(kit, "makecrm")).toBe(client);
    expect(resolveClient(kit, client)).toBe(client);
    expect(resolveClient(kit, "Make")).toMatchObject({ error: expect.stringContaining("mais de um") });
    expect(resolveClient(kit, "")).toBeNull();
    kit.ctx.scope.client = other;
    expect(resolveClient(kit, undefined)).toBe(other);
  });

  it("brand_kit: cores, fontes, logos e regras; marca vazia pede para perguntar", async () => {
    const { kit } = kitWith({ ai_brand_kit: brand });
    const out = outputText(await runArtTool(kit, "brand_kit", { client: "MakeCRM" }));
    expect(out).toContain("Navy #001119");
    expect(out).toContain("“Tomato Grotesk” 700 — Títulos");
    expect(out).toContain("marca:logo makecrm.svg");
    expect(out).toContain("Laranja só em destaque.");
    const empty = kitWith({ ai_brand_kit: { ...brand, colors: [], fonts: [], files: [], notes: "" } });
    expect(outputText(await runArtTool(empty.kit, "brand_kit", { client }))).toContain("pergunte à pessoa (ask_user)");
  });

  it("render_art: fontes da marca prontas, arquivos e imagens da conversa trocados; a MAVI vê a prévia", async () => {
    const { kit, rendered } = kitWith({ ai_brand_kit: brand, brand_asset_targets: targets });
    const html = `<div style="font-family:'Tomato Grotesk';background:url('img:I1')"><img src="marca:logo makecrm.svg">50% off</div>`;
    const out = (await runArtTool(kit, "render_art", { html, client: "MakeCRM", name: "Black Friday" })) as Exclude<ToolOutput, string>;
    expect(out.images).toEqual([{ mediaType: "image/jpeg", data: "SlBFRw==" }]);
    expect(out.text).toMatch(/^Arte I2 pronta \(1080×1350\)/);
    expect(out.text).toContain("não achou problema");
    expect(rendered[0]).toMatchObject({ width: 1080, height: 1350 });
    expect(rendered[0].html).toContain('@font-face{font-family:"Tomato Grotesk";src:url("marca:TomatoGrotesk-Bold.otf");font-weight:700');
    expect(rendered[0].tokens).toEqual(["marca:TomatoGrotesk-Bold.otf", "marca:logo makecrm.svg", "img:I1"]);
    const art = kit.artifacts[0] as ImageArtifact;
    expect(art).toMatchObject({ ref: "I2", art: true, width: 1080, height: 1350, client, size: "portrait", prompt: "Black Friday" });
    expect(art.html).toBe(html);
    // A correção herda o cliente e diz de qual arte é ajuste; o relatório volta.
    const fix = (await runArtTool(kit, "render_art", { html: `${html}<p>sobreposto</p>`, revises: "i2", format: "story" })) as Exclude<ToolOutput, string>;
    expect(fix.text).toContain("- Textos um sobre o outro");
    expect(kit.artifacts[1]).toMatchObject({ ref: "I3", edited_from: "I2", client, width: 1080, height: 1920 });
    // O HTML para ajustar depois.
    expect(outputText(await runArtTool(kit, "read_art", { ref: "I3" }))).toContain("<p>sobreposto</p>");
  });

  it("render_art recusa arquivo que a marca não tem e imagem fora da conversa", async () => {
    const { kit, rendered } = kitWith({ ai_brand_kit: brand, brand_asset_targets: targets });
    expect(
      outputText(await runArtTool(kit, "render_art", { html: `<img src="marca:logo-antigo.png"> texto da arte`, client })),
    ).toContain("não tem “logo-antigo.png”");
    expect(outputText(await runArtTool(kit, "render_art", { html: `<div style="background:url('img:I7')">arte</div>`, client }))).toContain(
      "Não achei I7",
    );
    expect(rendered).toHaveLength(0);
  });

  it("o anexo da arte guarda tamanho, HTML e cliente (e sobrevive à conversa salva)", () => {
    const a = sanitizeArtifact({
      id: "abcd1234",
      ref: "I3",
      type: "image",
      path: bg,
      prompt: "Black Friday",
      size: "portrait",
      art: true,
      width: 1080,
      height: 1350,
      html: "<div>50%</div>",
      client,
    });
    expect(a).toMatchObject({ art: true, width: 1080, height: 1350, html: "<div>50%</div>", client });
  });

  it("a página não roda scripts nem abre a internet", () => {
    const doc = artDocument(`<script>alert(1)</script><div>oi</div>`, 1080, 1350);
    expect(doc).not.toContain("<script");
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("width:1080px;height:1350px");
    expect(checkRenderInput({ html: "<div>arte com texto</div>", width: 1080, height: 99999, assets: [] })).toMatch(/altura/);
    expect(
      checkRenderInput({ html: "<div>arte com texto</div>", width: 1080, height: 1080, assets: [{ token: "marca:x", url: "https://evil.com/x" }] }),
    ).toBe("Arquivo inválido.");
  });

  it("generate_image também devolve a imagem para a MAVI ver", async () => {
    const { kit } = kitWith({});
    kit.env.openaiKey = "sk";
    const png = Buffer.from("fake-png-bytes").toString("base64");
    kit.ctx.fetch = vi.fn(async (url: string) =>
      /images\/generations/.test(url)
        ? new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 })
        : new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const out = (await runPowerTool(kit, "generate_image", { prompt: "um fundo de cidade à noite" })) as Exclude<ToolOutput, string>;
    expect(out.images[0]).toEqual({ mediaType: "image/png", data: png });
    expect(out.text).toContain("img:I2");
  });
});

describe("imagens dos resultados das ferramentas", () => {
  it("Claude: a imagem vai no tool_result, junto do texto", async () => {
    const requests: any[] = [];
    let round = 0;
    const client = {
      beta: {
        messages: {
          stream: (params: any) => {
            requests.push(JSON.parse(JSON.stringify(params)));
            const first = round++ === 0;
            return {
              on: () => undefined,
              finalMessage: async () => ({
                model: "claude-opus-5-5",
                stop_reason: first ? "tool_use" : "end_turn",
                content: first
                  ? [{ type: "tool_use", id: "t1", name: "render_art", input: {} }]
                  : [{ type: "text", text: "pronto" }],
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
            };
          },
        },
      },
    };
    let effort = "medium";
    await anthropicAdapter({ anthropicKey: "", model: "claude-opus-5-5" }, client as never)({
      instructions: "i",
      context: "c",
      messages: [{ role: "user", content: "arte" }],
      tools: [{ name: "render_art", description: "d", parameters: { type: "object" } }],
      execute: async () => {
        effort = "xhigh";
        return { text: "Arte I1 pronta", images: [{ mediaType: "image/jpeg", data: "AAA" }] };
      },
      effort: () => effort as never,
    });
    const result = requests[1].messages.at(-1).content[0];
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: [
        { type: "text", text: "Arte I1 pronta" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
      ],
    });
    // O esforço é lido a cada rodada (a skill carregada sobe dali em diante).
    expect(requests[0].output_config).toEqual({ effort: "medium" });
    expect(requests[1].output_config).toEqual({ effort: "xhigh" });
  });

  it("OpenAI e compatíveis: a imagem vai numa mensagem logo depois dos resultados; o esforço vira reasoning_effort", async () => {
    const bodies: any[] = [];
    const sse = (chunks: unknown[]) =>
      new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return bodies.length === 1
        ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "render_art", arguments: "{}" } }] } }] }])
        : sse([{ choices: [{ delta: { content: "ok" } }] }]);
    }) as unknown as typeof fetch;
    await openAiChatAdapter(
      { kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5", price: null } as ProviderConfig,
      fetchImpl,
    )({
      instructions: "i",
      context: "c",
      messages: [{ role: "user", content: "arte" }],
      tools: [{ name: "render_art", description: "d", parameters: { type: "object" } }],
      execute: async () => ({ text: "Arte pronta", images: [{ mediaType: "image/jpeg", data: "AAA" }] }),
      effort: "max",
    });
    expect(bodies[0].reasoning_effort).toBe("high");
    const msgs = bodies[1].messages;
    expect(msgs.at(-2)).toEqual({ role: "tool", tool_call_id: "c1", content: "Arte pronta" });
    expect(msgs.at(-1).content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } });
  });

  it("modelo que não raciocina recusa o esforço: segue sem", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return bodies.length === 1
        ? new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }), { status: 400 })
        : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await openAiChatAdapter(
      { kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4.1", price: null } as ProviderConfig,
      fetchImpl,
    )({ instructions: "i", context: "c", messages: [{ role: "user", content: "oi" }], tools: [], execute: vi.fn(), effort: "low" });
    expect(out.text).toBe("ok");
    expect(bodies[1].reasoning_effort).toBeUndefined();
  });
});

describe("esforço escolhido no painel", () => {
  it("o módulo segue a bolinha; a skill manda (sem escolha, pelo menos high)", () => {
    expect(effortOf({ assistant: "low" }, "mavi_page")).toBe("low");
    expect(effortOf({ assistant: "low", mavi_page: "max" }, "mavi_page")).toBe("max");
    expect(effortOf({ mavi_page: "turbo" }, "mavi_page")).toBeUndefined();
    expect(turnEffort({}, "mavi_page", [])).toBeUndefined();
    expect(turnEffort({}, "mavi_page", [{ id: "s1" }])).toBe("high");
    expect(turnEffort({ mavi_page: "xhigh" }, "mavi_page", [{ id: "s1" }])).toBe("xhigh");
    expect(turnEffort({ mavi_page: "xhigh", "skill:s1": "low" }, "mavi_page", [{ id: "s1" }])).toBe("low");
    expect(turnEffort({ "skill:s1": "low", "skill:s2": "max" }, "mavi_page", [{ id: "s1" }, { id: "s2" }])).toBe("max");
  });
  it("a regra de pessoa/cliente vale no lugar do esforço da funcionalidade", () => {
    const panel = { assistant: "low", "skill:s1": "max" };
    expect(withRouteEffort(panel, null, "mavi_page")).toBe(panel);
    expect(withRouteEffort(panel, { effort: null }, "assistant")).toBe(panel);
    expect(effortOf(withRouteEffort(panel, { effort: "high" }, "assistant"), "assistant")).toBe("high");
    expect(effortOf(withRouteEffort(panel, { effort: "xhigh" }, "mavi_page"), "mavi_page")).toBe("xhigh");
    // Com a skill carregada, continua o esforço dela.
    expect(turnEffort(withRouteEffort(panel, { effort: "low" }, "assistant"), "assistant", [{ id: "s1" }])).toBe("max");
  });
});

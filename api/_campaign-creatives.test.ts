import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { AdsEnv } from "./_ads";
import {
  creativeLine,
  metaSource,
  parseCreatives,
  readCreatives,
  type CreativeAd,
  type CreativesEnv,
} from "./_campaign-creatives";

const company = "00000000-0000-4000-8000-000000000001";
const ads: AdsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  tokenKey: crypto.randomBytes(32),
  redirectUri: "",
  meta: { appId: "app", appSecret: "secret", version: "v23.0" },
  google: { clientId: "", clientSecret: "", developerToken: "", version: "v25" },
};
const env: CreativesEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: crypto.randomBytes(32),
  imageModel: "gpt-image-1",
  ads,
} as AiEnv & { ads: AdsEnv };
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe("os criativos do Meta", () => {
  it("a chave é o vídeo, senão o hash da imagem, senão o criativo; e a melhor imagem", () => {
    expect(metaSource({ id: "c1", video_id: "v9", thumbnail_url: "https://t/9.jpg" })).toEqual({
      key: "v:v9",
      kind: "video",
      image: "https://t/9.jpg",
      video: "v9",
    });
    expect(
      metaSource({ id: "c2", object_story_spec: { link_data: { image_hash: "h1", picture: "https://p/1.jpg" } } }),
    ).toMatchObject({ key: "i:h1", kind: "image", image: "https://p/1.jpg" });
    expect(metaSource({ id: "c3", asset_feed_spec: { images: [{ hash: "h2", url: "https://p/2.jpg" }] } })).toMatchObject({
      key: "i:h2",
      image: "https://p/2.jpg",
    });
    expect(metaSource({ id: "c4", thumbnail_url: "https://t/4.jpg" })).toMatchObject({ key: "c:c4", kind: "image" });
  });

  it("a resposta: só os criativos pedidos, campos curtos; a linha junta o essencial", () => {
    const m = parseCreatives(
      `ok ${JSON.stringify({
        criativos: [
          { key: "i:h1", promessa: "Frete grátis em 24h", gancho: "Caixa chegando", resumo: "Entrega rápida", oferta: "" },
          { key: "outro", promessa: "x" },
        ],
      })}`,
      ["i:h1"],
    );
    expect([...m.keys()]).toEqual(["i:h1"]);
    expect(m.get("i:h1")).toEqual({ promessa: "Frete grátis em 24h", gancho: "Caixa chegando", resumo: "Entrega rápida" });
    expect(creativeLine(m.get("i:h1")!)).toBe("Entrega rápida | promessa: Frete grátis em 24h | gancho: Caixa chegando");
    expect(parseCreatives("sem json", ["i:h1"]).size).toBe(0);
  });
});

function network(opts: { cached?: unknown[]; newMax?: number; videos?: boolean }) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body =
      init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body instanceof FormData ? "form" : null;
    calls.push({ url, body });
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (url.includes("rpc/ai_campaign_creatives_get"))
      return json({ settings: { images: true, videos: opts.videos ?? true, new_max: opts.newMax ?? 6 }, items: opts.cached ?? [] });
    if (url.includes("rpc/ai_campaign_creatives_put")) return json(2);
    if (url.includes("rpc/ai_worker_route")) return json(null);
    if (url.startsWith("https://graph.facebook.com/v23.0/?"))
      return json({
        c1: { id: "c1", image_hash: "h1", image_url: "https://cdn.example/h1.jpg" },
        c2: { id: "c2", video_id: "v9", thumbnail_url: "https://cdn.example/v9.jpg" },
        c3: { id: "c3", object_story_spec: { link_data: { image_hash: "h1", picture: "https://cdn.example/h1b.jpg" } } },
      });
    if (url.startsWith("https://graph.facebook.com/v23.0/v9")) return json({ source: "https://video.example/v9.mp4", length: 30 });
    if (url.startsWith("https://video.example/"))
      return new Response(new Uint8Array([0, 0, 0, 1]), { status: 200, headers: { "content-type": "video/mp4" } });
    if (url.startsWith("https://cdn.example/"))
      return new Response(jpeg(), { status: 200, headers: { "content-type": "image/jpeg" } });
    if (url === "https://api.openai.com/v1/audio/transcriptions") return json({ text: "Frete grátis só hoje" });
    if (url === "https://api.anthropic.com/v1/messages") {
      const keys = (body.messages[0].content as any[])
        .filter((c) => c.type === "text")
        .map((c) => /Criativo (\S+)/.exec(c.text)?.[1]);
      return json({
        model: "claude-opus-5-5",
        content: [
          {
            type: "text",
            text: JSON.stringify({ criativos: keys.map((key) => ({ key, promessa: `promessa de ${key}`, resumo: `resumo ${key}` })) }),
          },
        ],
        usage: { input_tokens: 2000, output_tokens: 300 },
      });
    }
    throw Error(`rota inesperada: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const theAds: CreativeAd[] = [
  { entity: "a:1", spend: 500, title: "Frete grátis", body: "Compre hoje", meta: { creative: "c1", account: "111" } },
  { entity: "a:2", spend: 300, title: "Vídeo", meta: { creative: "c2", account: "111" } },
  // O mesmo hash da imagem do a:1: lido uma vez.
  { entity: "a:3", spend: 100, meta: { creative: "c3", account: "111" } },
];

describe("ler os criativos", () => {
  it("lê os novos uma vez (imagem e vídeo com o áudio), guarda e devolve o resumo de cada anúncio", async () => {
    const { fetchImpl, calls } = network({});
    const r = await readCreatives(env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn() }, {
      company,
      platform: "meta",
      ads: theAds,
      tokens: new Map([["111", "token"]]),
      platformFetch: fetchImpl,
      budget: 0.2,
    });
    expect(r.read).toBe(2);
    expect(r.reused).toBe(0);
    expect(r.byEntity.get("a:1")!.line).toBe("resumo i:h1 | promessa: promessa de i:h1");
    expect(r.byEntity.get("a:3")!.line).toBe(r.byEntity.get("a:1")!.line);
    expect(r.byEntity.get("a:2")!.transcript).toBe("Frete grátis só hoje");
    // Uma chamada ao modelo de visão para os dois criativos, com o texto, a capa e o áudio.
    const vision = calls.filter((c) => c.url === "https://api.anthropic.com/v1/messages");
    expect(vision).toHaveLength(1);
    const content = vision[0].body.messages[0].content as any[];
    expect(content.filter((c) => c.type === "image")).toHaveLength(2);
    expect(content.find((c) => c.type === "text" && c.text.includes("v:v9")).text).toMatch(/Transcrição do áudio: Frete grátis só hoje/);
    expect(content.find((c) => c.type === "text" && c.text.includes("i:h1")).text).toMatch(/Texto do anúncio: Compre hoje/);
    const put = calls.find((c) => c.url.includes("rpc/ai_campaign_creatives_put"))!.body;
    expect(put.p_items.map((x: any) => [x.key, x.kind, x.transcript])).toEqual([
      ["i:h1", "image", ""],
      ["v:v9", "video", "Frete grátis só hoje"],
    ]);
    expect(r.usage.map((u) => u.kind)).toEqual(["campaign_creative_transcribe", "campaign_creative_image"]);
    // 30 s no gpt-4o-mini-transcribe (US$ 0,003/min).
    expect(r.usage[0].cost).toBeCloseTo(0.0015, 6);
  });

  it("o que já foi lido é reaproveitado, sem baixar nem chamar o modelo", async () => {
    const { fetchImpl, calls } = network({
      cached: [
        { key: "i:h1", kind: "image", summary: { resumo: "já lido" }, transcript: "", note: "" },
        { key: "v:v9", kind: "video", summary: { resumo: "vídeo já lido" }, transcript: "fala", note: "" },
      ],
    });
    const r = await readCreatives(env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn() }, {
      company,
      platform: "meta",
      ads: theAds,
      tokens: new Map([["111", "token"]]),
      platformFetch: fetchImpl,
      budget: 0.2,
    });
    expect(r).toMatchObject({ read: 0, reused: 2, usage: [] });
    expect(r.byEntity.get("a:3")!.line).toBe("já lido");
    expect(calls.some((c) => c.url.includes("anthropic") || c.url.includes("cdn.example"))).toBe(false);
  });

  it("limite por análise e teto: o resto fica para a próxima", async () => {
    const one = network({ newMax: 1 });
    const r1 = await readCreatives(env, { fetch: one.fetchImpl, llm: vi.fn(), embed: vi.fn() }, {
      company,
      platform: "meta",
      ads: theAds,
      tokens: new Map([["111", "token"]]),
      platformFetch: one.fetchImpl,
      budget: 0.2,
    });
    // O de maior investimento (a imagem do a:1 e a:3) primeiro.
    expect(r1.read).toBe(1);
    expect(r1.byEntity.has("a:1")).toBe(true);
    expect(r1.byEntity.has("a:2")).toBe(false);
    expect(r1.notes[0]).toMatch(/1 criativos novos ficaram para a próxima/);
    const poor = network({});
    const r2 = await readCreatives(env, { fetch: poor.fetchImpl, llm: vi.fn(), embed: vi.fn() }, {
      company,
      platform: "meta",
      ads: theAds,
      tokens: new Map([["111", "token"]]),
      platformFetch: poor.fetchImpl,
      budget: 0.001,
    });
    expect(r2.read).toBe(0);
    expect(r2.notes.join(" ")).toMatch(/Só 0 de 2 criativos novos couberam/);
    expect(poor.calls.some((c) => c.url.includes("anthropic"))).toBe(false);
  });
});

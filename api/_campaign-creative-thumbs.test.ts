import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import { attachCreatives, citedAds, type ThumbsEnv } from "./_campaign-creative-thumbs";
import type { CreativeRef } from "./_campaign-creatives";

const company = "00000000-0000-4000-8000-000000000001";
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const env: ThumbsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  workerSecret: "s".repeat(40),
  credentials: {
    client_email: "worker@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  },
  publicBucket: "publico",
} as AiEnv & { publicBucket: string };

const entities = new Map(
  [
    { key: "s:1", level: "adset", name: "Público frio" },
    { key: "a:1", level: "ad", name: "Frete grátis", parent: "s:1" },
    { key: "a:2", level: "ad", name: "Depoimento", parent: "s:1" },
    { key: "a:3", level: "ad", name: "Sem imagem", parent: "s:1" },
    { key: "a:4", level: "ad", name: "Mesmo criativo do a:1", parent: "s:1" },
  ].map((e) => [e.key, e]),
);
const ref = (key: string, image: string | null, extra: Partial<CreativeRef> = {}): CreativeRef => ({
  key,
  kind: "image",
  image,
  link: null,
  summary: null,
  transcript: "",
  ...extra,
});
const refs = new Map<string, CreativeRef>([
  ["a:1", ref("i:h1", "https://cdn.example/h1.jpg", { summary: { promessa: "Frete grátis" }, link: "https://www.instagram.com/p/1" })],
  ["a:2", ref("v:v2", "https://cdn.example/v2.jpg", { kind: "video", transcript: "Eu já tinha desistido" })],
  ["a:3", ref("c:c3", null)],
  ["a:4", ref("i:h1", "https://cdn.example/h1.jpg")],
]);
const ev = (entity: string) => ({ entity });

function network(stored: Record<string, string> = {}) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method: init?.method ?? "GET", body });
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (url.includes("rpc/ai_campaign_creative_thumbs_get")) return json(stored);
    if (url.includes("rpc/ai_campaign_creative_thumbs_put")) return json(1);
    if (url.startsWith("https://cdn.example/"))
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), { status: 200, headers: { "content-type": "image/jpeg" } });
    if (url.startsWith("https://storage.googleapis.com/publico/") && init?.method === "PUT") return new Response("", { status: 200 });
    throw Error(`rota inesperada: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const deps = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  llm: vi.fn(),
  embed: vi.fn(),
  toWebp: vi.fn(async () => new Uint8Array([0x52, 0x49, 0x46, 0x46])),
});

describe("os criativos citados nos insights", () => {
  it("só os anúncios: o alvo primeiro, depois os dos números, sem repetir", () => {
    expect(
      citedAds({ target: { key: "a:2", level: "ad" }, evidence: [ev("s:1"), ev("a:1"), ev("a:2"), ev("total")] }, entities),
    ).toEqual(["a:2", "a:1"]);
    expect(citedAds({ target: { key: "s:1", level: "adset" }, evidence: [ev("s:1")] }, entities)).toEqual([]);
  });

  it("gera a miniatura UMA vez por criativo, guarda e põe a lista (com a leitura) em cada insight", async () => {
    const { fetchImpl, calls } = network();
    const a = { target: { key: "a:1", level: "ad" }, evidence: [ev("a:1"), ev("a:3")] };
    const b = { target: null, evidence: [ev("a:2"), ev("a:4")], extra: { negatives: [] } };
    const c = { target: { key: "s:1", level: "adset" }, evidence: [ev("s:1")] };
    const d = deps(fetchImpl);
    const r = await attachCreatives(env, d, { company, platform: "meta", insights: [a, b, c], entities, refs });
    // a:1 e a:4 têm o mesmo criativo: duas miniaturas (h1 e v2), não três.
    expect(r.made).toBe(2);
    expect(d.toWebp).toHaveBeenCalledTimes(2);
    const puts = calls.filter((x) => x.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0].url).toMatch(new RegExp(`^https://storage.googleapis.com/publico/campaign-creatives/${company}/[0-9a-f-]{36}\\.webp\\?`));
    const saved = calls.find((x) => x.url.includes("rpc/ai_campaign_creative_thumbs_put"))!.body;
    expect(Object.keys(saved.p_items).sort()).toEqual(["i:h1", "v:v2"]);
    // O sem imagem (a:3) fica de fora; o nome do conjunto vai junto.
    expect((a as any).extra.creatives).toEqual([
      {
        entity: "a:1",
        name: "Frete grátis",
        parent: "Público frio",
        key: "i:h1",
        kind: "image",
        thumb: saved.p_items["i:h1"],
        link: "https://www.instagram.com/p/1",
        summary: { promessa: "Frete grátis" },
      },
    ]);
    expect((b as any).extra.negatives).toEqual([]);
    expect((b as any).extra.creatives.map((x: any) => [x.entity, x.kind, x.transcript])).toEqual([
      ["a:2", "video", "Eu já tinha desistido"],
      ["a:4", "image", undefined],
    ]);
    expect((c as any).extra).toBeUndefined();
  });

  it("reaproveita a miniatura guardada (sem baixar de novo); sem armazenamento, não gera", async () => {
    const stored = { "i:h1": "https://storage.googleapis.com/publico/campaign-creatives/x/1.webp" };
    const { fetchImpl, calls } = network(stored);
    const a = { target: { key: "a:1", level: "ad" }, evidence: [] };
    const r = await attachCreatives(env, deps(fetchImpl), { company, platform: "meta", insights: [a], entities, refs });
    expect(r.made).toBe(0);
    expect(calls.some((x) => x.url.startsWith("https://cdn.example/"))).toBe(false);
    expect((a as any).extra.creatives[0].thumb).toBe(stored["i:h1"]);

    const { fetchImpl: f2 } = network();
    const b = { target: { key: "a:2", level: "ad" }, evidence: [] };
    const r2 = await attachCreatives({ ...env, publicBucket: undefined }, deps(f2), {
      company,
      platform: "meta",
      insights: [b],
      entities,
      refs,
    });
    expect(r2.notes).toEqual(["Sem acesso ao armazenamento: os criativos ficaram sem miniatura."]);
    expect((b as any).extra).toBeUndefined();
  });

  it("uma imagem que não abre fica sem miniatura e não trava as outras", async () => {
    const { fetchImpl } = network();
    const failing = vi.fn(async (url: string, init?: RequestInit) =>
      url.includes("v2.jpg") ? new Response("", { status: 403 }) : fetchImpl(url, init),
    ) as unknown as typeof fetch;
    const a = { target: null, evidence: [ev("a:1"), ev("a:2")] };
    const r = await attachCreatives(env, deps(failing), { company, platform: "meta", insights: [a], entities, refs });
    expect(r.made).toBe(1);
    expect(r.notes).toEqual(["1 criativo ficou sem miniatura."]);
    expect((a as any).extra.creatives.map((x: any) => x.entity)).toEqual(["a:1"]);
  });
});

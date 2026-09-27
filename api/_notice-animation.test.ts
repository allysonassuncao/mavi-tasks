import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleNoticeAnimate, animationMessage } from "./_notice-animation";
import type { AnimationDeps, AnimationEnv } from "./_notice-animation";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const company = "00000000-0000-4000-8000-000000000001";
const notice = "00000000-0000-4000-8000-000000000002";
const shot = "00000000-0000-4000-8000-000000000003";
const user = "00000000-0000-4000-8000-000000000010";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.y`;
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  anthropicKey: "sk",
  model: "claude-opus-5-5",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  providerKey: null,
  bucket: "drive-bucket",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
} as unknown as AnimationEnv;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

const started = {
  id: "00000000-0000-4000-8000-0000000000aa",
  version: 1,
  company_id: company,
  route: null,
  notice: {
    title: "Mural novo",
    text: "Agora os avisos chegam aqui.",
    level: "important",
  },
  base: null,
  knowledge: true,
  refs: [
    {
      id: shot,
      name: "tela.png",
      content_type: "image/png",
      size_bytes: 3,
      path: "notices/c/n/a",
    },
  ],
};

function setup(
  answer: string,
  opts: { hidden?: string[]; blocked?: boolean } = {},
) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("/memberships"))
      return json([{ hidden_pages: opts.hidden ?? [], active: true }]);
    if (url.endsWith("/ai_check_limits"))
      return json({ blocked: !!opts.blocked, message: "Teto do mês." });
    if (url.endsWith("/start_notice_animation")) return json(started);
    if (url.endsWith("/ai_search"))
      return json([
        {
          title: "Manual do Mural",
          content: "O botão Novo aviso fica no topo.",
        },
      ]);
    if (url.includes("storage.googleapis.com"))
      return new Response(new Uint8Array([1, 2, 3]));
    return json(null);
  });
  const jobs: Promise<unknown>[] = [];
  const complete = vi.fn(async (_env, request, _signal, meter) => {
    meter.cost = 0.03;
    meter.input = 5000;
    meter.output = 3000;
    return answer;
  });
  const deps: AnimationDeps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    embed: vi.fn(async () => ({
      vectors: [[0.1, 0.2]],
      tokens: 12,
      model: "text-embedding-3-small",
    })),
    complete: complete as unknown as AnimationDeps["complete"],
    background: (work) => void jobs.push(work),
  };
  return { deps, calls, complete, jobs };
}

const body = {
  company,
  notice,
  request: "Mostre como criar um aviso",
  refs: [shot],
  knowledge: true,
};

describe("A animação do aviso no servidor", () => {
  it("responde na hora e gera em segundo plano com prints, base e roteiro conferido", async () => {
    const answer = JSON.stringify({
      theme: "light",
      scenes: [
        {
          layout: "title",
          duration: 3,
          heading: "Mural novo",
          text: "",
          bullets: [],
          icon: "megaphone",
          stat: { value: "", label: "" },
          image: "",
          focus: { x: 0, y: 0, w: 0, h: 0 },
          cursor: { show: false, x: 0, y: 0, click: false },
          callout: "",
          ui: [],
          target: -1,
          transition: "zoom",
        },
        {
          layout: "screen",
          duration: 5,
          heading: "Clique em Novo aviso",
          text: "",
          bullets: [],
          icon: "none",
          stat: { value: "", label: "" },
          image: shot,
          focus: { x: 70, y: 5, w: 20, h: 8 },
          cursor: { show: true, x: 80, y: 9, click: true },
          callout: "Novo aviso",
          ui: [],
          target: -1,
          transition: "slide",
        },
      ],
    });
    const { deps, calls, complete, jobs } = setup(answer);
    const res = await handleNoticeAnimate(body, token, env, deps);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: started.id, status: "generating" });
    await Promise.all(jobs);
    const req = complete.mock.calls[0][1];
    expect(req.images).toEqual([{ media_type: "image/png", data: "AQID" }]);
    expect(req.user).toContain(`1. id ${shot} · tela.png`);
    expect(req.user).toContain("Manual do Mural");
    expect(req.user).toContain("Mostre como criar um aviso");
    const finish = calls.find((c) =>
      c.url.endsWith("/finish_notice_animation"),
    )!.body!;
    expect(finish.p_error).toBeNull();
    expect((finish.p_spec as { scenes: unknown[] }).scenes).toHaveLength(2);
    expect(finish.p_cost).toBeGreaterThanOrEqual(0.03);
    const log = calls.find((c) => c.url.endsWith("/ai_log_usage"))!.body!;
    expect(log).toMatchObject({
      p_module: "notices",
      p_kind: "animation",
      p_embedding: 12,
    });
  });

  it("um roteiro inválido termina como falha, com o custo registrado", async () => {
    const { deps, calls, jobs } = setup("não sei fazer isso");
    await handleNoticeAnimate(body, token, env, deps);
    await Promise.all(jobs);
    const finish = calls.find((c) =>
      c.url.endsWith("/finish_notice_animation"),
    )!.body!;
    expect(finish.p_spec).toBeNull();
    expect(String(finish.p_error)).toMatch(/roteiro/);
    expect(calls.some((c) => c.url.endsWith("/ai_log_usage"))).toBe(true);
  });

  it("MAVI desligada, teto de gasto e pedido vazio não começam nada", async () => {
    const off = setup("", { hidden: ["assistant"] });
    expect((await handleNoticeAnimate(body, token, env, off.deps)).status).toBe(
      403,
    );
    const capped = setup("", { blocked: true });
    const r = await handleNoticeAnimate(body, token, env, capped.deps);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("Teto do mês.");
    expect(
      capped.calls.some((c) => c.url.endsWith("/start_notice_animation")),
    ).toBe(false);
    expect(
      (
        await handleNoticeAnimate(
          { ...body, request: "x" },
          token,
          env,
          setup("").deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (await handleNoticeAnimate(body, null, env, setup("").deps)).status,
    ).toBe(401);
  });

  it("num ajuste, manda a versão atual e pede para mudar só o que foi pedido", () => {
    const msg = animationMessage(
      {
        ...started,
        base: { version: 1, theme: "light", scenes: [] },
        refs: [],
      },
      "Mais curta",
      [],
    );
    expect(msg).toContain("Versão atual da animação");
    expect(msg).toContain("Ajuste pedido");
    expect(msg).toContain("Sem prints de referência");
  });
});

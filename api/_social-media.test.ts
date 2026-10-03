import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { seal, unseal } from "./_google";
import {
  PROCESSING_LIMIT_MS,
  handleSocialMedia,
  handleSocialMediaCallback,
  missingConfig,
  publishJob,
  socialMediaEnv,
  type Job,
} from "./_social-media";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = crypto.randomBytes(32);
const env = socialMediaEnv(
  {
    credentials: { client_email: "svc@example.iam", private_key: privateKey },
    bucket: "bucket",
  },
  {
    SOCIAL_MEDIA_META_APP_ID: "app-sm",
    SOCIAL_MEDIA_META_APP_SECRET: "secret-sm",
    SOCIAL_MEDIA_TOKEN_KEY: key.toString("base64"),
    AI_WORKER_SECRET: "w".repeat(40),
    APP_ORIGIN: "https://mavi.test",
    VITE_SUPABASE_URL: "https://db.test",
    VITE_SUPABASE_PUBLISHABLE_KEY: "anon",
  },
);
const contract = "00000000-0000-4000-8000-000000000041";

type Call = { method: string; path: string; params: Record<string, string> };
/** A Graph API de mentira: cada rota responde com a função dada. */
function fakeMeta(
  routes: Record<string, (p: Record<string, string>, n: number) => unknown>,
) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "storage.googleapis.com") {
      calls.push({
        method: init?.method ?? "GET",
        path: `gcs:${u.pathname}`,
        params: {},
      });
      return new Response(init?.method === "PUT" ? "" : "png-bytes", {
        status: 200,
      });
    }
    const method = init?.method ?? "GET";
    const params = Object.fromEntries(
      method === "POST"
        ? new URLSearchParams(String(init?.body))
        : u.searchParams,
    );
    const path = u.pathname.replace(/^\/v[0-9.]+/, "");
    const key = `${method} ${path.replace(/\/[0-9a-z_-]+$/i, (m) => (routes[`${method} ${path}`] ? m : "/:id"))}`;
    const route = routes[`${method} ${path}`] ? `${method} ${path}` : key;
    calls.push({ method, path, params });
    counts[route] = (counts[route] ?? 0) + 1;
    const fn = routes[route];
    if (!fn)
      return new Response(
        JSON.stringify({ error: { message: `sem rota ${route}` } }),
        { status: 400 },
      );
    const body = fn(params, counts[route]);
    return new Response(JSON.stringify(body), {
      status: (body as { error?: unknown })?.error ? 400 : 200,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const job = (over: Partial<Job> = {}): Job => ({
  plan: "00000000-0000-4000-8000-000000000099",
  number: 1,
  company: "00000000-0000-4000-8000-000000000001",
  contract,
  destinations: ["instagram", "facebook"],
  caption: "Legenda do post",
  first_comment: "",
  cover: null,
  state: {},
  started_at: null,
  page_id: "444",
  ig_user_id: "888",
  token_cipher: seal(key, "page-token"),
  arts: [{ id: "a1", name: "arte.png", type: "image/png", path: "c/arte1" }],
  ...over,
});
const toJpeg = async () => Buffer.from("jpeg");

describe("Social Media · configuração", () => {
  it("variáveis próprias, separadas das Campanhas", () => {
    expect(missingConfig(env)).toEqual([]);
    const empty = socialMediaEnv(
      { credentials: null, bucket: "b" },
      {
        META_APP_ID: "app-campanhas",
        META_APP_SECRET: "x",
        GOOGLE_TOKEN_KEY_ADS: key.toString("base64"),
      },
    );
    expect(missingConfig(empty)).toEqual([
      "SOCIAL_MEDIA_META_APP_ID",
      "SOCIAL_MEDIA_META_APP_SECRET",
      "SOCIAL_MEDIA_TOKEN_KEY",
    ]);
    expect(env.redirectUri).toBe("https://mavi.test/api/social-media-callback");
  });

  it("conectar pela agência abre o login do app do Social Media", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify("f".repeat(64)))) as unknown as typeof fetch;
    const r = await handleSocialMedia(
      { action: "connect", contract },
      "Bearer u",
      env,
      {
        fetch: fetchImpl,
      },
    );
    const url = new URL((r.body as { url: string }).url);
    expect(url.searchParams.get("client_id")).toBe("app-sm");
    expect(url.searchParams.get("state")).toBe(
      `a.${contract}.${"f".repeat(64)}`,
    );
    expect(url.searchParams.get("scope")).toContain(
      "instagram_content_publish",
    );
    const withConfig = { ...env, configId: "cfg-1" };
    const r2 = await handleSocialMedia(
      { action: "connect", contract },
      "Bearer u",
      withConfig,
      {
        fetch: fetchImpl,
      },
    );
    const u2 = new URL((r2.body as { url: string }).url);
    expect(u2.searchParams.get("config_id")).toBe("cfg-1");
    expect(u2.searchParams.has("scope")).toBe(false);
  });

  it("o worker só com o segredo", async () => {
    const r = await handleSocialMedia(
      { action: "publish" },
      "Bearer errado",
      env,
      {
        fetch: fetch,
      },
    );
    expect(r.status).toBe(401);
  });
});

describe("Social Media · callback do login", () => {
  it("guarda as Páginas lacradas e manda escolher", async () => {
    let stored: any = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/oauth/access_token"))
        return new Response(
          JSON.stringify({
            access_token: u.searchParams.has("code") ? "short" : "long",
          }),
        );
      if (u.pathname.endsWith("/me"))
        return new Response(JSON.stringify({ name: "Dono" }));
      if (u.pathname.endsWith("/me/accounts"))
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "444",
                name: "Forma",
                access_token: "page-444",
                instagram_business_account: { id: "888", username: "forma" },
              },
              { id: "555", name: "Sem token" },
            ],
          }),
        );
      if (u.pathname.endsWith("/rpc/social_media_store_pending")) {
        stored = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ pending: "p-1", contract, month: 2 }),
        );
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const state = "e".repeat(64);
    const r = await handleSocialMediaCallback(
      new URLSearchParams({ code: "c", state: `a.${contract}.${state}` }),
      env,
      fetchImpl,
    );
    expect(r.location).toBe(
      `https://mavi.test/planejamento/social-media?contrato=${contract}&secao=agendamento&mes=2&sm_pendente=p-1`,
    );
    expect(stored.p_state).toBe(state);
    expect(stored.p_pages).toHaveLength(1);
    expect(unseal(key, stored.p_pages[0].token_cipher)).toBe("page-444");
    expect(stored.p_pages[0].ig_username).toBe("forma");

    const link = "d".repeat(64);
    const c = await handleSocialMediaCallback(
      new URLSearchParams({
        error: "access_denied",
        state: `c.${link}.${state}`,
      }),
      env,
      fetchImpl,
    );
    expect(c.location).toBe(
      `https://mavi.test/conectar/${link}?resultado=cancelado`,
    );
  });
});

describe("Social Media · publicar", () => {
  it("imagem no Instagram (vira JPEG) e na Página, com o primeiro comentário", async () => {
    const meta = fakeMeta({
      "POST /888/media": () => ({ id: "cont-1" }),
      "GET /:id": (p) =>
        p.fields === "status_code,status"
          ? { status_code: "FINISHED" }
          : p.fields === "permalink"
            ? { permalink: "https://www.instagram.com/p/xyz" }
            : { permalink_url: "https://www.facebook.com/444/posts/9" },
      "POST /888/media_publish": () => ({ id: "ig-media-1" }),
      "POST /444/photos": () => ({ id: "photo-1", post_id: "444_9" }),
      "POST /ig-media-1/comments": () => ({ id: "cm1" }),
      "POST /444_9/comments": () => ({ id: "cm2" }),
    });
    const out = await publishJob(job({ first_comment: "#forma" }), env, {
      fetch: meta.fetchImpl,
      toJpeg,
    });
    expect(out).toMatchObject({
      kind: "done",
      ok: true,
      url: "https://www.instagram.com/p/xyz",
      commentError: null,
    });
    const igMedia = meta.calls.find((c) => c.path === "/888/media")!;
    expect(igMedia.params.caption).toBe("Legenda do post");
    // O PNG virou JPEG no bucket antes de ir para o Instagram.
    expect(igMedia.params.image_url).toContain("/social-media/tmp/");
    expect(
      meta.calls.some((c) => c.method === "PUT" && c.path.includes(".jpg")),
    ).toBe(true);
    // A Página recebe o original.
    expect(
      meta.calls.find((c) => c.path === "/444/photos")!.params.url,
    ).toContain("/c/arte1");
    expect(
      meta.calls
        .filter((c) => c.path.endsWith("/comments"))
        .map((c) => c.params.message),
    ).toEqual(["#forma", "#forma"]);
  });

  it("Reels espera o Meta processar e continua na rodada seguinte", async () => {
    let finished = false;
    const meta = fakeMeta({
      "POST /888/media": () => ({ id: "reel-c" }),
      "GET /:id": (p) =>
        p.fields === "status_code,status"
          ? { status_code: finished ? "FINISHED" : "IN_PROGRESS" }
          : { permalink: "https://www.instagram.com/reel/r1" },
      "POST /888/media_publish": () => ({ id: "reel-1" }),
    });
    const base = job({
      destinations: ["instagram"],
      arts: [{ id: "v1", name: "reel.mp4", type: "video/mp4", path: "c/reel" }],
      cover: { seconds: 2.5 },
    });
    let t = 1_000;
    const first = await publishJob(base, env, {
      fetch: meta.fetchImpl,
      now: () => t,
    });
    expect(first.kind).toBe("progress");
    const reel = meta.calls.find((c) => c.path === "/888/media")!.params;
    expect(reel).toMatchObject({
      media_type: "REELS",
      share_to_feed: "true",
      thumb_offset: "2500",
    });
    // Sem criar outro contêiner na volta.
    finished = true;
    t += 60_000;
    const second = await publishJob({ ...base, state: first.state }, env, {
      fetch: meta.fetchImpl,
      now: () => t,
    });
    expect(second).toMatchObject({
      kind: "done",
      ok: true,
      url: "https://www.instagram.com/reel/r1",
    });
    expect(meta.calls.filter((c) => c.path === "/888/media")).toHaveLength(1);
    // Demorou demais: desiste com o motivo.
    finished = false;
    const stuck = await publishJob(
      {
        ...base,
        state: { instagram: { container: "reel-c", waitingSince: 0 } },
      },
      env,
      { fetch: meta.fetchImpl, now: () => PROCESSING_LIMIT_MS + 1 },
    );
    expect(stuck).toMatchObject({ kind: "done", ok: false });
    expect((stuck as { error: string }).error).toMatch(/20 minutos/);
  });

  it("carrossel no Instagram e várias fotos num post da Página; Stories um por arte", async () => {
    let n = 0;
    const meta = fakeMeta({
      "POST /888/media": () => ({ id: `c${++n}` }),
      "GET /:id": (p) =>
        p.fields === "status_code,status" ? { status_code: "FINISHED" } : {},
      "POST /888/media_publish": (p) => ({ id: `pub-${p.creation_id}` }),
      "POST /444/photos": (_p, k) => ({ id: `ph${k}` }),
      "POST /444/feed": () => ({ id: "444_77" }),
    });
    const out = await publishJob(
      job({
        destinations: ["instagram", "story", "facebook"],
        arts: [
          { id: "a1", name: "1.jpg", type: "image/jpeg", path: "c/1" },
          { id: "a2", name: "2.jpg", type: "image/jpeg", path: "c/2" },
        ],
      }),
      env,
      { fetch: meta.fetchImpl, toJpeg },
    );
    expect(out).toMatchObject({ kind: "done", ok: true });
    const media = meta.calls
      .filter((c) => c.path === "/888/media")
      .map((c) => c.params);
    expect(media.filter((p) => p.is_carousel_item === "true")).toHaveLength(2);
    expect(media.find((p) => p.media_type === "CAROUSEL")!.children).toBe(
      "c1,c2",
    );
    expect(media.filter((p) => p.media_type === "STORIES")).toHaveLength(2);
    expect(
      meta.calls
        .filter((c) => c.path === "/444/photos")
        .map((c) => c.params.published),
    ).toEqual(["false", "false"]);
    expect(
      JSON.parse(
        meta.calls.find((c) => c.path === "/444/feed")!.params.attached_media,
      ),
    ).toEqual([{ media_fbid: "ph1" }, { media_fbid: "ph2" }]);
    // JPEG não precisa de conversão.
    expect(meta.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("token que caiu: volta para o lembrete e marca a conexão", async () => {
    const meta = fakeMeta({
      "POST /888/media": () => ({
        error: { message: "Error validating access token", code: 190 },
      }),
    });
    const out = await publishJob(job(), env, { fetch: meta.fetchImpl, toJpeg });
    expect(out).toMatchObject({ kind: "done", ok: false, tokenError: true });
    expect((out as { error: string }).error).toBe(
      "Instagram: a conexão com o Meta caiu (o token não vale mais). Facebook: a conexão com o Meta caiu.",
    );
  });

  it("um destino falha: diz o que já saiu para publicar à mão só o resto", async () => {
    const meta = fakeMeta({
      "POST /888/media": () => ({
        error: {
          message: "x",
          error_user_msg: "A proporção da imagem não é aceita.",
          code: 36003,
        },
      }),
      "POST /444/photos": () => ({ id: "p", post_id: "444_1" }),
      "GET /:id": () => ({
        permalink_url: "https://www.facebook.com/444/posts/1",
      }),
    });
    const out = await publishJob(job(), env, { fetch: meta.fetchImpl, toJpeg });
    expect(out).toMatchObject({
      kind: "done",
      ok: false,
      tokenError: false,
      url: "https://www.facebook.com/444/posts/1",
      error:
        "Instagram: A proporção da imagem não é aceita. Já saiu em Facebook; publique à mão só o que faltou.",
    });
  });

  it("sem permissão de comentar: o post sai e o comentário vira aviso", async () => {
    const meta = fakeMeta({
      "POST /444/photos": () => ({ id: "p", post_id: "444_1" }),
      "GET /:id": () => ({}),
      "POST /444_1/comments": () => ({
        error: {
          message: "(#200) Requires pages_manage_engagement permission",
          code: 200,
        },
      }),
    });
    const out = await publishJob(
      job({ destinations: ["facebook"], first_comment: "#oi" }),
      env,
      { fetch: meta.fetchImpl },
    );
    expect(out).toMatchObject({ kind: "done", ok: true });
    expect((out as { commentError: string }).commentError).toMatch(
      /pages_manage_engagement/,
    );
  });
});

import crypto from "node:crypto";
import { appOrigin } from "./_origin.js";
import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import { seal, unseal } from "./_google.js";
import { postTextPlain } from "../src/social-leads.js";

/**
 * Planejamento › Social Media › Agendamento, fase 2 (migration
 * 20270316090000_social_media_meta): a publicação automática pelo Meta.
 *
 * - Um app do Meta só do Social Media, separado do das Campanhas (que usa
 *   META_APP_ID/META_APP_SECRET e GOOGLE_TOKEN_KEY_ADS): aqui tudo é
 *   SOCIAL_MEDIA_META_* e SOCIAL_MEDIA_TOKEN_KEY, então reconectar ou tirar
 *   uma Página daqui nunca mexe na conexão das Campanhas.
 * - "connect" (administrador ou gestor) e "link-connect" (o cliente, pelo
 *   /conectar/<token>) abrem o login do Facebook; o callback
 *   (/api/social-media-callback) troca o código por um token de longa
 *   duração, lê as Páginas (com o Instagram profissional de cada uma) e
 *   guarda os tokens das Páginas lacrados até alguém escolher a do cliente.
 * - "publish": o worker do pg_cron (mavi_private.social_media_kick, com o
 *   AI_WORKER_SECRET). Publica destino por destino — Instagram (imagem,
 *   carrossel ou Reels), Stories e a Página do Facebook — guardando o
 *   andamento; vídeo que o Meta ainda processa continua na rodada seguinte.
 *   No fim, o primeiro comentário. O Instagram só aceita JPEG: as outras
 *   imagens viram JPEG numa pasta temporária do bucket, apagada no fim.
 */
export type SocialMediaEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  /** 32 bytes (SOCIAL_MEDIA_TOKEN_KEY, base64); null quando falta ou é inválida. */
  tokenKey: Buffer | null;
  appId: string;
  appSecret: string;
  /** Facebook Login for Business: a configuração do app (opcional). */
  configId: string;
  version: string;
  scope: string;
  /** Cadastrado no app: <origem>/api/social-media-callback. */
  redirectUri: string;
  origin: string;
  workerSecret: string;
  credentials: GcsCredentials | null;
  bucket: string;
  budgetMs: number;
};

/** O que o login pede (o app precisa ter essas permissões aprovadas). */
export const SOCIAL_MEDIA_SCOPE = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
].join(",");

export function socialMediaEnv(
  base: { credentials: GcsCredentials | null; bucket: string },
  env: Record<string, string | undefined> = process.env,
): SocialMediaEnv {
  const key = env.SOCIAL_MEDIA_TOKEN_KEY
    ? Buffer.from(env.SOCIAL_MEDIA_TOKEN_KEY, "base64")
    : null;
  const origin = appOrigin(env);
  return {
    supabaseUrl:
      env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co",
    supabaseKey:
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
    tokenKey: key && key.length === 32 ? key : null,
    appId: env.SOCIAL_MEDIA_META_APP_ID?.trim() ?? "",
    appSecret: env.SOCIAL_MEDIA_META_APP_SECRET?.trim() ?? "",
    configId: env.SOCIAL_MEDIA_META_CONFIG_ID?.trim() ?? "",
    version: env.SOCIAL_MEDIA_META_GRAPH_VERSION?.trim() || "v23.0",
    scope: env.SOCIAL_MEDIA_META_SCOPE?.trim() || SOCIAL_MEDIA_SCOPE,
    redirectUri:
      env.SOCIAL_MEDIA_META_REDIRECT_URI?.trim() ||
      `${origin}/api/social-media-callback`,
    origin,
    workerSecret: env.AI_WORKER_SECRET?.trim() ?? "",
    credentials: base.credentials,
    bucket: base.bucket,
    budgetMs: Number(env.SOCIAL_MEDIA_WORKER_BUDGET_MS) || 240_000,
  };
}

/** As variáveis que faltam na Vercel (vazio: pronto). */
export function missingConfig(env: SocialMediaEnv) {
  const missing: string[] = [];
  if (!env.appId) missing.push("SOCIAL_MEDIA_META_APP_ID");
  if (!env.appSecret) missing.push("SOCIAL_MEDIA_META_APP_SECRET");
  if (!env.tokenKey) missing.push("SOCIAL_MEDIA_TOKEN_KEY");
  return missing;
}

type Fetch = typeof fetch;
export type Deps = {
  fetch: Fetch;
  now?: () => number;
  /** PNG/WebP → JPEG (o Instagram só aceita JPEG); sharp na Vercel. */
  toJpeg?: (input: Buffer) => Promise<Buffer>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

async function rpc<T>(
  env: SocialMediaEnv,
  fetchImpl: Fetch,
  authorization: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const r = await callRpc<T>(env, fetchImpl, authorization, name, args);
  if (!r.ok) throw Object.assign(Error(r.error), { status: r.status });
  return r.data;
}

const authorized = (authorization: string | null, secret: string) => {
  const token = Buffer.from(authorization?.replace(/^Bearer\s+/, "") ?? "");
  const expected = Buffer.from(secret);
  return (
    expected.length > 0 &&
    token.length === expected.length &&
    crypto.timingSafeEqual(token, expected)
  );
};

// ------------------------------------------------------------ Graph API
export class MetaError extends Error {
  constructor(
    message: string,
    public code: number | null = null,
    public subcode: number | null = null,
  ) {
    super(message);
  }
  /** O token não vale mais (senha trocada, acesso tirado, app removido). */
  get tokenError() {
    return this.code === 190 || this.code === 102;
  }
}
const proof = (env: SocialMediaEnv, token: string) =>
  crypto.createHmac("sha256", env.appSecret).update(token).digest("hex");

export async function graph<T>(
  env: SocialMediaEnv,
  fetchImpl: Fetch,
  token: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${env.version}${path}`);
  const fields = new URLSearchParams({
    ...params,
    appsecret_proof: proof(env, token),
  });
  if (method === "GET") url.search = fields.toString();
  const res = await fetchImpl(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === "POST"
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    ...(method === "POST" ? { body: fields.toString() } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: {
      message?: string;
      error_user_msg?: string;
      code?: number;
      error_subcode?: number;
    };
  } & T;
  if (!res.ok || body.error)
    throw new MetaError(
      (
        body.error?.error_user_msg ||
        body.error?.message ||
        `HTTP ${res.status}`
      )
        .trim()
        .slice(0, 300),
      body.error?.code ?? null,
      body.error?.error_subcode ?? null,
    );
  return body;
}

// ------------------------------------------------------------ conectar
export type SocialMediaRequest =
  | { action: "status"; company: string }
  | { action: "connect"; contract: string }
  | { action: "link-connect"; token: string }
  | { action: "publish" };

function dialogUrl(env: SocialMediaEnv, state: string) {
  const url = new URL(`https://www.facebook.com/${env.version}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: env.appId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    state,
    ...(env.configId ? { config_id: env.configId } : { scope: env.scope }),
  }).toString();
  return url.toString();
}

export async function handleSocialMedia(
  body: SocialMediaRequest,
  authorization: string | null,
  env: SocialMediaEnv,
  deps: Deps,
): Promise<{ status: number; body: unknown }> {
  try {
    if (body?.action === "publish")
      return await publishWorker(authorization, env, deps);
    const missing = missingConfig(env);
    if (body?.action === "status")
      return { status: 200, body: { configured: !missing.length, missing } };
    if (missing.length)
      return {
        status: 503,
        body: {
          error: `A publicação pelo Meta não está configurada no servidor. Falta na Vercel: ${missing.join(", ")}.`,
        },
      };
    if (body?.action === "connect") {
      if (!authorization)
        return { status: 401, body: { error: "Entre na sua conta." } };
      if (!UUID.test(body.contract ?? ""))
        return { status: 400, body: { error: "Pedido inválido." } };
      const state = await rpc<string>(
        env,
        deps.fetch,
        authorization,
        "social_media_begin_connect",
        { p_contract: body.contract },
      );
      return {
        status: 200,
        body: { url: dialogUrl(env, `a.${body.contract}.${state}`) },
      };
    }
    if (body?.action === "link-connect") {
      if (!HEX64.test(body.token ?? ""))
        return { status: 400, body: { error: "Link inválido." } };
      const state = await rpc<string>(
        env,
        deps.fetch,
        null,
        "social_media_begin_link_connect",
        { p_token: body.token },
      );
      return {
        status: 200,
        body: { url: dialogUrl(env, `c.${body.token}.${state}`) },
      };
    }
    return { status: 400, body: { error: "Ação desconhecida." } };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return {
      status: status && status >= 400 && status < 600 ? status : 500,
      body: { error: (err as Error).message || "Não foi possível agora." },
    };
  }
}

type PageRow = {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id?: string; username?: string };
};

/**
 * O retorno do login (GET /api/social-media-callback?code&state): guarda as
 * Páginas e manda a pessoa escolher a do cliente — na tela do Agendamento
 * (agência) ou na página do link (cliente).
 */
export async function handleSocialMediaCallback(
  query: URLSearchParams,
  env: SocialMediaEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; location: string }> {
  const [via, ref = "", state = ""] = (query.get("state") ?? "").split(".");
  const agency = via === "a" && UUID.test(ref);
  const client = via === "c" && HEX64.test(ref);
  const back = (result: string, extra: Record<string, string> = {}) => ({
    status: 302,
    location: client
      ? `${env.origin}/conectar/${ref}?${new URLSearchParams({ ...extra, ...(result ? { resultado: result } : {}) })}`
      : `${env.origin}/planejamento/social-media?${new URLSearchParams({
          ...(agency ? { contrato: ref } : {}),
          secao: "agendamento",
          ...extra,
          ...(result ? { sm_conexao: result } : {}),
        })}`,
  });
  if ((!agency && !client) || !HEX64.test(state)) return back("erro");
  if (missingConfig(env).length) return back("erro");
  const code = query.get("code");
  if (query.get("error") || !code) return back("cancelado");
  const exchange = async (params: Record<string, string>) => {
    const url = new URL(
      `https://graph.facebook.com/${env.version}/oauth/access_token`,
    );
    url.search = new URLSearchParams({
      client_id: env.appId,
      client_secret: env.appSecret,
      ...params,
    }).toString();
    const res = await fetchImpl(url.toString());
    if (!res.ok) return null;
    return (await res.json()) as { access_token?: string };
  };
  try {
    const short = await exchange({ redirect_uri: env.redirectUri, code });
    if (!short?.access_token) return back("erro");
    // Token de longa duração: os tokens das Páginas tirados dele não expiram.
    const long = await exchange({
      grant_type: "fb_exchange_token",
      fb_exchange_token: short.access_token,
    });
    const token = long?.access_token ?? short.access_token;
    const me = await graph<{ name?: string }>(
      env,
      fetchImpl,
      token,
      "GET",
      "/me",
      {
        fields: "name",
      },
    );
    const pages: PageRow[] = [];
    let after = "";
    for (let i = 0; i < 10; i++) {
      const r = await graph<{
        data?: PageRow[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>(env, fetchImpl, token, "GET", "/me/accounts", {
        fields: "id,name,access_token,instagram_business_account{id,username}",
        limit: "100",
        ...(after ? { after } : {}),
      });
      pages.push(...(r.data ?? []));
      after = r.paging?.next ? (r.paging.cursors?.after ?? "") : "";
      if (!after) break;
    }
    const usable = pages.filter((p) => p.id && p.access_token);
    if (!usable.length) return back("sem-paginas");
    const stored = await rpc<{
      pending: string;
      contract: string;
      month: number | null;
    }>(env, fetchImpl, null, "social_media_store_pending", {
      p_state: state,
      p_fb_user_name: me.name ?? "",
      p_pages: usable.map((p) => ({
        id: p.id,
        name: p.name ?? "",
        ig_id: p.instagram_business_account?.id ?? null,
        ig_username: p.instagram_business_account?.username ?? null,
        token_cipher: seal(env.tokenKey!, p.access_token!),
      })),
    });
    return client
      ? back("", { pendente: stored.pending })
      : back("", {
          ...(stored.month ? { mes: String(stored.month) } : {}),
          sm_pendente: stored.pending,
        });
  } catch {
    return back("erro");
  }
}

// ------------------------------------------------------------ publicar
type Art = { id: string; name: string; type: string; path: string };
export type Job = {
  plan: string;
  number: number;
  company: string;
  contract: string;
  destinations: ("instagram" | "story" | "facebook")[];
  caption: string;
  first_comment: string;
  cover: { art: string } | { seconds: number } | null;
  state: PublishState;
  started_at: string | null;
  page_id: string | null;
  ig_user_id: string | null;
  token_cipher: string | null;
  arts: Art[];
};
type Item = { container?: string; id?: string };
type Step = {
  done?: boolean;
  error?: string;
  /** Mídia publicada (Instagram/Stories) ou post (Facebook). */
  id?: string;
  url?: string;
  /** Instagram: os itens do carrossel e o contêiner principal. */
  items?: Item[];
  container?: string;
  /** Desde quando espera o Meta processar (ms). */
  waitingSince?: number;
};
export type PublishState = {
  instagram?: Step;
  story?: Step;
  facebook?: Step;
  /** As imagens convertidas para JPEG (id da arte → caminho no bucket). */
  jpegs?: Record<string, string>;
  comments?: { done?: boolean; error?: string };
};
export type Outcome =
  | { kind: "progress"; state: PublishState }
  | {
      kind: "done";
      state: PublishState;
      ok: boolean;
      url: string | null;
      error: string | null;
      tokenError: boolean;
      commentError: string | null;
    };

const LABELS = {
  instagram: "Instagram",
  story: "Stories",
  facebook: "Facebook",
} as const;
/** Quanto esperar o Meta processar um vídeo antes de desistir. */
export const PROCESSING_LIMIT_MS = 20 * 60_000;
const CAROUSEL_MAX = 10;

class Waiting extends Error {}

/** Publica o que falta de um post; devolve o andamento ou o fim. */
export async function publishJob(
  job: Job,
  env: SocialMediaEnv,
  deps: Deps,
): Promise<Outcome> {
  const now = deps.now ?? Date.now;
  const state: PublishState = structuredClone(job.state ?? {});
  const fail = (error: string, tokenError = false): Outcome => ({
    kind: "done",
    state,
    ok: false,
    url: null,
    error,
    tokenError,
    commentError: null,
  });
  if (!job.token_cipher || !job.page_id)
    return fail("O cliente não está mais conectado ao Meta.");
  if (!env.tokenKey) return fail("Falta a SOCIAL_MEDIA_TOKEN_KEY no servidor.");
  let token: string;
  try {
    token = unseal(env.tokenKey, job.token_cipher);
  } catch {
    return fail("Não foi possível abrir a conexão do Meta. Reconecte.", true);
  }
  const credentials = env.credentials;
  if (!credentials)
    return fail("Credenciais do Google Cloud Storage não configuradas.");
  const media = job.arts.filter(
    (a) => a.type.startsWith("image/") || a.type.startsWith("video/"),
  );
  if (!media.length)
    return fail("O post não tem imagem nem vídeo para publicar.");
  const caption = postTextPlain(job.caption).slice(0, 2200);
  const api = <T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string>,
  ) => graph<T>(env, deps.fetch, token, method, path, params);
  // Endereços assinados por 2 horas: o Meta baixa daqui.
  const signed = (path: string) =>
    signGcsUrl(credentials, env.bucket, path, "GET", {
      expiresInSeconds: 7200,
    });
  const jpeg = async (art: Art) => {
    if (art.type === "image/jpeg") return signed(art.path);
    state.jpegs ??= {};
    let path = state.jpegs[art.id];
    if (!path) {
      if (!deps.toJpeg)
        throw new MetaError("Não há conversor de imagem no servidor.");
      const res = await deps.fetch(signed(art.path));
      if (!res.ok)
        throw new MetaError(`Não foi possível ler a arte ${art.name}.`);
      const out = await deps.toJpeg(Buffer.from(await res.arrayBuffer()));
      path = `${job.company}/social-media/tmp/${job.plan}-${job.number}-${art.id}.jpg`;
      const put = await deps.fetch(
        signGcsUrl(credentials, env.bucket, path, "PUT", {
          contentType: "image/jpeg",
        }),
        { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: out },
      );
      if (!put.ok)
        throw new MetaError("Não foi possível preparar o JPEG da arte.");
      state.jpegs[art.id] = path;
    }
    return signed(path);
  };
  const isVideo = (a: Art) => a.type.startsWith("video/");
  /** O contêiner terminou? (espera vídeo; erro do Meta vira falha). */
  const ready = async (step: Step, container: string) => {
    const s = await api<{ status_code?: string; status?: string }>(
      "GET",
      `/${container}`,
      {
        fields: "status_code,status",
      },
    );
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED")
      return true;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED")
      throw new MetaError(
        `O Meta recusou a mídia${s.status ? ` (${s.status})` : ""}.`,
      );
    step.waitingSince ??= now();
    if (now() - step.waitingSince > PROCESSING_LIMIT_MS)
      throw new MetaError(
        "O Meta não terminou de processar o vídeo em 20 minutos.",
      );
    return false;
  };
  const igPublish = async (container: string) => {
    const r = await api<{ id: string }>(
      "POST",
      `/${job.ig_user_id}/media_publish`,
      {
        creation_id: container,
      },
    );
    return r.id;
  };

  const steps = {
    async instagram(step: Step) {
      if (!job.ig_user_id)
        throw new MetaError(
          "A Página não tem um Instagram profissional ligado.",
        );
      const list = media.slice(0, CAROUSEL_MAX);
      if (!step.container) {
        if (list.length === 1) {
          const a = list[0];
          const cover = job.cover;
          const coverArt =
            cover && "art" in cover
              ? job.arts.find((x) => x.id === cover.art)
              : undefined;
          const r = await api<{ id: string }>(
            "POST",
            `/${job.ig_user_id}/media`,
            {
              caption,
              ...(isVideo(a)
                ? {
                    media_type: "REELS",
                    video_url: signed(a.path),
                    share_to_feed: "true",
                    ...(coverArt ? { cover_url: await jpeg(coverArt) } : {}),
                    ...(cover && "seconds" in cover
                      ? {
                          thumb_offset: String(
                            Math.round(cover.seconds * 1000),
                          ),
                        }
                      : {}),
                  }
                : { image_url: await jpeg(a) }),
            },
          );
          step.container = r.id;
        } else {
          step.items ??= [];
          for (let i = step.items.length; i < list.length; i++) {
            const a = list[i];
            const r = await api<{ id: string }>(
              "POST",
              `/${job.ig_user_id}/media`,
              {
                is_carousel_item: "true",
                ...(isVideo(a)
                  ? { media_type: "VIDEO", video_url: signed(a.path) }
                  : { image_url: await jpeg(a) }),
              },
            );
            step.items.push({ container: r.id });
          }
          for (const it of step.items)
            if (!(await ready(step, it.container!))) throw new Waiting();
          const r = await api<{ id: string }>(
            "POST",
            `/${job.ig_user_id}/media`,
            {
              media_type: "CAROUSEL",
              children: step.items.map((it) => it.container).join(","),
              caption,
            },
          );
          step.container = r.id;
        }
      }
      if (!(await ready(step, step.container))) throw new Waiting();
      step.id = await igPublish(step.container);
      const m = await api<{ permalink?: string }>("GET", `/${step.id}`, {
        fields: "permalink",
      }).catch(() => ({}) as { permalink?: string });
      step.url = m.permalink;
    },
    async story(step: Step) {
      if (!job.ig_user_id)
        throw new MetaError(
          "A Página não tem um Instagram profissional ligado.",
        );
      step.items ??= [];
      // Um story por arte, na ordem.
      for (let i = 0; i < media.length; i++) {
        const a = media[i];
        const it = (step.items[i] ??= {});
        if (it.id) continue;
        if (!it.container) {
          const r = await api<{ id: string }>(
            "POST",
            `/${job.ig_user_id}/media`,
            {
              media_type: "STORIES",
              ...(isVideo(a)
                ? { video_url: signed(a.path) }
                : { image_url: await jpeg(a) }),
            },
          );
          it.container = r.id;
        }
        if (!(await ready(step, it.container))) throw new Waiting();
        it.id = await igPublish(it.container);
      }
    },
    async facebook(step: Step) {
      const page = job.page_id!;
      const videos = media.filter(isVideo);
      const images = media.filter((a) => !isVideo(a));
      if (videos.length && images.length)
        throw new MetaError(
          "Carrossel com vídeo não sai na Página por aqui: publique à mão.",
        );
      if (videos.length) {
        const r = await api<{ id: string }>("POST", `/${page}/videos`, {
          file_url: signed(videos[0].path),
          description: caption,
        });
        step.id = r.id;
        step.url = `https://www.facebook.com/${page}/videos/${r.id}`;
        return;
      }
      if (images.length === 1) {
        const r = await api<{ id: string; post_id?: string }>(
          "POST",
          `/${page}/photos`,
          {
            url: signed(images[0].path),
            caption,
            published: "true",
          },
        );
        step.id = r.post_id ?? r.id;
      } else {
        step.items ??= [];
        for (let i = step.items.length; i < images.length; i++) {
          const r = await api<{ id: string }>("POST", `/${page}/photos`, {
            url: signed(images[i].path),
            published: "false",
          });
          step.items.push({ id: r.id });
        }
        const r = await api<{ id: string }>("POST", `/${page}/feed`, {
          message: caption,
          attached_media: JSON.stringify(
            step.items.map((it) => ({ media_fbid: it.id })),
          ),
        });
        step.id = r.id;
      }
      const p = await api<{ permalink_url?: string }>("GET", `/${step.id}`, {
        fields: "permalink_url",
      }).catch(() => ({}) as { permalink_url?: string });
      step.url = p.permalink_url;
    },
  };

  let tokenError = false;
  for (const d of (["instagram", "story", "facebook"] as const).filter((x) =>
    job.destinations.includes(x),
  )) {
    const step = (state[d] ??= {});
    if (step.done || step.error) continue;
    if (tokenError) {
      step.error = "a conexão com o Meta caiu";
      continue;
    }
    try {
      await steps[d](step);
      step.done = true;
      delete step.waitingSince;
    } catch (e) {
      if (e instanceof Waiting) return { kind: "progress", state };
      const err =
        e instanceof MetaError ? e : new MetaError((e as Error).message);
      if (err.tokenError) tokenError = true;
      step.error = err.tokenError
        ? "a conexão com o Meta caiu (o token não vale mais)"
        : err.message;
    }
  }

  // O primeiro comentário, uma vez, onde saiu (Instagram e Página).
  let commentError: string | null = null;
  const comment = job.first_comment.trim();
  if (comment && !state.comments?.done && !tokenError) {
    const errors: string[] = [];
    for (const [d, edge] of [
      ["instagram", "comments"],
      ["facebook", "comments"],
    ] as const) {
      const step = state[d];
      if (!step?.done || !step.id) continue;
      try {
        await api("POST", `/${step.id}/${edge}`, { message: comment });
      } catch (e) {
        errors.push(`${LABELS[d]}: ${(e as Error).message}`);
      }
    }
    state.comments = {
      done: true,
      ...(errors.length ? { error: errors.join(" ") } : {}),
    };
    if (errors.length)
      commentError = `O primeiro comentário não saiu. ${errors.join(" ")}`;
  }

  const order = (["instagram", "facebook", "story"] as const).filter((d) =>
    job.destinations.includes(d),
  );
  const failed = order.filter((d) => state[d]?.error);
  const done = order.filter((d) => state[d]?.done);
  const url =
    order.map((d) => state[d]?.url).find((u) => u && /^https:\/\//.test(u)) ??
    null;
  if (!failed.length)
    return {
      kind: "done",
      state,
      ok: true,
      url,
      error: null,
      tokenError: false,
      commentError,
    };
  return {
    kind: "done",
    state,
    ok: false,
    url,
    tokenError,
    commentError: null,
    error: [
      failed
        .map((d) => `${LABELS[d]}: ${state[d]!.error!.replace(/[.!\s]+$/, "")}`)
        .join(". ") + ".",
      done.length
        ? `Já saiu em ${done.map((d) => LABELS[d]).join(" e ")}; publique à mão só o que faltou.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

async function publishWorker(
  authorization: string | null,
  env: SocialMediaEnv,
  deps: Deps,
): Promise<{ status: number; body: unknown }> {
  if (!authorized(authorization, env.workerSecret))
    return { status: 401, body: { error: "Não autorizado." } };
  const now = deps.now ?? Date.now;
  const started = now();
  const call = <T>(name: string, args: Record<string, unknown>) =>
    rpc<T>(env, deps.fetch, null, name, {
      p_secret: env.workerSecret,
      ...args,
    });
  let published = 0,
    waiting = 0,
    failed = 0;
  const seen = new Set<string>();
  while (now() - started < env.budgetMs) {
    const jobs = await call<Job[]>("social_media_claim_publish", {
      p_limit: 5,
    });
    const fresh = jobs.filter((j) => !seen.has(`${j.plan}:${j.number}`));
    if (!fresh.length) break;
    for (const job of fresh) {
      seen.add(`${job.plan}:${job.number}`);
      let out: Outcome;
      try {
        out = await publishJob(job, env, deps);
      } catch (e) {
        out = {
          kind: "done",
          state: job.state ?? {},
          ok: false,
          url: null,
          error: (e as Error).message || "Falha inesperada ao publicar.",
          tokenError: false,
          commentError: null,
        };
      }
      if (out.kind === "progress") {
        waiting++;
        await call("social_media_publish_progress", {
          p_plan: job.plan,
          p_number: job.number,
          p_state: out.state,
        });
        continue;
      }
      out.ok ? published++ : failed++;
      await call("social_media_publish_done", {
        p_plan: job.plan,
        p_number: job.number,
        p_state: out.state,
        p_ok: out.ok,
        p_url: out.url,
        p_error: out.error,
        p_token_error: out.tokenError,
        p_comment_error: out.commentError,
      });
      // Os JPEGs temporários já não servem.
      for (const path of Object.values(out.state.jpegs ?? {}))
        if (env.credentials)
          await deps
            .fetch(signGcsUrl(env.credentials, env.bucket, path, "DELETE"), {
              method: "DELETE",
            })
            .catch(() => null);
    }
  }
  return { status: 200, body: { published, waiting, failed } };
}

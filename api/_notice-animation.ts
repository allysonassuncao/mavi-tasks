import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import {
  embeddingCost,
  vectorLiteral,
  type Embedder,
} from "./_ai-embeddings.js";
import { llmFriendlyError } from "./_ai-llm.js";
import {
  routeConfig,
  type ProviderConfig,
  type ResolvedRoute,
} from "./_ai-providers.js";
import {
  newMeter,
  type Meter,
  type ModelRequest,
  type SocialLeadsEnv,
} from "./_social-leads.js";
import type { AiEnv } from "./_ai.js";
import {
  ANIMATION_MAX_SECONDS,
  ANIMATION_SCHEMA,
  AnimationError,
  sanitizeSpec,
  type AnimationSpec,
} from "../src/notice-animation.js";

/**
 * A animação de um aviso do Mural (ação "notice-animate" de /api/drive,
 * funcionalidade 'notice_animation'). A MAVI devolve um roteiro de cenas em
 * JSON (src/notice-animation.ts); o player do SaaS anima. Nada de código
 * gerado.
 *
 * O banco abre a versão e confere tudo (start_notice_animation: quem pode,
 * qual modelo está liberado, quais prints). A resposta volta na hora e a
 * geração continua em segundo plano (waitUntil na Vercel): os prints do
 * aviso vão como imagens, a base de conhecimento (quando o administrador
 * permite e quem gera liga) entra como trechos buscados antes, e a versão
 * anterior num ajuste. No fim, finish_notice_animation grava o roteiro já
 * conferido (ou o erro) e avisa quem pediu na caixa de entrada.
 */
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type AnimationEnv = AiEnv & {
  credentials?: GcsCredentials | null;
  bucket?: string;
};
export type AnimationDeps = {
  fetch: typeof fetch;
  embed: Embedder;
  /** A resposta em JSON (claudeComplete: Claude ou provedores compatíveis). */
  complete: (
    env: SocialLeadsEnv,
    request: ModelRequest,
    signal: AbortSignal,
    meter: Meter,
  ) => Promise<string>;
  /** Continua o trabalho depois da resposta (waitUntil). */
  background: (work: Promise<unknown>) => void;
};

type Started = {
  id: string;
  version: number;
  company_id: string;
  route: ResolvedRoute | null;
  notice: { title: string; text: string; level: string };
  base: AnimationSpec | null;
  knowledge: boolean;
  refs: {
    id: string;
    name: string;
    content_type: string;
    size_bytes: number;
    path: string | null;
  }[];
};

export const ANIMATION_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing. Aqui você cria a animação curta (estilo motion graphic, até ${ANIMATION_MAX_SECONDS} segundos, só visual, sem áudio) que acompanha um aviso do Mural: por exemplo, o passo a passo de uma funcionalidade nova, um comunicado importante ou um pedido para o time. Seu nome é MAVI, no feminino.

Você não escreve código: responde com o roteiro de cenas em JSON, que o player do sistema anima com a identidade visual da agência.

Tipos de cena (layout):
- "title": abertura; heading curto e forte, text opcional como subtítulo, um icon.
- "text": uma ideia; heading e text.
- "steps": passo a passo; heading e bullets (até 4 passos curtos, na ordem).
- "stat": um número em destaque; stat.value (ex.: "30", "3x", "sexta") e stat.label; heading opcional.
- "screen": um print da tela (uma das imagens de referência, pelo id em image). Use focus para destacar a área onde a ação acontece (x, y, w, h em % da imagem; confira na imagem), cursor para mostrar onde clicar (x, y em % e click true) e callout para a legenda curta ("Clique em Novo aviso").
- "mockup": quando não há print, recrie a interface com componentes do sistema em ui (de cima para baixo): "menu" (items e active: o índice do item ativo), "button" (label; primary true para o botão principal), "card" (label e text), "toggle" (label e on), "input" (label e text como valor), "badge" (label e tone), "list" (label e items). target é o índice do componente que o cursor clica (-1: nenhum); cursor.show true para mostrá-lo.
- "closing": encerramento; heading com a chamada final (onde encontrar, o que fazer agora) e um icon.

Como montar:
- De 3 a 7 cenas; a soma das durações até ${ANIMATION_MAX_SECONDS} s. Cena de texto: 3 a 4 s; tela ou interface com cursor: 4 a 6 s.
- Textos curtos, para ler em poucos segundos: heading até 50 caracteres, text até 140, cada bullet até 60. Português do Brasil, direto e cordial.
- Para mostrar uma funcionalidade, prefira as telas reais (screen) quando houver prints; sem prints, use mockup com os nomes reais dos botões e menus citados.
- Use só o que está no aviso, no pedido, nas imagens e nos trechos da base de conhecimento. Nunca invente datas, números, nomes de botões ou recursos que não apareçam ali.
- theme: "light" por padrão; "dark" só se pedirem.
- transition: "fade" na maioria; "slide" para avançar passos; "zoom" para destacar um número ou a abertura.
- Campos que a cena não usa ficam vazios: "" nos textos, [] nas listas, focus com w 0, cursor com show false, target -1, stat com value "".

Num ajuste, você recebe a versão atual: mude só o que foi pedido e mantenha o resto igual.`;

export function animationMessage(
  ctx: Started,
  request: string,
  knowledge: string[],
) {
  const parts = [
    `Aviso: ${ctx.notice.title}`,
    ctx.notice.text
      ? `Texto do aviso:\n"""\n${ctx.notice.text.slice(0, 6000)}\n"""`
      : "",
    ctx.refs.length
      ? `Imagens de referência (na ordem em que aparecem acima):\n${ctx.refs
          .map((r, i) => `${i + 1}. id ${r.id} · ${r.name}`)
          .join("\n")}`
      : "Sem prints de referência: recrie a interface com mockup quando precisar mostrar telas.",
    knowledge.length
      ? `Trechos da base de conhecimento da agência (use só se ajudarem):\n${knowledge.join("\n\n")}`
      : "",
    ctx.base
      ? `Versão atual da animação:\n${JSON.stringify(ctx.base)}\n\nAjuste pedido:\n"""\n${request}\n"""`
      : `O que a animação deve mostrar:\n"""\n${request}\n"""`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

function userIdFrom(auth: string) {
  try {
    const sub = JSON.parse(
      Buffer.from(
        auth.replace(/^Bearer\s+/, "").split(".")[1],
        "base64url",
      ).toString("utf8"),
    ).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub : "";
  } catch {
    return "";
  }
}

export async function handleNoticeAnimate(
  body: unknown,
  authorization: string | null,
  env: AnimationEnv,
  deps: AnimationDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = typeof req.company === "string" ? req.company : "";
  const notice = typeof req.notice === "string" ? req.notice : "";
  if (!UUID.test(company) || !UUID.test(notice))
    return fail(400, "Aviso inválido.");
  const request =
    typeof req.request === "string" ? req.request.trim().slice(0, 4000) : "";
  if (request.length < 3)
    return fail(400, "Conte para a MAVI o que a animação deve mostrar.");
  const provider =
    typeof req.provider === "string" && UUID.test(req.provider)
      ? req.provider
      : null;
  const model =
    provider && typeof req.model === "string" ? req.model.slice(0, 120) : null;
  const refs = Array.isArray(req.refs)
    ? req.refs
        .filter((x): x is string => typeof x === "string" && UUID.test(x))
        .slice(0, 6)
    : [];
  const base =
    typeof req.base === "string" && UUID.test(req.base) ? req.base : null;

  // A MAVI desligada para a pessoa e os limites de gasto valem aqui também.
  const me = await deps.fetch(
    `${env.supabaseUrl}/rest/v1/memberships?select=hidden_pages,active&company_id=eq.${company}&user_id=eq.${userIdFrom(authorization)}`,
    { headers: { apikey: env.supabaseKey, Authorization: authorization } },
  );
  const member = me.ok
    ? (
        (await me.json()) as {
          hidden_pages: string[] | null;
          active: boolean;
        }[]
      )[0]
    : null;
  if (!member?.active) return fail(403, "Sem acesso a esta empresa.");
  if ((member.hidden_pages ?? []).includes("assistant"))
    return fail(403, "A MAVI está desligada para você nesta empresa.");
  const limits = await callRpc<{ blocked: boolean; message: string | null }>(
    env,
    deps.fetch,
    authorization,
    "ai_check_limits",
    { p_company: company, p_client: null, p_contract: null, p_project: null },
  );
  if (limits.ok && limits.data?.blocked)
    return fail(429, limits.data.message ?? "Limite de uso da MAVI atingido.");

  const started = await callRpc<Started>(
    env,
    deps.fetch,
    authorization,
    "start_notice_animation",
    {
      p_notice: notice,
      p_request: request,
      p_provider: provider,
      p_model: model,
      p_refs: refs,
      p_knowledge: req.knowledge === true,
      p_base: base,
    },
  );
  if (!started.ok) return fail(started.status, started.error);
  const ctx = started.data;
  deps.background(generate(ctx, company, request, authorization, env, deps));
  return {
    status: 202,
    body: { id: ctx.id, version: ctx.version, status: "generating" },
  };
}

async function generate(
  ctx: Started,
  company: string,
  request: string,
  auth: string,
  env: AnimationEnv,
  deps: AnimationDeps,
) {
  let meter: Meter | undefined;
  let embedding = { tokens: 0, model: env.embeddingModel };
  let spec: AnimationSpec | null = null;
  let error: string | null = null;
  let config: ProviderConfig | null = null;
  try {
    if (ctx.company_id !== company)
      throw new AnimationError("Aviso de outra empresa.");
    config = ctx.route?.key_cipher ? routeConfig(env, ctx.route) : null;
    if (!config && !env.anthropicKey)
      throw new AnimationError(
        "A MAVI não está configurada no servidor. Escolha um provedor para as animações do Mural no Painel da MAVI.",
      );
    const images = await loadImages(ctx, env, deps);
    const knowledge = ctx.knowledge
      ? await searchKnowledge(
          company,
          `${ctx.notice.title}\n${request}`,
          auth,
          env,
          deps,
        ).then((r) => {
          embedding = r.embedding;
          return r.snippets;
        })
      : [];
    const model = config?.model ?? env.model;
    meter = newMeter(model);
    const slEnv: SocialLeadsEnv = {
      supabaseUrl: env.supabaseUrl,
      supabaseKey: env.supabaseKey,
      anthropicKey: env.anthropicKey,
      model,
      deadlineMs: 240_000,
      providerKey: env.providerKey,
      provider: config,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    try {
      const text = await deps.complete(
        slEnv,
        {
          system: ANIMATION_INSTRUCTIONS,
          user: animationMessage(ctx, request, knowledge),
          schema: ANIMATION_SCHEMA,
          domains: [],
          images: images.map((i) => ({
            media_type: i.media_type,
            data: i.data,
          })),
          effort: "medium",
          maxTokens: 20000,
        },
        controller.signal,
        meter,
      );
      const start = text.indexOf("{");
      const raw = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
      spec = sanitizeSpec(raw, new Set(ctx.refs.map((r) => r.id)));
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    error =
      err instanceof AnimationError
        ? err.message
        : err instanceof SyntaxError
          ? "A MAVI não conseguiu montar o roteiro. Tente de novo."
          : llmFriendlyError(err);
  }
  const cost =
    (meter?.cost ?? 0) + embeddingCost(embedding.model, embedding.tokens);
  await callRpc(env, deps.fetch, auth, "finish_notice_animation", {
    p_animation: ctx.id,
    p_spec: spec,
    p_error: error,
    p_cost: Math.round(cost * 1e6) / 1e6,
  }).catch(() => {});
  if (meter)
    await callRpc(env, deps.fetch, auth, "ai_log_usage", {
      p_company: company,
      p_module: "notices",
      p_kind: "animation",
      p_client: null,
      p_contract: null,
      p_project: null,
      p_recording: null,
      p_model: meter.model,
      p_input: meter.input,
      p_output: meter.output,
      p_cache_read: meter.cacheRead,
      p_cache_write: meter.cacheWrite,
      p_embedding: embedding.tokens,
      p_cost: Math.round(cost * 1e6) / 1e6,
      ...(ctx.route?.provider_id ? { p_provider: ctx.route.provider_id } : {}),
    }).catch(() => {});
}

/** Os prints do aviso, baixados do bucket (os grandes demais ficam de fora). */
async function loadImages(
  ctx: Started,
  env: AnimationEnv,
  deps: AnimationDeps,
) {
  const out: { id: string; media_type: string; data: string }[] = [];
  if (!ctx.refs.length) return out;
  if (!env.credentials?.client_email || !env.bucket)
    throw new AnimationError(
      "Credenciais do Google Cloud Storage não configuradas.",
    );
  for (const r of ctx.refs) {
    if (!r.path || r.size_bytes > IMAGE_MAX_BYTES) continue;
    const res = await deps.fetch(
      signGcsUrl(env.credentials, env.bucket, r.path, "GET"),
    );
    if (!res.ok) continue;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > IMAGE_MAX_BYTES) continue;
    out.push({
      id: r.id,
      media_type: r.content_type,
      data: bytes.toString("base64"),
    });
  }
  // As imagens que ficaram de fora saem da lista que o modelo recebe.
  ctx.refs = ctx.refs.filter((r) => out.some((i) => i.id === r.id));
  return out;
}

/** Trechos da base de conhecimento (busca híbrida; sem vetor, só por palavra). */
async function searchKnowledge(
  company: string,
  query: string,
  auth: string,
  env: AnimationEnv,
  deps: AnimationDeps,
) {
  let embedding = { tokens: 0, model: env.embeddingModel };
  let vector: number[] | undefined;
  try {
    const e = await deps.embed([query.slice(0, 2000)]);
    vector = e.vectors[0];
    embedding = { tokens: e.tokens, model: e.model };
  } catch {
    // Sem chave de embeddings: a busca por palavra ainda ajuda.
  }
  const r = await callRpc<{ title: string; content: string }[]>(
    env,
    deps.fetch,
    auth,
    "ai_search",
    {
      p_company: company,
      p_embedding: vector ? vectorLiteral(vector) : null,
      p_query: query.slice(0, 400),
      p_filters: {},
      p_limit: 6,
    },
  );
  const snippets = r.ok
    ? r.data.map(
        (row, i) => `[${i + 1}] ${row.title}\n${row.content.slice(0, 900)}`,
      )
    : [];
  return { snippets, embedding };
}

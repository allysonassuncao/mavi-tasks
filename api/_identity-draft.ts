import { callRpc, signGcsUrl } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter, type ToolImage } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import { routedLlm } from "./_ai-router.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import { siteStyle, siteStyleText } from "./_site-style.js";
import {
  BUILTIN_LOOKS,
  GOOGLE_FONTS,
  GUIDE_SECTIONS,
  sanitizeTokens,
  tokensFromBrand,
  type BrandInput,
  type IdentityRow,
  type IdentityTokens,
} from "../src/visual-identity.js";

/**
 * MAVI · "Gerar com a MAVI" (ação ai-identity-draft): o primeiro Guia da
 * marca de um cliente — ou a identidade da empresa, ou um estilo da galeria
 * — a partir da Marca do Drive (cores, fontes, regras e os logos, que a MAVI
 * vê), do site (cores e fontes do CSS, o tom do texto), do guia atual e do
 * que a pessoa pediu. Uma chamada ao modelo, sem ferramentas, que devolve o
 * rascunho; nada é gravado aqui: a tela abre no editor e a pessoa salva.
 * Usa o modelo de "MAVI no módulo" (Quem usa qual modelo) e os limites de gasto.
 */

type Row = Record<string, unknown>;
type Full = IdentityRow & { guide: string };
type BrandKit = BrandInput & { client: string; client_name: string; notes: string; files: { id: string; name: string; content_type: string; size: number }[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fail = (status: number, error: string) => ({ status, body: { error } });

export const DRAFT_INSTRUCTIONS = `Você é a MAVI, a inteligência de uma agência de marketing, montando a identidade visual de uma marca para os documentos e apresentações que a agência gera (PDF, PowerPoint, Word, páginas).

Use só o material recebido (a Marca do Drive, os logos que você vê, o site, o guia atual e o pedido da pessoa). Não invente fatos sobre a marca: onde faltar, deixe a seção curta e diga o que confirmar.

Devolva só um JSON:
{
  "name": "nome curto da identidade",
  "description": "quando usar, em uma frase",
  "style": {
    "mode": "light" | "dark",
    "colors": { "bg", "surface", "ink", "muted", "primary", "on_primary", "accent" } (todas #RRGGBB),
    "heading": { "family", "weight" },
    "body": { "family", "weight" },
    "cover": "solid" | "primary" | "gradient" | "split",
    "decor": "none" | "bar" | "corner" | "band",
    "radius": 0 a 40
  },
  "guide": "o Guia da marca em Markdown",
  "notes": ["o que a pessoa deve conferir"]
}

Cores: a principal é a cor de marca (da Marca do Drive primeiro; senão a do site: theme-color e as variáveis de tema pesam mais que as mais repetidas, e branco, preto e cinzas de borda não são cor de marca). Texto sobre o fundo com contraste de pelo menos 4,5:1; on_primary legível sobre a principal; surface uma variação suave do fundo.
Fontes: as da Marca pelo nome exato da família; senão as do site, se forem do Google Fonts; senão uma do Google Fonts que combine (ex.: {fonts}).
Guia: as seções ${GUIDE_SECTIONS.map((s) => `"## ${s}"`).join(", ")}. Essência e Tom de voz a partir do texto do site e das regras da Marca; Visual com como usar as cores, fundo claro ou escuro, fotos; Faça e Evite com regras objetivas (uma por item); mantenha o que já está no guia atual (corrija só o que o material contradiz) e os Exemplos aprovados e Aprendizados que já existirem.
Português do Brasil.`;

function jsonFrom(text: string): Row | null {
  const t = text.replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (/```/.test(m) ? "" : m)).replace(/```[\s\S]*$/, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1)) as Row;
  } catch {
    return null;
  }
}

function userIdFrom(auth: string) {
  try {
    const sub = JSON.parse(Buffer.from(auth.replace(/^Bearer\s+/, "").split(".")[1], "base64url").toString("utf8")).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub : "";
  } catch {
    return "";
  }
}

/** Os logos da Marca que o modelo pode ver (PNG, JPG ou WebP, até 2 MB; 2 no máximo). */
async function logoImages(env: AiEnv, deps: AiDeps, auth: string, company: string, client: string): Promise<ToolImage[]> {
  if (!env.credentials || !env.bucket) return [];
  const r = await callRpc<{ id: string; name: string; content_type: string; path: string; size: number }[]>(
    env,
    deps.fetch,
    auth,
    "brand_asset_targets",
    { p_company: company, p_client: client },
  );
  const files = (r.ok && Array.isArray(r.data) ? r.data : [])
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name) && f.size <= 2_000_000)
    .sort((a, b) => Number(/logo/i.test(b.name)) - Number(/logo/i.test(a.name)))
    .slice(0, 2);
  const out: ToolImage[] = [];
  for (const f of files) {
    const res = await deps.fetch(signGcsUrl(env.credentials, env.bucket, f.path, "GET", { expiresInSeconds: 300 }), {
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res?.ok) continue;
    const ext = f.name.toLowerCase().split(".").pop();
    out.push({
      mediaType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg",
      data: Buffer.from(await res.arrayBuffer()).toString("base64"),
    });
  }
  return out;
}

export async function handleIdentityDraft(
  req: Row,
  authorization: string,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Row }> {
  const company = str(req.company, 40);
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  const scope = req.scope === "company" || req.scope === "gallery" ? req.scope : "client";
  const client = str(req.client, 40);
  if (scope === "client" && !UUID.test(client)) return fail(400, "Diga o cliente.");
  const url = str(req.url, 300);
  const notes = str(req.notes, 2000);
  let meter: Meter | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const user = userIdFrom(authorization);
    const meRes = await deps.fetch(
      `${env.supabaseUrl}/rest/v1/memberships?select=hidden_pages,active&company_id=eq.${company}&user_id=eq.${user}`,
      { headers: { apikey: env.supabaseKey, Authorization: authorization } },
    );
    const me = meRes.ok ? ((await meRes.json()) as { hidden_pages: string[] | null; active: boolean }[]) : [];
    if (!me[0]?.active) return fail(403, "Sem acesso a esta empresa.");
    if ((me[0].hidden_pages ?? []).includes("assistant")) return fail(403, "A MAVI está desligada para você nesta empresa.");
    const rpc = <T>(name: string, args: Row) =>
      callRpc<T>(env, deps.fetch, authorization, name, args).then((r) => (r.ok ? r.data : null));
    const [limits, route, brand, current, list] = await Promise.all([
      rpc<{ blocked: boolean; message: string | null }>("ai_check_limits", {
        p_company: company,
        p_client: scope === "client" ? client : null,
        p_contract: null,
        p_project: null,
      }),
      featureProvider(env, deps.fetch, authorization, company, "mavi_page", scope === "client" ? { client } : {}),
      scope === "client" ? rpc<BrandKit | null>("ai_brand_kit", { p_company: company, p_client: client }) : Promise.resolve(null),
      scope === "client"
        ? rpc<Full | null>("identity_of_client", { p_company: company, p_client: client })
        : UUID.test(str(req.current, 40))
          ? rpc<Full | null>("identity_get", { p_id: str(req.current, 40) })
          : Promise.resolve(null),
      scope === "company" ? rpc<{ company: IdentityRow | null } | null>("identity_list", { p_company: company, p_client: null }) : Promise.resolve(null),
    ]);
    if (scope === "client" && !brand) return fail(403, "Só quem atende este cliente gera a identidade dele.");
    provider = route;
    if (limits?.blocked) return fail(429, limits.message ?? "Limite de uso da MAVI atingido.");
    if (!provider && !env.anthropicKey) return fail(503, "A MAVI não está configurada no servidor.");
    const companyNow = scope === "company" && list?.company ? await rpc<Full | null>("identity_get", { p_id: list.company.id }) : null;
    const now = current ?? companyNow;
    // O site: as cores, as fontes e o texto (o que der; sem site, segue).
    const warnings: string[] = [];
    let site = "";
    if (url)
      site = await siteStyle(url, { fetch: deps.fetch, ...(deps.lookup ? { lookup: deps.lookup } : {}) })
        .then(siteStyleText)
        .catch((e: Error) => {
          warnings.push(`Não deu para ler o site: ${e.message}`);
          return "";
        });
    const images = scope === "client" ? await logoImages(env, deps, authorization, company, client).catch(() => []) : [];
    const material = [
      brand
        ? `Marca do Drive (${brand.client_name}):\n- Cores: ${brand.colors.map((c) => `${c.name || "sem nome"} ${c.hex}`).join(", ") || "nenhuma"}\n- Fontes: ${brand.fonts.map((f) => `“${f.family}” ${f.weight}${f.role ? ` (${f.role})` : ""}`).join("; ") || "nenhuma"}\n- Arquivos: ${brand.files.map((f) => f.name).join(", ") || "nenhum"}\n- Regras de uso: ${brand.notes?.trim() || "nenhuma"}`
        : "",
      images.length ? `Você vê ${images.length === 1 ? "o logo" : `${images.length} logos`} da Marca nas imagens.` : "",
      site,
      now ? `Identidade atual “${now.name}” (versão ${now.version}):\nTema: ${JSON.stringify(now.tokens)}\nGuia atual:\n${now.guide || "(vazio)"}` : "",
      notes ? `Pedido da pessoa: ${notes}` : "",
      !brand && !site && !now && !notes ? "Sem material: proponha um estilo neutro e diga o que falta." : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const make = (c: Parameters<typeof adapterFor>[0]) => (deps.providerLlm ?? ((x) => adapterFor(x, deps.fetch)))(c);
    const llm: LlmAdapter = routedLlm(provider ? make(provider.config) : deps.llm, {
      env,
      fetch: deps.fetch,
      auth: authorization,
      where: { company, surface: "identity_draft", feature: "mavi_page" },
      used: { providerId: provider?.id ?? null, model: provider?.config.model || env.model, scope: provider?.scope, auto: provider?.auto },
      question: "Monte a identidade visual e o Guia da marca a partir do material",
      hasServerKey: !!env.anthropicKey,
      open: { providerKey: env.providerKey ?? null, anthropicKey: env.anthropicKey, make, server: { model: env.model, llm: deps.llm } },
      onUsed: (c, config) => {
        provider = c.providerId ? { id: c.providerId, config, scope: "router" } : null;
      },
    });
    const result = await llm({
      instructions: DRAFT_INSTRUCTIONS.replace("{fonts}", Object.keys(GOOGLE_FONTS).slice(0, 14).join(", ")),
      context: "",
      messages: [{ role: "user", content: material, ...(images.length ? { images } : {}) }],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "medium",
      maxTokens: 12_000,
    });
    meter = result.meter;
    const data = jsonFrom(result.text);
    if (!data) return fail(502, "A MAVI não devolveu o rascunho no formato certo. Tente de novo.");
    const base: IdentityTokens = now
      ? sanitizeTokens(now.tokens)
      : brand && (brand.colors.length || brand.fonts.length || brand.files.length)
        ? tokensFromBrand(brand)
        : BUILTIN_LOOKS.claro.tokens;
    const tokens = sanitizeTokens(data.style ?? {}, base);
    return {
      status: 200,
      body: {
        name: str(data.name, 80) || now?.name || (brand ? `Marca de ${brand.client_name}` : "Nova identidade"),
        description: str(data.description, 300) || now?.description || "",
        tokens,
        guide: typeof data.guide === "string" ? data.guide.trim().slice(0, 30_000) : (now?.guide ?? ""),
        notes: [...warnings, ...(Array.isArray(data.notes) ? data.notes.map((n) => str(n, 300)).filter(Boolean).slice(0, 6) : [])],
        model: meter?.model || provider?.config.model || env.model,
      },
    };
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "identities",
        p_kind: "identity_draft",
        p_client: scope === "client" ? client : null,
        p_contract: null,
        p_project: null,
        p_recording: null,
        p_model: meter.model || provider?.config.model || env.model,
        p_input: meter.input ?? 0,
        p_output: meter.output ?? 0,
        p_cache_read: meter.cacheRead ?? 0,
        p_cache_write: meter.cacheWrite ?? 0,
        p_embedding: 0,
        p_cost: Math.round((meter.cost ?? 0) * 1e6) / 1e6,
        ...(provider ? { p_provider: provider.id } : {}),
      }).catch(() => {});
  }
}

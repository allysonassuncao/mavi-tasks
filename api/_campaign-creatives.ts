import { callRpc } from "./_drive.js";
import {
  isClaude,
  priceCost,
  routeConfig,
  type ProviderConfig,
  type ResolvedRoute,
} from "./_ai-providers.js";
import { graph, type AdsEnv } from "./_ads.js";
import { transcribe } from "./_whatsapp.js";
import { addUsage, newMeter } from "./_social-leads.js";
import { serverModel, transcribePerMinute } from "../src/ai-providers.js";
import type { AiDeps, AiEnv } from "./_ai.js";

/**
 * Campanhas › Insights da MAVI, Fase 3 (migração 20270328090000_campaign_creatives):
 * a MAVI enxerga os criativos dos anúncios que pesam na campanha.
 *
 * - Cada criativo é lido UMA vez, pela imagem (hash), pelo vídeo (id) ou pelo
 *   criativo/endereço, e o resumo fica em campaign_creatives: as próximas
 *   análises (e outras campanhas com o mesmo criativo) reaproveitam.
 * - Imagem (ou a capa do vídeo) + o texto do anúncio vão ao modelo de visão
 *   da funcionalidade 'campaign_creative_image'; o áudio do vídeo (até 24 MB)
 *   ao de transcrição 'campaign_creative_transcribe'. Sem acesso ao arquivo do
 *   vídeo, fica só a capa (e a nota diz isso).
 * - Nunca trava a análise: o que falhar vira nota e fica para a próxima.
 */

type Row = Record<string, unknown>;
type Fetch = typeof fetch;

export type CreativeSummary = {
  formato?: string;
  promessa?: string;
  gancho?: string;
  oferta?: string;
  prova?: string;
  cta?: string;
  publico_aparente?: string;
  texto_na_imagem?: string;
  resumo?: string;
};
/** Um anúncio que pesa na campanha e o criativo dele. */
export type CreativeAd = {
  entity: string;
  spend: number;
  title?: string;
  body?: string;
  cta?: string;
  /** Meta: o criativo e a conta (o token); Google: a imagem do anúncio. */
  meta?: { creative: string; account: string };
  google?: { image: string };
};
/** Um criativo a ler (ou já lido): a chave e de onde vem. */
export type CreativeSource = {
  key: string;
  kind: "image" | "video";
  image: string | null;
  video?: string | null;
  /** O anúncio publicado (Meta: Instagram ou Facebook), para a prévia dos insights. */
  link?: string | null;
  /** Meta: a conta (para ler o vídeo com o token dela). */
  account?: string;
  ads: CreativeAd[];
};
export type CreativeRead = {
  key: string;
  kind: "image" | "video";
  summary: CreativeSummary;
  transcript: string;
  note: string;
};
type Usage = {
  kind: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  provider_id?: string;
  provider?: string;
};

const IMAGE_MAX = 5 * 1024 * 1024;
const VIDEO_MAX = 24 * 1024 * 1024;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const hashUrl = (url: string) => {
  // Endereço sem a assinatura (os do Facebook mudam a cada leitura).
  const clean = url.split("?")[0];
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) | 0;
  return `u:${(h >>> 0).toString(36)}${clean.length.toString(36)}`;
};

/**
 * Os criativos do Meta (uma chamada para vários): a chave é o vídeo, senão o
 * hash da imagem, senão o próprio criativo — o mesmo vídeo em dois anúncios
 * é lido uma vez.
 */
export function metaSource(c: Row): Omit<CreativeSource, "ads" | "account"> {
  const story = str(c.effective_object_story_id);
  const oss = (c.object_story_spec ?? {}) as Row;
  const link = (oss.link_data ?? {}) as Row;
  const vdata = (oss.video_data ?? {}) as Row;
  const feed = (c.asset_feed_spec ?? {}) as Row;
  const feedVideo = Array.isArray(feed.videos) ? (feed.videos[0] as Row | undefined) : undefined;
  const feedImage = Array.isArray(feed.images) ? (feed.images[0] as Row | undefined) : undefined;
  const video = str(c.video_id) || str(vdata.video_id) || str(feedVideo?.video_id);
  const hash = str(c.image_hash) || str(link.image_hash) || str(feedImage?.hash);
  const image =
    str(c.image_url) ||
    str(link.picture) ||
    str(vdata.image_url) ||
    str(feedImage?.url) ||
    str(feedVideo?.thumbnail_url) ||
    str(c.thumbnail_url);
  return {
    key: video ? `v:${video}` : hash ? `i:${hash}` : `c:${str(c.id)}`,
    kind: video ? "video" : "image",
    image: image || null,
    video: video || null,
    link: str(c.instagram_permalink_url) || (story ? `https://www.facebook.com/${story}` : null),
  };
}

export const CREATIVE_PROMPT = `Você é a MAVI, a inteligência de uma agência de marketing (no feminino). Leia cada criativo de anúncio abaixo — a imagem (ou a capa do vídeo), o texto do anúncio e, quando houver, a transcrição do áudio — e descreva o que ele COMUNICA, para a equipe de tráfego entender por que ele funciona ou não.

Para cada criativo, responda com:
- "formato": imagem única, vídeo, carrossel, depoimento, antes e depois, print, produto em destaque…
- "promessa": a promessa principal (o benefício que o cliente vai ter).
- "gancho": o que prende a atenção nos primeiros segundos ou no primeiro olhar.
- "oferta": condição comercial (desconto, frete, brinde, prazo, garantia…), se houver.
- "prova": prova social ou de autoridade (depoimento, número, selo, especialista…), se houver.
- "cta": a chamada para ação.
- "publico_aparente": para quem o criativo parece falar.
- "texto_na_imagem": o texto escrito na imagem (resumido).
- "resumo": até 280 caracteres juntando o essencial.

Seja factual: só o que está na imagem, no texto ou no áudio. Campo sem nada: "". Português do Brasil.
Responda SOMENTE com o JSON: {"criativos": [{"key": "...", "formato": "...", "promessa": "...", "gancho": "...", "oferta": "...", "prova": "...", "cta": "...", "publico_aparente": "...", "texto_na_imagem": "...", "resumo": "..."}]}`;

/** A resposta do modelo: só os criativos pedidos, com os campos em texto curto. */
export function parseCreatives(text: string, keys: string[]): Map<string, CreativeSummary> {
  const out = new Map<string, CreativeSummary>();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let raw: Row;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Row;
  } catch {
    return out;
  }
  const list = Array.isArray(raw.criativos) ? (raw.criativos as Row[]) : [];
  const fields: (keyof CreativeSummary)[] = [
    "formato",
    "promessa",
    "gancho",
    "oferta",
    "prova",
    "cta",
    "publico_aparente",
    "texto_na_imagem",
    "resumo",
  ];
  for (const x of list) {
    const key = str(x?.key);
    if (!keys.includes(key)) continue;
    const s: CreativeSummary = {};
    for (const f of fields) {
      const v = str(x[f]).trim();
      if (v) s[f] = v.slice(0, f === "resumo" ? 300 : 200);
    }
    if (Object.keys(s).length) out.set(key, s);
  }
  return out;
}

/** O resumo como a análise lê (curto). */
export function creativeLine(s: CreativeSummary) {
  const parts = [
    s.resumo,
    s.promessa && `promessa: ${s.promessa}`,
    s.gancho && `gancho: ${s.gancho}`,
    s.oferta && `oferta: ${s.oferta}`,
    s.prova && `prova: ${s.prova}`,
    s.formato && `formato: ${s.formato}`,
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 600);
}

/** Baixa um arquivo público (imagem do anúncio ou o vídeo), com limite de tamanho. */
async function download(fetchImpl: Fetch, url: string, max: number) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`não abriu (${res.status})`);
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > max) throw new Error("arquivo grande demais");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > max) throw new Error("arquivo grande demais");
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  return { bytes, type };
}
const imageType = (type: string, bytes: Uint8Array) => {
  if (/^image\/(png|jpeg|webp|gif)$/.test(type)) return type;
  // Sem o tipo certo no cabeçalho: pelos primeiros bytes.
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
  return null;
};

type Image = { key: string; mime: string; data: string; text: string };

/** Lê algumas imagens numa chamada (Claude ou compatível com /chat/completions). */
async function vision(
  config: ProviderConfig,
  fetchImpl: Fetch,
  images: Image[],
): Promise<{ text: string; model: string; input: number; output: number; cost: number }> {
  if (isClaude(config)) {
    const res = await fetchImpl(`${(config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 400 * images.length + 400,
        system: CREATIVE_PROMPT,
        messages: [
          {
            role: "user",
            content: images.flatMap((i) => [
              { type: "text", text: i.text },
              { type: "image", source: { type: "base64", media_type: i.mime, data: i.data } },
            ]),
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      model?: string;
      content?: { type: string; text?: string }[];
      usage?: Record<string, number>;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`o modelo ${config.model} não leu as imagens: ${body.error?.message ?? res.status}`);
    const meter = newMeter(config.model);
    addUsage(meter, body.model ?? config.model, body.usage ?? {}, config.price);
    return {
      text: (body.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""),
      model: body.model ?? config.model,
      input: meter.input + meter.cacheRead + meter.cacheWrite,
      output: meter.output,
      cost: meter.cost,
    };
  }
  const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 400 * images.length + 400,
      messages: [
        { role: "system", content: CREATIVE_PROMPT },
        {
          role: "user",
          content: images.flatMap((i) => [
            { type: "text", text: i.text },
            { type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } },
          ]),
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string };
  };
  if (!res.ok)
    throw new Error(
      `o modelo ${config.model} não leu as imagens: ${body.error?.message?.slice(0, 160) ?? res.status}. Escolha um modelo com visão em Quem usa qual modelo.`,
    );
  const input = body.usage?.prompt_tokens ?? 0;
  const output = body.usage?.completion_tokens ?? 0;
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    model: config.model,
    input,
    output,
    cost: typeof body.usage?.cost === "number" ? body.usage.cost : priceCost(config.price, { input, output, cached: 0 }),
  };
}

export type CreativesEnv = AiEnv & { ads: AdsEnv };
export type CreativesInput = {
  company: string;
  platform: "meta" | "google";
  /** Os anúncios que pesam (os que vão para a análise), do maior investimento ao menor. */
  ads: CreativeAd[];
  /** Meta: o token aberto de cada conta. */
  tokens: Map<string, string>;
  /** O fetch que conta as chamadas às plataformas (a cota). */
  platformFetch: Fetch;
  /** Quanto as leituras novas podem gastar (US$). */
  budget: number;
};
/** O criativo de um anúncio: para a miniatura e a prévia dos insights. */
export type CreativeRef = {
  key: string;
  kind: "image" | "video";
  image: string | null;
  link: string | null;
  summary: CreativeSummary | null;
  transcript: string;
};
export type CreativesResult = {
  /** O resumo de cada anúncio (pela entidade). */
  byEntity: Map<string, { line: string; transcript: string }>;
  /** O criativo de cada anúncio (pela entidade), lido ou não. */
  byAd: Map<string, CreativeRef>;
  usage: Usage[];
  notes: string[];
  read: number;
  reused: number;
};

async function workerRpc<T>(env: AiEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** Quanto custa ler uma imagem (≈ 1.200 tokens de entrada e 350 de saída). */
export const imageEstimate = (price: { input: number; output: number }) => (1200 * price.input + 350 * price.output) / 1e6;

/**
 * Os criativos dos anúncios que pesam: o que já foi lido vem do banco; os
 * novos (até o limite da empresa e do orçamento) são lidos e guardados.
 */
export async function readCreatives(env: CreativesEnv, deps: AiDeps, input: CreativesInput): Promise<CreativesResult> {
  const result: CreativesResult = { byEntity: new Map(), byAd: new Map(), usage: [], notes: [], read: 0, reused: 0 };
  if (!input.ads.length) return result;
  // 1. De onde vem cada criativo (Meta: uma chamada por conta para todos).
  const sources = new Map<string, CreativeSource>();
  const add = (s: Omit<CreativeSource, "ads">, ad: CreativeAd) => {
    const found = sources.get(s.key) ?? { ...s, ads: [] };
    found.ads.push(ad);
    if (!found.image && s.image) found.image = s.image;
    if (!found.link && s.link) found.link = s.link;
    sources.set(s.key, found);
  };
  if (input.platform === "meta") {
    const byAccount = new Map<string, CreativeAd[]>();
    for (const ad of input.ads)
      if (ad.meta) byAccount.set(ad.meta.account, [...(byAccount.get(ad.meta.account) ?? []), ad]);
    for (const [account, ads] of byAccount) {
      const token = input.tokens.get(account);
      if (!token) continue;
      const ids = [...new Set(ads.map((a) => a.meta!.creative))].slice(0, 50);
      const found = await graph<Record<string, Row>>(env.ads, input.platformFetch, token, "/", {
        ids: ids.join(","),
        fields:
          "id,object_type,image_url,image_hash,video_id,thumbnail_url,instagram_permalink_url,effective_object_story_id,object_story_spec{link_data{picture,image_hash},video_data{video_id,image_url}},asset_feed_spec{images{hash,url},videos{video_id,thumbnail_url}}",
        thumbnail_width: "720",
        thumbnail_height: "720",
      });
      for (const ad of ads) {
        const c = found[ad.meta!.creative];
        if (c) add({ ...metaSource(c), account }, ad);
      }
    }
  } else {
    for (const ad of input.ads)
      if (ad.google?.image) add({ key: hashUrl(ad.google.image), kind: "image", image: ad.google.image }, ad);
  }
  if (!sources.size) return result;
  for (const s of sources.values())
    for (const ad of s.ads)
      result.byAd.set(ad.entity, { key: s.key, kind: s.kind, image: s.image, link: s.link ?? null, summary: null, transcript: "" });
  // 2. O que já foi lido (e as escolhas da empresa).
  const cached = await workerRpc<{
    settings: { images: boolean; videos: boolean; new_max: number };
    items: CreativeRead[];
  }>(env, deps, "ai_campaign_creatives_get", {
    p_company: input.company,
    p_platform: input.platform,
    p_keys: [...sources.keys()],
  });
  const known = new Map(cached.items.map((i) => [i.key, i]));
  const settings = cached.settings;
  // 3. Os novos que cabem: os de maior investimento primeiro.
  const spendOf = (s: CreativeSource) => s.ads.reduce((sum, a) => sum + a.spend, 0);
  const missing = [...sources.values()]
    .filter((s) => !known.has(s.key) && s.image && (s.kind === "video" ? settings.videos : settings.images))
    .sort((a, b) => spendOf(b) - spendOf(a));
  let fresh: CreativeSource[] = missing.slice(0, Math.max(settings.new_max, 0));
  if (missing.length > fresh.length)
    result.notes.push(`${missing.length - fresh.length} criativos novos ficaram para a próxima análise (limite por análise).`);
  // A rota da visão (ou a Claude do servidor) e o preço, para caber no orçamento.
  let config: ProviderConfig | null = null;
  let route: ResolvedRoute | null = null;
  if (fresh.length) {
    route = await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
      p_company: input.company,
      p_feature: "campaign_creative_image",
    }).catch(() => null);
    config = route?.key_cipher ? routeConfig(env, route) : null;
    if (!config && env.anthropicKey)
      config = {
        kind: "anthropic",
        name: "Claude",
        baseUrl: "",
        apiKey: env.anthropicKey,
        model: serverModel("campaign_creative_image", process.env),
        price: null,
      };
    if (!config) {
      result.notes.push("Sem modelo para ler as imagens dos criativos.");
      fresh = [];
    } else {
      const price = config.price ?? { input: 4, output: 20 };
      const fits = Math.max(Math.floor(input.budget / imageEstimate(price)), 0);
      if (fits < fresh.length) {
        result.notes.push(`Só ${fits} de ${fresh.length} criativos novos couberam no teto por análise.`);
        fresh = fresh.slice(0, fits);
      }
    }
  }
  // 4. Vídeos: o áudio (quando a empresa quer e há acesso ao arquivo).
  const transcripts = new Map<string, { text: string; note: string }>();
  const videos = fresh.filter((s) => s.kind === "video" && s.video && s.account);
  if (videos.length) {
    let via: ProviderConfig | null = null;
    const r = await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
      p_company: input.company,
      p_feature: "campaign_creative_transcribe",
    }).catch(() => null);
    via = r?.key_cipher ? routeConfig(env, r) : null;
    const model = via?.model ?? serverModel("campaign_creative_transcribe", process.env);
    for (const v of videos) {
      const token = input.tokens.get(v.account!);
      if (!token) continue;
      try {
        const info = await graph<{ source?: string; length?: number }>(env.ads, input.platformFetch, token, `/${v.video}`, {
          fields: "source,length",
        });
        if (!info.source) {
          transcripts.set(v.key, { text: "", note: "Sem acesso ao arquivo do vídeo: só a capa foi lida." });
          continue;
        }
        const file = await download(deps.fetch, info.source, VIDEO_MAX);
        const text = await transcribe(
          { openaiKey: env.openaiKey, transcribeModel: model },
          deps,
          file.bytes,
          file.type || "video/mp4",
          "video.mp4",
          via,
        );
        const minutes = Math.max(Number(info.length) || 60, 1) / 60;
        result.usage.push({
          kind: "campaign_creative_transcribe",
          model,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          cost: Math.round(minutes * transcribePerMinute(model, 0.006) * 1e6) / 1e6,
          ...(r ? { provider_id: r.provider_id, provider: r.provider } : {}),
        });
        transcripts.set(v.key, { text: text.slice(0, 20000), note: "" });
      } catch (e) {
        transcripts.set(v.key, {
          text: "",
          note: `O áudio do vídeo não pôde ser lido (${(e as Error).message.slice(0, 120)}): só a capa.`,
        });
      }
    }
  }
  // 5. As imagens (e capas), quatro por chamada, com o texto do anúncio.
  const saved: (CreativeRead & { model: string; cost: number })[] = [];
  for (let i = 0; i < fresh.length && config; i += 4) {
    const chunk = fresh.slice(i, i + 4);
    const images: Image[] = [];
    for (const s of chunk) {
      try {
        const file = await download(deps.fetch, s.image!, IMAGE_MAX);
        const mime = imageType(file.type, file.bytes);
        if (!mime) throw new Error("formato de imagem não suportado");
        const ad = s.ads[0];
        const t = transcripts.get(s.key);
        images.push({
          key: s.key,
          mime,
          data: Buffer.from(file.bytes).toString("base64"),
          text: [
            `Criativo ${s.key} (${s.kind === "video" ? "vídeo: a imagem é a capa" : "imagem"})`,
            ad.title && `Título: ${ad.title}`,
            ad.body && `Texto do anúncio: ${ad.body.slice(0, 800)}`,
            ad.cta && `Chamada: ${ad.cta}`,
            t?.text && `Transcrição do áudio: ${t.text.slice(0, 4000)}`,
          ]
            .filter(Boolean)
            .join("\n"),
        });
      } catch (e) {
        result.notes.push(`Criativo não lido (${(e as Error).message.slice(0, 80)}).`);
      }
    }
    if (!images.length) continue;
    try {
      const r = await vision(config, deps.fetch, images);
      result.usage.push({
        kind: "campaign_creative_image",
        model: r.model,
        input: r.input,
        output: r.output,
        cache_read: 0,
        cache_write: 0,
        cost: Math.round(r.cost * 1e6) / 1e6,
        ...(route ? { provider_id: route.provider_id, provider: route.provider } : {}),
      });
      const parsed = parseCreatives(
        r.text,
        images.map((x) => x.key),
      );
      const each = r.cost / Math.max(parsed.size, 1);
      for (const [key, summary] of parsed) {
        const s = sources.get(key)!;
        const t = transcripts.get(key);
        saved.push({ key, kind: s.kind, summary, transcript: t?.text ?? "", note: t?.note ?? "", model: r.model, cost: each });
      }
    } catch (e) {
      result.notes.push(`Leitura dos criativos: ${(e as Error).message.slice(0, 200)}`);
      break;
    }
  }
  if (saved.length)
    await workerRpc(env, deps, "ai_campaign_creatives_put", {
      p_company: input.company,
      p_platform: input.platform,
      p_items: saved,
    }).catch((e) => result.notes.push(`Os criativos lidos não foram guardados: ${(e as Error).message}`));
  result.read = saved.length;
  // 6. Cada anúncio com o resumo do criativo dele (lido agora ou antes).
  const all = new Map<string, CreativeRead>([...known, ...saved.map((x) => [x.key, x] as const)]);
  for (const [key, s] of sources) {
    const r = all.get(key);
    if (!r) continue;
    if (known.has(key)) result.reused++;
    for (const ad of s.ads) {
      result.byEntity.set(ad.entity, { line: creativeLine(r.summary), transcript: (r.transcript ?? "").slice(0, 300) });
      const ref = result.byAd.get(ad.entity);
      if (ref) Object.assign(ref, { summary: r.summary, transcript: (r.transcript ?? "").slice(0, 600) });
    }
  }
  return result;
}

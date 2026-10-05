import crypto from "node:crypto";
import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import type { CreativeRef, CreativeSummary } from "./_campaign-creatives.js";
import type { AiDeps, AiEnv } from "./_ai.js";

/**
 * Campanhas › Insights da MAVI: a miniatura dos criativos citados (migração
 * 20270506090000_campaign_insight_creatives).
 *
 * - Só os anúncios que o insight cita: o alvo (quando é um anúncio) e os dos
 *   números, nessa ordem, até 6.
 * - Os endereços das imagens do Meta/Google expiram: cada criativo vira UMA
 *   miniatura WebP (até 640 px) no bucket público, num caminho aleatório, e o
 *   endereço fica em campaign_creative_thumbs para as próximas análises.
 * - A lista (com o que a MAVI leu no criativo) vai em insight.extra.creatives.
 * - Nunca trava a análise: o que falhar fica sem miniatura.
 */

type Row = Record<string, unknown>;
type Fetch = typeof fetch;

/** Até 6 criativos por insight; até 12 miniaturas novas por análise. */
export const CREATIVES_PER_INSIGHT = 6;
export const NEW_THUMBS_MAX = 12;
const IMAGE_MAX = 8 * 1024 * 1024;
const THUMB_MAX = 1024 * 1024;

export type InsightCreative = {
  entity: string;
  name: string;
  parent?: string;
  key: string;
  kind: "image" | "video";
  thumb: string;
  link?: string;
  summary?: CreativeSummary;
  transcript?: string;
};
/** O mínimo de um insight e de uma entidade que esta etapa precisa. */
type CitingInsight = {
  target: { key: string; level: string } | null;
  evidence: { entity: string }[];
  extra?: Row;
};
type AdEntity = { key: string; level: string; name: string; parent?: string };

export type ThumbsEnv = AiEnv & { publicBucket?: string };
/** Reduz a imagem (WebP, até 640 px); sem ela, a imagem vai como veio (se for pequena). */
export type ToWebp = (bytes: Uint8Array) => Promise<Uint8Array>;

/** Os anúncios citados: o alvo primeiro, depois os dos números (sem repetir). */
export function citedAds(insight: CitingInsight, entities: Map<string, AdEntity>) {
  const keys = [
    ...(insight.target?.level === "ad" ? [insight.target.key] : []),
    ...insight.evidence.map((e) => e.entity),
  ];
  return [...new Set(keys)].filter((k) => entities.get(k)?.level === "ad");
}

async function workerRpc<T>(env: AiEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const imageType = (type: string, bytes: Uint8Array) => {
  if (/^image\/(png|jpeg|webp|gif)$/.test(type)) return type;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
  return null;
};

/** Baixa a imagem, reduz e guarda no bucket público: devolve o endereço. */
export async function makeThumb(
  fetchImpl: Fetch,
  storage: { credentials: GcsCredentials; bucket: string },
  company: string,
  image: string,
  toWebp?: ToWebp,
) {
  const res = await fetchImpl(image, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`a imagem não abriu (${res.status})`);
  const original = new Uint8Array(await res.arrayBuffer());
  if (original.byteLength > IMAGE_MAX) throw new Error("imagem grande demais");
  const mime = imageType((res.headers.get("content-type") ?? "").split(";")[0].trim(), original);
  if (!mime) throw new Error("formato de imagem não suportado");
  let bytes = original;
  let type = mime;
  if (toWebp) {
    bytes = await toWebp(original);
    type = "image/webp";
  }
  if (bytes.byteLength > THUMB_MAX) throw new Error("miniatura grande demais");
  const ext = type.split("/")[1].replace("jpeg", "jpg");
  const path = `campaign-creatives/${company}/${crypto.randomUUID()}.${ext}`;
  const headers = { "cache-control": "public, max-age=31536000, immutable" };
  const url = signGcsUrl(storage.credentials, storage.bucket, path, "PUT", { contentType: type, headers });
  const put = await fetchImpl(url, {
    method: "PUT",
    headers: { "Content-Type": type, ...headers },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!put.ok) throw new Error(`a miniatura não foi guardada (${put.status})`);
  return `https://storage.googleapis.com/${storage.bucket}/${path}`;
}

/**
 * Põe em cada insight a lista dos criativos citados (com a miniatura). As
 * miniaturas que faltam são geradas agora (até NEW_THUMBS_MAX).
 */
export async function attachCreatives(
  env: ThumbsEnv,
  deps: AiDeps & { toWebp?: ToWebp },
  input: {
    company: string;
    platform: "meta" | "google";
    insights: CitingInsight[];
    entities: Map<string, AdEntity>;
    refs: Map<string, CreativeRef>;
  },
): Promise<{ notes: string[]; made: number }> {
  const out = { notes: [] as string[], made: 0 };
  const cited = new Map<CitingInsight, string[]>();
  const keys: string[] = [];
  for (const i of input.insights) {
    const ads = citedAds(i, input.entities).filter((e) => input.refs.get(e)?.image);
    if (!ads.length) continue;
    cited.set(i, ads);
    for (const e of ads) keys.push(input.refs.get(e)!.key);
  }
  if (!cited.size) return out;
  const wanted = [...new Set(keys)];
  const urls = new Map(
    Object.entries(
      await workerRpc<Record<string, string>>(env, deps, "ai_campaign_creative_thumbs_get", {
        p_company: input.company,
        p_platform: input.platform,
        p_keys: wanted,
      }),
    ),
  );
  const missing = wanted.filter((k) => !urls.has(k));
  const storage = env.credentials && env.publicBucket ? { credentials: env.credentials, bucket: env.publicBucket } : null;
  if (missing.length && !storage) out.notes.push("Sem acesso ao armazenamento: os criativos ficaram sem miniatura.");
  if (missing.length && storage) {
    const imageOf = new Map([...input.refs.values()].map((r) => [r.key, r.image!]));
    const made: Record<string, string> = {};
    const now = missing.slice(0, NEW_THUMBS_MAX);
    let failed = 0;
    await Promise.all(
      now.map(async (key) => {
        try {
          made[key] = await makeThumb(deps.fetch, storage, input.company, imageOf.get(key)!, deps.toWebp);
        } catch {
          failed++;
        }
      }),
    );
    if (Object.keys(made).length) {
      await workerRpc(env, deps, "ai_campaign_creative_thumbs_put", {
        p_company: input.company,
        p_platform: input.platform,
        p_items: made,
      });
      for (const [k, u] of Object.entries(made)) urls.set(k, u);
      out.made = Object.keys(made).length;
    }
    if (failed) out.notes.push(`${failed} ${failed === 1 ? "criativo ficou" : "criativos ficaram"} sem miniatura.`);
  }
  for (const [insight, ads] of cited) {
    const list: InsightCreative[] = [];
    for (const entity of ads) {
      const ref = input.refs.get(entity)!;
      const thumb = urls.get(ref.key);
      if (!thumb) continue;
      const e = input.entities.get(entity)!;
      const parent = e.parent ? input.entities.get(e.parent)?.name : undefined;
      list.push({
        entity,
        name: e.name,
        ...(parent ? { parent } : {}),
        key: ref.key,
        kind: ref.kind,
        thumb,
        ...(ref.link ? { link: ref.link } : {}),
        ...(ref.summary ? { summary: ref.summary } : {}),
        ...(ref.transcript ? { transcript: ref.transcript } : {}),
      });
      if (list.length >= CREATIVES_PER_INSIGHT) break;
    }
    if (list.length) insight.extra = { ...(insight.extra ?? {}), creatives: list };
  }
  return out;
}

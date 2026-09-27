import crypto from "node:crypto";
import {
  callRpc,
  signGcsUrl,
  type DriveEnv,
  type GcsCredentials,
} from "./_drive.js";
import { extractFileText } from "./_ai-extract.js";

/**
 * Drive › cliente › "Whatsapp": a coleta dos grupos na Uazapi
 * (migration 20261027150000_whatsapp_groups).
 *
 * - "whatsapp-sync": o worker, chamado pelo pg_cron (mavi_private.
 *   whatsapp_kick) com o segredo. A cada 2 horas faz a varredura (a lista de
 *   grupos com o horário da última mensagem, 200 por página); depois lê os
 *   grupos com mensagem nova desde onde parou e copia as mídias para o GCS,
 *   enquanto houver tempo. O que não couber fica para a próxima chamada.
 *
 * - "whatsapp-media": links assinados das mídias para a pasta Whatsapp do
 *   Drive, como a pessoa (o banco confere o acesso pela regra do Drive).
 *
 * A Uazapi guarda as mensagens por 7 dias e as mídias por 2: por isso as
 * mídias mais antigas da fila vão primeiro. O servidor fala com o banco como
 * anon + segredo (sem service key) e o token da Uazapi só existe aqui.
 */

type Row = Record<string, any>;

export type WhatsappEnv = Pick<
  DriveEnv,
  "supabaseUrl" | "supabaseKey" | "bucket" | "credentials"
> & {
  uazapiUrl: string;
  uazapiToken: string;
  workerSecret: string;
  /** Quanto o worker trabalha por chamada (ms). */
  workerBudgetMs: number;
  /** Mídias maiores que isso não são copiadas (ficam como "grande demais"). */
  mediaMaxBytes: number;
  /** Transcrição dos áudios (OpenAI, a mesma chave dos vetores da MAVI). */
  openaiKey: string;
  transcribeModel: string;
  /** Preço da transcrição por minuto (US$), para o painel de consumo. */
  transcribeUsdPerMinute: number;
};

export function whatsappEnv(
  drive: DriveEnv,
  env: Record<string, string | undefined> = process.env,
): WhatsappEnv {
  return {
    supabaseUrl: drive.supabaseUrl,
    supabaseKey: drive.supabaseKey,
    bucket: env.GCS_WHATSAPP_BUCKET || drive.bucket,
    credentials: drive.credentials,
    uazapiUrl: (env.UAZAPI_URL || "").replace(/\/+$/, ""),
    uazapiToken: env.UAZAPI_TOKEN || "",
    workerSecret: env.WHATSAPP_WORKER_SECRET || "",
    workerBudgetMs: Number(env.WHATSAPP_WORKER_BUDGET_MS) || 80_000,
    mediaMaxBytes: (Number(env.WHATSAPP_MEDIA_MAX_MB) || 300) * 1024 * 1024,
    openaiKey: env.OPENAI_API_KEY || "",
    transcribeModel: env.WHATSAPP_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    transcribeUsdPerMinute:
      Number(env.WHATSAPP_TRANSCRIBE_USD_PER_MIN) || 0.003,
  };
}

export type WhatsappDeps = { fetch: typeof fetch; now?: () => number };

class WhatsappError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ mensagens
export type WhatsappKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "reaction"
  | "album"
  | "poll"
  | "location"
  | "contact"
  | "unavailable"
  | "other";

const KINDS: Record<string, WhatsappKind> = {
  Conversation: "text",
  ExtendedTextMessage: "text",
  TextMessage: "text",
  ImageMessage: "image",
  VideoMessage: "video",
  PtvMessage: "video",
  AudioMessage: "audio",
  DocumentMessage: "document",
  DocumentWithCaptionMessage: "document",
  StickerMessage: "sticker",
  ReactionMessage: "reaction",
  AlbumMessage: "album",
  PollCreationMessage: "poll",
  PollCreationMessageV2: "poll",
  PollCreationMessageV3: "poll",
  LocationMessage: "location",
  LiveLocationMessage: "location",
  ContactMessage: "contact",
  ContactsArrayMessage: "contact",
  error: "unavailable",
};
// Controle do WhatsApp (apagar, editar, chaves) e votos: não são conversa.
const SKIPPED = new Set([
  "ProtocolMessage",
  "SenderKeyDistributionMessage",
  "PollUpdateMessage",
  "MessageHistoryBundle",
  "KeepInChatMessage",
  "PinInChatMessage",
]);

export type WhatsappMessage = {
  wa_id: string;
  source_id: string;
  sent_at: string;
  sender: string;
  sender_phone: string;
  sender_name: string;
  from_me: boolean;
  kind: WhatsappKind;
  body: string;
  quoted_wa_id: string | null;
  reaction_to: string | null;
  edited: boolean;
  extra: Row;
  media_mime: string | null;
  media_name: string | null;
  media_bytes: number | null;
  media_seconds: number | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.round(n)
    : null;
};

/** Milissegundos de uma mensagem da Uazapi (vem em ms; aceita segundos). */
export function messageTime(raw: Row): number | null {
  const t = Number(raw?.messageTimestamp);
  if (!Number.isFinite(t) || t <= 0) return null;
  return t < 1e12 ? t * 1000 : t;
}

/** Uma mensagem da Uazapi no formato de whatsapp_messages (null = não guardar). */
export function normalizeMessage(raw: Row): WhatsappMessage | null {
  const type = str(raw?.messageType);
  const time = messageTime(raw);
  const waId = str(raw?.messageid) || str(raw?.id).split(":").pop() || "";
  if (!waId || time === null || SKIPPED.has(type)) return null;
  let content: Row = {};
  if (raw.content && typeof raw.content === "object") content = raw.content;
  else if (typeof raw.content === "string")
    try {
      const parsed = JSON.parse(raw.content);
      if (parsed && typeof parsed === "object") content = parsed;
    } catch {
      /* texto puro */
    }
  const text = str(raw.text) || str(content.caption) || str(content.text);
  const kind: WhatsappKind = KINDS[type] ?? "other";
  if (kind === "other" && !text.trim()) return null;
  const media = ["image", "video", "audio", "document", "sticker"].includes(
    kind,
  );
  const extra: Row = {};
  let body = text;
  if (kind === "poll") {
    body = str(content.name) || text;
    extra.options = (Array.isArray(content.options) ? content.options : [])
      .map((o: Row) => str(o?.optionName))
      .filter(Boolean);
  } else if (kind === "location") {
    body = [str(content.name), str(content.address)]
      .filter(Boolean)
      .join(" · ");
    const lat = Number(content.degreesLatitude);
    const lng = Number(content.degreesLongitude);
    if (Number.isFinite(lat) && Number.isFinite(lng))
      Object.assign(extra, { lat, lng });
  } else if (kind === "contact") {
    body = str(content.displayName) || text;
  } else if (kind === "unavailable") {
    // "[Undecryptable] …": a mensagem existe, mas o conteúdo não veio.
    body = "";
    if (/view_once/i.test(text)) extra.view_once = true;
  }
  // A miniatura que o WhatsApp manda junto (poucos KB): prévia na conversa
  // e na galeria sem baixar a mídia.
  const thumb = str(content.JPEGThumbnail);
  if ((kind === "image" || kind === "video") && thumb && thumb.length <= 12_000)
    extra.thumb = thumb;
  const phone =
    str(raw.sender_pn).replace(/@.*$/, "") ||
    (str(raw.sender).endsWith("@s.whatsapp.net")
      ? str(raw.sender).replace(/@.*$/, "")
      : "");
  return {
    wa_id: waId,
    source_id: str(raw.id),
    sent_at: new Date(time).toISOString(),
    sender: str(raw.sender),
    sender_phone: phone,
    sender_name: str(raw.senderName),
    from_me: raw.fromMe === true,
    kind,
    body,
    quoted_wa_id: str(raw.quoted) || str(content.contextInfo?.stanzaID) || null,
    reaction_to: kind === "reaction" ? str(raw.reaction) || null : null,
    edited: !!str(raw.edited),
    extra,
    media_mime: media ? str(content.mimetype) || null : null,
    media_name:
      kind === "document"
        ? str(content.fileName) || str(content.title) || null
        : null,
    media_bytes: media ? num(content.fileLength) : null,
    media_seconds: media ? num(content.seconds) : null,
  };
}

// ------------------------------------------------------------ Uazapi
async function uazapi<T = Row>(
  env: WhatsappEnv,
  deps: WhatsappDeps,
  path: string,
  body: Row,
  timeoutMs = 25_000,
): Promise<T> {
  let last = "";
  // Uma nova tentativa quando a Uazapi está ocupada ou fora do ar.
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(`${env.uazapiUrl}${path}`, {
        method: "POST",
        headers: { token: env.uazapiToken, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = `Uazapi ${path}: ${(e as Error).message}`;
      continue;
    }
    const text = await res.text();
    if (res.ok)
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new WhatsappError(502, `Uazapi ${path}: resposta inválida.`);
      }
    last = `Uazapi ${path} (${res.status}): ${text.slice(0, 200)}`;
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new WhatsappError(502, last);
}

export type UazapiGroup = {
  jid: string;
  title: string;
  last_message_at: number;
};

/** Todos os grupos que o número conhece, com o horário da última mensagem. */
export async function listGroups(env: WhatsappEnv, deps: WhatsappDeps) {
  const out: UazapiGroup[] = [];
  for (let offset = 0, page = 0; page < 100; page++) {
    const r = await uazapi<Row>(env, deps, "/chat/find", {
      wa_isGroup: true,
      sort: "-wa_lastMsgTimestamp",
      compact: true,
      limit: 200,
      offset,
    });
    const chats: Row[] = Array.isArray(r?.chats) ? r.chats : [];
    for (const c of chats) {
      const jid = str(c.wa_chatid);
      if (!jid.endsWith("@g.us")) continue;
      out.push({
        jid,
        title: str(c.wa_name) || str(c.name),
        last_message_at: Number(c.wa_lastMsgTimestamp) || 0,
      });
    }
    offset += chats.length;
    const total = Number(r?.pagination?.totalRecords);
    if (!chats.length || (Number.isFinite(total) && offset >= total)) break;
  }
  return out;
}

// ------------------------------------------------------------ banco
async function rpc<T>(
  env: WhatsappEnv,
  deps: WhatsappDeps,
  name: string,
  args: Row,
) {
  const r = await callRpc<T>(env, deps.fetch, null, name, {
    p_secret: env.workerSecret,
    ...args,
  });
  if (!r.ok) throw new WhatsappError(r.status, `${name}: ${r.error}`);
  return r.data;
}

type ClaimedGroup = { id: string; jid: string; since: string };
type ClaimedMedia = {
  id: string;
  source_id: string;
  group_jid: string;
  kind: WhatsappKind;
  media_mime: string | null;
  media_name: string | null;
  media_bytes: number | null;
  sent_at: string;
};

// Margem para mensagens com o mesmo horário da última lida (nada duplica).
const OVERLAP_MS = 60_000;
const PAGE = 200;
const STORE_BATCH = 500;

/**
 * Lê um grupo da mensagem mais nova para trás até "since". Só avança o ponto
 * de leitura se chegou lá antes do fim do tempo.
 */
async function readGroup(
  env: WhatsappEnv,
  deps: WhatsappDeps,
  g: ClaimedGroup,
  deadline: number,
) {
  const now = deps.now ?? Date.now;
  const since = new Date(g.since).getTime() - OVERLAP_MS;
  const found: WhatsappMessage[] = [];
  let newest = 0;
  let complete = false;
  let error: string | null = null;
  try {
    for (let offset = 0, page = 0; page < 200; page++) {
      if (now() > deadline) break;
      const r = await uazapi<Row>(env, deps, "/message/find", {
        chatid: g.jid,
        limit: PAGE,
        offset,
      });
      const messages: Row[] = Array.isArray(r?.messages) ? r.messages : [];
      let oldest = Infinity;
      for (const raw of messages) {
        const t = messageTime(raw);
        if (t === null) continue;
        oldest = Math.min(oldest, t);
        if (t < since) continue;
        newest = Math.max(newest, t);
        const m = normalizeMessage(raw);
        if (m) found.push(m);
      }
      if (!messages.length || oldest < since || r?.hasMore === false) {
        complete = true;
        break;
      }
      offset =
        Number(r?.nextOffset) > offset
          ? Number(r.nextOffset)
          : offset + messages.length;
    }
  } catch (e) {
    error = (e as Error).message;
  }
  const until = complete
    ? new Date(Math.max(newest, since + OVERLAP_MS)).toISOString()
    : null;
  let stored = 0;
  // Em lotes; o último leva o ponto de leitura (ou o erro).
  for (let i = 0; i < Math.max(found.length, 1); i += STORE_BATCH) {
    const last = i + STORE_BATCH >= found.length;
    stored += await rpc<number>(env, deps, "whatsapp_store_messages", {
      p_group: g.id,
      p_messages: found.slice(i, i + STORE_BATCH),
      p_until: last ? until : null,
      p_error: last ? error : null,
    });
  }
  return { stored, complete, error };
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "application/pdf": ".pdf",
};

/** Onde a mídia fica no GCS: whatsapp/<empresa>/<grupo>/<aaaa>/<mm>/<id>.<ext>. */
export function mediaPath(
  company: string,
  item: Pick<ClaimedMedia, "id" | "group_jid" | "sent_at" | "media_name">,
  mime: string,
) {
  const base = mime.split(";")[0].trim().toLowerCase();
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(item.media_name ?? "")?.[0];
  const ext = EXTENSIONS[base] ?? fromName?.toLowerCase() ?? "";
  const d = new Date(item.sent_at);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const group = item.group_jid
    .replace(/@g\.us$/, "")
    .replace(/[^A-Za-z0-9-]/g, "_");
  return `whatsapp/${company}/${group}/${d.getUTCFullYear()}/${month}/${item.id}${ext}`;
}

/** Baixa uma mídia da Uazapi e guarda no GCS. */
async function copyMedia(
  env: WhatsappEnv,
  deps: WhatsappDeps,
  company: string,
  item: ClaimedMedia,
  creds: GcsCredentials,
) {
  const report = (status: string, extra: Row = {}) =>
    rpc(env, deps, "whatsapp_store_media", {
      p_message: item.id,
      p_status: status,
      ...extra,
    });
  if (item.media_bytes && item.media_bytes > env.mediaMaxBytes)
    return report("too_large", { p_error: `${item.media_bytes} bytes` });
  try {
    const link = await uazapi<Row>(
      env,
      deps,
      "/message/download",
      { id: item.source_id, return_link: true, generate_mp3: true },
      60_000,
    );
    const url = str(link?.fileURL);
    if (!url) throw new Error("A Uazapi não devolveu o arquivo.");
    const file = await deps.fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!file.ok) throw new Error(`Download da mídia falhou (${file.status}).`);
    const length = Number(file.headers.get("content-length"));
    if (length > env.mediaMaxBytes) {
      await file.body?.cancel();
      return report("too_large", { p_error: `${length} bytes` });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > env.mediaMaxBytes)
      return report("too_large", { p_error: `${bytes.byteLength} bytes` });
    const mime =
      str(link?.mimetype) ||
      file.headers.get("content-type") ||
      item.media_mime ||
      "application/octet-stream";
    const path = mediaPath(company, item, mime);
    const put = await deps.fetch(
      signGcsUrl(creds, env.bucket, path, "PUT", { contentType: mime }),
      {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: bytes,
        signal: AbortSignal.timeout(90_000),
      },
    );
    if (!put.ok) throw new Error(`Envio ao GCS falhou (${put.status}).`);
    return report("stored", {
      p_bucket: env.bucket,
      p_path: path,
      p_mime: mime,
      p_bytes: bytes.byteLength,
    });
  } catch (e) {
    return report("failed", { p_error: (e as Error).message });
  }
}

type ClaimedContent = {
  id: string;
  kind: "audio" | "document";
  /** "audio" ou o tipo de documento que o extrator lê (pdf, docx…). */
  content_kind: string | null;
  bucket: string;
  path: string;
  media_mime: string | null;
  media_name: string | null;
  media_bytes: number | null;
  media_seconds: number | null;
  client_id: string | null;
};

/** O texto de um áudio, pela OpenAI (uma nova tentativa em 429 e 5xx). */
export async function transcribe(
  env: WhatsappEnv,
  deps: WhatsappDeps,
  bytes: Uint8Array,
  mime: string,
  name: string,
) {
  if (!env.openaiKey)
    throw new Error(
      "Transcrição não configurada: falta OPENAI_API_KEY na Vercel.",
    );
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), name);
    form.append("model", env.transcribeModel);
    form.append("language", "pt");
    form.append("response_format", "json");
    const res = await deps.fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.openaiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      },
    );
    const text = await res.text();
    if (res.ok) return str(JSON.parse(text)?.text).trim();
    last = `Transcrição (${res.status}): ${text.slice(0, 200)}`;
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new Error(last);
}

/**
 * Lê uma mídia guardada: transcreve o áudio ou extrai o texto do documento
 * e devolve ao banco. Retorna o custo (US$) da transcrição.
 */
async function readContent(
  env: WhatsappEnv,
  deps: WhatsappDeps,
  item: ClaimedContent,
  creds: GcsCredentials,
) {
  const report = (
    status: string,
    text: string | null,
    error: string | null = null,
  ) =>
    rpc(env, deps, "whatsapp_store_content", {
      p_message: item.id,
      p_status: status,
      p_text: text,
      p_error: error,
    });
  if (!item.content_kind || item.bucket !== env.bucket) {
    await report("skipped", null);
    return 0;
  }
  try {
    const file = await deps.fetch(
      signGcsUrl(creds, item.bucket, item.path, "GET", {
        expiresInSeconds: 300,
      }),
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!file.ok) throw new Error(`Download do GCS falhou (${file.status}).`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = item.media_name || item.path.split("/").pop() || "arquivo";
    if (item.content_kind === "audio") {
      const text = await transcribe(
        env,
        deps,
        bytes,
        item.media_mime || "audio/mpeg",
        item.path.split("/").pop() || "audio.mp3",
      );
      await report(text ? "done" : "empty", text || null);
      // Sem a duração, estima pelo tamanho do MP3 (~16 KB por segundo).
      const seconds = item.media_seconds || bytes.byteLength / 16_000;
      return (seconds / 60) * env.transcribeUsdPerMinute;
    }
    const out = await extractFileText(item.content_kind, bytes, name);
    const text = out.pages
      .map((p) => [p.label, p.text].filter(Boolean).join("\n"))
      .join("\n\n")
      .trim();
    if (out.status === "done" && text) await report("done", text);
    else if (out.status === "error")
      await report("error", null, out.error ?? "falha ao ler");
    else await report(out.status === "unsupported" ? "skipped" : "empty", null);
    return 0;
  } catch (e) {
    await report("error", null, (e as Error).message);
    return 0;
  }
}

/** Faz em paralelo, no máximo `limit` de cada vez. */
async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export async function runWhatsappSync(env: WhatsappEnv, deps: WhatsappDeps) {
  const now = deps.now ?? Date.now;
  const deadline = now() + env.workerBudgetMs;
  const stats = {
    groups: 0,
    swept: 0,
    groupsRead: 0,
    messages: 0,
    media: 0,
    contents: 0,
    errors: [] as string[],
  };
  const state = await rpc<{ company: string; sweep_due: boolean }>(
    env,
    deps,
    "whatsapp_worker_state",
    {},
  );
  if (state.sweep_due) {
    try {
      const groups = await listGroups(env, deps);
      stats.groups = groups.length;
      stats.swept = await rpc<number>(env, deps, "whatsapp_sweep", {
        p_groups: groups,
        p_error: null,
      });
    } catch (e) {
      const message = (e as Error).message;
      stats.errors.push(message);
      await rpc(env, deps, "whatsapp_sweep", {
        p_groups: null,
        p_error: message,
      }).catch(() => {});
    }
  }
  let groupsDone = false;
  let mediaDone = !env.credentials;
  let contentDone = !env.credentials;
  const costs = new Map<string, number>();
  if (!env.credentials)
    stats.errors.push(
      "Credenciais do GCS não configuradas: mídias ficam na fila.",
    );
  // Grupos e mídias se alternam: as mídias vencem em 2 dias na Uazapi. Ler
  // o conteúdo (transcrever, extrair texto) vem depois, sem pressa.
  while (
    !(groupsDone && mediaDone && contentDone) &&
    now() < deadline - 5_000
  ) {
    if (!groupsDone) {
      const claimed = await rpc<ClaimedGroup[]>(
        env,
        deps,
        "whatsapp_claim_groups",
        { p_limit: 4 },
      );
      if (!claimed.length) groupsDone = true;
      await pool(claimed, 4, async (g) => {
        const r = await readGroup(env, deps, g, deadline - 5_000);
        stats.groupsRead++;
        stats.messages += r.stored;
        if (r.error) stats.errors.push(`${g.jid}: ${r.error}`);
      });
    }
    // Baixar e enviar uma mídia grande leva tempo: só com folga no relógio.
    if (!mediaDone && now() < deadline - 30_000) {
      const claimed = await rpc<ClaimedMedia[]>(
        env,
        deps,
        "whatsapp_claim_media",
        { p_limit: 6 },
      );
      if (!claimed.length) mediaDone = true;
      await pool(claimed, 3, async (item) => {
        await copyMedia(env, deps, state.company, item, env.credentials!);
        stats.media++;
      });
    } else mediaDone = true;
    if (!contentDone && mediaDone && now() < deadline - 30_000) {
      const claimed = await rpc<ClaimedContent[]>(
        env,
        deps,
        "whatsapp_claim_content",
        { p_limit: 4 },
      );
      if (!claimed.length) contentDone = true;
      await pool(claimed, 2, async (item) => {
        const cost = await readContent(env, deps, item, env.credentials!);
        stats.contents++;
        if (cost > 0 && item.client_id)
          costs.set(item.client_id, (costs.get(item.client_id) ?? 0) + cost);
      });
    } else if (mediaDone) contentDone = true;
  }
  if (costs.size)
    await rpc(env, deps, "whatsapp_log_usage", {
      p_model: env.transcribeModel,
      p_items: [...costs].map(([client, cost]) => ({
        client,
        cost: Math.round(cost * 1e6) / 1e6,
      })),
    }).catch(() => {});
  return stats;
}

// ------------------------------------------------------------ entrada
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Links assinados das mídias, como a pessoa (o banco confere o acesso). Até
 * 100 de uma vez (a conversa e a galeria pedem a página toda); "download"
 * abre uma só, como anexo, e entra no histórico do Drive.
 */
async function mediaLinks(
  req: Row,
  authorization: string,
  env: WhatsappEnv,
  deps: WhatsappDeps,
  origin: Row,
) {
  const ids: string[] = Array.isArray(req.ids)
    ? ([
        ...new Set(
          req.ids.filter(
            (id: unknown) => typeof id === "string" && UUID.test(id),
          ),
        ),
      ] as string[])
    : [];
  if (!ids.length || ids.length !== req.ids.length || ids.length > 100)
    return { status: 400, body: { error: "Mídias inválidas." } };
  const download = req.download === true && ids.length === 1;
  if (!env.credentials?.client_email || !env.credentials.private_key)
    return {
      status: 500,
      body: { error: "Credenciais do Google Cloud Storage não configuradas." },
    };
  const r = await callRpc<
    {
      id: string;
      bucket: string;
      path: string;
      content_type: string | null;
      name: string | null;
      kind: string;
    }[]
  >(env, deps.fetch, authorization, "whatsapp_media_targets", {
    p_ids: ids,
    p_download: download,
    p_origin: origin,
  });
  if (!r.ok) return { status: r.status, body: { error: r.error } };
  const urls: Record<string, string> = {};
  for (const t of r.data) {
    // Só o bucket das mídias do Whatsapp é assinado.
    if (t.bucket !== env.bucket) continue;
    const type = t.content_type || "application/octet-stream";
    const name = t.name || t.path.split("/").pop() || "arquivo";
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    urls[t.id] = signGcsUrl(env.credentials, t.bucket, t.path, "GET", {
      // A conversa fica aberta por horas; o link acompanha.
      expiresInSeconds: 6 * 3600,
      query: {
        "response-content-type": type,
        "response-content-disposition": download
          ? `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
          : "inline",
      },
    });
  }
  return { status: 200, body: { urls } };
}

export async function handleWhatsapp(
  body: unknown,
  authorization: string | null,
  env: WhatsappEnv,
  deps: WhatsappDeps,
  origin: Row = {},
): Promise<{ status: number; body: Row }> {
  const req = (body ?? {}) as Row;
  try {
    if (req.action === "whatsapp-media") {
      if (!authorization?.startsWith("Bearer "))
        return { status: 401, body: { error: "Entre na sua conta." } };
      return await mediaLinks(req, authorization, env, deps, origin);
    }
    if (req.action === "whatsapp-sync") {
      const token = authorization?.replace(/^Bearer\s+/, "") ?? "";
      if (!env.workerSecret || !token || !sameSecret(token, env.workerSecret))
        return { status: 401, body: { error: "Não autorizado." } };
      if (!env.uazapiUrl || !env.uazapiToken)
        return {
          status: 500,
          body: { error: "UAZAPI_URL e UAZAPI_TOKEN não configurados." },
        };
      return { status: 200, body: await runWhatsappSync(env, deps) };
    }
    return { status: 400, body: { error: "Ação inválida." } };
  } catch (err) {
    const e = err as WhatsappError;
    return { status: e.status || 500, body: { error: e.message } };
  }
}

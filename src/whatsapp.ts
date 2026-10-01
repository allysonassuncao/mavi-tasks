import { supabase } from "./supabase";
import { fetchAllRows, rpc } from "./api";
import { fold } from "./domain";
import { driveServer } from "./drive";
import { pageUrl, routeParts } from "./router";
import { serializeDescription, type RichNode } from "./rich-text";
import type { Snapshot } from "./types";
import type { ViewerFile } from "./FileViewer";

/**
 * Drive › cliente › "Whatsapp": os grupos de WhatsApp dos clientes, trazidos
 * da Uazapi a cada hora (migration 20261027150000_whatsapp_groups,
 * api/_whatsapp.ts). Aqui, a tela de ajuste de Configurações: qual cliente
 * (e quais produtos) cada grupo atende, ou se ele é ignorado.
 */

export interface WhatsappGroup {
  id: string;
  jid: string;
  title: string;
  client_id: string | null;
  product_ids: string[];
  linked_by: "auto" | "manual";
  ignored: boolean;
  last_message_at: string | null;
  synced_until: string | null;
  synced_at: string | null;
  sync_error: string | null;
  message_count: number;
}
export interface WhatsappStatus {
  configured: boolean;
  last_sweep_at: string | null;
  last_sweep_error: string | null;
  sweep_hours: number;
  backfill_days: number;
  groups_pending: number;
  groups_with_error: number;
  messages: number;
  media_pending: number;
  media_lost: number;
  /** Áudios e documentos esperando a leitura para a MAVI, e os já lidos. */
  content_pending?: number;
  content_done?: number;
}

const COLUMNS =
  "id,jid,title,client_id,product_ids,linked_by,ignored,last_message_at,synced_until,synced_at,sync_error,message_count";

export async function listWhatsappGroups(
  company: string,
): Promise<WhatsappGroup[]> {
  if (!supabase) throw Error("Supabase não configurado");
  return fetchAllRows<WhatsappGroup>((count) =>
    supabase!
      .from("whatsapp_groups")
      .select(COLUMNS, count ? { count } : undefined)
      .eq("company_id", company)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id"),
  );
}

export async function whatsappGroup(company: string, id: string) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase
    .from("whatsapp_groups")
    .select(COLUMNS)
    .eq("company_id", company)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as WhatsappGroup | null;
}

export async function whatsappStatus(company: string) {
  return (await rpc("whatsapp_status", {
    p_company: company,
  })) as WhatsappStatus;
}

/** Ligar a um cliente (e produtos), ignorar ou voltar ao automático. */
export async function setWhatsappGroup(
  company: string,
  group: string,
  change:
    | { client: string | null; products: string[]; ignored: boolean }
    | { auto: true },
) {
  await rpc(
    "whatsapp_set_group",
    "auto" in change
      ? { p_company: company, p_group: group, p_auto: true }
      : {
          p_company: company,
          p_group: group,
          p_client: change.client,
          p_products: change.products,
          p_ignored: change.ignored,
          p_auto: false,
        },
  );
}

export type GroupFilter = "linked" | "unlinked" | "ignored";

export function groupFilter(g: WhatsappGroup): GroupFilter {
  if (g.ignored) return "ignored";
  return g.client_id ? "linked" : "unlinked";
}

/**
 * Os grupos de uma aba, pela busca (título, código ou nome do cliente, ou o
 * JID). Na aba "Sem cliente", os com mensagem recente primeiro — são os que
 * vale ligar antes.
 */
export function filterGroups(
  groups: WhatsappGroup[],
  filter: GroupFilter,
  query: string,
  clientName: (id: string) => string,
) {
  const q = fold(query.trim());
  return groups.filter(
    (g) =>
      groupFilter(g) === filter &&
      (!q ||
        fold(g.title).includes(q) ||
        g.jid.includes(q) ||
        (g.client_id && fold(clientName(g.client_id)).includes(q))),
  );
}

/** "Lido há 20 min", "há 3 h", "há 2 dias" (vazio sem data). */
export function ago(value: string | null, now = Date.now()) {
  if (!value) return "";
  const minutes = Math.max(
    0,
    Math.round((now - new Date(value).getTime()) / 60_000),
  );
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "há 1 dia" : `há ${days} dias`;
}

// ------------------------------------------------------------ pasta no Drive
/*
 * Drive › cliente › Whatsapp: as conversas dos grupos do cliente (só
 * leitura), a galeria de mídias e tarefas a partir das mensagens. A leitura
 * é a regra do Drive (RLS); as mídias chegam por links assinados de
 * /api/drive (ação "whatsapp-media").
 */

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
export interface WhatsappMessage {
  id: string;
  group_id: string;
  wa_id: string;
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
  extra: {
    thumb?: string;
    options?: string[];
    lat?: number;
    lng?: number;
    view_once?: boolean;
  };
  media_mime: string | null;
  media_name: string | null;
  media_bytes: number | null;
  media_seconds: number | null;
  media_status: "none" | "pending" | "stored" | "failed" | "lost" | "too_large";
  /** Transcrição do áudio / texto do documento, lidos para a MAVI. */
  content_text: string | null;
  content_status: "none" | "pending" | "done" | "empty" | "skipped" | "error";
}
const MESSAGE_COLUMNS =
  "id,group_id,wa_id,sent_at,sender,sender_phone,sender_name,from_me,kind,body,quoted_wa_id,reaction_to,edited,extra,media_mime,media_name,media_bytes,media_seconds,media_status,content_text,content_status";

function db() {
  if (!supabase) throw Error("Supabase não configurado");
  return supabase;
}

/** Os grupos do cliente (os ignorados não aparecem). */
export async function clientGroups(company: string, client: string) {
  const { data, error } = await db()
    .from("whatsapp_groups")
    .select(COLUMNS)
    .eq("company_id", company)
    .eq("client_id", client)
    .eq("ignored", false)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id");
  if (error) throw error;
  return (data ?? []) as WhatsappGroup[];
}

/** Quantos grupos o cliente tem (o cartão da pasta). */
export async function countClientGroups(company: string, client: string) {
  if (!supabase) return 0;
  const { count, error } = await supabase
    .from("whatsapp_groups")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company)
    .eq("client_id", client)
    .eq("ignored", false);
  if (error) throw error;
  return count ?? 0;
}

/** Um grupo e o cliente dele (links de outras telas). */
export async function whatsappGroupById(id: string) {
  const { data, error } = await db()
    .from("whatsapp_groups")
    .select(`${COLUMNS},company_id`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as (WhatsappGroup & { company_id: string }) | null;
}

export async function whatsappMessageById(id: string) {
  const { data, error } = await db()
    .from("whatsapp_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as WhatsappMessage | null;
}

/** Quantas mensagens a conversa carrega de cada vez. */
export const CHAT_PAGE = 150;
type Cursor = Pick<WhatsappMessage, "sent_at" | "id">;
const iso = (value: string) => new Date(value).toISOString();

/**
 * As mensagens antes de `before` (ou as mais recentes), em ordem de envio.
 * O cursor é (horário, id): mensagens do mesmo milissegundo não se perdem.
 */
export async function messagesBefore(
  company: string,
  group: string,
  before?: Cursor,
  limit = CHAT_PAGE,
) {
  let q = db()
    .from("whatsapp_messages")
    .select(MESSAGE_COLUMNS)
    .eq("company_id", company)
    .eq("group_id", group);
  if (before) {
    const t = iso(before.sent_at);
    q = q.or(`sent_at.lt.${t},and(sent_at.eq.${t},id.lt.${before.id})`);
  }
  const { data, error } = await q
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw error;
  const rows = (data ?? []) as WhatsappMessage[];
  return {
    messages: rows.slice(0, limit).reverse(),
    more: rows.length > limit,
  };
}

/** As mensagens depois de `after` (ou desde um dia, com `from`). */
export async function messagesAfter(
  company: string,
  group: string,
  after: Cursor | { from: string },
  limit = CHAT_PAGE,
) {
  let q = db()
    .from("whatsapp_messages")
    .select(MESSAGE_COLUMNS)
    .eq("company_id", company)
    .eq("group_id", group);
  if ("from" in after) q = q.gte("sent_at", iso(after.from));
  else {
    const t = iso(after.sent_at);
    q = q.or(`sent_at.gt.${t},and(sent_at.eq.${t},id.gt.${after.id})`);
  }
  const { data, error } = await q
    .order("sent_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit + 1);
  if (error) throw error;
  const rows = (data ?? []) as WhatsappMessage[];
  return { messages: rows.slice(0, limit), more: rows.length > limit };
}

/** Busca em todos os grupos do cliente (texto, legenda e nome do arquivo). */
export async function searchClientMessages(
  company: string,
  groups: string[],
  query: string,
  limit = 60,
) {
  if (!groups.length) return [];
  const { data, error } = await db()
    .from("whatsapp_messages")
    .select(MESSAGE_COLUMNS)
    .eq("company_id", company)
    .in("group_id", groups)
    .neq("kind", "reaction")
    .textSearch("search", query, { type: "websearch", config: "portuguese" })
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as WhatsappMessage[];
}

export type MediaTab = "image" | "video" | "audio" | "document" | "link";
export const MEDIA_PAGE = 48;

/** Uma página da galeria do cliente (todos os grupos ou um). */
export async function listMedia(
  company: string,
  groups: string[],
  tab: MediaTab,
  page: number,
  pageSize = MEDIA_PAGE,
) {
  if (!groups.length) return { rows: [] as WhatsappMessage[], total: 0 };
  let q = db()
    .from("whatsapp_messages")
    .select(MESSAGE_COLUMNS, { count: "exact" })
    .eq("company_id", company)
    .in("group_id", groups);
  q =
    tab === "link"
      ? q.eq("kind", "text").filter("body", "imatch", "https?://")
      : q.eq("kind", tab);
  const { data, error, count } = await q
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw error;
  return { rows: (data ?? []) as WhatsappMessage[], total: count ?? 0 };
}

// Links assinados valem 6 h; guardados por 5 h para não pedir de novo.
const urlCache = new Map<string, { url: string; until: number }>();
const URL_TTL = 5 * 3600_000;

/** Links das mídias (em lotes de 100), reaproveitando os já pedidos. */
export async function mediaUrls(ids: string[]) {
  const now = Date.now();
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const hit = urlCache.get(id);
    if (hit && hit.until > now) out[id] = hit.url;
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const { urls } = await driveServer<{ urls: Record<string, string> }>({
      action: "whatsapp-media",
      ids: missing.slice(i, i + 100),
    });
    for (const [id, url] of Object.entries(urls)) {
      urlCache.set(id, { url, until: now + URL_TTL });
      out[id] = url;
    }
  }
  return out;
}

/** Baixar uma mídia (como anexo; entra no histórico do Drive). */
export async function downloadMedia(id: string) {
  const { urls } = await driveServer<{ urls: Record<string, string> }>({
    action: "whatsapp-media",
    ids: [id],
    download: true,
  });
  if (!urls[id]) throw Error("Esta mídia não está disponível.");
  window.location.href = urls[id];
}

/** Link de uma mensagem: abre o Drive já na conversa, na mensagem. */
export function whatsappLink(group: string, message?: string) {
  const company = routeParts(window.location.pathname).company;
  const url = new URL(pageUrl("drive", company), window.location.origin);
  url.searchParams.set("whatsapp", group);
  if (message) url.searchParams.set("msg", message);
  return url.toString();
}

// ------------------------------------------------------------ apresentação
/** O que aparece como balão: reações e o aviso de álbum não. */
export function visibleMessages(list: WhatsappMessage[]) {
  return list.filter((m) => m.kind !== "reaction" && m.kind !== "album");
}

export type Reaction = { emoji: string; names: string[] };
/**
 * As reações de cada mensagem (pelo wa_id): vale a última de cada pessoa; a
 * reação vazia é a pessoa tirando a dela.
 */
export function reactionsOf(list: WhatsappMessage[]) {
  const latest = new Map<string, Map<string, WhatsappMessage>>();
  for (const m of list) {
    if (m.kind !== "reaction" || !m.reaction_to) continue;
    const bySender = latest.get(m.reaction_to) ?? new Map();
    const key = m.from_me ? "__me__" : m.sender || m.sender_name;
    const prev = bySender.get(key);
    if (!prev || prev.sent_at <= m.sent_at) bySender.set(key, m);
    latest.set(m.reaction_to, bySender);
  }
  const out = new Map<string, Reaction[]>();
  for (const [target, bySender] of latest) {
    const byEmoji = new Map<string, string[]>();
    for (const r of bySender.values()) {
      const emoji = r.body.trim();
      if (!emoji) continue;
      byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), senderLabel(r)]);
    }
    if (byEmoji.size)
      out.set(
        target,
        [...byEmoji].map(([emoji, names]) => ({ emoji, names })),
      );
  }
  return out;
}

/** "+55 11 98606-0266" (outros formatos ficam como vieram). */
export function formatPhone(phone: string) {
  const d = phone.replace(/\D/g, "");
  const br = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return br ? `+55 ${br[1]} ${br[2]}-${br[3]}` : d ? `+${d}` : "";
}

export function senderLabel(
  m: Pick<WhatsappMessage, "from_me" | "sender_name" | "sender_phone">,
) {
  if (m.sender_name.trim()) return m.sender_name.trim();
  if (m.from_me) return "Número da agência";
  return formatPhone(m.sender_phone) || "Participante";
}

const SENDER_COLORS = [
  "#3f7d4e",
  "#2d5a8c",
  "#8a4f9e",
  "#b0603a",
  "#1f7a7a",
  "#9c4468",
  "#6b6b1f",
  "#4b5fa8",
];
/** A mesma cor para a mesma pessoa em todas as conversas. */
export function senderColor(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length];
}

const TZ = "America/Sao_Paulo";
const dayKey = (value: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(value));
export { dayKey as whatsappDay };

/** "Hoje", "Ontem" ou "26 de setembro de 2026". */
export function dayLabel(value: string, now = Date.now()) {
  const day = dayKey(value);
  if (day === dayKey(new Date(now).toISOString())) return "Hoje";
  if (day === dayKey(new Date(now - 86400_000).toISOString())) return "Ontem";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

export function timeLabel(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/** "26/09 14:05" (a data curta das listas). */
export function shortDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/** Início de um dia (aaaa-mm-dd) no horário de Brasília. */
export function dayStart(day: string) {
  return new Date(`${day}T00:00:00-03:00`).toISOString();
}

export function bytesLabel(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0).replace(".", ",")} ${units[unit]}`;
}

export function secondsLabel(seconds: number | null) {
  if (!seconds) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type TextPiece = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
  href?: string;
};
const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'"]/gi;
/** Os endereços de um texto. */
export function linksIn(text: string) {
  return [...text.matchAll(URL_RE)].map((m) => m[0]);
}

/**
 * O texto com a formatação do WhatsApp: *negrito*, _itálico_, ~riscado~,
 * ```monoespaçado``` e os links.
 */
export function formatWhatsapp(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  const style =
    /```([\s\S]+?)```|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])|(?<![\w~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\w~])/g;
  const pushLinks = (chunk: string, marks: Omit<TextPiece, "text">) => {
    let last = 0;
    for (const m of chunk.matchAll(URL_RE)) {
      if (m.index! > last)
        out.push({ text: chunk.slice(last, m.index), ...marks });
      out.push({ text: m[0], href: m[0], ...marks });
      last = m.index! + m[0].length;
    }
    if (last < chunk.length) out.push({ text: chunk.slice(last), ...marks });
  };
  let last = 0;
  for (const m of text.matchAll(style)) {
    if (m.index! > last) pushLinks(text.slice(last, m.index), {});
    if (m[1] !== undefined) out.push({ text: m[1], mono: true });
    else if (m[2] !== undefined) pushLinks(m[2], { bold: true });
    else if (m[3] !== undefined) pushLinks(m[3], { italic: true });
    else pushLinks(m[4], { strike: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) pushLinks(text.slice(last), {});
  return out;
}

const KIND_LABELS: Record<WhatsappKind, string> = {
  text: "Mensagem",
  image: "Imagem",
  video: "Vídeo",
  audio: "Áudio",
  document: "Documento",
  sticker: "Figurinha",
  reaction: "Reação",
  album: "Álbum",
  poll: "Enquete",
  location: "Localização",
  contact: "Contato",
  unavailable: "Mensagem não disponível",
  other: "Mensagem",
};
/** O texto sem os símbolos de formatação (*negrito* vira negrito). */
export function plainText(text: string) {
  return formatWhatsapp(text)
    .map((p) => p.text)
    .join("");
}

/** Uma linha que resume a mensagem (citações, busca, tarefas). */
export function messagePreview(m: WhatsappMessage) {
  const text = plainText(m.body.trim());
  if (m.kind === "text" || m.kind === "other") return text;
  if (m.kind === "document")
    return [m.media_name || "Documento", text].filter(Boolean).join(" · ");
  return text ? `${KIND_LABELS[m.kind]}: ${text}` : KIND_LABELS[m.kind];
}

/** O contrato em que a tarefa nasce: um do produto do grupo, se houver. */
export function taskContract(
  data: Snapshot,
  client: string,
  products: string[],
  canCreate: (contract: string) => boolean,
) {
  const open = data.contracts.filter(
    (k) => k.client_id === client && !k.archived && canCreate(k.id),
  );
  return (open.find((k) => products.includes(k.product_id)) ?? open[0])?.id;
}

/** O caminho (dentro do app) que abre a conversa numa mensagem. */
export function whatsappPath(group: string, message?: string) {
  const company = routeParts(window.location.pathname).company;
  const q = new URLSearchParams({ whatsapp: group });
  if (message) q.set("msg", message);
  return `${pageUrl("drive", company)}?${q.toString()}`;
}

/** O rascunho que a MAVI devolve (/api/drive, ação "whatsapp-task-draft"). */
export type TaskDraft = {
  title: string;
  summary: string;
  actions: string[];
  details: string[];
  due: string | null;
};
export async function draftWhatsappTask(messages: string[]) {
  return driveServer<TaskDraft>({ action: "whatsapp-task-draft", messages });
}

const byTime = (a: WhatsappMessage, b: WhatsappMessage) =>
  a.sent_at === b.sent_at
    ? a.id.localeCompare(b.id)
    : a.sent_at < b.sent_at
      ? -1
      : 1;

/** A mensagem em texto para a tarefa: áudio com a transcrição, documento com o nome. */
function taskLine(m: WhatsappMessage) {
  const body = plainText(m.body.trim());
  if (m.kind === "audio") {
    const len = secondsLabel(m.media_seconds);
    const said = m.content_text?.trim();
    return `Áudio${len ? ` (${len})` : ""}${said ? `: “${said}”` : " (sem transcrição)"}`;
  }
  return messagePreview(m) || body || "(sem texto)";
}

const GREETING =
  /^(?:(?:bom dia|boa tarde|boa noite|oi+|ol[aá]|opa|e a[ií]|pessoal|galera|gente|time|tudo bem|tudo certo)[\s,!.?…-]*)+/i;
/**
 * Um título quando a MAVI não responde: a primeira mensagem com conteúdo,
 * sem saudação, sem links e sem formatação, cortada numa palavra.
 */
export function fallbackTitle(messages: WhatsappMessage[]) {
  const sorted = [...messages].sort(byTime);
  for (const m of sorted) {
    const raw = m.kind === "audio" ? (m.content_text ?? "") : plainText(m.body);
    const clean = raw
      .replace(URL_RE, "")
      .replace(/\s+/g, " ")
      .replace(GREETING, "")
      .replace(/^[\s,.;:!?-]+/, "")
      .trim();
    if (clean.length < 8) continue;
    const cut =
      clean.length <= 80
        ? clean
        : `${clean.slice(0, 80).replace(/\s+\S*$/, "")}…`;
    return cut.charAt(0).toUpperCase() + cut.slice(1);
  }
  const first = sorted[0];
  const what = first ? KIND_LABELS[first.kind] : "Mensagem";
  return `Ver ${what.toLowerCase()} de ${first ? senderLabel(first) : "participante"} no grupo`;
}

/**
 * Título e descrição (rich text) da tarefa feita a partir de mensagens. Com o
 * rascunho da MAVI: resumo, o que fazer e detalhes; sempre, as mensagens com
 * o horário como link para a conversa, e o grupo.
 */
export function messagesTask(
  messages: WhatsappMessage[],
  context: { group: string; groupTitle: string; clientName: string },
  draft?: TaskDraft | null,
) {
  const sorted = [...messages].sort(byTime);
  const text = (t: string, ...marks: RichNode["marks"][]): RichNode => ({
    type: "text",
    text: t,
    marks: marks.flat().filter(Boolean) as NonNullable<RichNode["marks"]>,
  });
  const bold = [{ type: "bold" }];
  const link = (href: string) => [{ type: "link", attrs: { href } }];
  const paragraph = (...content: RichNode[]): RichNode => ({
    type: "paragraph",
    content,
  });
  const list = (items: RichNode[][]): RichNode => ({
    type: "bulletList",
    content: items.map((content) => ({
      type: "listItem",
      content: [paragraph(...content)],
    })),
  });
  const section = (title: string, ...body: RichNode[]) => [
    paragraph(text(title, bold)),
    ...body,
  ];
  const people = [...new Set(sorted.map(senderLabel))];
  const first = sorted[0];
  const content: RichNode[] = [];
  if (draft?.summary)
    content.push(...section("Resumo", paragraph(text(draft.summary))));
  else
    content.push(
      paragraph(
        text(
          `Pedido feito no grupo do cliente ${context.clientName} por ${people.join(", ")}, em ${shortDate(first.sent_at)}. Leia as mensagens abaixo e abra a conversa para ver o contexto.`,
        ),
      ),
    );
  if (draft?.actions.length)
    content.push(
      ...section("O que fazer", list(draft.actions.map((a) => [text(a)]))),
    );
  if (draft?.details.length)
    content.push(
      ...section("Detalhes", list(draft.details.map((d) => [text(d)]))),
    );
  content.push(
    ...section(
      sorted.length === 1 ? "Mensagem do grupo" : "Mensagens do grupo",
      paragraph(
        text("Clique no horário para abrir a conversa naquela mensagem.", [
          { type: "italic" },
        ]),
      ),
      list(
        sorted.map((m) => [
          text(shortDate(m.sent_at), link(whatsappPath(context.group, m.id))),
          text(" · "),
          text(`${senderLabel(m)}: `, bold),
          text(taskLine(m).slice(0, 600)),
        ]),
      ),
    ),
    paragraph(
      text("Grupo: ", bold),
      text(`${context.groupTitle} (cliente ${context.clientName}) · `),
      text("abrir a conversa", link(whatsappPath(context.group, first.id))),
    ),
  );
  return {
    title: (draft?.title || fallbackTitle(sorted)).slice(0, 240),
    description: serializeDescription({ type: "doc", content }),
    ...(draft?.due ? { due: draft.due } : {}),
  };
}

// ------------------------------------------------------------ visualizador
const mediaName = (m: WhatsappMessage) => {
  if (m.media_name) return m.media_name;
  const ext = m.media_mime?.split("/")[1]?.split(";")[0] ?? "";
  const label =
    m.kind === "image"
      ? "Imagem"
      : m.kind === "video"
        ? "Vídeo"
        : m.kind === "audio"
          ? "Áudio"
          : m.kind === "sticker"
            ? "Figurinha"
            : "Arquivo";
  return `${label} de ${senderLabel(m)} ${shortDate(m.sent_at).replace(/[/:]/g, "-")}${ext ? `.${ext === "mpeg" ? "mp3" : ext}` : ""}`;
};

/** O arquivo para o visualizador do Drive (link assinado sob demanda). */
export function viewerFile(m: WhatsappMessage): ViewerFile {
  return {
    key: m.id,
    name: mediaName(m),
    contentType: m.media_mime ?? "",
    size: m.media_bytes ?? undefined,
    load: async () => {
      const url = (await mediaUrls([m.id]))[m.id];
      if (!url) throw Error("Esta mídia não está disponível.");
      return url;
    },
    download: () => downloadMedia(m.id),
  };
}

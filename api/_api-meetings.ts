import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { callRpc, signGcsUrl, type DriveEnv } from "./_drive.js";

/**
 * API pública › POST /api/v1/clients/{id}/meetings: uma reunião já feita
 * (gravada fora da MAVI) entra nas Gravações do cliente — migration
 * 20270603090000_api_meetings.
 *
 * - A transcrição chega em texto corrido (com "Nome: fala", tempos ou
 *   WebVTT/SRT), em trechos com tempo ou no JSON do provedor (Deepgram,
 *   AssemblyAI, Whisper, Recall, o formato do gravador da MAVI); aqui vira o
 *   formato das gravações: { speakers, segments: [[início, fim, falante, texto]] }.
 * - O resumo é sempre o de quem envia (as chaves de sempre: overview, notes,
 *   todo, action_items, keywords, tone); a MAVI não gera.
 * - O vídeo vem por link (video_url): o banco guarda na fila e o worker
 *   (ação "meeting-video-import", com o segredo) baixa e envia ao GCS em
 *   partes, sem passar o arquivo inteiro pela memória.
 */

export type Segment = [number | null, number | null, number | null, string];
export type MeetingTranscript = { speakers: string[]; segments: Segment[] };

const MAX_SEGMENTS = 20_000;
const MAX_TEXT = 1_500_000;
/** Um trecho longo (texto corrido sem quebras) vira vários, até este tamanho. */
const PIECE = 1_500;

class InvalidTranscript extends Error {}

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const isObj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Segundos de um número ou de "hh:mm:ss(.mmm)" / "mm:ss". */
export function seconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
  return (
    Number(m[1] ?? 0) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    (m[4] ? Number(m[4].padEnd(3, "0")) / 1000 : 0)
  );
}

const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

function splitLong(text: string): string[] {
  if (text.length <= PIECE) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > PIECE) {
    const window = rest.slice(0, PIECE);
    const cut = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
    );
    const at = cut > PIECE / 3 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : PIECE;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Monta a transcrição: falantes por nome (ou número) e trechos limpos. */
function builder() {
  const speakers: string[] = [];
  const index = new Map<string, number>();
  const segments: Segment[] = [];
  let total = 0;
  const who = (raw: unknown): number | null => {
    if (raw == null || raw === "") return null;
    const label =
      typeof raw === "number" && Number.isInteger(raw)
        ? `Falante ${raw + 1}`
        : /^[A-Z]$/.test(String(raw).trim())
          ? `Falante ${String(raw).trim()}`
          : clean(raw).slice(0, 120);
    if (!label) return null;
    const key = label.toLowerCase();
    if (!index.has(key)) {
      index.set(key, speakers.length);
      speakers.push(label);
    }
    return index.get(key)!;
  };
  const push = (start: number | null, end: number | null, speaker: number | null, text: unknown) => {
    const t = clean(text);
    if (!t) return;
    const pieces = splitLong(t);
    pieces.forEach((p, i) => {
      // Um trecho longo dividido: só o primeiro pedaço leva o início, só o
      // último o fim.
      segments.push([
        i === 0 ? round(start) : null,
        i === pieces.length - 1 ? round(end) : null,
        speaker,
        p,
      ]);
      total += p.length;
    });
    if (segments.length > MAX_SEGMENTS)
      throw new InvalidTranscript(`A transcrição pode ter até ${MAX_SEGMENTS} trechos.`);
    if (total > MAX_TEXT)
      throw new InvalidTranscript("A transcrição pode ter até 1,5 milhão de caracteres.");
  };
  const done = (): MeetingTranscript => {
    // Só o início: o fim é o começo do trecho seguinte.
    segments.forEach((s, i) => {
      if (s[0] != null && s[1] == null) {
        const next = segments.slice(i + 1).find((x) => x[0] != null)?.[0];
        s[1] = next != null && next >= s[0] ? next : s[0];
      }
    });
    if (segments.length && segments.every((s) => s[0] != null))
      segments.sort((a, b) => a[0]! - b[0]!);
    return { speakers, segments };
  };
  return { who, push, done };
}

/** Texto corrido: "Nome: fala", "[00:01:23] Nome: fala", WebVTT ou SRT. */
function fromText(text: string, b: ReturnType<typeof builder>) {
  const CUE =
    /^((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  const STAMP = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s*(?:[-–—|]\s*)?/;
  const SPEAKER = /^([^:]{1,60}?)\s*(?:\(((?:\d{1,2}:)?\d{1,2}:\d{2})\))?\s*:\s+(.+)$/;
  // Um nome: até 4 palavras, cada uma com maiúscula ou número (ou "de", "da"…),
  // ou um e-mail. "Os pontos são: …" não é falante.
  const isName = (s: string) => {
    const words = s.trim().split(/\s+/);
    return (
      /^[^@\s]+@[^@\s]+$/.test(s.trim()) ||
      (words.length <= 4 && words.every((w) => /^[\p{Lu}\d]/u.test(w) || /^(de|da|do|das|dos|e)$/.test(w)))
    );
  };
  let cue: [number | null, number | null] | null = null;
  let cueId = 0;
  let last: {
    speaker: number | null;
    text: string;
    start: number | null;
    end: number | null;
    cue: number | null;
  } | null = null;
  const flush = () => {
    if (last) b.push(last.start, last.end, last.speaker, last.text);
    last = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) {
      if (cue) cue = null;
      continue;
    }
    if (/^WEBVTT\b/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) continue;
    const c = line.match(CUE);
    if (c) {
      flush();
      cue = [seconds(c[1]), seconds(c[2])];
      cueId++;
      continue;
    }
    // O número da legenda (SRT/VTT) antes do tempo.
    if (/^\d+$/.test(line)) continue;
    let start: number | null = cue?.[0] ?? null;
    let end: number | null = cue?.[1] ?? null;
    let stamped = false;
    const s = !cue && line.match(STAMP);
    if (s && s[0].length < line.length) {
      start = seconds(s[1]);
      stamped = true;
      line = line.slice(s[0].length);
    }
    let speaker: number | null | undefined;
    const voice = line.match(/^<v(?:\.[^\s>]+)*\s+([^>]+)>(.*?)(?:<\/v>)?$/);
    if (voice) {
      speaker = b.who(voice[1]);
      line = voice[2];
    } else {
      const sp = line.match(SPEAKER);
      if (sp && !/https?$/i.test(sp[1]) && isName(sp[1])) {
        speaker = b.who(sp[1]);
        if (sp[2] != null && start == null) {
          start = seconds(sp[2]);
          stamped = true;
        }
        line = sp[3];
      }
    }
    line = line.replace(/<[^>]+>/g, "");
    // Continuação da fala anterior (mesma legenda, ou linha sem falante nem tempo).
    if (
      last &&
      speaker === undefined &&
      !stamped &&
      (cue ? last.cue === cueId : last.cue == null && last.speaker != null)
    ) {
      last.text += " " + line;
      continue;
    }
    flush();
    last = { speaker: speaker ?? null, text: line, start, end, cue: cue ? cueId : null };
  }
  flush();
}

/** Um item de lista: { start, end, speaker, text } e as variações dos provedores. */
function fromItems(items: unknown[], b: ReturnType<typeof builder>, scale = 1) {
  const at = (v: unknown) => {
    const s = seconds(v);
    return s == null ? null : s / scale;
  };
  for (const item of items) {
    if (Array.isArray(item)) {
      // O próprio formato das gravações: [início, fim, falante, texto].
      if (item.length === 4 && typeof item[3] === "string")
        b.push(at(item[0]), at(item[1]), typeof item[2] === "number" ? item[2] : null, item[3]);
      continue;
    }
    if (typeof item === "string") {
      b.push(null, null, null, item);
      continue;
    }
    if (!isObj(item)) continue;
    // Deepgram (parágrafos): { speaker, sentences: [{ text, start, end }] }.
    if (Array.isArray(item.sentences)) {
      const s = b.who(item.speaker_name ?? item.speaker);
      for (const x of item.sentences) if (isObj(x)) b.push(at(x.start), at(x.end), s, x.text);
      continue;
    }
    // O gravador da MAVI (Deepgram por falante): { speaker, utterances: [...] }.
    if (Array.isArray(item.utterances)) {
      const s = b.who(item.speaker_name ?? (Number.isInteger(item.speaker) ? item.speaker : 0));
      if (!item.utterances.length) b.push(at(item.start), at(item.end), s, item.transcript ?? item.text);
      for (const u of item.utterances)
        if (isObj(u)) b.push(at(u.start), at(u.end), s, u.transcript ?? u.text);
      continue;
    }
    const text = item.text ?? item.transcript ?? item.content ?? item.sentence;
    // Recall: { speaker: "Nome", words: [{ start, end, word }] } em frases.
    if (Array.isArray(item.words) && typeof text !== "string") {
      const s = b.who(item.speaker_name ?? item.speaker ?? item.participant?.name);
      let words: { start: number | null; end: number | null; word: string }[] = [];
      const flush = () => {
        if (words.length)
          b.push(words[0].start, words[words.length - 1].end, s, words.map((w) => w.word).join(" "));
        words = [];
      };
      for (const w of item.words) {
        if (!isObj(w)) continue;
        const word = { start: at(w.start ?? w.start_timestamp?.relative), end: at(w.end ?? w.end_timestamp?.relative), word: String(w.word ?? w.text ?? "").trim() };
        const prev = words[words.length - 1];
        if (prev && word.start != null && prev.end != null && word.start - prev.end > 1.5) flush();
        words.push(word);
        if ((/[.?!…]["”)]?$/.test(word.word) && words.length >= 4) || words.length >= 45) flush();
      }
      flush();
      continue;
    }
    if (typeof text === "string") {
      b.push(
        at(item.start ?? item.start_time ?? item.start_seconds ?? item.timestamp),
        at(item.end ?? item.end_time ?? item.end_seconds),
        b.who(item.speaker_name ?? item.speaker ?? item.name ?? item.participant),
        text,
      );
      continue;
    }
    // Sem tempo: { "Nome": "fala" }.
    for (const [name, value] of Object.entries(item))
      if (typeof value === "string") b.push(null, null, b.who(name === "undefined" ? "Falante 1" : name), value);
  }
}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * A transcrição em qualquer um dos formatos aceitos, no formato das
 * gravações. Lança InvalidTranscript quando passa dos limites.
 */
export function normalizeMeetingTranscript(raw: unknown): MeetingTranscript {
  const b = builder();
  const read = (v: unknown, depth = 0): void => {
    if (v == null || depth > 4) return;
    if (typeof v === "string") {
      const json = parseJson(v);
      if (json !== undefined) return read(json, depth + 1);
      return fromText(v, b);
    }
    if (Array.isArray(v)) return fromItems(v, b);
    if (!isObj(v)) return;
    // O nosso formato ({ speakers, segments: [[…]] }) ou trechos do Whisper.
    if (Array.isArray(v.segments)) {
      const named: unknown[] = Array.isArray(v.speakers) ? v.speakers : [];
      return fromItems(
        v.segments.map((s: unknown) =>
          Array.isArray(s) && s.length === 4
            ? { start: s[0], end: s[1], text: s[3], speaker: typeof s[2] === "number" ? (named[s[2]] ?? s[2]) : null }
            : s,
        ),
        b,
      );
    }
    // Deepgram (a resposta da API).
    if (isObj(v.results)) {
      if (Array.isArray(v.results.utterances) && v.results.utterances.length)
        return fromItems(v.results.utterances, b);
      const alt = v.results.channels?.[0]?.alternatives?.[0];
      if (Array.isArray(alt?.paragraphs?.paragraphs)) return fromItems(alt.paragraphs.paragraphs, b);
      if (typeof alt?.transcript === "string") return fromText(alt.transcript, b);
      return;
    }
    // AssemblyAI: utterances com "text" e tempos em milissegundos.
    if (Array.isArray(v.utterances) && v.utterances.length) {
      const ms = v.utterances.some((u: unknown) => isObj(u) && typeof u.text === "string" && u.transcript == null);
      return fromItems(v.utterances, b, ms ? 1000 : 1);
    }
    if (Array.isArray(v.transcript) || isObj(v.transcript)) return read(v.transcript, depth + 1);
    if (typeof v.transcript === "string") return read(v.transcript, depth + 1);
    if (typeof v.text === "string") return fromText(v.text, b);
    fromItems([v], b);
  };
  read(raw);
  return b.done();
}

type SummaryItem = { title?: string; owner?: string; description: string; deadline?: string };

/** O resumo de quem envia, com as chaves que as Gravações mostram. */
export function normalizeMeetingSummary(raw: unknown): Record<string, unknown> {
  let s: unknown = raw;
  if (typeof s === "string") s = parseJson(s) ?? (s.trim() ? { overview: s.trim() } : {});
  if (!isObj(s)) return {};
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const text = (v: unknown) => String(v ?? "").trim();
  const items = (v: unknown, owner: boolean): SummaryItem[] =>
    list(v)
      .map((t): SummaryItem | null => {
        if (typeof t === "string") return t.trim() ? { ...(owner ? { owner: "" } : { title: "" }), description: t.trim() } : null;
        if (!isObj(t)) return null;
        const description = text(t.description ?? t.text ?? t.task ?? t.content);
        const title = clean(t.title ?? t.topic);
        if (!description && !(title && !owner)) return null;
        return owner
          ? { owner: clean(t.owner ?? t.assignee ?? t.responsible), description, ...(t.deadline || t.due ? { deadline: clean(t.deadline ?? t.due) } : {}) }
          : { title, description };
      })
      .filter((x): x is SummaryItem => !!x);
  const out: Record<string, unknown> = {};
  if (clean(s.title)) out.title = clean(s.title).slice(0, 300);
  const overview = text(s.overview ?? s.summary ?? s.resumo);
  if (overview) out.overview = overview;
  const notes = items(s.notes ?? s.topics, false);
  if (notes.length) out.notes = notes;
  const todo = items(s.todo ?? s["to-do"], true);
  if (todo.length) out.todo = todo;
  const actions = items(s.action_items ?? s.next_steps, true).map((a) => ({ deadline: "", ...a }));
  if (actions.length) out.action_items = actions;
  const words = (v: unknown) => list(v).filter((k) => typeof k === "string" && clean(k)).map(clean);
  if (words(s.keywords).length) out.keywords = words(s.keywords);
  if (words(s.tone).length) out.tone = words(s.tone);
  return out;
}

// ------------------------------------------------------------ links externos

/** Endereços que o servidor nunca acessa (rede interna, metadados da nuvem…). */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]);
    return (
      x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) ||
      x.startsWith("ff") || x.startsWith("64:ff9b:") || x.startsWith("::ffff:")
    );
  }
  return true;
}

/** Só https, na porta padrão, para um nome (ou IP) público. */
export function videoUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "video_url inválido.";
  }
  if (u.protocol !== "https:") return "video_url deve começar com https://.";
  if (u.port && u.port !== "443") return "video_url deve usar a porta padrão do https.";
  if (u.username || u.password) return "video_url não pode ter usuário e senha.";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host) || (isIP(host) && privateAddress(host)))
    return "video_url deve ser um endereço público.";
  return null;
}

// ------------------------------------------------------------ o corpo

export type MeetingPayload = {
  external_id: string | null;
  title: string;
  recorded_at: unknown;
  duration_seconds: number | null;
  recorded_by_email: string;
  attendees: string[];
  meet_link: string | null;
  video_url: string | null;
  summary: Record<string, unknown>;
  transcript: MeetingTranscript;
};

/** Confere e normaliza o corpo do POST; o banco confere de novo os limites. */
export function meetingPayload(
  body: Record<string, unknown>,
): { ok: true; payload: MeetingPayload } | { ok: false; error: string } {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const external =
    typeof body.external_id === "number" ? String(body.external_id) : str(body.external_id);
  if (body.attendees != null && !Array.isArray(body.attendees))
    return { ok: false, error: "attendees deve ser uma lista." };
  const attendees = ((body.attendees as unknown[]) ?? [])
    .map((a) => (isObj(a) ? str(a.email) || str(a.name) : str(a)))
    .filter(Boolean);
  const video = str(body.video_url) || null;
  if (video) {
    const problem = videoUrlProblem(video);
    if (problem) return { ok: false, error: problem };
  }
  if (body.summary != null && typeof body.summary !== "string" && !isObj(body.summary))
    return { ok: false, error: "summary deve ser um objeto ou um texto." };
  let transcript: MeetingTranscript;
  try {
    transcript = normalizeMeetingTranscript(body.transcript);
  } catch (e) {
    if (e instanceof InvalidTranscript) return { ok: false, error: e.message };
    throw e;
  }
  if (body.transcript != null && body.transcript !== "" && !transcript.segments.length)
    return { ok: false, error: "Não foi possível ler a transcrição: veja os formatos aceitos na documentação." };
  let duration: number | null = null;
  if (body.duration_seconds != null) {
    if (typeof body.duration_seconds !== "number")
      return { ok: false, error: "duration_seconds deve ser um número." };
    duration = body.duration_seconds;
  } else {
    // Sem a duração: o fim do último trecho com tempo.
    const ends = transcript.segments.map((s) => s[1] ?? s[0]).filter((x): x is number => x != null);
    if (ends.length) duration = Math.round(Math.max(...ends));
  }
  return {
    ok: true,
    payload: {
      external_id: external || null,
      title: str(body.title),
      recorded_at: body.recorded_at,
      duration_seconds: duration,
      recorded_by_email: str(body.recorded_by_email),
      attendees,
      meet_link: str(body.meet_link) || null,
      video_url: video,
      summary: normalizeMeetingSummary(body.summary),
      transcript,
    },
  };
}

// ------------------------------------------------------------ o vídeo

export type MeetingVideoEnv = DriveEnv & {
  workerSecret: string;
  maxBytes: number;
  /** Quanto tempo uma rodada do worker trabalha (a função tem 300 s). */
  budgetMs: number;
};
type Fetch = typeof fetch;
export type MeetingVideoDeps = {
  fetch: Fetch;
  lookup?: (host: string) => Promise<string[]>;
  now?: () => number;
};
type Job = { recording_id: string; company_id: string; url: string; attempts: number };

/** Partes do envio ao GCS (múltiplo de 256 KiB). */
export const CHUNK = 16 * 1024 * 1024;

export function meetingVideoEnv(
  base: DriveEnv,
  env: Record<string, string | undefined> = process.env,
): MeetingVideoEnv {
  return {
    ...base,
    workerSecret: env.AI_WORKER_SECRET?.trim() || "",
    maxBytes: Number(env.MEETING_VIDEO_MAX_BYTES) || 2 * 1024 * 1024 * 1024,
    budgetMs: Number(env.MEETING_VIDEO_BUDGET_MS) || 270_000,
  };
}

export function meetingVideoAllowed(authorization: string | null, env: MeetingVideoEnv) {
  const given = Buffer.from(authorization?.replace(/^Bearer\s+/i, "").trim() ?? "");
  const expected = Buffer.from(env.workerSecret);
  return !!env.workerSecret && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".weba",
};
const BY_EXTENSION = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]),
);

/** Falha que não adianta tentar de novo (link errado, arquivo grande demais…). */
class Final extends Error {}

/** O tipo do arquivo: o do servidor ou, se genérico, o da extensão do link. */
export function videoType(header: string | null, url: string): string | null {
  const base = (header ?? "").split(";")[0].trim().toLowerCase();
  if (/^(video|audio)\//.test(base)) return base;
  if (!base || base === "application/octet-stream" || base === "binary/octet-stream") {
    const ext = new URL(url).pathname.toLowerCase().match(/\.[a-z0-9]{2,5}$/)?.[0];
    return (ext && BY_EXTENSION[ext]) || null;
  }
  return null;
}

/** Segue até 5 redirecionamentos, conferindo cada endereço. */
async function fetchPublic(url: string, deps: MeetingVideoDeps, signal: AbortSignal) {
  const lookup =
    deps.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address));
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const problem = videoUrlProblem(current);
    if (problem) throw new Final(problem);
    const host = new URL(current).hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : await lookup(host);
    if (!addresses.length || addresses.some(privateAddress))
      throw new Final("O link do vídeo aponta para um endereço que não é público.");
    const res = await deps.fetch(current, { redirect: "manual", signal });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    return { res, url: current };
  }
  throw new Final("O link do vídeo redireciona vezes demais.");
}

/** Baixa o vídeo e envia ao GCS em partes (envio retomável). */
export async function importMeetingVideo(
  job: Job,
  env: MeetingVideoEnv,
  deps: MeetingVideoDeps,
  signal: AbortSignal,
): Promise<{ bucket: string; path: string; type: string; bytes: number }> {
  const creds = env.credentials!;
  const { res, url } = await fetchPublic(job.url, deps, signal);
  if (!res.ok) {
    await res.body?.cancel();
    const message = `O link do vídeo respondeu ${res.status}.`;
    throw res.status >= 500 || res.status === 429 ? new Error(message) : new Final(message);
  }
  const type = videoType(res.headers.get("content-type"), url);
  if (!type) {
    await res.body?.cancel();
    throw new Final(
      `O link não devolveu um vídeo ou áudio (${res.headers.get("content-type") || "sem tipo"}). Use um link direto para o arquivo.`,
    );
  }
  const declared = Number(res.headers.get("content-length"));
  const tooBig = `O vídeo passa de ${Math.round(env.maxBytes / 1024 / 1024)} MB.`;
  if (declared > env.maxBytes) {
    await res.body?.cancel();
    throw new Final(tooBig);
  }
  if (!res.body) throw new Error("O link do vídeo não devolveu conteúdo.");
  const path = `meetings/${job.company_id}/${job.recording_id}${EXTENSIONS[type] ?? ""}`;
  const start = await deps.fetch(
    signGcsUrl(creds, env.bucket, path, "POST", {
      contentType: type,
      headers: { "x-goog-resumable": "start" },
    }),
    { method: "POST", headers: { "Content-Type": type, "x-goog-resumable": "start" }, signal },
  );
  const session = start.headers.get("location");
  if (!start.ok || !session) throw new Error(`O GCS recusou o envio (${start.status}).`);

  const put = async (data: Uint8Array, offset: number, total: number | null) => {
    const range = data.byteLength
      ? `bytes ${offset}-${offset + data.byteLength - 1}/${total ?? "*"}`
      : `bytes */${total}`;
    const r = await deps.fetch(session, {
      method: "PUT",
      headers: { "Content-Range": range },
      body: data,
      redirect: "manual",
      signal,
    });
    await r.body?.cancel();
    const expected = total == null ? r.status === 308 : r.status === 200 || r.status === 201;
    if (!expected) throw new Error(`O GCS recusou uma parte do vídeo (${r.status}).`);
  };
  const reader = res.body.getReader();
  const buf = new Uint8Array(CHUNK);
  let fill = 0;
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let rest = value;
      while (rest.byteLength) {
        const n = Math.min(rest.byteLength, CHUNK - fill);
        buf.set(rest.subarray(0, n), fill);
        fill += n;
        rest = rest.subarray(n);
        if (fill === CHUNK) {
          if (offset + fill > env.maxBytes) throw new Final(tooBig);
          await put(buf, offset, null);
          offset += fill;
          fill = 0;
        }
      }
    }
    const total = offset + fill;
    if (total > env.maxBytes) throw new Final(tooBig);
    if (!total) throw new Final("O link do vídeo devolveu um arquivo vazio.");
    await put(buf.subarray(0, fill), offset, total);
    return { bucket: env.bucket, path, type, bytes: total };
  } catch (e) {
    await reader.cancel().catch(() => {});
    // O envio pela metade não fica no GCS.
    await deps.fetch(session, { method: "DELETE" }).catch(() => null);
    throw e;
  }
}

/**
 * O worker: pega os vídeos da fila e importa um por vez até acabar o tempo
 * desta rodada. Responde quantos importou e quantos falharam.
 */
export async function handleMeetingVideoImport(
  env: MeetingVideoEnv,
  deps: MeetingVideoDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!env.credentials?.client_email || !env.credentials.private_key)
    return { status: 500, body: { error: "Credenciais do Google Cloud Storage não configuradas." } };
  const now = deps.now ?? Date.now;
  const deadline = now() + env.budgetMs;
  const worker = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  let stored = 0;
  let failed = 0;
  // Um vídeo grande precisa de tempo: só começa outro com pelo menos 1 minuto.
  while (now() < deadline - 60_000) {
    const [job] = await worker<Job[]>("meeting_video_claim", { p_limit: 1 });
    if (!job) break;
    try {
      const v = await importMeetingVideo(job, env, deps, AbortSignal.timeout(Math.max(deadline - now(), 1_000)));
      await worker("meeting_video_save", {
        p_recording: job.recording_id,
        p_bucket: v.bucket,
        p_path: v.path,
        p_type: v.type,
        p_bytes: v.bytes,
        p_error: null,
        p_retry: false,
      });
      stored++;
    } catch (e) {
      failed++;
      const err = e as Error;
      await worker("meeting_video_save", {
        p_recording: job.recording_id,
        p_bucket: null,
        p_path: null,
        p_type: null,
        p_bytes: null,
        p_error: err.name === "TimeoutError" ? "O download não terminou a tempo." : err.message,
        p_retry: !(e instanceof Final),
      });
    }
  }
  return { status: 200, body: { stored, failed } };
}

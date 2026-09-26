import { supabase } from "./supabase";
import { fetchAllRows, rpc } from "./api";
import { driveServer } from "./drive";
import { routeParts, pageUrl } from "./router";

/**
 * Drive › cliente › "Gravações da MAVI": reuniões gravadas e transcritas
 * pelo gravador (migration 20261018090000_meeting_recordings). A leitura
 * segue a regra do Drive (RLS); o vídeo e a IA passam por /api/drive.
 */

export interface MeetingSummary {
  title?: string;
  overview?: string;
  notes?: { title: string; description: string }[];
  todo?: { owner: string; description: string }[];
  action_items?: { owner: string; description: string; deadline?: string }[];
  keywords?: string[];
  tone?: string[];
}
export interface MeetingRecording {
  id: string;
  client_id: string;
  title: string;
  recorded_at: string;
  duration_seconds: number | null;
  recorded_by_email: string;
  attendees: string[];
  speakers: string[];
  meet_link: string | null;
  video_type: string | null;
  video_bytes: number | null;
  summary: MeetingSummary;
}
/** [início s, fim s, falante, texto]; início/fim null sem tempo. */
export type MeetingSegment = [
  number | null,
  number | null,
  number | null,
  string,
];
export interface MeetingTranscript {
  speakers: string[];
  segments: MeetingSegment[];
  timed: boolean;
}
export interface MeetingComment {
  id: string;
  recording_id: string;
  at_seconds: number;
  body: string;
  author_id: string;
  created_at: string;
}
export interface MeetingHit {
  recording_id: string;
  recorded_at: string;
  start_seconds: number | null;
  speaker: number | null;
  text: string;
}
export type ChatTurn = { role: "user" | "assistant"; content: string };

// Sem video_path: o caminho nunca sai do banco.
const COLUMNS =
  "id,client_id,title,recorded_at,duration_seconds,recorded_by_email,attendees,speakers,meet_link,video_type,video_bytes,summary";

export async function listMeetingRecordings(
  company: string,
  client: string,
): Promise<MeetingRecording[]> {
  if (!supabase) throw Error("Supabase não configurado");
  return fetchAllRows<MeetingRecording>((count) =>
    supabase!
      .from("meeting_recordings")
      .select(COLUMNS, count ? { count } : undefined)
      .eq("company_id", company)
      .eq("client_id", client)
      .order("recorded_at", { ascending: false })
      .order("id"),
  );
}

/** Quantas gravações o cliente tem (o cartão da pasta). */
export async function countMeetingRecordings(company: string, client: string) {
  if (!supabase) return 0;
  const { count, error } = await supabase
    .from("meeting_recordings")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company)
    .eq("client_id", client);
  if (error) throw error;
  return count ?? 0;
}

export async function meetingRecording(id: string) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase
    .from("meeting_recordings")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as MeetingRecording | null;
}

export async function meetingTranscript(id: string) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase
    .from("meeting_transcripts")
    .select("speakers,segments,timed")
    .eq("recording_id", id)
    .maybeSingle();
  if (error) throw error;
  return data as MeetingTranscript | null;
}

export async function meetingComments(id: string) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase
    .from("meeting_comments")
    .select("id,recording_id,at_seconds,body,author_id,created_at")
    .eq("recording_id", id)
    .order("at_seconds")
    .order("created_at");
  if (error) throw error;
  return (data ?? []).map((c) => ({
    ...c,
    at_seconds: Number(c.at_seconds),
  })) as MeetingComment[];
}

export function addMeetingComment(recording: string, at: number, body: string) {
  return rpc("add_meeting_comment", {
    p_recording: recording,
    p_at: at,
    p_body: body,
  });
}
export function deleteMeetingComment(id: string) {
  return rpc("delete_meeting_comment", { p_comment: id });
}

export async function searchMeetingSegments(
  company: string,
  client: string,
  query: string,
) {
  const rows = (await rpc("search_meeting_segments", {
    p_company: company,
    p_client: client,
    p_query: query,
    p_limit: 80,
  })) as MeetingHit[] | null;
  return (rows ?? []).map((r) => ({
    ...r,
    start_seconds: r.start_seconds == null ? null : Number(r.start_seconds),
  }));
}

export async function meetingVideoUrl(recording: string) {
  const { url } = await driveServer<{ url: string }>({
    action: "meeting-video",
    recording,
  });
  return url;
}
export async function askMeeting(
  recording: string,
  question: string,
  history: ChatTurn[],
) {
  const { answer } = await driveServer<{ answer: string }>({
    action: "meeting-ask",
    recording,
    question,
    history,
  });
  return answer;
}
export async function askClientMeetings(
  client: string,
  question: string,
  history: ChatTurn[],
) {
  return driveServer<{ answer: string; refs: string[] }>({
    action: "meeting-ask-client",
    client,
    question,
    history,
  });
}

// ------------------------------------------------------------ apresentação
/** 75 → "01:15"; 3725 → "1:02:05". */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
/** "12:34" / "1:02:05" → segundos. */
export function parseClock(text: string) {
  const parts = text.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
export function durationLabel(seconds: number | null) {
  if (!seconds) return "";
  const m = Math.round(seconds / 60);
  return m < 60
    ? `${m} min`
    : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** Tipo da reunião pelo título da agenda ("R2 4282", "RP 5027", "Alinhamento…"). */
export function meetingKind(title: string) {
  const t = title ?? "";
  const r = t.match(/\bR\s?([1-4])\b/i);
  if (r) return `R${r[1]}`;
  if (/\bRP\b/i.test(t)) return "RP";
  if (/onboard/i.test(t)) return "Onboarding";
  if (/alinhamento/i.test(t)) return "Alinhamento";
  if (/follow/i.test(t)) return "Follow-up";
  if (/review|revis[ãa]o|resultado/i.test(t)) return "Revisão";
  return "Outras";
}

export const meetingTitle = (r: Pick<MeetingRecording, "summary" | "title">) =>
  r.summary?.title || r.title || "Reunião sem título";

/** Próximos passos do resumo (tarefas e ações com prazo). */
export function nextSteps(s: MeetingSummary) {
  return [
    ...(s.action_items ?? []).map((a) => ({
      ...a,
      deadline: a.deadline ?? "",
    })),
    ...(s.todo ?? []).map((t) => ({ ...t, deadline: "" })),
  ].filter((t) => t.description);
}

/** "Até 25/07/2025" → "2025-07-25", só se ainda não passou. */
export function deadlineDate(deadline: string, today = new Date()) {
  const m = deadline.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return "";
  const year = m[3]
    ? m[3].length === 2
      ? 2000 + Number(m[3])
      : Number(m[3])
    : today.getFullYear();
  const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
  if (d.getMonth() !== Number(m[2]) - 1) return "";
  const key = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return key(d) >= key(today) ? key(d) : "";
}

/** O link que abre a gravação no Drive, num momento. */
export function recordingLink(recording: string, seconds?: number) {
  const company = routeParts(window.location.pathname).company;
  const url = new URL(pageUrl("drive", company), window.location.origin);
  url.searchParams.set("gravacao", recording);
  if (seconds && seconds > 0)
    url.searchParams.set("t", String(Math.floor(seconds)));
  return url.toString();
}

export type AnswerPiece =
  | { kind: "text"; text: string; bold?: boolean }
  | { kind: "time"; seconds: number; label: string }
  | { kind: "ref"; index: number; label: string };
/**
 * Uma linha da resposta da IA em pedaços: texto, **negrito**, momentos
 * [12:34] e reuniões [R3] (clicáveis).
 */
export function answerPieces(line: string): AnswerPiece[] {
  const pieces: AnswerPiece[] = [];
  const re = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]|\[R(\d{1,3})\]|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last)
      pieces.push({ kind: "text", text: line.slice(last, m.index) });
    if (m[1]) {
      const seconds = parseClock(m[1]);
      pieces.push(
        seconds == null
          ? { kind: "text", text: m[0] }
          : { kind: "time", seconds, label: m[1] },
      );
    } else if (m[2])
      pieces.push({ kind: "ref", index: Number(m[2]), label: `R${m[2]}` });
    else pieces.push({ kind: "text", text: m[3], bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) pieces.push({ kind: "text", text: line.slice(last) });
  return pieces;
}

/** Índice do trecho que está tocando (busca binária pelo início). */
export function segmentAt(segments: MeetingSegment[], time: number) {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = segments[mid][0];
    if (start == null) return -1;
    if (start <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

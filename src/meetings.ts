import { supabase } from "./supabase";
import { fetchAllRows, rpc } from "./api";
import { driveServer } from "./drive";
import { routeParts, pageUrl } from "./router";
import { serializeDescription, type RichNode } from "./rich-text";
import { streamAnswer, type AiStreamHandlers } from "./ai";

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

// ------------------------------------------------------------ agenda
/**
 * What identifies a call link in meet_link, however it was written: the
 * Google Meet code ("abc-defg-hij", with or without https, ?authuser…) or,
 * for other services, the host and path. An ilike pattern.
 */
export function meetLinkPattern(link: string): string | null {
  const text = link.trim().toLowerCase();
  const code = text.match(
    /meet\.google\.com\/(?:lookup\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\b/,
  )?.[1];
  if (code) return `%meet.google.com/${code}%`;
  try {
    const url = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
    const path = `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
    if (!url.hostname.includes(".")) return null;
    return `%${path.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  } catch {
    return null;
  }
}

/**
 * When the recording of an event may have started: from 30 minutes before
 * it to 30 minutes after it ends (the MAVI joins late or the call runs
 * over). Recurring meetings share the link; the time tells them apart.
 */
export function eventRecordingWindow(start: string, end: string) {
  const margin = 30 * 60_000;
  const from = new Date(start).getTime() - margin;
  const to = Math.max(new Date(end).getTime(), from + margin) + margin;
  return { from: new Date(from), to: new Date(to) };
}

export type EventRecording = Pick<
  MeetingRecording,
  "id" | "client_id" | "title" | "recorded_at"
>;
/**
 * The recordings of a calendar event the person can open (the Drive rule,
 * by RLS): same call link, recorded during it. Usually one; two when the
 * MAVI was invited twice.
 */
export async function eventRecordings(
  company: string,
  link: string,
  start: string,
  end: string,
): Promise<EventRecording[]> {
  const pattern = meetLinkPattern(link);
  if (!supabase || !company || !pattern) return [];
  const { from, to } = eventRecordingWindow(start, end);
  // Nothing recorded yet: the meeting hasn't started.
  if (from.getTime() > Date.now()) return [];
  const { data, error } = await supabase
    .from("meeting_recordings")
    .select("id,client_id,title,recorded_at")
    .eq("company_id", company)
    .gte("recorded_at", from.toISOString())
    .lte("recorded_at", to.toISOString())
    .ilike("meet_link", pattern)
    .order("recorded_at")
    .limit(5);
  if (error) throw error;
  return (data ?? []) as EventRecording[];
}

export async function meetingVideoUrl(recording: string) {
  const { url } = await driveServer<{ url: string }>({
    action: "meeting-video",
    recording,
  });
  return url;
}
// ------------------------------------------------------------ link público
/**
 * O link público de uma gravação (migration 20270104090000): um por
 * gravação, com o que mostra, download, validade e senha opcional.
 */
export interface MeetingShare {
  token: string;
  show_video: boolean;
  show_transcript: boolean;
  show_summary: boolean;
  allow_download: boolean;
  expires_at: string | null;
  expired: boolean;
  has_password: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  opens: number;
  downloads: number;
  last_opened_at: string | null;
  /** Quem criou o link ou um líder. */
  can_manage: boolean;
}
export type MeetingShareInput = {
  video: boolean;
  transcript: boolean;
  summary: boolean;
  download: boolean;
  expiresAt: string | null;
  /** undefined mantém a senha atual; "" tira a senha. */
  password?: string;
};

export async function meetingShare(recording: string) {
  return (await rpc("meeting_share", {
    p_recording: recording,
  })) as MeetingShare | null;
}
export async function saveMeetingShare(
  recording: string,
  input: MeetingShareInput,
) {
  return (await rpc("set_meeting_share", {
    p_recording: recording,
    p_video: input.video,
    p_transcript: input.transcript,
    p_summary: input.summary,
    p_download: input.download,
    p_expires_at: input.expiresAt,
    p_password: input.password ?? null,
    p_keep_password: input.password === undefined,
  })) as MeetingShare;
}
export async function deleteMeetingShare(recording: string) {
  await rpc("delete_meeting_share", { p_recording: recording });
}
/** As gravações do cliente com link público (e até quando valem). */
export async function sharedRecordings(company: string, client: string) {
  const rows = (await rpc("meeting_shared_recordings", {
    p_company: company,
    p_client: client,
  })) as { recording_id: string; expires_at: string | null }[] | null;
  return new Map((rows ?? []).map((r) => [r.recording_id, r.expires_at]));
}
/**
 * Levar gravações para outro cliente (migration
 * 20270312090000_meeting_move_client): o que muda, conferido pelo banco.
 */
export interface MeetingMovePreview {
  recordings: number;
  from_clients: string[];
  to: { client_id: string; label: string };
  /** Com link público ativo (continua abrindo). */
  shared: number;
  /** Ocorrências no Radar do cliente antigo (saem e a leitura é refeita). */
  radar_mentions: number;
  /** Já lidas pelo Termômetro (a leitura é refeita). */
  temperature: number;
}
export function previewMeetingMove(
  company: string,
  recordings: string[],
  client: string,
): Promise<MeetingMovePreview> {
  return rpc("meeting_move_preview", {
    p_company: company,
    p_recordings: recordings,
    p_client: client,
  });
}
export function moveMeetingRecordings(
  company: string,
  recordings: string[],
  client: string,
): Promise<MeetingMovePreview> {
  return rpc("move_meeting_recordings", {
    p_company: company,
    p_recordings: recordings,
    p_client: client,
  });
}
export function publicRecordingUrl(token: string, seconds?: number) {
  const url = new URL(`/gravacao/${token}`, window.location.origin);
  if (seconds && seconds > 0)
    url.searchParams.set("t", String(Math.floor(seconds)));
  return url.toString();
}

/** O que a página pública recebe (só o que o link mostra). */
export type PublicMeeting =
  | { status: "expired" | "password" | "wrong" | "locked" }
  | {
      status: "ok";
      company: string;
      title: string;
      recorded_at: string;
      duration_seconds: number | null;
      speakers: string[];
      video: boolean;
      download: boolean;
      expires_at: string | null;
      show_transcript: boolean;
      show_summary: boolean;
      summary: MeetingSummary | null;
      transcript: MeetingTranscript | null;
    };
/** Nulo: o link não existe (ou foi desativado). `opened` conta a visita. */
export async function publicMeeting(
  token: string,
  password: string | null,
  opened: boolean,
) {
  return (await rpc("meeting_public", {
    p_token: token,
    p_password: password,
    p_opened: opened,
  })) as PublicMeeting | null;
}
export async function publicMeetingVideo(
  token: string,
  password: string | null,
  download: boolean,
) {
  const { url } = await driveServer<{ url: string }>({
    action: "meeting-public-video",
    token,
    password: password ?? undefined,
    download,
  });
  return url;
}

/** A transcrição em texto (o download do link público). */
export function transcriptPlainText(title: string, t: MeetingTranscript) {
  const name = (i: number | null) =>
    i != null && t.speakers[i] ? t.speakers[i] : `Falante ${(i ?? 0) + 1}`;
  const lines: string[] = [title, ""];
  let speaker: number | null | undefined;
  for (const [start, , who, text] of t.segments) {
    if (who !== speaker) {
      speaker = who;
      lines.push(
        "",
        `${start != null ? `[${clock(start)}] ` : ""}${name(who)}:`,
      );
    }
    lines.push(text);
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}
/** O resumo em texto (o download do link público). */
export function summaryPlainText(title: string, s: MeetingSummary) {
  const parts = [title];
  if (s.overview) parts.push(s.overview);
  if (s.notes?.length)
    parts.push(
      "Assuntos discutidos:\n" +
        s.notes
          .map(
            (n, i) =>
              `${i + 1}. ${n.title}${n.description ? `\n   ${n.description}` : ""}`,
          )
          .join("\n"),
    );
  const tags = [...(s.tone ?? []), ...(s.keywords ?? [])];
  if (tags.length) parts.push(`Temas: ${tags.join(", ")}`);
  return parts.join("\n\n") + "\n";
}

/** Pergunta sobre uma reunião (a transcrição inteira), em tempo real. */
export function askMeeting(
  recording: string,
  question: string,
  history: ChatTurn[],
  handlers: AiStreamHandlers = {},
) {
  return streamAnswer(
    "/api/drive",
    { action: "meeting-ask", recording, question, history },
    handlers,
  );
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
  | { kind: "source"; ref: string };
/**
 * Uma linha da resposta da IA em pedaços: texto, **negrito**, momentos
 * [12:34] e fontes [S3] (clicáveis).
 */
export function answerPieces(line: string): AnswerPiece[] {
  const pieces: AnswerPiece[] = [];
  const re = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]|\[(S\d{1,3})\]|\*\*([^*]+)\*\*/g;
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
    } else if (m[2]) pieces.push({ kind: "source", ref: m[2] });
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

/**
 * A descrição da tarefa no formato do editor (texto com negrito), não HTML:
 * o editor mostraria as tags como texto.
 */
export function stepDescription(
  step: { description: string; owner: string; deadline: string },
  meeting: { title: string; clientName: string; date: string; link: string },
) {
  const text = (t: string, bold = false): RichNode => ({
    type: "text",
    text: t,
    marks: bold ? [{ type: "bold" }] : [],
  });
  const paragraph = (...content: RichNode[]): RichNode => ({
    type: "paragraph",
    content,
  });
  return serializeDescription({
    type: "doc",
    content: [
      paragraph(text(step.description)),
      ...(step.owner
        ? [paragraph(text("Responsável na reunião: ", true), text(step.owner))]
        : []),
      ...(step.deadline
        ? [paragraph(text("Prazo combinado: ", true), text(step.deadline))]
        : []),
      paragraph(
        text("Reunião: ", true),
        text(`${meeting.title} com ${meeting.clientName} em ${meeting.date}`),
      ),
      paragraph(text("Gravação: ", true), text(meeting.link)),
    ],
  });
}

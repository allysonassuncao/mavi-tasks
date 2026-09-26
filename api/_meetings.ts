import Anthropic from "@anthropic-ai/sdk";
import {
  callRpc,
  signGcsUrl,
  type GcsCredentials,
  type RequestOrigin,
} from "./_drive.js";
import { addUsage, newMeter, type Meter } from "./_social-leads.js";

/**
 * Drive › Gravações da MAVI, no servidor (ações "meeting-*" de /api/drive):
 *
 * - "meeting-video": link assinado do vídeo (o banco confere o acesso,
 *   devolve o caminho e registra a abertura no histórico do Drive);
 * - "meeting-ask": pergunta sobre uma reunião; a Claude responde lendo a
 *   transcrição e cita os momentos como [mm:ss];
 *
 * A pergunta sobre o histórico do cliente é da IA geral (api/_ai.ts), que
 * busca nos trechos indexados em vez de ler todos os resumos.
 *
 * Tudo roda como a pessoa (o token dela): o RLS decide o que ela vê. Cada
 * resposta da IA é medida e registrada em ai_usage.
 */

export type MeetingsEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  anthropicKey: string;
  model: string;
  credentials: GcsCredentials | null;
  /** Buckets que o gravador usa (nenhum outro é assinado). */
  buckets: string[];
};
export function meetingsEnv(
  base: Pick<MeetingsEnv, "supabaseUrl" | "supabaseKey" | "credentials">,
  env: Record<string, string | undefined> = process.env,
): MeetingsEnv {
  return {
    ...base,
    anthropicKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.MEETINGS_MODEL || "claude-opus-5",
    buckets: (env.MEETING_BUCKETS || "meet_recording,makecrm_meet")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean),
  };
}

type Fetch = typeof fetch;
export type AskRequest = {
  system: string;
  /** Material longo e fixo da conversa (fica em cache entre perguntas). */
  context: string;
  messages: { role: "user" | "assistant"; content: string }[];
};
export type MeetingsDeps = {
  fetch: Fetch;
  /** A chamada à Claude, trocada nos testes. */
  ask: (
    env: MeetingsEnv,
    request: AskRequest,
    meter: Meter,
    onEvent?: (e: { type: "thinking" | "text"; text: string }) => void,
  ) => Promise<string>;
};

export type MeetingsRequest =
  | { action: "meeting-video"; recording: string }
  | {
      action: "meeting-ask";
      recording: string;
      question: string;
      history?: { role: "user" | "assistant"; content: string }[];
    };

class MeetingsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Leitura pelo PostgREST como a pessoa (o RLS filtra). */
async function select<T>(
  env: MeetingsEnv,
  fetchImpl: Fetch,
  auth: string,
  path: string,
): Promise<T[]> {
  const res = await fetchImpl(`${env.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: env.supabaseKey, Authorization: auth },
  });
  if (!res.ok)
    throw new MeetingsError(
      res.status === 401 || res.status === 403 ? 403 : 502,
      "Não foi possível ler a gravação.",
    );
  return (await res.json()) as T[];
}

/** 75 → "01:15"; 3725 → "1:02:05". */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type Segment = [number | null, number | null, number | null, string];
/**
 * A transcrição como texto para a IA: falas seguidas da mesma pessoa viram
 * uma linha (até ~45 s), com o tempo de início.
 */
export function transcriptText(speakers: string[], segments: Segment[]) {
  const lines: string[] = [];
  let current: {
    start: number | null;
    speaker: number | null;
    text: string[];
  } | null = null;
  const name = (i: number | null) =>
    i != null && speakers[i] ? speakers[i] : `Falante ${(i ?? 0) + 1}`;
  const flush = () => {
    if (!current) return;
    const at = current.start != null ? `[${clock(current.start)}] ` : "";
    lines.push(`${at}${name(current.speaker)}: ${current.text.join(" ")}`);
    current = null;
  };
  for (const [start, , speaker, text] of segments) {
    if (
      current &&
      current.speaker === speaker &&
      (start == null || current.start == null || start - current.start < 45)
    ) {
      current.text.push(text);
      continue;
    }
    flush();
    current = { start, speaker, text: [text] };
  }
  flush();
  return lines.join("\n");
}

type Summary = {
  title?: string;
  overview?: string;
  notes?: { title: string; description: string }[];
  todo?: { owner: string; description: string }[];
  action_items?: { owner: string; description: string; deadline?: string }[];
  keywords?: string[];
};
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

/** Resumo de uma reunião como texto. */
export function summaryText(s: Summary) {
  const parts: string[] = [];
  if (s.overview) parts.push(s.overview);
  for (const n of s.notes ?? []) parts.push(`- ${n.title}: ${n.description}`);
  const steps = [...(s.todo ?? []), ...(s.action_items ?? [])];
  if (steps.length)
    parts.push(
      "Próximos passos:\n" +
        steps
          .map(
            (t) =>
              `- ${t.owner ? `${t.owner}: ` : ""}${t.description}${"deadline" in t && t.deadline ? ` (${t.deadline})` : ""}`,
          )
          .join("\n"),
    );
  return parts.join("\n");
}

export const MEETING_SYSTEM = `Você ajuda o time de uma agência de marketing a consultar uma reunião gravada com um cliente. Abaixo está a transcrição automática, com o tempo de cada fala entre colchetes.

Regras:
- Responda só com o que está na transcrição (e no resumo, quando houver). Se a resposta não estiver lá, diga isso com clareza, sem inventar.
- Cite o momento de cada informação importante com o tempo exato entre colchetes, no formato da transcrição, por exemplo [12:34] ou [1:02:05]. Use apenas tempos que aparecem na transcrição.
- A transcrição é automática: nomes e palavras podem ter saído errados. Quando algo parecer ambíguo, avise.
- Seja direto: frases curtas, listas quando ajudar. Português do Brasil. Sem markdown pesado (use no máximo listas com "-" e negrito com **).`;

/** Uma resposta da Claude, com a transcrição/histórico em cache. */
export async function claudeAsk(
  env: MeetingsEnv,
  request: AskRequest,
  meter: Meter,
  onEvent?: (e: { type: "thinking" | "text"; text: string }) => void,
): Promise<string> {
  const client = new Anthropic({ apiKey: env.anthropicKey, maxRetries: 2 });
  const stream = client.beta.messages.stream({
    model: env.model,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "medium" },
    system: [
      { type: "text", text: request.system },
      {
        type: "text",
        text: request.context,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: request.messages,
  });
  if (onEvent) {
    stream.on("thinking", (delta) =>
      onEvent({ type: "thinking", text: delta }),
    );
    stream.on("text", (delta) => onEvent({ type: "text", text: delta }));
  }
  const message = await stream.finalMessage();
  addUsage(meter, message.model, message.usage);
  if (message.stop_reason === "refusal")
    throw new MeetingsError(
      422,
      "A IA não respondeu a esta pergunta. Tente reformular.",
    );
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) {
    const kinds = message.content.map((b) => b.type).join(", ") || "nada";
    console.error("IA sem resposta (reunião)", {
      model: message.model,
      stop_reason: message.stop_reason,
      blocks: kinds,
      usage: message.usage,
    });
    throw new MeetingsError(
      502,
      `A IA não devolveu resposta (motivo: ${message.stop_reason ?? "desconhecido"}; veio: ${kinds}). Tente de novo.`,
    );
  }
  if (message.stop_reason === "max_tokens")
    return `${text}\n\n(A resposta foi cortada por ser longa demais.)`;
  return text;
}

function friendly(err: unknown) {
  if (err instanceof MeetingsError) return err.message;
  if (err instanceof Anthropic.AuthenticationError)
    return "A chave da API da Claude (ANTHROPIC_API_KEY) foi recusada. Confira a variável na Vercel.";
  if (err instanceof Anthropic.RateLimitError)
    return "Limite de uso da API da Claude atingido. Tente de novo em alguns minutos.";
  if (err instanceof Anthropic.APIError)
    return `A API da Claude respondeu com erro (${err.status ?? "sem status"}). Tente de novo.`;
  return "Não foi possível responder agora. Tente de novo.";
}

function conversation(
  question: unknown,
  history: unknown,
): { role: "user" | "assistant"; content: string }[] {
  const q = typeof question === "string" ? question.trim() : "";
  if (q.length < 2 || q.length > 2000)
    throw new MeetingsError(
      400,
      "Escreva uma pergunta de até 2.000 caracteres.",
    );
  const turns = (Array.isArray(history) ? history : [])
    .filter(
      (t): t is { role: "user" | "assistant"; content: string } =>
        !!t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string" &&
        !!t.content.trim(),
    )
    .slice(-12)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 12000) }));
  // A conversa começa pela pessoa e alterna.
  while (turns.length && turns[0].role !== "user") turns.shift();
  const clean: typeof turns = [];
  for (const t of turns)
    if (!clean.length || clean[clean.length - 1].role !== t.role) clean.push(t);
  if (clean.length && clean[clean.length - 1].role === "user") clean.pop();
  return [...clean, { role: "user", content: q }];
}

async function logUsage(
  env: MeetingsEnv,
  fetchImpl: Fetch,
  auth: string,
  at: { company: string; client: string; recording: string },
  m: Meter,
) {
  if (!m.input && !m.output && !m.cacheRead && !m.cacheWrite) return;
  await callRpc(env, fetchImpl, auth, "ai_log_usage", {
    p_company: at.company,
    p_module: "meetings",
    p_kind: "ask",
    p_client: at.client,
    p_contract: null,
    p_project: null,
    p_recording: at.recording,
    p_model: m.model || env.model,
    p_input: m.input,
    p_output: m.output,
    p_cache_read: m.cacheRead,
    p_cache_write: m.cacheWrite,
    p_embedding: 0,
    p_cost: Math.round(m.cost * 1e6) / 1e6,
  }).catch(() => {});
}

export async function handleMeetings(
  body: unknown,
  authorization: string | null,
  env: MeetingsEnv,
  deps: MeetingsDeps,
  origin: RequestOrigin = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = (body ?? {}) as Partial<MeetingsRequest> &
    Record<string, unknown>;
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");

  if (req.action === "meeting-video") {
    if (!UUID.test(String(req.recording ?? "")))
      return fail(400, "Gravação inválida.");
    if (!env.credentials?.client_email || !env.credentials.private_key)
      return fail(500, "Credenciais do Google Cloud Storage não configuradas.");
    const target = await callRpc<
      {
        bucket: string;
        path: string;
        content_type: string | null;
        title: string;
      }[]
    >(env, deps.fetch, authorization, "meeting_video_target", {
      p_recording: req.recording,
      p_origin: origin,
    });
    if (!target.ok) return fail(target.status, target.error);
    const video = target.data[0];
    if (!video || !env.buckets.includes(video.bucket))
      return fail(404, "O vídeo desta reunião não está disponível.");
    const type = video.content_type || "video/mp4";
    return {
      status: 200,
      body: {
        // O player pede pedaços do vídeo durante toda a reunião: o link vale
        // por 6 horas.
        url: signGcsUrl(env.credentials, video.bucket, video.path, "GET", {
          expiresInSeconds: 6 * 3600,
          query: {
            "response-content-type": type,
            "response-content-disposition": "inline",
          },
        }),
        content_type: type,
      },
    };
  }

  if (req.action !== "meeting-ask") return fail(400, "Ação inválida.");
  try {
    const answer = await meetingAsk(req, authorization, env, deps, () => {});
    return { status: 200, body: { answer } };
  } catch (err) {
    return fail(err instanceof MeetingsError ? err.status : 500, friendly(err));
  }
}

type MeetingEvent =
  | {
      type: "step";
      id: string;
      label: string;
      state: "running" | "done";
      detail?: string;
    }
  | { type: "thinking" | "text"; text: string }
  | { type: "done"; answer: string; sources: []; conversation: null }
  | { type: "error"; error: string; status: number };

/** Pergunta sobre uma reunião: a transcrição inteira em contexto (em cache). */
async function meetingAsk(
  req: Record<string, unknown>,
  authorization: string,
  env: MeetingsEnv,
  deps: MeetingsDeps,
  emit: (e: MeetingEvent) => void,
): Promise<string> {
  if (!env.anthropicKey)
    throw new MeetingsError(
      503,
      "A IA não está configurada no servidor. Falta na Vercel: ANTHROPIC_API_KEY. Depois de salvar, faça um Redeploy.",
    );
  const messages = conversation(req.question, req.history);
  if (!UUID.test(String(req.recording ?? "")))
    throw new MeetingsError(400, "Gravação inválida.");
  emit({
    type: "step",
    id: "read",
    label: "Lendo a transcrição da reunião",
    state: "running",
  });
  const [recording] = await select<{
    id: string;
    company_id: string;
    client_id: string;
    title: string;
    recorded_at: string;
    summary: Summary;
  }>(
    env,
    deps.fetch,
    authorization,
    `meeting_recordings?id=eq.${req.recording}&select=id,company_id,client_id,title,recorded_at,summary`,
  );
  if (!recording) throw new MeetingsError(404, "Gravação não encontrada.");
  const [transcript] = await select<{
    speakers: string[];
    segments: Segment[];
  }>(
    env,
    deps.fetch,
    authorization,
    `meeting_transcripts?recording_id=eq.${req.recording}&select=speakers,segments`,
  );
  if (!transcript?.segments.length)
    throw new MeetingsError(404, "Esta reunião não tem transcrição.");
  emit({
    type: "step",
    id: "read",
    label: "Transcrição lida",
    state: "done",
    detail: `${transcript.segments.length} falas`,
  });
  const context = [
    `Reunião: ${recording.summary.title || recording.title || "sem título"} (${date(recording.recorded_at)})`,
    recording.summary.overview
      ? `Resumo automático:\n${summaryText(recording.summary)}`
      : "",
    `Transcrição:\n${transcriptText(transcript.speakers, transcript.segments)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const meter = newMeter(env.model);
  try {
    return await deps.ask(
      env,
      { system: MEETING_SYSTEM, context, messages },
      meter,
      emit,
    );
  } finally {
    await logUsage(
      env,
      deps.fetch,
      authorization,
      {
        company: recording.company_id,
        client: recording.client_id,
        recording: recording.id,
      },
      meter,
    );
  }
}

/** A pergunta sobre a reunião em tempo real (uma linha JSON por evento). */
export async function streamMeetingAsk(
  body: unknown,
  authorization: string | null,
  env: MeetingsEnv,
  deps: MeetingsDeps,
  write: (e: MeetingEvent) => void,
) {
  if (!authorization?.startsWith("Bearer ")) {
    write({ type: "error", error: "Autenticação necessária.", status: 401 });
    return;
  }
  try {
    const answer = await meetingAsk(
      (body ?? {}) as Record<string, unknown>,
      authorization,
      env,
      deps,
      write,
    );
    write({ type: "done", answer, sources: [], conversation: null });
  } catch (err) {
    write({
      type: "error",
      error: friendly(err),
      status: err instanceof MeetingsError ? err.status : 500,
    });
  }
}

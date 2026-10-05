import crypto from "node:crypto";
import { callRpc, signGcsUrl, type DriveEnv } from "./_drive.js";
import { routeConfig, type ProviderConfig, type ResolvedRoute } from "./_ai-providers.js";
import { transcribe } from "./_whatsapp.js";
import { isLinkTranscriber, transcribePerMinute } from "../src/ai-providers.js";

/**
 * Tutoriais › transcrição dos vídeos enviados (ação "tutorial-transcribe" de
 * /api/ai, acordada por mavi_private.tutorial_transcribe_kick quando um envio
 * termina — migration 20270420090000_tutorials_mavi). Só com o segredo do
 * worker (AI_WORKER_SECRET).
 *
 * Quem transcreve é a funcionalidade 'tutorial_transcribe' de Quem usa qual
 * modelo:
 * - Deepgram e AssemblyAI recebem o link assinado do vídeo (sem limite de
 *   tamanho). A AssemblyAI processa à parte: o pedido fica guardado e o vídeo
 *   volta para a fila até ficar pronto.
 * - Os provedores com o endpoint da OpenAI (e a OpenAI do servidor, sem
 *   regra) recebem o arquivo: só até 25 MB. Os maiores ficam "grandes demais"
 *   para quem edita escrever a transcrição ou trocar o provedor.
 */
export type TutorialTranscribeEnv = DriveEnv & {
  openaiKey: string;
  transcribeModel: string;
  workerSecret: string;
  providerKey: Buffer | null;
  /** Quanto tempo uma rodada do worker trabalha (a função tem 300 s). */
  budgetMs: number;
};
type Fetch = typeof fetch;
export type TranscribeDeps = {
  fetch: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};
type Job = {
  id: string;
  company_id: string;
  tutorial_id: string;
  path: string;
  name: string;
  content_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  job: string | null;
  created_by: string;
};
type Outcome = {
  text?: string;
  error?: string;
  skipped?: boolean;
  /** O provedor ainda processa (AssemblyAI). */
  job?: string;
  seconds?: number | null;
};

/** O limite de arquivo do endpoint de transcrição da OpenAI. */
export const FILE_LIMIT = 25 * 1024 * 1024;
const TOO_BIG =
  "Vídeo maior que 25 MB para o provedor escolhido. Em Painel da MAVI › Quem usa qual modelo › Tutoriais, escolha o Deepgram ou a AssemblyAI (transcrevem pelo link), ou escreva a transcrição.";

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function tutorialTranscribeEnv(
  base: DriveEnv,
  env: Record<string, string | undefined> = process.env,
  providerKey: Buffer | null,
): TutorialTranscribeEnv {
  return {
    ...base,
    openaiKey: env.OPENAI_API_KEY || "",
    transcribeModel: env.WHATSAPP_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    workerSecret: env.AI_WORKER_SECRET?.trim() || "",
    providerKey,
    budgetMs: Number(env.TUTORIAL_TRANSCRIBE_BUDGET_MS) || 240_000,
  };
}

/** Se o pedido traz o segredo do worker (antes de seguir em segundo plano). */
export function tutorialTranscribeAllowed(authorization: string | null, env: TutorialTranscribeEnv) {
  const given = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  return !!env.workerSecret && !!given && sameSecret(given, env.workerSecret);
}

export async function handleTutorialTranscribe(
  authorization: string | null,
  env: TutorialTranscribeEnv,
  deps: TranscribeDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!tutorialTranscribeAllowed(authorization, env))
    return { status: 401, body: { error: "Não autorizado." } };
  if (!env.credentials?.client_email || !env.credentials.private_key)
    return { status: 500, body: { error: "Credenciais do Google Cloud Storage não configuradas." } };
  const now = deps.now ?? Date.now;
  const deadline = now() + env.budgetMs;
  const worker = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  let done = 0;
  while (now() < deadline - 20_000) {
    const jobs = await worker<Job[]>("tutorial_transcribe_claim", { p_limit: 3 });
    if (!jobs?.length) break;
    for (const job of jobs) {
      let route: ResolvedRoute | null = null;
      let via: ProviderConfig | null = null;
      let out: Outcome;
      try {
        route = await worker<ResolvedRoute | null>("ai_worker_route", {
          p_company: job.company_id,
          p_feature: "tutorial_transcribe",
        });
        via = route?.key_cipher ? routeConfig(env, route) : null;
        out = await transcribeVideo(env, deps, job, via, deadline);
      } catch (e) {
        out = { error: (e as Error).message.slice(0, 400) };
      }
      const model = via?.model ?? env.transcribeModel;
      const seconds = out.seconds ?? job.duration_seconds;
      const cost =
        out.text && seconds
          ? Math.round((seconds / 60) * transcribePerMinute(model, 0.006) * 1e6) / 1e6
          : 0;
      await worker("tutorial_transcribe_save", {
        p_media: job.id,
        p_transcript: out.text ?? null,
        p_error: out.error ?? null,
        p_skipped: !!out.skipped,
        p_job: out.job ?? null,
        p_model: model,
        p_cost: cost,
        p_provider: out.text && route ? route.provider_id : null,
        p_duration: out.seconds != null ? Math.round(out.seconds) : null,
      });
      done++;
    }
  }
  return { status: 200, body: { done } };
}

/** Um vídeo: pelo link (Deepgram, AssemblyAI) ou pelo arquivo (até 25 MB). */
export async function transcribeVideo(
  env: TutorialTranscribeEnv,
  deps: TranscribeDeps,
  job: Job,
  via: ProviderConfig | null,
  deadline: number,
): Promise<Outcome> {
  const now = deps.now ?? Date.now;
  const creds = env.credentials!;
  if (via && isLinkTranscriber(via.kind)) {
    const url = signGcsUrl(creds, env.bucket, job.path, "GET", { expiresInSeconds: 6 * 3600 });
    if (via.kind === "deepgram") {
      const query = new URLSearchParams({
        model: via.model,
        language: "pt-BR",
        smart_format: "true",
        punctuate: "true",
        paragraphs: "true",
      });
      const res = await deps.fetch(`${via.baseUrl}/listen?${query}`, {
        method: "POST",
        headers: { Authorization: `Token ${via.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(Math.max(deadline - now() - 10_000, 30_000)),
      });
      const body = (await res.json().catch(() => ({}))) as {
        err_msg?: string;
        metadata?: { duration?: number };
        results?: {
          channels?: { alternatives?: { transcript?: string; paragraphs?: { transcript?: string } }[] }[];
        };
      };
      if (!res.ok) throw new Error(`Deepgram (${res.status}): ${(body.err_msg ?? "").slice(0, 200)}`);
      const alt = body.results?.channels?.[0]?.alternatives?.[0];
      const text = (alt?.paragraphs?.transcript || alt?.transcript || "").trim();
      if (!text) return { error: "O Deepgram não encontrou fala no vídeo." };
      return { text, seconds: body.metadata?.duration ?? null };
    }
    // AssemblyAI: pede (ou retoma o pedido) e acompanha até o fim da rodada.
    const headers = { Authorization: via.apiKey, "Content-Type": "application/json" };
    let id = job.job;
    if (!id) {
      const res = await deps.fetch(`${via.baseUrl}/transcript`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audio_url: url, speech_model: via.model, language_code: "pt" }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(`AssemblyAI (${res.status}): ${(body.error ?? "").slice(0, 200)}`);
      id = body.id;
    }
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    while (now() < deadline - 15_000) {
      const res = await deps.fetch(`${via.baseUrl}/transcript/${encodeURIComponent(id)}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        text?: string;
        error?: string;
        audio_duration?: number;
      };
      if (!res.ok) throw new Error(`AssemblyAI (${res.status}): ${(body.error ?? "").slice(0, 200)}`);
      if (body.status === "completed") {
        const text = (body.text ?? "").trim();
        return text
          ? { text, seconds: body.audio_duration ?? null }
          : { error: "A AssemblyAI não encontrou fala no vídeo." };
      }
      if (body.status === "error") throw new Error(`AssemblyAI: ${(body.error ?? "erro").slice(0, 200)}`);
      await sleep(4000);
    }
    return { job: id };
  }
  // Pelo arquivo: o endpoint da OpenAI (até 25 MB).
  if (job.size_bytes > FILE_LIMIT) return { skipped: true, error: TOO_BIG };
  if (!via && !env.openaiKey)
    return { error: "Transcrição não configurada: escolha um provedor em Quem usa qual modelo › Tutoriais." };
  const res = await deps.fetch(signGcsUrl(creds, env.bucket, job.path, "GET", { expiresInSeconds: 300 }), {
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Não foi possível ler o vídeo (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ext = job.name.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ?? "mp4";
  const text = await transcribe(
    { openaiKey: env.openaiKey, transcribeModel: env.transcribeModel },
    { fetch: deps.fetch },
    bytes,
    job.content_type,
    `video.${ext}`,
    via,
  );
  return text ? { text } : { error: "A transcrição voltou vazia (o vídeo tem fala?)." };
}

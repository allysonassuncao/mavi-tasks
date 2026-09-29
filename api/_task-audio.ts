import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import { featureProvider, providerKeyFrom } from "./_ai-providers.js";
import type { AskRequest, MeetingsEnv } from "./_meetings.js";
import { newMeter, type Meter } from "./_social-leads.js";
import { transcribe } from "./_whatsapp.js";
import { serverModel, transcribePerMinute } from "../src/ai-providers.js";
import { audioExtension } from "../src/upload-types.js";

/**
 * Áudios das tarefas (ação "task-audio" de /api/drive, migration
 * 20261201090000_task_audio). Quem gravou pede o trabalho logo depois de
 * enviar o arquivo; quem cuida do áudio pede de novo quando falhou ou
 * quando corrige a transcrição.
 *
 * - op "work": o banco entrega o áudio (start_task_audio_work, como a
 *   pessoa: quem pode, e nada em dobro); o servidor baixa do GCS,
 *   transcreve (funcionalidade 'task_audio_transcribe'; sem regra, a
 *   OpenAI do servidor) e, nos áudios da descrição, a MAVI resume em tópicos
 *   (funcionalidade 'task_audio' do Painel da MAVI). Cada passo volta ao
 *   banco (save_task_audio_work), que avisa pelo Realtime quem está com a
 *   tarefa aberta.
 * - op "edit": grava a transcrição corrigida (edit_task_audio) e refaz o
 *   resumo.
 *
 * A resposta traz o áudio como ficou: o formulário de criação espera por
 * ela (o rascunho ainda não é de nenhuma tarefa, então ninguém mais é
 * avisado).
 */
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Transcrições curtas já são o resumo: a MAVI não é chamada. */
export const SUMMARY_MIN_CHARS = 280;
export const SUMMARY_MAX_POINTS = 6;

export type TaskAudioEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  credentials: GcsCredentials | null;
  /** O bucket público dos anexos e áudios das tarefas. */
  bucket: string;
  openaiKey: string;
  transcribeModel: string;
  transcribeUsdPerMinute: number;
  anthropicKey: string;
  /** O modelo do padrão do servidor (o Painel da MAVI vence). */
  model: string;
  providerKey?: Buffer | null;
};

export function taskAudioEnv(
  base: Pick<TaskAudioEnv, "supabaseUrl" | "supabaseKey" | "credentials">,
  env: Record<string, string | undefined> = process.env,
): TaskAudioEnv {
  return {
    ...base,
    bucket: env.GCS_BUCKET || "maso_storage_main",
    openaiKey: env.OPENAI_API_KEY || "",
    transcribeModel: env.WHATSAPP_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    transcribeUsdPerMinute:
      Number(env.WHATSAPP_TRANSCRIBE_USD_PER_MIN) || 0.003,
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    model: serverModel("task_audio", env),
    providerKey: providerKeyFrom(env.AI_PROVIDER_KEY),
  };
}

export type TaskAudioDeps = {
  fetch: typeof fetch;
  /** A chamada à MAVI (claudeAsk: Claude ou provedores da biblioteca). */
  ask: (env: MeetingsEnv, request: AskRequest, meter: Meter) => Promise<string>;
};

export type AudioRow = {
  id: string;
  company_id: string;
  task_id: string | null;
  comment_id: string | null;
  purpose: "description" | "comment";
  path: string;
  mime: string;
  duration_seconds: number;
  status: string;
  transcript: string | null;
  summary: string | null;
  error: string | null;
};
type Started = {
  skip: boolean;
  audio: AudioRow;
  client: string | null;
  contract: string | null;
  project: string | null;
  task_title: string | null;
};

export const SUMMARY_SYSTEM = `Você é a MAVI, a inteligência do SaaS de tarefas de uma agência. Alguém gravou um áudio explicando uma tarefa, e você recebe a transcrição automática (pode ter erros de reconhecimento).

Resuma o que precisa ser feito em tópicos curtos, para quem vai executar a tarefa bater o olho e entender:
- No máximo ${SUMMARY_MAX_POINTS} tópicos, do mais importante ao menos importante.
- Cada tópico com uma ação ou informação concreta: o que fazer, entregáveis, prazos, referências, restrições, para quem.
- Use as palavras de quem falou; não invente nada que não foi dito e não dê conselhos.
- Português do Brasil, sem saudação, sem título e sem comentário seu.

Responda só com os tópicos, um por linha, cada um começando com "- ".`;

/** Os tópicos da resposta, limpos (sem título, numeração ou markdown). */
export function summaryPoints(text: string) {
  return text
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^([-*•]|\d+[.)])\s+/, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter((l) => l.length > 0 && !/:$/.test(l))
    .slice(0, SUMMARY_MAX_POINTS)
    .map((l) => `- ${l.slice(0, 400)}`)
    .join("\n");
}

class AudioError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function rpc<T>(
  env: TaskAudioEnv,
  deps: TaskAudioDeps,
  auth: string,
  name: string,
  args: Row,
) {
  const r = await callRpc<T>(env, deps.fetch, auth, name, args);
  if (!r.ok) throw new AudioError(r.status >= 500 ? 502 : r.status, r.error);
  return r.data;
}

export async function handleTaskAudio(
  body: unknown,
  authorization: string | null,
  env: TaskAudioEnv,
  deps: TaskAudioDeps,
): Promise<{ status: number; body: Row }> {
  if (!authorization?.startsWith("Bearer "))
    return { status: 401, body: { error: "Entre na sua conta." } };
  const req = (body ?? {}) as Row;
  const audio = typeof req.audio === "string" ? req.audio : "";
  const contract =
    typeof req.contract === "string" && UUID.test(req.contract)
      ? req.contract
      : null;
  if (!UUID.test(audio))
    return { status: 400, body: { error: "Áudio inválido." } };
  try {
    if (req.op === "edit") {
      const transcript =
        typeof req.transcript === "string" ? req.transcript.slice(0, 20000) : "";
      const edited = await rpc<AudioRow>(
        env,
        deps,
        authorization,
        "edit_task_audio",
        { p_audio: audio, p_transcript: transcript },
      );
      if (edited.status !== "summarizing")
        return { status: 200, body: { audio: edited } };
    } else if (req.op !== "work")
      return { status: 400, body: { error: "Pedido inválido." } };
    return {
      status: 200,
      body: { audio: await work(audio, contract, authorization, env, deps) },
    };
  } catch (e) {
    const status = e instanceof AudioError ? e.status : 500;
    return { status, body: { error: (e as Error).message } };
  }
}

async function work(
  id: string,
  contract: string | null,
  auth: string,
  env: TaskAudioEnv,
  deps: TaskAudioDeps,
): Promise<AudioRow> {
  const started = await rpc<Started>(
    env,
    deps,
    auth,
    "start_task_audio_work",
    { p_audio: id, p_contract: contract },
  );
  if (started.skip) return started.audio;
  let audio = started.audio;
  const save = (transcript: string | null, summary: string | null, error: string | null) =>
    rpc<AudioRow>(env, deps, auth, "save_task_audio_work", {
      p_audio: id,
      p_transcript: transcript,
      p_summary: summary,
      p_error: error,
    });
  const scope = {
    client: started.client ?? undefined,
    contract: started.contract ?? undefined,
    project: started.project ?? undefined,
  };
  const log = (kind: string, model: string, cost: number, meter?: Meter, provider?: string) =>
    callRpc(env, deps.fetch, auth, "ai_log_usage", {
      p_company: audio.company_id,
      p_module: "tasks",
      p_kind: kind,
      p_client: started.client,
      p_contract: started.contract,
      p_project: started.project,
      p_recording: null,
      p_model: model,
      p_input: meter?.input ?? 0,
      p_output: meter?.output ?? 0,
      p_cache_read: meter?.cacheRead ?? 0,
      p_cache_write: meter?.cacheWrite ?? 0,
      p_embedding: 0,
      p_cost: Math.round(cost * 1e6) / 1e6,
      ...(provider ? { p_provider: provider } : {}),
    }).catch(() => {});

  // O limite de gasto da MAVI vale aqui também.
  const limits = await callRpc<{ blocked: boolean; message: string | null }>(
    env,
    deps.fetch,
    auth,
    "ai_check_limits",
    {
      p_company: audio.company_id,
      p_client: started.client,
      p_contract: started.contract,
      p_project: started.project,
    },
  );
  if (limits.ok && limits.data?.blocked)
    return save(null, null, limits.data.message ?? "Limite de uso da MAVI atingido.");

  if (audio.transcript == null) {
    let text: string;
    // Quem transcreve: a regra "Transcrição dos áudios das tarefas" do
    // Painel da MAVI ou, sem ela, a OpenAI do servidor.
    let via: Awaited<ReturnType<typeof featureProvider>> = null;
    try {
      via = await featureProvider(
        { ...env, providerKey: env.providerKey ?? null },
        deps.fetch,
        auth,
        audio.company_id,
        "task_audio_transcribe",
        scope,
      );
    } catch (e) {
      return save(null, null, (e as Error).message);
    }
    try {
      if (!env.credentials)
        throw new Error("Credenciais do Google Cloud Storage não configuradas.");
      const file = await deps.fetch(
        signGcsUrl(env.credentials, env.bucket, audio.path, "GET", {
          expiresInSeconds: 300,
        }),
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!file.ok)
        throw new Error(
          file.status === 404
            ? "O arquivo do áudio não chegou ao servidor. Grave de novo."
            : `Não foi possível baixar o áudio (${file.status}).`,
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      text = await transcribe(
        env,
        deps,
        bytes,
        audio.mime,
        `audio.${audioExtension(audio.mime)}`,
        via?.config,
      );
    } catch (e) {
      return save(null, null, friendly((e as Error).message));
    }
    const model = via?.config.model ?? env.transcribeModel;
    await log(
      "audio_transcription",
      model,
      (Number(audio.duration_seconds) / 60) *
        transcribePerMinute(model, env.transcribeUsdPerMinute),
      undefined,
      via?.id,
    );
    audio = await save(text, null, null);
  }
  if (audio.status !== "summarizing") return audio;

  const transcript = audio.transcript ?? "";
  // Pouca coisa: a própria transcrição já se lê de uma vez.
  if (transcript.length < SUMMARY_MIN_CHARS) return save(null, "", null);
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    provider = await featureProvider(
      { ...env, providerKey: env.providerKey ?? null },
      deps.fetch,
      auth,
      audio.company_id,
      "task_audio",
      scope,
    );
  } catch (e) {
    return save(null, null, (e as Error).message);
  }
  if (!provider && !env.anthropicKey)
    return save(
      null,
      null,
      "A MAVI não está configurada no servidor (ANTHROPIC_API_KEY). Escolha um provedor para os áudios das tarefas no Painel da MAVI.",
    );
  const meter = newMeter(provider?.config.model ?? env.model);
  try {
    const answer = await deps.ask(
      {
        supabaseUrl: env.supabaseUrl,
        supabaseKey: env.supabaseKey,
        anthropicKey: env.anthropicKey,
        model: env.model,
        credentials: env.credentials,
        buckets: [],
        provider: provider?.config ?? null,
      },
      {
        system: SUMMARY_SYSTEM,
        context: [
          started.task_title ? `Tarefa: ${started.task_title}` : "Tarefa ainda sem título salvo.",
          `Duração do áudio: ${Math.round(Number(audio.duration_seconds))} s`,
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: `Transcrição do áudio:\n"""\n${transcript}\n"""\n\nResuma em tópicos.`,
          },
        ],
      },
      meter,
    );
    const points = summaryPoints(answer);
    return await save(null, points, points ? null : "A MAVI não devolveu o resumo.");
  } catch (e) {
    return save(null, null, `A MAVI não conseguiu resumir: ${(e as Error).message}`.slice(0, 480));
  } finally {
    if (meter.input || meter.output)
      await log(
        "audio_summary",
        meter.model || env.model,
        meter.cost,
        meter,
        provider?.id,
      );
  }
}

function friendly(message: string) {
  if (/OPENAI_API_KEY/.test(message))
    return "A transcrição não está configurada no servidor (OPENAI_API_KEY).";
  if (/Transcrição \((429|5\d\d)\)/.test(message))
    return "O serviço de transcrição está ocupado. Tente de novo em instantes.";
  return message.slice(0, 480);
}

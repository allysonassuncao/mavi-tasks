import crypto from "node:crypto";
import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";

/**
 * Limpeza dos áudios das tarefas (ação "task-audio-cleanup" de /api/ai,
 * migration 20261203090000_task_audio_cleanup). Só o agendamento chama
 * (pg_cron → mavi_private.task_audio_cleanup_kick, com o AI_WORKER_SECRET),
 * e só quando há trabalho.
 *
 * O banco tira os rascunhos com mais de 24 horas e entrega os caminhos cujo
 * último registro saiu (task_audio_cleanup_claim); o worker apaga cada um do
 * bucket público e confirma (task_audio_cleanup_done). "Já não existe" (404)
 * conta como feito: quem tirou o áudio pela tela já pode ter apagado. O que
 * falhar volta na próxima rodada.
 */
export type TaskAudioCleanupEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  credentials: GcsCredentials | null;
  /** O bucket público dos anexos e áudios das tarefas. */
  bucket: string;
  workerSecret: string;
  /** Quanto o worker trabalha por chamada (ms). */
  budgetMs: number;
};

export function taskAudioCleanupEnv(
  base: Pick<TaskAudioCleanupEnv, "supabaseUrl" | "supabaseKey" | "credentials">,
  env: Record<string, string | undefined> = process.env,
): TaskAudioCleanupEnv {
  return {
    ...base,
    bucket: env.GCS_BUCKET || "maso_storage_main",
    workerSecret: env.AI_WORKER_SECRET?.trim() ?? "",
    budgetMs: Number(env.AI_WORKER_BUDGET_MS) || 50_000,
  };
}

export type TaskAudioCleanupDeps = {
  fetch: typeof fetch;
  now?: () => number;
};

/** Caminhos por rodada e quantos o GCS apaga ao mesmo tempo. */
export const CLEANUP_BATCH = 100;
const PARALLEL = 8;

const authorized = (authorization: string | null, secret: string) => {
  const token = Buffer.from(authorization?.replace(/^Bearer\s+/, "") ?? "");
  const expected = Buffer.from(secret);
  return (
    expected.length > 0 &&
    token.length === expected.length &&
    crypto.timingSafeEqual(token, expected)
  );
};

export async function handleTaskAudioCleanup(
  authorization: string | null,
  env: TaskAudioCleanupEnv,
  deps: TaskAudioCleanupDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!authorized(authorization, env.workerSecret))
    return { status: 401, body: { error: "Não autorizado." } };
  const credentials = env.credentials;
  if (!credentials?.client_email || !credentials.private_key)
    return {
      status: 500,
      body: { error: "Credenciais do Google Cloud Storage não configuradas." },
    };
  const now = deps.now ?? Date.now;
  const started = now();
  // O worker fala com o banco como anon + segredo (sem service key).
  const rpc = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await callRpc<T>(env, deps.fetch, null, name, {
      p_secret: env.workerSecret,
      ...args,
    });
    if (!r.ok) throw Object.assign(Error(r.error), { status: r.status });
    return r.data;
  };
  const remove = async (path: string) => {
    const res = await deps
      .fetch(signGcsUrl(credentials, env.bucket, path, "DELETE"), {
        method: "DELETE",
      })
      .catch(() => null);
    return !!res && (res.ok || res.status === 404);
  };

  let deleted = 0,
    failed = 0;
  try {
    while (now() - started < env.budgetMs) {
      const claimed = await rpc<{ path: string }[]>(
        "task_audio_cleanup_claim",
        { p_limit: CLEANUP_BATCH },
      );
      if (!claimed.length) break;
      const done: string[] = [],
        failures: string[] = [];
      for (let i = 0; i < claimed.length; i += PARALLEL) {
        const slice = claimed.slice(i, i + PARALLEL).map((r) => r.path);
        const results = await Promise.all(slice.map(remove));
        slice.forEach((p, j) => (results[j] ? done : failures).push(p));
      }
      await rpc("task_audio_cleanup_done", {
        p_done: done,
        p_failed: failures,
        p_error: failures.length ? "O GCS não apagou o arquivo." : null,
      });
      deleted += done.length;
      failed += failures.length;
      // Uma rodada incompleta esvaziou o que estava vencido.
      if (claimed.length < CLEANUP_BATCH) break;
    }
  } catch (err) {
    const e = err as Error & { status?: number };
    return {
      status: e.status ?? 500,
      body: { error: e.message, deleted, failed },
    };
  }
  return { status: 200, body: { deleted, failed } };
}

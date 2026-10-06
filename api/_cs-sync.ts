import { callRpc } from "./_drive.js";
import { sameSecret } from "./_ads-today.js";
import { buildPayload, downloadSheet } from "./_cs-sheet.js";

/**
 * Customer Success (migração 20270520090000): a leitura da planilha mestre.
 *
 * POST /api/ai {"action":"cs-sync"}:
 *  - o agendamento (pg_cron → mavi_private.cs_sync_kick, com o
 *    AI_WORKER_SECRET) lê todas as planilhas que passaram de 9 minutos;
 *  - "Sincronizar agora" (administrador ou gestor, com o login dele) lê a da
 *    empresa; `allow_removals` confirma o sumiço em massa que a leitura
 *    anterior segurou.
 *
 * O banco é chamado como a própria pessoa ou, no agendamento, como anônimo
 * com o segredo — nunca com a chave de serviço.
 */

type Fetch = typeof fetch;
type Result = { status: number; body: Record<string, unknown> };
export type CsSyncEnv = { supabaseUrl: string; supabaseKey: string; workerSecret?: string };
type Target = { company: string; sheet_id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function syncOne(
  env: CsSyncEnv,
  fetchImpl: Fetch,
  auth: { authorization: string | null; secret: string | null },
  t: Target,
  trigger: "schedule" | "manual",
  allowRemovals: boolean,
) {
  const started = new Date();
  let payload: ReturnType<typeof buildPayload> | null = null;
  let error: string | null = null;
  try {
    const tabs = await downloadSheet(t.sheet_id, fetchImpl);
    payload = buildPayload(tabs);
    payload.meta = {
      started_at: started.toISOString(),
      download_ms: Date.now() - started.getTime(),
      tabs_read: tabs.length,
    };
  } catch (e) {
    error = (e as Error).message || "Falha ao ler a planilha.";
  }
  const stored = await callRpc<Record<string, unknown>>(env, fetchImpl, auth.authorization, "cs_sync_store", {
    p_secret: auth.secret,
    p_company: t.company,
    p_payload: payload,
    p_error: error,
    p_trigger: trigger,
    p_allow_removals: allowRemovals,
  });
  if (!stored.ok) {
    // A gravação falhou (a transação voltou inteira): registra a falha.
    await callRpc(env, fetchImpl, auth.authorization, "cs_sync_store", {
      p_secret: auth.secret,
      p_company: t.company,
      p_payload: null,
      p_error: `Falha ao gravar a leitura: ${stored.error}`,
      p_trigger: trigger,
      p_allow_removals: false,
    }).catch(() => undefined);
    return { company: t.company, ok: false, error: stored.error };
  }
  return { company: t.company, ok: !error, run: stored.data, ...(error ? { error } : {}) };
}

/** POST /api/ai com action cs-sync (api/drive.ts). */
export async function handleCsSync(
  body: Record<string, unknown>,
  authorization: string | null,
  env: CsSyncEnv,
  fetchImpl: Fetch = fetch,
): Promise<Result> {
  const scheduled =
    !!env.workerSecret && !!authorization && sameSecret(authorization, `Bearer ${env.workerSecret}`);
  const company = String(body.company ?? "");
  if (!scheduled) {
    if (!authorization?.startsWith("Bearer ")) return { status: 401, body: { error: "Autenticação necessária." } };
    if (!UUID.test(company)) return { status: 400, body: { error: "Informe a empresa." } };
  }
  const auth = scheduled
    ? { authorization: null, secret: env.workerSecret! }
    : { authorization, secret: null };
  const targets = await callRpc<Target[]>(env, fetchImpl, auth.authorization, "cs_sync_targets", {
    p_secret: auth.secret,
    p_company: scheduled ? null : company,
  });
  if (!targets.ok) return { status: targets.status, body: { error: targets.error } };
  const results = [];
  for (const t of targets.data ?? [])
    results.push(
      await syncOne(env, fetchImpl, auth, t, scheduled ? "schedule" : "manual", !scheduled && body.allow_removals === true),
    );
  return { status: 200, body: { results } };
}

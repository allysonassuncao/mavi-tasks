import { callRpc, disposition, signGcsUrl, type DriveEnv } from "./_drive.js";

/**
 * Tutoriais, no servidor (ações "tutorial-*" de /api/drive). O banco decide
 * tudo (migration 20270415090000_tutorials): cada ação chama uma função como
 * a pessoa, que só devolve o caminho do vídeo quando é permitido; o
 * navegador recebe links assinados, nunca o caminho.
 *
 * - "tutorial-sign-upload": PUT de um vídeo que a própria pessoa preparou,
 *   com o tipo e o tamanho declarados;
 * - "tutorial-media": links de leitura de até 60 vídeos. Valem 4 horas: um
 *   vídeo longo pausado e retomado continua tocando;
 * - "tutorial-delete": o banco apaga o tutorial e devolve os caminhos dos
 *   vídeos, removidos do bucket aqui.
 */
export type TutorialsRequest =
  | { action: "tutorial-sign-upload"; media: string }
  | { action: "tutorial-media"; media: string[] }
  | { action: "tutorial-delete"; tutorial: string };

type Fetch = typeof fetch;
type Target = { id: string; path: string; name: string; content_type: string };

const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const ids = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter(isId))].slice(0, 60) : [];

export async function handleTutorials(
  body: unknown,
  authorization: string | null,
  env: DriveEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = (body ?? {}) as Record<string, unknown>;
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!env.credentials?.client_email || !env.credentials.private_key)
    return fail(500, "Credenciais do Google Cloud Storage não configuradas.");
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");
  const creds = env.credentials;

  if (req.action === "tutorial-sign-upload") {
    if (!isId(req.media)) return fail(400, "Vídeo inválido.");
    const target = await callRpc<
      { path: string; content_type: string; size_bytes: number }[]
    >(env, fetchImpl, authorization, "tutorial_upload_target", {
      p_media: req.media,
    });
    const file = target.ok ? target.data[0] : undefined;
    if (!file) return fail(403, "Envio não autorizado ou expirado.");
    const range = `0,${file.size_bytes}`;
    return {
      status: 200,
      body: {
        url: signGcsUrl(creds, env.bucket, file.path, "PUT", {
          contentType: file.content_type,
          headers: { "x-goog-content-length-range": range },
        }),
        headers: {
          "Content-Type": file.content_type,
          "x-goog-content-length-range": range,
        },
      },
    };
  }

  if (req.action === "tutorial-media") {
    const media = ids(req.media);
    if (!media.length) return { status: 200, body: { urls: {} } };
    const found = await callRpc<Target[]>(
      env,
      fetchImpl,
      authorization,
      "tutorial_media_targets",
      { p_ids: media },
    );
    if (!found.ok) return fail(found.status, found.error);
    return {
      status: 200,
      body: {
        urls: Object.fromEntries(
          found.data.map((t) => [
            t.id,
            signGcsUrl(creds, env.bucket, t.path, "GET", {
              expiresInSeconds: 4 * 3600,
              query: {
                "response-content-disposition": disposition("inline", t.name),
              },
            }),
          ]),
        ),
      },
    };
  }

  if (req.action === "tutorial-delete") {
    if (!isId(req.tutorial)) return fail(400, "Tutorial inválido.");
    const r = await callRpc<string[]>(
      env,
      fetchImpl,
      authorization,
      "delete_tutorial",
      { p_tutorial: req.tutorial },
    );
    if (!r.ok) return fail(r.status, r.error);
    // Removidos do banco; um objeto que não sai só fica sem registro.
    const results = await Promise.all(
      (r.data ?? []).map((path) =>
        fetchImpl(signGcsUrl(creds, env.bucket, path, "DELETE"), {
          method: "DELETE",
        })
          .then((x) => x.ok || x.status === 404)
          .catch(() => false),
      ),
    );
    return {
      status: 200,
      body: { ok: true, storage: results.every(Boolean), removed: results.length },
    };
  }

  return fail(400, "Ação inválida.");
}

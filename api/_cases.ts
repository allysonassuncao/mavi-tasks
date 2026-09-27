import { callRpc, disposition, signGcsUrl, type DriveEnv } from "./_drive.js";

/**
 * Cases de Sucesso, no servidor (ações "case-*" de /api/drive). O banco
 * decide tudo (migration 20261029090000_success_cases): cada ação chama uma
 * função como a pessoa (ou anônima, no link público) que só devolve o
 * caminho da mídia quando é permitido; o navegador recebe links assinados
 * de poucos minutos, nunca o caminho.
 *
 * - "case-sign-upload": PUT de uma mídia que a própria pessoa preparou,
 *   com o tipo e o tamanho declarados;
 * - "case-media": links de leitura (inline para ver, ou download) de até
 *   60 mídias de uma vez (a grade de capas pede várias);
 * - "case-public-media": o mesmo, pelo token do link do lead;
 * - "case-delete-media", "case-delete", "case-review", "case-discard-draft":
 *   o banco apaga os registros e devolve os caminhos que saíram, que são
 *   removidos do bucket aqui.
 */
export type CasesRequest =
  | { action: "case-sign-upload"; media: string }
  | { action: "case-media"; media: string[]; inline?: boolean }
  | {
      action: "case-public-media";
      token: string;
      media: string[];
      inline?: boolean;
    }
  | { action: "case-delete-media"; media: string }
  | { action: "case-delete"; case: string }
  | { action: "case-review"; case: string; approve: boolean; note?: string }
  | { action: "case-discard-draft"; case: string };

type Fetch = typeof fetch;
type Target = { id: string; path: string; name: string; content_type: string };

const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const ids = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter(isId))].slice(0, 60) : [];

export async function handleCases(
  body: unknown,
  authorization: string | null,
  env: DriveEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = (body ?? {}) as Record<string, unknown>;
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!env.credentials?.client_email || !env.credentials.private_key)
    return fail(500, "Credenciais do Google Cloud Storage não configuradas.");
  const creds = env.credentials;
  const read = (targets: Target[], inline: boolean) =>
    Object.fromEntries(
      targets.map((t) => [
        t.id,
        signGcsUrl(creds, env.bucket, t.path, "GET", {
          expiresInSeconds: 900,
          query: {
            "response-content-disposition": disposition(
              inline ? "inline" : "attachment",
              t.name,
            ),
          },
        }),
      ]),
    );
  // Removidos do banco; um objeto que não sai só fica sem registro.
  const remove = async (paths: unknown) => {
    const list = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === "string" && !!p)
      : [];
    const results = await Promise.all(
      list.map((path) =>
        fetchImpl(signGcsUrl(creds, env.bucket, path, "DELETE"), {
          method: "DELETE",
        })
          .then((r) => r.ok || r.status === 404)
          .catch(() => false),
      ),
    );
    return results.every(Boolean);
  };

  if (req.action === "case-public-media") {
    if (typeof req.token !== "string" || !/^[0-9a-f]{64}$/.test(req.token))
      return fail(404, "Link inválido ou case indisponível.");
    const media = ids(req.media);
    if (!media.length) return { status: 200, body: { urls: {} } };
    const found = await callRpc<Target[]>(
      env,
      fetchImpl,
      null,
      "success_case_public_media",
      { p_token: req.token, p_ids: media },
    );
    if (!found.ok) return fail(404, "Link inválido ou case indisponível.");
    return { status: 200, body: { urls: read(found.data, !!req.inline) } };
  }

  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");

  if (req.action === "case-sign-upload") {
    if (!isId(req.media)) return fail(400, "Mídia inválida.");
    const target = await callRpc<
      { path: string; content_type: string; size_bytes: number }[]
    >(env, fetchImpl, authorization, "success_case_upload_target", {
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

  if (req.action === "case-media") {
    const media = ids(req.media);
    if (!media.length) return { status: 200, body: { urls: {} } };
    const found = await callRpc<Target[]>(
      env,
      fetchImpl,
      authorization,
      "success_case_media_targets",
      { p_ids: media },
    );
    if (!found.ok) return fail(found.status, found.error);
    return { status: 200, body: { urls: read(found.data, !!req.inline) } };
  }

  if (req.action === "case-delete-media") {
    if (!isId(req.media)) return fail(400, "Mídia inválida.");
    const r = await callRpc<string | null>(
      env,
      fetchImpl,
      authorization,
      "delete_success_case_media",
      { p_media: req.media },
    );
    if (!r.ok) return fail(r.status, r.error);
    // null: a remoção só vale quando a alteração for aprovada.
    const storage = r.data ? await remove([r.data]) : true;
    return { status: 200, body: { deleted: !!r.data, storage } };
  }

  if (
    req.action === "case-delete" ||
    req.action === "case-review" ||
    req.action === "case-discard-draft"
  ) {
    if (!isId(req.case)) return fail(400, "Case inválido.");
    const r =
      req.action === "case-delete"
        ? await callRpc<string[]>(
            env,
            fetchImpl,
            authorization,
            "delete_success_case",
            { p_case: req.case },
          )
        : req.action === "case-discard-draft"
          ? await callRpc<string[]>(
              env,
              fetchImpl,
              authorization,
              "discard_success_case_draft",
              { p_case: req.case },
            )
          : await callRpc<string[]>(
              env,
              fetchImpl,
              authorization,
              "review_success_case",
              {
                p_case: req.case,
                p_approve: req.approve === true,
                p_note: typeof req.note === "string" ? req.note : null,
              },
            );
    if (!r.ok) return fail(r.status, r.error);
    return {
      status: 200,
      body: {
        ok: true,
        storage: await remove(r.data),
        removed: r.data?.length ?? 0,
      },
    };
  }

  return fail(400, "Ação inválida.");
}

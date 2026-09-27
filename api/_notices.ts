import { callRpc, disposition, signGcsUrl, type DriveEnv } from "./_drive.js";

/**
 * Mural de avisos, no servidor (ações "notice-*" de /api/drive). O banco
 * decide tudo (migration 20261106090000_notice_board): cada ação chama uma
 * função como a pessoa, que só devolve o caminho do anexo quando é
 * permitido; o navegador recebe links assinados de poucos minutos, nunca o
 * caminho.
 *
 * - "notice-sign-upload": PUT de um anexo que a própria pessoa preparou,
 *   com o tipo e o tamanho declarados;
 * - "notice-files": links de leitura (inline para ver, ou download) de até
 *   60 anexos de uma vez — enviados agora ou arquivos do Drive, que o aviso
 *   dá a quem o recebeu o direito de abrir;
 * - "notice-delete-file", "notice-delete": o banco apaga os registros e
 *   devolve os caminhos enviados que saíram, removidos do bucket aqui (um
 *   arquivo do Drive continua no Drive).
 */
export type NoticesRequest =
  | { action: "notice-sign-upload"; attachment: string }
  | { action: "notice-files"; attachments: string[]; inline?: boolean }
  | { action: "notice-delete-file"; attachment: string }
  | { action: "notice-delete"; notice: string };

type Fetch = typeof fetch;
type Target = { id: string; path: string; name: string; content_type: string };

const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const ids = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter(isId))].slice(0, 60) : [];

export async function handleNotices(
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

  if (req.action === "notice-sign-upload") {
    if (!isId(req.attachment)) return fail(400, "Anexo inválido.");
    const target = await callRpc<
      { path: string; content_type: string; size_bytes: number }[]
    >(env, fetchImpl, authorization, "notice_upload_target", {
      p_attachment: req.attachment,
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

  if (req.action === "notice-files") {
    const list = ids(req.attachments);
    if (!list.length) return { status: 200, body: { urls: {} } };
    const found = await callRpc<Target[]>(
      env,
      fetchImpl,
      authorization,
      "notice_attachment_targets",
      { p_ids: list },
    );
    if (!found.ok) return fail(found.status, found.error);
    const inline = !!req.inline;
    return {
      status: 200,
      body: {
        urls: Object.fromEntries(
          found.data.map((t) => [
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
        ),
      },
    };
  }

  if (req.action === "notice-delete-file") {
    if (!isId(req.attachment)) return fail(400, "Anexo inválido.");
    const r = await callRpc<string | null>(
      env,
      fetchImpl,
      authorization,
      "delete_notice_attachment",
      { p_attachment: req.attachment },
    );
    if (!r.ok) return fail(r.status, r.error);
    return {
      status: 200,
      body: { deleted: true, storage: r.data ? await remove([r.data]) : true },
    };
  }

  if (req.action === "notice-delete") {
    if (!isId(req.notice)) return fail(400, "Aviso inválido.");
    const r = await callRpc<string[]>(
      env,
      fetchImpl,
      authorization,
      "delete_notice",
      { p_notice: req.notice },
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

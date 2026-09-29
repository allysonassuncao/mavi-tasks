import crypto from "node:crypto";

/**
 * Drive server logic shared by the Vercel function (api/drive.ts) and the Vite
 * dev middleware. Permissions are enforced by the database: each action calls
 * a SECURITY DEFINER function as the requesting user (or anonymously, for
 * public links), which returns the object path only when allowed. Clients
 * never see paths; they get short-lived signed URLs.
 *
 * Files prefixed with "_" in api/ are not deployed as functions by Vercel.
 */

export type GcsCredentials = { client_email: string; private_key: string };
export type DriveEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  bucket: string;
  credentials: GcsCredentials | null;
};
type Fetch = typeof fetch;

const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

/** GCS V4 signed URL for PUT (upload), GET (download) or DELETE. */
export function signGcsUrl(
  creds: GcsCredentials,
  bucket: string,
  objectPath: string,
  method: "PUT" | "GET" | "DELETE",
  options: {
    contentType?: string;
    /** Extra signed headers the client must send, e.g. x-goog-content-length-range. */
    headers?: Record<string, string>;
    query?: Record<string, string>;
    expiresInSeconds?: number;
    now?: Date;
  } = {},
) {
  const now = options.now ?? new Date();
  const iso = now.toISOString();
  const dateStamp = iso.slice(0, 10).replace(/-/g, "");
  const timestamp = `${dateStamp}T${iso.slice(11, 19).replace(/:/g, "")}Z`;
  const credentialScope = `${dateStamp}/auto/storage/goog4_request`;
  const headers: Record<string, string> = {
    host: "storage.googleapis.com",
    ...(options.contentType
      ? { "content-type": options.contentType.trim() }
      : {}),
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v.trim(),
      ]),
    ),
  };
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(";");
  const params: Record<string, string> = {
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${creds.client_email}/${credentialScope}`,
    "X-Goog-Date": timestamp,
    "X-Goog-Expires": String(options.expiresInSeconds ?? 900),
    "X-Goog-SignedHeaders": signedHeaders,
    ...options.query,
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join("&");
  const canonicalUri = `/${bucket}/${objectPath
    .replace(/^\/+/, "")
    .split("/")
    .map(rfc3986)
    .join("/")}`;
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "GOOG4-RSA-SHA256",
    timestamp,
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(stringToSign)
    .sign(creds.private_key, "hex");
  return `https://storage.googleapis.com${canonicalUri}?${canonicalQuery}&X-Goog-Signature=${signature}`;
}

/** Calls a database function through PostgREST, as the user or anonymously. */
export async function callRpc<T>(
  env: Pick<DriveEnv, "supabaseUrl" | "supabaseKey">,
  fetchImpl: Fetch,
  authorization: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<
  { ok: true; data: T } | { ok: false; status: number; error: string }
> {
  const res = await fetchImpl(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.supabaseKey,
      Authorization: authorization ?? `Bearer ${env.supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok)
    return {
      ok: false,
      status: res.status === 401 || res.status === 403 ? 403 : res.status,
      error: body?.message ?? "Não foi possível acessar o arquivo.",
    };
  return { ok: true, data: body as T };
}

export function disposition(kind: "attachment" | "inline", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${rfc3986(name)}`;
}

export type DriveRequest =
  | { action: "sign-upload"; file: string }
  | { action: "download"; file: string; inline?: boolean }
  | { action: "delete"; file: string }
  /**
   * What each file of a list shows instead of an icon: its thumbnail, or
   * the file itself when the browser still has to make the thumbnail.
   */
  | { action: "thumbs"; files: string[] }
  /** Where the browser stores a thumbnail it made (WebP, up to 1 MB). */
  | { action: "sign-thumb"; file: string; type?: string }
  | { action: "public"; token: string; inline?: boolean }
  /** A file inside a publicly shared folder (or one of its subfolders). */
  | {
      action: "public-folder-file";
      token: string;
      file: string;
      inline?: boolean;
    }
  /**
   * A file sent through a public folder link that accepts uploads
   * (drive_folders.public_upload): the database records it and the answer
   * is where to PUT it. No sign-in.
   */
  | {
      action: "public-upload";
      token: string;
      name: string;
      size: number;
      content_type: string;
    };

export const THUMBS_PER_REQUEST = 200;
/** Signed into the thumbnail upload: at most 1 MB, cached by the browser. */
const THUMB_UPLOAD_HEADERS = {
  "x-goog-content-length-range": "1,1048576",
  "Cache-Control": "private, max-age=7200",
};

/** The browser behind a request, recorded in the Drive audit trail. */
export type RequestOrigin = { ip?: string; user_agent?: string };

export async function handleDrive(
  body: unknown,
  authorization: string | null,
  env: DriveEnv,
  fetchImpl: Fetch = fetch,
  origin: RequestOrigin = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = (body ?? {}) as Partial<DriveRequest> & Record<string, unknown>;
  const fail = (status: number, error: string) => ({
    status,
    body: { error },
  });
  if (!env.credentials?.client_email || !env.credentials.private_key)
    return fail(500, "Credenciais do Google Cloud Storage não configuradas.");
  const creds = env.credentials;
  const isId = (v: unknown): v is string =>
    typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

  if (req.action === "public-upload") {
    if (typeof req.token !== "string" || !/^[0-9a-f]{64}$/.test(req.token))
      return fail(404, "Link inválido ou pasta indisponível.");
    const created = await callRpc<
      { id: string; path: string; content_type: string }[]
    >(env, fetchImpl, null, "drive_public_upload", {
      p_token: req.token,
      p_name: String(req.name ?? "").slice(0, 255),
      p_size: Number(req.size),
      p_content_type: String(req.content_type ?? ""),
      p_origin: origin,
    });
    if (!created.ok) return fail(created.status, created.error);
    const file = created.data[0];
    if (!file) return fail(403, "Envio não autorizado.");
    return {
      status: 200,
      body: {
        file: file.id,
        url: signGcsUrl(creds, env.bucket, file.path, "PUT", {
          contentType: file.content_type,
        }),
        content_type: file.content_type,
      },
    };
  }

  if (req.action === "public" || req.action === "public-folder-file") {
    if (typeof req.token !== "string" || !/^[0-9a-f]{64}$/.test(req.token))
      return fail(404, "Link inválido ou arquivo indisponível.");
    if (req.action === "public-folder-file" && !isId(req.file))
      return fail(404, "Link inválido ou arquivo indisponível.");
    // Anonymous: the database checks the token (and that the file is in
    // the shared folder) and records the access.
    const target = await callRpc<
      { path: string; name: string; content_type: string; size_bytes: number }[]
    >(
      env,
      fetchImpl,
      null,
      req.action === "public"
        ? "drive_public_target"
        : "drive_public_folder_file",
      {
        p_token: req.token,
        ...(req.action === "public" ? {} : { p_file: req.file }),
        p_inline: !!req.inline,
        p_origin: origin,
      },
    );
    const file = target.ok ? target.data[0] : undefined;
    if (!file) return fail(404, "Link inválido ou arquivo indisponível.");
    return {
      status: 200,
      body: {
        name: file.name,
        content_type: file.content_type,
        size_bytes: file.size_bytes,
        url: signGcsUrl(creds, env.bucket, file.path, "GET", {
          expiresInSeconds: 300,
          query: {
            "response-content-disposition": disposition(
              req.inline ? "inline" : "attachment",
              file.name,
            ),
          },
        }),
      },
    };
  }

  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");

  if (req.action === "thumbs") {
    const ids = Array.isArray(req.files)
      ? [...new Set(req.files.filter(isId))].slice(0, THUMBS_PER_REQUEST)
      : [];
    if (!ids.length) return { status: 200, body: { thumbs: {} } };
    const sources = await callRpc<
      { id: string; path: string; ready: boolean }[]
    >(env, fetchImpl, authorization, "drive_thumb_sources", { p_files: ids });
    if (!sources.ok) return fail(sources.status, sources.error);
    // A thumbnail keeps the same URL for the whole hour, so the browser
    // cache serves it again while the folder is browsed.
    const now = new Date();
    const hour = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
    return {
      status: 200,
      body: {
        thumbs: Object.fromEntries(
          sources.data.map((s) => [
            s.id,
            {
              ready: s.ready,
              url: signGcsUrl(
                creds,
                env.bucket,
                s.path,
                "GET",
                s.ready
                  ? { now: hour, expiresInSeconds: 7200 }
                  : { now, expiresInSeconds: 900 },
              ),
            },
          ]),
        ),
      },
    };
  }

  if (!isId(req.file)) return fail(400, "Arquivo inválido.");

  if (req.action === "sign-thumb") {
    const target = await callRpc<{ path: string }[]>(
      env,
      fetchImpl,
      authorization,
      "drive_thumb_target",
      { p_file: req.file },
    );
    const file = target.ok ? target.data[0] : undefined;
    if (!file) return fail(403, "Sem acesso a este arquivo.");
    // WebP; JPEG from browsers that cannot encode WebP.
    const contentType = req.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    return {
      status: 200,
      body: {
        url: signGcsUrl(creds, env.bucket, file.path, "PUT", {
          contentType,
          headers: THUMB_UPLOAD_HEADERS,
        }),
        headers: { "Content-Type": contentType, ...THUMB_UPLOAD_HEADERS },
      },
    };
  }

  if (req.action === "sign-upload") {
    const target = await callRpc<{ path: string; content_type: string }[]>(
      env,
      fetchImpl,
      authorization,
      "drive_upload_target",
      { p_file: req.file },
    );
    const file = target.ok ? target.data[0] : undefined;
    if (!file) return fail(403, "Envio não autorizado.");
    return {
      status: 200,
      body: {
        url: signGcsUrl(creds, env.bucket, file.path, "PUT", {
          contentType: file.content_type,
        }),
        content_type: file.content_type,
      },
    };
  }

  if (req.action === "download") {
    const target = await callRpc<
      { path: string; name: string; content_type: string }[]
    >(env, fetchImpl, authorization, "drive_download_target", {
      p_file: req.file,
      p_inline: !!req.inline,
      p_origin: origin,
    });
    const file = target.ok ? target.data[0] : undefined;
    if (!file) return fail(403, "Sem acesso a este arquivo.");
    return {
      status: 200,
      body: {
        url: signGcsUrl(creds, env.bucket, file.path, "GET", {
          expiresInSeconds: 300,
          query: {
            "response-content-disposition": disposition(
              req.inline ? "inline" : "attachment",
              file.name,
            ),
          },
        }),
      },
    };
  }

  if (req.action === "delete") {
    const removed = await callRpc<string>(
      env,
      fetchImpl,
      authorization,
      "delete_drive_file",
      { p_file: req.file },
    );
    if (!removed.ok) return fail(removed.status, removed.error);
    // The record is gone either way; a failed object removal only leaves an
    // unreachable object behind (its path was never exposed).
    const res = await fetchImpl(
      signGcsUrl(creds, env.bucket, removed.data, "DELETE"),
      { method: "DELETE" },
    ).catch(() => null);
    // The thumbnail, when there is one, goes too.
    await fetchImpl(
      signGcsUrl(creds, env.bucket, `${removed.data}.thumb.webp`, "DELETE"),
      { method: "DELETE" },
    ).catch(() => null);
    return {
      status: 200,
      body: { deleted: true, storage: res && (res.ok || res.status === 404) },
    };
  }

  return fail(400, "Ação inválida.");
}

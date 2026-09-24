import crypto from "node:crypto";
import { callRpc } from "./_drive.js";
import { appOrigin } from "./_origin.js";

/**
 * Agenda: each person's Google Calendar, read and written live through this
 * server (migration 20260930160000_google_calendar keeps only the
 * connection). OAuth runs here with the app's client secret; the refresh and
 * access tokens are sealed with AES-256-GCM under GOOGLE_TOKEN_KEY before
 * they reach the database, and the browser never sees them.
 *
 * Files prefixed with "_" in api/ are not deployed as functions by Vercel.
 */

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";
const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type GoogleEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  clientId: string;
  clientSecret: string;
  /** 32 bytes (GOOGLE_TOKEN_KEY, base64); null when missing or invalid. */
  tokenKey: Buffer | null;
  /** Registered in Google Cloud: <origin>/api/google-callback. */
  redirectUri: string;
};

export function googleEnv(
  env: Record<string, string | undefined> = process.env,
): GoogleEnv {
  const key = env.GOOGLE_TOKEN_KEY
    ? Buffer.from(env.GOOGLE_TOKEN_KEY, "base64")
    : null;
  return {
    supabaseUrl:
      env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co",
    supabaseKey:
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    tokenKey: key && key.length === 32 ? key : null,
    redirectUri:
      env.GOOGLE_REDIRECT_URI || `${appOrigin(env)}/api/google-callback`,
  };
}

// ------------------------------------------------------------ token sealing
/** "v1:" + base64(iv | tag | ciphertext), AES-256-GCM. */
export function seal(key: Buffer, text: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}
export function unseal(key: Buffer, sealed: string) {
  if (!sealed.startsWith("v1:")) throw Error("Token em formato desconhecido.");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    raw.subarray(0, 12),
  );
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

// ------------------------------------------------------------ recurrence
/** 2026-09-24T12:30:00Z → 20260924T123000Z; an all-day date → 20260924. */
export function untilStamp(value: string, allDay: boolean) {
  if (allDay) return value.slice(0, 10).replace(/-/g, "");
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * Ends a series just before an occurrence: every RRULE gets that UNTIL (and
 * loses COUNT); EXDATE/RDATE lines are kept.
 */
export function truncateRecurrence(
  rules: string[],
  beforeStart: string,
  allDay: boolean,
) {
  const until = allDay
    ? untilStamp(
        new Date(
          Date.parse(`${beforeStart.slice(0, 10)}T00:00:00Z`) - 86400000,
        ).toISOString(),
        true,
      )
    : untilStamp(new Date(Date.parse(beforeStart) - 1000).toISOString(), false);
  return rules.map((line) =>
    line.startsWith("RRULE:")
      ? `RRULE:${line
          .slice(6)
          .split(";")
          .filter((p) => p && !/^(COUNT|UNTIL)=/.test(p))
          .concat(`UNTIL=${until}`)
          .join(";")}`
      : line,
  );
}

// ------------------------------------------------------------ Google calls
class GoogleError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
type Fetch = typeof fetch;

async function readError(res: Response) {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string } | string;
    error_description?: string;
  };
  return typeof body.error === "string"
    ? body.error_description || body.error
    : (body.error?.message ?? res.statusText);
}

/** A valid access token for the caller, refreshed (and saved) when needed. */
async function accessToken(
  env: GoogleEnv,
  fetchImpl: Fetch,
  authorization: string,
  force = false,
): Promise<string> {
  const key = env.tokenKey!;
  const found = await callRpc<
    {
      refresh_token_cipher: string;
      access_token_cipher: string | null;
      access_expires_at: string | null;
    }[]
  >(env, fetchImpl, authorization, "google_tokens", {});
  if (!found.ok) throw new GoogleError(found.status, found.error);
  const row = found.data[0];
  if (!row)
    throw new GoogleError(409, "Conecte seu Google Agenda.", "not_connected");
  if (
    !force &&
    row.access_token_cipher &&
    row.access_expires_at &&
    Date.parse(row.access_expires_at) > Date.now() + 60_000
  )
    return unseal(key, row.access_token_cipher);
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: unseal(key, row.refresh_token_cipher),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    const message = body.error_description || body.error || res.statusText;
    // Revoked or expired consent: forget it; the person connects again.
    // (Other errors, e.g. a misconfigured client, keep the connection.)
    if (body.error === "invalid_grant") {
      await callRpc(env, fetchImpl, authorization, "google_disconnect", {});
      throw new GoogleError(
        409,
        "A conexão com o Google expirou. Conecte sua agenda novamente.",
        "not_connected",
      );
    }
    throw new GoogleError(502, `Google: ${message}`);
  }
  const token = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  await callRpc(env, fetchImpl, authorization, "google_save_access", {
    p_access_cipher: seal(key, token.access_token),
    p_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  });
  return token.access_token;
}

/** Calls the Calendar API; a 401 refreshes the token once and retries. */
function calendarClient(
  env: GoogleEnv,
  fetchImpl: Fetch,
  authorization: string,
) {
  let token: Promise<string> | null = null;
  return async function call<T>(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<T> {
    token ??= accessToken(env, fetchImpl, authorization);
    const res = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (res.status === 401 && retry) {
      token = accessToken(env, fetchImpl, authorization, true);
      return call<T>(path, init, false);
    }
    if (!res.ok) {
      const message = await readError(res);
      throw new GoogleError(
        res.status === 404 ? 404 : res.status === 403 ? 403 : 502,
        res.status === 404
          ? "Evento ou agenda não encontrado."
          : `Google: ${message}`,
      );
    }
    return (res.status === 204 ? null : await res.json()) as T;
  };
}

// ------------------------------------------------------------ events
type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurringEventId?: string;
  recurrence?: string[];
  attendees?: {
    email: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
  }[];
  organizer?: { email?: string; self?: boolean };
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  htmlLink?: string;
  colorId?: string;
};
export type AgendaEvent = {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** ISO date (all day, end exclusive) or date-time. */
  start: string;
  end: string;
  timeZone?: string;
  recurringEventId?: string;
  attendees: {
    email: string;
    name?: string;
    response?: string;
    organizer?: boolean;
    self?: boolean;
  }[];
  meetUrl?: string;
  htmlLink?: string;
  colorId?: string;
  organizerSelf: boolean;
  canEdit: boolean;
};
const EVENT_FIELDS =
  "id,status,summary,description,location,start,end,recurringEventId,attendees(email,displayName,responseStatus,organizer,self),organizer(email,self),hangoutLink,conferenceData(entryPoints(entryPointType,uri)),htmlLink,colorId";

export function toAgendaEvent(
  e: GoogleEvent,
  calendarId: string,
  writable: boolean,
): AgendaEvent {
  const allDay = !!e.start?.date;
  const organizerSelf = e.organizer?.self ?? true;
  return {
    id: e.id,
    calendarId,
    title: e.summary ?? "(sem título)",
    description: e.description ?? "",
    location: e.location ?? "",
    allDay,
    start: (allDay ? e.start?.date : e.start?.dateTime) ?? "",
    end: (allDay ? e.end?.date : e.end?.dateTime) ?? "",
    timeZone: e.start?.timeZone,
    recurringEventId: e.recurringEventId,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email,
      name: a.displayName,
      response: a.responseStatus,
      organizer: a.organizer,
      self: a.self,
    })),
    meetUrl:
      e.hangoutLink ??
      e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")
        ?.uri,
    htmlLink: e.htmlLink,
    colorId: e.colorId,
    organizerSelf,
    canEdit: writable && organizerSelf,
  };
}

export type EventInput = {
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  start: string;
  end: string;
  timeZone?: string;
  /** RRULE lines, or null for a single event. */
  recurrence?: string[] | null;
  attendees?: string[];
  meet?: boolean;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The Google event body for an input; validates what it can. */
export function eventBody(
  input: EventInput,
  opts: { withRecurrence: boolean; hadMeet: boolean; patch?: boolean },
) {
  const title = String(input.title ?? "").trim();
  if (!title || title.length > 1024)
    throw new GoogleError(400, "Informe o título do evento.");
  const valid = input.allDay
    ? /^\d{4}-\d{2}-\d{2}$/.test(input.start) &&
      /^\d{4}-\d{2}-\d{2}$/.test(input.end)
    : !Number.isNaN(Date.parse(input.start)) &&
      !Number.isNaN(Date.parse(input.end));
  if (!valid) throw new GoogleError(400, "Datas inválidas.");
  if (
    input.allDay
      ? input.end < input.start
      : Date.parse(input.end) < Date.parse(input.start)
  )
    throw new GoogleError(400, "O fim precisa ser depois do início.");
  const attendees = (input.attendees ?? [])
    .map((a) => String(a).trim().toLowerCase())
    .filter(Boolean);
  if (attendees.length > 100 || attendees.some((a) => !EMAIL.test(a)))
    throw new GoogleError(400, "Confira os e-mails dos convidados.");
  const recurrence = (input.recurrence ?? []).filter((r) =>
    /^(RRULE|EXDATE|RDATE|EXRULE):/.test(r),
  );
  // Editing may switch between all-day and timed: the other field is cleared.
  const when = (value: string) =>
    input.allDay
      ? { date: value, ...(opts.patch ? { dateTime: null } : {}) }
      : {
          dateTime: value,
          timeZone: input.timeZone || "America/Sao_Paulo",
          ...(opts.patch ? { date: null } : {}),
        };
  return {
    summary: title,
    description: String(input.description ?? "").slice(0, 8000),
    location: String(input.location ?? "").slice(0, 1024),
    start: when(input.start),
    end: when(input.end),
    attendees: [...new Set(attendees)].map((email) => ({ email })),
    ...(opts.withRecurrence ? { recurrence } : {}),
    ...(input.meet && !opts.hadMeet
      ? {
          conferenceData: {
            createRequest: {
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : !input.meet && opts.hadMeet
        ? { conferenceData: null }
        : {}),
  };
}

// ------------------------------------------------------------ handlers
export type GoogleRequest =
  | { action: "connect" }
  | { action: "disconnect" }
  | { action: "calendars" }
  | {
      action: "events";
      calendars: { id: string; writable: boolean }[];
      from: string;
      to: string;
    }
  | { action: "series"; calendarId: string; eventId: string }
  | {
      action: "save";
      calendarId: string;
      eventId?: string;
      /** For an occurrence of a series: only it, or it and the next ones. */
      scope?: "this" | "following";
      recurringEventId?: string;
      /** The occurrence's original start (for "following"). */
      instanceStart?: string;
      hadMeet?: boolean;
      event: EventInput;
    }
  | {
      action: "delete";
      calendarId: string;
      eventId: string;
      scope?: "this" | "following";
      recurringEventId?: string;
      instanceStart?: string;
    };

const idOk = (v: unknown, max = 1024): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\s/?#]/.test(v);

export async function handleGoogle(
  body: unknown,
  authorization: string | null,
  env: GoogleEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string, code?: string) => ({
    status,
    body: code ? { error, code } : { error },
  });
  if (!env.clientId || !env.clientSecret || !env.tokenKey)
    return fail(
      500,
      "Integração com o Google não configurada no servidor.",
      "not_configured",
    );
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Autenticação necessária.");
  const req = (body ?? {}) as Partial<GoogleRequest> & Record<string, unknown>;
  try {
    if (req.action === "connect") {
      const state = await callRpc<string>(
        env,
        fetchImpl,
        authorization,
        "google_begin_connect",
        {},
      );
      if (!state.ok) return fail(state.status, state.error);
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: env.clientId,
        redirect_uri: env.redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPE,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state: state.data,
      }).toString();
      return { status: 200, body: { url: url.toString() } };
    }

    if (req.action === "disconnect") {
      const found = await callRpc<{ refresh_token_cipher: string }[]>(
        env,
        fetchImpl,
        authorization,
        "google_tokens",
        {},
      );
      const row = found.ok ? found.data[0] : undefined;
      if (row)
        await fetchImpl(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(unseal(env.tokenKey, row.refresh_token_cipher))}`,
          {
            method: "POST",
          },
        ).catch(() => null);
      await callRpc(env, fetchImpl, authorization, "google_disconnect", {});
      return { status: 200, body: { disconnected: true } };
    }

    const call = calendarClient(env, fetchImpl, authorization);

    if (req.action === "calendars") {
      const list = await call<{ items?: Record<string, unknown>[] }>(
        "/users/me/calendarList?maxResults=250&fields=items(id,summary,summaryOverride,backgroundColor,foregroundColor,primary,accessRole,selected,timeZone)",
      );
      return {
        status: 200,
        body: {
          calendars: (list.items ?? []).map((c) => ({
            id: c.id,
            name:
              (c.summaryOverride as string) ||
              (c.summary as string) ||
              String(c.id),
            color: (c.backgroundColor as string) || "#2a78d6",
            primary: !!c.primary,
            writable: c.accessRole === "owner" || c.accessRole === "writer",
            selected: !!c.selected || !!c.primary,
            timeZone: c.timeZone,
          })),
        },
      };
    }

    if (req.action === "events") {
      const calendars = Array.isArray(req.calendars)
        ? req.calendars.slice(0, 25)
        : [];
      const { from, to } = req as { from?: string; to?: string };
      if (
        !from ||
        !to ||
        Number.isNaN(Date.parse(from)) ||
        Number.isNaN(Date.parse(to)) ||
        Date.parse(to) - Date.parse(from) > 400 * 86400000
      )
        return fail(400, "Período inválido.");
      const failed: string[] = [];
      const lists = await Promise.all(
        calendars
          .filter((c): c is { id: string; writable: boolean } => idOk(c?.id))
          .map(async (c) => {
            const events: AgendaEvent[] = [];
            let page: string | undefined;
            try {
              // Recurring events come expanded into their occurrences.
              for (let i = 0; i < 5; i++) {
                const q = new URLSearchParams({
                  timeMin: new Date(from).toISOString(),
                  timeMax: new Date(to).toISOString(),
                  singleEvents: "true",
                  orderBy: "startTime",
                  maxResults: "2500",
                  fields: `items(${EVENT_FIELDS}),nextPageToken`,
                  ...(page ? { pageToken: page } : {}),
                });
                const res = await call<{
                  items?: GoogleEvent[];
                  nextPageToken?: string;
                }>(`/calendars/${encodeURIComponent(c.id)}/events?${q}`);
                for (const e of res.items ?? [])
                  if (e.status !== "cancelled")
                    events.push(toAgendaEvent(e, c.id, !!c.writable));
                page = res.nextPageToken;
                if (!page) break;
              }
            } catch (e) {
              if (e instanceof GoogleError && e.code === "not_connected")
                throw e;
              failed.push(c.id);
            }
            return events;
          }),
      );
      return { status: 200, body: { events: lists.flat(), failed } };
    }

    if (req.action === "series") {
      if (!idOk(req.calendarId) || !idOk(req.eventId))
        return fail(400, "Evento inválido.");
      const master = await call<GoogleEvent>(
        `/calendars/${encodeURIComponent(req.calendarId)}/events/${encodeURIComponent(req.eventId)}?fields=id,recurrence,start,end`,
      );
      return {
        status: 200,
        body: {
          recurrence: master.recurrence ?? [],
          start: master.start,
          end: master.end,
        },
      };
    }

    if (req.action === "save") {
      if (!idOk(req.calendarId)) return fail(400, "Agenda inválida.");
      const input = req.event as EventInput;
      const cal = `/calendars/${encodeURIComponent(req.calendarId)}/events`;
      const opts = "conferenceDataVersion=1&sendUpdates=all";
      if (!req.eventId) {
        const created = await call<GoogleEvent>(`${cal}?${opts}`, {
          method: "POST",
          body: JSON.stringify(
            eventBody(input, { withRecurrence: true, hadMeet: false }),
          ),
        });
        return {
          status: 200,
          body: { event: toAgendaEvent(created, req.calendarId, true) },
        };
      }
      if (!idOk(req.eventId)) return fail(400, "Evento inválido.");
      // An occurrence and the next ones: the series ends before it and a
      // new series (or single event) starts with the changes.
      if (
        req.scope === "following" &&
        idOk(req.recurringEventId) &&
        req.instanceStart
      ) {
        const master = await call<GoogleEvent>(
          `${cal}/${encodeURIComponent(req.recurringEventId)}?fields=id,recurrence,start`,
        );
        const allDay = !!master.start?.date;
        const first = allDay
          ? master.start?.date === req.instanceStart.slice(0, 10)
          : Date.parse(master.start?.dateTime ?? "") ===
            Date.parse(req.instanceStart);
        if (first) {
          const updated = await call<GoogleEvent>(
            `${cal}/${encodeURIComponent(req.recurringEventId)}?${opts}`,
            {
              method: "PATCH",
              body: JSON.stringify(
                eventBody(input, {
                  withRecurrence: true,
                  hadMeet: !!req.hadMeet,
                  patch: true,
                }),
              ),
            },
          );
          return {
            status: 200,
            body: { event: toAgendaEvent(updated, req.calendarId, true) },
          };
        }
        await call(
          `${cal}/${encodeURIComponent(req.recurringEventId)}?sendUpdates=all`,
          {
            method: "PATCH",
            body: JSON.stringify({
              recurrence: truncateRecurrence(
                master.recurrence ?? [],
                req.instanceStart,
                allDay,
              ),
            }),
          },
        );
        const created = await call<GoogleEvent>(`${cal}?${opts}`, {
          method: "POST",
          body: JSON.stringify(
            eventBody(input, { withRecurrence: true, hadMeet: false }),
          ),
        });
        return {
          status: 200,
          body: { event: toAgendaEvent(created, req.calendarId, true) },
        };
      }
      // A single event, or only this occurrence (Google keeps it as an exception).
      const updated = await call<GoogleEvent>(
        `${cal}/${encodeURIComponent(req.eventId)}?${opts}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            eventBody(input, {
              withRecurrence: !req.recurringEventId,
              hadMeet: !!req.hadMeet,
              patch: true,
            }),
          ),
        },
      );
      return {
        status: 200,
        body: { event: toAgendaEvent(updated, req.calendarId, true) },
      };
    }

    if (req.action === "delete") {
      if (!idOk(req.calendarId) || !idOk(req.eventId))
        return fail(400, "Evento inválido.");
      const cal = `/calendars/${encodeURIComponent(req.calendarId)}/events`;
      if (
        req.scope === "following" &&
        idOk(req.recurringEventId) &&
        req.instanceStart
      ) {
        const master = await call<GoogleEvent>(
          `${cal}/${encodeURIComponent(req.recurringEventId)}?fields=id,recurrence,start`,
        );
        const allDay = !!master.start?.date;
        const first = allDay
          ? master.start?.date === req.instanceStart.slice(0, 10)
          : Date.parse(master.start?.dateTime ?? "") ===
            Date.parse(req.instanceStart);
        if (first)
          await call(
            `${cal}/${encodeURIComponent(req.recurringEventId)}?sendUpdates=all`,
            { method: "DELETE" },
          );
        else
          await call(
            `${cal}/${encodeURIComponent(req.recurringEventId)}?sendUpdates=all`,
            {
              method: "PATCH",
              body: JSON.stringify({
                recurrence: truncateRecurrence(
                  master.recurrence ?? [],
                  req.instanceStart,
                  allDay,
                ),
              }),
            },
          );
        return { status: 200, body: { deleted: true } };
      }
      await call(`${cal}/${encodeURIComponent(req.eventId)}?sendUpdates=all`, {
        method: "DELETE",
      });
      return { status: 200, body: { deleted: true } };
    }

    return fail(400, "Ação inválida.");
  } catch (e) {
    if (e instanceof GoogleError) return fail(e.status, e.message, e.code);
    throw e;
  }
}

/**
 * Google's redirect after consent (GET /api/google-callback?code&state):
 * exchanges the code, checks the calendar scope was granted, stores the
 * sealed tokens against the state and sends the person back to the Agenda.
 */
export async function handleGoogleCallback(
  query: URLSearchParams,
  env: GoogleEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; location: string }> {
  const back = (result: string) => ({
    status: 302,
    location: `${new URL(env.redirectUri).origin}/agenda?google=${result}`,
  });
  if (!env.clientId || !env.clientSecret || !env.tokenKey) return back("erro");
  const code = query.get("code");
  const state = query.get("state") ?? "";
  if (query.get("error") || !code) return back("cancelado");
  if (!/^[0-9a-f]{64}$/.test(state)) return back("erro");
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: env.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return back("erro");
  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  if (!token.refresh_token) return back("erro");
  if (!(token.scope ?? "").split(" ").includes(GOOGLE_SCOPE))
    return back("sem-permissao");
  // The primary calendar's id is the account's e-mail.
  const primary = await fetchImpl(
    `${API}/users/me/calendarList/primary?fields=id`,
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
    },
  )
    .then((r) => (r.ok ? r.json() : {}))
    .then((body) => body as { id?: string })
    .catch((): { id?: string } => ({}));
  const stored = await callRpc(
    env,
    fetchImpl,
    null,
    "google_complete_connect",
    {
      p_state: state,
      p_email: primary.id ?? "",
      p_scope: token.scope ?? "",
      p_refresh_cipher: seal(env.tokenKey, token.refresh_token),
      p_access_cipher: seal(env.tokenKey, token.access_token),
      p_expires_at: new Date(
        Date.now() + token.expires_in * 1000,
      ).toISOString(),
    },
  );
  return back(stored.ok ? "conectado" : "expirado");
}

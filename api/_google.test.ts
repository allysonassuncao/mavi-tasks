import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_SCOPE,
  eventBody,
  handleGoogle,
  handleGoogleCallback,
  seal,
  truncateRecurrence,
  unseal,
  type GoogleEnv,
} from "./_google";

const key = crypto.randomBytes(32);
const env: GoogleEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  clientId: "client-id",
  clientSecret: "client-secret",
  tokenKey: key,
  redirectUri: "https://workspace.example.com/api/google-callback",
};
const json = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), { status });

/** A fake network: each route answers by URL (and method), in order. */
function network(
  routes: [RegExp, (init: RequestInit & { url: string }) => Response][],
) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body?.toString(),
    });
    const route = routes.find(([re]) =>
      re.test(`${init.method ?? "GET"} ${url}`),
    );
    if (!route) throw Error(`Rota inesperada: ${init.method ?? "GET"} ${url}`);
    return route[1]({ ...init, url });
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}
const tokens = (access: { cipher: string | null; expires: string | null }) =>
  [
    /POST .*rpc\/google_tokens/,
    () =>
      json([
        {
          refresh_token_cipher: seal(key, "refresh-1"),
          access_token_cipher: access.cipher,
          access_expires_at: access.expires,
        },
      ]),
  ] as [RegExp, () => Response];

describe("tokens e recorrência", () => {
  it("sela e abre tokens; adulteração é detectada", () => {
    const sealed = seal(key, "segredo");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(unseal(key, sealed)).toBe("segredo");
    const raw = Buffer.from(sealed.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => unseal(key, `v1:${raw.toString("base64")}`)).toThrow();
    expect(() => unseal(crypto.randomBytes(32), sealed)).toThrow();
  });
  it("encerra a série antes da ocorrência (tira COUNT, mantém EXDATE)", () => {
    expect(
      truncateRecurrence(
        [
          "RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO",
          "EXDATE;TZID=America/Sao_Paulo:20260928T090000",
        ],
        "2026-10-05T12:00:00Z",
        false,
      ),
    ).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261005T115959Z",
      "EXDATE;TZID=America/Sao_Paulo:20260928T090000",
    ]);
    expect(
      truncateRecurrence(
        ["RRULE:FREQ=DAILY;UNTIL=20270101"],
        "2026-10-05",
        true,
      ),
    ).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261004"]);
  });
  it("monta o corpo do evento e valida", () => {
    const body = eventBody(
      {
        title: " Reunião ",
        allDay: false,
        start: "2026-10-01T12:00:00-03:00",
        end: "2026-10-01T13:00:00-03:00",
        timeZone: "America/Sao_Paulo",
        attendees: ["Ana@Empresa.com", "ana@empresa.com"],
        meet: true,
        recurrence: ["RRULE:FREQ=WEEKLY", "X-INJECT:1"],
      },
      { withRecurrence: true, hadMeet: false },
    );
    expect(body.summary).toBe("Reunião");
    expect(body.attendees).toEqual([{ email: "ana@empresa.com" }]);
    expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(body.conferenceData).toMatchObject({
      createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } },
    });
    expect(body.start).toEqual({
      dateTime: "2026-10-01T12:00:00-03:00",
      timeZone: "America/Sao_Paulo",
    });
    const patch = eventBody(
      {
        title: "Dia todo",
        allDay: true,
        start: "2026-10-01",
        end: "2026-10-02",
        meet: false,
      },
      { withRecurrence: false, hadMeet: true, patch: true },
    );
    expect(patch.start).toEqual({ date: "2026-10-01", dateTime: null });
    expect(patch.conferenceData).toBeNull();
    expect(() =>
      eventBody(
        { title: "", allDay: true, start: "2026-10-01", end: "2026-10-02" },
        { withRecurrence: false, hadMeet: false },
      ),
    ).toThrow(/título/);
    expect(() =>
      eventBody(
        {
          title: "x",
          allDay: false,
          start: "2026-10-01T13:00:00Z",
          end: "2026-10-01T12:00:00Z",
        },
        { withRecurrence: false, hadMeet: false },
      ),
    ).toThrow(/depois/);
    expect(() =>
      eventBody(
        {
          title: "x",
          allDay: true,
          start: "2026-10-01",
          end: "2026-10-02",
          attendees: ["não é email"],
        },
        { withRecurrence: false, hadMeet: false },
      ),
    ).toThrow(/convidados/);
  });
});

describe("handleGoogle", () => {
  it("sem configuração ou sem login, não chama ninguém", async () => {
    const net = network([]);
    expect(
      (
        await handleGoogle(
          { action: "calendars" },
          "Bearer t",
          { ...env, tokenKey: null },
          net.fetch,
        )
      ).body,
    ).toMatchObject({
      code: "not_configured",
    });
    expect(
      (await handleGoogle({ action: "calendars" }, null, env, net.fetch))
        .status,
    ).toBe(401);
    expect(net.calls).toHaveLength(0);
  });
  it("link de consentimento: acesso offline, escopo da agenda e estado do banco", async () => {
    const state = "a".repeat(64);
    const net = network([[/rpc\/google_begin_connect/, () => json(state)]]);
    const res = await handleGoogle(
      { action: "connect" },
      "Bearer t",
      env,
      net.fetch,
    );
    const url = new URL(res.body.url as string);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-id",
      redirect_uri: env.redirectUri,
      scope: GOOGLE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
  });
  it("renova o token vencido, guarda selado e lista os eventos expandidos", async () => {
    const net = network([
      tokens({
        cipher: seal(key, "velho"),
        expires: new Date(Date.now() - 1000).toISOString(),
      }),
      [
        /POST https:\/\/oauth2.googleapis.com\/token/,
        () => json({ access_token: "novo", expires_in: 3600 }),
      ],
      [/rpc\/google_save_access/, () => json(null, 204)],
      [
        /GET https:\/\/www.googleapis.com\/calendar\/v3\/calendars\/primary\/events/,
        (init) => {
          expect((init.headers as Record<string, string>).Authorization).toBe(
            "Bearer novo",
          );
          return json({
            items: [
              {
                id: "e1",
                summary: "Planejamento",
                start: {
                  dateTime: "2026-10-01T12:00:00-03:00",
                  timeZone: "America/Sao_Paulo",
                },
                end: { dateTime: "2026-10-01T13:00:00-03:00" },
                hangoutLink: "https://meet.google.com/abc",
                organizer: { self: true },
              },
              { id: "e2", status: "cancelled" },
            ],
          });
        },
      ],
    ]);
    const res = await handleGoogle(
      {
        action: "events",
        calendars: [{ id: "primary", writable: true }],
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-08T00:00:00Z",
      },
      "Bearer t",
      env,
      net.fetch,
    );
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([
      expect.objectContaining({
        id: "e1",
        title: "Planejamento",
        allDay: false,
        meetUrl: "https://meet.google.com/abc",
        canEdit: true,
      }),
    ]);
    const save = net.calls.find((c) => c.url.includes("google_save_access"))!;
    const saved = JSON.parse(save.body!);
    expect(saved.p_access_cipher).not.toContain("novo");
    expect(unseal(key, saved.p_access_cipher)).toBe("novo");
    const list = net.calls.find((c) => c.url.includes("/events?"))!;
    expect(new URL(list.url).searchParams.get("singleEvents")).toBe("true");
  });
  it("consentimento revogado: desconecta e pede nova conexão", async () => {
    const net = network([
      tokens({ cipher: null, expires: null }),
      [
        /oauth2.googleapis.com\/token/,
        () =>
          json(
            {
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            },
            400,
          ),
      ],
      [/rpc\/google_disconnect/, () => json(null, 204)],
    ]);
    const res = await handleGoogle(
      { action: "calendars" },
      "Bearer t",
      env,
      net.fetch,
    );
    expect(res).toMatchObject({ status: 409, body: { code: "not_connected" } });
    expect(net.calls.some((c) => c.url.includes("google_disconnect"))).toBe(
      true,
    );
  });
  it("erro de configuração do app não derruba a conexão da pessoa", async () => {
    const net = network([
      tokens({ cipher: null, expires: null }),
      [
        /oauth2.googleapis.com\/token/,
        () => json({ error: "invalid_client" }, 401),
      ],
    ]);
    const res = await handleGoogle(
      { action: "calendars" },
      "Bearer t",
      env,
      net.fetch,
    );
    expect(res.status).toBe(502);
    expect(net.calls.some((c) => c.url.includes("google_disconnect"))).toBe(
      false,
    );
  });
  it("editar esta e as próximas: encerra a série e cria uma nova", async () => {
    const valid = {
      cipher: seal(key, "ok"),
      expires: new Date(Date.now() + 3600e3).toISOString(),
    };
    const net = network([
      tokens(valid),
      [
        /GET .*\/events\/serie\?/,
        () =>
          json({
            id: "serie",
            recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
            start: { dateTime: "2026-10-01T12:00:00-03:00" },
          }),
      ],
      [
        /PATCH .*\/events\/serie\?/,
        (init) => {
          expect(JSON.parse(init.body as string)).toEqual({
            recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261015T145959Z"],
          });
          return json({ id: "serie" });
        },
      ],
      [
        /POST .*\/events\?conferenceDataVersion=1&sendUpdates=all/,
        (init) => {
          const body = JSON.parse(init.body as string);
          expect(body.summary).toBe("Novo horário");
          expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TH"]);
          return json({
            id: "nova",
            summary: "Novo horário",
            start: { dateTime: "2026-10-15T15:00:00-03:00" },
            end: { dateTime: "2026-10-15T16:00:00-03:00" },
          });
        },
      ],
    ]);
    const res = await handleGoogle(
      {
        action: "save",
        calendarId: "primary",
        eventId: "serie_20261015T150000Z",
        scope: "following",
        recurringEventId: "serie",
        instanceStart: "2026-10-15T12:00:00-03:00",
        event: {
          title: "Novo horário",
          allDay: false,
          start: "2026-10-15T15:00:00-03:00",
          end: "2026-10-15T16:00:00-03:00",
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
        },
      },
      "Bearer t",
      env,
      net.fetch,
    );
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ id: "nova" });
  });
  it("só esta ocorrência: altera a instância, sem mexer na regra", async () => {
    const valid = {
      cipher: seal(key, "ok"),
      expires: new Date(Date.now() + 3600e3).toISOString(),
    };
    const net = network([
      tokens(valid),
      [
        /PATCH .*\/events\/serie_20261015T150000Z\?/,
        (init) => {
          expect(JSON.parse(init.body as string).recurrence).toBeUndefined();
          return json({
            id: "serie_20261015T150000Z",
            recurringEventId: "serie",
            start: { dateTime: "2026-10-15T15:00:00-03:00" },
            end: { dateTime: "2026-10-15T16:00:00-03:00" },
          });
        },
      ],
    ]);
    const res = await handleGoogle(
      {
        action: "save",
        calendarId: "primary",
        eventId: "serie_20261015T150000Z",
        scope: "this",
        recurringEventId: "serie",
        event: {
          title: "Só hoje",
          allDay: false,
          start: "2026-10-15T15:00:00-03:00",
          end: "2026-10-15T16:00:00-03:00",
        },
      },
      "Bearer t",
      env,
      net.fetch,
    );
    expect(res.status).toBe(200);
  });
  it("recusa ids com caracteres de caminho", async () => {
    const net = network([]);
    const res = await handleGoogle(
      { action: "delete", calendarId: "../users", eventId: "x" },
      "Bearer t",
      env,
      net.fetch,
    );
    expect(res.status).toBe(400);
  });
});

describe("handleGoogleCallback", () => {
  const q = (params: Record<string, string>) => new URLSearchParams(params);
  it("cancelado ou estado inválido volta para a Agenda sem trocar código", async () => {
    const net = network([]);
    expect(
      (
        await handleGoogleCallback(
          q({ error: "access_denied" }),
          env,
          net.fetch,
        )
      ).location,
    ).toBe("https://workspace.example.com/agenda?google=cancelado");
    expect(
      (await handleGoogleCallback(q({ code: "c", state: "x" }), env, net.fetch))
        .location,
    ).toContain("google=erro");
    expect(net.calls).toHaveLength(0);
  });
  it("sem o escopo da agenda, não guarda nada", async () => {
    const net = network([
      [
        /oauth2.googleapis.com\/token/,
        () =>
          json({
            access_token: "a",
            refresh_token: "r",
            expires_in: 3600,
            scope: "openid",
          }),
      ],
    ]);
    const res = await handleGoogleCallback(
      q({ code: "c", state: "b".repeat(64) }),
      env,
      net.fetch,
    );
    expect(res.location).toContain("google=sem-permissao");
    expect(
      net.calls.some((c) => c.url.includes("google_complete_connect")),
    ).toBe(false);
  });
  it("conecta: troca o código e guarda os tokens selados para o estado", async () => {
    const state = "c".repeat(64);
    const net = network([
      [
        /oauth2.googleapis.com\/token/,
        (init) => {
          const body = new URLSearchParams(init.body as string);
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("redirect_uri")).toBe(env.redirectUri);
          return json({
            access_token: "acesso",
            refresh_token: "renova",
            expires_in: 3600,
            scope: `${GOOGLE_SCOPE} openid`,
          });
        },
      ],
      [/calendarList\/primary/, () => json({ id: "ana@empresa.com" })],
      [
        /rpc\/google_complete_connect/,
        (init) => {
          expect((init.headers as Record<string, string>).Authorization).toBe(
            "Bearer publishable",
          );
          const body = JSON.parse(init.body as string);
          expect(body).toMatchObject({
            p_state: state,
            p_email: "ana@empresa.com",
          });
          expect(unseal(key, body.p_refresh_cipher)).toBe("renova");
          expect(body.p_refresh_cipher).not.toContain("renova");
          return json(null, 204);
        },
      ],
    ]);
    const res = await handleGoogleCallback(
      q({ code: "codigo", state }),
      env,
      net.fetch,
    );
    expect(res).toEqual({
      status: 302,
      location: "https://workspace.example.com/agenda?google=conectado",
    });
  });
});

import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleMakeLeads, MAX_LEADS, normalizeLeads } from "./_make-leads";
import type { SyncEnv } from "./_ads-sync";

const env: SyncEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  tokenKey: crypto.randomBytes(32),
  redirectUri: "https://workspace.example.com/api/ads-callback",
  meta: { appId: "app-1", appSecret: "app-secret", version: "v23.0" },
  google: {
    clientId: "client-id",
    clientSecret: "client-secret",
    developerToken: "dev-token",
    version: "v25",
  },
  secret: "s".repeat(40),
  makeLeadsUrl: "https://make.example.com/api/capture/mavi-leads.php",
  makeLeadsSecret: "m".repeat(40),
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function database(answer: (name: string, args: any) => Response) {
  const calls: { name: string; args: any }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const name = url.split("/rpc/")[1];
    const args = JSON.parse(String(init.body));
    calls.push({ name, args });
    return answer(name, args);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

describe("leads da Make: o que entra", () => {
  it("uma vez cada, só os que o MASO contaria", () => {
    expect(
      normalizeLeads([
        { squeeze: "81895b88", lead: "L1", day: "2026-09-20" },
        // Another field of the same lead.
        { squeeze: "81895b88", lead: "L1", day: "2026-09-20" },
        ["12345", " L2 ", "2026-09-21"],
        { squeeze: "0", lead: "L3", day: "2026-09-21" },
        { squeeze: "12345", lead: "", day: "2026-09-21" },
        { squeeze: "12345", lead: "L4", day: "0000-00-00" },
        { squeeze: "12345", lead: "L5", day: "2026-02-30" },
        { squeeze: "a b", lead: "L6", day: "2026-09-21" },
        null,
        "texto",
      ]),
    ).toEqual([
      { squeeze: "81895b88", lead: "L1", day: "2026-09-20" },
      { squeeze: "12345", lead: "L2", day: "2026-09-21" },
    ]);
    expect(normalizeLeads("nada")).toEqual([]);
  });
});

describe("POST /api/make-leads", () => {
  it("sem o segredo da Make: 401, sem tocar no banco", async () => {
    const { fetch, calls } = database(() => json({}));
    expect(
      (await handleMakeLeads({ leads: [] }, "errado", env, fetch)).status,
    ).toBe(401);
    expect((await handleMakeLeads({ leads: [] }, null, env, fetch)).status).toBe(
      401,
    );
    expect(calls).toHaveLength(0);
  });

  it("sem os segredos na Vercel: 503", async () => {
    const { fetch } = database(() => json({}));
    const off = await handleMakeLeads(
      { leads: [] },
      env.makeLeadsSecret,
      { ...env, secret: "" },
      fetch,
    );
    expect(off.status).toBe(503);
    expect(String(off.body.error)).toContain("ADS_SYNC_SECRET");
  });

  it("lead do script de cadastro: grava sem cursor", async () => {
    const { fetch, calls } = database(() => json({ inserted: 1, cursor: 900 }));
    const result = await handleMakeLeads(
      { leads: [{ squeeze: "81895b88", lead: "L1", day: "2026-09-20" }] },
      env.makeLeadsSecret,
      env,
      fetch,
    );
    expect(result).toEqual({
      status: 200,
      body: { received: 1, valid: 1, inserted: 1, cursor: 900 },
    });
    expect(calls).toEqual([
      {
        name: "make_leads_ingest",
        args: {
          p_secret: env.secret,
          p_leads: [{ squeeze: "81895b88", lead: "L1", day: "2026-09-20" }],
          p_cursor: null,
          p_done: false,
        },
      },
    ]);
  });

  it("envio agendado: manda até onde leu e se chegou ao fim", async () => {
    const { fetch, calls } = database(() => json({ inserted: 0, cursor: 5000 }));
    await handleMakeLeads(
      { leads: [], cursor: 5000, done: true },
      env.makeLeadsSecret,
      env,
      fetch,
    );
    expect(calls[0].args).toMatchObject({ p_cursor: 5000, p_done: true });
    // "done" without a cursor doesn't count (only the sender reads the table).
    await handleMakeLeads({ leads: [], done: true }, env.makeLeadsSecret, env, fetch);
    expect(calls[1].args).toMatchObject({ p_cursor: null, p_done: false });
  });

  it("status: de onde o envio agendado continua", async () => {
    const { fetch, calls } = database(() =>
      json({ cursor: 3342518, caught_up_at: null, seen_at: null }),
    );
    const result = await handleMakeLeads(
      { action: "status" },
      env.makeLeadsSecret,
      env,
      fetch,
    );
    expect(result.body).toEqual({
      cursor: 3342518,
      caught_up_at: null,
      seen_at: null,
    });
    expect(calls[0]).toEqual({
      name: "make_leads_status",
      args: { p_secret: env.secret },
    });
  });

  it("lote inválido: 400", async () => {
    const { fetch, calls } = database(() => json({}));
    const send = (body: unknown) =>
      handleMakeLeads(body, env.makeLeadsSecret, env, fetch);
    expect((await send({})).status).toBe(400);
    expect((await send({ leads: [], cursor: -1 })).status).toBe(400);
    expect((await send({ leads: [], cursor: "abc" })).status).toBe(400);
    expect(
      (await send({ leads: Array.from({ length: MAX_LEADS + 1 }, () => ({})) }))
        .status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

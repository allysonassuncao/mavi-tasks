import crypto from "node:crypto";
import { callRpc } from "./_drive.js";
import type { Fetch } from "./_ads.js";
import type { SyncEnv } from "./_ads-sync.js";

/**
 * Campanhas: the Make server sends the leads of its capture pages
 * (migration 20270106090000_make_capture_leads), so the sync counts them
 * here instead of asking the Make (whose dados_capture query timed out).
 * POST /api/make-leads with X-Mavi-Secret (MAKE_LEADS_SECRET, the Make's
 * MAVI_LEADS_SECRET):
 *  - {action: "status"}: where the Make's scheduled sender goes on from (the
 *    last dados_capture id read);
 *  - {leads: [{squeeze, lead, day}], cursor?, done?}: a batch — from the
 *    capture script, one lead as it is saved; from the scheduled sender, the
 *    rows after the cursor, with the last id read and whether it reached the
 *    end of the table.
 */

const SQUEEZE = /^[0-9A-Za-z_-]{1,60}$/;
/** At most this many leads per call (the database takes 20000). */
export const MAX_LEADS = 5000;

export type MakeLead = { squeeze: string; lead: string; day: string };

function validDay(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)
    ? value
    : null;
}

/**
 * The batch's valid leads, once each. Skipped: rows the MASO wouldn't count
 * (no id_lead, page "0") and MySQL's zero dates.
 */
export function normalizeLeads(input: unknown): MakeLead[] {
  if (!Array.isArray(input)) return [];
  const seen = new Map<string, MakeLead>();
  for (const item of input) {
    const row = Array.isArray(item)
      ? { squeeze: item[0], lead: item[1], day: item[2] }
      : (item as Record<string, unknown> | null);
    if (!row || typeof row !== "object") continue;
    const squeeze = String(row.squeeze ?? "").trim();
    const lead = String(row.lead ?? "").trim();
    const day = validDay(row.day);
    if (!SQUEEZE.test(squeeze) || squeeze === "0") continue;
    if (!lead || lead.length > 100 || !day) continue;
    seen.set(JSON.stringify([squeeze, lead, day]), { squeeze, lead, day });
  }
  return [...seen.values()];
}

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handleMakeLeads(
  body: unknown,
  given: string | null,
  env: SyncEnv,
  fetchImpl: Fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (env.makeLeadsSecret.length < 32 || !env.secret)
    return fail(
      503,
      "O recebimento dos leads da Make não está configurado: faltam MAKE_LEADS_SECRET e ADS_SYNC_SECRET na Vercel.",
    );
  if (!given || !sameSecret(given, env.makeLeadsSecret))
    return fail(401, "Não autorizado.");
  const input = (body ?? {}) as {
    action?: unknown;
    leads?: unknown;
    cursor?: unknown;
    done?: unknown;
  };
  if (input.action === "status") {
    const status = await callRpc<Record<string, unknown>>(
      env,
      fetchImpl,
      null,
      "make_leads_status",
      { p_secret: env.secret },
    );
    return status.ok
      ? { status: 200, body: status.data }
      : fail(status.status, status.error);
  }
  if (!Array.isArray(input.leads))
    return fail(400, "Envie os leads (leads: [{squeeze, lead, day}]).");
  if (input.leads.length > MAX_LEADS)
    return fail(400, `Envie no máximo ${MAX_LEADS} leads por vez.`);
  const cursor =
    input.cursor === undefined || input.cursor === null
      ? null
      : Number(input.cursor);
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0))
    return fail(400, "Cursor inválido.");
  const leads = normalizeLeads(input.leads);
  const saved = await callRpc<{ inserted: number; cursor: number }>(
    env,
    fetchImpl,
    null,
    "make_leads_ingest",
    {
      p_secret: env.secret,
      p_leads: leads,
      p_cursor: cursor,
      p_done: cursor !== null && input.done === true,
    },
  );
  if (!saved.ok) return fail(saved.status, saved.error);
  return {
    status: 200,
    body: {
      received: input.leads.length,
      valid: leads.length,
      inserted: saved.data.inserted,
      cursor: saved.data.cursor,
    },
  };
}

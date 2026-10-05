import type { IncomingMessage, ServerResponse } from "node:http";
import { adsEnv } from "./_ads.js";
import { handleAdsSync, syncEnv } from "./_ads-sync.js";
import { handleAdsToday } from "./_ads-today.js";
import { handleBudgetRefresh, handleBudgetSchedule } from "./_ads-budget.js";
import { handleMakeLeads } from "./_make-leads.js";

/**
 * Campanhas: the daily sync of the cycles' numbers (api/_ads-sync.ts), the
 * list's "hoje" reader ({"today": true}, api/_ads-today.ts, which also
 * reads the platforms' budgets, api/_ads-budget.ts), the list's "Atualizar"
 * of a campaign's budget ({"budget": "<campanha>"}) and,
 * at /api/make-leads (vercel.json), the leads the Make server sends
 * (api/_make-leads.ts).
 */
export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Método não permitido" }));
    return;
  }
  let raw = "";
  if (typeof req.body === "object" && req.body !== null) {
    raw = JSON.stringify(req.body);
  } else {
    for await (const chunk of req) raw += chunk;
  }
  const url = new URL(req.url ?? "/", "https://mavi.invalid");
  const makeLeads =
    url.pathname === "/api/make-leads" ||
    url.searchParams.get("make-leads") === "1";
  try {
    const body = JSON.parse(raw || "{}");
    const env = syncEnv(process.env, adsEnv());
    const result = makeLeads
      ? await handleMakeLeads(
          body,
          (req.headers["x-mavi-secret"] as string | undefined) ?? null,
          env,
        )
      : body?.today === true
        ? await readTodayAndBudgets(
            (req.headers["authorization"] as string | undefined) ?? null,
            env,
          )
        : typeof body?.budget === "string"
          ? await handleBudgetRefresh(
              body,
              (req.headers["authorization"] as string | undefined) ?? null,
              env,
            )
          : await handleAdsSync(
              body,
              (req.headers["authorization"] as string | undefined) ?? null,
              env,
            );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/** The "hoje" reader and, side by side, the budgets due (a failure there never fails the "hoje"). */
async function readTodayAndBudgets(authorization: string | null, env: ReturnType<typeof syncEnv>) {
  const [today, budgets] = await Promise.all([
    handleAdsToday(authorization, env),
    handleBudgetSchedule(authorization, env).catch((e: Error) => ({ error: e.message })),
  ]);
  return budgets && today.status === 200
    ? { ...today, body: { ...today.body, budgets } }
    : today;
}

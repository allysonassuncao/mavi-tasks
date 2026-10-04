/**
 * O medidor das APIs de anúncios: conta as chamadas ao Meta e ao Google e
 * percebe a cota (os cabeçalhos de consumo do Meta e os erros de limite),
 * sem mudar as leituras. Usado pelos Insights da MAVI
 * (api/_campaign-insights.ts) e pelo leitor do "hoje" da lista de
 * Campanhas (api/_ads-today.ts); as pausas vão para
 * mavi_private.ad_api_cooldowns.
 */

type Row = Record<string, unknown>;
type Fetch = typeof fetch;

/** O que uma leitura gastou das APIs e o quanto da cota a plataforma diz que já foi. */
export type Throttle = { platform: "meta" | "google"; scope: "account" | "platform"; minutes: number; reason: string };
export type ApiMeter = {
  meta: number;
  google: number;
  /** O maior consumo da cota informado pelo Meta (%), entre todas as respostas. */
  pct: number;
  /** Minutos até liberar, quando o Meta informa. */
  regainMinutes: number;
  throttle: Throttle | null;
};
export const newApiMeter = (): ApiMeter => ({ meta: 0, google: 0, pct: 0, regainMinutes: 0, throttle: null });
/** Os erros de limite do Meta (app, usuário, conta, Business Use Case). */
const META_THROTTLE = new Set([4, 17, 32, 613, ...Array.from({ length: 15 }, (_, i) => 80000 + i)]);

/**
 * O consumo que o Meta informa em cada resposta: X-Business-Use-Case-Usage
 * (por conta e tipo, com o tempo até liberar), X-Ad-Account-Usage,
 * X-FB-Ads-Insights-Throttle e X-App-Usage — o maior percentual vale.
 */
export function metaUsage(headers: Headers) {
  let pct = 0;
  let regain = 0;
  const read = (name: string) => {
    const raw = headers.get(name);
    if (!raw) return;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      return;
    }
    const visit = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(visit);
      if (!x || typeof x !== "object") return;
      for (const [k, val] of Object.entries(x as Row)) {
        if (typeof val === "object") visit(val);
        else if (typeof val === "number") {
          if (["call_count", "total_cputime", "total_time", "acc_id_util_pct", "app_id_util_pct"].includes(k))
            pct = Math.max(pct, val);
          if (k === "estimated_time_to_regain_access") regain = Math.max(regain, val);
          if (k === "reset_time_duration") regain = Math.max(regain, Math.ceil(val / 60));
        }
      }
    };
    visit(v);
  };
  for (const h of ["x-business-use-case-usage", "x-ad-account-usage", "x-fb-ads-insights-throttle", "x-app-usage"])
    read(h);
  return { pct, regain };
}

/** Um fetch que conta as chamadas e percebe a cota (sem mudar as leituras). */
export function meteredFetch(base: Fetch, meter: ApiMeter): Fetch {
  return (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await base(input, init);
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    if (host === "graph.facebook.com") {
      meter.meta++;
      const u = metaUsage(res.headers);
      meter.pct = Math.max(meter.pct, u.pct);
      meter.regainMinutes = Math.max(meter.regainMinutes, u.regain);
      if (!res.ok) {
        const body = (await res.clone().json().catch(() => null)) as { error?: { code?: number } } | null;
        const code = Number(body?.error?.code);
        if (META_THROTTLE.has(code))
          meter.throttle = {
            platform: "meta",
            scope: code === 4 ? "platform" : "account",
            minutes: Math.max(u.regain, code === 4 || code === 17 ? 60 : 15),
            reason: `Meta: limite de requisições (código ${code})`,
          };
      }
    } else if (host === "googleads.googleapis.com") {
      meter.google++;
      if (!res.ok) {
        const text = await res.clone().text().catch(() => "");
        if (/RESOURCE_EXHAUSTED/.test(text)) {
          const delay = Number(/"retryDelay"\s*:\s*"(\d+)s"/.exec(text)?.[1] ?? 0);
          meter.throttle = {
            platform: "google",
            scope: "platform",
            minutes: Math.max(Math.ceil(delay / 60), 60),
            reason: "Google Ads: cota do developer token esgotada (RESOURCE_EXHAUSTED)",
          };
        }
      }
    }
    return res;
  }) as Fetch;
}


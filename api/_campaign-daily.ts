import { callRpc } from "./_drive.js";
import type { LlmAdapter } from "./_ai-llm.js";
import { adapterFor, routeConfig, type ProviderConfig, type ResolvedRoute } from "./_ai-providers.js";
import { workerAuthorized } from "./_copilot.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import { unseal } from "./_google.js";
import { modelPrice } from "./_social-leads.js";
import { readCreatives, type CreativeAd } from "./_campaign-creatives.js";
import { newApiMeter, meteredFetch } from "./_ads-meter.js";
import {
  GOOGLE_OPS_PER_ACCOUNT,
  InsightsError,
  SOFT_LIMIT_PCT,
  ThrottledError,
  accountsOf,
  estimateCost,
  readAnalysis,
  type Analysis,
  type Basis,
  type CampaignInsightsEnv,
  type Entity,
  type InsightMaterial,
  type Level,
  type Numbers,
} from "./_campaign-insights.js";
import { sampledLlm, workerSpot } from "./_ai-samples.js";

/**
 * Campanhas › lista: a Leitura do dia da MAVI (migração
 * 20270403170000_campaign_daily_read).
 *
 * O worker do pg_cron (ação "ai-campaign-daily" de /api/ai): para cada
 * leitura da fila,
 *  1. sem investimento ontem nem hoje, escreve a frase pelas regras (sem a
 *     MAVI e sem a plataforma);
 *  2. lê a plataforma e o CRM como os insights (readAnalysis: campanha,
 *     conjuntos/grupos, anúncios com as copys, público, palavras-chave), com
 *     as mesmas pausas da cota e o mesmo orçamento do Google; os criativos
 *     vêm do cache dos insights (os novos dentro do teto);
 *  3. pede à MAVI (funcionalidade 'campaign_daily'; sem regra, a dos
 *     insights) UMA frase e até 3 pontos, só com números do material;
 *  4. grava (ai_campaign_daily_store). Sem a plataforma (cota, conexão),
 *     escreve com os números do MAVI e avisa na nota; sem a MAVI, pelas regras.
 */

type Row = Record<string, unknown>;

export type DailyMaterial = InsightMaterial & {
  cycle_total: { spend: number; conversions: number; until: string } | null;
  today_read: { spend: number; conversions: number; read_at: string } | null;
  open_insights: { priority: string; kind: string; title: string; action: string }[];
};
export type DailyEnv = CampaignInsightsEnv & { dailyBudgetMs?: number };
export type Tone = "good" | "attention" | "bad";
export type DailyResult = { tone: Tone; headline: string; points: string[] };

const num = (v: unknown) => (typeof v === "number" ? v : Number(v)) || 0;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const brl = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v).replace(/\u00a0/g, " ");
const qty = (v: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(v);
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const between = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const RESULT: Record<string, [string, string]> = {
  lead: ["lead", "leads"],
  message: ["conversa", "conversas"],
  sale: ["venda", "vendas"],
  traffic: ["clique", "cliques"],
  engagement: ["engajamento", "engajamentos"],
  custom: ["conversão", "conversões"],
  video: ["visualização", "visualizações"],
};

// ------------------------------------------------------------ os números do MAVI
/** O ciclo, ontem e hoje como a lista conta (na base de dinheiro da empresa). */
export function dailyNumbers(m: DailyMaterial) {
  const basis: Basis = m.settings.money_basis === "gross" ? "gross" : "net";
  const k = basis === "gross" ? num(m.cycle.multiplier) || 1 : 1;
  const days = between(m.cycle.start_date, m.cycle.end_date) + 1;
  const elapsed = Math.min(Math.max(between(m.cycle.start_date, m.today), 0), days);
  const rows = m.daily.filter((d) => d.day < m.today);
  const spentDays = rows.reduce((s, d) => s + num(d.spend), 0);
  const conversionsDays = rows.reduce((s, d) => s + num(d.conversions), 0);
  const spent = (m.cycle_total ? num(m.cycle_total.spend) : spentDays) * k;
  const conversions = m.cycle_total ? num(m.cycle_total.conversions) : conversionsDays;
  const budget = (num(m.cycle.budget) / (num(m.cycle.multiplier) || 1)) * k;
  const goal = num(m.cycle.goal_results);
  const goalCost = goal > 0 ? budget / goal : null;
  const cost = conversions > 0 ? spent / conversions : null;
  const y = rows.find((d) => d.day === addDays(m.today, -1)) ?? null;
  const t = m.today_read;
  const last7 = rows.filter((d) => d.day >= addDays(m.today, -7));
  return {
    basis,
    days,
    elapsed,
    remaining: Math.max(days - elapsed, 0),
    budget,
    spent,
    expected: elapsed > 0 ? (budget * elapsed) / days : 0,
    conversions,
    goal,
    goalCost,
    cost,
    /** Custo × meta (%): +20 = 20% acima. */
    vsGoal: cost !== null && goalCost ? round((cost / goalCost - 1) * 100, 0) : null,
    projection: elapsed > 0 ? round((conversions / elapsed) * days, 0) : null,
    yesterday: y ? { spend: num(y.spend) * k, conversions: num(y.conversions) } : null,
    today: t ? { spend: num(t.spend) * k, conversions: num(t.conversions), at: t.read_at } : null,
    last7: last7.map((d) => ({ day: d.day, spend: round(num(d.spend) * k), conversions: num(d.conversions) })),
  };
}
export type DailyNumbers = ReturnType<typeof dailyNumbers>;

/** Sem investimento ontem nem hoje (a lista mostra que está parada). */
export const idle = (n: DailyNumbers) => (n.yesterday?.spend ?? 0) <= 0 && (n.today?.spend ?? 0) <= 0;

/**
 * A frase pelas regras: quando não há o que a MAVI ler (sem investimento) ou
 * quando ela não respondeu. Curta e com os números do MAVI.
 */
export function ruleRead(m: DailyMaterial, n: DailyNumbers): DailyResult {
  const [one, many] = RESULT[m.cycle.objective] ?? ["resultado", "resultados"];
  if (idle(n))
    return {
      tone: "attention",
      headline: `Sem investimento ontem${n.today ? " nem hoje" : ""}: confira se a campanha está pausada, sem saldo ou com algum anúncio reprovado.`,
      points: [],
    };
  const points: string[] = [];
  if (n.yesterday)
    points.push(
      n.yesterday.conversions > 0
        ? `Ontem: ${qty(n.yesterday.conversions)} ${n.yesterday.conversions === 1 ? one : many} a ${brl(n.yesterday.spend / n.yesterday.conversions)} cada.`
        : `Ontem: ${brl(n.yesterday.spend)} investidos sem nenhum ${one}.`,
    );
  if (n.expected > 0) {
    const pace = round((n.spent / n.expected - 1) * 100, 0);
    if (Math.abs(pace) >= 15)
      points.push(`O gasto está ${Math.abs(pace)}% ${pace > 0 ? "acima" : "abaixo"} do ritmo da verba do ciclo.`);
  }
  if (n.cost === null)
    return {
      tone: "bad",
      headline: `Nenhum ${one} no ciclo até agora, com ${brl(n.spent)} investidos.`,
      points,
    };
  if (n.vsGoal === null)
    return {
      tone: "attention",
      headline: `${qty(n.conversions)} ${many} no ciclo a ${brl(n.cost)} cada (o ciclo não tem meta de resultados).`,
      points,
    };
  return {
    tone: n.vsGoal <= 0 ? "good" : n.vsGoal <= 15 ? "attention" : "bad",
    headline: `${qty(n.conversions)} ${many} no ciclo a ${brl(n.cost)} cada, ${Math.abs(n.vsGoal)}% ${n.vsGoal <= 0 ? "abaixo" : "acima"} da meta de ${brl(n.goalCost!)}${n.projection !== null && n.goal ? `; no ritmo atual, fecha com ${qty(n.projection)} de ${qty(n.goal)}` : ""}.`,
    points,
  };
}

// ------------------------------------------------------------ o material da MAVI
/** Quantos itens de cada nível vão para a MAVI (os que mais gastaram). */
export const DAILY_LIMITS: Partial<Record<Level, number>> = {
  adset: 6,
  ad: 6,
  keyword: 6,
  search_term: 5,
  segment: 6,
};
const KEEP = [
  "spend",
  "results",
  "cost_per_result",
  "conversions",
  "cost_per_conversion",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "crm_opportunities",
  "crm_rate",
  "crm_won",
  "crm_revenue",
];
const compact = (n: Numbers | undefined) =>
  Object.fromEntries(Object.entries(n ?? {}).filter(([k, v]) => KEEP.includes(k) && v !== null && v !== undefined));

/** Os itens que pesam (por gasto no ciclo, senão nos 7 dias), até o limite de cada nível. */
export function dailyEntities(a: Analysis, scale = 1): Entity[] {
  const spend = (e: Entity) => num(e.n.cycle?.spend ?? e.n.d7?.spend);
  const out: Entity[] = [];
  for (const level of ["campaign", "adset", "ad", "keyword", "search_term", "segment"] as Level[]) {
    const list = a.entities.filter((e) => e.level === level).sort((x, y) => spend(y) - spend(x));
    const cap = level === "campaign" ? 3 : Math.round((DAILY_LIMITS[level] ?? 0) * scale);
    out.push(...list.slice(0, cap));
  }
  return out;
}

export function dailyMessage(m: DailyMaterial, n: DailyNumbers, a: Analysis | null, scale = 1): string {
  const [, many] = RESULT[m.cycle.objective] ?? ["resultado", "resultados"];
  const money = (v: number | null) => (v === null ? null : round(v));
  const material = {
    campanha: m.campaign.name,
    canal: m.campaign.platform === "meta" ? "Meta Ads" : "Google Ads",
    cliente: m.client?.name ?? "",
    produto: m.product?.name ?? "",
    resultado: many,
    destino: m.cycle.destination,
    valores: n.basis === "gross" ? "R$ com M (o que o cliente vê)" : "R$ sem M (o investimento real na plataforma)",
    hoje: m.today,
    ciclo: {
      inicio: m.cycle.start_date,
      fim: m.cycle.end_date,
      dia: `${n.elapsed} de ${n.days} (faltam ${n.remaining})`,
      verba: money(n.budget),
      gasto_ate_ontem: money(n.spent),
      gasto_esperado_ate_ontem: money(n.expected),
      resultados: n.conversions,
      custo_por_resultado: money(n.cost),
      meta_resultados: n.goal || undefined,
      meta_custo_por_resultado: money(n.goalCost) ?? undefined,
      custo_vs_meta: n.vsGoal === null ? undefined : `${n.vsGoal > 0 ? "+" : ""}${n.vsGoal}%`,
      projecao_resultados_no_fim: n.projection ?? undefined,
    },
    ontem: n.yesterday
      ? {
          gasto: money(n.yesterday.spend),
          resultados: n.yesterday.conversions,
          custo_por_resultado: n.yesterday.conversions ? money(n.yesterday.spend / n.yesterday.conversions) : null,
        }
      : "ainda sem os números de ontem",
    hoje_ate_agora: n.today
      ? {
          ate: new Date(n.today.at).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: m.timezone,
          }),
          gasto: money(n.today.spend),
          resultados: n.today.conversions,
        }
      : "sem leitura de hoje ainda",
    ultimos_7_dias: n.last7,
    insights_abertos: m.open_insights.slice(0, 4).map((i) => ({
      prioridade: i.priority,
      titulo: i.title,
      o_que_fazer: i.action || undefined,
    })),
    plataforma: a
      ? {
          janelas: "ciclo = do início do ciclo até ontem; d7 = últimos 7 dias",
          resultado_da_plataforma: a.result_label || undefined,
          crm:
            a.crm === "ok"
              ? "ligado (oportunidades e ganhos por UTM)"
              : a.crm === "error"
                ? "ligado, mas sem resposta agora"
                : "sem CRM ligado",
          itens: dailyEntities(a, scale).map((e) => ({
            nivel: e.level,
            nome: e.name,
            ...(e.status ? { status: e.status } : {}),
            ...(e.info && Object.keys(e.info).length
              ? { info: Object.fromEntries(Object.entries(e.info).map(([k, v]) => [k, String(v).slice(0, 400)])) }
              : {}),
            ciclo: compact(e.n.cycle),
            d7: compact(e.n.d7),
          })),
        }
      : "sem a leitura da plataforma hoje (use só os números acima)",
  };
  return `Material da campanha (JSON):\n${JSON.stringify(material)}`;
}

export const DAILY_INSTRUCTIONS = `Você é a MAVI, a inteligência de uma agência de marketing (seu nome é MAVI, no feminino), analista sênior de tráfego pago. Escreva a LEITURA DO DIA de UMA campanha para a lista de campanhas: quem opera bate o olho e entende como a campanha está e o que fazer hoje.

O QUE ESCREVER:
- "frase": UMA frase de até 200 caracteres. Diga o estado (ciclo × meta, ontem, hoje até agora, ritmo de gasto) e, se houver, a ação mais importante, apontando o item pelo nome (conjunto, público, anúncio, palavra-chave ou copy). Ex.: "Leads 18% abaixo da meta, puxados pelo anúncio 'Frete grátis'; o conjunto 'Lookalike 1%' gasta 40% da verba sem lead: vale pausar."
- "pontos": de 0 a 3 frases curtas (até 160 caracteres cada) que sustentam a frase: o destaque (o que vai bem e por quê — público, criativo ou a promessa da copy), o problema (o que gasta sem trazer resultado) e o próximo passo. Sem repetir a frase.
- "tom": "bom" (no caminho da meta), "atencao" (precisa de atenção ou cedo para dizer) ou "ruim" (fora da meta ou gastando sem resultado).

COMO:
- Linguagem simples, de conversa, sem jargão ("custo por lead", "taxa de cliques", "vezes que cada pessoa viu o anúncio").
- Só números e nomes do material, no formato brasileiro (R$ 1.234,56; 12,3%). Nunca invente. Os valores já vêm na base indicada em "valores": não fale de M nem de multiplicador.
- Hoje é parcial: não julgue o dia de hoje sozinho; use-o para confirmar o que ontem e os últimos 7 dias mostram.
- Amostra pequena (poucos resultados) não permite concluir: diga que é cedo.
- Copys e criativos ("info": titulo, texto, cta, criativo, audio) explicam o porquê: cite a promessa ou o gancho que funciona ou não.
- Boas práticas: não sugira mexer em conjunto em aprendizado; não mais que 20% a 30% de verba de uma vez; frequência alta com taxa de cliques caindo = criativo cansado.
- Se há insights abertos, você pode dizer qual atacar primeiro, sem copiá-los.

Responda SOMENTE com um JSON: {"tom": "bom|atencao|ruim", "frase": "...", "pontos": ["...", "..."]}. Português do Brasil.`;

const TONES: Record<string, Tone> = {
  bom: "good",
  good: "good",
  atencao: "attention",
  "atenção": "attention",
  attention: "attention",
  ruim: "bad",
  bad: "bad",
};
/** A resposta da MAVI (nulo quando não serve). */
export function parseDaily(text: string): DailyResult | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let v: Row;
  try {
    v = JSON.parse(text.slice(start, end + 1)) as Row;
  } catch {
    return null;
  }
  const headline = typeof v.frase === "string" ? v.frase.replace(/\s+/g, " ").trim() : "";
  if (headline.length < 10) return null;
  const tone = TONES[String(v.tom ?? "").toLowerCase().trim()] ?? "attention";
  const points = (Array.isArray(v.pontos) ? v.pontos : [])
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.replace(/\s+/g, " ").trim().slice(0, 220))
    .slice(0, 3);
  return { tone, headline: headline.slice(0, 320), points };
}

// ------------------------------------------------------------ o worker
type Usage = {
  kind: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  provider_id?: string;
  provider?: string;
};
type Company = { llm: LlmAdapter; route: ResolvedRoute | null; model: string; price: { input: number; output: number } };

async function workerRpc<T>(env: AiEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
  if (!r.ok) throw new InsightsError(r.status, r.error);
  return r.data;
}

/** O modelo da leitura do dia: a regra própria; sem ela, a dos insights. */
async function companyOf(env: AiEnv, deps: AiDeps, id: string): Promise<Company> {
  const own = await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
    p_company: id,
    p_feature: "campaign_daily",
  });
  const route =
    own?.scope === "feature"
      ? own
      : await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
          p_company: id,
          p_feature: "campaign_insights",
        });
  const config = route && route.key_cipher ? routeConfig(env, route) : null;
  if (!config && !env.anthropicKey) throw new InsightsError(503, "Sem provedor para a leitura do dia.", true);
  const model = config?.model ?? env.model;
  const listed = config?.price ?? route?.price ?? null;
  const [input, output] = listed ? [listed.input, listed.output] : modelPrice(model);
  return {
    llm: config ? (deps.providerLlm ?? ((p: ProviderConfig) => adapterFor(p, deps.fetch)))(config) : deps.llm,
    route,
    model,
    price: { input, output },
  };
}

const minutesFromNow = (now: number, minutes: number) => new Date(now + minutes * 60_000).toISOString();

/** Uma leitura (a fila já reservou). */
export async function readDaily(
  env: DailyEnv,
  deps: AiDeps,
  readId: string,
  companies: Map<string, Promise<Company>>,
  read: typeof readAnalysis = readAnalysis,
  creatives: typeof readCreatives = readCreatives,
): Promise<"done" | "skipped" | "deferred" | "rule"> {
  const now = deps.now ?? Date.now;
  const m = await workerRpc<DailyMaterial | null>(env, deps, "ai_campaign_daily_material", { p_read: readId });
  if (!m) return "skipped";
  const store = (result: Row) => workerRpc(env, deps, "ai_campaign_daily_store", { p_read: readId, p_result: result });
  if (m.blocked) {
    await store({ status: "skipped", note: m.blocked });
    return "skipped";
  }
  const n = dailyNumbers(m);
  // Parada: a frase sai pelas regras, sem gastar a API nem a MAVI.
  if (idle(n)) {
    await store({ ...ruleRead(m, n), status: "done", source: "rule", money_basis: n.basis, note: "Sem investimento ontem nem hoje." });
    return "rule";
  }
  const notes: string[] = [];
  const usage: Usage[] = [];
  const meter = newApiMeter();
  // Google: o orçamento de operações da MAVI (o mesmo dos insights).
  const google = m.campaign.platform === "google";
  const reserved = google ? Math.max(accountsOf(m.links).size, 1) * GOOGLE_OPS_PER_ACCOUNT : 0;
  let platform = true;
  if (google) {
    const b = await workerRpc<{ ok: boolean; used: number; budget: number }>(env, deps, "ai_campaign_insight_google_ops", {
      p_company: m.company_id,
      p_ops: reserved,
      p_check: true,
    });
    if (!b.ok) {
      platform = false;
      notes.push(`Orçamento de operações do Google da MAVI atingido (${b.used} de ${b.budget}): leitura sem os itens da plataforma.`);
    }
  }
  let analysis: Analysis | null = null;
  if (platform) {
    try {
      analysis = await read(env, deps.fetch, m, meter);
    } catch (e) {
      if (e instanceof ThrottledError) {
        const until = minutesFromNow(now(), e.throttle.minutes);
        for (const account of e.throttle.scope === "platform" ? ["*"] : e.accounts)
          await workerRpc(env, deps, "ai_campaign_insight_cooldown", {
            p_platform: e.throttle.platform,
            p_account: account,
            p_until: until,
            p_reason: e.throttle.reason,
          }).catch(() => {});
        await workerRpc(env, deps, "ai_campaign_daily_defer", {
          p_read: readId,
          p_until: until,
          p_note: `${e.throttle.reason}: a leitura espera a cota liberar.`,
        });
        if (google && meter.google !== reserved)
          await workerRpc(env, deps, "ai_campaign_insight_google_ops", {
            p_company: m.company_id,
            p_ops: meter.google - reserved,
            p_check: false,
          }).catch(() => {});
        return "deferred";
      }
      notes.push(`Sem a leitura da plataforma: ${(e as Error).message}`.slice(0, 300));
    }
    if (google && meter.google !== reserved)
      await workerRpc(env, deps, "ai_campaign_insight_google_ops", {
        p_company: m.company_id,
        p_ops: meter.google - reserved,
        p_check: false,
      }).catch(() => {});
    if (meter.pct >= SOFT_LIMIT_PCT)
      for (const account of analysis?.accounts ?? [])
        await workerRpc(env, deps, "ai_campaign_insight_cooldown", {
          p_platform: m.campaign.platform,
          p_account: account,
          p_until: minutesFromNow(now(), Math.max(meter.regainMinutes, 15)),
          p_reason: `Consumo da cota em ${Math.round(meter.pct)}%`,
        }).catch(() => {});
  }
  const cap = Number(m.settings.run_cap_usd) || 0.1;
  // As copys e os criativos dos anúncios que pesam (do cache; os novos no teto).
  if (analysis) {
    const ads = dailyEntities(analysis).filter((e) => e.level === "ad" && e.source);
    if (ads.length)
      try {
        const tokens = new Map<string, string>();
        if (m.campaign.platform === "meta" && env.ads.tokenKey)
          for (const [account, t] of Object.entries(m.meta_tokens ?? {}))
            tokens.set(account, unseal(env.ads.tokenKey, t.token_cipher));
        const cr = await creatives(env, deps, {
          company: m.company_id,
          platform: m.campaign.platform,
          ads: ads.map(
            (e): CreativeAd => ({
              entity: e.key,
              spend: num(e.n.cycle?.spend ?? e.n.d7?.spend),
              title: e.info?.titulo ?? e.info?.titulos,
              body: e.info?.texto ?? e.info?.descricoes,
              cta: e.info?.cta,
              ...(e.source?.creative && e.source.account
                ? { meta: { creative: e.source.creative, account: e.source.account } }
                : {}),
              ...(e.source?.image ? { google: { image: e.source.image } } : {}),
            }),
          ),
          tokens,
          platformFetch: meteredFetch(deps.fetch, meter),
          budget: cap * 0.4,
        });
        const byKey = new Map(analysis.entities.map((e) => [e.key, e]));
        for (const [key, c] of cr.byEntity) {
          const e = byKey.get(key);
          if (e) e.info = { ...(e.info ?? {}), criativo: c.line, ...(c.transcript ? { audio: c.transcript } : {}) };
        }
        usage.push(...cr.usage);
      } catch (e) {
        notes.push(`Criativos indisponíveis agora: ${(e as Error).message}`.slice(0, 200));
      }
  }
  const spentSoFar = usage.reduce((s, u) => s + u.cost, 0);
  if (!companies.has(m.company_id)) companies.set(m.company_id, companyOf(env, deps, m.company_id));
  let company: Company | null = null;
  try {
    company = await companies.get(m.company_id)!;
  } catch (e) {
    notes.push((e as Error).message);
  }
  // O maior material que cabe no teto (menos itens a cada passo; sem itens no fim).
  const maxTokens = 700;
  let text: string | null = null;
  if (company)
    for (const scale of [1, 0.5, 0]) {
      const t = dailyMessage(m, n, scale === 0 ? null : analysis, scale);
      if (estimateCost(t.length + DAILY_INSTRUCTIONS.length, maxTokens, company.price) <= cap - spentSoFar) {
        text = t;
        if (scale < 1 && analysis) notes.push("Menos itens da plataforma para caber no teto por leitura.");
        break;
      }
    }
  let result: DailyResult | null = null;
  if (company && text) {
    try {
      const r = await sampledLlm(company.llm, workerSpot(env, deps, m.company_id, "campaign_daily", { client: m.client?.id, providerId: company.route?.provider_id }))({
        instructions: DAILY_INSTRUCTIONS,
        context: "",
        messages: [{ role: "user", content: text }],
        tools: [],
        execute: async () => "",
        maxRounds: 0,
        maxTokens,
        effort: "low",
      });
      usage.push({
        kind: "campaign_daily",
        model: r.meter.model || company.model,
        input: r.meter.input,
        output: r.meter.output,
        cache_read: r.meter.cacheRead,
        cache_write: r.meter.cacheWrite,
        cost: Math.round(r.meter.cost * 1e6) / 1e6,
        ...(company.route ? { provider_id: company.route.provider_id, provider: company.route.provider } : {}),
      });
      result = parseDaily(r.text);
      if (!result) notes.push("A resposta da MAVI não veio no formato: frase pelas regras.");
    } catch (e) {
      notes.push(`A MAVI não respondeu: ${(e as Error).message}`.slice(0, 200));
    }
  } else if (company) notes.push(`O teto por leitura (US$ ${cap.toFixed(2)}) não cobre a MAVI: frase pelas regras.`);
  const final = result ?? ruleRead(m, n);
  await store({
    ...final,
    status: "done",
    source: result ? "mavi" : "rule",
    money_basis: n.basis,
    note: notes.join(" ").slice(0, 1000),
    model: result ? (company?.model ?? "") : "",
    provider: result ? (company?.route?.provider ?? "") : "",
    usage,
    api_calls: { meta: meter.meta, google: meter.google },
  });
  return result ? "done" : "rule";
}

/** Pega as leituras da fila (três por vez) até o tempo acabar. */
export async function runCampaignDaily(
  env: DailyEnv,
  deps: AiDeps,
  read: typeof readAnalysis = readAnalysis,
  creatives: typeof readCreatives = readCreatives,
) {
  const now = deps.now ?? Date.now;
  const deadline = now() + (env.dailyBudgetMs ?? 240_000);
  const stats = { done: 0, rule: 0, skipped: 0, deferred: 0, failed: 0 };
  const companies = new Map<string, Promise<Company>>();
  // Uma leitura leva até ~1 min (a plataforma + a MAVI).
  while (now() < deadline - 70_000) {
    const claimed = await workerRpc<{ id: string }[]>(env, deps, "ai_campaign_daily_claim", { p_limit: 3 });
    if (!claimed.length) break;
    await Promise.all(
      claimed.map(async (c) => {
        try {
          stats[await readDaily(env, deps, c.id, companies, read, creatives)]++;
        } catch (e) {
          stats.failed++;
          const err = e as InsightsError;
          console.error("campaign daily", c.id, err.message);
          await workerRpc(env, deps, "ai_campaign_daily_fail", {
            p_read: c.id,
            p_error: String(err.message ?? "Erro na leitura.").slice(0, 900),
            p_final: err instanceof InsightsError && err.final,
          }).catch(() => {});
        }
      }),
    );
  }
  return stats;
}

/** "ai-campaign-daily": só o agendamento (pg_cron) com o segredo do worker. */
export async function handleCampaignDailyWorker(
  authorization: string | null,
  env: DailyEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Row }> {
  if (!workerAuthorized(authorization, env)) return { status: 401, body: { error: "Não autorizado." } };
  try {
    return { status: 200, body: await runCampaignDaily(env, deps) };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return { status: typeof e.status === "number" ? e.status : 500, body: { error: e.message ?? "Erro na leitura do dia." } };
  }
}


import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import {
  ALERT_OBJECTIVES,
  ALERT_OBJECTIVE_LABELS,
  ALERT_PLATFORMS,
  CONDITION_LABELS,
  METRIC_HELP,
  METRIC_INFO,
  ALERT_METRICS,
  describeRule,
  ruleFromInput,
  ruleProblem,
  suggestedName,
  type CampaignAlertRule,
} from "../src/campaign-alerts.js";
import { sampledLlm } from "./_ai-samples.js";

/**
 * Campanhas › Meus avisos com a MAVI (migração 20270218090000):
 *
 * - "Descreva o aviso" (ação "campaign-alert-mavi" de /api/drive,
 *   funcionalidade 'campaign_alerts' do Painel da MAVI): o texto da pessoa
 *   vira uma regra para ela revisar no formulário. Nada é gravado aqui.
 * - Na conversa (bolinha e módulo MAVI): campaign_alerts lê os avisos da
 *   pessoa e propose_campaign_alert monta o cartão de confirmação; quem grava
 *   é a tela, depois do "Confirmar".
 *
 * Os nomes (campanha, clientes, produtos, equipes) viram ids só entre o que a
 * pessoa enxerga (as consultas vão com a sessão dela).
 */

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export type AlertCatalog = {
  campaigns: { id: string; name: string; platform: string; status: string; client: string; product: string }[];
  clients: { id: string; name: string }[];
  products: { id: string; name: string }[];
  teams: { id: string; name: string }[];
};
type Rest = <T>(path: string) => Promise<T[]>;

/** O que a pessoa enxerga para montar um aviso. */
export async function alertCatalog(rest: Rest, company: string): Promise<AlertCatalog> {
  const [campaigns, clients, products, teams] = await Promise.all([
    rest<{
      id: string;
      name: string;
      platform: string;
      status: string;
      contracts: { clients: { name: string } | null; products: { name: string } | null } | null;
    }>(
      `ad_campaigns?select=id,name,platform,status,contracts(clients(name),products(name))&company_id=eq.${company}&archived=is.false&order=name&limit=600`,
    ),
    rest<{ id: string; name: string }>(
      `clients?select=id,name&company_id=eq.${company}&archived=is.false&order=name&limit=1000`,
    ),
    rest<{ id: string; name: string }>(`products?select=id,name&company_id=eq.${company}&order=name&limit=300`),
    rest<{ id: string; name: string }>(`teams?select=id,name&company_id=eq.${company}&order=name&limit=300`),
  ]);
  return {
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      platform: c.platform,
      status: c.status,
      client: c.contracts?.clients?.name ?? "",
      product: c.contracts?.products?.name ?? "",
    })),
    clients,
    products,
    teams,
  };
}

/** Um nome (ou id) entre os do catálogo: o exato, senão os que contêm. */
export function findByName<T extends { id: string; name: string }>(list: T[], wanted: string) {
  if (UUID.test(wanted)) return list.filter((x) => x.id === wanted);
  const w = fold(wanted);
  if (!w) return [];
  const exact = list.filter((x) => fold(x.name) === w);
  return exact.length ? exact : list.filter((x) => fold(x.name).includes(w));
}

/** Os rótulos que a tela e o cartão mostram (os do banco, antes de gravar). */
export function labelRule(rule: CampaignAlertRule, cat: AlertCatalog): CampaignAlertRule {
  const names = (list: { id: string; name: string }[], ids: string[]) =>
    ids.map((id) => list.find((x) => x.id === id)?.name).filter((x): x is string => !!x);
  const campaign = cat.campaigns.find((c) => c.id === rule.campaign_id);
  return {
    ...rule,
    labels: {
      campaign: campaign?.name ?? null,
      campaign_client: campaign?.client ?? null,
      clients: names(cat.clients, rule.client_ids),
      products: names(cat.products, rule.product_ids),
      teams: names(cat.teams, rule.team_ids),
    },
  };
}

/** Só os ids que a pessoa enxerga ficam na regra. */
export function keepKnown(rule: CampaignAlertRule, cat: AlertCatalog): CampaignAlertRule {
  const has = (list: { id: string }[]) => (id: string) => list.some((x) => x.id === id);
  return {
    ...rule,
    campaign_id: rule.campaign_id && has(cat.campaigns)(rule.campaign_id) ? rule.campaign_id : null,
    client_ids: rule.client_ids.filter(has(cat.clients)),
    product_ids: rule.product_ids.filter(has(cat.products)),
    team_ids: rule.team_ids.filter(has(cat.teams)),
  };
}

// ------------------------------------------------------------ o que a MAVI sabe
const metricLines = ALERT_METRICS.map(
  (m) =>
    `- ${m}: ${METRIC_INFO[m].label}${METRIC_INFO[m].cycle ? " (do ciclo atual: só above/below)" : ""} — ${METRIC_HELP[m].what} ${METRIC_HELP[m].calc}`,
).join("\n");

/** O formato da regra (o mesmo nas duas MAVIs). */
export const ALERT_FORMAT = `Formato de uma regra de aviso de campanha:
- metric (uma destas):
${metricLines}
- condition: above (${CONDITION_LABELS.above} value), below (${CONDITION_LABELS.below} value), unchanged (igual por "days" dias seguidos; "tolerance" em % aceita pequena diferença), zero (zerado por "days" dias seguidos; só spend, conversions, impressions, clicks, reach), rise / drop (subir / cair "value"% ou mais: os últimos "days" dias contra os "days" anteriores).
- period (para above/below em métricas de dia): day (o último dia fechado, ontem), days (soma dos últimos "days" dias, mínimo 2), cycle (o ciclo atual até ontem). Métricas do ciclo ignoram.
- days: 1 a 30. value: número na unidade da métrica (R$ sem símbolo, % sem o sinal, contagem); em rise/drop, o %.
- with_m: true quando os valores em dinheiro devem considerar o M (como o cliente contratou e vê); padrão false (o que a plataforma gasta).
- Alcance: campaign_id (uma campanha) OU filtros para as campanhas ativas: client_ids, product_ids, team_ids, platforms (${ALERT_PLATFORMS.join(", ")}), objectives (${ALERT_OBJECTIVES.map((o) => `${o} = ${ALERT_OBJECTIVE_LABELS[o]}`).join(", ")}). Sem campanha e sem filtros = todas as campanhas ativas.
- repeat: once (avisa uma vez e só de novo depois que a situação deixar de valer — padrão), daily (todo dia enquanto valer), every (a cada "repeat_days" dias, 2 a 30).
- channel: now (na hora: caixa de entrada e notificação — padrão) ou digest (um resumo por dia às 11h).
- name: curto (até 60 caracteres), diz o que o aviso vigia (ex.: "Consumo travado", "CPL acima de R$ 25").
Os números chegam uma vez por dia, de manhã, até ontem: "3 dias" são os 3 últimos dias fechados.
Exemplos: "ficou 3 dias com o mesmo consumo" = spend/unchanged/days 3; "3 dias sem conversão" = conversions/zero/days 3; "custo por lead passou de 30 no ciclo" = cpa/above/period cycle/value 30; "gastou mais rápido que o previsto" = spend_pace/above/value 110; "o orçamento diário passou de 500" = daily_budget/above/value 500.`;

export const ALERT_WRITER_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de uma agência de marketing (no feminino). Na tela Campanhas › Meus avisos, a pessoa descreve em palavras um aviso que quer receber sobre as campanhas de tráfego pago, e você transforma o pedido numa regra para ela revisar antes de salvar.

${ALERT_FORMAT}

Como responder:
- Responda SÓ com um JSON, sem texto antes ou depois e sem cercas de código: {"rule": {...}, "note": "..."}.
- rule: os campos do formato. Use só ids das listas de campanhas, clientes, produtos e equipes que vierem na mensagem; nunca invente ids.
- Se a pessoa está numa campanha e não pediu outra coisa (todas, um cliente, uma plataforma…), use o campaign_id dela.
- Se vier um aviso atual, ajuste-o conforme o pedido (mantenha o que ela não mudou).
- Quando faltar um número (ex.: "custo alto" sem valor), escolha um valor razoável e diga na note que ela pode ajustar.
- note: 1 ou 2 frases em português, dizendo o que o aviso faz e o que você assumiu. Sem markdown.`;

/** As listas que o modelo pode usar, curtas. */
export function catalogText(cat: AlertCatalog, campaign: string | null) {
  const open = cat.campaigns.find((c) => c.id === campaign);
  const campaigns = cat.campaigns.filter((c) => c.status === "active" || c.id === campaign).slice(0, 300);
  return [
    open ? `A pessoa está na campanha: ${open.id} | ${open.name} | ${open.client} › ${open.product} | ${open.platform}` : "",
    `Campanhas (id | nome | cliente › produto | plataforma):\n${campaigns.map((c) => `${c.id} | ${c.name} | ${c.client} › ${c.product} | ${c.platform}`).join("\n") || "(nenhuma)"}`,
    `Clientes (id | nome):\n${cat.clients.slice(0, 400).map((c) => `${c.id} | ${c.name}`).join("\n") || "(nenhum)"}`,
    `Produtos (id | nome):\n${cat.products.map((c) => `${c.id} | ${c.name}`).join("\n") || "(nenhum)"}`,
    `Equipes (id | nome):\n${cat.teams.map((c) => `${c.id} | ${c.name}`).join("\n") || "(nenhuma)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** O JSON da resposta do modelo (com ou sem cercas). */
export function parseDraft(text: string): { rule: unknown; note: string } | null {
  const body = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(body.slice(start, end + 1)) as Row;
    const rule = data.rule && typeof data.rule === "object" ? data.rule : data;
    return { rule, note: str(data.note, 600) };
  } catch {
    return null;
  }
}

class AlertError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const LLM_TIMEOUT_MS = 40_000;

/** "Descreva o aviso": a regra para revisar e um recado curto. */
export async function handleCampaignAlertWriter(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  const campaign = UUID.test(str(req.campaign, 40)) ? str(req.campaign, 40) : null;
  const text = str(req.text, 1500);
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  if (text.length < 3) return fail(400, "Descreva o aviso que você quer receber.");
  const current = req.current && typeof req.current === "object" ? ruleFromInput(req.current).rule : null;

  let meter: Meter | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const rest: Rest = async <T>(path: string) => {
      const res = await deps.fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
        headers: { apikey: env.supabaseKey, Authorization: authorization },
      });
      if (!res.ok) throw new AlertError(res.status === 401 ? 401 : 502, "Não foi possível ler as campanhas.");
      return (await res.json()) as T[];
    };
    // Quem não usa Campanhas para aqui (o banco diz).
    const mine = await callRpc<unknown[]>(env, deps.fetch, authorization, "campaign_alert_rules", {
      p_company: company,
      p_campaign: null,
    });
    if (!mine.ok) throw new AlertError(mine.status === 400 ? 403 : mine.status, mine.error);
    const [cat, limits, route] = await Promise.all([
      alertCatalog(rest, company),
      callRpc<{ blocked: boolean; message: string | null }>(env, deps.fetch, authorization, "ai_check_limits", {
        p_company: company,
        p_client: null,
        p_contract: null,
        p_project: null,
      }),
      featureProvider(env, deps.fetch, authorization, company, "campaign_alerts", {}),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new AlertError(429, limits.data.message ?? "Limite de uso da MAVI atingido.");
    if (!provider && !env.anthropicKey)
      throw new AlertError(
        503,
        "A MAVI não está configurada no servidor. Escolha um provedor para os avisos de campanhas no Painel da MAVI.",
      );
    const llm: LlmAdapter = sampledLlm(
      provider ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config) : deps.llm,
      { db: env, fetch: deps.fetch, auth: authorization, company, feature: "campaign_alerts", client: null, providerId: provider?.id ?? null },
    );
    const result = await llm({
      instructions: ALERT_WRITER_INSTRUCTIONS,
      context: catalogText(cat, campaign),
      messages: [
        {
          role: "user",
          content: [
            current ? `Aviso atual (ajuste conforme o pedido):\n${JSON.stringify(current)}` : "",
            `Pedido:\n"""\n${text}\n"""`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "low",
      maxTokens: 1200,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    meter = result.meter;
    const draft = parseDraft(result.text);
    if (!draft) throw new AlertError(502, "A MAVI não conseguiu montar o aviso. Tente descrever de outro jeito.");
    let rule = keepKnown(ruleFromInput(draft.rule).rule, cat);
    if (current?.id) rule = { ...rule, id: current.id, active: current.active };
    if (!rule.name) rule.name = suggestedName(rule);
    rule = labelRule(rule, cat);
    const problem = ruleProblem(rule);
    return {
      status: 200,
      body: { rule, note: draft.note || describeRule(rule), ...(problem ? { problem } : {}) },
    };
  } catch (err) {
    if (err instanceof AlertError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "campaigns",
        p_kind: "campaign_alerts",
        p_client: null,
        p_contract: null,
        p_project: null,
        p_recording: null,
        p_model: meter.model || provider?.config.model || env.model,
        p_input: meter.input ?? 0,
        p_output: meter.output ?? 0,
        p_cache_read: meter.cacheRead ?? 0,
        p_cache_write: meter.cacheWrite ?? 0,
        p_embedding: 0,
        p_cost: Math.round((meter.cost ?? 0) * 1e6) / 1e6,
        ...(provider ? { p_provider: provider.id } : {}),
      }).catch(() => {});
  }
}

// ------------------------------------------------------------ na conversa
/** As instruções da conversa quando a pessoa usa Campanhas. */
export const ALERT_CHAT_RULES = `

Avisos de campanhas (campaign_alerts, propose_campaign_alert): a pessoa pode pedir para ser avisada quando algo acontecer nas campanhas ("me avisa se a campanha X ficar 3 dias sem conversão", "quero saber quando o CPL passar de 30", "pausa o aviso de consumo"). Os avisos chegam na caixa de entrada e como notificação (ou num resumo por dia) e ficam em Campanhas › Meus avisos.
- Você só propõe (propose_campaign_alert): a pessoa confirma no cartão. Nunca diga que o aviso foi criado, mudado ou excluído; diga que está pronto para ela confirmar.
- Os avisos são pessoais: só para quem pede (não dá para criar para outra pessoa).
- Para mudar, pausar (active false), ligar ou excluir, leia antes os avisos dela com campaign_alerts e use o id.
- Passe a campanha, os clientes, os produtos e as equipes pelo nome (ou id): o sistema confere entre os que a pessoa enxerga. Se o pedido não disser o valor de um limite, pergunte (ask_user) ou assuma um valor razoável e diga qual.
${ALERT_FORMAT}`;

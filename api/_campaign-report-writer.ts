import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import { sampledLlm } from "./_ai-samples.js";

/**
 * A MAVI na análise de um relatório de campanha (ação "campaign-report-mavi"
 * de /api/drive, funcionalidade 'campaign_report' do Painel da MAVI). Uma
 * chamada ao modelo, sem ferramentas: lê os números do relatório (já com ou
 * sem M, como o cliente vai ver) e escreve a análise para o cliente. Nada é
 * salvo aqui: a tela mostra o texto, quem cria o relatório edita e decide.
 */

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

export class ReportWriterError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const REPORT_INSTRUCTIONS = `Você é a MAVI, a inteligência de uma agência de marketing (seu nome é MAVI, no feminino). Aqui você escreve a análise de um relatório de tráfego pago que a agência vai enviar ao cliente por um link.

Como escrever:
- Português do Brasil, claro, profissional e próximo. Quem lê é o cliente, não um especialista: explique o que os números significam para o negócio dele.
- Comece com um parágrafo curto com o resumo do período (investimento, resultados, custo por resultado). Depois, os destaques (o que foi bem, o que merece atenção), os anúncios que mais trouxeram resultado, se houver, e os próximos passos sugeridos.
- Use parágrafos curtos. Use lista ("- " no começo da linha) para destaques e próximos passos. Pode usar **negrito** em poucas palavras. Sem títulos com #, sem tabelas, sem emojis.
- Use só os números que vieram. Nunca invente números, metas, datas, nomes de anúncios ou comparações que não estejam nos dados. Arredonde com bom senso e use o formato brasileiro (R$ 1.234,56; 12,3%).
- Não fale de M, multiplicador, índice de performance, custos internos, ferramentas ou da própria MAVI. Não cite nomes de pessoas da agência.
- Se houver meta do ciclo, compare o resultado com ela sem exagerar. Se os dados forem poucos (poucos dias ou nenhum resultado), diga isso com cuidado.
- Até 350 palavras.

Responda só com o texto da análise, sem introdução e sem aspas.`;

export function reportMessage(input: {
  title: string;
  period: string;
  client: string;
  focus: string;
  numbers: string;
}) {
  return [
    `Relatório: ${input.title}`,
    `Cliente: ${input.client || "—"}`,
    `Período: ${input.period}`,
    input.focus ? `Pedido de quem cria o relatório: ${input.focus}` : "",
    "",
    "Números do relatório (JSON):",
    input.numbers,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

async function selectAs<T>(
  env: AiEnv,
  deps: AiDeps,
  auth: string,
  path: string,
): Promise<T[]> {
  const res = await deps.fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: env.supabaseKey, Authorization: auth },
  });
  if (!res.ok)
    throw new ReportWriterError(
      res.status === 401 ? 401 : 502,
      "Não foi possível ler os dados.",
    );
  return (await res.json()) as T[];
}

function userIdFrom(auth: string) {
  try {
    const sub = JSON.parse(
      Buffer.from(
        auth.replace(/^Bearer\s+/, "").split(".")[1],
        "base64url",
      ).toString("utf8"),
    ).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub : "";
  } catch {
    return "";
  }
}

export async function handleReportWriter(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer "))
    return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  const campaign = str(req.campaign, 40);
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  if (!UUID.test(campaign)) return fail(400, "Campanha inválida.");
  const numbers =
    typeof req.numbers === "string"
      ? req.numbers.slice(0, 30000)
      : JSON.stringify(req.numbers ?? {}).slice(0, 30000);
  if (numbers.length < 10) return fail(400, "O relatório ainda não tem números.");
  const input = {
    title: str(req.title, 160) || "Relatório",
    period: str(req.period, 80),
    client: str(req.client, 160),
    focus: str(req.focus, 1000),
    numbers,
  };

  let meter: Meter | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const user = userIdFrom(authorization);
    const [me, visible] = await Promise.all([
      selectAs<{ hidden_pages: string[] | null; active: boolean }>(
        env,
        deps,
        authorization,
        `memberships?select=hidden_pages,active&company_id=eq.${company}&user_id=eq.${user}`,
      ),
      // The campaign as the person sees it (the module's rules).
      selectAs<{ id: string }>(
        env,
        deps,
        authorization,
        `ad_campaigns?select=id&company_id=eq.${company}&id=eq.${campaign}`,
      ),
    ]);
    if (!me[0]?.active)
      throw new ReportWriterError(403, "Sem acesso a esta empresa.");
    if (!visible.length)
      throw new ReportWriterError(403, "Sem acesso a esta campanha.");
    if ((me[0].hidden_pages ?? []).includes("assistant"))
      throw new ReportWriterError(
        403,
        "A MAVI está desligada para você nesta empresa.",
      );
    const [limits, route] = await Promise.all([
      callRpc<{ blocked: boolean; message: string | null }>(
        env,
        deps.fetch,
        authorization,
        "ai_check_limits",
        {
          p_company: company,
          p_client: null,
          p_contract: null,
          p_project: null,
        },
      ),
      featureProvider(env, deps.fetch, authorization, company, "campaign_report"),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new ReportWriterError(
        429,
        limits.data.message ?? "Limite de uso da MAVI atingido.",
      );
    if (!provider && !env.anthropicKey)
      throw new ReportWriterError(
        503,
        "A MAVI não está configurada no servidor. Escolha um provedor para os relatórios de campanha no Painel da MAVI.",
      );
    const llm: LlmAdapter = sampledLlm(
      provider ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config) : deps.llm,
      { db: env, fetch: deps.fetch, auth: authorization, company, feature: "campaign_report", client: null, providerId: provider?.id ?? null },
    );
    const result = await llm({
      instructions: REPORT_INSTRUCTIONS,
      context: "",
      messages: [{ role: "user", content: reportMessage(input) }],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "low",
      maxTokens: 2500,
    });
    meter = result.meter;
    const text = result.text
      .trim()
      .replace(/^["“]|["”]$/g, "")
      .slice(0, 20000);
    if (!text)
      throw new ReportWriterError(502, "A MAVI não conseguiu escrever agora.");
    return {
      status: 200,
      body: { text, model: meter?.model || provider?.config.model || env.model },
    };
  } catch (err) {
    if (err instanceof ReportWriterError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "campaigns",
        p_kind: "report_analysis",
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

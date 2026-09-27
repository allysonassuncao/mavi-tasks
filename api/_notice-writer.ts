import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";

/**
 * A MAVI na escrita de um aviso do Mural (ação "notice-mavi" de /api/drive,
 * funcionalidade 'notice_writer' do Painel da MAVI). Uma chamada ao modelo,
 * sem ferramentas, que devolve JSON:
 *
 * - "write": a partir de uma ideia em poucas palavras, o título, o texto e
 *   as sugestões de nível, formatos, confirmação e público;
 * - "improve": o texto revisado (mais claro, mais curto, mais formal ou
 *   mais próximo), sem inventar nada;
 * - "suggest": só as sugestões, lendo o que já foi escrito.
 *
 * Nada é aplicado sozinho: a tela mostra e quem escreve decide. O público
 * volta como nomes (os que o texto cita); a tela os procura no que quem
 * escreve pode avisar. Só administradores e gestores, com a MAVI ligada para
 * a pessoa e dentro dos limites de gasto.
 */
export type WriterMode = "write" | "improve" | "suggest";
export type WriterStyle = "clear" | "short" | "formal" | "friendly";
export type WriterAudience = {
  kind: "everyone" | "team" | "client" | "project" | "user";
  name: string;
  mode?: "teams" | "assignees" | "both";
};
export type WriterResult = {
  title?: string;
  body?: string;
  level?: "info" | "important" | "critical";
  formats?: { popup: boolean; inbox: boolean; push: boolean; banner: boolean };
  require_ack?: boolean;
  audience?: WriterAudience[];
  why?: string;
  model: string;
};

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

export class WriterError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const WRITER_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing. Aqui você ajuda administradores e gestores a escrever avisos do Mural: comunicados internos para o time (pessoas, equipes, quem atende um cliente ou um projeto). Seu nome é MAVI, no feminino.

Como escrever um aviso:
- Português do Brasil, direto, cordial e profissional. O título diz o essencial em até 80 caracteres, sem ponto final e sem emoji.
- O texto começa pelo que a pessoa precisa saber ou fazer; depois o contexto (datas, quem, onde). Parágrafos curtos. Use lista ("- " no começo da linha) só para passos ou itens.
- Nunca invente fatos, datas, nomes, números ou links que não estejam no que foi escrito. Se faltar algo essencial (a data, por exemplo), escreva [completar: ...] no lugar.
- Não assine o aviso (o nome de quem publica já aparece).

Como sugerir nível e formatos:
- "info" (Informativo): recado sem urgência; caixa de entrada.
- "important" (Importante): muda a rotina ou tem prazo (folga, prazo de entrega, mudança de processo, pedido de material de um cliente); caixa de entrada, push e faixa no topo.
- "critical" (Crítico): exige ação ou ciência de todos agora (política nova, incidente, regra que vale já); popup com "Li e entendi", push e caixa de entrada.
- require_ack (pedir "Li e entendi") só quando for preciso registrar que cada pessoa leu: políticas, regras, mudanças obrigatórias.

Como sugerir o público:
- Só o que o texto indica. "Todos", "a agência", "o time inteiro" é everyone.
- Cite equipes, clientes e projetos com o nome como aparece no texto. Para cliente e projeto, mode: "teams" (as equipes que o atendem), "assignees" (quem tem tarefa aberta dele) ou "both" (em dúvida).
- Pessoas citadas pelo nome são "user". Não sugira público quando o texto não disser.

Responda só com um objeto JSON, sem comentários nem cercas de código, com os campos pedidos:
{"title": "...", "body": "...", "level": "info|important|critical", "formats": {"popup": false, "inbox": true, "push": false, "banner": false}, "require_ack": false, "audience": [{"kind": "everyone|team|client|project|user", "name": "...", "mode": "teams|assignees|both"}], "why": "uma frase explicando o nível e os formatos"}`;

const STYLES: Record<WriterStyle, string> = {
  clear: "Deixe mais claro e bem organizado, sem mudar o sentido.",
  short: "Deixe bem mais curto, só com o essencial.",
  formal: "Deixe mais formal e institucional.",
  friendly: "Deixe mais próximo e caloroso, sem perder a clareza.",
};

export function writerMessage(
  mode: WriterMode,
  input: { idea: string; title: string; text: string; style: WriterStyle },
  ctx: { company: string; author: string; today: string },
) {
  const head = `Agência: ${ctx.company}\nQuem publica: ${ctx.author}\nHoje: ${ctx.today}\n\n`;
  if (mode === "write")
    return `${head}Escreva um aviso a partir desta ideia:\n"""\n${input.idea}\n"""\n${
      input.text
        ? `\nO que já está escrito (aproveite o que servir):\n"""\n${input.text}\n"""\n`
        : ""
    }\nDevolva title, body, level, formats, require_ack, audience e why.`;
  if (mode === "improve")
    return `${head}Revise este aviso. ${STYLES[input.style]}\n\nTítulo: ${input.title || "(sem título)"}\nTexto:\n"""\n${input.text}\n"""\n\nDevolva só title e body.`;
  return `${head}Leia este aviso e sugira como ele deve chegar e para quem.\n\nTítulo: ${input.title || "(sem título)"}\nTexto:\n"""\n${input.text}\n"""\n\nDevolva só level, formats, require_ack, audience e why.`;
}

/** O JSON da resposta, conferido campo a campo (o resto é ignorado). */
export function parseWriter(
  text: string,
  mode: WriterMode,
): Omit<WriterResult, "model"> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let raw: Row;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Row;
  } catch {
    throw new WriterError(
      502,
      "A MAVI não conseguiu montar a resposta. Tente de novo.",
    );
  }
  const out: Omit<WriterResult, "model"> = {};
  if (mode !== "suggest") {
    const title = str(raw.title, 160);
    const body =
      typeof raw.body === "string" ? raw.body.trim().slice(0, 8000) : "";
    if (title.length >= 2) out.title = title;
    if (body) out.body = body;
    if (!out.title && !out.body)
      throw new WriterError(
        502,
        "A MAVI não conseguiu escrever o aviso. Tente de novo.",
      );
  }
  if (mode !== "improve") {
    if (
      raw.level === "info" ||
      raw.level === "important" ||
      raw.level === "critical"
    )
      out.level = raw.level;
    const f = raw.formats as Row | undefined;
    if (f && typeof f === "object")
      out.formats = {
        popup: f.popup === true,
        inbox: f.inbox === true,
        push: f.push === true,
        banner: f.banner === true,
      };
    if (typeof raw.require_ack === "boolean") out.require_ack = raw.require_ack;
    if (Array.isArray(raw.audience))
      out.audience = raw.audience
        .map((a) => a as Row)
        .filter(
          (a) =>
            ["everyone", "team", "client", "project", "user"].includes(
              String(a?.kind),
            ) &&
            (a.kind === "everyone" || str(a.name, 160).length >= 2),
        )
        .slice(0, 10)
        .map((a) => ({
          kind: a.kind as WriterAudience["kind"],
          name: a.kind === "everyone" ? "" : str(a.name, 160),
          ...(a.kind === "client" || a.kind === "project"
            ? {
                mode: (["teams", "assignees", "both"].includes(String(a.mode))
                  ? a.mode
                  : "both") as WriterAudience["mode"],
              }
            : {}),
        }));
    const why = str(raw.why, 300);
    if (why) out.why = why;
  }
  return out;
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
    throw new WriterError(
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

export async function handleNoticeWriter(
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
  const mode = req.mode as WriterMode;
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  if (!["write", "improve", "suggest"].includes(mode))
    return fail(400, "Pedido inválido.");
  const input = {
    idea: str(req.idea, 2000),
    title: str(req.title, 160),
    text: str(req.text, 12000),
    style: (["clear", "short", "formal", "friendly"].includes(String(req.style))
      ? req.style
      : "clear") as WriterStyle,
  };
  if (mode === "write" && input.idea.length < 3)
    return fail(400, "Conte em poucas palavras do que é o aviso.");
  if (mode !== "write" && !input.text && !input.title)
    return fail(400, "Escreva o aviso primeiro.");

  let meter: Meter | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const user = userIdFrom(authorization);
    const [me, companies] = await Promise.all([
      selectAs<{
        role: string;
        name: string;
        hidden_pages: string[] | null;
        active: boolean;
      }>(
        env,
        deps,
        authorization,
        `memberships?select=role,name,hidden_pages,active&company_id=eq.${company}&user_id=eq.${user}`,
      ),
      selectAs<{ name: string; timezone: string }>(
        env,
        deps,
        authorization,
        `companies?select=name,timezone&id=eq.${company}`,
      ),
    ]);
    const m = me[0];
    if (!m?.active) throw new WriterError(403, "Sem acesso a esta empresa.");
    if (m.role !== "admin" && m.role !== "manager")
      throw new WriterError(
        403,
        "Somente administradores e gestores escrevem avisos.",
      );
    if ((m.hidden_pages ?? []).includes("assistant"))
      throw new WriterError(
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
      featureProvider(env, deps.fetch, authorization, company, "notice_writer"),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new WriterError(
        429,
        limits.data.message ?? "Limite de uso da MAVI atingido.",
      );
    if (!provider && !env.anthropicKey)
      throw new WriterError(
        503,
        "A MAVI não está configurada no servidor. Escolha um provedor para o Mural de avisos no Painel da MAVI.",
      );
    const llm: LlmAdapter = provider
      ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(
          provider.config,
        )
      : deps.llm;
    const tz = companies[0]?.timezone || "America/Sao_Paulo";
    const today = new Date((deps.now ?? Date.now)()).toLocaleDateString(
      "pt-BR",
      {
        timeZone: tz,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      },
    );
    const result = await llm({
      instructions: WRITER_INSTRUCTIONS,
      context: "",
      messages: [
        {
          role: "user",
          content: writerMessage(mode, input, {
            company: companies[0]?.name ?? "",
            author: m.name,
            today,
          }),
        },
      ],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "low",
      maxTokens: 3000,
    });
    meter = result.meter;
    const parsed = parseWriter(result.text, mode);
    return {
      status: 200,
      body: {
        ...parsed,
        model: meter?.model || provider?.config.model || env.model,
      },
    };
  } catch (err) {
    if (err instanceof WriterError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "notices",
        p_kind: `writer_${mode}`,
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

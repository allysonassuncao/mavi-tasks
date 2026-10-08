import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import { cleanTaskTitle } from "../src/task-title.js";
import { sampledLlm } from "./_ai-samples.js";

/**
 * O título de uma tarefa nova (ação "task-title" de /api/drive,
 * funcionalidade 'task_title' do Painel da MAVI). O formulário de criação
 * não tem mais o campo: ao clicar em "Criar tarefa", ele manda a descrição
 * e a transcrição dos áudios, espera o título e só então salva, para a
 * tarefa já chegar à lista com ele. Uma chamada curta, sem ferramentas; se
 * falhar, o formulário salva com o começo da descrição.
 */
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
/** O formulário desiste em 8 s; o servidor não passa muito disso. */
const LLM_TIMEOUT_MS = 12_000;

class TitleError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const TITLE_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de tarefas de uma agência de marketing. Seu nome é MAVI, no feminino. Alguém acabou de descrever uma tarefa (por escrito, em áudio ou os dois) e você escreve o título dela.

Como escrever o título:
- Fácil e objetivo: quem bate o olho na lista entende o que precisa ser feito.
- Comece por um verbo no infinitivo (Criar, Ajustar, Revisar, Enviar, Publicar, Configurar…) seguido do quê e, se couber, do detalhe que distingue esta tarefa (formato, quantidade, campanha, data).
- De 3 a 10 palavras, no máximo 80 caracteres, em português do Brasil.
- Não repita o nome do cliente nem do produto (eles já aparecem ao lado do título).
- Sem ponto final, sem aspas, sem emoji e sem inventar nada que não foi escrito ou dito. A transcrição do áudio pode ter erros de reconhecimento: use o sentido.

Responda só com o título, em uma linha.`;

export function titleMessage(input: {
  client: string;
  product: string;
  hint: string;
  description: string;
  audio: string;
}) {
  return [
    input.client ? `Cliente: ${input.client}` : "",
    input.product ? `Produto: ${input.product}` : "",
    input.hint ? `Sugestão de quem abriu a tarefa: ${input.hint}` : "",
    input.description ? `Descrição:\n"""\n${input.description}\n"""` : "",
    input.audio ? `Áudios gravados na descrição (transcrição):\n"""\n${input.audio}\n"""` : "",
    "Escreva o título da tarefa.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function selectAs<T>(env: AiEnv, deps: AiDeps, auth: string, path: string): Promise<T[]> {
  const res = await deps.fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: env.supabaseKey, Authorization: auth },
  });
  if (!res.ok)
    throw new TitleError(res.status === 401 ? 401 : 502, "Não foi possível ler os dados.");
  return (await res.json()) as T[];
}

function userIdFrom(auth: string) {
  try {
    const sub = JSON.parse(
      Buffer.from(auth.replace(/^Bearer\s+/, "").split(".")[1], "base64url").toString("utf8"),
    ).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub : "";
  } catch {
    return "";
  }
}

export async function handleTaskTitle(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  const contract = str(req.contract, 40);
  const project = str(req.project, 40);
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  if (!UUID.test(contract)) return fail(400, "Escolha o cliente e o produto.");
  const input = {
    description: str(req.description, 6000),
    audio: str(req.audio, 6000),
    hint: str(req.hint, 240),
  };
  if ((input.description + input.audio + input.hint).length < 3)
    return fail(400, "Descreva a tarefa ou grave um áudio.");

  let meter: Meter | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  let client: string | null = null;
  try {
    const user = userIdFrom(authorization);
    const [me, contracts] = await Promise.all([
      selectAs<{ active: boolean }>(
        env,
        deps,
        authorization,
        `memberships?select=active&company_id=eq.${company}&user_id=eq.${user}`,
      ),
      selectAs<{ client_id: string; name: string }>(
        env,
        deps,
        authorization,
        `contracts?select=client_id,name&company_id=eq.${company}&id=eq.${contract}`,
      ),
    ]);
    if (!me[0]?.active) throw new TitleError(403, "Sem acesso a esta empresa.");
    const k = contracts[0];
    if (!k) throw new TitleError(404, "Produto não encontrado.");
    client = k.client_id;
    const scope = {
      client: k.client_id,
      contract,
      ...(UUID.test(project) ? { project } : {}),
    };
    const [clients, limits, route] = await Promise.all([
      selectAs<{ name: string }>(env, deps, authorization, `clients?select=name&id=eq.${k.client_id}`),
      callRpc<{ blocked: boolean; message: string | null }>(env, deps.fetch, authorization, "ai_check_limits", {
        p_company: company,
        p_client: k.client_id,
        p_contract: contract,
        p_project: scope.project ?? null,
      }),
      featureProvider(env, deps.fetch, authorization, company, "task_title", scope),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new TitleError(429, limits.data.message ?? "Limite de uso da MAVI atingido.");
    if (!provider && !env.anthropicKey)
      throw new TitleError(
        503,
        "A MAVI não está configurada no servidor. Escolha um provedor para o título das tarefas no Painel da MAVI.",
      );
    const llm: LlmAdapter = sampledLlm(
      provider ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config) : deps.llm,
      { db: env, fetch: deps.fetch, auth: authorization, company, feature: "task_title", client, providerId: provider?.id ?? null },
    );
    const result = await llm({
      instructions: TITLE_INSTRUCTIONS,
      context: "",
      messages: [
        {
          role: "user",
          content: titleMessage({
            ...input,
            client: clients[0]?.name ?? "",
            product: k.name ?? "",
          }),
        },
      ],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "low",
      maxTokens: 400,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    meter = result.meter;
    const title = cleanTaskTitle(result.text);
    if (title.length < 2) throw new TitleError(502, "A MAVI não devolveu o título.");
    return { status: 200, body: { title } };
  } catch (err) {
    if (err instanceof TitleError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "tasks",
        p_kind: "task_title",
        p_client: client,
        p_contract: contract,
        p_project: UUID.test(project) ? project : null,
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

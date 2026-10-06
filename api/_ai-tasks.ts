import crypto from "node:crypto";
import { callRpc } from "./_drive.js";
import type { Effort, LlmAdapter, RoundUsage, ToolSpec } from "./_ai-llm.js";
import {
  TOOLS,
  describeStep,
  runTool,
  summarizeStep,
  type AiScope,
  type AiSource,
  type ToolContext,
} from "./_ai-tools.js";
import { adapterFor, resolveRoute, routeConfig, withRouteEffort, type ProviderConfig } from "./_ai-providers.js";
import { logCost, meterEntries, type CostTurn } from "./_ai-cost.js";
import { addUsage, newMeter } from "./_social-leads.js";
import { embeddingCost, type Embedder } from "./_ai-embeddings.js";
import { DOCUMENT_MAX, type TaskArtifact } from "../src/mavi-artifacts.js";

/**
 * MAVI · tarefas longas (migração 20270111090000_mavi_long_tasks).
 *
 * Pedido grande demais para uma resposta (a passagem de 17 clientes, um
 * relatório de muitos clientes): a MAVI monta um plano (plan_long_task) com
 * uma etapa por capítulo, o custo estimado e o teto da empresa, e a pessoa
 * confirma no card. Aí o servidor trabalha em fatias de até ~4,5 minutos
 * (o limite da função na Vercel é 5): cada fatia pega a vez no banco, roda
 * algumas etapas em paralelo (cada uma é uma MAVI só com as ferramentas de
 * consulta, que escreve o capítulo dela) e chama a próxima fatia. Tudo com o
 * token de quem pediu: as ferramentas só veem o que a pessoa vê. Token
 * vencido, a tarefa pausa e continua quando a pessoa abrir a conversa.
 *
 * No fim (ou parada pela pessoa, ou perto do teto), a MAVI escreve a parte
 * final com tudo em mãos, junta os capítulos num documento do canvas e o
 * entrega numa resposta nova da conversa, com o custo da tarefa ligado a ela.
 */

// ------------------------------------------------------------ o plano
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const PLAN_TOOL: ToolSpec = {
  name: "plan_long_task",
  description:
    "Monta uma tarefa longa, que roda em segundo plano por alguns minutos e entrega um documento no fim (a pessoa baixa em Word ou PDF). Use quando o pedido exigir juntar muita informação de vários clientes ou escrever um material longo que não cabe numa resposta: passagem de carteira, relatório ou análise de muitos clientes, levantamento completo de vários assuntos. Cada etapa escreve um capítulo do documento. A pessoa vê o plano, o custo estimado e o teto por tarefa, e confirma antes de começar. Depois de chamar, não use mais ferramentas: escreva uma frase curta e pare.",
  parameters: obj(
    {
      title: { type: "string", description: "O título do documento final." },
      goal: {
        type: "string",
        description:
          "O pedido completo da pessoa, com tudo o que cada capítulo precisa cobrir (assuntos, período, para quem é, formato, tom). Cada etapa lê isto.",
      },
      steps: {
        type: "array",
        description: "De 1 a 40 etapas, na ordem do documento. Em geral, uma por cliente.",
        items: obj(
          {
            title: { type: "string", description: "O título do capítulo (ex.: 'Cliente 5022')." },
            instructions: {
              type: "string",
              description: "O que esta etapa levanta e escreve, além do pedido geral.",
            },
            client_ids: {
              type: "array",
              items: { type: "string" },
              description: "Os clientes desta etapa (ids de find_clients).",
            },
          },
          ["title", "instructions"],
        ),
      },
      closing: obj(
        {
          title: { type: "string" },
          instructions: { type: "string" },
        },
        ["title", "instructions"],
      ),
    },
    ["title", "goal", "steps"],
  ),
};

export const TASK_RULES = `

Tarefas longas (plan_long_task):
- Quando o pedido exigir levantar muita coisa de vários clientes (mais de 4 clientes, ou mais de umas 25 consultas) ou escrever um material longo com um capítulo por cliente ou por assunto (passagem de carteira, relatório de vários clientes, levantamento completo), não tente fazer tudo nesta resposta: monte uma tarefa longa com plan_long_task.
- Antes, ache os ids de todos os clientes com find_clients, com todos os códigos numa chamada só. Não levante o conteúdo antes: as etapas fazem isso, cada uma com as ferramentas de consulta.
- Uma etapa por cliente (ou por assunto), com instruções claras do que levantar e escrever. Ponha no goal tudo o que a pessoa pediu (os assuntos de cada capítulo, para quem é, o período). Use closing para a parte escrita no fim com tudo em mãos, que abre o documento (ex.: um resumo da carteira em tabela, com temperatura, pendências e riscos de cada cliente).
- Depois de chamar, escreva só uma frase curta dizendo que o plano está no card para a pessoa conferir e confirmar, e pare. Não diga que já começou.
- Se a pessoa pedir para continuar um trabalho grande que parou no limite de passos, monte a tarefa longa com o que falta.`;

/** As regras de uma etapa (o capítulo de um documento maior). */
export const STEP_RULES = `

Você está fazendo uma etapa de uma tarefa longa: o resultado desta etapa é um capítulo de um documento maior que a pessoa vai ler e baixar. Estas regras valem no lugar das de "Como responder" acima:
- Levante o que o capítulo precisa com as ferramentas. Para um cliente, comece por client_overview e complete com search_knowledge, list_meetings, list_tasks, campaign_results e read_more quando faltar detalhe. Faça várias consultas na mesma rodada (em paralelo).
- Responda só com o capítulo, em Markdown: comece com "## " e o título da etapa, use ### para as seções, listas e tabelas quando ajudarem. Nada de introdução ("Vou…", "Aqui está") nem de comentário sobre a tarefa.
- Cite as fontes [S#] logo depois de cada informação. Não invente: o que não achar, escreva que não encontrou no sistema.
- Escreva para quem não conhece o cliente e vai assumir o atendimento: completo, com datas, nomes e números, e direto.`;

const CLOSING_RULES = `Você escreve a parte final de um documento que a MAVI (a inteligência de uma agência de marketing) montou em etapas. Você recebe o pedido e os capítulos já escritos. Escreva só esta parte, em Markdown, começando com "## " e o título dela; use tabelas quando ajudarem. Use só o que está nos capítulos: não invente números, nomes nem datas. Mantenha as referências [S#] dos capítulos junto das informações que vieram delas. Português do Brasil, claro e direto.`;

type PlanStep = { title: string; instructions: string; client_ids: string[] };
export type Plan = {
  title: string;
  goal: string;
  steps: PlanStep[];
  closing: { title: string; instructions: string } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** O plano que o modelo mandou, conferido (os clientes, só os que a pessoa acessa). */
export function parsePlan(raw: unknown, clients: Map<string, string>): Plan | string {
  const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const title = str(i.title, 160);
  const goal = str(i.goal, 4000);
  if (title.length < 3) return "Dê um título ao documento.";
  if (goal.length < 10) return "Descreva no goal o pedido completo da pessoa.";
  const steps = (Array.isArray(i.steps) ? i.steps : [])
    .map((x): PlanStep | null => {
      const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const t = str(s.title, 160);
      if (!t) return null;
      const ids = (Array.isArray(s.client_ids) ? s.client_ids : [])
        .map((id) => str(id, 40))
        .filter((id) => UUID.test(id) && clients.has(id));
      return { title: t, instructions: str(s.instructions, 3000), client_ids: [...new Set(ids)].slice(0, 10) };
    })
    .filter((s): s is PlanStep => !!s);
  if (!steps.length) return "Mande pelo menos uma etapa, com título e instruções.";
  if (steps.length > 40) return "No máximo 40 etapas: junte clientes ou assuntos parecidos.";
  const c = (i.closing && typeof i.closing === "object" ? i.closing : null) as Record<string, unknown> | null;
  const closing = c && str(c.title, 160) ? { title: str(c.title, 160), instructions: str(c.instructions, 3000) } : null;
  return { title, goal, steps, closing };
}

// ------------------------------------------------------------ estimativa
/**
 * Quanto custa uma etapa (≈): umas 4 rodadas, com o dossiê do cliente e
 * algumas buscas, a maior parte da entrada lida do cache, e o capítulo.
 */
const STEP_TOKENS = { input: 6_000, cacheWrite: 36_000, cacheRead: 60_000, output: 9_000 };
function tokensCost(
  model: string,
  price: ProviderConfig["price"],
  t: { input: number; cacheWrite: number; cacheRead: number; output: number },
) {
  const meter = newMeter(model);
  addUsage(
    meter,
    model,
    {
      input_tokens: t.input,
      output_tokens: t.output,
      cache_read_input_tokens: t.cacheRead,
      cache_creation_input_tokens: t.cacheWrite,
    },
    price,
  );
  return meter.cost;
}
/**
 * O custo estimado da tarefa: com pelo menos 5 etapas feitas nas últimas
 * tarefas da empresa, a média delas (com folga); senão, a conta de tokens.
 */
export function estimateTask(
  plan: Pick<Plan, "steps" | "closing">,
  model: string,
  price: ProviderConfig["price"] = null,
  basis: { step: number | null; steps: number } | null = null,
) {
  const perStep =
    basis && basis.steps >= 5 && Number(basis.step) > 0
      ? Number(basis.step) * 1.1
      : tokensCost(model, price, STEP_TOKENS);
  const closing = plan.closing
    ? tokensCost(model, price, { input: 4_000 + plan.steps.length * 1_500, cacheWrite: 0, cacheRead: 0, output: 4_000 })
    : 0;
  return { perStep, total: Math.round((perStep * plan.steps.length + closing) * 100) / 100 };
}

/** O que a MAVI da conversa precisa para montar o plano. */
export type PlanKit = {
  supabaseUrl: string;
  supabaseKey: string;
  fetch: typeof fetch;
  auth: string;
  company: string;
  conversation: string | null;
  module: string;
  clients: Map<string, string>;
  model: string;
  price: ProviderConfig["price"];
  /** Cria o card na resposta (a referência T#). */
  addCard: (card: Omit<TaskArtifact, "id" | "ref">) => TaskArtifact;
};

const money = (v: number) => `US$ ${v.toFixed(2).replace(".", ",")}`;

/** plan_long_task: grava o plano (ainda sem rodar) e mostra o card. */
export async function planLongTask(kit: PlanKit, raw: unknown) {
  if (!kit.conversation) return "A tarefa longa precisa de uma conversa salva: responda normalmente desta vez.";
  const plan = parsePlan(raw, kit.clients);
  if (typeof plan === "string") return plan;
  const basis = await callRpc<{ step: number | null; steps: number }>(kit, kit.fetch, kit.auth, "ai_task_basis", {
    p_company: kit.company,
  })
    .then((r) => (r.ok ? r.data : null))
    .catch(() => null);
  const estimate = estimateTask(plan, kit.model, kit.price, basis).total;
  const r = await callRpc<{ id: string; cap: number }>(kit, kit.fetch, kit.auth, "ai_task_create", {
    p_company: kit.company,
    p_conversation: kit.conversation,
    p_title: plan.title,
    p_goal: plan.goal,
    p_steps: plan.steps,
    p_closing: plan.closing,
    p_estimate: estimate,
    p_module: kit.module,
  });
  if (!r.ok) throw new Error(r.error);
  const cap = Number(r.data.cap) || 10;
  const card = kit.addCard({ type: "task", task: r.data.id, title: plan.title, steps: plan.steps.length, estimate, cap });
  return `Plano montado [[${card.ref}]]: ${plan.steps.length} ${plan.steps.length === 1 ? "etapa" : "etapas"}${plan.closing ? ` e a parte final "${plan.closing.title}"` : ""}, custo estimado de ${money(estimate)} (teto por tarefa: ${money(cap)}${estimate > cap ? "; a estimativa passa do teto: a MAVI faz o que couber e diz o que faltou" : ""}). A pessoa confere e confirma no card; nada começou ainda. Escreva só uma frase curta com a referência [[${card.ref}]] numa linha e pare.`;
}

// ------------------------------------------------------------ o trabalho
type StepState = {
  ord: number;
  title: string;
  instructions: string;
  client_ids: string[];
  status: "pending" | "running" | "done" | "error" | "skipped";
  result?: string | null;
  error?: string | null;
  cost: number;
  attempts: number;
};
export type TaskState = {
  id: string;
  company_id: string;
  conversation: string;
  module: string;
  title: string;
  goal: string;
  closing: { title: string; instructions: string } | null;
  status: "proposed" | "running" | "paused" | "stopping" | "done" | "cancelled" | "error";
  cap: number;
  spent: number;
  estimate: number;
  turn: string;
  slices: number;
  sources: AiSource[];
  steps: StepState[];
};

type BaseContext = {
  context: string;
  members: Map<string, { name: string; email: string }>;
  clients: Map<string, string>;
  today: string;
};
/** O que vem do _ai.ts (passado aqui para não haver importação circular). */
export type TaskHost = {
  instructions: string;
  buildContext: (auth: string, company: string, scope: AiScope, now: number) => Promise<BaseContext>;
  effort: (efforts: Record<string, string>) => Effort | undefined;
};
export type TaskEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  providerKey: Buffer | null;
  model: string;
  embeddingModel: string;
  /** Quanto uma fatia trabalha (ms). */
  sliceMs: number;
};
export type TaskDeps = {
  fetch: typeof fetch;
  llm: LlmAdapter;
  embed: Embedder;
  providerLlm?: (config: ProviderConfig) => LlmAdapter;
  now?: () => number;
  /** Continua o trabalho depois da resposta (waitUntil na Vercel). */
  background?: (work: Promise<unknown>) => void;
  /** Chama a próxima fatia (o endereço desta função); sem ele, pausa. */
  next?: (auth: string, task: string) => Promise<boolean>;
};

/** Quanto tempo uma etapa precisa, no mínimo, para começar dentro da fatia. */
const STEP_MIN_MS = 150_000;
/** Quanto a parte final e a montagem do documento precisam. */
const FINISH_MIN_MS = 100_000;
/** Etapas ao mesmo tempo numa fatia. */
const PARALLEL = 3;
const AUTH_PAUSE =
  "O acesso da sua sessão venceu no meio da tarefa: ela continua sozinha quando você abrir esta conversa.";
const NEXT_PAUSE =
  "A próxima parte da tarefa não começou sozinha: ela continua quando você abrir esta conversa.";

function tokenClaims(auth: string): Record<string, unknown> {
  try {
    const payload = auth.replace(/^Bearer\s+/, "").split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) ?? {};
  } catch {
    return {};
  }
}
/** Quando o token vence (segundos desde 1970), ou null. */
export function tokenExpiry(auth: string) {
  const exp = tokenClaims(auth).exp;
  return typeof exp === "number" ? exp : null;
}

class AuthLost extends Error {}

const cleanError = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 280);

/**
 * As fontes de uma etapa passam a ser da tarefa: cada [S#] local vira o da
 * tarefa (a mesma fonte, a mesma referência) e o texto muda junto.
 */
export function mergeSources(all: AiSource[], local: AiSource[], text: string) {
  const map = new Map<string, string>();
  const added: AiSource[] = [];
  for (const s of local) {
    const same = [...all, ...added].find(
      (x) =>
        x.type === s.type && x.id === s.id && x.start === s.start && x.page === s.page && x.url === s.url,
    );
    if (same) map.set(s.ref, same.ref);
    else {
      const ref = `S${all.length + added.length + 1}`;
      added.push({ ...s, ref });
      map.set(s.ref, ref);
    }
  }
  const out = text.replace(/\[S(\d+)\]/g, (m, n) => {
    const to = map.get(`S${n}`);
    return to ? `[${to}]` : "";
  });
  return { text: out, added };
}

/** O capítulo começa pelo título dele (o modelo às vezes esquece). */
export function chapter(title: string, text: string) {
  const body = text.trim();
  return /^##\s/.test(body) ? body : `## ${title}\n\n${body.replace(/^#\s+.*\n+/, "")}`;
}

const brDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
const SOURCE_KIND: Record<string, string> = {
  meeting: "Reunião",
  task: "Tarefa",
  file: "Arquivo",
  social: "Social Leads",
  campaign: "Campanha",
  case: "Case",
  whatsapp: "WhatsApp",
  web: "Página",
  attachment: "Anexo",
  note: "Anotação do cliente",
};

/** O documento final: o título, a parte final (no começo), os capítulos e as fontes. */
export function assembleDocument(
  task: Pick<TaskState, "title" | "steps" | "closing" | "sources">,
  opts: { today: string; who: string; closingText: string | null; missing: string | null },
) {
  const done = task.steps.filter((s) => s.status === "done").length;
  const parts = [
    `# ${task.title}`,
    `_Preparado pela MAVI em ${brDate(opts.today)} para ${opts.who}. ${done} de ${task.steps.length} ${task.steps.length === 1 ? "parte pronta" : "partes prontas"}._`,
  ];
  if (opts.missing) parts.push(`> ${opts.missing}`);
  if (opts.closingText) parts.push(chapter(task.closing?.title ?? "Resumo", opts.closingText));
  for (const s of task.steps)
    parts.push(
      s.status === "done" && s.result
        ? chapter(s.title, s.result)
        : `## ${s.title}\n\n_Esta parte não ficou pronta${s.error ? ` (${s.error})` : ""}._`,
    );
  let body = parts.join("\n\n");
  const cited = new Set([...body.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`));
  const list = task.sources.filter((s) => cited.has(s.ref));
  const sources = list.length
    ? `\n\n## Fontes\n\n${list
        .map(
          (s) =>
            `- [${s.ref}] ${SOURCE_KIND[s.type] ?? "Fonte"} “${s.title}”${s.date ? ` · ${new Date(s.date).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : ""}${s.url ? ` · ${s.url}` : ""}`,
        )
        .join("\n")}`
    : "";
  const room = DOCUMENT_MAX - sources.length - 200;
  if (body.length > room) body = `${body.slice(0, room)}\n\n_(O documento foi cortado por ser longo demais.)_`;
  return { markdown: body + sources, cited: list, done };
}

type Rpc = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

/** Uma fatia do trabalho: pega a vez, faz etapas, chama a próxima ou termina. */
export async function runSlice(
  auth: string,
  taskId: string,
  env: TaskEnv,
  deps: TaskDeps,
  host: TaskHost,
): Promise<"busy" | "next" | "paused" | "finished" | "error"> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + env.sliceMs;
  let authLost = false;
  const rpc: Rpc = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await callRpc<T>(env, deps.fetch, auth, name, args);
    if (!r.ok) {
      if (r.status === 403 && /JWT|token|expired|autenticad/i.test(r.error)) throw new AuthLost(r.error);
      throw new Error(r.error);
    }
    return r.data;
  };
  const release = (status: "running" | "paused" | "error", reason: string | null) =>
    rpc("ai_task_release", { p_task: taskId, p_status: status, p_reason: reason }).catch(() => null);

  let task: TaskState | null;
  try {
    task = await rpc<TaskState | null>("ai_task_claim", {
      p_task: taskId,
      p_seconds: Math.ceil(env.sliceMs / 1000) + 60,
    });
  } catch {
    return "error";
  }
  if (!task) return "busy";
  const exp = tokenExpiry(auth);
  if (exp !== null && exp * 1000 - now() < env.sliceMs + 60_000) {
    await release("paused", AUTH_PAUSE);
    return "paused";
  }
  try {
    const base = await host.buildContext(auth, task.company_id, { module: task.module }, now());
    const scopeFor = (step: StepState): AiScope => ({
      module: task!.module,
      ...(step.client_ids.length === 1 ? { client: step.client_ids[0] } : {}),
    });
    const [route, efforts, limits] = await Promise.all([
      resolveRoute(env, deps.fetch, auth, task.company_id, {}, "mavi_page").catch(() => null),
      callRpc<Record<string, string>>(env, deps.fetch, auth, "ai_efforts", { p_company: task.company_id })
        .then((r) => (r.ok && r.data && typeof r.data === "object" ? r.data : {}))
        .catch(() => ({}) as Record<string, string>),
      callRpc<{ blocked: boolean; message: string | null }>(env, deps.fetch, auth, "ai_check_limits", {
        p_company: task.company_id,
        p_client: null,
        p_contract: null,
        p_project: null,
      }).catch(() => null),
    ]);
    const provider = route ? routeConfig(env, route) : null;
    const llm = provider
      ? (deps.providerLlm ?? ((c: ProviderConfig) => adapterFor(c, deps.fetch)))(provider)
      : deps.llm;
    const model = provider?.model || env.model;
    const effort = host.effort(withRouteEffort(efforts, route, "mavi_page")) ?? "medium";
    const perStep = estimateTask({ steps: [task.steps[0]], closing: null }, model, provider?.price ?? null).perStep;
    const turn: CostTurn = { conversation: task.conversation, turn: task.turn, entries: [], pending: [] };
    const sub = tokenClaims(auth).sub;
    const who = (typeof sub === "string" && base.members.get(sub)?.name) || "quem pediu";
    const blocked = limits?.ok && limits.data.blocked ? (limits.data.message ?? "Limite de uso da MAVI atingido.") : null;

    let stop = task.status === "stopping";
    let capReached = false;
    const context =
      `${base.context}\n\nA tarefa longa: "${task.title}".\nO pedido da pessoa: ${task.goal}\n` +
      `Os capítulos do documento, na ordem: ${task.steps.map((s) => `${s.ord}. ${s.title}`).join("; ")}.`;

    /** Uma etapa: a MAVI com as ferramentas de consulta escreve o capítulo. */
    const runStep = async (step: StepState) => {
      const start = await rpc<{ status: string; spent: number; cap: number; run: boolean }>("ai_task_step_start", {
        p_task: taskId,
        p_ord: step.ord,
      });
      if (!start.run) {
        step.status = "error";
        return;
      }
      step.status = "running";
      const scope = scopeFor(step);
      const ctx: ToolContext = {
        supabaseUrl: env.supabaseUrl,
        supabaseKey: env.supabaseKey,
        fetch: deps.fetch,
        auth,
        company: task!.company_id,
        scope,
        embed: deps.embed,
        members: base.members,
        clients: base.clients,
        today: base.today,
        usage: { embeddingTokens: 0, embeddingModel: env.embeddingModel },
        sources: [],
        chunks: new Map(),
      };
      const calls: { tool: string; power: null; ok: boolean; ms: number; cost: number; error?: string }[] = [];
      const stopAt = new AbortController();
      const timer = setTimeout(() => stopAt.abort(), Math.max(deadline - now() - 20_000, 5_000));
      const clients = step.client_ids.map((id) => `${base.clients.get(id) ?? "?"} (id ${id})`);
      const rounds: RoundUsage[] = [];
      let result: Awaited<ReturnType<LlmAdapter>> | null = null;
      let failure: unknown = null;
      try {
        result = await llm({
          instructions: host.instructions + STEP_RULES,
          context,
          messages: [
            {
              role: "user",
              content: `Faça a etapa ${step.ord} de ${task!.steps.length}: "${step.title}".${step.instructions ? `\n${step.instructions}` : ""}${clients.length ? `\nClientes desta etapa: ${clients.join(", ")}.` : ""}\nResponda só com o capítulo, começando com "## ${step.title}".`,
            },
          ],
          tools: TOOLS,
          execute: async (name, input) => {
            const t0 = Date.now();
            try {
              const out = await runTool(ctx, name, input);
              calls.push({ tool: name, power: null, ok: true, ms: Date.now() - t0, cost: 0 });
              return out;
            } catch (e) {
              if (e instanceof AuthLost) authLost = true;
              calls.push({ tool: name, power: null, ok: false, ms: Date.now() - t0, cost: 0, error: cleanError(e) });
              throw e;
            }
          },
          maxRounds: 8,
          effort,
          maxTokens: 16_000,
          onRound: (r) => rounds.push(r),
          signal: stopAt.signal,
          cacheContext: true,
          cacheConversation: true,
          cacheKey: `${task!.company_id}:task:${taskId}`,
        });
      } catch (e) {
        failure = e;
      } finally {
        clearTimeout(timer);
      }
      // O gasto conta mesmo quando a etapa não termina.
      const spent = rounds.reduce((n, r) => n + r.cost, 0) + embeddingCost(ctx.usage.embeddingModel, ctx.usage.embeddingTokens);
      const where = { company: task!.company_id, module: task!.module, client: scope.client ?? null };
      const entries = result
        ? meterEntries("task", result.meter, route?.provider_id ?? null, model, provider?.name ?? null)
        : rounds.length
          ? [
              {
                kind: "task",
                model,
                provider: route?.provider_id ?? null,
                input: rounds.reduce((n, r) => n + r.input, 0),
                output: rounds.reduce((n, r) => n + r.output, 0),
                cacheRead: rounds.reduce((n, r) => n + r.cacheRead, 0),
                cacheWrite: rounds.reduce((n, r) => n + r.cacheWrite, 0),
                embedding: 0,
                cost: rounds.reduce((n, r) => n + r.cost, 0),
              },
            ]
          : [];
      if (ctx.usage.embeddingTokens)
        entries.push({
          kind: "search",
          model: ctx.usage.embeddingModel,
          provider: null,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          embedding: ctx.usage.embeddingTokens,
          cost: embeddingCost(ctx.usage.embeddingModel, ctx.usage.embeddingTokens),
        });
      await Promise.all(entries.map((e) => logCost(env, deps.fetch, auth, where, e, turn)));
      if (calls.length)
        void callRpc(env, deps.fetch, auth, "ai_log_tool_calls", {
          p_company: task!.company_id,
          p_conversation: task!.conversation,
          p_module: task!.module,
          p_calls: calls.slice(0, 60),
        }).catch(() => null);
      const text = result?.text.trim() ?? "";
      const ok = !!result && text.length >= 40;
      const merged = ok ? mergeSources(task!.sources, ctx.sources, text) : { text: "", added: [] };
      if (ok) task!.sources.push(...merged.added);
      const saved = await rpc<{ status: string; spent: number; cap: number }>("ai_task_step_save", {
        p_task: taskId,
        p_ord: step.ord,
        p_status: ok ? "done" : "pending",
        p_result: ok ? merged.text : null,
        p_error: ok
          ? null
          : failure
            ? stopAt.signal.aborted
              ? "O tempo desta rodada acabou; a etapa volta para a fila."
              : cleanError(failure)
            : "A etapa terminou sem o capítulo.",
        p_cost: Math.round(spent * 1e4) / 1e4,
        p_sources: merged.added,
      });
      step.status = ok ? "done" : "pending";
      step.result = ok ? merged.text : null;
      step.cost += spent;
      task!.spent = Number(saved.spent) || task!.spent + spent;
      if (saved.status === "stopping") stop = true;
      if (failure instanceof AuthLost) authLost = true;
    };

    // As etapas da fila, algumas ao mesmo tempo, enquanto houver tempo e verba.
    const queue = task.steps.filter((s) => s.status === "pending");
    const canStart = () => {
      if (stop || authLost || blocked) return false;
      if (task!.spent + perStep * 1.2 > task!.cap) {
        capReached = true;
        return false;
      }
      return now() < deadline - STEP_MIN_MS;
    };
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (queue.length && canStart()) {
        const step = queue.shift()!;
        await runStep(step).catch((e) => {
          if (e instanceof AuthLost) authLost = true;
          step.status = "pending";
        });
      }
    });
    await Promise.all(workers);

    if (authLost) {
      await release("paused", AUTH_PAUSE);
      return "paused";
    }
    const left = task.steps.filter((s) => s.status === "pending" || s.status === "running");
    if (left.length && !stop && !capReached && !blocked) {
      await release("running", null);
      const went = deps.next ? await deps.next(auth, taskId).catch(() => false) : false;
      if (!went) await release("paused", NEXT_PAUSE);
      return went ? "next" : "paused";
    }
    // A parte final e o documento: sem tempo, a próxima fatia faz.
    if (now() > deadline - FINISH_MIN_MS && task.closing && task.steps.some((s) => s.status === "done")) {
      await release("running", null);
      const went = deps.next ? await deps.next(auth, taskId).catch(() => false) : false;
      if (!went) await release("paused", NEXT_PAUSE);
      return went ? "next" : "paused";
    }
    const missing = left.length
      ? `${stop ? "Tarefa parada por você" : capReached ? `A tarefa chegou perto do teto de ${money(task.cap)}` : (blocked ?? "A tarefa parou")}: ${left.length} ${left.length === 1 ? "parte ficou" : "partes ficaram"} de fora (${left.map((s) => s.title).join(", ")}). Peça para continuar numa nova tarefa, se quiser.`
      : null;
    await finish(task, { base, llm, model, route, provider, turn, rpc, env, deps, auth, effort, missing, who, stopped: stop });
    return "finished";
  } catch (e) {
    if (e instanceof AuthLost || authLost) {
      await release("paused", AUTH_PAUSE);
      return "paused";
    }
    await release("error", cleanError(e));
    return "error";
  }
}

/** A parte final, o documento e a resposta na conversa. */
async function finish(
  task: TaskState,
  x: {
    base: BaseContext;
    llm: LlmAdapter;
    model: string;
    route: { provider_id: string } | null;
    provider: ProviderConfig | null;
    turn: CostTurn;
    rpc: Rpc;
    env: TaskEnv;
    deps: TaskDeps;
    auth: string;
    effort: Effort;
    missing: string | null;
    who: string;
    /** Parada pela pessoa: a entrega fica como cancelada. */
    stopped: boolean;
  },
) {
  const done = task.steps.filter((s) => s.status === "done" && s.result);
  let closingText: string | null = null;
  if (task.closing && done.length) {
    const material = done.map((s) => (s.result!.length > 4000 ? `${s.result!.slice(0, 4000)}\n(…)` : s.result!)).join("\n\n");
    try {
      const out = await x.llm({
        instructions: CLOSING_RULES,
        context: `Hoje é ${x.base.today}.`,
        messages: [
          {
            role: "user",
            content: `O pedido: ${task.goal}\n\nEscreva a parte "${task.closing.title}": ${task.closing.instructions}\n\nOs capítulos:\n\n${material}`,
          },
        ],
        tools: [],
        execute: async () => "",
        maxRounds: 0,
        effort: x.effort,
        maxTokens: 12_000,
      });
      closingText = out.text.trim() || null;
      await Promise.all(
        meterEntries("task", out.meter, x.route?.provider_id ?? null, x.model, x.provider?.name ?? null).map((e) =>
          logCost(x.env, x.deps.fetch, x.auth, { company: task.company_id, module: task.module }, e, x.turn),
        ),
      );
    } catch {
      closingText = null;
    }
  }
  // A referência do documento: a próxima D# da conversa.
  const past = await x.deps
    .fetch(
      `${x.env.supabaseUrl}/rest/v1/ai_messages?select=artifacts&conversation_id=eq.${task.conversation}&role=eq.assistant`,
      { headers: { apikey: x.env.supabaseKey, Authorization: x.auth } },
    )
    .then((r) => (r.ok ? (r.json() as Promise<{ artifacts: { ref?: string }[] | null }[]>) : []))
    .catch(() => []);
  const nextD =
    Math.max(
      0,
      ...past.flatMap((m) => (m.artifacts ?? []).map((a) => (/^D(\d+)$/.exec(a.ref ?? "") ? Number(a.ref!.slice(1)) : 0))),
    ) + 1;
  const doc = assembleDocument(task, { today: x.base.today, who: x.who, closingText, missing: x.missing });
  const ref = `D${Math.min(nextD, 99)}`;
  const artifact = {
    id: crypto.randomUUID(),
    ref,
    type: "canvas",
    canvas: { kind: "document", title: task.title.slice(0, 120), markdown: doc.markdown },
  };
  const failed = !doc.done;
  const answer = failed
    ? x.stopped
      ? `Parei a tarefa longa **${task.title}** antes de alguma parte ficar pronta.`
      : `Não consegui terminar a tarefa longa **${task.title}**: nenhuma parte ficou pronta.${x.missing ? ` ${x.missing}` : ""}`
    : `Terminei a tarefa longa **${task.title}**: ${doc.done} de ${task.steps.length} ${task.steps.length === 1 ? "parte pronta" : "partes prontas"}${closingText && task.closing ? `, com "${task.closing.title}" no começo` : ""}. O documento está abaixo e baixa em Word ou PDF.\n\n[[${ref}]]${x.missing ? `\n\n${x.missing}` : ""}`;
  const steps = [
    {
      label: `Tarefa longa: ${task.steps.length} ${task.steps.length === 1 ? "etapa" : "etapas"} em ${task.slices} ${task.slices === 1 ? "rodada" : "rodadas"} no servidor`,
      detail: `${money(task.spent)} de ${money(task.cap)}`,
    },
    ...task.steps.map((s) => ({
      label: s.title,
      detail: s.status === "done" ? "pronta" : s.status === "error" ? "com erro" : "ficou de fora",
    })),
  ].slice(0, 60);
  const message = await x.rpc<number>("ai_task_finish", {
    p_task: task.id,
    p_answer: answer,
    p_sources: doc.cited,
    p_artifacts: failed ? [] : [artifact],
    p_steps: steps,
    // Parada pela pessoa, o banco guarda como cancelada.
    p_status: failed && !x.stopped ? "error" : "done",
  });
  // O gasto de todas as fatias fica nesta resposta (o custo da conversa).
  await Promise.all(x.turn.pending).catch(() => null);
  await callRpc(x.env, x.deps.fetch, x.auth, "ai_usage_close_turn", {
    p_conversation: task.conversation,
    p_turn: task.turn,
  }).catch(() => null);
  return message;
}

// ------------------------------------------------------------ as ações
const UUIDish = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);

/**
 * ai-task-confirm (o card), ai-task-resume (a próxima fatia, ou a tela que
 * abriu uma tarefa pausada) e ai-task-stop. O trabalho segue depois da
 * resposta (waitUntil).
 */
export async function handleTaskAction(
  req: Record<string, unknown>,
  auth: string | null,
  env: TaskEnv,
  deps: TaskDeps,
  host: TaskHost,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!auth?.startsWith("Bearer ")) return { status: 401, body: { error: "Entre na sua conta." } };
  const task = UUIDish(req.task);
  if (!task) return { status: 400, body: { error: "Tarefa inválida." } };
  const later = (work: Promise<unknown>) => {
    if (deps.background) deps.background(work);
    return work;
  };
  const kick = () => later(runSlice(auth, task, env, deps, host).catch(() => "error"));
  const rpc = async (name: string) => {
    const r = await callRpc<Record<string, unknown> | null>(env, deps.fetch, auth, name, { p_task: task });
    if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status });
    return r.data;
  };
  try {
    if (req.action === "ai-task-confirm") {
      const t = await rpc("ai_task_confirm");
      const work = kick();
      if (!deps.background) await work;
      return { status: 200, body: { task: t } };
    }
    if (req.action === "ai-task-stop") {
      const t = await rpc("ai_task_stop");
      // Pausada (ninguém rodando): uma fatia entrega o que já tem.
      if (t?.status === "stopping") {
        const work = kick();
        if (!deps.background) await work;
      }
      return { status: 200, body: { task: t } };
    }
    if (req.action === "ai-task-resume") {
      const work = kick();
      if (!deps.background) await work;
      return { status: 202, body: { ok: true } };
    }
    return { status: 400, body: { error: "Ação inválida." } };
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return { status: status >= 400 && status < 600 ? status : 500, body: { error: (e as Error).message } };
  }
}

/** O endereço desta função para a próxima fatia: o do app ou o da Vercel. */
export function selfOrigin(host: string | undefined, appOrigin: string, override?: string) {
  const o = override?.trim().replace(/\/+$/, "");
  if (o && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) return o;
  const h = (host ?? "").trim().toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/.test(h) || `https://${h}` === appOrigin) return `https://${h}`;
  return appOrigin;
}

/** A próxima fatia: chama esta função de novo com o token de quem pediu. */
export function nextSlice(origin: string, fetchImpl: typeof fetch) {
  return async (auth: string, task: string) => {
    const res = await fetchImpl(`${origin}/api/ai`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ai-task-resume", task }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok;
  };
}

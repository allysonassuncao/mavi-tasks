import crypto from "node:crypto";
import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import { extractFileText } from "./_ai-extract.js";
import {
  EmbeddingError,
  embeddingCost,
  openAiEmbedder,
  vectorLiteral,
  type Embedder,
} from "./_ai-embeddings.js";
import {
  anthropicAdapter,
  llmFriendlyError,
  type ChatTurn,
  type LlmAdapter,
} from "./_ai-llm.js";
import {
  TOOLS,
  describeStep,
  runTool,
  summarizeStep,
  temperatureLine,
  type AiScope,
  type AiSource,
  type ToolContext,
} from "./_ai-tools.js";
import {
  adapterFor,
  handleProviders,
  providerKeyFrom,
  resolveRoute,
  routeConfig,
  type ProviderConfig,
} from "./_ai-providers.js";
import { serverModel, embeddingModel } from "../src/ai-providers.js";
import {
  REGISTRY,
  describePowerStep,
  historyTurn,
  powerInstructions,
  runPowerTool,
  summarizePowerStep,
  toolsFor,
  type PowerKit,
} from "./_ai-powers.js";
import {
  sanitizeArtifacts,
  type AiArtifact,
  type Power,
} from "../src/mavi-artifacts.js";
import {
  catalogContext,
  describeSkillStep,
  loadSkill,
  pickedSkills,
  runSkillTool,
  summarizeSkillStep,
  type CatalogSkill,
  type SkillKit,
} from "./_ai-skills.js";

/**
 * IA do MAVI (ações "ai-*" de /api/ai, que é a função api/drive.ts):
 *
 * - "ai-ask": uma pergunta de quem está logado. O modelo recebe o contexto
 *   (quem pergunta, o cliente/produto/projeto aberto, a data) e ferramentas
 *   de busca; lê só os trechos relevantes e responde citando [S#]. A resposta
 *   volta com as fontes citadas (reunião no minuto, tarefa).
 * - "ai-index": o worker, chamado pelo pg_cron (mavi_private.ai_kick) com o
 *   segredo: monta os documentos da fila e gera os vetores em lotes, até o
 *   tempo acabar. Vários ao mesmo tempo não repetem trabalho.
 */

export type AiEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  anthropicKey: string;
  model: string;
  openaiKey: string;
  embeddingModel: string;
  workerSecret: string;
  /** Quanto o worker trabalha por chamada (ms). */
  workerBudgetMs: number;
  /** Abre as API Keys da biblioteca de provedores (AI_PROVIDER_KEY). */
  providerKey: Buffer | null;
  /** O modelo de imagem do servidor, sem regra no painel (IMAGE_MODEL). */
  imageModel: string;
  /** GCS do Drive: o worker baixa os arquivos para ler o texto. */
  credentials?: GcsCredentials | null;
  bucket?: string;
};
export function aiEnv(
  base: {
    supabaseUrl: string;
    supabaseKey: string;
    credentials?: GcsCredentials | null;
    bucket?: string;
  },
  env: Record<string, string | undefined> = process.env,
): AiEnv {
  return {
    ...base,
    anthropicKey: env.ANTHROPIC_API_KEY ?? "",
    model: serverModel("assistant", env),
    openaiKey: env.OPENAI_API_KEY ?? "",
    embeddingModel: embeddingModel(env),
    // Sem espaços nas pontas: colado na Vercel com uma quebra de linha, o
    // segredo nunca bateria com o do banco (o cabeçalho chega sem ela).
    workerSecret: env.AI_WORKER_SECRET?.trim() ?? "",
    workerBudgetMs: Number(env.AI_WORKER_BUDGET_MS) || 50_000,
    providerKey: providerKeyFrom(env.AI_PROVIDER_KEY),
    imageModel: serverModel("image_generation", env),
  };
}

export type AiDeps = {
  fetch: typeof fetch;
  llm: LlmAdapter;
  embed: Embedder;
  now?: () => number;
  /** Baixa um arquivo do Drive (trocado nos testes). */
  download?: (path: string) => Promise<Uint8Array>;
  /** O adaptador de um provedor da biblioteca (trocado nos testes). */
  providerLlm?: (config: ProviderConfig) => LlmAdapter;
};
export function aiDeps(env: AiEnv): AiDeps {
  return {
    fetch,
    llm: anthropicAdapter(env),
    embed: openAiEmbedder(env, fetch),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_LABELS: Record<string, string> = {
  admin: "administrador",
  manager: "gestor",
  member: "colaborador",
};

export const INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing (clientes, produtos contratados, projetos, tarefas, reuniões gravadas, arquivos do Drive, grupos de WhatsApp dos clientes, Social Leads, campanhas de tráfego pago e cases de sucesso). Você responde perguntas do time sobre os clientes com base no que está registrado no sistema. Seu nome é MAVI, no feminino ("a MAVI"): quando falar de si, use o feminino.

Como trabalhar:
- Para qualquer pergunta sobre fatos (o que foi dito, combinado, pedido, prometido, decidido, reclamado), busque antes de responder. Nunca responda de memória nem invente.
- Use search_knowledge com os termos que provavelmente aparecem no texto. Para perguntas amplas, faça 2 a 4 buscas com formulações diferentes na mesma rodada (em paralelo).
- Use list_meetings e list_tasks para perguntas de lista, contagem ou situação atual ("quais", "quantas", "a última", "o que está atrasado"). Status, responsável e prazo das tarefas vêm atualizados dessas ferramentas.
- Para desempenho, verba e resultados de anúncios, use campaign_results (os números vêm dos dias sincronizados; nunca calcule de cabeça o que a ferramenta já traz). Para evolução no tempo, "dia a dia" ou "por dia", peça by_day: o sistema tem os números de cada dia de cada campanha. Anotações e ciclos das campanhas também aparecem na busca.
- Documentos do cliente (propostas, contratos, briefings, planilhas, apresentações) estão nos arquivos do Drive; o briefing e os planos mensais do Social Leads (com os 8 posts e a decisão do cliente) também entram na busca.
- Cases de sucesso aprovados (resultados em números, nichos, produtos, links e contatos do cliente) entram na busca com o tipo case: use quando pedirem prova social, exemplos de resultado ou "tem case de…". Diga o cliente, o nicho e os números, e cite.
- As conversas dos grupos de WhatsApp com cada cliente entram na busca com o tipo whatsapp: o que o cliente pediu, reclamou, aprovou ou combinou no dia a dia. Os áudios aparecem transcritos e o texto dos documentos enviados também; imagens e vídeos aparecem só como "[imagem]" e "[vídeo]" (você não vê o conteúdo deles, diga isso se perguntarem). Cada trecho traz a data e o horário das mensagens.
- Para como está a relação com um cliente (satisfeito, irritado, em risco de cancelar, esfriando), use client_temperature: o termômetro que o sistema calcula lendo as reuniões e os grupos de WhatsApp, com indicadores, sinais de alerta, tendência e as leituras que mais pesaram. Sem cliente, ela lista a carteira do mais frio ao mais quente. Diga a nota e a faixa, o que puxa para cima ou para baixo e cite as leituras; para o que exatamente foi dito, complete com search_knowledge.
- Use read_more quando um trecho parecer cortado ou precisar de mais contexto.
- Pare de buscar assim que tiver o suficiente. Se nada relevante aparecer, diga claramente que não encontrou no sistema e sugira onde procurar.

Como responder:
- Cite a fonte logo depois de cada informação, com a referência exata entre colchetes, por exemplo [S2] ou [S1][S4]. Use só referências devolvidas pelas ferramentas.
- Transcrições são automáticas: nomes e palavras podem sair errados. Quando algo for ambíguo, avise.
- Quando houver datas, diga quando foi. Se informações se contradizem ao longo do tempo, mostre a mais recente e o que mudou.
- Português do Brasil, direto: frases curtas, listas com "-" quando ajudar, negrito com ** só no essencial. Sem títulos (#) e sem tabelas.`;

type Row = Record<string, unknown>;
async function rest<T = Row>(
  env: AiEnv,
  deps: AiDeps,
  auth: string,
  path: string,
): Promise<T[]> {
  const res = await deps.fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: env.supabaseKey, Authorization: auth },
  });
  if (!res.ok)
    throw new AiError(
      res.status === 401 ? 401 : 502,
      "Não foi possível ler os dados.",
    );
  return (await res.json()) as T[];
}

class AiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** O id de quem pergunta, lido do token (só para o contexto; o banco confere o acesso). */
function userIdFrom(auth: string) {
  try {
    const payload = auth.replace(/^Bearer\s+/, "").split(".")[1];
    const sub = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

const todayKey = (now: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

function conversation(question: unknown, history: unknown): ChatTurn[] {
  const q = typeof question === "string" ? question.trim() : "";
  if (q.length < 2 || q.length > 2000)
    throw new AiError(400, "Escreva uma pergunta de até 2.000 caracteres.");
  const turns = (Array.isArray(history) ? history : [])
    .filter(
      (t): t is ChatTurn =>
        !!t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string" &&
        !!t.content.trim(),
    )
    .slice(-12)
    // As referências das respostas antigas não valem nesta pergunta.
    .map((t) => ({
      role: t.role,
      content: t.content.replace(/\[S\d+\]/g, "").slice(0, 8000),
    }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  const clean: ChatTurn[] = [];
  for (const t of turns)
    if (!clean.length || clean[clean.length - 1].role !== t.role) clean.push(t);
  if (clean.length && clean[clean.length - 1].role === "user") clean.pop();
  return [...clean, { role: "user", content: q }];
}

/** O que o modelo precisa saber sobre quem pergunta e onde. */
export async function buildContext(
  env: AiEnv,
  deps: AiDeps,
  auth: string,
  company: string,
  scope: AiScope,
  now: number,
) {
  const userId = userIdFrom(auth);
  const [members, clients, contracts, temperature] = await Promise.all([
    rest<{
      user_id: string;
      name: string;
      email: string | null;
      role: string;
      active: boolean;
      hidden_pages?: string[] | null;
    }>(
      env,
      deps,
      auth,
      `memberships?select=user_id,name,email,role,active,hidden_pages&company_id=eq.${company}`,
    ),
    rest<{ id: string; name: string }>(
      env,
      deps,
      auth,
      `clients?select=id,name&company_id=eq.${company}` +
        (scope.client ? `&id=eq.${scope.client}` : "&archived=is.false"),
    ),
    scope.client
      ? rest<{
          id: string;
          name: string;
          archived: boolean;
          products: { name: string } | null;
        }>(
          env,
          deps,
          auth,
          `contracts?select=id,name,archived,products(name)&company_id=eq.${company}&client_id=eq.${scope.client}`,
        )
      : Promise.resolve([]),
    // O termômetro do cliente entra no contexto (sem ele, a conversa segue).
    scope.client
      ? callRpc<Parameters<typeof temperatureLine>[0]>(env, deps.fetch, auth, "client_temperature", {
          p_company: company,
          p_client: scope.client,
          p_days: 0,
          p_signals: 0,
        })
          .then((r) => (r.ok ? r.data : null))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const open = contracts.filter((k) => !k.archived).map((k) => k.id);
  const projects = open.length
    ? await rest<{ id: string; name: string; contract_id: string }>(
        env,
        deps,
        auth,
        `projects?select=id,name,contract_id&company_id=eq.${company}&archived=is.false&contract_id=in.(${open.join(",")})`,
      )
    : [];
  const me = members.find((m) => m.user_id === userId);
  if (!me) throw new AiError(403, "Sem acesso a esta empresa.");
  if (scope.client && !clients.length)
    throw new AiError(403, "Sem acesso a este cliente.");
  const memberMap = new Map(
    members.map((m) => [
      m.user_id,
      { name: m.name, email: (m.email ?? "").toLowerCase() },
    ]),
  );
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));
  const today = todayKey(now);
  const weekday = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(now));
  const lines = [
    `Hoje é ${weekday} (${today}).`,
    `Quem pergunta: ${me.name} (${ROLE_LABELS[me.role] ?? me.role}).`,
  ];
  if (scope.client) {
    const products = contracts
      .filter((k) => !k.archived)
      .map((k) => {
        const own = projects
          .filter((p) => p.contract_id === k.id)
          .map((p) => p.name);
        return `${k.products?.name ?? k.name}${k.products?.name && k.name !== k.products.name ? ` (${k.name})` : ""}${own.length ? ` — projetos: ${own.join(", ")}` : ""}`;
      });
    lines.push(
      `A pergunta foi feita dentro do cliente "${clientMap.get(scope.client)}" (no sistema, o nome do cliente é o código dele): as ferramentas já buscam só nele.`,
      products.length ? `Produtos contratados: ${products.join("; ")}.` : "",
      temperatureLine(temperature),
    );
  } else {
    lines.push(
      "A pergunta pode envolver qualquer cliente que a pessoa acessa. Quando ela citar um cliente, use find_clients para achar o id e depois filtre as buscas por ele.",
    );
  }
  if (scope.module === "meetings")
    lines.push(
      "A pessoa está na pasta Gravações da MAVI: reuniões costumam ser o foco, mas use também as tarefas quando ajudar.",
    );
  return {
    context: lines.filter(Boolean).join("\n"),
    members: memberMap,
    clients: clientMap,
    today,
    /** Os módulos que um administrador escondeu de quem pergunta. */
    hidden: me.hidden_pages ?? [],
  };
}

/** Só as fontes citadas na resposta, na ordem em que aparecem. */
export function citedSources(answer: string, sources: AiSource[]) {
  const order = [...answer.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`);
  const seen = new Set<string>();
  return order
    .filter((ref) => !seen.has(ref) && seen.add(ref))
    .map((ref) => sources.find((s) => s.ref === ref))
    .filter((s): s is AiSource => !!s);
}

/** O que a tela recebe enquanto a IA trabalha (uma linha JSON por evento). */
export type AiStreamEvent =
  | {
      type: "step";
      id: string;
      label: string;
      state: "running" | "done" | "error";
      detail?: string;
    }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "round_end" }
  | { type: "warning"; text: string }
  | { type: "artifact"; artifact: AiArtifact }
  | {
      type: "done";
      answer: string;
      sources: AiSource[];
      artifacts: AiArtifact[];
      conversation: string | null;
    }
  | { type: "error"; error: string; status: number };
type Emit = (event: AiStreamEvent) => void;

async function ask(
  body: Row,
  auth: string,
  env: AiEnv,
  deps: AiDeps,
  emit: Emit,
): Promise<Extract<AiStreamEvent, { type: "done" }>> {
  const company = String(body.company ?? "");
  if (!UUID.test(company)) throw new AiError(400, "Empresa inválida.");
  const raw = (body.scope ?? {}) as Row;
  const id = (v: unknown) =>
    typeof v === "string" && UUID.test(v) ? v : undefined;
  const scope: AiScope = {
    client: id(raw.client),
    contract: id(raw.contract),
    project: id(raw.project),
    module:
      typeof raw.module === "string" ? raw.module.slice(0, 40) : undefined,
  };
  const conversationId = id(body.conversation) ?? null;
  const question = typeof body.question === "string" ? body.question : "";
  conversation(question, []); // confere a pergunta antes de gastar qualquer coisa
  emit({
    type: "step",
    id: "ctx",
    label: "Entendendo a pergunta",
    state: "running",
  });
  const now = (deps.now ?? Date.now)();
  // Os poderes (visualizações, imagens, ações) só no módulo MAVI.
  const onPage = body.surface === "page";
  const [base, limits, history, route, powerList, catalog] = await Promise.all([
    buildContext(env, deps, auth, company, scope, now),
    callRpc<{ blocked: boolean; message: string | null; warnings: string[] }>(
      env,
      deps.fetch,
      auth,
      "ai_check_limits",
      {
        p_company: company,
        p_client: scope.client ?? null,
        p_contract: scope.contract ?? null,
        p_project: scope.project ?? null,
      },
    ),
    conversationId
      ? Promise.all([
          rest<{ owner_id: string }>(
            env,
            deps,
            auth,
            `ai_conversations?select=owner_id&id=eq.${conversationId}`,
          ),
          rest<ChatTurn & { artifacts?: unknown }>(
            env,
            deps,
            auth,
            `ai_messages?select=role,content,artifacts&conversation_id=eq.${conversationId}&order=id.desc&limit=12`,
          ).catch(() =>
            // Antes da migração 20261212090000_mavi_powers não há anexos.
            rest<ChatTurn & { artifacts?: unknown }>(
              env,
              deps,
              auth,
              `ai_messages?select=role,content&conversation_id=eq.${conversationId}&order=id.desc&limit=12`,
            ),
          ),
        ])
      : Promise.resolve(null),
    // Qual provedor e modelo respondem (biblioteca de provedores).
    resolveRoute(
      env,
      deps.fetch,
      auth,
      company,
      scope,
      scope.module === "meetings" ? "meetings_history" : "assistant",
    ),
    onPage
      ? callRpc<string[]>(env, deps.fetch, auth, "ai_my_powers", {
          p_company: company,
        }).then((r) => (r.ok && Array.isArray(r.data) ? r.data : []))
      : Promise.resolve([] as string[]),
    // O catálogo de skills da pessoa (vazio sem o poder 'skills').
    onPage
      ? callRpc<CatalogSkill[]>(env, deps.fetch, auth, "ai_skill_catalog", {
          p_company: company,
        }).then((r) => (r.ok && Array.isArray(r.data) ? r.data : []))
      : Promise.resolve([] as CatalogSkill[]),
  ]);
  const powers = new Set(
    powerList.filter((p): p is Power =>
      ["visuals", "images", "actions", "skills"].includes(p),
    ),
  );
  // O assistente (o balão de todas as telas) é um módulo que o
  // administrador desliga para cada pessoa.
  if (
    (scope.module ?? "assistant") === "assistant" &&
    base.hidden.includes("assistant")
  )
    throw new AiError(403, "A MAVI está desligada para você nesta empresa.");
  const provider = route ? routeConfig(env, route) : null;
  const llm = provider
    ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider)
    : deps.llm;
  if (limits.ok && limits.data.blocked)
    throw new AiError(
      429,
      limits.data.message ?? "Limite de uso da MAVI atingido.",
    );
  if (limits.ok)
    for (const text of limits.data.warnings ?? [])
      emit({ type: "warning", text });
  if (history) {
    const [owner] = history[0];
    if (!owner) throw new AiError(404, "Conversa não encontrada.");
    if (owner.owner_id !== userIdFrom(auth))
      throw new AiError(403, "Só quem começou a conversa continua nela.");
  }
  // O que as respostas anteriores mostraram (as imagens podem ser editadas).
  const past = history ? [...history[1]].reverse() : [];
  const priorImages = new Map<string, string>();
  const next = { V: 1, I: 1, A: 1 };
  for (const m of past)
    for (const a of sanitizeArtifacts(m.artifacts)) {
      const letter = a.ref[0] as keyof typeof next;
      next[letter] = Math.max(next[letter], Number(a.ref.slice(1)) + 1);
      if (a.type === "image") priorImages.set(a.ref, a.path);
    }
  const messages = conversation(
    question,
    history
      ? past.map((m) => ({
          role: m.role,
          content:
            m.role === "assistant"
              ? historyTurn(m.content, sanitizeArtifacts(m.artifacts))
              : m.content,
        }))
      : body.history,
  );
  emit({
    type: "step",
    id: "ctx",
    label: scope.client
      ? `Contexto do cliente ${base.clients.get(scope.client) ?? ""} carregado`
      : "Contexto carregado",
    state: "done",
  });
  const ctx: ToolContext = {
    supabaseUrl: env.supabaseUrl,
    supabaseKey: env.supabaseKey,
    fetch: deps.fetch,
    auth,
    company,
    scope,
    embed: deps.embed,
    members: base.members,
    clients: base.clients,
    today: base.today,
    usage: { embeddingTokens: 0, embeddingModel: env.embeddingModel },
    sources: [],
    chunks: new Map(),
  };
  const kit: PowerKit = {
    ctx,
    env: { ...env, credentials: env.credentials, bucket: env.bucket },
    artifacts: [],
    priorImages,
    next,
    emit: (artifact) => emit({ type: "artifact", artifact }),
    imageCost: { usd: 0, model: "", provider: null },
  };
  const skills: SkillKit = {
    ctx,
    env,
    catalog: new Map(
      (powers.has("skills") ? catalog : []).map((c) => [c.slug, c]),
    ),
    loaded: new Map(),
    last: null,
  };
  const steps: { label: string; detail?: string }[] = [];
  // Cada chamada fica registrada (qual, quanto tempo, se falhou, quanto custou).
  const calls: {
    tool: string;
    power: Power | null;
    ok: boolean;
    ms: number;
    cost: number;
    error?: string;
    skill?: string;
    skill_version?: number;
  }[] = [];
  // As skills escolhidas na caixa de mensagem entram já carregadas.
  if (powers.has("skills"))
    for (const pick of pickedSkills(body.skills)) {
      const started = Date.now();
      const s = await loadSkill(skills, pick.slug, pick.version).catch(() => null);
      calls.push({
        tool: "use_skill",
        power: "skills",
        ok: !!s,
        ms: Date.now() - started,
        cost: 0,
        ...(s ? { skill: s.id, skill_version: s.version } : { error: `indisponível: ${pick.slug}` }),
      });
      if (!s) {
        emit({ type: "warning", text: `A skill “${pick.slug}” não está disponível para você.` });
        continue;
      }
      const label = `Usando a skill “${s.name}”${s.test ? ` (versão ${s.version} em teste)` : ""}`;
      steps.push({ label, detail: "escolhida por você" });
      emit({ type: "step", id: `skill-${s.slug}`, label, state: "done", detail: "escolhida por você" });
    }
  // Sem catálogo e sem skill escolhida, as ferramentas das skills não entram.
  const tools = toolsFor(powers).filter(
    (t) =>
      REGISTRY[t.name]?.kind !== "skill" ||
      skills.catalog.size > 0 ||
      skills.loaded.size > 0,
  );
  const allowed = new Set(tools.map((t) => t.name));
  let n = 0;
  const execute = async (name: string, input: unknown) => {
    const stepId = `t${++n}`;
    const meta = REGISTRY[name];
    const power = meta?.power ?? null;
    const skillTool = meta?.kind === "skill";
    const label = skillTool
      ? describeSkillStep(skills, name, input)
      : power
        ? describePowerStep(name, input)
        : describeStep(ctx, name, input);
    emit({ type: "step", id: stepId, label, state: "running" });
    const started = Date.now();
    const spent = kit.imageCost.usd;
    try {
      // Só as ferramentas oferecidas nesta pergunta (os poderes da pessoa).
      if (!allowed.has(name)) throw Error(`Ferramenta indisponível: ${name}.`);
      const work = skillTool
        ? runSkillTool(skills, name, input)
        : power
          ? runPowerTool(kit, name, input)
          : runTool(ctx, name, input);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const out = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("A ferramenta demorou demais.")),
            meta?.timeoutMs ?? 45_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      const detail = skillTool
        ? summarizeSkillStep(name, out)
        : power
          ? summarizePowerStep(name, out)
          : summarizeStep(name, out);
      steps.push({ label, detail });
      calls.push({
        tool: name,
        power,
        ok: true,
        ms: Date.now() - started,
        cost: kit.imageCost.usd - spent,
        ...(skillTool && skills.last
          ? { skill: skills.last.id, skill_version: skills.last.version }
          : {}),
      });
      emit({ type: "step", id: stepId, label, state: "done", detail });
      return out;
    } catch (e) {
      calls.push({
        tool: name,
        power,
        ok: false,
        ms: Date.now() - started,
        cost: kit.imageCost.usd - spent,
        error: (e as Error).message?.slice(0, 300),
      });
      emit({
        type: "step",
        id: stepId,
        label,
        state: "error",
        detail: "falhou",
      });
      throw e;
    }
  };
  let result: Awaited<ReturnType<LlmAdapter>> | undefined;
  try {
    result = await llm({
      instructions: INSTRUCTIONS + powerInstructions(powers),
      context:
        base.context +
        catalogContext([...skills.catalog.values()], [...skills.loaded.values()]),
      messages,
      tools,
      execute,
      maxRounds: powers.size ? 8 : 6,
      onEvent: (e) =>
        e.type === "round_end" ? emit({ type: "round_end" }) : emit(e),
    });
  } finally {
    // O custo entra mesmo quando a resposta falha no meio.
    const m = result?.meter;
    const embedCost = embeddingCost(
      ctx.usage.embeddingModel,
      ctx.usage.embeddingTokens,
    );
    if (m || ctx.usage.embeddingTokens)
      await callRpc(env, deps.fetch, auth, "ai_log_usage", {
        p_company: company,
        p_module: scope.module ?? "assistant",
        p_kind: "ask",
        p_client: scope.client ?? null,
        p_contract: scope.contract ?? null,
        p_project: scope.project ?? null,
        p_recording: null,
        p_model: m?.model || provider?.model || env.model,
        p_input: m?.input ?? 0,
        p_output: m?.output ?? 0,
        p_cache_read: m?.cacheRead ?? 0,
        p_cache_write: m?.cacheWrite ?? 0,
        p_embedding: ctx.usage.embeddingTokens,
        p_cost: Math.round(((m?.cost ?? 0) + embedCost) * 1e6) / 1e6,
        ...(route ? { p_provider: route.provider_id } : {}),
      }).catch(() => {});
  }
  const answer = result!.text;
  const sources = citedSources(answer, ctx.sources);
  // O link assinado da imagem vale uma hora: não é gravado.
  const artifacts = kit.artifacts;
  const stored = artifacts.map((a) =>
    a.type === "image" ? { ...a, url: undefined } : a,
  );
  // A conversa fica salva; se não der, a resposta chega mesmo assim.
  const saved = await callRpc<string>(env, deps.fetch, auth, "ai_save_turn", {
    p_company: company,
    p_conversation: conversationId,
    p_scope: {
      ...(scope.client ? { client: scope.client } : {}),
      ...(scope.contract ? { contract: scope.contract } : {}),
      ...(scope.project ? { project: scope.project } : {}),
    },
    p_module: scope.module ?? "assistant",
    p_question: question.trim(),
    p_answer: answer,
    p_sources: sources,
    p_steps: steps,
    ...(stored.length ? { p_artifacts: stored } : {}),
  }).catch(() => null);
  if (!saved?.ok)
    emit({ type: "warning", text: "Não foi possível salvar esta conversa." });
  const savedId = saved?.ok ? saved.data : conversationId;
  if (calls.length)
    await callRpc(env, deps.fetch, auth, "ai_log_tool_calls", {
      p_company: company,
      p_conversation: savedId,
      p_module: scope.module ?? "assistant",
      p_calls: calls.map((c) => ({
        ...c,
        cost: Math.round(c.cost * 1e6) / 1e6,
      })),
    }).catch(() => {});
  return {
    type: "done",
    answer,
    sources,
    artifacts,
    conversation: savedId,
  };
}

/**
 * Links (1 hora) das imagens que a MAVI gerou, só para quem vê a conversa
 * em que elas aparecem (o banco confere: a resposta tem que ser visível).
 */
async function imageUrls(body: Row, auth: string, env: AiEnv, deps: AiDeps) {
  const company = String(body.company ?? "");
  if (!UUID.test(company)) throw new AiError(400, "Empresa inválida.");
  if (!env.credentials || !env.bucket)
    throw new AiError(500, "Credenciais do GCS não configuradas.");
  const pattern = new RegExp(
    `^ai-images/${company}/[0-9a-f-]{36}\\.(png|webp|jpg)$`,
    "i",
  );
  const paths = [
    ...new Set(
      (Array.isArray(body.paths) ? body.paths : [])
        .filter((p): p is string => typeof p === "string" && pattern.test(p))
        .slice(0, 24),
    ),
  ];
  const urls: Record<string, string> = {};
  await Promise.all(
    paths.map(async (path) => {
      const filter = encodeURIComponent(JSON.stringify([{ path }]));
      const rows = await rest<{ id: number }>(
        env,
        deps,
        auth,
        `ai_messages?select=id&company_id=eq.${company}&artifacts=cs.${filter}&limit=1`,
      );
      if (rows.length)
        urls[path] = signGcsUrl(env.credentials!, env.bucket!, path, "GET", {
          expiresInSeconds: 3600,
        });
    }),
  );
  return urls;
}

function errorEvent(err: unknown): Extract<AiStreamEvent, { type: "error" }> {
  const status =
    err instanceof AiError || err instanceof EmbeddingError
      ? err.status
      : typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500;
  const error =
    err instanceof AiError || err instanceof EmbeddingError
      ? err.message
      : llmFriendlyError(err);
  return { type: "error", error, status };
}

/**
 * A pergunta em tempo real: cada evento vai para `write` assim que acontece
 * (passos, raciocínio, texto), e termina em "done" ou "error".
 */
export async function streamAi(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
  write: Emit,
) {
  if (!authorization?.startsWith("Bearer ")) {
    write({ type: "error", error: "Entre na sua conta.", status: 401 });
    return;
  }
  try {
    write(await ask((body ?? {}) as Row, authorization, env, deps, write));
  } catch (err) {
    write(errorEvent(err));
  }
}

// ------------------------------------------------------------ worker
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function rpcOrThrow<T>(
  env: AiEnv,
  deps: AiDeps,
  name: string,
  args: Row,
) {
  // O worker fala com o banco como anon + segredo (sem service key no servidor).
  const r = await callRpc<T>(env, deps.fetch, null, name, args);
  if (!r.ok) throw new AiError(r.status, r.error);
  return r.data;
}

/** Baixa um arquivo do Drive por um link assinado de 5 minutos. */
function gcsDownload(env: AiEnv, fetchImpl: typeof fetch) {
  return async (path: string) => {
    if (!env.credentials || !env.bucket)
      throw new AiError(500, "Credenciais do GCS não configuradas.");
    const res = await fetchImpl(
      signGcsUrl(env.credentials, env.bucket, path, "GET", {
        expiresInSeconds: 300,
      }),
    );
    if (!res.ok)
      throw new AiError(502, `Download do arquivo falhou (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** Lê o texto de alguns arquivos pendentes do Drive e devolve ao banco. */
async function readFiles(env: AiEnv, deps: AiDeps) {
  const files = await rpcOrThrow<
    {
      file_id: string;
      path: string;
      name: string;
      kind: string | null;
      size_bytes: number;
    }[]
  >(env, deps, "ai_claim_files", { p_secret: env.workerSecret, p_limit: 3 });
  const download = deps.download ?? gcsDownload(env, deps.fetch);
  await Promise.all(
    files.map(async (f) => {
      let status: string;
      let pages: unknown = null;
      let error: string | null = null;
      try {
        const out = await extractFileText(
          f.kind,
          await download(f.path),
          f.name,
        );
        status = out.status;
        pages = out.status === "done" ? out.pages : null;
        error = out.error ?? null;
      } catch (e) {
        status = "error";
        error = (e as Error).message;
      }
      await rpcOrThrow(env, deps, "ai_store_file_text", {
        p_secret: env.workerSecret,
        p_file: f.file_id,
        p_status: status,
        p_pages: pages,
        p_error: error,
      });
    }),
  );
  return files.length;
}

export async function runIndexer(env: AiEnv, deps: AiDeps) {
  const now = deps.now ?? Date.now;
  const deadline = now() + env.workerBudgetMs;
  const stats = { built: 0, embedded: 0, tokens: 0, cost: 0, files: 0 };
  const perCompany = new Map<string, { tokens: number; cost: number }>();
  while (now() < deadline - 5000) {
    const built = await rpcOrThrow<number>(env, deps, "ai_index_step", {
      p_secret: env.workerSecret,
      p_limit: 50,
    });
    stats.built += built;
    // Arquivos do Drive (baixar e ler leva tempo): só com folga no relógio.
    const read = now() < deadline - 20000 ? await readFiles(env, deps) : 0;
    stats.files += read;
    const claimed = await rpcOrThrow<
      { id: number; company_id: string; content: string }[]
    >(env, deps, "ai_claim_chunks", {
      p_secret: env.workerSecret,
      p_limit: 256,
    });
    if (!claimed.length) {
      if (!built && !read) break;
      continue;
    }
    // Lotes de 128 textos, dois de cada vez.
    const batches: (typeof claimed)[] = [];
    for (let i = 0; i < claimed.length; i += 128)
      batches.push(claimed.slice(i, i + 128));
    const done = await Promise.all(
      batches.map(async (batch) => {
        const { vectors, tokens, model } = await deps.embed(
          batch.map((c) => c.content),
        );
        return { batch, vectors, tokens, model };
      }),
    );
    for (const { batch, vectors, tokens, model } of done) {
      const cost = embeddingCost(model, tokens);
      stats.tokens += tokens;
      stats.cost += cost;
      // O custo do lote dividido entre as empresas pelo tamanho dos textos.
      const chars = batch.reduce((n, c) => n + c.content.length, 0) || 1;
      for (const c of batch) {
        const share = c.content.length / chars;
        const e = perCompany.get(c.company_id) ?? { tokens: 0, cost: 0 };
        e.tokens += tokens * share;
        e.cost += cost * share;
        perCompany.set(c.company_id, e);
      }
      for (let i = 0; i < batch.length; i += 64) {
        const items = batch.slice(i, i + 64).map((c, k) => ({
          id: c.id,
          embedding: vectorLiteral(vectors[i + k]),
        }));
        stats.embedded += await rpcOrThrow<number>(
          env,
          deps,
          "ai_store_embeddings",
          {
            p_secret: env.workerSecret,
            p_model: model,
            p_items: items,
          },
        );
      }
    }
  }
  if (perCompany.size)
    await rpcOrThrow(env, deps, "ai_log_indexing", {
      p_secret: env.workerSecret,
      p_model: env.embeddingModel,
      p_items: [...perCompany].map(([company, e]) => ({
        company,
        tokens: Math.round(e.tokens),
        cost: Math.round(e.cost * 1e6) / 1e6,
      })),
    }).catch(() => {});
  return stats;
}

export async function handleAi(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Row }> {
  const req = (body ?? {}) as Row;
  try {
    if (req.action === "ai-index") {
      const token = authorization?.replace(/^Bearer\s+/, "") ?? "";
      if (!env.workerSecret || !token || !sameSecret(token, env.workerSecret))
        return { status: 401, body: { error: "Não autorizado." } };
      return { status: 200, body: await runIndexer(env, deps) };
    }
    if (typeof req.action === "string" && req.action.startsWith("ai-provider-"))
      return handleProviders(req, authorization, env, deps);
    if (req.action === "ai-image-urls") {
      if (!authorization?.startsWith("Bearer "))
        return { status: 401, body: { error: "Entre na sua conta." } };
      return {
        status: 200,
        body: { urls: await imageUrls(req, authorization, env, deps) },
      };
    }
    if (req.action === "ai-ask") {
      if (!authorization?.startsWith("Bearer "))
        return { status: 401, body: { error: "Entre na sua conta." } };
      const done = await ask(req, authorization, env, deps, () => {});
      return {
        status: 200,
        body: {
          answer: done.answer,
          sources: done.sources,
          artifacts: done.artifacts,
          conversation: done.conversation,
        },
      };
    }
    return { status: 400, body: { error: "Ação inválida." } };
  } catch (err) {
    const e = errorEvent(err);
    return { status: e.status, body: { error: e.error } };
  }
}

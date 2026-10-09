import type {
  AgentModels,
  MaviReply,
  AgentDetail,
  AgentDraft,
  BuilderAgent,
  KnowledgeItem,
  MakecrmInbox,
  SimulateResult,
  TurnTrace,
} from "./agent-builder";

/** Demonstração (sem banco): um agente de exemplo, guardado só na memória. */

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

const agents: (BuilderAgent & { draft: AgentDraft; draft_updated_by: string | null })[] = [
  {
    id: "demo-agent-1",
    company_id: "crm-demo",
    name: "Clara (atendimento)",
    origin: "mavi_tasks",
    status: "active",
    external_ref: { mavi_client_id: "demo-client", mavi_contract_id: "demo-contract", client_code: 774 },
    published_version: 2,
    draft_updated_at: now(),
    draft_updated_by: "demo@makevendas.com.br",
    created_at: now(),
    updated_at: now(),
    bindings: 1,
    draft: {
      schema: "mavi-agent/v1",
      persona: { name: "Clara", company: "Make Vendas", company_summary: "Agência de marketing e vendas com IA." },
      instructions: {
        goal: "Entender o que o lead procura, tirar dúvidas e agendar uma reunião com o time comercial.",
        conversation_guide: "1. Cumprimente e pergunte o nome.\n2. Entenda o negócio do lead.\n3. Ofereça a reunião.",
        rules: ["Só agende em dias úteis, das 9h às 18h."],
      },
      memory: { contact_fields: ["nome", "e-mail", "empresa"] },
    },
  },
];

const items: (KnowledgeItem & { agent: string })[] = [
  {
    agent: "demo-agent-1",
    id: "k1",
    kind: "faq",
    title: "",
    body_preview: "",
    body_length: 0,
    data: { question: "Quanto custa?", answer: "Os planos começam em R$ 497 por mês, sem fidelidade." },
    source: { type: "text" },
    status: "ready",
    error: null,
    chunk_count: 1,
    created_by: "demo",
    created_at: now(),
    updated_at: now(),
  },
  {
    agent: "demo-agent-1",
    id: "k2",
    kind: "document",
    title: "Política de atendimento.pdf",
    body_preview: "[página 1] Horário de atendimento: segunda a sexta, das 9h às 18h…",
    body_length: 5321,
    data: {},
    source: { type: "upload", filename: "Política de atendimento.pdf", mime: "application/pdf", size: 120334 },
    status: "ready",
    error: null,
    chunk_count: 5,
    created_by: "demo",
    created_at: now(),
    updated_at: now(),
  },
];

const versions = [
  { version: 2, note: "Novo roteiro", restored_from: null, published_by: "demo@makevendas.com.br", created_at: now() },
  { version: 1, note: "Primeira versão", restored_from: null, published_by: "demo@makevendas.com.br", created_at: now() },
];

const turns: TurnTrace[] = [];

export const demoList = async () => ({ agents: agents.map(({ draft: _d, draft_updated_by: _b, ...a }) => a), leader: true, configured: true });

export async function demoCreate(input: { client: string; contract: string; name: string }) {
  const a = {
    ...agents[0]!,
    id: id(),
    name: input.name,
    published_version: null,
    bindings: 0,
    external_ref: { mavi_client_id: input.client, mavi_contract_id: input.contract, client_code: 774 },
    draft: { schema: "mavi-agent/v1", persona: { name: input.name.split(" ")[0], company: "" }, instructions: { goal: "" } },
  };
  agents.push(a);
  return { agent: a };
}

function validate(d: AgentDraft) {
  const errors = [];
  if (!d.persona?.name) errors.push({ path: "persona.name", message: "Obrigatório" });
  if (!d.persona?.company) errors.push({ path: "persona.company", message: "Obrigatório" });
  if (!d.instructions?.goal) errors.push({ path: "instructions.goal", message: "Obrigatório" });
  return { valid: !errors.length, errors };
}

export async function demoOp(agentId: string, op: string, extra: Record<string, any>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 250));
  const a = agents.find((x) => x.id === agentId);
  if (!a) throw new Error("Agente não encontrado.");
  switch (op) {
    case "get":
      return {
        agent: a,
        draft_validation: validate(a.draft),
        published: a.published_version ? { version: a.published_version, spec: a.draft, note: "", published_by: "demo", created_at: now() } : null,
        bindings: a.bindings ? [{ id: "b1", inbox_id: "i1", inbox_name: "MAVI (WhatsApp)", enabled: true, created_by: "demo", created_at: now() }] : [],
        can_edit: true,
      } satisfies AgentDetail;
    case "draft":
      a.draft = extra.draft;
      a.draft_updated_at = now();
      return { agent: a, draft_validation: validate(a.draft) };
    case "update":
      Object.assign(a, extra.name ? { name: extra.name } : {}, extra.status ? { status: extra.status } : {});
      return { agent: a };
    case "publish": {
      const v = (versions[0]?.version ?? 0) + 1;
      versions.unshift({ version: v, note: extra.note ?? "", restored_from: extra.restore_version ?? null, published_by: "demo", created_at: now() });
      a.published_version = v;
      return { version: v };
    }
    case "versions":
      return { versions, published_version: a.published_version };
    case "knowledge-list": {
      const list = items.filter((i) => i.agent === agentId && (!extra.kind || i.kind === extra.kind));
      return {
        items: list,
        totals: { total: list.length, ready: list.filter((i) => i.status === "ready").length, errors: 0, processing: 0, chunks: list.reduce((s, i) => s + i.chunk_count, 0) },
      };
    }
    case "knowledge-add":
    case "knowledge-bulk": {
      const add = op === "knowledge-add" ? [extra.item] : extra.items;
      for (const it of add) {
        items.push({
          agent: agentId,
          id: id(),
          kind: it.kind,
          title: it.title ?? it.data?.name ?? it.url ?? "",
          body_preview: (it.body ?? "").slice(0, 300),
          body_length: (it.body ?? "").length,
          data: it.data ?? {},
          source: it.url ? { type: "url", url: it.url } : { type: "text" },
          status: "ready",
          error: null,
          chunk_count: 1,
          created_by: "demo",
          created_at: now(),
          updated_at: now(),
        });
      }
      return { created: add.length };
    }
    case "knowledge-delete": {
      const i = items.findIndex((x) => x.id === extra.item);
      if (i >= 0) items.splice(i, 1);
      return { ok: true };
    }
    case "knowledge-get":
      return { item: items.find((x) => x.id === extra.item), chunks: [{ id: "c1", ord: 0, title: "", content: "Trecho de exemplo do item.", context: "" }] };
    case "knowledge-reprocess":
      return { ok: true };
    case "knowledge-search":
      return {
        results: items.slice(0, 2).map((i, n) => ({
          chunk_id: `c${n}`,
          item_id: i.id,
          kind: i.kind,
          title: i.title || i.data.question || "",
          content: i.data.answer ?? i.body_preview,
          context: "",
          score: 0.03 - n * 0.01,
          vector_rank: n + 1,
          keyword_rank: n === 0 ? 1 : null,
        })),
      };
    case "upload-url":
      return { item_id: id(), storage_path: "demo", upload_url: "" };
    case "uploaded":
      return demoOp(agentId, "knowledge-add", { item: { kind: extra.kind, title: extra.title || extra.filename, data: {} } });
    case "simulate": {
      const t: TurnTrace = {
        id: id(),
        status: "done",
        model: "openai/gpt-5.2",
        rounds: 1,
        tokens_in: 1700,
        tokens_out: 180,
        tokens_cached: 0,
        cost_usd: 0.0058,
        timings: { retrieval: 700, llm: 3200, total: 4100 },
        tools: [{ name: "responder", result: "ok", ms: 1 }],
        retrieved: [{ ref: "K1", kind: "faq", title: "Quanto custa?", score: 0.03, via: "prefetch" }],
        output: { messages: [{ text: "Oi! Os planos começam em R$ 497 por mês", media: [] }, { text: "Me conta: qual é o seu negócio?", media: [] }], silent_reason: null, handoff: null },
        error: null,
        created_at: now(),
        simulation: true,
      };
      turns.unshift(t);
      return { conversation_id: "demo", result: { status: "done", messages: t.output!.messages, attachments: {} }, turn: t } satisfies SimulateResult;
    }
    case "sim-messages":
      return { messages: [] };
    case "inboxes":
      return {
        inboxes: [
          { id: "i1", name: "MAVI (WhatsApp)", type_id: 2, status: true, kind: "whatsapp_business_api", bound_agent: { id: agentId, name: a.name } },
          { id: "i2", name: "Comercial", type_id: 1, status: true, kind: "whatsapp_uazapi", bound_agent: null },
        ] satisfies MakecrmInbox[],
      };
    case "bind":
      a.bindings = (a.bindings ?? 0) + 1;
      return { binding: { id: id() }, warnings: ["Demonstração: nada foi alterado no MakeCRM."] };
    case "unbind":
    case "binding-toggle":
      return { ok: true };
    case "crm-pipelines":
      return {
        pipelines: [
          { id: "11111111-1111-4111-8111-111111111111", name: "Funil Principal", stages: [
            { id: "21111111-1111-4111-8111-111111111111", name: "Novo lead", pipeline_id: "11111111-1111-4111-8111-111111111111", order: 1 },
            { id: "31111111-1111-4111-8111-111111111111", name: "Qualificado", pipeline_id: "11111111-1111-4111-8111-111111111111", order: 2 },
            { id: "41111111-1111-4111-8111-111111111111", name: "Reunião agendada", pipeline_id: "11111111-1111-4111-8111-111111111111", order: 3 },
          ] },
          { id: "12111111-1111-4111-8111-111111111111", name: "Pós-venda", stages: [
            { id: "22111111-1111-4111-8111-111111111111", name: "Onboarding", pipeline_id: "12111111-1111-4111-8111-111111111111", order: 1 },
          ] },
        ],
      };
    case "crm-users":
      return {
        users: [
          { id: "a1111111-1111-4111-8111-111111111111", name: "Ana Souza", email: "ana@cliente.com", google: "ana@cliente.com" },
          { id: "b1111111-1111-4111-8111-111111111111", name: "Bruno Lima", email: "bruno@cliente.com", google: "bruno@cliente.com" },
          { id: "c1111111-1111-4111-8111-111111111111", name: "Carla Dias", email: "carla@cliente.com", google: null },
        ],
      };
    case "crm-templates":
      return {
        templates: [
          { template_id: "t1", name: "retomada_conversa", category: "MARKETING", language: "pt_BR", text: "Oi {{1}}, tudo bem? Ficou alguma dúvida sobre {{2}}?", params: 2, examples: ["Ana", "a proposta"] },
          { template_id: "t2", name: "ultimo_contato", category: "MARKETING", language: "pt_BR", text: "Vou encerrar seu atendimento por aqui. Se quiser retomar, é só responder esta mensagem!", params: 0, examples: [] },
        ],
      };
    case "keys":
    case "key-set":
    case "key-delete":
      return demoSecretsOp(op, extra);
    case "turns":
      return { turns: extra.simulation === "false" ? [] : turns };
    case "turn":
      return { turn: turns.find((t) => t.id === extra.turn), messages: [] };
    case "usage":
      return { usage: [] };
    case "conversations":
      return { conversations: [] };
    default:
      return {};
  }
}

/** A MAVI na demonstração: uma pergunta e uma proposta de exemplo. */
export async function demoMavi(messages: { role: string; content: string }[]): Promise<MaviReply> {
  await new Promise((r) => setTimeout(r, 600));
  if (!messages.some((m) => m.role === "user"))
    return {
      message: "Oi! Vou te ajudar a montar o agente. Para começar:",
      questions: [
        { text: "O cliente tem site?", options: ["Sim, vou colar o endereço", "Não tem site"], multiple: false },
        { text: "Qual o objetivo principal do atendimento?", options: ["Agendar reunião", "Vender pelo WhatsApp", "Tirar dúvidas", "Suporte"], multiple: false },
      ],
      proposal: null,
      files: [],
    };
  return {
    message: "Com o que você me contou, preparei o perfil e duas perguntas frequentes. Confira e aplique o que fizer sentido.",
    questions: [{ text: "Qual o horário de atendimento?", options: ["Comercial (seg a sex, 9h às 18h)", "Inclui sábado", "Todos os dias"], multiple: false }],
    proposal: {
      summary: "Perfil e primeiras perguntas da base",
      fields: [
        { path: "persona.tone", label: "Tom de voz", before: "Cordial e natural", after: "Consultivo", value: "consultivo, seguro e especialista", why: "Vendas B2B, segundo você" },
        { path: "instructions.goal", label: "Objetivo", before: "(padrão)", after: "Qualificar e agendar uma reunião com o time comercial.", value: "Qualificar e agendar uma reunião com o time comercial.", why: "Sua resposta" },
      ],
      knowledge: [
        { kind: "faq", title: "Tem fidelidade?", preview: "Não, os planos são mensais e sem fidelidade.", why: "Site do cliente", item: { kind: "faq", data: { question: "Tem fidelidade?", answer: "Não, os planos são mensais e sem fidelidade." } } },
      ],
      skipped: [],
    },
    files: [],
  };
}

const DEMO_MODELS: AgentModels = {
  can_edit: true,
  default: "p1|openai/gpt-5.2",
  fallback: "p1|openai/gpt-4.1",
  updated_at: null,
  models: [
    { key: "p1|openai/gpt-5.2", ref: "openrouter:openai/gpt-5.2", provider_id: "p1", provider_name: "OpenRouter (Make)", kind: "openrouter", model: "openai/gpt-5.2", label: "GPT-5.2", input: 1.25, output: 10, cached: 0.13, allowed: true },
    { key: "p1|openai/gpt-4.1", ref: "openrouter:openai/gpt-4.1", provider_id: "p1", provider_name: "OpenRouter (Make)", kind: "openrouter", model: "openai/gpt-4.1", label: "GPT-4.1", input: 2, output: 8, cached: 0.5, allowed: true },
    { key: "p1|anthropic/claude-sonnet-4.6", ref: "openrouter:anthropic/claude-sonnet-4.6", provider_id: "p1", provider_name: "OpenRouter (Make)", kind: "openrouter", model: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", input: 3, output: 15, cached: 0.3, allowed: true },
    { key: "p2|gpt-5-mini", ref: "openai:gpt-5-mini", provider_id: "p2", provider_name: "OpenAI", kind: "openai", model: "gpt-5-mini", label: "GPT-5 mini", input: 0.25, output: 2, cached: 0.03, allowed: false },
  ],
};
export const demoModels = async () => DEMO_MODELS;
const demoSecrets: { provider: string; key_hint: string }[] = [];
export function demoSecretsOp(op: string, extra: Record<string, any>) {
  if (op === "key-set") {
    const i = demoSecrets.findIndex((x) => x.provider === extra.provider);
    const row = { provider: extra.provider, key_hint: String(extra.key).slice(-4) };
    if (i >= 0) demoSecrets[i] = row;
    else demoSecrets.push(row);
    return { provider: extra.provider, key_hint: row.key_hint, check_ok: true, check_error: null };
  }
  if (op === "key-delete") {
    const i = demoSecrets.findIndex((x) => x.provider === extra.provider);
    if (i >= 0) demoSecrets.splice(i, 1);
    return { ok: true };
  }
  return {
    secrets: demoSecrets.map((s) => ({ ...s, checked_at: new Date().toISOString(), check_ok: true, check_error: null, updated_by: "demo", updated_at: new Date().toISOString() })),
    server_providers: ["openrouter", "openai"],
  };
}

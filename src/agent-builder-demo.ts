import type {
  AgentModels,
  AgentReading,
  AgentReport,
  ConversationInsight,
  GapDetail,
  GapsResult,
  GapSuggestion,
  GapTopic,
  InsightConversation,
  InsightsSettings,
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
    case "gaps":
    case "gap":
    case "gap-update":
    case "gap-suggest":
    case "gap-apply":
    case "gap-merge":
    case "report":
    case "reading":
    case "insight-conversations":
    case "conversation-insight":
    case "conversation-messages":
    case "insights-settings":
    case "insights-settings-set":
      return demoInsightsOp(op, extra);
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

// ------------------------------------------------------------ lacunas e insights (demonstração)
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const ymd = (d: number) => new Date(Date.now() - 3 * 3600_000 - d * 86_400_000).toISOString().slice(0, 10);
const demoTopics: (GapTopic & { suggestion: GapSuggestion | null })[] = [
  { id: "g1", kind: "question", title: "Aceita pagamento no boleto?", title_source: "mavi", category: "", status: "open", occurrences: 14, conversations: 12, after_trained: 0, first_seen_at: ago(400), last_seen_at: ago(3), trained_at: null, trained_by: null, knowledge_item_id: null, has_suggestion: false, in_period: 9, in_previous: 4, conversations_in_period: 8, suggestion: null },
  { id: "g2", kind: "objection", title: "Está caro para o meu momento", title_source: "mavi", category: "preco", status: "open", occurrences: 8, conversations: 8, after_trained: 0, first_seen_at: ago(300), last_seen_at: ago(20), trained_at: null, trained_by: null, knowledge_item_id: null, has_suggestion: false, in_period: 6, in_previous: 7, conversations_in_period: 6, suggestion: null },
  { id: "g3", kind: "question", title: "Atende em Curitiba?", title_source: "first", category: "", status: "open", occurrences: 2, conversations: 2, after_trained: 0, first_seen_at: ago(90), last_seen_at: ago(30), trained_at: null, trained_by: null, knowledge_item_id: null, has_suggestion: false, in_period: 2, in_previous: 0, conversations_in_period: 2, suggestion: null },
  { id: "g4", kind: "question", title: "Tem fidelidade no contrato?", title_source: "mavi", category: "", status: "trained", occurrences: 6, conversations: 6, after_trained: 0, first_seen_at: ago(700), last_seen_at: ago(200), trained_at: ago(190), trained_by: "demo@makevendas.com.br", knowledge_item_id: "k1", has_suggestion: true, in_period: 1, in_previous: 5, conversations_in_period: 1, suggestion: null },
];
const demoConversations: InsightConversation[] = [
  { conversation_id: "c1", external_id: "x1", contact_name: "Marina Souza", phone: "5511999990001", intent: "Saber preço do plano", outcome: "ghosted", outcome_reason: "Parou de responder depois de receber o preço", reason_label: "preço alto", sentiment: "neutral", objections: ["preço alto"], topics: ["planos", "preço"], agent_issues: [], summary: "Perguntou o preço do plano anual, recebeu a tabela e parou de responder.", lead_messages: 4, activity_at: ago(26) },
  { conversation_id: "c2", external_id: "x2", contact_name: "Rafael Lima", phone: "5511999990002", intent: "Agendar demonstração", outcome: "scheduled", outcome_reason: "Marcou reunião para quinta 15h", reason_label: "", sentiment: "positive", objections: [], topics: ["demonstração"], agent_issues: [], summary: "Quis ver a ferramenta funcionando e marcou uma demonstração para quinta.", lead_messages: 7, activity_at: ago(30) },
  { conversation_id: "c3", external_id: "x3", contact_name: "Ana Paula", phone: "5511999990003", intent: "Pagar no boleto", outcome: "handed_off", outcome_reason: "Pediu para falar com uma pessoa sobre boleto", reason_label: "", sentiment: "negative", objections: ["forma de pagamento"], topics: ["pagamento"], agent_issues: [{ type: "ignored_question", detail: "Não respondeu se aceita boleto e repetiu a apresentação." }], summary: "Perguntou duas vezes se aceita boleto, o agente desviou e ela pediu uma pessoa.", lead_messages: 6, activity_at: ago(50) },
];
const demoReport = (from: string, to: string): AgentReport => {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return {
    period: { from, to },
    previous: { from: ymd(days * 2 - 1), to: ymd(days) },
    days,
    sample_percent: 20,
    metrics: { conversations: 412, new_conversations: 288, lead_messages: 3120, agent_messages: 3860, followup_messages: 190, followup_recovered: 41, turns: 2710, errors: 3, handoffs: 37, meetings: 54, reply_ms_p50: 11800, cost_usd: 14.2, insights_cost_usd: 0.17 },
    previous_metrics: { conversations: 365, new_conversations: 250, lead_messages: 2800, agent_messages: 3400, followup_messages: 150, followup_recovered: 30, turns: 2400, errors: 9, handoffs: 41, meetings: 44, reply_ms_p50: 12400, cost_usd: 12.6, insights_cost_usd: 0.15 },
    series: {
      days: Array.from({ length: days }, (_, i) => ({ day: ymd(days - 1 - i), conversations: 8 + ((i * 7) % 13) + (i % 7 < 5 ? 6 : 0), lead_messages: 60 + i, handoffs: i % 3, meetings: i % 4 })),
      hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, lead_messages: h < 7 ? 5 : h < 12 ? 120 + h * 10 : h < 19 ? 180 - (h - 12) * 8 : 60 })),
    },
    insights: {
      analyzed: 82,
      outcomes: [
        { outcome: "qualified", n: 21 },
        { outcome: "ghosted", n: 19 },
        { outcome: "scheduled", n: 14 },
        { outcome: "in_progress", n: 10 },
        { outcome: "not_interested", n: 8 },
        { outcome: "handed_off", n: 6 },
        { outcome: "disqualified", n: 4 },
      ],
      sentiment: [
        { sentiment: "positive", n: 38 },
        { sentiment: "neutral", n: 36 },
        { sentiment: "negative", n: 8 },
      ],
      reasons: [
        { label: "preço alto", n: 11, conversations: ["c1"] },
        { label: "sem tempo agora", n: 7, conversations: ["c1"] },
        { label: "já tem fornecedor", n: 5, conversations: ["c1"] },
      ],
      objections: [
        { label: "preço alto", n: 17, conversations: ["c1"] },
        { label: "forma de pagamento", n: 9, conversations: ["c3"] },
        { label: "prazo de implantação", n: 4, conversations: ["c2"] },
      ],
      topics: [
        { label: "planos", n: 31 },
        { label: "demonstração", n: 18 },
        { label: "pagamento", n: 12 },
      ],
      issues: [{ type: "ignored_question", n: 5, examples: [{ conversation_id: "c3", detail: "Não respondeu se aceita boleto e repetiu a apresentação." }] }],
    },
    previous_insights: { analyzed: 70, outcomes: [{ outcome: "qualified", n: 18 }, { outcome: "ghosted", n: 20 }, { outcome: "scheduled", n: 9 }] },
    look_at: demoConversations.filter((c) => c.sentiment === "negative" || c.agent_issues.length).map((c) => ({ ...c })),
    gaps: { turns: 2710, gap_turns: 190, gaps: 214, new_topics: 6, coverage: 0.93, top: demoTopics.filter((t) => t.status === "open").map((t) => ({ id: t.id, kind: t.kind, title: t.title, category: t.category, in_period: t.in_period, occurrences: t.occurrences })) },
    previous_gaps: { turns: 2400, gap_turns: 260, gaps: 280, new_topics: 9, coverage: 0.89 },
  };
};
let demoReading: AgentReading | null = null;
const demoSettings = { sample: 20, weekly: true, recipients: ["u1"] };

function demoInsightsOp(op: string, extra: Record<string, any>): unknown {
  switch (op) {
    case "gaps": {
      const topics = demoTopics.filter((t) => (!extra.status || t.status === extra.status) && (!extra.kind || t.kind === extra.kind));
      return {
        period: { from: extra.from, to: extra.to },
        previous: { from: extra.from, to: extra.to },
        topics,
        stats: { turns: 2710, gap_turns: 190, gaps: 214, new_topics: 6, coverage: 0.93 },
        previous_stats: { turns: 2400, gap_turns: 260, gaps: 280, new_topics: 9, coverage: 0.89 },
        pending: 0,
      } satisfies GapsResult;
    }
    case "gap": {
      const t = demoTopics.find((x) => x.id === extra.topic)!;
      return {
        topic: t,
        examples: [
          { id: "e1", text: t.title, lead_text: "vcs aceitam boleto? cartão não tenho", created_at: ago(3), conversation_id: "c3", external_id: "x3", contact_name: "Ana Paula", phone: null },
          { id: "e2", text: t.title, lead_text: "dá pra pagar no boleto bancário?", created_at: ago(40), conversation_id: "c1", external_id: "x1", contact_name: "Marina Souza", phone: null },
        ],
        similar: demoTopics.filter((x) => x.id !== t.id).map((x, i) => ({ id: x.id, title: x.title, kind: x.kind, status: x.status, occurrences: x.occurrences, similarity: 0.72 - i * 0.1 })),
      } satisfies GapDetail;
    }
    case "gap-suggest": {
      const t = demoTopics.find((x) => x.id === extra.topic)!;
      t.suggestion = {
        question: t.title,
        answer: t.kind === "objection" ? "Entendo! Muita gente sente isso no começo. [PREENCHER: condição especial ou parcelamento] Quer que eu te mostre quanto o cliente médio recupera no primeiro mês?" : "Aceitamos sim! O boleto vence em [PREENCHER: prazo do boleto] e a ativação acontece assim que ele compensa.",
        note: "Confirme com o financeiro o prazo de vencimento do boleto.",
        sources: ["conhecimento do agente", "resposta da equipe (2)"],
        model: "demo",
        generated_at: now(),
      };
      t.has_suggestion = true;
      return { suggestion: t.suggestion };
    }
    case "gap-apply": {
      const t = demoTopics.find((x) => x.id === extra.topic)!;
      Object.assign(t, { status: "trained", trained_at: now(), trained_by: "demo@makevendas.com.br" });
      return { knowledge_item_id: id() };
    }
    case "gap-update": {
      const t = demoTopics.find((x) => x.id === extra.topic)!;
      if (extra.status) t.status = extra.status;
      if (extra.title) Object.assign(t, { title: extra.title, title_source: "person" });
      return { ok: true };
    }
    case "gap-merge": {
      const i = demoTopics.findIndex((x) => x.id === extra.topic);
      const into = demoTopics.find((x) => x.id === extra.into)!;
      if (i >= 0) {
        into.occurrences += demoTopics[i]!.occurrences;
        demoTopics.splice(i, 1);
      }
      return { ok: true };
    }
    case "report":
      return { report: demoReport(extra.from, extra.to), reading: demoReading };
    case "reading":
      demoReading = {
        reading: {
          summary: "Semana mais movimentada (+13% de conversas) e com mais reuniões marcadas (54, +23%). O que mais trava é preço e a forma de pagamento: o agente ainda não sabe responder sobre boleto.",
          points: [
            { kind: "good", title: "Mais reuniões", text: "54 reuniões marcadas contra 44 no período anterior; o follow-up trouxe 41 conversas de volta.", conversations: ["c2"] },
            { kind: "attention", title: "Boleto sem resposta", text: "9 leads perguntaram sobre boleto e o agente desviou; em uma conversa a lead pediu uma pessoa por isso.", conversations: ["c3"] },
            { kind: "action", title: "Incluir a resposta do boleto", text: "Abra Lacunas › \"Aceita pagamento no boleto?\" e inclua a resposta no treinamento.", conversations: [] },
          ],
        },
        model: "demo",
        created_by: "demo@makevendas.com.br",
        created_at: now(),
      };
      return { reading: demoReading };
    case "insight-conversations": {
      const rows = demoConversations.filter(
        (c) => (!extra.outcome || c.outcome === extra.outcome) && (!extra.sentiment || c.sentiment === extra.sentiment) && (!extra.objection || c.objections.includes(extra.objection)),
      );
      return { conversations: rows.length ? rows : demoConversations, total: rows.length || demoConversations.length };
    }
    case "conversation-insight": {
      const c = demoConversations.find((x) => x.conversation_id === extra.conversation) ?? demoConversations[0]!;
      return {
        conversation: { id: c.conversation_id, external_id: c.external_id, phone: c.phone, contact_name: c.contact_name, facts: {}, summary: "", last_inbound_at: c.activity_at, last_reply_at: c.activity_at, created_at: c.activity_at },
        insight: { ...c, analyzed_at: now() },
        gaps: c.conversation_id === "c3" ? [{ id: "x", kind: "question", text: "Aceita pagamento no boleto?", created_at: c.activity_at, topic_id: "g1", topic_title: "Aceita pagamento no boleto?", topic_status: "open" }] : [],
      } satisfies ConversationInsight;
    }
    case "conversation-messages":
      return {
        messages: [
          { id: "1", role: "user", content: "Oi, vcs aceitam boleto?", content_type: "text", media: null, turn_id: "t", created_at: ago(51) },
          { id: "2", role: "assistant", content: "Oi! Eu sou a Clara, da Make Vendas 😊 Me conta um pouco do seu negócio?", content_type: "text", media: null, turn_id: "t", created_at: ago(51) },
          { id: "3", role: "user", content: "Mas aceita boleto ou não?", content_type: "text", media: null, turn_id: "t2", created_at: ago(50) },
        ],
      };
    case "insights-settings":
      return {
        sample_percent: demoSettings.sample,
        can_edit: true,
        weekly: {
          weekly: demoSettings.weekly,
          custom: true,
          recipients: demoSettings.recipients,
          candidates: [
            { id: "u1", name: "Allyson", email: "demo@makevendas.com.br" },
            { id: "u2", name: "Bruna (CS)", email: "bruna@makevendas.com.br" },
            { id: "u3", name: "Carlos (Comercial)", email: "carlos@makevendas.com.br" },
          ],
          last_sent: ymd(10),
        },
      } satisfies InsightsSettings;
    case "insights-settings-set":
      Object.assign(demoSettings, { sample: extra.sample_percent, weekly: extra.weekly, recipients: extra.recipients });
      return { ok: true };
  }
  return {};
}

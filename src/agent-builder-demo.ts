import type {
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

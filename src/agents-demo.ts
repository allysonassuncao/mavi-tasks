import type {
  AgentInstance,
  AgentPrompt,
  AgentPromptVersion,
  AgentStatus,
  AgentWorkflow,
} from "./agents";

/**
 * A demonstração do Agente Conversacional (sem banco): dois clientes, um
 * subfluxo, uma cópia e um fluxo sem cliente; publicar troca o texto em
 * memória e cria a versão.
 */
const now = Date.now();
const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();

const PROMPT_CLINICA = `Você é a Sofia, assistente virtual da Clínica Sorriso no WhatsApp.

## Tom
- Simpática, objetiva e sempre em português do Brasil.
- Use o primeiro nome do paciente quando souber.

## Agendamento
- Atendemos de segunda a sexta, das 8h às 18h.
- Consultas de avaliação duram 40 minutos.
- Antes de confirmar, pergunte nome completo, telefone e o melhor horário.
- Nunca confirme horário sem consultar a agenda (ferramenta Agenda).

## Preços
- Avaliação: gratuita.
- Limpeza: R$ 180,00.
- Clareamento: informe que o valor é passado na avaliação.

## Encaminhar para humano
- Reclamações, urgências (dor forte, sangramento) ou pedidos de reembolso.`;

const PROMPT_SUB = `Você agenda consultas da Clínica Sorriso.
Use a ferramenta Agenda para ver os horários livres e reservar.
Responda só com o horário confirmado ou com até 3 opções livres.`;

type Store = {
  workflows: AgentWorkflow[];
  texts: Map<string, string>;
  versions: Map<string, (AgentPromptVersion & { prompt: string })[]>;
};
let store: Store | null = null;

function seed(): Store {
  const base = {
    instance: "demo-vps",
    instance_name: "VPS 1",
    archived: false,
    removed_at: null,
    ignored: false,
    can_edit: true,
  };
  const prompt = (
    id: string,
    node: string,
    text: string,
    version: number,
    setup: AgentWorkflow["prompts"][number]["setup"],
    changedBy: string | null,
    hours: number,
  ) => ({
    id,
    node_name: node,
    node_type: "@n8n/n8n-nodes-langchain.agent",
    chars: text.length,
    version,
    changed_at: ago(hours),
    changed_by_name: changedBy,
    setup,
    expression: false,
    removed: false,
    excerpt: text.replace(/\s+/g, " ").slice(0, 200),
  });
  const workflows: AgentWorkflow[] = [
    {
      ...base,
      id: "demo-wf-1",
      n8n_url: "https://n8n.example.com/workflow/a1",
      n8n_id: "a1",
      name: "[Clínica Sorriso] Atendimento WhatsApp",
      active: true,
      role: "main",
      called_by: [],
      n8n_updated_at: ago(20),
      client_id: "demo-clinica",
      client_name: "Clínica Sorriso",
      contract_id: null,
      product_name: "MAVI",
      link_source: "auto",
      prompts: [
        prompt("demo-p-1", "Sofia (AI Agent)", PROMPT_CLINICA, 3,
          { model: "gpt-4.1-mini", provider: "OpenAi", tools: ["Agenda", "Base de preços"], memory: "Memória Postgres" },
          "Ana Admin", 20),
      ],
    },
    {
      ...base,
      id: "demo-wf-2",
      n8n_url: "https://n8n.example.com/workflow/a2",
      n8n_id: "a2",
      name: "Agendamento (subfluxo)",
      active: false,
      role: "subflow",
      called_by: [{ id: "a1", name: "[Clínica Sorriso] Atendimento WhatsApp" }],
      n8n_updated_at: ago(72),
      client_id: "demo-clinica",
      client_name: "Clínica Sorriso",
      contract_id: null,
      product_name: "MAVI",
      link_source: "auto",
      prompts: [
        prompt("demo-p-2", "Agendador", PROMPT_SUB, 1,
          { model: "gpt-4.1-nano", provider: "OpenAi", tools: ["Agenda"] }, null, 72),
      ],
    },
    {
      ...base,
      id: "demo-wf-3",
      n8n_url: "https://n8n.example.com/workflow/a3",
      n8n_id: "a3",
      name: "Clínica Sorriso - BACKUP 12/09",
      active: false,
      role: "copy",
      called_by: [],
      n8n_updated_at: ago(500),
      client_id: "demo-clinica",
      client_name: "Clínica Sorriso",
      contract_id: null,
      product_name: "MAVI",
      link_source: "auto",
      prompts: [
        prompt("demo-p-3", "Sofia (AI Agent)", PROMPT_CLINICA.replace("das 8h às 18h", "das 9h às 17h"), 1,
          { model: "gpt-4o-mini", provider: "OpenAi" }, null, 500),
      ],
    },
    {
      ...base,
      id: "demo-wf-4",
      n8n_url: "https://n8n.example.com/workflow/b1",
      n8n_id: "b1",
      name: "Bot Padaria Pão Quente",
      active: true,
      role: "main",
      called_by: [],
      n8n_updated_at: ago(5),
      client_id: null,
      client_name: null,
      contract_id: null,
      product_name: null,
      link_source: null,
      prompts: [
        prompt("demo-p-4", "AI Agent", "Você é o atendente da padaria. Informe o cardápio do dia e anote encomendas.", 1,
          { model: "claude-haiku-4-5", provider: "Anthropic" }, null, 5),
      ],
    },
  ];
  const texts = new Map<string, string>([
    ["demo-p-1", PROMPT_CLINICA],
    ["demo-p-2", PROMPT_SUB],
    ["demo-p-3", workflows[2].prompts[0].excerpt],
    ["demo-p-4", "Você é o atendente da padaria. Informe o cardápio do dia e anote encomendas."],
  ]);
  const v = (
    version: number,
    source: AgentPromptVersion["source"],
    text: string,
    hours: number,
    by: string | null,
    note = "",
  ) => ({ version, source, restored_from: null, note, saved_by_name: by, saved_at: ago(hours), chars: text.length, prompt: text });
  const versions = new Map<string, (AgentPromptVersion & { prompt: string })[]>([
    [
      "demo-p-1",
      [
        v(3, "edit", PROMPT_CLINICA, 20, "Ana Admin", "Preço da limpeza"),
        v(2, "n8n", PROMPT_CLINICA.replace("R$ 180,00", "R$ 160,00"), 120, null),
        v(1, "first", PROMPT_CLINICA.replace("R$ 180,00", "R$ 160,00").replace("de segunda a sexta", "de segunda a sábado"), 400, null),
      ],
    ],
  ]);
  return { workflows, texts, versions };
}
const db = () => (store ??= seed());

export function demoAgentList(opts: { query?: string; unlinked?: boolean }) {
  const q = opts.query?.trim().toLowerCase() ?? "";
  return db()
    .workflows.filter((w) => (opts.unlinked ? !w.client_id : !!w.client_id))
    .filter(
      (w) =>
        !q ||
        w.name.toLowerCase().includes(q) ||
        w.prompts.some((p) => (db().texts.get(p.id) ?? "").toLowerCase().includes(q)),
    );
}
export const demoAgentStatus = (): AgentStatus => ({
  leader: true,
  linker: true,
  admin: true,
  instances: 1,
  errors: 0,
  last_sync_at: ago(0.4),
  unlinked: db().workflows.filter((w) => !w.client_id && !w.ignored).length,
  unlinked_all: db().workflows.filter((w) => !w.client_id).length,
});
export function demoAgentPrompt(id: string): AgentPrompt {
  const w = db().workflows.find((x) => x.prompts.some((p) => p.id === id));
  const p = w?.prompts.find((x) => x.id === id);
  if (!w || !p) throw Error("Prompt não encontrado.");
  return {
    id,
    workflow_id: w.id,
    node_id: id,
    node_name: p.node_name,
    node_type: p.node_type,
    prompt: db().texts.get(id) ?? "",
    expression: false,
    setup: p.setup,
    version: p.version,
    changed_at: p.changed_at,
    changed_by_name: p.changed_by_name,
    removed: false,
    workflow: w,
  };
}
export function demoAgentVersions(id: string): AgentPromptVersion[] {
  const list = db().versions.get(id);
  if (list) return list;
  const p = demoAgentPrompt(id);
  return [{ version: p.version, source: "first", restored_from: null, note: "", saved_by_name: null,
    saved_at: p.changed_at, chars: p.prompt.length }];
}
export function demoAgentVersion(id: string, version: number) {
  const v = db().versions.get(id)?.find((x) => x.version === version);
  const text = v?.prompt ?? db().texts.get(id) ?? "";
  return {
    version,
    prompt: text,
    expression: false,
    source: v?.source ?? ("first" as const),
    restored_from: null,
    note: v?.note ?? "",
    saved_at: v?.saved_at ?? ago(1),
    saved_by_name: v?.saved_by_name ?? null,
  };
}
export function demoPublish(id: string, text: string, note: string, from?: number) {
  const w = db().workflows.find((x) => x.prompts.some((p) => p.id === id))!;
  const p = w.prompts.find((x) => x.id === id)!;
  p.version += 1;
  p.chars = text.length;
  p.changed_at = new Date().toISOString();
  p.changed_by_name = "Você (demonstração)";
  p.excerpt = text.replace(/\s+/g, " ").slice(0, 200);
  db().texts.set(id, text);
  const list = db().versions.get(id) ?? demoAgentVersions(id).map((x) => ({ ...x, prompt: "" }));
  list.unshift({
    version: p.version,
    source: from ? "restore" : "edit",
    restored_from: from ?? null,
    note,
    saved_by_name: "Você (demonstração)",
    saved_at: p.changed_at,
    chars: text.length,
    prompt: text,
  });
  db().versions.set(id, list);
  window.dispatchEvent(new CustomEvent("mavi:agents", { detail: {} }));
  return { version: p.version, active: w.active };
}
export function demoLink(workflow: string, client: string | null, clientName: string | null) {
  const w = db().workflows.find((x) => x.id === workflow)!;
  w.client_id = client;
  w.client_name = clientName;
  w.link_source = "manual";
  window.dispatchEvent(new CustomEvent("mavi:agents", { detail: {} }));
  return w;
}
export const demoInstances = (): AgentInstance[] => [
  {
    id: "demo-vps",
    name: "VPS 1",
    base_url: "https://n8n.example.com",
    key_hint: "…a9f2",
    enabled: true,
    last_sync_at: ago(0.4),
    last_attempt_at: ago(0.4),
    last_error: null,
    last_stats: { workflows: 87, agents: 4, main: 2, subflows: 1, copies: 1 },
    syncing: false,
    workflows: 4,
    created_at: ago(900),
  },
];

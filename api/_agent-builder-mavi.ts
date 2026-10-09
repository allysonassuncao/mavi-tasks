import { callRpc } from "./_drive.js";
import { llmFriendlyError, outputText, type LlmAdapter, type ToolSpec } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import { routedLlm } from "./_ai-router.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import { extractFileText } from "./_ai-extract.js";
import { pageForMavi, scrapePage } from "./_ai-scrape.js";
import { BuilderError, builderEnv, engine, loadAgentAccess, type BuilderEnv } from "./_agent-builder.js";
import { FIELD_BY_PATH, FIELDS, checkFieldValue, describeValue, fieldsGuide } from "../src/agent-fields.js";

/**
 * Agentes MAVI › a MAVI monta o agente (ação "builder-mavi", funcionalidade
 * 'agent_builder' em Quem usa qual modelo). A conversa ao lado do construtor:
 * ela entrevista a pessoa com perguntas simples (com opções), lê o site e os
 * arquivos que a pessoa envia e o prompt atual do agente no n8n, e propõe
 * mudanças nos campos e itens novos na base de conhecimento.
 *
 * Nada é gravado aqui: a proposta, conferida contra o catálogo dos campos
 * (src/agent-fields.ts), volta para a tela com o antes e o depois; a pessoa
 * aplica o que quiser (decisão: prévia + Aplicar). Só quem edita o agente
 * conversa com ela.
 */

type Row = Record<string, unknown>;
type Fetch = typeof fetch;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export type BuilderMessage = { role: "user" | "assistant"; content: string };
export type BuilderQuestion = { text: string; options: string[]; multiple: boolean };
export type ProposedField = { path: string; label: string; before: string; after: string; value: unknown; why: string };
export type ProposedKnowledge = {
  kind: "faq" | "product" | "text" | "example" | "document" | "file";
  title: string;
  preview: string;
  why: string;
  /** O item para a API do motor (knowledge-add); file: o nome do arquivo anexado. */
  item: Row;
  file?: string;
};
export type BuilderReply = {
  message: string;
  questions: BuilderQuestion[];
  proposal: { summary: string; fields: ProposedField[]; knowledge: ProposedKnowledge[]; skipped: string[] } | null;
};

const MAX_TOOL_CALLS = 16;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_FILES_BYTES = 3.4 * 1024 * 1024;
const FILE_TEXT = 30_000;

export const BUILDER_MAVI_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing e vendas. Seu nome é MAVI, no feminino. Aqui você ajuda uma pessoa da equipe — que pode não entender nada de IA nem de prompts — a montar um agente de atendimento no WhatsApp para um cliente da agência. O agente conversa com os leads desse cliente.

Como conduzir:
- Seja uma entrevistadora gentil e objetiva. Fale simples, sem jargão ("prompt", "LLM", "RAG", "token" não). Frases curtas.
- Pergunte pouco por vez: no máximo 3 perguntas por resposta, cada uma com opções clicáveis quando fizer sentido (a pessoa ainda pode escrever outra coisa). Comece pelo que destrava mais: o site do cliente, se já existe um agente no n8n, o que o cliente vende e o objetivo do atendimento.
- Antes de perguntar, veja o que já sabe: o rascunho atual, a base de conhecimento, o site ou arquivos enviados e o prompt do n8n (ferramentas abaixo). Não pergunte o que já está respondido.
- Proponha aos poucos: assim que tiver informação suficiente para alguns campos, já proponha esses campos (a pessoa aplica e você segue). Não espere ter tudo.
- Ordem sugerida: 1) a empresa e o objetivo (perfil, função, tom); 2) roteiro da conversa e regras; 3) horários; 4) base de conhecimento (perguntas frequentes, produtos e preços, políticas, documentos); 5) comportamento (só mude o que a pessoa pedir ou o que o negócio exigir; os padrões já são bons); 6) diga para testar na aba Testar e publicar.
- Nunca invente fatos do negócio (preços, prazos, condições, endereço, horários). Se não estiver numa fonte, pergunte. Ao tirar algo de uma fonte, diga de onde veio no "why".
- Instruções enxutas: o agente consulta a base de conhecimento a cada mensagem. Preços, catálogo, políticas e respostas prontas vão para a BASE (itens), não para as instruções. Nas instruções ficam quem ele é, o objetivo, o roteiro e as regras.
- Prompt do n8n: quando existir, leia e divida nas partes certas — persona e empresa no perfil, objetivo/roteiro/regras/"nunca" nas instruções, horários em horários, perguntas e respostas e produtos como itens da base. Não copie tudo para "Instruções adicionais"; use esse campo só para o que não couber em nenhum outro. Ignore detalhes técnicos do n8n (nomes de ferramentas, variáveis {{ }}, formatação de JSON).
- Arquivos e site: transforme em itens da base (FAQ, produtos, texto) ou proponha anexar o arquivo inteiro como documento ("file") quando ele for grande e útil como está.
- Roteiro: escreva como etapas numeradas e curtas, no tom do negócio.
- Exemplos de conversa (kind "example") ajudam muito: proponha 1 ou 2 quando entender bem o jeito de atender.

Os campos do agente (use exatamente estes caminhos e formatos):
{fields}

A base de conhecimento aceita itens destes tipos:
- "faq": {"question": "...", "answer": "..."}
- "product": {"name": "...", "price": "...", "category": "...", "description": "...", "attributes": {"tamanhos": "P a GG", ...}}
- "text": {"title": "...", "body": "..."} (políticas, informações)
- "example": {"title": "...", "body": "Lead: ...\\nAgente: ..."} (como responder bem)
- "document": {"title": "...", "url": "https://..."} (uma página para o motor ler)
- "file": {"file": "nome exato do arquivo anexado", "title": "..."} (anexar o arquivo enviado na conversa)

Responda SEMPRE com um único JSON, sem texto fora dele:
{
  "message": "o que você diz para a pessoa (curto; pode usar quebras de linha)",
  "questions": [{"text": "pergunta", "options": ["opção 1", "opção 2"], "multiple": false}],
  "proposal": {
    "summary": "uma frase do que esta proposta faz",
    "fields": [{"path": "persona.tone", "value": "...", "why": "de onde veio / por quê"}],
    "knowledge": [{"kind": "faq", "item": {"question": "...", "answer": "..."}, "why": "..."}]
  }
}
"questions" e "proposal" são opcionais (use [] e null quando não houver). Para voltar um campo ao padrão, use "value": null. Listas (regras, "nunca", dados do contato) vão completas: o valor substitui a lista atual. Não repita itens que já estão na base.`;

export const BUILDER_MAVI_TOOLS: ToolSpec[] = [
  {
    name: "ler_site",
    description: "Lê uma página da internet (site do cliente, cardápio, catálogo, PDF por link). Use quando a pessoa passar um endereço. Leia no máximo as páginas principais.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Endereço completo (https://...)." },
        foco: { type: "string", description: "Opcional: o assunto a procurar na página (ex.: preços, horários)." },
      },
      required: ["url"],
    },
  },
  {
    name: "prompts_do_n8n",
    description: "Lista os agentes que este cliente já tem nos fluxos do n8n (nós AI Agent), com o tamanho de cada prompt. Use no começo para saber se dá para aproveitar um agente existente.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "ler_prompt_do_n8n",
    description: "Lê o texto completo de um prompt do n8n listado por prompts_do_n8n.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "buscar_na_base",
    description: "Procura na base de conhecimento atual do agente (para não duplicar e para conferir o que já existe).",
    parameters: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] },
  },
];

// ------------------------------------------------------------ estado
/** O rascunho em palavras: só os campos preenchidos (o resto está no padrão). */
export function draftText(draft: Row): string {
  const lines: string[] = [];
  for (const f of FIELDS) {
    const v = f.path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), draft);
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    const text = describeValue(f.path, v);
    lines.push(`- ${f.path} (${f.label}): ${text.length > 1500 ? `${text.slice(0, 1500)}… (${text.length} caracteres)` : text}`);
  }
  return lines.length ? lines.join("\n") : "(vazio: nada preenchido ainda)";
}

type KnowledgeSummary = { items: { kind: string; title: string; data: Row; source: Row; status: string }[]; totals: Row };
export function knowledgeText(k: KnowledgeSummary | null): string {
  if (!k) return "(não consegui ler a base agora)";
  if (!k.items.length) return "(vazia)";
  const by = new Map<string, string[]>();
  for (const i of k.items) {
    const t = i.kind === "faq" ? String(i.data.question ?? i.title) : i.kind === "product" ? String(i.data.name ?? i.title) : i.title || String(i.source.filename ?? i.source.url ?? "");
    by.set(i.kind, [...(by.get(i.kind) ?? []), t]);
  }
  return [...by.entries()].map(([kind, titles]) => `- ${kind} (${titles.length}): ${titles.slice(0, 60).join(" | ")}${titles.length > 60 ? " | …" : ""}`).join("\n");
}

// ------------------------------------------------------------ resposta
function jsonOf(text: string): Row {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Row;
    } catch {
      /* abaixo */
    }
  }
  // Sem JSON: a resposta inteira vira a mensagem.
  return { message: text.trim() };
}

const getPath = (draft: Row, path: string) =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), draft);

/** Confere a proposta contra o catálogo dos campos e as regras dos itens. */
export function parseBuilderReply(text: string, draft: Row, files: string[]): BuilderReply {
  const j = jsonOf(text);
  const message = str(j.message, 6000) || "Pronto.";
  const questions: BuilderQuestion[] = (Array.isArray(j.questions) ? j.questions : [])
    .slice(0, 3)
    .map((q) => (q && typeof q === "object" ? (q as Row) : {}))
    .map((q) => ({
      text: str(q.text, 400),
      options: (Array.isArray(q.options) ? q.options : []).map((o) => str(o, 120)).filter(Boolean).slice(0, 8),
      multiple: q.multiple === true,
    }))
    .filter((q) => q.text);

  const p = j.proposal && typeof j.proposal === "object" ? (j.proposal as Row) : null;
  if (!p) return { message, questions, proposal: null };
  const skipped: string[] = [];
  const fields: ProposedField[] = [];
  const seen = new Set<string>();
  for (const raw of (Array.isArray(p.fields) ? p.fields : []).slice(0, 40)) {
    const f = raw && typeof raw === "object" ? (raw as Row) : {};
    const path = str(f.path, 80);
    const def = FIELD_BY_PATH.get(path);
    if (!def) {
      if (path) skipped.push(`campo desconhecido: ${path}`);
      continue;
    }
    if (seen.has(path)) continue;
    const checked = checkFieldValue(path, f.value);
    if (!checked.ok) {
      skipped.push(checked.error);
      continue;
    }
    const before = getPath(draft, path);
    if (JSON.stringify(before ?? null) === JSON.stringify(checked.value ?? null)) continue;
    seen.add(path);
    fields.push({
      path,
      label: def.label,
      before: describeValue(path, before),
      after: describeValue(path, checked.value),
      value: checked.value ?? null,
      why: str(f.why, 400),
    });
  }

  const knowledge: ProposedKnowledge[] = [];
  for (const raw of (Array.isArray(p.knowledge) ? p.knowledge : []).slice(0, 40)) {
    const k = raw && typeof raw === "object" ? (raw as Row) : {};
    const it = k.item && typeof k.item === "object" ? (k.item as Row) : k;
    const why = str(k.why, 400);
    switch (k.kind) {
      case "faq": {
        const q = str(it.question, 1000);
        const a = str(it.answer, 10_000);
        if (!q || !a) {
          skipped.push("pergunta sem resposta");
          continue;
        }
        knowledge.push({ kind: "faq", title: q, preview: a, why, item: { kind: "faq", data: { question: q, answer: a } } });
        break;
      }
      case "product": {
        const name = str(it.name, 300);
        if (!name) {
          skipped.push("produto sem nome");
          continue;
        }
        const attrs = it.attributes && typeof it.attributes === "object" && !Array.isArray(it.attributes)
          ? Object.fromEntries(Object.entries(it.attributes as Row).slice(0, 30).map(([a, b]) => [str(a, 60), str(b, 500)]).filter(([a, b]) => a && b))
          : {};
        const data = {
          name,
          price: str(it.price, 100),
          category: str(it.category, 120),
          description: str(it.description, 4000),
          ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
        };
        knowledge.push({ kind: "product", title: name, preview: [data.price, data.category, data.description].filter(Boolean).join(" · "), why, item: { kind: "product", data } });
        break;
      }
      case "text":
      case "example": {
        const body = str(it.body, 200_000);
        if (!body) {
          skipped.push("texto vazio");
          continue;
        }
        const title = str(it.title, 300);
        knowledge.push({ kind: k.kind, title: title || body.slice(0, 60), preview: body.slice(0, 400), why, item: { kind: k.kind, title, body } });
        break;
      }
      case "document": {
        const url = str(it.url, 2000);
        if (!/^https:\/\//i.test(url)) {
          skipped.push("página sem endereço https");
          continue;
        }
        const title = str(it.title, 300);
        knowledge.push({ kind: "document", title: title || url, preview: url, why, item: { kind: "document", title, url } });
        break;
      }
      case "file": {
        const file = str(it.file, 200);
        if (!files.includes(file)) {
          skipped.push(`arquivo não anexado: ${file || "(sem nome)"}`);
          continue;
        }
        const title = str(it.title, 300);
        knowledge.push({ kind: "file", title: title || file, preview: `Anexar o arquivo "${file}" à base`, why, file, item: { kind: "document", title } });
        break;
      }
      default:
        skipped.push(`tipo de item desconhecido: ${String(k.kind ?? "")}`);
    }
  }
  if (!fields.length && !knowledge.length) return { message, questions, proposal: null };
  return { message, questions, proposal: { summary: str(p.summary, 400), fields, knowledge, skipped } };
}

// ------------------------------------------------------------ arquivos
const KIND_BY_EXT: Record<string, string> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  txt: "text",
  md: "text",
  csv: "text",
  json: "text",
  html: "text",
};

async function readAttachments(raw: unknown): Promise<{ text: string; names: string[] }> {
  const list = (Array.isArray(raw) ? raw : []).slice(0, 5).map((x) => (x && typeof x === "object" ? (x as Row) : {}));
  let total = 0;
  const parts: string[] = [];
  const names: string[] = [];
  for (const a of list) {
    const name = str(a.name, 200);
    const data = typeof a.data === "string" ? a.data : "";
    if (!name || !data) continue;
    const bytes = Buffer.from(data, "base64");
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_FILES_BYTES)
      throw new BuilderError(413, "Arquivos grandes demais para a conversa (até 3 MB no total). Para arquivos maiores, use Conhecimento › Arquivo.");
    const kind = KIND_BY_EXT[name.toLowerCase().split(".").pop() ?? ""] ?? null;
    const x = await extractFileText(kind, new Uint8Array(bytes), name);
    names.push(name);
    const text = x.pages.map((p) => (p.label ? `[${p.label}]\n${p.text}` : p.text)).join("\n\n").trim();
    parts.push(
      x.status === "unsupported"
        ? `Arquivo "${name}": tipo que não consigo ler (aceito PDF, DOCX, PPTX, XLSX, TXT, MD, CSV).`
        : text
          ? `Arquivo "${name}":\n${text.length > FILE_TEXT ? `${text.slice(0, FILE_TEXT)}\n… (arquivo cortado em ${FILE_TEXT} caracteres de ${text.length})` : text}`
          : `Arquivo "${name}": não encontrei texto (${x.error ?? "vazio ou só imagens"}).`,
    );
  }
  return { text: parts.join("\n\n"), names };
}

// ------------------------------------------------------------ ação
export async function handleAgentBuilderMavi(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
  builder: BuilderEnv = builderEnv(env),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  const f: Fetch = deps.fetch;
  const history: BuilderMessage[] = (Array.isArray(req.messages) ? req.messages : [])
    .map((m) => (m && typeof m === "object" ? (m as Row) : {}))
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as BuilderMessage["role"], content: str(m.content, 8000) }))
    .filter((m) => m.content)
    .slice(-30);
  const draft = req.draft && typeof req.draft === "object" && !Array.isArray(req.draft) ? (req.draft as Row) : {};
  const heldFiles = (Array.isArray(req.files) ? req.files : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 20);

  let meter: Awaited<ReturnType<LlmAdapter>>["meter"] | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  let ref: { mavi_client_id?: string; mavi_contract_id?: string } = {};
  try {
    const { a, access } = await loadAgentAccess(builder, f, authorization, company, str(req.agent, 40));
    if (!access.write) return fail(403, "Só quem edita este produto do cliente no Drive monta o agente com a MAVI.");
    ref = a.external_ref ?? {};
    const attachments = await readAttachments(req.attachments);
    const files = [...new Set([...heldFiles, ...attachments.names])];

    const [limits, route, knowledge] = await Promise.all([
      callRpc<{ blocked: boolean; message: string | null }>(env, f, authorization, "ai_check_limits", {
        p_company: company,
        p_client: ref.mavi_client_id ?? null,
        p_contract: ref.mavi_contract_id ?? null,
        p_project: null,
      }),
      featureProvider(env, f, authorization, company, "agent_builder"),
      engine<KnowledgeSummary>(builder, f, "GET", `/v1/agents/${a.id}/knowledge?limit=300`).catch(() => null),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked) throw new BuilderError(429, limits.data.message ?? "Limite de uso da MAVI atingido.");
    if (!provider && !env.anthropicKey)
      throw new BuilderError(503, "A MAVI não está configurada no servidor. Escolha um provedor para os Agentes no Painel da MAVI.");

    // ---------------------------------------------- ferramentas
    let calls = 0;
    const robots = new Map<string, string>();
    const execute = async (name: string, input: unknown): Promise<string> => {
      const args = (input && typeof input === "object" ? input : {}) as Row;
      if (++calls > MAX_TOOL_CALLS) return "Limite de consultas desta resposta: proponha com o que já tem ou pergunte à pessoa.";
      try {
        if (name === "ler_site") {
          const page = await scrapePage(str(args.url, 2000), { fetch: f }, robots, { focus: str(args.foco, 200) });
          return pageForMavi(page, `S${calls}`, true).slice(0, 24_000);
        }
        if (name === "prompts_do_n8n") {
          const r = await callRpc<Row[]>(env, f, authorization, "agent_list", {
            p_company: company,
            p_client: ref.mavi_client_id,
            p_contract: null,
            p_query: null,
            p_unlinked: false,
          });
          if (!r.ok) return `Não consegui ler os fluxos do n8n: ${r.error}`;
          const lines: string[] = [];
          for (const w of r.data ?? []) {
            if (w.role === "copy") continue;
            for (const p of (Array.isArray(w.prompts) ? w.prompts : []) as Row[]) {
              if (p.removed) continue;
              lines.push(`- id ${String(p.id)}: "${String(p.node_name)}" no fluxo "${String(w.name)}" (${w.role === "main" ? "principal" : "subfluxo"}${w.active ? ", ativo" : ", parado"}) — ${String(p.chars)} caracteres`);
            }
          }
          return lines.length ? `Agentes deste cliente no n8n:\n${lines.join("\n")}` : "Este cliente não tem agente no n8n ligado a ele.";
        }
        if (name === "ler_prompt_do_n8n") {
          const id = str(args.id, 40);
          if (!UUID.test(id)) return "Informe o id listado por prompts_do_n8n.";
          const r = await callRpc<Row>(env, f, authorization, "agent_prompt_get", { p_prompt: id });
          if (!r.ok) return `Não consegui ler o prompt: ${r.error}`;
          const text = String(r.data?.prompt ?? "").replace(/^=/, "");
          return `Prompt "${String(r.data?.node_name ?? "")}" (${text.length} caracteres):\n${text.slice(0, 60_000)}${text.length > 60_000 ? "\n… (cortado)" : ""}`;
        }
        if (name === "buscar_na_base") {
          const r = await engine<{ results: Row[] }>(builder, f, "POST", `/v1/agents/${a.id}/knowledge/search`, { query: str(args.consulta, 1000), k: 6 });
          if (!r.results.length) return "Nada na base sobre isso.";
          return r.results.map((x) => `- (${String(x.kind)}) ${String(x.title)}: ${String(x.content).slice(0, 500)}`).join("\n");
        }
        return "Ferramenta desconhecida.";
      } catch (e) {
        return `Não deu: ${(e as Error).message ?? "erro"}`;
      }
    };

    // ---------------------------------------------- mensagens
    const state = [
      `Agente: "${a.name}" — cliente ${access.client_name}.`,
      a.published_version ? `Publicado na versão ${a.published_version}.` : "Ainda não publicado.",
      `Rascunho atual:\n${draftText(draft)}`,
      `Base de conhecimento:\n${knowledgeText(knowledge)}`,
      files.length ? `Arquivos anexados nesta conversa (podem ir para a base como "file"): ${files.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const last = history[history.length - 1];
    const opener = "(A pessoa abriu a conversa com você para montar o agente. Cumprimente em uma frase e comece a entrevista.)";
    const userTurn = `${last?.role === "user" ? last.content : opener}${attachments.text ? `\n\n${attachments.text}` : ""}\n\n---\n${state}`;
    const messages = [...(last?.role === "user" ? history.slice(0, -1) : history), { role: "user" as const, content: userTurn }];

    const llm: LlmAdapter = routedLlm(
      provider ? (deps.providerLlm ?? ((c) => adapterFor(c, f)))(provider.config) : deps.llm,
      {
        env,
        fetch: f,
        auth: authorization,
        where: { company, surface: "agents", feature: "agent_builder", client: ref.mavi_client_id ?? null },
        scope: { client: ref.mavi_client_id ?? null, contract: ref.mavi_contract_id ?? null },
        used: { providerId: provider?.id ?? null, model: provider?.config.model || env.model, scope: provider?.scope, auto: provider?.auto },
        question: last?.role === "user" ? last.content : "montar o agente",
        hasServerKey: !!env.anthropicKey,
        open: {
          providerKey: env.providerKey ?? null,
          anthropicKey: env.anthropicKey,
          make: (c) => (deps.providerLlm ?? ((x) => adapterFor(x, f)))(c),
          server: { model: env.model, llm: deps.llm },
        },
        onUsed: (c, config) => {
          provider = c.providerId ? { id: c.providerId, config, scope: "router" } : null;
        },
      },
    );
    const result = await llm({
      instructions: BUILDER_MAVI_INSTRUCTIONS.replace("{fields}", fieldsGuide()),
      context: `Quem conversa: ${access.user_label}${access.leader ? " (administrador ou gestor)" : ""}. Hoje: ${new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full" }).format(new Date(deps.now?.() ?? Date.now()))}.`,
      messages,
      tools: BUILDER_MAVI_TOOLS,
      execute: async (name, input) => outputText(await execute(name, input)),
      maxRounds: 10,
      effort: "medium",
      maxTokens: 16_000,
    });
    meter = result.meter;
    const reply = parseBuilderReply(result.text, draft, files);
    return { status: 200, body: { ...reply, files, model: meter?.model || provider?.config.model || env.model } };
  } catch (err) {
    if (err instanceof BuilderError) return fail(err.status, err.message);
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await callRpc(env, f, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "agents",
        p_kind: "agent_builder",
        p_client: ref.mavi_client_id ?? null,
        p_contract: ref.mavi_contract_id ?? null,
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

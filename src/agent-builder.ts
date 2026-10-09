import { supabase } from "./supabase";

/**
 * Agente Conversacional › Agentes MAVI (api/_agent-builder.ts): os agentes
 * que rodam no motor próprio (mavi-agentes). O navegador fala só com /api/ai;
 * o servidor confere a regra do Drive e chama o motor com a chave dele.
 */

export type KnowledgeKind = "faq" | "product" | "document" | "media" | "example" | "text";

export type BuilderAgent = {
  id: string;
  company_id: string;
  name: string;
  origin: "mavi_tasks" | "makecrm";
  status: "active" | "paused";
  external_ref: { mavi_client_id?: string; mavi_contract_id?: string; client_code?: number };
  published_version: number | null;
  draft_updated_at: string;
  created_at: string;
  updated_at: string;
  bindings?: number;
};

/** O rascunho é o JSON da especificação (mavi-agent/v1), editado por partes. */
export type AgentDraft = Record<string, any>;
export type DraftError = { path: string; message: string };
export type DraftValidation = { valid: boolean; errors: DraftError[] };

export type AgentBinding = {
  id: string;
  inbox_id: string;
  inbox_name: string;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
};

export type AgentDetail = {
  agent: BuilderAgent & { draft: AgentDraft; draft_updated_by: string | null };
  draft_validation: DraftValidation;
  published: { version: number; spec: AgentDraft; note: string; published_by: string | null; created_at: string } | null;
  bindings: AgentBinding[];
  can_edit: boolean;
};

export type AgentVersion = {
  version: number;
  note: string;
  restored_from: number | null;
  published_by: string | null;
  created_at: string;
};

export type KnowledgeItem = {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body_preview: string;
  body_length: number;
  data: Record<string, any>;
  source: { type?: string; url?: string; filename?: string; mime?: string; size?: number };
  status: "pending" | "processing" | "ready" | "error";
  error: string | null;
  chunk_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
export type KnowledgeTotals = { total: number; ready: number; errors: number; processing: number; chunks: number };

export type SearchResult = {
  chunk_id: string;
  item_id: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  context: string;
  score: number;
  vector_rank: number | null;
  keyword_rank: number | null;
};

export type MakecrmInbox = {
  id: string;
  name: string;
  type_id: number;
  status: boolean;
  kind: "whatsapp_uazapi" | "whatsapp_business_api";
  bound_agent: { id: string; name: string } | null;
};

export type ReplyMessage = { text: string; media: string[] };
export type TurnTrace = {
  id: string;
  status: "done" | "silent" | "error" | "skipped";
  model: string | null;
  rounds: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_usd: string | number;
  timings: Record<string, number>;
  tools: { name: string; args?: unknown; result: string; ms: number }[];
  retrieved: { ref: string; kind: string; title: string; score: number; via: string }[];
  output: { messages: ReplyMessage[]; silent_reason: string | null; handoff: string | null } | null;
  error: string | null;
  created_at: string;
  simulation?: boolean;
  agent_version?: number | null;
  external_id?: string;
  contact_name?: string | null;
  phone?: string | null;
  messages?: ReplyMessage[] | null;
};
export type SimulateResult = {
  conversation_id: string;
  result: {
    status: TurnTrace["status"];
    messages: ReplyMessage[];
    attachments: Record<string, { url: string; mime: string; title: string }>;
    silentReason?: string;
    handoff?: string;
    error?: string;
  };
  turn: TurnTrace | null;
};
export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "note";
  content: string;
  content_type: string;
  media: unknown;
  turn_id: string | null;
  created_at: string;
};
export type UsageDay = {
  day: string;
  simulation: boolean;
  turns: number;
  errors: number;
  tokens_in: string | number;
  tokens_out: string | number;
  tokens_cached: string | number;
  cost_usd: string | number;
};
export type AgentConversation = {
  id: string;
  external_id: string;
  phone: string | null;
  contact_name: string | null;
  facts: Record<string, string>;
  summary: string;
  last_inbound_at: string | null;
  last_reply_at: string | null;
  created_at: string;
};

export class BuilderError extends Error {
  constructor(
    message: string,
    readonly details: DraftError[] = [],
  ) {
    super(message);
  }
}

// Sem banco (demonstração): os dados de exemplo, carregados só então.
const demo = () => (supabase ? null : import("./agent-builder-demo"));

async function server<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new BuilderError("Supabase não configurado");
  const call = async () => {
    const token = (await supabase!.auth.getSession()).data.session?.access_token;
    return fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  };
  let res = await call();
  if (res.status === 401) {
    await supabase.auth.refreshSession();
    res = await call();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new BuilderError(data.error ?? "Não foi possível falar com o servidor.", Array.isArray(data.details) ? data.details : []);
  return data as T;
}

export const listBuilderAgents = (company: string, client?: string | null) =>
  demo()?.then((m) => m.demoList()) ??
  server<{ agents: BuilderAgent[]; leader: boolean; configured: boolean }>({ action: "builder-list", company, client: client ?? null });

export const createBuilderAgent = (company: string, input: { client: string; contract: string; name: string }) =>
  demo()?.then((m) => m.demoCreate(input)) ?? server<{ agent: BuilderAgent }>({ action: "builder-create", company, ...input });

/** Uma operação num agente (ver OPS em api/_agent-builder.ts). */
export function agentOp<T>(company: string, agent: string, op: string, extra: Record<string, unknown> = {}): Promise<T> {
  return (
    (demo()?.then((m) => m.demoOp(agent, op, extra)) as Promise<T> | undefined) ??
    server<T>({ action: "builder-agent", company, agent, op, ...extra })
  );
}

/** Envia o arquivo direto ao armazenamento do motor e registra o item. */
export async function uploadKnowledgeFile(
  company: string,
  agent: string,
  file: File,
  opts: { kind: "document" | "media"; title?: string; description?: string },
): Promise<{ id: string }> {
  const mime = file.type || guessMime(file.name);
  const link = await agentOp<{ item_id: string; storage_path: string; upload_url: string }>(company, agent, "upload-url", {
    kind: opts.kind,
    filename: file.name,
    mime,
    size: file.size,
  });
  if (link.upload_url) {
    const put = await fetch(link.upload_url, { method: "PUT", headers: { "Content-Type": mime }, body: file });
    if (!put.ok) throw new BuilderError("Não foi possível enviar o arquivo. Tente de novo.");
  }
  return agentOp<{ id: string }>(company, agent, "uploaded", {
    item_id: link.item_id,
    storage_path: link.storage_path,
    kind: opts.kind,
    filename: file.name,
    mime,
    title: opts.title ?? "",
    description: opts.description ?? "",
  });
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};
export const guessMime = (name: string) => MIME[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";

// ------------------------------------------------------------ rascunho

/** Lê um campo do rascunho pelo caminho ("persona.name"). */
export function draftGet(draft: AgentDraft, path: string): any {
  return path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), draft);
}

/** Troca um campo sem mexer no resto (cópia rasa por nível). */
export function draftSet(draft: AgentDraft, path: string, value: unknown): AgentDraft {
  const keys = path.split(".");
  const next: AgentDraft = { ...draft };
  let cur: any = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    cur[k] = cur[k] && typeof cur[k] === "object" && !Array.isArray(cur[k]) ? { ...cur[k] } : {};
    cur = cur[k];
  }
  const last = keys[keys.length - 1]!;
  if (value === undefined || value === "" || (Array.isArray(value) && !value.length && !REQUIRED_LISTS.has(path))) delete cur[last];
  else cur[last] = value;
  return next;
}
const REQUIRED_LISTS = new Set<string>();

/** Linhas de uma lista (regras, "nunca", campos do contato). */
export const linesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);

/** Planilha simples (CSV com ; ou ,) para importar FAQ e produtos. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0]!.match(/;/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0) ? ";" : ",";
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const norm = (h: string) =>
    h
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  const head = split(lines[0]!).map(norm);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
}

/** Linhas da planilha → itens (FAQ: pergunta/resposta; produto: nome/preço/categoria/descrição + o resto como atributos). */
export function csvToItems(rows: Record<string, string>[], kind: "faq" | "product") {
  if (kind === "faq") {
    return rows
      .map((r) => ({ q: r.pergunta ?? r.question ?? "", a: r.resposta ?? r.answer ?? "" }))
      .filter((r) => r.q && r.a)
      .map((r) => ({ kind: "faq", data: { question: r.q, answer: r.a } }));
  }
  const known = new Set(["nome", "name", "produto", "preco", "price", "valor", "categoria", "category", "descricao", "description", "codigo", "sku"]);
  return rows
    .map((r) => {
      const name = r.nome ?? r.name ?? r.produto ?? "";
      const attributes = Object.fromEntries(Object.entries(r).filter(([k, v]) => !known.has(k) && v));
      return {
        kind: "product",
        data: {
          name,
          price: r.preco ?? r.price ?? r.valor ?? "",
          category: r.categoria ?? r.category ?? "",
          description: r.descricao ?? r.description ?? "",
          sku: r.codigo ?? r.sku ?? "",
          ...(Object.keys(attributes).length ? { attributes } : {}),
        },
      };
    })
    .filter((i) => i.data.name);
}

export const KIND_LABEL: Record<KnowledgeKind, string> = {
  faq: "Pergunta e resposta",
  product: "Produto",
  document: "Documento",
  media: "Mídia",
  example: "Exemplo de conversa",
  text: "Texto",
};

export const usd = (v: string | number | null | undefined) =>
  `US$ ${Number(v ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;

/** Data e hora de Brasília. */
export const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Sao_Paulo",
      })
    : "—";
export const errorOf = (e: unknown) => (e as Error)?.message ?? "Algo deu errado.";

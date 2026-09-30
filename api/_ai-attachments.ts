import Anthropic from "@anthropic-ai/sdk";
import { logCost } from "./_ai-cost.js";
import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import { extractFileText } from "./_ai-extract.js";
import { embeddingCost, vectorLiteral, type Embedder } from "./_ai-embeddings.js";
import {
  featureProvider,
  isClaude,
  priceCost,
  resolveRoute,
  routeConfig,
  type ProviderConfig,
} from "./_ai-providers.js";
import { transcribe } from "./_whatsapp.js";
import { addUsage, newMeter } from "./_social-leads.js";
import { transcribePerMinute } from "../src/ai-providers.js";
import type { ToolSpec } from "./_ai-llm.js";
import { cite, reranked, type ToolContext } from "./_ai-tools.js";

/**
 * MAVI · anexos na conversa (migração 20261221090000_mavi_attachments).
 *
 * O arquivo vai direto do navegador para o GCS (link assinado com o tamanho
 * travado). Depois, o servidor lê uma vez só:
 * - documentos (PDF, Word, PowerPoint, Excel, texto): a extração de sempre;
 * - imagens: descrição e todo o texto visível, pelo modelo do módulo MAVI
 *   (com visão), para a MAVI "ver" a imagem em qualquer pergunta depois;
 * - áudio e vídeo (até 25 MB): transcrição.
 * O texto vira trechos com o nome do arquivo e a página (contexto em cada
 * trecho), vetorizados na hora, na mesma base (HNSW + texto) com acesso
 * 'private': só a busca dos anexos da conversa encontra.
 */

type Fetch = typeof fetch;
export type AttachEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  providerKey: Buffer | null;
  anthropicKey: string;
  model: string;
  openaiKey: string;
  embeddingModel: string;
  credentials?: GcsCredentials | null;
  bucket?: string;
};
export type AttachDeps = {
  fetch: Fetch;
  embed: Embedder;
  /** Continua o trabalho mesmo se a pessoa sair (waitUntil na Vercel). */
  background?: (work: Promise<unknown>) => void;
  /** A Claude (trocada nos testes). */
  anthropic?: (apiKey: string, baseUrl?: string) => Pick<Anthropic, "messages">;
};
type Row = Record<string, unknown>;
export type AttachmentKind = "document" | "image" | "audio" | "video";

export class AttachError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const EXT: Record<string, { kind: AttachmentKind; text?: "pdf" | "docx" | "pptx" | "xlsx" | "text"; mime: string }> = {
  pdf: { kind: "document", text: "pdf", mime: "application/pdf" },
  docx: { kind: "document", text: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pptx: { kind: "document", text: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  xlsx: { kind: "document", text: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  txt: { kind: "document", text: "text", mime: "text/plain" },
  md: { kind: "document", text: "text", mime: "text/markdown" },
  csv: { kind: "document", text: "text", mime: "text/csv" },
  json: { kind: "document", text: "text", mime: "application/json" },
  html: { kind: "document", text: "text", mime: "text/html" },
  htm: { kind: "document", text: "text", mime: "text/html" },
  xml: { kind: "document", text: "text", mime: "application/xml" },
  log: { kind: "document", text: "text", mime: "text/plain" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  wav: { kind: "audio", mime: "audio/wav" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  oga: { kind: "audio", mime: "audio/ogg" },
  opus: { kind: "audio", mime: "audio/ogg" },
  aac: { kind: "audio", mime: "audio/aac" },
  flac: { kind: "audio", mime: "audio/flac" },
  mp4: { kind: "video", mime: "video/mp4" },
  mov: { kind: "video", mime: "video/quicktime" },
  webm: { kind: "video", mime: "video/webm" },
  mpeg: { kind: "video", mime: "video/mpeg" },
};
const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? "";
/** O tipo do anexo pelo nome (o que não está aqui não entra). */
export function attachmentKind(name: string) {
  return EXT[ext(name)] ?? null;
}
export const MAX_BYTES: Record<AttachmentKind, number> = {
  document: 52_428_800,
  image: 52_428_800,
  audio: 26_214_400,
  video: 26_214_400,
};
/** A Claude lê imagens de até 5 MB (a tela reduz antes de subir). */
const IMAGE_MAX = 5_000_000;

export const IMAGE_PROMPT = `Você lê esta imagem para a MAVI, a inteligência de uma agência de marketing, que vai responder perguntas sobre ela sem vê-la. Responda em português do Brasil, em Markdown, com estas partes:
## Descrição
O que a imagem mostra, com os detalhes que importam (pessoas, produtos, cenário, composição, cores, estilo, marca).
## Texto na imagem
Transcreva exatamente todo o texto visível, na ordem de leitura (títulos, preços, datas, rodapés). Se não houver, escreva "Sem texto".
## Dados
Se houver gráfico, tabela, painel ou print de sistema: os números, rótulos e períodos, como tabela em Markdown. Se não houver, omita esta parte.
Não invente o que não dá para ver; diga quando algo estiver ilegível.`;

// ------------------------------------------------------------ leitura
async function download(env: AttachEnv, fetchImpl: Fetch, path: string) {
  if (!env.credentials || !env.bucket) throw new AttachError(500, "Credenciais do GCS não configuradas.");
  const res = await fetchImpl(signGcsUrl(env.credentials, env.bucket, path, "GET", { expiresInSeconds: 300 }), {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new AttachError(502, `Não achei o arquivo enviado (${res.status}). Envie de novo.`);
  return new Uint8Array(await res.arrayBuffer());
}

type Cost = { usd: number; model: string; input: number; output: number; provider: string | null; kind: string };

/** A descrição e o texto da imagem, pelo modelo do módulo (ou a Claude do servidor). */
export async function describeImage(
  env: AttachEnv,
  deps: AttachDeps,
  auth: string,
  company: string,
  bytes: Uint8Array,
  mime: string,
): Promise<{ text: string; cost: Cost }> {
  if (bytes.byteLength > IMAGE_MAX)
    throw new AttachError(400, "Imagem grande demais para ler (até 5 MB). Envie uma versão menor.");
  const route = await resolveRoute(env, deps.fetch, auth, company, {}, "mavi_page").catch(() => null);
  let config: ProviderConfig | null = route ? routeConfig(env, route) : null;
  const data = Buffer.from(bytes).toString("base64");
  // Sem regra no painel, ou com um provedor fora da Claude sem visão conhecida: a Claude do servidor.
  if (!config && env.anthropicKey)
    config = { kind: "anthropic", name: "Claude", baseUrl: "", apiKey: env.anthropicKey, model: env.model, price: null };
  if (!config) throw new AttachError(503, "Nenhum modelo configurado para ler imagens.");
  if (isClaude(config)) {
    const client =
      deps.anthropic?.(config.apiKey, config.baseUrl || undefined) ??
      new Anthropic({ apiKey: config.apiKey, maxRetries: 2, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
    const message = await client.messages.create({
      model: config.model,
      max_tokens: 3000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mime as "image/png", data },
            },
            { type: "text", text: IMAGE_PROMPT },
          ],
        },
      ],
    });
    const meter = newMeter(config.model);
    addUsage(meter, message.model, message.usage, config.price);
    const text = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return {
      text,
      cost: {
        usd: meter.cost,
        model: config.model,
        input: meter.input,
        output: meter.output,
        provider: route?.provider_id ?? null,
        kind: "attachment_image",
      },
    };
  }
  const res = await deps.fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 3000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } },
            { type: "text", text: IMAGE_PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string };
  };
  if (!res.ok)
    throw new AttachError(
      502,
      `O modelo ${config.model} não leu a imagem${body.error?.message ? `: ${body.error.message.slice(0, 160)}` : "."} Escolha um modelo com visão em Quem usa qual modelo › MAVI no módulo.`,
    );
  const input = body.usage?.prompt_tokens ?? 0;
  const output = body.usage?.completion_tokens ?? 0;
  return {
    text: (body.choices?.[0]?.message?.content ?? "").trim(),
    cost: {
      usd:
        typeof body.usage?.cost === "number" ? body.usage.cost : priceCost(config.price, { input, output, cached: 0 }),
      model: config.model,
      input,
      output,
      provider: route?.provider_id ?? null,
      kind: "attachment_image",
    },
  };
}

type Pages = { label: string | null; text: string }[];

/** Lê o anexo conforme o tipo: páginas de texto e o custo. */
async function read(
  env: AttachEnv,
  deps: AttachDeps,
  auth: string,
  a: { company: string; name: string; kind: AttachmentKind; mime: string; path: string; size?: number },
  seconds: number | null,
): Promise<{ pages: Pages; cost: Cost | null }> {
  const bytes = await download(env, deps.fetch, a.path);
  // O arquivo tem que ser o que foi declarado (nada maior que o limite passa).
  if (bytes.byteLength > Math.min(a.size ?? Infinity, MAX_BYTES[a.kind])) {
    if (env.credentials && env.bucket)
      await deps.fetch(signGcsUrl(env.credentials, env.bucket, a.path, "DELETE"), { method: "DELETE" }).catch(() => null);
    throw new AttachError(413, "O arquivo enviado é maior que o declarado. Envie de novo.");
  }
  const info = attachmentKind(a.name);
  if (a.kind === "document") {
    const x = await extractFileText(info?.text ?? "text", bytes, a.name);
    if (x.status === "unsupported") throw new AttachError(415, "Não dá para ler este tipo de documento.");
    if (x.status === "error") throw new AttachError(422, x.error ?? "Não foi possível ler o documento.");
    return { pages: x.pages.map((p) => ({ label: p.label, text: p.text })), cost: null };
  }
  if (a.kind === "image") {
    const mime = info?.mime ?? a.mime;
    const d = await describeImage(env, deps, auth, a.company, bytes, mime);
    return { pages: [{ label: "Imagem", text: d.text }], cost: d.cost };
  }
  // Áudio e vídeo: a transcrição (o vídeo vai com a trilha de áudio).
  const provider = await featureProvider(env, deps.fetch, auth, a.company, "task_audio_transcribe").catch(() => null);
  const model = provider?.config.model ?? "gpt-4o-mini-transcribe";
  if (!provider && !env.openaiKey) throw new AttachError(503, "Nenhum modelo configurado para transcrever áudio.");
  const text = await transcribe(
    { openaiKey: env.openaiKey, transcribeModel: model },
    { fetch: deps.fetch },
    bytes,
    info?.mime ?? a.mime,
    a.name,
    provider?.config ?? null,
  );
  const minutes = Math.max((seconds ?? bytes.byteLength / 16_000) / 60, 0.1);
  return {
    pages: [{ label: a.kind === "video" ? "Transcrição do vídeo" : "Transcrição", text }],
    cost: {
      usd: minutes * transcribePerMinute(model, 0.003),
      model,
      input: 0,
      output: 0,
      provider: provider?.id ?? null,
      kind: "attachment_transcription",
    },
  };
}

async function rpc<T>(env: AttachEnv, fetchImpl: Fetch, auth: string, name: string, args: Row): Promise<T> {
  const r = await callRpc<T>(env, fetchImpl, auth, name, args);
  if (!r.ok) throw new AttachError(r.status, r.error);
  return r.data;
}

/** O gasto de ler o anexo: fica no anexo e, por ele, na conversa em que foi usado. */
const logUsage = (
  env: AttachEnv,
  fetchImpl: Fetch,
  auth: string,
  company: string,
  c: Cost,
  embedding = 0,
  attachment: string | null = null,
) =>
  logCost(
    env,
    fetchImpl,
    auth,
    { company, module: "assistant" },
    {
      kind: c.kind,
      model: c.model,
      provider: c.provider,
      input: c.input,
      output: c.output,
      cacheRead: 0,
      cacheWrite: 0,
      embedding,
      cost: c.usd,
    },
    null,
    attachment,
  );

/** Vetoriza os trechos que faltam (em lotes) e guarda. */
async function embedPending(
  env: AttachEnv,
  deps: AttachDeps,
  auth: string,
  company: string,
  attachment: string,
  pending: { id: number; content: string }[],
) {
  let tokens = 0;
  let model = env.embeddingModel;
  for (let i = 0; i < pending.length; i += 128) {
    const batch = pending.slice(i, i + 128);
    const out = await deps.embed(batch.map((c) => c.content));
    tokens += out.tokens;
    model = out.model;
    await rpc(env, deps.fetch, auth, "ai_attachment_store_embeddings", {
      p_attachment: attachment,
      p_model: out.model,
      p_items: batch.map((c, k) => ({ id: c.id, embedding: vectorLiteral(out.vectors[k]) })),
    });
  }
  if (tokens)
    await logUsage(
      env,
      deps.fetch,
      auth,
      company,
      { usd: embeddingCost(model, tokens), model, input: 0, output: 0, provider: null, kind: "attachment_index" },
      tokens,
      attachment,
    );
}

/** Lê, divide, vetoriza e marca pronto (ou com erro). Devolve como ficou. */
async function processAttachment(env: AttachEnv, deps: AttachDeps, auth: string, id: string, seconds: number | null) {
  const a = await rpc<{
    id: string;
    company: string;
    name: string;
    kind: AttachmentKind;
    mime: string;
    path: string;
    size: number;
    status: string;
  }>(env, deps.fetch, auth, "ai_attachment_begin", { p_attachment: id });
  if (a.status === "ready") return a;
  try {
    const { pages, cost } = await read(env, deps, auth, a, seconds);
    if (cost) await logUsage(env, deps.fetch, auth, a.company, cost, 0, a.id);
    const useful = pages.filter((p) => p.text.trim().length >= 3);
    if (!useful.length) {
      await rpc(env, deps.fetch, auth, "ai_attachment_finish", {
        p_attachment: id,
        p_status: "empty",
        p_pages: null,
        p_error: a.kind === "image" ? "A imagem não tem nada para ler." : "O arquivo não tem texto para ler.",
      });
    } else {
      const pending = await rpc<{ id: number; content: string }[]>(env, deps.fetch, auth, "ai_attachment_finish", {
        p_attachment: id,
        p_status: "ready",
        p_pages: useful.map((p) => ({ label: p.label, text: p.text.slice(0, 200_000) })),
        p_error: null,
      });
      // Sem vetor agora, o worker de sempre faz em até um minuto (a busca por texto já vale).
      await embedPending(env, deps, auth, a.company, id, pending).catch(() => null);
    }
  } catch (e) {
    const status = e instanceof AttachError && e.status === 415 ? "unsupported" : "error";
    await callRpc(env, deps.fetch, auth, "ai_attachment_finish", {
      p_attachment: id,
      p_status: status,
      p_pages: null,
      p_error: ((e as Error).message || "Não foi possível ler o arquivo.").slice(0, 300),
    }).catch(() => null);
  }
  return rpc<Row>(env, deps.fetch, auth, "ai_attachment_get", { p_attachment: id }).catch(() => ({ id }) as Row);
}

// ------------------------------------------------------------ ações da tela
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function handleAttachments(
  req: Row,
  auth: string | null,
  env: AttachEnv,
  deps: AttachDeps,
): Promise<{ status: number; body: Row }> {
  if (!auth?.startsWith("Bearer ")) return { status: 401, body: { error: "Entre na sua conta." } };
  try {
    const id = str(req.id, 40);
    if (req.action === "ai-attach-sign") {
      const company = str(req.company, 40);
      if (!UUID.test(company)) throw new AttachError(400, "Empresa inválida.");
      const name = str(req.name, 200);
      const info = attachmentKind(name);
      if (!info)
        throw new AttachError(
          415,
          "Tipo de arquivo não aceito. Envie PDF, Word, PowerPoint, Excel, texto, imagem, áudio ou vídeo.",
        );
      const size = Number(req.size);
      if (!Number.isFinite(size) || size < 1 || size > MAX_BYTES[info.kind])
        throw new AttachError(413, "Arquivo grande demais: até 50 MB (áudio e vídeo até 25 MB).");
      const conversation = UUID.test(str(req.conversation, 40)) ? str(req.conversation, 40) : null;
      const created = await rpc<Row & { id: string; path: string; reused: boolean; status: string }>(
        env,
        deps.fetch,
        auth,
        "ai_attachment_create",
        {
          p_company: company,
          p_conversation: conversation,
          p_name: name,
          p_mime: info.mime,
          p_size: Math.floor(size),
          p_kind: info.kind,
          p_sha256: /^[0-9a-f]{64}$/.test(str(req.sha256, 64)) ? str(req.sha256, 64) : null,
        },
      );
      const { path, ...attachment } = created;
      if (created.reused) return { status: 200, body: { attachment } };
      if (!env.credentials || !env.bucket) throw new AttachError(500, "Credenciais do GCS não configuradas.");
      // O tamanho declarado é conferido na leitura (arquivo maior é recusado e apagado).
      return {
        status: 200,
        body: {
          attachment,
          url: signGcsUrl(env.credentials, env.bucket, path, "PUT", { contentType: info.mime }),
          headers: { "Content-Type": info.mime },
        },
      };
    }
    if (!UUID.test(id)) throw new AttachError(400, "Anexo inválido.");
    if (req.action === "ai-attach-process") {
      const seconds = Number(req.seconds);
      const work = processAttachment(env, deps, auth, id, Number.isFinite(seconds) && seconds > 0 ? seconds : null);
      // Se a pessoa sair da tela, a leitura termina assim mesmo.
      deps.background?.(work.catch(() => null));
      return { status: 200, body: { attachment: await work } };
    }
    if (req.action === "ai-attach-delete") {
      const gone = await rpc<{ path: string; last: boolean }>(env, deps.fetch, auth, "ai_attachment_delete", {
        p_attachment: id,
      });
      if (gone.last && env.credentials && env.bucket)
        await deps
          .fetch(signGcsUrl(env.credentials, env.bucket, gone.path, "DELETE"), { method: "DELETE" })
          .catch(() => null);
      return { status: 200, body: { ok: true } };
    }
    if (req.action === "ai-attach-url") {
      const file = await rpc<{ path: string; name: string; mime: string } | null>(
        env,
        deps.fetch,
        auth,
        "ai_attachment_file",
        { p_attachment: id },
      );
      if (!file) throw new AttachError(404, "Anexo não encontrado.");
      if (!env.credentials || !env.bucket) throw new AttachError(500, "Credenciais do GCS não configuradas.");
      const safe = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
      return {
        status: 200,
        body: {
          url: signGcsUrl(env.credentials, env.bucket, file.path, "GET", {
            expiresInSeconds: 600,
            query: {
              "response-content-disposition": `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            },
          }),
        },
      };
    }
    return { status: 400, body: { error: "Ação inválida." } };
  } catch (e) {
    const status = e instanceof AttachError ? e.status : 500;
    return { status, body: { error: (e as Error).message || "Erro nos anexos." } };
  }
}

// ------------------------------------------------------------ na conversa
export type ConversationAttachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  status: string;
  error: string | null;
  pages: number | null;
  chars: number | null;
  preview: string | null;
};

export const ATTACH_TOOLS: ToolSpec[] = [
  {
    name: "search_attachments",
    description:
      "Busca nos arquivos que a pessoa anexou nesta conversa (documentos, imagens descritas, áudios e vídeos transcritos), por assunto: devolve os trechos mais relevantes, cada um com a referência [S#] para citar. Use antes de responder sobre o conteúdo dos anexos que não vieram inteiros na mensagem.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "O que procurar (palavras que devem aparecer no texto e o assunto)." },
        attachment: {
          type: "string",
          description: "Opcional: o nome (ou parte dele) de um anexo, para buscar só nele.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_attachment",
    description:
      "Lê um anexo desta conversa por inteiro (ou a partir de um trecho), na ordem: para resumir, revisar ou comparar o arquivo todo. Arquivos longos vêm em partes: continue com from.",
    parameters: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "O nome (ou parte dele) do anexo." },
        from: { type: "integer", description: "Opcional: continuar a partir deste trecho (o número que a leitura anterior indicou)." },
      },
      required: ["attachment"],
      additionalProperties: false,
    },
  },
];

export const ATTACH_RULES = `
Anexos: a pessoa anexou arquivos nesta conversa (lista no contexto). Os desta mensagem que couberam vêm inteiros no texto dela, com a referência [S#]. Para os outros (ou partes que faltaram), use search_attachments (por assunto) e read_attachment (o arquivo inteiro, em partes). Cite as referências [S#]. Imagens chegam descritas, com o texto delas transcrito (você não vê a imagem em si); áudios e vídeos chegam transcritos. Se um anexo não pôde ser lido, diga qual e por quê.`;

const fold = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
/** O anexo pelo nome (ou parte dele) ou pelo id. */
export function findAttachment(list: ConversationAttachment[], raw: unknown) {
  const q = fold(typeof raw === "string" ? raw : "");
  if (!q) return null;
  return (
    list.find((a) => a.id === q) ??
    list.find((a) => fold(a.name) === q) ??
    list.find((a) => fold(a.name).includes(q)) ??
    null
  );
}

const citeAttachment = (ctx: ToolContext, a: { id: string; name: string }, label: string | null, page?: number) =>
  cite(ctx, {
    type: "attachment",
    id: a.id,
    title: a.name,
    date: null,
    client_id: null,
    ...(label ? { label } : {}),
    ...(typeof page === "number" ? { page } : {}),
  });

/** O contexto: a lista dos anexos da conversa, como ficaram. */
export function attachmentContext(list: ConversationAttachment[]) {
  if (!list.length) return "";
  const kind = { document: "documento", image: "imagem", audio: "áudio", video: "vídeo" };
  return `\n\nAnexos desta conversa:\n${list
    .map(
      (a) =>
        `- “${a.name}” (${kind[a.kind] ?? a.kind}${a.pages ? `, ${a.pages} ${a.pages === 1 ? "parte" : "partes"}` : ""}): ${
          a.status === "ready"
            ? "lido"
            : a.status === "processing" || a.status === "uploading"
              ? "ainda sendo lido"
              : `não foi lido${a.error ? ` (${a.error})` : ""}`
        }`,
    )
    .join("\n")}`;
}

type ReadParts = { name: string; parts: { ord: number; label: string | null; text: string }[]; more: boolean };

/** Os anexos desta mensagem que cabem inteiros (até ~40 mil caracteres no total). */
export async function inlineAttachments(
  env: Pick<AttachEnv, "supabaseUrl" | "supabaseKey">,
  ctx: ToolContext,
  list: ConversationAttachment[],
  ids: string[],
  budget = 40_000,
) {
  const mine = list.filter((a) => ids.includes(a.id) && a.status === "ready");
  let left = budget;
  const blocks: string[] = [];
  for (const a of mine) {
    if ((a.chars ?? 0) > left) {
      blocks.push(`“${a.name}” é longo (${a.chars} caracteres): use search_attachments e read_attachment.`);
      continue;
    }
    const r = await callRpc<ReadParts>(env, ctx.fetch, ctx.auth, "ai_attachment_read", {
      p_attachment: a.id,
      p_from: 0,
      p_max: left,
    });
    if (!r.ok) continue;
    const ref = citeAttachment(ctx, a, null);
    const text = r.data.parts.map((p) => p.text).join("\n\n");
    left -= text.length;
    blocks.push(`[${ref}] Anexo “${a.name}”:\n${text}${r.data.more ? "\n… (continua: use read_attachment)" : ""}`);
  }
  return blocks.length ? `\n\n[Anexos desta mensagem]\n${blocks.join("\n\n---\n\n")}` : "";
}

/** As ferramentas dos anexos (busca e leitura), com as fontes citáveis. */
export async function runAttachmentTool(
  env: Pick<AttachEnv, "supabaseUrl" | "supabaseKey">,
  ctx: ToolContext,
  conversation: string,
  list: ConversationAttachment[],
  name: string,
  raw: unknown,
) {
  const input = (raw && typeof raw === "object" ? raw : {}) as Row;
  const ready = list.filter((a) => a.status === "ready");
  if (name === "search_attachments") {
    const query = str(input.query, 500);
    if (query.length < 2) return "Diga o que procurar.";
    const only = input.attachment ? findAttachment(ready, input.attachment) : null;
    if (input.attachment && !only) return `Não achei o anexo “${str(input.attachment, 80)}”. Anexos lidos: ${ready.map((a) => a.name).join(", ")}.`;
    const out = await ctx.embed([query]);
    ctx.usage.embeddingTokens += out.tokens;
    ctx.usage.embeddingModel = out.model;
    const r = await callRpc<{ chunk_id: number; attachment_id: string; name: string; content: string; meta: Row }[]>(
      env,
      ctx.fetch,
      ctx.auth,
      "ai_attachment_search",
      {
        p_conversation: conversation,
        p_embedding: vectorLiteral(out.vectors[0]),
        p_query: query,
        p_limit: ctx.rerank ? 20 : 8,
        p_ids: only ? [only.id] : null,
      },
    );
    if (!r.ok) throw new Error(r.error);
    if (!r.data.length) return "Nada encontrado nos anexos sobre isso.";
    const rows = await reranked(ctx, query, r.data, (row) => row.content, 8);
    return rows
      .map((row) => {
        const label = typeof row.meta?.label === "string" ? row.meta.label : null;
        const page = typeof row.meta?.page === "number" ? row.meta.page : undefined;
        const ref = citeAttachment(ctx, { id: row.attachment_id, name: row.name }, label, page);
        const body = row.content.split("\n").slice(1).join("\n").trim();
        return `[${ref}] Anexo “${row.name}”${label ? ` · ${label}` : ""}\n${body}`;
      })
      .join("\n\n");
  }
  if (name === "read_attachment") {
    const a = findAttachment(list, input.attachment);
    if (!a) return `Não achei o anexo “${str(input.attachment, 80)}”. Anexos: ${list.map((x) => x.name).join(", ")}.`;
    if (a.status !== "ready") return `O anexo “${a.name}” não foi lido${a.error ? `: ${a.error}` : " ainda"}.`;
    const from = Number.isInteger(input.from) ? Math.max(Number(input.from), 0) : 0;
    const r = await callRpc<ReadParts>(env, ctx.fetch, ctx.auth, "ai_attachment_read", {
      p_attachment: a.id,
      p_from: from,
      p_max: 30_000,
    });
    if (!r.ok) throw new Error(r.error);
    if (!r.data.parts.length) return `Não há mais nada em “${a.name}” a partir daí.`;
    const ref = citeAttachment(ctx, a, null);
    const last = r.data.parts[r.data.parts.length - 1].ord;
    return `[${ref}] Anexo “${a.name}” (trechos ${from} a ${last}):\n${r.data.parts.map((p) => p.text).join("\n\n")}${
      r.data.more ? `\n\n… continua: read_attachment com from=${last + 1}.` : "\n\n(fim do arquivo)"
    }`;
  }
  return `Ferramenta desconhecida: ${name}.`;
}

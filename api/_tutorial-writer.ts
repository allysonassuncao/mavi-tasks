import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import { embeddingCost, vectorLiteral } from "./_ai-embeddings.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import { sampledLlm } from "./_ai-samples.js";

/**
 * A MAVI escreve um tutorial (ação "tutorial-write" de /api/drive,
 * funcionalidade 'tutorial_writer' de Quem usa qual modelo, migração
 * 20270503090000_tutorial_extras). Uma chamada ao modelo, sem ferramentas,
 * que devolve JSON com título, resumo e os blocos do texto:
 *
 * - "idea": a partir de uma ideia em poucas linhas;
 * - "video": a partir da transcrição de um vídeo do tutorial;
 * - "improve": o texto aberto, organizado em seções e passos, sem
 *   acrescentar informação.
 *
 * As referências são as seções dos tutoriais publicados que a pessoa vê
 * (public.search_tutorials), para usar os nomes certos de telas e botões; o
 * que não está nelas nem no material vem como [confirmar: …]. As imagens e
 * os vídeos do texto aberto chegam como [[MIDIA n]] e voltam no lugar
 * (blocos "media"). Nada é aplicado sozinho: o editor mostra e quem escreve
 * aplica. Só administradores e gestores com a MAVI à mostra
 * (public.tutorial_can_write), dentro dos limites de gasto.
 */
export type WriterMode = "idea" | "video" | "improve";
export type WriterBlock =
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "steps" | "list"; items: string[] }
  | { type: "media"; n: number };
export type WriterDraft = { title: string; summary: string; blocks: WriterBlock[]; notes: string };

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE = /^[a-zA-Z]{2,40}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const LLM_TIMEOUT_MS = 90_000;
const REFERENCES = 6;

export class WriterError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const TUTORIAL_WRITER_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing. Seu nome é MAVI, no feminino. Aqui você escreve TUTORIAIS de uso do próprio sistema para o time da agência: guias passo a passo, claros, em português do Brasil.

Como escrever um tutorial:
- Título de até 80 caracteres, dizendo o que a pessoa vai conseguir fazer (ex.: "Como mudar o prazo de uma tarefa"). Sem ponto final e sem emoji.
- Resumo de 1 ou 2 frases: o que a pessoa aprende e quando usar.
- Seções com título (nível 2; nível 3 só para subdividir uma seção longa). Cada seção cobre uma etapa ou um assunto. Uma introdução curta pode vir antes da primeira seção.
- Passos numerados no imperativo ("Clique em…", "Escolha…", "Aperte Enter"), um por item, curtos. Parágrafos curtos para explicar o porquê ou o que acontece depois.
- Escreva os nomes de menus, botões, abas e campos exatamente como aparecem nas referências e no material, com **negrito** no nome.
- Nunca invente telas, botões, menus, regras, números ou permissões. O que não estiver nas referências nem no material, escreva entre colchetes: [confirmar: ...].
- Sem outro markdown além do **negrito**. Sem saudação, sem despedida.
- Mídias: o material pode trazer [[MIDIA n]] (uma imagem ou um vídeo do tutorial). Mantenha cada uma, uma vez só, no lugar onde ela ajuda, como um bloco {"type":"media","n":n}. Não invente números de mídia.

Responda apenas com JSON, sem texto em volta:
{"title": "...", "summary": "...", "blocks": [{"type": "paragraph", "text": "..."}, {"type": "heading", "level": 2, "text": "..."}, {"type": "steps", "items": ["...", "..."]}, {"type": "list", "items": ["..."]}, {"type": "media", "n": 1}], "notes": "o que quem escreve precisa conferir antes de publicar (curto; vazio se nada)"}`;

/** O pedido ao modelo, conforme o modo. */
export function writerMessage(
  mode: WriterMode,
  input: { idea: string; title: string; summary: string; source: string; modules: string[]; media: number },
) {
  const parts: string[] = [];
  if (mode === "idea") parts.push(`Escreva um tutorial novo a partir desta ideia:\n"""\n${input.idea}\n"""`);
  if (mode === "video")
    parts.push(
      `Transforme a transcrição deste vídeo num tutorial passo a passo. Fique só com o que o vídeo ensina (sem hesitações, repetições e conversa).${input.idea ? `\nO que quem escreve quer destacar: ${input.idea}` : ""}\nTranscrição:\n"""\n${input.source}\n"""`,
    );
  if (mode === "improve")
    parts.push(
      `Melhore este tutorial: organize em seções e passos numerados, corrija o português e deixe mais claro e mais curto. Não acrescente informação que não está nele (se faltar algo essencial, use [confirmar: ...]).${input.idea ? `\nO que quem escreve pediu: ${input.idea}` : ""}`,
    );
  if (input.title || input.summary)
    parts.push(`Título atual: ${input.title || "(sem título)"}\nResumo atual: ${input.summary || "(sem resumo)"}`);
  if (mode !== "video" && input.source) parts.push(`Texto atual do tutorial:\n"""\n${input.source}\n"""`);
  if (input.media) parts.push(`O texto tem ${input.media} mídia(s): [[MIDIA 1]] a [[MIDIA ${input.media}]]. Mantenha todas.`);
  if (input.modules.length) parts.push(`Telas (módulos) de que o tutorial fala: ${input.modules.join(", ")}.`);
  return parts.join("\n\n");
}

const clip = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** A resposta do modelo, conferida (JSON às vezes vem com texto em volta). */
export function parseDraft(text: string, media: number): WriterDraft | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let v: Row;
  try {
    v = JSON.parse(match[0]) as Row;
  } catch {
    return null;
  }
  const blocks: WriterBlock[] = [];
  const used = new Set<number>();
  for (const b of Array.isArray(v.blocks) ? (v.blocks as Row[]).slice(0, 200) : []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "heading") {
      const t = clip(b.text, 160);
      if (t) blocks.push({ type: "heading", level: b.level === 3 ? 3 : 2, text: t });
    } else if (b.type === "paragraph") {
      const t = clip(b.text, 4000);
      if (t) blocks.push({ type: "paragraph", text: t });
    } else if (b.type === "steps" || b.type === "list") {
      const items = (Array.isArray(b.items) ? b.items : []).map((i) => clip(i, 1000)).filter(Boolean).slice(0, 50);
      if (items.length) blocks.push({ type: b.type, items });
    } else if (b.type === "media") {
      const n = Number(b.n);
      if (Number.isInteger(n) && n >= 1 && n <= media && !used.has(n)) {
        used.add(n);
        blocks.push({ type: "media", n });
      }
    }
  }
  const title = clip(v.title, 160);
  if (!title || !blocks.some((b) => b.type !== "media")) return null;
  return { title, summary: clip(v.summary, 600), blocks, notes: clip(v.notes, 600) };
}

export async function handleTutorialWriter(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  const mode = req.mode as WriterMode;
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  if (!["idea", "video", "improve"].includes(mode)) return fail(400, "Pedido inválido.");
  const input = {
    idea: str(req.idea, 3000),
    title: str(req.title, 160),
    summary: str(req.summary, 600),
    source: str(req.source, 60000),
    modules: Array.isArray(req.modules)
      ? req.modules.map((m) => str(m, 60)).filter(Boolean).slice(0, 12)
      : [],
    media: Math.min(Math.max(Math.trunc(Number(req.media) || 0), 0), 60),
  };
  const moduleIds = Array.isArray(req.module_ids)
    ? req.module_ids.map((m) => str(m, 40)).filter((m) => MODULE.test(m)).slice(0, 12)
    : [];
  if (mode === "idea" && input.idea.length < 5) return fail(400, "Conte em poucas linhas do que é o tutorial.");
  if (mode === "video" && input.source.length < 40)
    return fail(400, "Este vídeo ainda não tem transcrição. Espere a transcrição ou escreva-a no player.");
  if (mode === "improve" && input.source.length < 20) return fail(400, "Escreva o tutorial primeiro.");

  const rpc = <T>(name: string, args: Row) => callRpc<T>(env, deps.fetch, authorization, name, args);
  let meter: Meter | undefined;
  let embedded = null as { tokens: number; model: string } | null;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const allowed = await rpc<boolean>("tutorial_can_write", { p_company: company });
    if (!allowed.ok) throw new WriterError(allowed.status, allowed.error);
    if (!allowed.data)
      throw new WriterError(403, "Só administradores e gestores, com a MAVI ligada, pedem à MAVI para escrever tutoriais.");
    const [limits, route] = await Promise.all([
      rpc<{ blocked: boolean; message: string | null }>("ai_check_limits", {
        p_company: company,
        p_client: null,
        p_contract: null,
        p_project: null,
      }),
      featureProvider(env, deps.fetch, authorization, company, "tutorial_writer", {}),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new WriterError(429, limits.data.message ?? "Limite de uso da MAVI atingido.");
    if (!provider && !env.anthropicKey)
      throw new WriterError(503, "A MAVI não está configurada no servidor. Escolha um provedor para escrever tutoriais no Painel da MAVI.");

    // As referências: o que os tutoriais publicados já dizem sobre o assunto.
    const query = (mode === "idea" ? input.idea : `${input.title} ${input.idea} ${input.source.slice(0, 400)}`)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    let embedding: string | null = null;
    if (env.openaiKey && query.length >= 3) {
      try {
        const out = await deps.embed([query]);
        embedded = { tokens: out.tokens, model: out.model };
        embedding = out.vectors[0] ? vectorLiteral(out.vectors[0]) : null;
      } catch {
        embedding = null;
      }
    }
    const found = query.length >= 2
      ? await rpc<{ title: string; section: string; content: string }[]>("search_tutorials", {
          p_company: company,
          p_query: query,
          p_embedding: embedding,
          p_module: moduleIds[0] ?? null,
          p_strict: false,
          p_category: null,
          p_tags: null,
          p_limit: REFERENCES,
        })
      : null;
    const refs = found?.ok ? (found.data ?? []) : [];
    const context = refs.length
      ? `Referências (trechos de tutoriais já publicados no sistema):\n\n${refs
          .map((h, i) => `[${i + 1}] “${h.title}”${h.section ? ` › ${h.section}` : ""}\n${h.content.slice(0, 1500)}`)
          .join("\n\n")}`
      : "Referências: nenhum tutorial publicado fala deste assunto ainda.";

    const llm: LlmAdapter = sampledLlm(
      provider ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config) : deps.llm,
      { db: env, fetch: deps.fetch, auth: authorization, company, feature: "tutorial_writer", client: null, providerId: provider?.id ?? null },
    );
    const result = await llm({
      instructions: TUTORIAL_WRITER_INSTRUCTIONS,
      context,
      messages: [{ role: "user", content: writerMessage(mode, input) }],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "low",
      maxTokens: 6000,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    meter = result.meter;
    const draft = parseDraft(result.text, input.media);
    if (!draft) throw new WriterError(502, "A MAVI não conseguiu escrever agora. Tente de novo.");
    return {
      status: 200,
      body: { ...draft, references: refs.length, model: meter?.model || provider?.config.model || env.model },
    };
  } catch (err) {
    if (err instanceof WriterError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    const log = (line: Row) =>
      rpc("ai_log_usage", {
        p_company: company,
        p_module: "tutorials",
        p_kind: `tutorial_writer_${mode}`,
        p_client: null,
        p_contract: null,
        p_project: null,
        p_recording: null,
        p_input: 0,
        p_output: 0,
        p_cache_read: 0,
        p_cache_write: 0,
        p_embedding: 0,
        ...line,
      }).catch(() => {});
    await Promise.all([
      meter
        ? log({
            p_model: meter.model || provider?.config.model || env.model,
            p_input: meter.input ?? 0,
            p_output: meter.output ?? 0,
            p_cache_read: meter.cacheRead ?? 0,
            p_cache_write: meter.cacheWrite ?? 0,
            p_cost: Math.round((meter.cost ?? 0) * 1e6) / 1e6,
            ...(provider ? { p_provider: provider.id } : {}),
          })
        : null,
      embedded
        ? log({
            p_model: embedded.model,
            p_embedding: embedded.tokens,
            p_cost: Math.round(embeddingCost(embedded.model, embedded.tokens) * 1e6) / 1e6,
          })
        : null,
    ]);
  }
}

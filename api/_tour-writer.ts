import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import { sampledLlm } from "./_ai-samples.js";
import { WriterError, parseDraft, type WriterDraft } from "./_tutorial-writer.js";

/**
 * A MAVI sugere o texto do balão de um passo de onboarding (ação
 * "tour-write" de /api/drive; a mesma funcionalidade 'tutorial_writer' de
 * Quem usa qual modelo e a mesma permissão de escrever tutoriais). Recebe o
 * que o editor sabe do passo — a tela, o elemento escolhido, o tipo do
 * passo, os passos em volta e o texto atual — e devolve título e texto
 * curtos. As referências são os tutoriais publicados (os nomes certos de
 * telas e botões); o que não está nelas vem como [confirmar: …]. Nada é
 * aplicado sozinho: o editor mostra e quem escreve aplica.
 */
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const LLM_TIMEOUT_MS = 60_000;

export const TOUR_WRITER_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing. Seu nome é MAVI, no feminino. Aqui você escreve o BALÃO de um passo de um onboarding: um tour guiado que destaca um elemento da tela (botão, campo, tabela…) e explica o que fazer, em português do Brasil.

Como escrever o balão:
- Título de até 60 caracteres, no imperativo ou dizendo o que é o elemento (ex.: "Crie sua primeira tarefa", "Aqui ficam suas tarefas atrasadas"). Sem ponto final, sem emoji.
- Texto de 1 a 3 frases curtas (até 280 caracteres no total): o que o elemento faz e por que importa. Se ajudar, uma lista de até 4 itens curtos.
- Combine com o tipo do passo: "esperar o clique" termina pedindo o clique ("Clique em **Nova tarefa** para continuar."); "esperar preencher" pede para preencher ou escolher; "o tour clica sozinho" avisa o que vai abrir; "Próximo" só explica.
- Escreva nomes de botões, abas, campos e telas exatamente como no elemento e nas referências, em **negrito**. Nunca invente telas, botões, regras ou números; o que não souber, escreva [confirmar: ...].
- Tom simples e acolhedor, sem jargão. Sem saudação, sem despedida, sem outro markdown além do **negrito**.

Responda apenas com JSON, sem texto em volta:
{"title": "...", "blocks": [{"type": "paragraph", "text": "..."}, {"type": "list", "items": ["..."]}], "notes": "o que conferir (curto; vazio se nada)"}`;

const KIND: Record<string, string> = {
  next: "Botão “Próximo” (o balão só explica)",
  click: "Esperar o clique (só avança quando a pessoa clica no elemento)",
  input: "Esperar preencher (só avança quando a pessoa preenche ou escolhe algo)",
  auto: "O tour clica sozinho (abre o modal, a aba ou o menu)",
};

/** O pedido ao modelo: o passo, os vizinhos e o texto atual. */
export function tourWriterMessage(input: {
  mode: "write" | "improve";
  idea: string;
  tour: string;
  summary: string;
  n: number;
  total: number;
  screen: string;
  element: string;
  context: string;
  kind: string;
  title: string;
  text: string;
  before: string[];
  after: string[];
}) {
  const parts = [
    input.mode === "improve"
      ? "Melhore o balão deste passo: mais claro e mais curto, sem acrescentar informação."
      : "Escreva o balão deste passo.",
    `Onboarding: ${input.tour}${input.summary ? ` — ${input.summary}` : ""}`,
    `Passo ${input.n} de ${input.total}, na tela ${input.screen || "(não informada)"}.`,
    `Elemento destacado: ${input.element || "nenhum (balão no centro da tela)"}${input.context ? ` (em “${input.context}”)` : ""}.`,
    `Como a pessoa avança: ${KIND[input.kind] ?? KIND.next}.`,
  ];
  if (input.before.length) parts.push(`Passos antes: ${input.before.map((t) => `“${t}”`).join(", ")}.`);
  if (input.after.length) parts.push(`Passos depois: ${input.after.map((t) => `“${t}”`).join(", ")}.`);
  if (input.title || input.text)
    parts.push(`Balão atual:\nTítulo: ${input.title || "(sem título)"}\nTexto: ${input.text || "(sem texto)"}`);
  if (input.idea) parts.push(`O que quem escreve pediu: ${input.idea}`);
  return parts.join("\n");
}

export async function handleTourWriter(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 120)).filter(Boolean).slice(-4) : []);
  const input = {
    mode: req.mode === "improve" ? ("improve" as const) : ("write" as const),
    idea: str(req.idea, 600),
    tour: str(req.tour, 160),
    summary: str(req.summary, 600),
    n: Math.max(1, Math.trunc(Number(req.n) || 1)),
    total: Math.max(1, Math.trunc(Number(req.total) || 1)),
    screen: str(req.screen, 80),
    element: str(req.element, 200),
    context: str(req.context, 120),
    kind: str(req.kind, 10),
    title: str(req.title, 120),
    text: str(req.text, 3000),
    before: list(req.before),
    after: Array.isArray(req.after) ? list(req.after.slice(0, 4)) : [],
  };
  if (!input.tour) return fail(400, "Dê um nome ao onboarding primeiro.");

  const rpc = <T>(name: string, args: Row) => callRpc<T>(env, deps.fetch, authorization, name, args);
  let meter: Meter | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const allowed = await rpc<boolean>("tutorial_can_write", { p_company: company });
    if (!allowed.ok) throw new WriterError(allowed.status, allowed.error);
    if (!allowed.data)
      throw new WriterError(403, "Só administradores e gestores, com a MAVI ligada, pedem textos à MAVI.");
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
      throw new WriterError(503, "A MAVI não está configurada no servidor. Escolha um provedor no Painel da MAVI.");

    // As referências: o que os tutoriais publicados dizem da tela e do elemento.
    const query = `${input.screen} ${input.element} ${input.tour}`.trim().slice(0, 300);
    const found = await rpc<{ title: string; section: string; content: string }[]>("search_tutorials", {
      p_company: company,
      p_query: query,
      p_embedding: null,
      p_module: null,
      p_strict: false,
      p_category: null,
      p_tags: null,
      p_limit: 4,
    });
    const refs = found.ok ? (found.data ?? []) : [];
    const context = refs.length
      ? `Referências (trechos de tutoriais já publicados no sistema):\n\n${refs
          .map((h, i) => `[${i + 1}] “${h.title}”${h.section ? ` › ${h.section}` : ""}\n${h.content.slice(0, 1000)}`)
          .join("\n\n")}`
      : "Referências: nenhum tutorial publicado fala desta tela ainda.";

    const llm: LlmAdapter = sampledLlm(
      provider ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config) : deps.llm,
      { db: env, fetch: deps.fetch, auth: authorization, company, feature: "tutorial_writer", client: null, providerId: provider?.id ?? null },
    );
    const result = await llm({
      instructions: TOUR_WRITER_INSTRUCTIONS,
      context,
      messages: [{ role: "user", content: tourWriterMessage(input) }],
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "low",
      maxTokens: 1200,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    meter = result.meter;
    const draft: WriterDraft | null = parseDraft(result.text, 0);
    if (!draft) throw new WriterError(502, "A MAVI não conseguiu escrever agora. Tente de novo.");
    return {
      status: 200,
      body: {
        title: draft.title.slice(0, 120),
        blocks: draft.blocks.filter((b) => b.type === "paragraph" || b.type === "list" || b.type === "steps"),
        notes: draft.notes,
        model: meter?.model || provider?.config.model || env.model,
      },
    };
  } catch (err) {
    if (err instanceof WriterError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await rpc("ai_log_usage", {
        p_company: company,
        p_module: "tutorials",
        p_kind: "tour_writer",
        p_client: null,
        p_contract: null,
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

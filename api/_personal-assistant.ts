import { callRpc } from "./_drive.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import { routedLlm } from "./_ai-router.js";
import { buildContext, type AiDeps, type AiEnv } from "./_ai.js";
import { TOOLS, runTool, type AiSource, type ToolContext } from "./_ai-tools.js";
import { adsTurn, ADS_RULES } from "./_ai-ads.js";
import { embeddingCost } from "./_ai-embeddings.js";
import { appOrigin } from "./_origin.js";
import type { ToolOutput } from "./_ai-llm.js";
import { inKnowledge, knowledgeBlock, knowledgeQuery, type AgentKnowledge } from "./_agent-knowledge.js";

/**
 * Radar pessoal · Fase 2: a resposta que a MAVI Assistente Pessoal daria a
 * uma situação (ação "personal-radar-draft" de /api/ai, funcionalidade
 * 'personal_assistant'; migration 20270306090000_personal_radar_replies).
 *
 * Roda com o login da pessoa: o banco confere que o item é dela, reserva a
 * resposta e manda o material (o item, as falas, a conversa do grupo, o tom e
 * os retornos dela, e o que dá para linkar do cliente). A MAVI lê o cliente
 * com as mesmas ferramentas da conversa (Drive, gravações, tarefas, Radar,
 * termômetro, mídia e as campanhas ao vivo) — sempre só o que a pessoa vê — e
 * devolve o texto para colar no WhatsApp, as evidências, os links que criaria
 * e o que conferir. Nada sai para o grupo nem é criado aqui.
 *
 * Sem item, escreve a próxima resposta da fila da pessoa (a tela pede uma por
 * vez enquanto houver).
 *
 * Migration 20270512090000: os exemplos de tom são as respostas da pessoa
 * mais parecidas com a situação (tipo, cliente, produto), as aprovadas de
 * colegas no mesmo produto entram como referência de conteúdo, as lições do
 * produto valem junto com as da pessoa, e a base do Agente Conversacional do
 * cliente (o prompt do robô) é fonte quando a situação é sobre o que o robô
 * sabe ou faz.
 *
 * Migration 20270513090000: junto com a resposta, a MAVI decide se a situação
 * pede uma tarefa operacional que a resposta não resolve e, só então, sugere
 * a tarefa para uma pessoa ou equipe que atende o cliente. A pessoa cria pelo
 * formulário de tarefa (sempre revisando) ou dispensa; as lições do tipo
 * 'task' ensinam quando sugerir.
 */

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AssistantError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ material
export type TaskContext = {
  teams: { id: string; name: string; members: string[] }[];
  people: { id: string; name: string; teams?: string[] | null; about?: string; me?: boolean }[];
  contracts: { id: string; product: string; product_id: string }[];
  product_id?: string | null;
  open_tasks: { title: string; status: string; assignee?: string; due?: string }[];
};
type Line = { role: "client" | "team"; who: string; text: string; at: string };
type Cycle = { start: string; end: string; objective: string };
export type DraftMaterial = {
  status: "claimed";
  item: {
    id: string;
    kind: string;
    title: string;
    summary: string;
    urgency: number;
    asks: number;
    client_id: string;
    client_name: string;
    group: string;
    first_at: string;
    task?: { id: string; title: string; status: string } | null;
    radar?: { id: string; title: string } | null;
    reason?: string | null;
  };
  quotes: Line[];
  conversation: Line[];
  person: { name: string; about: string; teams: string[] };
  style: string[];
  feedback: { action: string; note?: string; reason?: string; title?: string; draft?: string; final?: string }[];
  guidance: string;
  previous?: string | null;
  /** As lições em uso (da pessoa, do cliente, do produto e da equipe): de resposta e de tarefa. */
  lessons?: { scope: "person" | "team" | "client" | "product"; kind?: "reply" | "task"; text: string }[];
  /** Quem atende o cliente, os produtos e as tarefas abertas (para sugerir uma tarefa). */
  task_context?: TaskContext | null;
  /** O produto da situação (nulo: geral). */
  product?: string | null;
  /** Respostas aprovadas de colegas no mesmo produto (conteúdo, não tom). */
  team_examples?: string[];
  /** A base do Agente Conversacional do cliente (o prompt do robô). */
  knowledge?: AgentKnowledge[];
  shareables: {
    recordings: { id: string; title?: string; at: string; token?: string }[];
    files: { id: string; name: string; type: string; folder?: string; at: string; token?: string; can_share?: boolean }[];
    campaigns: {
      id: string;
      name: string;
      platform: string;
      status: string;
      cycle?: Cycle | null;
      previous?: Cycle | null;
      reports?: { id: string; title: string; start: string; end: string; token: string }[] | null;
    }[];
  };
};

const KIND: Record<string, string> = {
  question: "dúvida",
  request: "solicitação",
  complaint: "reclamação",
  material: "material enviado",
  approval: "aprovação ou reprovação",
  deadline: "cobrança de prazo",
};
const ROLE = { client: "cliente", team: "time" } as const;
const REASON: Record<string, string> = {
  wrong_info: "informação errada",
  wrong_tone: "tom errado",
  incomplete: "incompleta",
  should_not_reply: "não deveria responder",
  other: "outro motivo",
};
const dateBr = (d: string) => (DAY.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d);

export const ASSISTANT_INSTRUCTIONS = `Você é a MAVI Assistente Pessoal, a assistente de uma pessoa do time de uma agência de marketing. Seu nome é MAVI, no feminino. Um cliente pediu, perguntou, reclamou ou mandou algo no grupo de WhatsApp, e é com essa pessoa. Você prepara a resposta que ela mandaria — ela revisa, copia e envia. Você nunca escreve no grupo.

Como trabalhar:
1. Entenda o que o cliente quer pelas falas e pela conversa do grupo.
2. Busque o que responde de verdade, com as ferramentas (só o que a pessoa vê): client_overview para o quadro do cliente; search_knowledge para reuniões, arquivos, tarefas, campanhas, anotações e o próprio WhatsApp; list_tasks e list_meetings para o que está em andamento; campaign_results e as ferramentas das contas de anúncio para números de campanha (com o período certo). Faça poucas buscas, certeiras.
3. Escreva a resposta e devolva o JSON.

A resposta ("reply"):
- Português do Brasil, no tom de WhatsApp da pessoa (siga os exemplos dela quando houver), curta, educada e objetiva. Chame o cliente pelo nome quando souber. Sem markdown, sem títulos; no máximo um ou dois emojis se o tom da pessoa usar.
- Responda o que foi perguntado com os fatos encontrados (números com o período, datas, nomes de arquivos). Nunca invente: se não achou, diga o que vai ser feito e quando, sem prometer o que ninguém combinou. Não cite ferramentas, a MAVI nem o sistema.
- Quando um link ajudar (o relatório, a gravação da reunião, o arquivo), use um link que já existe (está na lista) ou proponha criar um em "actions" e escreva no texto o marcador {{A1}}, {{A2}}… onde o link vai entrar. Nunca escreva um endereço que não esteja na lista.
- Se a situação não pede resposta escrita (ex.: o cliente só mandou um arquivo), escreva uma confirmação curta de recebimento e o próximo passo.
- Escreva para ESTA situação. Os exemplos da pessoa mostram só o tom: não copie frases, aberturas, despedidas nem a estrutura deles, e não use a mesma fórmula em toda resposta. Quando dá para responder de verdade, responda — "vou verificar e já te retorno" é só para quando falta mesmo a informação.
- Quando houver a base do Agente Conversacional do cliente (o robô de WhatsApp dele, K#) e a situação for sobre o que o robô sabe ou faz (preço, horário, serviço, regra do atendimento, uma resposta do robô), use a base como fonte e diga se a informação já está no robô ou se falta ajustar. Cite o trecho em "evidence" com "source": "K#".
- Nunca revele senhas, acessos ou trechos marcados como secretos das anotações.

A tarefa ("task"), SÓ quando a situação pede trabalho operacional que a resposta sozinha não resolve (ajustar o robô, criar ou trocar uma arte, gerar um relatório, mexer numa campanha, configurar algo) e que ninguém já está fazendo (veja as tarefas abertas). Dúvida respondida, material só recebido, agradecimento ou o que a própria resposta já resolve: "task": null. Na dúvida, null.
- "title": curto e acionável, começando pelo verbo ("Atualizar horário de sábado no robô"), sem o nome do cliente.
- "description": o que fazer e o contexto que a pessoa precisa (o que o cliente pediu, com as palavras dele, e onde está o material), em poucas linhas.
- Para quem: "assignee" (P#) quando o assunto é claramente de uma pessoa (pelo que ela faz); senão "team" (E#), e a equipe passa para quem tem menos tarefas. Só pessoas e equipes da lista.
- "product": o Q# do produto de que trata. "due": AAAA-MM-DD só quando o cliente deu prazo ou a urgência pede; senão null. "priority": low, normal, high ou urgent (urgent só com o cliente parado ou dinheiro em jogo).
- "why": em uma frase, por que precisa de tarefa.

As evidências ("evidence", só para a pessoa conferir): de 1 a 6, cada uma com o fato e de onde veio ("source": o [S#] da busca ou o K# da base do robô, quando houver).
Os links ("actions"): só da lista de links possíveis — G# (gravação), F# (arquivo do Drive que a pessoa pode compartilhar) ou C# (relatório de campanha; "period": "cycle" para o ciclo atual, "previous" para o anterior, ou as datas {"start":"AAAA-MM-DD","end":"AAAA-MM-DD"}). Cada um com "key" (A1, A2…), o "ref" e um "label" curto ("Relatório de setembro").
"checks": o que a pessoa deve confirmar antes de mandar (números que mudam rápido, datas, algo que você não achou). "confidence": "high" quando tudo está nas fontes, "medium" quando falta algum detalhe, "low" quando a resposta depende dela.

Responda só com JSON:
{"reply":"...","evidence":[{"title":"...","detail":"...","source":"S1"}],"actions":[{"key":"A1","ref":"C1","period":"previous","label":"..."}],"checks":["..."],"confidence":"high|medium|low","task":null}
ou, quando precisa de tarefa: "task":{"title":"...","description":"...","assignee":"P1"|null,"team":"E1"|null,"product":"Q1"|null,"due":null,"priority":"normal","why":"..."}`;

/** O pedido para o modelo, com as referências dos links possíveis (G#, F#, C#). */
export function draftMessage(m: DraftMaterial, origin: string) {
  const recordings = new Map<string, DraftMaterial["shareables"]["recordings"][number]>();
  const files = new Map<string, DraftMaterial["shareables"]["files"][number]>();
  const campaigns = new Map<string, DraftMaterial["shareables"]["campaigns"][number]>();
  const i = m.item;
  const out: string[] = [
    `Pessoa: ${m.person.name}${m.person.teams.length ? ` (equipes: ${m.person.teams.join(", ")})` : ""}${m.person.about ? ` — o que é com ela: ${m.person.about}` : ""}.`,
    `Cliente: ${i.client_name} · grupo "${i.group}"${m.product ? ` · produto ${m.product}` : ""}.`,
    "",
    `Situação (${KIND[i.kind] ?? i.kind}${i.urgency >= 2 ? ", urgente" : ""}${i.asks > 1 ? `, o cliente cobrou ${i.asks}x` : ""}, desde ${i.first_at}): ${i.title}${i.summary ? ` — ${i.summary}` : ""}`,
    i.reason ? `Por que é com ela: ${i.reason}.` : "",
    i.task ? `Tarefa aberta sobre isso: "${i.task.title}" (${i.task.status}).` : "",
    i.radar ? `No Radar do cliente: "${i.radar.title}".` : "",
    "",
    "Falas do item:",
    ...m.quotes.map((q) => `${q.at} [${ROLE[q.role]}] ${q.who}: ${q.text}`),
    "",
    "Conversa do grupo (mais recente no fim):",
    ...m.conversation.map((q) => `${q.at} [${ROLE[q.role]}] ${q.who}: ${q.text}`),
  ];
  const sh = m.shareables;
  const links: string[] = [];
  sh.recordings.forEach((r, n) => {
    const ref = `G${n + 1}`;
    recordings.set(ref, r);
    links.push(
      `- ${ref} gravação "${r.title || "Reunião"}" de ${r.at}${r.token ? ` — já tem link: ${origin}/gravacao/${r.token}` : " — dá para criar o link"}`,
    );
  });
  sh.files.forEach((f, n) => {
    const ref = `F${n + 1}`;
    files.set(ref, f);
    links.push(
      `- ${ref} arquivo "${f.name}"${f.folder ? ` (pasta ${f.folder})` : ""} de ${f.at}${f.token ? ` — já tem link: ${origin}/arquivo/${f.token}` : f.can_share ? " — dá para criar o link" : " — sem link (a pessoa não pode compartilhar)"}`,
    );
  });
  sh.campaigns.forEach((c, n) => {
    const ref = `C${n + 1}`;
    campaigns.set(ref, c);
    const cycle = (y?: Cycle | null) => (y ? `${dateBr(y.start)} a ${dateBr(y.end)}` : "");
    links.push(
      `- ${ref} campanha "${c.name}" (${c.platform}, ${c.status === "active" ? "ativa" : "inativa"})${c.cycle ? ` · ciclo atual ${cycle(c.cycle)}` : ""}${c.previous ? ` · anterior ${cycle(c.previous)}` : ""} — dá para criar o link do relatório${(c.reports ?? []).length ? `; relatórios com link: ${(c.reports ?? []).map((r) => `"${r.title}" (${dateBr(r.start)} a ${dateBr(r.end)}) ${origin}/relatorio/${r.token}`).join("; ")}` : ""}`,
    );
  });
  out.push("", "Links possíveis:", ...(links.length ? links : ["(nenhum)"]));
  if (m.style.length)
    out.push(
      "",
      "Como a pessoa escreve (respostas que ela mandou; só o tom — não copie frases nem a estrutura):",
      ...m.style.map((s) => `- "${s}"`),
    );
  if (m.team_examples?.length)
    out.push(
      "",
      `Respostas aprovadas de colegas em situações do produto ${m.product ?? ""} (referência do que costuma ser respondido, não do tom):`,
      ...m.team_examples.map((s) => `- "${s}"`),
    );
  const kb = m.knowledge?.length ? knowledgeBlock(m.knowledge) : null;
  if (kb)
    out.push(
      "",
      "Base do Agente Conversacional do cliente (o prompt do robô de WhatsApp dele; K#):",
      kb.text,
    );
  const fb = m.feedback.filter((f) => f.note || f.final || f.reason);
  if (fb.length)
    out.push(
      "",
      "O que a pessoa já ensinou (siga):",
      ...fb.map((f) =>
        f.action === "training"
          ? `- Instrução: ${f.note}`
          : f.action === "rejected"
            ? `- Reprovou uma resposta (${REASON[f.reason ?? ""] ?? "sem motivo"})${f.note ? `: ${f.note}` : ""}${f.title ? ` — situação "${f.title}"` : ""}`
            : `- Editou antes de mandar${f.title ? ` ("${f.title}")` : ""}: de "${f.draft ?? ""}" para "${f.final ?? ""}"`,
      ),
    );
  const scopeLabel = (l: NonNullable<DraftMaterial["lessons"]>[number]) =>
    l.scope === "person" ? "Da pessoa" : l.scope === "client" ? "Do cliente" : l.scope === "product" ? "Do produto" : "Da equipe";
  const taskLessons = (m.lessons ?? []).filter((l) => l.kind === "task");
  const replyLessons = (m.lessons ?? []).filter((l) => l.kind !== "task");
  const people = new Map<string, string>();
  const teams = new Map<string, string>();
  const contracts = new Map<string, string>();
  const tc = m.task_context;
  if (tc && (tc.people?.length || tc.teams?.length)) {
    out.push("", "Para uma tarefa, se precisar — pessoas que atendem o cliente (P#):");
    (tc.people ?? []).forEach((p, n) => {
      people.set(`P${n + 1}`, p.id);
      out.push(
        `- P${n + 1} ${p.name}${p.me ? " (a própria pessoa)" : ""}${p.teams?.length ? ` · equipes: ${p.teams.join(", ")}` : ""}${p.about ? ` · o que é com ela: ${p.about}` : ""}`,
      );
    });
    out.push("Equipes (E#):");
    (tc.teams ?? []).forEach((t, n) => {
      teams.set(`E${n + 1}`, t.id);
      out.push(`- E${n + 1} ${t.name}${t.members.length ? ` (${t.members.join(", ")})` : ""}`);
    });
    out.push("Produtos do cliente (Q#):");
    (tc.contracts ?? []).forEach((k, n) => {
      contracts.set(`Q${n + 1}`, k.id);
      out.push(`- Q${n + 1} ${k.product}${tc.product_id && k.product_id === tc.product_id ? " (o da situação)" : ""}`);
    });
    out.push(
      "Tarefas abertas do cliente:",
      ...(tc.open_tasks?.length
        ? tc.open_tasks.map((t) => `- ${t.title} (${t.status}${t.assignee ? `, com ${t.assignee}` : ""}${t.due ? `, prazo ${t.due}` : ""})`)
        : ["(nenhuma)"]),
    );
  }
  if (taskLessons.length)
    out.push("", "Quando sugerir tarefa (o que você aprendeu; siga):", ...taskLessons.map((l) => `- ${scopeLabel(l)}: ${l.text}`));
  if (replyLessons.length)
    out.push(
      "",
      "O que você aprendeu (siga; a da pessoa vale mais que a do cliente, que vale mais que a do produto, que vale mais que a da equipe):",
      ...replyLessons.map(
        (l) =>
          `- ${scopeLabel(l)}: ${l.text}`,
      ),
    );
  if (m.previous) out.push("", `A versão anterior desta resposta (melhore):\n"${m.previous}"`);
  if (m.guidance) out.push("", `Pedido da pessoa para esta versão: ${m.guidance}`);
  out.push("", "Prepare a resposta.");
  return {
    text: out.filter((l, n, a) => !(l === "" && a[n - 1] === "")).join("\n"),
    refs: {
      recordings,
      files,
      campaigns,
      knowledge: kb?.refs ?? new Map<string, AgentKnowledge>(),
      people,
      teams,
      contracts,
    },
  };
}

export type DraftEvidence = { title: string; detail: string; source?: AiSource };
export type DraftAction =
  | { key: string; kind: "recording"; id: string; label: string }
  | { key: string; kind: "file"; id: string; label: string }
  | {
      key: string;
      kind: "report";
      id: string;
      label: string;
      platform: string;
      start: string;
      end: string;
      objective: string | null;
    };
/** A tarefa sugerida (o banco confere de novo quem e qual produto). */
export type DraftTask = {
  title: string;
  description?: string;
  assignee_id?: string;
  team_id?: string;
  contract_id?: string;
  due?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  why?: string;
};
export type Draft = {
  reply: string;
  evidence: DraftEvidence[];
  actions: DraftAction[];
  checks: string[];
  confidence: "high" | "medium" | "low" | null;
  task: DraftTask | null;
};

/** A tarefa do modelo, com as referências trocadas pelos ids (sem título, nada). */
export function parseTask(raw: unknown, refs: Pick<ReturnType<typeof draftMessage>["refs"], "people" | "teams" | "contracts">) {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Row;
  const title = clean(t.title, 200);
  if (title.length < 3) return null;
  const ref = (v: unknown) => clean(v, 8).replace(/[[\]]/g, "").toUpperCase();
  const assignee = refs.people?.get(ref(t.assignee));
  const team = assignee ? undefined : refs.teams?.get(ref(t.team));
  const contract = refs.contracts?.get(ref(t.product));
  const due = typeof t.due === "string" && DAY.test(t.due) ? t.due : undefined;
  const priority = ["low", "normal", "high", "urgent"].includes(String(t.priority))
    ? (t.priority as DraftTask["priority"])
    : undefined;
  const description = clean(t.description, 4000);
  const why = clean(t.why, 300);
  return {
    title,
    ...(description ? { description } : {}),
    ...(assignee ? { assignee_id: assignee } : {}),
    ...(team ? { team_id: team } : {}),
    ...(contract ? { contract_id: contract } : {}),
    ...(due ? { due } : {}),
    ...(priority ? { priority } : {}),
    ...(why ? { why } : {}),
  } satisfies DraftTask;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * A resposta do modelo, conferida: os links só da lista (o marcador de um
 * link que não passou sai do texto), as fontes trocadas pelo que a busca
 * achou.
 */
export function parseDraft(
  text: string,
  refs: ReturnType<typeof draftMessage>["refs"],
  sources: AiSource[],
): Draft {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AssistantError(502, "A MAVI não devolveu a resposta.");
  let o: Row;
  try {
    o = JSON.parse(text.slice(start, end + 1)) as Row;
  } catch {
    throw new AssistantError(502, "A MAVI devolveu um JSON inválido.");
  }
  let reply = clean(o.reply, 6000);
  if (!reply) throw new AssistantError(502, "A MAVI devolveu a resposta vazia.");
  const actions: DraftAction[] = [];
  const checks = (Array.isArray(o.checks) ? o.checks : [])
    .map((c) => clean(c, 300))
    .filter(Boolean)
    .slice(0, 6);
  for (const raw of (Array.isArray(o.actions) ? o.actions : []).slice(0, 6)) {
    const a = (raw ?? {}) as Row;
    const key = clean(a.key, 8).toUpperCase();
    const ref = clean(a.ref, 8).toUpperCase();
    const label = clean(a.label, 120);
    if (!/^A\d{1,2}$/.test(key) || actions.some((x) => x.key === key)) continue;
    const rec = refs.recordings.get(ref);
    const file = refs.files.get(ref);
    const camp = refs.campaigns.get(ref);
    if (rec && !rec.token) actions.push({ key, kind: "recording", id: rec.id, label: label || `Gravação ${rec.title ?? ""}`.trim() });
    else if (file && !file.token && file.can_share)
      actions.push({ key, kind: "file", id: file.id, label: label || file.name });
    else if (camp) {
      const p = a.period;
      const range =
        p === "previous"
          ? camp.previous
          : p && typeof p === "object" && DAY.test(String((p as Row).start)) && DAY.test(String((p as Row).end)) &&
              String((p as Row).start) <= String((p as Row).end)
            ? { start: String((p as Row).start), end: String((p as Row).end), objective: camp.cycle?.objective ?? "" }
            : camp.cycle;
      if (range)
        actions.push({
          key,
          kind: "report",
          id: camp.id,
          label: label || `Relatório ${camp.name}`,
          platform: camp.platform,
          start: range.start,
          end: range.end,
          objective: range.objective || null,
        });
    }
  }
  // O marcador sem link preparado sai do texto (e a pessoa fica sabendo).
  const keys = new Set(actions.map((a) => a.key));
  const orphan = [...reply.matchAll(/\{\{(A\d{1,2})\}\}/g)].map((x) => x[1]).filter((k) => !keys.has(k));
  if (orphan.length) {
    for (const k of orphan) reply = reply.replaceAll(`{{${k}}}`, "").replace(/[ \t]{2,}/g, " ");
    checks.push("A MAVI quis colocar um link que não está disponível: confira se falta algum.");
  }
  const evidence = (Array.isArray(o.evidence) ? o.evidence : []).slice(0, 6).flatMap((raw) => {
    const e = (raw ?? {}) as Row;
    const title = clean(e.title, 160);
    const detail = clean(e.detail, 500);
    if (!title && !detail) return [];
    const ref = clean(e.source, 8).replace(/[[\]]/g, "").toUpperCase();
    const source = sources.find((s) => s.ref === ref);
    // Da base do robô: diz de onde veio (sem link de busca).
    const k = refs.knowledge?.get(ref);
    if (k)
      return [
        {
          title: title || detail.slice(0, 80),
          detail: `${detail}${detail ? " " : ""}(Agente Conversacional: ${k.workflow} › ${k.node}${inKnowledge(k, detail) ? "" : ", confira o trecho"})`,
        },
      ];
    return [{ title: title || detail.slice(0, 80), detail, ...(source ? { source } : {}) }];
  });
  const confidence = ["high", "medium", "low"].includes(String(o.confidence))
    ? (o.confidence as Draft["confidence"])
    : null;
  return {
    reply: reply.trim(),
    evidence,
    actions,
    checks: checks.slice(0, 6),
    confidence,
    task: parseTask(o.task, refs),
  };
}

// ------------------------------------------------------------ servidor
const READ_TOOLS = new Set([
  "client_overview",
  "search_knowledge",
  "read_more",
  "list_meetings",
  "list_tasks",
  "campaign_results",
  "client_radar",
  "client_temperature",
  "media_account",
]);

async function rpc<T>(env: AiEnv, deps: AiDeps, auth: string, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, auth, name, args);
  if (!r.ok) throw new AssistantError(r.status, r.error);
  return r.data;
}

/** Escreve a resposta de um item (ou da próxima da fila) e devolve o item. */
export async function writeDraft(
  body: Row,
  auth: string,
  env: AiEnv & { origin?: string },
  deps: AiDeps,
): Promise<Row> {
  const company = String(body.company ?? "");
  if (!UUID.test(company)) throw new AssistantError(400, "Empresa inválida.");
  let item = typeof body.item === "string" && UUID.test(body.item) ? body.item : null;
  if (!item) {
    item = await rpc<string | null>(env, deps, auth, "personal_radar_draft_next", { p_company: company });
    if (!item) return { status: "none" };
  }
  const guidance = typeof body.guidance === "string" ? body.guidance.slice(0, 2000) : null;
  const started = await rpc<DraftMaterial | { status: "running" | "done" }>(
    env,
    deps,
    auth,
    "personal_radar_draft_start",
    { p_company: company, p_item: item, p_force: body.force === true, p_guidance: guidance },
  );
  if (started.status !== "claimed") return { status: started.status, item };
  const m = started as DraftMaterial;
  const fail = (message: string) =>
    callRpc(env, deps.fetch, auth, "personal_radar_draft_fail", {
      p_company: company,
      p_item: item,
      p_error: message,
    }).catch(() => {});
  try {
    const client = m.item.client_id;
    const limits = await rpc<{ blocked: boolean; message: string | null }>(env, deps, auth, "ai_check_limits", {
      p_company: company,
      p_client: client,
      p_contract: null,
      p_project: null,
    });
    if (limits?.blocked) throw new AssistantError(429, limits.message ?? "O limite de gasto da MAVI foi atingido.");
    const now = (deps.now ?? Date.now)();
    // Os exemplos mais parecidos com a situação (sem a migração 20270512, o tom
    // fica com as últimas aprovadas que o banco mandou).
    const examples = await rpc<{ product: string | null; product_id: string | null; mine: string[]; team: string[] }>(
      env,
      deps,
      auth,
      "personal_radar_reply_examples",
      { p_company: company, p_item: item },
    ).catch(() => null);
    if (examples) {
      if (Array.isArray(examples.mine) && examples.mine.length) m.style = examples.mine;
      m.team_examples = Array.isArray(examples.team) ? examples.team : [];
      m.product = examples.product;
    }
    // As lições de resposta (sem a migração 20270307, nenhuma), com as do produto.
    m.lessons = await rpc<NonNullable<DraftMaterial["lessons"]>>(env, deps, auth, "personal_radar_reply_lessons", {
      p_company: company,
      p_client: client,
      ...(examples?.product_id ? { p_product: examples.product_id } : {}),
    }).catch(() => []);
    // Quem atende o cliente, para a tarefa sugerida (sem a migração 20270513, nenhuma).
    m.task_context = await rpc<TaskContext>(env, deps, auth, "personal_radar_task_context", {
      p_company: company,
      p_item: item,
    })
      .then((x) => (x && Array.isArray(x.people) && Array.isArray(x.teams) ? x : null))
      .catch(() => null);
    // A base do robô do cliente (só quem tem Agente Conversacional).
    m.knowledge = await rpc<AgentKnowledge[]>(env, deps, auth, "agent_knowledge", {
      p_company: company,
      p_client: client,
      p_query: knowledgeQuery([
        { kind: m.item.kind, title: m.item.title, summary: m.item.summary, quotes: m.quotes.map((q) => q.text) },
      ]),
      p_chars: 16000,
    })
      .then((k) => (Array.isArray(k) ? k : []))
      .catch(() => []);
    const [base, provider] = await Promise.all([
      buildContext(env, deps, auth, company, { client, module: "personal_radar" }, now),
      featureProvider(env, deps.fetch, auth, company, "personal_assistant", { client }),
    ]);
    const baseLlm = provider ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config) : deps.llm;
    const ctx: ToolContext = {
      supabaseUrl: env.supabaseUrl,
      supabaseKey: env.supabaseKey,
      fetch: deps.fetch,
      auth,
      company,
      scope: { client, module: "personal_radar" },
      embed: deps.embed,
      members: base.members,
      clients: base.clients,
      today: base.today,
      usage: { embeddingTokens: 0, embeddingModel: env.embeddingModel },
      sources: [],
      chunks: new Map(),
    };
    // As contas de anúncio ao vivo, para quem usa Campanhas.
    const ads = base.campaigns
      ? await adsTurn({ supabaseUrl: env.supabaseUrl, supabaseKey: env.supabaseKey }, deps.fetch, auth, company, {
          client,
        }).catch(() => null)
      : null;
    const tools = [...TOOLS.filter((t) => READ_TOOLS.has(t.name)), ...(ads?.tools ?? [])];
    const allowed = new Set(tools.map((t) => t.name));
    const execute = async (name: string, input: unknown): Promise<ToolOutput> => {
      if (!allowed.has(name)) return `Ferramenta indisponível: ${name}.`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = ads?.has(name) ? ads.run(name, input) : runTool(ctx, name, input);
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error("A ferramenta demorou demais.")), ads?.has(name) ? 90_000 : 45_000);
          }),
        ]);
      } catch (e) {
        return `Erro: ${(e as Error).message}`;
      } finally {
        clearTimeout(timer);
      }
    };
    const origin = env.origin ?? appOrigin();
    const { text, refs } = draftMessage(m, origin);
    const llm = routedLlm(baseLlm, {
      env,
      fetch: deps.fetch,
      auth,
      where: { company, surface: "personal_radar", feature: "personal_assistant", client },
      used: { providerId: provider?.id ?? null, model: provider?.config.model || env.model, scope: provider?.scope },
      question: text,
      hasServerKey: !!env.anthropicKey,
    });
    let result;
    try {
      result = await llm({
        instructions: ASSISTANT_INSTRUCTIONS + (ads ? ADS_RULES : ""),
        context: base.context + (ads?.context ?? ""),
        messages: [{ role: "user", content: text }],
        tools,
        execute,
        maxRounds: 6,
        effort: "medium",
        maxTokens: 4000,
      });
    } finally {
      await ads?.close().catch(() => {});
    }
    const draft = parseDraft(result.text, refs, ctx.sources);
    // Sem produto na tarefa: o da situação ou o único do cliente.
    const tc = m.task_context;
    if (draft.task && !draft.task.contract_id && tc?.contracts?.length) {
      const k = tc.contracts.find((c) => c.product_id === tc.product_id) ?? (tc.contracts.length === 1 ? tc.contracts[0] : null);
      if (k) draft.task.contract_id = k.id;
    }
    const embedding = ctx.usage.embeddingTokens;
    const cost =
      result.meter.cost + (embedding ? embeddingCost(ctx.usage.embeddingModel, embedding) : 0);
    return await rpc<Row>(env, deps, auth, "personal_radar_draft_store", {
      p_company: company,
      p_item: item,
      p_draft: { ...draft, model: result.meter.model || provider?.config.model || env.model },
      p_usage: {
        model: result.meter.model || provider?.config.model || env.model,
        input: result.meter.input,
        output: result.meter.output,
        cache_read: result.meter.cacheRead,
        cache_write: result.meter.cacheWrite,
        embedding,
        cost: Math.round(cost * 1e6) / 1e6,
        ...(provider ? { provider_id: provider.id, provider: provider.config.name } : {}),
      },
    });
  } catch (e) {
    await fail((e as Error).message);
    throw e;
  }
}

/** "personal-radar-draft": com o login da pessoa. */
export async function handlePersonalDraft(
  body: unknown,
  authorization: string | null,
  env: AiEnv & { origin?: string },
  deps: AiDeps,
): Promise<{ status: number; body: Row }> {
  if (!authorization?.startsWith("Bearer ")) return { status: 401, body: { error: "Autenticação necessária." } };
  try {
    return { status: 200, body: await writeDraft((body ?? {}) as Row, authorization, env, deps) };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return {
      status: typeof e.status === "number" && e.status >= 400 ? e.status : 500,
      body: { error: e.message ?? "A MAVI não conseguiu escrever a resposta." },
    };
  }
}

import { callRpc } from "./_drive.js";
import { adapterFor, routeConfig, type ResolvedRoute } from "./_ai-providers.js";
import { workerAuthorized } from "./_copilot.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { LlmAdapter } from "./_ai-llm.js";

/**
 * Radar pessoal · o worker (ação "ai-personal-radar" de /api/ai, só o pg_cron
 * com o segredo; migration 20270304090000_personal_radar).
 *
 * Para cada grupo com mensagem nova e alguém que usa o Radar pessoal nele:
 * 1. O banco monta o material: as mensagens novas numeradas (cliente ou time,
 *    quem foi citado, a quem a mensagem responde, as que já estão num item),
 *    um pouco da conversa antes, as pessoas lidas (equipes, "O que é comigo",
 *    o que já disseram que não era com elas), os itens do grupo, as tarefas
 *    abertas e o Radar do cliente.
 * 2. O modelo da funcionalidade 'personal_radar' tira as situações (dúvida,
 *    solicitação, reclamação, material, aprovação, cobrança de prazo), junta
 *    a repetição no item que já existe, escolhe o dono e marca o que o time
 *    resolveu no grupo.
 * 3. Aqui as referências viram ids, os trechos são conferidos na fala e quem
 *    foi citado ou respondido entra como dono pelo motivo certo, mesmo que o
 *    modelo esqueça.
 * 4. O banco confere tudo de novo e grava itens, donos, falas, resolução e o
 *    custo (dividido entre as pessoas lidas).
 */

type Row = Record<string, unknown>;

export class PersonalRadarError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ material
export type PersonalKind =
  | "question"
  | "request"
  | "complaint"
  | "material"
  | "approval"
  | "deadline";
export const KINDS: PersonalKind[] = [
  "question",
  "request",
  "complaint",
  "material",
  "approval",
  "deadline",
];
export type PersonalLine = {
  msg: string;
  role: "client" | "team";
  who: string;
  text: string;
  at: string;
  /** As pessoas lidas que a mensagem cita (@). */
  to?: string[];
  /** A pessoa a quem a mensagem responde (a citada). */
  reply_to?: string;
  reply_text?: string;
  /** O item em que a mensagem já está. */
  item?: string;
};
export type PersonalPerson = {
  id: string;
  name: string;
  teams: string[];
  about?: string;
  not_mine?: string[];
};
export type PersonalItem = {
  id: string;
  kind: PersonalKind;
  title: string;
  summary: string;
  status: "open" | "resolved";
  asks: number;
  last: string;
  owners: string[];
};
export type PersonalMaterial = {
  group_id: string;
  company_id: string;
  client_id: string;
  client_name: string;
  group: string;
  products: string[];
  people: PersonalPerson[];
  lines: PersonalLine[];
  context: { role: "client" | "team"; who: string; text: string; at: string }[];
  items: PersonalItem[];
  tasks: { id: string; title: string; status: string; assignee?: string; due?: string }[];
  radar: { id: string; title: string; topic: string }[];
  until_at: string;
  until_id: string;
  more: boolean;
};

const ROLE: Record<string, string> = { client: "cliente", team: "time" };
const KIND_LABEL: Record<PersonalKind, string> = {
  question: "dúvida",
  request: "solicitação",
  complaint: "reclamação",
  material: "material enviado",
  approval: "aprovação ou reprovação",
  deadline: "cobrança de prazo",
};

export const PERSONAL_RADAR_INSTRUCTIONS = `Você é a MAVI Assistente Pessoal da agência. Lê as mensagens novas do grupo de WhatsApp de um cliente e lista as situações que alguém do time precisa resolver, para a pessoa certa. Você só lê: nunca escreve no grupo.

O que é uma situação (o "kind"):
- question: o cliente pergunta algo ao time.
- request: o cliente pede que o time faça algo (ajuste, envio, relatório, alteração, reunião).
- complaint: o cliente reclama, mostra insatisfação ou aponta um erro.
- material: o cliente manda arquivo, acesso, informação ou conteúdo que o time precisa usar ou confirmar que recebeu.
- approval: o cliente aprova ou reprova algo do time (arte, texto, campanha, orçamento).
- deadline: o cliente cobra prazo ou entrega.

O que NÃO é situação: cumprimentos, agradecimentos, "ok", "👍", figurinhas, conversa só entre pessoas do time, avisos que não pedem nada, e o que o time já respondeu por completo nas próprias mensagens que você está lendo.

Regras:
1. Um item por assunto. Se o assunto já está na lista de itens (I#), use "item":"I#" em vez de criar outro — inclusive quando o cliente cobra de novo ou volta ao assunto depois de resolvido. Nunca crie dois itens do mesmo assunto. Mensagens marcadas "(já em I#)" já pertencem àquele item: só repita esse I# se for incluir alguém como dono.
2. Cada item cita as mensagens do cliente que o mostram ("lines": L# e um trecho exato).
3. Donos (P#): quem foi citado (→ cita P#) ou a quem o cliente respondeu (responde a P#) é dono com "reason":"mention" ou "reply". Sem isso, escolha pelo assunto e pelo que a pessoa faz (equipes e "O que é comigo"), com "reason":"role". Mais de um dono só quando o assunto é claramente dos dois. Se ninguém se encaixa, escolha quem mais se aproxima com "reason":"general". Evite dar a alguém o que se parece com o que ela já disse que não era com ela. "why": o motivo em poucas palavras, falando com a pessoa ("Te marcaram", "Assunto de campanha", "Você cuida das artes").
4. Resolvido: quando uma mensagem do [time] depois da última do cliente responde ou resolve de verdade um item aberto (da lista I#), coloque em "resolved" com o L# dessa mensagem. Promessa ("vou ver", "já te falo") não resolve.
5. urgency: 3 urgente (cliente irritado, prazo hoje, campanha parada, dinheiro em jogo), 2 alta (reclamação ou cobrou mais de uma vez), 1 normal, 0 baixa.
6. title: curto e objetivo (até 80 caracteres), sem o nome do cliente. summary: 1 ou 2 frases com o que o cliente quer e o contexto necessário para responder.
7. "task": a tarefa aberta (T#) que já cuida disso, se houver. "radar": o item do Radar do cliente (R#) do mesmo assunto, se houver.
8. Não invente: tudo sai das mensagens. Sem situação nova, devolva listas vazias.

Responda só com JSON:
{"items":[{"item":"I1"|null,"kind":"question|request|complaint|material|approval|deadline","title":"...","summary":"...","urgency":1,"lines":[{"ref":"L3","quote":"trecho exato"}],"owners":[{"person":"P1","reason":"mention|reply|role|general","why":"..."}],"task":"T1"|null,"radar":"R1"|null}],"resolved":[{"item":"I2","by":"L7"}]}`;

/** O texto que o modelo lê, com as referências curtas (P#, I#, L#, T#, R#). */
export function personalMessage(m: PersonalMaterial) {
  const people = new Map<string, PersonalPerson>();
  const personRef = new Map<string, string>();
  m.people.forEach((p, i) => {
    people.set(`P${i + 1}`, p);
    personRef.set(p.id, `P${i + 1}`);
  });
  const items = new Map<string, PersonalItem>();
  const itemRef = new Map<string, string>();
  m.items.forEach((it, i) => {
    items.set(`I${i + 1}`, it);
    itemRef.set(it.id, `I${i + 1}`);
  });
  const lines = new Map<string, PersonalLine>();
  const tasks = new Map<string, string>();
  const radar = new Map<string, string>();
  const out: string[] = [
    `Cliente: ${m.client_name}${m.products.length ? ` · produtos: ${m.products.join(", ")}` : ""}`,
    `Grupo: "${m.group}"`,
    "",
    "Pessoas do time que você lê neste grupo:",
    ...m.people.map((p) => {
      const ref = personRef.get(p.id);
      const bits = [
        `${ref} ${p.name}`,
        p.teams.length ? `equipes: ${p.teams.join(", ")}` : "",
        p.about ? `o que é com ela: ${p.about}` : "",
        p.not_mine?.length ? `já disse que não era com ela: ${p.not_mine.map((t) => `"${t}"`).join("; ")}` : "",
      ].filter(Boolean);
      return `- ${bits.join(" · ")}`;
    }),
  ];
  if (m.items.length) {
    out.push("", "Itens do grupo (I#):");
    for (const it of m.items) {
      const owners = it.owners.map((o) => personRef.get(o) ?? "outra pessoa").join(", ");
      out.push(
        `- ${itemRef.get(it.id)} [${it.status === "open" ? "aberto" : "resolvido"}] ${KIND_LABEL[it.kind] ?? it.kind}: ${it.title}${it.summary ? ` — ${it.summary}` : ""} (cobrou ${it.asks}x; última ${it.last}${owners ? `; donos: ${owners}` : ""})`,
      );
    }
  }
  if (m.tasks.length) {
    out.push("", "Tarefas abertas do cliente (T#):");
    m.tasks.forEach((t, i) => {
      tasks.set(`T${i + 1}`, t.id);
      out.push(`- T${i + 1} ${t.title}${t.assignee ? ` (com ${t.assignee}` : " ("}${t.due ? `, prazo ${t.due}` : ""})`);
    });
  }
  if (m.radar.length) {
    out.push("", "Radar do cliente em aberto (R#):");
    m.radar.forEach((r, i) => {
      radar.set(`R${i + 1}`, r.id);
      out.push(`- R${i + 1} ${r.topic}: ${r.title}`);
    });
  }
  if (m.context.length) {
    out.push("", "Conversa antes (só contexto, já lida):");
    for (const c of m.context) out.push(`${c.at} [${ROLE[c.role]}] ${c.who}: ${c.text}`);
  }
  out.push("", "Mensagens novas (L#):");
  m.lines.forEach((l, i) => {
    const ref = `L${i + 1}`;
    lines.set(ref, l);
    const to = (l.to ?? []).map((u) => personRef.get(u)).filter(Boolean);
    const reply = l.reply_to ? personRef.get(l.reply_to) : undefined;
    const marks = [
      to.length ? `→ cita ${to.join(", ")}` : "",
      reply ? `(responde a ${reply}${l.reply_text ? `: "${l.reply_text}"` : ""})` : l.reply_text ? `(respondendo a "${l.reply_text}")` : "",
      l.item && itemRef.get(l.item) ? `(já em ${itemRef.get(l.item)})` : "",
    ].filter(Boolean);
    out.push(`${ref} · ${l.at} [${ROLE[l.role]}] ${l.who}: ${l.text}${marks.length ? ` ${marks.join(" ")}` : ""}`);
  });
  return { text: out.join("\n"), refs: { people, items, lines, tasks, radar } };
}

function parseJson(text: string): Row {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  // Sem JSON, a leitura falha (e o grupo volta para a fila): nada se perde.
  if (start < 0 || end <= start) throw new PersonalRadarError(502, "A MAVI não devolveu JSON.");
  try {
    return JSON.parse(text.slice(start, end + 1)) as Row;
  } catch {
    throw new PersonalRadarError(502, "A MAVI devolveu um JSON inválido.");
  }
}

const clean = (v: unknown, max: number) =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export type PersonalOwner = {
  user_id: string;
  reason: "mention" | "reply" | "role" | "general";
  why: string;
};
export type PersonalCandidate = {
  item_id: string | null;
  kind: PersonalKind;
  title: string;
  summary: string;
  urgency: number;
  owners: PersonalOwner[];
  mentions: { message_id: string; quote: string }[];
  task_id: string | null;
  radar_item_id: string | null;
};

/**
 * Os itens e as resoluções do modelo, com as referências trocadas pelos ids.
 * Sai o item sem fala do cliente; quem foi citado ou respondido numa fala do
 * item entra como dono pelo motivo certo.
 */
export function parsePersonal(
  text: string,
  refs: ReturnType<typeof personalMessage>["refs"],
) {
  const out = parseJson(text);
  const raw = Array.isArray(out.items) ? out.items : [];
  const byItem = new Map<string, PersonalCandidate>();
  const items: PersonalCandidate[] = [];
  for (const r of raw.slice(0, 40)) {
    const o = (r ?? {}) as Row;
    const existing =
      typeof o.item === "string" ? (refs.items.get(o.item) ?? null) : null;
    const kind = KINDS.includes(o.kind as PersonalKind)
      ? (o.kind as PersonalKind)
      : (existing?.kind ?? null);
    if (!kind) continue;
    const title = clean(o.title, 200) || existing?.title || "";
    if (!existing && title.length < 3) continue;
    const seen = new Set<string>();
    const lines = (Array.isArray(o.lines) ? o.lines : []).flatMap((l) => {
      const x = (typeof l === "string" ? { ref: l } : (l ?? {})) as Row;
      const line = refs.lines.get(String(x.ref ?? ""));
      if (!line || seen.has(line.msg)) return [];
      seen.add(line.msg);
      const quote = clean(x.quote, 700);
      // O trecho precisa estar na fala; senão, vale a fala.
      const exact =
        quote && norm(line.text).includes(norm(quote).slice(0, 60)) ? quote : "";
      return [{ line, quote: exact }];
    });
    // Item novo só com fala do cliente.
    if (!lines.some((l) => l.line.role === "client")) continue;
    const owners = new Map<string, PersonalOwner>();
    for (const l of lines) {
      if (l.line.role !== "client") continue;
      for (const u of l.line.to ?? [])
        if (!owners.has(u)) owners.set(u, { user_id: u, reason: "mention", why: "Te marcaram" });
      const reply = l.line.reply_to;
      if (reply && !owners.has(reply))
        owners.set(reply, { user_id: reply, reason: "reply", why: "Responderam a você" });
    }
    for (const w of Array.isArray(o.owners) ? o.owners : []) {
      const x = (w ?? {}) as Row;
      const person = refs.people.get(String(x.person ?? ""));
      if (!person || owners.has(person.id)) continue;
      const reason = ["role", "general"].includes(String(x.reason))
        ? (x.reason as "role" | "general")
        : "role";
      owners.set(person.id, { user_id: person.id, reason, why: clean(x.why, 300) });
    }
    const urgency = Math.min(3, Math.max(0, Math.round(Number(o.urgency ?? 1)) || 0));
    const candidate: PersonalCandidate = {
      item_id: existing?.id ?? null,
      kind,
      title: existing ? "" : title,
      summary: clean(o.summary, 1500),
      urgency: Number.isFinite(Number(o.urgency)) ? urgency : 1,
      owners: [...owners.values()],
      mentions: lines.map((l) => ({ message_id: l.line.msg, quote: l.quote })),
      task_id: refs.tasks.get(String(o.task ?? "")) ?? null,
      radar_item_id: refs.radar.get(String(o.radar ?? "")) ?? null,
    };
    // Duas anotações do mesmo item viram uma só.
    const prev = candidate.item_id ? byItem.get(candidate.item_id) : undefined;
    if (prev) {
      for (const m of candidate.mentions)
        if (!prev.mentions.some((x) => x.message_id === m.message_id)) prev.mentions.push(m);
      for (const w of candidate.owners)
        if (!prev.owners.some((x) => x.user_id === w.user_id)) prev.owners.push(w);
      prev.urgency = Math.max(prev.urgency, candidate.urgency);
      continue;
    }
    if (candidate.item_id) byItem.set(candidate.item_id, candidate);
    items.push(candidate);
  }
  const resolved = (Array.isArray(out.resolved) ? out.resolved : []).flatMap((r) => {
    const x = (r ?? {}) as Row;
    const item = refs.items.get(String(x.item ?? ""));
    const line = refs.lines.get(String(x.by ?? ""));
    if (!item || !line || line.role !== "team" || item.status !== "open") return [];
    return [{ item_id: item.id, message_id: line.msg }];
  });
  return { items, resolved };
}

// ------------------------------------------------------------ worker
async function workerRpc<T>(env: AiEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, {
    p_secret: env.workerSecret,
    ...args,
  });
  if (!r.ok) throw new PersonalRadarError(r.status, r.error);
  return r.data;
}

type Company = { llm: LlmAdapter; route: ResolvedRoute | null; model: string };

async function companyOf(env: AiEnv, deps: AiDeps, id: string): Promise<Company> {
  const route = await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
    p_company: id,
    p_feature: "personal_radar",
  });
  const config = route && route.key_cipher ? routeConfig(env, route) : null;
  if (!config && !env.anthropicKey)
    throw new PersonalRadarError(503, "Sem provedor para o Radar pessoal.");
  return {
    llm: config ? (deps.providerLlm ?? ((p) => adapterFor(p, deps.fetch)))(config) : deps.llm,
    route,
    model: config?.model ?? env.model,
  };
}

/** Lê um grupo (até 200 mensagens) e grava o que achou. */
async function readGroup(env: AiEnv, deps: AiDeps, company: Company, group: string) {
  const m = await workerRpc<PersonalMaterial | null>(env, deps, "ai_personal_radar_material", {
    p_group: group,
  });
  if (!m) return { items: 0, skipped: true };
  const { text, refs } = personalMessage(m);
  const result = await company.llm({
    instructions: PERSONAL_RADAR_INSTRUCTIONS,
    context: "",
    messages: [{ role: "user", content: text }],
    tools: [],
    execute: async () => "",
    maxRounds: 0,
    maxTokens: 6000,
  });
  const parsed = parsePersonal(result.text, refs);
  const stored = await workerRpc<number>(env, deps, "ai_personal_radar_store", {
    p_group: group,
    p_result: {
      until_at: m.until_at,
      until_id: m.until_id,
      people: m.people.map((p) => p.id),
      items: parsed.items,
      resolved: parsed.resolved,
      usage: {
        model: result.meter.model || company.model,
        input: result.meter.input,
        output: result.meter.output,
        cache_read: result.meter.cacheRead,
        cache_write: result.meter.cacheWrite,
        cost: Math.round(result.meter.cost * 1e6) / 1e6,
        ...(company.route
          ? { provider_id: company.route.provider_id, provider: company.route.provider }
          : {}),
      },
    },
  });
  return { items: stored, skipped: false };
}

export type PersonalRadarEnv = AiEnv & { personalRadarBudgetMs?: number };

/** Lê os grupos pendentes (alguns ao mesmo tempo) até o tempo acabar. */
export async function runPersonalRadar(env: PersonalRadarEnv, deps: AiDeps) {
  const now = deps.now ?? Date.now;
  const deadline = now() + (env.personalRadarBudgetMs ?? env.workerBudgetMs);
  const stats = { groups: 0, items: 0, skipped: 0, failed: 0 };
  const companies = new Map<string, Promise<Company>>();
  // Uma leitura leva até ~60 s (200 mensagens e o contexto).
  while (now() < deadline - 70_000) {
    const claimed = await workerRpc<{ group_id: string; company_id: string }[]>(
      env,
      deps,
      "ai_personal_radar_claim",
      { p_limit: 4 },
    );
    if (!claimed.length) break;
    await Promise.all(
      claimed.map(async (c) => {
        try {
          if (!companies.has(c.company_id))
            companies.set(c.company_id, companyOf(env, deps, c.company_id));
          const company = await companies.get(c.company_id)!;
          // Com mais para ler (o histórico), o grupo volta na próxima reserva.
          const r = await readGroup(env, deps, company, c.group_id);
          if (r.skipped) stats.skipped++;
          else {
            stats.groups++;
            stats.items += r.items;
          }
        } catch (e) {
          stats.failed++;
          console.error("radar pessoal", c.group_id, (e as Error).message);
          await workerRpc(env, deps, "ai_personal_radar_fail", {
            p_group: c.group_id,
            p_error: (e as Error).message,
          }).catch(() => {});
        }
      }),
    );
  }
  return stats;
}

/** "ai-personal-radar": só o agendamento (pg_cron) com o segredo do worker. */
export async function handlePersonalRadarWorker(
  authorization: string | null,
  env: PersonalRadarEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Row }> {
  if (!workerAuthorized(authorization, env))
    return { status: 401, body: { error: "Não autorizado." } };
  try {
    return { status: 200, body: await runPersonalRadar(env, deps) };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return {
      status: typeof e.status === "number" ? e.status : 500,
      body: { error: e.message ?? "Erro no Radar pessoal." },
    };
  }
}

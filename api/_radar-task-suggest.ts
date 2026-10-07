import { callRpc } from "./_drive.js";
import { adapterFor, routeConfig, type ResolvedRoute } from "./_ai-providers.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import { REASONS } from "./_radar-task-rules.js";

/**
 * Radar do cliente · a tarefa sugerida no item (migration
 * 20270608090000_radar_task_suggestions, Fase 3), dentro do worker do Radar.
 *
 * Para cada item novo ou reaberto sem tarefa, num tópico × produto com
 * regras em uso, a MAVI (funcionalidade 'client_radar_tasks') decide com as
 * regras, casos parecidos e as tarefas abertas do cliente: sugerir a tarefa
 * (título, descrição, equipe, pessoa só quando a regra diz, prazo,
 * prioridade), vincular uma tarefa aberta que já trata do assunto, não abrir
 * (regra de não abrir) ou ficar quieta. O banco só guarda o que uma regra em
 * uso sustenta.
 */

type Row = Record<string, unknown>;

export class SuggestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type SuggestClaim = {
  company: string;
  item: string;
  item_data: {
    title: string;
    summary?: string;
    severity?: number;
    mentions?: number;
    due_date?: string;
    first_seen?: string;
    last_seen?: string;
    reopened?: boolean;
    theme?: string;
    client?: string;
    product?: string;
    topic?: string;
    quotes?: string[];
  };
  rules: {
    id: string;
    action: "task" | "no_task";
    condition: string;
    min_severity?: number;
    team_id?: string;
    team?: string;
    team_serves?: boolean;
    assignee_id?: string;
    assignee?: string;
    due_days?: number;
    priority?: string;
    title_hint?: string;
  }[];
  examples: {
    kind: string;
    title: string;
    severity?: number;
    same_theme?: boolean;
    team?: string;
    due_days?: number;
    priority?: string;
    task_title?: string;
    closed_as?: string;
    reason?: string;
  }[];
  open_tasks: { id: string; title: string; status: string; due?: string }[];
  teams: { id: string; name: string }[];
  people: { id: string; name: string }[];
};
export type SuggestResult = {
  decision: "task" | "link" | "no_task" | "unsure";
  rule_id?: string;
  title?: string;
  description?: string;
  team_id?: string;
  assignee_id?: string;
  due_days?: number;
  priority?: string;
  why?: string;
  link_task_id?: string;
};

const SEVERITY = ["baixa", "média", "alta", "crítica"];
const PRIORITY: Record<string, string> = { low: "baixa", normal: "normal", high: "alta", urgent: "urgente" };
const STATUS: Record<string, string> = {
  progress: "em andamento",
  returned: "devolvida",
  rejected: "reprovada",
  correction: "em correção",
  review: "em validação",
};

export const SUGGEST_INSTRUCTIONS = `Você é a MAVI, a inteligência de uma agência de marketing. No Radar do cliente aparecem problemas, promessas e outros tópicos tirados das reuniões e dos grupos de WhatsApp. Os gestores aprovaram REGRAS que dizem quando um item pede tarefa, para quem e com que prazo. Você recebe um item novo e decide, seguindo essas regras, se sugere uma tarefa. Uma pessoa sempre revisa antes de criar. Fale de si no feminino.

Decida UMA opção:
- "task": uma regra R# de "abrir tarefa" claramente vale para este item (o assunto bate com o "Quando" e a gravidade é pelo menos a mínima) e nenhuma tarefa aberta do cliente (K#) já trata do mesmo problema.
- "link": uma regra R# de "abrir tarefa" vale, mas uma tarefa aberta do cliente (K#) já trata exatamente deste problema. Cite a K# em "task".
- "no_task": uma regra R# de "não abrir tarefa" vale para o item.
- "unsure": nenhuma regra vale com clareza. Na dúvida, escolha "unsure": melhor ficar quieta do que sugerir errado.

Para "task":
- "title": curto e concreto, com o que fazer (verbo no infinitivo) e o cliente; siga o "título" da regra quando houver, trocando os <marcadores>.
- "description": 2 a 4 linhas: o que precisa ser feito, o contexto do cliente (o que ele disse) e quando está pronto. Sem inventar fatos.
- "team": a equipe da regra quando ela atende o cliente (T#); se a regra não diz ou a equipe não atende este cliente, a equipe T# que mais combina com o assunto, ou null.
- "assignee": só a pessoa que a regra indica (P#), quando ela está na lista; senão null (a tarefa vai para quem tem menos tarefas na equipe).
- "due_days" e "priority": os da regra (em dias úteis; prioridade low, normal, high ou urgent). Suba a prioridade só se o item for de gravidade crítica e a regra não disser.
- "why": em uma frase, por que a regra vale (cite o trecho do item).

Responda só com JSON, sem texto fora dele:
{"decision": "task", "rule": "R1", "title": "...", "description": "...", "team": "T1", "assignee": null, "due_days": 2, "priority": "high", "why": "...", "task": null}`;

/** O material com referências curtas (R#, T#, P#, K#) e o mapa de volta. */
export function suggestMessage(c: SuggestClaim) {
  const refs = {
    rules: new Map(c.rules.map((r, i) => [`R${i + 1}`, r.id])),
    teams: new Map(c.teams.map((t, i) => [`T${i + 1}`, t.id])),
    people: new Map(c.people.map((p, i) => [`P${i + 1}`, p.id])),
    tasks: new Map(c.open_tasks.map((t, i) => [`K${i + 1}`, t.id])),
  };
  const teamRef = new Map([...refs.teams].map(([k, v]) => [v, k]));
  const personRef = new Map([...refs.people].map(([k, v]) => [v, k]));
  const d = c.item_data;
  const sev = (s?: number) => (s === undefined || s === null ? "" : SEVERITY[s] ?? String(s));
  const rule = (r: SuggestClaim["rules"][number], i: number) => {
    const when = `R${i + 1} Quando: ${r.condition}${r.min_severity !== undefined && r.min_severity !== null ? ` (gravidade ${sev(r.min_severity)} ou mais)` : ""}`;
    if (r.action === "no_task") return `${when} → NÃO abrir tarefa`;
    const team = r.team_id
      ? r.team_serves
        ? `para ${teamRef.get(r.team_id) ?? ""} ${r.team ?? ""}`.trim()
        : `para a equipe ${r.team ?? "?"} (que NÃO atende este cliente)`
      : "";
    const person = r.assignee_id
      ? personRef.has(r.assignee_id)
        ? `pessoa ${personRef.get(r.assignee_id)} ${r.assignee ?? ""}`.trim()
        : `pessoa ${r.assignee ?? "?"} (fora das equipes do cliente)`
      : "";
    return `${when} → ABRIR tarefa${[
      team,
      person,
      r.due_days !== undefined && r.due_days !== null ? `prazo ${r.due_days} dias úteis` : "",
      r.priority ? `prioridade ${PRIORITY[r.priority] ?? r.priority}` : "",
      r.title_hint ? `título: ${r.title_hint}` : "",
    ]
      .filter(Boolean)
      .map((x) => `, ${x}`)
      .join("")}`;
  };
  const example = (x: SuggestClaim["examples"][number]) => {
    const head = `- ${x.same_theme ? "[mesmo tema] " : ""}"${x.title}"${x.severity !== undefined ? ` (gravidade ${sev(x.severity)})` : ""}`;
    if (x.kind === "no_task") return `${head} → fechado sem tarefa (${x.closed_as ?? "fechado"})`;
    if (x.kind === "dismissed") return `${head} → sugestão recusada: ${REASONS[x.reason ?? ""] ?? x.reason ?? "sem motivo"}`;
    return `${head} → tarefa${x.task_title ? ` "${x.task_title}"` : ""}${x.team ? ` para ${x.team}` : ""}${
      x.due_days !== undefined && x.due_days !== null ? `, prazo ${x.due_days} dias úteis` : ""
    }${x.priority && x.priority !== "normal" ? `, prioridade ${PRIORITY[x.priority] ?? x.priority}` : ""}`;
  };
  const text = [
    `Item do Radar — tópico ${d.topic ?? "?"} · produto ${d.product ?? "Geral / Agência"} · cliente ${d.client ?? "?"}`,
    `"${d.title}"${d.summary ? ` — ${d.summary}` : ""}`,
    [
      d.severity !== undefined && d.severity !== null ? `gravidade ${sev(d.severity)}` : "",
      d.mentions && d.mentions > 1 ? `apareceu ${d.mentions}x` : "",
      d.first_seen ? `desde ${d.first_seen}` : "",
      d.last_seen && d.last_seen !== d.first_seen ? `última vez ${d.last_seen}` : "",
      d.theme ? `tema "${d.theme}"` : "",
      d.due_date ? `prazo combinado ${d.due_date}` : "",
      d.reopened ? "REABERTO (voltou a aparecer depois de fechado)" : "",
    ]
      .filter(Boolean)
      .join(" · "),
    d.quotes?.length ? `Falas recentes:\n${d.quotes.map((q) => `- ${q}`).join("\n")}` : "",
    "",
    `Regras em uso:\n${c.rules.map(rule).join("\n")}`,
    "",
    `Casos parecidos do mesmo tópico e produto:\n${c.examples.map(example).join("\n") || "(nenhum)"}`,
    "",
    `Tarefas abertas do cliente:\n${
      c.open_tasks
        .map((t, i) => `K${i + 1} "${t.title}" · ${STATUS[t.status] ?? t.status}${t.due ? ` · prazo ${t.due}` : ""}`)
        .join("\n") || "(nenhuma)"
    }`,
    "",
    `Equipes que atendem o cliente: ${c.teams.map((t, i) => `T${i + 1} ${t.name}`).join(", ") || "(nenhuma)"}`,
    `Pessoas dessas equipes: ${c.people.map((p, i) => `P${i + 1} ${p.name}`).join(", ") || "(nenhuma)"}`,
  ]
    .filter((x) => x !== null)
    .join("\n");
  return { text, refs };
}

/** A decisão do modelo com as referências trocadas pelos ids. */
export function parseSuggestion(text: string, refs: ReturnType<typeof suggestMessage>["refs"]): SuggestResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new SuggestError(502, "A MAVI não devolveu JSON.");
  let raw: Row;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Row;
  } catch {
    throw new SuggestError(502, "A MAVI devolveu um JSON inválido.");
  }
  const ref = (m: Map<string, string>, v: unknown) => (typeof v === "string" ? m.get(v.trim().toUpperCase()) : undefined);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const decision = ["task", "link", "no_task", "unsure"].includes(raw.decision as string)
    ? (raw.decision as SuggestResult["decision"])
    : "unsure";
  if (decision === "unsure") return { decision, why: str(raw.why, 600) || undefined };
  const out: SuggestResult = { decision, why: str(raw.why, 600) || undefined };
  const rule = ref(refs.rules, raw.rule);
  if (rule) out.rule_id = rule;
  if (decision === "link") {
    const task = ref(refs.tasks, raw.task);
    if (task) out.link_task_id = task;
  }
  if (decision === "task") {
    out.title = str(raw.title, 240);
    const description = str(raw.description, 4000);
    if (description) out.description = description;
    const team = ref(refs.teams, raw.team);
    if (team) out.team_id = team;
    const person = ref(refs.people, raw.assignee);
    if (person) out.assignee_id = person;
    if (typeof raw.due_days === "number" && Number.isInteger(raw.due_days) && raw.due_days >= 0 && raw.due_days <= 60)
      out.due_days = raw.due_days;
    if (typeof raw.priority === "string" && ["low", "normal", "high", "urgent"].includes(raw.priority))
      out.priority = raw.priority;
  }
  return out;
}

async function workerRpc<T>(env: AiEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
  if (!r.ok) throw new SuggestError(r.status, r.error);
  return r.data;
}

/** Um item: a MAVI decide e o banco guarda (só o que uma regra em uso sustenta). */
export async function suggestTask(env: AiEnv & { tasksModel?: string }, deps: AiDeps, c: SuggestClaim) {
  const route = await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
    p_company: c.company,
    p_feature: "client_radar_tasks",
  });
  const config = route && route.key_cipher ? routeConfig(env, route) : null;
  if (!config && !env.anthropicKey) throw new SuggestError(503, "Sem provedor para as sugestões de tarefas do Radar.");
  const llm = config ? (deps.providerLlm ?? ((p) => adapterFor(p, deps.fetch)))(config) : deps.llm;
  const { text, refs } = suggestMessage(c);
  const result = await llm({
    instructions: SUGGEST_INSTRUCTIONS,
    context: "",
    messages: [{ role: "user", content: text }],
    tools: [],
    execute: async () => "",
    maxRounds: 0,
    maxTokens: 1500,
  });
  const decided = parseSuggestion(result.text, refs);
  return workerRpc<string | null>(env, deps, "ai_radar_task_suggest_store", {
    p_item: c.item,
    p_result: decided,
    p_usage: {
      model: result.meter.model || config?.model || env.tasksModel || env.model,
      input: result.meter.input,
      output: result.meter.output,
      cache_read: result.meter.cacheRead,
      cache_write: result.meter.cacheWrite,
      cost: Math.round(result.meter.cost * 1e6) / 1e6,
      ...(route ? { provider_id: route.provider_id, provider: route.provider } : {}),
    },
  });
}

/** Os itens na fila, alguns ao mesmo tempo, até o prazo do worker. */
export async function runTaskSuggestions(env: AiEnv & { tasksModel?: string }, deps: AiDeps, deadline: number) {
  const now = deps.now ?? Date.now;
  const stats = { suggested: 0, quiet: 0, failed: 0 };
  // Uma decisão leva até ~20 s; 4 por vez.
  for (let round = 0; round < 6 && now() < deadline - 30_000; round++) {
    const claimed = await workerRpc<SuggestClaim[] | null>(env, deps, "ai_radar_task_suggest_claim", { p_limit: 4 });
    if (!Array.isArray(claimed) || !claimed.length) break;
    await Promise.all(
      claimed.map(async (c) => {
        try {
          const status = await suggestTask(env, deps, c);
          if (status === "open") stats.suggested++;
          else stats.quiet++;
        } catch (e) {
          stats.failed++;
          console.error("radar · tarefa sugerida", c.item, (e as Error).message);
          await workerRpc(env, deps, "ai_radar_task_suggest_fail", {
            p_item: c.item,
            p_error: (e as Error).message,
          }).catch(() => {});
        }
      }),
    );
  }
  return stats;
}

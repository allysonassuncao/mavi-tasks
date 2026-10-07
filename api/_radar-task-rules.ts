import { callRpc } from "./_drive.js";
import { adapterFor, routeConfig, type ResolvedRoute } from "./_ai-providers.js";
import { askJev, type JevQuestion } from "./_temperature.js";
import type { AiDeps, AiEnv } from "./_ai.js";

/**
 * Radar do cliente · as regras das tarefas (migration
 * 20270606090000_radar_task_rules, Fase 2), dentro do worker do Radar.
 *
 * 1. O banco entrega um tópico × produto com registros novos (tarefas
 *    criadas e vinculadas a partir dos itens, itens fechados sem tarefa), as
 *    equipes, as pessoas que receberam e as regras que o grupo já tem.
 * 2. A MAVI (funcionalidade 'client_radar_tasks') propõe regras: quando abrir
 *    (ou não abrir) tarefa, para qual equipe, prazo, prioridade, gravidade
 *    mínima e dica de título, citando os registros (S#). Referências curtas
 *    (S#, T#, P#, R#) no lugar dos ids.
 * 3. O Jev confere cada proposta (os registros sustentam? é clara e não
 *    contradiz as em uso?); aprovada, espera um administrador ou gestor.
 */

type Row = Record<string, unknown>;

export class TaskRulesError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RuleSignal = {
  id: string;
  kind: "created" | "linked" | "no_task" | "dismissed";
  at: string;
  title: string;
  summary?: string;
  severity?: number;
  theme?: string;
  client?: string;
  mentions?: number;
  task_title?: string;
  team_id?: string;
  by_team?: boolean;
  assignee_id?: string;
  due_days?: number;
  priority?: string;
  changed?: string[];
  from_item?: boolean;
  preset_title?: string;
  /** Veio da tarefa sugerida pela MAVI (criada, vinculada ou recusada). */
  from_suggestion?: boolean;
  /** Recusada: o motivo, a observação e o título que a MAVI sugeriu. */
  reason?: string;
  note?: string;
  suggested_title?: string;
  closed_as?: string;
  by_mavi?: boolean;
  reopened?: boolean;
};
export type ExistingRule = {
  id: string;
  action: "task" | "no_task";
  condition: string;
  team_id?: string;
  assignee_id?: string;
  due_days?: number;
  priority?: string;
  min_severity?: number;
  title_hint?: string;
  status: string;
  origin: string;
  all_products?: boolean;
};
export type RulesClaim = {
  company: string;
  product_key: string;
  topic: { id: string; name: string; description: string; statuses: { label: string; kind: string }[] };
  product: { id: string; name: string } | null;
  signals: RuleSignal[];
  teams: { id: string; name: string; product?: boolean }[];
  people: { id: string; name: string }[];
  rules: ExistingRule[];
};
export type RuleOp = {
  op: "add" | "update" | "retire";
  id?: string;
  action?: "task" | "no_task";
  condition?: string;
  team_id?: string;
  assignee_id?: string;
  due_days?: number;
  priority?: string;
  min_severity?: number;
  title_hint?: string;
  why?: string;
  signals?: string[];
  replaces?: string;
};

const SEVERITY = ["baixa", "média", "alta", "crítica"];
const PRIORITY: Record<string, string> = { low: "baixa", normal: "normal", high: "alta", urgent: "urgente" };
const CHANGED: Record<string, string> = {
  title: "título",
  description: "descrição",
  product: "produto",
  due: "prazo",
  assignee: "responsável",
  team: "equipe",
  priority: "prioridade",
};
const STATUS: Record<string, string> = {
  active: "em uso",
  suggested: "sugerida, esperando um líder",
  checking: "sugerida, em conferência",
  paused: "pausada",
  refused: "recusada pelo Jev",
  dismissed: "recusada ou excluída",
};
/** Os motivos de recusa da tarefa sugerida (radar_task_suggestion_dismiss). */
export const REASONS: Record<string, string> = {
  not_needed: "não precisa de tarefa",
  exists: "já existe tarefa para isso",
  wrong_person: "equipe ou pessoa errada",
  wrong_due: "prazo errado",
  other: "outro motivo",
};
const MAX_OPS = 5;

export const RULES_INSTRUCTIONS = `Você é a MAVI, a inteligência de uma agência de marketing. Os gestores acompanham, no Radar do cliente, os problemas, promessas e outros tópicos que aparecem nas reuniões e nos grupos de WhatsApp. A partir de cada item, alguém do time decide se abre uma tarefa, para quem e com que prazo. Você aprende essas decisões para, no futuro, sugerir a tarefa certa sozinha. Fale de si no feminino.

Você recebe os registros de UM tópico num produto:
- TAREFA CRIADA: alguém criou a tarefa a partir do item (o formulário veio preenchido pela MAVI; "mudou" diz o que a pessoa trocou).
- TAREFA VINCULADA: o item ganhou uma tarefa que já existia (também conta como "este item pedia tarefa").
- FECHADO SEM TAREFA: o item foi resolvido ou descartado sem tarefa ("quando NÃO abrir"). Fechado pela MAVI pesa menos; se o item reabriu depois, é um contra-exemplo (talvez precisasse de tarefa).
- SUGESTÃO RECUSADA: a MAVI sugeriu a tarefa por uma regra e a pessoa recusou, com o motivo (não precisa, já existe, equipe/pessoa errada, prazo errado, outro). Recusas repetidas pelo mesmo motivo pedem ajustar a regra (substituta) ou uma regra de não abrir.
- "(pela sugestão)" numa tarefa criada ou vinculada: a pessoa aceitou a sugestão da MAVI ("mudou" diz o que ela corrigiu).

Proponha REGRAS curtas que expliquem os padrões, para um administrador ou gestor aprovar:
- "condition": QUANDO a regra vale, descrita pelo assunto/tipo de item (ex.: "Problema que trava a entrada de leads: formulário, pixel, página fora do ar"). Nada de nome de cliente; use a gravidade em "min_severity" (0 baixa, 1 média, 2 alta, 3 crítica) quando o padrão depende dela.
- "action": "task" (abrir tarefa) ou "no_task" (não abrir).
- Para "task": "team" (T#) quando 2/3 ou mais dos casos parecidos foram para essa equipe; "assignee" (P#) SÓ quando 80% ou mais dos casos, e pelo menos 3, foram para a mesma pessoa; "due_days" = prazo típico em dias úteis (a mediana dos casos); "priority" (low, normal, high, urgent) só quando o padrão não é normal; "title_hint" quando as pessoas reescrevem o título de um jeito consistente (ex.: "Corrigir <o que quebrou> — <cliente>").
- "why": em uma frase, os números que sustentam (ex.: "6 de 7 itens de gravidade alta viraram tarefa para Tráfego, prazo de 2 dias úteis").
- "signals": os registros (S#) que sustentam a regra.

Regras do jogo:
- Só proponha o que pelo menos 3 registros sustentam e sem contra-exemplos fortes. Melhor nenhuma regra do que uma regra fraca.
- Não repita uma regra que já existe (em uso, sugerida, recusada ou excluída), nem com outras palavras.
- Se os registros novos contrariam uma regra em uso, proponha a substituta com "replaces": "R#" (a antiga fica pausada quando a nova for aprovada).
- Você pode atualizar ("update") ou retirar ("retire") só as suas sugestões ainda não aprovadas (R# marcadas "sugerida").
- No máximo ${MAX_OPS} operações. Sem nada novo, devolva {"ops": []}.

Responda só com JSON, sem texto fora dele:
{"ops": [
 {"op": "add", "action": "task", "condition": "...", "team": "T1", "assignee": null, "due_days": 2, "priority": "high", "min_severity": 2, "title_hint": "...", "why": "...", "signals": ["S1", "S3"], "replaces": null},
 {"op": "add", "action": "no_task", "condition": "...", "min_severity": null, "why": "...", "signals": ["S2"]},
 {"op": "update", "id": "R2", "action": "task", "condition": "...", "team": "T1", "due_days": 3, "why": "...", "signals": ["S5"]},
 {"op": "retire", "id": "R3", "why": "..."}
]}`;

/** O material com referências curtas (S#, T#, P#, R#) e o mapa de volta. */
export function rulesMessage(c: RulesClaim) {
  const refs = {
    signals: new Map(c.signals.map((s, i) => [`S${i + 1}`, s.id])),
    teams: new Map(c.teams.map((t, i) => [`T${i + 1}`, t.id])),
    people: new Map(c.people.map((p, i) => [`P${i + 1}`, p.id])),
    rules: new Map(c.rules.map((r, i) => [`R${i + 1}`, r.id])),
  };
  const back = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [v, k]));
  const team = back(refs.teams);
  const person = back(refs.people);
  const teamName = (id?: string) => (id ? `${team.get(id) ?? "?"} ${c.teams.find((t) => t.id === id)?.name ?? ""}`.trim() : "");
  const personName = (id?: string) =>
    id ? `${person.get(id) ?? "?"} ${c.people.find((p) => p.id === id)?.name ?? ""}`.trim() : "";
  const severity = (s?: number) => (s === undefined || s === null ? "" : `[gravidade ${SEVERITY[s] ?? s}] `);
  const signal = (s: RuleSignal, i: number) => {
    const head = `S${i + 1} · ${s.at} · ${
      s.kind === "created"
        ? "TAREFA CRIADA"
        : s.kind === "linked"
          ? "TAREFA VINCULADA"
          : s.kind === "dismissed"
            ? "SUGESTÃO RECUSADA"
            : "FECHADO SEM TAREFA"
    }${s.from_suggestion && s.kind !== "dismissed" ? " (pela sugestão)" : ""} · ${severity(s.severity)}"${s.title}"${s.summary ? ` — ${s.summary}` : ""}${s.client ? ` · cliente ${s.client}` : ""}${
      s.theme ? ` · tema "${s.theme}"` : ""
    }${s.mentions && s.mentions > 1 ? ` · apareceu ${s.mentions}x` : ""}`;
    if (s.kind === "dismissed")
      return `${head} → a MAVI sugeriu${s.suggested_title ? ` "${s.suggested_title}"` : ""}${
        s.team_id ? ` para ${teamName(s.team_id)}` : ""
      }${s.assignee_id ? `, pessoa ${personName(s.assignee_id)}` : ""}${
        s.due_days !== undefined && s.due_days !== null ? `, prazo ${s.due_days} dias úteis` : ""
      }; recusada: ${REASONS[s.reason ?? ""] ?? s.reason ?? "sem motivo"}${s.note ? ` ("${s.note}")` : ""}`;
    if (s.kind === "no_task")
      return `${head} → fechado como ${s.closed_as ?? "fechado"}${s.by_mavi ? " (pela MAVI)" : ""}${
        s.reopened ? " · REABRIU depois" : ""
      }`;
    const to = [
      s.team_id ? `equipe ${teamName(s.team_id)}${s.by_team ? " (enviada à equipe)" : ""}` : "",
      s.assignee_id ? `pessoa ${personName(s.assignee_id)}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const parts = [
      s.task_title ? `tarefa "${s.task_title}"` : "tarefa",
      to && `para ${to}`,
      s.due_days !== undefined && s.due_days !== null ? `prazo ${s.due_days} dias úteis` : "",
      s.priority ? `prioridade ${PRIORITY[s.priority] ?? s.priority}` : "",
      s.changed?.length ? `mudou: ${s.changed.map((x) => CHANGED[x] ?? x).join(", ")}` : s.from_item ? "como veio preenchida" : "",
      s.changed?.includes("title") && s.preset_title ? `título que veio: "${s.preset_title}"` : "",
    ].filter(Boolean);
    return `${head} → ${parts.join(" · ")}`;
  };
  const rule = (r: ExistingRule, i: number) =>
    `R${i + 1} [${STATUS[r.status] ?? r.status}${r.origin === "mavi" ? ", da MAVI" : ", de um líder"}${
      r.all_products ? ", vale em todos os produtos" : ""
    }] Quando: ${r.condition}${r.min_severity !== undefined && r.min_severity !== null ? ` (gravidade ${SEVERITY[r.min_severity]} ou mais)` : ""} → ${
      r.action === "no_task"
        ? "não abrir tarefa"
        : [
            "abrir tarefa",
            r.team_id && `para ${teamName(r.team_id)}`,
            r.assignee_id && `pessoa ${personName(r.assignee_id)}`,
            r.due_days !== undefined && r.due_days !== null && `prazo ${r.due_days} dias úteis`,
            r.priority && `prioridade ${PRIORITY[r.priority] ?? r.priority}`,
            r.title_hint && `título: ${r.title_hint}`,
          ]
            .filter(Boolean)
            .join(", ")
    }`;
  const counts = {
    task: c.signals.filter((s) => s.kind === "created" || s.kind === "linked").length,
    none: c.signals.filter((s) => s.kind === "no_task").length,
    dismissed: c.signals.filter((s) => s.kind === "dismissed").length,
  };
  const text = [
    `Tópico: ${c.topic.name}${c.topic.description ? ` — ${c.topic.description}` : ""}`,
    `Produto: ${c.product?.name ?? "Geral / Agência"}`,
    `Status do tópico: ${c.topic.statuses.map((s) => `${s.label} (${s.kind === "closed" ? "fechado" : "aberto"})`).join(", ")}`,
    "",
    `Equipes:\n${c.teams.map((t, i) => `T${i + 1} ${t.name}${t.product ? " (atende o produto)" : ""}`).join("\n") || "(nenhuma)"}`,
    "",
    `Pessoas que receberam tarefas:\n${c.people.map((p, i) => `P${i + 1} ${p.name}`).join("\n") || "(nenhuma)"}`,
    "",
    `Regras que já existem:\n${c.rules.map(rule).join("\n") || "(nenhuma)"}`,
    "",
    `Registros (${counts.task} com tarefa, ${counts.none} fechados sem tarefa${
      counts.dismissed ? `, ${counts.dismissed} sugestões recusadas` : ""
    }; do mais novo ao mais antigo):`,
    ...c.signals.map(signal),
  ].join("\n");
  return { text, refs };
}

function parseJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new TaskRulesError(502, "A MAVI não devolveu JSON.");
  try {
    return JSON.parse(text.slice(start, end + 1)) as { ops?: unknown };
  } catch {
    throw new TaskRulesError(502, "A MAVI devolveu um JSON inválido.");
  }
}

/** As operações do modelo com as referências trocadas pelos ids (as inválidas saem). */
export function parseRuleOps(text: string, refs: ReturnType<typeof rulesMessage>["refs"]): RuleOp[] {
  const raw = parseJson(text).ops;
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const num = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
  const ref = (m: Map<string, string>, v: unknown) => (typeof v === "string" ? m.get(v.trim().toUpperCase()) : undefined);
  const out: RuleOp[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    const x = o as Row;
    const op = x.op;
    if (op === "retire") {
      const id = ref(refs.rules, x.id);
      if (id) out.push({ op, id, why: str(x.why, 300) });
    } else if (op === "add" || op === "update") {
      const action = x.action === "task" || x.action === "no_task" ? x.action : undefined;
      const condition = str(x.condition, 400);
      const id = op === "update" ? ref(refs.rules, x.id) : undefined;
      if (!action || condition.length < 5 || (op === "update" && !id)) continue;
      const task = action === "task";
      const priority = typeof x.priority === "string" && ["low", "normal", "high", "urgent"].includes(x.priority) ? x.priority : undefined;
      out.push({
        op,
        ...(id ? { id } : {}),
        action,
        condition,
        ...(task && ref(refs.teams, x.team) ? { team_id: ref(refs.teams, x.team) } : {}),
        ...(task && ref(refs.people, x.assignee) ? { assignee_id: ref(refs.people, x.assignee) } : {}),
        ...(task && num(x.due_days, 0, 60) !== undefined ? { due_days: num(x.due_days, 0, 60) } : {}),
        ...(task && priority ? { priority } : {}),
        ...(num(x.min_severity, 0, 3) !== undefined ? { min_severity: num(x.min_severity, 0, 3) } : {}),
        ...(task && str(x.title_hint, 200) ? { title_hint: str(x.title_hint, 200) } : {}),
        why: str(x.why, 600),
        signals: Array.isArray(x.signals)
          ? [...new Set(x.signals.map((s) => ref(refs.signals, s)).filter((s): s is string => !!s))]
          : [],
        ...(ref(refs.rules, x.replaces) ? { replaces: ref(refs.rules, x.replaces) } : {}),
      });
    }
    if (out.length >= MAX_OPS) break;
  }
  return out;
}

async function workerRpc<T>(env: AiEnv, deps: AiDeps, name: string, args: Row) {
  const r = await callRpc<T>(env, deps.fetch, null, name, { p_secret: env.workerSecret, ...args });
  if (!r.ok) throw new TaskRulesError(r.status, r.error);
  return r.data;
}

/** Uma rodada num tópico × produto: a MAVI propõe e o banco grava. */
export async function learnRules(env: AiEnv & { tasksModel?: string }, deps: AiDeps, c: RulesClaim) {
  const route = await workerRpc<ResolvedRoute | null>(env, deps, "ai_worker_route", {
    p_company: c.company,
    p_feature: "client_radar_tasks",
  });
  const config = route && route.key_cipher ? routeConfig(env, route) : null;
  if (!config && !env.anthropicKey) throw new TaskRulesError(503, "Sem provedor para as regras das tarefas do Radar.");
  const llm = config ? (deps.providerLlm ?? ((p) => adapterFor(p, deps.fetch)))(config) : deps.llm;
  const { text, refs } = rulesMessage(c);
  const result = await llm({
    instructions: RULES_INSTRUCTIONS,
    context: "",
    messages: [{ role: "user", content: text }],
    tools: [],
    execute: async () => "",
    maxRounds: 0,
    maxTokens: 4000,
  });
  const ops = parseRuleOps(result.text, refs);
  return workerRpc<number>(env, deps, "ai_radar_task_rules_store", {
    p_company: c.company,
    p_topic: c.topic.id,
    p_product_key: c.product_key,
    p_ops: ops,
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

// ------------------------------------------------------------ o Jev
export type RuleCheck = {
  id: string;
  company: string;
  rule: {
    topic_name: string;
    product_name?: string;
    all_products?: boolean;
    action: "task" | "no_task";
    condition: string;
    min_severity?: number;
    team_name?: string;
    assignee_name?: string;
    due_days?: number;
    priority?: string;
    title_hint?: string;
    why?: string;
    replaces_condition?: string;
  };
  signals: { kind: string; title: string; severity?: number; team?: string; due_days?: number; priority?: string; closed_as?: string }[];
  group: { task: number; no_task: number };
  active: string[];
  jev: ResolvedRoute | null;
};

export function ruleText(r: RuleCheck["rule"]) {
  return `Quando: ${r.condition}${r.min_severity !== undefined && r.min_severity !== null ? ` (gravidade ${SEVERITY[r.min_severity]} ou mais)` : ""} → ${
    r.action === "no_task"
      ? "não abrir tarefa"
      : [
          "abrir tarefa",
          r.team_name && `para a equipe ${r.team_name}`,
          r.assignee_name && `com ${r.assignee_name}`,
          r.due_days !== undefined && r.due_days !== null && `prazo de ${r.due_days} dias úteis`,
          r.priority && `prioridade ${PRIORITY[r.priority] ?? r.priority}`,
        ]
          .filter(Boolean)
          .join(", ")
  }`;
}

export const RULE_QUESTIONS: Record<string, JevQuestion> = {
  supported: {
    type: "noul",
    instructions:
      "Os registros citados e os números do grupo sustentam a regra? A maioria dos casos parecidos seguiu o que ela diz (abrir ou não abrir tarefa e, quando diz, a equipe, o prazo e a prioridade).",
    criteria: { true: "Sim: os casos sustentam a regra", false: "Não: poucos casos ou casos que contrariam" },
  },
  clear: {
    type: "noul",
    instructions:
      "A regra é clara e acionável (dá para decidir, num item novo, se ela vale), sem dado pessoal, e não contradiz as regras em uso?",
    criteria: { true: "Sim: clara e coerente", false: "Não: vaga, com dado pessoal ou contraditória" },
  },
};

export async function checkRule(env: AiEnv, deps: AiDeps, r: RuleCheck) {
  const jev = r.jev?.key_cipher ? routeConfig(env, r.jev) : null;
  // Sem o Jev cadastrado, a sugestão segue para um líder aprovar.
  if (!jev)
    return workerRpc(env, deps, "ai_radar_task_rule_check_store", {
      p_rule: r.id,
      p_ok: true,
      p_note: "Sem o Jev cadastrado: sem conferência.",
      p_usage: {},
    });
  const res = await askJev(
    jev,
    {
      topico: r.rule.topic_name,
      produto: r.rule.all_products ? "todos os produtos" : (r.rule.product_name ?? "Geral / Agência"),
      regra: ruleText(r.rule),
      por_que: r.rule.why ?? "",
      substitui: r.rule.replaces_condition ?? "",
      registros_citados: r.signals.map(
        (s) =>
          `${s.kind === "no_task" ? `fechado sem tarefa (${s.closed_as ?? ""})` : "com tarefa"}: "${s.title}"${
            s.severity !== undefined ? `, gravidade ${SEVERITY[s.severity]}` : ""
          }${s.team ? `, equipe ${s.team}` : ""}${s.due_days !== undefined ? `, prazo ${s.due_days} dias úteis` : ""}`,
      ),
      grupo: `${r.group.task} itens com tarefa e ${r.group.no_task} fechados sem tarefa neste tópico e produto`,
      regras_em_uso: r.active,
    },
    RULE_QUESTIONS,
    deps.fetch,
    AbortSignal.timeout(30000),
  );
  const supported = res.answers?.supported?.noul;
  const clear = res.answers?.clear?.noul;
  const ok = (typeof supported !== "number" || supported >= 0.5) && (typeof clear !== "number" || clear >= 0.5);
  const why = [
    typeof supported === "number" && supported < 0.5 ? "os registros não sustentam" : "",
    typeof clear === "number" && clear < 0.5 ? "está vaga ou contradiz uma regra em uso" : "",
  ].filter(Boolean);
  return workerRpc(env, deps, "ai_radar_task_rule_check_store", {
    p_rule: r.id,
    p_ok: ok,
    p_note: ok ? null : `O Jev recusou: ${why.join("; ")}.`,
    p_usage: {
      model: res.model || jev.model,
      input: res.tokens,
      cost: Math.round(res.cost * 1e6) / 1e6,
      ...(r.jev ? { provider_id: r.jev.provider_id, provider: r.jev.provider } : {}),
    },
  });
}

/** As rodadas pendentes e as conferências, até o prazo do worker. */
export async function runTaskRules(env: AiEnv & { tasksModel?: string }, deps: AiDeps, deadline: number) {
  const now = deps.now ?? Date.now;
  const stats = { rules: 0, checked: 0, failed: 0 };
  // Uma rodada leva até ~60 s; no máximo 3 por vez do worker.
  for (let i = 0; i < 3 && now() < deadline - 60_000; i++) {
    const c = await workerRpc<RulesClaim | null>(env, deps, "ai_radar_task_rules_claim", {});
    if (!c?.topic) break;
    try {
      stats.rules += await learnRules(env, deps, c);
    } catch (e) {
      stats.failed++;
      console.error("radar · regras das tarefas", c.topic.id, (e as Error).message);
      await workerRpc(env, deps, "ai_radar_task_rules_fail", {
        p_company: c.company,
        p_topic: c.topic.id,
        p_product_key: c.product_key,
        p_error: (e as Error).message,
      }).catch(() => {});
    }
  }
  for (let i = 0; i < 10 && now() < deadline - 20_000; i++) {
    const r = await workerRpc<RuleCheck | null>(env, deps, "ai_radar_task_rule_check_claim", {});
    if (!r?.rule) break;
    try {
      await checkRule(env, deps, r);
      stats.checked++;
    } catch (e) {
      stats.failed++;
      // Volta para a fila quando a reserva vence (até 3 tentativas).
      console.error("radar · regra no Jev", r.id, (e as Error).message);
    }
  }
  return stats;
}
